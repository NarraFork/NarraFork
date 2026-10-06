import { afterEach, describe, expect, test } from "bun:test";
import { computeFingerprint } from "../../fingerprint";
import type { AnthropicProviderConfig } from "../../settings";
import { CLAUDE_CLI_VERSION } from "../../user-agent";
import { AnthropicProvider } from "../anthropic-provider";
import type { ChatParams } from "../provider";

const MODEL = "claude-opus-5";
const SYSTEM_PROMPT = "NarraFork stable cache diagnostic system prompt.";
const MID_CONVERSATION_SYSTEM = "Stable mid-conversation system guidance.";
const ORIGINAL_FETCH = globalThis.fetch;

/** Fingerprint of the first user-authored text in makeHistory(), per the CLI algorithm. */
const EXPECTED_FINGERPRINT = computeFingerprint("stable prior user message", CLAUDE_CLI_VERSION);
const BILLING_BLOCK = `x-anthropic-billing-header: cc_version=${CLAUDE_CLI_VERSION}.${EXPECTED_FINGERPRINT}; cc_entrypoint=cli; cch=00000;`;

interface CapturedRequest {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
}

interface WireBlock extends Record<string, unknown> {
	type?: string;
	text?: string;
	cache_control?: { type: string; scope?: string };
}

interface WireMessage {
	role: string;
	content: string | WireBlock[];
}

let capturedRequests: CapturedRequest[] = [];

function config(
	officialApi: boolean,
	overrides: Partial<AnthropicProviderConfig> = {},
): AnthropicProviderConfig {
	return {
		id: officialApi ? "official-cache-test" : "compatible-cache-test",
		name: officialApi ? "Official cache test" : "Compatible cache test",
		prefix: officialApi ? "cache_official" : "cache_compatible",
		apiKey: "sk-test",
		baseUrl: "https://example.invalid/v1",
		defaultModel: MODEL,
		officialApi,
		...overrides,
	};
}

function installFetchCapture(): void {
	capturedRequests = [];
	globalThis.fetch = (async (input, init) => {
		if (typeof init?.body !== "string") {
			throw new Error("Expected Anthropic request body to be a serialized string");
		}
		capturedRequests.push({
			url: String(input),
			headers: new Headers(init.headers),
			body: JSON.parse(init.body) as Record<string, unknown>,
		});
		return new Response(
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_cache_test","usage":{"input_tokens":1}}}\n\n' +
				'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
				'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
				'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
				'event: message_stop\ndata: {"type":"message_stop"}\n\n',
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	}) as typeof fetch;
}

function makeHistory(provider: AnthropicProvider): unknown[] {
	const history: unknown[] = [
		{ role: "user", content: [{ type: "text", text: "stable prior user message" }] },
		{
			role: "assistant",
			content: [
				{
					type: "text",
					text: "stable prior assistant reply",
					cache_control: { type: "ephemeral" },
				},
			],
		},
		{ role: "user", content: [{ type: "text", text: "second prior user message" }] },
		// A `sys` row injected after a user turn: the only position the API accepts a
		// mid-conversation system message in (it must precede an assistant turn).
		{ role: "system", content: MID_CONVERSATION_SYSTEM },
		{ role: "assistant", content: [{ type: "text", text: "assistant after system" }] },
	];
	provider.injectSystemPrompt(history, SYSTEM_PROMPT, MODEL);
	return history;
}

function makeTools(): unknown[] {
	return [
		{
			name: "Read",
			description: "Read a file for the cache construction test.",
			input_schema: {
				type: "object",
				properties: { file_path: { type: "string" } },
				required: ["file_path"],
			},
			cache_control: { type: "ephemeral" },
		},
	];
}

function chatParams(
	provider: AnthropicProvider,
	content: string,
	history = makeHistory(provider),
	tools = makeTools(),
): ChatParams {
	return {
		conversationId: "cache-conversation",
		content,
		model: MODEL,
		cwd: process.cwd(),
		history,
		tools,
		toolResults: [],
		signal: new AbortController().signal,
		reasoningEffort: "none",
	};
}

async function sendAndCapture(
	provider: AnthropicProvider,
	content: string,
	history?: unknown[],
	tools?: unknown[],
): Promise<CapturedRequest> {
	const before = capturedRequests.length;
	for await (const _event of provider.chat(chatParams(provider, content, history, tools))) {
		// Exhaust the response so the provider completes the real request path.
	}
	expect(capturedRequests).toHaveLength(before + 1);
	return capturedRequests[before];
}

/** Same as sendAndCapture, but overrides the reasoning-effort tier. */
async function sendWithEffort(
	provider: AnthropicProvider,
	content: string,
	reasoningEffort: ChatParams["reasoningEffort"],
): Promise<CapturedRequest> {
	const before = capturedRequests.length;
	const params: ChatParams = { ...chatParams(provider, content), reasoningEffort };
	for await (const _event of provider.chat(params)) {
		// Exhaust the response so the provider completes the real request path.
	}
	expect(capturedRequests).toHaveLength(before + 1);
	return capturedRequests[before];
}

function collectCacheControlPaths(value: unknown, path = "$", output: string[] = []): string[] {
	if (!value || typeof value !== "object") return output;
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			collectCacheControlPaths(value[index], `${path}[${index}]`, output);
		}
		return output;
	}
	const record = value as Record<string, unknown>;
	if (Object.hasOwn(record, "cache_control")) output.push(`${path}.cache_control`);
	for (const [key, child] of Object.entries(record)) {
		collectCacheControlPaths(child, `${path}.${key}`, output);
	}
	return output;
}

function withoutCacheControl<T>(value: T): T {
	return JSON.parse(
		JSON.stringify(value, (key, child) => (key === "cache_control" ? undefined : child)),
	) as T;
}

function messagesFrom(body: Record<string, unknown>): WireMessage[] {
	return body.messages as WireMessage[];
}

function systemFrom(body: Record<string, unknown>): WireBlock[] {
	return body.system as WireBlock[];
}

function toolsFrom(body: Record<string, unknown>): WireBlock[] {
	return (body.tools as WireBlock[] | undefined) ?? [];
}

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	capturedRequests = [];
});

describe("AnthropicProvider final wire-body cache construction", () => {
	test("matches the official three-breakpoint Claude Code prefix", async () => {
		installFetchCapture();
		const provider = new AnthropicProvider(config(true));
		const request = await sendAndCapture(provider, "current user tail alpha");
		const { body } = request;

		expect(request.url).toEndWith("/messages?beta=true");
		expect(body.max_tokens).toBe(64_000);
		expect(collectCacheControlPaths(body).sort()).toEqual([
			"$.messages[5].content[0].cache_control",
			"$.system[1].cache_control",
			"$.system[2].cache_control",
		]);

		const system = systemFrom(body);
		expect(system[0]).toEqual({ type: "text", text: BILLING_BLOCK });
		expect(system[1]).toEqual({
			type: "text",
			text: "You are Claude Code, Anthropic's official CLI for Claude.",
			cache_control: { type: "ephemeral" },
		});
		expect(system[2]).toEqual({
			type: "text",
			text: SYSTEM_PROMPT,
			cache_control: { type: "ephemeral" },
		});

		const messages = messagesFrom(body);
		expect(messages[3]).toEqual({ role: "system", content: MID_CONVERSATION_SYSTEM });
		// Legal placement: preceded by a user turn, followed by an assistant turn.
		expect(messages[2].role).toBe("user");
		expect(messages[4].role).toBe("assistant");
		expect(messages.at(-1)).toEqual({
			role: "user",
			content: [
				{
					type: "text",
					text: "current user tail alpha",
					cache_control: { type: "ephemeral" },
				},
			],
		});
		for (const message of messages.filter((item) => item.role === "assistant")) {
			expect(collectCacheControlPaths(message)).toEqual([]);
		}
		for (const tool of toolsFrom(body)) {
			expect(tool.cache_control).toBeUndefined();
		}

		expect(body.context_management).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain('"scope"');
		expect(JSON.stringify(body)).not.toContain("cc_workload");
		const beta = request.headers.get("anthropic-beta") ?? "";
		expect(beta).toContain("prompt-caching-scope-2026-01-05");
		expect(beta).toContain("mid-conversation-system-2026-04-07");
		expect(beta).toContain("context-management-2025-06-27");
		// The fallback-credit lane is never armed here, so upstream would not
		// declare its beta either.
		expect(beta).not.toContain("fallback-credit-2026-06-01");
	});

	test("sends context_management only while thinking is enabled", async () => {
		installFetchCapture();
		const provider = new AnthropicProvider(config(true));

		// `clear_thinking_20251015` is the only edit in the block, so upstream
		// builds it from `hasThinking` — a thinking edit on a non-thinking request
		// describes work the server cannot perform.
		const thinking = await sendWithEffort(provider, "thinking tail", "high");
		expect(thinking.body.thinking).toEqual({ type: "adaptive" });
		expect(thinking.body.context_management).toEqual({
			edits: [{ type: "clear_thinking_20251015", keep: "all" }],
		});
		// Opus 5 rejects `temperature`, so it must be absent in both shapes.
		expect(thinking.body.temperature).toBeUndefined();

		const disabled = await sendWithEffort(provider, "no thinking tail", "none");
		expect(disabled.body.thinking).toEqual({ type: "disabled" });
		expect(disabled.body.context_management).toBeUndefined();
		expect(disabled.body.temperature).toBeUndefined();
	});

	test("reports one CLI version across the billing block and User-Agent", async () => {
		installFetchCapture();
		const provider = new AnthropicProvider(config(true));
		const request = await sendAndCapture(provider, "version parity tail");

		// A request whose User-Agent and cc_version disagree matches no real CLI release.
		expect(request.headers.get("user-agent")).toContain(`claude-cli/${CLAUDE_CLI_VERSION}`);
		expect(systemFrom(request.body)[0].text).toContain(`cc_version=${CLAUDE_CLI_VERSION}.`);

		// Stainless telemetry. The package version is the anthropic-sdk-typescript
		// build bundled into the CLI, read from the SDK's own VERSION constant.
		expect(request.headers.get("x-stainless-package-version")).toBe("0.112.1");
		expect(request.headers.get("x-stainless-runtime-version")).toBe("v26.3.0");
		expect(request.headers.get("x-app")).toBe("cli");
		// The CLI mints a fresh UUID per official-API attempt and sends it here.
		expect(request.headers.get("x-client-request-id")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	test("keeps one session id per conversation across provider rebuilds", async () => {
		installFetchCapture();

		// A provider instance is rebuilt for every chat turn (see the
		// v1FallbackCache note in the provider), so an instance-scoped session id
		// changed on every message of one conversation. That is not only unlike the
		// real CLI, which carries one id for the conversation's lifetime: relays in
		// front of Anthropic key credential affinity on this exact value, so a
		// per-turn id spread one conversation across several upstream credentials
		// and missed the prompt cache on each turn. Two fresh providers stand in for
		// two consecutive turns here.
		const first = await sendAndCapture(new AnthropicProvider(config(true)), "turn one");
		const second = await sendAndCapture(new AnthropicProvider(config(true)), "turn two");

		const sessionOf = (request: CapturedRequest): string => {
			const metadata = request.body.metadata as Record<string, string>;
			return (JSON.parse(metadata.user_id) as Record<string, string>).session_id;
		};

		expect(sessionOf(first)).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(sessionOf(second)).toBe(sessionOf(first));
		// The header must carry the same value the body reports.
		expect(first.headers.get("x-claude-code-session-id")).toBe(sessionOf(first));
		expect(second.headers.get("x-claude-code-session-id")).toBe(sessionOf(first));

		// Stable is not the same as constant: a different conversation must get a
		// different id, or every conversation would share one credential.
		const provider = new AnthropicProvider(config(true));
		const otherParams: ChatParams = {
			...chatParams(provider, "other conversation"),
			conversationId: "cache-conversation-other",
		};
		const before = capturedRequests.length;
		for await (const _event of provider.chat(otherParams)) {
			// Exhaust the response so the provider completes the real request path.
		}
		expect(sessionOf(capturedRequests[before])).not.toBe(sessionOf(first));
	});

	test("reports a persisted 64-hex device id", async () => {
		installFetchCapture();

		// Upstream validates its own device id against /^[0-9a-f]{64}$/ and rewrites
		// the stored value whenever it fails, so this is the only shape a real
		// install reports. It is persisted, so it must also survive a rebuild.
		const first = await sendAndCapture(new AnthropicProvider(config(true)), "device one");
		const second = await sendAndCapture(new AnthropicProvider(config(true)), "device two");

		const deviceOf = (request: CapturedRequest): string => {
			const metadata = request.body.metadata as Record<string, string>;
			return (JSON.parse(metadata.user_id) as Record<string, string>).device_id;
		};

		expect(deviceOf(first)).toMatch(/^[0-9a-f]{64}$/);
		expect(deviceOf(second)).toBe(deviceOf(first));
	});

	test("caller metadata cannot overwrite the attribution user_id", async () => {
		installFetchCapture();

		// `user_id` is not a free-form field: relays parse it for device/session
		// identity, and one that fails to parse makes them treat the request as
		// coming from an unknown client — which costs the caller its own system
		// prompt and the prompt cache. So the attribution value wins over anything
		// the caller passes, while unrelated keys still travel.
		const provider = new AnthropicProvider(config(true));
		const params: ChatParams = {
			...chatParams(provider, "metadata precedence tail"),
			metadata: { user_id: "not-a-parseable-user-id" } as ChatParams["metadata"],
		};

		const before = capturedRequests.length;
		for await (const _event of provider.chat(params)) {
			// Exhaust the response so the provider completes the real request path.
		}
		const metadata = capturedRequests[before].body.metadata as Record<string, string>;

		expect(metadata.user_id).not.toBe("not-a-parseable-user-id");
		const userId = JSON.parse(metadata.user_id) as Record<string, string>;
		expect(userId.device_id).toMatch(/^[0-9a-f]{64}$/);
	});

	test("skips harness system reminders when deriving the billing fingerprint", async () => {
		installFetchCapture();
		const provider = new AnthropicProvider(config(true));

		const userAuthored = "who are you and what tools you can use";
		const history: unknown[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "<system-reminder>\nInjected by the harness.\n</system-reminder>" },
					{ type: "text", text: userAuthored },
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "prior reply" }] },
		];
		provider.injectSystemPrompt(history, SYSTEM_PROMPT, MODEL);

		const request = await sendAndCapture(provider, "reminder fingerprint tail", history);
		const expected = computeFingerprint(userAuthored, CLAUDE_CLI_VERSION);
		const reminderDerived = computeFingerprint(
			"<system-reminder>\nInjected by the harness.\n</system-reminder>",
			CLAUDE_CLI_VERSION,
		);

		expect(systemFrom(request.body)[0].text).toBe(
			`x-anthropic-billing-header: cc_version=${CLAUDE_CLI_VERSION}.${expected}; cc_entrypoint=cli; cch=00000;`,
		);
		// Guard against regressing to "first text block wins".
		expect(expected).not.toBe(reminderDerived);
	});

	test("marks a trailing mid-conversation system message", async () => {
		installFetchCapture();
		const provider = new AnthropicProvider(config(true));

		// Captured claude-cli traffic ends a turn on a mid-conversation system message
		// when the harness appends one; the breakpoint must follow it rather than
		// falling back to an earlier user turn.
		const history: unknown[] = [
			{ role: "user", content: [{ type: "text", text: "opening user turn" }] },
			{ role: "system", content: "trailing agent-type catalogue" },
		];
		provider.injectSystemPrompt(history, SYSTEM_PROMPT, MODEL);

		const request = await sendAndCapture(provider, "", history);
		const messages = messagesFrom(request.body);

		expect(messages.at(-1)?.role).toBe("system");
		expect(collectCacheControlPaths(request.body).sort()).toEqual([
			`$.messages[${messages.length - 1}].content[0].cache_control`,
			"$.system[1].cache_control",
			"$.system[2].cache_control",
		]);
	});

	test("marks a trailing tool_result turn", async () => {
		installFetchCapture();
		const provider = new AnthropicProvider(config(true));

		const history: unknown[] = [
			{ role: "user", content: [{ type: "text", text: "opening user turn" }] },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.ts" } }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "call_1", content: "file body" }],
			},
		];
		provider.injectSystemPrompt(history, SYSTEM_PROMPT, MODEL);

		const request = await sendAndCapture(provider, "", history);
		const messages = messagesFrom(request.body);
		const last = messages.at(-1);

		expect(last?.role).toBe("user");
		const blocks = last?.content as WireBlock[];
		expect(blocks.at(-1)?.type).toBe("tool_result");
		expect(blocks.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
	});

	test("keeps the billing block byte-identical across turns of one conversation", async () => {
		installFetchCapture();
		const provider = new AnthropicProvider(config(true));

		const first = await sendAndCapture(provider, "first turn");
		const secondHistory = structuredClone(messagesFrom(first.body)) as unknown[];
		provider.injectSystemPrompt(secondHistory, SYSTEM_PROMPT, MODEL);
		const second = await sendAndCapture(provider, "second turn", secondHistory);

		// The billing block opens the cached prefix: any per-request variation in it
		// invalidates the whole system cache on every turn.
		expect(systemFrom(second.body)[0]).toEqual(systemFrom(first.body)[0]);
	});

	test("keeps the previous wire prefix stable while moving the user breakpoint", async () => {
		installFetchCapture();
		const provider = new AnthropicProvider(config(true));
		const first = await sendAndCapture(provider, "first current user turn");
		const firstMessages = messagesFrom(first.body);

		const secondHistory = structuredClone(firstMessages) as unknown[];
		secondHistory.push({
			role: "assistant",
			content: [
				{
					type: "text",
					text: "assistant reply after the first turn",
					cache_control: { type: "ephemeral" },
				},
			],
		});
		provider.injectSystemPrompt(secondHistory, SYSTEM_PROMPT, MODEL);

		const second = await sendAndCapture(provider, "second current user turn", secondHistory);
		const secondMessages = messagesFrom(second.body);

		expect(secondMessages).toHaveLength(firstMessages.length + 2);
		expect(withoutCacheControl(secondMessages.slice(0, firstMessages.length))).toEqual(
			withoutCacheControl(firstMessages),
		);
		expect(collectCacheControlPaths(first.body).sort()).toEqual([
			"$.messages[5].content[0].cache_control",
			"$.system[1].cache_control",
			"$.system[2].cache_control",
		]);
		expect(collectCacheControlPaths(second.body).sort()).toEqual([
			"$.messages[7].content[0].cache_control",
			"$.system[1].cache_control",
			"$.system[2].cache_control",
		]);
		expect(collectCacheControlPaths(secondMessages[5])).toEqual([]);
		expect(collectCacheControlPaths(secondMessages[6])).toEqual([]);
		expect(secondMessages[7]).toEqual({
			role: "user",
			content: [
				{
					type: "text",
					text: "second current user turn",
					cache_control: { type: "ephemeral" },
				},
			],
		});
		expect(systemFrom(second.body)).toEqual(systemFrom(first.body));
		expect(toolsFrom(second.body)).toEqual(toolsFrom(first.body));
		expect(second.body.context_management).toEqual(first.body.context_management);
	});

	test("anthropic-compatible mode downgrades system messages and sends no cache controls", async () => {
		installFetchCapture();
		const provider = new AnthropicProvider(config(false));
		const request = await sendAndCapture(provider, "compatible current user tail");

		expect(collectCacheControlPaths(request.body)).toEqual([]);
		expect(request.body.system).toEqual([{ type: "text", text: SYSTEM_PROMPT }]);
		expect(request.body.context_management).toBeUndefined();
		expect(messagesFrom(request.body).some((message) => message.role === "system")).toBe(false);
		expect(JSON.stringify(request.body)).toContain(MID_CONVERSATION_SYSTEM);
		expect(JSON.stringify(request.body)).not.toContain("cch=");
		const beta = request.headers.get("anthropic-beta") ?? "";
		expect(beta).not.toContain("prompt-caching-scope-2026-01-05");
		expect(beta).not.toContain("mid-conversation-system-2026-04-07");
		expect(beta).not.toContain("context-management-2025-06-27");
	});
});
