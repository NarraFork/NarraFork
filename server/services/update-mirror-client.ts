import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { parseMirrorAvailability } from "../../shared/independent-update-mirror";
import {
	type GithubPatchStep,
	MAX_RELEASE_BINARY_BYTES,
	MAX_RELEASE_PATCH_BYTES,
	validateReleasePatchMetadata,
} from "../../shared/release-patch";
import { compareReleaseVersions } from "../../shared/release-version";
import type { UpdateSourceIdentity } from "../../shared/update-identity";
import {
	MAX_UPDATE_INDEX_BYTES,
	MAX_UPDATE_NOTES_BYTES,
	parseUpdateIndex,
	parseUpdateNotes,
	type UpdateIndexAsset,
} from "../../shared/update-index";
import {
	fetchUpdateWithTimeout,
	readUpdateJson,
	type UpdateFetchContext,
} from "../lib/net/update-fetch";
import { planGithubReleasePatches } from "./github-release-patch-planner";
import { GithubUpdateError, validateGithubBinaryMetadata } from "./github-release-update";
import type { ReleaseInfo, UpdateCheckResult } from "./update-service";

type MirrorIdentity = Extract<UpdateSourceIdentity, { source: "update-server" }>;
interface MetadataBudget {
	remaining: number;
}
const MAX_CHECK_METADATA_BYTES = 4 * 1024 * 1024;
function consumeMetadata(budget: MetadataBudget, bytes: number) {
	budget.remaining -= bytes;
	if (budget.remaining < 0) throw new Error("Mirror check metadata exceeds total byte budget");
}
async function readCheckJson(response: Response, budget: MetadataBudget) {
	if (!response.body) throw new Error("Missing mirror metadata body");
	const metered = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				consumeMetadata(budget, chunk.byteLength);
				controller.enqueue(chunk);
			},
		}),
	);
	return readUpdateJson(
		new Response(metered, { headers: response.headers }),
		MAX_UPDATE_INDEX_BYTES,
	);
}
export interface MirrorAsset extends UpdateIndexAsset {
	url: string;
}
export interface MirrorPatchStep extends GithubPatchStep {
	name: string;
	metadata: MirrorAsset;
	sha256: string;
}
export interface MirrorBinaryDescriptor extends MirrorAsset {
	version: string;
	platform: string;
	commit: string;
	sha512: string;
	metadata: MirrorAsset;
	recoveryManifestVersions: number[];
}
function mirrorBase(identity: MirrorIdentity) {
	return `${identity.serverUrl}/api/v3/products/${encodeURIComponent(identity.product)}/mirror`;
}
function freezeAsset(identity: MirrorIdentity, asset: UpdateIndexAsset): MirrorAsset {
	return {
		name: asset.name,
		size: asset.size,
		sha256: asset.sha256,
		url: `${mirrorBase(identity)}/assets/${asset.sha256}`,
	};
}
function validateAsset(identity: MirrorIdentity, asset: MirrorAsset, maximumBytes: number) {
	if (
		!asset ||
		!/^[a-f0-9]{64}$/.test(asset.sha256) ||
		!Number.isSafeInteger(asset.size) ||
		asset.size <= 0 ||
		asset.size > maximumBytes ||
		asset.url !== `${mirrorBase(identity)}/assets/${asset.sha256}`
	)
		throw new Error("Invalid frozen mirror asset descriptor");
}
export function validateMirrorFull(release: ReleaseInfo): MirrorBinaryDescriptor {
	const identity = release.sourceIdentity;
	const full = release._mirror?.full;
	if (
		release.source !== "update-server" ||
		identity?.source !== "update-server" ||
		release._github ||
		!full ||
		release._mirror?.serverUrl !== identity.serverUrl ||
		release.repository?.toLowerCase() !== identity.repository ||
		full.version !== release.version ||
		full.platform !== identity.platform ||
		full.name !== release.path ||
		full.sha512 !== release.sha512 ||
		full.size !== release.files[0]?.size ||
		release.files[0]?.sha512 !== full.sha512 ||
		!/^[a-f0-9]{40}$/.test(full.commit) ||
		JSON.stringify(full.recoveryManifestVersions) !==
			JSON.stringify(release.recoveryManifestVersions)
	)
		throw new Error("Invalid frozen mirror binary identity; check for updates again");
	validateAsset(identity, full, MAX_RELEASE_BINARY_BYTES);
	validateAsset(identity, full.metadata, 64 * 1024);
	if (full.metadata.name !== `${full.name}.metadata.json`)
		throw new Error("Invalid mirror sidecar identity");
	return full;
}
export function validateMirrorPatchStep(
	release: ReleaseInfo,
	candidate: GithubPatchStep,
): MirrorPatchStep {
	validateMirrorFull(release);
	const identity = release.sourceIdentity as MirrorIdentity;
	const step = release._mirror?.patchChain?.find(
		(item) => JSON.stringify(item) === JSON.stringify(candidate),
	);
	if (
		!step ||
		step.metadata.url !== step.metaUrl ||
		step.metadata.name !== `${step.name}.meta.json`
	)
		throw new Error("Patch is not part of the frozen mirror selection");
	validateAsset(identity, { ...step, size: step.patchSize }, MAX_RELEASE_PATCH_BYTES);
	validateAsset(identity, step.metadata, 64 * 1024);
	return step;
}

/** The index and every byte descriptor are frozen to the selected mirror, never GitHub. */
export async function checkMirrorUpdate(
	identity: MirrorIdentity,
	currentVersion: string,
	transport: UpdateFetchContext,
	parent?: AbortSignal,
): Promise<UpdateCheckResult> {
	identity = Object.freeze({ ...identity });
	const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(parent ? [parent] : [])]);
	const budget: MetadataBudget = { remaining: MAX_CHECK_METADATA_BYTES };
	const base = mirrorBase(identity);
	const response = await fetchUpdateWithTimeout(`${base}/index`, {
		timeoutMs: 10_000,
		signal,
		transport,
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new GithubUpdateError(
			[404, 410].includes(response.status) ? "CANONICAL_MIRROR_REQUIRED" : "NETWORK_ERROR",
			"Independent update server requires canonical mirror API v3; upgrade the mirror",
		);
	}
	const index = parseUpdateIndex(await readCheckJson(response, budget), identity.repository);
	const result: UpdateCheckResult = {
		source: "update-server",
		repository: identity.repository,
		currentVersion,
		updateAvailable: false,
	};
	const target = index.releases.find(
		(release) => release.version === index.channels[identity.channel],
	);
	if (!target)
		return {
			...result,
			errorCode: "NO_RELEASE",
			error: "No published application releases in this channel",
		};
	result.latestVersion = target.version;
	if (compareReleaseVersions(target.version, currentVersion) <= 0) return result;
	const file = target.files.find((item) => item.platform === identity.platform);
	if (!file) throw new Error("Canonical update index does not contain this platform");
	const metadata = freezeAsset(identity, file.metadata);
	const raw = await readMirrorAsset(metadata.url, metadata, signal, transport, 64 * 1024, budget);
	const { recoveryManifestVersions } = validateGithubBinaryMetadata(
		JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
		{
			name: file.name,
			platform: identity.platform,
			version: target.version,
			size: file.size,
			indexed: { sha256: file.sha256, sha512: file.sha512, commit: target.commit },
		},
	);
	const release: ReleaseInfo = {
		source: "update-server",
		repository: identity.repository,
		sourceIdentity: identity,
		version: target.version,
		releaseDate: target.publishedAt,
		path: file.name,
		sha512: file.sha512,
		recoveryManifestVersions,
		files: [{ url: file.name, size: file.size, sha512: file.sha512 }],
		notesDeferred: true,
		notesAvailable: !!target.notes,
		_mirror: {
			serverUrl: identity.serverUrl,
			full: {
				...freezeAsset(identity, file),
				version: target.version,
				platform: identity.platform,
				commit: target.commit,
				sha512: file.sha512,
				metadata,
				recoveryManifestVersions: [...recoveryManifestVersions],
			},
		},
	};
	// Bound fan-out, metadata count and aggregate bytes independently of the index's own limits.
	const candidates = index.releases
		.filter(
			(item) =>
				compareReleaseVersions(item.version, currentVersion) > 0 &&
				compareReleaseVersions(item.version, target.version) <= 0,
		)
		.slice(0, 32);
	const steps: MirrorPatchStep[] = [];
	let next = 0;
	let metadataCount = 0;
	let metadataBytes = 0;
	const probe = async () => {
		for (;;) {
			signal.throwIfAborted();
			if (budget.remaining <= 0) return;
			const candidate = candidates[next++];
			if (!candidate) return;
			const binary = candidate.files.find((item) => item.platform === identity.platform);
			if (!binary) continue;
			try {
				const response = await fetchUpdateWithTimeout(
					`${base}/availability/${candidate.version}/${identity.platform}`,
					{ timeoutMs: 10_000, signal, transport },
				);
				if (!response.ok) {
					await response.body?.cancel().catch(() => {});
					continue;
				}
				const availability = parseMirrorAvailability(
					await readCheckJson(response, budget),
					identity.repository,
					candidate.version,
					identity.platform,
					index,
				);
				const available = (asset: UpdateIndexAsset) =>
					availability.assets.some(
						(item) =>
							item.name === asset.name && item.size === asset.size && item.sha256 === asset.sha256,
					);
				for (const patch of binary.patches) {
					signal.throwIfAborted();
					if (
						compareReleaseVersions(patch.fromVersion, currentVersion) < 0 ||
						patch.size >= file.size ||
						!available(patch) ||
						!available(patch.metadata)
					)
						continue;
					if (
						metadataCount >= 32 ||
						metadataBytes + patch.metadata.size > 1024 * 1024 ||
						patch.metadata.size > budget.remaining
					)
						break;
					metadataCount++;
					metadataBytes += patch.metadata.size;
					try {
						const metadata = freezeAsset(identity, patch.metadata);
						const bytes = await readMirrorAsset(
							metadata.url,
							metadata,
							signal,
							transport,
							64 * 1024,
							budget,
						);
						const meta = validateReleasePatchMetadata(
							JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
							{
								fromVersion: patch.fromVersion,
								toVersion: candidate.version,
								patchSize: patch.size,
								newFileSize: binary.size,
								newFileSha512: binary.sha512,
							},
						);
						steps.push({
							name: patch.name,
							fromVersion: patch.fromVersion,
							toVersion: candidate.version,
							patchSize: patch.size,
							url: freezeAsset(identity, patch).url,
							metaUrl: metadata.url,
							sha256: patch.sha256,
							metadata,
							meta,
						});
					} catch {
						signal.throwIfAborted();
					}
				}
			} catch {
				signal.throwIfAborted();
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, probe));
	signal.throwIfAborted();
	const chain = planGithubReleasePatches({
		currentVersion,
		targetVersion: target.version,
		targetSize: file.size,
		targetSha512: file.sha512,
		steps,
	});
	if (chain && release._mirror) release._mirror.patchChain = chain as MirrorPatchStep[];
	const patchSize = chain?.reduce((size, step) => size + step.patchSize, 0);
	return {
		...result,
		updateAvailable: true,
		releaseInfo: release,
		notesDeferred: true,
		notesAvailable: !!target.notes,
		strategy: patchSize ? "zstd" : "full",
		downloadSize: patchSize ?? file.size,
		totalSize: file.size,
		zstdPatchSize: patchSize,
		...(chain ? { patchChain: chain } : {}),
	};
}

async function readMirrorAsset(
	url: string,
	asset: UpdateIndexAsset,
	signal: AbortSignal,
	transport: UpdateFetchContext,
	maximumBytes = 64 * 1024,
	budget?: MetadataBudget,
): Promise<Uint8Array> {
	if (asset.size > maximumBytes) throw new Error("Mirror metadata exceeds size limit");
	const response = await fetchUpdateWithTimeout(url, { timeoutMs: 10_000, signal, transport });
	if (!response.ok || !response.body) {
		await response.body?.cancel().catch(() => {});
		throw new Error("Mirror metadata unavailable; upgrade or repair the mirror");
	}
	const reader = response.body.getReader();
	const data = new Uint8Array(asset.size);
	let size = 0;
	try {
		for (;;) {
			signal.throwIfAborted();
			const next = await reader.read();
			if (next.done) break;
			if (budget) consumeMetadata(budget, next.value.length);
			size += next.value.length;
			if (size > data.length) throw new Error("Mirror metadata exceeds announced size");
			data.set(next.value, size - next.value.length);
		}
		signal.throwIfAborted();
		if (size !== asset.size || createHash("sha256").update(data).digest("hex") !== asset.sha256)
			throw new Error("Mirror metadata size or digest mismatch");
		return data;
	} finally {
		await reader.cancel().catch(() => {});
	}
}

export async function getMirrorNotes(
	identity: MirrorIdentity,
	version: string,
	sha512: string,
	transport: UpdateFetchContext,
	parent?: AbortSignal,
) {
	identity = Object.freeze({ ...identity });
	const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(parent ? [parent] : [])]);
	const base = mirrorBase(identity);
	const response = await fetchUpdateWithTimeout(`${base}/index`, {
		timeoutMs: 10_000,
		signal,
		transport,
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new GithubUpdateError("NETWORK_ERROR", "Mirror notes catalog unavailable");
	}
	const index = parseUpdateIndex(
		await readUpdateJson(response, MAX_UPDATE_INDEX_BYTES),
		identity.repository,
	);
	const target = index.releases.find((item) => item.version === version);
	const file = target?.files.find((item) => item.platform === identity.platform);
	if (!file || file.sha512 !== sha512)
		throw new GithubUpdateError("UPDATE_ARTIFACT_CHANGED", "Selected mirror artifact changed");
	if (!target?.notes) return { notes: undefined };
	const descriptor = {
		name: target.notes.path,
		size: target.notes.size,
		sha256: target.notes.sha256,
	};
	const bytes = await readMirrorAsset(
		freezeAsset(identity, descriptor).url,
		descriptor,
		signal,
		transport,
		MAX_UPDATE_NOTES_BYTES,
	);
	const notes = parseUpdateNotes(
		JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
		identity.repository,
		version,
	);
	signal.throwIfAborted();
	return { notes: notes.notes };
}

async function downloadMirrorAsset(
	asset: MirrorAsset,
	path: string,
	options: { signal: AbortSignal; onProgress?: (bytes: number) => void },
	transport: UpdateFetchContext,
	sha512?: string,
): Promise<void> {
	let created = false;
	const response = await fetchUpdateWithTimeout(asset.url, {
		timeoutMs: 10 * 60_000,
		signal: options.signal,
		transport,
	});
	try {
		if (!response.ok || !response.body)
			throw new Error(
				`Mirror asset unavailable (${response.status}); upgrade or repair the mirror`,
			);
		const declared = response.headers.get("content-length");
		if (declared !== null && Number(declared) !== asset.size)
			throw new Error("Mirror asset Content-Length mismatch");
		const handle = await open(path, "wx", 0o600);
		created = true;
		const reader = response.body.getReader();
		let bytes = 0;
		let progressAt = 0;
		const hash = createHash("sha256");
		const binaryHash = sha512 ? createHash("sha512") : undefined;
		try {
			for (;;) {
				options.signal.throwIfAborted();
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.length;
				if (bytes > asset.size) throw new Error("Mirror asset exceeds announced size");
				hash.update(chunk.value);
				binaryHash?.update(chunk.value);
				let offset = 0;
				while (offset < chunk.value.length) {
					const { bytesWritten } = await handle.write(
						chunk.value,
						offset,
						chunk.value.length - offset,
					);
					if (!bytesWritten) throw new Error("Mirror asset write made no progress");
					offset += bytesWritten;
				}
				if (Date.now() - progressAt >= 100 || bytes === asset.size) {
					progressAt = Date.now();
					options.onProgress?.(bytes);
				}
			}
			options.signal.throwIfAborted();
			if (
				bytes !== asset.size ||
				hash.digest("hex") !== asset.sha256 ||
				(binaryHash && binaryHash.digest("base64") !== sha512)
			)
				throw new Error("Mirror asset size or checksum mismatch");
		} finally {
			await reader.cancel().catch(() => {});
			await handle.close();
		}
	} catch (error) {
		if (created) await unlink(path).catch(() => {});
		throw error;
	} finally {
		await response.body?.cancel().catch(() => {});
	}
}
export async function downloadMirrorBinary(
	release: ReleaseInfo,
	path: string,
	options: { signal: AbortSignal; onProgress?: (bytes: number) => void },
	transport: UpdateFetchContext,
): Promise<void> {
	const full = validateMirrorFull(release);
	await downloadMirrorAsset(full, path, options, transport, full.sha512);
}
export async function downloadMirrorPatch(
	release: ReleaseInfo,
	path: string,
	options: { signal: AbortSignal; onProgress?: (bytes: number) => void },
	transport: UpdateFetchContext,
	step: GithubPatchStep,
): Promise<void> {
	const patch = validateMirrorPatchStep(release, step);
	await downloadMirrorAsset({ ...patch, size: patch.patchSize }, path, options, transport);
}
