/**
 * Replaying StructSed's copy/move.
 *
 * A separate file from `struct-sed-replay.test.ts` (which covers the in-place commands)
 * because relocation has its own extra failure surface: a destination.
 *
 * The load-bearing property is unchanged — an unreplayable call must THROW.
 * `applyToolCall` returns `currentContent` for anything it does not recognise, so a
 * copy/move that fell through would reconstruct the file as though the block had never
 * moved, while the Write/Edit calls around it replayed normally. The result looks
 * plausible, is wrong, and nothing reports it.
 */

import { describe, expect, test } from "bun:test";
import { applyToolCall, ReplayDivergedError } from "./file-state-rebuild";

function call(inputJson: unknown) {
	return {
		toolUseId: "tu-move-1",
		toolName: "StructSed",
		inputJson,
		status: "success",
		messageId: "m-1",
		seq: 1,
		createdAt: new Date().toISOString(),
	};
}

describe("relocation replay", () => {
	test("move with a recorded destination", () => {
		expect(
			applyToolCall(
				"a\nb\nc\nd\n",
				call({
					command: "move",
					resolvedStartLine: 1,
					resolvedEndLine: 1,
					resolvedToStartLine: 3,
					resolvedToEndLine: 3,
					placement: "after",
				}),
			),
		).toBe("b\nc\na\nd\n");
	});

	test("copy leaves the source in place", () => {
		expect(
			applyToolCall(
				"a\nb\n",
				call({
					command: "copy",
					resolvedStartLine: 1,
					resolvedEndLine: 1,
					resolvedToStartLine: 2,
					resolvedToEndLine: 2,
					placement: "after",
				}),
			),
		).toBe("a\nb\na\n");
	});

	test("placement: before is honoured", () => {
		expect(
			applyToolCall(
				"a\nb\nc\n",
				call({
					command: "move",
					resolvedStartLine: 3,
					resolvedEndLine: 3,
					resolvedToStartLine: 1,
					resolvedToEndLine: 1,
					placement: "before",
				}),
			),
		).toBe("c\na\nb\n");
	});

	test("a move with NO recorded destination appends at end of file", () => {
		// Absent is a real state (the tool's own "end of file" default), not missing data,
		// so this must replay rather than diverge.
		expect(
			applyToolCall("a\nb\n", call({ command: "move", resolvedStartLine: 1, resolvedEndLine: 1 })),
		).toBe("b\na\n");
	});

	test("every line survives a replayed move exactly once", () => {
		// Catches both duplication and loss, which is the failure mode of resolving the
		// destination against post-insert line numbers.
		const out = applyToolCall(
			"a\nb\nc\nd\ne\n",
			call({
				command: "move",
				resolvedStartLine: 2,
				resolvedEndLine: 3,
				resolvedToStartLine: 5,
				resolvedToEndLine: 5,
				placement: "after",
			}),
		);
		expect(out?.trim().split("\n").sort()).toEqual(["a", "b", "c", "d", "e"]);
	});

	test("CRLF is preserved through a move", () => {
		expect(
			applyToolCall(
				"a\r\nb\r\nc\r\n",
				call({
					command: "move",
					resolvedStartLine: 1,
					resolvedEndLine: 1,
					resolvedToStartLine: 3,
					resolvedToEndLine: 3,
					placement: "after",
				}),
			),
		).toBe("b\r\nc\r\na\r\n");
	});
});

describe("relocation divergence", () => {
	test("a destination overlapping the source diverges instead of guessing", () => {
		expect(() =>
			applyToolCall(
				"a\nb\nc\n",
				call({
					command: "move",
					resolvedStartLine: 1,
					resolvedEndLine: 2,
					resolvedToStartLine: 2,
					resolvedToEndLine: 2,
				}),
			),
		).toThrow(ReplayDivergedError);
	});

	test("a source past the reconstructed content diverges", () => {
		expect(() =>
			applyToolCall("a\n", call({ command: "move", resolvedStartLine: 40, resolvedEndLine: 40 })),
		).toThrow(ReplayDivergedError);
	});

	test("a destination past the reconstructed content diverges", () => {
		expect(() =>
			applyToolCall(
				"a\nb\n",
				call({
					command: "copy",
					resolvedStartLine: 1,
					resolvedEndLine: 1,
					resolvedToStartLine: 90,
					resolvedToEndLine: 90,
				}),
			),
		).toThrow(ReplayDivergedError);
	});

	test("a move with no recorded line range diverges", () => {
		expect(() => applyToolCall("a\n", call({ command: "move" }))).toThrow(ReplayDivergedError);
	});
});
