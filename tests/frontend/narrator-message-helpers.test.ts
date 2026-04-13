import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
	hasToolUse,
	isToolOnlyMessage,
	removeStreamingChunksMsg,
	resolveAllToolCallsFromMsg,
} from "../../frontend/components/narrator/narrator-message-helpers";
import { createStreamingChunksFixture, makeMessage } from "./narrator-timeline.fixtures";

describe("narrator-message-helpers legacy behavior", () => {
	test("resolveAllToolCallsFromMsg 优先读取 enriched tool_use block 字段", () => {
		const msg = makeMessage({
			id: "m-enriched",
			role: "assistant",
			contentJson: [
				{
					type: "tool_use",
					id: "tu-enriched",
					name: "Read",
					input: { file_path: "a.txt" },
					inputJson: { file_path: "b.txt" },
					status: "fail",
					errorMessage: "boom",
					tcId: "tc-from-block",
					durationMs: 42,
				},
			],
			toolCalls: [
				{
					id: "tc-from-row",
					toolUseId: "tu-enriched",
					toolName: "Read",
					inputJson: { file_path: "row.txt" },
					status: "success",
					createdAt: "2025-01-01T00:00:00.000Z",
				},
			],
		});

		const calls = resolveAllToolCallsFromMsg(msg);
		expect(calls).toHaveLength(1);
		expect(calls[0].id).toBe("tc-from-block");
		expect(calls[0].status).toBe("fail");
		expect(calls[0].inputJson).toEqual({ file_path: "b.txt" });
		expect(calls[0].errorMessage).toBe("boom");
		expect(calls[0].durationMs).toBe(42);
	});

	test("isToolOnlyMessage / hasToolUse 兼容 legacy 判定", () => {
		const toolOnly = makeMessage({
			id: "m-tool-only",
			role: "assistant",
			contentJson: [
				{ type: "reasoning", text: "r" },
				{ type: "text", text: "   " },
				{ type: "tool_use", id: "tu-1", name: "Read", input: {} },
			],
		});
		expect(isToolOnlyMessage(toolOnly)).toBe(true);
		expect(hasToolUse(toolOnly)).toBe(true);

		const mixed = makeMessage({
			id: "m-mixed",
			role: "assistant",
			contentJson: [
				{ type: "text", text: "hello" },
				{ type: "tool_use", id: "tu-2", name: "Read", input: {} },
			],
		});
		expect(isToolOnlyMessage(mixed)).toBe(false);
		expect(hasToolUse(mixed)).toBe(true);

		const userMsg = makeMessage({
			id: "m-user",
			role: "user",
			contentJson: [{ type: "tool_use", id: "tu-3", name: "Read", input: {} }],
		});
		expect(hasToolUse(userMsg)).toBe(false);
	});

	test("removeStreamingChunksMsg 只移除 synthetic streaming message", () => {
		const qc = new QueryClient();
		const key = ["narrators", "n1", "messages"] as const;
		const { regular, streaming, tail } = createStreamingChunksFixture();
		qc.setQueryData(key, {
			pages: [
				{
					messages: [regular, streaming, tail],
					hasMore: false,
					nextCursor: null,
				},
			],
			pageParams: [undefined],
		});

		removeStreamingChunksMsg(qc, [...key]);
		const data = qc.getQueryData<{ pages: Array<{ messages: Array<{ id: string }> }> }>(key);
		expect(data?.pages[0]?.messages.map((m) => m.id)).toEqual(["m-regular", "m-tail"]);
	});
});
