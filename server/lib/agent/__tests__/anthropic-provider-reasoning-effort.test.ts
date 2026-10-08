import { afterEach, describe, expect, test } from "bun:test";
import type { ModelMetadata } from "@shared/model-catalog/schema/catalog";
import {
	bindModelCatalogSettings,
	getEffectiveModelMetadata,
	getModelCatalogSnapshot,
	mutateModelCatalog,
} from "../../model-catalog";
import { type AnthropicProviderConfig, saveSettings, settings } from "../../settings";
import type { NarraForkSettings } from "../../settings/types";
import { AnthropicProvider, mapEffortParam } from "../anthropic-provider";
import type { ChatParams } from "../provider";

/**
 * The specific regression this covers: a third-party model behind an
 * Anthropic-compatible relay (GLM, Kimi, MiniMax, ...) must receive
 * `output_config.effort`.
 *
 * Two things used to block it — the Claude-version whitelist in
 * `supportsEffort`, and the `thinkingEnabled` guard, which is false for any id
 * that is not Claude-shaped because `thinking` is an Anthropic-only block.
 */

function config(overrides?: Partial<AnthropicProviderConfig>): AnthropicProviderConfig {
	return {
		id: "relay",
		name: "Relay",
		prefix: "relay",
		apiKey: "sk-test",
		baseUrl: "https://example.invalid",
		defaultModel: "GLM-5.1",
		...overrides,
	} as AnthropicProviderConfig;
}

function chatParams(overrides?: Partial<ChatParams>): ChatParams {
	return {
		history: [],
		content: "hi",
		model: "relay:GLM-5.1",
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
		conversationId: "conv-1",
		...overrides,
	} as ChatParams;
}

const originalFetch = globalThis.fetch;
let capturedBody: Record<string, unknown> | null = null;
let capturedHeaders: Headers | null = null;

function mockFetchCapturingRequest(): void {
	capturedBody = null;
	capturedHeaders = null;
	globalThis.fetch = (async (_input, init) => {
		const req = init as RequestInit | undefined;
		capturedHeaders = new Headers(req?.headers);
		if (typeof req?.body === "string") capturedBody = JSON.parse(req.body);
		return new Response("upstream unavailable", { status: 500 });
	}) as typeof fetch;
}

async function sendAndCapture(
	provider: AnthropicProvider,
	params: ChatParams,
): Promise<Record<string, unknown>> {
	const iterator = provider.chat(params)[Symbol.asyncIterator]();
	try {
		await iterator.next();
	} catch {
		// Expected: the mock always fails the request.
	}
	expect(capturedBody).not.toBeNull();
	return capturedBody as Record<string, unknown>;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	capturedBody = null;
	capturedHeaders = null;
	bindModelCatalogSettings(settings, () => saveSettings(settings));
});

function installClaudeReasoningMetadata(
	modelId = "claude-opus-5",
	reasoning: ModelMetadata["reasoning"] = { supported: true },
): void {
	bindModelCatalogSettings(
		{
			anthropicProviders: [config()],
			agent: {
				modelCatalog: {
					schemaVersion: 1,
					migrationVersion: 1,
					local: { revision: 0 },
					autoApply: false,
					pinnedVersion: null,
				},
			},
		} as NarraForkSettings,
		() => {},
	);
	mutateModelCatalog({
		baseRevision: getModelCatalogSnapshot().local.revision,
		action: "upsert-model",
		model: { id: modelId, metadata: { reasoning } },
	});
	mutateModelCatalog({
		baseRevision: getModelCatalogSnapshot().local.revision,
		action: "upsert-binding",
		binding: {
			id: "claude-channel-fixture",
			providerId: "relay",
			upstreamModelId: `anthropic:${modelId}`,
			modelId,
			overrides: { reasoning },
		},
	});
	expect(getEffectiveModelMetadata(`relay:anthropic:${modelId}`).metadata.reasoning).toMatchObject(
		reasoning ?? {},
	);
}

type RequestPath = "chat" | "generate" | "history";

async function capturePath(
	provider: AnthropicProvider,
	path: RequestPath,
	model: string,
	reasoningEffort?: ChatParams["reasoningEffort"],
): Promise<Record<string, unknown>> {
	mockFetchCapturingRequest();
	if (path === "chat") return sendAndCapture(provider, chatParams({ model, reasoningEffort }));
	const request =
		path === "generate"
			? provider.generateWithMeta("hi", model, undefined, { reasoningEffort })
			: provider.generateWithHistoryWithMeta("sys", "hi", model, undefined, { reasoningEffort });
	await expect(request).rejects.toThrow();
	expect(capturedBody).not.toBeNull();
	return capturedBody as Record<string, unknown>;
}

const OPUS_45_BUDGET_REASONING: ModelMetadata["reasoning"] = {
	supported: true,
	mode: "budget",
	levels: null,
	canDisable: true,
	defaultLevel: null,
};

const REQUEST_PATHS: RequestPath[] = ["chat", "generate", "history"];

// Legacy Opus uses catalog-declared budget thinking, not a guessed adaptive mode.
// Effort is still valid independently of the thinking configuration.
describe("AnthropicProvider Opus 4.5 budget-mode effort", () => {
	test.each([
		[true, "low"],
		[true, "medium"],
		[false, "low"],
		[false, "medium"],
	] as const)("sends requested effort on official=%s tier=%s across all request paths", async (officialApi, tier) => {
		installClaudeReasoningMetadata("claude-opus-4-5", OPUS_45_BUDGET_REASONING);
		const provider = new AnthropicProvider(config({ officialApi }));
		const model = "relay:anthropic:claude-opus-4-5";
		for (const path of REQUEST_PATHS) {
			const body = await capturePath(provider, path, model, tier);
			expect(body.thinking).toEqual({
				type: "enabled",
				budget_tokens: path === "chat" ? 10_000 : 4_095,
			});
			expect(body.output_config).toEqual({ effort: tier });
		}
		expect(mapEffortParam(model, tier)).toBe(tier);
	});

	test.each([
		"high",
		"xhigh",
		"max",
	] as const)("clamps %s to the Opus 4.5 three-tier fallback", async (tier) => {
		installClaudeReasoningMetadata("claude-opus-4-5", OPUS_45_BUDGET_REASONING);
		const model = "relay:anthropic:claude-opus-4-5";
		expect(mapEffortParam(model, tier)).toBe("high");
		const body = await capturePath(new AnthropicProvider(config()), "chat", model, tier);
		expect(body.output_config).toEqual({ effort: "high" });
	});

	test("explicit metadata levels retain ownership of tier mapping", async () => {
		installClaudeReasoningMetadata("claude-opus-4-5", {
			...OPUS_45_BUDGET_REASONING,
			levels: ["low", "max"],
		});
		const model = "relay:anthropic:claude-opus-4-5";
		expect(mapEffortParam(model, "xhigh")).toBe("max");
		const body = await capturePath(new AnthropicProvider(config()), "chat", model, "xhigh");
		expect(body.output_config).toEqual({ effort: "max" });
	});

	test.each([
		undefined,
		"none",
	] as const)("does not invent effort for preference=%s", async (tier) => {
		installClaudeReasoningMetadata("claude-opus-4-5", OPUS_45_BUDGET_REASONING);
		const provider = new AnthropicProvider(config());
		for (const path of REQUEST_PATHS) {
			const body = await capturePath(provider, path, "relay:anthropic:claude-opus-4-5", tier);
			expect(body.output_config).toBeUndefined();
			if (tier === "none") expect(body.thinking).toEqual({ type: "disabled" });
		}
	});

	test.each([
		"claude-sonnet-4-5",
		"claude-opus-4-0",
		"claude-3-opus-20240229",
	])("catalog capability does not bypass the built-in rejection of %s", async (modelId) => {
		installClaudeReasoningMetadata(modelId, OPUS_45_BUDGET_REASONING);
		const model = `relay:anthropic:${modelId}`;
		expect(mapEffortParam(model, "low")).toBeUndefined();
		const provider = new AnthropicProvider(config());
		for (const path of REQUEST_PATHS) {
			const body = await capturePath(provider, path, model, "low");
			expect(body.output_config).toBeUndefined();
		}
	});

	test("retains the xhigh tier on Opus 4.7", async () => {
		const body = await capturePath(
			new AnthropicProvider(config()),
			"chat",
			"relay:claude-opus-4-7",
			"xhigh",
		);
		expect(body.output_config).toEqual({ effort: "xhigh" });
	});
});

describe("AnthropicProvider effort on third-party models", () => {
	test("sends output_config.effort for a non-Claude model", async () => {
		mockFetchCapturingRequest();
		const provider = new AnthropicProvider(config());
		const body = await sendAndCapture(provider, chatParams({ reasoningEffort: "high" }));
		expect(body.output_config).toEqual({ effort: "high" });
	});

	test("does not gate effort on the Claude-only adaptive thinking block", async () => {
		// A non-Claude id gets the classic relay thinking shape (enabled + budget),
		// never Claude's `adaptive` — and effort is sent regardless of thinking.
		mockFetchCapturingRequest();
		const provider = new AnthropicProvider(config());
		const body = await sendAndCapture(provider, chatParams({ reasoningEffort: "max" }));
		expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 10_000 });
		expect(body.output_config).toEqual({ effort: "max" });
	});

	test("passes xhigh through on a model with no known tier table", async () => {
		mockFetchCapturingRequest();
		const provider = new AnthropicProvider(config());
		const body = await sendAndCapture(provider, chatParams({ reasoningEffort: "xhigh" }));
		expect(body.output_config).toEqual({ effort: "xhigh" });
	});

	test("omits effort when the user asked for none", async () => {
		mockFetchCapturingRequest();
		const provider = new AnthropicProvider(config());
		const body = await sendAndCapture(provider, chatParams({ reasoningEffort: "none" }));
		expect(body.output_config).toBeUndefined();
	});

	test("does not declare Anthropic beta flags on a non-Claude model", async () => {
		// A generic relay may reject unknown beta names, and does not need them
		// to honor output_config.effort.
		mockFetchCapturingRequest();
		const provider = new AnthropicProvider(config());
		await sendAndCapture(provider, chatParams({ reasoningEffort: "high" }));
		expect(capturedHeaders?.get("anthropic-beta")).toBeNull();
	});
});

describe("AnthropicProvider effort on Claude models", () => {
	test("declares the effort betas for Claude 4.6+", async () => {
		mockFetchCapturingRequest();
		const provider = new AnthropicProvider(config({ defaultModel: "claude-opus-4-6" }));
		await sendAndCapture(
			provider,
			chatParams({ model: "relay:claude-opus-4-6", reasoningEffort: "high" }),
		);
		expect(capturedHeaders?.get("anthropic-beta")).toContain("effort-2025-11-24");
	});

	test("omits effort entirely for Sonnet before 4.6", async () => {
		// The built-in blacklist entry: the official API 400s on these.
		mockFetchCapturingRequest();
		const provider = new AnthropicProvider(config({ defaultModel: "claude-sonnet-4-5" }));
		const body = await sendAndCapture(
			provider,
			chatParams({ model: "relay:claude-sonnet-4-5", reasoningEffort: "high" }),
		);
		expect(body.output_config).toBeUndefined();
		expect(capturedHeaders?.get("anthropic-beta")).toBeNull();
	});

	test("clamps xhigh to max on 4.6, which has no xhigh tier", async () => {
		mockFetchCapturingRequest();
		const provider = new AnthropicProvider(config({ defaultModel: "claude-opus-4-6" }));
		const body = await sendAndCapture(
			provider,
			chatParams({ model: "relay:claude-opus-4-6", reasoningEffort: "xhigh" }),
		);
		expect(body.output_config).toEqual({ effort: "max" });
	});
});

describe("AnthropicProvider effort with no caller preference", () => {
	test("sends no effort at all when the caller left it unset", async () => {
		// The upstream's own default must stand. Substituting `medium` was harmless
		// while this branch only ran for Claude 4.6+, but under the blacklist policy
		// it would impose a tier on every third-party model.
		mockFetchCapturingRequest();
		const provider = new AnthropicProvider(config());
		const body = await sendAndCapture(provider, chatParams({ reasoningEffort: undefined }));
		expect(body.output_config).toBeUndefined();
	});

	test("also sends nothing for a Claude model with no tier requested", async () => {
		mockFetchCapturingRequest();
		const provider = new AnthropicProvider(config({ defaultModel: "claude-opus-4-6" }));
		const body = await sendAndCapture(
			provider,
			chatParams({ model: "relay:claude-opus-4-6", reasoningEffort: undefined }),
		);
		expect(body.output_config).toBeUndefined();
	});
});

describe("AnthropicProvider effort blocklist through a routing channel", () => {
	// A NUG anthropic-channel model reaches this provider as
	// `nug:anthropic:GLM-5.1`; parseModelId peels one prefix and leaves
	// `anthropic:GLM-5.1`. An anchored blocklist pattern used to miss that id, so
	// the tier menu hid the model while the request still sent the parameter.
	const originalBlocklist = settings.agent?.reasoningEffortBlocklist;

	afterEach(() => {
		if (settings.agent) settings.agent.reasoningEffortBlocklist = originalBlocklist;
	});

	test.each([
		true,
		false,
	])("catalog capabilities cannot bypass deny on official=%s chat/generate/history", async (officialApi) => {
		installClaudeReasoningMetadata();
		if (settings.agent)
			settings.agent.reasoningEffortBlocklist = [{ pattern: "/^claude-opus-5$/" }];
		const provider = new AnthropicProvider(
			config({ officialApi, baseUrl: "https://example.invalid/v1" }),
		);
		const model = "relay:anthropic:claude-opus-5";
		for (const path of ["chat", "generate", "history"] as const) {
			mockFetchCapturingRequest();
			if (path === "chat") {
				await sendAndCapture(provider, chatParams({ model, reasoningEffort: "high" }));
			} else {
				const request =
					path === "generate"
						? provider.generateWithMeta("hi", model, undefined, { reasoningEffort: "high" })
						: provider.generateWithHistoryWithMeta("sys", "hi", model, undefined, {
								reasoningEffort: "high",
							});
				await expect(request).rejects.toThrow();
			}
			expect(capturedBody).not.toBeNull();
			expect(capturedBody?.output_config).toBeUndefined();
			expect(capturedBody?.thinking).toEqual({ type: "adaptive" });
			expect(capturedHeaders?.get("anthropic-beta") ?? "").not.toContain("effort-2025-11-24");
		}
	});

	test.each([
		true,
		false,
	])("Opus 4.5 catalog support cannot bypass explicit deny on official=%s", async (officialApi) => {
		installClaudeReasoningMetadata("claude-opus-4-5", OPUS_45_BUDGET_REASONING);
		if (settings.agent)
			settings.agent.reasoningEffortBlocklist = [{ pattern: "/^claude-opus-4-5$/" }];
		const model = "relay:anthropic:claude-opus-4-5";
		const provider = new AnthropicProvider(config({ officialApi }));
		for (const path of REQUEST_PATHS) {
			const body = await capturePath(provider, path, model, "low");
			expect(body.output_config).toBeUndefined();
			expect(body.thinking).toEqual({
				type: "enabled",
				budget_tokens: path === "chat" ? 10_000 : 4_095,
			});
		}
		expect(mapEffortParam(model, "low")).toBeUndefined();
	});

	test("DeepSeek-specific mapping cannot bypass deny", async () => {
		if (settings.agent) settings.agent.reasoningEffortBlocklist = [{ pattern: "/^deepseek/" }];
		mockFetchCapturingRequest();
		const body = await sendAndCapture(
			new AnthropicProvider(config()),
			chatParams({
				model: "relay:deepseek-v4-pro",
				reasoningEffort: "high",
			}),
		);
		expect(body.output_config).toBeUndefined();
		expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 10_000 });
	});

	test.each([
		true,
		false,
	])("disabled deny entry retains catalog effort on official=%s", async (officialApi) => {
		installClaudeReasoningMetadata();
		if (settings.agent)
			settings.agent.reasoningEffortBlocklist = [{ pattern: "/^claude-opus-5$/", enabled: false }];
		mockFetchCapturingRequest();
		const body = await sendAndCapture(
			new AnthropicProvider(config({ officialApi })),
			chatParams({
				model: "relay:anthropic:claude-opus-5",
				reasoningEffort: "high",
			}),
		);
		expect(body.output_config).toEqual({ effort: "high" });
		expect(capturedHeaders?.get("anthropic-beta")).toContain("effort-2025-11-24");
	});

	test("an anchored pattern excludes a channel-prefixed model", async () => {
		if (settings.agent) settings.agent.reasoningEffortBlocklist = [{ pattern: "/^glm/" }];
		mockFetchCapturingRequest();
		const provider = new AnthropicProvider(config());
		const body = await sendAndCapture(
			provider,
			chatParams({ model: "relay:anthropic:GLM-5.1", reasoningEffort: "high" }),
		);
		expect(body.output_config).toBeUndefined();
	});

	test("the same model still receives effort with the entry disabled", async () => {
		if (settings.agent) {
			settings.agent.reasoningEffortBlocklist = [{ pattern: "/^glm/", enabled: false }];
		}
		mockFetchCapturingRequest();
		const provider = new AnthropicProvider(config());
		const body = await sendAndCapture(
			provider,
			chatParams({ model: "relay:anthropic:GLM-5.1", reasoningEffort: "high" }),
		);
		expect(body.output_config).toEqual({ effort: "high" });
	});
});

type CapturedMessage = {
	role: string;
	content: Array<{
		type: string;
		thinking?: string;
		signature?: string;
		id?: string;
		name?: string;
		input?: Record<string, unknown>;
	}>;
};

function assistantMessages(body: Record<string, unknown>): CapturedMessage[] {
	return (body.messages as CapturedMessage[]).filter((message) => message.role === "assistant");
}

describe("AnthropicProvider thinking request sanitization", () => {
	test("drops empty Claude thinking without removing the adjacent tool call", async () => {
		mockFetchCapturingRequest();
		const provider = new AnthropicProvider(config({ defaultModel: "claude-sonnet-4-5" }));
		const body = await sendAndCapture(
			provider,
			chatParams({
				model: "relay:claude-sonnet-4-5",
				reasoningEffort: "high",
				history: [
					{ role: "user", content: [{ type: "text", text: "Run a tool." }] },
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "", signature: "orphan-signature" },
							{ type: "tool_use", id: "toolu_1", name: "Read", input: {} },
						],
					},
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }],
					},
				],
			}),
		);

		expect(assistantMessages(body)[0].content).toEqual([
			{ type: "tool_use", id: "toolu_1", name: "Read", input: {} },
		]);
	});

	test("uses non-empty thinking with empty signatures for DeepSeek history", async () => {
		mockFetchCapturingRequest();
		const provider = new AnthropicProvider(config({ defaultModel: "deepseek-v4-flash-0731" }));
		const body = await sendAndCapture(
			provider,
			chatParams({
				model: "relay:deepseek-v4-flash-0731",
				reasoningEffort: "high",
				history: [
					{ role: "user", content: [{ type: "text", text: "Run a tool." }] },
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "", signature: "orphan-signature" },
							{ type: "tool_use", id: "toolu_1", name: "Read", input: {} },
						],
					},
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }],
					},
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "real reasoning", signature: "" },
							{ type: "text", text: "Finished." },
						],
					},
					{ role: "user", content: [{ type: "text", text: "Continue." }] },
					{
						role: "assistant",
						content: [
							{
								type: "thinking",
								thinking: "signed reasoning",
								signature: "real-signature",
							},
							{ type: "text", text: "Still finished." },
						],
					},
				],
			}),
		);

		const assistants = assistantMessages(body);
		expect(assistants[0].content[0]).toEqual({
			type: "thinking",
			thinking: " ",
			signature: "",
		});
		expect(assistants[1].content[0]).toEqual({
			type: "thinking",
			thinking: "real reasoning",
			signature: "",
		});
		expect(assistants[2].content[0]).toEqual({
			type: "thinking",
			thinking: "signed reasoning",
			signature: "real-signature",
		});
		expect(
			assistants
				.flatMap((message) => message.content)
				.every((block) => {
					if (block.type !== "thinking") return true;
					// Empty thinking text is always padded away; the signature may be
					// empty (relay models mint none), but must never be undefined.
					return (block.thinking?.length ?? 0) > 0 && typeof block.signature === "string";
				}),
		).toBe(true);
	});
});
