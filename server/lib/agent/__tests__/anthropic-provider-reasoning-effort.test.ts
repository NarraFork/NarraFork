import { afterEach, describe, expect, test } from "bun:test";
import { type AnthropicProviderConfig, settings } from "../../settings";
import { AnthropicProvider } from "../anthropic-provider";
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

	test("omits effort entirely for pre-4.6 Claude", async () => {
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
