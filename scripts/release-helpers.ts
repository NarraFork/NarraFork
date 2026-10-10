/**
 * Auxiliary release controller. No implicit publishing: use preview for offline
 * validation; publish is an explicit remote write and --dry-run makes it offline.
 */
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	HELPER_PLATFORMS,
	HELPER_RELEASE_TAG,
	type HelperPlatform,
} from "../shared/helper-distribution";
import {
	assertBridgeMode,
	ciBridgeDeadlineSignal,
	createBridgeGhRunner,
} from "./lib/ci-update-server-bridge-restore";
import {
	assembleHelperReleaseBundle,
	assertHelperReleaseGate,
	buildHelperReleasePlatform,
	type HelperReleasePlan,
	mirrorHelperReleasePlan,
	planHelperRelease,
	prepareHelperReleaseBridge,
	publishHelperReleasePlan,
	readHelperReleasePlan,
	restoreHelperReleaseBundle,
	smokeHelperReleasePlatform,
	writeHelperReleasePlan,
} from "./lib/helper-release-control";

const COMMANDS = [
	"preflight",
	"build",
	"smoke",
	"assemble",
	"restore",
	"preview",
	"publish",
	"prepare-bridge",
	"mirror",
	"gate",
] as const;
type HelperControllerCommand = (typeof COMMANDS)[number];
const COMMAND_OPTIONS: Record<HelperControllerCommand, readonly string[]> = {
	preflight: [
		"root",
		"plan",
		"kind",
		"tag",
		"source-run-id",
		"publish",
		"mirror-only",
		"bridge-run-id",
		"bridge-run-attempt",
	],
	build: ["root", "plan", "output", "cache", "platform"],
	smoke: ["root", "plan", "output", "platform"],
	assemble: ["root", "plan", "output", "native"],
	restore: ["root", "plan", "output", "source-run-id"],
	preview: ["root", "plan", "output"],
	publish: [
		"root",
		"plan",
		"output",
		"dry-run",
		"bridge-dir",
		"source-run-attempt",
		"bridge-artifact-id",
		"bridge-artifact-digest",
	],
	"prepare-bridge": ["root", "plan", "output", "bridge-dir", "source-run-attempt"],
	mirror: ["root", "plan", "output", "bridge-dir", "source-run-attempt"],
	gate: [],
};
function validRunId(value: string): boolean {
	return /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
}
export function parseHelperReleaseArguments(args: string[]): {
	command: HelperControllerCommand;
	options: ReadonlyMap<string, string>;
	dryRun: boolean;
} {
	const command = args[0] as HelperControllerCommand;
	if (!COMMANDS.includes(command))
		throw new Error(
			"Expected preflight|build|smoke|assemble|restore|preview|publish; publish explicitly writes remotely, preview and publish --dry-run validate offline",
		);
	const options = new Map<string, string>();
	for (const argument of args.slice(1)) {
		if (!argument.startsWith("--")) throw new Error("Unexpected positional argument");
		const equals = argument.indexOf("=");
		const name = argument.slice(2, equals === -1 ? undefined : equals);
		if (!COMMAND_OPTIONS[command].includes(name))
			throw new Error(`Unknown option for ${command}: --${name}`);
		if (options.has(name)) throw new Error(`Duplicate option: --${name}`);
		if (name === "dry-run") {
			if (equals !== -1) throw new Error("--dry-run is a flag without a value");
			options.set(name, "true");
			continue;
		}
		if (equals === -1) throw new Error(`Expected --${name}=value`);
		const value = argument.slice(equals + 1);
		if (
			value.length > 4096 ||
			Array.from(value).some(
				(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
			) ||
			(!value.trim() &&
				!(
					value === "" &&
					((command === "preflight" &&
						["source-run-id", "bridge-run-id", "bridge-run-attempt"].includes(name)) ||
						(command === "publish" &&
							["bridge-artifact-id", "bridge-artifact-digest"].includes(name)))
				))
		)
			throw new Error(`Invalid option value: --${name}`);
		options.set(name, value);
	}
	if (command === "preflight") {
		const publish = options.get("publish") ?? "false";
		if (publish !== "true" && publish !== "false") throw new Error("Expected --publish=true|false");
		assertBridgeMode({
			publish,
			mirrorOnly: options.get("mirror-only") ?? "false",
			sourceRunId: options.get("source-run-id"),
			bridgeRunId: options.get("bridge-run-id"),
		});
		const kind = options.get("kind");
		const tag = options.get("tag");
		if (kind !== "helpers" && kind !== "executor")
			throw new Error("preflight requires --kind=helpers|executor");
		if (
			!tag ||
			(kind === "helpers"
				? tag !== HELPER_RELEASE_TAG
				: !/^executor-v\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$/.test(tag))
		)
			throw new Error("preflight requires a valid fixed --tag");
	}
	if (
		(command === "build" || command === "smoke") &&
		!HELPER_PLATFORMS.includes(options.get("platform") as HelperPlatform)
	)
		throw new Error(`${command} requires a supported --platform`);
	for (const name of [
		"source-run-id",
		"bridge-run-id",
		"bridge-run-attempt",
		"source-run-attempt",
		"bridge-artifact-id",
	]) {
		const value = options.get(name);
		if (value !== undefined && value !== "" && !validRunId(value))
			throw new Error(`Invalid --${name}`);
	}
	return { command, options, dryRun: options.has("dry-run") };
}
export function resolveHelperRestoreSource(
	plan: HelperReleasePlan,
	requested?: string,
	environment: NodeJS.ProcessEnv = process.env,
): string {
	if (requested === undefined || requested === plan.sourceRunId) return plan.sourceRunId;
	if (
		plan.sourceRunId !== "" ||
		!validRunId(requested) ||
		requested !== environment.GITHUB_RUN_ID ||
		plan.controlCommit !== environment.GITHUB_SHA ||
		environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
		environment.GITHUB_REF !== `refs/heads/${plan.defaultBranch}` ||
		environment.GITHUB_REPOSITORY?.toLowerCase() !== plan.repository.toLowerCase()
	)
		throw new Error("Restore source override cannot change the frozen plan provenance");
	return requested;
}
export async function runHelperReleaseController(args: string[]): Promise<void> {
	const abort = new AbortController();
	const cancel = () => abort.abort(new Error("Helper release cancelled"));
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	const signal = ["prepare-bridge", "publish", "mirror", "restore"].includes(args[0] ?? "")
		? ciBridgeDeadlineSignal(process.env, abort.signal)
		: abort.signal;
	try {
		await runHelperReleaseCommand(args, signal);
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
}
async function runHelperReleaseCommand(args: string[], signal: AbortSignal): Promise<void> {
	const parsed = parseHelperReleaseArguments(args);
	const { command } = parsed;
	if (command === "gate") {
		assertHelperReleaseGate(process.env);
		return;
	}
	const option = (name: string, fallback = "") => parsed.options.get(name) ?? fallback;
	const root = resolve(option("root", "."));
	const planPath = resolve(root, option("plan", ".helper-release/control/plan.json"));
	const output = resolve(root, option("output", ".helper-release/bundle"));
	if (command === "preflight") {
		await writeHelperReleasePlan(
			planPath,
			await planHelperRelease(root, option("kind"), option("tag"), option("source-run-id"), {
				publish: option("publish", "false") === "true",
				mirrorOnly: option("mirror-only", "false") === "true",
				bridgeRunId: option("bridge-run-id"),
				bridgeRunAttempt: option("bridge-run-attempt"),
			}),
		);
		return;
	}
	const plan = await readHelperReleasePlan(planPath);
	if (command === "build" || command === "smoke") {
		const platform = option("platform") as HelperPlatform;
		if (!HELPER_PLATFORMS.includes(platform)) throw new Error("Invalid native helper platform");
		if (command === "build")
			await buildHelperReleasePlatform(
				root,
				plan,
				platform,
				resolve(root, option("cache", ".helper-release/cache")),
				output,
			);
		else await smokeHelperReleasePlatform(plan, platform, output);
	} else if (command === "assemble") {
		await assembleHelperReleaseBundle(
			root,
			plan,
			resolve(root, option("native", ".helper-release/native")),
			output,
		);
	} else if (command === "restore") {
		const restored = await restoreHelperReleaseBundle(
			root,
			{
				...plan,
				sourceRunId: resolveHelperRestoreSource(plan, parsed.options.get("source-run-id")),
			},
			output,
			{ signal, run: createBridgeGhRunner(signal) },
		);
		if (process.env.GITHUB_OUTPUT)
			await appendFile(
				process.env.GITHUB_OUTPUT,
				`source-run-attempt=${restored.sourceRunAttempt}\n`,
			);
	} else if (
		command === "preview" ||
		command === "publish" ||
		command === "prepare-bridge" ||
		command === "mirror"
	) {
		const bridgeOptions = {
			run: createBridgeGhRunner(signal),
			bridgeDir: resolve(root, option("bridge-dir", ".helper-release/bridge")),
			sourceRunAttempt: option("source-run-attempt"),
			artifactId: option("bridge-artifact-id"),
			artifactDigest: option("bridge-artifact-digest"),
			signal,
		};
		if (command === "prepare-bridge") await prepareHelperReleaseBridge(plan, output, bridgeOptions);
		else if (command === "mirror") await mirrorHelperReleasePlan(plan, output, bridgeOptions);
		else
			await publishHelperReleasePlan(
				plan,
				output,
				command === "preview" || parsed.dryRun,
				bridgeOptions,
			);
	} else throw new Error("Expected preflight|build|smoke|assemble|restore|preview|publish");
}
if (import.meta.main) await runHelperReleaseController(process.argv.slice(2));
