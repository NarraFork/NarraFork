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

describe("OpenAIProvider Responses history reasoning fallback", () => {
	test("buildHistory keeps historical reasoning summary as assistant text fallback", async () => {
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
		const assistant = (result.history as Array<{ role?: string; content?: unknown }>).find(
			(msg) => msg.role === "assistant",
		);

		expect(assistant).toBeDefined();
		expect(JSON.stringify(assistant)).toContain("Earlier hidden reasoning summary");
		expect(JSON.stringify(assistant)).toContain("Visible assistant reply");
		expect(JSON.stringify(result.history)).not.toContain('"type":"reasoning"');
		expect(JSON.stringify(result.history)).not.toContain('"id":"rs_123"');
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
