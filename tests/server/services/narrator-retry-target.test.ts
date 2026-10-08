import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { cleanDb, getTestDb } from "../../setup";

// The function is pure, but its import graph initializes the durable runtime outbox.
// Use the full migration fixture rather than an empty handle that cannot load the module.
const { db, sqlite } = getTestDb();
// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../../server/db")) };
mock.module("../../../server/db", () => ({ ...realDbModule, db, sqlite }));

const { resolveRetryTarget } = await import("../../../server/services/narrator-session");

afterEach(() => cleanDb(sqlite));
afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
	mock.restore();
	sqlite.close();
});

interface Msg {
	id: string;
	role: string;
	contentJson?: unknown;
	contentText?: string | null;
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

	for (const contentJson of [null, undefined, { text: "unrecognized persisted output" }]) {
		it(`contentJson 非数组（${contentJson === null ? "null" : contentJson === undefined ? "未初始化" : "未知结构"}）不得被当作空占位行删除`, () => {
			const now = "2026-01-01T00:00:00.000Z";
			sqlite
				.prepare(
					"INSERT INTO narrators (id, message_version, created_at, updated_at) VALUES ('n1', 7, ?, ?)",
				)
				.run(now, now);
			sqlite
				.prepare(
					"INSERT INTO narrator_messages (id, narrator_id, role, content_json, content_text, created_at) VALUES ('u1', 'n1', 'user', ?, 'hi', ?)",
				)
				.run(JSON.stringify(user("u1").contentJson), now);
			sqlite
				.prepare(
					"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES ('a1', 'n1', 'assistant', ?, ?)",
				)
				.run(JSON.stringify(contentJson ?? null), now);
			sqlite.run(
				"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('ref-u1', 'n1', 'u1', 0), ('ref-a1', 'n1', 'a1', 1)",
			);
			sqlite
				.prepare(
					"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, status, output_json, created_at) VALUES ('audit', 'n1', 'a1', 'audit-use', 'Read', 'success', ?, ?)",
				)
				.run(JSON.stringify({ output: "must preserve completed tool output" }), now);
			const snapshot = () => ({
				messages: sqlite
					.query("SELECT id, content_json, content_text FROM narrator_messages ORDER BY id")
					.all(),
				refs: sqlite
					.query("SELECT id, message_id, seq FROM narrator_message_refs ORDER BY seq")
					.all(),
				version: sqlite.query("SELECT message_version FROM narrators WHERE id = 'n1'").get(),
				tools: sqlite
					.query("SELECT id, status, output_json FROM narrator_tool_calls ORDER BY id")
					.all(),
			});
			const before = snapshot();
			const unknownContent: Msg = { id: "a1", role: "assistant", contentJson, toolCalls: null };
			const result = resolveRetryTarget([user("u1"), unknownContent]);
			expect(result).toEqual({ target: null, reason: "not_user" });
			expect(result).not.toHaveProperty("emptyAssistantIds");
			expect(snapshot()).toEqual(before);
			expect(before.messages).toHaveLength(2);
			expect(before.refs).toHaveLength(2);
			expect(before.tools).toHaveLength(1);
			expect(before.version).toEqual({ message_version: 7 });
		});
	}

	it("已知空 contentJson 且 toolCalls 为 null 时仍可重试", () => {
		const result = resolveRetryTarget([
			user("u1"),
			{ id: "a1", role: "assistant", contentJson: [], toolCalls: null },
		]);
		expect(result.target?.id).toBe("u1");
		expect(result.target && result.emptyAssistantIds).toEqual(["a1"]);
	});

	it("即使 blocks 为空，已有正文的 assistant 也不得被当作占位行", () => {
		const result = resolveRetryTarget([
			user("u1"),
			{ ...emptyAssistant("a1"), contentText: "persisted answer" },
		]);
		expect(result).toEqual({ target: null, reason: "not_user" });
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
