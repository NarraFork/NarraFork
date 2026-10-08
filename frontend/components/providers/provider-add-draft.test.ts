import { describe, expect, test } from "bun:test";
import { parseModelId } from "../../../shared/model-id";
import type { AddProviderDraft } from "./provider-add-draft";
import {
	customProviderFromDraft,
	draftFromPreset,
	isValidProviderDraft,
	nugProviderFromDraft,
	sanitizeProviderPrefix,
	updateDraftConnection,
} from "./provider-add-draft";
import { PROVIDER_PRESETS, type ProviderPreset } from "./provider-presets";
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

	test("prefers Responses, then Messages, then Completions over the registry default", () => {
		const preset: ProviderPreset = {
			id: "priority",
			name: "Priority",
			defaultProtocol: "completions-compatible",
			endpoints: {
				"completions-compatible": "https://example.com/chat/v1",
				"anthropic-messages": "https://example.com/anthropic/v1",
				"openai-responses": "https://example.com/responses/v1",
			},
		};
		expect(draftFromPreset(preset)).toMatchObject({
			protocol: "openai-responses",
			baseUrl: "https://example.com/responses/v1",
		});
		delete preset.endpoints["openai-responses"];
		expect(draftFromPreset(preset)).toMatchObject({
			protocol: "anthropic-messages",
			baseUrl: "https://example.com/anthropic/v1",
		});
		delete preset.endpoints["anthropic-messages"];
		expect(draftFromPreset(preset)).toMatchObject({
			protocol: "completions-compatible",
			baseUrl: "https://example.com/chat/v1",
		});
	});

	test("built-in selections choose only supported protocols using the preferred priority", () => {
		for (const [id, protocol] of [
			["deepseek", "openai-responses"],
			["zhipu", "anthropic-messages"],
			["groq", "completions-compatible"],
			["gemini", "gemini-compatible"],
		] as const) {
			const preset = PROVIDER_PRESETS.find((item) => item.id === id);
			if (!preset) throw new Error(`Missing preset ${id}`);
			expect(draftFromPreset(preset)).toMatchObject({
				protocol,
				baseUrl: preset.endpoints[protocol],
			});
		}
	});

	test("explicit single-protocol custom choices stay unchanged, including empty URLs", () => {
		for (const protocol of [
			"openai-responses",
			"anthropic-messages",
			"completions-compatible",
			"gemini-compatible",
			"nug",
		] as const) {
			expect(
				draftFromPreset({
					id: "custom",
					name: "Custom",
					defaultProtocol: protocol,
					endpoints: { [protocol]: "" },
				}),
			).toMatchObject({ protocol, baseUrl: "" });
		}
	});

	test("switching connection retains credentials and replaces only connection-derived fields", () => {
		const previous = {
			...draft,
			name: "My name",
			prefix: "team",
			apiKey: "old-account-key",
			baseUrl: "https://my-proxy.example.test/v1",
		};
		const next = updateDraftConnection(
			previous,
			{
				id: "subscription",
				name: "Generated name",
				defaultProtocol: "completions-compatible",
				endpoints: {
					"openai-responses": "https://subscription.example.test/v1",
					"completions-compatible": "https://subscription.example.test/v1",
				},
			},
			"narrafork",
		);
		expect(next).toMatchObject({
			name: "My name",
			prefix: "team",
			apiKey: "old-account-key",
			baseUrl: "https://subscription.example.test/v1",
			protocol: "openai-responses",
			userAgentMode: "narrafork",
		});
		expect(previous.apiKey).toBe("old-account-key");
		const pending = updateDraftConnection(next, null);
		expect(pending.baseUrl).toBe("");
		expect(pending.name).toBe("My name");
		expect(isValidProviderDraft(pending)).toBe(false);
	});

	test("saving a subscription draft retains the real client identity without duplicating the key", () => {
		const provider = customProviderFromDraft("subscription", {
			...draft,
			protocol: "openai-responses",
			apiKey: "subscription-key",
			userAgentMode: "narrafork",
		});
		expect(provider.userAgentMode).toBe("narrafork");
		expect(provider.apiKey).toBe("subscription-key");
		expect(provider.extraHeaders).toBeUndefined();
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
