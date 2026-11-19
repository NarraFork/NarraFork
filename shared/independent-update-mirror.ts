import { isValidGitHubRepository } from "./github-repository";
import { HELPER_BINARY_MAX_BYTES } from "./helper-distribution";
import { MAX_RELEASE_BINARY_BYTES, MAX_RELEASE_PATCH_BYTES } from "./release-patch";
import { isValidReleaseVersion } from "./release-version";
import { parseUpdateIndex, updateJsonBytes } from "./update-index";
import type { UpdateIndexAsset, UpdateIndexV1 } from "./update-index-types";

export const MIRROR_PROTOCOL_VERSION = 1;
export const MAX_MIRROR_SNAPSHOT_BYTES = 320 * 1024;
export const MAX_MIRROR_METADATA_BYTES = 64 * 1024;
export const MAX_MIRROR_ASSETS = 145;
export const MAX_MIRROR_MAIN_BINARY_BYTES = MAX_RELEASE_BINARY_BYTES;
export const MIRROR_MAIN_TRANSFER_TIMEOUT_MS = 15 * 60_000;
export const MIRROR_MAIN_COMMIT_TIMEOUT_MS = 25 * 60_000;
export const MIRROR_ASSET_HEADERS = {
	kind: "x-mirror-kind",
	name: "x-mirror-name",
	size: "x-mirror-size",
	repository: "x-mirror-repository",
	version: "x-mirror-version",
	platform: "x-mirror-platform",
} as const;
export type MirrorAssetKind =
	| "main-binary"
	| "binary-sidecar"
	| "patch"
	| "patch-meta"
	| "notes"
	| "helpers-binary"
	| "executor-binary"
	| "remote-peer-binary";
export interface MirrorAssetDescriptor extends UpdateIndexAsset {
	kind: MirrorAssetKind;
	version: string;
	platform?: string;
}
export interface MirrorSnapshotV1 {
	schemaVersion: 1;
	repository: string;
	indexCommit: string;
	index: UpdateIndexV1;
	targetVersion: string;
	assets: MirrorAssetDescriptor[];
}
export interface MirrorSnapshotV2 extends Omit<MirrorSnapshotV1, "schemaVersion"> {
	schemaVersion: 2;
}
export type MirrorSnapshot = MirrorSnapshotV1 | MirrorSnapshotV2;
export interface MirrorAvailabilityV1 {
	schemaVersion: 1;
	repository: string;
	version: string;
	platform: string;
	assets: UpdateIndexAsset[];
}
function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Invalid independent mirror: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
	check(value && typeof value === "object" && !Array.isArray(value), "object required");
	return value as Record<string, unknown>;
}
function repo(value: unknown, expected: string) {
	check(
		isValidGitHubRepository(expected) &&
			isValidGitHubRepository(value) &&
			value.toLowerCase() === expected.toLowerCase(),
		"repository mismatch or unconfigured",
	);
}
export function mirrorAssetLimit(kind: MirrorAssetKind): number {
	if (kind === "main-binary") return MAX_MIRROR_MAIN_BINARY_BYTES;
	return kind === "helpers-binary" || kind === "executor-binary" || kind === "remote-peer-binary"
		? HELPER_BINARY_MAX_BYTES
		: kind === "patch"
			? MAX_RELEASE_PATCH_BYTES
			: kind === "notes"
				? 1024 * 1024
				: MAX_MIRROR_METADATA_BYTES;
}
export function parseMirrorAssetDescriptor(value: unknown): MirrorAssetDescriptor {
	const a = object(value);
	check(
		Object.keys(a).every((k) =>
			["kind", "name", "size", "sha256", "version", "platform"].includes(k),
		),
		"unknown asset field",
	);
	check(
		[
			"main-binary",
			"binary-sidecar",
			"patch",
			"patch-meta",
			"notes",
			"helpers-binary",
			"executor-binary",
			"remote-peer-binary",
		].includes(String(a.kind)),
		"asset kind",
	);
	const kind = a.kind as MirrorAssetKind;
	check(typeof a.version === "string" && isValidReleaseVersion(a.version), "asset version");
	check(
		typeof a.name === "string" &&
			a.name.length <= 512 &&
			/^[A-Za-z0-9._+/-]+$/.test(a.name) &&
			!a.name.includes("..") &&
			!a.name.startsWith("/"),
		"asset name",
	);
	check(
		typeof a.size === "number" &&
			Number.isSafeInteger(a.size) &&
			a.size > 0 &&
			a.size <= mirrorAssetLimit(kind),
		"asset size",
	);
	check(typeof a.sha256 === "string" && /^[a-f0-9]{64}$/.test(a.sha256), "asset SHA256");
	check(
		kind === "notes"
			? a.platform === undefined
			: typeof a.platform === "string" && /^[a-z0-9-]{1,32}$/.test(a.platform),
		"asset platform",
	);
	return {
		kind,
		name: a.name,
		size: a.size,
		sha256: a.sha256,
		version: a.version,
		...(a.platform === undefined ? {} : { platform: a.platform as string }),
	};
}
/** Complete projection of one release; legacy callers remain metadata/patch-only. */
export function mirrorAssetsForTarget(
	index: UpdateIndexV1,
	targetVersion: string,
	projectionVersion: 1 | 2 = 1,
): MirrorAssetDescriptor[] {
	const target = index.releases.find((r) => r.version === targetVersion);
	check(target, "target not in canonical index");
	const assets: MirrorAssetDescriptor[] = [];
	for (const file of target.files) {
		if (projectionVersion === 2)
			assets.push({
				name: file.name,
				size: file.size,
				sha256: file.sha256,
				kind: "main-binary",
				version: targetVersion,
				platform: file.platform,
			});
		assets.push({
			...file.metadata,
			kind: "binary-sidecar",
			version: targetVersion,
			platform: file.platform,
		});
		for (const patch of file.patches) {
			assets.push({
				name: patch.name,
				size: patch.size,
				sha256: patch.sha256,
				kind: "patch",
				version: targetVersion,
				platform: file.platform,
			});
			assets.push({
				...patch.metadata,
				kind: "patch-meta",
				version: targetVersion,
				platform: file.platform,
			});
		}
	}
	if (target.notes)
		assets.push({
			name: target.notes.path,
			size: target.notes.size,
			sha256: target.notes.sha256,
			kind: "notes",
			version: targetVersion,
		});
	return assets;
}
export function parseMirrorSnapshot(value: unknown, expectedRepository: string): MirrorSnapshot {
	check(updateJsonBytes(value) <= MAX_MIRROR_SNAPSHOT_BYTES, "snapshot byte limit");
	const s = object(value);
	check(
		Object.keys(s).every((k) =>
			["schemaVersion", "repository", "indexCommit", "index", "targetVersion", "assets"].includes(
				k,
			),
		),
		"unknown snapshot field",
	);
	check(s.schemaVersion === 1 || s.schemaVersion === 2, "schema version");
	repo(s.repository, expectedRepository);
	check(typeof s.indexCommit === "string" && /^[a-f0-9]{40}$/.test(s.indexCommit), "index commit");
	const index = parseUpdateIndex(s.index, expectedRepository);
	check(typeof s.targetVersion === "string", "target version");
	check(Array.isArray(s.assets) && s.assets.length <= MAX_MIRROR_ASSETS, "asset count");
	const assets = s.assets.map(parseMirrorAssetDescriptor);
	const expected = mirrorAssetsForTarget(index, s.targetVersion, s.schemaVersion);
	check(
		assets.length === expected.length && new Set(assets.map((a) => a.name)).size === assets.length,
		"complete target projection required",
	);
	for (const a of assets) {
		const e = expected.find((e) => e.name === a.name);
		check(
			e &&
				e.kind === a.kind &&
				e.version === a.version &&
				e.platform === a.platform &&
				e.size === a.size &&
				e.sha256 === a.sha256,
			"canonical asset identity",
		);
	}
	return {
		schemaVersion: s.schemaVersion,
		repository: index.repository,
		indexCommit: s.indexCommit,
		index,
		targetVersion: s.targetVersion,
		assets,
	};
}
export function parseMirrorAvailability(
	value: unknown,
	expectedRepository: string,
	version: string,
	platform: string,
	index?: UpdateIndexV1,
): MirrorAvailabilityV1 {
	check(updateJsonBytes(value) <= MAX_MIRROR_SNAPSHOT_BYTES, "availability byte limit");
	const a = object(value);
	check(
		Object.keys(a).every((k) =>
			["schemaVersion", "repository", "version", "platform", "assets"].includes(k),
		),
		"unknown availability field",
	);
	repo(a.repository, expectedRepository);
	check(
		a.schemaVersion === 1 &&
			a.version === version &&
			a.platform === platform &&
			isValidReleaseVersion(version),
		"availability identity",
	);
	check(Array.isArray(a.assets) && a.assets.length <= MAX_MIRROR_ASSETS, "availability count");
	const expected = index
		? mirrorAssetsForTarget(parseUpdateIndex(index, expectedRepository), version).filter(
				(a) => a.platform === platform,
			)
		: undefined;
	const assets = a.assets.map((value) => {
		const asset = object(value);
		check(
			Object.keys(asset).every((k) => ["name", "size", "sha256"].includes(k)),
			"unknown availability asset field",
		);
		check(
			typeof asset.name === "string" &&
				asset.name.length <= 512 &&
				!asset.name.includes("..") &&
				/^[A-Za-z0-9._+-]+$/.test(asset.name),
			"availability name",
		);
		check(
			typeof asset.size === "number" &&
				Number.isSafeInteger(asset.size) &&
				asset.size > 0 &&
				asset.size <= MAX_RELEASE_PATCH_BYTES,
			"availability size",
		);
		check(
			typeof asset.sha256 === "string" && /^[a-f0-9]{64}$/.test(asset.sha256),
			"availability SHA256",
		);
		check(
			!expected ||
				expected.some(
					(e) => e.name === asset.name && e.size === asset.size && e.sha256 === asset.sha256,
				),
			"availability canonical identity",
		);
		return { name: asset.name, size: asset.size, sha256: asset.sha256 };
	});
	check(new Set(assets.map((a) => a.name)).size === assets.length, "duplicate availability asset");
	return {
		schemaVersion: 1,
		repository: expectedRepository.toLowerCase(),
		version,
		platform,
		assets,
	};
}
