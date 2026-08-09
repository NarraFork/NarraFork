import { describe, expect, test } from "bun:test";
import {
	extractCleanupErrors,
	extractSkippedIds,
	extractWarnings,
	formatWarningList,
	MAX_WARNING_CHARS,
	MAX_WARNING_ITEMS,
} from "./operation-warnings";

describe("extractWarnings", () => {
	test("reads the singular warning field returned by merge and unmerge", () => {
		expect(extractWarnings({ success: true, warning: "worktree kept" })).toEqual(["worktree kept"]);
	});

	test("reads the plural warnings array returned by fork and split", () => {
		expect(
			extractWarnings({ id: "ch", warnings: ["rebuilt from edits", "bash writes absent"] }),
		).toEqual(["rebuilt from edits", "bash writes absent"]);
	});

	test("reads both fields when a response carries them together", () => {
		expect(extractWarnings({ warning: "a", warnings: ["b"] })).toEqual(["a", "b"]);
	});

	test("deduplicates repeated text", () => {
		expect(extractWarnings({ warning: "same", warnings: ["same", "other"] })).toEqual([
			"same",
			"other",
		]);
	});

	test("ignores empty, blank and non-string entries", () => {
		expect(extractWarnings({ warnings: ["", "   ", null, 42, { a: 1 }, "real"] })).toEqual([
			"real",
		]);
	});

	test("returns nothing for a clean success, so callers show no notification", () => {
		expect(extractWarnings({ success: true })).toEqual([]);
		expect(extractWarnings(null)).toEqual([]);
		expect(extractWarnings(undefined)).toEqual([]);
		expect(extractWarnings("not an object")).toEqual([]);
	});
});

describe("formatWarningList", () => {
	test("joins warnings one per line", () => {
		expect(formatWarningList(["first", "second"])).toBe("first\nsecond");
	});

	test("caps the item count and says how many were omitted", () => {
		const many = Array.from({ length: MAX_WARNING_ITEMS + 5 }, (_, i) => `w${i}`);
		const body = formatWarningList(many);
		expect(body).toContain("… +5");
		expect(body.split("\n")).toHaveLength(MAX_WARNING_ITEMS + 1);
	});

	test("caps the character count, since warnings quote server-side detail", () => {
		const body = formatWarningList(["x".repeat(MAX_WARNING_CHARS + 500)]);
		expect(body.length).toBeLessThanOrEqual(MAX_WARNING_CHARS + 1);
		expect(body.endsWith("…")).toBe(true);
	});
});

describe("cleanup report readers", () => {
	test("extracts skipped chapter ids", () => {
		expect(extractSkippedIds({ cleaned: ["a"], skipped: ["b", "c"], errors: [] })).toEqual([
			"b",
			"c",
		]);
	});

	test("ignores a missing or malformed skipped field", () => {
		expect(extractSkippedIds({ cleaned: ["a"] })).toEqual([]);
		expect(extractSkippedIds({ skipped: "nope" })).toEqual([]);
		expect(extractSkippedIds({ skipped: [1, "", "  ", "ok"] })).toEqual(["ok"]);
	});

	test("extracts per-chapter errors, tolerating a missing message", () => {
		expect(
			extractCleanupErrors({
				errors: [{ chapterId: "a", error: "boom" }, { chapterId: "b" }, { error: "no id" }],
			}),
		).toEqual([
			{ chapterId: "a", error: "boom" },
			{ chapterId: "b", error: "" },
		]);
	});
});
