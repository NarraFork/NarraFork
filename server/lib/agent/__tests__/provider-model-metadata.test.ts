import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ModelMetadata } from "@shared/model-catalog/schema/catalog";
import { setNugCachedModels } from "../../nug-model-cache";
import {
	supportsNativeSearch,
	usesInlineNativeSearch,
	usesSideRequestNativeSearch,
} from "../../search/native";
import { executeSearch } from "../../search/router";
import { customSearchChannelId } from "../../search/settings";
import { settings } from "../../settings";
import { AnthropicProvider, getAnthropicEffectiveContextWindow } from "../anthropic-provider";
import { CodexProvider } from "../codex-provider";
import { GeminiInteractionsProvider } from "../gemini-interactions-provider";
import { GeminiProvider } from "../gemini-provider";
import { NugProvider } from "../nug-provider";
import { OpenAIProvider } from "../openai-provider";
import type { ChatParams, ProviderAdapter } from "../provider";
import {
	assertModelInputModalities,
	resolveMetadataReasoning,
	resolveOutputTokenLimit,
} from "../provider-model-metadata";

const config = {
	id: "metadata-runtime",
	prefix: "metadata-runtime",
	name: "Metadata runtime",
	apiKey: "test",
	baseUrl: "https://example.invalid/v1",
	defaultModel: "opaque",
};
const model = `${config.prefix}:opaque`;
const originalFetch = globalThis.fetch;
let savedCatalog: typeof settings.agent.modelCatalog;
let savedOpenAI: typeof settings.openaiProviders;
let savedAnthropic: typeof settings.anthropicProviders;
let savedNug: typeof settings.nugProviders;
let savedFingerprint: typeof settings.clientFingerprint;
let savedSearch: typeof settings.search;
let requests: Record<string, any>[] = [];
function setMetadata(metadata: ModelMetadata): void {
	settings.agent.modelCatalog = {
		schemaVersion: 1,
		migrationVersion: 1,
		autoApply: false,
		pinnedVersion: null,
		local: {
			revision: 101,
			models: [{ id: "runtime-card", metadata: {} }],
			bindings: [
				{
					id: "runtime-binding",
					providerId: config.id,
					upstreamModelId: "opaque",
					modelId: "runtime-card",
					overrides: metadata,
				},
			],
		},
	};
}
function params(extra: Partial<ChatParams> = {}): ChatParams {
	return {
		model,
		history: [],
		content: "hello",
		tools: [],
		toolResults: [],
		cwd: ".",
		conversationId: "metadata-request",
		signal: new AbortController().signal,
		...extra,
	};
}
async function captureChat(
	provider: ProviderAdapter,
	extra: Partial<ChatParams> = {},
): Promise<Record<string, any>> {
	const start = requests.length;
	await expect(provider.chat(params(extra)).next()).rejects.toThrow();
	expect(requests.length).toBeGreaterThan(start);
	return requests.at(-1)!;
}
async function captureGenerate(
	provider: ProviderAdapter,
	requested?: number,
	history = false,
): Promise<Record<string, any>> {
	const start = requests.length;
	const options = { maxOutputTokens: requested, reasoningEffort: "max" as const };
	await expect(
		history
			? provider.generateWithHistoryWithMeta!("system", "hello", model, "en", options)
			: provider.generateWithMeta!("hello", model, undefined, options),
	).rejects.toThrow();
	expect(requests.length).toBeGreaterThan(start);
	return requests.at(-1)!;
}
beforeEach(() => {
	savedCatalog = settings.agent.modelCatalog;
	savedOpenAI = settings.openaiProviders;
	savedAnthropic = settings.anthropicProviders;
	savedNug = settings.nugProviders;
	savedFingerprint = settings.clientFingerprint;
	savedSearch = settings.search;
	settings.clientFingerprint = {
		installationId: "11111111-2222-4333-8444-555555555555",
		claudeDeviceId: "a".repeat(64),
	};
	settings.openaiProviders = [...(savedOpenAI ?? []), { ...config, apiMode: "codex" }];
	settings.anthropicProviders = [...(savedAnthropic ?? []), { ...config, officialApi: true }];
	requests = [];
	setMetadata({
		limits: { maxOutputTokens: 2300 },
		reasoning: { supported: true, levels: ["low", "high"], canDisable: false, defaultLevel: "low" },
	});
	globalThis.fetch = (async (input, init) => {
		const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
		if (typeof raw === "string") requests.push(JSON.parse(raw));
		return new Response("simulated upstream unavailable", { status: 500 });
	}) as typeof fetch;
});
afterEach(() => {
	settings.agent.modelCatalog = savedCatalog;
	settings.openaiProviders = savedOpenAI;
	settings.anthropicProviders = savedAnthropic;
	settings.nugProviders = savedNug;
	settings.clientFingerprint = savedFingerprint;
	settings.search = savedSearch;
	globalThis.fetch = originalFetch;
});

describe("metadata policy", () => {
	test("output caps preserve lower requests, defaults, and unknown limits", () => {
		const metadata = { limits: { maxOutputTokens: 100 } };
		expect(resolveOutputTokenLimit(metadata, 20, 4096)).toBe(20);
		expect(resolveOutputTokenLimit(metadata, 200, 4096)).toBe(100);
		expect(resolveOutputTokenLimit(metadata)).toBe(100);
		expect(resolveOutputTokenLimit({})).toBeUndefined();
		expect(resolveOutputTokenLimit({ limits: { maxOutputTokens: null } }, 20)).toBe(20);
	});
	test("reasoning supported, allowed levels and disable policy", () => {
		expect(resolveMetadataReasoning({}, "xhigh")).toBe("xhigh");
		expect(resolveMetadataReasoning({ reasoning: { supported: false } }, "max")).toBeUndefined();
		expect(
			resolveMetadataReasoning(
				{ reasoning: { levels: ["low", "high"], canDisable: false } },
				"none",
			),
		).toBe("low");
		expect(
			resolveMetadataReasoning(
				{ reasoning: { levels: ["low", "high"], canDisable: true } },
				"none",
			),
		).toBe("none");
	});
	test("output image capability does not imply input image capability", () => {
		expect(() =>
			assertModelInputModalities("opaque", [{ type: "input_image" }], {
				modalities: { input: ["text"], output: ["image"] },
			}),
		).toThrow("image input");
		expect(() =>
			assertModelInputModalities("opaque", [{ type: "input_image" }], {
				modalities: { output: ["text"] },
			}),
		).not.toThrow();
	});
});

describe("actual provider request bodies", () => {
	for (const apiMode of ["completions", "responses", "codex"] as const) {
		test(`OpenAI ${apiMode} chat and both utility paths enforce binding output/reasoning`, async () => {
			const provider = new OpenAIProvider({ ...config, apiMode, codexWebSocket: false });
			const body = await captureChat(provider, { reasoningEffort: "none", maxOutputTokens: 20000 });
			if (apiMode === "completions") {
				expect(body.max_tokens).toBe(2300);
				expect(body.max_output_tokens).toBeUndefined();
			} else if (apiMode === "responses") {
				expect(body.max_output_tokens).toBe(2300);
				expect(body.max_tokens).toBeUndefined();
			} else {
				// Only Codex endpoints omit the output ceiling.
				expect(body.max_output_tokens).toBeUndefined();
				expect(body.max_tokens).toBeUndefined();
			}
			expect(apiMode === "completions" ? body.reasoning_effort : body.reasoning?.effort).toBe(
				"low",
			);
			if (apiMode === "completions") {
				expect((await captureGenerate(provider, 77)).max_tokens).toBe(77);
				expect((await captureGenerate(provider, 20000, true)).max_tokens).toBe(2300);
			} else if (apiMode === "responses") {
				expect((await captureGenerate(provider, 77)).max_output_tokens).toBe(77);
				expect((await captureGenerate(provider, 20000, true)).max_output_tokens).toBe(2300);
			} else {
				expect((await captureGenerate(provider, 77)).max_output_tokens).toBeUndefined();
				expect((await captureGenerate(provider, 20000, true)).max_output_tokens).toBeUndefined();
			}
		});
	}
	test("both Codex WebSocket request constructors omit max_output_tokens but enforce reasoning", () => {
		for (const provider of [
			new OpenAIProvider({ ...config, apiMode: "codex" }),
			new CodexProvider({ useWebSocket: true }),
		]) {
			const instance = provider as unknown as {
				buildCodexWebSocketRequest?: (p: ChatParams) => any;
				buildResponsesWebSocketRequest?: (p: ChatParams) => any;
			};
			const body = (instance.buildCodexWebSocketRequest ??
				instance.buildResponsesWebSocketRequest)!.call(
				provider,
				params({ maxOutputTokens: 99, reasoningEffort: "max" }),
			);
			expect(body.max_output_tokens).toBeUndefined();
			expect(body.reasoning.effort).toBe("high");
		}
	});
	test("Anthropic chat and utility max_tokens use the same binding and legal thinking budget", async () => {
		const provider = new AnthropicProvider(config);
		const body = await captureChat(provider, { reasoningEffort: "none" });
		expect(body.max_tokens).toBe(2300);
		expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2299 });
		expect(body.output_config.effort).toBe("low");
		expect((await captureGenerate(provider, 1300)).max_tokens).toBe(1300);
		const count = requests.length;
		await expect(
			provider.generateWithMeta("hello", model, undefined, {
				maxOutputTokens: 700,
				reasoningEffort: "none",
			}),
		).rejects.toThrow("minimum thinking budget");
		expect(requests).toHaveLength(count);
		expect((await captureGenerate(provider, 99999, true)).max_tokens).toBe(2300);
	});
	for (const [name, Provider] of [
		["generateContent", GeminiProvider],
		["interactions", GeminiInteractionsProvider],
	] as const) {
		test(`Gemini ${name} propagates output caps through chat and utility paths`, async () => {
			const provider = new Provider(config);
			const value = (body: any) =>
				name === "generateContent"
					? body.generationConfig?.maxOutputTokens
					: body.generation_config?.max_output_tokens;
			expect(value(await captureChat(provider))).toBe(2300);
			expect(value(await captureGenerate(provider, 65))).toBe(65);
			expect(value(await captureGenerate(provider, 99999, true))).toBe(2300);
		});
	}
	test("fixed reasoning never receives a fabricated effort or a forbidden disable", async () => {
		setMetadata({ reasoning: { supported: true, mode: "fixed", canDisable: false } });
		const body = await captureChat(
			new OpenAIProvider({ ...config, apiMode: "codex", codexWebSocket: false }),
			{ reasoningEffort: "none" },
		);
		expect(body.reasoning?.effort).toBeUndefined();
	});
	test("fixed-but-disableable reasoning preserves an explicit disable", async () => {
		setMetadata({ reasoning: { supported: true, mode: "fixed", canDisable: true } });
		const body = await captureChat(
			new OpenAIProvider({ ...config, apiMode: "codex", codexWebSocket: false }),
			{ reasoningEffort: "none" },
		);
		expect(body.reasoning.effort).toBe("none");
	});
	test("Gemini disable respects the adapter mapping rather than silently enabling thinking", async () => {
		setMetadata({ reasoning: { supported: true, canDisable: true, mode: "budget" } });
		const body = await captureChat(new GeminiProvider(config), { reasoningEffort: "none" });
		expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
		const count = requests.length;
		await expect(
			new GeminiInteractionsProvider(config).chat(params({ reasoningEffort: "none" })).next(),
		).rejects.toThrow("generateContent");
		expect(requests).toHaveLength(count);
	});
	test("known unsupported reasoning sends no thinking configuration", async () => {
		setMetadata({ reasoning: { supported: false } });
		for (const provider of [
			new OpenAIProvider({ ...config, apiMode: "codex", codexWebSocket: false }),
			new AnthropicProvider(config),
			new GeminiProvider(config),
			new GeminiInteractionsProvider(config),
		]) {
			const body = await captureChat(provider, { reasoningEffort: "max" });
			expect(body.reasoning).toBeUndefined();
			expect(body.thinking).toBeUndefined();
			expect(body.output_config).toBeUndefined();
			expect(body.generationConfig?.thinkingConfig).toBeUndefined();
			expect(body.generation_config?.thinking_level).toBeUndefined();
		}
	});
	test("known unsupported current and history images fail before transport without mutating history", async () => {
		setMetadata({ modalities: { input: ["text"], output: ["image"] } });
		for (const provider of [
			new OpenAIProvider({ ...config, apiMode: "responses" }),
			new AnthropicProvider(config),
			new GeminiProvider(config),
			new GeminiInteractionsProvider(config),
		]) {
			await expect(
				provider.chat(params({ images: [{ format: "png", base64: "AA==" }] })).next(),
			).rejects.toThrow("image input");
		}
		const history = [
			{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] },
		];
		const snapshot = structuredClone(history);
		await expect(
			new OpenAIProvider({ ...config, apiMode: "responses" }).chat(params({ history })).next(),
		).rejects.toThrow("image input");
		expect(history).toEqual(snapshot);
		expect(requests).toHaveLength(0);
	});
	for (const channelType of ["openai", "responses", "codex", "anthropic"]) {
		test(`NUG ${channelType} delegate retains channel binding capabilities`, async () => {
			const nugConfig = { ...config, id: "runtime-nug", prefix: "runtime-nug" };
			settings.nugProviders = [...(savedNug ?? []), nugConfig];
			setNugCachedModels(nugConfig.id, [
				{ id: "channel:opaque", channel: "channel", channelType, model: "opaque" },
			]);
			settings.agent.modelCatalog!.local.bindings!.push({
				id: "nug-runtime-binding",
				providerId: nugConfig.id,
				channelId: "channel",
				upstreamModelId: "opaque",
				modelId: "runtime-card",
				overrides: { limits: { maxOutputTokens: 101 }, reasoning: { supported: false } },
			});
			const body = await captureChat(new NugProvider(nugConfig), {
				model: "runtime-nug:channel:opaque",
			});
			// Only the Codex channel omits output ceiling fields.
			if (channelType === "openai") {
				expect(body.max_tokens).toBe(101);
				expect(body.max_output_tokens).toBeUndefined();
			} else if (channelType === "anthropic") {
				expect(body.max_tokens).toBe(101);
			} else if (channelType === "responses") {
				expect(body.max_output_tokens).toBe(101);
				expect(body.max_tokens).toBeUndefined();
			} else {
				expect(body.max_tokens).toBeUndefined();
				expect(body.max_output_tokens).toBeUndefined();
			}
			expect(body.model).toBe("channel:opaque");
			await expect(
				new NugProvider(nugConfig).generateWithMeta(
					"utility",
					"runtime-nug:channel:opaque",
					undefined,
					{ maxOutputTokens: 51 },
				),
			).rejects.toThrow();
			const utility = requests.at(-1)!;
			if (channelType === "openai" || channelType === "anthropic") {
				expect(utility.max_tokens).toBe(51);
			} else if (channelType === "responses") {
				expect(utility.max_output_tokens).toBe(51);
				expect(utility.max_tokens).toBeUndefined();
			} else {
				expect(utility.max_tokens).toBeUndefined();
				expect(utility.max_output_tokens).toBeUndefined();
			}
			expect(utility.model).toBe("channel:opaque");
		});
	}
});

describe("native search and context policy", () => {
	test("Codex model gating removes inline search but retains ordinary WebSearch", async () => {
		setMetadata({ nativeSearch: { supported: false } });
		settings.search = {
			...settings.search,
			customProviders: settings.search?.customProviders ?? [],
			channels: [{ id: "native", kind: "native", enabled: true }],
		};
		const body = await captureChat(
			new OpenAIProvider({ ...config, apiMode: "codex", codexWebSocket: false }),
			{
				tools: [{ type: "web_search" }, { type: "function", name: "WebSearch", parameters: {} }],
			},
		);
		expect(body.tools.some((tool: { type: string }) => tool.type === "web_search")).toBe(false);
		expect(body.tools.some((tool: { name?: string }) => tool.name === "WebSearch")).toBe(true);
	});
	test("local provider opt-out wins over declared native search support", () => {
		setMetadata({ nativeSearch: { supported: true } });
		settings.openaiProviders = [{ ...config, apiMode: "codex", codexWebSearch: false }];
		expect(usesInlineNativeSearch(config.prefix, model)).toBe(false);
	});
	test("model-level native denial falls through to the next ordinary search channel", async () => {
		setMetadata({ nativeSearch: { supported: false } });
		const fallbackId = "metadata-fallback";
		settings.search = {
			...settings.search,
			customProviders: [
				{
					id: fallbackId,
					name: "Fallback",
					protocol: "zhipu-web-search-v1",
					baseUrl: "https://fallback.invalid/search",
					apiKey: "key",
				},
			],
			channels: [
				{ id: "native", kind: "native", enabled: true },
				{
					id: customSearchChannelId(fallbackId),
					kind: "custom-api",
					providerId: fallbackId,
					enabled: true,
				},
			],
		};
		const urls: string[] = [];
		globalThis.fetch = (async (input) => {
			urls.push(String(input));
			return Response.json({
				search_result: [
					{ title: "Fallback result", link: "https://result.invalid", content: "matched" },
				],
			});
		}) as typeof fetch;
		const result = await executeSearch({ query: "test", provider: config.prefix, model });
		expect(urls).toHaveLength(1);
		expect(urls[0]).toContain("fallback.invalid");
		expect(JSON.stringify(result)).toContain("Fallback result");
	});
	test("declared unsupported native search keeps the ordinary search entry point", async () => {
		setMetadata({ nativeSearch: { supported: false } });
		expect(usesInlineNativeSearch(config.prefix, model)).toBe(false);
		expect(usesSideRequestNativeSearch(config.prefix, model)).toBe(false);
		expect(supportsNativeSearch(config.prefix, model)).toBe(false);
		await expect(
			new AnthropicProvider({ ...config, officialApi: true }).performWebSearch({
				model,
				query: "test",
			}),
		).rejects.toThrow("native search");
		expect(requests).toHaveLength(0);
	});
	test("declared true does not invent an inline adapter for Gemini", () => {
		setMetadata({ nativeSearch: { supported: true } });
		expect(usesInlineNativeSearch("gemini", model)).toBe(false);
	});
	test("user binding context window is not raised by the Anthropic official floor", () => {
		settings.agent.modelCatalog!.local.bindings = [
			{
				id: "window",
				providerId: config.id,
				upstreamModelId: "claude-opus-4-8",
				overrides: { limits: { contextWindow: 32000, maxOutputTokens: 16000 } },
			},
		];
		expect(
			getAnthropicEffectiveContextWindow(`${config.prefix}:claude-opus-4-8`, {
				...config,
				officialApi: true,
			}),
		).toBe(32000);
	});
});
