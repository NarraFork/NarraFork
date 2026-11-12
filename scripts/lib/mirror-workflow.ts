import { lstat, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { isValidGitHubRepository } from "../../shared/github-repository";
import { isValidReleaseVersion } from "../../shared/release-version";
import type { GhRunner } from "./github-release";
import {
	currentPublicRelease,
	mirrorApi,
	mirrorGhRunner,
	publicTagCommit,
	readIndexSnapshot,
} from "./mirror-public-github";
import {
	AUXILIARY_PUBLICATION_ARTIFACT,
	MAIN_PUBLICATION_ARTIFACT,
	type PublicationReceipt,
	REMOTE_PEER_PUBLICATION_ARTIFACT,
	REMOTE_PEER_PUBLICATION_RECEIPT_PATH,
} from "./publication-receipt";

const PUBLICATION_WORKFLOWS = {
	main: ".github/workflows/release.yml",
	helpers: ".github/workflows/helpers-release.yml",
	executor: ".github/workflows/helpers-release.yml",
	"remote-peer": ".github/workflows/remote-peer-release.yml",
} as const;
export interface MirrorTrigger {
	repository: string;
	defaultBranch: string;
	runId: number;
	runAttempt: number;
	workflowPath: string;
	artifactName: string;
	artifactId: number;
}
interface WorkflowRun {
	id: number;
	run_attempt: number;
	event: string;
	status: string;
	conclusion: string;
	path: string;
	head_branch: string;
	head_repository: { full_name: string };
	repository: { full_name: string };
}
export async function readMirrorDataFile(path: string, maximum = 64 * 1024): Promise<unknown> {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximum)
		throw new Error("Mirror data file is not bounded regular JSON");
	const raw = await readFile(path);
	if (raw.length !== info.size || raw.length > maximum) throw new Error("Mirror data file changed");
	return JSON.parse(raw.toString("utf8"));
}
/** workflow_run is privileged: trust only the same repository's default-branch dispatch and exact successful publishing jobs. */
export async function resolveMirrorWorkflowTriggers(
	event: unknown,
	repository: string,
	rawRun?: GhRunner,
): Promise<MirrorTrigger[]> {
	if (!isValidGitHubRepository(repository)) throw new Error("Invalid mirror repository");
	const e = event as {
		repository: { full_name: string; default_branch: string };
		workflow_run: WorkflowRun;
	};
	if (
		e.repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
		!e.repository.default_branch
	)
		throw new Error("Mirror event repository mismatch");
	const source = e.workflow_run;
	if (
		!source ||
		!Number.isSafeInteger(source.id) ||
		source.id <= 0 ||
		!Number.isSafeInteger(source.run_attempt) ||
		source.run_attempt <= 0
	)
		throw new Error("Invalid mirror source run");
	const run = mirrorGhRunner(rawRun);
	const current = await mirrorApi<WorkflowRun>(
		run,
		repository,
		`actions/runs/${source.id}/attempts/${source.run_attempt}`,
	);
	const workflowPath = current.path;
	const isMain = workflowPath === ".github/workflows/release.yml";
	if (!Object.values(PUBLICATION_WORKFLOWS).some((path) => path === workflowPath))
		throw new Error("Untrusted mirror source workflow");
	for (const candidate of [source, current]) {
		if (
			candidate.id !== source.id ||
			candidate.run_attempt !== source.run_attempt ||
			candidate.event !== "workflow_dispatch" ||
			candidate.status !== "completed" ||
			candidate.conclusion !== "success" ||
			candidate.path !== workflowPath ||
			candidate.head_branch !== e.repository.default_branch ||
			candidate.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
			(candidate.repository &&
				candidate.repository.full_name?.toLowerCase() !== repository.toLowerCase())
		)
			throw new Error("Mirror requires a successful trusted default-branch source dispatch");
	}
	const suffix = `${source.id}-${source.run_attempt}`;
	const artifactNames = [
		`${isMain ? MAIN_PUBLICATION_ARTIFACT : AUXILIARY_PUBLICATION_ARTIFACT}-${suffix}`,
		...(isMain ? [`${REMOTE_PEER_PUBLICATION_ARTIFACT}-${suffix}`] : []),
	];
	const artifacts = await mirrorApi<{
		total_count: number;
		artifacts: { id: number; name: string; expired: boolean; size_in_bytes: number }[];
	}>(run, repository, `actions/runs/${source.id}/artifacts?per_page=100`);
	if (artifacts.total_count > 100 || !Array.isArray(artifacts.artifacts))
		throw new Error("Mirror source artifact list exceeds bounds");
	const selected = artifactNames.flatMap((artifactName) => {
		const matches = artifacts.artifacts.filter((a) => a.name === artifactName && !a.expired);
		if (matches.length === 0) return [];
		if (
			matches.length !== 1 ||
			!Number.isSafeInteger(matches[0].id) ||
			matches[0].id <= 0 ||
			!Number.isSafeInteger(matches[0].size_in_bytes) ||
			matches[0].size_in_bytes <= 0 ||
			matches[0].size_in_bytes > 128 * 1024
		)
			throw new Error("Ambiguous or oversized publication receipt artifact");
		return matches;
	});
	if (!selected.length) return []; // build-only success is deliberately not eligible
	if (
		selected[0].name !== artifactNames[0] ||
		new Set(selected.map((a) => a.id)).size !== selected.length ||
		selected.reduce((sum, a) => sum + a.size_in_bytes, 0) > 128 * 1024
	)
		throw new Error("Publication receipt collection lacks its primary receipt or exceeds bounds");
	const jobs = await mirrorApi<{
		total_count: number;
		jobs: { name: string; conclusion: string; status: string }[];
	}>(run, repository, `actions/runs/${source.id}/attempts/${source.run_attempt}/jobs?per_page=100`);
	if (jobs.total_count > 100 || !Array.isArray(jobs.jobs))
		throw new Error("Mirror source jobs exceed bounds");
	for (const name of isMain
		? ["Publish verified release", "Release Gate"]
		: workflowPath === PUBLICATION_WORKFLOWS["remote-peer"]
			? ["Publish approved remote peer draft", "Remote Peer Release Gate"]
			: ["Publish approved helper draft", "Auxiliary Release Gate"]) {
		const matches = jobs.jobs.filter((j) => j.name === name);
		if (
			matches.length !== 1 ||
			matches[0].status !== "completed" ||
			matches[0].conclusion !== "success"
		)
			throw new Error("Actual publisher/Core Release Gate did not succeed");
	}
	return selected.map((artifact) => ({
		repository,
		defaultBranch: e.repository.default_branch,
		runId: source.id,
		runAttempt: source.run_attempt,
		workflowPath,
		artifactName: artifact.name,
		artifactId: artifact.id,
	}));
}
/** Compatibility for callers that intentionally consume only the original primary receipt. */
export async function resolveMirrorWorkflowTrigger(
	event: unknown,
	repository: string,
	rawRun?: GhRunner,
): Promise<MirrorTrigger | undefined> {
	return (await resolveMirrorWorkflowTriggers(event, repository, rawRun))[0];
}
/** The artifact identity, not JSON self-description, selects its one allowed receipt basename. */
export function mirrorPublicationReceiptFilename(trigger: MirrorTrigger): string {
	const suffix = `${trigger.runId}-${trigger.runAttempt}`;
	if (trigger.workflowPath === PUBLICATION_WORKFLOWS.main) {
		if (trigger.artifactName === `${REMOTE_PEER_PUBLICATION_ARTIFACT}-${suffix}`)
			return basename(REMOTE_PEER_PUBLICATION_RECEIPT_PATH);
		if (trigger.artifactName === `${MAIN_PUBLICATION_ARTIFACT}-${suffix}`)
			return "publication-receipt.json";
	} else if (
		Object.values(PUBLICATION_WORKFLOWS).some((path) => path === trigger.workflowPath) &&
		trigger.artifactName === `${AUXILIARY_PUBLICATION_ARTIFACT}-${suffix}`
	) {
		return "publication-receipt.json";
	}
	throw new Error("Publication receipt artifact provenance mismatch");
}
export async function verifyProtectedMirrorEnvironment(
	repository: string,
	rawRun?: GhRunner,
): Promise<void> {
	const environment = await mirrorApi<{
		name: string;
		protection_rules?: { type: string; reviewers?: unknown[] }[];
	}>(mirrorGhRunner(rawRun), repository, "environments/release");
	if (
		environment.name !== "release" ||
		!environment.protection_rules?.some(
			(rule) =>
				rule.type === "required_reviewers" &&
				Array.isArray(rule.reviewers) &&
				rule.reviewers.length > 0,
		)
	)
		throw new Error(
			"Independent mirror requires the existing release Environment with reviewer protection; it never creates or bypasses one",
		);
}
export async function readMirrorPublicationReceiptSet(
	triggers: MirrorTrigger[],
	paths: { receiptFile?: string; peerReceiptFile?: string },
	rawRun?: GhRunner,
): Promise<PublicationReceipt[]> {
	const entries = [];
	for (const trigger of triggers) {
		const filename = mirrorPublicationReceiptFilename(trigger);
		const path =
			filename === basename(REMOTE_PEER_PUBLICATION_RECEIPT_PATH)
				? paths.peerReceiptFile
				: paths.receiptFile;
		if (!path || basename(path) !== filename)
			throw new Error("Exact publication receipt path required for every selected artifact");
		entries.push({ trigger, value: await readMirrorDataFile(path) });
	}
	return verifyMirrorPublicationReceiptSet(entries, rawRun);
}
/** Validate the complete frozen set before any upload; two receipts do not double its data/count budget. */
export async function verifyMirrorPublicationReceiptSet(
	entries: { trigger: MirrorTrigger; value: unknown }[],
	rawRun?: GhRunner,
): Promise<PublicationReceipt[]> {
	if (
		entries.length < 1 ||
		entries.length > 2 ||
		Buffer.byteLength(JSON.stringify(entries.map((e) => e.value))) > 64 * 1024 ||
		new Set(entries.map((e) => e.trigger.artifactId)).size !== entries.length ||
		entries.some(
			({ trigger }) =>
				trigger.repository !== entries[0].trigger.repository ||
				trigger.runId !== entries[0].trigger.runId ||
				trigger.runAttempt !== entries[0].trigger.runAttempt ||
				trigger.workflowPath !== entries[0].trigger.workflowPath,
		)
	)
		throw new Error("Invalid bounded publication receipt collection");
	const receipts: PublicationReceipt[] = [];
	for (const { trigger, value } of entries)
		receipts.push(await verifyMirrorPublicationReceipt(value, trigger, rawRun));
	if (
		receipts.reduce((sum, r) => sum + r.assets.length, 0) > 200 ||
		new Set(receipts.map((r) => r.kind)).size !== receipts.length ||
		new Set(receipts.map((r) => r.tag)).size !== receipts.length
	)
		throw new Error("Publication receipt collection exceeds asset/identity bounds");
	return receipts;
}
export async function verifyMirrorPublicationReceipt(
	value: unknown,
	trigger: MirrorTrigger,
	rawRun?: GhRunner,
): Promise<PublicationReceipt> {
	if (!value || typeof value !== "object" || Buffer.byteLength(JSON.stringify(value)) > 64 * 1024)
		throw new Error("Publication receipt exceeds bounds");
	const filename = mirrorPublicationReceiptFilename(trigger);
	const mainPeer = filename === basename(REMOTE_PEER_PUBLICATION_RECEIPT_PATH);
	const r = value as PublicationReceipt;
	const positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
	if (
		r.schemaVersion !== 1 ||
		!["main", "helpers", "executor", "remote-peer"].includes(r.kind) ||
		r.repository?.toLowerCase() !== trigger.repository.toLowerCase() ||
		!/^[a-f0-9]{40}$/.test(r.commit ?? "") ||
		!positive(r.releaseId) ||
		r.source?.runId !== trigger.runId ||
		r.source?.runAttempt !== trigger.runAttempt ||
		r.source?.workflowPath !== trigger.workflowPath ||
		!["verified-original-bundle", "verified-public-index-repair"].includes(r.source?.nativeProof) ||
		(mainPeer
			? r.kind !== "remote-peer"
			: trigger.workflowPath === PUBLICATION_WORKFLOWS.main
				? r.kind !== "main"
				: PUBLICATION_WORKFLOWS[r.kind] !== trigger.workflowPath) ||
		typeof r.version !== "string" ||
		!isValidReleaseVersion(r.version) ||
		!Array.isArray(r.assets) ||
		!r.assets.length ||
		r.assets.length > 200 ||
		typeof r.tag !== "string" ||
		r.tag !== `${r.kind === "main" ? "" : `${r.kind}-`}v${r.version}`
	)
		throw new Error("Publication receipt provenance mismatch");
	if (r.kind !== "main" && r.source.nativeProof !== "verified-original-bundle")
		throw new Error("Auxiliary receipt requires original native bundle proof");
	const build = r.buildSource;
	if (r.source.nativeProof === "verified-original-bundle" && !build)
		throw new Error("Publication receipt lacks original build provenance");
	if (
		build &&
		(!positive(build.runId) ||
			!positive(build.runAttempt) ||
			build.workflowPath !== trigger.workflowPath ||
			build.nativeProof !== "verified-original-bundle" ||
			(build.bundleArtifactId !== undefined && !positive(build.bundleArtifactId)) ||
			Object.keys(build).some(
				(key) =>
					!["runId", "runAttempt", "workflowPath", "bundleArtifactId", "nativeProof"].includes(key),
			))
	)
		throw new Error("Invalid bounded original build provenance");
	const run = mirrorGhRunner(rawRun);
	const release = await currentPublicRelease(run, trigger.repository, r.tag);
	if (
		(r.kind === "remote-peer" && release.prerelease !== r.version.includes("-")) ||
		release.id !== r.releaseId ||
		(await publicTagCommit(run, trigger.repository, r.tag)) !== r.commit ||
		release.assets.length !== r.assets.length
	)
		throw new Error("Publication receipt is stale or not public");
	for (const asset of r.assets) {
		if (
			!positive(asset.id) ||
			!positive(asset.size) ||
			!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") ||
			!release.assets.some(
				(a) =>
					a.id === asset.id &&
					a.name === asset.name &&
					a.size === asset.size &&
					a.digest === asset.digest,
			)
		)
			throw new Error("Publication receipt asset mismatch");
	}
	if (new Set(r.assets.map((a) => a.id)).size !== r.assets.length)
		throw new Error("Duplicate receipt assets");
	if (r.kind === "main") {
		if (!/^[a-f0-9]{40}$/.test(r.indexCommit ?? "") || !positive(r.generation))
			throw new Error("Receipt lacks confirmed canonical index");
		const snapshot = await readIndexSnapshot(run, trigger.repository);
		if (
			snapshot.index.generation < (r.generation as number) ||
			!snapshot.index.releases.some((v) => v.tag === r.tag && v.commit === r.commit)
		)
			throw new Error("Receipt target is not in current canonical index");
		const lineage = await mirrorApi<{ status: string }>(
			run,
			trigger.repository,
			`compare/${r.indexCommit}...${snapshot.indexCommit}`,
		);
		if (!["ahead", "identical"].includes(lineage.status))
			throw new Error("Publication receipt index is not canonical ancestry");
	}
	return r;
}
