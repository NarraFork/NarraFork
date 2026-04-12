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

	test("pushAssistantTurn prepends reasoning fallback for current responses history", () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const history: unknown[] = [];

		provider.pushAssistantTurn(
			history,
			"Tool result summary",
			[],
			[
				{
					text: "Live reasoning summary",
					providerMetadata: {
						openai: {
							itemId: "rs_live",
							reasoningEncryptedContent: "enc_live",
						},
					},
				},
			],
		);

		expect(history).toHaveLength(1);
		expect(JSON.stringify(history[0])).toContain("Live reasoning summary");
		expect(JSON.stringify(history[0])).toContain("Tool result summary");
		expect(JSON.stringify(history[0])).not.toContain('"type":"reasoning"');
	});
});
