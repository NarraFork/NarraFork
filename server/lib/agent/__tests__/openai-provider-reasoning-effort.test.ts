import { afterEach, describe, expect, test } from "bun:test";
import { type OpenAIProviderConfig, settings } from "../../settings";
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
});

describe("OpenAIProvider completions-compatible reasoning effort", () => {
	test("sends reasoning_effort for a third-party model", async () => {
		mockFetchCapturingBody();
		const provider = new OpenAIProvider(config({ apiMode: "completions" }));
		const body = await sendAndCaptureBody(provider, chatParams({ reasoningEffort: "high" }));
		expect(body.reasoning_effort).toBe("high");
		// The DeepSeek-only `thinking` block must not leak onto other models.
		expect(body.thinking).toBeUndefined();
	});

	test("clamps xhigh onto the generic ladder", async () => {
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

describe("OpenAIProvider responses-compatible reasoning effort", () => {
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
