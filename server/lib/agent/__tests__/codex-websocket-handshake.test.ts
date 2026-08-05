/**
 * Handshake headers for the Codex Responses WebSocket.
 *
 * These are worth pinning because a wrong header or a wrong conditional does not
 * surface as a visible error: the upstream refuses the upgrade and the transport
 * silently falls back to HTTP, so the only symptom is "WS never works" with no
 * useful log. The two callers also deliberately differ — openai-provider's codex
 * channel supplies a fingerprint, the built-in Codex adapter does not — so the
 * default path and the override path both need coverage.
 *
 * See docs/codex-websocket.md for the documented contract.
 */
import { describe, expect, test } from "bun:test";
import { getHttpUserAgent } from "../../user-agent";
import {
	buildHandshakeHeaders,
	type CodexResponsesRequestBody,
	type StreamCodexResponsesWebSocketOptions,
} from "../codex-websocket";

const OFFICIAL_BASE_URL = "https://chatgpt.com/backend-api/codex";
const RELAY_BASE_URL = "https://relay.example.com/codex";

function makeRequest(): CodexResponsesRequestBody {
	return {
		model: "gpt-5.3-codex",
		input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
		stream: true,
		instructions: "base",
		store: false,
	};
}

function makeOptions(
	overrides: Partial<StreamCodexResponsesWebSocketOptions> = {},
): StreamCodexResponsesWebSocketOptions {
	return {
		baseUrl: OFFICIAL_BASE_URL,
		apiKey: "sk-test-key",
		sessionKey: "session-key",
		credentialId: "cred-1",
		model: "gpt-5.3-codex",
		request: makeRequest(),
		signal: new AbortController().signal,
		...overrides,
	};
}

function build(
	overrides: Partial<StreamCodexResponsesWebSocketOptions> = {},
	turnState: string | null = null,
): Record<string, string> {
	return buildHandshakeHeaders(makeOptions(overrides), { turnState });
}

describe("codex WebSocket handshake headers", () => {
	test("built-in Codex adapter path (no fingerprint) sends the narrafork defaults", () => {
		const headers = build();

		expect(headers.Authorization).toBe("Bearer sk-test-key");
		expect(headers["User-Agent"]).toBe(getHttpUserAgent());
		expect(headers.originator).toBe("narrafork");
		expect(headers["OpenAI-Beta"]).toBe("responses_websockets=2026-02-06");
	});

	test("authorization overrides the bearer form (Agent Identity assertions)", () => {
		const headers = build({ authorization: "  AgentAssertion abc  " });

		expect(headers.Authorization).toBe("AgentAssertion abc");
	});

	test("a blank authorization falls back to the api key rather than sending an empty header", () => {
		const headers = build({ authorization: "   " });

		expect(headers.Authorization).toBe("Bearer sk-test-key");
	});

	test("x-client-request-id carries the session key", () => {
		const headers = build({ sessionKey: "narrator-42" });

		expect(headers["x-client-request-id"]).toBe("narrator-42");
	});

	test("Origin is the chatgpt origin on official domains and the base url elsewhere", () => {
		expect(build().Origin).toBe("https://chatgpt.com");
		expect(build({ baseUrl: RELAY_BASE_URL }).Origin).toBe(RELAY_BASE_URL);
	});

	test("ChatGPT-Account-Id is only sent to official domains", () => {
		expect(build({ accountId: "acct-1" })["ChatGPT-Account-Id"]).toBe("acct-1");
		expect(
			build({ accountId: "acct-1", baseUrl: RELAY_BASE_URL })["ChatGPT-Account-Id"],
		).toBeUndefined();
	});

	test("ChatGPT-Account-Id is omitted when no account is known", () => {
		expect(build()["ChatGPT-Account-Id"]).toBeUndefined();
	});

	test("x-codex-turn-state is replayed only when the session captured one", () => {
		expect(build({}, "turn-state-token")["x-codex-turn-state"]).toBe("turn-state-token");
		expect(build()["x-codex-turn-state"]).toBeUndefined();
	});

	test("x-codex-turn-metadata is only sent when the caller supplies it", () => {
		expect(build({ turnMetadata: "meta" })["x-codex-turn-metadata"]).toBe("meta");
		expect(build()["x-codex-turn-metadata"]).toBeUndefined();
	});

	test("userAgent overrides the default UA", () => {
		const headers = build({ userAgent: "codex_cli_rs/0.144.0 (Linux; x64) unknown" });

		expect(headers["User-Agent"]).toBe("codex_cli_rs/0.144.0 (Linux; x64) unknown");
	});

	test("extraHeaders win over the built-in defaults, including originator", () => {
		const headers = build({
			extraHeaders: {
				originator: "codex_cli_rs",
				"x-codex-installation-id": "install-1",
				"session-id": "sess-1",
				"thread-id": "thread-1",
			},
		});

		expect(headers.originator).toBe("codex_cli_rs");
		expect(headers["x-codex-installation-id"]).toBe("install-1");
		expect(headers["session-id"]).toBe("sess-1");
		expect(headers["thread-id"]).toBe("thread-1");
	});

	test("empty extraHeader values do not clobber a built-in default", () => {
		const headers = build({ extraHeaders: { originator: "" } });

		expect(headers.originator).toBe("narrafork");
	});
});
