import { expect, test } from "bun:test";
import {
	MAX_MIRROR_MAIN_BINARY_BYTES,
	type MirrorSnapshotV1,
	type MirrorSnapshotV2,
	mirrorAssetLimit,
	mirrorAssetsForTarget,
	parseMirrorAssetDescriptor,
	parseMirrorAvailability,
	parseMirrorSnapshot,
} from "./independent-update-mirror";
import { mergeUpdateIndex, type UpdateIndexRelease } from "./update-index";

function fixture(): MirrorSnapshotV1 {
	const name = "narrafork-0.9.2-linux-x64";
	const record: UpdateIndexRelease = {
		version: "0.9.2",
		tag: "v0.9.2",
		commit: "a".repeat(40),
		prerelease: false,
		publishedAt: "2026-07-01T00:00:00.000Z",
		files: [
			{
				name,
				platform: "linux-x64",
				size: 100,
				sha256: "a".repeat(64),
				sha512: Buffer.alloc(64).toString("base64"),
				metadata: { name: `${name}.metadata.json`, size: 100, sha256: "b".repeat(64) },
				patches: [],
			},
		],
	};
	const index = mergeUpdateIndex(null, record, "fork/project");
	return {
		schemaVersion: 1,
		repository: "fork/project",
		indexCommit: "c".repeat(40),
		index,
		targetVersion: record.version,
		assets: mirrorAssetsForTarget(index, record.version),
	};
}
test("pure mirror schema is bound to configured repo, target and complete exact canonical projection", () => {
	const value = fixture();
	expect(parseMirrorSnapshot(value, "fork/project")).toEqual(value);
	for (const mutate of [
		(s: MirrorSnapshotV1) => {
			s.repository = "upstream/project";
		},
		(s: MirrorSnapshotV1) => {
			s.index.repository = "upstream/project";
		},
		(s: MirrorSnapshotV1) => {
			s.targetVersion = "0.8.3";
		},
		(s: MirrorSnapshotV1) => {
			s.indexCommit = "tag";
		},
		(s: MirrorSnapshotV1) => {
			s.assets = [];
		},
		(s: MirrorSnapshotV1) => {
			s.assets.push(s.assets[0]);
		},
		(s: MirrorSnapshotV1) => {
			s.assets[0].size++;
		},
		(s: MirrorSnapshotV1) => {
			s.assets[0].sha256 = "e".repeat(64);
		},
		(s: MirrorSnapshotV1) => {
			s.assets[0].name = s.index.releases[0].files[0].name;
		},
	]) {
		const changed = structuredClone(value);
		mutate(changed);
		expect(() => parseMirrorSnapshot(changed, "fork/project")).toThrow();
	}
	expect(() => parseMirrorSnapshot(value, "")).toThrow("unconfigured");
});
test.each([
	1024 ** 3 + 1,
	4 * 1024 ** 3,
])("canonical mirror snapshots accept full descriptors up to 4 GiB: %s", (size) => {
	const legacy = fixture();
	legacy.index.releases[0].files[0].size = size;
	const value: MirrorSnapshotV2 = {
		...legacy,
		schemaVersion: 2,
		assets: mirrorAssetsForTarget(legacy.index, legacy.targetVersion, 2),
	};
	expect(parseMirrorSnapshot(value, value.repository)).toEqual(value);
	const tooLarge = structuredClone(value);
	tooLarge.index.releases[0].files[0].size = MAX_MIRROR_MAIN_BINARY_BYTES + 1;
	expect(() => parseMirrorSnapshot(tooLarge, value.repository)).toThrow("size");
});
test("v2 requires exact full-binary projection while v1 remains metadata-only", () => {
	const old = fixture();
	const full: MirrorSnapshotV2 = {
		...old,
		schemaVersion: 2,
		assets: mirrorAssetsForTarget(old.index, old.targetVersion, 2),
	};
	expect(parseMirrorSnapshot(full, old.repository)).toEqual(full);
	expect(full.assets[0].kind).toBe("main-binary");
	expect(full.assets[0]).not.toHaveProperty("metadata");
	expect(() => parseMirrorSnapshot({ ...full, assets: old.assets }, old.repository)).toThrow(
		"complete",
	);
	expect(() => parseMirrorSnapshot({ ...full, schemaVersion: 1 }, old.repository)).toThrow(
		"complete",
	);
	expect(mirrorAssetLimit("main-binary")).toBe(4 * 1024 ** 3);
	expect(mirrorAssetLimit("patch")).toBe(512 * 1024 ** 2);
	expect(
		parseMirrorAssetDescriptor({ ...full.assets[0], size: MAX_MIRROR_MAIN_BINARY_BYTES }).size,
	).toBe(MAX_MIRROR_MAIN_BINARY_BYTES);
	expect(() =>
		parseMirrorAssetDescriptor({ ...full.assets[0], size: MAX_MIRROR_MAIN_BINARY_BYTES + 1 }),
	).toThrow("size");
	for (const change of [
		{ sha256: "e".repeat(64) },
		{ platform: "win-x64" },
		{ version: "0.9.3" },
		{ name: "invented" },
		{ size: full.assets[0].size + 1 },
	]) {
		expect(() =>
			parseMirrorSnapshot(
				{ ...full, assets: [{ ...full.assets[0], ...change }, ...full.assets.slice(1)] },
				old.repository,
			),
		).toThrow("canonical");
	}
});

test("raw asset admission rejects unknown binary kinds, traversal and per-kind byte limits", () => {
	const asset = fixture().assets[0];
	for (const changed of [
		{ ...asset, kind: "binary" },
		{ ...asset, name: "../config" },
		{ ...asset, name: "/etc/passwd" },
		{ ...asset, size: 64 * 1024 + 1 },
		{ ...asset, sha256: "not a hash" },
		{ ...asset, platform: "../linux" },
		{ ...asset, fullUrl: "https://evil.invalid" },
	])
		expect(() => parseMirrorAssetDescriptor(changed)).toThrow();
	expect(() =>
		parseMirrorAssetDescriptor({ ...asset, kind: "patch", size: 512 * 1024 * 1024 + 1 }),
	).toThrow();
	expect(() =>
		parseMirrorAssetDescriptor({
			...asset,
			kind: "notes",
			platform: undefined,
			size: 1024 * 1024 + 1,
		}),
	).toThrow();
});
test("remote peer binaries retain the shared 32 MiB limit and mandatory canonical descriptors", () => {
	const asset = {
		kind: "remote-peer-binary" as const,
		name: "narrafork-remote-peer-0.1.0-alpha.1-linux-amd64",
		version: "0.1.0-alpha.1",
		platform: "linux-amd64",
		size: 32 * 1024 * 1024,
		sha256: "a".repeat(64),
	};
	expect(mirrorAssetLimit("remote-peer-binary")).toBe(32 * 1024 * 1024);
	expect(parseMirrorAssetDescriptor(asset)).toEqual(asset);
	for (const change of [
		{ size: asset.size + 1 },
		{ kind: "remote-peer" },
		{ platform: undefined },
		{ sha256: "" },
	])
		expect(() => parseMirrorAssetDescriptor({ ...asset, ...change })).toThrow();
});
test("availability permits an empty local projection but rejects invented/mismatched assets and authorities", () => {
	const s = fixture();
	const a = {
		schemaVersion: 1,
		repository: s.repository,
		version: s.targetVersion,
		platform: "linux-x64",
		assets: s.assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
	};
	expect(
		parseMirrorAvailability(a, s.repository, s.targetVersion, "linux-x64", s.index).assets,
	).toHaveLength(1);
	expect(
		parseMirrorAvailability(
			{ ...a, assets: [] },
			s.repository,
			s.targetVersion,
			"linux-x64",
			s.index,
		).assets,
	).toEqual([]);
	for (const changed of [
		{ ...a, repository: "upstream/project" },
		{ ...a, version: "999.0.0" },
		{ ...a, platform: "win-x64" },
		{ ...a, assets: [...a.assets, ...a.assets] },
		{ ...a, assets: [{ ...a.assets[0], sha256: "e".repeat(64) }] },
		{ ...a, assets: [{ ...a.assets[0], fullUrl: "https://evil.invalid" }] },
	])
		expect(() =>
			parseMirrorAvailability(changed, s.repository, s.targetVersion, "linux-x64", s.index),
		).toThrow();
});
