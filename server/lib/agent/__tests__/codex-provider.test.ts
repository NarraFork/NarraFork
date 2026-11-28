import { describe, expect, spyOn, test } from "bun:test";
import { encodeToolOutput } from "@shared/agent-protocol/tool-output";
import { CodexProvider, isCodexProviderExpected101WebSocketFailure } from "../codex-provider";
import { CodexWebSocketFallbackError } from "../codex-websocket";
import {
	CODEX_IMAGE_GENERATION_PARTIAL_IMAGES,
	OpenAIProvider,
	supportsCodexImageGeneration,
} from "../openai-provider";
import type { ChatParams, DbMessage } from "../provider";

describe("CodexProvider Responses WebSocket handling", () => {
	test("detects expected 101 errors from wrapped runtime events", () => {
		const expected101Message =
			"WebSocket connection to 'wss://chatgpt.com/backend-api/codex/responses' failed: Expected 101 status code";
		expect(isCodexProviderExpected101WebSocketFailure(new Error(expected101Message))).toBe(true);
		expect(isCodexProviderExpected101WebSocketFailure({ message: expected101Message })).toBe(true);
		expect(
			isCodexProviderExpected101WebSocketFailure({ error: new Error(expected101Message) }),
		).toBe(true);
		expect(
			isCodexProviderExpected101WebSocketFailure({ error: { message: expected101Message } }),
		).toBe(true);
		expect(
			isCodexProviderExpected101WebSocketFailure(new Error("Unexpected server response: 403")),
		).toBe(false);
	});

	test("GPT-6 Astra supports native image generation", () => {
		expect(supportsCodexImageGeneration("codex:gpt-6-astra")).toBe(true);
	});

	test("buildResponsesWebSocketRequest does not inject image_generation when disabled", () => {
		const provider = new CodexProvider({ useWebSocket: true, useImageGeneration: false });
		const request = (
			provider as unknown as {
				buildResponsesWebSocketRequest(params: {
					model: string;
					history: unknown[];
					toolResults: unknown[];
					content: string;
					images: undefined;
					conversationId: string;
					reasoningEffort?: undefined;
					serviceTier?: undefined;
					tools: unknown[];
					signal: AbortSignal;
					cwd: string;
					stickySessionKey?: string;
					requestDump?: undefined;
				}): { tools: unknown[] };
			}
		).buildResponsesWebSocketRequest({
			model: "codex:gpt-5.5",
			history: [],
			toolResults: [],
			content: "hello",
			images: undefined,
			conversationId: "conv-no-image-gen",
			tools: [{ type: "image_generation", output_format: "png" }],
			signal: new AbortController().signal,
			cwd: "/tmp",
		});

		const toolsJson = JSON.stringify(request.tools);
		expect(toolsJson).toContain('"type":"web_search"');
		expect(toolsJson).not.toContain('"type":"image_generation"');
	});

	test("buildResponsesWebSocketRequest does not inject web_search when disabled", () => {
		const provider = new CodexProvider({ useWebSocket: true, useWebSearch: false });
		const request = (
			provider as unknown as {
				buildResponsesWebSocketRequest(params: {
					model: string;
					history: unknown[];
					toolResults: unknown[];
					content: string;
					images: undefined;
					conversationId: string;
					reasoningEffort?: undefined;
					serviceTier?: undefined;
					tools: unknown[];
					signal: AbortSignal;
					cwd: string;
					stickySessionKey?: string;
					requestDump?: undefined;
				}): { tools: unknown[] };
			}
		).buildResponsesWebSocketRequest({
			model: "codex:gpt-5.5",
			history: [],
			toolResults: [],
			content: "hello",
			images: undefined,
			conversationId: "conv-no-web-search",
			tools: [{ type: "web_search" }],
			signal: new AbortController().signal,
			cwd: "/tmp",
		});

		const toolsJson = JSON.stringify(request.tools);
		expect(toolsJson).not.toContain('"type":"web_search"');
		expect(toolsJson).toContain('"type":"image_generation"');
		expect(toolsJson).toContain(`"partial_images":${CODEX_IMAGE_GENERATION_PARTIAL_IMAGES}`);
	});

	test("OpenAI codex mode does not inject image_generation when disabled", () => {
		const provider = new OpenAIProvider({
			id: "codex-gateway",
			name: "Codex Gateway",
			prefix: "gateway",
			apiKey: "token",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			defaultModel: "gpt-5.5",
			apiMode: "codex",
			codexImageGeneration: false,
		});
		const request = (
			provider as unknown as {
				buildCodexWebSocketRequest(params: {
					model: string;
					history: unknown[];
					toolResults: unknown[];
					content: string;
					images: undefined;
					conversationId: string;
					reasoningEffort?: undefined;
					serviceTier?: undefined;
					tools: unknown[];
					signal: AbortSignal;
					cwd: string;
					stickySessionKey?: string;
					requestDump?: undefined;
				}): { tools: unknown[] };
			}
		).buildCodexWebSocketRequest({
			model: "gateway:gpt-5.5",
			history: [],
			toolResults: [],
			content: "hello",
			images: undefined,
			conversationId: "conv-gateway-no-image-gen",
			tools: [],
			signal: new AbortController().signal,
			cwd: "/tmp",
		});

		const toolsJson = JSON.stringify(request.tools);
		expect(toolsJson).toContain('"type":"web_search"');
		expect(toolsJson).not.toContain('"type":"image_generation"');
	});

	test("OpenAI codex mode does not inject web_search when disabled", () => {
		const provider = new OpenAIProvider({
			id: "codex-gateway",
			name: "Codex Gateway",
			prefix: "gateway",
			apiKey: "token",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			defaultModel: "gpt-5.5",
			apiMode: "codex",
			codexWebSearch: false,
		});
		const request = (
			provider as unknown as {
				buildCodexWebSocketRequest(params: {
					model: string;
					history: unknown[];
					toolResults: unknown[];
					content: string;
					images: undefined;
					conversationId: string;
					reasoningEffort?: undefined;
					serviceTier?: undefined;
					tools: unknown[];
					signal: AbortSignal;
					cwd: string;
					stickySessionKey?: string;
					requestDump?: undefined;
				}): { tools: unknown[] };
			}
		).buildCodexWebSocketRequest({
			model: "gateway:gpt-5.5",
			history: [],
			toolResults: [],
			content: "hello",
			images: undefined,
			conversationId: "conv-gateway-no-web-search",
			tools: [],
			signal: new AbortController().signal,
			cwd: "/tmp",
		});

		const toolsJson = JSON.stringify(request.tools);
		expect(toolsJson).not.toContain('"type":"web_search"');
		expect(toolsJson).toContain('"type":"image_generation"');
		expect(toolsJson).toContain(`"partial_images":${CODEX_IMAGE_GENERATION_PARTIAL_IMAGES}`);
	});

	test("buildResponsesWebSocketRequest injects image_generation for Astra", () => {
		const provider = new CodexProvider({ useWebSocket: true });
		const request = (
			provider as unknown as {
				buildResponsesWebSocketRequest(params: {
					model: string;
					history: unknown[];
					toolResults: unknown[];
					content: string;
					images: undefined;
					conversationId: string;
					reasoningEffort?: undefined;
					serviceTier?: undefined;
					tools: unknown[];
					signal: AbortSignal;
					cwd: string;
					stickySessionKey?: string;
					requestDump?: undefined;
				}): { tools: unknown[] };
			}
		).buildResponsesWebSocketRequest({
			model: "codex:gpt-6-astra",
			history: [],
			toolResults: [],
			content: "hello",
			images: undefined,
			conversationId: "conv-spark",
			tools: [],
			signal: new AbortController().signal,
			cwd: "/tmp",
		});

		const toolsJson = JSON.stringify(request.tools);
		expect(toolsJson).toContain('"type":"web_search"');
		expect(toolsJson).toContain('"type":"image_generation"');
	});

	test("buildResponsesWebSocketRequest emits tool result images as input_image items", async () => {
		const provider = new CodexProvider({ useWebSocket: true });
		// Codex builds its history with an OpenAI provider in codex mode (it needs a live
		// credential to pick one); the result images ride in the history it returns.
		const rows: DbMessage[] = [
			{
				id: "u1",
				role: "user",
				contentJson: [{ type: "text", text: "take a screenshot" }],
				contentText: "take a screenshot",
				parentToolUseId: null,
				messageUuid: null,
			},
			{
				id: "a1",
				role: "assistant",
				contentJson: [{ type: "tool_use", id: "call_img", name: "Screenshot", input: {} }],
				contentText: null,
				parentToolUseId: null,
				messageUuid: null,
				toolCalls: [
					{
						toolUseId: "call_img",
						toolName: "Screenshot",
						inputJson: {},
						status: "success",
						outputJson: encodeToolOutput("Screenshot ready", {
							images: [
								{
									imageId: "img-1",
									mediaType: "image/png",
									data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
								},
							],
						}),
					},
				],
			},
		];
		const { history } = await new OpenAIProvider({
			id: "codex",
			name: "Codex",
			prefix: "codex",
			apiKey: "",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			defaultModel: "gpt-5.5",
			apiMode: "codex",
		}).buildHistory(rows, "gpt-5.5");

		const request = (
			provider as unknown as {
				buildResponsesWebSocketRequest(params: {
					model: string;
					history: unknown[];
					toolResults: unknown[];
					content: string;
					images: undefined;
					conversationId: string;
					reasoningEffort?: undefined;
					serviceTier?: undefined;
					tools: unknown[];
					signal: AbortSignal;
					cwd: string;
					stickySessionKey?: string;
					requestDump?: undefined;
				}): { input: unknown[]; tools: unknown[] };
			}
		).buildResponsesWebSocketRequest({
			model: "openai:gpt-5.5",
			history,
			toolResults: [],
			content: "",
			images: undefined,
			conversationId: "conv-1",
			tools: [],
			signal: new AbortController().signal,
			cwd: "/tmp",
		});

		const inputJson = JSON.stringify(request.input);
		const toolsJson = JSON.stringify(request.tools);
		expect(inputJson).toContain('"type":"function_call_output"');
		expect(inputJson).toContain('"call_id":"call_img"');
		expect(inputJson).toContain('"type":"input_image"');
		expect(inputJson).toContain('"image_url":"data:image/png;base64,');
		expect(toolsJson).toContain('"type":"image_generation"');
		expect(toolsJson).toContain(`"partial_images":${CODEX_IMAGE_GENERATION_PARTIAL_IMAGES}`);
	});
});

describe("CodexProvider credential reporting", () => {
	/** A manager stub that always hands out one account. */
	function withAccount(provider: CodexProvider) {
		const manager = (provider as unknown as { manager: Record<string, unknown> }).manager;
		const ctx = {
			id: "codex-account-1",
			token: "tok",
			authorization: "Bearer tok",
			credential: {
				id: "codex-account-1",
				accountId: "acc-1",
				disabled: false,
				expiresAt: Date.now() + 3_600_000,
				authMode: "oauth",
			},
		};
		const originals = { ...manager };
		Object.assign(manager, {
			acquireContext: async () => ctx,
			refreshUsageOnUseIfNeeded: async () => {},
			snapshot: () => ({ available: 1, entries: [] }),
			reportSuccess: () => {},
			isDiagnosticCredentialCurrent: () => true,
		});
		return () => Object.assign(manager, originals);
	}

	async function run(useWebSocket: boolean) {
		const provider = new CodexProvider({ useWebSocket });
		const restore = withAccount(provider);
		// The inner adapter is configured with id "codex" and may say so.
		const chat = spyOn(OpenAIProvider.prototype, "chat").mockImplementation(async function* (
			params: ChatParams,
		) {
			params.onRequestStart?.({ credentialId: "codex" });
			yield { text: "hi", credentialId: "codex" };
		} as never);
		if (useWebSocket) {
			// Force the WebSocket attempt onto its SSE fallback before anything is sent.
			(provider as unknown as Record<string, unknown>).buildResponsesWebSocketRequest = () => {
				throw new CodexWebSocketFallbackError("WebSocket unavailable");
			};
		}
		const started: Array<string | undefined> = [];
		const events: Array<string | undefined> = [];
		try {
			for await (const event of provider.chat({
				conversationId: "conv-credential",
				content: "hello",
				model: "gpt-5.5",
				cwd: process.cwd(),
				history: [],
				tools: [],
				toolResults: [],
				signal: new AbortController().signal,
				onRequestStart: (info) => started.push(info?.credentialId),
			})) {
				events.push(event.credentialId);
			}
		} finally {
			chat.mockRestore();
			restore();
		}
		return { started, events };
	}

	test("HTTP mode reports the account, never the inner adapter's id", async () => {
		expect(await run(false)).toEqual({
			started: ["codex-account-1"],
			events: ["codex-account-1"],
		});
	});

	test("the WebSocket mode's SSE fallback reports the account at request start", async () => {
		expect(await run(true)).toEqual({
			started: ["codex-account-1"],
			events: ["codex-account-1"],
		});
	});

	test("non-streaming results are billed to the account", async () => {
		const provider = new CodexProvider({ useWebSocket: false });
		const restore = withAccount(provider);
		const result = { text: "summary", usage: undefined };
		const generate = spyOn(OpenAIProvider.prototype, "generateWithMeta").mockResolvedValue(
			result as never,
		);
		const history = spyOn(
			OpenAIProvider.prototype,
			"generateWithHistoryWithMeta",
		).mockResolvedValue(result as never);
		try {
			expect((await provider.generateWithMeta("hi", "gpt-5.5")).credentialId).toBe(
				"codex-account-1",
			);
			expect(
				(await provider.generateWithHistoryWithMeta("sys", "hi", "gpt-5.5")).credentialId,
			).toBe("codex-account-1");
		} finally {
			generate.mockRestore();
			history.mockRestore();
			restore();
		}
	});
});
