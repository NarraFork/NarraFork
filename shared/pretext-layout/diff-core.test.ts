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
	countDiffLineStats,
	countTextLines,
	createDiffDocument,
	type DiffLine,
	type DiffSourcePoint,
	diffDocumentCacheStats,
	diffDocumentLineNoWidth,
	diffLineMarker,
	diffLineNoWidth,
	formatDiffGutter,
	formatDiffLineNumber,
	getDiffRowAnchor,
	MAX_DIFF_INPUT_CHARS,
	MAX_DIFF_LINES,
	normalizeDiffLineEndings,
	projectDiffDocument,
	readDiffRowContent,
	resetDiffDocumentCache,
	resolveDiffSourcePoint,
} from "./diff-core";
import { appendSourceText, createSourceText, reconcileSourceText } from "./source-text";

/** Small-fixture projection; source caching and bounds are tested separately below. */
const projectTextRows = (oldText: string, newText: string, startLine?: number) =>
	projectDiffDocument(createDiffDocument({ oldText, newText, startLine }), { startRow: 0 }).lines;

const shape = (lines: DiffLine[]) => lines.map((l) => [l.type, l.content]);
const numbers = (lines: DiffLine[]) => lines.map((l) => [l.oldLineNo, l.newLineNo]);

describe("streaming source completeness", () => {
	it("does not treat a known live frontier as omitted source content", () => {
		const source = appendSourceText(createSourceText("", { epoch: "stream" }), "a\nb", 16_000);
		const doc = createDiffDocument({
			oldText: source.text,
			newText: source.text,
			oldRange: source.range,
			newRange: source.range,
			startLine: 445,
		});
		expect(source.range.complete).toBe(false);
		expect(doc.truncated).toBe(false);
		expect(doc.omission).toBeNull();
		expect(numbers(projectDiffDocument(doc).lines)).toEqual([
			[445, 445],
			[446, 446],
		]);
		const staticPrefix = createDiffDocument({
			oldText: source.text,
			newText: source.text,
			oldRange: { ...source.range, streaming: false },
			newRange: source.range,
			startLine: 445,
		});
		expect(staticPrefix.omission).toBe("source-range");
		expect(staticPrefix.revision).not.toBe(doc.revision);
	});

	it("still marks actually missing heads and unverified reconnect tails as partial", () => {
		for (const source of [
			appendSourceText(createSourceText("", { epoch: "stream" }), "head\ntail", 4),
			appendSourceText(
				createSourceText("", { epoch: "reconnect", originKnown: false }),
				"tail",
				16_000,
			),
		]) {
			expect(
				createDiffDocument({
					oldText: "old",
					newText: source.text,
					newRange: source.range,
				}).omission,
			).toBe("source-range");
		}
	});

	it("marks only the unknown side of the line-number gutter as provisional", () => {
		const row: DiffLine = { type: "context", content: "}", oldLineNo: 446, newLineNo: 2 };
		expect(formatDiffGutter(row, 4, { new: "~" })).toBe(" 446   ~2 ");
		expect(formatDiffGutter(row, 4, { old: "~" })).toBe("~446    2 ");
	});
});

describe("document projection — line classification", () => {
	it("keeps unchanged lines as context instead of removing and re-adding them", () => {
		// The regression this locks down: a naive implementation emits
		// [removed a, removed b, added a, added B], losing the fact that `a` is
		// unchanged and destroying the line numbering.
		expect(shape(projectTextRows("a\nb", "a\nB"))).toEqual([
			["context", "a"],
			["removed", "b"],
			["added", "B"],
		]);
	});

	it("reports a pure insertion with no removed rows", () => {
		expect(shape(projectTextRows("a\n", "a\nb\n"))).toEqual([
			["context", "a"],
			["added", "b"],
		]);
	});

	it("reports a pure deletion with no added rows", () => {
		expect(shape(projectTextRows("a\nb\n", "a\n"))).toEqual([
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
		expect(shape(projectTextRows("a", "a\nb"))).toEqual([
			["removed", "a"],
			["added", "a"],
			["added", "b"],
		]);
	});

	it("handles an empty old side (whole body added)", () => {
		expect(shape(projectTextRows("", "x\ny"))).toEqual([
			["added", "x"],
			["added", "y"],
		]);
	});

	it("handles an empty new side (whole body removed)", () => {
		expect(shape(projectTextRows("x\ny", ""))).toEqual([
			["removed", "x"],
			["removed", "y"],
		]);
	});

	it("returns no rows when both sides are identical and empty", () => {
		expect(projectTextRows("", "")).toEqual([]);
	});

	it("emits all context when the two sides are identical", () => {
		const lines = projectTextRows("a\nb\nc", "a\nb\nc");
		expect(lines.every((l) => l.type === "context")).toBe(true);
		expect(lines).toHaveLength(3);
	});

	it("pairs uneven modification blocks, then lists the leftovers", () => {
		// 3 removed vs 1 added: one pair, then two unpaired removals.
		expect(shape(projectTextRows("a\nb\nc", "X"))).toEqual([
			["removed", "a"],
			["added", "X"],
			["removed", "b"],
			["removed", "c"],
		]);
	});
});

describe("document projection — line numbers", () => {
	it("numbers context on both sides and each change on its own side only", () => {
		expect(numbers(projectTextRows("a\nb", "a\nB"))).toEqual([
			[1, 1],
			[2, undefined],
			[undefined, 2],
		]);
	});

	it("offsets every row by startLine", () => {
		expect(numbers(projectTextRows("a\nb", "a\nB", 42))).toEqual([
			[42, 42],
			[43, undefined],
			[undefined, 43],
		]);
	});

	it("keeps the two sides diverging after an insertion", () => {
		// Adding a line makes the new side run one ahead of the old side.
		const lines = projectTextRows("a\nz", "a\nb\nz");
		expect(numbers(lines)).toEqual([
			[1, 1],
			[undefined, 2],
			[2, 3],
		]);
	});
});

describe("document projection — word-level changes", () => {
	it("marks only the differing token inside a modified pair", () => {
		const lines = projectTextRows("const a = 1;", "const a = 2;");
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
		const inserted = projectTextRows("a\n", "a\nb\n").find((l) => l.content === "b");
		expect(inserted?.type).toBe("added");
		expect(inserted?.wordChanges).toBeUndefined();
	});

	it("skips the word diff for lines beyond the per-line budget", () => {
		const long = "x".repeat(3_000);
		const lines = projectTextRows(long, `${long}y`);
		// 3000 + 3001 > MAX_WORD_DIFF_CHARS (4000) → no quadratic word diff.
		expect(lines.find((l) => l.type === "removed")?.wordChanges).toBeUndefined();
	});
});

describe("normalizeDiffLineEndings", () => {
	it("folds CRLF and lone CR to LF", () => {
		expect(normalizeDiffLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
	});

	it("makes line-ending-only changes produce no edits", () => {
		const lines = projectTextRows("a\r\nb\r\n", "a\nb\n");
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
		const lines = projectTextRows("a\nb", "a\nB", 1);
		const width = diffLineNoWidth(lines);
		const gutters = lines.map((l) => formatDiffGutter(l, width));
		// Fixed width is what makes the code column start at the same offset.
		expect(new Set(gutters.map((g) => g.length)).size).toBe(1);
		// `oldNo + ' ' + newNo + marker`
		expect(gutters[0]).toHaveLength(width * 2 + 2);
	});

	it("builds the two-column gutter with the correct markers", () => {
		const lines = projectTextRows("a\nb", "a\nB", 1);
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
		const lines = projectTextRows("a\nb", "a\nB");
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
		expect(projectTextRows(oldStr, newStr).length).toBeLessThanOrEqual(MAX_DIFF_LINES);
	});

	it("clamps an over-long single line", () => {
		const lines = projectTextRows("a", `${"b".repeat(9_000)}`);
		const added = lines.find((l) => l.type === "added");
		// 4000-char clamp plus the " …" marker.
		expect(added?.content.length).toBeLessThan(4_100);
		expect(added?.content.endsWith("…")).toBe(true);
	});

	it("marks an oversized bounded diff without injecting a fake source row", () => {
		const big = "x\n".repeat(150_000);
		const doc = createDiffDocument({ oldText: big, newText: `${big}y`, focusSide: "new" });
		const projection = projectDiffDocument(doc);
		expect(projection.lines.length).toBeLessThanOrEqual(MAX_DIFF_LINES);
		expect(doc.omission).toBe("input-budget");
		expect(doc.truncated).toBe(true);
		expect(projection.lines[projection.focusIndex]?.content).toBe("y");
	});
});

/**
 * The memo is a PERFORMANCE fix for the layout path (the adapter re-classifies
 * every tool card on every rebuild), so these tests assert both halves: it must
 * return the identical rows a fresh computation would, and it must stay bounded.
 */
describe("createDiffDocument source cache", () => {
	beforeEach(() => {
		resetDiffDocumentCache();
	});

	it("rebuilds the same source runs and projected rows after clearing the cache", () => {
		const input = { oldText: "a\nb\nc", newText: "a\nB\nc", startLine: 1 };
		const cached = createDiffDocument(input);
		resetDiffDocumentCache();
		const rebuilt = createDiffDocument(input);
		expect(rebuilt).not.toBe(cached);
		expect(rebuilt.runs).toEqual(cached.runs);
		expect(projectDiffDocument(rebuilt)).toEqual(projectDiffDocument(cached));
	});

	it("shares the document but never a reader's projected rows on repeat calls", () => {
		const input = { oldText: "const a = 1;\nkeep", newText: "const a = 2;\nkeep", startLine: 7 };
		const first = createDiffDocument(input);
		expect(createDiffDocument(input)).toBe(first);
		const projection = projectDiffDocument(first);
		expect(projectDiffDocument(first).lines).not.toBe(projection.lines);
		expect(diffDocumentCacheStats().entries).toBe(1);
	});

	it("keys on startLine, so the same texts at a different offset recompute", () => {
		const input = { oldText: "a\nb", newText: "a\nB" };
		const first = createDiffDocument({ ...input, startLine: 1 });
		const second = createDiffDocument({ ...input, startLine: 40 });
		expect(second).not.toBe(first);
		expect(projectDiffDocument(second).lines[0]?.oldLineNo).toBe(40);
		expect(diffDocumentCacheStats().entries).toBe(2);
	});

	it("does not confuse two inputs that share length and sampled edges", () => {
		// The changed region is outside the head/middle/tail samples. Exact source
		// equality must reject the bucket collision before reusing cached runs.
		const prefix = "h".repeat(64);
		const suffix = "t".repeat(256);
		const a = `${prefix}AAAA${suffix}`;
		const b = `${prefix}BBBB${suffix}`;
		const first = createDiffDocument({ oldText: a, newText: `${a}\nz`, startLine: 1 });
		const second = createDiffDocument({ oldText: b, newText: `${b}\nz`, startLine: 1 });
		expect(second).not.toBe(first);
		expect(projectDiffDocument(second).lines.some((line) => line.content.includes("BBBB"))).toBe(
			true,
		);
	});

	it("bounds the retained source document entries", () => {
		for (let i = 0; i < 400; i++) {
			createDiffDocument({ oldText: `old ${i}`, newText: `new ${i}` });
		}
		expect(diffDocumentCacheStats().entries).toBeLessThanOrEqual(192);
	});

	it("bounds retained source characters instead of retaining projected rows and words", () => {
		for (let i = 0; i < 24; i++) {
			const text = `${"line\n".repeat(16_000)}${i}`;
			const doc = createDiffDocument({ oldText: text, newText: `${text}!` });
			const beforeProjection = diffDocumentCacheStats();
			projectDiffDocument(doc);
			expect(diffDocumentCacheStats()).toEqual(beforeProjection);
		}
		const stats = diffDocumentCacheStats();
		expect(stats.chars).toBeLessThanOrEqual(MAX_DIFF_INPUT_CHARS * 10);
		expect(stats.entries).toBeGreaterThan(0);
	});

	it("makes a repeated large source document cheap without rehashing or projecting it", () => {
		const input = {
			oldText: Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n"),
			newText: Array.from({ length: 400 }, (_, i) => `LINE ${i}`).join("\n"),
			startLine: 1,
		};
		const first = createDiffDocument(input);
		const started = performance.now();
		for (let i = 0; i < 50; i++) expect(createDiffDocument(input)).toBe(first);
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

describe("DiffDocument — source runs and independent viewport projections", () => {
	const text = (count: number) => Array.from({ length: count }, (_, i) => `${i}\n`).join("");
	const anchorAt = (
		doc: ReturnType<typeof createDiffDocument>,
		row: number,
		side: "old" | "new" = "new",
	) => {
		const point = getDiffRowAnchor(doc, row, side);
		if (!point) throw new Error("missing test anchor");
		return point;
	};

	it("shares all line runs, not a first-500-row projection or word-change objects", () => {
		const doc = createDiffDocument({
			oldText: text(2_000),
			newText: text(2_000),
			focusSide: "new",
		});
		expect(doc.totalRows).toBe(2_000);
		expect(doc.runs).toHaveLength(1);
		expect(doc.oldSource.lineStarts).toHaveLength(2_000);
		expect(JSON.stringify(doc)).not.toContain("wordChanges");
		const follow = projectDiffDocument(doc);
		expect(follow.lines).toHaveLength(500);
		expect(follow.lines[follow.focusIndex]?.newPoint?.line).toBe(1_999);
		expect(follow.beforeRows).toBe(1_500);
		expect(follow.afterRows).toBe(0);
		expect(projectDiffDocument(doc).lines).not.toBe(follow.lines);
	});

	it("lets a follower cross multiple 500-row boundaries while a reader keeps row 200", () => {
		const oldText = text(2_000);
		let doc = createDiffDocument({ oldText, newText: text(450), focusSide: "new" });
		const reader = anchorAt(doc, 200);
		const original = projectDiffDocument(doc, { anchor: reader });
		for (const count of [650, 1_200, 1_750, 2_000]) {
			doc = createDiffDocument({ oldText, newText: text(count), focusSide: "new" });
			const follower = projectDiffDocument(doc);
			const paused = projectDiffDocument(doc, { anchor: reader });
			expect(follower.lines[follower.focusIndex]?.newPoint?.line).toBe(count - 1);
			expect(paused.lines[paused.anchorIndex]?.newPoint?.line).toBe(200);
			expect(paused.anchorLost).toBe(false);
			expect(paused.anchor).toEqual(reader);
			expect(paused.lines.length).toBeLessThanOrEqual(500);
			expect(original.lines[original.anchorIndex]?.newPoint?.line).toBe(200);
		}
		expect(doc.totalRows).toBe(2_000);
	});

	it("puts new-side focus before the long remaining deletion suffix", () => {
		const doc = createDiffDocument({
			oldText: text(2_000),
			newText: "new content",
			focusSide: "new",
		});
		const projection = projectDiffDocument(doc);
		expect(doc.totalRows).toBe(2_001);
		expect(doc.focus?.side).toBe("new");
		expect(projection.lines[projection.focusIndex]?.type).toBe("added");
		expect(projection.lines[projection.focusIndex]?.row).toBe(1);
		expect(projection.afterRows).toBeGreaterThan(1_000);
	});

	it("keeps pairing and words when a projection starts in the second half of a pair", () => {
		const doc = createDiffDocument({
			oldText: "a\nb\nc\nsame\nd",
			newText: "X\nsame\ny\nz",
			startLine: 40,
		});
		const all = projectDiffDocument(doc, { startRow: 0 }).lines;
		expect(shape(all)).toEqual([
			["removed", "a"],
			["added", "X"],
			["removed", "b"],
			["removed", "c"],
			["context", "same"],
			["removed", "d"],
			["added", "y"],
			["added", "z"],
		]);
		const added = projectDiffDocument(doc, { startRow: 1, limit: 1 }).lines[0];
		expect(added?.wordChanges?.map((word) => word.value).join("")).toBe("X");
		expect(added?.newLineNo).toBe(40);
		for (const row of all) {
			for (const point of [row.oldPoint, row.newPoint]) {
				if (point) expect(resolveDiffSourcePoint(doc, point).row).toBe(row.row);
			}
		}
	});

	it("advances same-line focus and maps added→context without changing the source key", () => {
		const before = createDiffDocument({ oldText: "hello", newText: "he", focusSide: "new" });
		const after = createDiffDocument({ oldText: "hello", newText: "hello", focusSide: "new" });
		const previous = projectDiffDocument(before).lines.find((row) => row.type === "added");
		const current = projectDiffDocument(after).lines[0];
		if (!previous || !current) throw new Error("missing projected test row");
		expect(before.focus?.column).toBe(2);
		expect(after.focus?.column).toBe(5);
		expect(after.revision).not.toBe(before.revision);
		expect(current.key).toBe(previous.key);
		expect(current.type).toBe("context");
		expect(resolveDiffSourcePoint(after, before.focus as DiffSourcePoint).lost).toBe(false);
	});

	it("falls back to the affected old side for empty replacement and to no row for empty diff", () => {
		const deletion = createDiffDocument({ oldText: "a\nb", newText: "", focusSide: "new" });
		expect(deletion.focus).toMatchObject({ side: "old", line: 1 });
		expect(projectDiffDocument(deletion).focusIndex).toBe(1);
		const empty = createDiffDocument({ oldText: "", newText: "" });
		expect(projectDiffDocument(empty, { anchor: deletion.focus }).anchorLost).toBe(true);
		expect(projectDiffDocument(empty, { anchor: deletion.focus }).lines).toEqual([]);
		expect(projectDiffDocument(empty).startRow).toBe(0);
	});

	it("remaps retained source lines after 16k eviction, and clamps genuinely lost lines", () => {
		const initial = createSourceText("h\n".repeat(7_900), { epoch: "stream" });
		const first = createDiffDocument({
			oldText: "",
			newText: initial.text,
			newRange: initial.range,
			focusSide: "new",
		});
		const retained = anchorAt(first, 7_800);
		const lost = anchorAt(first, 4);
		const appended = appendSourceText(initial, "tail\n".repeat(300), 16_000);
		const next = createDiffDocument({
			oldText: "",
			newText: appended.text,
			newRange: appended.range,
			focusSide: "new",
		});
		const paused = projectDiffDocument(next, { anchor: retained });
		expect(paused.anchorLost).toBe(false);
		expect(paused.anchor?.line).toBe(7_800);
		const evicted = projectDiffDocument(next, { anchor: lost });
		expect(evicted.anchorLost).toBe(true);
		expect(evicted.anchorLossReason).toBe("range");
		expect(evicted.anchor?.line).toBe(appended.range.startLine);
		expect(evicted.anchor?.line).not.toBe(next.focus?.line);
	});

	it("keeps a partial first line's identity and clamps its in-line offset", () => {
		const initial = createSourceText("abcdef", { epoch: "stream" });
		const first = createDiffDocument({
			oldText: "",
			newText: initial.text,
			newRange: initial.range,
		});
		const point = { ...anchorAt(first, 0), column: 4, offset: 4 };
		const next = appendSourceText(initial, "ghi", 6);
		const doc = createDiffDocument({ oldText: "", newText: next.text, newRange: next.range });
		expect(resolveDiffSourcePoint(doc, point)).toMatchObject({
			lost: false,
			point: { line: 0, column: 4, offset: 4 },
		});
		expect(resolveDiffSourcePoint(doc, { ...point, column: 1, offset: 1 })).toMatchObject({
			lost: true,
			reason: "range",
			point: { line: 0, column: 3 },
		});
	});

	it("translates both readers through verified full completion, never through text search", () => {
		const preview = createSourceText("XYZ\ntail", { epoch: "unknown", originKnown: false });
		const first = createDiffDocument({
			oldText: "",
			newText: preview.text,
			newRange: preview.range,
			focusSide: "new",
			startLine: 80,
		});
		const inline = first.focus as DiffSourcePoint;
		const reader = { ...anchorAt(first, 0), column: 2, offset: 2 };
		expect(projectDiffDocument(first).lines[0]?.newLineNo).toBe(1);
		const complete = reconcileSourceText(preview, "header\nabcXYZ\ntail", { epoch: "unused" });
		const doc = createDiffDocument({
			oldText: "",
			newText: complete.text,
			newRange: complete.range,
			focusSide: "new",
			startLine: 80,
		});
		expect(resolveDiffSourcePoint(doc, reader)).toMatchObject({
			lost: false,
			point: { line: 1, column: 5, offset: 12 },
		});
		expect(resolveDiffSourcePoint(doc, inline)).toMatchObject({
			lost: false,
			point: { line: 2, column: 4 },
		});
		expect(projectDiffDocument(doc, { anchor: reader }).lines[1]?.newLineNo).toBe(81);
		const invalid = reconcileSourceText(preview, "XYZ\ntail\nother", { epoch: "unused" });
		const replaced = createDiffDocument({
			oldText: "",
			newText: invalid.text,
			newRange: invalid.range,
			focusSide: "new",
		});
		expect(projectDiffDocument(replaced, { anchor: reader })).toMatchObject({
			anchorLost: true,
			anchorLossReason: "epoch",
			anchorIndex: 0,
		});
		expect(projectDiffDocument(replaced, { anchor: reader }).anchor?.line).toBe(0);
	});

	it("keeps the focus in a bounded diff when the source exceeds 240k", () => {
		const huge = `${"repeat\n".repeat(50_000)}LATEST`;
		const doc = createDiffDocument({ oldText: huge, newText: `${huge}!`, focusSide: "new" });
		expect(doc.oldSource.text.length + doc.newSource.text.length).toBeLessThanOrEqual(
			MAX_DIFF_INPUT_CHARS,
		);
		expect(doc.omission).toBe("input-budget");
		expect(doc.truncated).toBe(true);
		const projection = projectDiffDocument(doc);
		expect(projection.lines.length).toBeLessThanOrEqual(500);
		expect(projection.lines[projection.focusIndex]?.content).toContain("LATEST!");
		expect(projection.lines.some((line) => line.type === "added")).toBe(true);
		expect(doc.focus?.line).toBe(50_000);
	});

	it("keeps static revisions stable when rebuilding more than 192 cached documents", () => {
		resetDiffDocumentCache();
		const inputs = Array.from({ length: 256 }, (_, index) => ({
			oldText: `before ${index}\nkeep`,
			newText: `after ${index}\nkeep`,
			startLine: index + 1,
		}));
		const original = inputs.map(createDiffDocument);
		for (let rebuild = 0; rebuild < 3; rebuild++) {
			for (const [index, input] of inputs.entries()) {
				const first = original[index];
				if (!first) throw new Error("missing original document");
				const rebuilt = createDiffDocument(input);
				expect(rebuilt).not.toBe(first);
				expect(rebuilt.revision).toBe(first.revision);
			}
		}
	});

	it("keeps revisions stable after the source-character cache budget evicts a document", () => {
		resetDiffDocumentCache();
		const inputs = Array.from({ length: 12 }, (_, index) => ({
			oldText: `${"x".repeat(80_000)}${index}`,
			newText: `${"x".repeat(80_000)}${index}`,
		}));
		const original = inputs.map(createDiffDocument);
		for (const [index, input] of inputs.entries()) {
			const first = original[index];
			if (!first) throw new Error("missing original document");
			const rebuilt = createDiffDocument(input);
			expect(rebuilt).not.toBe(first);
			expect(rebuilt.revision).toBe(first.revision);
			expect(rebuilt.revision).toHaveLength(21);
		}
	});

	it("fingerprints full bounded content and semantic range/focus options, not just samples", () => {
		const text = "x".repeat(400);
		const first = createDiffDocument({ oldText: "", newText: text });
		const changed = createDiffDocument({
			oldText: "",
			newText: `${text.slice(0, 70)}y${text.slice(71)}`,
		});
		expect(changed.focus).toEqual(first.focus);
		expect(changed.revision).not.toBe(first.revision);
		const range = createSourceText(text, { epoch: "known", complete: true }).range;
		const input = {
			oldText: text,
			newText: text,
			oldRange: range,
			newRange: range,
			focusSide: "new" as const,
		};
		const doc = createDiffDocument(input);
		expect(createDiffDocument({ ...input, focusSide: "old" }).revision).not.toBe(doc.revision);
		expect(createDiffDocument({ ...input, startLine: 20 }).revision).not.toBe(doc.revision);
		expect(
			createDiffDocument({ ...input, newRange: { ...range, epoch: "other" } }).revision,
		).not.toBe(doc.revision);
		expect(
			createDiffDocument({
				...input,
				newRange: {
					...range,
					startOffset: 10,
					endOffset: range.endOffset + 10,
					startColumn: 10,
					endColumn: range.endColumn + 10,
				},
			}).revision,
		).not.toBe(doc.revision);
	});

	it("does not include an unavailable oversized prefix in the bounded source fingerprint", () => {
		const text = `${"x".repeat(MAX_DIFF_INPUT_CHARS + 20)}tail`;
		const first = createDiffDocument({ oldText: "", newText: text, focusSide: "new" });
		resetDiffDocumentCache();
		const sameRetainedSource = createDiffDocument({
			oldText: "",
			newText: `y${text.slice(1)}`,
			focusSide: "new",
		});
		expect(sameRetainedSource.oldSource).toEqual(first.oldSource);
		expect(sameRetainedSource.newSource).toEqual(first.newSource);
		expect(sameRetainedSource.revision).toBe(first.revision);
	});

	it("memoizes only source-dependent documents and has bounded geometry-free probes", () => {
		const input = {
			oldText: text(2_000),
			newText: text(1_999),
			focusSide: "old" as const,
			startLine: 99,
		};
		const doc = createDiffDocument(input);
		expect(createDiffDocument(input)).toBe(doc);
		projectDiffDocument(doc, { anchor: anchorAt(doc, 20), limit: 50 });
		expect(createDiffDocument(input)).toBe(doc);
		expect(createDiffDocument({ ...input, focusSide: "new" }).revision).not.toBe(doc.revision);
		expect(readDiffRowContent(doc, 1_998)).toBe("1998");
		expect(readDiffRowContent(doc, -1)).toBeNull();
		expect(diffDocumentLineNoWidth(doc)).toBe(4);
		expect(projectDiffDocument(doc, { limit: 99_999 }).lines.length).toBe(500);
	});
});
