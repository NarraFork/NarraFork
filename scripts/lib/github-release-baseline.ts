import { createHash } from "node:crypto";
import {
	isValidGitHubRepository,
	OFFICIAL_GITHUB_REPOSITORY,
} from "../../shared/github-repository";
import { MAX_RELEASE_BINARY_BYTES, RELEASE_SHA512_RE } from "../../shared/release-patch";
import { compareReleaseVersions, isValidReleaseVersion } from "../../shared/release-version";
import type { BinaryMetadata } from "./binary-metadata";
import { CI_METADATA_LIMIT, CI_TEXT_LIMIT, runCiGh } from "./ci-release-io";
import { CI_RELEASE_TARGETS, type CiReleaseBaseline, type CiReleasePlan } from "./ci-release-types";
import { type GhRunner, releaseChannel } from "./github-release";
import { type GitHubReleaseSummary, listGitHubReleaseSummaries } from "./github-release-summary";

interface RemoteAsset {
	id: number;
	name: string;
	size: number;
	state: string;
}
export interface SelectGitHubBaselinesOptions {
	run?: GhRunner;
	signal?: AbortSignal;
}

function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function validateBaselineMetadata(
	value: unknown,
	expected: {
		version: string;
		platform: string;
		name: string;
		size: number;
		commit?: string;
		repository?: string;
	},
): BinaryMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid binary metadata");
	const meta = value as BinaryMetadata;
	const target = CI_RELEASE_TARGETS.find((entry) => entry.platform === expected.platform);
	if (
		!target ||
		(meta.repository !== undefined && !isValidGitHubRepository(meta.repository)) ||
		(expected.repository !== undefined &&
			(meta.repository ?? OFFICIAL_GITHUB_REPOSITORY) !== expected.repository) ||
		meta.version !== expected.version ||
		meta.platform !== expected.platform ||
		meta.name !== expected.name ||
		meta.target !== `bun-${target.target}` ||
		!positive(meta.size) ||
		meta.size > MAX_RELEASE_BINARY_BYTES ||
		meta.size !== expected.size ||
		typeof meta.commit !== "string" ||
		!/^[a-f0-9]{7,40}$/.test(meta.commit) ||
		(expected.commit !== undefined && !expected.commit.startsWith(meta.commit)) ||
		typeof meta.buildDate !== "string" ||
		!Number.isFinite(Date.parse(meta.buildDate)) ||
		typeof meta.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(meta.sha256) ||
		typeof meta.sha512 !== "string" ||
		!RELEASE_SHA512_RE.test(meta.sha512)
	)
		throw new Error(`Invalid binary metadata/provenance: ${expected.name}`);
	return meta;
}

/** Stops only after a short page. A full tenth page is ambiguous and therefore fails closed. */
async function listPages<T>(run: GhRunner, endpoint: string, signal?: AbortSignal): Promise<T[]> {
	const items: T[] = [];
	for (let page = 1; page <= 10; page++) {
		signal?.throwIfAborted();
		const raw = await run(["api", `${endpoint}?per_page=100&page=${page}`]);
		if (Buffer.byteLength(raw) > CI_TEXT_LIMIT)
			throw new Error("GitHub API response exceeds limit");
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid GitHub API page");
		items.push(...value);
		if (value.length < 100) return items;
	}
	throw new Error("GitHub API pagination limit exceeded; refusing truncated baseline history");
}

/** Selects immutable asset IDs, not guessed URLs or local dist leftovers. Never swallows API errors. */
export async function selectGitHubBaselines(
	plan: Omit<CiReleasePlan, "baselines">,
	options: SelectGitHubBaselinesOptions = {},
): Promise<CiReleaseBaseline[]> {
	if (
		!isValidGitHubRepository(plan.repository) ||
		!isValidReleaseVersion(plan.version) ||
		plan.channel !== releaseChannel(plan.version)
	)
		throw new Error("Invalid baseline release plan");
	const run = options.run ?? runCiGh;
	options.signal?.throwIfAborted();
	const releases = await listGitHubReleaseSummaries(async (args) => {
		options.signal?.throwIfAborted();
		const result = await run(args);
		options.signal?.throwIfAborted();
		return result;
	}, plan.repository);
	const ids = new Set<number>();
	const versions = new Set<string>();
	const candidates: GitHubReleaseSummary[] = [];
	for (const release of releases) {
		if (
			!release ||
			!positive(release.id) ||
			typeof release.tagName !== "string" ||
			typeof release.draft !== "boolean" ||
			typeof release.prerelease !== "boolean" ||
			ids.has(release.id)
		)
			throw new Error("Invalid/duplicate GitHub release identity");
		ids.add(release.id);
		if (release.draft || !release.tagName.startsWith("v")) continue;
		const version = release.tagName.slice(1);
		if (!isValidReleaseVersion(version) || compareReleaseVersions(version, plan.version) >= 0)
			continue;
		if (versions.has(version)) throw new Error("Duplicate baseline release version");
		versions.add(version);
		candidates.push(release);
	}
	candidates.sort((a, b) => compareReleaseVersions(b.tagName.slice(1), a.tagName.slice(1)));
	const nearest = new Set<string>();
	const stable = new Set<string>();
	const result: CiReleaseBaseline[] = [];
	for (const release of candidates) {
		options.signal?.throwIfAborted();
		const version = release.tagName.slice(1);
		const isStable = releaseChannel(version) === "stable" && !release.prerelease;
		const needed = CI_RELEASE_TARGETS.filter(
			({ platform }) =>
				!nearest.has(platform) || (plan.channel === "stable" && isStable && !stable.has(platform)),
		);
		if (needed.length === 0) continue;
		const assets = await listPages<RemoteAsset>(
			run,
			`repos/${plan.repository}/releases/${release.id}/assets`,
			options.signal,
		);
		if (assets.length > 200) throw new Error("Baseline release asset limit exceeded");
		if (assets.length !== release.assetCount)
			throw new Error("Baseline release asset count changed or truncated");
		const assetMap = new Map<string, RemoteAsset>();
		const assetIds = new Set<number>();
		for (const asset of assets) {
			if (
				!asset ||
				!positive(asset.id) ||
				typeof asset.name !== "string" ||
				asset.name.length > 255 ||
				!positive(asset.size) ||
				asset.state !== "uploaded" ||
				assetMap.has(asset.name) ||
				assetIds.has(asset.id)
			)
				throw new Error("Invalid/duplicate baseline asset");
			assetMap.set(asset.name, asset);
			assetIds.add(asset.id);
		}
		for (const target of needed) {
			const name = `narrafork-${version}-${target.suffix}`;
			const binary = assetMap.get(name);
			const sidecar = assetMap.get(`${name}.metadata.json`);
			if (!binary && !sidecar) continue;
			if (!binary || !sidecar) throw new Error(`Incomplete baseline platform: ${name}`);
			if (binary.size > MAX_RELEASE_BINARY_BYTES || sidecar.size > CI_METADATA_LIMIT)
				throw new Error("Baseline asset size limit exceeded");
			options.signal?.throwIfAborted();
			const raw = await run([
				"api",
				`repos/${plan.repository}/releases/assets/${sidecar.id}`,
				"-H",
				"Accept: application/octet-stream",
			]);
			if (Buffer.byteLength(raw) !== sidecar.size || Buffer.byteLength(raw) > CI_METADATA_LIMIT)
				throw new Error("Baseline metadata size mismatch");
			const metadata = validateBaselineMetadata(JSON.parse(raw), {
				version,
				platform: target.platform,
				name,
				size: binary.size,
			});
			result.push({
				releaseId: release.id,
				version,
				platform: target.platform,
				binaryAsset: { id: binary.id, name: binary.name, size: binary.size },
				metadataAsset: { id: sidecar.id, name: sidecar.name, size: sidecar.size },
				metadataSha256: createHash("sha256").update(raw).digest("hex"),
				metadata,
			});
			nearest.add(target.platform);
			if (isStable) stable.add(target.platform);
		}
		if (
			nearest.size === CI_RELEASE_TARGETS.length &&
			(plan.channel !== "stable" || stable.size === CI_RELEASE_TARGETS.length)
		)
			break;
	}
	if (result.length > 16) throw new Error("Baseline count limit exceeded");
	return result;
}
