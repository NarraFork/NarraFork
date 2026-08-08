/**
 * diff-core.test.ts — Contract for the shared diff model.
 *
 * This module is now the single source of truth for both render paths, so these
 * tests pin the properties BOTH depend on:
 *
 *   - unchanged lines stay CONTEXT (the bug that made the virtual list show every
 *     line as "removed then re-added")
 *   - both sides carry their own line numbers, so a two-column gutter is possible
 *   - the gutter string is fixed-width, so code starts at the same column on
 *     every row
 *   - word-level changes mark only what actually differs
 *   - every bound (input size, row count, per-line length) actually holds
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
	buildDiffHighlightSource,
	computeDiff,
	computeDiffCached,
	type DiffLine,
	diffCacheStats,
	diffLineMarker,
	diffLineNoWidth,
	formatDiffGutter,
	formatDiffLineNumber,
	MAX_DIFF_LINES,
	normalizeDiffLineEndings,
	resetDiffCache,
} from "./diff-core";

const shape = (lines: DiffLine[]) => lines.map((l) => [l.type, l.content]);
const numbers = (lines: DiffLine[]) => lines.map((l) => [l.oldLineNo, l.newLineNo]);

describe("computeDiff — line classification", () => {
	it("keeps unchanged lines as context instead of removing and re-adding them", () => {
		// The regression this locks down: a naive implementation emits
		// [removed a, removed b, added a, added B], losing the fact that `a` is
		// unchanged and destroying the line numbering.
		expect(shape(computeDiff("a\nb", "a\nB"))).toEqual([
			["context", "a"],
			["removed", "b"],
			["added", "B"],
		]);
	});

	it("reports a pure insertion with no removed rows", () => {
		expect(shape(computeDiff("a\n", "a\nb\n"))).toEqual([
			["context", "a"],
			["added", "b"],
		]);
	});

	it("reports a pure deletion with no added rows", () => {
		expect(shape(computeDiff("a\nb\n", "a\n"))).toEqual([
			["context", "a"],
			["removed", "b"],
		]);
	});

	it("treats a changed trailing newline as a change on the last line", () => {
		// UPSTREAM BEHAVIOUR, documented rather than asserted-as-ideal: the `diff`
		// package compares "a" against "a\n" as different lines, so appending a line
		// to an unterminated body reports the previously-last line as modified.
		// Both render paths share this function, so both agree — which is the
		// property that matters here. Real Edit payloads normally keep their
		// newlines, in which case the case above applies.
		expect(shape(computeDiff("a", "a\nb"))).toEqual([
			["removed", "a"],
			["added", "a"],
			["added", "b"],
		]);
	});

	it("handles an empty old side (whole body added)", () => {
		expect(shape(computeDiff("", "x\ny"))).toEqual([
			["added", "x"],
			["added", "y"],
		]);
	});

	it("handles an empty new side (whole body removed)", () => {
		expect(shape(computeDiff("x\ny", ""))).toEqual([
			["removed", "x"],
			["removed", "y"],
		]);
	});

	it("returns no rows when both sides are identical and empty", () => {
		expect(computeDiff("", "")).toEqual([]);
	});

	it("emits all context when the two sides are identical", () => {
		const lines = computeDiff("a\nb\nc", "a\nb\nc");
		expect(lines.every((l) => l.type === "context")).toBe(true);
		expect(lines).toHaveLength(3);
	});

	it("pairs uneven modification blocks, then lists the leftovers", () => {
		// 3 removed vs 1 added: one pair, then two unpaired removals.
		expect(shape(computeDiff("a\nb\nc", "X"))).toEqual([
			["removed", "a"],
			["added", "X"],
			["removed", "b"],
			["removed", "c"],
		]);
	});
});

describe("computeDiff — line numbers", () => {
	it("numbers context on both sides and each change on its own side only", () => {
		expect(numbers(computeDiff("a\nb", "a\nB"))).toEqual([
			[1, 1],
			[2, undefined],
			[undefined, 2],
		]);
	});

	it("offsets every row by startLine", () => {
		expect(numbers(computeDiff("a\nb", "a\nB", 42))).toEqual([
			[42, 42],
			[43, undefined],
			[undefined, 43],
		]);
	});

	it("keeps the two sides diverging after an insertion", () => {
		// Adding a line makes the new side run one ahead of the old side.
		const lines = computeDiff("a\nz", "a\nb\nz");
		expect(numbers(lines)).toEqual([
			[1, 1],
			[undefined, 2],
			[2, 3],
		]);
	});
});

describe("computeDiff — word-level changes", () => {
	it("marks only the differing token inside a modified pair", () => {
		const lines = computeDiff("const a = 1;", "const a = 2;");
		const removed = lines.find((l) => l.type === "removed");
		const added = lines.find((l) => l.type === "added");
		// The removed row must contain no additions, and vice versa.
		expect(removed?.wordChanges?.some((c) => c.added)).toBe(false);
		expect(added?.wordChanges?.some((c) => c.removed)).toBe(false);
		// Reassembling each row's chunks reproduces that row's content exactly.
		expect(removed?.wordChanges?.map((c) => c.value).join("")).toBe("const a = 1;");
		expect(added?.wordChanges?.map((c) => c.value).join("")).toBe("const a = 2;");
		// The shared prefix survives as an unchanged chunk.
		expect(removed?.wordChanges?.some((c) => !c.added && !c.removed)).toBe(true);
	});

	it("omits word changes for unpaired insertions and deletions", () => {
		// `b` is an unpaired addition (nothing was removed opposite it), so there is
		// no counterpart to word-diff against.
		const inserted = computeDiff("a\n", "a\nb\n").find((l) => l.content === "b");
		expect(inserted?.type).toBe("added");
		expect(inserted?.wordChanges).toBeUndefined();
	});

	it("skips the word diff for lines beyond the per-line budget", () => {
		const long = "x".repeat(3_000);
		const lines = computeDiff(long, `${long}y`);
		// 3000 + 3001 > MAX_WORD_DIFF_CHARS (4000) → no quadratic word diff.
		expect(lines.find((l) => l.type === "removed")?.wordChanges).toBeUndefined();
	});
});

describe("normalizeDiffLineEndings", () => {
	it("folds CRLF and lone CR to LF", () => {
		expect(normalizeDiffLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
	});

	it("makes line-ending-only changes produce no edits", () => {
		const lines = computeDiff("a\r\nb\r\n", "a\nb\n");
		expect(lines.every((l) => l.type === "context")).toBe(true);
	});
});

describe("gutter formatting", () => {
	it("right-aligns a number to the column width", () => {
		expect(formatDiffLineNumber(7, 3)).toBe("  7");
		expect(formatDiffLineNumber(123, 3)).toBe("123");
	});

	it("renders blanks when a side has no number", () => {
		expect(formatDiffLineNumber(undefined, 3)).toBe("   ");
	});

	it("applies the provisional prefix inside the column width", () => {
		expect(formatDiffLineNumber(4, 3, "xx")).toBe("xx4");
		expect(formatDiffLineNumber(4, 4, "xx")).toBe(" xx4");
	});

	it("produces the same total width for every row type", () => {
		const lines = computeDiff("a\nb", "a\nB", 1);
		const width = diffLineNoWidth(lines);
		const gutters = lines.map((l) => formatDiffGutter(l, width));
		// Fixed width is what makes the code column start at the same offset.
		expect(new Set(gutters.map((g) => g.length)).size).toBe(1);
		// `oldNo + ' ' + newNo + marker`
		expect(gutters[0]).toHaveLength(width * 2 + 2);
	});

	it("builds the two-column gutter with the correct markers", () => {
		const lines = computeDiff("a\nb", "a\nB", 1);
		// Layout: `oldNo` + one space + `newNo` + marker, each column 3 wide.
		// A missing number becomes blanks so the columns still line up.
		expect(lines.map((l) => formatDiffGutter(l, 3))).toEqual([
			"  1   1 ", // context: both sides numbered, space marker
			"  2    -", // removed: old side only
			"      2+", // added: new side only
		]);
	});

	it("marks rows with a single character", () => {
		expect(diffLineMarker("removed")).toBe("-");
		expect(diffLineMarker("added")).toBe("+");
		expect(diffLineMarker("context")).toBe(" ");
	});

	it("widens the columns for large line numbers and honours the minimum", () => {
		expect(diffLineNoWidth([{ type: "context", content: "", oldLineNo: 5, newLineNo: 5 }])).toBe(2);
		expect(
			diffLineNoWidth([{ type: "context", content: "", oldLineNo: 12345, newLineNo: 12345 }]),
		).toBe(5);
		// The prefix counts toward the width, otherwise `xx` would overflow.
		expect(diffLineNoWidth([{ type: "added", content: "", newLineNo: 7 }], "xx")).toBe(3);
		expect(diffLineNoWidth([{ type: "added", content: "", newLineNo: 700 }], "xx")).toBe(5);
	});
});

describe("buildDiffHighlightSource", () => {
	it("joins row contents without markers or gutters", () => {
		const lines = computeDiff("a\nb", "a\nB");
		expect(buildDiffHighlightSource(lines)).toBe("a\nb\nB");
	});

	it("returns null past the highlight budget instead of a huge string", () => {
		const huge: DiffLine[] = Array.from({ length: 200 }, () => ({
			type: "context" as const,
			content: "x".repeat(1_000),
		}));
		expect(buildDiffHighlightSource(huge)).toBeNull();
	});
});

describe("bounds", () => {
	it("caps the emitted row count", () => {
		const oldStr = Array.from({ length: 2_000 }, (_, i) => `old ${i}`).join("\n");
		const newStr = Array.from({ length: 2_000 }, (_, i) => `new ${i}`).join("\n");
		expect(computeDiff(oldStr, newStr).length).toBeLessThanOrEqual(MAX_DIFF_LINES);
	});

	it("clamps an over-long single line", () => {
		const lines = computeDiff("a", `${"b".repeat(9_000)}`);
		const added = lines.find((l) => l.type === "added");
		// 4000-char clamp plus the " …" marker.
		expect(added?.content.length).toBeLessThan(4_100);
		expect(added?.content.endsWith("…")).toBe(true);
	});

	it("falls back to a bounded preview for an oversized input", () => {
		const big = "x\n".repeat(150_000);
		const lines = computeDiff(big, `${big}y`);
		expect(lines.length).toBeLessThanOrEqual(MAX_DIFF_LINES);
		// The preview announces itself rather than silently truncating.
		expect(lines[0]?.content).toContain("too large");
	});
});

/**
 * The memo is a PERFORMANCE fix for the layout path (the adapter re-classifies
 * every tool card on every rebuild), so these tests assert both halves: it must
 * return the identical rows a fresh computation would, and it must stay bounded.
 */
describe("computeDiffCached", () => {
	beforeEach(() => {
		resetDiffCache();
	});

	it("returns the same rows the uncached computation does", () => {
		const oldStr = "a\nb\nc";
		const newStr = "a\nB\nc";
		expect(computeDiffCached(oldStr, newStr, 1)).toEqual(computeDiff(oldStr, newStr, 1));
	});

	it("returns the SAME array instance on a repeat call", () => {
		const oldStr = "const a = 1;\nkeep";
		const newStr = "const a = 2;\nkeep";
		const first = computeDiffCached(oldStr, newStr, 7);
		expect(computeDiffCached(oldStr, newStr, 7)).toBe(first);
		expect(diffCacheStats().entries).toBe(1);
	});

	it("keys on startLine, so the same texts at a different offset recompute", () => {
		const first = computeDiffCached("a\nb", "a\nB", 1);
		const second = computeDiffCached("a\nb", "a\nB", 40);
		expect(second).not.toBe(first);
		expect(second[0]?.oldLineNo).toBe(40);
		expect(diffCacheStats().entries).toBe(2);
	});

	it("does not confuse two inputs that share length and sampled edges", () => {
		// Same length, same head/middle/tail sample → same bucket key. The stored
		// strings must still be compared, or one edit would render as another.
		const head = "h".repeat(64);
		const tail = "t".repeat(64);
		const a = `${head}AAAA${tail}`;
		const b = `${head}BBBB${tail}`;
		const first = computeDiffCached(a, `${a}\nz`, 1);
		const second = computeDiffCached(b, `${b}\nz`, 1);
		expect(second).not.toBe(first);
		expect(second.some((l) => l.content.includes("BBBB"))).toBe(true);
	});

	it("bounds the retained entries", () => {
		for (let i = 0; i < 400; i++) {
			computeDiffCached(`old ${i}`, `new ${i}`, 1);
		}
		expect(diffCacheStats().entries).toBeLessThanOrEqual(192);
	});

	it("bounds the retained rows for large diffs", () => {
		for (let i = 0; i < 80; i++) {
			const oldStr = Array.from({ length: 400 }, (_, n) => `old ${i}-${n}`).join("\n");
			const newStr = Array.from({ length: 400 }, (_, n) => `new ${i}-${n}`).join("\n");
			computeDiffCached(oldStr, newStr, 1);
		}
		const stats = diffCacheStats();
		expect(stats.rows).toBeLessThanOrEqual(24_000);
		expect(stats.entries).toBeGreaterThan(0);
	});

	it("makes a repeated large diff cheap (the reason it exists)", () => {
		const oldStr = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
		const newStr = Array.from({ length: 400 }, (_, i) => `LINE ${i}`).join("\n");
		computeDiffCached(oldStr, newStr, 1);
		const started = performance.now();
		for (let i = 0; i < 50; i++) computeDiffCached(oldStr, newStr, 1);
		// 50 uncached calls on this input take seconds; 50 hits are sub-millisecond.
		expect(performance.now() - started).toBeLessThan(50);
	});
});
