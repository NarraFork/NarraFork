import { describe, expect, test } from "bun:test";
import { resolveAllToolCallsFromMsg } from "./message-segments";
import type { NarratorMsg } from "./narrator-panel-types";

function assistantMessage(overrides: Partial<NarratorMsg> = {}): NarratorMsg {
	return {
		id: "msg-1",
		narratorId: "narrator-1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [],
		contentText: null,
		toolCalls: [],
		tokensIn: null,
		costUsd: null,
		createdAt: "2026-05-14T00:00:00.000Z",
		children: [],
		...overrides,
	};
}

describe("message-segments tool call resolution", () => {
	test("prefers enriched contentJson fields over stale toolCalls rows", () => {
		const msg = assistantMessage({
			contentJson: [
				{
					type: "tool_use",
					id: "tool-1",
					name: "Edit",
					status: "denied",
					inputJson: { file_path: "new.ts" },
					outputJson: { message: "blocked" },
					permissionDenyMessage: "Please narrow the edit",
					permissionDecisionReason: "user_feedback",
				},
			],
			toolCalls: [
				{
					id: "tc-legacy",
					toolUseId: "tool-1",
					toolName: "Edit",
					status: "success",
					inputJson: { file_path: "old.ts" },
					outputJson: { message: "stale" },
				},
			],
		});

		const calls = resolveAllToolCallsFromMsg(msg);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			toolUseId: "tool-1",
			toolName: "Edit",
			status: "denied",
			inputJson: { file_path: "new.ts" },
			outputJson: { message: "blocked" },
			permissionDenyMessage: "Please narrow the edit",
			permissionDecisionReason: "user_feedback",
		});
	});

	test("falls back to toolCalls rows for non-enriched legacy tool_use blocks", () => {
		const msg = assistantMessage({
			contentJson: [{ type: "tool_use", id: "tool-legacy", name: "Bash", input: {} }],
			toolCalls: [
				{
					id: "tc-legacy",
					toolUseId: "tool-legacy",
					toolName: "Bash",
					status: "success",
					inputJson: { command: "pwd" },
					outputJson: { stdout: "/tmp" },
					durationMs: 42,
				},
			],
		});

		const calls = resolveAllToolCallsFromMsg(msg);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			id: "tc-legacy",
			toolUseId: "tool-legacy",
			toolName: "Bash",
			status: "success",
			inputJson: { command: "pwd" },
			outputJson: { stdout: "/tmp" },
			durationMs: 42,
		});
	});
});
