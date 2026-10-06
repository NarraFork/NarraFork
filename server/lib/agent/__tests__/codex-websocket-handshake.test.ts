/**
 * Handshake headers for the Codex Responses WebSocket.
 *
 * These are worth pinning because a wrong header or a wrong conditional does not
 * surface as a visible error: the upstream refuses the upgrade and the transport
 * silently falls back to HTTP, so the only symptom is "WS never works" with no
 * useful log.
 *
 * Both callers present the managed Codex client identity: openai-provider's codex
 * channel supplies a fingerprint through `extraHeaders`, and the built-in Codex
 * adapter supplies none and relies on the defaults built here. So the default path
 * and the override path both need coverage.
 *
 * See docs/codex-websocket.md for the documented contract.
 */
import { describe, expect, test } from "bun:test";
import { getHttpCodexUserAgent, ORIGINATOR_CODEX } from "../../user-agent";
import { deriveCodexWindowId } from "../codex-request";
import {
	applyTurnStateToRequest,
	buildHandshakeHeaders,
	type CodexResponsesRequestBody,
	type StreamCodexResponsesWebSocketOptions,
} from "../codex-websocket";

const OFFICIAL_BASE_URL = "https://chatgpt.com/backend-api/codex";
const RELAY_BASE_URL = "https://relay.example.com/codex";
const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";

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
		conversationId: "conv-default",
		credentialId: "cred-1",
		model: "gpt-5.3-codex",
		request: makeRequest(),
		signal: new AbortController().signal,
		...overrides,
	};
}

function build(
	overrides: Partial<StreamCodexResponsesWebSocketOptions> = {},
): Record<string, string> {
	return buildHandshakeHeaders(makeOptions(overrides));
}

describe("codex WebSocket handshake headers", () => {
	test("sends the managed Codex client identity, not a narrafork originator", () => {
		const headers = build();

		expect(headers.Authorization).toBe("Bearer sk-test-key");
		expect(headers["User-Agent"]).toBe(getHttpCodexUserAgent());
		expect(headers.originator).toBe(ORIGINATOR_CODEX);
		expect(headers.originator).not.toBe("narrafork");
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

	/**
	 * The WS transport sends the same non-lite body as HTTP, so it must not claim
	 * the lite contract. Upstream rejects the header outright whenever `tools`
	 * carries a hosted tool, which is exactly what NarraFork sends.
	 */
	test("does not claim the responses-lite contract", () => {
		expect(build()[RESPONSES_LITE_HEADER]).toBeUndefined();
	});

	test("strips a responses-lite header pushed in through caller fingerprint headers", () => {
		const headers = build({
			extraHeaders: { "X-OpenAI-Internal-Codex-Responses-Lite": "true" },
		});

		for (const key of Object.keys(headers)) {
			expect(key.toLowerCase()).not.toBe(RESPONSES_LITE_HEADER);
		}
	});

	test("correlates session/thread/client-request ids to one conversation", () => {
		const headers = build({ conversationId: "conv-abc" });

		expect(headers["session-id"]).toBe("conv-abc");
		expect(headers["thread-id"]).toBe("conv-abc");
		expect(headers["x-client-request-id"]).toBe("conv-abc");
	});

	test("carries the conversation-stable window id, mirroring codex-rs", () => {
		const headers = build({ conversationId: "conv-abc" });

		// codex-rs build_websocket_headers inserts x-codex-window-id directly; the
		// value is a conversation-derived UUID, stable across the whole session.
		expect(headers["x-codex-window-id"]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(headers["x-codex-window-id"]).toBe(deriveCodexWindowId("conv-abc"));
		expect(build({ conversationId: "conv-abc" })["x-codex-window-id"]).toBe(
			headers["x-codex-window-id"],
		);
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

	/**
	 * The handshake structurally cannot carry the turn-state token: it is learned from
	 * the first response of a turn, long after this connection's upgrade was sent, and
	 * the connection is then reused for the rest of the turn. codex-rs's
	 * build_websocket_headers passes `/*turn_state*​/ None` for the same reason and
	 * routes the token through the websocket client_metadata instead.
	 */
	test("never carries the turn-state token on the handshake", () => {
		expect(build()["x-codex-turn-state"]).toBeUndefined();
	});

	test("omits volatile per-turn tracking headers by default", () => {
		expect(build()["x-codex-turn-metadata"]).toBeUndefined();
		expect(build()["x-codex-beta-features"]).toBeUndefined();
	});

	test("x-codex-turn-metadata is only sent when the caller supplies it", () => {
		expect(build({ turnMetadata: "meta" })["x-codex-turn-metadata"]).toBe("meta");
	});

	test("userAgent overrides the default UA", () => {
		const headers = build({ userAgent: "codex-tui/test (probe)" });

		expect(headers["User-Agent"]).toBe("codex-tui/test (probe)");
	});

	test("extraHeaders win over the built-in defaults, including originator", () => {
		const headers = build({
			extraHeaders: {
				originator: "custom-originator",
				"x-codex-installation-id": "install-1",
				"session-id": "sess-1",
				"thread-id": "thread-1",
			},
		});

		expect(headers.originator).toBe("custom-originator");
		expect(headers["x-codex-installation-id"]).toBe("install-1");
		expect(headers["session-id"]).toBe("sess-1");
		expect(headers["thread-id"]).toBe("thread-1");
	});

	test("empty extraHeader values do not clobber a built-in default", () => {
		const headers = build({ extraHeaders: { originator: "" } });

		expect(headers.originator).toBe(ORIGINATOR_CODEX);
	});
});

/**
 * The other half of the turn-state contract: the token the handshake cannot carry
 * has to reach the wire through the request body, or sticky routing silently never
 * happens (the symptom is invisible — requests just scatter across backends).
 */
describe("applyTurnStateToRequest", () => {
	test("adds the token to client_metadata, preserving existing keys", () => {
		const request: Record<string, unknown> = {
			type: "response.create",
			client_metadata: { session_id: "conv-1", thread_id: "conv-1" },
		};

		applyTurnStateToRequest(request, "turn-state-token");

		expect(request.client_metadata).toEqual({
			session_id: "conv-1",
			thread_id: "conv-1",
			"x-codex-turn-state": "turn-state-token",
		});
	});

	test("creates client_metadata when the request has none", () => {
		const request: Record<string, unknown> = { type: "response.create" };

		applyTurnStateToRequest(request, "turn-state-token");

		expect(request.client_metadata).toEqual({ "x-codex-turn-state": "turn-state-token" });
	});

	test("is a no-op before the turn has produced a token", () => {
		const request: Record<string, unknown> = {
			type: "response.create",
			client_metadata: { session_id: "conv-1" },
		};

		applyTurnStateToRequest(request, null);

		expect(request.client_metadata).toEqual({ session_id: "conv-1" });
	});

	test("overwrites a stale token rather than appending", () => {
		const request: Record<string, unknown> = {
			type: "response.create",
			client_metadata: { "x-codex-turn-state": "old" },
		};

		applyTurnStateToRequest(request, "new");

		expect(request.client_metadata).toEqual({ "x-codex-turn-state": "new" });
	});
});
