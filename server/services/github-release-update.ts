import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import {
	type GithubPatchStep,
	MAX_RELEASE_BINARY_BYTES,
	MAX_RELEASE_LEGACY_BYTES,
	MAX_RELEASE_PATCH_BYTES,
	MAX_RELEASE_PATCH_METADATA,
	parseReleasePatchName,
	validateReleasePatchMetadata,
} from "../../shared/release-patch";
import {
	compareReleaseVersions as compareSemanticVersions,
	isValidReleaseVersion as validSemver,
} from "../../shared/release-version";
import { parseUpdateSourceIdentity, type UpdateSourceIdentity } from "../../shared/update-identity";
import { parseUpdateIndex, parseUpdateNotes } from "../../shared/update-index";
import {
	MAX_UPDATE_INDEX_BYTES,
	MAX_UPDATE_NOTES_BYTES,
	UPDATE_INDEX_BRANCH,
	UPDATE_INDEX_FILE,
	type UpdateIndexAsset,
	type UpdateIndexV1,
} from "../../shared/update-index-types";
import { logger } from "../lib/logger";
import { isValidGitHubRepository } from "../lib/settings/update-source";
import { planGithubReleasePatches } from "./github-release-patch-planner";
import type { ReleaseInfo, UpdateCheckResult } from "./update-service";

const PLATFORM_SUFFIXES: Record<string, string> = {
	"darwin-arm64": "macos-arm64",
	"darwin-x64": "macos-x64",
	"linux-x64": "linux-x64",
	"linux-x64-baseline": "linux-x64-baseline",
	"linux-arm64": "linux-arm64",
	"win-x64": "windows-x64.exe",
	"win-x64-baseline": "windows-x64-baseline.exe",
	"win-arm64": "windows-arm64.exe",
};
const MAX_BINARY_BYTES = MAX_RELEASE_BINARY_BYTES;
const CACHE_MS = 5 * 60_000;
const MAX_PAGES = 5;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_JSON_BYTES = 10 * 1024 * 1024;
const SHA512_RE = /^[A-Za-z0-9+/]{86}==$/;
const ASSET_HOSTS = new Set([
	"github.com",
	"release-assets.githubusercontent.com",
	"objects.githubusercontent.com",
	"github-releases.githubusercontent.com",
]);

export type GithubFetch = (url: string, init?: RequestInit) => Promise<Response>;
export class GithubUpdateError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly retryAfter?: number,
	) {
		super(message);
	}
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		if (signal.aborted) {
			// The operation may already have started (e.g. body.cancel on a locked stream).
			// Observe its eventual rejection even when the deadline wins immediately.
			void promise.catch(() => {});
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isGithubUpdateRepository(repository: string): boolean {
	return isValidGitHubRepository(repository);
}

export function compareReleaseVersions(a: string, b: string): number {
	try {
		return compareSemanticVersions(a, b);
	} catch {
		throw new GithubUpdateError("INVALID_METADATA", "Invalid release version");
	}
}

export function validateGithubAssetUrl(
	url: string,
	repository: string,
	version: string,
	filename: string,
): void {
	if (
		!isGithubUpdateRepository(repository) ||
		!validSemver(version) ||
		!filename ||
		filename === "." ||
		filename === ".." ||
		/[/\\\0]/.test(filename)
	) {
		throw new GithubUpdateError("INVALID_METADATA", "Invalid GitHub release identity");
	}
	try {
		const parsed = new URL(url);
		// Compare decoded path components so valid CI tags containing '+' work with either
		// browser URL spelling, without allowing encoded slashes or extra path components.
		const parts = parsed.pathname.split("/").map((part) => decodeURIComponent(part));
		const [owner, repo] = repository.split("/");
		if (
			parsed.origin !== "https://github.com" ||
			parsed.username ||
			parsed.password ||
			parsed.search ||
			parsed.hash ||
			parts.length !== 7 ||
			parts[0] !== "" ||
			parts[1]?.toLowerCase() !== owner.toLowerCase() ||
			parts[2]?.toLowerCase() !== repo.toLowerCase() ||
			parts[3] !== "releases" ||
			parts[4] !== "download" ||
			parts[5] !== `v${version}` ||
			parts[6] !== filename
		) {
			throw new Error("Release asset identity mismatch");
		}
	} catch {
		throw new GithubUpdateError(
			"INVALID_METADATA",
			"Asset URL does not match the selected GitHub release",
		);
	}
}

/** Asset responses retain the caller's deadline throughout body consumption, not just headers. */
export async function fetchGithubAsset(
	url: string,
	signal: AbortSignal,
	fetcher: GithubFetch = (input, init) => fetch(input, init),
): Promise<Response> {
	let current = url;
	for (let redirects = 0; redirects <= 5; redirects++) {
		const parsed = new URL(current);
		if (
			parsed.protocol !== "https:" ||
			!ASSET_HOSTS.has(parsed.hostname) ||
			parsed.port ||
			parsed.username ||
			parsed.password
		) {
			throw new GithubUpdateError("INVALID_METADATA", "Untrusted GitHub asset redirect");
		}
		const response = await abortable(fetcher(current, { redirect: "manual", signal }), signal);
		if (![301, 302, 303, 307, 308].includes(response.status)) return response;
		await abortable(response.body?.cancel() ?? Promise.resolve(), signal);
		const location = response.headers.get("location");
		if (!location || redirects === 5) {
			throw new GithubUpdateError("NETWORK_ERROR", "GitHub asset redirect limit exceeded");
		}
		current = new URL(location, current).href;
	}
	throw new GithubUpdateError("NETWORK_ERROR", "GitHub asset redirect limit exceeded");
}

async function readBoundedJson(
	response: Response,
	maxBytes: number,
	signal: AbortSignal,
	consumeBytes?: (bytes: number) => void,
): Promise<{ value: unknown; bytes: number; sha256: string }> {
	if (!response.body) throw new GithubUpdateError("INVALID_METADATA", "Missing metadata body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		const declared = Number(response.headers.get("content-length") ?? 0);
		if (declared > maxBytes)
			throw new GithubUpdateError("INVALID_METADATA", "Metadata exceeds byte limit");
		while (true) {
			const { done, value } = await abortable(reader.read(), signal);
			if (done) break;
			bytes += value.byteLength;
			consumeBytes?.(value.byteLength);
			if (bytes > maxBytes)
				throw new GithubUpdateError("INVALID_METADATA", "Metadata exceeds byte limit");
			chunks.push(value);
		}
		try {
			const raw = Buffer.concat(chunks, bytes);
			return {
				value: JSON.parse(raw.toString("utf8")),
				bytes,
				sha256: createHash("sha256").update(raw).digest("hex"),
			};
		} catch {
			throw new GithubUpdateError("INVALID_METADATA", "Invalid metadata JSON");
		}
	} finally {
		await abortable(reader.cancel(), signal).catch(() => {});
	}
}

interface Asset {
	name: string;
	size: number;
	url: string;
	sha256?: string;
}
interface Candidate {
	version: string;
	binary: Asset;
	metadata: Asset;
	releaseDate: string;
	releaseNotes?: string;
}
interface CheckInput {
	repository: string;
	channel: "stable" | "beta";
	platform: string;
	currentVersion: string;
}

function parseAsset(value: unknown, verifyDigest = false): Asset | null {
	if (
		!isRecord(value) ||
		value.state !== "uploaded" ||
		typeof value.name !== "string" ||
		typeof value.browser_download_url !== "string" ||
		typeof value.size !== "number" ||
		!Number.isSafeInteger(value.size) ||
		value.size <= 0
	)
		return null;
	const digest = value.digest;
	// Absent digests are compatible with older GitHub releases; malformed digests are not trusted.
	const validDigest = typeof digest === "string" && /^sha256:[a-f0-9]{64}$/.test(digest);
	if (verifyDigest && digest !== undefined && digest !== null && !validDigest) return null;
	return {
		name: value.name,
		size: value.size,
		url: value.browser_download_url,
		sha256: validDigest ? digest.slice(7) : undefined,
	};
}

function selectCandidate(releases: unknown[], input: CheckInput): Candidate | undefined {
	const suffix = PLATFORM_SUFFIXES[input.platform];
	if (!suffix) throw new GithubUpdateError("PLATFORM_UNAVAILABLE", "Unsupported update platform");
	let eligibleReleases = 0;
	const candidates: Array<{ version: string; release: Record<string, unknown>; name: string }> = [];
	for (const release of releases) {
		if (
			!isRecord(release) ||
			release.draft !== false ||
			typeof release.prerelease !== "boolean" ||
			typeof release.tag_name !== "string" ||
			!release.tag_name.startsWith("v")
		)
			continue;
		const version = release.tag_name.slice(1);
		if (!validSemver(version) || (input.channel === "stable" && release.prerelease)) continue;
		eligibleReleases++;
		if (!Array.isArray(release.assets) || release.assets.length > 200) {
			throw new GithubUpdateError("INVALID_METADATA", "Invalid release assets");
		}
		const name = `narrafork-${version}-${suffix}`;
		if (release.assets.some((asset) => isRecord(asset) && asset.name === name)) {
			candidates.push({ version, release, name });
		}
	}
	candidates.sort((a, b) => compareReleaseVersions(b.version, a.version));
	const selected = candidates[0];
	if (!selected) {
		if (eligibleReleases)
			throw new GithubUpdateError("PLATFORM_UNAVAILABLE", "No release asset for this platform");
		return undefined;
	}
	const { release, version, name } = selected;
	const assets = release.assets as unknown[];
	const binaries = assets.filter((asset) => isRecord(asset) && asset.name === name);
	const sidecars = assets.filter(
		(asset) => isRecord(asset) && asset.name === `${name}.metadata.json`,
	);
	if (binaries.length !== 1 || sidecars.length !== 1) {
		throw new GithubUpdateError("INVALID_METADATA", "Release is missing unique platform metadata");
	}
	const binary = parseAsset(binaries[0]);
	const metadata = parseAsset(sidecars[0]);
	if (!binary || !metadata || binary.size > MAX_BINARY_BYTES || metadata.size > 64 * 1024) {
		throw new GithubUpdateError("INVALID_METADATA", "Invalid release asset size or state");
	}
	validateGithubAssetUrl(binary.url, input.repository, version, name);
	validateGithubAssetUrl(metadata.url, input.repository, version, metadata.name);
	if (
		typeof release.published_at !== "string" ||
		!Number.isFinite(Date.parse(release.published_at))
	) {
		throw new GithubUpdateError("INVALID_METADATA", "Invalid release date");
	}
	return {
		version,
		binary,
		metadata,
		releaseDate: release.published_at,
		releaseNotes: typeof release.body === "string" ? release.body.slice(0, 128 * 1024) : undefined,
	};
}

interface PatchCandidate {
	version: string;
	binary: Asset;
	patch: Asset;
	metadata: Asset;
	fromVersion?: string;
}

/** Only published app releases for the exact platform participate; beta intermediates are allowed. */
function discoverPatchAssets(
	releases: unknown[],
	input: CheckInput,
	targetVersion: string,
): PatchCandidate[] {
	const candidates: PatchCandidate[] = [];
	let ignored = 0;
	for (const release of releases) {
		if (
			!isRecord(release) ||
			release.draft !== false ||
			typeof release.prerelease !== "boolean" ||
			typeof release.tag_name !== "string" ||
			!release.tag_name.startsWith("v") ||
			!Array.isArray(release.assets) ||
			release.assets.length > 200
		)
			continue;
		const version = release.tag_name.slice(1);
		if (
			!validSemver(version) ||
			compareReleaseVersions(version, input.currentVersion) <= 0 ||
			compareReleaseVersions(version, targetVersion) > 0
		)
			continue;
		const byName = new Map<string, unknown[]>();
		for (const asset of release.assets) {
			if (!isRecord(asset) || typeof asset.name !== "string") continue;
			const group = byName.get(asset.name);
			if (group) group.push(asset);
			else byName.set(asset.name, [asset]);
		}
		const binaryName = `narrafork-${version}-${PLATFORM_SUFFIXES[input.platform]}`;
		const binaries = byName.get(binaryName) ?? [];
		const binary = binaries.length === 1 ? parseAsset(binaries[0]) : null;
		if (!binary || binary.size > MAX_BINARY_BYTES) continue;
		try {
			validateGithubAssetUrl(binary.url, input.repository, version, binaryName);
		} catch {
			continue;
		}
		for (const [name, matching] of byName) {
			const hint = parseReleasePatchName(binaryName, name);
			if (!hint) continue;
			try {
				const sidecars = byName.get(`${name}.meta.json`) ?? [];
				const patch = parseAsset(matching[0], true);
				const metadata = sidecars.length === 1 ? parseAsset(sidecars[0]) : null;
				if (
					matching.length !== 1 ||
					!patch ||
					!metadata ||
					patch.size > MAX_RELEASE_PATCH_BYTES ||
					metadata.size > 64 * 1024
				)
					throw new Error("Missing or invalid optional patch asset pair");
				validateGithubAssetUrl(patch.url, input.repository, version, patch.name);
				validateGithubAssetUrl(metadata.url, input.repository, version, metadata.name);
				candidates.push({ version, binary, patch, metadata, ...hint });
			} catch (error) {
				// Release lists are bounded, but synchronous log writes must also remain bounded.
				if (++ignored <= 8)
					logger.warn("Ignoring optional GitHub patch asset", { version, error: String(error) });
			}
		}
	}
	if (ignored > 8)
		logger.warn("Additional invalid GitHub patch assets ignored", { count: ignored - 8 });
	const priority = (candidate: PatchCandidate) =>
		candidate.version === targetVersion
			? candidate.fromVersion === input.currentVersion
				? 0
				: candidate.fromVersion === undefined
					? 1
					: 2
			: 3;
	return candidates
		.sort(
			(a, b) =>
				priority(a) - priority(b) ||
				compareReleaseVersions(b.version, a.version) ||
				(a.patch.name < b.patch.name ? -1 : a.patch.name > b.patch.name ? 1 : 0),
		)
		.slice(0, MAX_RELEASE_PATCH_METADATA);
}

/** Construct release URLs locally; the public index never supplies arbitrary URLs. */
function indexReleases(index: UpdateIndexV1, platform: string, repository: string): unknown[] {
	return index.releases.map((release) => {
		const asset = (item: UpdateIndexAsset) => ({
			name: item.name,
			size: item.size,
			digest: `sha256:${item.sha256}`,
			state: "uploaded",
			browser_download_url: `https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(item.name)}`,
		});
		const file = release.files.find((item) => item.platform === platform);
		return {
			tag_name: release.tag,
			draft: false,
			prerelease: release.prerelease,
			published_at: release.publishedAt,
			assets: file
				? [
						asset(file),
						asset(file.metadata),
						...file.patches.flatMap((patch) => [asset(patch), asset(patch.metadata)]),
					]
				: [],
		};
	});
}

export interface UpdateNotesRequest {
	version: string;
	sha512: string;
	sourceIdentity: UpdateSourceIdentity;
}

/** Instance-scoped bounded caches; production shares one instance across all administrators. */
export class GithubReleaseUpdater {
	private readonly checks = new Map<string, { until: number; result: UpdateCheckResult }>();
	private readonly inFlight = new Map<string, Promise<UpdateCheckResult>>();
	private readonly jsonCache = new Map<
		string,
		{ etag: string; value: unknown; bytes: number; next: boolean }
	>();
	// Four validated catalogs occupy at most 1 MiB; no caller receives mutable cached objects.
	private readonly indexCache = new Map<
		string,
		{ etag: string; index: UpdateIndexV1; bytes: number }
	>();
	private cooldownUntil = 0;
	private generation = 0;
	private readonly latestGenerations = new Map<string, number>();

	constructor(
		private readonly fetcher: GithubFetch = (url, init) => fetch(url, init),
		private readonly now: () => number = Date.now,
		private readonly budgets: {
			requestTimeoutMs?: number;
			checkTimeoutMs?: number;
			patchTimeoutMs?: number;
		} = {},
	) {}

	check(
		input: CheckInput,
		options: { force?: boolean; signal?: AbortSignal } = {},
	): Promise<UpdateCheckResult> {
		// A cancellable caller cannot own (or cancel) another administrator's shared check.
		if (options.signal) return this.performCheck(input, options.signal);
		const key = JSON.stringify([
			input.repository.toLowerCase(),
			input.channel,
			input.platform,
			input.currentVersion,
		]);
		const cached = this.checks.get(key);
		if (!options.force && cached && cached.until > this.now())
			return Promise.resolve(cached.result);
		const active = this.inFlight.get(`${key}:${options.force === true}`);
		if (active) return active;
		const flightKey = `${key}:${options.force === true}`;
		const generation = ++this.generation;
		if (this.latestGenerations.size >= 32)
			this.latestGenerations.delete(this.latestGenerations.keys().next().value ?? "");
		this.latestGenerations.set(key, generation);
		const result = this.performCheck(input)
			.then((value) => {
				// A slower pre-download check must not overwrite a newer forced result.
				if (this.latestGenerations.get(key) !== generation) return value;
				if (this.checks.size >= 32) this.checks.delete(this.checks.keys().next().value ?? "");
				this.checks.set(key, {
					until: this.now() + (value.errorCode ? 30_000 : CACHE_MS),
					result: value,
				});
				return value;
			})
			.finally(() => this.inFlight.delete(flightKey));
		this.inFlight.set(flightKey, result);
		return result;
	}

	private async fetchRaw(
		repository: string,
		path: string,
		signal: AbortSignal,
		etag?: string,
	): Promise<Response> {
		if (!isGithubUpdateRepository(repository))
			throw new GithubUpdateError("INVALID_CONFIGURATION", "Invalid GitHub repository");
		const url = `https://raw.githubusercontent.com/${repository}/${UPDATE_INDEX_BRANCH}/${path}`;
		// No token and no redirects: even another raw repository is a different authority.
		const response = await abortable(
			this.fetcher(url, {
				signal,
				redirect: "error",
				headers: etag ? { "If-None-Match": etag } : {},
			}),
			signal,
		);
		if (response.redirected || (response.url && response.url !== url)) {
			await abortable(response.body?.cancel() ?? Promise.resolve(), signal).catch(() => {});
			throw new GithubUpdateError("INVALID_METADATA", "Untrusted metadata redirect");
		}
		return response;
	}

	private async readIndex(
		repository: string,
		deadline: AbortSignal,
	): Promise<{ index: UpdateIndexV1; bytes: number } | null> {
		const key = repository.toLowerCase();
		const cached = this.indexCache.get(key);
		const signal = AbortSignal.any([
			deadline,
			AbortSignal.timeout(this.budgets.requestTimeoutMs ?? 10_000),
		]);
		const response = await this.fetchRaw(repository, UPDATE_INDEX_FILE, signal, cached?.etag);
		try {
			if (response.status === 404) {
				this.indexCache.delete(key);
				return null;
			}
			this.checkResponse(response);
			if (response.status === 304) {
				if (
					!cached ||
					(response.headers.has("etag") && response.headers.get("etag") !== cached.etag)
				)
					throw new GithubUpdateError("INVALID_METADATA", "Unexpected index 304 response");
				return { index: structuredClone(cached.index), bytes: cached.bytes };
			}
			const json = await readBoundedJson(response, MAX_UPDATE_INDEX_BYTES, signal);
			let index: UpdateIndexV1;
			try {
				index = parseUpdateIndex(json.value, repository);
			} catch {
				throw new GithubUpdateError("INVALID_METADATA", "Invalid GitHub update index");
			}
			const etag = response.headers.get("etag");
			this.indexCache.delete(key);
			if (etag && etag.length <= 1024) {
				if (this.indexCache.size >= 4)
					this.indexCache.delete(this.indexCache.keys().next().value ?? "");
				this.indexCache.set(key, { index: structuredClone(index), bytes: json.bytes, etag });
			}
			return { index, bytes: json.bytes };
		} finally {
			await abortable(response.body?.cancel() ?? Promise.resolve(), signal).catch(() => {});
		}
	}

	async getNotes(
		request: UpdateNotesRequest,
		cancellation?: AbortSignal,
	): Promise<{ notes: string | Record<string, string> | null }> {
		const identity = parseUpdateSourceIdentity(request.sourceIdentity);
		if (
			identity?.source !== "github" ||
			!validSemver(request.version) ||
			!SHA512_RE.test(request.sha512)
		)
			throw new GithubUpdateError("INVALID_METADATA", "Invalid release notes identity");
		const signal = AbortSignal.any([
			AbortSignal.timeout(this.budgets.requestTimeoutMs ?? 10_000),
			...(cancellation ? [cancellation] : []),
		]);
		const data = await this.readIndex(identity.repository, signal);
		const release = data?.index.releases.find((item) => item.version === request.version);
		const binary = release?.files.find((item) => item.platform === identity.platform);
		if (
			!release ||
			!binary ||
			binary.sha512 !== request.sha512 ||
			(identity.channel === "stable" && release.prerelease)
		)
			throw new GithubUpdateError(
				"UPDATE_ARTIFACT_CHANGED",
				"Release notes artifact is no longer available",
			);
		if (!release.notes) return { notes: null };
		const descriptor = release.notes;
		const response = await this.fetchRaw(identity.repository, descriptor.path, signal);
		try {
			this.checkResponse(response);
			const json = await readBoundedJson(response, MAX_UPDATE_NOTES_BYTES, signal);
			if (json.bytes !== descriptor.size || json.sha256 !== descriptor.sha256)
				throw new GithubUpdateError("INVALID_METADATA", "Release notes checksum mismatch");
			try {
				return { notes: parseUpdateNotes(json.value, identity.repository, request.version).notes };
			} catch {
				throw new GithubUpdateError("INVALID_METADATA", "Invalid release notes document");
			}
		} finally {
			await abortable(response.body?.cancel() ?? Promise.resolve(), signal).catch(() => {});
		}
	}

	private checkResponse(response: Response): void {
		if (response.ok || response.status === 304) return;
		if (response.status === 403 || response.status === 429) {
			const retry = Number(response.headers.get("retry-after") ?? 0);
			const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0);
			const limited =
				response.status === 429 ||
				retry > 0 ||
				response.headers.get("x-ratelimit-remaining") === "0";
			if (limited) {
				const seconds = Math.min(
					86400,
					Math.max(
						60,
						Number.isFinite(retry) ? retry : 0,
						response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset)
							? Math.ceil(reset - this.now() / 1000)
							: 0,
					),
				);
				this.cooldownUntil = this.now() + seconds * 1000;
				throw new GithubUpdateError(
					"RATE_LIMITED",
					"GitHub update requests are rate limited",
					seconds,
				);
			}
		}
		if (response.status === 404 || response.status === 403 || response.status === 401) {
			throw new GithubUpdateError(
				"REPOSITORY_UNAVAILABLE",
				"GitHub repository or asset is not publicly accessible",
			);
		}
		throw new GithubUpdateError("NETWORK_ERROR", `GitHub returned HTTP ${response.status}`);
	}

	private async probePatches(
		releases: unknown[],
		input: CheckInput,
		candidate: Candidate,
		sha512: string,
		deadline: AbortSignal,
		usedBytes: number,
		index?: UpdateIndexV1,
	): Promise<GithubPatchStep[] | undefined> {
		const controller = new AbortController();
		const signal = AbortSignal.any([
			deadline,
			controller.signal,
			AbortSignal.timeout(Math.min(8_000, this.budgets.patchTimeoutMs ?? 8_000)),
		]);
		const steps: GithubPatchStep[] = [];
		try {
			const candidates = discoverPatchAssets(releases, input, candidate.version);
			let next = 0;
			const consumeBytes = (bytes: number) => {
				usedBytes += bytes;
				if (usedBytes > MAX_TOTAL_JSON_BYTES) {
					controller.abort(new Error("Shared GitHub metadata budget exceeded"));
					throw signal.reason;
				}
			};
			const worker = async () => {
				while (next < candidates.length && !signal.aborted) {
					const item = candidates[next++];
					if (!item || usedBytes + item.metadata.size > MAX_TOTAL_JSON_BYTES) continue;
					let response: Response | undefined;
					try {
						response = await fetchGithubAsset(item.metadata.url, signal, this.fetcher);
						this.checkResponse(response);
						const json = await readBoundedJson(response, 64 * 1024, signal, consumeBytes);
						if (
							json.bytes !== item.metadata.size ||
							(item.metadata.sha256 && item.metadata.sha256 !== json.sha256)
						)
							throw new Error("Patch sidecar size or checksum mismatch");
						const indexedBinary = index?.releases
							.find((release) => release.version === item.version)
							?.files.find((file) => file.platform === input.platform);
						const indexedPatch = indexedBinary?.patches.find(
							(patch) => patch.name === item.patch.name,
						);
						const meta = validateReleasePatchMetadata(json.value, {
							fromVersion: indexedPatch?.fromVersion ?? item.fromVersion,
							toVersion: item.version,
							patchSize: item.patch.size,
							newFileSize: item.binary.size,
							newFileSha512:
								indexedBinary?.sha512 ?? (item.version === candidate.version ? sha512 : undefined),
						});
						if (
							meta.mode !== "patch-from" &&
							Math.max(meta.oldFileSize, meta.newFileSize, meta.patchSize) >
								MAX_RELEASE_LEGACY_BYTES
						)
							throw new Error("Legacy dictionary patch exceeds executable size limit");
						steps.push({
							fromVersion: meta.fromVersion,
							toVersion: meta.toVersion,
							patchSize: meta.patchSize,
							url: item.patch.url,
							metaUrl: item.metadata.url,
							sha256: item.patch.sha256,
							meta,
						});
					} catch (error) {
						logger.warn("Ignoring optional GitHub patch metadata", {
							version: item.version,
							error: String(error),
						});
					} finally {
						await abortable(response?.body?.cancel() ?? Promise.resolve(), signal).catch(() => {});
					}
				}
			};
			await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
			return planGithubReleasePatches({
				currentVersion: input.currentVersion,
				targetVersion: candidate.version,
				targetSize: candidate.binary.size,
				targetSha512: sha512,
				steps,
			});
		} catch (error) {
			logger.warn("GitHub patch discovery failed; retaining verified full update", {
				error: String(error),
			});
			return undefined;
		} finally {
			controller.abort();
		}
	}

	private async performCheck(
		input: CheckInput,
		cancellation?: AbortSignal,
	): Promise<UpdateCheckResult> {
		const base: UpdateCheckResult = {
			updateAvailable: false,
			currentVersion: input.currentVersion,
			source: "github",
			repository: input.repository,
		};
		const deadline = AbortSignal.any([
			AbortSignal.timeout(this.budgets.checkTimeoutMs ?? 30_000),
			...(cancellation ? [cancellation] : []),
		]);
		try {
			deadline.throwIfAborted();
			if (!isGithubUpdateRepository(input.repository))
				throw new GithubUpdateError("INVALID_CONFIGURATION", "Invalid GitHub repository");
			if (this.cooldownUntil > this.now())
				throw new GithubUpdateError(
					"RATE_LIMITED",
					"GitHub update requests are cooling down",
					Math.ceil((this.cooldownUntil - this.now()) / 1000),
				);
			const catalog = await this.readIndex(input.repository, deadline);
			const index = catalog?.index;
			const releases: unknown[] = index
				? indexReleases(index, input.platform, input.repository)
				: [];
			let totalBytes = catalog?.bytes ?? 0;
			for (let page = 1; !index && page <= MAX_PAGES; page++) {
				const url = `https://api.github.com/repos/${input.repository}/releases?per_page=100&page=${page}`;
				const cached = this.jsonCache.get(url);
				const signal = AbortSignal.any([
					deadline,
					AbortSignal.timeout(this.budgets.requestTimeoutMs ?? 10_000),
				]);
				const response = await abortable(
					this.fetcher(url, {
						signal,
						redirect: "error",
						headers: {
							Accept: "application/vnd.github+json",
							"X-GitHub-Api-Version": "2022-11-28",
							...(cached ? { "If-None-Match": cached.etag } : {}),
						},
					}),
					signal,
				);
				let data: { value: unknown; bytes: number; next: boolean };
				try {
					this.checkResponse(response);
					if (response.status === 304) {
						if (!cached) throw new GithubUpdateError("INVALID_METADATA", "Unexpected 304 response");
						data = cached;
					} else {
						data = {
							...(await readBoundedJson(response, MAX_JSON_BYTES, signal)),
							next: /rel="next"/.test(response.headers.get("link") ?? ""),
						};
						const etag = response.headers.get("etag");
						if (etag) {
							if (this.jsonCache.size >= 5)
								this.jsonCache.delete(this.jsonCache.keys().next().value ?? "");
							this.jsonCache.set(url, { ...data, etag });
						}
					}
				} finally {
					await response.body?.cancel().catch(() => {});
				}
				totalBytes += data.bytes;
				if (
					totalBytes > MAX_TOTAL_JSON_BYTES ||
					!Array.isArray(data.value) ||
					data.value.length > 100
				)
					throw new GithubUpdateError("INVALID_METADATA", "Invalid or oversized release list");
				releases.push(...data.value);
				if (!data.next) break;
				if (page === MAX_PAGES)
					throw new GithubUpdateError("SCAN_LIMIT_REACHED", "GitHub release scan limit reached");
			}
			const indexedRelease = index?.releases.find(
				(release) => release.version === index.channels[input.channel],
			);
			const indexedBinary = indexedRelease?.files.find((file) => file.platform === input.platform);
			const candidate = selectCandidate(
				index
					? releases.filter(
							(release) => isRecord(release) && release.tag_name === indexedRelease?.tag,
						)
					: releases,
				input,
			);
			if (!candidate)
				return {
					...base,
					errorCode: "NO_RELEASE",
					error: "No published application releases in this channel",
				};
			if (compareReleaseVersions(candidate.version, input.currentVersion) <= 0)
				return { ...base, latestVersion: candidate.version };
			const metadataSignal = AbortSignal.any([
				deadline,
				AbortSignal.timeout(this.budgets.requestTimeoutMs ?? 10_000),
			]);
			const response = await fetchGithubAsset(candidate.metadata.url, metadataSignal, this.fetcher);
			let metadata: unknown;
			try {
				this.checkResponse(response);
				const json = await readBoundedJson(response, 64 * 1024, metadataSignal);
				if (
					json.bytes !== candidate.metadata.size ||
					(indexedBinary && json.sha256 !== indexedBinary.metadata.sha256) ||
					totalBytes + json.bytes > MAX_TOTAL_JSON_BYTES
				) {
					throw new GithubUpdateError(
						"INVALID_METADATA",
						"Sidecar size mismatch or metadata budget exceeded",
					);
				}
				totalBytes += json.bytes;
				metadata = json.value;
			} finally {
				await response.body?.cancel().catch(() => {});
			}
			if (
				!isRecord(metadata) ||
				metadata.name !== candidate.binary.name ||
				metadata.platform !== input.platform ||
				metadata.version !== candidate.version ||
				metadata.size !== candidate.binary.size ||
				typeof metadata.sha512 !== "string" ||
				!SHA512_RE.test(metadata.sha512) ||
				typeof metadata.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(metadata.sha256) ||
				(indexedBinary &&
					(metadata.sha256 !== indexedBinary.sha256 ||
						metadata.sha512 !== indexedBinary.sha512 ||
						typeof metadata.commit !== "string" ||
						!/^[a-f0-9]{7,40}$/.test(metadata.commit) ||
						!indexedRelease?.commit.startsWith(metadata.commit)))
			) {
				throw new GithubUpdateError(
					"INVALID_METADATA",
					"GitHub binary metadata identity or checksum is invalid",
				);
			}
			const patchChain = await this.probePatches(
				releases,
				input,
				candidate,
				metadata.sha512,
				deadline,
				totalBytes,
				index,
			);
			deadline.throwIfAborted();
			return {
				...base,
				updateAvailable: true,
				latestVersion: candidate.version,
				notesDeferred: !!index,
				notesAvailable: !!indexedRelease?.notes,
				strategy: patchChain ? "zstd" : "full",
				downloadSize: patchChain
					? patchChain.reduce((bytes, step) => bytes + step.patchSize, 0)
					: candidate.binary.size,
				...(patchChain
					? {
							patchChain,
							zstdPatchSize: patchChain.length === 1 ? patchChain[0]?.patchSize : undefined,
						}
					: {}),
				totalSize: candidate.binary.size,
				releaseInfo: {
					source: "github",
					repository: input.repository,
					version: candidate.version,
					releaseDate: candidate.releaseDate,
					releaseNotes: candidate.releaseNotes,
					notesDeferred: !!index,
					notesAvailable: !!indexedRelease?.notes,
					path: candidate.binary.name,
					sha512: metadata.sha512,
					files: [
						{ url: candidate.binary.name, size: candidate.binary.size, sha512: metadata.sha512 },
					],
					_github: {
						downloadUrl: candidate.binary.url,
						repository: input.repository,
						...(patchChain ? { patchChain } : {}),
					},
				},
			};
		} catch (error) {
			const updateError =
				error instanceof GithubUpdateError
					? error
					: new GithubUpdateError(
							cancellation?.aborted
								? "CANCELLED"
								: deadline.aborted ||
										(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
									? "TIMEOUT"
									: "NETWORK_ERROR",
							"GitHub update check failed",
						);
			return {
				...base,
				error: updateError.message,
				errorCode: updateError.code,
				retryAfter: updateError.retryAfter,
			};
		}
	}
}

/** Full binary downloads are streamed and hashed under one lifetime deadline. */
export async function downloadGithubBinaryToFile(
	release: ReleaseInfo,
	path: string,
	options: {
		signal?: AbortSignal;
		onProgress?: (bytes: number) => void | Promise<void>;
		timeoutMs?: number;
		fetcher?: GithubFetch;
	} = {},
): Promise<void> {
	const github = release._github;
	const size = release.files[0]?.size ?? 0;
	if (
		!github ||
		release.source !== "github" ||
		size <= 0 ||
		!Number.isSafeInteger(size) ||
		size > MAX_BINARY_BYTES ||
		!SHA512_RE.test(release.sha512)
	) {
		throw new GithubUpdateError("INVALID_METADATA", "Invalid full download descriptor");
	}
	validateGithubAssetUrl(github.downloadUrl, github.repository, release.version, release.path);
	const signal = AbortSignal.any([
		AbortSignal.timeout(options.timeoutMs ?? 15 * 60_000),
		...(options.signal ? [options.signal] : []),
	]);
	let response: Response | undefined;
	let created = false;
	try {
		signal.throwIfAborted();
		response = await fetchGithubAsset(github.downloadUrl, signal, options.fetcher);
		if (!response.ok || !response.body)
			throw new GithubUpdateError(
				"NETWORK_ERROR",
				`GitHub binary download failed (HTTP ${response.status})`,
			);
		const declared = response.headers.get("content-length");
		if (declared !== null && Number(declared) !== size)
			throw new GithubUpdateError("INVALID_METADATA", "Binary Content-Length mismatch");
		const handle = await open(path, "wx");
		created = true;
		const reader = response.body.getReader();
		let bytes = 0;
		let lastProgressAt = 0;
		const hash = createHash("sha512");
		try {
			while (true) {
				signal.throwIfAborted();
				const { done, value } = await abortable(reader.read(), signal);
				if (done) break;
				bytes += value.byteLength;
				if (bytes > size)
					throw new GithubUpdateError("INVALID_METADATA", "Binary exceeds declared size");
				hash.update(value);
				let offset = 0;
				while (offset < value.byteLength) {
					const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
					if (!bytesWritten) throw new Error("Binary write made no progress");
					offset += bytesWritten;
				}
				if (Date.now() - lastProgressAt >= 100 || bytes === size) {
					lastProgressAt = Date.now();
					await options.onProgress?.(bytes);
				}
			}
			signal.throwIfAborted();
			if (bytes !== size || hash.digest("base64") !== release.sha512)
				throw new GithubUpdateError("INVALID_METADATA", "Binary size or SHA512 mismatch");
		} finally {
			await abortable(reader.cancel(), signal).catch(() => {});
			await handle.close();
		}
	} catch (error) {
		if (created) await unlink(path).catch(() => {});
		throw error;
	} finally {
		await abortable(response?.body?.cancel() ?? Promise.resolve(), signal).catch(() => {});
	}
}

/** Resolve only the exact release patch namespace; a generic github.com URL is insufficient. */
function validatePatchDescriptor(step: GithubPatchStep): void {
	validateReleasePatchMetadata(step.meta, {
		fromVersion: step.fromVersion,
		toVersion: step.toVersion,
		patchSize: step.patchSize,
	});
	if (step.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(step.sha256))
		throw new GithubUpdateError("INVALID_METADATA", "Invalid patch SHA256 digest");
	const parsed = new URL(step.url);
	const parts = parsed.pathname.split("/");
	if (parts.length !== 7 || parts[3] !== "releases" || parts[4] !== "download")
		throw new GithubUpdateError("INVALID_METADATA", "Invalid GitHub patch release path");
	const repository = `${parts[1]}/${parts[2]}`;
	const filename = decodeURIComponent(parts[6] ?? "");
	const binary = Object.values(PLATFORM_SUFFIXES)
		.map((suffix) => `narrafork-${step.toVersion}-${suffix}`)
		.find((name) => parseReleasePatchName(name, filename));
	if (!binary) throw new GithubUpdateError("INVALID_METADATA", "Invalid platform patch asset name");
	const hint = parseReleasePatchName(binary, filename);
	if (hint?.fromVersion !== undefined && hint.fromVersion !== step.fromVersion)
		throw new GithubUpdateError("INVALID_METADATA", "Patch filename base version mismatch");
	validateGithubAssetUrl(step.url, repository, step.toVersion, filename);
	validateGithubAssetUrl(step.metaUrl, repository, step.toVersion, `${filename}.meta.json`);
}

/** Trusted check-time metadata accompanies a streamed patch; reconstructed SHA512 is checked by the executor. */
export async function downloadGithubPatchToFile(
	step: GithubPatchStep,
	path: string,
	options: {
		signal?: AbortSignal;
		onProgress?: (bytes: number) => void | Promise<void>;
		timeoutMs?: number;
		fetcher?: GithubFetch;
	} = {},
): Promise<void> {
	validatePatchDescriptor(step);
	const signal = AbortSignal.any([
		AbortSignal.timeout(options.timeoutMs ?? 15 * 60_000),
		...(options.signal ? [options.signal] : []),
	]);
	let response: Response | undefined;
	let created = false;
	try {
		signal.throwIfAborted();
		response = await fetchGithubAsset(step.url, signal, options.fetcher);
		if (!response.ok || !response.body)
			throw new GithubUpdateError(
				"NETWORK_ERROR",
				`GitHub patch download failed (HTTP ${response.status})`,
			);
		const declared = response.headers.get("content-length");
		if (declared !== null && Number(declared) !== step.patchSize)
			throw new GithubUpdateError("INVALID_METADATA", "Patch Content-Length mismatch");
		const handle = await open(path, "wx");
		created = true;
		const reader = response.body.getReader();
		const hash = step.sha256 ? createHash("sha256") : undefined;
		let bytes = 0;
		let lastProgressAt = 0;
		try {
			while (true) {
				signal.throwIfAborted();
				const { done, value } = await abortable(reader.read(), signal);
				if (done) break;
				bytes += value.byteLength;
				if (bytes > step.patchSize)
					throw new GithubUpdateError("INVALID_METADATA", "Patch exceeds declared size");
				hash?.update(value);
				let offset = 0;
				while (offset < value.byteLength) {
					signal.throwIfAborted();
					const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
					if (!bytesWritten) throw new Error("Patch write made no progress");
					offset += bytesWritten;
				}
				if (Date.now() - lastProgressAt >= 100 || bytes === step.patchSize) {
					lastProgressAt = Date.now();
					await abortable(Promise.resolve(options.onProgress?.(bytes)), signal);
				}
			}
			signal.throwIfAborted();
			if (bytes !== step.patchSize || (hash && hash.digest("hex") !== step.sha256))
				throw new GithubUpdateError("INVALID_METADATA", "Patch size or SHA256 mismatch");
		} finally {
			await abortable(reader.cancel(), signal).catch(() => {});
			await handle.close();
		}
	} catch (error) {
		if (created) await unlink(path).catch(() => {});
		throw error;
	} finally {
		await abortable(response?.body?.cancel() ?? Promise.resolve(), signal).catch(() => {});
	}
}

export const githubReleaseUpdater = new GithubReleaseUpdater();
