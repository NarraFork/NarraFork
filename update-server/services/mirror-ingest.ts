import { createHash } from "node:crypto";
import { isValidGitHubRepository } from "../../shared/github-repository";
import {
	HELPER_MANIFEST_FILENAME,
	parseExecutorReleaseManifest,
	parseHelperManifest,
} from "../../shared/helper-distribution";
import {
	MAX_MIRROR_METADATA_BYTES,
	type MirrorAssetDescriptor,
	mirrorAssetsForTarget,
	parseMirrorAssetDescriptor,
	parseMirrorSnapshot,
} from "../../shared/independent-update-mirror";
import { MAX_MIRROR_UPLOAD_CONCURRENCY, mirrorTransferTimeoutMs } from "../../shared/mirror-relay";
import { EXECUTOR_MANIFEST_FILENAME } from "../../shared/remote-executor";
import { parseUpdateIndex } from "../../shared/update-index";
import type { UpdateIndexV1 } from "../../shared/update-index-types";
import { getConfig } from "../lib/config";
import { logger } from "../lib/logger";
import type { StorageBackend } from "../storage/types";
import { objectPath, validateMirrorMetadata, verifyMirrorAsset } from "./mirror-ingest-io";

export type { MirrorAssetDescriptor } from "../../shared/independent-update-mirror";
export interface MirrorVerifiedAsset {
	name: string;
	size: number;
	sha256: string;
}
export interface MirrorAssetReceipt extends MirrorVerifiedAsset {
	schemaVersion: 1;
	verification: "server-sha256";
}
export interface MirrorMainReceipt {
	schemaVersion: 1;
	verification: "server-sha256";
	repository: string;
	indexCommit: string;
	generation: number;
	targetVersion: string;
	verified: MirrorVerifiedAsset[];
}
export interface MirrorToolsReceipt {
	schemaVersion: 1;
	verification: "server-sha256";
	repository: string;
	kind: "helpers" | "executor";
	tag: string;
	verified: MirrorVerifiedAsset[];
}
export class MirrorIngestError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
	) {
		super(code);
		this.name = "MirrorIngestError";
	}
}
const STATE_LIMIT = 1024 * 1024;
const statePath = (product: string) => `mirror-snapshots/${product}.json`;
const toolPath = (product: string, kind: string, tag: string) =>
	`mirror-tools/${product}/${kind}/tags/${tag}.json`;
interface TargetMarker {
	version: string;
	fingerprint: string;
}
interface CatalogState {
	schemaVersion: 2;
	repository: string;
	indexCommit: string;
	index: UpdateIndexV1;
	targets: TargetMarker[];
}
interface ToolAsset extends MirrorVerifiedAsset {
	content: string;
}
interface ToolProjection {
	schemaVersion: 1;
	repository: string;
	kind: "helpers" | "executor";
	tag: string;
	assets: ToolAsset[];
	/** Descriptors only; executable bytes are separate streamed objects. */
	binaries?: MirrorAssetDescriptor[];
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const summary = ({ name, size, sha256 }: MirrorVerifiedAsset): MirrorVerifiedAsset => ({
	name,
	size,
	sha256,
});
function fingerprint(index: UpdateIndexV1, version: string): string | undefined {
	const target = index.releases.find((r) => r.version === version);
	return target ? digest(target) : undefined;
}
function checkToolsIdentity(kind: string, tag: string) {
	if (!/^(helpers|executor)$/.test(kind) || !/^[a-z0-9.-]{1,64}$/.test(tag))
		throw new Error("Invalid component identity");
}
export function parseTools(
	input: unknown,
	repository: string,
	kind: "helpers" | "executor",
	tag: string,
): ToolProjection {
	const encoded = JSON.stringify(input);
	if (!encoded || Buffer.byteLength(encoded) > STATE_LIMIT)
		throw new Error("Component metadata byte limit");
	const data = JSON.parse(encoded);
	if (
		!data ||
		typeof data !== "object" ||
		Array.isArray(data) ||
		data.schemaVersion !== 1 ||
		typeof data.repository !== "string" ||
		// GitHub slugs are case-insensitive, and the expected side is not always
		// normalized: the relay pull passes the signed manifest's repository, which
		// reflects GITHUB_REPOSITORY as published. Comparing only the payload side
		// lowercased rejected every tools import for a mixed-case repository.
		data.repository.toLowerCase() !== repository.toLowerCase() ||
		data.kind !== kind ||
		data.tag !== tag ||
		!Array.isArray(data.assets) ||
		data.assets.length < 1 ||
		data.assets.length > 16 ||
		Object.keys(data).some(
			(k) => !["schemaVersion", "repository", "kind", "tag", "assets", "binaries"].includes(k),
		)
	)
		throw new Error("Invalid component metadata envelope");
	const assets: ToolAsset[] = data.assets.map((a: ToolAsset) => {
		if (
			!a ||
			typeof a !== "object" ||
			Array.isArray(a) ||
			typeof a.content !== "string" ||
			a.content.includes("\u0000") ||
			typeof a.name !== "string" ||
			!/^[A-Za-z0-9._-]{1,255}$/.test(a.name) ||
			a.name.includes("..") ||
			Object.keys(a).some((k) => !["name", "size", "sha256", "content"].includes(k))
		)
			throw new Error("Invalid component metadata file");
		const bytes = Buffer.from(a.content, "utf8");
		if (
			bytes.length !== a.size ||
			bytes.length > MAX_MIRROR_METADATA_BYTES ||
			createHash("sha256").update(bytes).digest("hex") !== a.sha256
		)
			throw new Error("Component metadata size/hash mismatch");
		return { ...summary(a), content: a.content };
	});
	const manifestName = kind === "helpers" ? HELPER_MANIFEST_FILENAME : EXECUTOR_MANIFEST_FILENAME;
	const manifestAsset = assets.find((a) => a.name === manifestName);
	if (!manifestAsset) throw new Error(`Required ${manifestName} missing`);
	const value = JSON.parse(manifestAsset.content);
	const manifest =
		kind === "helpers"
			? parseHelperManifest(value, { repository, tag })
			: parseExecutorReleaseManifest(value, {
					repository,
					tag,
					version: tag.replace(/^executor-v/, ""),
					protocolVersion: value?.manifest?.protocolVersion,
				});
	if (
		assets.length !== manifest.licenses.length + 1 ||
		new Set(assets.map((a) => a.name)).size !== assets.length
	)
		throw new Error("Only complete manifest/licenses metadata accepted; binaries prohibited");
	// Canonical declarations, not filename keywords, authorize licence metadata.
	for (const license of manifest.licenses) {
		if (
			!assets.some(
				(a) => a.name === license.name && a.size === license.size && a.sha256 === license.sha256,
			)
		)
			throw new Error("Missing or invalid declared licence metadata");
	}
	let binaries: MirrorAssetDescriptor[] | undefined;
	if (data.binaries !== undefined) {
		const expected =
			"files" in manifest
				? manifest.files
				: Object.entries(manifest.manifest.platforms).map(([platform, file]) => ({
						name: file.filename,
						size: file.size,
						sha256: file.sha256,
						platform,
					}));
		if (
			!Array.isArray(data.binaries) ||
			data.binaries.length !== expected.length ||
			data.binaries.length > 16
		)
			throw new Error("Complete bounded component binaries required");
		binaries = (data.binaries as unknown[]).map(parseMirrorAssetDescriptor);
		if (new Set(binaries.map((a) => a.name)).size !== binaries.length)
			throw new Error("Duplicate component binary");
		for (const binary of binaries) {
			const file = expected.find((f) => f.name === binary.name);
			if (
				!file ||
				binary.kind !== `${kind}-binary` ||
				`${kind}-v${binary.version}` !== tag ||
				binary.platform !== file.platform ||
				binary.size !== file.size ||
				binary.sha256 !== file.sha256
			)
				throw new Error("Component binary canonical identity mismatch");
		}
	}
	return {
		schemaVersion: 1,
		// Store the canonical lowercase slug regardless of which caller supplied it,
		// so relay-imported metadata matches the direct-upload form byte for byte.
		repository: repository.toLowerCase(),
		kind,
		tag,
		assets,
		...(binaries ? { binaries } : {}),
	};
}

/** One instance is shared by HTTP and relay: neither path can bypass verification or CAS/quotas. */
export class MirrorIngestService {
	private readonly uploads = new Set<string>();
	private readonly commits = new Set<string>();
	constructor(private readonly storage: StorageBackend) {}

	public repository(product: string): string {
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(product)) throw new Error("Invalid mirror product");
		const repo = getConfig().mirrorRepositories?.[product];
		if (!isValidGitHubRepository(repo))
			throw new Error("Mirror repository is not configured by the operator");
		return repo.toLowerCase();
	}

	private async smallFile(path: string): Promise<Buffer | null> {
		const size = await this.storage.getFileSize(path);
		if (size === null) return null;
		if (size > STATE_LIMIT) throw new Error("Stored mirror metadata exceeds limit");
		const bytes = await this.storage.getFile(path);
		if (bytes && bytes.length > STATE_LIMIT)
			throw new Error("Stored mirror metadata exceeds limit");
		return bytes;
	}

	private async catalog(product: string): Promise<CatalogState | null> {
		const repo = this.repository(product);
		const bytes = await this.smallFile(statePath(product));
		if (!bytes) return null;
		const data = JSON.parse(bytes.toString("utf8"));
		if (data.schemaVersion === 1) {
			const old = parseMirrorSnapshot(data, repo);
			return {
				schemaVersion: 2,
				repository: repo,
				indexCommit: old.indexCommit,
				index: old.index,
				targets: [
					{
						version: old.targetVersion,
						fingerprint: fingerprint(old.index, old.targetVersion) as string,
					},
				],
			};
		}
		if (
			data.schemaVersion !== 2 ||
			data.repository !== repo ||
			typeof data.indexCommit !== "string" ||
			!/^[a-f0-9]{40}$/.test(data.indexCommit) ||
			!Array.isArray(data.targets) ||
			data.targets.length > 32
		)
			throw new Error("Invalid stored mirror catalog");
		const index = parseUpdateIndex(data.index, repo);
		const targets: TargetMarker[] = [];
		for (const marker of data.targets) {
			if (!marker || typeof marker.version !== "string" || typeof marker.fingerprint !== "string")
				throw new Error("Invalid stored mirror target marker");
			if (
				fingerprint(index, marker.version) === marker.fingerprint &&
				!targets.some((t) => t.version === marker.version)
			)
				targets.push({ version: marker.version, fingerprint: marker.fingerprint });
		}
		return { schemaVersion: 2, repository: repo, indexCommit: data.indexCommit, index, targets };
	}

	/** Public views derive assets only from committed markers still bound to this catalog. */
	public async readMain(
		product: string,
	): Promise<{ index: UpdateIndexV1; assets: MirrorAssetDescriptor[] } | null> {
		const catalog = await this.catalog(product);
		return catalog
			? {
					index: catalog.index,
					assets: catalog.targets.flatMap((t) => mirrorAssetsForTarget(catalog.index, t.version)),
				}
			: null;
	}

	public async ingestAsset(
		product: string,
		descriptor: MirrorAssetDescriptor,
		stream: ReadableStream<Uint8Array>,
		signal: AbortSignal,
		/** Internal delivery identity, never accepted from upload headers or request bodies. */
		delivery: "direct" | "relay" = "direct",
	): Promise<MirrorAssetReceipt> {
		this.repository(product);
		const asset = parseMirrorAssetDescriptor(descriptor);
		if (
			(asset.kind === "binary-sidecar" && !asset.name.endsWith(".metadata.json")) ||
			(asset.kind === "patch" && !asset.name.endsWith(".zstd-patch")) ||
			(asset.kind === "patch-meta" && !asset.name.endsWith(".zstd-patch.meta.json")) ||
			(asset.kind === "notes" && !/^notes\/[A-Za-z0-9.+-]+\.json$/.test(asset.name))
		)
			throw new Error("Only canonical metadata, patches and component binaries may be uploaded");
		if (!this.storage.saveVerifiedFile)
			throw new MirrorIngestError(503, "STORAGE_VERIFICATION_UNAVAILABLE");
		if (this.uploads.size >= MAX_MIRROR_UPLOAD_CONCURRENCY || this.uploads.has(asset.sha256))
			throw new MirrorIngestError(429, "MIRROR_UPLOAD_CONCURRENCY_LIMIT");
		this.uploads.add(asset.sha256);
		const started = Date.now();
		try {
			const limits = getConfig().mirrorLimits;
			for (const [key, value] of Object.entries(limits ?? {})) {
				if (!Number.isSafeInteger(value) || value < (key === "minFreeBytes" ? 0 : 1))
					throw new Error("Invalid operator mirror limits");
			}
			const timeoutMs =
				delivery === "relay"
					? mirrorTransferTimeoutMs(getConfig().mirrorRelay?.transferTimeoutMinutes)
					: 120_000;
			signal.throwIfAborted();
			await this.storage.saveVerifiedFile(objectPath(asset.sha256), stream, {
				size: asset.size,
				sha256: asset.sha256,
				signal,
				timeoutMs: Math.min(limits?.uploadTimeoutMs ?? timeoutMs, timeoutMs),
				quotaBytes: Math.min(limits?.quotaBytes ?? 8 * 1024 ** 3, 8 * 1024 ** 3),
				minFreeBytes: Math.max(limits?.minFreeBytes ?? 256 * 1024 ** 2, 0),
			});
			signal.throwIfAborted();
			return { schemaVersion: 1, verification: "server-sha256", ...summary(asset) };
		} finally {
			this.uploads.delete(asset.sha256);
			if (Date.now() - started >= 1000)
				logger.info("Slow mirror asset ingest", {
					kind: asset.kind,
					bytes: asset.size,
					delivery,
					durationMs: Date.now() - started,
				});
		}
	}

	public async commitMain(
		product: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<MirrorMainReceipt> {
		const repo = this.repository(product);
		if (!this.storage.saveAtomicFile)
			throw new MirrorIngestError(503, "STORAGE_COMMIT_UNAVAILABLE");
		if (this.commits.size >= 2 || this.commits.has(product))
			throw new MirrorIngestError(409, "MIRROR_COMMIT_IN_PROGRESS");
		this.commits.add(product);
		const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
		try {
			deadline.throwIfAborted();
			const snapshot = parseMirrorSnapshot(input, repo);
			const previous = await this.catalog(product);
			if (previous && snapshot.index.generation < previous.index.generation)
				throw new MirrorIngestError(409, "STALE_CANONICAL_SNAPSHOT");
			if (
				previous &&
				snapshot.index.generation === previous.index.generation &&
				(snapshot.indexCommit !== previous.indexCommit ||
					JSON.stringify(snapshot.index) !== JSON.stringify(previous.index))
			)
				throw new MirrorIngestError(409, "CANONICAL_SNAPSHOT_CONFLICT");
			for (const asset of snapshot.assets) {
				const bytes = await verifyMirrorAsset(this.storage, asset, deadline);
				if (bytes) validateMirrorMetadata(snapshot, asset, bytes);
			}
			const targets = (previous?.targets ?? []).filter(
				(t) =>
					t.version !== snapshot.targetVersion &&
					fingerprint(snapshot.index, t.version) === t.fingerprint,
			);
			targets.push({
				version: snapshot.targetVersion,
				fingerprint: fingerprint(snapshot.index, snapshot.targetVersion) as string,
			});
			if (targets.length > 32) throw new Error("Mirror target marker limit");
			const state: CatalogState = {
				schemaVersion: 2,
				repository: repo,
				indexCommit: snapshot.indexCommit,
				index: snapshot.index,
				targets,
			};
			const bytes = Buffer.from(JSON.stringify(state));
			if (bytes.length > STATE_LIMIT) throw new Error("Mirror catalog state byte limit");
			deadline.throwIfAborted();
			await this.storage.saveAtomicFile(statePath(product), bytes, deadline);
			return {
				schemaVersion: 1,
				verification: "server-sha256",
				repository: repo,
				indexCommit: snapshot.indexCommit,
				generation: snapshot.index.generation,
				targetVersion: snapshot.targetVersion,
				verified: snapshot.assets.map(summary),
			};
		} finally {
			this.commits.delete(product);
		}
	}

	public async readTools(
		product: string,
		kind: "helpers" | "executor",
		tag: string,
	): Promise<ToolProjection | null> {
		const repo = this.repository(product);
		checkToolsIdentity(kind, tag);
		const exact = await this.smallFile(toolPath(product, kind, tag));
		if (exact) return parseTools(JSON.parse(exact.toString("utf8")), repo, kind, tag);
		// Read a single old pointer only; never enumerate or import legacy v2 artifacts.
		const legacy = await this.smallFile(`mirror-tools/${product}/${kind}/current.json`);
		if (!legacy) return null;
		const data = JSON.parse(legacy.toString("utf8"));
		if (
			data?.tag !== tag ||
			typeof data.repository !== "string" ||
			data.repository.toLowerCase() !== repo
		)
			return null;
		return parseTools(data, repo, kind, tag);
	}

	public async commitTools(
		product: string,
		kind: "helpers" | "executor",
		tag: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<MirrorToolsReceipt> {
		const repo = this.repository(product);
		checkToolsIdentity(kind, tag);
		if (!this.storage.saveAtomicFile)
			throw new MirrorIngestError(503, "STORAGE_COMMIT_UNAVAILABLE");
		const key = `${product}:tools:${kind}`;
		if (this.commits.size >= 2 || this.commits.has(key))
			throw new MirrorIngestError(429, "MIRROR_COMMIT_IN_PROGRESS");
		this.commits.add(key);
		const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
		try {
			deadline.throwIfAborted();
			const projection = parseTools(input, repo, kind, tag);
			const previous = await this.readTools(product, kind, tag);
			if (
				previous &&
				digest([...previous.assets].sort((a, b) => a.name.localeCompare(b.name))) !==
					digest([...projection.assets].sort((a, b) => a.name.localeCompare(b.name)))
			)
				throw new MirrorIngestError(409, "TOOLS_METADATA_CONFLICT");
			const requestedBinaries = projection.binaries ?? [];
			// Metadata-only retries cannot erase already committed binary availability.
			if (previous?.binaries && !projection.binaries) projection.binaries = previous.binaries;
			for (const binary of projection.binaries ?? [])
				await verifyMirrorAsset(this.storage, binary, deadline);
			deadline.throwIfAborted();
			const path = toolPath(product, kind, tag);
			if (!(await this.storage.fileExists(path)) || (!previous?.binaries && projection.binaries))
				await this.storage.saveAtomicFile(path, Buffer.from(JSON.stringify(projection)), deadline);
			return {
				schemaVersion: 1,
				verification: "server-sha256",
				repository: repo,
				kind,
				tag,
				verified: [...projection.assets, ...requestedBinaries].map(summary),
			};
		} finally {
			this.commits.delete(key);
		}
	}
}
