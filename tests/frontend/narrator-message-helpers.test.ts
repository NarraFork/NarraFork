import { describe, expect, test } from "bun:test";
import {
	buildToolUseIndex,
	mergeFieldsByIndex,
} from "../../frontend/components/narrator/message-tree-utils";
import {
	hasToolUse,
	isToolOnlyMessage,
	resolveAllToolCallsFromMsg,
} from "../../frontend/components/narrator/narrator-message-helpers";
import { makeMessage } from "./narrator-timeline.fixtures";

describe("narrator-message-helpers", () => {
	test("resolveAllToolCallsFromMsg 优先读取 enriched tool_use block 字段", () => {
		const msg = makeMessage({
			id: "m-enriched",
			role: "assistant",
			contentJson: [
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
		});

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
		const msg = makeMessage({
			id: "m-completed-shell-tools",
			role: "assistant",
			contentJson: [
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
		});

		const [bashCall, awaitCall] = resolveAllToolCallsFromMsg(msg);
		expect(bashCall).toMatchObject(bashTiming);
		expect(awaitCall).toMatchObject(awaitTiming);
	});

	test("实时工具从 running 合并为 success 后仍保留 runtime startedAt", () => {
		const startedAt = Date.parse("2025-01-01T00:02:00.000Z");
		const msg = makeMessage({
			id: "m-live-tool",
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tu-live", name: "Bash", input: {} }],
			toolCalls: [
				{
					toolUseId: "tu-live",
					toolName: "Bash",
					status: "initializing",
					createdAt: "2025-01-01T00:01:59.000Z",
				},
			],
		});
		const cache = {
			pages: [{ messages: [msg], hasMore: false, nextCursor: null }],
			pageParams: [undefined],
		};
		const index = buildToolUseIndex(cache.pages);
		const running = mergeFieldsByIndex(cache, "tu-live", { status: "running", startedAt }, index);
		const completed = mergeFieldsByIndex(
			running,
			"tu-live",
			{ status: "success", completedAt: "2025-01-01T00:02:05.000Z" },
			index,
		);

		const [call] = resolveAllToolCallsFromMsg(completed.pages[0].messages[0]);
		expect(call.status).toBe("success");
		expect(call.startedAt).toBe(startedAt);
		expect(call.completedAt).toBe("2025-01-01T00:02:05.000Z");
	});

	test("completed 普通工具同样保留 timing，并从对应 toolCalls 回退", () => {
		const timing = {
			streamStartedAt: "2025-01-01T00:03:01.000Z",
			permissionStartedAt: "2025-01-01T00:03:02.000Z",
			executionStartedAt: "2025-01-01T00:03:03.000Z",
			completedAt: "2025-01-01T00:03:04.000Z",
		};
		const msg = makeMessage({
			id: "m-completed-read",
			role: "assistant",
			contentJson: [
				{
					type: "tool_use",
					id: "tu-read",
					name: "Read",
					input: { file_path: "a.txt" },
					status: "success",
				},
			],
			toolCalls: [
				{
					toolUseId: "tu-read",
					toolName: "Read",
					status: "success",
					...timing,
				},
			],
		});

		const [call] = resolveAllToolCallsFromMsg(msg);
		expect(call).toMatchObject(timing);
	});

	test("completed 工具完全无 timing 时保持 undefined，不从创建时间伪造", () => {
		const msg = makeMessage({
			id: "m-completed-no-timing",
			role: "assistant",
			contentJson: [
				{
					type: "tool_use",
					id: "tu-no-timing",
					name: "Read",
					input: { file_path: "a.txt" },
					status: "success",
					tcCreatedAt: "2025-01-01T00:04:00.000Z",
				},
			],
			toolCalls: [
				{
					toolUseId: "tu-no-timing",
					toolName: "Read",
					status: "success",
					createdAt: "2025-01-01T00:04:00.000Z",
					permissionDecidedAt: "2025-01-01T00:04:01.000Z",
				},
			],
		});

		const [call] = resolveAllToolCallsFromMsg(msg);
		expect(call.startedAt).toBeUndefined();
		expect(call.streamStartedAt).toBeUndefined();
		expect(call.permissionStartedAt).toBeUndefined();
		expect(call.executionStartedAt).toBeUndefined();
		expect(call.completedAt).toBeUndefined();
	});

	test("isToolOnlyMessage / hasToolUse 兼容 legacy 判定", () => {
		const toolOnly = makeMessage({
			id: "m-tool-only",
			role: "assistant",
			contentJson: [
				{ type: "reasoning", text: "r" },
				{ type: "text", text: "   " },
				{ type: "tool_use", id: "tu-1", name: "Read", input: {} },
			],
		});
		expect(isToolOnlyMessage(toolOnly)).toBe(true);
		expect(hasToolUse(toolOnly)).toBe(true);

		const mixed = makeMessage({
			id: "m-mixed",
			role: "assistant",
			contentJson: [
				{ type: "text", text: "hello" },
				{ type: "tool_use", id: "tu-2", name: "Read", input: {} },
			],
		});
		expect(isToolOnlyMessage(mixed)).toBe(false);
		expect(hasToolUse(mixed)).toBe(true);

		const userMsg = makeMessage({
			id: "m-user",
			role: "user",
			contentJson: [{ type: "tool_use", id: "tu-3", name: "Read", input: {} }],
		});
		expect(hasToolUse(userMsg)).toBe(false);
	});
});
