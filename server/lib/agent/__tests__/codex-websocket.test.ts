import { afterEach, describe, expect, test } from "bun:test";
import {
	buildCodexResponsesWebSocketRequest,
	buildCodexResponsesWebSocketUrl,
	type CodexResponsesRequestBody,
	type CompletedResponseSnapshot,
	clearCodexResponsesWebSocketSessions,
	decidePrematureCodexReconnect,
	hasRecentNarratorMessage,
	isCodexExpected101StatusError,
	isCodexResponsesWebSocketSessionExpired,
	isCodexWebSocketConnectionLimitError,
	isCodexWebSocketIdleTimeoutError,
	parseCodexWrappedError,
	shouldTreatCodexStreamEventAsYielded,
} from "../codex-websocket";
import type { OAIMessage } from "../openai-provider";

function makeUserMessage(text: string): OAIMessage {
	return {
		role: "user",
		content: [{ type: "input_text", text }],
	};
}

function makeAssistantMessage(text: string): OAIMessage {
	return {
		role: "assistant",
		content: [{ type: "output_text", text }],
	};
}

function makeRequest(input: OAIMessage[], instructions = "base"): CodexResponsesRequestBody {
	return {
		model: "gpt-5.3-codex",
		input,
		stream: true,
		instructions,
		store: false,
		parallel_tool_calls: true,
	};
}

function makeCompleted(responseId: string, itemsAdded: unknown[]): CompletedResponseSnapshot {
	return { responseId, itemsAdded };
}

afterEach(async () => {
	await clearCodexResponsesWebSocketSessions();
});

describe("Codex Responses WebSocket helpers", () => {
	test("converts Codex base URL to /responses websocket URL", () => {
		expect(buildCodexResponsesWebSocketUrl("https://chatgpt.com/backend-api/codex")).toBe(
			"wss://chatgpt.com/backend-api/codex/responses",
		);
		expect(buildCodexResponsesWebSocketUrl("http://example.com/v1/responses")).toBe(
			"ws://example.com/v1/responses",
		);
	});

	test("reuses previous_response_id when input extends last request baseline", () => {
		const lastRequest = makeRequest([makeUserMessage("hello")]);
		const lastCompleted = makeCompleted("resp-1", [makeAssistantMessage("assistant output")]);
		const nextRequest = makeRequest([
			makeUserMessage("hello"),
			makeAssistantMessage("assistant output"),
			makeUserMessage("second"),
		]);

		const envelope = buildCodexResponsesWebSocketRequest(nextRequest, lastRequest, lastCompleted);
		expect(envelope.type).toBe("response.create");
		expect(envelope.previous_response_id).toBe("resp-1");
		expect(envelope.input).toEqual([makeUserMessage("second")]);
	});

	test("falls back to full create when non-input request fields change", () => {
		const lastRequest = makeRequest([makeUserMessage("hello")], "base one");
		const lastCompleted = makeCompleted("resp-1", []);
		const nextRequest = makeRequest(
			[makeUserMessage("hello"), makeUserMessage("second")],
			"base two",
		);

		const envelope = buildCodexResponsesWebSocketRequest(nextRequest, lastRequest, lastCompleted);
		expect(envelope.previous_response_id).toBeUndefined();
		expect(envelope.input).toEqual(nextRequest.input);
	});

	test("falls back to full create when reasoning settings change", () => {
		const lastRequest = makeRequest([makeUserMessage("hello")]);
		lastRequest.reasoning = { effort: "medium", summary: "auto" };
		const lastCompleted = makeCompleted("resp-1", [makeAssistantMessage("assistant output")]);
		const nextRequest = makeRequest([
			makeUserMessage("hello"),
			makeAssistantMessage("assistant output"),
			makeUserMessage("second"),
		]);
		nextRequest.reasoning = { effort: "high", summary: "auto" };

		const envelope = buildCodexResponsesWebSocketRequest(nextRequest, lastRequest, lastCompleted);
		expect(envelope.previous_response_id).toBeUndefined();
		expect(envelope.input).toEqual(nextRequest.input);
	});

	test("falls back to full create when input is not a baseline extension", () => {
		const lastRequest = makeRequest([makeUserMessage("hello")]);
		const lastCompleted = makeCompleted("resp-1", []);
		const nextRequest = makeRequest([makeUserMessage("different")]);

		const envelope = buildCodexResponsesWebSocketRequest(nextRequest, lastRequest, lastCompleted);
		expect(envelope.previous_response_id).toBeUndefined();
		expect(envelope.input).toEqual(nextRequest.input);
	});

	/**
	 * client_metadata must not participate in the continuation decision. It carries
	 * per-request runtime values — notably x-codex-turn-state, which only exists after
	 * the first response of a turn — so comparing it would make every request after the
	 * first look like a new one. The failure is silent: continuation degrades into full
	 * resends and the prompt cache is lost, with no error anywhere. codex-rs draws the
	 * same line in responses_request_properties_match ("ignores metadata").
	 */
	test("still continues when only client_metadata differs", () => {
		const lastRequest = makeRequest([makeUserMessage("hello")]);
		lastRequest.client_metadata = { session_id: "conv-1", thread_id: "conv-1" };
		const lastCompleted = makeCompleted("resp-1", [makeAssistantMessage("assistant output")]);
		const nextRequest = makeRequest([
			makeUserMessage("hello"),
			makeAssistantMessage("assistant output"),
			makeUserMessage("second"),
		]);
		// The turn-state token appears only on later requests of a turn.
		nextRequest.client_metadata = {
			session_id: "conv-1",
			thread_id: "conv-1",
			"x-codex-turn-state": "turn-state-token",
		};

		const envelope = buildCodexResponsesWebSocketRequest(nextRequest, lastRequest, lastCompleted);
		expect(envelope.previous_response_id).toBe("resp-1");
		expect(envelope.input).toEqual([makeUserMessage("second")]);
	});

	test("treats narrator activity within five minutes as recent", () => {
		const now = Date.parse("2026-01-01T00:10:00.000Z");
		expect(hasRecentNarratorMessage("2026-01-01T00:05:01.000Z", now)).toBe(true);
		expect(hasRecentNarratorMessage("2026-01-01T00:05:00.000Z", now)).toBe(true);
		expect(hasRecentNarratorMessage("2026-01-01T00:04:59.000Z", now)).toBe(false);
		expect(hasRecentNarratorMessage(null, now)).toBe(false);
		expect(hasRecentNarratorMessage("not-a-date", now)).toBe(false);
	});

	test("detects websocket idle timeout errors", () => {
		expect(
			isCodexWebSocketIdleTimeoutError(
				new Error("Codex WebSocket idle timeout waiting for response event"),
			),
		).toBe(true);
		expect(isCodexWebSocketIdleTimeoutError(new Error("other error"))).toBe(false);
		expect(
			isCodexWebSocketIdleTimeoutError("Codex WebSocket idle timeout waiting for response event"),
		).toBe(false);
	});

	test("detects websocket expected 101 status errors", () => {
		expect(
			isCodexExpected101StatusError(
				new Error(
					"WebSocket connection to 'wss://chatgpt.com/backend-api/codex/responses' failed: Expected 101 status code",
				),
			),
		).toBe(true);
		expect(isCodexExpected101StatusError(new Error("Unexpected server response: 403"))).toBe(false);
	});

	test("detects websocket connection lifetime limit errors", () => {
		expect(
			isCodexWebSocketConnectionLimitError({
				type: "error",
				status: 400,
				error: { code: "websocket_connection_limit_reached" },
			}),
		).toBe(true);
		expect(
			isCodexWebSocketConnectionLimitError({
				type: "error",
				status: 400,
				error: { type: "websocket_connection_limit_reached" },
			}),
		).toBe(true);
		expect(
			isCodexWebSocketConnectionLimitError({
				type: "error",
				status: 400,
				error: { code: "rate_limit_exceeded" },
			}),
		).toBe(false);
	});

	test("parses detailed websocket close reasons as wrapped errors", () => {
		const parsed = parseCodexWrappedError(
			JSON.stringify({
				type: "error",
				status: 429,
				error: {
					code: "usage_limit_reached",
					message: "Usage limit reached for this Codex account",
				},
			}),
		);

		expect(parsed?.status).toBe(429);
		expect(parsed?.error?.code).toBe("usage_limit_reached");
		expect(parsed?.error?.message).toBe("Usage limit reached for this Codex account");
	});

	test("parses embedded JSON from websocket close reasons", () => {
		const parsed = parseCodexWrappedError(
			'closed by server: {"error":{"type":"server_error","message":"upstream crashed"}}',
		);

		expect(parsed?.type).toBe("error");
		expect(parsed?.error?.type).toBe("server_error");
		expect(parsed?.error?.message).toBe("upstream crashed");
	});

	test("reconnect decision only retries before any events were yielded", () => {
		const now = Date.parse("2026-01-01T00:10:00.000Z");
		expect(decidePrematureCodexReconnect("2026-01-01T00:09:30.000Z", false, 0, now)).toEqual({
			shouldReconnect: true,
			shouldFallback: true,
		});
		expect(decidePrematureCodexReconnect("2026-01-01T00:09:30.000Z", true, 0, now)).toEqual({
			shouldReconnect: false,
			shouldFallback: false,
		});
		expect(decidePrematureCodexReconnect("2026-01-01T00:09:30.000Z", false, 1, now)).toEqual({
			shouldReconnect: false,
			shouldFallback: true,
		});
		expect(decidePrematureCodexReconnect(null, false, 0, now)).toEqual({
			shouldReconnect: false,
			shouldFallback: false,
		});
	});

	test("counts visible stream events and any tool use chunks as yielded output", () => {
		expect(shouldTreatCodexStreamEventAsYielded({ responseId: "resp_1" })).toBe(false);
		expect(shouldTreatCodexStreamEventAsYielded({ messageId: "msg_1" })).toBe(false);
		expect(shouldTreatCodexStreamEventAsYielded({ credentialId: "cred_1" })).toBe(false);
		expect(shouldTreatCodexStreamEventAsYielded({ queueStatus: { position: 1 } })).toBe(false);
		expect(shouldTreatCodexStreamEventAsYielded({ quotaBalance: "42" })).toBe(false);
		expect(
			shouldTreatCodexStreamEventAsYielded({ usage: { promptTokens: 10, completionTokens: 0 } }),
		).toBe(false);
		expect(
			shouldTreatCodexStreamEventAsYielded({ webSearch: { id: "ws_1", status: "in_progress" } }),
		).toBe(false);
		expect(
			shouldTreatCodexStreamEventAsYielded({
				webSearch: { id: "ws_1", status: "completed", final: true, query: "weather" },
			}),
		).toBe(true);
		expect(
			shouldTreatCodexStreamEventAsYielded({
				imageGeneration: { id: "img_1", status: "generating" },
			}),
		).toBe(false);
		expect(
			shouldTreatCodexStreamEventAsYielded({
				imageGeneration: {
					id: "img_1",
					status: "generating",
					partialImageIndex: 0,
					partialImageB64: "base64-preview",
				},
			}),
		).toBe(true);
		expect(
			shouldTreatCodexStreamEventAsYielded({
				imageGeneration: { id: "img_1", status: "completed", final: true, result: "base64" },
			}),
		).toBe(true);
		expect(
			shouldTreatCodexStreamEventAsYielded({
				toolUseChunk: { toolUseId: "call_1", name: "Read", input: "{}" },
			}),
		).toBe(true);
		expect(
			shouldTreatCodexStreamEventAsYielded({
				toolUseChunk: { toolUseId: "call_1", name: "Read", stop: true },
			}),
		).toBe(true);
		expect(
			shouldTreatCodexStreamEventAsYielded({
				toolUses: [{ toolUseId: "call_2", name: "Read", input: {} }],
			}),
		).toBe(true);
		expect(shouldTreatCodexStreamEventAsYielded({ text: "hello" })).toBe(true);
	});

	test("expires only idle sessions past the TTL", () => {
		const now = 1_000_000;
		expect(
			isCodexResponsesWebSocketSessionExpired({ busy: false, lastUsedAt: now - 601_000 }, now),
		).toBe(true);
		expect(
			isCodexResponsesWebSocketSessionExpired({ busy: false, lastUsedAt: now - 60_000 }, now),
		).toBe(false);
		expect(
			isCodexResponsesWebSocketSessionExpired({ busy: true, lastUsedAt: now - 999_999 }, now),
		).toBe(false);
	});
});
