import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	REMOTE_PEER_MANIFEST_FILENAME,
	REMOTE_PEER_PLATFORMS,
	type RemotePeerPlatform,
} from "../../shared/remote-peer";
import { runPublicationProcess } from "./ci-publication-runtime";
import {
	ciApi,
	ciApiList,
	parseCiId,
	revalidateCiReleasePlan,
	validateCiDispatch,
} from "./ci-release-plan";
import { downloadArchive } from "./ci-release-restore";
import { CI_RELEASE_WORKFLOW, type CiReleasePlan } from "./ci-release-types";
import type { GhRunner } from "./github-release";
import { validateHelperArtifactZip } from "./helper-artifact";
import {
	findPublishedRemotePeerRelease,
	isMissingPeerRemote,
	publishHelperRelease,
	resolveHelperTagCommit,
	validateHelperReleaseBundle,
} from "./helper-release";
import {
	assembleHelperReleaseBundle,
	buildHelperReleasePlatform,
	type HelperReleasePlan,
	smokeHelperReleasePlatform,
} from "./helper-release-control";
import {
	REMOTE_PEER_PUBLICATION_RECEIPT_PATH,
	writePublicationReceipt,
} from "./publication-receipt";
import {
	compareRemotePeerRecipeIdentity,
	createGitRemotePeerSource,
	fingerprintRemotePeerInputs,
	REMOTE_PEER_NATIVE_CONTRACT,
} from "./remote-peer-release-inputs";
import { validateRemotePeerReleasePlan } from "./remote-peer-release-prepare";

export const PEER_NATIVE_MATRIX = REMOTE_PEER_NATIVE_CONTRACT;
export const REQUIRED_MAIN_PEER_JOBS = [
	"Release preflight",
	"Peer Assemble",
	...REMOTE_PEER_PLATFORMS.flatMap((platform) => [
		`Peer Build (${platform})`,
		`Peer Native Smoke (${platform})`,
	]),
];
function peerIdentity(plan: CiReleasePlan) {
	const peer = validateRemotePeerReleasePlan(plan.remotePeer);
	if (peer.action === "absent") throw new Error("NF has no peer pin");
	return peer;
}
export function mainPeerHelperPlan(plan: CiReleasePlan): HelperReleasePlan {
	const peer = peerIdentity(plan);
	return {
		schemaVersion: 1,
		repository: plan.repository,
		defaultBranch: plan.defaultBranch ?? "main",
		tag: peer.tag,
		version: peer.version,
		protocolVersion: peer.protocolVersion,
		commit: peer.sourceCommit,
		controlCommit: plan.workflowCommit,
		kind: "remote-peer",
		sourceRunId: "",
		publish: false,
	};
}
export function mainPeerArtifactName(plan: CiReleasePlan): string {
	const peer = peerIdentity(plan);
	const origin = peer.buildSource ?? plan;
	return `release-peer-bundle-${peer.sourceCommit}-${origin.runId}-${origin.runAttempt}`;
}
export async function verifyMainPeerBuildInputs(
	root: string,
	plan: CiReleasePlan,
	signal?: AbortSignal,
) {
	const peer = peerIdentity(plan);
	if (peer.action !== "build") throw new Error("Only a frozen new peer can be built");
	const source = createGitRemotePeerSource(root, signal);
	const actual = await fingerprintRemotePeerInputs({
		commit: plan.commit,
		source,
		protocolVersion: peer.protocolVersion,
		signal,
	});
	if (actual !== peer.inputsSha256) throw new Error("Frozen peer production inputs changed");
	await compareRemotePeerRecipeIdentity({
		commit: plan.commit,
		controlCommit: plan.workflowCommit,
		readSource: source.read,
		signal,
	});
}
export async function buildMainReleasePeer(
	root: string,
	plan: CiReleasePlan,
	platform: string,
	output: string,
	signal?: AbortSignal,
) {
	if (!REMOTE_PEER_PLATFORMS.includes(platform as RemotePeerPlatform))
		throw new Error("Unknown peer build platform");
	await verifyMainPeerBuildInputs(root, plan, signal);
	await buildHelperReleasePlatform(
		root,
		mainPeerHelperPlan(plan),
		platform as RemotePeerPlatform,
		"",
		output,
		signal,
	);
}
export async function smokeMainReleasePeer(
	plan: CiReleasePlan,
	platform: string,
	output: string,
	signal?: AbortSignal,
) {
	if (
		peerIdentity(plan).action !== "build" ||
		!REMOTE_PEER_PLATFORMS.includes(platform as RemotePeerPlatform)
	)
		throw new Error("Invalid frozen peer smoke");
	await smokeHelperReleasePlatform(
		mainPeerHelperPlan(plan),
		platform as RemotePeerPlatform,
		output,
		signal,
	);
}
export async function assembleMainReleasePeer(
	root: string,
	plan: CiReleasePlan,
	nativeDir: string,
	output: string,
	signal?: AbortSignal,
) {
	await verifyMainPeerBuildInputs(root, plan, signal);
	const dirs = await readdir(nativeDir, { withFileTypes: true });
	if (dirs.length !== REMOTE_PEER_PLATFORMS.length)
		throw new Error("Incomplete peer native matrix");
	for (const platform of REMOTE_PEER_PLATFORMS) {
		const name = `release-peer-native-${platform}-${plan.runId}-${plan.runAttempt}`;
		if (
			!dirs.some((entry) => entry.name === name && entry.isDirectory() && !entry.isSymbolicLink())
		)
			throw new Error("Unexpected peer native artifact identity");
		await rename(join(nativeDir, name), join(nativeDir, `helper-native-${platform}`));
	}
	await assembleHelperReleaseBundle(root, mainPeerHelperPlan(plan), nativeDir, output);
}

/** Narrow main-workflow provenance. No arbitrary workflow and no standalone bundle substitution. */
export function validateMainPeerSource(
	plan: CiReleasePlan,
	source: unknown,
	jobs: unknown,
	artifact: unknown,
) {
	const peer = peerIdentity(plan);
	const origin = peer.buildSource ?? plan;
	const run = source as Record<string, unknown>;
	const repo = run.repository as { id?: number; full_name?: string } | undefined;
	const head = run.head_repository as { id?: number; full_name?: string } | undefined;
	if (
		run.id !== origin.runId ||
		run.run_attempt !== origin.runAttempt ||
		run.path !== CI_RELEASE_WORKFLOW ||
		run.event !== "workflow_dispatch" ||
		run.head_sha !== origin.workflowCommit ||
		run.head_branch !== (plan.defaultBranch ?? "main") ||
		!Number.isSafeInteger(repo?.id) ||
		(repo?.id ?? 0) < 1 ||
		repo?.full_name !== plan.repository ||
		head?.full_name !== plan.repository ||
		repo?.id !== head?.id ||
		!["completed", "in_progress"].includes(String(run.status))
	)
		throw new Error("Untrusted main peer source run");
	if (!Array.isArray(jobs) || jobs.length > 100) throw new Error("Invalid main peer job list");
	for (const name of REQUIRED_MAIN_PEER_JOBS) {
		const matches = jobs.filter((job) => job.name === name);
		if (
			matches.length !== 1 ||
			matches[0].conclusion !== "success" ||
			matches[0].status !== "completed" ||
			matches[0].run_id !== origin.runId ||
			matches[0].run_attempt !== origin.runAttempt ||
			matches[0].head_sha !== origin.workflowCommit ||
			peer.nativeContract.some(
				({ platform, runner }) =>
					name === `Peer Native Smoke (${platform})` &&
					(!Array.isArray(matches[0].labels) || !matches[0].labels.includes(runner)),
			)
		)
			throw new Error(`Missing original native peer proof: ${name}`);
	}
	const a = artifact as {
		id: number;
		name: string;
		expired: boolean;
		size_in_bytes: number;
		digest: string;
		workflow_run: {
			id: number;
			repository_id: number;
			head_repository_id: number;
			head_sha: string;
			head_branch: string;
		};
	};
	if (
		!Number.isSafeInteger(a.id) ||
		a.id < 1 ||
		a.name !== mainPeerArtifactName(plan) ||
		a.expired !== false ||
		!Number.isSafeInteger(a.size_in_bytes) ||
		a.size_in_bytes < 1 ||
		a.size_in_bytes > 512 * 1024 * 1024 ||
		!/^sha256:[a-f0-9]{64}$/.test(a.digest) ||
		!a.workflow_run ||
		a.workflow_run.id !== origin.runId ||
		a.workflow_run.repository_id !== repo?.id ||
		a.workflow_run.head_repository_id !== repo?.id ||
		a.workflow_run.head_sha !== origin.workflowCommit ||
		a.workflow_run.head_branch !== run.head_branch
	)
		throw new Error("Immutable main peer artifact provenance mismatch");
	return { ...a, expired: false as const };
}
export async function restoreMainReleasePeer(options: {
	root: string;
	plan: CiReleasePlan;
	output: string;
	run: GhRunner;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
}) {
	const peer = peerIdentity(options.plan);
	if (peer.action !== "build" && peer.action !== "restore")
		throw new Error("Peer restore requires frozen original build identity");
	const origin = peer.buildSource ?? options.plan;
	const { repository } = options.plan;
	const source = await ciApi(
		options.run,
		`actions/runs/${origin.runId}/attempts/${origin.runAttempt}`,
		repository,
	);
	const jobs = await ciApiList(
		options.run,
		`actions/runs/${origin.runId}/attempts/${origin.runAttempt}/jobs`,
		"jobs",
		repository,
	);
	const artifacts = await ciApiList(
		options.run,
		`actions/runs/${origin.runId}/artifacts`,
		"artifacts",
		repository,
	);
	const matches = artifacts.filter(
		(value) => (value as { name?: string }).name === mainPeerArtifactName(options.plan),
	);
	if (matches.length !== 1)
		throw new Error("Missing exact original main peer bundle; rebuilding is forbidden");
	const listed = matches[0] as { id: number; name: string; digest: string; size_in_bytes: number };
	const metadata = await ciApi(
		options.run,
		`actions/artifacts/${parseCiId(listed.id)}`,
		repository,
	);
	if (JSON.stringify(metadata) !== JSON.stringify(matches[0])) {
		const a = metadata as { id?: number; name?: string; digest?: string; size_in_bytes?: number };
		if (
			a.id !== listed.id ||
			a.name !== listed.name ||
			a.digest !== listed.digest ||
			a.size_in_bytes !== listed.size_in_bytes
		)
			throw new Error("Peer artifact listing changed");
	}
	const artifact = validateMainPeerSource(options.plan, source, jobs, metadata);
	const env = options.env ?? process.env;
	if (
		(source as { status?: string }).status !== "completed" &&
		(origin.runId !== Number(env.GITHUB_RUN_ID) ||
			origin.runAttempt !== Number(env.GITHUB_RUN_ATTEMPT))
	)
		throw new Error("Unfinished foreign main peer run");
	await mkdir(dirname(resolve(options.output)), { recursive: true });
	const temporary = await mkdtemp(join(dirname(resolve(options.output)), ".peer-restore-"));
	const archive = join(temporary, "peer.zip");
	let ownsOutput = false;
	try {
		await downloadArchive(
			artifact,
			repository,
			archive,
			env,
			options.fetch ?? fetch,
			options.signal,
		);
		await validateHelperArtifactZip(archive);
		await mkdir(options.output, { recursive: false });
		ownsOutput = true;
		await runPublicationProcess("unzip", ["-q", archive, "-d", options.output], {
			signal: options.signal,
			environment: env,
			timeoutMs: 30_000,
			maximumOutputBytes: 64 * 1024,
		});
		await validateHelperReleaseBundle({
			...mainPeerHelperPlan(options.plan),
			bundleDir: options.output,
		});
		return { artifactId: artifact.id, runId: origin.runId, runAttempt: origin.runAttempt };
	} catch (error) {
		if (ownsOutput) await rm(options.output, { recursive: true, force: true });
		throw error;
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

/** The sole write path runs inside the existing main publisher's release Environment. */
export async function publishMainReleasePeer(options: {
	receiptPath?: string;
	root: string;
	plan: CiReleasePlan;
	run: GhRunner;
	output: string;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
}) {
	const peer = options.plan.remotePeer;
	if (!peer || peer.action === "absent") return;
	const environment = options.env ?? process.env;
	const dispatch = validateCiDispatch(environment, options.plan.defaultBranch ?? "main");
	if (
		dispatch.repository !== options.plan.repository ||
		environment.GITHUB_JOB !== "publish" ||
		environment.PUBLISH_REQUESTED !== "true"
	)
		throw new Error("Peer publication requires the fixed approved main publisher");
	if (peer.action === "reuse") {
		const current = await findPublishedRemotePeerRelease({
			...mainPeerHelperPlan(options.plan),
			run: options.run,
			signal: options.signal,
		});
		if (current?.commit !== peer.sourceCommit || current.manifestSha256 !== peer.manifestSha256)
			throw new Error("Frozen public peer reuse identity changed");
		return;
	}
	// Restore before creating even a tag. A local caller-supplied directory never qualifies.
	const original = await restoreMainReleasePeer(options);
	const helper = mainPeerHelperPlan(options.plan);
	const description = await validateHelperReleaseBundle({ ...helper, bundleDir: options.output });
	const guard = async () => {
		options.signal?.throwIfAborted();
		await revalidateCiReleasePlan(options.plan, {
			root: options.root,
			publish: true,
			run: options.run,
			env: environment,
			signal: options.signal,
		});
	};
	await guard();
	let tagged: string | undefined;
	try {
		tagged = await resolveHelperTagCommit(
			{ repository: options.plan.repository, run: options.run, signal: options.signal },
			peer.tag,
		);
	} catch (error) {
		if (!isMissingPeerRemote(error)) throw error;
	}
	if (tagged && tagged !== peer.sourceCommit)
		throw new Error("Existing peer tag conflicts with frozen source; never force tags");
	if (!tagged) {
		await guard();
		try {
			await options.run([
				"api",
				`repos/${options.plan.repository}/git/refs`,
				"--method",
				"POST",
				"-f",
				`ref=refs/tags/${peer.tag}`,
				"-f",
				`sha=${peer.sourceCommit}`,
			]);
		} catch (error) {
			// A concurrent standalone diagnostic publisher may create the same immutable ref.
			if (
				(await resolveHelperTagCommit(
					{ repository: options.plan.repository, run: options.run, signal: options.signal },
					peer.tag,
				)) !== peer.sourceCommit
			)
				throw error;
		}
	}
	if (
		(await resolveHelperTagCommit(
			{ repository: options.plan.repository, run: options.run, signal: options.signal },
			peer.tag,
		)) !== peer.sourceCommit
	)
		throw new Error("Peer tag readback mismatch");
	const existing = await findPublishedRemotePeerRelease({
		...helper,
		run: options.run,
		signal: options.signal,
	});
	if (existing) {
		if (
			existing.commit !== peer.sourceCommit ||
			existing.manifestSha256 !==
				description.files.find(({ name }) => name === REMOTE_PEER_MANIFEST_FILENAME)?.sha256
		)
			throw new Error("Public peer does not match the immutable original bundle");
	} else {
		await publishHelperRelease({
			...helper,
			bundleDir: options.output,
			dryRun: false,
			run: options.run,
			signal: options.signal,
			beforeWrite: guard,
		});
	}
	const published = await findPublishedRemotePeerRelease({
		...helper,
		run: options.run,
		signal: options.signal,
	});
	if (published?.commit !== peer.sourceCommit)
		throw new Error("Peer public readback failed; NF remains unpublished");
	await writePublicationReceipt({
		kind: "remote-peer",
		repository: options.plan.repository,
		tag: peer.tag,
		version: peer.version,
		commit: peer.sourceCommit,
		expectedAssets: description.files,
		source: {
			runId: dispatch.runId,
			runAttempt: dispatch.runAttempt,
			workflowPath: CI_RELEASE_WORKFLOW,
			nativeProof: "verified-original-bundle",
		},
		buildSource: {
			runId: original.runId,
			runAttempt: original.runAttempt,
			bundleArtifactId: original.artifactId,
			workflowPath: CI_RELEASE_WORKFLOW,
			nativeProof: "verified-original-bundle",
		},
		run: options.run,
		signal: options.signal,
		path: options.receiptPath ?? REMOTE_PEER_PUBLICATION_RECEIPT_PATH,
	});
}
