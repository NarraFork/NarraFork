import { describe, expect, test } from "bun:test";
import {
	MAX_UPDATE_INDEX_BYTES,
	MAX_UPDATE_NOTES_BYTES,
	mergeUpdateIndex,
	parseUpdateIndex,
	parseUpdateIndexRelease,
	parseUpdateNotes,
	type UpdateIndexRelease,
	type UpdateIndexV1,
	updateJsonBytes,
} from "./update-index";

const repository = "fork-owner/fork-repo";
const now = "2026-07-01T00:00:00.000Z";
function record(version = "1.2.0", prerelease = false): UpdateIndexRelease {
	const name = `narrafork-${version}-linux-x64`;
	return {
		version,
		tag: `v${version}`,
		commit: "a".repeat(40),
		publishedAt: now,
		prerelease,
		files: [
			{
				name,
				platform: "linux-x64",
				size: 100,
				sha256: "a".repeat(64),
				sha512: Buffer.alloc(64, 3).toString("base64"),
				metadata: { name: `${name}.metadata.json`, size: 100, sha256: "b".repeat(64) },
				patches: [],
			},
		],
	};
}
function index() {
	return mergeUpdateIndex(null, record(), repository, now);
}
describe("bounded public update index", () => {
	test("normalizes repository; computes stable/beta semantic max without rolling back", () => {
		let value = mergeUpdateIndex(null, record("2.0.0"), repository.toUpperCase(), now);
		value = mergeUpdateIndex(value, record("10.1.1", true), repository, now);
		value = mergeUpdateIndex(value, record("1.9.0"), repository, now);
		expect(value.repository).toBe(repository);
		expect(value.channels).toEqual({ stable: "2.0.0", beta: "10.1.1" });
	});
	test("same bytes are idempotent, metadata promotion is allowed but demotion and rewriting assets are not", () => {
		const beta = record("1.2.1", true);
		const first = mergeUpdateIndex(null, beta, repository, now);
		expect(mergeUpdateIndex(first, beta, repository, "2026-08-01T00:00:00.000Z")).toEqual(first);
		const promoted = mergeUpdateIndex(first, { ...beta, prerelease: false }, repository, now);
		expect(promoted.channels.stable).toBe("1.2.1");
		expect(promoted.generation).toBe(2);
		expect(() => mergeUpdateIndex(promoted, beta, repository)).toThrow("demoted");
		const changed = structuredClone(beta);
		changed.files[0].sha256 = "c".repeat(64);
		expect(() => mergeUpdateIndex(first, changed, repository)).toThrow("immutable");
		expect(() => mergeUpdateIndex(first, { ...beta, commit: "b".repeat(40) }, repository)).toThrow(
			"immutable",
		);
	});
	test("same-version patches grow monotonically without changing announced asset identities", () => {
		const original = record();
		const first = mergeUpdateIndex(null, original, repository, now);
		const expanded = structuredClone(original);
		const name = `${expanded.files[0].name}.from-1.0.0.zstd-patch`;
		expanded.files[0].patches.push({
			name,
			fromVersion: "1.0.0",
			size: 10,
			sha256: "c".repeat(64),
			metadata: { name: `${name}.meta.json`, size: 90, sha256: "d".repeat(64) },
		});
		const next = mergeUpdateIndex(first, expanded, repository, now);
		expect(next.generation).toBe(2);
		expect(next.releases[0].files[0].patches).toEqual(expanded.files[0].patches);
		expect(mergeUpdateIndex(next, expanded, repository, now)).toEqual(next);
		for (const mutate of [
			(value: UpdateIndexRelease) => {
				value.files[0].patches = [];
			},
			(value: UpdateIndexRelease) => {
				value.files[0].patches[0].sha256 = "e".repeat(64);
			},
			(value: UpdateIndexRelease) => {
				value.files[0].patches[0].size++;
			},
			(value: UpdateIndexRelease) => {
				value.files[0].patches[0].metadata.sha256 = "e".repeat(64);
			},
			(value: UpdateIndexRelease) => {
				value.files[0].patches[0].metadata.size++;
			},
			(value: UpdateIndexRelease) => {
				value.files[0].metadata.sha256 = "e".repeat(64);
			},
			(value: UpdateIndexRelease) => {
				value.files[0].size++;
			},
		]) {
			const changed = structuredClone(expanded);
			mutate(changed);
			expect(() => mergeUpdateIndex(next, changed, repository, now)).toThrow("immutable");
		}
	});
	test("keeps old stable target plus newest 31 betas; pruned old publications stay idempotent", () => {
		let value = index();
		for (let i = 1; i <= 40; i++)
			value = mergeUpdateIndex(value, record(`2.0.${i}`, true), repository, now);
		expect(value.releases).toHaveLength(32);
		expect(value.channels).toEqual({ stable: "1.2.0", beta: "2.0.40" });
		expect(value.releases.some((r) => r.version === "1.2.0")).toBe(true);
		expect(mergeUpdateIndex(value, record("0.9.1", true), repository)).toEqual(value);
	});
	test("byte pruning only removes non-targets, including long patch records", () => {
		let value: UpdateIndexV1 | null = null;
		for (let i = 1; i <= 20; i++) {
			const entry = record(`2.1.${i}`, true);
			const binary = entry.files[0];
			for (let p = 1; p <= 64; p++) {
				const fromVersion = `1.1.${p}`;
				const name = `${binary.name}.from-${fromVersion}.zstd-patch`;
				binary.patches.push({
					name,
					fromVersion,
					size: 10,
					sha256: "a".repeat(64),
					metadata: { name: `${name}.meta.json`, size: 10, sha256: "b".repeat(64) },
				});
			}
			value = mergeUpdateIndex(value, entry, repository, now);
		}
		expect(value?.channels.beta).toBe("2.1.20");
		expect(value?.releases.length).toBeLessThan(20);
		expect(updateJsonBytes(value)).toBeLessThanOrEqual(MAX_UPDATE_INDEX_BYTES);
	});
	test("strict schema, repository, identity, pointer, sizes, duplicate and path validation", () => {
		for (const mutate of [
			(v: UpdateIndexV1) => {
				v.schemaVersion = 2 as 1;
			},
			(v: UpdateIndexV1) => {
				v.repository = "other/repo";
			},
			(v: UpdateIndexV1) => {
				v.channels.stable = "99.0.0";
			},
			(v: UpdateIndexV1) => {
				v.generatedAt = "2026-02-30T00:00:00.000Z";
			},
			(v: UpdateIndexV1) => {
				v.releases[0].files[0].name = "../evil";
			},
			(v: UpdateIndexV1) => {
				v.releases[0].files[0].sha512 = `${"a".repeat(86)}==`;
			},
			(v: UpdateIndexV1) => {
				v.releases[0].files[0].metadata.size = 65537;
			},
			(v: UpdateIndexV1) => {
				v.releases[0].files.push(v.releases[0].files[0]);
			},
			(v: UpdateIndexV1) => {
				v.releases.push(v.releases[0]);
			},
		]) {
			const value = index();
			mutate(value);
			expect(() => parseUpdateIndex(value, repository)).toThrow();
		}
		expect(() => parseUpdateIndex({ ...index(), body: "hidden notes" }, repository)).toThrow(
			"unknown field",
		);
		expect(() =>
			parseUpdateIndexRelease({
				...record(),
				notes: { path: "https://other/repo", size: 1, sha256: "a".repeat(64) },
			}),
		).toThrow("notes path");
	});
	test("notes are localized, bounded UTF8 and bound to repository/version", () => {
		const value = {
			schemaVersion: 1,
			repository,
			version: "1.2.0",
			notes: { en: "Changes", "zh-CN": "更新说明" },
		};
		expect(parseUpdateNotes(value, repository, "1.2.0").notes).toEqual(value.notes);
		expect(() => parseUpdateNotes(value, repository, "1.1.0")).toThrow("version");
		expect(() => parseUpdateNotes(value, "other/repo", "1.2.0")).toThrow("repository");
		expect(() =>
			parseUpdateNotes(
				{ ...value, notes: "中".repeat(MAX_UPDATE_NOTES_BYTES / 2) },
				repository,
				"1.2.0",
			),
		).toThrow("byte limit");
	});
});
