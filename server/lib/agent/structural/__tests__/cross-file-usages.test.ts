/**
 * Assembling cross-file usage results.
 *
 * The IO (ripgrep prefilter + per-file parse) lives in the tool handler; the classification
 * that decides what actually gets reported is here, pure and tested. The load-bearing rule
 * is that a text-only match — the name in a comment or string, with no real identifier line
 * — is NOT reported as a usage. Reporting it would recreate the grep noise this mode exists
 * to remove.
 */
import { describe, expect, test } from "bun:test";
import {
	assembleUsages,
	CROSS_FILE_PRECISION_NOTE,
	importMayReferTo,
	type RawFileHit,
} from "../cross-file-usages";

describe("assembleUsages", () => {
	test("lists files that have real identifier lines", () => {
		const hits: RawFileHit[] = [
			{ path: "a.ts", lines: [4, 9] },
			{ path: "b.ts", lines: [12] },
		];
		const result = assembleUsages(hits);
		expect(result.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
		expect(result.files[0]?.lines).toEqual([4, 9]);
	});

	test("a text-only match is counted, not listed", () => {
		// The name appeared in a comment/string — ripgrep saw it, the parser found no
		// identifier. That is the noise this stage removes.
		const result = assembleUsages([
			{ path: "real.ts", lines: [3] },
			{ path: "comment-only.ts", lines: [] },
		]);
		expect(result.files.map((f) => f.path)).toEqual(["real.ts"]);
		expect(result.textOnlyFiles).toBe(1);
	});

	test("files are ordered by how many times the symbol is used", () => {
		const result = assembleUsages([
			{ path: "few.ts", lines: [1] },
			{ path: "many.ts", lines: [1, 2, 3] },
		]);
		expect(result.files.map((f) => f.path)).toEqual(["many.ts", "few.ts"]);
	});

	test("ties break alphabetically for stable output", () => {
		const result = assembleUsages([
			{ path: "z.ts", lines: [1] },
			{ path: "a.ts", lines: [1] },
		]);
		expect(result.files.map((f) => f.path)).toEqual(["a.ts", "z.ts"]);
	});

	test("lines are deduped and sorted", () => {
		const result = assembleUsages([{ path: "a.ts", lines: [9, 4, 4, 1] }]);
		expect(result.files[0]?.lines).toEqual([1, 4, 9]);
	});

	test("per-file lines are capped", () => {
		const many = Array.from({ length: 40 }, (_, i) => i + 1);
		const result = assembleUsages([{ path: "a.ts", lines: many }], { maxLinesPerFile: 5 });
		expect(result.files[0]?.lines).toHaveLength(5);
	});

	test("propagates the capped and skipped flags", () => {
		const result = assembleUsages([{ path: "a.ts", lines: [1] }], {
			candidatesCapped: true,
			skipped: 3,
		});
		expect(result.candidatesCapped).toBe(true);
		expect(result.skipped).toBe(3);
	});

	test("no hits yields an empty, honest result", () => {
		const result = assembleUsages([]);
		expect(result.files).toHaveLength(0);
		expect(result.textOnlyFiles).toBe(0);
	});

	test("confirmed files sort ahead of unverified ones", () => {
		// A rename has to update the files that provably use the symbol; the same-named
		// ones have to be read first. Ordering puts the actionable group on top.
		const result = assembleUsages([
			{ path: "maybe.ts", lines: [1, 2, 3, 4], confidence: "unverified" },
			{ path: "certain.ts", lines: [7], confidence: "confirmed" },
		]);
		expect(result.files.map((f) => f.path)).toEqual(["certain.ts", "maybe.ts"]);
	});

	test("an alias is carried through so the local name is visible", () => {
		const result = assembleUsages([
			{ path: "renamer.ts", lines: [1, 2], confidence: "aliased", alias: "renamed" },
		]);
		expect(result.files[0]?.alias).toBe("renamed");
		expect(result.files[0]?.confidence).toBe("aliased");
	});

	test("importMayReferTo matches a direct path, a barrel and an index", () => {
		const def = "/repo/server/lib/structural/cross-file-usages.ts";
		// Direct: the specifier names the file.
		expect(importMayReferTo("./cross-file-usages", def)).toBe(true);
		expect(importMayReferTo("../../structural/cross-file-usages.ts", def)).toBe(true);
		// Barrel: the specifier names the directory the file lives in, which is how most
		// of a codebase reaches a symbol.
		expect(importMayReferTo("../../structural", def)).toBe(true);
		expect(importMayReferTo("@server/lib/structural", def)).toBe(true);
		// Unrelated module.
		expect(importMayReferTo("./address", def)).toBe(false);
		expect(importMayReferTo("node:path", def)).toBe(false);
		expect(importMayReferTo("", def)).toBe(false);
	});

	test("importMayReferTo resolves a directory import to its index file", () => {
		const def = "/repo/server/tools/struct-view/index.ts";
		expect(importMayReferTo("../struct-view", def)).toBe(true);
		expect(importMayReferTo("./index", def)).toBe(true);
		expect(importMayReferTo("../struct-sed", def)).toBe(false);
	});

	test("the precision note names both known blind spots", () => {
		// If this string ever loses the same-name or alias caveat, the mode starts looking
		// authoritative when it is not.
		expect(CROSS_FILE_PRECISION_NOTE).toMatch(/same name/i);
		expect(CROSS_FILE_PRECISION_NOTE).toMatch(/alias/i);
	});
});
