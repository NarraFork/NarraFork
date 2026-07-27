import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it, mock } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as relations from "../../../server/db/relations";
import * as schema from "../../../server/db/schema";

// narrator-session.ts touches the db module at import time via its dependency
// graph, so provide an in-memory stub before importing (mirrors narrator-tool-rerun).
// The function under test is pure and does not hit the DB.
const sqlite = new Database(":memory:");
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../../server/db")) };
mock.module("../../../server/db", () => ({ db, sqlite }));

const { resolveRetryTarget } = await import("../../../server/services/narrator-session");

afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
	mock.restore();
});

interface Msg {
	id: string;
	role: string;
	contentJson?: unknown;
	toolCalls?: Array<unknown> | null;
}

const user = (id: string): Msg => ({
	id,
	role: "user",
	contentJson: [{ type: "text", text: "hi" }],
});

/** An assistant row with no persisted blocks and no tool calls (crashed partial). */
const emptyAssistant = (id: string): Msg => ({
	id,
	role: "assistant",
	contentJson: [],
	toolCalls: [],
});

const textAssistant = (id: string): Msg => ({
	id,
	role: "assistant",
	contentJson: [{ type: "text", text: "reply" }],
	toolCalls: [],
});

describe("resolveRetryTarget", () => {
	it("尾部就是用户消息时直接返回它", () => {
		const result = resolveRetryTarget([textAssistant("a1"), user("u1")]);
		expect(result.target?.id).toBe("u1");
		expect(result.target && result.emptyAssistantIds).toEqual([]);
	});

	it("跳过尾部的空 assistant 占位行，回退到上一条用户消息", () => {
		const result = resolveRetryTarget([user("u1"), emptyAssistant("a1")]);
		expect(result.target?.id).toBe("u1");
		expect(result.target && result.emptyAssistantIds).toEqual(["a1"]);
	});

	it("跳过多条连续的空 assistant 占位行", () => {
		const result = resolveRetryTarget([user("u1"), emptyAssistant("a1"), emptyAssistant("a2")]);
		expect(result.target?.id).toBe("u1");
		// Collected newest-first as the walk goes backwards.
		expect(result.target && result.emptyAssistantIds).toEqual(["a2", "a1"]);
	});

	it("尾部是有正文的 assistant 回复时拒绝重试（应走继续）", () => {
		const result = resolveRetryTarget([user("u1"), textAssistant("a1")]);
		expect(result.target).toBeNull();
		expect(result.target === null && result.reason).toBe("not_user");
	});

	it("空 contentJson 但有工具调用的 assistant 不算占位行", () => {
		const withToolCall: Msg = { id: "a1", role: "assistant", contentJson: [], toolCalls: [{}] };
		const result = resolveRetryTarget([user("u1"), withToolCall]);
		expect(result.target).toBeNull();
		expect(result.target === null && result.reason).toBe("not_user");
	});

	it("contentJson 非数组（null/未初始化）且无工具调用时视为占位行", () => {
		const nullContent: Msg = { id: "a1", role: "assistant", contentJson: null, toolCalls: null };
		const result = resolveRetryTarget([user("u1"), nullContent]);
		expect(result.target?.id).toBe("u1");
	});

	it("有 reasoning 块的 assistant 不算占位行", () => {
		const reasoningOnly: Msg = {
			id: "a1",
			role: "assistant",
			contentJson: [{ type: "reasoning", text: "thinking" }],
			toolCalls: [],
		};
		const result = resolveRetryTarget([user("u1"), reasoningOnly]);
		expect(result.target).toBeNull();
		expect(result.target === null && result.reason).toBe("not_user");
	});

	it("没有任何消息时返回 empty", () => {
		const result = resolveRetryTarget([]);
		expect(result.target).toBeNull();
		expect(result.target === null && result.reason).toBe("empty");
	});

	it("扫描范围内全是空 assistant 占位行时返回 empty", () => {
		const result = resolveRetryTarget([emptyAssistant("a1"), emptyAssistant("a2")]);
		expect(result.target).toBeNull();
		expect(result.target === null && result.reason).toBe("empty");
	});
});
