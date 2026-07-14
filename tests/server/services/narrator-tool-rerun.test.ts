import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it, mock } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as relations from "../../../server/db/relations";
import * as schema from "../../../server/db/schema";

// narrator-session.ts touches the db module at import time via its dependency
// graph, so provide an in-memory stub before importing (mirrors the interrupt
// finalization test). The function under test is pure and does not hit the DB.
const sqlite = new Database(":memory:");
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../../server/db")) };
mock.module("../../../server/db", () => ({ db, sqlite }));

const { evaluateRerunnableToolCall } = await import("../../../server/services/narrator-session");

afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
	mock.restore();
});

type ToolCallArg = Parameters<typeof evaluateRerunnableToolCall>[0];

function toolCall(overrides: Partial<NonNullable<ToolCallArg>> = {}): NonNullable<ToolCallArg> {
	return {
		toolName: "Bash",
		status: "fail",
		permissionDecidedBy: "user",
		messageId: "m-latest",
		...overrides,
	};
}

describe("evaluateRerunnableToolCall", () => {
	it("允许重跑：最新轮次中被用户拒绝的工具", () => {
		expect(evaluateRerunnableToolCall(toolCall(), "m-latest")).toBeNull();
	});

	it("允许重跑：中断时权限挂起被取消（aborted）的工具", () => {
		expect(
			evaluateRerunnableToolCall(toolCall({ permissionDecidedBy: "aborted" }), "m-latest"),
		).toBeNull();
	});

	it("拒绝：工具调用不存在", () => {
		expect(evaluateRerunnableToolCall(null, "m-latest")).toBe("not_found");
	});

	it("拒绝：控制类工具（ExitPlanMode/AskUserQuestion 等）不可重跑", () => {
		expect(evaluateRerunnableToolCall(toolCall({ toolName: "ExitPlanMode" }), "m-latest")).toBe(
			"not_rerunnable_tool",
		);
		expect(evaluateRerunnableToolCall(toolCall({ toolName: "AskUserQuestion" }), "m-latest")).toBe(
			"not_rerunnable_tool",
		);
	});

	it("拒绝：成功完成的工具不是被拒绝状态", () => {
		expect(evaluateRerunnableToolCall(toolCall({ status: "success" }), "m-latest")).toBe(
			"not_denied",
		);
	});

	it("拒绝：执行中被中断的工具（permissionDecidedBy 为空）不可重跑", () => {
		expect(evaluateRerunnableToolCall(toolCall({ permissionDecidedBy: null }), "m-latest")).toBe(
			"not_denied",
		);
	});

	it("拒绝：自动拒绝（黑名单/auto）的工具不可重跑", () => {
		expect(evaluateRerunnableToolCall(toolCall({ permissionDecidedBy: "auto" }), "m-latest")).toBe(
			"not_denied",
		);
	});

	it("拒绝：不属于最新 assistant 轮次的工具", () => {
		expect(evaluateRerunnableToolCall(toolCall({ messageId: "m-old" }), "m-latest")).toBe(
			"not_latest_turn",
		);
	});

	it("拒绝：没有最新 assistant 消息时不可重跑", () => {
		expect(evaluateRerunnableToolCall(toolCall(), null)).toBe("not_latest_turn");
	});
});
