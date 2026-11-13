import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type GhRunner, validateGitHubRepository } from "./github-release";

export const PUBLICATION_RECEIPT_PATH = "artifacts/publication/publication-receipt.json";
export const MAIN_PUBLICATION_ARTIFACT = "main-publication-receipt";
export const AUXILIARY_PUBLICATION_ARTIFACT = "auxiliary-publication-receipt";
export const REMOTE_PEER_PUBLICATION_ARTIFACT = "remote-peer-publication-receipt";
export const REMOTE_PEER_PUBLICATION_RECEIPT_PATH =
	"artifacts/publication/remote-peer-publication-receipt.json";
export interface PublicationAssetIdentity {
	id: number;
	name: string;
	size: number;
	digest: string;
}
export interface PublicationReceipt {
	schemaVersion: 1;
	kind: "main" | "helpers" | "executor" | "remote-peer";
	repository: string;
	tag: string;
	version: string;
	commit: string;
	releaseId: number;
	assets: PublicationAssetIdentity[];
	indexCommit?: string;
	generation?: number;
	/** Current publisher run that owns this attempt-scoped publication artifact. */
	source: {
		runId: number;
		runAttempt: number;
		workflowPath: string;
		nativeProof: "verified-original-bundle" | "verified-public-index-repair";
	};
	/** Original verified QA provenance, independent of a later publisher run/attempt. */
	buildSource?: PublicationBuildSource;
}
export interface PublicationBuildSource {
	runId: number;
	runAttempt: number;
	workflowPath: string;
	bundleArtifactId?: number;
	nativeProof: "verified-original-bundle";
}

/** Only verified current public identities enter this small CI artifact; it is never a public asset. */
export async function writePublicationReceipt(options: {
	kind: PublicationReceipt["kind"];
	repository: string;
	tag: string;
	version: string;
	commit: string;
	expectedAssets: { name: string; size: number; sha256: string }[];
	/** Index-only repairs may preserve the two historical checksum reports outside the index. */
	additionalAssetNames?: string[];
	source: PublicationReceipt["source"];
	buildSource?: PublicationBuildSource;
	indexCommit?: string;
	generation?: number;
	run: GhRunner;
	signal?: AbortSignal;
	path?: string;
}): Promise<PublicationReceipt> {
	options.signal?.throwIfAborted();
	validateGitHubRepository(options.repository);
	const positive = (n: unknown): n is number =>
		typeof n === "number" && Number.isSafeInteger(n) && n > 0;
	if (
		(options.kind === "remote-peer" &&
			(![".github/workflows/remote-peer-release.yml", ".github/workflows/release.yml"].includes(
				options.source.workflowPath,
			) ||
				options.source.nativeProof !== "verified-original-bundle" ||
				options.tag !== `remote-peer-v${options.version}`)) ||
		!/^[a-f0-9]{40}$/.test(options.commit) ||
		!positive(options.source.runId) ||
		!positive(options.source.runAttempt) ||
		!["verified-original-bundle", "verified-public-index-repair"].includes(
			options.source.nativeProof,
		) ||
		(options.source.nativeProof === "verified-original-bundle" && !options.buildSource) ||
		(options.buildSource !== undefined &&
			(!positive(options.buildSource.runId) ||
				!positive(options.buildSource.runAttempt) ||
				options.buildSource.nativeProof !== "verified-original-bundle" ||
				options.buildSource.workflowPath !== options.source.workflowPath ||
				(options.buildSource.bundleArtifactId !== undefined &&
					!positive(options.buildSource.bundleArtifactId)))) ||
		(options.kind === "main" &&
			(!/^[a-f0-9]{40}$/.test(options.indexCommit ?? "") || !positive(options.generation)))
	)
		throw new Error("Invalid publication receipt provenance");
	const raw = await options.run([
		"api",
		`repos/${options.repository}/releases/tags/${options.tag}`,
	]);
	if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("Publication readback exceeds limit");
	const release = JSON.parse(raw) as {
		id: number;
		tag_name: string;
		draft: boolean;
		assets: (PublicationAssetIdentity & { state: string })[];
	};
	if (
		!positive(release.id) ||
		release.tag_name !== options.tag ||
		release.draft !== false ||
		!Array.isArray(release.assets) ||
		release.assets.length < options.expectedAssets.length ||
		release.assets.length >
			options.expectedAssets.length + (options.additionalAssetNames?.length ?? 0) ||
		release.assets.length === 0 ||
		release.assets.length > 256
	)
		throw new Error("Publication receipt requires the exact public Release");
	const assets = options.expectedAssets.map((expected) => {
		const matches = release.assets.filter(({ name }) => name === expected.name);
		const asset = matches[0];
		if (
			matches.length !== 1 ||
			!asset ||
			!positive(asset.id) ||
			asset.state !== "uploaded" ||
			asset.size !== expected.size ||
			asset.digest !== `sha256:${expected.sha256}`
		)
			throw new Error("Publication receipt asset identity mismatch");
		return { id: asset.id, name: asset.name, size: asset.size, digest: asset.digest };
	});
	for (const name of options.additionalAssetNames ?? []) {
		if (
			![
				`narrafork-${options.version}-SHA256SUMS`,
				`narrafork-${options.version}-checksums.txt`,
			].includes(name)
		)
			throw new Error("Invalid supplemental publication asset");
		const matches = release.assets.filter((asset) => asset.name === name);
		if (matches.length === 0) continue;
		const asset = matches[0];
		if (
			matches.length !== 1 ||
			!asset ||
			!positive(asset.id) ||
			!positive(asset.size) ||
			asset.size > 64 * 1024 ||
			asset.state !== "uploaded" ||
			!/^sha256:[a-f0-9]{64}$/.test(asset.digest)
		)
			throw new Error("Invalid supplemental publication asset identity");
		assets.push({ id: asset.id, name: asset.name, size: asset.size, digest: asset.digest });
	}
	if (
		assets.length !== release.assets.length ||
		new Set(assets.map(({ id }) => id)).size !== assets.length ||
		new Set(assets.map(({ name }) => name)).size !== assets.length
	)
		throw new Error("Duplicate publication asset identity");
	const receipt: PublicationReceipt = {
		schemaVersion: 1,
		kind: options.kind,
		repository: options.repository,
		tag: options.tag,
		version: options.version,
		commit: options.commit,
		releaseId: release.id,
		assets,
		source: options.source,
		...(options.buildSource ? { buildSource: options.buildSource } : {}),
		...(options.kind === "main"
			? { indexCommit: options.indexCommit, generation: options.generation }
			: {}),
	};
	const text = `${JSON.stringify(receipt, null, 2)}\n`;
	if (Buffer.byteLength(text) > 64 * 1024) throw new Error("Publication receipt exceeds limit");
	options.signal?.throwIfAborted();
	const path = options.path ?? PUBLICATION_RECEIPT_PATH;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text, { flag: "wx" });
	return receipt;
}
