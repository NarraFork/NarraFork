import { describe, expect, test } from "bun:test";
import {
	findLatestSpecTasksToolUseId,
	getReflectionSuggestion,
	normalizeReflectionAfterToolStatus,
	resolvePendingPerm,
} from "./narrator-message-helpers";
import type { NarratorMsg, PendingPermission } from "./narrator-panel-types";
import type { ToolCallData } from "./ToolCallCard";

function msg(overrides: Partial<NarratorMsg> = {}): NarratorMsg {
	return {
		id: "m1",
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [],
		contentText: null,
		toolCalls: [],
		children: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	} as NarratorMsg;
}

function toolCall(overrides: Partial<ToolCallData> = {}): ToolCallData {
	return {
		id: "tc-1",
		toolName: "Edit",
		toolUseId: "tool-1",
		inputJson: { file_path: "truncated.ts" },
		status: "pending",
		...overrides,
	};
}

describe("resolvePendingPerm", () => {
	test("prefers websocket permission list over truncated tool call input", () => {
		const wsPerm: PendingPermission = {
			id: "perm-1",
			toolName: "Edit",
			toolUseId: "tool-1",
			inputJson: { file_path: "full.ts", old_string: "long old", new_string: "long new" },
		};
		const resolved = resolvePendingPerm(toolCall(), null, [wsPerm]);

		expect(resolved).toBe(wsPerm);
		expect(resolved?.inputJson).toEqual({
			file_path: "full.ts",
			old_string: "long old",
			new_string: "long new",
		});
	});

	test("falls back to pending tool call rows when websocket permission is not available", () => {
		const resolved = resolvePendingPerm(
			toolCall({
				id: "tc-fallback",
				permissionDecisionReason: "dangerous_command",
				permissionSuggestions: [{ type: "danger_reflection", status: "awaiting_user" }],
			}),
			null,
		);

		expect(resolved).toMatchObject({
			id: "tc-fallback",
			toolName: "Edit",
			toolUseId: "tool-1",
			inputJson: { file_path: "truncated.ts" },
			decisionReason: "dangerous_command",
		});
	});

	test("does not resurrect resolved reflection permissions from historical tool calls", () => {
		const resolved = resolvePendingPerm(
			toolCall({
				permissionSuggestions: [{ type: "danger_reflection", status: "confirmed" }],
			}),
			null,
		);

		expect(resolved).toBeNull();
	});

	test("recognizes task reflection suggestions without making resolved ones actionable", () => {
		expect(
			getReflectionSuggestion([
				{
					type: "task_reflection",
					status: "running",
					requestId: "task-reflection-1",
					reason: "Checking protected task change",
					nextSteps: "Gather concrete evidence.",
				},
			]),
		).toMatchObject({
			kind: "task_reflection",
			status: "running",
			requestId: "task-reflection-1",
			nextSteps: "Gather concrete evidence.",
		});

		const resolved = resolvePendingPerm(
			toolCall({
				permissionSuggestions: [{ type: "task_reflection", status: "confirmed" }],
			}),
			null,
		);

		expect(resolved).toBeNull();
	});
});

describe("normalizeReflectionAfterToolStatus", () => {
	const runningReflection = {
		kind: "danger_reflection" as const,
		status: "running" as const,
		requestId: "danger-1",
		reason: "Checking a dangerous command",
	};

	test("keeps an approved reflection active while the tool is running", () => {
		expect(normalizeReflectionAfterToolStatus(runningReflection, "running", false)).toBe(
			runningReflection,
		);
	});

	test("only infers aborted when the tool reaches a failed terminal state", () => {
		expect(normalizeReflectionAfterToolStatus(runningReflection, "fail", false)).toMatchObject({
			status: "aborted",
			requestId: "danger-1",
		});
	});

	test("does not infer aborted while a permission is still pending", () => {
		expect(normalizeReflectionAfterToolStatus(runningReflection, "fail", true)).toBe(
			runningReflection,
		);
	});
});

describe("findLatestSpecTasksToolUseId", () => {
	const tasksBlock = (id: string) => ({
		type: "tool_use" as const,
		id,
		name: "Write",
		input: { file_path: "spec://tasks.json", content: "{}" },
	});

	test("returns the last spec tasks tool-use id from contentJson", () => {
		const messages = [
			msg({ id: "m1", contentJson: [tasksBlock("t1")] as never }),
			msg({ id: "m2", contentJson: [tasksBlock("t2")] as never }),
		];
		expect(findLatestSpecTasksToolUseId(messages)).toBe("t2");
	});

	test("ignores non-tasks file operations", () => {
		const messages = [
			msg({
				contentJson: [
					{
						type: "tool_use",
						id: "other",
						name: "Write",
						input: { file_path: "src/index.ts", content: "x" },
					},
				] as never,
			}),
		];
		expect(findLatestSpecTasksToolUseId(messages)).toBeNull();
	});

	test("reads spec tasks ops from toolCalls records too", () => {
		const messages = [
			msg({
				toolCalls: [
					{
						toolUseId: "tc-tasks",
						toolName: "Read",
						inputJson: { file_path: "spec://tasks.json" },
					},
				] as never,
			}),
		];
		expect(findLatestSpecTasksToolUseId(messages)).toBe("tc-tasks");
	});

	test("returns null when there are no spec tasks ops", () => {
		expect(findLatestSpecTasksToolUseId([msg(), msg()])).toBeNull();
		expect(findLatestSpecTasksToolUseId([])).toBeNull();
	});
});
