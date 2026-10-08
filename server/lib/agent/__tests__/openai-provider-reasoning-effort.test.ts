import { afterEach, describe, expect, test } from "bun:test";
import {
	bindModelCatalogSettings,
	getEffectiveModelMetadata,
	getModelCatalogSnapshot,
	mutateModelCatalog,
} from "../../model-catalog";
import { type OpenAIProviderConfig, saveSettings, settings } from "../../settings";
import type { NarraForkSettings } from "../../settings/types";
import { OpenAIProvider } from "../openai-provider";
import type { ChatParams } from "../provider";

/**
 * Reasoning effort must reach the wire on the two generic (non-Codex) modes.
 *
 * Before the blacklist policy, `completions` only sent a hint for DeepSeek and
 * plain `responses` sent nothing at all, so a third-party model behind either
 * relay silently ignored the tier the user picked.
 */

function config(overrides: Partial<OpenAIProviderConfig>): OpenAIProviderConfig {
	return {
		id: "p1",
		name: "Third party",
		prefix: "p1",
		apiKey: "sk-test",
		baseUrl: "https://example.invalid/v1",
		defaultModel: "glm-5.1",
		...overrides,
	} as OpenAIProviderConfig;
}

function chatParams(overrides?: Partial<ChatParams>): ChatParams {
	return {
		history: [],
		content: "hi",
		model: "p1:glm-5.1",
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
		conversationId: "conv-1",
		...overrides,
	} as ChatParams;
}

const originalFetch = globalThis.fetch;
let capturedBody: Record<string, unknown> | null = null;

function mockFetchCapturingBody(): void {
	capturedBody = null;
	globalThis.fetch = (async (_input, init) => {
		const raw = (init as RequestInit | undefined)?.body;
		if (typeof raw === "string") capturedBody = JSON.parse(raw);
		// Non-JSON 500 so the provider raises a normal API error instead of
		// reaching the network or parsing a fake stream.
		return new Response("upstream unavailable", { status: 500 });
	}) as typeof fetch;
}

/** Drive chat() far enough to emit the request, swallowing the mocked failure. */
async function sendAndCaptureBody(
	provider: OpenAIProvider,
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
	bindModelCatalogSettings(settings, () => saveSettings(settings));
});

function installReasoningLevels(): void {
	bindModelCatalogSettings(
		{
			openaiProviders: [config({})],
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
		model: {
			id: "glm-5.1",
			matches: { aliases: ["responses:glm-5.1", "openai:glm-5.1"] },
			metadata: {
				reasoning: {
					supported: true,
					levels: ["low", "medium", "high", "max"],
					canDisable: true,
				},
			},
		},
	});
	for (const model of ["p1:glm-5.1", "p1:responses:glm-5.1"]) {
		expect(getEffectiveModelMetadata(model).metadata.reasoning?.levels).toEqual([
			"low",
			"medium",
			"high",
			"max",
		]);
	}
}

describe("OpenAIProvider completions-compatible reasoning effort", () => {
	test("sends reasoning_effort for a third-party model", async () => {
		mockFetchCapturingBody();
		const provider = new OpenAIProvider(config({ apiMode: "completions" }));
		const body = await sendAndCaptureBody(provider, chatParams({ reasoningEffort: "high" }));
		expect(body.reasoning_effort).toBe("high");
		// The DeepSeek-only `thinking` block must not leak onto other models.
		expect(body.thinking).toBeUndefined();
	});

	test("preserves xhigh when the model declares no tier table", async () => {
		mockFetchCapturingBody();
		const provider = new OpenAIProvider(config({ apiMode: "completions" }));
		const body = await sendAndCaptureBody(provider, chatParams({ reasoningEffort: "xhigh" }));
		expect(body.reasoning_effort).toBe("xhigh");
	});

	test("maps xhigh to max when metadata declares low/medium/high/max", async () => {
		installReasoningLevels();
		mockFetchCapturingBody();
		const provider = new OpenAIProvider(config({ apiMode: "completions" }));
		const body = await sendAndCaptureBody(provider, chatParams({ reasoningEffort: "xhigh" }));
		expect(body.reasoning_effort).toBe("max");
	});

	test("keeps the DeepSeek thinking-block shape", async () => {
		mockFetchCapturingBody();
		const provider = new OpenAIProvider(
			config({ apiMode: "completions", defaultModel: "deepseek-v4-pro" }),
		);
		const body = await sendAndCaptureBody(
			provider,
			chatParams({ model: "p1:deepseek-v4-pro", reasoningEffort: "low" }),
		);
		expect(body.thinking).toEqual({ type: "enabled" });
		// DeepSeek accepts only high/max, so low clamps up to high.
		expect(body.reasoning_effort).toBe("high");
	});

	test("DeepSeek none disables thinking outright", async () => {
		mockFetchCapturingBody();
		const provider = new OpenAIProvider(
			config({ apiMode: "completions", defaultModel: "deepseek-v4-pro" }),
		);
		const body = await sendAndCaptureBody(
			provider,
			chatParams({ model: "p1:deepseek-v4-pro", reasoningEffort: "none" }),
		);
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body.reasoning_effort).toBeUndefined();
	});

	test("sends nothing when no effort is set", async () => {
		mockFetchCapturingBody();
		const provider = new OpenAIProvider(config({ apiMode: "completions" }));
		const body = await sendAndCaptureBody(provider, chatParams());
		expect(body.reasoning_effort).toBeUndefined();
		expect(body.thinking).toBeUndefined();
	});
});

describe("OpenAIProvider plain responses (apiMode) reasoning effort", () => {
	test("sends reasoning.effort for a third-party model", async () => {
		mockFetchCapturingBody();
		const provider = new OpenAIProvider(config({ apiMode: "responses" }));
		const body = await sendAndCaptureBody(provider, chatParams({ reasoningEffort: "high" }));
		expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
		// encrypted_content is a Codex-only include; a generic relay must not be
		// asked for it.
		expect(body.include).toBeUndefined();
	});

	test("sends nothing when no effort is set", async () => {
		mockFetchCapturingBody();
		const provider = new OpenAIProvider(config({ apiMode: "responses" }));
		const body = await sendAndCaptureBody(provider, chatParams());
		expect(body.reasoning).toBeUndefined();
	});
});

describe("OpenAIProvider effort blocklist through a routing channel", () => {
	// A NUG openai/responses-channel model arrives as `nug:responses:glm-5.1`;
	// parseModelId leaves `responses:glm-5.1`, which an anchored pattern used to
	// miss — so the blocklist silently did nothing on this path too.
	const originalBlocklist = settings.agent?.reasoningEffortBlocklist;

	afterEach(() => {
		if (settings.agent) settings.agent.reasoningEffortBlocklist = originalBlocklist;
	});

	test.each([
		"completions",
		"responses",
	] as const)("metadata tiers cannot bypass deny on %s chat/generate/history", async (apiMode) => {
		installReasoningLevels();
		if (settings.agent) settings.agent.reasoningEffortBlocklist = [{ pattern: "/^glm/" }];
		const provider = new OpenAIProvider(config({ apiMode }));
		const model = "p1:responses:glm-5.1";
		mockFetchCapturingBody();
		const body = await sendAndCaptureBody(provider, chatParams({ model, reasoningEffort: "high" }));
		expect(body.reasoning_effort).toBeUndefined();
		expect(body.reasoning).toBeUndefined();
		for (const history of [false, true]) {
			mockFetchCapturingBody();
			const request = history
				? provider.generateWithHistoryWithMeta("sys", "hi", model, undefined, {
						reasoningEffort: "high",
					})
				: provider.generateWithMeta("hi", model, undefined, { reasoningEffort: "high" });
			await expect(request).rejects.toThrow();
			expect(capturedBody).not.toBeNull();
			expect(capturedBody?.reasoning_effort).toBeUndefined();
			expect(capturedBody?.reasoning).toBeUndefined();
		}
	});

	test.each([
		"high",
		"none",
	] as const)("DeepSeek deny omits effort but preserves %s thinking control", async (reasoningEffort) => {
		if (settings.agent) settings.agent.reasoningEffortBlocklist = [{ pattern: "/^deepseek/" }];
		mockFetchCapturingBody();
		const provider = new OpenAIProvider(config({ apiMode: "completions" }));
		const body = await sendAndCaptureBody(
			provider,
			chatParams({
				model: "p1:deepseek-v4-pro",
				reasoningEffort,
			}),
		);
		expect(body.reasoning_effort).toBeUndefined();
		expect(body.thinking).toEqual({ type: reasoningEffort === "none" ? "disabled" : "enabled" });
	});

	test("disabled blocklist entry still permits declared metadata tiers", async () => {
		installReasoningLevels();
		if (settings.agent)
			settings.agent.reasoningEffortBlocklist = [{ pattern: "/^glm/", enabled: false }];
		mockFetchCapturingBody();
		const body = await sendAndCaptureBody(
			new OpenAIProvider(config({ apiMode: "responses" })),
			chatParams({ model: "p1:responses:glm-5.1", reasoningEffort: "high" }),
		);
		expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
	});

	test("excludes a channel-prefixed model on the completions path", async () => {
		if (settings.agent) settings.agent.reasoningEffortBlocklist = [{ pattern: "/^glm/" }];
		mockFetchCapturingBody();
		const provider = new OpenAIProvider(config({ apiMode: "completions" }));
		const body = await sendAndCaptureBody(
			provider,
			chatParams({ model: "p1:openai:glm-5.1", reasoningEffort: "high" }),
		);
		expect(body.reasoning_effort).toBeUndefined();
	});

	test("excludes a channel-prefixed model on the responses path", async () => {
		if (settings.agent) settings.agent.reasoningEffortBlocklist = [{ pattern: "/^glm/" }];
		mockFetchCapturingBody();
		const provider = new OpenAIProvider(config({ apiMode: "responses" }));
		const body = await sendAndCaptureBody(
			provider,
			chatParams({ model: "p1:responses:glm-5.1", reasoningEffort: "high" }),
		);
		expect(body.reasoning).toBeUndefined();
	});
});
