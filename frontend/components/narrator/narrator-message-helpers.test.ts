import { describe, expect, test } from "bun:test";
import { resolvePendingPerm } from "./narrator-message-helpers";
import type { PendingPermission } from "./narrator-panel-types";
import type { ToolCallData } from "./ToolCallCard";

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
	test("prefers websocket permission map over truncated tool call input", () => {
		const wsPerm: PendingPermission = {
			id: "perm-1",
			toolName: "Edit",
			toolUseId: "tool-1",
			inputJson: { file_path: "full.ts", old_string: "long old", new_string: "long new" },
		};
		const resolved = resolvePendingPerm(
			toolCall(),
			null,
			new Map<string, PendingPermission>([["tool-1", wsPerm]]),
		);

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
});
