import { describe, expect, test } from "bun:test";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import {
	hasToolUse,
	isToolOnlyMessage,
	resolveAllToolCallsFromMsg,
} from "../../frontend/components/narrator/narrator-message-helpers";
import { makeMessage } from "./narrator-timeline.fixtures";

describe("narrator-message-helpers", () => {
	test("resolveAllToolCallsFromMsg 优先读取 enriched tool_use block 字段", () => {
		const msg = makeMessage(
			rowWithElements(
				{
					id: "m-enriched",
					role: "assistant",
					toolCalls: [
						{
							id: "tc-from-row",
							toolUseId: "tu-enriched",
							toolName: "Read",
							inputJson: { file_path: "row.txt" },
							status: "success",
							createdAt: "2025-01-01T00:00:00.000Z",
						},
					],
				},
				[
					{
						type: "tool_use",
						id: "tu-enriched",
						name: "Read",
						input: { file_path: "a.txt" },
						inputJson: { file_path: "b.txt" },
						status: "fail",
						errorMessage: "boom",
						tcId: "tc-from-block",
						durationMs: 42,
					},
				],
			),
		);

		const calls = resolveAllToolCallsFromMsg(msg);
		expect(calls).toHaveLength(1);
		expect(calls[0].id).toBe("tc-from-block");
		expect(calls[0].status).toBe("fail");
		expect(calls[0].inputJson).toEqual({ file_path: "b.txt" });
		expect(calls[0].errorMessage).toBe("boom");
		expect(calls[0].durationMs).toBe(42);
	});

	test("历史 completed Bash/Await 保留 enriched block 的全部 timing", () => {
		const bashTiming = {
			streamStartedAt: "2025-01-01T00:00:01.000Z",
			permissionStartedAt: "2025-01-01T00:00:02.000Z",
			executionStartedAt: "2025-01-01T00:00:03.000Z",
			completedAt: "2025-01-01T00:00:04.000Z",
		};
		const awaitTiming = {
			streamStartedAt: "2025-01-01T00:01:01.000Z",
			permissionStartedAt: "2025-01-01T00:01:02.000Z",
			executionStartedAt: "2025-01-01T00:01:03.000Z",
			completedAt: "2025-01-01T00:01:04.000Z",
		};
		const msg = makeMessage(
			rowWithElements(
				{
					id: "m-completed-shell-tools",
					role: "assistant",
					toolCalls: [
						{
							toolUseId: "tu-bash",
							toolName: "Bash",
							status: "success",
							streamStartedAt: "row-should-not-win",
							permissionStartedAt: "row-should-not-win",
							executionStartedAt: "row-should-not-win",
							completedAt: "row-should-not-win",
						},
						{
							toolUseId: "tu-await",
							toolName: "Await",
							status: "success",
							streamStartedAt: "row-should-not-win",
							permissionStartedAt: "row-should-not-win",
							executionStartedAt: "row-should-not-win",
							completedAt: "row-should-not-win",
						},
					],
				},
				[
					{
						type: "tool_use",
						id: "tu-bash",
						name: "Bash",
						input: { command: "pwd" },
						status: "success",
						...bashTiming,
					},
					{
						type: "tool_use",
						id: "tu-await",
						name: "Await",
						input: { id: "task-1" },
						status: "success",
						...awaitTiming,
					},
				],
			),
		);

		const [bashCall, awaitCall] = resolveAllToolCallsFromMsg(msg);
		expect(bashCall).toMatchObject(bashTiming);
		expect(awaitCall).toMatchObject(awaitTiming);
	});

	test("completed 普通工具同样保留 timing，并从对应 toolCalls 回退", () => {
		const timing = {
			streamStartedAt: "2025-01-01T00:03:01.000Z",
			permissionStartedAt: "2025-01-01T00:03:02.000Z",
			executionStartedAt: "2025-01-01T00:03:03.000Z",
			completedAt: "2025-01-01T00:03:04.000Z",
		};
		const msg = makeMessage(
			rowWithElements(
				{
					id: "m-completed-read",
					role: "assistant",
					toolCalls: [
						{
							toolUseId: "tu-read",
							toolName: "Read",
							status: "success",
							...timing,
						},
					],
				},
				[
					{
						type: "tool_use",
						id: "tu-read",
						name: "Read",
						input: { file_path: "a.txt" },
						status: "success",
					},
				],
			),
		);

		const [call] = resolveAllToolCallsFromMsg(msg);
		expect(call).toMatchObject(timing);
	});

	test("completed 工具完全无 timing 时保持 undefined，不从创建时间伪造", () => {
		const msg = makeMessage(
			rowWithElements(
				{
					id: "m-completed-no-timing",
					role: "assistant",
					toolCalls: [
						{
							toolUseId: "tu-no-timing",
							toolName: "Read",
							status: "success",
							createdAt: "2025-01-01T00:04:00.000Z",
							permissionDecidedAt: "2025-01-01T00:04:01.000Z",
						},
					],
				},
				[
					{
						type: "tool_use",
						id: "tu-no-timing",
						name: "Read",
						input: { file_path: "a.txt" },
						status: "success",
						tcCreatedAt: "2025-01-01T00:04:00.000Z",
					},
				],
			),
		);

		const [call] = resolveAllToolCallsFromMsg(msg);
		expect(call.startedAt).toBeUndefined();
		expect(call.streamStartedAt).toBeUndefined();
		expect(call.permissionStartedAt).toBeUndefined();
		expect(call.executionStartedAt).toBeUndefined();
		expect(call.completedAt).toBeUndefined();
	});

	test("isToolOnlyMessage / hasToolUse 兼容 legacy 判定", () => {
		const toolOnly = makeMessage(
			rowWithElements(
				{
					id: "m-tool-only",
					role: "assistant",
				},
				[
					{ type: "reasoning", text: "r" },
					{ type: "text", text: "   " },
					{ type: "tool_use", id: "tu-1", name: "Read", input: {} },
				],
			),
		);
		expect(isToolOnlyMessage(toolOnly)).toBe(true);
		expect(hasToolUse(toolOnly)).toBe(true);

		const mixed = makeMessage(
			rowWithElements(
				{
					id: "m-mixed",
					role: "assistant",
				},
				[
					{ type: "text", text: "hello" },
					{ type: "tool_use", id: "tu-2", name: "Read", input: {} },
				],
			),
		);
		expect(isToolOnlyMessage(mixed)).toBe(false);
		expect(hasToolUse(mixed)).toBe(true);

		const userMsg = makeMessage(
			rowWithElements(
				{
					id: "m-user",
					role: "user",
				},
				[{ type: "tool_use", id: "tu-3", name: "Read", input: {} }],
			),
		);
		expect(hasToolUse(userMsg)).toBe(false);
	});
});
