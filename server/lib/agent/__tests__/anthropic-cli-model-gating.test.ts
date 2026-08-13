/**
 * Per-model request gating on the official Anthropic path.
 *
 * `claude-cli` derives the beta list and several body fields from the model in
 * hand rather than sending one fixed shape, so a constant list necessarily
 * claims capabilities the real client would withhold.
 *
 * Support scope starts at Claude 4.7, so the version-threshold gates that only
 * separated the 3.x/4.0–4.6 generations are gone. What remains is what still
 * varies inside the supported range:
 *
 *   - `temperature` is refused by every in-scope Claude (`wHo`), and only
 *     third-party relay ids still receive it.
 *   - `role: "system"` turns need `mid-conversation-system-2026-04-07` (`qHS`),
 *     which Opus 4.7 does not have, so the message must be downgraded there.
 *   - the Claude Code beta is withheld from Haiku by name (`KHS`), and the
 *     1M-context and effort betas track NarraFork's own capability answers.
 *
 * Transcribed predicates: `wHo`, `qHS`, `KHS`, `EZb` in claude-cli 2.1.227.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type AnthropicProviderConfig, settings } from "../../settings";
import { AnthropicProvider } from "../anthropic-provider";
import type { ChatParams } from "../provider";

const ORIGINAL_FETCH = globalThis.fetch;
const SYSTEM_PROMPT = "NarraFork gating diagnostic system prompt.";
const MID_CONVERSATION_SYSTEM = "Mid-conversation system guidance.";

interface Captured {
	betas: string[];
	body: Record<string, unknown>;
}

interface WireMessage {
	role: string;
	content: unknown;
}

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
});

/** Drive one official chat request and return its betas plus wire body. */
async function send(
	model: string,
	reasoningEffort: ChatParams["reasoningEffort"],
	options: { midConversationSystem?: boolean } = {},
): Promise<Captured> {
	let betas: string[] = [];
	let body: Record<string, unknown> = {};
	globalThis.fetch = (async (_input, init) => {
		const headers = new Headers(init?.headers);
		betas = (headers.get("anthropic-beta") ?? "").split(",").filter(Boolean);
		body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		return new Response("upstream stubbed", { status: 500 });
	}) as typeof fetch;

	const config: AnthropicProviderConfig = {
		id: "gating",
		name: "Gating",
		prefix: "gating",
		apiKey: "sk-test",
		baseUrl: "https://example.invalid/v1",
		defaultModel: model,
		officialApi: true,
	} as AnthropicProviderConfig;

	const provider = new AnthropicProvider(config);
	const history: unknown[] = [{ role: "user", content: [{ type: "text", text: "opening" }] }];
	if (options.midConversationSystem) {
		history.push(
			{ role: "assistant", content: [{ type: "text", text: "reply" }] },
			{ role: "system", content: MID_CONVERSATION_SYSTEM },
		);
	}
	provider.injectSystemPrompt(history, SYSTEM_PROMPT, model);

	const params: ChatParams = {
		conversationId: "gating-conversation",
		content: "tail",
		model,
		cwd: process.cwd(),
		history,
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
		reasoningEffort,
	} as ChatParams;

	const iterator = provider.chat(params)[Symbol.asyncIterator]();
	try {
		await iterator.next();
	} catch {
		// Expected: the stub always fails the request.
	}
	return { betas, body };
}

/** Every Claude id the provider is expected to serve. */
const IN_SCOPE_MODELS = [
	"claude-opus-4-7",
	"claude-opus-4-8",
	"claude-opus-5",
	"claude-sonnet-5",
	"claude-haiku-5",
	"claude-fable-5",
	"claude-mythos-5",
];

describe("thinking is always adaptive in the supported range", () => {
	test.each(IN_SCOPE_MODELS)("%s takes adaptive thinking", async (model) => {
		const { body } = await send(model, "high");
		expect(body.thinking).toEqual({ type: "adaptive" });
		// The 64k ceiling covers every model in range, so no per-model clamp.
		expect(body.max_tokens).toBe(64_000);
	});

	test.each(IN_SCOPE_MODELS)("%s disables thinking on an explicit none", async (model) => {
		const { body } = await send(model, "none");
		expect(body.thinking).toEqual({ type: "disabled" });
	});
});

describe("temperature is withheld from recognised Claude ids", () => {
	test.each(IN_SCOPE_MODELS)("%s never receives temperature", async (model) => {
		// Thinking off is the only case upstream would have sent it in.
		const { body } = await send(model, "none");
		expect(body.temperature).toBeUndefined();
	});

	test("a third-party relay id still receives it", async () => {
		// `wHo` says nothing about non-Claude models, and a generic
		// Anthropic-compatible upstream expects a normal Messages body.
		const { body } = await send("GLM-5.1", "none");
		expect(body.temperature).toBe(1);
	});
});

describe("context_management follows the thinking flag", () => {
	test("present while thinking is on, absent when it is off", async () => {
		// `clear_thinking_20251015` is the only edit in the block, so upstream
		// builds it from `hasThinking` — a thinking edit on a non-thinking request
		// describes work the server cannot perform.
		const thinking = await send("claude-opus-5", "high");
		expect(thinking.body.context_management).toEqual({
			edits: [{ type: "clear_thinking_20251015", keep: "all" }],
		});

		const disabled = await send("claude-opus-5", "none");
		expect(disabled.body.context_management).toBeUndefined();
	});
});

describe("beta flags are derived per model", () => {
	test("Haiku never claims the Claude Code beta", async () => {
		// Upstream's rule is by name, not version: `!r.includes("haiku")`.
		const { betas } = await send("claude-haiku-5", "high");
		expect(betas).not.toContain("claude-code-20250219");
		// The thinking betas are unconditional inside the supported range.
		expect(betas).toContain("interleaved-thinking-2025-05-14");
		expect(betas).toContain("redact-thinking-2026-02-12");
		expect(betas).toContain("thinking-token-count-2026-05-13");
		expect(betas).toContain("context-management-2025-06-27");
		expect(betas).toContain("prompt-caching-scope-2026-01-05");
	});

	test("the 1M-context beta is only claimed by models that have the window", async () => {
		// Declaring it must agree with getAnthropicEffectiveContextWindow, which is
		// what lifts those models to a 1M window.
		expect((await send("claude-sonnet-5", "high")).betas).toContain("context-1m-2025-08-07");
		expect((await send("claude-haiku-5", "high")).betas).not.toContain("context-1m-2025-08-07");
	});

	test("no request declares the unarmed fallback-credit lane", async () => {
		const { betas } = await send("claude-opus-5", "high");
		expect(betas).not.toContain("fallback-credit-2026-06-01");
	});
});

describe("the effort beta tracks the user's blocklist", () => {
	const originalBlocklist = settings.agent?.reasoningEffortBlocklist;

	afterEach(() => {
		if (settings.agent) settings.agent.reasoningEffortBlocklist = originalBlocklist;
	});

	test("declared by default", async () => {
		const { betas, body } = await send("claude-opus-5", "high");
		expect(betas).toContain("effort-2025-11-24");
		expect(body.output_config).toEqual({ effort: "high" });
	});

	test("withheld together with the parameter when the model is blocklisted", async () => {
		if (settings.agent) {
			settings.agent.reasoningEffortBlocklist = [{ pattern: "claude-opus-5" }];
		}
		const { betas, body } = await send("claude-opus-5", "high");
		expect(betas).not.toContain("effort-2025-11-24");
		expect(body.output_config).toBeUndefined();
	});
});

describe("mid-conversation system messages track their beta", () => {
	test.each([
		"claude-opus-4-8",
		"claude-opus-5",
		"claude-sonnet-5",
		"claude-mythos-5",
	])("%s keeps the system role and declares the beta", async (model) => {
		const { betas, body } = await send(model, "high", { midConversationSystem: true });
		expect(betas).toContain("mid-conversation-system-2026-04-07");
		const messages = body.messages as WireMessage[];
		expect(messages.some((message) => message.role === "system")).toBe(true);
		expect(JSON.stringify(body)).toContain(MID_CONVERSATION_SYSTEM);
	});

	test("Opus 4.7 downgrades the turn instead of sending an illegal role", async () => {
		// The one in-scope model upstream excludes from `qHS`.
		const { betas, body } = await send("claude-opus-4-7", "high", {
			midConversationSystem: true,
		});
		expect(betas).not.toContain("mid-conversation-system-2026-04-07");
		const messages = body.messages as WireMessage[];
		expect(messages.some((message) => message.role === "system")).toBe(false);
		// Downgraded, not dropped: the guidance still reaches the model.
		expect(JSON.stringify(body)).toContain(MID_CONVERSATION_SYSTEM);
	});
});
