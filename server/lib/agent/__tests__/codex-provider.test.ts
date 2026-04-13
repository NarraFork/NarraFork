import { describe, expect, test } from "bun:test";
import { CodexProvider } from "../codex-provider";

describe("CodexProvider Responses WebSocket image handling", () => {
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
				}): { input: unknown[] };
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
		expect(inputJson).toContain('"type":"function_call_output"');
		expect(inputJson).toContain('"call_id":"call_img"');
		expect(inputJson).toContain('"type":"input_image"');
		expect(inputJson).toContain('"image_url":"data:image/png;base64,');
	});
});
