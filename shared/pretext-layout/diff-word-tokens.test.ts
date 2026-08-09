/**
 * diff-word-tokens.test.ts — Contract for word-chunk × token intersection.
 *
 * The properties that matter to the render layer:
 *   - the character sequence is preserved exactly (colours may not shift text)
 *   - a token straddling a chunk boundary is split and keeps its colour on both
 *     sides
 *   - any length disagreement returns null, so the caller renders plain chunks
 *     rather than mis-aligned colours
 */

import { describe, expect, it } from "bun:test";
import type { DiffWordChange } from "./diff-core";
import { type DiffHighlightToken, sliceTokensByWordChanges } from "./diff-word-tokens";

const tok = (content: string, color?: string): DiffHighlightToken =>
	color === undefined ? { content } : { content, color };

/** Flatten a slice result back to text, to assert nothing was lost or reordered. */
const textOf = (result: ReturnType<typeof sliceTokensByWordChanges> | null) =>
	(result ?? []).map((entry) => entry.tokens.map((t) => t.content).join("")).join("");

describe("sliceTokensByWordChanges — alignment", () => {
	it("splits tokens on chunk boundaries and preserves the exact text", () => {
		// "if (" unchanged, "x" removed, ") {" unchanged
		const chunks: DiffWordChange[] = [
			{ value: "if (" },
			{ value: "x", removed: true },
			{ value: ") {" },
		];
		const tokens = [tok("if", "#kw"), tok(" ("), tok("x", "#var"), tok(") {")];

		const result = sliceTokensByWordChanges(tokens, chunks);
		expect(result).not.toBeNull();
		expect(textOf(result)).toBe("if (x) {");
		expect(result?.map((e) => e.tokens.map((t) => t.content))).toEqual([
			["if", " ("],
			["x"],
			[") {"],
		]);
	});

	it("splits a token that straddles a boundary, keeping its colour on both sides", () => {
		// One token "abcd" spans two chunks ("ab" | "cd").
		const chunks: DiffWordChange[] = [{ value: "ab" }, { value: "cd", added: true }];
		const result = sliceTokensByWordChanges([tok("abcd", "#same")], chunks);

		expect(result?.map((e) => e.tokens)).toEqual([
			[{ content: "ab", color: "#same" }],
			[{ content: "cd", color: "#same" }],
		]);
	});

	it("carries each chunk's added/removed flag through unchanged", () => {
		const chunks: DiffWordChange[] = [
			{ value: "a", removed: true },
			{ value: "b", added: true },
			{ value: "c" },
		];
		const result = sliceTokensByWordChanges([tok("abc")], chunks);

		expect(result?.map((e) => [e.chunk.removed, e.chunk.added])).toEqual([
			[true, undefined],
			[undefined, true],
			[undefined, undefined],
		]);
	});

	it("keeps a colourless token colourless", () => {
		const result = sliceTokensByWordChanges([tok("ab")], [{ value: "ab" }]);
		expect(result?.[0]?.tokens).toEqual([{ content: "ab" }]);
	});

	it("preserves a zero-length chunk without consuming tokens", () => {
		const chunks: DiffWordChange[] = [{ value: "" }, { value: "ab" }];
		const result = sliceTokensByWordChanges([tok("ab")], chunks);

		expect(result?.map((e) => e.tokens.length)).toEqual([0, 1]);
		expect(textOf(result)).toBe("ab");
	});
});

describe("sliceTokensByWordChanges — safe degradation", () => {
	it("returns null when tokens cover more text than the chunks", () => {
		expect(sliceTokensByWordChanges([tok("abcd")], [{ value: "ab" }])).toBeNull();
	});

	it("returns null when chunks cover more text than the tokens", () => {
		expect(sliceTokensByWordChanges([tok("ab")], [{ value: "abcd" }])).toBeNull();
	});

	it("returns null for absent or empty input on either side", () => {
		expect(sliceTokensByWordChanges(null, [{ value: "a" }])).toBeNull();
		expect(sliceTokensByWordChanges(undefined, [{ value: "a" }])).toBeNull();
		expect(sliceTokensByWordChanges([tok("a")], null)).toBeNull();
		expect(sliceTokensByWordChanges([tok("a")], [])).toBeNull();
		expect(sliceTokensByWordChanges([], [{ value: "a" }])).toBeNull();
	});
});
