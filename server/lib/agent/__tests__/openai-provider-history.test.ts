import { describe, expect, test } from "bun:test";
import type { OpenAIProviderConfig } from "../../settings";
import { OpenAIProvider } from "../openai-provider";
import type { DbMessage } from "../provider";

const TEST_PROVIDER: OpenAIProviderConfig = {
	id: "test-openai",
	name: "Test OpenAI",
	prefix: "openai",
	apiKey: "test-key",
	baseUrl: "https://example.com/v1",
	defaultModel: "gpt-5",
	apiMode: "responses",
};

function makeAssistantMessage(overrides: Partial<DbMessage> = {}): DbMessage {
	return {
		id: "msg-1",
		role: "assistant",
		contentJson: [],
		contentText: null,
		parentToolUseId: null,
		messageUuid: null,
		toolCalls: [],
		...overrides,
	};
}

describe("OpenAIProvider Responses history reasoning continuation", () => {
	test("buildHistory includes reasoning items with encrypted_content for continuation", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				contentJson: [
					{
						type: "reasoning",
						text: "Earlier hidden reasoning summary",
						providerMetadata: {
							openai: {
								itemId: "rs_123",
								reasoningEncryptedContent: "enc_123",
							},
						},
					},
					{ type: "text", text: "Visible assistant reply" },
				],
				contentText: "Visible assistant reply",
			}),
		];

		const result = await provider.buildHistory(dbMessages, "openai:gpt-5");
		const historyJson = JSON.stringify(result.history);

		// Should include reasoning item with encrypted_content
		expect(historyJson).toContain('"type":"reasoning"');
		expect(historyJson).toContain('"id":"rs_123"');
		expect(historyJson).toContain('"encrypted_content":"enc_123"');
		expect(historyJson).toContain("Earlier hidden reasoning summary");

		// Should also include assistant text
		expect(historyJson).toContain("Visible assistant reply");

		// Verify structure: reasoning item should come before assistant message
		const reasoningItem = (result.history as Array<{ type?: string }>).find(
			(msg) => msg.type === "reasoning",
		);
		const assistantMsg = (result.history as Array<{ role?: string }>).find(
			(msg) => msg.role === "assistant",
		);
		expect(reasoningItem).toBeDefined();
		expect(assistantMsg).toBeDefined();
	});

	test("buildHistory handles assistant message with reasoning but no text", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				contentJson: [
					{
						type: "reasoning",
						text: "Pure reasoning turn",
						providerMetadata: {
							openai: {
								itemId: "rs_456",
								reasoningEncryptedContent: "enc_456",
							},
						},
					},
				],
				contentText: null,
			}),
		];

		const result = await provider.buildHistory(dbMessages, "openai:gpt-5");
		const historyJson = JSON.stringify(result.history);

		// Should include reasoning item
		expect(historyJson).toContain('"type":"reasoning"');
		expect(historyJson).toContain('"encrypted_content":"enc_456"');
	});

	test("pushAssistantTurn emits native reasoning and web_search items for responses history", () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const history: unknown[] = [];

		provider.pushAssistantTurn(
			history,
			"Tool result summary",
			[],
			[
				{
					text: "Live reasoning summary",
					outputIndex: 0,
					providerMetadata: {
						openai: {
							itemId: "rs_live",
							reasoningEncryptedContent: "enc_live",
						},
					},
				},
			],
			[{ id: "ws_live", query: "cache me", outputIndex: 1 }],
		);

		expect(history).toHaveLength(3);
		expect(JSON.stringify(history[0])).toContain('"type":"reasoning"');
		expect(JSON.stringify(history[0])).toContain('"encrypted_content":"enc_live"');
		expect(JSON.stringify(history[1])).toContain('"type":"web_search_call"');
		expect(JSON.stringify(history[1])).toContain('"query":"cache me"');
		expect(JSON.stringify(history[2])).toContain("Tool result summary");
		expect(JSON.stringify(history[2])).not.toContain("Live reasoning summary");
	});

	test("pushAssistantTurn keeps non-replayable reasoning as assistant text fallback", () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const history: unknown[] = [];

		provider.pushAssistantTurn(history, "Visible reply", [], [{ text: "Fallback reasoning" }]);

		expect(history).toHaveLength(1);
		expect(JSON.stringify(history[0])).toContain("Fallback reasoning");
		expect(JSON.stringify(history[0])).toContain("Visible reply");
		expect(JSON.stringify(history[0])).not.toContain('"type":"reasoning"');
	});

	test("buildHistory replays web_search as native responses items", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				contentJson: [
					{ type: "web_search", id: "ws_123", query: "weather sf", outputIndex: 1 },
					{ type: "text", text: "Search result summary" },
				],
				contentText: "Search result summary",
			}),
		];

		const result = await provider.buildHistory(dbMessages, "openai:gpt-5");
		expect(result.trailingToolResults).toEqual([]);
		expect(JSON.stringify(result.history[0])).toContain('"type":"web_search_call"');
		expect(JSON.stringify(result.history[0])).toContain('"query":"weather sf"');
		expect(JSON.stringify(result.history[1])).toContain("Search result summary");
		expect(JSON.stringify(result.history)).not.toContain("[Web search:");
	});

	test("buildHistory matches pushAssistantTurn canonical responses layout", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				contentJson: [
					{
						type: "reasoning",
						text: "Reasoning summary",
						providerMetadata: {
							openai: {
								itemId: "rs_sync",
								reasoningEncryptedContent: "enc_sync",
							},
						},
						outputIndex: 0,
					},
					{ type: "web_search", id: "ws_sync", query: "search term", outputIndex: 1 },
					{ type: "text", text: "Assistant reply" },
				],
				contentText: "Assistant reply",
				toolCalls: [
					{
						toolUseId: "call_sync",
						toolName: "Read",
						inputJson: { file_path: "/tmp/demo" },
						outputJson: "file contents",
						status: "success",
					},
				],
			}),
		];

		const rebuilt = await provider.buildHistory(dbMessages, "openai:gpt-5");
		const pushedHistory: unknown[] = [];
		provider.pushAssistantTurn(
			pushedHistory,
			"Assistant reply",
			[{ toolUseId: "call_sync", name: "Read", input: { file_path: "/tmp/demo" } }],
			[
				{
					text: "Reasoning summary",
					providerMetadata: {
						openai: {
							itemId: "rs_sync",
							reasoningEncryptedContent: "enc_sync",
						},
					},
					outputIndex: 0,
				},
			],
			[{ id: "ws_sync", query: "search term", outputIndex: 1 }],
		);
		const pushedTrailing = [provider.formatToolResult("call_sync", "file contents", false)];

		expect(pushedHistory).toEqual(rebuilt.history);
		expect(pushedTrailing).toEqual(rebuilt.trailingToolResults);
	});
});
