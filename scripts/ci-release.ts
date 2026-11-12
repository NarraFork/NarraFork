import { execFileSync } from "node:child_process";
import { appendFile, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { mergeUpdateIndex } from "../shared/update-index";
import { UPDATE_INDEX_FILE, type UpdateIndexRelease } from "../shared/update-index-types";
import { updateServerChildEnvironment } from "../shared/update-server-child-env";
import {
	ciPublicationDeadlineSignal,
	createPublicationGhRunner,
} from "./lib/ci-publication-runtime";
import {
	prepareCiReleaseBuild,
	restoreCiReleaseBuildPlatform,
	restoreCiReleaseRemoteFrontend,
} from "./lib/ci-release-build-restore";
import { assembleReleaseBundle, verifyReleaseBundle } from "./lib/ci-release-bundle";
import { timeReleasePhase } from "./lib/ci-release-io";
import {
	assembleMainReleasePeer,
	buildMainReleasePeer,
	PEER_NATIVE_MATRIX,
	publishMainReleasePeer,
	restoreMainReleasePeer,
	smokeMainReleasePeer,
	verifyMainPeerBuildInputs,
} from "./lib/ci-release-peer";
import {
	createCiReleasePlan,
	revalidateCiReleasePlan,
	validateCiReleasePlan,
} from "./lib/ci-release-plan";
import { restoreCiReleaseBundle } from "./lib/ci-release-restore";
import { CI_RELEASE_TARGETS, type CiReleasePlan } from "./lib/ci-release-types";
import { readTargetComponentDependencies } from "./lib/component-release-inputs";
import { type GhRunner, publishGitHubRelease, runGh } from "./lib/github-release";
import { selectGitHubBaselines } from "./lib/github-release-baseline";
import { type PublicationBuildSource, writePublicationReceipt } from "./lib/publication-receipt";
import {
	prepareRemotePeerRelease,
	restoreRemotePeerReleasePlan,
} from "./lib/remote-peer-release-prepare";
import { prepareUpdateIndexRelease } from "./lib/update-index";
import { preparePublishedUpdateIndexRelease, publishUpdateIndex } from "./lib/update-index-github";

const FLAGS: Record<string, readonly string[]> = {
	preflight: [
		"tag",
		"publish",
		"source-run-id",
		"plan",
		"index-only",
		"build-run-id",
		"build-run-attempt",
		"smoke-target",
	],
	"restore-platform": ["plan", "target", "platform-dir"],
	"restore-remote-frontend": ["plan", "output"],
	"peer-build": ["plan", "platform", "output"],
	"peer-smoke": ["plan", "platform", "output"],
	"peer-assemble": ["plan", "native-dir", "output"],
	"peer-restore": ["plan", "output"],
	assemble: [
		"plan",
		"platforms-dir",
		"smoke-dir",
		"bundle-dir",
		"preview-dir",
		"remote-frontend-dir",
	],
	restore: ["tag", "source-run-id", "bundle-dir"],
	"prepare-bridge": [],
	mirror: [],
	publish: ["tag", "source-run-id", "bundle-dir"],
	index: ["plan", "source-run-id", "bundle-dir", "publish", "preview-dir"],
	gate: [],
};

export function parseCiReleaseArgs(argv: string[]) {
	const command = argv[0];
	if (command === "prepare-bridge" || command === "mirror")
		throw new Error(
			"Legacy bridge publication is retired; use the independent update-server-mirror workflow for an already-public GitHub release. Historical seals are diagnostic only.",
		);
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
	const selected = plan.buildSource?.platforms.map(({ target }) => target);
	return {
		include: CI_RELEASE_TARGETS.filter((entry) => !selected || selected.includes(entry.target)).map(
			(entry) => ({ ...entry, binary: `narrafork-${plan.version}-${entry.suffix}` }),
		),
	};
}

/** Validate recovery combinations before performing any network or filesystem operation. */
export function validateBuildRecoveryArgs(values: Record<string, string>) {
	const buildRun = values["build-run-id"];
	const buildAttempt = values["build-run-attempt"];
	const smokeTarget = values["smoke-target"] || undefined;
	if (Boolean(buildRun) !== Boolean(buildAttempt))
		throw new Error("Original build recovery requires both run ID and explicit attempt");
	if (smokeTarget && !CI_RELEASE_TARGETS.some(({ target }) => target === smokeTarget))
		throw new Error("Unknown native smoke target");
	if (smokeTarget && !buildRun) throw new Error("Single-platform smoke requires an original build");
	if (buildRun) {
		if (values["source-run-id"] || values["index-only"] === "true")
			throw new Error("Original build recovery cannot mix bundle or index recovery");
		if (smokeTarget && values.publish !== "false")
			throw new Error("Single-platform diagnostics cannot publish");
	}
	return {
		buildRunId: buildRun ? positiveId(buildRun) : undefined,
		buildRunAttempt: buildAttempt ? positiveId(buildAttempt) : undefined,
		smokeTarget,
	};
}

export function assertReleaseGate(env: NodeJS.ProcessEnv) {
	if (env.PREFLIGHT_RESULT !== "success") throw new Error("Release preflight did not succeed");
	if (env.RESTORE_MODE !== "true" && env.RESTORE_MODE !== "false")
		throw new Error("Invalid release mode");
	if (env.PUBLISH_REQUESTED !== "true" && env.PUBLISH_REQUESTED !== "false")
		throw new Error("Invalid publish mode");
	if (env.PEER_ACTION !== undefined) {
		if (!["absent", "reuse", "build", "restore"].includes(env.PEER_ACTION))
			throw new Error("Invalid frozen peer action");
		for (const stage of ["BUILD", "SMOKE", "ASSEMBLE", "RESTORE"]) {
			const expected =
				env.PEER_ACTION === (stage === "RESTORE" ? "restore" : "build") ? "success" : "skipped";
			if (env[`PEER_${stage}_RESULT`] !== expected)
				throw new Error(`Unexpected peer ${stage} result`);
		}
	}
	const restoring = env.RESTORE_MODE === "true";
	const reverify = env.BUILD_REUSE_MODE === "true";
	const diagnostic = env.SMOKE_ONLY === "true";
	const recoveryGate = env.BUILD_REUSE_MODE !== undefined || env.SMOKE_ONLY !== undefined;
	if (env.REMOTE_FRONTEND_DECLARED !== undefined) {
		if (!["true", "false"].includes(env.REMOTE_FRONTEND_DECLARED))
			throw new Error("Invalid remote frontend declaration gate");
		const expected =
			env.REMOTE_FRONTEND_DECLARED === "true" && reverify && !diagnostic ? "success" : "skipped";
		if (env.REMOTE_FRONTEND_RESTORE_RESULT !== expected)
			throw new Error("Unexpected remote frontend restore result");
	}
	for (const key of ["BUILD_REUSE_MODE", "SMOKE_ONLY"])
		if (recoveryGate && !["true", "false"].includes(env[key] ?? ""))
			throw new Error(`Invalid ${key}`);
	if ((restoring && reverify) || (diagnostic && (!reverify || env.PUBLISH_REQUESTED !== "false")))
		throw new Error("Invalid build recovery gate mode");
	const expectedResults = {
		VERIFY_RESULT: restoring || reverify ? "skipped" : "success",
		BUILD_RESULT: restoring || reverify ? "skipped" : "success",
		SMOKE_RESULT: restoring ? "skipped" : "success",
		ASSEMBLE_RESULT: restoring || diagnostic ? "skipped" : "success",
	};
	for (const [key, expected] of Object.entries(expectedResults))
		if (env[key] !== expected) throw new Error(`Unexpected ${key}: ${env[key]}`);
	if (
		(reverify && env.RESTORE_PLATFORMS_RESULT !== "success") ||
		(!reverify &&
			(recoveryGate || env.RESTORE_PLATFORMS_RESULT !== undefined) &&
			env.RESTORE_PLATFORMS_RESULT !== "skipped")
	)
		throw new Error("Unexpected original platform restore result");
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
			env: updateServerChildEnvironment(),
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
		componentEvidence: plan.componentEvidence,
		remoteFrontend: plan.remoteFrontend,
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

/** Preserve ordinary upload windows while component reads own shorter budgets and cancellation. */
export function createCiReleaseGhRunner(
	signal: AbortSignal,
	commandRunner: GhRunner,
	readRunner: GhRunner = runGh,
): GhRunner {
	return async (args, controls) => {
		const requestSignal = controls?.signal ? AbortSignal.any([signal, controls.signal]) : signal;
		await setImmediate(undefined, { signal: requestSignal });
		if (controls) return readRunner(args, { ...controls, signal: requestSignal });
		return commandRunner(args);
	};
}

export async function runCiRelease(argv: string[]) {
	const { command, values } = parseCiReleaseArgs(argv);
	const root = process.cwd();
	const abort = new AbortController();
	const onlinePublication =
		command === "publish" || (command === "index" && values.publish === "true");
	const signal = onlinePublication
		? ciPublicationDeadlineSignal(process.env, abort.signal)
		: abort.signal;
	const cancel = () => abort.abort(new Error("CI release cancelled"));
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	const gh = onlinePublication ? createPublicationGhRunner(signal) : runGh;
	const run = createCiReleaseGhRunner(signal, gh);
	try {
		await timeReleasePhase(
			`core.${command}.total`,
			{},
			async () => {
				if (command === "gate") {
					assertReleaseGate(process.env);
					await summary(
						process.env.SMOKE_ONLY === "true"
							? "Single-platform diagnostic passed; no release bundle or publication qualification was created."
							: "Release gate passed; build-only runs have not published a Release or update index.",
					);
					return;
				}
				if (command === "preflight") {
					const publish = required(values, "publish");
					const indexOnly = values["index-only"] ?? "false";
					if (!["true", "false"].includes(publish) || !["true", "false"].includes(indexOnly))
						throw new Error("publish/index-only must be true or false");
					const recovery = validateBuildRecoveryArgs(values);
					const sourceRunId = values["source-run-id"]
						? positiveId(values["source-run-id"])
						: undefined;
					const tag = required(values, "tag");
					const plan = recovery.buildRunId
						? await prepareCiReleaseBuild({
								root,
								tag,
								publish: publish === "true",
								sourceRunId: recovery.buildRunId,
								sourceRunAttempt: recovery.buildRunAttempt as number,
								target: recovery.smokeTarget,
								signal,
							})
						: sourceRunId && indexOnly === "false"
							? await (async () => {
									await mkdir(resolve(".ci-release"), { recursive: true });
									const original = await restoreCiReleaseBundle({
										root,
										tag,
										sourceRunId,
										destination: resolve(".ci-release/preflight-original"),
										signal,
										run,
									});
									return {
										...original.plan,
										remotePeer: restoreRemotePeerReleasePlan(
											original.plan.remotePeer,
											original.plan,
										),
									};
								})()
							: await createCiReleasePlan({
									root,
									tag,
									publish: publish === "true",
									sourceRunId,
									indexOnly: indexOnly === "true",
									signal,
								});
					if (!recovery.buildRunId && !sourceRunId && indexOnly === "false") {
						// Freeze peer decisions for build-only as well as publish, before any compilation.
						plan.remotePeer = await prepareRemotePeerRelease({
							root,
							commit: plan.commit,
							repository: plan.repository,
							run,
							signal,
						});
						if (plan.remotePeer.action === "build")
							await verifyMainPeerBuildInputs(root, plan, signal);
						plan.baselines = await selectGitHubBaselines(plan, { signal });
					}
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
						"peer-action":
							indexOnly === "true" || recovery.smokeTarget
								? "absent"
								: (plan.remotePeer?.action ?? "absent"),
						"peer-matrix": JSON.stringify({
							include:
								plan.remotePeer && plan.remotePeer.action !== "absent"
									? plan.remotePeer.nativeContract
									: PEER_NATIVE_MATRIX,
						}),
						"remote-frontend": String(Boolean(plan.remoteFrontend)),
						"index-only": indexOnly,
						"restore-mode": String(!!sourceRunId || indexOnly === "true"),
						"build-reuse-mode": String(!sourceRunId && !!plan.buildSource),
						"smoke-only": String(!!recovery.smokeTarget),
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
				if (command.startsWith("peer-")) {
					const plan = await readPlan(required(values, "plan"));
					const destination = resolve(required(values, "output"));
					if (command === "peer-build")
						await buildMainReleasePeer(
							root,
							plan,
							required(values, "platform"),
							destination,
							signal,
						);
					else if (command === "peer-smoke")
						await smokeMainReleasePeer(plan, required(values, "platform"), destination, signal);
					else if (command === "peer-assemble")
						await assembleMainReleasePeer(
							root,
							plan,
							resolve(required(values, "native-dir")),
							destination,
							signal,
						);
					else if (command === "peer-restore")
						await restoreMainReleasePeer({ root, plan, output: destination, run, signal });
					return;
				}
				if (command === "restore-remote-frontend") {
					const plan = await readPlan(required(values, "plan"));
					await restoreCiReleaseRemoteFrontend({
						plan,
						root,
						destination: resolve(required(values, "output")),
						signal,
					});
					await summary(`Restored original remote frontend for ${plan.tag}; no rebuild.`);
					return;
				}
				if (command === "restore-platform") {
					const plan = await readPlan(required(values, "plan"));
					await restoreCiReleaseBuildPlatform({
						plan,
						target: required(values, "target"),
						root,
						destination: resolve(required(values, "platform-dir")),
						signal,
					});
					await summary(
						`Restored byte-identical original platform for ${plan.tag}; no product build.`,
					);
					return;
				}
				if (command === "assemble") {
					const plan = await readPlan(required(values, "plan"));
					if (plan.buildSource && plan.buildSource.platforms.length !== CI_RELEASE_TARGETS.length)
						throw new Error("Single-platform diagnostics cannot assemble a release bundle");
					const platformsDir = resolve(required(values, "platforms-dir"));
					const smokeDir = resolve(required(values, "smoke-dir"));
					const bundleDir = resolve(required(values, "bundle-dir"));
					await normalizeMatrixArtifacts(platformsDir, "platform", plan);
					await normalizeMatrixArtifacts(smokeDir, "smoke", plan);
					// Only target source data is read here; build-only never queries component tags/assets.
					const targetHelperDistribution = await readTargetComponentDependencies({
						repository: plan.repository,
						targetCommit: plan.commit,
						signal,
					});
					const manifest = await timeReleasePhase(
						"core.assemble.bundle",
						{ version: plan.version },
						() =>
							assembleReleaseBundle({
								plan,
								targetHelperDistribution,
								platformsDir,
								smokeDir,
								bundleDir,
								remoteFrontendDir: plan.remoteFrontend
									? resolve(required(values, "remote-frontend-dir"))
									: undefined,
								signal: signal,
							}),
						signal,
					);
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
					let plan = await readPlan(required(values, "plan"));
					const shouldPublish = required(values, "publish");
					if (!["true", "false"].includes(shouldPublish))
						throw new Error("publish must be true or false");
					if (shouldPublish === "true") {
						if (process.env.PUBLISH_REQUESTED !== "true")
							throw new Error("Index publication requires an explicit publish request");
						assertPrimaryReleaseCheckout(root);
					}
					plan = await revalidateCiReleasePlan(plan, {
						root,
						publish: shouldPublish === "true",
						requireAlreadyPublished: true,
						run,
						signal,
					});
					let prepared: Awaited<ReturnType<typeof preparePublishedUpdateIndexRelease>>;
					let buildSource: PublicationBuildSource | undefined;
					if (values["source-run-id"]) {
						const destination = resolve(required(values, "bundle-dir"));
						const restored = await restoreCiReleaseBundle({
							sourceRunId: positiveId(values["source-run-id"]),
							tag: plan.tag,
							root,
							destination,
							signal: signal,
						});
						const manifest = await verifyReleaseBundle(destination, restored.plan);
						if (
							manifest.plan.repository.toLowerCase() !== plan.repository.toLowerCase() ||
							manifest.plan.commit !== plan.commit
						)
							throw new Error("Repair bundle target mismatch");
						const options = githubOptions(manifest.plan, join(destination, "dist"));
						await publishGitHubRelease({ ...options, requireAlreadyPublished: true, run, signal });
						buildSource = {
							runId: restored.sourceRunId,
							runAttempt: restored.sourceRunAttempt,
							workflowPath: ".github/workflows/release.yml",
							bundleArtifactId: restored.artifactId,
							nativeProof: "verified-original-bundle",
						};
					}
					// Bundle verification proves immutable bytes; the public reader supplies
					// the approved announcement state for both preview and actual repair.
					prepared = await preparePublishedUpdateIndexRelease({
						repository: plan.repository,
						version: plan.version,
						commit: plan.commit,
						changelog: { ...plan.changelog },
						run,
						signal: signal,
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
					plan = await revalidateCiReleasePlan(plan, {
						root,
						publish: true,
						requireAlreadyPublished: true,
						run,
						signal,
					});
					const receipt = await timeReleasePhase(
						"core.index.publish",
						{},
						() =>
							publishUpdateIndex({
								repository: plan.repository,
								...prepared,
								run,
								signal: signal,
							}),
						signal,
					);
					await writePublicationReceipt({
						kind: "main",
						repository: plan.repository,
						tag: plan.tag,
						version: plan.version,
						commit: plan.commit,
						expectedAssets: prepared.release.files.flatMap((binary) => [
							binary,
							binary.metadata,
							...binary.patches.flatMap((patch) => [patch, patch.metadata]),
						]),
						additionalAssetNames: [
							`narrafork-${plan.version}-SHA256SUMS`,
							`narrafork-${plan.version}-checksums.txt`,
						],
						indexCommit: receipt.commit,
						generation: receipt.generation,
						source: {
							runId: positiveId(process.env.GITHUB_RUN_ID ?? ""),
							runAttempt: positiveId(process.env.GITHUB_RUN_ATTEMPT ?? ""),
							workflowPath: ".github/workflows/release.yml",
							nativeProof: "verified-public-index-repair",
						},
						buildSource,
						run,
						signal,
					});
					await output({
						"index-commit": receipt.commit,
						"index-generation": String(receipt.generation),
						"publication-status": "INDEXED",
					});
					await summary(
						`Update index repaired: ${receipt.commit}, generation ${receipt.generation}. Existing Release assets were not changed.`,
					);
					return;
				}
				const sourceRunId = positiveId(required(values, "source-run-id"));
				const tag = required(values, "tag");
				const destination = resolve(required(values, "bundle-dir"));
				// Each entry restores immutable Actions bytes with original source-job proof.
				// A caller-selected local manifest cannot replace the trusted source artifact.
				const restored = await restoreCiReleaseBundle({
					sourceRunId,
					tag,
					root,
					destination,
					signal,
					run,
				});
				const manifest = await verifyReleaseBundle(destination, restored.plan);
				if (manifest.plan.tag !== tag || manifest.plan.runId !== sourceRunId)
					throw new Error("Original bundle run/tag mismatch");
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
				// Build-only bundles remain byte-identical: new online evidence belongs to control state.
				const publisherPlan = await revalidateCiReleasePlan(manifest.plan, {
					root,
					publish: true,
					requireAlreadyPublished: false,
					run,
					signal,
					helperDistribution: manifest.helperDistribution,
				});
				if (publisherPlan.componentEvidence) {
					const controlDir = resolve(".ci-release/control");
					await mkdir(controlDir, { recursive: true });
					await writeFile(
						join(controlDir, "publisher-plan.json"),
						`${JSON.stringify(publisherPlan, null, 2)}\n`,
					);
				}
				signal.throwIfAborted();
				const options = githubOptions(publisherPlan, join(destination, "dist"));
				// Validate the bounded record before making the Release public.
				const prepared = await prepareUpdateIndexRelease(options);
				// A required new peer must be public and read back before NF can become public.
				await publishMainReleasePeer({
					root,
					plan: publisherPlan,
					run,
					output: resolve(".ci-release/publish-peer"),
					signal,
				});
				const result = await timeReleasePhase(
					"core.publish.github",
					{ version: publisherPlan.version },
					() =>
						publishGitHubRelease({
							...options,
							preventStableLatestRollback: true,
							run,
							signal,
						}),
					signal,
				);
				await output({ "publication-status": "PUBLISHED" });
				try {
					const receipt = await timeReleasePhase(
						"core.index.publish",
						{},
						() =>
							publishUpdateIndex({
								repository: manifest.plan.repository,
								...prepared,
								run,
								signal: signal,
							}),
						signal,
					);
					await writePublicationReceipt({
						kind: "main",
						repository: manifest.plan.repository,
						tag,
						version: manifest.plan.version,
						commit: manifest.plan.commit,
						expectedAssets: manifest.files,
						indexCommit: receipt.commit,
						generation: receipt.generation,
						source: {
							runId: positiveId(process.env.GITHUB_RUN_ID ?? ""),
							runAttempt: positiveId(process.env.GITHUB_RUN_ATTEMPT ?? ""),
							workflowPath: ".github/workflows/release.yml",
							nativeProof: "verified-original-bundle",
						},
						buildSource: {
							runId: sourceRunId,
							runAttempt: restored.sourceRunAttempt,
							workflowPath: ".github/workflows/release.yml",
							bundleArtifactId: restored.artifactId,
							nativeProof: "verified-original-bundle",
						},
						run,
						signal,
					});
					await output({
						"index-commit": receipt.commit,
						"index-generation": String(receipt.generation),
						"publication-status": "INDEXED",
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
			},
			signal,
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
