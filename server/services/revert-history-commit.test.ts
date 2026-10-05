import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { FILE_CHANGE_LIMITS, type FileChangeRevertSelector } from "@shared/file-change-protocol";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqlite as isolatedTemplate } from "../db";
import * as schema from "../db/schema";
import { measureMessageCharacters } from "../lib/context-characters";
import { createFileChangeIdentity, fileChangeIdentityKey } from "./file-change-identity";
import type { NarratorAclRow, NarratorPrincipal } from "./narrator-acl";
import { reconcileQuestionHistoryInTransaction } from "./narrator-question-history";
import {
	type PreparedRevertHistory,
	REWRITE_WORKER,
	RevertHistoryCommitService,
} from "./revert-history-commit";
import { RevertSelectionService } from "./revert-selection-service";

// Actual schema/FKs/generated columns, with a real independent root and actual collector.
// The template is test-preload-isolated; no production data, old deletion service, file
// execution/replay, or fake "files verified" API is involved. Test journals are SQL fixtures.
const principal: NarratorPrincipal = { userId: "alice", isAdmin: false };
const time = "2026-09-07T12:00:00.000Z";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let sqlite: Database;
let db: ReturnType<typeof database>;
let service: RevertHistoryCommitService;
let collector: RevertSelectionService;
let serial: number;
let authorized: string[];
let onAuthorize: (() => void) | undefined;
let connections: Database[];
function database(client: Database) {
	return drizzle({ client, schema });
}
function query<T>(text: string, ...params: SQLQueryBindings[]) {
	return sqlite.query<T, SQLQueryBindings[]>(text).all(...params);
}
function scalar(text: string, ...params: SQLQueryBindings[]) {
	return query<{ n: number }>(text, ...params)[0].n;
}
function seedSchema(client: Database) {
	client.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;");
	const definitions = isolatedTemplate
		.query<{ sql: string }, []>(
			"SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '*_fts*' ORDER BY type DESC LIMIT 2048",
		)
		.all();
	expect(definitions.length).toBeLessThan(2048);
	for (const row of definitions) client.exec(row.sql);
	// Pending schema changes are exercised without generating/running a migration.
	const columns = new Set(
		client
			.query<{ name: string }, []>("PRAGMA table_info(narrator_questions)")
			.all()
			.map((row) => row.name),
	);
	for (const column of ["context", "resolution_json", "summary_json", "withdraw_reason"]) {
		if (!columns.has(column))
			client.exec(`ALTER TABLE narrator_questions ADD COLUMN ${column} TEXT`);
	}
	client.exec(
		"CREATE INDEX IF NOT EXISTS idx_narrator_questions_answer_message ON narrator_questions(answer_message_id)",
	);
	client.exec(
		"CREATE TABLE IF NOT EXISTS narrator_question_events (question_id TEXT NOT NULL REFERENCES narrator_questions(id) ON DELETE CASCADE,message_id TEXT PRIMARY KEY REFERENCES narrator_messages(id) ON DELETE CASCADE,kind TEXT NOT NULL,created_at TEXT NOT NULL,resolution_json TEXT)",
	);
	client.exec(
		"CREATE INDEX IF NOT EXISTS idx_question_events_question_created ON narrator_question_events(question_id,created_at,message_id)",
	);
	client.exec(
		"CREATE INDEX IF NOT EXISTS idx_question_events_question_rowid ON narrator_question_events(question_id)",
	);
}
beforeEach(() => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	expect(process.env.HOME).not.toBe(process.env.NARRAFORK_ORIGINAL_HOME);
	sqlite = new Database(":memory:");
	connections = [sqlite];
	seedSchema(sqlite);
	db = database(sqlite);
	serial = 0;
	authorized = [];
	onAuthorize = undefined;
	for (const id of ["alice", "bob"])
		db.insert(schema.users)
			.values({ id, username: id, passwordHash: "not-a-secret", createdAt: time })
			.run();
	narrator("root");
	narrator("fork");
	narrator("other", "bob");
	service = new RevertHistoryCommitService(db, { authorize, onSlow: () => {} });
	collector = new RevertSelectionService(db, { authorize, onSlow: () => {} });
});
afterEach(() => {
	for (const connection of connections) connection.close();
});
async function authorize(
	user: NarratorPrincipal,
	row: NarratorAclRow,
	need: "write",
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	expect(need).toBe("write");
	expect(sqlite.inTransaction).toBe(false);
	onAuthorize?.();
	authorized.push(row.id);
	const account = db
		.select({ id: schema.users.id, role: schema.users.role })
		.from(schema.users)
		.where(eq(schema.users.id, user.userId))
		.get();
	if (!account || user.isAdmin !== (account.role === "admin")) throw Error("Authentication denied");
	const judged =
		row.type === "subagent"
			? db
					.select({ ownerUserId: schema.narrators.ownerUserId })
					.from(schema.narrators)
					.where(eq(schema.narrators.id, row.aclRootNarratorId ?? ""))
					.get()
			: row;
	// This fixture's real policy is private, standalone owner access; no default-allow mock.
	if (!judged || (!user.isAdmin && judged.ownerUserId !== user.userId)) throw Error("ACL denied");
}
function narrator(
	id: string,
	ownerUserId = "alice",
	extra: Partial<typeof schema.narrators.$inferInsert> = {},
) {
	db.insert(schema.narrators)
		.values({
			id,
			ownerUserId,
			title: id,
			messageVersion: 7,
			apiConversationId: "upstream",
			createdAt: time,
			updatedAt: time,
			...extra,
		})
		.run();
}
function message(
	seq: number,
	blocks: unknown[] = [{ type: "text", text: "hello" }],
	narratorId = "root",
	raw?: string,
) {
	const id = `message-${serial++}`;
	db.insert(schema.narratorMessages)
		.values({
			id,
			narratorId,
			role: "assistant",
			contentJson: blocks,
			treeHashAfter: "tree",
			snapshotCommitSha: "snapshot",
			createdAt: time,
		})
		.run();
	if (raw) sqlite.query("UPDATE narrator_messages SET content_json=? WHERE id=?").run(raw, id);
	ref(id, narratorId, seq);
	return id;
}
function ref(
	messageId: string,
	narratorId: string,
	seq: number,
	extra: Partial<typeof schema.narratorMessageRefs.$inferInsert> = {},
) {
	const id = `ref-${serial++}`;
	db.insert(schema.narratorMessageRefs)
		.values({ id, narratorId, messageId, seq, ...extra })
		.run();
	return id;
}
function tool(
	messageId: string,
	toolUseId: string,
	toolName = "Read",
	extra: Partial<typeof schema.narratorToolCalls.$inferInsert> = {},
) {
	const id = `tool-${serial++}`;
	db.insert(schema.narratorToolCalls)
		.values({
			id,
			messageId,
			narratorId: "root",
			toolUseId,
			toolName,
			status: "success",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionDeviceId: "local",
			executionPathFlavor: "posix",
			runtimeGeneration: 1,
			inputJson: { file_path: "/repo/x" },
			outputJson: { ok: true },
			createdAt: time,
			...extra,
		})
		.run();
	return id;
}
function withTools(seq = 1, names = ["a", "b"], narratorId = "root") {
	const id = message(
		seq,
		[
			{ type: "text", text: "keep" },
			...names.map((name) => ({ type: "tool_use", id: name, name: "Read", input: {} })),
		],
		narratorId,
	);
	const tools = names.map((name) => tool(id, name, "Read", { narratorId }));
	return { messageId: id, tools };
}
function version(id = "root") {
	return scalar("SELECT message_version AS n FROM narrators WHERE id=?", id);
}
function body(id: string) {
	return query<{ content_json: string }>(
		"SELECT content_json FROM narrator_messages WHERE id=?",
		id,
	)[0]?.content_json;
}
function count(table: string) {
	return scalar(`SELECT count(*) AS n FROM ${table}`);
}
async function select(selector: FileChangeRevertSelector = { kind: "all" }, narratorId = "root") {
	return collector.collect({
		principal,
		narratorId,
		expectedMessageVersion: version(narratorId),
		selector,
	});
}
async function prepare(selector: FileChangeRevertSelector = { kind: "all" }, narratorId = "root") {
	const fixedSelection = await select(selector, narratorId);
	return service.prepare({ principal, fixedSelection });
}
function apply(token: PreparedRevertHistory) {
	return db.transaction((tx) => service.applyToTransaction(tx, token));
}
function operation(toolId: string, mode: "effect" | "no_dispatch" = "effect") {
	const toolRow = db
		.select()
		.from(schema.narratorToolCalls)
		.where(eq(schema.narratorToolCalls.id, toolId))
		.get();
	if (!toolRow) throw Error("missing tool");
	const id = `operation-${serial++}`;
	const binding = {
		deviceId: "local",
		runtimeEpoch: "fixture",
		runtimeGeneration: 1,
		fencingToken: 0,
	};
	db.insert(schema.fileChangeOperations)
		.values({
			id,
			sourceInstanceId: "instance",
			sourceKind: "tool",
			sourceId: toolRow.executionOriginToolCallId ?? toolId,
			attempt: 1,
			toolCallId: toolRow.executionOriginToolCallId ?? toolId,
			narratorId: toolRow.narratorId,
			actorSubjectKey: `narrator:${toolRow.narratorId}`,
			actorJson: {
				kind: "primary",
				subjectKey: `narrator:${toolRow.narratorId}`,
				narratorId: toolRow.narratorId,
				userId: null,
				label: "Writer",
				deleted: false,
				parentSubjectKey: null,
			},
			executionBindingJson: binding,
			requestDigest: hash(id),
			expectedEffectCount: mode === "effect" ? 1 : 0,
			preparedEffectCount: mode === "effect" ? 1 : 0,
			settledEffectCount: mode === "effect" ? 1 : 0,
			evidenceBytes: mode === "effect" ? 6 : 0,
			executionOutcome: "failed",
			effectOutcome: mode === "effect" ? "changed" : "no_change",
			settlement: "settled",
			coverage: "complete",
			attributionGrade: "measured",
			reason: mode === "no_dispatch" ? "no_dispatch:validation_rejected" : null,
			startedAt: time,
			finishedAt: time,
			updatedAt: time,
		})
		.run();
	db.update(schema.narratorToolCalls)
		.set({ fileChangeOperationId: id, status: "fail", toolName: "Write" })
		.where(eq(schema.narratorToolCalls.id, toolId))
		.run();
	if (mode === "no_dispatch") return id;
	const scopeId = `scope-${serial++}`;
	db.insert(schema.fileChangeScopes)
		.values({
			id: scopeId,
			sourceInstanceId: "instance",
			deviceId: "local",
			workspaceInstanceId: "workspace",
			pathFlavor: "posix",
			canonicalRoot: "/repo",
			displayRoot: "/repo",
			status: "active",
			createdAt: time,
			updatedAt: time,
		})
		.run();
	const identity = createFileChangeIdentity(
		{
			id: scopeId,
			sourceInstanceId: "instance",
			deviceId: "local",
			workspaceInstanceId: "workspace",
			pathFlavor: "posix",
			canonicalRoot: "/repo",
		},
		{
			deviceId: "local",
			pathFlavor: "posix",
			canonicalPath: "/repo/x",
			lexicalPath: "/repo/x",
			objectRole: "referent",
		},
	);
	for (const bytes of ["old", "new"])
		if (
			!db
				.select()
				.from(schema.fileChangeBlobs)
				.where(eq(schema.fileChangeBlobs.digest, hash(bytes)))
				.get()
		)
			db.insert(schema.fileChangeBlobs)
				.values({
					id: `blob-${bytes}`,
					digest: hash(bytes),
					storageKey: `fixture-${bytes}`,
					sizeBytes: 3,
					status: "ready",
					createdAt: time,
					updatedAt: time,
				})
				.run();
	const before = {
		kind: "regular" as const,
		mode: 0o644,
		blob: { algorithm: "sha256" as const, digest: hash("old"), sizeBytes: 3 },
	};
	const after = {
		kind: "regular" as const,
		mode: 0o644,
		blob: { algorithm: "sha256" as const, digest: hash("new"), sizeBytes: 3 },
	};
	const mutationId = hash(`${id}-mutation`),
		requestDigest = hash(`${id}-request`);
	db.insert(schema.fileChangeEffects)
		.values({
			id: `effect-${id}`,
			operationId: id,
			scopeId,
			fileKey: fileChangeIdentityKey(identity),
			identityJson: identity,
			scopeRevision: 1,
			mutationId,
			requestDigest,
			phase: "apply",
			beforeStateJson: before,
			intendedAfterStateJson: after,
			observedAfterStateJson: after,
			beforeBlobDigest: hash("old"),
			intendedAfterBlobDigest: hash("new"),
			observedAfterBlobDigest: hash("new"),
			outcome: "changed",
			settlement: "settled",
			attributionGrade: "measured",
			executionConfirmed: true,
			executionReceiptJson: {
				receiptId: `receipt-${id}`,
				mutationId,
				requestDigest,
				executionBinding: binding,
				confirmed: true,
				outcome: "applied",
				observedAfter: after,
			},
			createdAt: time,
			updatedAt: time,
		})
		.run();
	return id;
}
function question(toolCallId: string, id = `question-${serial++}`) {
	db.insert(schema.narratorQuestions)
		.values({
			id,
			narratorId: "root",
			toolCallId,
			toolUseId: "provider",
			questionsJson: [],
			createdAt: time,
		})
		.run();
	return id;
}

for (const role of ["assistant", "user", "sys", "system", "disp", "other"]) {
	test(`rewrite worker context characters match the shared helper for ${role}`, async () => {
		const retained: Array<Record<string, unknown>> = [
			{ type: "text", text: "中文😀" },
			{ type: "text", text: "adjacent" },
			{ type: "thinking", thinking: "think" },
			{ type: "tool_use", id: "kept-tool", name: "Read", input: { text: "not counted" } },
			{ type: "tool_result", content: "not counted either" },
			{ type: "image", source: { data: "binary not counted" } },
			{ type: "redacted_thinking", data: "hidden" },
			{ type: "info", text: "display only" },
			{ type: "error", text: "display only" },
			{ type: "compact", status: "compacted", summary: "narrator row already counts this" },
			{ type: "segment_compact", status: "compacted", summary: "摘要😀" },
			{ type: "segment_compact", status: "compacting", summary: "not final" },
			{ type: "segment_compact", status: "failed", summary: "not final" },
			{ type: "file_reference", snapshotText: "inline snapshot" },
			{ type: "text_file", chars: 7 },
			{ type: "text_file", contentChars: 9 },
			{ type: "text_file", text: "actual text", chars: 999, contentChars: 999 },
			{ type: "text_file", content: "content priority", chars: 999 },
			{ type: "text_file", chars: -1 },
			{ type: "text_file", chars: 0.5 },
			{ type: "text_file", filename: "legacy.txt", size: 9000 },
			{ type: "attachment", source: { text: "source text" } },
			{ type: "document", content: "document text" },
			{ type: "text", text: "after attachment" },
			{ type: "tool_use", id: "second-tool", name: "Bash", input: { command: "not counted" } },
			{ type: "system_injection", modelText: "native projection", text: "display projection" },
			{ type: "reasoning", text: "reasoning text" },
		];
		const content = [...retained, { type: "text", text: "removed" }];
		const body = JSON.stringify(content);
		const contentDigest = hash(body);
		const fixed = content.map((block, i) => {
			const digest = hash(JSON.stringify(block));
			return {
				key: hash(JSON.stringify(["char-message", contentDigest, i, digest])),
				digest,
				type: block.type,
				toolUseId: block.type === "tool_use" ? block.id : null,
				action: i === retained.length ? "remove" : "retain",
			};
		});
		const worker = new Worker(REWRITE_WORKER, { eval: true });
		try {
			const response = new Promise<{ contextCharsJson: string; error?: string }>(
				(resolve, reject) => {
					worker.once("message", resolve);
					worker.once("error", reject);
				},
			);
			worker.postMessage({
				message: {
					id: "char-message",
					contentDigest,
					blockCount: content.length,
					removedBlockCount: 1,
				},
				blocks: fixed,
				body,
				role,
				limit: FILE_CHANGE_LIMITS.historyCowBytes,
			});
			const result = await response;
			expect(result.error).toBeUndefined();
			expect(JSON.parse(result.contextCharsJson)).toEqual(measureMessageCharacters(role, retained));
		} finally {
			await worker.terminate();
		}
	});
}

describe("fixed selector history application", () => {
	for (const kind of ["all", "from_seq", "messages"] as const)
		test(`${kind} removes exactly the fixed refs/messages`, async () => {
			const first = message(1);
			const second = message(2);
			const third = message(3);
			const selector: FileChangeRevertSelector =
				kind === "all"
					? { kind }
					: kind === "from_seq"
						? { kind, minSeq: 2 }
						: { kind, messageIds: [second, third] };
			const token = await prepare(selector);
			expect(count("narrator_messages")).toBe(3);
			const result = apply(token);
			expect(body(first) !== undefined).toBe(kind !== "all");
			expect(body(second)).toBeUndefined();
			expect(body(third)).toBeUndefined();
			expect(version()).toBe(8);
			expect(version("fork")).toBe(7);
			expect(result.affectedNarratorIds).toEqual(["root"]);
			expect(query("SELECT api_conversation_id FROM narrators WHERE id='root'")[0]).toEqual({
				api_conversation_id: null,
			});
		});
	test("after_block rewrites boundary and deletes following messages in the same apply", async () => {
		const target = withTools();
		const later = message(2);
		apply(
			await prepare({ kind: "after_block", messageId: target.messageId, keepThroughBlockIndex: 1 }),
		);
		expect(JSON.parse(body(target.messageId))).toHaveLength(2);
		expect(
			query<{ context_chars_json: string }>(
				"SELECT context_chars_json FROM narrator_messages WHERE id=?",
				target.messageId,
			)[0].context_chars_json,
		).toBe(
			JSON.stringify({
				segments: [
					{ category: "assistant", chars: 4 },
					{ category: "toolCall", chars: 0, toolUseId: "a" },
				],
			}),
		);
		expect(body(later)).toBeUndefined();
		expect(query<{ id: string }>("SELECT id FROM narrator_tool_calls").map((r) => r.id)).toEqual([
			target.tools[0],
		]);
		expect(
			query(
				"SELECT tree_hash_after,snapshot_commit_sha FROM narrator_messages WHERE id=?",
				target.messageId,
			)[0],
		).toEqual({ tree_hash_after: null, snapshot_commit_sha: null });
		expect(version()).toBe(8);
	});
	test("after_block retaining only text preserves text-only snapshot boundary", async () => {
		const id = message(1, [
			{ type: "text", text: "one" },
			{ type: "text", text: "two" },
		]);
		apply(await prepare({ kind: "after_block", messageId: id, keepThroughBlockIndex: 0 }));
		expect(
			query<{ tree_hash_after: string }>(
				"SELECT tree_hash_after FROM narrator_messages WHERE id=?",
				id,
			)[0].tree_hash_after,
		).toBe("tree");
	});
	test("precise PK deletion never globally deletes duplicate provider IDs", async () => {
		const a = withTools(1, ["duplicate"]);
		const b = withTools(2, ["duplicate"]);
		apply(await prepare({ kind: "tool_calls", toolCallIds: [a.tools[0], a.tools[0]] }));
		expect(count("narrator_tool_calls")).toBe(1);
		expect(query<{ id: string }>("SELECT id FROM narrator_tool_calls")[0].id).toBe(b.tools[0]);
		expect(JSON.parse(body(a.messageId))).toEqual([{ type: "text", text: "keep" }]);
		expect(JSON.parse(body(b.messageId))).toHaveLength(2);
	});
	test("full shared selection unlinks only owner ref and preserves other's message/tools", async () => {
		const target = withTools();
		ref(target.messageId, "other", 1);
		const original = body(target.messageId);
		const selection = await select();
		expect(selection.history.messages[0].action).toBe("unlink");
		apply(await service.prepare({ principal, fixedSelection: selection }));
		expect(body(target.messageId)).toBe(original);
		expect(count("narrator_tool_calls")).toBe(2);
		expect(
			query<{ narrator_id: string }>("SELECT narrator_id FROM narrator_message_refs").map(
				(r) => r.narrator_id,
			),
		).toEqual(["other"]);
		expect(version("other")).toBe(7);
		expect(authorized).not.toContain("other");
	});
	test("two selected shared tools cause ONE COW; preserve original owner, role, raw JSON and earliest execution origin", async () => {
		const target = withTools(1, ["a", "b", "keep"]);
		const ownerRef = ref(target.messageId, "fork", 1, { isCompact: 1 });
		ref(target.messageId, "other", 1);
		const kept = target.tools[2];
		const op = operation(kept);
		sqlite
			.query(
				"UPDATE narrator_tool_calls SET execution_origin_tool_call_id=?, input_json=?, output_json=?, owned_paths_json=? WHERE id=?",
			)
			.run(
				"earliest-execution-pk",
				'{ "large":9007199254740993,"escaped":"\\u0061" }',
				'{ "result":-0 }',
				'[ "x" ]',
				kept,
			);
		sqlite
			.query("UPDATE file_change_operations SET source_id=?,tool_call_id=? WHERE id=?")
			.run("earliest-execution-pk", "earliest-execution-pk", op);
		sqlite.query("UPDATE narrators SET fork_message_id=? WHERE id='fork'").run(target.messageId);
		sqlite
			.query(
				"UPDATE narrator_messages SET role='disp',origin='system',original_content_json=?,turn_usage_json=? WHERE id=?",
			)
			.run('[ { "text":"original" } ]', '{ "count":9007199254740993 }', target.messageId);
		const original = body(target.messageId);
		const token = await prepare(
			{ kind: "tool_calls", toolCallIds: [target.tools[0], target.tools[1], target.tools[0]] },
			"fork",
		);
		const result = apply(token);
		expect(result.replacements).toHaveLength(1);
		expect(result.replacements[0].refId).toBe(ownerRef);
		const clonedId = result.replacements[0].messageId;
		expect(count("narrator_messages")).toBe(2);
		expect(body(target.messageId)).toBe(original);
		expect(JSON.parse(body(clonedId))).toHaveLength(2);
		const cloned = query<Record<string, unknown>>(
			"SELECT narrator_id,role,origin,original_content_json,turn_usage_json,tree_hash_after,snapshot_commit_sha,compact_pending FROM narrator_messages WHERE id=?",
			clonedId,
		)[0];
		expect(cloned).toEqual({
			narrator_id: "root",
			role: "disp",
			origin: "system",
			original_content_json: '[ { "text":"original" } ]',
			turn_usage_json: '{ "count":9007199254740993 }',
			tree_hash_after: null,
			snapshot_commit_sha: null,
			compact_pending: 0,
		});
		const calls = query<{
			id: string;
			narrator_id: string;
			execution_origin_tool_call_id: string;
			file_change_operation_id: string;
			input_json: string;
			output_json: string;
			owned_paths_json: string;
			started_at: string;
		}>(
			"SELECT id,narrator_id,execution_origin_tool_call_id,file_change_operation_id,input_json,output_json,owned_paths_json,started_at FROM narrator_tool_calls WHERE message_id=?",
			clonedId,
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].id).not.toBe(kept);
		expect(calls[0]).toMatchObject({
			narrator_id: "root",
			execution_origin_tool_call_id: "earliest-execution-pk",
			file_change_operation_id: op,
			input_json: '{ "large":9007199254740993,"escaped":"\\u0061" }',
			output_json: '{ "result":-0 }',
			owned_paths_json: '[ "x" ]',
			started_at: time,
		});
		expect(count("file_change_operations")).toBe(1);
		expect(count("file_change_effects")).toBe(1);
		expect(query("SELECT is_compact FROM narrator_message_refs WHERE id=?", ownerRef)[0]).toEqual({
			is_compact: 1,
		});
		expect(
			query<{ fork_message_id: string }>("SELECT fork_message_id FROM narrators WHERE id='fork'")[0]
				.fork_message_id,
		).toBe(clonedId);
		expect(version("fork")).toBe(8);
		expect(version()).toBe(7);
		expect(version("other")).toBe(7);
		// A history clone with an origin is not a new attempt; collector follows the same evidence.
		const next = await select({ kind: "tool_calls", toolCallIds: [calls[0].id] }, "fork");
		expect(next.operations.map((row) => row.id)).toEqual([op]);
		expect(next.evidenceComplete).toBe(true);
	});
	test("retained block byte spelling and JSON numeric semantics survive worker rewrite", async () => {
		const retained =
			'{ "type":"text", "text":"a,]\\"b", "n":9007199254740993, "z":-0, "escaped":"\\u0061" }';
		const id = message(
			1,
			[],
			"root",
			`[${retained},{"type":"tool_use","id":"x","name":"Read","input":{}}]`,
		);
		const call = tool(id, "x");
		apply(await prepare({ kind: "tool_calls", toolCallIds: [call] }));
		expect(body(id)).toBe(`[${retained}]`);
		expect(count("narrator_tool_calls")).toBe(0);
	});
	test("failure tools are removed while effect/operation records survive", async () => {
		const target = withTools();
		const op = operation(target.tools[0]);
		question(target.tools[0]);
		const before = query("SELECT * FROM file_change_effects WHERE operation_id=?", op);
		apply(await prepare({ kind: "tool_calls", toolCallIds: [target.tools[0]] }));
		expect(query("SELECT id FROM narrator_tool_calls WHERE id=?", target.tools[0])).toHaveLength(0);
		expect(count("narrator_questions")).toBe(0);
		expect(count("file_change_operations")).toBe(1);
		expect(query("SELECT * FROM file_change_effects WHERE operation_id=?", op)).toEqual(before);
	});
	test("no_dispatch, spec and read-only histories are applied without inventing file executions", async () => {
		const target = withTools(1, ["rejected", "virtual", "read"]);
		operation(target.tools[0], "no_dispatch");
		db.update(schema.narratorToolCalls)
			.set({
				toolName: "Edit",
				executionPathFlavor: "spec",
				resolvedFilePath: "spec://tasks.json",
				canonicalFilePath: "spec://tasks.json",
			})
			.where(eq(schema.narratorToolCalls.id, target.tools[1]))
			.run();
		const selection = await select();
		expect(selection.noDiskTools.map((r) => r.reason)).toEqual([
			"no_dispatch",
			"spec",
			"read_only",
		]);
		apply(await service.prepare({ principal, fixedSelection: selection }));
		expect(count("narrator_messages")).toBe(0);
		expect(count("file_change_effects")).toBe(0);
		expect(count("file_change_operations")).toBe(1);
	});
});

describe("manifest associations and real FK behavior", () => {
	test("explicit cascade rows, SET NULL and fork pointers are included atomically", async () => {
		const target = withTools();
		question(target.tools[0]);
		db.insert(schema.narratorToolContinuations)
			.values({
				id: "continuation",
				narratorId: "root",
				toolCallId: target.tools[0],
				updateEpoch: "epoch",
				kind: "deferred_tool",
				createdAt: time,
				updatedAt: time,
			})
			.run();
		db.insert(schema.narratorPatches)
			.values({
				id: "patch",
				narratorId: "root",
				messageId: target.messageId,
				toolUseId: "a",
				beforeHash: "before",
				afterHash: "after",
				filesJson: [],
				createdAt: time,
			})
			.run();
		sqlite.query("UPDATE narrators SET fork_message_id=? WHERE id='fork'").run(target.messageId);
		const selection = await select();
		expect(selection.history.associations.map((r) => r.table)).toContain("narrator_patches");
		apply(await service.prepare({ principal, fixedSelection: selection }));
		for (const table of [
			"narrator_messages",
			"narrator_tool_calls",
			"narrator_questions",
			"narrator_patches",
			"narrator_tool_continuations",
		])
			expect(count(table)).toBe(0);
		expect(query("SELECT fork_message_id FROM narrators WHERE id='fork'")[0]).toEqual({
			fork_message_id: null,
		});
		expect(version()).toBe(8);
		expect(version("fork")).toBe(8);
	});
	test("every SET NULL association keeps its large payload and both knowledge pointers clear once", async () => {
		const target = withTools();
		db.insert(schema.apiRequests)
			.values({
				id: "request",
				messageId: target.messageId,
				createdAt: time,
				provider: "fixture",
				model: "fixture",
				rawDumpJson: '{"raw":"do not load or erase"}',
			})
			.run();
		db.insert(schema.specNamespaces)
			.values({ id: "namespace", narratorId: "root", createdAt: time, updatedAt: time })
			.run();
		db.insert(schema.specFileRevisions)
			.values({
				id: "revision",
				namespaceId: "namespace",
				path: "tasks.json",
				content: "private revision",
				contentHash: hash("private revision"),
				sourceMessageId: target.messageId,
				createdAt: time,
			})
			.run();
		db.insert(schema.projects)
			.values({
				id: "project",
				name: "fixture",
				gitPath: "/not-used",
				createdAt: time,
				updatedAt: time,
			})
			.run();
		db.insert(schema.chapters)
			.values({
				id: "chapter",
				projectId: "project",
				title: "fixture",
				branch: "fixture",
				baseBranch: "main",
				createdAt: time,
				updatedAt: time,
			})
			.run();
		db.insert(schema.chapterCommits)
			.values({
				id: "commit",
				chapterId: "chapter",
				sha: "not-a-real-git-commit",
				message: "fixture",
				authoredAt: time,
				createdAt: time,
				narratorMessageId: target.messageId,
			})
			.run();
		db.insert(schema.knowledgeCollections)
			.values({
				id: "collection",
				name: "fixture",
				slug: "fixture",
				createdAt: time,
				updatedAt: time,
			})
			.run();
		db.insert(schema.knowledgeEntries)
			.values({
				id: "entry",
				collectionId: "collection",
				title: "fixture",
				slug: "entry",
				createdAt: time,
				updatedAt: time,
			})
			.run();
		db.insert(schema.knowledgeInjectionEvents)
			.values({
				id: "knowledge",
				narratorId: "root",
				compactSeq: -1,
				entryId: "entry",
				source: "tool_output",
				triggerMessageId: target.messageId,
				triggerToolCallId: target.tools[0],
				summary: "preserve",
				createdAt: time,
			})
			.run();
		const fixedSelection = await select();
		const edges = fixedSelection.history.associations.filter((edge) => edge.id === "knowledge");
		expect(edges).toHaveLength(2);
		apply(await service.prepare({ principal, fixedSelection }));
		expect(
			query("SELECT message_id,raw_dump_json FROM api_requests WHERE id='request'")[0],
		).toEqual({ message_id: null, raw_dump_json: '{"raw":"do not load or erase"}' });
		expect(
			query("SELECT source_message_id,content FROM spec_file_revisions WHERE id='revision'")[0],
		).toEqual({ source_message_id: null, content: "private revision" });
		expect(query("SELECT narrator_message_id FROM chapter_commits WHERE id='commit'")[0]).toEqual({
			narrator_message_id: null,
		});
		expect(
			query(
				"SELECT trigger_message_id,trigger_tool_call_id,summary FROM knowledge_injection_events WHERE id='knowledge'",
			)[0],
		).toEqual({ trigger_message_id: null, trigger_tool_call_id: null, summary: "preserve" });
		expect(version()).toBe(8);
	});
	test("segmentCompact refs unhide only fixed authorized rows and narrator version increments once", async () => {
		const compact = message(1, [{ type: "compact", status: "compacted", summary: "summary" }]);
		const hidden = message(2);
		sqlite
			.query("UPDATE narrator_message_refs SET segment_compact_id=? WHERE message_id=?")
			.run(compact, hidden);
		const selection = await select({ kind: "messages", messageIds: [compact] });
		expect(selection.history.associations.some((r) => r.table === "narrator_message_refs")).toBe(
			true,
		);
		apply(await service.prepare({ principal, fixedSelection: selection }));
		expect(body(hidden)).toBeDefined();
		expect(
			query("SELECT segment_compact_id FROM narrator_message_refs WHERE message_id=?", hidden)[0],
		).toEqual({ segment_compact_id: null });
		expect(version()).toBe(8);
	});
	test("segmentCompact cannot authorize an unrelated narrator not authorized by collector", async () => {
		const compact = message(1, [{ type: "compact", status: "compacted" }]);
		const other = message(1, [], "other");
		sqlite
			.query("UPDATE narrator_message_refs SET segment_compact_id=? WHERE message_id=?")
			.run(compact, other);
		await expect(prepare({ kind: "messages", messageIds: [compact] })).rejects.toMatchObject({
			code: "REVERT_HISTORY_UNAUTHORIZED_ASSOCIATION",
		});
		expect(count("narrator_messages")).toBe(2);
	});
	test("new inbound FK/cascade through a leaf is explicitly unsupported, never implicit SQL expansion", async () => {
		const target = withTools();
		const q = question(target.tools[0]);
		sqlite.exec(
			"CREATE TABLE unplanned_leaf(id TEXT PRIMARY KEY, question_id TEXT REFERENCES narrator_questions(id) ON DELETE CASCADE)",
		);
		sqlite.query("INSERT INTO unplanned_leaf VALUES('leaf',?)").run(q);
		await expect(prepare()).rejects.toMatchObject({
			code: "REVERT_HISTORY_UNSUPPORTED_ASSOCIATION",
		});
		expect(count("unplanned_leaf")).toBe(1);
		expect(count("narrator_tool_calls")).toBe(2);
	});
	test("unreviewed triggers cannot create unmanifested cascade rows during apply", async () => {
		withTools();
		sqlite.exec(
			"CREATE TRIGGER hidden_mutation AFTER DELETE ON narrator_message_refs BEGIN UPDATE narrators SET title='unplanned'; END",
		);
		await expect(prepare()).rejects.toMatchObject({
			code: "REVERT_HISTORY_UNSUPPORTED_ASSOCIATION",
		});
		expect(count("narrator_message_refs")).toBe(1);
	});
	test("reviewed live FTS triggers and generated columns remain enabled during rewrite", async () => {
		sqlite.exec(
			"CREATE VIRTUAL TABLE narrator_messages_fts USING fts5(content_text,content='narrator_messages',content_rowid=rowid,tokenize='trigram'); CREATE VIRTUAL TABLE narrators_fts USING fts5(title,content='narrators',content_rowid=rowid,tokenize='trigram')",
		);
		const triggers = isolatedTemplate
			.query<{ sql: string }, []>(
				"SELECT sql FROM sqlite_schema WHERE type='trigger' AND (name GLOB 'narrator_messages_fts_*' OR name GLOB 'narrators_fts_*') LIMIT 10",
			)
			.all();
		expect(triggers).toHaveLength(6);
		for (const trigger of triggers) sqlite.exec(trigger.sql);
		const target = withTools();
		apply(await prepare({ kind: "tool_calls", toolCallIds: [target.tools[0]] }));
		expect(
			scalar(
				"SELECT count(*) AS n FROM narrator_messages_fts WHERE narrator_messages_fts MATCH 'keep'",
			),
		).toBe(1);
	});
	test("real subagents use exact originating PK; ordinary fork and other child remain untouched", async () => {
		const rootMessage = message(1, [
			{ type: "tool_use", id: "agent-provider", name: "Agent", input: {} },
		]);
		const agent = tool(rootMessage, "agent-provider", "Agent");
		narrator("child", "alice", {
			type: "subagent",
			parentNarratorId: "root",
			aclRootNarratorId: "root",
			originToolCallId: agent,
		});
		narrator("different-child", "alice", {
			type: "subagent",
			parentNarratorId: "root",
			aclRootNarratorId: "root",
			originToolCallId: "different-execution",
		});
		const selectedChild = withTools(1, ["child-read"], "child");
		const unrelated = withTools(1, ["other-child-read"], "different-child");
		const ordinary = message(1, [], "fork");
		sqlite.query("UPDATE narrators SET parent_narrator_id='root' WHERE id='fork'").run();
		sqlite
			.query("UPDATE narrator_messages SET parent_tool_use_id='agent-provider' WHERE id=?")
			.run(selectedChild.messageId);
		const selection = await select();
		expect(selection.history.messages.map((r) => r.narratorId)).toContain("child");
		apply(await service.prepare({ principal, fixedSelection: selection }));
		expect(body(rootMessage)).toBeUndefined();
		expect(body(selectedChild.messageId)).toBeUndefined();
		expect(body(unrelated.messageId)).toBeDefined();
		expect(body(ordinary)).toBeDefined();
		expect(version()).toBe(8);
		expect(version("child")).toBe(8);
		expect(version("different-child")).toBe(7);
	});
	test("ambiguous provider-ID child history is refused rather than deleted", async () => {
		// HEAD deliberately excludes Read from child expansion. This ambiguity guard
		// needs an actual delegation call in both the persisted body and tool row.
		const messageId = message(1, [
			{ type: "text", text: "keep" },
			{ type: "tool_use", id: "same", name: "Task", input: { prompt: "fixture" } },
		]);
		const target = { messageId, tools: [tool(messageId, "same", "Task")] };
		const other = message(1, [], "other");
		sqlite.query("UPDATE narrator_messages SET parent_tool_use_id='same' WHERE id=?").run(other);
		await expect(
			prepare({ kind: "tool_calls", toolCallIds: [target.tools[0]] }),
		).rejects.toMatchObject({ code: "REVERT_SELECTION_CHILD_ORIGIN_UNVERIFIED" });
		expect(body(other)).toBeDefined();
	});
});

describe("drift, ACL and capability/transaction boundaries", () => {
	for (const kind of ["body", "ref", "tool", "association", "shared", "metadata"] as const)
		test(`plan-to-prepare ${kind} drift fails closed`, async () => {
			const target = withTools();
			const fixedSelection = await select();
			if (kind === "body")
				sqlite
					.query("UPDATE narrator_messages SET content_json='[]' WHERE id=?")
					.run(target.messageId);
			if (kind === "ref")
				sqlite
					.query("UPDATE narrator_message_refs SET seq=8 WHERE message_id=?")
					.run(target.messageId);
			if (kind === "tool")
				sqlite
					.query("UPDATE narrator_tool_calls SET tool_name='Glob' WHERE id=?")
					.run(target.tools[0]);
			if (kind === "association") question(target.tools[0]);
			if (kind === "shared") ref(target.messageId, "other", 1);
			if (kind === "metadata")
				sqlite
					.query("UPDATE narrator_messages SET tree_hash_after='other' WHERE id=?")
					.run(target.messageId);
			await expect(service.prepare({ principal, fixedSelection })).rejects.toBeDefined();
			expect(count("narrator_messages")).toBe(1);
			expect(version()).toBe(7);
		});
	for (const kind of [
		"body",
		"ref",
		"tool",
		"association",
		"shared",
		"unrelated",
		"rollback",
	] as const)
		test(`prepare-to-apply ${kind} drift fails with no partial mutation`, async () => {
			const target = withTools();
			const token = await prepare();
			if (kind === "body")
				sqlite.query("UPDATE narrator_messages SET role='disp' WHERE id=?").run(target.messageId);
			if (kind === "ref")
				sqlite
					.query("UPDATE narrator_message_refs SET is_compact=1 WHERE message_id=?")
					.run(target.messageId);
			if (kind === "tool")
				sqlite
					.query("UPDATE narrator_tool_calls SET output_json='{}' WHERE id=?")
					.run(target.tools[0]);
			if (kind === "association") question(target.tools[0]);
			if (kind === "shared") ref(target.messageId, "other", 1);
			if (kind === "unrelated")
				sqlite.query("UPDATE narrators SET title='changed' WHERE id='other'").run();
			if (kind === "rollback")
				expect(() =>
					db.transaction(() => {
						sqlite.query("UPDATE narrators SET title='rollback' WHERE id='other'").run();
						throw Error("rollback");
					}),
				).toThrow("rollback");
			expect(() => apply(token)).toThrow("Database changed");
			expect(count("narrator_messages")).toBe(1);
			expect(count("narrator_tool_calls")).toBe(2);
			expect(version()).toBe(7);
		});
	test("external connection data_version rejects an unrelated committed write", async () => {
		const filename = join(process.env.HOME as string, `history-${Date.now()}.sqlite`);
		const fileDb = new Database(filename);
		connections.push(fileDb);
		seedSchema(fileDb);
		fileDb.exec("PRAGMA journal_mode=WAL");
		fileDb
			.query(
				"INSERT INTO users(id,username,password_hash,created_at) VALUES('alice','alice','x',?)",
			)
			.run(time);
		fileDb
			.query(
				"INSERT INTO narrators(id,owner_user_id,message_version,created_at,updated_at) VALUES('root','alice',7,?,?)",
			)
			.run(time, time);
		fileDb
			.query(
				"INSERT INTO narrator_messages(id,narrator_id,role,content_json,created_at) VALUES('m','root','assistant','[]',?)",
			)
			.run(time);
		fileDb
			.query(
				"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES('r','root','m',1)",
			)
			.run();
		const fileRoot = database(fileDb);
		const fileService = new RevertHistoryCommitService(fileRoot, { authorize });
		const fileSelection = await new RevertSelectionService(fileRoot, { authorize }).collect({
			principal,
			narratorId: "root",
			expectedMessageVersion: 7,
			selector: { kind: "all" },
		});
		const token = await fileService.prepare({ principal, fixedSelection: fileSelection });
		const external = new Database(filename);
		connections.push(external);
		external.query("UPDATE narrators SET title='external' WHERE id='root'").run();
		expect(() => fileRoot.transaction((tx) => fileService.applyToTransaction(tx, token))).toThrow(
			"Database changed",
		);
	});
	test("ACL reauthorization failure and writes inside await reject prepare", async () => {
		withTools();
		const fixedSelection = await select();
		onAuthorize = () => {
			throw Error("ACL revoked");
		};
		await expect(service.prepare({ principal, fixedSelection })).rejects.toThrow("ACL revoked");
		onAuthorize = () => {
			sqlite.query("UPDATE narrators SET title='during-ACL' WHERE id='other'").run();
		};
		await expect(service.prepare({ principal, fixedSelection })).rejects.toBeDefined();
		expect(count("narrator_messages")).toBe(1);
	});
	test("fake/mutable prepared, root-as-tx, different root and reused capabilities are rejected", async () => {
		withTools();
		const token = await prepare();
		expect(Object.isFrozen(token)).toBe(true);
		expect(Object.keys(token)).toEqual([]);
		expect(() => apply({} as PreparedRevertHistory)).toThrow("Unknown");
		expect(() => service.applyToTransaction(db, token)).toThrow("active transaction");
		expect(() => db.transaction(() => service.applyToTransaction(db, token))).toThrow(
			"active transaction",
		);
		const otherDb = new Database(":memory:");
		connections.push(otherDb);
		otherDb.exec("PRAGMA foreign_keys=ON");
		const otherRoot = database(otherDb);
		expect(() => otherRoot.transaction((tx) => service.applyToTransaction(tx, token))).toThrow(
			"active transaction",
		);
		const otherService = new RevertHistoryCommitService(db, { authorize });
		expect(() => db.transaction((tx) => otherService.applyToTransaction(tx, token))).toThrow(
			"Unknown",
		);
		apply(token);
		expect(() => apply(token)).toThrow("Unknown");
	});
	test("prepare rejects ambient transactions and mandatory ACL cannot be omitted", async () => {
		withTools();
		const fixedSelection = await select();
		let pending: Promise<PreparedRevertHistory> | undefined;
		db.transaction(() => {
			pending = service.prepare({ principal, fixedSelection });
		});
		await expect(pending).rejects.toThrow("ambient");
		expect(() => new RevertHistoryCommitService(db, {} as never)).toThrow("ACL");
		expect(() =>
			db.transaction((tx) => new RevertHistoryCommitService(tx as never, { authorize })),
		).toThrow();
	});
	test("unsafe SQLite waits are rejected without changing the caller connection", async () => {
		withTools();
		const fixedSelection = await select();
		sqlite.exec("PRAGMA busy_timeout=1000;");
		expect(() => new RevertHistoryCommitService(db, { authorize })).toThrow("busy_timeout");
		await expect(service.prepare({ principal, fixedSelection })).rejects.toThrow("busy_timeout");
		expect(query<{ timeout: number }>("PRAGMA busy_timeout")[0].timeout).toBe(1000);
		expect(count("narrator_messages")).toBe(1);
	});

	test("changing busy_timeout after prepare invalidates the synchronous history capability", async () => {
		withTools();
		const token = await prepare();
		sqlite.exec("PRAGMA busy_timeout=1000;");
		expect(() => apply(token)).toThrow("Database changed");
		expect(count("narrator_messages")).toBe(1);
		expect(query<{ timeout: number }>("PRAGMA busy_timeout")[0].timeout).toBe(1000);
	});

	test("fixed input mutations after prepare starts do not replace private data", async () => {
		const target = withTools();
		const fixedSelection = await select({ kind: "tool_calls", toolCallIds: [target.tools[0]] });
		const pending = service.prepare({ principal, fixedSelection });
		fixedSelection.selector = { kind: "all" };
		fixedSelection.history.messages.length = 0;
		apply(await pending);
		expect(body(target.messageId)).toBeDefined();
		expect(count("narrator_tool_calls")).toBe(1);
	});
	test("fake version/ref/block commitments are not accepted merely because digest matches", async () => {
		const target = withTools();
		const original = await select();
		for (const kind of ["version", "ref", "block"]) {
			const fixedSelection = structuredClone(original);
			if (kind === "version") fixedSelection.messageVersions[0].messageVersion++;
			if (kind === "ref") fixedSelection.history.messages[0].refId = "fake-ref";
			if (kind === "block") fixedSelection.history.blocks[0].key = "fake-block";
			await expect(service.prepare({ principal, fixedSelection })).rejects.toBeDefined();
		}
		expect(body(target.messageId)).toBeDefined();
	});
	test("aborted prepared cannot mutate history", async () => {
		withTools();
		const fixedSelection = await select();
		const controller = new AbortController();
		const token = await service.prepare({ principal, fixedSelection, signal: controller.signal });
		controller.abort();
		expect(() => apply(token)).toThrow();
		expect(count("narrator_messages")).toBe(1);
	});
});

describe("prepared question lifecycle", () => {
	function answer(
		questionId: string,
		seq: number,
		kind: "answer" | "supplement" | "dismissal" = "answer",
		resolution: unknown = null,
	) {
		const id = message(seq);
		db.insert(schema.narratorQuestionEvents)
			.values({
				questionId,
				messageId: id,
				kind,
				createdAt: `${time}-${seq}`,
				resolutionJson:
					resolution as typeof schema.narratorQuestionEvents.$inferInsert.resolutionJson,
			})
			.run();
		sqlite
			.query(
				"UPDATE narrator_questions SET status=?,answer_message_id=?,answers_json=?,annotations_json=?,resolution_json=? WHERE id=?",
			)
			.run(
				kind === "dismissal" ? "dismissed" : "answered",
				id,
				'{"answer":"yes"}',
				'{"answer":"note"}',
				resolution ? JSON.stringify(resolution) : null,
				questionId,
			);
		return id;
	}
	function receipt(messageId: string) {
		const id = `receipt-${serial++}`;
		db.insert(schema.narratorBufferedMessages)
			.values({
				id,
				narratorId: "root",
				text: "receipt",
				seq: 1,
				bufferedAt: time,
				kind: "task_notice",
				noticeKind: "agent",
				sourceKey: `question-answer:${messageId}`,
				recipientMessageId: messageId,
				state: "claimed",
				claimToken: "claim",
				claimEpoch: "epoch",
				claimedAt: time,
			})
			.run();
		return id;
	}
	test("deleting the latest supplement restores the prior event and its resolution", async () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		const note = { answerMessageId: "first", note: "used", actor: "root", resolvedAt: time };
		const first = answer(q, 2, "answer", note);
		const latest = answer(q, 3, "supplement");
		const inbox = receipt(latest);
		const token = await prepare({ kind: "messages", messageIds: [latest] });
		const result = apply(token);
		expect(result.affectedQuestionIds).toEqual([q]);
		const restored = db
			.select()
			.from(schema.narratorQuestions)
			.where(eq(schema.narratorQuestions.id, q))
			.get();
		expect(restored?.answerMessageId).toBe(first);
		expect(restored?.resolutionJson).toEqual(note);
		expect(restored?.status).toBe("answered");
		expect(count("narrator_question_events")).toBe(1);
		expect(
			query<{ state: string; receipt_disposition: string; claim_token: string | null }>(
				"SELECT state,receipt_disposition,claim_token FROM narrator_buffered_messages WHERE id=?",
				inbox,
			)[0],
		).toEqual({ state: "cancelled", receipt_disposition: "recipient_deleted", claim_token: null });
	});
	test("same-millisecond events restore their actual insertion order rather than random message IDs", async () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		serial = 9;
		answer(q, 2);
		const previous = answer(q, 3, "supplement");
		const latest = answer(q, 4, "supplement");
		sqlite
			.query("UPDATE narrator_question_events SET created_at=? WHERE question_id=?")
			.run(time, q);
		apply(await prepare({ kind: "messages", messageIds: [latest] }));
		expect(
			query<{ answer_message_id: string }>(
				"SELECT answer_message_id FROM narrator_questions WHERE id=?",
				q,
			)[0].answer_message_id,
		).toBe(previous);
	});
	test("deleting the only answer reopens the question and clears response fields", async () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		const event = answer(q, 2);
		apply(await prepare({ kind: "messages", messageIds: [event] }));
		const row = db
			.select()
			.from(schema.narratorQuestions)
			.where(eq(schema.narratorQuestions.id, q))
			.get();
		expect(row?.status).toBe("open");
		expect(row?.answerMessageId).toBeNull();
		expect(row?.answersJson).toBeNull();
		expect(row?.annotationsJson).toBeNull();
		expect(row?.resolutionJson).toBeNull();
	});
	test("original-owner answer unlink restores state even if the fork retains the physical message", async () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		const event = answer(q, 2);
		ref(event, "fork", 2);
		apply(await prepare({ kind: "messages", messageIds: [event] }));
		expect(
			query<{ status: string }>("SELECT status FROM narrator_questions WHERE id=?", q)[0].status,
		).toBe("open");
		expect(query("SELECT id FROM narrator_messages WHERE id=?", event)).toHaveLength(1);
		expect(count("narrator_question_events")).toBe(0);
	});
	test("fork-only answer unlink cannot mutate the original owner's active question", async () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		const event = answer(q, 2);
		ref(event, "fork", 2);
		const result = apply(await prepare({ kind: "messages", messageIds: [event] }, "fork"));
		expect(result.affectedQuestionIds).toEqual([]);
		expect(
			query<{ status: string }>("SELECT status FROM narrator_questions WHERE id=?", q)[0].status,
		).toBe("answered");
		expect(count("narrator_question_events")).toBe(1);
	});
	test("original-owner creation unlink withdraws the retained question and cancels pending receipts", async () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		ref(creation.messageId, "fork", 1);
		const event = answer(q, 2);
		const inbox = receipt(event);
		apply(await prepare({ kind: "messages", messageIds: [creation.messageId] }));
		expect(
			query<{ status: string; withdraw_reason: string }>(
				"SELECT status,withdraw_reason FROM narrator_questions WHERE id=?",
				q,
			)[0],
		).toEqual({
			status: "withdrawn",
			withdraw_reason: "Question creation was removed from history.",
		});
		expect(
			query<{ state: string }>("SELECT state FROM narrator_buffered_messages WHERE id=?", inbox)[0]
				.state,
		).toBe("cancelled");
		expect(query("SELECT id FROM narrator_tool_calls WHERE id=?", creation.tools[0])).toHaveLength(
			1,
		);
	});
	test("physical question deletion explicitly deletes all historical event leaves", async () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		answer(q, 2);
		answer(q, 3, "supplement");
		const result = apply(await prepare({ kind: "messages", messageIds: [creation.messageId] }));
		expect(result.affectedQuestionIds).toEqual([q]);
		expect(count("narrator_questions")).toBe(0);
		expect(count("narrator_question_events")).toBe(0);
		expect(count("narrator_messages")).toBe(2);
	});
	test("an unknown FK referencing question-event leaves is rejected even when empty", async () => {
		withTools();
		sqlite.exec(
			"CREATE TABLE unexpected_event_leaf (id TEXT PRIMARY KEY,event_id TEXT REFERENCES narrator_question_events(message_id) ON DELETE CASCADE)",
		);
		await expect(prepare()).rejects.toMatchObject({
			code: "REVERT_HISTORY_UNSUPPORTED_ASSOCIATION",
		});
	});
	test("shared partial creation removal withdraws the owner question despite retaining fork tools", async () => {
		const creation = withTools(1, ["ask", "keep"]);
		const q = question(creation.tools[0]);
		ref(creation.messageId, "fork", 1);
		apply(await prepare({ kind: "tool_calls", toolCallIds: [creation.tools[0]] }));
		expect(
			query<{ status: string }>("SELECT status FROM narrator_questions WHERE id=?", q)[0].status,
		).toBe("withdrawn");
		expect(query("SELECT id FROM narrator_tool_calls WHERE id=?", creation.tools[0])).toHaveLength(
			1,
		);
		expect(count("narrator_messages")).toBe(2);
	});
	test("deleting a supplement after a dismissal restores the dismissed status", async () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		const first = answer(q, 2, "dismissal");
		const latest = answer(q, 3, "supplement");
		apply(await prepare({ kind: "messages", messageIds: [latest] }));
		expect(
			query<{ status: string; answer_message_id: string }>(
				"SELECT status,answer_message_id FROM narrator_questions WHERE id=?",
				q,
			)[0],
		).toEqual({ status: "dismissed", answer_message_id: first });
	});
	test("question resolution history is size gated before preparing restoration bodies", async () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		const event = answer(q, 2);
		sqlite
			.query("UPDATE narrator_question_events SET resolution_json=? WHERE message_id=?")
			.run("x".repeat(4 * 1024 * 1024 + 1), event);
		await expect(prepare({ kind: "messages", messageIds: [event] })).rejects.toMatchObject({
			code: "REVERT_HISTORY_BUDGET_EXCEEDED",
		});
		expect(count("narrator_question_events")).toBe(1);
	}, 20_000);
	test("ordinary transaction helper restores answers and cancels only their question receipts", () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		const first = answer(q, 2, "answer", {
			answerMessageId: "first",
			note: "used",
			resolvedAt: time,
			actor: "root",
		});
		const latest = answer(q, 3, "supplement");
		const oldInbox = receipt(first);
		const latestInbox = receipt(latest);
		const result = db.transaction((tx) =>
			reconcileQuestionHistoryInTransaction(tx, "root", { deletedMessageIds: [latest] }),
		);
		expect(result).toEqual({ affectedQuestionIds: [q], withdrawnQuestionIds: [] });
		expect(
			query<{ answer_message_id: string }>(
				"SELECT answer_message_id FROM narrator_questions WHERE id=?",
				q,
			)[0].answer_message_id,
		).toBe(first);
		expect(
			query<{ state: string }>(
				"SELECT state FROM narrator_buffered_messages WHERE id=?",
				latestInbox,
			)[0].state,
		).toBe("cancelled");
		expect(
			query<{ state: string }>(
				"SELECT state FROM narrator_buffered_messages WHERE id=?",
				oldInbox,
			)[0].state,
		).toBe("claimed");
	});
	test("ordinary partial tool removal withdraws only the exact owner and tool identity", () => {
		const creation = withTools(1, ["ask", "keep"]);
		const q = question(creation.tools[0]);
		const otherQ = question(creation.tools[1]);
		ref(creation.messageId, "fork", 1);
		const rootResult = db.transaction((tx) =>
			reconcileQuestionHistoryInTransaction(tx, "root", {
				deletedMessageIds: [],
				deletedToolBlocks: [{ messageId: creation.messageId, toolUseId: "ask" }],
			}),
		);
		expect(rootResult).toEqual({ affectedQuestionIds: [q], withdrawnQuestionIds: [q] });
		expect(
			query<{ status: string }>("SELECT status FROM narrator_questions WHERE id=?", otherQ)[0]
				.status,
		).toBe("open");
		const forkResult = db.transaction((tx) =>
			reconcileQuestionHistoryInTransaction(tx, "fork", {
				deletedMessageIds: [creation.messageId],
			}),
		);
		expect(forkResult).toEqual({ affectedQuestionIds: [], withdrawnQuestionIds: [] });
	});
	test("ordinary question reconciliation rolls back with the caller transaction", () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		const event = answer(q, 2);
		const inbox = receipt(event);
		expect(() =>
			db.transaction((tx) => {
				reconcileQuestionHistoryInTransaction(tx, "root", { deletedMessageIds: [event] });
				throw new Error("rollback");
			}),
		).toThrow("rollback");
		expect(
			query<{ status: string }>("SELECT status FROM narrator_questions WHERE id=?", q)[0].status,
		).toBe("answered");
		expect(count("narrator_question_events")).toBe(1);
		expect(
			query<{ state: string }>("SELECT state FROM narrator_buffered_messages WHERE id=?", inbox)[0]
				.state,
		).toBe("claimed");
	});
	test("question inbox writes after prepare invalidate the fixed SQL capability", async () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		const event = answer(q, 2);
		const token = await prepare({ kind: "messages", messageIds: [event] });
		receipt(event);
		expect(() => apply(token)).toThrow("Database changed after preparation");
		expect(count("narrator_question_events")).toBe(1);
	});
});

describe("bounded preparation and synchronous atomic commit", () => {
	test("expired prepared cannot execute even without intervening writes", async () => {
		withTools();
		const token = await prepare();
		const future = Date.now() + 60_000;
		const clock = spyOn(Date, "now").mockReturnValue(future);
		try {
			expect(() => apply(token)).toThrow("Database changed");
		} finally {
			clock.mockRestore();
		}
		expect(count("narrator_messages")).toBe(1);
	});
	for (const column of [
		"input_json",
		"output_json",
		"permission_deny_message",
		"owned_paths_json",
		"error_message",
	] as const)
		test(`full COW rows count ${column}, not just contentJson`, async () => {
			const target = withTools();
			ref(target.messageId, "fork", 1);
			sqlite
				.query(`UPDATE narrator_tool_calls SET ${column}=? WHERE id=?`)
				.run("x".repeat(FILE_CHANGE_LIMITS.historyCowBytes + 1), target.tools[1]);
			await expect(
				prepare({ kind: "tool_calls", toolCallIds: [target.tools[0]] }, "fork"),
			).rejects.toMatchObject({ statusCode: 409 });
			expect(count("narrator_messages")).toBe(1);
		});
	test("message extra fields contribute to COW budget before fetching raw rows", async () => {
		const target = withTools();
		ref(target.messageId, "fork", 1);
		sqlite
			.query("UPDATE narrator_messages SET turn_usage_json=? WHERE id=?")
			.run("x".repeat(FILE_CHANGE_LIMITS.historyCowBytes + 1), target.messageId);
		await expect(
			prepare({ kind: "tool_calls", toolCallIds: [target.tools[0]] }, "fork"),
		).rejects.toMatchObject({ code: "REVERT_HISTORY_BUDGET_EXCEEDED" });
	});
	test("full delete does not SELECT or JSON-parse huge tool input/output", async () => {
		const target = withTools();
		sqlite
			.query("UPDATE narrator_tool_calls SET input_json=?,output_json=? WHERE id=?")
			.run("x".repeat(5 * 1024 * 1024), "y".repeat(5 * 1024 * 1024), target.tools[0]);
		const selected: string[] = [];
		const realQuery = sqlite.query.bind(sqlite);
		const trace = spyOn(sqlite, "query").mockImplementation(((text: string) => {
			selected.push(text);
			return realQuery(text);
		}) as typeof sqlite.query);
		try {
			apply(await prepare());
		} finally {
			trace.mockRestore();
		}
		const bodies = selected.filter(
			(s) =>
				/^SELECT\s/i.test(s) &&
				/input_json|output_json/.test(s) &&
				!/octet_length|length\(CAST/.test(s),
		);
		expect(bodies).toEqual([]);
		expect(count("narrator_tool_calls")).toBe(0);
	});
	test("10000 cascade rows reject a complete selection before apply", async () => {
		const target = withTools();
		// API requests SET NULL is one collector edge each, with no large field reads.
		const insertRequest = sqlite.query(
			"INSERT INTO api_requests(id,message_id,created_at,provider,model) VALUES(?,?,?,?,?)",
		);
		db.transaction(() => {
			for (let i = 0; i < FILE_CHANGE_LIMITS.historyToolRelatedChanges + 1; i++)
				insertRequest.run(`request-${i}`, target.messageId, time, "fixture", "fixture");
		});
		await expect(prepare()).rejects.toMatchObject({ code: "REVERT_SELECTION_BUDGET_EXCEEDED" });
		expect(count("narrator_messages")).toBe(1);
	}, 20_000);
	test("5000 message/ref changes reject before any mutation", async () => {
		const insertMessage = sqlite.query(
			"INSERT INTO narrator_messages(id,narrator_id,role,content_json,created_at) VALUES(?,'root','assistant','[]',?)",
		);
		const insertRef = sqlite.query(
			"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES(?,'root',?,?)",
		);
		db.transaction(() => {
			for (let i = 0; i <= FILE_CHANGE_LIMITS.historyMessageRefChanges / 2; i++) {
				insertMessage.run(`m-${i}`, time);
				insertRef.run(`r-${i}`, `m-${i}`, i);
			}
		});
		await expect(prepare()).rejects.toMatchObject({ code: "REVERT_SELECTION_BUDGET_EXCEEDED" });
		expect(count("narrator_messages")).toBe(2501);
		expect(version()).toBe(7);
	}, 20_000);
	test("prepared clone body growth plus retained full tools also obeys 4MiB", async () => {
		const text = "x".repeat(1024 * 1024);
		const id = message(1, [
			{ type: "text", text },
			{ type: "tool_use", id: "remove", name: "Read", input: {} },
			{ type: "tool_use", id: "keep", name: "Read", input: {} },
		]);
		const removed = tool(id, "remove");
		const kept = tool(id, "keep");
		ref(id, "fork", 1);
		sqlite
			.query("UPDATE narrator_tool_calls SET output_json=? WHERE id=?")
			.run("y".repeat(2 * 1024 * 1024 + 100), kept);
		await expect(
			prepare({ kind: "tool_calls", toolCallIds: [removed] }, "fork"),
		).rejects.toMatchObject({ code: "REVERT_HISTORY_BUDGET_EXCEEDED" });
		expect(count("narrator_messages")).toBe(1);
	});
	test("stored-schema drift cannot silently omit a new copy field", async () => {
		const target = withTools();
		ref(target.messageId, "fork", 1);
		sqlite.exec("ALTER TABLE narrator_tool_calls ADD COLUMN new_unhandled_reference TEXT");
		await expect(
			prepare({ kind: "tool_calls", toolCallIds: [target.tools[0]] }, "fork"),
		).rejects.toMatchObject({ code: "REVERT_HISTORY_UNSUPPORTED_SCHEMA" });
	});
	test("SQL failure on second ref deletion rolls back first deletion and every other mutation", async () => {
		const first = message(1);
		const second = message(2);
		const token = await prepare();
		const realQuery = sqlite.query.bind(sqlite);
		let deletes = 0;
		// Inject a real SQLite NOT NULL failure at the second native write, with the same
		// parameter arity. The first ref DELETE has actually executed on this transaction.
		const fault = spyOn(sqlite, "query").mockImplementation(((text: string) => {
			if (text.startsWith('DELETE FROM "narrator_message_refs"') && ++deletes === 2)
				return realQuery(
					"INSERT INTO narrator_messages(id,narrator_id,role,content_json,created_at) VALUES(?,?,NULL,'[]',?)",
				);
			return realQuery(text);
		}) as typeof sqlite.query);
		try {
			expect(() => apply(token)).toThrow("NOT NULL");
		} finally {
			fault.mockRestore();
		}
		expect(deletes).toBe(2);
		expect(body(first)).toBeDefined();
		expect(body(second)).toBeDefined();
		expect(count("narrator_message_refs")).toBe(2);
		expect(version()).toBe(7);
		expect(() => apply(token)).toThrow("Unknown");
	});
	for (const rollback of [false, true])
		test(`caller journal and history ${rollback ? "rollback" : "commit"} together`, async () => {
			withTools();
			sqlite.exec(
				"CREATE TABLE test_revert_journal(id TEXT PRIMARY KEY,status TEXT NOT NULL); INSERT INTO test_revert_journal VALUES('revert','files_verified')",
			);
			const token = await prepare();
			const work = () =>
				db.transaction((tx) => {
					const result = service.applyToTransaction(tx, token);
					expect(result).not.toBeInstanceOf(Promise);
					tx.run(sql`UPDATE test_revert_journal SET status='committed' WHERE id='revert'`);
					if (rollback) throw Error("journal failure");
				});
			if (rollback) expect(work).toThrow("journal failure");
			else work();
			expect(query<{ status: string }>("SELECT status FROM test_revert_journal")[0].status).toBe(
				rollback ? "files_verified" : "committed",
			);
			expect(count("narrator_messages")).toBe(rollback ? 1 : 0);
			expect(version()).toBe(rollback ? 7 : 8);
		});
	test("writes before apply, even to caller journal in same tx, are conservatively rejected", async () => {
		withTools();
		sqlite.exec("CREATE TABLE test_journal(status TEXT)");
		const token = await prepare();
		expect(() =>
			db.transaction((tx) => {
				tx.run(sql`INSERT INTO test_journal VALUES('committed')`);
				service.applyToTransaction(tx, token);
			}),
		).toThrow("Database changed");
		expect(count("test_journal")).toBe(0);
		expect(count("narrator_messages")).toBe(1);
	});
});
