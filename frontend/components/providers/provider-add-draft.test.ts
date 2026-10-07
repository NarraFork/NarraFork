import { describe, expect, test } from "bun:test";
import { parseModelId } from "../../../shared/model-id";
import type { AddProviderDraft } from "./provider-add-draft";
import {
	customProviderFromDraft,
	draftFromPreset,
	isValidProviderDraft,
	nugProviderFromDraft,
	sanitizeProviderPrefix,
} from "./provider-add-draft";
import { providersStateFromSettings } from "./providers-reducer";

const draft: AddProviderDraft = {
	protocol: "completions-compatible",
	name: "Local",
	apiKey: "",
	prefix: "",
	baseUrl: "http://localhost:11434/v1",
};

describe("provider addition draft", () => {
	test("permits local HTTP and optional credentials but rejects invalid base URLs", () => {
		expect(isValidProviderDraft(draft)).toBe(true);
		for (const baseUrl of [
			"",
			"api.example.com",
			"file:///tmp/api",
			"javascript:alert(1)",
			"https://key:secret@example.com",
		]) {
			expect(isValidProviderDraft({ ...draft, baseUrl })).toBe(false);
		}
		expect(isValidProviderDraft({ ...draft, name: "  " })).toBe(false);
	});

	test("new selection fills the default endpoint and never carries credentials", () => {
		expect(
			draftFromPreset({
				id: "test",
				name: "Test",
				defaultProtocol: "anthropic-messages",
				endpoints: {
					"anthropic-messages": "https://example.com/anthropic",
					"completions-compatible": "https://example.com/v1",
				},
			}),
		).toEqual({
			protocol: "anthropic-messages",
			name: "Test",
			baseUrl: "https://example.com/anthropic",
			apiKey: "",
			prefix: "",
		});
	});

	test("creation retains edited values without claiming a connection or inventing models", () => {
		const provider = customProviderFromDraft("immutable-id", {
			...draft,
			protocol: "completions-compatible",
			name: " Local ",
			apiKey: " secret ",
			prefix: " local ",
		});
		expect(provider).toMatchObject({
			id: "immutable-id",
			name: "Local",
			prefix: "local",
			apiKey: "secret",
			baseUrl: draft.baseUrl,
			defaultModel: "",
			protocol: "completions-compatible",
			tlsRejectUnauthorized: true,
		});
	});

	test("prefix sanitization matches existing configuration and preserves other text", () => {
		expect(sanitizeProviderPrefix(" team:api:: ")).toBe(" teamapi ");
		expect(sanitizeProviderPrefix("团队 / api-v2")).toBe("团队 / api-v2");
		expect(sanitizeProviderPrefix(":")).toBe("");
	});

	test("custom API prefixes survive settings serialization and model parsing", () => {
		for (const protocol of [
			"completions-compatible",
			"anthropic-messages",
			"openai-responses",
			"gemini-compatible",
		] as const) {
			const provider = customProviderFromDraft("custom-id", {
				...draft,
				protocol,
				prefix: " team:api:: ",
			});
			const state = providersStateFromSettings(
				JSON.parse(JSON.stringify({ customApiProviders: [provider], agent: {} })),
			);
			const saved = state.customApiProviders[0];
			expect(saved?.prefix).toBe("teamapi");
			expect(parseModelId(`${saved?.prefix}:channel:model`)).toEqual({
				provider: "teamapi",
				model: "channel:model",
			});
		}
	});

	test("NUG prefixes survive settings serialization and model parsing", () => {
		const provider = nugProviderFromDraft("nug-id", {
			...draft,
			protocol: "nug",
			prefix: " team:api:: ",
		});
		const state = providersStateFromSettings(
			JSON.parse(JSON.stringify({ nugProviders: [provider], agent: {} })),
		);
		const saved = state.nugProviders[0];
		expect(saved?.prefix).toBe("teamapi");
		expect(parseModelId(`${saved?.prefix}:channel:model`)).toEqual({
			provider: "teamapi",
			model: "channel:model",
		});
		expect(saved?.id).toBe("nug-id");
	});

	test("Gemini uses generateContent and does not prefill a potentially stale default model", () => {
		const provider = customProviderFromDraft("gemini", { ...draft, protocol: "gemini-compatible" });
		expect(provider.geminiTransport).toBe("generate-content");
		expect(provider.defaultModel).toBe("");
	});
});
