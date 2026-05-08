import { describe, expect, test } from "bun:test";
import {
	customApiProtocolFromOpenAI,
	deriveCustomApiProvidersFromLegacy,
} from "../custom-api-providers";
import type { OpenAIProviderConfig } from "../types";

describe("custom API provider migration", () => {
	test("preserves legacy responsesApi=false as completions-compatible", () => {
		const provider: OpenAIProviderConfig = {
			id: "legacy-openai",
			name: "Legacy OpenAI Compatible",
			prefix: "legacy",
			apiKey: "sk-test",
			baseUrl: "https://example.com/v1",
			defaultModel: "test-model",
			responsesApi: false,
		};

		expect(customApiProtocolFromOpenAI(provider)).toBe("completions-compatible");
		expect(deriveCustomApiProvidersFromLegacy([provider], [])[0]?.protocol).toBe(
			"completions-compatible",
		);
	});

	test("apiMode takes precedence over legacy responsesApi", () => {
		const provider: OpenAIProviderConfig = {
			id: "explicit-responses",
			name: "Explicit Responses",
			prefix: "responses",
			apiKey: "sk-test",
			baseUrl: "https://example.com/v1",
			defaultModel: "test-model",
			responsesApi: false,
			apiMode: "responses",
		};

		expect(customApiProtocolFromOpenAI(provider)).toBe("responses-compatible");
	});
});
