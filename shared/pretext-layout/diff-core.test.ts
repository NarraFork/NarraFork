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
	buildDiffHighlightPlan,
	buildDiffHighlightSource,
	computeDiff,
	computeDiffCached,
	countDiffLineStats,
	countTextLines,
	type DiffLine,
	diffCacheStats,
	diffLineMarker,
	diffLineNoWidth,
	formatDiffGutter,
	formatDiffLineNumber,
	MAX_DIFF_INPUT_CHARS,
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

describe("buildDiffHighlightPlan", () => {
	/** Read back what a row would be tokenized as, following its own row ref. */
	function resolve(plan: NonNullable<ReturnType<typeof buildDiffHighlightPlan>>, row: number) {
		const ref = plan.rows[row];
		if (!ref) throw new Error(`no row ref at ${row}`);
		return plan.sources[ref.source]?.split("\n")[ref.line];
	}

	it("keeps one source when the diff touches a single side", () => {
		const added = buildDiffHighlightPlan([
			{ type: "context", content: "a" },
			{ type: "added", content: "b" },
		]);
		expect(added?.sources).toEqual(["a\nb"]);
		expect(added?.rows).toEqual([
			{ source: 0, line: 0 },
			{ source: 0, line: 1 },
		]);

		const removed = buildDiffHighlightPlan([
			{ type: "context", content: "a" },
			{ type: "removed", content: "b" },
		]);
		expect(removed?.sources).toEqual(["a\nb"]);
	});

	it("splits the sides so a removed construct cannot leak into context", () => {
		// The real-world shape: the old side opens a block comment that the new side
		// replaced with a line comment. Merged into one document, the untouched
		// `const value = 1;` sits inside the still-open comment.
		const plan = buildDiffHighlightPlan([
			{ type: "removed", content: "/* legacy note" },
			{ type: "added", content: "// short note" },
			{ type: "context", content: "const value = 1;" },
			{ type: "removed", content: "*/" },
			{ type: "added", content: "const kept = 2;" },
		]);

		expect(plan?.sources).toEqual([
			"/* legacy note\nconst value = 1;\n*/",
			"// short note\nconst value = 1;\nconst kept = 2;",
		]);
		// Removed rows read the old file; context and added rows read the new file.
		expect(plan?.rows).toEqual([
			{ source: 0, line: 0 },
			{ source: 1, line: 0 },
			{ source: 1, line: 1 },
			{ source: 0, line: 2 },
			{ source: 1, line: 2 },
		]);
	});

	it("points every row at its own content, whichever side it came from", () => {
		const lines: DiffLine[] = [
			{ type: "context", content: "head" },
			{ type: "removed", content: "gone" },
			{ type: "added", content: "fresh" },
			{ type: "context", content: "tail" },
		];
		const plan = buildDiffHighlightPlan(lines);
		if (!plan) throw new Error("expected a plan");

		// The row → (source, line) mapping is the whole contract: a drift here would
		// paint a row with another row's colours.
		for (const [index, line] of lines.entries()) {
			expect(resolve(plan, index)).toBe(line.content);
		}
	});

	it("charges both sides to one budget instead of doubling the work ceiling", () => {
		// Context is written to BOTH sides, so 60 x 1000 chars of context bills ~120k
		// against the 80k ceiling even though the interleaved string would have fit.
		const wide: DiffLine[] = [
			{ type: "removed", content: "x" },
			{ type: "added", content: "y" },
			...Array.from({ length: 60 }, () => ({
				type: "context" as const,
				content: "z".repeat(1_000),
			})),
		];
		expect(buildDiffHighlightPlan(wide)).toBeNull();
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

describe("countDiffLineStats", () => {
	it("counts a modified line as one added and one removed", () => {
		expect(countDiffLineStats("a\nb\nc", "a\nB\nc")).toEqual({ added: 1, removed: 1 });
	});

	it("counts pure insertions and pure deletions", () => {
		expect(countDiffLineStats("a\n", "a\nb\nc\n")).toEqual({ added: 2, removed: 0 });
		expect(countDiffLineStats("a\nb\nc\n", "a\n")).toEqual({ added: 0, removed: 2 });
	});

	it("counts a new file's every line as an addition", () => {
		expect(countDiffLineStats("", "x\ny\nz")).toEqual({ added: 3, removed: 0 });
	});

	it("reports zero changes for identical text", () => {
		expect(countDiffLineStats("a\nb", "a\nb")).toEqual({ added: 0, removed: 0 });
	});

	/**
	 * A CRLF→LF conversion is not an edit to every line. Without normalization the
	 * whole file would be reported as rewritten, which is exactly the kind of
	 * confidently-wrong figure this feature must not produce.
	 */
	it("ignores a pure line-ending difference", () => {
		expect(countDiffLineStats("a\r\nb\r\n", "a\nb\n")).toEqual({ added: 0, removed: 0 });
	});

	/**
	 * `null` is "no data", never zero. Two sources, both asserted here, because a
	 * caller that mistook either for `{added: 0, removed: 0}` would render a large
	 * rewrite as having changed nothing.
	 */
	it("returns null when the input exceeds the shared ceiling", () => {
		const huge = "x".repeat(MAX_DIFF_INPUT_CHARS);
		expect(countDiffLineStats(huge, `${huge}y`)).toBeNull();
	});

	it("returns null when the input exceeds a caller's smaller ceiling", () => {
		expect(countDiffLineStats("aaaa", "bbbb", { maxInputChars: 4 })).toBeNull();
		// The caller's bound only ever TIGHTENS: it cannot raise the shared ceiling.
		const huge = "x".repeat(MAX_DIFF_INPUT_CHARS);
		expect(
			countDiffLineStats(huge, `${huge}y`, { maxInputChars: Number.MAX_SAFE_INTEGER }),
		).toBeNull();
	});

	/**
	 * The computation budget must be REACHABLE, or it is decoration — and on the
	 * server's single JS thread an unbounded Myers run is the failure this whole
	 * mechanism exists to prevent.
	 *
	 * Two fully-disjoint 11k-line texts fit well inside the input ceiling (the
	 * premise is asserted, so a null here cannot come from the size bound) yet need
	 * an edit distance of ~22k — above `maxEditLength`, and expensive enough to also
	 * trip `timeout`. Which arm fires first is machine-dependent, which is precisely
	 * why both exist; the contract is that the call ABORTS rather than running to
	 * completion, so the elapsed time is bounded too.
	 */
	it("returns null when the computation budget is exhausted", () => {
		const oldStr = Array.from({ length: 11_000 }, (_, i) => `o${i}`).join("\n");
		const newStr = Array.from({ length: 11_000 }, (_, i) => `w${i}`).join("\n");
		expect(oldStr.length + newStr.length).toBeLessThanOrEqual(MAX_DIFF_INPUT_CHARS);
		const started = performance.now();
		expect(countDiffLineStats(oldStr, newStr)).toBeNull();
		// Generous vs. the 150ms budget (CI is slow) but far below the seconds an
		// unbounded run on this input would take.
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	/** Bounded runtime is the whole point on the server's single thread. */
	it("stays fast on a large but tractable input", () => {
		const oldStr = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join("\n");
		const newStr = Array.from({ length: 2_000 }, (_, i) =>
			i === 900 ? "changed" : `line ${i}`,
		).join("\n");
		const started = performance.now();
		expect(countDiffLineStats(oldStr, newStr)).toEqual({ added: 1, removed: 1 });
		expect(performance.now() - started).toBeLessThan(300);
	});
});

describe("countTextLines", () => {
	it("counts lines without inventing one for a trailing newline", () => {
		expect(countTextLines("")).toBe(0);
		expect(countTextLines("a")).toBe(1);
		expect(countTextLines("a\nb")).toBe(2);
		expect(countTextLines("a\nb\n")).toBe(2);
	});
});
