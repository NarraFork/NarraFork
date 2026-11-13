import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeLegacyContent } from "@shared/narrator-blocks/decode";
import {
	clearedToolOutput,
	historyClearedText,
	type StorageHistoryCandidate,
} from "@shared/storage-retention";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { openSchemaCopyAt } from "../../../tests/sqlite-schema-image";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";

const directory = mkdtempSync(join(tmpdir(), "nf-history-mutation-test-"));
const databasePath = join(directory, "history.sqlite");
const template = getTestDb();
const sqlite = openSchemaCopyAt(template.sqlite, databasePath);
for (const trigger of template.sqlite
	.query<{ sql: string }, []>(
		"SELECT sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL",
	)
	.all())
	sqlite.exec(trigger.sql);
template.sqlite.close();
sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 100");
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");
const { narratorPersistence } = await import("../narrator-persistence");
const { narratorMessageQueries } = await import("../narrator-messages");
const sync = await import("../narrator-block-sync");
const bodies = await import("../narrator-body-writes");
const { settings } = await import("../../lib/settings");
const pool = await import("../../lib/db-worker/pool");
const { runStorageHistoryBody } = await import("../../lib/db-worker/storage-history-query");
const { runBlockIndexQueueSlice } = await import("../../lib/db-worker/block-backfill-query");
const readIndex: import("../narrator-block-index").IndexQueueReader = async (params) =>
	runBlockIndexQueueSlice(sqlite, params);
const { clearStorageHistoryCandidate } = await import("../storage-history-mutations");
const { toTurns } = await import("../../lib/agent/projection/turns");
(await import("../../db/fts")).ensureFts(sqlite, { wasClean: true });
const { withIdleNarratorCleanupAdmission } = await import("../narrator-session-state");
let afterBodyRead: (() => unknown) | null = null;
const read = spyOn(pool, "runReadTask").mockImplementation(async (_path, params) => {
	if (params.kind !== "storageHistoryBody") throw new Error("unexpected worker task");
	const result = runStorageHistoryBody(sqlite, params);
	await afterBodyRead?.();
	return result as never;
});
const OLD = "2026-01-01T00:00:00.000Z";
const AT = "2026-10-01T00:00:00.000Z";
const CUTOFF = "2026-09-01T00:00:00.000Z";

beforeEach(() => {
	afterBodyRead = null;
	settings.narratorBlocks.compactJson = false;
	cleanDb(sqlite);
	for (const id of ["owner", "shared", "lazy"])
		sqlite.run(
			"INSERT INTO narrators (id, status, api_conversation_id, created_at, updated_at) VALUES (?, 'idle', 'old-api', ?, ?)",
			[id, OLD, OLD],
		);
});
afterAll(() => {
	read.mockRestore();
	sync.stopBlockSyncSweep();
	mock.module("../../db", () => realDbModule);
	sqlite.close();
	rmSync(directory, { recursive: true, force: true });
});

function candidate(id: string, tool = false): StorageHistoryCandidate {
	const table = tool ? "narrator_tool_calls" : "narrator_messages";
	const revision = tool ? "model_revision" : "body_revision";
	const found = sqlite
		.query<StorageHistoryCandidate, [string]>(`SELECT rowid, id,
		${tool ? "message_id" : "id"} AS messageId, ${revision} AS revision, 1 AS approxBytes
		FROM ${table} WHERE id = ?`)
		.get(id);
	if (!found) throw new Error(`missing fixture ${id}`);
	return found;
}
function clear(id: string, tool = false, cutoffAt = CUTOFF) {
	return clearStorageHistoryCandidate({
		target: tool ? "toolCallPayloads" : "messageHistory",
		candidate: candidate(id, tool),
		cutoffAt,
		clearedAt: AT,
	});
}
function content(id: string): unknown[] {
	return db.transaction((tx) => bodies.readEnvelopeBody(tx, id)) as unknown[];
}
async function user() {
	const message = await narratorStore.appendInput("owner", "private old message");
	sqlite.run(
		"UPDATE narrator_messages SET created_at = ?, original_content_json = ?, command_text = ? WHERE id = ?",
		[OLD, JSON.stringify([{ type: "text", text: "original private" }]), "/private", message.id],
	);
	return message.id;
}
async function tool() {
	const message = await narratorStore.openStep("owner", { uuid: "upstream", session_id: "api" });
	const id = await narratorStore.writeStepItem(message.id, "owner", {
		type: "tool_use",
		id: "wire",
		name: "Bash",
		input: { command: "private-command" },
	});
	await narratorStore.settleTool(
		"wire",
		{ status: "success", output: "private-result" },
		message.id,
		id,
	);
	if (!id) throw new Error("missing tool fixture");
	sqlite.run("UPDATE narrator_messages SET created_at = ? WHERE id = ?", [OLD, message.id]);
	sqlite.run("UPDATE narrator_tool_calls SET created_at = ? WHERE id = ?", [OLD, id]);
	return { messageId: message.id, id };
}

describe("retained recovery evidence and late projections", () => {
	test("cleared tool details keep legacy Write reconstruction input, but not model/detail payloads or their budgets", async () => {
		const { id, messageId } = await tool();
		const input = { file_path: "/legacy.txt", content: "private replay bytes\r\n".repeat(2000) };
		sqlite.run("UPDATE narrator_tool_calls SET tool_name = 'Write', input_json = ? WHERE id = ?", [
			JSON.stringify(input),
			id,
		]);
		db.transaction((tx) =>
			bodies.writeEnvelopeBody(tx, messageId, [
				{ type: "tool_use", id: "wire", name: "Write", input },
			]),
		);
		const { applyToolCall } = await import("../file-state-rebuild");
		const replayRow = () => ({
			toolUseId: "wire",
			toolName: "Write",
			inputJson: JSON.parse(
				(
					sqlite
						.query("SELECT input_json AS input FROM narrator_tool_calls WHERE id = ?")
						.get(id) as { input: string }
				).input,
			),
			status: "success",
			messageId,
			seq: 1,
			createdAt: OLD,
		});
		const beforeReplay = applyToolCall(null, replayRow());
		const { queryModelHistory, sqliteHistoryQuery } = await import(
			"../agent-runtime/model-history-query"
		);
		const { queryModelHistoryDelta, modelHistoryManifest } = await import(
			"../agent-runtime/model-history-delta"
		);
		const query = sqliteHistoryQuery(sqlite);
		const previous = await queryModelHistory(query, {
			narratorId: "owner",
			versioned: true,
			bodiesFromBlocks: true,
		});
		expect((await clear(id, true)).cleared).toBe(true);
		expect(applyToolCall(null, replayRow())).toBe(beforeReplay);
		expect(
			sqlite.query("SELECT input_chars AS chars FROM narrator_tool_calls WHERE id = ?").get(id),
		).toEqual({ chars: 0 });
		const next = await queryModelHistory(query, {
			narratorId: "owner",
			versioned: true,
			bodiesFromBlocks: true,
			maxBytes: 16384,
			inlineRowBytes: 2048,
		});
		expect(next.messages[0]?.toolCalls[0]?.inputJson).toBeNull();
		expect(next.counters.sourceBytes).toBeLessThan(16384);
		const delta: unknown[] = [];
		await queryModelHistoryDelta(
			query,
			{
				narratorId: "owner",
				versioned: true,
				bodiesFromBlocks: true,
				maxBytes: 16384,
				inlineRowBytes: 2048,
			},
			modelHistoryManifest(previous),
			async (message) => {
				delta.push(message);
			},
		);
		expect(JSON.stringify(delta)).not.toContain("private replay bytes");
		const detail = await narratorMessageQueries.getToolCallDetail("owner", "wire", {
			toolCallId: id,
			messageId,
		});
		expect(detail.inputJson).toBeNull();
		const { enrichToolUseBlocks } = await import("../narrator-messages");
		const view = enrichToolUseBlocks([
			{
				contentJson: content(messageId),
				toolCalls: [
					{
						id,
						toolUseId: "wire",
						toolName: "Write",
						inputJson: input,
						outputJson: clearedToolOutput(AT),
						status: "success",
					},
				],
			},
		]);
		expect(JSON.stringify(view)).not.toContain("private replay bytes");
	});

	test("tool cleanup preserves prose stored only in the legacy content_text fallback", async () => {
		const { id, messageId } = await tool();
		sqlite.run(
			"UPDATE narrator_messages SET content_text = 'fallback prose remains' WHERE id = ?",
			[messageId],
		);
		sync.flushChangedEnvelopes();
		expect((await clear(id, true)).cleared).toBe(true);
		expect(
			sqlite
				.query("SELECT content_text AS text FROM narrator_messages WHERE id = ?")
				.get(messageId),
		).toEqual({ text: "fallback prose remains" });
	});

	test("automatic projection clearing preserves the retention fence, including after an explicit edit", async () => {
		const id = await user();
		await clear(id);
		const { runBlockProjectionSlice } = await import("../../lib/db-worker/block-backfill-query");
		const select = () =>
			runBlockProjectionSlice(sqlite, {
				kind: "blockProjectionSlice",
				job: "clear",
				afterRowid: 0,
				maxEnvelopes: 100,
				maxSourceBytes: 1048576,
				budgetMs: 1000,
			});
		expect(select().envelopes.map((row) => row.id)).not.toContain(id);
		expect(
			db.transaction((tx) =>
				bodies.writeEnvelopeBody(tx, id, [{ type: "text", text: "late original" }]),
			),
		).toBe(false);
		await narratorPersistence.copyOnWriteMessage("owner", id, {
			contentJson: [{ type: "text", text: "new human".repeat(100) }],
			editedAt: AT,
		});
		expect(select().envelopes.map((row) => row.id)).not.toContain(id);
		expect(
			db.transaction((tx) =>
				bodies.writeEnvelopeBody(tx, id, [{ type: "text", text: "late after edit" }]),
			),
		).toBe(false);
		expect(JSON.stringify(content(id))).toContain("new human");
	});

	test("NULL output is not a tombstone and does not block normal input persistence or model budgeting", async () => {
		const step = await narratorStore.openStep("owner", { uuid: "u", session_id: "s" });
		const id = await narratorStore.writeStepItem(step.id, "owner", {
			type: "tool_use",
			id: "pending-wire",
			name: "Bash",
			input: { command: "initial" },
		});
		if (!id) throw new Error("missing pending tool");
		await narratorPersistence.overwriteToolCallInput(
			"pending-wire",
			{ command: "new pending input" },
			id,
		);
		expect(
			(
				sqlite
					.query("SELECT input_json AS input FROM narrator_tool_calls WHERE id = ?")
					.get(id) as { input: string }
			).input,
		).toContain("new pending input");
		const { queryModelHistory, sqliteHistoryQuery } = await import(
			"../agent-runtime/model-history-query"
		);
		const source = await queryModelHistory(sqliteHistoryQuery(sqlite), {
			narratorId: "owner",
			versioned: true,
			bodiesFromBlocks: true,
			maxBytes: 16384,
		});
		expect(source.messages[0]?.toolCalls[0]?.inputJson).toEqual({ command: "new pending input" });
	});
});

describe("retention payload references", () => {
	test.each([
		"main",
		"external",
	] as const)("worker preparation is fenced against %s connection writes for both policies", async (writer) => {
		for (const target of ["messageHistory", "toolCallPayloads"] as const) {
			const { id, messageId } = await tool();
			const beforeBody = content(messageId);
			const beforeCall = sqlite
				.query(
					"SELECT input_json AS input, output_json AS output FROM narrator_tool_calls WHERE id = ?",
				)
				.get(id);
			const prepared = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			afterBodyRead = () => {
				prepared.resolve();
				return gate.promise;
			};
			const pending = clearStorageHistoryCandidate({
				target,
				candidate: candidate(
					target === "messageHistory" ? messageId : id,
					target === "toolCallPayloads",
				),
				cutoffAt: CUTOFF,
				clearedAt: AT,
			});
			await prepared.promise;
			const connection = writer === "external" ? new Database(databasePath) : sqlite;
			try {
				expect(
					connection.query("UPDATE narrators SET updated_at = ? WHERE id = 'shared'").run(AT)
						.changes,
				).toBe(1);
			} finally {
				if (connection !== sqlite) connection.close();
			}
			gate.resolve();
			expect(await pending).toEqual({ cleared: false, retained: true });
			expect(content(messageId)).toEqual(beforeBody);
			expect(
				sqlite
					.query(
						"SELECT input_json AS input, output_json AS output FROM narrator_tool_calls WHERE id = ?",
					)
					.get(id),
			).toEqual(beforeCall);
			afterBodyRead = null;
		}
	});
	test("any intervening database write invalidates worker recovery protection, even without a body revision change", async () => {
		const id = await user();
		afterBodyRead = () =>
			sqlite.run(
				"UPDATE narrators SET title = 'intervening recovery metadata' WHERE id = 'shared'",
			);
		expect(await clear(id)).toEqual({ cleared: false, retained: true });
		expect(JSON.stringify(content(id))).toContain("private old message");
	});
	test("a changed live policy fences a candidate that was already prepared by a worker", async () => {
		const id = await user();
		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let enabled = true;
		afterBodyRead = () => {
			started.resolve();
			return gate.promise;
		};
		const pending = clearStorageHistoryCandidate({
			target: "messageHistory",
			candidate: candidate(id),
			cutoffAt: CUTOFF,
			clearedAt: AT,
			canClear: () => enabled,
		});
		await started.promise;
		enabled = false;
		gate.resolve();
		expect(await pending).toEqual({ cleared: false, retained: true });
		expect(JSON.stringify(content(id))).toContain("private old message");
	});
	test("tool cleanup preserves unrelated original prose, composer document and command metadata", async () => {
		const { id, messageId } = await tool();
		const original = [
			{ type: "text", text: "original prose must remain" },
			{
				type: "tool_use",
				id: "wire",
				name: "Bash",
				input: { command: "private original tool input" },
			},
			{ type: "tool_use", id: "unrelated", name: "Read", input: { path: "other input" } },
		];
		sqlite.run(
			"UPDATE narrator_messages SET original_content_json = ?, composer_document = ?, command_text = ? WHERE id = ?",
			[
				JSON.stringify(original),
				JSON.stringify({ version: 1, opaque: "composer must remain" }),
				"/unrelated",
				messageId,
			],
		);
		expect((await clear(id, true)).cleared).toBe(true);
		const preserved = sqlite
			.query(
				"SELECT original_content_json AS original, composer_document AS doc, command_text AS command FROM narrator_messages WHERE id = ?",
			)
			.get(messageId) as { original: string; doc: string; command: string };
		expect(preserved.original).toContain("original prose must remain");
		expect(preserved.original).toContain("other input");
		expect(preserved.original).not.toContain("private original tool input");
		expect(preserved.doc).toContain("composer must remain");
		expect(preserved.command).toBe("/unrelated");
	});

	test("lazy effective latest compact caches follow the cleared summary without requiring local refs", async () => {
		const id = await user();
		db.transaction((tx) =>
			bodies.writeEnvelopeBody(
				tx,
				id,
				[{ type: "compact", status: "compacted", summary: "borrowed old summary" }],
				{ set: { role: "system" } },
			),
		);
		sqlite.run("UPDATE narrator_message_refs SET is_compact = 1 WHERE message_id = ?", [id]);
		const seq = (
			sqlite.query("SELECT seq FROM narrator_message_refs WHERE message_id = ?").get(id) as {
				seq: number;
			}
		).seq;
		sqlite.run(
			"UPDATE narrators SET refs_inherited_from = 'owner', refs_backfill_cursor = ?, context_summary = 'borrowed old summary' WHERE id = 'lazy'",
			[seq + 1],
		);
		expect((await clear(id)).cleared).toBe(true);
		expect(
			sqlite.query("SELECT context_summary AS summary FROM narrators WHERE id = 'lazy'").get(),
		).toEqual({ summary: "[History cleared]" });
		expect(
			sqlite.query("SELECT 1 FROM narrator_message_refs WHERE narrator_id = 'lazy'").all(),
		).toHaveLength(0);
	});

	test("body cleanup removes old FTS and asset associations, and in-flight index results cannot restore them", async () => {
		const id = await user();
		const index = await import("../narrator-block-index");
		const query = await import("../../lib/db-worker/block-backfill-query");
		await index.drainBlockIndexQueue(readIndex);
		const oldBlock = sqlite
			.query<{ id: string }, [string]>("SELECT id FROM narrator_blocks WHERE message_id = ?")
			.get(id);
		if (!oldBlock) throw new Error("missing block");
		sqlite.run(
			"INSERT INTO narrator_block_assets (block_id,asset_id,role) VALUES (?, 'old-asset', 'input_file')",
			[oldBlock.id],
		);
		index.queueBlockIndex(oldBlock.id);
		const stale = query.runBlockIndexQueueSlice(sqlite, {
			kind: "blockIndexQueueSlice",
			maxBlocks: 20,
			maxIndexChars: 100000,
			budgetMs: 1000,
		});
		expect(stale.entries.length).toBeGreaterThan(0);
		expect((await clear(id)).cleared).toBe(true);
		expect(
			sqlite.query("SELECT 1 FROM narrator_block_assets WHERE asset_id = 'old-asset'").all(),
		).toHaveLength(0);
		expect(
			sqlite.query("SELECT 1 FROM narrator_block_index_queue WHERE block_id = ?").all(oldBlock.id),
		).toHaveLength(0);
		expect(await index.drainBlockIndexQueue(async () => stale)).toBe(0);
		expect(
			sqlite
				.query("SELECT 1 FROM narrator_blocks_fts WHERE narrator_blocks_fts MATCH 'private'")
				.all(),
		).toHaveLength(0);
	});
});

describe("atomic storage history retention", () => {
	test.each([
		false,
		true,
	])("message tombstones preserve refs and invalidate real/lazy holders (rows-only=%s)", async (rowsOnly) => {
		settings.narratorBlocks.compactJson = rowsOnly;
		const id = await user();
		const seq = (
			sqlite.query("SELECT seq FROM narrator_message_refs WHERE message_id = ?").get(id) as {
				seq: number;
			}
		).seq;
		sqlite.run(
			"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('shared-ref', 'shared', ?, ?)",
			[id, seq],
		);
		sqlite.run(
			"UPDATE narrators SET refs_inherited_from = 'shared', refs_backfill_cursor = ? WHERE id = 'lazy'",
			[seq + 1],
		);
		const before = sqlite.query("SELECT id, message_version AS v FROM narrators").all() as Array<{
			id: string;
			v: number;
		}>;
		expect(await clear(id)).toEqual({ cleared: true, retained: false });
		expect(content(id)).toEqual([historyClearedText(AT)]);
		expect(
			sqlite.query("SELECT id FROM narrator_message_refs WHERE message_id = ?").all(id),
		).toHaveLength(2);
		for (const row of before) {
			const n = sqlite
				.query(
					"SELECT message_version AS v, api_conversation_id AS api FROM narrators WHERE id = ?",
				)
				.get(row.id) as { v: number; api: null };
			expect(n.v).toBeGreaterThan(row.v);
			expect(n.api).toBeNull();
		}
		const envelope = sqlite
			.query(
				"SELECT original_content_json AS original, command_text AS command, body_rows_only AS rowsOnly FROM narrator_messages WHERE id = ?",
			)
			.get(id);
		expect(envelope).toEqual({ original: null, command: null, rowsOnly: 0 });
		expect(await clear(id)).toEqual({ cleared: false, retained: false });
	});

	test("message cleanup leaves independent tool receipts but never synthesizes ledger-only model blocks", async () => {
		const { id, messageId } = await tool();
		expect((await clear(messageId)).cleared).toBe(true);
		const call = sqlite
			.query(
				"SELECT input_json AS input, output_json AS output FROM narrator_tool_calls WHERE id = ?",
			)
			.get(id) as { input: string; output: string };
		expect(call.input).toContain("private-command");
		expect(call.output).toContain("private-result");
		const envelope = decodeLegacyContent({
			id: messageId,
			role: "assistant",
			contentJson: content(messageId),
			contentText: null,
			parentToolUseId: null,
			toolCalls: [
				{
					toolUseId: "wire",
					toolName: "Bash",
					inputJson: JSON.parse(call.input),
					outputJson: JSON.parse(call.output),
					status: "success",
				},
			],
		});
		expect(envelope.blocks.map((block) => block.kind)).toEqual(["output"]);
		expect(await clear(id, true)).toEqual({ cleared: true, retained: false });
		expect(content(messageId)).toEqual([historyClearedText(AT)]);
	});

	test("tool cleanup preserves state/name and degrades the entire model call/result pair", async () => {
		const { id, messageId } = await tool();
		const index = await import("../narrator-block-index");
		const query = await import("../../lib/db-worker/block-backfill-query");
		await index.drainBlockIndexQueue(readIndex);
		const stale = query.runBlockIndexQueueSlice(sqlite, {
			kind: "blockIndexQueueSlice",
			maxBlocks: 10,
			maxIndexChars: 100000,
			budgetMs: 1000,
		});
		expect((await clear(id, true)).cleared).toBe(true);
		const call = sqlite
			.query(
				"SELECT tool_name AS name, status, input_json AS input, output_json AS output FROM narrator_tool_calls WHERE id = ?",
			)
			.get(id) as { name: string; status: string; input: null; output: string };
		expect(call).toMatchObject({ name: "Bash", status: "success", input: null });
		expect(JSON.parse(call.output)).toEqual(clearedToolOutput(AT));
		expect(JSON.stringify(content(messageId))).not.toContain("private-command");
		const envelope = decodeLegacyContent({
			id: messageId,
			role: "assistant",
			contentJson: content(messageId),
			contentText: null,
			parentToolUseId: null,
			toolCalls: [
				{
					toolUseId: "wire",
					toolName: call.name,
					inputJson: null,
					outputJson: JSON.parse(call.output),
					status: call.status,
				},
			],
		});
		expect(envelope.blocks[0]).toMatchObject({
			kind: "tool",
			subtype: "Bash",
			phase: "done",
			payload: { payloadCleared: true },
		});
		const projected = toTurns([envelope], { strict: false, reasoningSource: "anthropic" });
		expect(projected.turns).toEqual([
			{
				kind: "assistant",
				envelopeId: messageId,
				items: [{ kind: "text", blockId: envelope.blocks[0]?.id, text: "[Tool details cleared]" }],
			},
		]);
		expect(stale.entries).toBeDefined();
		expect(await clear(id, true)).toEqual({ cleared: false, retained: false });
	});

	test("late checkpoints, results, input overwrites and state patches cannot revive cleared payloads", async () => {
		const { id, messageId } = await tool();
		await clear(id, true);
		await narratorPersistence.updateToolCallResult(
			"wire",
			{ status: "success", output: "late secret" },
			messageId,
			id,
		);
		await narratorPersistence.overwriteToolCallInput("wire", { command: "late command" }, id);
		await narratorStore.writeStepItem(messageId, "owner", {
			type: "tool_use",
			id: "wire",
			name: "Bash",
			input: { command: "late checkpoint" },
		});
		expect(JSON.stringify(content(messageId))).not.toContain("late");
		expect(
			sqlite.query("SELECT input_json AS input FROM narrator_tool_calls WHERE id = ?").get(id),
		).toEqual({ input: null });
		await clear(messageId);
		expect(
			db.transaction((tx) =>
				bodies.writeEnvelopeBody(tx, messageId, [{ type: "text", text: "late checkpoint" }]),
			),
		).toBe(false);
		expect(sync.patchEnvelopeState(messageId, () => [{ type: "text", text: "late patch" }])).toBe(
			false,
		);
		expect(content(messageId)).toEqual([historyClearedText(AT)]);
	});

	test("an explicit new user edit can replace a tombstone without re-adopting its old tool ledger", async () => {
		const { messageId } = await tool();
		await clear(messageId);
		await narratorPersistence.copyOnWriteMessage("owner", messageId, {
			contentJson: [{ type: "text", text: "new human text" }],
			contentText: "new human text",
			editedAt: AT,
		});
		const envelope = decodeLegacyContent({
			id: messageId,
			role: "assistant",
			contentJson: content(messageId),
			contentText: null,
			parentToolUseId: null,
			toolCalls: [
				{
					toolUseId: "wire",
					toolName: "Bash",
					inputJson: { command: "private-command" },
					outputJson: "private-result",
					status: "success",
				},
			],
		});
		expect(envelope.blocks.map((block) => block.kind)).toEqual(["output"]);
		expect(JSON.stringify(envelope)).toContain("new human text");
		await narratorStore.writeStepItem(messageId, "owner", {
			type: "text",
			text: "late checkpoint after human edit",
		});
		expect(JSON.stringify(content(messageId))).not.toContain("late checkpoint");
		expect((await clear(messageId)).cleared).toBe(true);
		expect(content(messageId)).toEqual([historyClearedText(AT)]);
	});

	test("candidate CAS, strict cutoff and admission all retain rather than clear", async () => {
		const id = await user();
		expect(await clear(id, false, OLD)).toEqual({ cleared: false, retained: true });
		const old = candidate(id);
		sqlite.run("UPDATE narrator_messages SET content_text = 'newer' WHERE id = ?", [id]);
		expect(
			await clearStorageHistoryCandidate({
				target: "messageHistory",
				candidate: old,
				cutoffAt: CUTOFF,
				clearedAt: AT,
			}),
		).toEqual({ cleared: false, retained: true });
		await withIdleNarratorCleanupAdmission(["owner"], async () => {
			expect(await clear(id)).toEqual({ cleared: false, retained: true });
		});
		expect(content(id)).not.toEqual([historyClearedText(AT)]);
	});

	test("worker snapshot drift and a lazy-fork becoming busy are rechecked before commit", async () => {
		const id = await user();
		afterBodyRead = () =>
			sqlite.run(
				"UPDATE narrator_messages SET content_text = 'changed after worker read' WHERE id = ?",
				[id],
			);
		expect(await clear(id)).toEqual({ cleared: false, retained: true });
		afterBodyRead = () => {
			sqlite.run(
				"UPDATE narrators SET refs_inherited_from = 'owner', refs_backfill_cursor = 100, status = 'working' WHERE id = 'lazy'",
			);
		};
		expect(await clear(id)).toEqual({ cleared: false, retained: true });
	});

	test("unacknowledged continuations from an old epoch and file-history checkpoints are protected", async () => {
		const { id, messageId } = await tool();
		sqlite.run(
			"INSERT INTO narrator_tool_continuations (id, tool_call_id, narrator_id, update_epoch, kind, state, payload_json, created_at, updated_at) VALUES ('continuation', ?, 'owner', 'old-epoch', 'deferred_tool', 'completed', '{}', ?, ?)",
			[id, OLD, OLD],
		);
		expect(await clear(id, true)).toEqual({ cleared: false, retained: true });
		expect(await clear(messageId)).toEqual({ cleared: false, retained: true });
		sqlite.run(
			'UPDATE narrator_tool_continuations SET payload_json = \'{"recoveryPhase":"owner_continuation_started"}\'',
		);
		sqlite.run("UPDATE narrator_tool_calls SET is_file_history_checkpoint = 1 WHERE id = ?", [id]);
		expect(await clear(id, true)).toEqual({ cleared: false, retained: true });
	});

	test("compact cleanup preserves control identity and clears the summary cache, not history refs", async () => {
		const id = await user();
		db.transaction((tx) =>
			bodies.writeEnvelopeBody(
				tx,
				id,
				[
					{
						type: "compact",
						status: "compacted",
						summary: "private summary",
						epoch: { id: "frozen-epoch" },
						attempts: [{ status: "success", output: "private compact output" }],
					},
				],
				{ set: { role: "system" } },
			),
		);
		sqlite.run("UPDATE narrator_message_refs SET is_compact = 1 WHERE message_id = ?", [id]);
		sqlite.run("UPDATE narrators SET context_summary = 'private summary' WHERE id = 'owner'");
		expect((await clear(id)).cleared).toBe(true);
		expect(content(id)[0]).toMatchObject({
			type: "compact",
			status: "compacted",
			epoch: { id: "frozen-epoch" },
			summary: "[History cleared]",
		});
		expect(JSON.stringify(content(id))).not.toContain("private");
		expect(
			sqlite.query("SELECT context_summary AS summary FROM narrators WHERE id = 'owner'").get(),
		).toEqual({ summary: "[History cleared]" });
		await narratorMessageQueries.updateCompactSummary("owner", id, "new summary");
		expect(JSON.stringify(content(id))).toContain("new summary");
	});

	test("clearing an obsolete attempt never removes the adopted attempt's input", async () => {
		const { id, messageId } = await tool();
		sqlite.run(
			`INSERT INTO narrator_tool_calls (id,narrator_id,message_id,tool_use_id,tool_name,status,input_json,output_json,execution_attempt,created_at)
			VALUES ('new-attempt','owner',?,'wire','Bash','success','{"command":"new attempt input"}','"new output"',99,?)`,
			[messageId, AT],
		);
		sync.flushChangedEnvelopes();
		expect((await clear(id, true)).cleared).toBe(true);
		expect(
			sqlite
				.query("SELECT input_json AS input FROM narrator_tool_calls WHERE id = 'new-attempt'")
				.get(),
		).toEqual({ input: '{"command":"new attempt input"}' });
		expect(
			decodeLegacyContent({
				id: messageId,
				role: "assistant",
				contentJson: content(messageId),
				contentText: null,
				parentToolUseId: null,
				toolCalls: [
					{
						toolUseId: "wire",
						toolName: "Bash",
						inputJson: { command: "new attempt input" },
						outputJson: "new output",
						status: "success",
					},
				],
			}).blocks[0],
		).toMatchObject({ payload: { input: { command: "new attempt input" } } });
	});
});
