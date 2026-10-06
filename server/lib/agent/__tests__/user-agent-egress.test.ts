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
} from "../../user-agent";
import { AnthropicProvider } from "../anthropic-provider";
import {
	buildHandshakeHeaders,
	type CodexResponsesRequestBody,
	type StreamCodexResponsesWebSocketOptions,
} from "../codex-websocket";
import { OpenAIProvider } from "../openai-provider";

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
