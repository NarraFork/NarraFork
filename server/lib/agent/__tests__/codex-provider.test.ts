import { describe, expect, test } from "bun:test";
import { CodexProvider, isCodexProviderExpected101WebSocketFailure } from "../codex-provider";
import { OpenAIProvider, supportsCodexImageGeneration } from "../openai-provider";

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

	test("gpt-5.3-codex-spark is not allowed to use native image generation", () => {
		expect(supportsCodexImageGeneration("codex:gpt-5.3-codex-spark")).toBe(false);
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
			model: "codex:gpt-5.3-codex",
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
			model: "codex:gpt-5.3-codex",
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
	});

	test("OpenAI codex mode does not inject image_generation when disabled", () => {
		const provider = new OpenAIProvider({
			id: "codex-gateway",
			name: "Codex Gateway",
			prefix: "gateway",
			apiKey: "token",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			defaultModel: "gpt-5.3-codex",
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
			model: "gateway:gpt-5.3-codex",
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
			defaultModel: "gpt-5.3-codex",
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
			model: "gateway:gpt-5.3-codex",
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
	});

	test("buildResponsesWebSocketRequest does not inject image_generation for spark", () => {
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
			model: "codex:gpt-5.3-codex-spark",
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
		expect(toolsJson).not.toContain('"type":"image_generation"');
	});

	test("buildResponsesWebSocketRequest emits tool result images as input_image items", () => {
		const provider = new CodexProvider({ useWebSocket: true });
		const toolResult = provider.formatToolResult("call_img", "Screenshot ready", false, [
			{
				format: "png",
				base64:
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
			},
		]);

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
			model: "openai:gpt-5.3-codex",
			history: [],
			toolResults: [toolResult],
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
	});
});
