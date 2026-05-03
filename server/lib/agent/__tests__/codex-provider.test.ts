import { describe, expect, test } from "bun:test";
import { CodexProvider } from "../codex-provider";
import { supportsCodexImageGeneration } from "../openai-provider";

describe("CodexProvider Responses WebSocket image handling", () => {
	test("gpt-5.3-codex-spark is not allowed to use native image generation", () => {
		expect(supportsCodexImageGeneration("codex:gpt-5.3-codex-spark")).toBe(false);
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
