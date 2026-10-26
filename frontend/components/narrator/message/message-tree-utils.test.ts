import { describe, expect, test } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api";
import { messageBody, rowWithElements } from "@shared/narrator-blocks/message-blocks";
import {
	mergeToolCallFieldsInRows,
	replaceSubagentActivitySnapshot,
	updateSubagentActivityInMessages,
	upsertSubagentToolCallHeader,
} from "./message-tree-utils";

/** A row; a body in `overrides` is split again as this row's, as the server would. */
function message(overrides: Partial<TreeMessage> = {}): TreeMessage {
	const { blocks, ...rest } = overrides;
	return rowWithElements(
		{
			id: "msg-1",
			narratorId: "narrator-1",
			parentToolUseId: null,
			role: "assistant",
			contentText: null,
			toolCalls: [],
			tokensIn: null,
			costUsd: null,
			createdAt: "2026-05-14T00:00:00.000Z",
			...rest,
		},
		messageBody({ blocks }),
	);
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
		const parent = message(
			rowWithElements(
				{
					toolCalls: [{ toolUseId: "parent-tool", toolName: "Agent" }],
				},
				[{ type: "tool_use", id: "parent-tool", name: "Agent" }],
			),
		);
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
		expect(messageBody(result.messages[0])[0]._subagentActivity).toEqual(snapshot);
		expect(result.messages[0].toolCalls[0]).toMatchObject({ _subagentActivity: snapshot });
	});
});

describe("message-tree-utils tool state parity", () => {
	test("mergeToolCallFieldsInRows syncs permission fields into enriched content blocks", () => {
		const messages = [
			message(
				rowWithElements(
					{
						toolCalls: [
							{
								toolUseId: "tool-1",
								toolName: "Edit",
								status: "permission_pending",
							},
						],
					},
					[
						{ type: "text", text: "before" },
						{
							type: "tool_use",
							id: "tool-1",
							name: "Edit",
							status: "permission_pending",
						},
					],
				),
			),
		];

		const result = mergeToolCallFieldsInRows(messages, "tool-1", {
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
		expect(messageBody(result.messages[0])[1]).toMatchObject({
			type: "tool_use",
			id: "tool-1",
			status: "denied",
			permissionDenyMessage: "Needs a smaller diff",
			permissionDecisionReason: "user_feedback",
		});
	});
});
