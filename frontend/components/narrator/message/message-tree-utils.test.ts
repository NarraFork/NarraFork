import { describe, expect, test } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api";
import {
	getDangerReflectionRequestIdInTree,
	getNewestReflectionToolOccurrenceInTree,
	insertChildIntoMessages,
	mergeFieldsIntoNewestToolOccurrenceInTree,
	mergeToolCallFieldsInTree,
	removeStreamingChildInMessages,
	replaceSubagentActivitySnapshot,
	updateSubagentActivityInMessages,
	updateToolCallInTree,
	upsertStreamingChildInMessages,
	upsertSubagentToolCallHeader,
} from "./message-tree-utils";

function message(overrides: Partial<TreeMessage> = {}): TreeMessage {
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

describe("subagent activity reducers", () => {
	test("deduplicates by stable id, falls back to toolUseId, and keeps latest three", () => {
		let activity = upsertSubagentToolCallHeader(undefined, {
			toolCallId: null,
			toolUseId: "tool-1",
			toolName: "Read",
			status: "running",
			createdAt: 1,
			timing: null,
		});
		activity = upsertSubagentToolCallHeader(activity, {
			toolCallId: "call-1",
			toolUseId: "tool-1",
			toolName: "Read",
			status: "success",
			createdAt: 1,
			timing: { completedAt: 2 },
		});
		for (let index = 2; index <= 4; index++) {
			activity = upsertSubagentToolCallHeader(activity, {
				toolCallId: `call-${index}`,
				toolUseId: `tool-${index}`,
				toolName: "Bash",
				status: "running",
				createdAt: index,
				timing: null,
			});
		}
		expect(activity.latestToolCalls.map((header) => header.toolUseId)).toEqual([
			"tool-2",
			"tool-3",
			"tool-4",
		]);
	});

	test("does not regress a terminal header to running", () => {
		const completed = upsertSubagentToolCallHeader(undefined, {
			toolCallId: "call-1",
			toolUseId: "tool-1",
			toolName: "Edit",
			status: "success",
			createdAt: 1,
			timing: { completedAt: 2 },
		});
		const regressed = upsertSubagentToolCallHeader(completed, {
			toolCallId: "call-1",
			toolUseId: "tool-1",
			toolName: "Edit",
			status: "running",
			createdAt: 1,
			timing: { startedAt: 1 },
		});
		expect(regressed.latestToolCalls[0].status).toBe("success");
		expect(regressed.latestToolCalls[0].timing?.completedAt).toBe(2);
	});

	test("does not let an empty snapshot erase known model or reasoning metadata", () => {
		const replaced = replaceSubagentActivitySnapshot(
			{
				subagentNarratorId: "sub-1",
				model: "   ",
				reasoningEffort: " ",
				latestToolCalls: [],
			},
			{
				subagentNarratorId: "sub-1",
				model: "known-model",
				reasoningEffort: "high",
				latestToolCalls: [],
			},
		);

		expect(replaced.model).toBe("known-model");
		expect(replaced.reasoningEffort).toBe("high");
	});

	test("replaces snapshots and updates the matching parent tool block", () => {
		const parent = message({
			contentJson: [{ type: "tool_use", id: "parent-tool", name: "Agent" }],
			toolCalls: [{ toolUseId: "parent-tool", toolName: "Agent" }],
		});
		const snapshot = replaceSubagentActivitySnapshot({
			subagentNarratorId: "sub-1",
			model: "model-1",
			latestToolCalls: [
				{
					toolCallId: "call-1",
					toolUseId: "child-tool",
					toolName: "Read",
					status: "success",
					createdAt: 1,
					timing: null,
				},
			],
		});
		const result = updateSubagentActivityInMessages([parent], "parent-tool", () => snapshot);
		expect(result.changed).toBe(true);
		expect(result.messages[0].contentJson[0]._subagentActivity).toEqual(snapshot);
		expect(result.messages[0].toolCalls[0]).toMatchObject({ _subagentActivity: snapshot });
	});
});

describe("message-tree-utils tool state parity", () => {
	test("mergeToolCallFieldsInTree syncs permission fields into enriched content blocks", () => {
		const messages = [
			message({
				contentJson: [
					{ type: "text", text: "before" },
					{
						type: "tool_use",
						id: "tool-1",
						name: "Edit",
						status: "permission_pending",
					},
				],
				toolCalls: [
					{
						toolUseId: "tool-1",
						toolName: "Edit",
						status: "permission_pending",
					},
				],
			}),
		];

		const result = mergeToolCallFieldsInTree(messages, "tool-1", {
			status: "denied",
			permissionDenyMessage: "Needs a smaller diff",
			permissionDecisionReason: "user_feedback",
		});

		expect(result.changed).toBe(true);
		expect(result.messages[0].toolCalls[0]).toMatchObject({
			status: "denied",
			permissionDenyMessage: "Needs a smaller diff",
			permissionDecisionReason: "user_feedback",
		});
		expect(result.messages[0].contentJson[1]).toMatchObject({
			type: "tool_use",
			id: "tool-1",
			status: "denied",
			permissionDenyMessage: "Needs a smaller diff",
			permissionDecisionReason: "user_feedback",
		});
	});

	test("updateToolCallInTree syncs completion output and duration into nested tool blocks", () => {
		const messages = [
			message({
				id: "parent",
				children: [
					message({
						id: "child",
						contentJson: [
							{
								type: "tool_use",
								id: "tool-nested",
								name: "Bash",
								status: "running",
							},
						],
						toolCalls: [
							{
								toolUseId: "tool-nested",
								toolName: "Bash",
								status: "running",
							},
						],
					}),
				],
			}),
		];
		const output = { stdout: "ok" };

		const result = updateToolCallInTree(messages, "tool-nested", "success", output, 123);

		expect(result.changed).toBe(true);
		const child = result.messages[0].children[0];
		expect(child.toolCalls[0]).toMatchObject({
			status: "success",
			outputJson: output,
			durationMs: 123,
		});
		expect(child.contentJson[0]).toMatchObject({
			type: "tool_use",
			id: "tool-nested",
			status: "success",
			outputJson: output,
			durationMs: 123,
		});
	});

	test("contentJson-only parent accepts and removes persisted child messages", () => {
		const parent = message({
			contentJson: [{ type: "tool_use", id: "parent-tool", name: "Agent", input: {} }],
		});
		const child = message({ id: "child", parentToolUseId: "parent-tool" });

		const inserted = insertChildIntoMessages([parent], child);
		expect(inserted.changed).toBe(true);
		expect(inserted.messages[0].children.map((entry) => entry.id)).toEqual(["child"]);
	});

	test("contentJson-only parent accepts and removes synthetic streaming children", () => {
		const parent = message({
			contentJson: [{ type: "tool_use", id: "parent-tool", name: "Agent", input: {} }],
		});
		const inserted = upsertStreamingChildInMessages(
			[parent],
			"parent-tool",
			"synthetic-child",
			"narrator-1",
			"child-tool",
			"Bash",
			12,
		);
		expect(inserted.changed).toBe(true);
		expect(inserted.messages[0].children).toHaveLength(1);

		const removed = removeStreamingChildInMessages(
			inserted.messages,
			"parent-tool",
			"synthetic-child",
		);
		expect(removed.changed).toBe(true);
		expect(removed.messages[0].children).toHaveLength(0);
	});

	test("reads the current danger reflection request for a reused toolUseId", () => {
		const messages = [
			message({
				toolCalls: [
					{
						toolUseId: "reused-tool-id",
						toolName: "Bash",
						permissionSuggestions: [
							{ type: "danger_reflection", status: "running", requestId: "old-request" },
							{ type: "danger_reflection", status: "running", requestId: "new-request" },
						],
					},
				],
			}),
		];

		expect(getDangerReflectionRequestIdInTree(messages, "reused-tool-id")).toBe("new-request");
	});

	test("prefers newer top-level and nested reflection requests", () => {
		const messages = [
			message({
				id: "old",
				toolCalls: [
					{
						toolUseId: "reused-tool-id",
						toolName: "Bash",
						permissionSuggestions: [{ type: "danger_reflection", requestId: "old-top-level" }],
					},
				],
			}),
			message({
				id: "new",
				children: [
					message({
						id: "nested-new",
						toolCalls: [
							{
								toolUseId: "reused-tool-id",
								toolName: "Bash",
								permissionSuggestions: [
									{ type: "danger_reflection", requestId: "nested-new-request" },
								],
							},
						],
					}),
				],
			}),
		];

		expect(getDangerReflectionRequestIdInTree(messages, "reused-tool-id")).toBe(
			"nested-new-request",
		);
	});

	test("does not fall back to an older reflection when the newest tool has no suggestion", () => {
		const messages = [
			message({
				id: "old",
				toolCalls: [
					{
						toolUseId: "reused-tool-id",
						toolName: "Bash",
						permissionSuggestions: [{ type: "danger_reflection", requestId: "old-request" }],
					},
				],
			}),
			message({
				id: "new",
				toolCalls: [{ toolUseId: "reused-tool-id", toolName: "Bash" }],
			}),
		];

		expect(getDangerReflectionRequestIdInTree(messages, "reused-tool-id")).toBeUndefined();
		expect(
			getNewestReflectionToolOccurrenceInTree(messages, "reused-tool-id", "danger_reflection"),
		).toEqual({ found: true });

		const merged = mergeFieldsIntoNewestToolOccurrenceInTree(messages, "reused-tool-id", {
			permissionSuggestions: [
				{ type: "danger_reflection", status: "running", requestId: "new-request" },
			],
		});
		expect(merged.changed).toBe(true);
		expect(merged.messages[0].toolCalls?.[0]?.permissionSuggestions?.[0]).toMatchObject({
			requestId: "old-request",
		});
		expect(merged.messages[1].toolCalls?.[0]?.permissionSuggestions?.[0]).toMatchObject({
			requestId: "new-request",
		});
	});
});
