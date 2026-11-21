import { afterEach, expect, test } from "bun:test";
import { setOutboundFetchOverrideForTest } from "../../net/outbound-fetch";
import { setNugCachedModels } from "../../nug-model-cache";
import { NugProvider } from "../nug-provider";

afterEach(() => setOutboundFetchOverrideForTest(null));

for (const mode of [undefined, "off", "inline", "separate"] as const) {
	test(`NUG Chat Completions sends tool images only when enabled: ${mode}`, async () => {
		const id = `tool-images-${mode}`;
		setNugCachedModels(id, [
			{ id: "openai:model", channel: "openai", channelType: "openai", model: "model" },
		]);
		const provider = new NugProvider({
			id,
			name: "Test",
			prefix: "nug",
			apiKey: "test-key",
			baseUrl: "https://nug.example.test",
			defaultModel: "openai:model",
			toolResultImages: mode,
		});
		let body = "";
		setOutboundFetchOverrideForTest(async (input, init) => {
			expect(String(input)).toBe("https://nug.example.test/v1/chat/completions");
			body = String(init?.body);
			return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		});
		for await (const _ of provider.chat({
			model: "nug:openai:model",
			conversationId: "test",
			content: "",
			cwd: ".",
			history: [],
			tools: [],
			toolResults: [
				{
					tool_call_id: "call-1",
					content: "read",
					_images: [{ format: "png", mediaType: "image/png", base64: "aGVsbG8=" }],
				},
			],
			signal: new AbortController().signal,
		})) {
		}
		expect(body).toContain("read");
		expect(body.includes("data:image/png;base64,aGVsbG8=")).toBe(
			mode === "inline" || mode === "separate",
		);
	});
}
