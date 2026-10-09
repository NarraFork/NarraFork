import { execFileSync } from "node:child_process";
import { appendFile, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { mergeUpdateIndex } from "../shared/update-index";
import { UPDATE_INDEX_FILE, type UpdateIndexRelease } from "../shared/update-index-types";
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
import { prepareUpdateIndexRelease } from "./lib/update-index";
import { preparePublishedUpdateIndexRelease, publishUpdateIndex } from "./lib/update-index-github";

const FLAGS: Record<string, readonly string[]> = {
	preflight: ["tag", "publish", "source-run-id", "plan", "index-only"],
	assemble: ["plan", "platforms-dir", "smoke-dir", "bundle-dir", "preview-dir"],
	restore: ["tag", "source-run-id", "bundle-dir"],
	publish: ["tag", "source-run-id", "bundle-dir"],
	index: ["plan", "source-run-id", "bundle-dir", "publish", "preview-dir"],
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
	if (env.INDEX_ONLY !== undefined && env.INDEX_ONLY !== "true" && env.INDEX_ONLY !== "false")
		throw new Error("Invalid index repair mode");
	if (env.INDEX_ONLY === "true" && !restoring)
		throw new Error("Index repair cannot run build jobs");
	if (
		env.PUBLISH_REQUESTED === "true" &&
		(!/^[a-f0-9]{40}$/.test(env.INDEX_COMMIT ?? "") ||
			!/^[1-9]\d*$/.test(env.INDEX_GENERATION ?? ""))
	)
		throw new Error("Release publication lacks a verified index receipt");
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

function githubOptions(plan: CiReleasePlan, distDir: string) {
	return {
		distDir,
		version: plan.version,
		repository: plan.repository,
		commit: plan.commit,
		changelog: { ...plan.changelog },
		requireBuildRepository: true,
		platformSuffixes: new Map(CI_RELEASE_TARGETS.map((entry) => [entry.platform, entry.suffix])),
	};
}

async function writeIndexPreview(
	directory: string,
	prepared: {
		release: UpdateIndexRelease;
		notes?: { path: string; content: string; size: number; sha256: string };
	},
	repository: string,
) {
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, UPDATE_INDEX_FILE),
		`${JSON.stringify(mergeUpdateIndex(null, prepared.release, repository, prepared.release.publishedAt), null, 2)}\n`,
		{ flag: "wx" },
	);
	await writeFile(
		join(directory, "release.json"),
		`${JSON.stringify(prepared.release, null, 2)}\n`,
		{ flag: "wx" },
	);
	if (prepared.notes) {
		if (!/^notes\/[A-Za-z0-9.+_-]+\.json$/.test(prepared.notes.path))
			throw new Error("Unsafe notes preview path");
		const path = join(directory, prepared.notes.path);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, prepared.notes.content, { flag: "wx" });
	}
}

export async function runCiRelease(argv: string[]) {
	const { command, values } = parseCiReleaseArgs(argv);
	const root = process.cwd();
	const abort = new AbortController();
	const cancel = () => abort.abort(new Error("CI release cancelled"));
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	const run = async (args: string[]) => {
		await setImmediate(undefined, { signal: abort.signal });
		return runGh(args);
	};
	try {
		if (command === "gate") {
			assertReleaseGate(process.env);
			await summary(
				"Release gate passed; build-only runs have not published a Release or update index.",
			);
			return;
		}
		if (command === "preflight") {
			const publish = required(values, "publish");
			const indexOnly = values["index-only"] ?? "false";
			if (!["true", "false"].includes(publish) || !["true", "false"].includes(indexOnly))
				throw new Error("publish/index-only must be true or false");
			const sourceRunId = values["source-run-id"] ? positiveId(values["source-run-id"]) : undefined;
			const plan = await createCiReleasePlan({
				root,
				tag: required(values, "tag"),
				publish: publish === "true",
				sourceRunId,
				indexOnly: indexOnly === "true",
			});
			if (!sourceRunId && indexOnly === "false")
				plan.baselines = await selectGitHubBaselines(plan, { signal: abort.signal });
			validateCiReleasePlan(plan);
			const path = resolve(required(values, "plan"));
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
			await output({
				commit: plan.commit,
				version: plan.version,
				repository: plan.repository,
				"default-branch": plan.defaultBranch ?? "main",
				matrix: JSON.stringify(releaseMatrix(plan)),
				"index-only": indexOnly,
				"restore-mode": String(!!sourceRunId || indexOnly === "true"),
				"source-run-id": sourceRunId
					? String(sourceRunId)
					: indexOnly === "true"
						? ""
						: String(plan.runId),
			});
			await summary(
				`Release ${plan.repository}@${plan.tag}; source ${plan.commit}; control ${plan.workflowCommit}; index-only=${indexOnly}; publish=${publish}.`,
			);
			return;
		}
		if (command === "assemble") {
			const plan = await readPlan(required(values, "plan"));
			const platformsDir = resolve(required(values, "platforms-dir"));
			const smokeDir = resolve(required(values, "smoke-dir"));
			const bundleDir = resolve(required(values, "bundle-dir"));
			await normalizeMatrixArtifacts(platformsDir, "platform", plan);
			await normalizeMatrixArtifacts(smokeDir, "smoke", plan);
			const manifest = await assembleReleaseBundle({
				plan,
				platformsDir,
				smokeDir,
				bundleDir,
				signal: abort.signal,
			});
			const prepared = await prepareUpdateIndexRelease(
				githubOptions(plan, join(bundleDir, "dist")),
			);
			await writeIndexPreview(
				resolve(values["preview-dir"] ?? ".ci-release/index-preview"),
				prepared,
				plan.repository,
			);
			await summary(
				`Sealed ${manifest.files.length} assets for ${plan.tag}; eight native smoke results and bounded update-index preview verified. No remote writes.`,
			);
			return;
		}
		if (command === "index") {
			const plan = await readPlan(required(values, "plan"));
			const shouldPublish = required(values, "publish");
			if (!["true", "false"].includes(shouldPublish))
				throw new Error("publish must be true or false");
			if (shouldPublish === "true") {
				if (process.env.PUBLISH_REQUESTED !== "true")
					throw new Error("Index publication requires an explicit publish request");
				assertPrimaryReleaseCheckout(root);
			}
			await revalidateCiReleasePlan(plan, { root, publish: shouldPublish === "true" });
			let prepared: Awaited<ReturnType<typeof preparePublishedUpdateIndexRelease>>;
			if (values["source-run-id"]) {
				const destination = resolve(required(values, "bundle-dir"));
				const restored = await restoreCiReleaseBundle({
					sourceRunId: positiveId(values["source-run-id"]),
					tag: plan.tag,
					root,
					destination,
					signal: abort.signal,
				});
				const manifest = await verifyReleaseBundle(destination, restored.plan);
				if (
					manifest.plan.repository.toLowerCase() !== plan.repository.toLowerCase() ||
					manifest.plan.commit !== plan.commit
				)
					throw new Error("Repair bundle target mismatch");
				const options = githubOptions(manifest.plan, join(destination, "dist"));
				await publishGitHubRelease({ ...options, requireAlreadyPublished: true, run });
			}
			// Bundle verification proves immutable bytes; the public reader supplies
			// the approved announcement state for both preview and actual repair.
			prepared = await preparePublishedUpdateIndexRelease({
				repository: plan.repository,
				version: plan.version,
				commit: plan.commit,
				changelog: { ...plan.changelog },
				run,
				signal: abort.signal,
			});
			if (shouldPublish === "false") {
				await writeIndexPreview(
					resolve(values["preview-dir"] ?? ".ci-release/index-preview"),
					prepared,
					plan.repository,
				);
				await summary(
					`Read-only index repair preview prepared for ${plan.repository}@${plan.tag}; no Release or ref was changed.`,
				);
				return;
			}
			await revalidateCiReleasePlan(plan, { root, publish: true });
			const receipt = await publishUpdateIndex({
				repository: plan.repository,
				...prepared,
				run,
				signal: abort.signal,
			});
			await output({
				"index-commit": receipt.commit,
				"index-generation": String(receipt.generation),
			});
			await summary(
				`Update index repaired: ${receipt.commit}, generation ${receipt.generation}. Existing Release assets were not changed.`,
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
				`Verified original bundle run ${restored.sourceRunId}, attempt ${restored.sourceRunAttempt}, artifact ${restored.artifactId}; no rebuild.`,
			);
			return;
		}
		if (process.env.PUBLISH_REQUESTED !== "true")
			throw new Error("Publication requires an explicit publish request");
		assertPrimaryReleaseCheckout(root);
		await revalidateCiReleasePlan(manifest.plan, { root, publish: true });
		abort.signal.throwIfAborted();
		const options = githubOptions(manifest.plan, join(destination, "dist"));
		// Validate the bounded record before making the Release public.
		const prepared = await prepareUpdateIndexRelease(options);
		const result = await publishGitHubRelease({
			...options,
			preventStableLatestRollback: true,
			run,
		});
		try {
			const receipt = await publishUpdateIndex({
				repository: manifest.plan.repository,
				...prepared,
				run,
				signal: abort.signal,
			});
			await output({
				"index-commit": receipt.commit,
				"index-generation": String(receipt.generation),
			});
			await summary(
				`Release ${tag}: ${result.alreadyPublished ? "already published and verified" : "published and verified"}; index ${receipt.commit} generation ${receipt.generation}. Original artifact: ${restored.artifactId}.`,
			);
		} catch (error) {
			await summary(
				`PUBLISHED_NOT_INDEXED: ${tag} is public but its update index could not be confirmed. Resume with source_run_id or use index_only repair; never rebuild/overwrite this release.`,
			);
			throw error;
		}
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
