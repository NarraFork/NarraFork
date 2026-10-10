import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, lstat, mkdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { applyZstdPatchToFile } from "../../server/lib/zstd-patch";
import { isValidGitHubRepository } from "../../shared/github-repository";
import {
	MAX_RELEASE_BINARY_BYTES,
	MAX_RELEASE_LEGACY_BYTES,
	MAX_RELEASE_PATCH_BYTES,
	RELEASE_SHA512_RE,
	type ReleasePatchMetadata,
	validateReleasePatchMetadata,
} from "../../shared/release-patch";
import { compareReleaseVersions, isValidReleaseVersion } from "../../shared/release-version";
import type { CheckUpdateResponse, ReleaseListItem, ReleaseMeta } from "../../update-server/types";
import {
	CI_METADATA_LIMIT,
	copyReleaseFile,
	downloadReleaseAsset,
	hashReleaseFile,
	type ReleaseAssetDownloader,
	readReleaseText,
	runCiGh,
} from "./ci-release-io";
import { CI_RELEASE_TARGETS, type CiReleaseManifest } from "./ci-release-types";
import type { GhRunner } from "./github-release";
import { validateBaselineMetadata } from "./github-release-baseline";
import {
	BRIDGE_DISK_RESERVE,
	BRIDGE_POST_LIMIT,
	BridgeHttpError,
	type FileHash,
	snapshotBridgeUploadFile,
	type UpdateServerBridgeConfig,
	UpdateServerBridgeHttp,
} from "./update-server-bridge-http";
import { generateBridgePatch } from "./update-server-bridge-patch";

const ROOT = "/api/v2/products/narrafork/releases";
const SEAL_FILE = "prepared-main-mirror.json";
const RECEIPT_FILE = "receipt-main-mirror.json";
export const MAIN_MIRROR_TOTAL_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BRIDGE_DISK = 24 * 1024 ** 3;
interface FullIdentity extends FileHash {
	filename: string;
}
interface SourceIdentity {
	version: string;
	filename: string;
	size: number;
	sha512: string;
}
export interface MainMirrorPatch {
	source: SourceIdentity;
	file: string;
	metadataFile: string;
	identity: FileHash;
	metadataIdentity: FileHash;
	metadata: ReleasePatchMetadata;
	origin: "github-bundle" | "bridge-generated";
}
export interface MainMirrorPlatform {
	platform: string;
	full: FullIdentity;
	patches: MainMirrorPatch[];
}
export interface MainMirrorSeal {
	schemaVersion: 1;
	product: "narrafork";
	serverUrl: string;
	repository: string;
	commit: string;
	workflowCommit: string;
	tag: string;
	version: string;
	channel: "stable" | "beta";
	runId: number;
	runAttempt: number;
	manifestSha256: string;
	releaseNotes: { en: string; "zh-CN": string };
	platforms: MainMirrorPlatform[];
}
export interface PreparedMainMirror {
	seal: MainMirrorSeal;
	sealSha256: string;
	bundleDir: string;
	bridgeDir: string;
}
export interface MirrorReceipt {
	schemaVersion: 1;
	status: "mirrored" | "partial";
	serverUrl: string;
	tag: string;
	runId: number;
	runAttempt: number;
	sealSha256: string;
	/** Closed diagnostic vocabulary; never includes response text, URLs or secrets. */
	failureCode?:
		| "TARGET_CONFLICT"
		| "SOURCE_DRIFT"
		| "BASELINE_ADVANCED"
		| "READBACK_FAILED"
		| "HTTP_FAILED"
		| "CANCELLED"
		| "MIRROR_FAILED";
	platforms: { platform: string; status: "verified" | "pending" }[];
}
export class MirrorPublicationError extends Error {
	constructor(readonly receipt: MirrorReceipt) {
		super(
			"PUBLISHED_NOT_MIRRORED: update server synchronization incomplete; restore original bridge receipt",
		);
		this.name = "MirrorPublicationError";
	}
}
export interface PrepareUpdateServerMainMirrorOptions {
	manifest: CiReleaseManifest;
	bundleDir: string;
	bridgeDir: string;
	config: UpdateServerBridgeConfig;
	signal?: AbortSignal;
	run?: GhRunner;
	http?: UpdateServerBridgeHttp;
	downloadAsset?: ReleaseAssetDownloader;
	/** Explicit fixture/operator candidate, never an implicit HOME/dist search. */
	localBaseline?: (source: SourceIdentity, platform: string) => Promise<string | undefined>;
}
function deadline(parent?: AbortSignal): AbortSignal {
	return AbortSignal.any([
		AbortSignal.timeout(MAIN_MIRROR_TOTAL_TIMEOUT_MS),
		...(parent ? [parent] : []),
	]);
}
function safeName(name: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(name);
}
function same(left: { size: number; sha512: string }, right: { size: number; sha512: string }) {
	return left.size === right.size && left.sha512 === right.sha512;
}
function sameHash(left: FileHash, right: FileHash) {
	return same(left, right) && left.sha256 === right.sha256;
}
function sameNotes(
	actual: ReleaseMeta["releaseNotes"],
	expected: MainMirrorSeal["releaseNotes"],
): boolean {
	return (
		typeof actual === "object" &&
		actual !== null &&
		!Array.isArray(actual) &&
		Object.keys(actual).length === 2 &&
		actual.en === expected.en &&
		actual["zh-CN"] === expected["zh-CN"]
	);
}
function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
function filePath(directory: string, name: string): string {
	if (!safeName(name)) throw new Error("Invalid bridge artifact filename");
	return join(directory, name);
}
function assertSeparateDirectories(bundleDir: string, bridgeDir: string) {
	const bundle = resolve(bundleDir);
	const bridge = resolve(bridgeDir);
	const isInside = (child: string, parent: string) => {
		const rel = relative(parent, child);
		return !rel || (!rel.startsWith("..") && !rel.startsWith("/"));
	};
	if (isInside(bundle, bridge) || isInside(bridge, bundle))
		throw new Error("Bridge directory must be separate from original bundle");
}
async function verifyOriginal(
	manifest: CiReleaseManifest,
	bundleDir: string,
	signal: AbortSignal,
): Promise<{ platforms: MainMirrorPlatform[]; manifestSha256: string }> {
	const plan = manifest.plan;
	if (
		!isValidGitHubRepository(plan.repository) ||
		!isValidReleaseVersion(plan.version) ||
		!/^[a-f0-9]{40}$/.test(plan.commit) ||
		!/^[a-f0-9]{40}$/.test(plan.workflowCommit) ||
		plan.tag !== `v${plan.version}` ||
		!["stable", "beta"].includes(plan.channel) ||
		!Number.isSafeInteger(plan.runId) ||
		plan.runId <= 0 ||
		!Number.isSafeInteger(plan.runAttempt) ||
		plan.runAttempt <= 0 ||
		typeof plan.changelog.en !== "string" ||
		typeof plan.changelog["zh-CN"] !== "string"
	)
		throw new Error("Invalid mirror source release plan");
	const manifestText = await readReleaseText(join(bundleDir, "manifest.json"));
	if (JSON.stringify(JSON.parse(manifestText)) !== JSON.stringify(manifest))
		throw new Error("Original bundle manifest does not match supplied artifact");
	if (new Set(manifest.files.map((file) => file.name)).size !== manifest.files.length)
		throw new Error("Duplicate source artifact filename");
	const platforms: MainMirrorPlatform[] = [];
	for (const target of CI_RELEASE_TARGETS) {
		signal.throwIfAborted();
		const filename = `narrafork-${plan.version}-${target.suffix}`;
		const binary = manifest.files.find((file) => file.name === filename);
		const sidecar = manifest.files.find((file) => file.name === `${filename}.metadata.json`);
		if (!binary || !sidecar) throw new Error(`Missing original binary/sidecar: ${target.platform}`);
		// Oversize declarations fail closed before expensive I/O. Accepted files still need exact byte hashes.
		if (
			!Number.isSafeInteger(binary.size) ||
			binary.size <= 0 ||
			binary.size + 128 * 1024 > BRIDGE_POST_LIMIT
		)
			throw new Error("Bridge full exceeds 256MiB multipart request budget before publication");
		const fullHash = await hashReleaseFile(
			filePath(join(bundleDir, "dist"), filename),
			MAX_RELEASE_BINARY_BYTES,
			signal,
		);
		const sidecarPath = filePath(join(bundleDir, "dist"), sidecar.name);
		if (
			!sameHash(fullHash, binary) ||
			!sameHash(await hashReleaseFile(sidecarPath, CI_METADATA_LIMIT, signal), sidecar)
		)
			throw new Error(`Original artifact hash mismatch: ${target.platform}`);
		const metadata = validateBaselineMetadata(
			JSON.parse(await readReleaseText(sidecarPath, CI_METADATA_LIMIT)),
			{
				version: plan.version,
				platform: target.platform,
				name: filename,
				size: fullHash.size,
				commit: plan.commit,
				repository: plan.repository,
			},
		);
		if (!sameHash(metadata, fullHash)) throw new Error("Original sidecar identity mismatch");
		platforms.push({ platform: target.platform, full: { filename, ...fullHash }, patches: [] });
	}
	return { platforms, manifestSha256: digest(manifestText) };
}
function validateRemoteMetadata(value: unknown, version: string): ReleaseMeta {
	if (!value || typeof value !== "object") throw new Error("Invalid old server metadata");
	const meta = value as ReleaseMeta;
	if (
		meta.version !== version ||
		!["stable", "beta"].includes(meta.channel) ||
		!meta.platforms ||
		typeof meta.platforms !== "object"
	)
		throw new Error("Invalid old server version/channel");
	for (const [platform, file] of Object.entries(meta.platforms)) {
		if (
			!CI_RELEASE_TARGETS.some((target) => target.platform === platform) ||
			!file ||
			!safeName(file.filename) ||
			!Number.isSafeInteger(file.size) ||
			file.size <= 0 ||
			file.size > MAX_RELEASE_BINARY_BYTES ||
			!RELEASE_SHA512_RE.test(file.sha512)
		)
			throw new Error("Invalid old server platform identity");
	}
	return meta;
}
async function metadata(
	http: UpdateServerBridgeHttp,
	version: string,
	signal: AbortSignal,
): Promise<ReleaseMeta | undefined> {
	const value = await http.readJson<unknown>(`${ROOT}/${version}/metadata`, {
		signal,
		allowNotFound: true,
	});
	return value === undefined ? undefined : validateRemoteMetadata(value, version);
}
function assertTarget(
	target: ReleaseMeta | undefined,
	platform: MainMirrorPlatform,
	seal: Pick<MainMirrorSeal, "channel">,
) {
	if (target && target.channel !== seal.channel)
		throw new Error("Target channel conflicts with published server release");
	const existing = target?.platforms[platform.platform];
	if (existing && (existing.filename !== platform.full.filename || !same(existing, platform.full)))
		throw new Error(`Target 409 identity conflict: ${platform.platform}`);
}
async function selectSources(
	http: UpdateServerBridgeHttp,
	version: string,
	platforms: MainMirrorPlatform[],
	channel: MainMirrorSeal["channel"],
	signal: AbortSignal,
): Promise<Map<string, SourceIdentity[]>> {
	const target = await metadata(http, version, signal);
	for (const platform of platforms) assertTarget(target, platform, { channel });
	const listing = await http.readJson<{ releases: ReleaseListItem[] }>(ROOT, {
		authenticated: true,
		signal,
	});
	if (!listing || !Array.isArray(listing.releases) || listing.releases.length > 2000)
		throw new Error("Invalid/truncated old server release list");
	const seen = new Set<string>();
	for (const release of listing.releases) {
		if (
			!isValidReleaseVersion(release.version) ||
			!["stable", "beta"].includes(release.channel) ||
			!Array.isArray(release.platforms) ||
			seen.has(release.version)
		)
			throw new Error("Invalid/duplicate old server release list item");
		seen.add(release.version);
	}
	const cache = new Map<string, ReleaseMeta>();
	const result = new Map<string, SourceIdentity[]>();
	for (const platform of platforms) {
		const sources: SourceIdentity[] = [];
		for (const sourceChannel of ["stable", "beta"] as const) {
			const latest = await http.readJson<CheckUpdateResponse>(
				`${ROOT}/latest?channel=${sourceChannel}&platform=${platform.platform}`,
				{ signal },
			);
			if (!latest || typeof latest.updateAvailable !== "boolean")
				throw new Error("Invalid old server latest response");
			if (
				latest.version &&
				(!isValidReleaseVersion(latest.version) ||
					compareReleaseVersions(latest.version, version) > 0)
			)
				throw new Error("Old server newer release prevents stale mirror");
			const candidate = listing.releases
				.filter(
					(release) =>
						release.channel === sourceChannel &&
						release.platforms.includes(platform.platform) &&
						compareReleaseVersions(release.version, version) < 0,
				)
				.sort((a, b) => compareReleaseVersions(b.version, a.version))[0];
			if (!candidate) continue;
			let sourceMeta = cache.get(candidate.version);
			if (!sourceMeta) {
				sourceMeta = await metadata(http, candidate.version, signal);
				if (!sourceMeta || sourceMeta.channel !== sourceChannel)
					throw new Error("Old source metadata disappeared/changed");
				cache.set(candidate.version, sourceMeta);
			}
			const file = sourceMeta.platforms[platform.platform];
			if (!file) throw new Error("Old source platform disappeared");
			sources.push({
				version: candidate.version,
				filename: file.filename,
				size: file.size,
				sha512: file.sha512,
			});
		}
		if (!sources.length)
			throw new Error(
				`No verifiable legacy upgrade basis: ${platform.platform}; full-only is forbidden`,
			);
		result.set(
			platform.platform,
			sources.sort((a, b) => compareReleaseVersions(a.version, b.version)),
		);
	}
	return result;
}
async function fallbackGithub(
	options: PrepareUpdateServerMainMirrorOptions,
	source: SourceIdentity,
	output: string,
	signal: AbortSignal,
): Promise<void> {
	const run = options.run ?? runCiGh;
	signal.throwIfAborted();
	const raw = await run([
		"api",
		`repos/${options.manifest.plan.repository}/releases/tags/v${source.version}`,
	]);
	if (Buffer.byteLength(raw) > 1024 * 1024)
		throw new Error("GitHub baseline response exceeds limit");
	const release = JSON.parse(raw) as {
		draft?: boolean;
		tag_name?: string;
		assets?: { id: number; name: string; size: number; state: string }[];
	};
	if (
		release.draft !== false ||
		release.tag_name !== `v${source.version}` ||
		!Array.isArray(release.assets) ||
		release.assets.length > 200
	)
		throw new Error("Legacy source requires already-public GitHub original binary");
	const assets = release.assets.filter((asset) => asset.name === source.filename);
	if (
		assets.length !== 1 ||
		assets[0].size !== source.size ||
		assets[0].state !== "uploaded" ||
		!Number.isSafeInteger(assets[0].id) ||
		assets[0].id <= 0
	)
		throw new Error("No matching original GitHub baseline binary");
	signal.throwIfAborted();
	await (options.downloadAsset ?? downloadReleaseAsset)({
		repository: options.manifest.plan.repository,
		assetId: assets[0].id,
		size: source.size,
		outputPath: output,
		signal,
	});
}
async function sourceBinary(
	options: PrepareUpdateServerMainMirrorOptions,
	http: UpdateServerBridgeHttp,
	source: SourceIdentity,
	platform: string,
	output: string,
	signal: AbortSignal,
): Promise<void> {
	const local = await options.localBaseline?.(source, platform);
	if (local) {
		if (!same(await hashReleaseFile(local, source.size, signal), source))
			throw new Error("Explicit baseline identity mismatch");
		await copyReleaseFile(local, output, source.size, signal);
	} else {
		try {
			await http.download(`${ROOT}/${source.version}/download/${source.filename}`, output, {
				maxBytes: source.size,
				expected: { size: source.size, sha512: source.sha512 },
				signal,
			});
		} catch (error) {
			if (!(error instanceof BridgeHttpError) || error.status !== 404) throw error;
			try {
				await fallbackGithub(options, source, output, signal);
			} catch {
				throw new Error(
					`Legacy source binary unavailable: ${platform} v${source.version}; supply exact published original bytes, never rebuild/full-only`,
				);
			}
		}
	}
	if (!same(await hashReleaseFile(output, source.size, signal), source))
		throw new Error("Legacy source binary hash mismatch");
}
async function findBundlePatch(
	options: PrepareUpdateServerMainMirrorOptions,
	platform: MainMirrorPlatform,
	source: SourceIdentity,
	signal: AbortSignal,
): Promise<{ path: string; meta: ReleasePatchMetadata } | undefined> {
	const names = [
		`${platform.full.filename}.from-${source.version}.zstd-patch`,
		`${platform.full.filename}.zstd-patch`,
	];
	for (const name of names) {
		const entry = options.manifest.files.find((file) => file.name === name);
		const sidecar = options.manifest.files.find((file) => file.name === `${name}.meta.json`);
		if (!entry || !sidecar) continue;
		const path = filePath(join(options.bundleDir, "dist"), name);
		const sidecarPath = filePath(join(options.bundleDir, "dist"), sidecar.name);
		if (
			!sameHash(await hashReleaseFile(path, MAX_RELEASE_PATCH_BYTES, signal), entry) ||
			!sameHash(await hashReleaseFile(sidecarPath, CI_METADATA_LIMIT, signal), sidecar)
		)
			throw new Error("Original GitHub patch artifact hash mismatch");
		const meta = validateReleasePatchMetadata(
			JSON.parse(await readReleaseText(sidecarPath, CI_METADATA_LIMIT)),
			{
				toVersion: options.manifest.plan.version,
				patchSize: entry.size,
				newFileSize: platform.full.size,
				newFileSha512: platform.full.sha512,
			},
		);
		// Legacy dictionary decoding buffers whole binaries; regenerate large inputs with streaming patch-from.
		if (
			meta.mode !== "patch-from" &&
			Math.max(meta.oldFileSize, meta.newFileSize, meta.patchSize) > MAX_RELEASE_LEGACY_BYTES
		)
			continue;
		if (
			meta.fromVersion === source.version &&
			meta.oldFileSize === source.size &&
			meta.oldFileSha512 === source.sha512
		)
			return { path, meta };
	}
	return undefined;
}
function assertMultipartBudget(
	full: FullIdentity,
	patches: MainMirrorPatch[],
	notes: MainMirrorSeal["releaseNotes"],
) {
	for (const patch of patches) {
		if (
			full.size +
				patch.identity.size +
				patch.metadataIdentity.size +
				Buffer.byteLength(JSON.stringify(notes)) +
				64 * 1024 >
			BRIDGE_POST_LIMIT
		)
			throw new Error(
				"Bridge full+patch multipart exceeds 256MiB request limit before publication",
			);
	}
}

/** Read-only network planning. Only new bridge files are written; original GH bytes stay untouched. */
export async function prepareUpdateServerMainMirror(
	options: PrepareUpdateServerMainMirrorOptions,
): Promise<PreparedMainMirror> {
	const signal = deadline(options.signal);
	assertSeparateDirectories(options.bundleDir, options.bridgeDir);
	const http = options.http ?? new UpdateServerBridgeHttp(options.config);
	if (http.serverUrl !== options.config.serverUrl)
		throw new Error("Mirror transport server identity mismatch");
	const original = await verifyOriginal(options.manifest, options.bundleDir, signal);
	const sources = await selectSources(
		http,
		options.manifest.plan.version,
		original.platforms,
		options.manifest.plan.channel,
		signal,
	);
	const plan = options.manifest.plan;
	const notes = { en: plan.changelog.en, "zh-CN": plan.changelog["zh-CN"] };
	// Disk reserve includes maximum patch + old basis + reconstruction. Process platforms serially.
	const retainedMaximum = original.platforms.reduce(
		(sum, item) => sum + (sources.get(item.platform)?.length ?? 0) * MAX_RELEASE_PATCH_BYTES,
		0,
	);
	if (retainedMaximum > MAX_BRIDGE_DISK) throw new Error("Bridge artifact disk budget exceeded");
	await mkdir(options.bridgeDir, { recursive: false, mode: 0o700 });
	const disk = await statfs(options.bridgeDir);
	if (
		disk.bavail * disk.bsize <
		retainedMaximum + 2 * MAX_RELEASE_BINARY_BYTES + BRIDGE_DISK_RESERVE
	)
		throw new Error("Insufficient bridge preparation disk budget");
	const seal: MainMirrorSeal = {
		schemaVersion: 1,
		product: "narrafork",
		serverUrl: http.serverUrl,
		repository: plan.repository,
		commit: plan.commit,
		workflowCommit: plan.workflowCommit,
		tag: plan.tag,
		version: plan.version,
		channel: plan.channel,
		runId: plan.runId,
		runAttempt: plan.runAttempt,
		manifestSha256: original.manifestSha256,
		releaseNotes: notes,
		platforms: original.platforms,
	};
	for (const platform of seal.platforms) {
		for (const source of sources.get(platform.platform) ?? []) {
			signal.throwIfAborted();
			const stem = `${platform.full.filename}.from-${source.version}.zstd-patch`;
			const patchPath = filePath(options.bridgeDir, stem);
			const sourcePath = filePath(
				options.bridgeDir,
				`${platform.platform}-${source.version}.basis`,
			);
			const outputPath = filePath(
				options.bridgeDir,
				`${platform.platform}-${source.version}.rebuilt`,
			);
			try {
				await sourceBinary(options, http, source, platform.platform, sourcePath, signal);
				const existing = await findBundlePatch(options, platform, source, signal);
				let meta: ReleasePatchMetadata;
				if (existing) {
					await copyReleaseFile(existing.path, patchPath, MAX_RELEASE_PATCH_BYTES, signal);
					meta = existing.meta;
				} else {
					meta = validateReleasePatchMetadata(
						await generateBridgePatch({
							oldFilePath: sourcePath,
							newFilePath: filePath(join(options.bundleDir, "dist"), platform.full.filename),
							patchOutputPath: patchPath,
							fromVersion: source.version,
							toVersion: seal.version,
							signal,
							maxPatchBytes: Math.min(
								MAX_RELEASE_PATCH_BYTES,
								BRIDGE_POST_LIMIT -
									platform.full.size -
									Buffer.byteLength(JSON.stringify(notes)) -
									128 * 1024,
							),
						}),
					);
				}
				if (
					meta.oldFileSize !== source.size ||
					meta.oldFileSha512 !== source.sha512 ||
					meta.newFileSize !== platform.full.size ||
					meta.newFileSha512 !== platform.full.sha512
				)
					throw new Error("Bridge generation source/target identity mismatch");
				await applyZstdPatchToFile({
					oldFilePath: sourcePath,
					patchFilePath: patchPath,
					outputFilePath: outputPath,
					meta,
					signal,
					maxOutputBytes: platform.full.size,
					timeoutMs: 15 * 60 * 1000,
				});
				if (!sameHash(await hashReleaseFile(outputPath, platform.full.size, signal), platform.full))
					throw new Error("Bridge reconstruction does not match original CI binary");
				const metadataFile = `${stem}.meta.json`;
				await writeFile(filePath(options.bridgeDir, metadataFile), `${JSON.stringify(meta)}\n`, {
					flag: "wx",
					mode: 0o600,
				});
				platform.patches.push({
					source,
					file: stem,
					metadataFile,
					metadata: meta,
					identity: await hashReleaseFile(patchPath, MAX_RELEASE_PATCH_BYTES, signal),
					metadataIdentity: await hashReleaseFile(
						filePath(options.bridgeDir, metadataFile),
						CI_METADATA_LIMIT,
						signal,
					),
					origin: existing ? "github-bundle" : "bridge-generated",
				});
				assertMultipartBudget(platform.full, platform.patches, notes);
			} finally {
				await rm(sourcePath, { force: true });
				await rm(outputPath, { force: true });
			}
		}
	}
	signal.throwIfAborted();
	const sealText = `${JSON.stringify(seal, null, 2)}\n`;
	if (Buffer.byteLength(sealText) > 1024 * 1024)
		throw new Error("Bridge seal exceeds metadata limit");
	await writeFile(join(options.bridgeDir, SEAL_FILE), sealText, { flag: "wx", mode: 0o600 });
	return {
		seal,
		sealSha256: digest(sealText),
		bundleDir: options.bundleDir,
		bridgeDir: options.bridgeDir,
	};
}

export async function verifyPreparedMainMirror(
	prepared: PreparedMainMirror,
	config: UpdateServerBridgeConfig,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	const signal = deadline(options.signal);
	assertSeparateDirectories(prepared.bundleDir, prepared.bridgeDir);
	const text = await readReleaseText(join(prepared.bridgeDir, SEAL_FILE));
	if (
		!/^[a-f0-9]{64}$/.test(prepared.sealSha256) ||
		digest(text) !== prepared.sealSha256 ||
		JSON.stringify(JSON.parse(text)) !== JSON.stringify(prepared.seal)
	)
		throw new Error("Bridge seal identity mismatch");
	const seal = prepared.seal;
	if (
		seal.schemaVersion !== 1 ||
		seal.product !== "narrafork" ||
		seal.serverUrl !== config.serverUrl
	)
		throw new Error("Bridge restore server/product identity mismatch");
	const manifest = JSON.parse(
		await readReleaseText(join(prepared.bundleDir, "manifest.json")),
	) as CiReleaseManifest;
	const original = await verifyOriginal(manifest, prepared.bundleDir, signal);
	if (
		original.manifestSha256 !== seal.manifestSha256 ||
		manifest.plan.repository !== seal.repository ||
		manifest.plan.commit !== seal.commit ||
		manifest.plan.workflowCommit !== seal.workflowCommit ||
		manifest.plan.tag !== seal.tag ||
		manifest.plan.version !== seal.version ||
		manifest.plan.channel !== seal.channel ||
		manifest.plan.runId !== seal.runId ||
		manifest.plan.runAttempt !== seal.runAttempt ||
		JSON.stringify(seal.releaseNotes) !==
			JSON.stringify({
				en: manifest.plan.changelog.en,
				"zh-CN": manifest.plan.changelog["zh-CN"],
			}) ||
		!Array.isArray(seal.platforms) ||
		seal.platforms.length !== CI_RELEASE_TARGETS.length
	)
		throw new Error("Bridge seal does not match original release artifact");
	for (let index = 0; index < original.platforms.length; index++) {
		const platform = seal.platforms[index];
		if (
			platform.platform !== original.platforms[index].platform ||
			JSON.stringify(platform.full) !== JSON.stringify(original.platforms[index].full) ||
			!Array.isArray(platform.patches) ||
			!platform.patches.length ||
			platform.patches.length > 2
		)
			throw new Error("Bridge sealed platform/full/patch coverage mismatch");
		const bases = new Set<string>();
		for (const patch of platform.patches) {
			const meta = validateReleasePatchMetadata(patch.metadata, {
				toVersion: seal.version,
				newFileSize: platform.full.size,
				newFileSha512: platform.full.sha512,
				patchSize: patch.identity.size,
			});
			if (
				meta.mode !== "patch-from" &&
				Math.max(meta.oldFileSize, meta.newFileSize, meta.patchSize) > MAX_RELEASE_LEGACY_BYTES
			)
				throw new Error("Bridge seal contains oversized legacy dictionary patch");
			if (
				!safeName(patch.source.filename) ||
				bases.has(meta.fromVersion) ||
				meta.fromVersion !== patch.source.version ||
				meta.oldFileSize !== patch.source.size ||
				meta.oldFileSha512 !== patch.source.sha512 ||
				patch.file !== `${platform.full.filename}.from-${meta.fromVersion}.zstd-patch` ||
				patch.metadataFile !== `${patch.file}.meta.json`
			)
				throw new Error("Bridge sealed source identity mismatch");
			bases.add(meta.fromVersion);
			const metaPath = filePath(prepared.bridgeDir, patch.metadataFile);
			if (
				!sameHash(
					await hashReleaseFile(
						filePath(prepared.bridgeDir, patch.file),
						MAX_RELEASE_PATCH_BYTES,
						signal,
					),
					patch.identity,
				) ||
				!sameHash(
					await hashReleaseFile(metaPath, CI_METADATA_LIMIT, signal),
					patch.metadataIdentity,
				) ||
				JSON.stringify(
					validateReleasePatchMetadata(
						JSON.parse(await readReleaseText(metaPath, CI_METADATA_LIMIT)),
					),
				) !== JSON.stringify(meta)
			)
				throw new Error("Bridge sealed patch/metadata bytes changed");
		}
		assertMultipartBudget(platform.full, platform.patches, seal.releaseNotes);
	}
}
export async function restorePreparedMainMirror(options: {
	manifest: CiReleaseManifest;
	bundleDir: string;
	bridgeDir: string;
	config: UpdateServerBridgeConfig;
	sealSha256: string;
	signal?: AbortSignal;
}): Promise<PreparedMainMirror> {
	const seal = JSON.parse(
		await readReleaseText(join(options.bridgeDir, SEAL_FILE)),
	) as MainMirrorSeal;
	const prepared = {
		seal,
		sealSha256: options.sealSha256,
		bundleDir: options.bundleDir,
		bridgeDir: options.bridgeDir,
	};
	if (
		JSON.stringify(JSON.parse(await readReleaseText(join(options.bundleDir, "manifest.json")))) !==
		JSON.stringify(options.manifest)
	)
		throw new Error("Restore requires original source artifact manifest");
	await verifyPreparedMainMirror(prepared, options.config, { signal: options.signal });
	return prepared;
}
async function saveReceipt(directory: string, receipt: MirrorReceipt): Promise<void> {
	const temporary = join(directory, `${RECEIPT_FILE}.${randomUUID()}.part`);
	try {
		await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		const destination = join(directory, RECEIPT_FILE);
		const stat = await lstat(destination).catch(() => undefined);
		if (stat && !stat.isFile()) throw new Error("Invalid bridge receipt file type");
		await rename(temporary, destination);
	} finally {
		await rm(temporary, { force: true });
	}
}
async function matchesRemote(
	http: UpdateServerBridgeHttp,
	seal: MainMirrorSeal,
	platform: MainMirrorPlatform,
	signal: AbortSignal,
): Promise<boolean> {
	const target = await metadata(http, seal.version, signal);
	assertTarget(target, platform, seal);
	if (
		!target?.platforms[platform.platform]?.hasZstdPatch ||
		!sameNotes(target.releaseNotes, seal.releaseNotes)
	)
		return false;
	try {
		if (
			!sameHash(
				await http.readHash(`${ROOT}/${seal.version}/download/${platform.full.filename}`, {
					maxBytes: platform.full.size,
					signal,
				}),
				platform.full,
			)
		)
			return false;
		for (const patch of platform.patches) {
			const query = `?fromVersion=${patch.source.version}`;
			const remoteMeta = await http.readJson<unknown>(
				`${ROOT}/${seal.version}/zstd-patch-meta/${platform.full.filename}${query}`,
				{ maxBytes: CI_METADATA_LIMIT, signal, allowNotFound: true },
			);
			if (
				remoteMeta === undefined ||
				JSON.stringify(validateReleasePatchMetadata(remoteMeta)) !==
					JSON.stringify(validateReleasePatchMetadata(patch.metadata))
			)
				return false;
			if (
				!sameHash(
					await http.readHash(
						`${ROOT}/${seal.version}/zstd-patch/${platform.full.filename}${query}`,
						{ maxBytes: patch.identity.size, signal },
					),
					patch.identity,
				)
			)
				return false;
		}
		return true;
	} catch (error) {
		if (error instanceof BridgeHttpError && error.status === 404) return false;
		throw error;
	}
}

/** Copy and hash before POST, then unlink the private snapshot and retain only a read-only FD.
 * Network awaits can neither reopen a replaced source path nor observe writes to its old inode.
 */
async function snapshotUploadInputs(
	prepared: PreparedMainMirror,
	platform: MainMirrorPlatform,
	patch: MainMirrorPatch,
	signal: AbortSignal,
): Promise<{
	files: { field: string; filename: string; body: Blob }[];
	close: () => Promise<void>;
}> {
	const specs = [
		{
			field: "file",
			filename: platform.full.filename,
			path: filePath(join(prepared.bundleDir, "dist"), platform.full.filename),
			identity: platform.full,
		},
		{
			field: "zstdPatch",
			filename: patch.file,
			path: filePath(prepared.bridgeDir, patch.file),
			identity: patch.identity,
		},
		{
			field: "zstdPatchMeta",
			filename: patch.metadataFile,
			path: filePath(prepared.bridgeDir, patch.metadataFile),
			identity: patch.metadataIdentity,
		},
	];
	const disk = await statfs(prepared.bridgeDir);
	const total = specs.reduce((sum, spec) => sum + spec.identity.size, 0);
	if (
		total + 64 * 1024 > BRIDGE_POST_LIMIT ||
		disk.bavail * disk.bsize < total + BRIDGE_DISK_RESERVE
	)
		throw new Error("Insufficient bounded multipart snapshot disk budget");
	const snapshots: FileHandle[] = [];
	const files: { field: string; filename: string; body: Blob }[] = [];
	const close = async () => {
		await Promise.all(snapshots.splice(0).map((handle) => handle.close()));
	};
	try {
		for (const spec of specs) {
			const snapshot = await snapshotBridgeUploadFile(
				spec.path,
				prepared.bridgeDir,
				spec.identity,
				signal,
			);
			snapshots.push(snapshot);
			files.push({ field: spec.field, filename: spec.filename, body: Bun.file(snapshot.fd) });
		}
		return { files, close };
	} catch (error) {
		await close();
		throw error;
	}
}

async function assertFrozenBasisCurrent(
	http: UpdateServerBridgeHttp,
	seal: MainMirrorSeal,
	signal: AbortSignal,
): Promise<void> {
	const listing = await http.readJson<{ releases: ReleaseListItem[] }>(ROOT, {
		authenticated: true,
		signal,
	});
	if (!listing || !Array.isArray(listing.releases) || listing.releases.length > 2000)
		throw new Error("Invalid/truncated old server release list");
	const seen = new Set<string>();
	for (const release of listing.releases) {
		if (
			!isValidReleaseVersion(release.version) ||
			!["stable", "beta"].includes(release.channel) ||
			!Array.isArray(release.platforms) ||
			seen.has(release.version)
		)
			throw new Error("Invalid/duplicate old server release list item");
		seen.add(release.version);
	}
	for (const platform of seal.platforms) {
		const relevant = listing.releases.filter((release) =>
			release.platforms.includes(platform.platform),
		);
		if (relevant.some((release) => compareReleaseVersions(release.version, seal.version) > 0))
			throw new Error("Frozen legacy baseline advanced; original receipt cannot be replanned");
		for (const channel of ["stable", "beta"] as const) {
			const latest = relevant
				.filter(
					(release) =>
						release.channel === channel &&
						compareReleaseVersions(release.version, seal.version) < 0,
				)
				.sort((a, b) => compareReleaseVersions(b.version, a.version))[0];
			if (latest && !platform.patches.some((patch) => patch.source.version === latest.version))
				throw new Error("Frozen legacy baseline advanced; original receipt cannot be replanned");
		}
	}
}

/** Serial immediate-public writes. Failures retain a resumable receipt, never roll back GH/server. */
export async function publishUpdateServerMainMirror(
	prepared: PreparedMainMirror,
	config: UpdateServerBridgeConfig,
	options: { signal?: AbortSignal; http?: UpdateServerBridgeHttp } = {},
): Promise<MirrorReceipt> {
	const signal = deadline(options.signal);
	await verifyPreparedMainMirror(prepared, config, { signal });
	const { seal } = prepared;
	const http = options.http ?? new UpdateServerBridgeHttp(config);
	if (http.serverUrl !== seal.serverUrl)
		throw new Error("Mirror publish transport identity mismatch");
	const receipt: MirrorReceipt = {
		schemaVersion: 1,
		status: "partial",
		serverUrl: seal.serverUrl,
		tag: seal.tag,
		runId: seal.runId,
		runAttempt: seal.runAttempt,
		sealSha256: prepared.sealSha256,
		platforms: seal.platforms.map(({ platform }) => ({ platform, status: "pending" })),
	};
	try {
		// An already-complete frozen mirror can be verified read-only, even after newer releases.
		const target = await metadata(http, seal.version, signal);
		for (const platform of seal.platforms) assertTarget(target, platform, seal);
		for (let index = 0; index < seal.platforms.length; index++) {
			if (await matchesRemote(http, seal, seal.platforms[index], signal))
				receipt.platforms[index].status = "verified";
		}
		if (receipt.platforms.every((item) => item.status === "verified")) {
			receipt.status = "mirrored";
			await saveReceipt(prepared.bridgeDir, receipt);
			return receipt;
		}
		// Recheck *all* frozen source identities and current bases before any repair/write.
		await assertFrozenBasisCurrent(http, seal, signal);
		for (const platform of seal.platforms) {
			for (const patch of platform.patches) {
				const source = await metadata(http, patch.source.version, signal);
				const file = source?.platforms[platform.platform];
				if (!file || file.filename !== patch.source.filename || !same(file, patch.source))
					throw new Error("Frozen old server source identity changed");
			}
		}
		await saveReceipt(prepared.bridgeDir, receipt);
		for (let index = 0; index < seal.platforms.length; index++) {
			const platform = seal.platforms[index];
			if (!(await matchesRemote(http, seal, platform, signal))) {
				receipt.platforms[index].status = "pending";
				await assertFrozenBasisCurrent(http, seal, signal);
				for (const patch of platform.patches) {
					signal.throwIfAborted();
					assertTarget(await metadata(http, seal.version, signal), platform, seal);
					const snapshot = await snapshotUploadInputs(prepared, platform, patch, signal);
					try {
						const form = new FormData();
						form.set("version", seal.version);
						form.set("channel", seal.channel);
						form.set("platform", platform.platform);
						form.set("releaseNotes", JSON.stringify(seal.releaseNotes));
						for (const file of snapshot.files) form.set(file.field, file.body, file.filename);
						await http.upload(ROOT, form, { signal });
					} finally {
						await snapshot.close();
					}
				}
				if (!(await matchesRemote(http, seal, platform, signal)))
					throw new Error("Public server mirror readback failed");
			}
			receipt.platforms[index].status = "verified";
			await saveReceipt(prepared.bridgeDir, receipt);
		}
		receipt.status = "mirrored";
		await saveReceipt(prepared.bridgeDir, receipt);
		return receipt;
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		receipt.failureCode = signal.aborted
			? "CANCELLED"
			: message.startsWith("Target 409") || message.startsWith("Target channel")
				? "TARGET_CONFLICT"
				: message === "Frozen old server source identity changed"
					? "SOURCE_DRIFT"
					: message.startsWith("Frozen legacy baseline advanced")
						? "BASELINE_ADVANCED"
						: message === "Public server mirror readback failed"
							? "READBACK_FAILED"
							: error instanceof BridgeHttpError
								? "HTTP_FAILED"
								: "MIRROR_FAILED";
		await saveReceipt(prepared.bridgeDir, receipt).catch(() => {});
		throw new MirrorPublicationError(receipt);
	}
}
