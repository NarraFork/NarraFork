/**
 * continue-reasoning-tail.test.ts — "continue" must look past a reasoning-only tail.
 *
 * The bug this pins: a turn calls a tool, the tool finishes, then the turn dies (or
 * is interrupted) after the model streamed thinking but before it produced a reply.
 * `finalizeOrCleanupPartialMessage` keeps that partial because the reasoning is
 * meaningful and strips its unexecuted tool_use blocks, so history ends on an
 * assistant record holding nothing but reasoning.
 *
 * `continueNarrator` judged the tail by taking the last top-level user/assistant
 * message, which was that reasoning-only record. It has no tool_use blocks, so the
 * tool-result replay check said "nothing pending" and the continuation degraded into
 * a plain "continue" user message — silently abandoning the completed tool result the
 * previous turn was waiting on.
 *
 * Two properties are asserted:
 *  1. tail resolution walks past dangling reasoning records and reports their ids;
 *  2. the narrow deletion removes exactly one such record — it must NOT take out
 *     later messages (unlike `deleteMessage`, which drops everything at a higher
 *     seq) and must refuse a target that actually produced output.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessageRefs, narratorMessages, narratorToolCalls } from "../../db/schema";

const { db, sqlite } = getTestDb();
for (const statement of [
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_path_flavor TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN canonical_file_path TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN runtime_generation INTEGER",
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_targets_json TEXT",
]) {
	try {
		sqlite.run(statement);
	} catch (err) {
		if (!String(err).includes("duplicate column name")) throw err;
	}
}
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const { resolveContinuationTail, hasTrailingInjectionRow, resolveRetryTarget } = await import(
	"../narrator-session"
);
const { narratorMessageQueries } = await import("../narrator-messages");

const NOW = "2026-08-20T09:00:00.000Z";

async function seedNarrator(id = "n1") {
	sqlite
		.prepare("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)")
		.run(id, NOW, NOW);
}

async function seedMessage(params: {
	id: string;
	narratorId?: string;
	seq: number;
	role: "user" | "assistant" | "sys";
	contentJson?: unknown;
	contentText?: string | null;
}) {
	const narratorId = params.narratorId ?? "n1";
	await db.insert(narratorMessages).values({
		id: params.id,
		narratorId,
		role: params.role,
		contentJson: params.contentJson ?? [],
		contentText: params.contentText ?? null,
		createdAt: NOW,
	});
	await db.insert(narratorMessageRefs).values({
		id: `ref-${params.id}`,
		narratorId,
		messageId: params.id,
		seq: params.seq,
		isCompact: 0,
	});
}

function reasoningOnly(text: string) {
	return [{ type: "reasoning", text }];
}

beforeEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
});

describe("resolveContinuationTail", () => {
	test("walks past a reasoning-only tail to the pending tool-call turn", () => {
		const { tail, danglingReasoningIds } = resolveContinuationTail([
			{ id: "u1", role: "user", contentText: "做个功能" },
			{
				id: "a1",
				role: "assistant",
				contentJson: [{ type: "tool_use", id: "tu1", name: "Bash" }],
				toolCalls: [{ toolUseId: "tu1", toolName: "Bash" }],
			},
			{ id: "a2", role: "assistant", contentJson: reasoningOnly("继续思考") },
		]);

		expect(tail?.id).toBe("a1");
		expect(danglingReasoningIds).toEqual(["a2"]);
	});

	test("collapses several consecutive dangling records (repeated failed resumes)", () => {
		const { tail, danglingReasoningIds } = resolveContinuationTail([
			{
				id: "a1",
				role: "assistant",
				contentJson: [{ type: "tool_use", id: "tu1", name: "Bash" }],
				toolCalls: [{ toolUseId: "tu1", toolName: "Bash" }],
			},
			{ id: "a2", role: "assistant", contentJson: reasoningOnly("第一次") },
			{ id: "a3", role: "assistant", contentJson: reasoningOnly("第二次") },
		]);

		expect(tail?.id).toBe("a1");
		// Reported newest-first; only the set matters to the caller.
		expect(new Set(danglingReasoningIds)).toEqual(new Set(["a2", "a3"]));
	});

	test("leaves a real reply as the tail and reports nothing to drop", () => {
		const { tail, danglingReasoningIds } = resolveContinuationTail([
			{
				id: "a1",
				role: "assistant",
				contentJson: [{ type: "tool_use", id: "tu1", name: "Bash" }],
				toolCalls: [{ toolUseId: "tu1", toolName: "Bash" }],
			},
			{
				id: "a2",
				role: "assistant",
				contentJson: [
					{ type: "reasoning", text: "想一下" },
					{ type: "text", text: "改完了" },
				],
			},
		]);

		expect(tail?.id).toBe("a2");
		expect(danglingReasoningIds).toEqual([]);
	});

	test("ignores subagent messages, which are not top-level turns", () => {
		const { tail, danglingReasoningIds } = resolveContinuationTail([
			{
				id: "a1",
				role: "assistant",
				contentJson: [{ type: "tool_use", id: "tu1", name: "Agent" }],
				toolCalls: [{ toolUseId: "tu1", toolName: "Agent" }],
			},
			{
				id: "sub1",
				role: "assistant",
				parentToolUseId: "tu1",
				contentJson: reasoningOnly("子代理在想"),
			},
		]);

		expect(tail?.id).toBe("a1");
		expect(danglingReasoningIds).toEqual([]);
	});
});

/**
 * A trailing injection is the OTHER shape "continue" must recognize.
 *
 * `resolveContinuationTail` walks past `sys` rows on purpose (an injection is not a turn
 * to build on), and reading that as "history ends on the row underneath" is what made
 * the continuation append a synthetic "please continue" user row. That row displaces the
 * injection from the trailing position, so the provider history builders stop lifting it
 * into the current turn — the model then reads the reminder as background while being
 * asked to continue something unnamed. Silent, so it is pinned here.
 */
describe("hasTrailingInjectionRow", () => {
	test("true when an injection is the last model-visible row", () => {
		expect(
			hasTrailingInjectionRow([
				{ id: "u1", role: "user", contentText: "做个功能" },
				{ id: "a1", role: "assistant", contentJson: [{ type: "text", text: "做完了" }] },
				{ id: "s1", role: "sys", contentText: "提醒：还有未完成任务" },
			]),
		).toBe(true);
	});

	test("true for a run of consecutive injections (several producers drained at once)", () => {
		expect(
			hasTrailingInjectionRow([
				{ id: "a1", role: "assistant", contentJson: [{ type: "text", text: "做完了" }] },
				{ id: "s1", role: "sys", contentText: "后台任务完成" },
				{ id: "s2", role: "sys", contentText: "容器已就绪" },
			]),
		).toBe(true);
	});

	test("false when an assistant turn follows the injection", () => {
		expect(
			hasTrailingInjectionRow([
				{ id: "s1", role: "sys", contentText: "提醒" },
				{ id: "a1", role: "assistant", contentJson: [{ type: "text", text: "收到" }] },
			]),
		).toBe(false);
	});

	test("false when a user turn follows the injection — that is Retry's case", () => {
		expect(
			hasTrailingInjectionRow([
				{ id: "s1", role: "sys", contentText: "提醒" },
				{ id: "u1", role: "user", contentText: "换个方向" },
			]),
		).toBe(false);
	});

	test("ignores subagent rows, which are not top-level turns", () => {
		expect(
			hasTrailingInjectionRow([
				{ id: "s1", role: "sys", contentText: "提醒" },
				{ id: "sub1", role: "assistant", parentToolUseId: "tu1", contentText: "子代理输出" },
			]),
		).toBe(true);
	});

	test("false on empty history", () => {
		expect(hasTrailingInjectionRow([])).toBe(false);
	});
});

describe("retry empty placeholder cleanup", () => {
	test("empty failed response without snapshots can be cleaned before retry range deletion", async () => {
		await seedNarrator();
		await seedMessage({ id: "u1", seq: 1, role: "user", contentText: "retry" });
		await seedMessage({ id: "a1", seq: 2, role: "assistant" });
		const rows = await db.query.narratorMessages.findMany({ with: { toolCalls: true } });
		const resolved = resolveRetryTarget(rows);
		expect(resolved.target?.id).toBe("u1");
		if (!resolved.target) throw new Error("missing retry target");
		for (const id of resolved.emptyAssistantIds) {
			expect(await narratorMessageQueries.deleteEmptyRetryPlaceholder("n1", id)).toBe(true);
		}
		expect(
			(await narratorMessageQueries.deleteMessagesAfter("n1", "u1")).deletedMessageIds,
		).toEqual([]);
		expect((await db.query.narrators.findFirst())?.messageStructureVersion).toBe(1);
	});

	test("remaining system traffic is a no-op rollback, so retry can delete it", async () => {
		await seedNarrator();
		await seedMessage({ id: "u1", seq: 1, role: "user", contentText: "retry" });
		await seedMessage({ id: "a1", seq: 2, role: "assistant" });
		await seedMessage({ id: "s1", seq: 3, role: "sys", contentText: "background notice" });
		expect(await narratorMessageQueries.deleteEmptyRetryPlaceholder("n1", "a1")).toBe(true);
		expect(
			(await narratorMessageQueries.deleteMessagesAfter("n1", "u1")).deletedMessageIds,
		).toEqual(["s1"]);
		expect((await db.query.narratorMessageRefs.findMany()).map((ref) => ref.messageId)).toEqual([
			"u1",
		]);
	});

	test("real tool rows and malformed or textual replies are never placeholders", async () => {
		await seedNarrator();
		await seedMessage({ id: "a1", seq: 1, role: "assistant" });
		await db.insert(narratorToolCalls).values({
			id: "tc1",
			narratorId: "n1",
			messageId: "a1",
			toolUseId: "tu1",
			toolName: "Write",
			inputJson: {},
			status: "success",
			createdAt: NOW,
		});
		await expect(narratorMessageQueries.deleteEmptyRetryPlaceholder("n1", "a1")).rejects.toThrow(
			/empty-placeholder/,
		);
		const row = await db.query.narratorMessages.findFirst({ with: { toolCalls: true } });
		if (!row) throw new Error("missing assistant");
		expect(resolveRetryTarget([{ id: "u1", role: "user" }, row]).target).toBeNull();
		for (const extra of [
			{ contentJson: {} },
			{ contentJson: [], contentText: "reply" },
			{ contentJson: [{ type: "tool_use", id: "tu" }] },
		]) {
			expect(
				resolveRetryTarget([
					{ id: "u1", role: "user" },
					{ id: "a", role: "assistant", ...extra },
				]).target,
			).toBeNull();
		}
		expect(await db.query.narratorToolCalls.findMany()).toHaveLength(1);
	});

	test("preserves shared records and unrelated system/subagent traffic", async () => {
		await seedNarrator();
		await seedNarrator("n2");
		await seedMessage({ id: "a1", seq: 1, role: "assistant" });
		await db
			.insert(narratorMessageRefs)
			.values({ id: "shared", narratorId: "n2", messageId: "a1", seq: 1 });
		await seedMessage({ id: "s1", seq: 2, role: "sys", contentText: "background notice" });
		await seedMessage({ id: "child", seq: 3, role: "assistant" });
		sqlite.run(
			"UPDATE narrator_messages SET parent_tool_use_id = 'parent-tool' WHERE id = 'child'",
		);
		expect(await narratorMessageQueries.deleteEmptyRetryPlaceholder("n1", "a1")).toBe(true);
		expect(await db.query.narratorMessages.findMany()).toHaveLength(3);
		expect(await db.query.narratorMessageRefs.findMany()).toHaveLength(3);
		await expect(
			narratorMessageQueries.deleteEmptyRetryPlaceholder("n1", "child"),
		).rejects.toThrow();
		await expect(narratorMessageQueries.deleteEmptyRetryPlaceholder("n1", "s1")).rejects.toThrow();
	});

	test("refuses snapshot, compact and fork boundaries without deleting history", async () => {
		await seedNarrator();
		await seedMessage({ id: "a1", seq: 1, role: "assistant" });
		for (const [set, clear] of [
			[
				"UPDATE narrator_messages SET tree_hash_after = 'tree'",
				"UPDATE narrator_messages SET tree_hash_after = NULL",
			],
			[
				"UPDATE narrator_message_refs SET is_compact = 1",
				"UPDATE narrator_message_refs SET is_compact = 0",
			],
			[
				"UPDATE narrators SET fork_message_id = 'a1'",
				"UPDATE narrators SET fork_message_id = NULL",
			],
		]) {
			sqlite.run(set);
			await expect(
				narratorMessageQueries.deleteEmptyRetryPlaceholder("n1", "a1"),
			).rejects.toThrow();
			expect(await db.query.narratorMessageRefs.findMany()).toHaveLength(1);
			sqlite.run(clear);
		}
	});
});

describe("deleteDanglingReasoningMessage", () => {
	test("removes only the target, leaving later messages intact", async () => {
		await seedNarrator();
		await seedMessage({ id: "u1", seq: 1, role: "user", contentText: "做个功能" });
		await seedMessage({
			id: "a1",
			seq: 2,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }],
		});
		await db.insert(narratorToolCalls).values({
			id: "tc1",
			narratorId: "n1",
			messageId: "a1",
			toolUseId: "tu1",
			toolName: "Bash",
			inputJson: { command: "ls" },
			outputJson: { stdout: "ok" },
			status: "success",
			createdAt: NOW,
		});
		await seedMessage({ id: "a2", seq: 3, role: "assistant", contentJson: reasoningOnly("在想") });
		// A background subagent's traffic can land after the dead turn. `deleteMessage`
		// would remove this too (it deletes every ref at seq >= target); this must not.
		await seedMessage({ id: "u2", seq: 4, role: "user", contentText: "后续消息" });

		const removed = await narratorMessageQueries.deleteDanglingReasoningMessage("n1", "a2");
		expect(removed).toBe(true);

		const remaining = (await db.select({ id: narratorMessages.id }).from(narratorMessages)).map(
			(row) => row.id,
		);
		expect(new Set(remaining)).toEqual(new Set(["u1", "a1", "u2"]));

		const refs = await db
			.select({ messageId: narratorMessageRefs.messageId })
			.from(narratorMessageRefs);
		expect(new Set(refs.map((r) => r.messageId))).toEqual(new Set(["u1", "a1", "u2"]));

		// The executed tool call survives — its result is what the continuation replays.
		const toolCalls = await db.select({ id: narratorToolCalls.id }).from(narratorToolCalls);
		expect(toolCalls).toHaveLength(1);
	});

	test("refuses a record that actually produced a reply", async () => {
		await seedNarrator();
		await seedMessage({
			id: "a1",
			seq: 1,
			role: "assistant",
			contentJson: [
				{ type: "reasoning", text: "想一下" },
				{ type: "text", text: "改完了" },
			],
		});

		await expect(narratorMessageQueries.deleteDanglingReasoningMessage("n1", "a1")).rejects.toThrow(
			/reasoning-only/,
		);

		const remaining = await db.select({ id: narratorMessages.id }).from(narratorMessages);
		expect(remaining).toHaveLength(1);
	});

	test("is a no-op when the ref is already gone", async () => {
		await seedNarrator();
		expect(await narratorMessageQueries.deleteDanglingReasoningMessage("n1", "missing")).toBe(
			false,
		);
	});
});
