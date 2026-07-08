import { describe, expect, it } from "bun:test";
import {
	AnthropicProvider,
	parseAnthropicSSEStream,
} from "../../../server/lib/agent/anthropic-provider";
import type { DbMessage } from "../../../server/lib/agent/provider";
import type { AgentToolUse } from "../../../server/lib/agent/types";

function sseStream(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
}

describe("AnthropicProvider thinking continuation", () => {
	it("preserves separate thinking block indexes and signatures from SSE", async () => {
		const events = await Array.fromAsync(
			parseAnthropicSSEStream(
				sseStream([
					{ type: "message_start", message: { id: "msg_1" } },
					{ type: "content_block_start", index: 0, content_block: { type: "thinking" } },
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "thinking_delta", thinking: "first" },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "signature_delta", signature: "sig-1" },
					},
					{ type: "content_block_stop", index: 0 },
					{ type: "content_block_start", index: 2, content_block: { type: "thinking" } },
					{
						type: "content_block_delta",
						index: 2,
						delta: { type: "thinking_delta", thinking: "second" },
					},
					{
						type: "content_block_delta",
						index: 2,
						delta: { type: "signature_delta", signature: "sig-2" },
					},
					{ type: "content_block_stop", index: 2 },
				]),
			),
		);

		const reasoningEvents = events.filter((event) => event.reasoning);
		expect(reasoningEvents).toEqual([
			expect.objectContaining({
				reasoning: "first",
				reasoningOutputIndex: 0,
				reasoningMetadata: { anthropic: { blockIndex: 0 } },
			}),
			expect.objectContaining({
				reasoning: "second",
				reasoningOutputIndex: 2,
				reasoningMetadata: { anthropic: { blockIndex: 2 } },
			}),
		]);

		const signatureEvents = events.filter((event) => event.reasoningMetadata?.anthropic?.signature);
		expect(signatureEvents).toEqual([
			expect.objectContaining({
				reasoningOutputIndex: 0,
				reasoningMetadata: { anthropic: { blockIndex: 0, signature: "sig-1" } },
			}),
			expect.objectContaining({
				reasoningOutputIndex: 2,
				reasoningMetadata: { anthropic: { blockIndex: 2, signature: "sig-2" } },
			}),
		]);
	});

	it("replays multiple persisted reasoning blocks as separate signed thinking blocks", async () => {
		const provider = new AnthropicProvider({
			id: "test",
			name: "Test",
			prefix: "anthropic",
			apiKey: "test-key",
			baseUrl: "https://api.anthropic.com/v1",
			defaultModel: "claude-sonnet-4-5",
		});
		const dbMessages: DbMessage[] = [
			{
				id: "u1",
				role: "user",
				contentJson: [{ type: "text", text: "run tools" }],
				contentText: "run tools",
				parentToolUseId: null,
				messageUuid: null,
			},
			{
				id: "a1",
				role: "assistant",
				contentJson: [
					{
						type: "reasoning",
						text: "first",
						providerMetadata: {
							anthropic: { blockIndex: 0, signature: "sig-1" },
							signatureSource: "anthropic",
						},
					},
					{ type: "text", text: "ok" },
					{
						type: "reasoning",
						text: "second",
						providerMetadata: {
							anthropic: { blockIndex: 2, signature: "sig-2" },
							signatureSource: "anthropic",
						},
					},
					{ type: "tool_use", id: "toolu_1" },
				],
				contentText: "ok",
				parentToolUseId: null,
				messageUuid: null,
				toolCalls: [
					{
						toolUseId: "toolu_1",
						toolName: "Read",
						inputJson: { file_path: "/tmp/a" },
						outputJson: "done",
						status: "success",
					},
				],
			},
		];

		const { history } = await provider.buildHistory(dbMessages, "claude-sonnet-4-5");
		const assistant = (history as Array<{ role: string; content: unknown }>).find(
			(message) => message.role === "assistant",
		);

		expect(assistant?.content).toEqual([
			{ type: "thinking", thinking: "first", signature: "sig-1" },
			{ type: "text", text: "ok" },
			{ type: "thinking", thinking: "second", signature: "sig-2" },
			{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/a" } },
		]);
	});

	it("drops signatures minted by a different upstream but keeps thinking text", async () => {
		const provider = new AnthropicProvider({
			id: "test",
			name: "Test",
			prefix: "anthropic",
			apiKey: "test-key",
			baseUrl: "https://api.anthropic.com/v1",
			defaultModel: "claude-sonnet-4-5",
		});
		const dbMessages: DbMessage[] = [
			{
				id: "u1",
				role: "user",
				contentJson: [{ type: "text", text: "run" }],
				contentText: "run",
				parentToolUseId: null,
				messageUuid: null,
			},
			{
				id: "a1",
				role: "assistant",
				contentJson: [
					// Minted by a NUG channel — must not be replayed to a direct anthropic upstream.
					{
						type: "reasoning",
						text: "foreign",
						providerMetadata: {
							anthropic: { blockIndex: 0, signature: "sig-foreign" },
							signatureSource: "nug:antigravity",
						},
					},
					// Legacy block with no recorded source — also dropped, conservatively.
					{
						type: "reasoning",
						text: "legacy",
						providerMetadata: { anthropic: { blockIndex: 1, signature: "sig-legacy" } },
					},
					{ type: "redacted_thinking", data: "opaque", signatureSource: "nug:antigravity" },
					{ type: "text", text: "answer" },
				],
				contentText: "answer",
				parentToolUseId: null,
				messageUuid: null,
				toolCalls: [],
			},
		];

		const { history } = await provider.buildHistory(dbMessages, "claude-sonnet-4-5");
		const assistant = (history as Array<{ role: string; content: unknown }>).find(
			(message) => message.role === "assistant",
		);

		// Signatures are blanked, the cross-source redacted block is dropped
		// entirely, and thinking text survives.
		expect(assistant?.content).toEqual([
			{ type: "thinking", thinking: "foreign", signature: "" },
			{ type: "thinking", thinking: "legacy", signature: "" },
			{ type: "text", text: "answer" },
		]);
	});

	it("preserves redacted thinking blocks from SSE for replay", async () => {
		const events = await Array.fromAsync(
			parseAnthropicSSEStream(
				sseStream([
					{ type: "message_start", message: { id: "msg_1" } },
					{
						type: "content_block_start",
						index: 1,
						content_block: { type: "redacted_thinking", data: "opaque-redacted-data" },
					},
					{ type: "content_block_stop", index: 1 },
				]),
			),
		);

		expect(events).toContainEqual({
			redactedThinking: { data: "opaque-redacted-data", outputIndex: 1 },
		});
	});

	it("keeps redacted thinking in the in-memory assistant trajectory", () => {
		const provider = new AnthropicProvider({
			id: "test",
			name: "Test",
			prefix: "anthropic",
			apiKey: "test-key",
			baseUrl: "https://api.anthropic.com/v1",
			defaultModel: "claude-sonnet-4-5",
		});
		const history: unknown[] = [];
		const toolUses: AgentToolUse[] = [
			{
				toolUseId: "toolu_1",
				name: "Read",
				input: { file_path: "/tmp/a" },
				outputIndex: 2,
			},
		];

		provider.pushAssistantTurn(
			history,
			"ok",
			toolUses,
			undefined,
			undefined,
			undefined,
			undefined,
			1,
			[{ data: "opaque-redacted-data", outputIndex: 0 }],
		);

		expect(history).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "redacted_thinking", data: "opaque-redacted-data" },
					{ type: "text", text: "ok" },
					{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/a" } },
				],
			},
		]);
	});
});
