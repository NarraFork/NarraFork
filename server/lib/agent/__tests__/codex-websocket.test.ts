import { afterEach, describe, expect, test } from "bun:test";
import {
	buildCodexResponsesWebSocketRequest,
	buildCodexResponsesWebSocketUrl,
	type CodexResponsesRequestBody,
	type CompletedResponseSnapshot,
	clearCodexResponsesWebSocketSessions,
	decidePrematureCodexReconnect,
	hasRecentNarratorMessage,
	isCodexResponsesWebSocketSessionExpired,
	isCodexWebSocketIdleTimeoutError,
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

	test("falls back to full create when input is not a baseline extension", () => {
		const lastRequest = makeRequest([makeUserMessage("hello")]);
		const lastCompleted = makeCompleted("resp-1", []);
		const nextRequest = makeRequest([makeUserMessage("different")]);

		const envelope = buildCodexResponsesWebSocketRequest(nextRequest, lastRequest, lastCompleted);
		expect(envelope.previous_response_id).toBeUndefined();
		expect(envelope.input).toEqual(nextRequest.input);
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

	test("only counts completed visible stream events as yielded output", () => {
		expect(shouldTreatCodexStreamEventAsYielded({ responseId: "resp_1" })).toBe(false);
		expect(shouldTreatCodexStreamEventAsYielded({ messageId: "msg_1" })).toBe(false);
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
				toolUseChunk: { toolUseId: "call_1", name: "Read", input: "{}" },
			}),
		).toBe(false);
		expect(
			shouldTreatCodexStreamEventAsYielded({
				toolUseChunk: { toolUseId: "call_1", name: "Read", stop: true },
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
