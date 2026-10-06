/**
 * reasoning-content.test.ts — classification of reasoning-only assistant records.
 *
 * Two questions live here and must not be conflated:
 *
 *  - `isMetadataOnlyEmptyReasoningAssistantMessage`: "is this row pure metadata?"
 *    Only EMPTY reasoning qualifies; such rows must not become model-history
 *    boundaries.
 *  - `isDanglingReasoningOnlyAssistantMessage`: "did this turn produce anything to
 *    continue from?" Reasoning WITH text qualifies too, because thinking alone
 *    gives a continuation nothing to build on. This is the check the "continue"
 *    path uses to look past a turn that died mid-thought and find the real tail.
 */

import { describe, expect, test } from "bun:test";
import {
	isDanglingReasoningOnlyAssistantMessage,
	isEmptyReasoningBlock,
	isMetadataOnlyEmptyReasoningAssistantMessage,
} from "../reasoning-content";

describe("isEmptyReasoningBlock", () => {
	test("accepts both stored shapes when the text is blank", () => {
		expect(isEmptyReasoningBlock({ type: "reasoning", text: "" })).toBe(true);
		expect(isEmptyReasoningBlock({ type: "reasoning", text: "   \n" })).toBe(true);
		expect(isEmptyReasoningBlock({ type: "thinking", thinking: "" })).toBe(true);
	});

	test("rejects blocks with real reasoning text and non-reasoning blocks", () => {
		expect(isEmptyReasoningBlock({ type: "reasoning", text: "分析中" })).toBe(false);
		expect(isEmptyReasoningBlock({ type: "thinking", thinking: "分析中" })).toBe(false);
		expect(isEmptyReasoningBlock({ type: "text", text: "" })).toBe(false);
		expect(isEmptyReasoningBlock(null)).toBe(false);
	});
});

describe("isDanglingReasoningOnlyAssistantMessage", () => {
	test("accepts reasoning with text — the turn thought but never answered", () => {
		expect(
			isDanglingReasoningOnlyAssistantMessage({
				role: "assistant",
				contentJson: [{ type: "reasoning", text: "先看一下现状" }],
			}),
		).toBe(true);
	});

	test("accepts the legacy thinking shape and empty reasoning", () => {
		expect(
			isDanglingReasoningOnlyAssistantMessage({
				role: "assistant",
				contentJson: [{ type: "thinking", thinking: "先看一下现状" }],
			}),
		).toBe(true);
		expect(
			isDanglingReasoningOnlyAssistantMessage({
				role: "assistant",
				contentJson: [{ type: "reasoning", text: "" }],
			}),
		).toBe(true);
	});

	test("tolerates blank text blocks alongside the reasoning", () => {
		expect(
			isDanglingReasoningOnlyAssistantMessage({
				role: "assistant",
				contentJson: [
					{ type: "reasoning", text: "想一下" },
					{ type: "text", text: "  " },
				],
			}),
		).toBe(true);
	});

	test("rejects a turn that produced an answer", () => {
		expect(
			isDanglingReasoningOnlyAssistantMessage({
				role: "assistant",
				contentJson: [
					{ type: "reasoning", text: "想一下" },
					{ type: "text", text: "结论是这样" },
				],
			}),
		).toBe(false);
	});

	test("rejects a turn that called a tool (block or persisted row)", () => {
		expect(
			isDanglingReasoningOnlyAssistantMessage({
				role: "assistant",
				contentJson: [
					{ type: "reasoning", text: "想一下" },
					{ type: "tool_use", id: "tu1", name: "Bash" },
				],
			}),
		).toBe(false);
		expect(
			isDanglingReasoningOnlyAssistantMessage({
				role: "assistant",
				contentJson: [{ type: "reasoning", text: "想一下" }],
				toolCalls: [{ toolUseId: "tu1", toolName: "Bash" }],
			}),
		).toBe(false);
	});

	test("rejects when contentText carries the answer (provider text fallback)", () => {
		// buildHistory falls back to contentText when contentJson has no text block,
		// so a row with text there DID answer and must not be treated as dangling.
		expect(
			isDanglingReasoningOnlyAssistantMessage({
				role: "assistant",
				contentJson: [{ type: "reasoning", text: "想一下" }],
				contentText: "结论是这样",
			}),
		).toBe(false);
	});

	test("rejects non-assistant roles and records with no blocks at all", () => {
		expect(
			isDanglingReasoningOnlyAssistantMessage({
				role: "user",
				contentJson: [{ type: "reasoning", text: "想一下" }],
			}),
		).toBe(false);
		// An empty placeholder is a different case, owned by the retry path.
		expect(isDanglingReasoningOnlyAssistantMessage({ role: "assistant", contentJson: [] })).toBe(
			false,
		);
	});
});

describe("isMetadataOnlyEmptyReasoningAssistantMessage", () => {
	test("stays narrower than the dangling check: reasoning with text does not qualify", () => {
		const withText = {
			role: "assistant",
			contentJson: [{ type: "reasoning", text: "先看一下现状" }],
		};
		expect(isMetadataOnlyEmptyReasoningAssistantMessage(withText)).toBe(false);
		expect(isDanglingReasoningOnlyAssistantMessage(withText)).toBe(true);
	});

	test("accepts an empty-reasoning record with optional blank text", () => {
		expect(
			isMetadataOnlyEmptyReasoningAssistantMessage({
				role: "assistant",
				contentJson: [
					{ type: "reasoning", text: "" },
					{ type: "text", text: "" },
				],
			}),
		).toBe(true);
	});
});
