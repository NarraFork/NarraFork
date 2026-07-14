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

const codexProvider = new OpenAIProvider({
	id: "codex",
	name: "Codex",
	prefix: "codex",
	apiKey: "test-key",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	defaultModel: "gpt-5.3-codex",
	apiMode: "codex",
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
	it("uses a fresh connection for non-idempotent model requests", async () => {
		const originalFetch = globalThis.fetch;
		const captured = { connectionHeader: null as string | null };

		globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
			const [, init] = args;
			captured.connectionHeader = new Headers(init?.headers).get("connection");
			return createDoneSseResponse();
		}) as typeof fetch;

		try {
			const params: ChatParams = {
				conversationId: "conv-connection-close",
				content: "hello",
				model: "test:gpt-5",
				cwd: "/tmp",
				history: [],
				tools: [],
				toolResults: [],
				signal: new AbortController().signal,
			};

			for await (const _event of provider.chat(params)) {
				// Drain stream
			}
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(captured.connectionHeader).toBe("close");
	});

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

	it("codex mode keeps prompt_cache_key constant and reuses the full input prefix", async () => {
		const originalFetch = globalThis.fetch;
		const capturedBodies: Record<string, unknown>[] = [];
		globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
			const [, init] = args;
			if (init?.body) {
				capturedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
			}
			return createDoneSseResponse();
		}) as typeof fetch;

		try {
			const history: unknown[] = [];
			codexProvider.injectSystemPrompt(history, "Stay cached", "codex:gpt-5.3-codex", "en");
			const conversationId = "cache-conv-1";

			const firstParams: ChatParams = {
				conversationId,
				content: "hello 1",
				model: "codex:gpt-5.3-codex",
				cwd: "/tmp",
				history,
				tools: [],
				toolResults: [],
				signal: new AbortController().signal,
			};
			for await (const _event of codexProvider.chat(firstParams)) {
				// Drain stream
			}

			codexProvider.pushUserTurn(history, "hello 1", "codex:gpt-5.3-codex", []);
			codexProvider.pushAssistantTurn(
				history,
				"assistant 1",
				[],
				[
					{
						text: "reasoning 1",
						providerMetadata: {
							openai: {
								itemId: "rs_cache_1",
								reasoningEncryptedContent: "enc_cache_1",
							},
						},
						outputIndex: 0,
					},
				],
				[{ id: "ws_cache_1", query: "cache query", outputIndex: 1 }],
			);

			const secondParams: ChatParams = {
				conversationId,
				content: "hello 2",
				model: "codex:gpt-5.3-codex",
				cwd: "/tmp",
				history,
				tools: [],
				toolResults: [],
				signal: new AbortController().signal,
			};
			for await (const _event of codexProvider.chat(secondParams)) {
				// Drain stream
			}
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(capturedBodies).toHaveLength(2);
		const [body1, body2] = capturedBodies as Array<{
			prompt_cache_key?: string;
			input?: unknown[];
			tools?: unknown[];
		}>;
		expect(body1.prompt_cache_key).toBe("cache-conv-1");
		expect(body2.prompt_cache_key).toBe("cache-conv-1");
		expect(body1.tools).toEqual(body2.tools);
		expect(body2.input?.slice(0, body1.input?.length ?? 0)).toEqual(body1.input);
		expect(JSON.stringify(body2.input)).toContain('"type":"web_search_call"');
		// NOTE: `id` is intentionally stripped from web_search_call input items
		// because the upstream Responses API does not accept it.
		expect(JSON.stringify(body2.input)).toContain('"type":"reasoning"');
	});
});
