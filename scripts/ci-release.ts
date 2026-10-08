import { execFileSync } from "node:child_process";
import { appendFile, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { assembleReleaseBundle, verifyReleaseBundle } from "./lib/ci-release-bundle";
import {
	createCiReleasePlan,
	revalidateCiReleasePlan,
	validateCiReleasePlan,
} from "./lib/ci-release-plan";
import { restoreCiReleaseBundle } from "./lib/ci-release-restore";
import { CI_RELEASE_TARGETS, type CiReleasePlan } from "./lib/ci-release-types";
import { publishGitHubRelease, runGh } from "./lib/github-release";
import { selectGitHubBaselines } from "./lib/github-release-baseline";

const FLAGS: Record<string, readonly string[]> = {
	preflight: ["tag", "publish", "source-run-id", "plan"],
	assemble: ["plan", "platforms-dir", "smoke-dir", "bundle-dir"],
	restore: ["tag", "source-run-id", "bundle-dir"],
	publish: ["tag", "source-run-id", "bundle-dir"],
	gate: [],
};

export function parseCiReleaseArgs(argv: string[]) {
	const command = argv[0];
	if (!command || !Object.hasOwn(FLAGS, command)) throw new Error("Unknown CI release command");
	const values: Record<string, string> = {};
	for (const arg of argv.slice(1)) {
		const match = /^--([a-z-]+)=(.*)$/.exec(arg);
		const key = match?.[1];
		const value = match?.[2];
		if (!key || value === undefined || !FLAGS[command]?.includes(key) || Object.hasOwn(values, key))
			throw new Error("Unknown or duplicate CI release argument");
		values[key] = value;
	}
	return { command, values };
}

function required(values: Record<string, string>, key: string): string {
	const value = values[key];
	if (!value) throw new Error(`Missing --${key}`);
	return value;
}
function positiveId(value: string): number {
	if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
		throw new Error("Invalid run ID");
	return Number(value);
}
export function releaseMatrix(plan: CiReleasePlan) {
	return {
		include: CI_RELEASE_TARGETS.map((entry) => ({
			...entry,
			binary: `narrafork-${plan.version}-${entry.suffix}`,
		})),
	};
}

export function assertReleaseGate(env: NodeJS.ProcessEnv) {
	if (env.PREFLIGHT_RESULT !== "success") throw new Error("Release preflight did not succeed");
	if (env.RESTORE_MODE !== "true" && env.RESTORE_MODE !== "false")
		throw new Error("Invalid release mode");
	if (env.PUBLISH_REQUESTED !== "true" && env.PUBLISH_REQUESTED !== "false")
		throw new Error("Invalid publish mode");
	const restoring = env.RESTORE_MODE === "true";
	for (const key of ["VERIFY_RESULT", "BUILD_RESULT", "SMOKE_RESULT", "ASSEMBLE_RESULT"]) {
		if (env[key] !== (restoring ? "skipped" : "success"))
			throw new Error(`Unexpected ${key}: ${env[key]}`);
	}
	if (env.RESTORE_RESULT !== (restoring ? "success" : "skipped"))
		throw new Error("Unexpected restore result");
	if (env.PUBLISH_RESULT !== (env.PUBLISH_REQUESTED === "true" ? "success" : "skipped"))
		throw new Error("Unexpected publish result");
}

async function readPlan(path: string) {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid release plan file");
	return validateCiReleasePlan(JSON.parse(await readFile(path, "utf8")));
}
async function output(values: Record<string, string>) {
	const file = process.env.GITHUB_OUTPUT;
	if (!file) return;
	for (const [name, value] of Object.entries(values)) {
		if (!/^[a-z-]+$/.test(name) || /[\r\n]/.test(value)) throw new Error("Invalid Actions output");
		await appendFile(file, `${name}=${value}\n`);
	}
}
async function summary(message: string) {
	console.log(message);
	if (process.env.GITHUB_STEP_SUMMARY)
		await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

/** Only the exact eight artifacts of this run/attempt may feed an assembled bundle. */
export async function normalizeMatrixArtifacts(
	directory: string,
	kind: "platform" | "smoke",
	plan: CiReleasePlan,
) {
	const entries = await readdir(directory, { withFileTypes: true });
	const expected = new Map(
		CI_RELEASE_TARGETS.map(({ target }) => [
			`release-${kind}-${target}-${plan.runId}-${plan.runAttempt}`,
			target,
		]),
	);
	if (entries.length !== expected.size) throw new Error(`Incomplete ${kind} artifact matrix`);
	for (const entry of entries) {
		const target = expected.get(entry.name);
		if (!target || !entry.isDirectory() || entry.isSymbolicLink())
			throw new Error(`Unexpected ${kind} artifact directory`);
		await rename(join(directory, entry.name), join(directory, target));
	}
}

export function assertPrimaryReleaseCheckout(root: string) {
	const dirs = execFileSync(
		"git",
		["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
		{
			cwd: root,
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 16 * 1024,
		},
	)
		.trim()
		.split("\n");
	if (dirs.length !== 2 || dirs[0] !== dirs[1])
		throw new Error("Real releases require a primary checkout, not a linked worktree");
}

export async function runCiRelease(argv: string[]) {
	const { command, values } = parseCiReleaseArgs(argv);
	const root = process.cwd();
	const abort = new AbortController();
	const cancel = () => abort.abort(new Error("CI release cancelled"));
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	try {
		if (command === "gate") {
			assertReleaseGate(process.env);
			await summary("Release gate passed; build-only runs have not published a Release.");
			return;
		}
		if (command === "preflight") {
			const publish = required(values, "publish");
			if (publish !== "true" && publish !== "false")
				throw new Error("--publish must be true or false");
			const sourceRunId = values["source-run-id"] ? positiveId(values["source-run-id"]) : undefined;
			const plan = await createCiReleasePlan({
				root,
				tag: required(values, "tag"),
				publish: publish === "true",
				sourceRunId,
			});
			if (!sourceRunId)
				plan.baselines = await selectGitHubBaselines(plan, { signal: abort.signal });
			validateCiReleasePlan(plan);
			const path = resolve(required(values, "plan"));
			await mkdir(resolve(path, ".."), { recursive: true });
			await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
			await output({
				commit: plan.commit,
				version: plan.version,
				matrix: JSON.stringify(releaseMatrix(plan)),
				"restore-mode": String(!!sourceRunId),
				"source-run-id": String(sourceRunId ?? plan.runId),
			});
			await summary(
				`Release ${plan.tag}; source ${plan.commit}; control ${plan.workflowCommit}; ${sourceRunId ? "restore" : "build"}; publish=${publish}.`,
			);
			return;
		}
		if (command === "assemble") {
			const plan = await readPlan(required(values, "plan"));
			const platformsDir = resolve(required(values, "platforms-dir"));
			const smokeDir = resolve(required(values, "smoke-dir"));
			await normalizeMatrixArtifacts(platformsDir, "platform", plan);
			await normalizeMatrixArtifacts(smokeDir, "smoke", plan);
			const manifest = await assembleReleaseBundle({
				plan,
				platformsDir,
				smokeDir,
				bundleDir: resolve(required(values, "bundle-dir")),
				signal: abort.signal,
			});
			await summary(
				`Sealed ${manifest.files.length} assets for ${plan.tag}; all eight native smoke results verified. No Release was published by assembly.`,
			);
			return;
		}
		const sourceRunId = positiveId(required(values, "source-run-id"));
		const tag = required(values, "tag");
		const destination = resolve(required(values, "bundle-dir"));
		const restored = await restoreCiReleaseBundle({
			sourceRunId,
			tag,
			root,
			destination,
			signal: abort.signal,
		});
		const manifest = await verifyReleaseBundle(destination, restored.plan);
		if (command === "restore") {
			await revalidateCiReleasePlan(manifest.plan, { root, publish: false });
			await output({
				"artifact-id": String(restored.artifactId),
				"source-run-id": String(sourceRunId),
			});
			await summary(
				`Verified original bundle from run ${restored.sourceRunId}, attempt ${restored.sourceRunAttempt}, artifact ${restored.artifactId}; no rebuild, signing or patch regeneration.`,
			);
			return;
		}
		if (process.env.PUBLISH_REQUESTED !== "true")
			throw new Error("Publication requires an explicit publish request");
		assertPrimaryReleaseCheckout(root);
		await revalidateCiReleasePlan(manifest.plan, { root, publish: true });
		abort.signal.throwIfAborted();
		const result = await publishGitHubRelease({
			distDir: join(destination, "dist"),
			version: manifest.plan.version,
			repository: manifest.plan.repository,
			commit: manifest.plan.commit,
			changelog: { ...manifest.plan.changelog },
			platformSuffixes: new Map(CI_RELEASE_TARGETS.map((entry) => [entry.platform, entry.suffix])),
			preventStableLatestRollback: true,
			run: async (args) => {
				await setImmediate(undefined, { signal: abort.signal });
				return runGh(args);
			},
		});
		await summary(
			`Release ${tag}: ${result.alreadyPublished ? "already published and verified" : "published and verified"}; ${result.assets.length} assets. Original artifact: ${restored.artifactId}.`,
		);
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
}

if (import.meta.main) {
	runCiRelease(process.argv.slice(2)).catch((error) => {
		console.error(
			`Release CI failed; existing draft/public assets are retained: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	});
}
