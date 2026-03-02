import { describe, expect, it } from "bun:test";
import { OpenAIProvider } from "../../../server/lib/agent/openai-provider";
import type { DbMessage } from "../../../server/lib/agent/provider";

const provider = new OpenAIProvider({
	id: "test",
	name: "Test",
	prefix: "test",
	apiKey: "test-key",
	baseUrl: "https://api.openai.com/v1",
	defaultModel: "gpt-5",
	apiMode: "responses",
});

describe("OpenAIProvider history builder", () => {
	it("skips empty assistant stubs in responses history", async () => {
		const dbMessages: DbMessage[] = [
			{
				id: "u1",
				role: "user",
				contentJson: [{ type: "text", text: "hello" }],
				contentText: "hello",
				parentToolUseId: null,
				messageUuid: null,
			},
			{
				id: "a-empty",
				role: "assistant",
				contentJson: [],
				contentText: null,
				parentToolUseId: null,
				messageUuid: null,
				toolCalls: [],
			},
			{
				id: "u2",
				role: "user",
				contentJson: [{ type: "text", text: "next" }],
				contentText: "next",
				parentToolUseId: null,
				messageUuid: null,
			},
		];

		const { history } = await provider.buildHistory(dbMessages, "test:gpt-5");

		expect(history).toHaveLength(1);
		expect(history[0]).toEqual({
			role: "user",
			content: [{ type: "input_text", text: "hello" }],
		});
	});
});
