import { describe, expect, test } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api";
import { mergeToolCallFieldsInTree, updateToolCallInTree } from "./message-tree-utils";

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
});
