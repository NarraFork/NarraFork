/**
 * vlist-token-lines.test.ts — Alignment contract for the token re-slicer.
 *
 * The failure this locks down is mis-coloured code: Shiki cuts by physical line,
 * pretext cuts by visual line, and if the two streams drift by even one character
 * every colour after that point lands on the wrong glyph. The tests therefore
 * assert three properties:
 *
 *   1. Concatenating a line's token contents reproduces that visual line's text
 *      EXACTLY (the alignment invariant).
 *   2. Hard breaks are consumed between physical lines; soft wraps are not (a
 *      wrapped physical line keeps flowing into the next visual line).
 *   3. Any drift degrades to an empty token list for that line, never to
 *      partially-shifted colours.
 */

import { describe, expect, it } from "bun:test";
import type { ShikiToken } from "@frontend/lib/shiki-token-cache";
import { splitTokensByVisualLines, type VisualLineText } from "./vlist-token-lines";

const lines = (...texts: string[]): VisualLineText[] => texts.map((text) => ({ text }));
const textOf = (tokens: readonly ShikiToken[]): string =>
	tokens.map((token) => token.content).join("");

/** Every produced line either matches its visual text exactly, or is empty. */
function expectAligned(
	split: ShikiToken[][] | null,
	visualLines: readonly VisualLineText[],
): asserts split is ShikiToken[][] {
	expect(split).not.toBeNull();
	if (!split) throw new Error("unreachable");
	expect(split).toHaveLength(visualLines.length);
	for (let i = 0; i < split.length; i++) {
		const produced = textOf(split[i] ?? []);
		if (produced.length > 0) expect(produced).toBe(visualLines[i]?.text ?? "");
	}
}

describe("splitTokensByVisualLines", () => {
	it("returns null when there are no tokens", () => {
		expect(splitTokensByVisualLines(null, lines("anything"))).toBeNull();
	});

	it("passes physical lines straight through when nothing wraps", () => {
		const tokens: ShikiToken[][] = [
			[
				{ content: "const", color: "#f00" },
				{ content: " a", color: "#0f0" },
			],
			[{ content: "let b", color: "#00f" }],
		];
		const visual = lines("const a", "let b");
		const split = splitTokensByVisualLines(tokens, visual);
		expectAligned(split, visual);
		expect(split[0]).toEqual([
			{ content: "const", color: "#f00" },
			{ content: " a", color: "#0f0" },
		]);
		expect(split[1]).toEqual([{ content: "let b", color: "#00f" }]);
	});

	it("splits ONE physical line across soft-wrapped visual lines", () => {
		// Shiki sees a single 12-char line; pretext wraps it into 5 + 7.
		const tokens: ShikiToken[][] = [
			[
				{ content: "abcde", color: "#f00" },
				{ content: "fghijkl", color: "#0f0" },
			],
		];
		const visual = lines("abcde", "fghijkl");
		const split = splitTokensByVisualLines(tokens, visual);
		expectAligned(split, visual);
		expect(split[0]).toEqual([{ content: "abcde", color: "#f00" }]);
		expect(split[1]).toEqual([{ content: "fghijkl", color: "#0f0" }]);
	});

	it("splits a soft wrap that falls INSIDE one token, preserving its colour", () => {
		const tokens: ShikiToken[][] = [[{ content: "abcdefgh", color: "#abc" }]];
		const visual = lines("abcd", "efgh");
		const split = splitTokensByVisualLines(tokens, visual);
		expectAligned(split, visual);
		expect(split[0]).toEqual([{ content: "abcd", color: "#abc" }]);
		expect(split[1]).toEqual([{ content: "efgh", color: "#abc" }]);
	});

	it("consumes the hard break between physical lines but not across a soft wrap", () => {
		// Physical line 1 wraps into two visual lines; then a hard break; then line 2.
		const tokens: ShikiToken[][] = [
			[{ content: "aaaabbbb", color: "#111" }],
			[{ content: "cccc", color: "#222" }],
		];
		const visual = lines("aaaa", "bbbb", "cccc");
		const split = splitTokensByVisualLines(tokens, visual);
		expectAligned(split, visual);
		expect(split[0]).toEqual([{ content: "aaaa", color: "#111" }]);
		expect(split[1]).toEqual([{ content: "bbbb", color: "#111" }]);
		// The `\n` was swallowed, so line 3 starts at the second physical line.
		expect(split[2]).toEqual([{ content: "cccc", color: "#222" }]);
	});

	it("handles blank physical lines (consecutive hard breaks)", () => {
		const tokens: ShikiToken[][] = [
			[{ content: "first", color: "#111" }],
			[],
			[{ content: "third", color: "#333" }],
		];
		const visual = lines("first", "", "third");
		const split = splitTokensByVisualLines(tokens, visual);
		expectAligned(split, visual);
		expect(textOf(split[0] ?? [])).toBe("first");
		expect(split[1]).toEqual([]);
		expect(textOf(split[2] ?? [])).toBe("third");
	});

	it("keeps whitespace-only tokens so indentation stays aligned", () => {
		const tokens: ShikiToken[][] = [
			[{ content: "  " }, { content: "return", color: "#f0f" }, { content: " x", color: "#0ff" }],
		];
		const visual = lines("  return x");
		const split = splitTokensByVisualLines(tokens, visual);
		expectAligned(split, visual);
		expect(textOf(split[0] ?? [])).toBe("  return x");
	});

	it("falls back to an empty line when the token stream runs short", () => {
		// pretext claims more text than Shiki tokenized (a desync).
		const tokens: ShikiToken[][] = [[{ content: "abc", color: "#f00" }]];
		const visual = lines("abc", "def");
		const split = splitTokensByVisualLines(tokens, visual);
		expectAligned(split, visual);
		expect(split[0]).toEqual([{ content: "abc", color: "#f00" }]);
		expect(split[1]).toEqual([]);
	});

	it("falls back to an empty line for a partially fillable line", () => {
		const tokens: ShikiToken[][] = [[{ content: "abcd", color: "#f00" }]];
		const visual = lines("abcdefgh");
		const split = splitTokensByVisualLines(tokens, visual);
		// Only 4 of 8 chars available → the whole line degrades, never shifts.
		expect(split?.[0]).toEqual([]);
	});

	it("ignores tokens left over when pretext has fewer lines", () => {
		const tokens: ShikiToken[][] = [
			[{ content: "keep", color: "#111" }],
			[{ content: "dropped", color: "#222" }],
		];
		const visual = lines("keep");
		const split = splitTokensByVisualLines(tokens, visual);
		expectAligned(split, visual);
		expect(split).toHaveLength(1);
	});

	it("returns the same array for repeated identical requests (memoized)", () => {
		const tokens: ShikiToken[][] = [[{ content: "abcd", color: "#f00" }]];
		const visual = lines("ab", "cd");
		const first = splitTokensByVisualLines(tokens, visual);
		const second = splitTokensByVisualLines(tokens, lines("ab", "cd"));
		expect(second).toBe(first);
	});

	it("recomputes when the visual line shape changes (resize)", () => {
		const tokens: ShikiToken[][] = [[{ content: "abcd", color: "#f00" }]];
		const narrow = splitTokensByVisualLines(tokens, lines("ab", "cd"));
		const wide = splitTokensByVisualLines(tokens, lines("abcd"));
		expect(narrow).toHaveLength(2);
		expect(wide).toHaveLength(1);
		expect(wide).not.toBe(narrow);
		// The narrow split is still cached and unchanged.
		expect(splitTokensByVisualLines(tokens, lines("ab", "cd"))).toBe(narrow);
	});

	it("handles an empty visual line list", () => {
		expect(splitTokensByVisualLines([[{ content: "x" }]], [])).toEqual([]);
	});

	it("aligns a realistic multi-line body with mixed wraps", () => {
		const tokens: ShikiToken[][] = [
			[
				{ content: "function", color: "#c678dd" },
				{ content: " ", color: undefined },
				{ content: "compute", color: "#61afef" },
				{ content: "(a, b) {", color: "#abb2bf" },
			],
			[
				{ content: "  return", color: "#c678dd" },
				{ content: " a + b;", color: "#abb2bf" },
			],
			[{ content: "}", color: "#abb2bf" }],
		];
		// Line 1 soft-wraps after "function comp"; the rest stay whole.
		const visual = lines("function comp", "ute(a, b) {", "  return a + b;", "}");
		const split = splitTokensByVisualLines(tokens, visual);
		expectAligned(split, visual);
		for (let i = 0; i < visual.length; i++) {
			expect(textOf(split[i] ?? [])).toBe(visual[i]?.text ?? "");
		}
		// The identifier keeps its colour on both sides of the wrap.
		expect(split[0]?.at(-1)?.color).toBe("#61afef");
		expect(split[1]?.[0]?.color).toBe("#61afef");
	});
});
