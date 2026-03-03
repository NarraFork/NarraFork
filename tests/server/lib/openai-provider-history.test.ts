import { describe, expect, it } from "bun:test";
import { OpenAIProvider } from "../../../server/lib/agent/openai-provider";
import type { ChatParams, DbMessage } from "../../../server/lib/agent/provider";

const provider = new OpenAIProvider({
	id: "test",
	name: "Test",
	prefix: "test",
	apiKey: "test-key",
	baseUrl: "https://api.openai.com/v1",
	defaultModel: "gpt-5",
	apiMode: "responses",
});

function createDoneSseResponse(): Response {
	return new Response("data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

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

describe("OpenAIProvider chat request formatting", () => {
	it("converts user image payload to Responses API input_* content types", async () => {
		const originalFetch = globalThis.fetch;
		let capturedBody: Record<string, unknown> | null = null;

		globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
			const [, init] = args;
			capturedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
			return createDoneSseResponse();
		}) as typeof fetch;

		try {
			const params: ChatParams = {
				conversationId: "conv-1",
				content: "请分析这张图",
				model: "test:gpt-5",
				cwd: "/tmp",
				history: [],
				tools: [],
				toolResults: [],
				signal: new AbortController().signal,
				images: [{ format: "png", base64: "aGVsbG8=" }],
			};

			for await (const _event of provider.chat(params)) {
				// Drain stream
			}
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(capturedBody).not.toBeNull();
		if (!capturedBody) {
			throw new Error("Expected request body to be captured");
		}
		const body = capturedBody as {
			input?: Array<{ role?: string; content?: Array<{ type?: string }> }>;
		};
		const userMsg = body.input?.find((msg) => msg.role === "user");
		const contentTypes = userMsg?.content?.map((part) => part.type) ?? [];

		expect(contentTypes).toEqual(["input_text", "input_image"]);
		expect(contentTypes.includes("text")).toBe(false);
		expect(contentTypes.includes("image_url")).toBe(false);
	});
});
