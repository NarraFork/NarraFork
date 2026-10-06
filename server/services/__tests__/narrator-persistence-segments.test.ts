import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq, is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableConfig, SQLiteSyncDialect, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";

// Build an isolated fixture from actual column definitions, with no foreign keys
// or migration dependency (schema-first worktrees intentionally omit migrations).
const sqlite = new Database(":memory:");
const dialect = new SQLiteSyncDialect();
for (const table of Object.values(schema).filter((value) => is(value, SQLiteTable))) {
	const config = getTableConfig(table);
	const columns = config.columns.map((column) => {
		const value = column.default;
		const defaultSql =
			value instanceof SQL
				? dialect.sqlToQuery(value).sql
				: typeof value === "string"
					? `'${value.replaceAll("'", "''")}'`
					: typeof value === "number"
						? String(value)
						: undefined;
		return `"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}${defaultSql ? ` DEFAULT ${defaultSql}` : ""}`;
	});
	sqlite.run(`CREATE TABLE "${config.name}" (${columns.join(", ")})`);
}
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
mock.module("../../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
mock.module("../../lib/context-characters", () => ({
	measureMessageCharacters: () => null,
	measureSerializedCharacters: (value: unknown) => JSON.stringify(value)?.length ?? 0,
	measureSummaryCharacters: (value: string) => value.length,
	queueContextCharacterRefresh: () => {},
}));
await import("../narrator-service");
const { narratorPersistence } = await import("../narrator-persistence");
const now = "2026-10-04T00:00:00Z";
beforeEach(async () => {
	for (const table of [
		"narrator_tool_calls",
		"narrator_message_refs",
		"narrator_messages",
		"narrators",
		"file_change_execution_segments",
	])
		sqlite.run(`DELETE FROM "${table}"`);
	await db.insert(schema.narrators).values({ id: "n", createdAt: now, updatedAt: now });
});
afterAll(() => {
	mock.restore();
	sqlite.close();
});
async function persist(narratorId = "n", parentToolUseId?: string) {
	return narratorPersistence.persistAssistantMessage(narratorId, {
		uuid: crypto.randomUUID(),
		session_id: "session",
		parent_tool_use_id: parentToolUseId,
		message: {
			content: [{ type: "tool_use", id: "reused-provider-id", name: "Write", input: {} }],
		},
	});
}

describe("persisted execution segment identities", () => {
	test("a provider ID reused across assistant messages creates independent real-call segments", async () => {
		await persist();
		await persist();
		const calls = await db.select().from(schema.narratorToolCalls);
		expect(calls).toHaveLength(2);
		expect(calls[0].executionSegmentId).not.toBe(calls[1].executionSegmentId);
		for (const call of calls) {
			const [segment] = await db
				.select()
				.from(schema.fileChangeExecutionSegments)
				.where(
					eq(schema.fileChangeExecutionSegments.id, call.executionSegmentId ?? "missing-segment"),
				);
			expect(segment.sourceToolCallId).toBe(call.id);
			expect(segment.sourceExecutionAttempt).toBe(call.executionAttempt);
			expect(segment.sourceInputId).toBeNull();
		}
	});

	test("explicit new attempts allocate a fresh segment, not their COW/historical segment", async () => {
		await persist();
		const [original] = await db.select().from(schema.narratorToolCalls);
		const prepared = await narratorPersistence.prepareToolCallAttempt("n", original.id);
		expect(prepared.toolCall.executionAttempt).toBe(2);
		expect(prepared.toolCall.executionSegmentId).not.toBe(original.executionSegmentId);
		const [segment] = await db
			.select()
			.from(schema.fileChangeExecutionSegments)
			.where(
				eq(
					schema.fileChangeExecutionSegments.id,
					prepared.toolCall.executionSegmentId ?? "missing-segment",
				),
			);
		expect(segment.sourceToolCallId).toBe(prepared.toolCall.id);
		expect(segment.sourceExecutionAttempt).toBe(2);
	});

	test("COW history stays historical while the fork's successor gets its own real segment", async () => {
		const message = await persist();
		const [original] = await db.select().from(schema.narratorToolCalls);
		await db.insert(schema.narrators).values({ id: "fork", createdAt: now, updatedAt: now });
		await db.insert(schema.narratorMessageRefs).values({
			id: "fork-ref",
			narratorId: "fork",
			messageId: message.id,
			seq: 1,
		});
		const prepared = await narratorPersistence.prepareToolCallAttempt("fork", original.id);
		expect(prepared.requiresFreshPermission).toBe(true);
		expect(prepared.toolCall.executionOriginToolCallId).toBeNull();
		expect(prepared.toolCall.executionSegmentId).not.toBe(original.executionSegmentId);
		const [segment] = await db
			.select()
			.from(schema.fileChangeExecutionSegments)
			.where(
				eq(
					schema.fileChangeExecutionSegments.id,
					prepared.toolCall.executionSegmentId ?? "missing-segment",
				),
			);
		expect(segment.narratorId).toBe("fork");
		expect(segment.sourceToolCallId).toBe(prepared.toolCall.id);
	});

	test("streamed tool blocks also isolate provider IDs across message shells", async () => {
		for (let i = 0; i < 2; i++) {
			const message = await narratorPersistence.createPartialAssistantMessage("n", {
				uuid: crypto.randomUUID(),
				session_id: "session",
			});
			await narratorPersistence.appendBlockToMessage(message.id, "n", {
				type: "tool_use",
				id: "reused-provider-id",
				name: "Write",
				input: {},
			});
		}
		const calls = await db.select().from(schema.narratorToolCalls);
		expect(calls).toHaveLength(2);
		expect(calls[0].executionSegmentId).not.toBe(calls[1].executionSegmentId);
	});

	test("a verified current run links tools only under the exact receipt despite duplicate provider IDs", async () => {
		await persist();
		await persist();
		const calls = await db.select().from(schema.narratorToolCalls);
		const chosen = calls[1];
		const binding = await narratorPersistence.getToolCallBinding(
			"n",
			chosen.messageId,
			chosen.toolUseId,
			chosen.id,
		);
		await db.insert(schema.narrators).values({
			id: "child",
			type: "subagent",
			parentNarratorId: "n",
			logicalRunId: "run-1",
			createdAt: now,
			updatedAt: now,
		});
		const { establishSubagentExecutionSegment } = await import("../subagent-execution-boundary");
		const run = await establishSubagentExecutionSegment({
			childNarratorId: "child",
			parentNarratorId: "n",
			logicalRunId: "run-1",
			toolUseId: chosen.toolUseId,
			binding,
		});
		await persist("child", chosen.toolUseId);
		const { createFileChangeExecutionSegmentsService } = await import(
			"../file-change-execution-segments"
		);
		const segments = createFileChangeExecutionSegmentsService(db);
		const [child] = await db
			.select()
			.from(schema.narratorToolCalls)
			.where(eq(schema.narratorToolCalls.narratorId, "child"));
		if (!child.executionSegmentId) throw new Error("Child tool execution segment is missing");
		expect((await segments.get(child.executionSegmentId))?.parentSegmentId).toBe(
			run.executionSegmentId,
		);
		expect(
			(await segments.descendants(calls[0].executionSegmentId ?? "missing")).segmentIds,
		).toEqual([]);
		expect((await segments.descendants(chosen.executionSegmentId ?? "missing")).segmentIds).toEqual(
			[run.executionSegmentId, child.executionSegmentId],
		);
	});

	test("internal Reads get real segments under the canonical Eval receipt", async () => {
		await persist();
		const [call] = await db.select().from(schema.narratorToolCalls);
		await db
			.update(schema.narratorToolCalls)
			.set({ toolName: "Eval", status: "running" })
			.where(eq(schema.narratorToolCalls.id, call.id));
		const result = await narratorPersistence.createInternalRead(
			"n",
			call.toolUseId,
			{
				toolCallId: call.id,
				attempt: call.executionAttempt,
			},
			{ file_path: "file" },
			1,
		);
		const [segment] = await db
			.select()
			.from(schema.fileChangeExecutionSegments)
			.where(eq(schema.fileChangeExecutionSegments.id, result.binding.executionSegmentId));
		expect(segment.sourceToolCallId).toBe(result.binding.toolCallId);
		expect(segment.parentSegmentId).toBe(call.executionSegmentId);
	});

	test("a receipt cannot substitute another call's segment", async () => {
		await persist();
		await persist();
		const calls = await db.select().from(schema.narratorToolCalls);
		const binding = await narratorPersistence.getToolCallBinding(
			"n",
			calls[0].messageId,
			calls[0].toolUseId,
			calls[0].id,
		);
		await expect(
			narratorPersistence.validateToolCallBinding("n", calls[0].toolUseId, {
				...binding,
				executionSegmentId: calls[1].executionSegmentId ?? "missing",
			}),
		).rejects.toThrow("does not match");
	});

	test("a missing historical segment stays unavailable, not a fake tool-call ID", async () => {
		await persist();
		const [call] = await db.select().from(schema.narratorToolCalls);
		await db
			.update(schema.narratorToolCalls)
			.set({ executionSegmentId: null })
			.where(eq(schema.narratorToolCalls.id, call.id));
		const binding = await narratorPersistence.getToolCallBinding(
			"n",
			call.messageId,
			call.toolUseId,
			call.id,
		);
		expect(binding.executionSegmentId).toBeUndefined();
	});

	test("an unverified parent provider ID cannot attach a child to an arbitrary same-ID call", async () => {
		await persist();
		await persist();
		await db.insert(schema.narrators).values({
			id: "child",
			type: "subagent",
			parentNarratorId: "n",
			createdAt: now,
			updatedAt: now,
		});
		await persist("child", "reused-provider-id");
		const [call] = await db
			.select()
			.from(schema.narratorToolCalls)
			.where(eq(schema.narratorToolCalls.narratorId, "child"));
		const [segment] = await db
			.select()
			.from(schema.fileChangeExecutionSegments)
			.where(
				eq(schema.fileChangeExecutionSegments.id, call.executionSegmentId ?? "missing-segment"),
			);
		expect(segment.parentSegmentId).toBeNull();
	});
});
