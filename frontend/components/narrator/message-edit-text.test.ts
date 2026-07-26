/** message-edit-text.test.ts — unit tests for the editor's pure text helpers. */

import { describe, expect, it } from "bun:test";
import {
	collectTextBlocksPreview,
	MAX_ASSISTANT_MESSAGE_EDIT_CHARS,
	MAX_USER_MESSAGE_EDIT_CHARS,
	resolveEditorInitialText,
} from "./message-edit-text";

describe("collectTextBlocksPreview", () => {
	it("joins text blocks with a blank line", () => {
		expect(
			collectTextBlocksPreview(
				[
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
				99,
			),
		).toEqual({ text: "a\n\nb", truncated: false });
	});

	it("skips non-text and non-string blocks", () => {
		expect(
			collectTextBlocksPreview(
				[{ type: "tool_use" }, { type: "text", text: 5 }, { type: "text", text: "ok" }],
				99,
			),
		).toEqual({ text: "ok", truncated: false });
	});

	it("marks truncation when the cap is reached mid-block", () => {
		const result = collectTextBlocksPreview([{ type: "text", text: "abcdef" }], 3);
		expect(result).toEqual({ text: "abc", truncated: true });
	});

	it("marks truncation when a later block cannot fit at all", () => {
		const result = collectTextBlocksPreview(
			[
				{ type: "text", text: "abc" },
				{ type: "text", text: "def" },
			],
			3,
		);
		expect(result.truncated).toBe(true);
		expect(result.text).toBe("abc");
	});

	it("returns empty for a message without text", () => {
		expect(collectTextBlocksPreview([], 99)).toEqual({ text: "", truncated: false });
	});
});

describe("resolveEditorInitialText", () => {
	it("applies the per-role cap", () => {
		const long = "x".repeat(MAX_ASSISTANT_MESSAGE_EDIT_CHARS + 10);
		// Over the assistant cap but under the (larger) user cap.
		expect(resolveEditorInitialText([{ type: "text", text: long }], "assistant").truncated).toBe(
			true,
		);
		expect(resolveEditorInitialText([{ type: "text", text: long }], "user").truncated).toBe(false);
	});

	it("keeps the user cap larger than the assistant cap", () => {
		expect(MAX_USER_MESSAGE_EDIT_CHARS).toBeGreaterThan(MAX_ASSISTANT_MESSAGE_EDIT_CHARS);
	});

	it("returns the full text when it fits", () => {
		expect(resolveEditorInitialText([{ type: "text", text: "hello" }], "user")).toEqual({
			text: "hello",
			truncated: false,
		});
	});
});
