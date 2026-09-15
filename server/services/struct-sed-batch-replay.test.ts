/**
 * Replaying a StructSed batch.
 *
 * The failure this guards against is quiet: `applyStructSedCall` used to read only the flat
 * `resolvedStartLine`, so a recorded batch replayed as ONE edit and the remaining operations
 * vanished. Surrounding Write/Edit calls replay normally, so the rebuilt file looks
 * plausible and nothing reports the loss.
 *
 * The other property is ordering. Every recorded address is relative to the original file,
 * so replay must go bottom-up; applying them top-down shifts every later address by however
 * much the earlier ones grew or shrank the file.
 */

import { describe, expect, test } from "bun:test";
import { applyToolCall, ReplayDivergedError } from "./file-state-rebuild";

function call(inputJson: unknown) {
	return {
		toolUseId: "tu-batch-1",
		toolName: "StructSed",
		inputJson,
		status: "success",
		messageId: "m-1",
		seq: 1,
		createdAt: new Date().toISOString(),
	};
}

const FIVE = "a\nb\nc\nd\ne\n";

describe("batch replay", () => {
	test("every operation is replayed, not just the first", () => {
		expect(
			applyToolCall(
				FIVE,
				call({
					operations: [
						{ command: "delete", resolvedStartLine: 1, resolvedEndLine: 1 },
						{ command: "delete", resolvedStartLine: 4, resolvedEndLine: 4 },
					],
				}),
			),
		).toBe("b\nc\ne\n");
	});

	test("addresses stay relative to the original file when content grows", () => {
		// L1 becomes three lines. Replayed top-down, the L3 replace would land on the
		// inserted text instead of the original "c".
		expect(
			applyToolCall(
				FIVE,
				call({
					operations: [
						{ command: "replace", resolvedStartLine: 1, resolvedEndLine: 1, content: "x\ny\nz" },
						{ command: "replace", resolvedStartLine: 3, resolvedEndLine: 3, content: "C" },
					],
				}),
			),
		).toBe("x\ny\nz\nb\nC\nd\ne\n");
	});

	test("addresses stay relative to the original file when content shrinks", () => {
		expect(
			applyToolCall(
				FIVE,
				call({
					operations: [
						{ command: "replace", resolvedStartLine: 1, resolvedEndLine: 2, content: "ab" },
						{ command: "replace", resolvedStartLine: 5, resolvedEndLine: 5, content: "E" },
					],
				}),
			),
		).toBe("ab\nc\nd\nE\n");
	});

	test("the recorded order does not change the result", () => {
		const inOrder = applyToolCall(
			FIVE,
			call({
				operations: [
					{ command: "delete", resolvedStartLine: 1, resolvedEndLine: 1 },
					{ command: "delete", resolvedStartLine: 4, resolvedEndLine: 4 },
				],
			}),
		);
		const reversed = applyToolCall(
			FIVE,
			call({
				operations: [
					{ command: "delete", resolvedStartLine: 4, resolvedEndLine: 4 },
					{ command: "delete", resolvedStartLine: 1, resolvedEndLine: 1 },
				],
			}),
		);
		expect(inOrder).toBe(reversed);
	});

	test("mixed commands in one batch", () => {
		expect(
			applyToolCall(
				FIVE,
				call({
					operations: [
						{ command: "replace", resolvedStartLine: 1, resolvedEndLine: 1, content: "A" },
						{ command: "delete", resolvedStartLine: 3, resolvedEndLine: 3 },
						{ command: "append", resolvedStartLine: 5, resolvedEndLine: 5, content: "f" },
					],
				}),
			),
		).toBe("A\nb\nd\ne\nf\n");
	});

	test("a relocation inside a batch keeps its recorded destination", () => {
		expect(
			applyToolCall(
				"a\nb\nc\nd\n",
				call({
					operations: [
						{
							command: "move",
							resolvedStartLine: 1,
							resolvedEndLine: 1,
							resolvedToStartLine: 3,
							resolvedToEndLine: 3,
							placement: "after",
						},
					],
				}),
			),
		).toBe("b\nc\na\nd\n");
	});

	test("substitute inside a batch replays with its flags", () => {
		expect(
			applyToolCall(
				"x x\ny\n",
				call({
					operations: [
						{
							command: "substitute",
							resolvedStartLine: 1,
							resolvedEndLine: 1,
							pattern: "x",
							replacement: "z",
							flags: "g",
						},
					],
				}),
			),
		).toBe("z z\ny\n");
	});

	test("a batch of one matches the single-operation shape", () => {
		const asBatch = applyToolCall(
			FIVE,
			call({ operations: [{ command: "delete", resolvedStartLine: 2, resolvedEndLine: 2 }] }),
		);
		const asSingle = applyToolCall(
			FIVE,
			call({ command: "delete", resolvedStartLine: 2, resolvedEndLine: 2 }),
		);
		expect(asBatch).toBe(asSingle);
	});

	test("CRLF is restored once, not per operation", () => {
		expect(
			applyToolCall(
				"a\r\nb\r\nc\r\n",
				call({
					operations: [
						{ command: "replace", resolvedStartLine: 1, resolvedEndLine: 1, content: "A" },
						{ command: "replace", resolvedStartLine: 3, resolvedEndLine: 3, content: "C" },
					],
				}),
			),
		).toBe("A\r\nb\r\nC\r\n");
	});

	test("every line survives a batch exactly once", () => {
		const out = applyToolCall(
			FIVE,
			call({
				operations: [
					{ command: "replace", resolvedStartLine: 2, resolvedEndLine: 2, content: "B" },
					{ command: "replace", resolvedStartLine: 4, resolvedEndLine: 4, content: "D" },
				],
			}),
		);
		expect(out).toBe("a\nB\nc\nD\ne\n");
	});
});

describe("batch divergence", () => {
	test("an empty recorded batch diverges", () => {
		expect(() => applyToolCall(FIVE, call({ operations: [] }))).toThrow(ReplayDivergedError);
	});

	test("a batched operation with no line range diverges", () => {
		expect(() =>
			applyToolCall(
				FIVE,
				call({
					operations: [
						{ command: "delete", resolvedStartLine: 1, resolvedEndLine: 1 },
						{ command: "delete" },
					],
				}),
			),
		).toThrow(ReplayDivergedError);
	});

	test("a batched operation past the reconstructed content diverges", () => {
		expect(() =>
			applyToolCall(
				FIVE,
				call({ operations: [{ command: "delete", resolvedStartLine: 90, resolvedEndLine: 90 }] }),
			),
		).toThrow(ReplayDivergedError);
	});

	test("a batched operation with an unknown command diverges", () => {
		expect(() =>
			applyToolCall(
				FIVE,
				call({ operations: [{ command: "frobnicate", resolvedStartLine: 1, resolvedEndLine: 1 }] }),
			),
		).toThrow(ReplayDivergedError);
	});

	test("a batched replace with no recorded content diverges", () => {
		expect(() =>
			applyToolCall(
				FIVE,
				call({ operations: [{ command: "replace", resolvedStartLine: 1, resolvedEndLine: 1 }] }),
			),
		).toThrow(ReplayDivergedError);
	});

	test("one bad operation rejects the whole batch rather than applying the rest", () => {
		// Partial application would be worse than failing: the file would be left in a state
		// the tool never produced.
		expect(() =>
			applyToolCall(
				FIVE,
				call({
					operations: [
						{ command: "delete", resolvedStartLine: 1, resolvedEndLine: 1 },
						{ command: "delete", resolvedStartLine: 900, resolvedEndLine: 900 },
					],
				}),
			),
		).toThrow(ReplayDivergedError);
	});

	test("a missing baseline diverges before any operation runs", () => {
		expect(() =>
			applyToolCall(
				null,
				call({ operations: [{ command: "delete", resolvedStartLine: 1, resolvedEndLine: 1 }] }),
			),
		).toThrow(ReplayDivergedError);
	});
});
