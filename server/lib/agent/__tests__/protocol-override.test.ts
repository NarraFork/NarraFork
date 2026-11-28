import { describe, expect, test } from "bun:test";
import { normalizeCustomApiProviderSettings, settings } from "../../settings";
import { OpenAIProvider } from "../openai-provider";
import {
	connectionForProtocolSwitch,
	openAIFamilyProtocol,
	protocolMatchesConnection,
} from "../protocol-override";
import { resolveProviderAndModel } from "../provider";

describe("protocol override keeps the connection", () => {
	for (const protocol of ["anthropic-messages", "gemini-compatible"] as const) {
		for (const mode of [undefined, "off", "inline", "separate"] as const) {
			test(`${protocol} preserves ${mode} tool images when overridden to Chat Completions`, () => {
				const original = structuredClone(settings);
				try {
					settings.customApiProviders = [
						{
							id: "image-override",
							name: "Image override",
							prefix: "image-override",
							apiKey: "test-key",
							baseUrl: "https://example.com/v1",
							defaultModel: "chat",
							protocol,
							toolResultImages: mode,
						},
					];
					normalizeCustomApiProviderSettings(settings);
					settings.agent.modelProtocolOverrides = {
						"image-override:chat": "completions-compatible",
					};
					const { adapter } = resolveProviderAndModel("image-override:chat");
					expect(adapter).toBeInstanceOf(OpenAIProvider);
					const config = (
						adapter as unknown as { config: { apiMode: string; toolResultImages?: string } }
					).config;
					expect(config.apiMode).toBe("completions");
					expect(config.toolResultImages).toBe(mode);
				} finally {
					Object.assign(settings, original);
				}
			});
		}
	}
	test("copies proxy, headers and fingerprint onto the switched adapter config", () => {
		const headers = () => ({ "X-Channel": "live" });
		const shared = connectionForProtocolSwitch(
			{
				id: "p1",
				name: "Demo",
				prefix: "demo",
				apiKey: "secret",
				baseUrl: "https://upstream.example/v1",
				proxy: { mode: "custom", url: "http://127.0.0.1:9" },
				extraHeaders: { "X-Test": "1" },
				dynamicHeaders: headers,
				userAgentMode: "custom",
				customUserAgent: "demo-agent",
				officialApi: true,
			},
			"demo:claude-sonnet",
		);
		expect(shared.proxy).toEqual({ mode: "custom", url: "http://127.0.0.1:9" });
		expect(shared.extraHeaders).toEqual({ "X-Test": "1" });
		expect(shared.dynamicHeaders).toBe(headers);
		expect(shared.customUserAgent).toBe("demo-agent");
		expect(shared.officialApi).toBe(true);
		expect(shared.defaultModel).toBe("claude-sonnet");
	});

	test("a matching protocol stays on the original adapter", () => {
		expect(protocolMatchesConnection("anthropic", {}, "anthropic-messages")).toBe(true);
		expect(protocolMatchesConnection("openai", { apiMode: "codex" }, "openai-responses")).toBe(
			true,
		);
		expect(
			protocolMatchesConnection("openai", { apiMode: "responses" }, "completions-compatible"),
		).toBe(false);
		expect(protocolMatchesConnection("nug", {}, "anthropic-messages")).toBe(false);
		expect(openAIFamilyProtocol({ responsesApi: false })).toBe("completions-compatible");
	});
});
