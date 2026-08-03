/**
 * The Codex Responses WebSocket handshake used to be reported to request
 * diagnostics as a hand-written stand-in (`originator: narrafork` plus a
 * hardcoded beta header), so the dump never matched what was actually sent on
 * the wire. The transport now surfaces the real handshake headers and the exact
 * `response.create` envelope through `onRequestPrepared` before connecting.
 *
 * These tests drive that callback with an already-aborted signal: the transport
 * prepares the request, reports it, and then fails fast in ensureConnection —
 * so the real header/envelope builders are exercised with no network access.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ORIGINATOR_CODEX } from "../../user-agent";
import {
	type CodexResponsesRequestBody,
	clearCodexResponsesWebSocketSessions,
	type StreamCodexResponsesWebSocketOptions,
	streamCodexResponsesWebSocket,
} from "../codex-websocket";

type Prepared = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

function makeRequest(): CodexResponsesRequestBody {
	return {
		model: "gpt-5.3-codex",
		input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
		stream: true,
		instructions: "base",
		store: false,
	};
}

/**
 * Run the transport far enough to capture the prepared request, then let the
 * aborted signal tear it down. Returns whatever onRequestPrepared observed.
 */
async function capturePrepared(
	overrides: Partial<StreamCodexResponsesWebSocketOptions> = {},
): Promise<Prepared> {
	let prepared: Prepared | undefined;
	const controller = new AbortController();
	controller.abort();

	const options: StreamCodexResponsesWebSocketOptions = {
		baseUrl: CODEX_BASE_URL,
		apiKey: "sk-test-key",
		sessionKey: "session-key",
		conversationId: "conv-1",
		credentialId: "cred-1",
		model: "gpt-5.3-codex",
		request: makeRequest(),
		signal: controller.signal,
		onRequestPrepared: (request) => {
			prepared = request as Prepared;
		},
		...overrides,
	};

	try {
		for await (const _event of streamCodexResponsesWebSocket(options)) {
			// The aborted signal ends the stream; no events are expected.
		}
	} catch {
		// ensureConnection rejects on an aborted signal — that is the point.
	}

	if (!prepared) throw new Error("onRequestPrepared was never called");
	return prepared;
}

afterEach(async () => {
	await clearCodexResponsesWebSocketSessions();
});

describe("Codex WebSocket handshake reported to diagnostics", () => {
	test("targets the /responses websocket endpoint", async () => {
		const prepared = await capturePrepared();

		expect(prepared.url).toBe("wss://chatgpt.com/backend-api/codex/responses");
	});

	test("sends the managed Codex client identity, not a narrafork originator", async () => {
		const prepared = await capturePrepared();

		expect(prepared.headers.originator).toBe(ORIGINATOR_CODEX);
		expect(prepared.headers.originator).not.toBe("narrafork");
		expect(prepared.headers["x-openai-internal-codex-responses-lite"]).toBe("true");
	});

	test("correlates session/thread/client-request ids to one conversation", async () => {
		const prepared = await capturePrepared({ conversationId: "conv-abc" });

		expect(prepared.headers["session-id"]).toBe("conv-abc");
		expect(prepared.headers["thread-id"]).toBe("conv-abc");
		expect(prepared.headers["x-client-request-id"]).toBe("conv-abc");
		// The real CLI uses hyphenated names; the legacy underscore form is gone.
		expect(prepared.headers.session_id).toBeUndefined();
	});

	test("reports the real Authorization header rather than a placeholder", async () => {
		const prepared = await capturePrepared({ authorization: "Bearer real-token" });

		expect(prepared.headers.Authorization).toBe("Bearer real-token");
	});

	test("applies the caller's fingerprint headers over transport defaults", async () => {
		const prepared = await capturePrepared({
			userAgent: "codex-tui/test (probe)",
			extraHeaders: { originator: "custom-originator", "x-codex-installation-id": "install-1" },
		});

		expect(prepared.headers["User-Agent"]).toBe("codex-tui/test (probe)");
		expect(prepared.headers.originator).toBe("custom-originator");
		expect(prepared.headers["x-codex-installation-id"]).toBe("install-1");
	});

	test("omits volatile per-turn tracking headers by default", async () => {
		const prepared = await capturePrepared();

		expect(prepared.headers["x-codex-turn-metadata"]).toBeUndefined();
		expect(prepared.headers["x-codex-turn-state"]).toBeUndefined();
	});

	test("reports the exact response.create envelope that will be sent", async () => {
		const prepared = await capturePrepared();

		// The envelope is the wire frame itself, not the bare request body.
		expect(prepared.body.type).toBe("response.create");
		expect(prepared.body.model).toBe("gpt-5.3-codex");
		expect(prepared.body.stream).toBe(true);
		// A fresh session has no previous response to chain from.
		expect(prepared.body.previous_response_id).toBeUndefined();
	});
});
