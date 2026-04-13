import { afterEach, describe, expect, test } from "bun:test";
import {
	buildCodexResponsesWebSocketRequest,
	buildCodexResponsesWebSocketUrl,
	type CodexResponsesRequestBody,
	type CompletedResponseSnapshot,
	clearCodexResponsesWebSocketSessions,
	isCodexResponsesWebSocketSessionExpired,
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
