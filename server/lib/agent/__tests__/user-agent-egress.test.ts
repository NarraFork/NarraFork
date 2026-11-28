/**
 * user-agent-egress.test.ts — Does the UA option actually reach the wire, on
 * every egress that exposes one?
 *
 * WHY THIS FILE EXISTS
 *
 * `user-agent-fingerprint.test.ts` pins the RESOLVER: given a mode, which string
 * comes out. That is necessary and not sufficient — a resolver can be perfect
 * while a provider forgets to write its result, writes it under a key something
 * else overwrites, or writes it on the HTTP path but not the WebSocket handshake.
 * Each of those is invisible to a resolver test and visible only in the header map
 * the transport is handed.
 *
 * So this file asserts from the LAST OBJECT NARRAFORK CONTROLS before fetch/WS:
 * `buildHeaders`, `buildRequestHeaders`, `buildHandshakeHeaders`. Anything past
 * that point belongs to the runtime.
 *
 * THE INVENTORY IS THE POINT
 *
 * Four config surfaces carry `userAgentMode`/`customUserAgent`
 * (`settings/types.ts`: CustomApiProvider, AnthropicProvider, OpenaiProvider,
 * `settings.codex`), and `custom-api-providers.ts` folds the first into the other
 * two. They reach exactly four egress shapes, all covered below:
 *
 *   1. OpenAIProvider HTTP        — apiMode "openai" and "codex"
 *   2. OpenAIProvider WS          — handshake, fingerprint passed through
 *   3. AnthropicProvider HTTP     — officialApi true (Claude Code emulation) and false
 *   4. CodexProvider WS           — handshake, same builder as (2)
 *
 * A fifth signature, `codex-pat.ts`, hardcodes `getHttpCodexUserAgent()` with no
 * option, so it is deliberately out of scope: there is nothing to override.
 *
 * THE BUG THIS LOCKS OUT
 *
 * A plain header object is case-SENSITIVE; HTTP header names are not. The two
 * providers wrote opposite casings (`"User-Agent"` vs `"user-agent"`), so an
 * `extraHeaders` override typed in the other casing left BOTH keys in the map and
 * `fetch` comma-joined them:
 *
 *   user-agent: NarraFork-Custom/7.7, override/2.0
 *
 * — neither value, matching no real client. Measured before the fix. Hence every
 * case below asserts the KEY COUNT, not just the value: one UA key, always.
 */
import { describe, expect, test } from "bun:test";
import {
	getHttpClaudeCliUserAgent,
	getHttpCodexUserAgent,
	getHttpUserAgent,
	ORIGINATOR,
	ORIGINATOR_CODEX,
	type UserAgentMode,
} from "../../user-agent";
import { AnthropicProvider } from "../anthropic-provider";
import { createProviderTurnContext } from "../codex-turn-state";
import {
	buildHandshakeHeaders,
	type CodexResponsesRequestBody,
	type StreamCodexResponsesWebSocketOptions,
} from "../codex-websocket";
import { OpenAIProvider } from "../openai-provider";
import { resetUnsupportedParameterMemory } from "../unsupported-parameter-fallback";

const CUSTOM_UA = "NarraFork-Custom/7.7";
const OVERRIDE_UA = "override/2.0";
/** Every casing an operator could plausibly type into extraHeaders. */
const UA_CASINGS: string[] = ["user-agent", "User-Agent", "USER-AGENT"];

/** The UA keys present, so a duplicate is a failure rather than a coin flip. */
function userAgentKeys(headers: Record<string, string>): string[] {
	return Object.keys(headers).filter((key) => key.toLowerCase() === "user-agent");
}

/** The single UA value, asserting there is exactly one key carrying it. */
function soleUserAgent(headers: Record<string, string>): string {
	const keys = userAgentKeys(headers);
	expect(keys).toHaveLength(1);
	return headers[keys[0] as string] as string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Egress 1 & 2 — OpenAIProvider (HTTP headers, and the WS handshake it feeds)
// ─────────────────────────────────────────────────────────────────────────────

interface OpenAIProbeConfig {
	userAgentMode?: string;
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
	apiMode?: string;
}

function openAiHeaders(config: OpenAIProbeConfig): Record<string, string> {
	const provider = new OpenAIProvider({
		id: "probe",
		name: "Probe",
		prefix: "probe",
		apiKey: "sk-probe",
		baseUrl: "https://example.invalid/v1",
		defaultModel: "gpt-probe",
		apiMode: config.apiMode ?? "openai",
		...config,
	} as never);
	// buildHeaders is private, but it IS the boundary under test: the object handed
	// to pfetch. Reaching it directly is what makes this a wire assertion rather
	// than a restatement of the resolver.
	const reach = provider as never as { buildHeaders: (key: string) => Record<string, string> };
	return reach.buildHeaders("sk-probe");
}

// ─────────────────────────────────────────────────────────────────────────────
// Egress 3 — AnthropicProvider, both protocol shapes
// ─────────────────────────────────────────────────────────────────────────────

interface AnthropicProbeConfig {
	userAgentMode?: string;
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
}

/**
 * @param officialApi The Claude Code emulation switch. It is an explicit config
 *   flag, NOT a URL guess: it decides whether the request also carries `x-app:
 *   cli`, the `X-Stainless-*` block and the billing header. Both shapes get
 *   coverage because they resolve their UA from different fallbacks.
 */
function anthropicHeaders(
	config: AnthropicProbeConfig,
	officialApi: boolean,
): Record<string, string> {
	const provider = new AnthropicProvider({
		id: "probe",
		name: "Probe",
		prefix: "probe",
		apiKey: "sk-ant-probe",
		baseUrl: officialApi ? "https://api.anthropic.com" : "https://relay.invalid",
		defaultModel: "claude-probe",
		officialApi,
		...config,
	} as never);
	const reach = provider as never as {
		buildRequestHeaders: (key: string, official: boolean, model: string) => Record<string, string>;
	};
	return reach.buildRequestHeaders("sk-ant-probe", officialApi, "claude-probe");
}

// ─────────────────────────────────────────────────────────────────────────────
// Egress 4 — the Codex WebSocket handshake, shared by both WS callers
// ─────────────────────────────────────────────────────────────────────────────

function wsHandshakeHeaders(
	overrides: Partial<StreamCodexResponsesWebSocketOptions>,
): Record<string, string> {
	const request: CodexResponsesRequestBody = {
		model: "gpt-probe-codex",
		input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
		stream: true,
		instructions: "base",
		store: false,
	};
	return buildHandshakeHeaders({
		baseUrl: "https://chatgpt.com/backend-api/codex",
		apiKey: "sk-probe",
		sessionKey: "session-key",
		conversationId: "conv-probe",
		credentialId: "cred-1",
		model: "gpt-probe-codex",
		request,
		signal: new AbortController().signal,
		...overrides,
	});
}

describe("UA option reaches the wire — OpenAIProvider HTTP", () => {
	/**
	 * The fallback differs per apiMode (`codex` emulates the Codex CLI, plain
	 * `openai` presents NarraFork), so both are pinned. Every non-default mode must
	 * replace whichever fallback applied.
	 */
	test.each([
		["openai", undefined, getHttpUserAgent()],
		["openai", "narrafork", getHttpUserAgent()],
		["openai", "claude-code", getHttpClaudeCliUserAgent()],
		["openai", "codex", getHttpCodexUserAgent()],
		["openai", "custom", CUSTOM_UA],
		["codex", undefined, getHttpCodexUserAgent()],
		["codex", "narrafork", getHttpUserAgent()],
		["codex", "claude-code", getHttpClaudeCliUserAgent()],
		["codex", "custom", CUSTOM_UA],
	])("apiMode=%s mode=%s", (apiMode, mode, expected) => {
		const headers = openAiHeaders({
			apiMode,
			userAgentMode: mode,
			customUserAgent: CUSTOM_UA,
		});
		expect(soleUserAgent(headers)).toBe(expected);
	});

	test("a blank custom string falls back instead of sending an empty UA", () => {
		const headers = openAiHeaders({ userAgentMode: "custom", customUserAgent: "   " });
		expect(soleUserAgent(headers)).toBe(getHttpUserAgent());
	});

	test.each(UA_CASINGS)("an extraHeaders %s override lands on one key", (key) => {
		const headers = openAiHeaders({
			userAgentMode: "custom",
			customUserAgent: CUSTOM_UA,
			extraHeaders: { [key]: OVERRIDE_UA },
		});
		expect(soleUserAgent(headers)).toBe(OVERRIDE_UA);
	});
});

describe("UA option reaches the wire — AnthropicProvider HTTP", () => {
	/**
	 * Anthropic-shaped traffic defaults to Claude CLI whether the endpoint is the
	 * official Claude Code API (`officialApi: true`) or a third-party Claude Code
	 * relay (`false`). Explicit modes still win.
	 */
	test.each([
		[true, undefined, getHttpClaudeCliUserAgent()],
		[true, "narrafork", getHttpUserAgent()],
		[true, "claude-code", getHttpClaudeCliUserAgent()],
		[true, "codex", getHttpCodexUserAgent()],
		[true, "custom", CUSTOM_UA],
		[false, undefined, getHttpClaudeCliUserAgent()],
		[false, "narrafork", getHttpUserAgent()],
		[false, "claude-code", getHttpClaudeCliUserAgent()],
		[false, "custom", CUSTOM_UA],
	])("officialApi=%s mode=%s", (officialApi, mode, expected) => {
		const headers = anthropicHeaders(
			{ userAgentMode: mode, customUserAgent: CUSTOM_UA },
			officialApi,
		);
		expect(soleUserAgent(headers)).toBe(expected);
	});

	test("a blank custom string falls back instead of sending an empty UA", () => {
		const headers = anthropicHeaders({ userAgentMode: "custom", customUserAgent: "" }, true);
		expect(soleUserAgent(headers)).toBe(getHttpClaudeCliUserAgent());
	});

	/**
	 * This provider writes `"user-agent"` in lower case, the opposite of
	 * OpenAIProvider, so the casing that used to duplicate here is the one that
	 * worked there. Both directions are covered.
	 */
	test.each(UA_CASINGS)("an extraHeaders %s override lands on one key", (key) => {
		const headers = anthropicHeaders(
			{
				userAgentMode: "custom",
				customUserAgent: CUSTOM_UA,
				extraHeaders: { [key]: OVERRIDE_UA },
			},
			false,
		);
		expect(soleUserAgent(headers)).toBe(OVERRIDE_UA);
	});

	test("the override also applies under the Claude Code emulation shape", () => {
		const headers = anthropicHeaders(
			{
				userAgentMode: "custom",
				customUserAgent: CUSTOM_UA,
				extraHeaders: { "User-Agent": OVERRIDE_UA },
			},
			true,
		);
		expect(soleUserAgent(headers)).toBe(OVERRIDE_UA);
	});
});

describe("UA option reaches the wire — Codex WebSocket handshake", () => {
	/**
	 * Both WS callers (openai-provider's codex channel and the built-in Codex
	 * adapter) pass the resolved fingerprint as `userAgent` + `extraHeaders`, so a
	 * handshake that ignored `userAgent`, or that let a differently-cased
	 * `extraHeaders` UA duplicate it, would silently present the wrong identity —
	 * and a refused upgrade only shows up as "WS never works".
	 */
	test("uses the Codex CLI UA when no option was configured", () => {
		expect(soleUserAgent(wsHandshakeHeaders({}))).toBe(getHttpCodexUserAgent());
	});

	test.each([
		["narrafork", getHttpUserAgent()],
		["claude-code", getHttpClaudeCliUserAgent()],
		["custom", CUSTOM_UA],
	])("carries the resolved UA for mode=%s", (_mode, resolved) => {
		expect(soleUserAgent(wsHandshakeHeaders({ userAgent: resolved }))).toBe(resolved);
	});

	test.each(UA_CASINGS)("an extraHeaders %s override lands on one key", (key) => {
		const headers = wsHandshakeHeaders({
			userAgent: CUSTOM_UA,
			extraHeaders: { [key]: OVERRIDE_UA },
		});
		expect(soleUserAgent(headers)).toBe(OVERRIDE_UA);
	});

	test("a fingerprint header map without a UA leaves the resolved UA intact", () => {
		// The normal shape: resolveClientFingerprint returns the UA separately and
		// its header map carries only the codex identity headers.
		const headers = wsHandshakeHeaders({
			userAgent: CUSTOM_UA,
			extraHeaders: { originator: "codex-tui", "x-codex-installation-id": "inst-1" },
		});
		expect(soleUserAgent(headers)).toBe(CUSTOM_UA);
	});

	/**
	 * User-reported: Codex UA set to NarraFork still went out as codex-tui.
	 * The handshake hardcodes originator to codex-tui as its default; the
	 * resolved fingerprint must overwrite it when the operator chose NarraFork,
	 * or dumps still look like the managed Codex client.
	 */
	test("NarraFork fingerprint headers replace the handshake originator default", () => {
		const headers = wsHandshakeHeaders({
			userAgent: getHttpUserAgent(),
			extraHeaders: { originator: ORIGINATOR, "x-codex-installation-id": "inst-1" },
		});
		expect(soleUserAgent(headers)).toBe(getHttpUserAgent());
		expect(headers.originator).toBe(ORIGINATOR);
	});

	test("Codex-mode fingerprint keeps originator as codex-tui", () => {
		const headers = wsHandshakeHeaders({
			userAgent: getHttpCodexUserAgent(),
			extraHeaders: { originator: ORIGINATOR_CODEX, "x-codex-installation-id": "inst-1" },
		});
		expect(soleUserAgent(headers)).toBe(getHttpCodexUserAgent());
		expect(headers.originator).toBe(ORIGINATOR_CODEX);
	});
});

/**
 * A single UA key is the property that matters on EVERY egress, because two keys
 * do not mean "one wins" — the runtime joins them. Asserting it once per egress
 * in one place makes a newly added egress that forgets the rule visible here
 * rather than in production traffic.
 */
describe("no egress ever emits two User-Agent keys", () => {
	test.each(UA_CASINGS)("openai HTTP with %s injected", (key) => {
		const headers = openAiHeaders({
			userAgentMode: "narrafork",
			extraHeaders: { [key]: OVERRIDE_UA },
		});
		expect(userAgentKeys(headers)).toHaveLength(1);
	});

	test.each(UA_CASINGS)("anthropic HTTP with %s injected", (key) => {
		const headers = anthropicHeaders(
			{ userAgentMode: "narrafork", extraHeaders: { [key]: OVERRIDE_UA } },
			true,
		);
		expect(userAgentKeys(headers)).toHaveLength(1);
	});

	test.each(UA_CASINGS)("codex WS handshake with %s injected", (key) => {
		const headers = wsHandshakeHeaders({
			userAgent: getHttpUserAgent(),
			extraHeaders: { [key]: OVERRIDE_UA },
		});
		expect(userAgentKeys(headers)).toHaveLength(1);
	});
});

describe("provider defaults are overridden at the real HTTP egress", () => {
	for (const protocol of ["anthropic", "responses", "codex", "completions"] as const) {
		test(`${protocol} sends one selected UA and one value for each overridden header`, async () => {
			const { server, requests, baseUrl } = startWireCapture(protocol);
			try {
				const config = {
					id: `wire-${protocol}`,
					prefix: "wire",
					name: "Wire probe",
					apiKey: "default-key",
					baseUrl,
					defaultModel: protocol === "anthropic" ? "claude-sonnet-5" : "gpt-5.5",
					userAgentMode: "custom" as const,
					customUserAgent: "configured/1",
					proxy: { mode: "direct" as const },
					apiMode: protocol === "anthropic" ? ("completions" as const) : protocol,
					codexWebSocket: false,
					codexWebSearch: false,
					codexImageGeneration: false,
					officialApi: true,
				};
				for (const extraHeaders of [
					undefined,
					{
						"uSeR-aGeNt": "operator/2",
						authorization: "Bearer operator",
						Originator: "operator",
						"cOnTeNt-TyPe": "application/custom+json",
						"Anthropic-Version": "operator-version",
					},
				]) {
					const provider =
						protocol === "anthropic"
							? new AnthropicProvider({ ...config, extraHeaders })
							: new OpenAIProvider({ ...config, extraHeaders });
					for await (const _event of provider.chat({
						conversationId: "wire-probe",
						model: `wire:${config.defaultModel}`,
						content: "hello",
						cwd: process.cwd(),
						history: [],
						tools: [],
						toolResults: [],
						signal: AbortSignal.timeout(2000),
					})) {
						// Drain the actual transport, including successful completion.
					}
				}
				const captured = requests.map((request) => request.headers);
				expect(captured).toHaveLength(2);
				expect(captured[0]?.get("user-agent")).toBe("configured/1");
				expect(captured[1]?.get("user-agent")).toBe("operator/2");
				expect(captured[1]?.get("authorization")).toBe("Bearer operator");
				expect(captured[1]?.get("originator")).toBe("operator");
				expect(captured[1]?.get("content-type")).toBe("application/custom+json");
				expect(captured[1]?.get("anthropic-version")).toBe("operator-version");
			} finally {
				await server.stop(true);
			}
		});
	}
});

describe("explicit UA survives the final HTTP transport", () => {
	for (const protocol of ["anthropic", "responses", "codex", "completions"] as const) {
		test(`${protocol}: operator UA wins, transport authentication stays current`, async () => {
			const { server, requests, baseUrl } = startWireCapture(protocol);
			const observed: Array<string | null> = [];
			try {
				let channel = 0;
				const config = {
					id: `final-${protocol}`,
					prefix: "wire",
					name: "Final UA probe",
					apiKey: "default-key",
					baseUrl,
					defaultModel: protocol === "anthropic" ? "claude-sonnet-5" : "gpt-5.5",
					userAgentMode: "custom" as const,
					customUserAgent: "selected/1",
					proxy: { mode: "direct" as const },
					apiMode: protocol === "anthropic" ? ("completions" as const) : protocol,
					codexWebSocket: false,
					codexWebSearch: false,
					codexImageGeneration: false,
					officialApi: true,
					extraHeaders: { authorization: "Bearer static" } as Record<string, string>,
					dynamicHeaders: () => ({
						"USER-AGENT": "dynamic/default",
						"X-Dynamic": "latest",
						Authorization: "Bearer dynamic",
					}),
				};
				const transport: import("../provider-transport").ProviderTransport = {
					transportHeaders(headers) {
						headers.set("User-Agent", "transport/default");
						headers.set("Authorization", "Bearer transport");
						headers.set("X-Channel", `channel-${++channel}`);
					},
					fetch(input, init, next) {
						const headers = new Headers(init?.headers);
						observed.push(headers.get("user-agent"));
						// Relay retries may replace their whole header map before next().
						headers.set("USER-AGENT", "retry/default");
						headers.set("Authorization", "Bearer refreshed-transport");
						return next(input, { ...init, headers });
					},
				};
				const provider =
					protocol === "anthropic"
						? new AnthropicProvider(config, transport)
						: new OpenAIProvider(config, undefined, transport);
				for (let i = 0; i < 2; i++) {
					if (i === 1) config.extraHeaders["uSeR-aGeNt"] = " operator/2 ";
					for await (const _event of provider.chat({
						conversationId: "final-ua-probe",
						model: `wire:${config.defaultModel}`,
						content: "hello",
						cwd: process.cwd(),
						history: [],
						tools: [],
						toolResults: [],
						signal: AbortSignal.timeout(8000),
					})) {
						/* Drain the real HTTP request. */
					}
				}
				const captured = requests.map((request) => request.headers);
				expect(observed).toEqual(["selected/1", "operator/2"]);
				expect(captured.map((headers) => headers.get("user-agent"))).toEqual([
					"selected/1",
					"operator/2",
				]);
				expect(captured.map((headers) => headers.get("authorization"))).toEqual([
					"Bearer refreshed-transport",
					"Bearer refreshed-transport",
				]);
				expect(captured.map((headers) => headers.get("x-channel"))).toEqual([
					"channel-1",
					"channel-2",
				]);
				if (protocol !== "anthropic")
					expect(captured.every((headers) => headers.get("x-dynamic") === "latest")).toBe(true);
			} finally {
				await server.stop(true);
			}
		});
	}
});

type WireProtocol = "anthropic" | "responses" | "codex" | "completions";
interface CapturedWireRequest {
	url: URL;
	method: string;
	headers: Headers;
	raw: string;
	body: Record<string, unknown>;
}
interface WireSelection {
	userAgentMode?: UserAgentMode;
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
}

function wireReply(protocol: WireProtocol, body: Record<string, unknown>, text = "ok"): Response {
	const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
	const message = {
		id: "msg_wire",
		type: "message",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	const response = { id: "resp_wire", status: "completed", output: [message], usage };
	if (!body.stream) {
		return Response.json(
			protocol === "anthropic"
				? {
						id: "msg_wire",
						type: "message",
						role: "assistant",
						content: [{ type: "text", text }],
						stop_reason: "end_turn",
						usage,
					}
				: protocol === "completions"
					? {
							id: "chat_wire",
							choices: [
								{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
							],
							usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
						}
					: response,
		);
	}
	const frames =
		protocol === "anthropic"
			? [
					{
						type: "message_start",
						message: {
							id: "msg_wire",
							role: "assistant",
							content: [],
							usage: { input_tokens: 1, output_tokens: 0 },
						},
					},
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
					{ type: "content_block_stop", index: 0 },
					...(Array.isArray(body.tools) && body.tools.some((tool) => tool?.name === "web_search")
						? [
								{
									type: "content_block_start",
									index: 1,
									content_block: {
										type: "server_tool_use",
										id: "srvtool_wire",
										name: "web_search",
										input: { query: "local fixture query" },
									},
								},
								{ type: "content_block_stop", index: 1 },
								{
									type: "content_block_start",
									index: 2,
									content_block: {
										type: "web_search_tool_result",
										tool_use_id: "srvtool_wire",
										content: [
											{
												type: "web_search_result",
												title: "Local fixture source",
												url: "https://example.invalid/fixture",
												encrypted_content: "fixture-only-opaque-content",
											},
										],
									},
								},
								{ type: "content_block_stop", index: 2 },
							]
						: []),
					{
						type: "message_delta",
						delta: { stop_reason: "end_turn" },
						usage: { output_tokens: 1 },
					},
					{ type: "message_stop" },
				]
			: protocol === "completions"
				? [
						{
							choices: [
								{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null },
							],
						},
						{
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
						},
					]
				: [
						{
							type: "response.created",
							response: { id: "resp_wire", status: "in_progress", output: [] },
						},
						{
							type: "response.output_item.added",
							output_index: 0,
							item: { ...message, status: "in_progress", content: [] },
						},
						{
							type: "response.content_part.added",
							output_index: 0,
							item_id: message.id,
							content_index: 0,
							part: { type: "output_text", text: "" },
						},
						{
							type: "response.output_text.delta",
							output_index: 0,
							item_id: message.id,
							content_index: 0,
							delta: text,
						},
						{
							type: "response.output_text.done",
							output_index: 0,
							item_id: message.id,
							content_index: 0,
							text,
						},
						{
							type: "response.content_part.done",
							output_index: 0,
							item_id: message.id,
							content_index: 0,
							part: message.content[0],
						},
						{ type: "response.output_item.done", output_index: 0, item: message },
						{ type: "response.completed", response },
					];
	return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function startWireCapture(
	protocol: WireProtocol,
	reply?: (request: CapturedWireRequest, index: number) => Response,
) {
	const requests: CapturedWireRequest[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const raw = await request.text();
			if (raw.length > 64 * 1024)
				return new Response("Fixture request budget exceeded", { status: 413 });
			const captured = {
				url: new URL(request.url),
				method: request.method,
				headers: request.headers,
				raw,
				body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
			};
			requests.push(captured);
			return reply?.(captured, requests.length - 1) ?? wireReply(protocol, captured.body);
		},
	});
	return { server, requests, baseUrl: `${server.url.origin}/v1` };
}

function wireProvider(protocol: WireProtocol, baseUrl: string, selection: WireSelection = {}) {
	let channel = 0;
	const dynamicHeaders = () => ({
		"USER-AGENT": "dynamic/default",
		Authorization: "Bearer dynamic",
		"X-Channel": `live-${++channel}`,
	});
	const config = {
		id: `wire-${protocol}`,
		name: "Local wire fixture",
		prefix: "wire",
		apiKey: "fake-wire-key",
		baseUrl,
		defaultModel: protocol === "anthropic" ? "claude-sonnet-5" : "gpt-5.5",
		apiMode: protocol === "anthropic" ? ("responses" as const) : protocol,
		proxy: { mode: "direct" as const },
		officialApi: false,
		codexWebSocket: false,
		codexWebSearch: false,
		codexImageGeneration: false,
		...selection,
		extraHeaders: {
			Authorization: "Bearer static",
			"x-channel": "stale",
			...selection.extraHeaders,
		},
		dynamicHeaders,
	};
	const provider =
		protocol === "anthropic"
			? new AnthropicProvider(config, {
					transportHeaders(headers) {
						for (const [key, value] of Object.entries(dynamicHeaders())) headers.set(key, value);
					},
				})
			: new OpenAIProvider(config);
	return { config, provider, model: `wire:${config.defaultModel}` };
}

function assertWireIdentity(request: CapturedWireRequest, expected: string) {
	expect(request.headers.get("user-agent")).toBe(expected);
	expect(
		Array.from(request.headers.keys()).filter((key) => key.toLowerCase() === "user-agent"),
	).toHaveLength(1);
	expect(request.headers.get("authorization")).toBe("Bearer dynamic");
	expect(request.headers.get("content-type")).toBe("application/json");
	expect(request.method).toBe("POST");
	expect(request.raw).not.toBe("");
	expect(request.body.model).toBeTruthy();
}

const WIRE_SELECTIONS: Array<{ name: string; selection: WireSelection; expected: string }> = [
	{ name: "narrafork", selection: { userAgentMode: "narrafork" }, expected: getHttpUserAgent() },
	{ name: "codex", selection: { userAgentMode: "codex" }, expected: getHttpCodexUserAgent() },
	{
		name: "claude-code",
		selection: { userAgentMode: "claude-code" },
		expected: getHttpClaudeCliUserAgent(),
	},
	{
		name: "custom",
		selection: { userAgentMode: "custom", customUserAgent: CUSTOM_UA },
		expected: CUSTOM_UA,
	},
	{
		name: "mixed-case extra",
		selection: {
			userAgentMode: "custom",
			customUserAgent: CUSTOM_UA,
			extraHeaders: { "USER-AGENT": "earlier/1", "uSeR-aGeNt": ` ${OVERRIDE_UA} ` },
		},
		expected: OVERRIDE_UA,
	},
	{
		name: "blank",
		selection: {
			userAgentMode: "custom",
			customUserAgent: " \t ",
			extraHeaders: { "USER-AGENT": " \t " },
		},
		expected: "dynamic/default",
	},
	{ name: "unset", selection: {}, expected: "dynamic/default" },
];

describe("complete local wire captures", () => {
	for (const protocol of ["anthropic", "responses", "codex", "completions"] as const) {
		for (const { name, selection, expected } of WIRE_SELECTIONS) {
			test(`${protocol} ${name}: chat, generate and history utility reach the final wire`, async () => {
				const wire = startWireCapture(protocol);
				try {
					const { provider, model } = wireProvider(protocol, wire.baseUrl, selection);
					for await (const _event of provider.chat({
						conversationId: "wire-chat",
						model,
						content: "chat message",
						cwd: process.cwd(),
						history: [],
						tools: [],
						toolResults: [],
						maxOutputTokens: 2048,
						signal: AbortSignal.timeout(8000),
					})) {
						/* Drain the actual streamed request. */
					}
					expect(await provider.generate("one-shot input", model)).toBe("ok");
					expect(
						await provider.generateWithHistory(
							"root instruction",
							"past conversation",
							model,
							"en",
							{ maxOutputTokens: 2048, signal: AbortSignal.timeout(8000) },
						),
					).toBe("ok");
					expect(wire.requests).toHaveLength(3);
					for (const request of wire.requests) {
						assertWireIdentity(request, expected);
						expect(request.headers.get("x-channel")).toMatch(/^live-[1-3]$/);
						expect(request.url.pathname).toBe(
							protocol === "anthropic"
								? "/v1/messages"
								: protocol === "completions"
									? "/v1/chat/completions"
									: "/v1/responses",
						);
						if (protocol === "anthropic" || protocol === "completions")
							expect(Array.isArray(request.body.messages)).toBe(true);
						else expect(Array.isArray(request.body.input)).toBe(true);
					}
					expect(wire.requests.map((request) => request.headers.get("x-channel"))).toEqual([
						"live-1",
						"live-2",
						"live-3",
					]);
					const historyBody = wire.requests[2].body;
					if (protocol === "responses") {
						expect(historyBody.instructions).toBeUndefined();
						expect(historyBody.input).toEqual(
							expect.arrayContaining([
								expect.objectContaining({
									role: "developer",
									content: [{ type: "input_text", text: "root instruction" }],
								}),
							]),
						);
					}
					if (protocol === "codex") {
						expect(historyBody.instructions).toBeUndefined();
						expect(historyBody.max_output_tokens).toBeUndefined();
						expect(historyBody.input).toEqual(
							expect.arrayContaining([
								expect.objectContaining({
									role: "developer",
									content: [expect.objectContaining({ text: "root instruction" })],
								}),
							]),
						);
					}
				} finally {
					await wire.server.stop(true);
				}
			});
		}
	}
	for (const { name, selection, expected } of WIRE_SELECTIONS) {
		test(`Anthropic search ${name}: native-search request keeps final UA and native declaration`, async () => {
			const wire = startWireCapture("anthropic");
			try {
				const { config } = wireProvider("anthropic", wire.baseUrl, selection);
				const provider = new AnthropicProvider(config, {
					transportHeaders(headers) {
						headers.set("User-Agent", "dynamic/default");
						headers.set("Authorization", "Bearer dynamic");
						headers.set("X-Channel", "search-live");
					},
				});
				const result = await provider.performWebSearch({
					query: "local fixture query",
					model: "wire:claude-sonnet-5",
					allowedDomains: ["example.invalid"],
					signal: AbortSignal.timeout(8000),
				});
				expect(result.text).toBe("ok");
				expect(wire.requests).toHaveLength(1);
				assertWireIdentity(wire.requests[0], expected);
				expect(wire.requests[0].body.tools).toEqual([
					expect.objectContaining({
						type: "web_search_20250305",
						name: "web_search",
						allowed_domains: ["example.invalid"],
					}),
				]);
				expect(wire.requests[0].body.tool_choice).toEqual({ type: "tool", name: "web_search" });
			} finally {
				await wire.server.stop(true);
			}
		});
	}
});

test("real WS rejection falls back to HTTP with current authentication, operator UA and same-turn state", async () => {
	const wire = startWireCapture("codex", (request) => {
		if (request.method === "GET")
			return new Response("WebSocket unsupported here", { status: 426 });
		const response = wireReply("codex", request.body);
		response.headers.set("x-codex-turn-state", "http-turn-route");
		return response;
	});
	try {
		let headersRead = 0;
		const { config, model } = wireProvider("codex", wire.baseUrl, {
			userAgentMode: "custom",
			customUserAgent: CUSTOM_UA,
			extraHeaders: { "uSeR-aGeNt": OVERRIDE_UA },
		});
		const provider = new OpenAIProvider({
			...config,
			codexWebSocket: true,
			dynamicHeaders: () => ({
				"USER-AGENT": "dynamic/default",
				Authorization: ++headersRead === 1 ? "Bearer handshake-a" : "Bearer http-b",
				"X-Channel": `phase-${headersRead}`,
			}),
		});
		const turnContext = createProviderTurnContext();
		for (let i = 0; i < 2; i++) {
			for await (const _event of provider.chat({
				conversationId: "wire-ws-http",
				turnContext,
				model,
				content: "hello",
				cwd: process.cwd(),
				history: [],
				tools: [],
				toolResults: [],
				signal: AbortSignal.timeout(8000),
			})) {
				/* Drain WS rejection and HTTP fallback. */
			}
		}
		expect(wire.requests.map((request) => request.method)).toEqual(["GET", "POST", "POST"]);
		expect(wire.requests.map((request) => request.headers.get("user-agent"))).toEqual([
			OVERRIDE_UA,
			OVERRIDE_UA,
			OVERRIDE_UA,
		]);
		expect(wire.requests.map((request) => request.headers.get("authorization"))).toEqual([
			"Bearer handshake-a",
			"Bearer http-b",
			"Bearer http-b",
		]);
		expect(wire.requests[1].headers.get("x-codex-turn-state")).toBeNull();
		expect(wire.requests[2].headers.get("x-codex-turn-state")).toBe("http-turn-route");
		expect(wire.requests[1].body.client_metadata).toEqual(wire.requests[2].body.client_metadata);
		for (const request of wire.requests)
			expect(request.headers.get("session-id")).toBe("wire-ws-http");
		for (const request of wire.requests.slice(1)) {
			expect(Array.isArray(request.body.input)).toBe(true);
			expect(request.body.instructions).toBeUndefined();
			expect(request.body.max_output_tokens).toBeUndefined();
		}
	} finally {
		await wire.server.stop(true);
	}
});

test("real Codex format degradation keeps operator UA, authentication and turn identity on the retry", async () => {
	resetUnsupportedParameterMemory();
	const wire = startWireCapture("codex", (request, index) =>
		index === 0
			? Response.json(
					{
						error: { message: "Unsupported parameter: text.format", type: "invalid_request_error" },
					},
					{ status: 400, headers: { "x-codex-turn-state": "schema-route" } },
				)
			: wireReply("codex", request.body, '{"value":"ok"}'),
	);
	try {
		const { provider, model } = wireProvider("codex", wire.baseUrl, {
			userAgentMode: "custom",
			customUserAgent: CUSTOM_UA,
			extraHeaders: { "USER-AGENT": OVERRIDE_UA },
		});
		const result = await provider.generateWithMeta("hello", model, "Base instructions.", {
			signal: AbortSignal.timeout(8000),
			responseFormat: {
				type: "json_schema",
				name: "wire_value",
				schema: {
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
					additionalProperties: false,
				},
				strict: true,
			},
		});
		expect(result.structured).toEqual({ value: "ok" });
		expect(wire.requests).toHaveLength(2);
		for (const request of wire.requests) assertWireIdentity(request, OVERRIDE_UA);
		expect(wire.requests[1].headers.get("x-codex-turn-state")).toBe("schema-route");
		const bodies = wire.requests.map((request) => request.body);
		expect((bodies[0].text as Record<string, unknown>).format).toBeDefined();
		expect((bodies[1].text as Record<string, unknown>).format).toBeUndefined();
		expect(bodies[1].client_metadata).toEqual(bodies[0].client_metadata);
		expect(bodies[1].prompt_cache_key).toBe(bodies[0].prompt_cache_key);
		const prefixes = bodies.map(
			(body) => (body.input as Array<{ id: string; content: Array<{ text: string }> }>)[0],
		);
		expect(prefixes[0].content[0].text).toBe("Base instructions.");
		expect(prefixes[1].content[0].text).toContain('"value"');
		expect(prefixes[0].id).not.toBe(prefixes[1].id);
	} finally {
		resetUnsupportedParameterMemory();
		await wire.server.stop(true);
	}
});

test("Anthropic /v1 discovery reuses the real body and keeps final identity across every utility surface", async () => {
	const wire = startWireCapture("anthropic", (request, index) =>
		index === 0
			? Response.json(
					{ error: { type: "not_found_error", message: "Use /v1/messages" } },
					{ status: 404 },
				)
			: wireReply("anthropic", request.body),
	);
	try {
		const { provider, model } = wireProvider("anthropic", wire.server.url.origin, {
			userAgentMode: "custom",
			customUserAgent: CUSTOM_UA,
			extraHeaders: { "uSeR-aGeNt": OVERRIDE_UA },
		});
		if (!(provider instanceof AnthropicProvider))
			throw new Error("Expected Anthropic wire fixture");
		for await (const _event of provider.chat({
			conversationId: "wire-v1",
			model,
			content: "hello",
			cwd: process.cwd(),
			history: [],
			tools: [],
			toolResults: [],
			signal: AbortSignal.timeout(8000),
		})) {
			/* Drain initial attempt and /v1 retry. */
		}
		expect(await provider.generate("one-shot", model)).toBe("ok");
		expect(
			await provider.generateWithHistory("root", "history", model, "en", {
				signal: AbortSignal.timeout(8000),
			}),
		).toBe("ok");
		expect(
			(
				await provider.performWebSearch({
					model,
					query: "local search",
					signal: AbortSignal.timeout(8000),
				})
			).text,
		).toBe("ok");
		expect(wire.requests).toHaveLength(5);
		expect(wire.requests.map((request) => request.url.pathname)).toEqual([
			"/messages",
			"/v1/messages",
			"/v1/messages",
			"/v1/messages",
			"/v1/messages",
		]);
		expect(wire.requests[0].raw).toBe(wire.requests[1].raw);
		for (const request of wire.requests) {
			assertWireIdentity(request, OVERRIDE_UA);
			expect(request.headers.get("x-api-key")).toBe("fake-wire-key");
			expect(typeof request.body.max_tokens).toBe("number");
			expect(Array.isArray(request.body.messages)).toBe(true);
		}
		expect(wire.requests.map((request) => request.headers.get("x-channel"))).toEqual([
			"live-1",
			"live-2",
			"live-3",
			"live-4",
			"live-5",
		]);
	} finally {
		await wire.server.stop(true);
	}
});

for (const protocol of ["responses", "completions"] as const) {
	test(`${protocol}: permitted parameter retry preserves the actual output ceiling, identity and input bytes`, async () => {
		resetUnsupportedParameterMemory();
		const wire = startWireCapture(protocol, (request, index) =>
			index === 0
				? Response.json(
						{
							error: {
								message: "Unsupported parameter: prompt_cache_key",
								type: "invalid_request_error",
							},
						},
						{ status: 400 },
					)
				: wireReply(protocol, request.body),
		);
		try {
			const { provider, model } = wireProvider(protocol, wire.baseUrl, {
				userAgentMode: "custom",
				customUserAgent: CUSTOM_UA,
				extraHeaders: { "USER-AGENT": OVERRIDE_UA },
			});
			for await (const _event of provider.chat({
				conversationId: "wire-parameter-retry",
				model,
				content: "hello",
				cwd: process.cwd(),
				history: [],
				tools: [],
				toolResults: [],
				maxOutputTokens: 123,
				signal: AbortSignal.timeout(8000),
			})) {
				/* Drain parameter retry. */
			}
			expect(wire.requests).toHaveLength(2);
			for (const request of wire.requests) assertWireIdentity(request, OVERRIDE_UA);
			const [first, second] = wire.requests.map((request) => request.body);
			expect(first.prompt_cache_key).toBe("wire-parameter-retry");
			expect(second.prompt_cache_key).toBeUndefined();
			for (const body of [first, second])
				expect(body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens).toBe(123);
			expect(second.input ?? second.messages).toEqual(first.input ?? first.messages);
			expect(second.tools).toEqual(first.tools);
		} finally {
			resetUnsupportedParameterMemory();
			await wire.server.stop(true);
		}
	});
	test(`${protocol}: unsupported output-budget error produces no uncapped wire retry`, async () => {
		resetUnsupportedParameterMemory();
		const wire = startWireCapture(protocol, (request) => {
			const parameter =
				request.body.max_output_tokens !== undefined
					? "max_output_tokens"
					: request.body.max_completion_tokens !== undefined
						? "max_completion_tokens"
						: "max_tokens";
			return Response.json(
				{
					error: { message: `Unsupported parameter: ${parameter}`, type: "invalid_request_error" },
				},
				{ status: 400 },
			);
		});
		try {
			const { provider, model } = wireProvider(protocol, wire.baseUrl, {
				userAgentMode: "custom",
				customUserAgent: CUSTOM_UA,
				extraHeaders: { "USER-AGENT": OVERRIDE_UA },
			});
			await expect(
				provider.generateWithMeta("hello", model, "root", {
					maxOutputTokens: 123,
					signal: AbortSignal.timeout(8000),
				}),
			).rejects.toThrow("Unsupported parameter");
			expect(wire.requests).toHaveLength(1);
			assertWireIdentity(wire.requests[0], OVERRIDE_UA);
			const body = wire.requests[0].body;
			expect(body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens).toBe(123);
		} finally {
			resetUnsupportedParameterMemory();
			await wire.server.stop(true);
		}
	});
}

test("Anthropic explicit public API version pairs final headers with every actual request body", async () => {
	const wire = startWireCapture("anthropic");
	try {
		const { provider, model } = wireProvider("anthropic", wire.baseUrl, {
			userAgentMode: "custom",
			customUserAgent: CUSTOM_UA,
			extraHeaders: { "uSeR-aGeNt": OVERRIDE_UA, "Anthropic-Version": "2026-10-21" },
		});
		if (!(provider instanceof AnthropicProvider))
			throw new Error("Expected Anthropic wire fixture");
		for await (const _event of provider.chat({
			conversationId: "wire-public-anthropic",
			model,
			content: "hello",
			cwd: process.cwd(),
			history: [],
			tools: [],
			toolResults: [],
			maxOutputTokens: 2048,
			signal: AbortSignal.timeout(8000),
		})) {
			/* Drain the version-paired request. */
		}
		expect(await provider.generate("one-shot", model)).toBe("ok");
		expect(
			await provider.generateWithHistory("root", "history", model, "en", {
				signal: AbortSignal.timeout(8000),
			}),
		).toBe("ok");
		expect(
			(
				await provider.performWebSearch({
					model,
					query: "local search",
					signal: AbortSignal.timeout(8000),
				})
			).text,
		).toBe("ok");
		expect(wire.requests).toHaveLength(4);
		for (const request of wire.requests) {
			assertWireIdentity(request, OVERRIDE_UA);
			expect(request.headers.get("anthropic-version")).toBe("2026-10-21");
			expect(request.body).not.toHaveProperty("temperature");
			expect(request.body).not.toHaveProperty("top_p");
			expect(request.body).not.toHaveProperty("top_k");
			expect(Array.isArray(request.body.messages)).toBe(true);
			expect(typeof request.body.max_tokens).toBe("number");
		}
	} finally {
		await wire.server.stop(true);
	}
});
