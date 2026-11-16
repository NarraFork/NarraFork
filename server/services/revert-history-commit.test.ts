import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { FILE_CHANGE_LIMITS, type FileChangeRevertSelector } from "@shared/file-change-protocol";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openSchemaCopyInMemory } from "../../tests/sqlite-schema-image";
import { sqlite as isolatedTemplate } from "../db";
import * as schema from "../db/schema";
import { measureMessageCharacters } from "../lib/context-characters";
import { createMailboxStore } from "./agent-runtime/mailbox";
import type { RuntimeDb } from "./agent-runtime/mailbox-types";
import { createFileChangeIdentity, fileChangeIdentityKey } from "./file-change-identity";
import type { NarratorAclRow, NarratorPrincipal } from "./narrator-acl";
import { reconcileQuestionHistoryInTransaction } from "./narrator-question-history";
import {
	closeRevertRewriteWorkers,
	type PreparedRevertHistory,
	REWRITE_WORKER,
	RevertHistoryCommitService,
	resetRevertRewriteWorkersForTests,
} from "./revert-history-commit";
import {
	closeRevertBodyWorkers,
	RevertSelectionService,
	resetRevertBodyWorkersForTests,
} from "./revert-selection-service";
import { loadSendTargetDetails } from "./send-delivery-resolution";

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
function seedSchema(client: Database, options: { schemaAlreadyCopied?: boolean } = {}) {
	client.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;");
	if (!options.schemaAlreadyCopied) {
		const definitions = isolatedTemplate
			.query<{ sql: string }, []>(
				"SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '*_fts*' ORDER BY type DESC LIMIT 2048",
			)
			.all();
		expect(definitions.length).toBeLessThan(2048);
		for (const row of definitions) client.exec(row.sql);
	}
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
beforeEach(async () => {
	await resetRevertBodyWorkersForTests();
	await resetRevertRewriteWorkersForTests();
	expect(process.env.NARRAFORK_TEST).toBe("1");
	expect(process.env.HOME).not.toBe(process.env.NARRAFORK_ORIGINAL_HOME);
	// Byte copy of the same schema, built once per process (see tests/sqlite-schema-image.ts);
	// replaying ~550 DDL statements per case dominated this file's runtime.
	sqlite = openSchemaCopyInMemory(isolatedTemplate);
	connections = [sqlite];
	seedSchema(sqlite, { schemaAlreadyCopied: true });
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
afterEach(async () => {
	await closeRevertBodyWorkers();
	await closeRevertRewriteWorkers();
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
/** Mutate on the next await after a real synchronous read has returned its original row. */
function mutateAfterRead(matches: (text: string) => boolean, mutation: () => void) {
	let scheduled = false;
	const state = { mutated: false };
	const realQuery = sqlite.query.bind(sqlite);
	const trace = spyOn(sqlite, "query").mockImplementation(((text: string) => {
		if (!scheduled && matches(text)) {
			scheduled = true;
			queueMicrotask(() => {
				mutation();
				state.mutated = true;
			});
		}
		return realQuery(text);
	}) as typeof sqlite.query);
	return { state, restore: () => trace.mockRestore() };
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
			const requestId = `characters-${role}`;
			const response = new Promise<{
				requestId: string;
				result: { contextCharsJson: string };
				error?: string;
			}>((resolve, reject) => {
				worker.once("message", resolve);
				worker.once("error", reject);
			});
			worker.postMessage({
				requestId,
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
			const reply = await response;
			expect(reply.requestId).toBe(requestId);
			expect(reply.error).toBeUndefined();
			expect(JSON.parse(reply.result.contextCharsJson)).toEqual(
				measureMessageCharacters(role, retained),
			);
			const errorResponse = new Promise<{ requestId: string; error: string }>((resolve) => {
				worker.once("message", resolve);
			});
			worker.postMessage({
				requestId: `${requestId}-invalid`,
				message: { id: "char-message", contentDigest: hash("different body") },
				blocks: fixed,
				body,
				role,
				limit: FILE_CHANGE_LIMITS.historyCowBytes,
			});
			expect(await errorResponse).toEqual({
				requestId: `${requestId}-invalid`,
				error: "Raw body commitment changed",
			});
		} finally {
			await worker.terminate();
		}
	});
}

describe("pooled rewrite worker lifecycle", () => {
	test("separate preparations reuse one native rewrite thread without changing shared originals", async () => {
		const target = withTools();
		ref(target.messageId, "fork", 1);
		const originalBody = body(target.messageId);
		const fixedSelection = await select({ kind: "tool_calls", toolCallIds: [target.tools[0]] });
		const threads = new Set<Worker>();
		const ids = new Set<string>();
		let calls = 0;
		const original = Worker.prototype.postMessage;
		const post = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
			this: Worker,
			...args: Parameters<Worker["postMessage"]>
		) {
			if (args[0]?.message?.id) {
				threads.add(this);
				ids.add(args[0].requestId);
				calls++;
				this.emit("message", { ready: true });
			}
			return Reflect.apply(original, this, args);
		});
		try {
			await service.prepare({ principal, fixedSelection });
			const token = await service.prepare({ principal, fixedSelection });
			expect(threads.size).toBe(1);
			expect(calls).toBe(2);
			expect(ids.size).toBe(2);
			expect(body(target.messageId)).toBe(originalBody);
			const result = apply(token);
			expect(result.replacements).toHaveLength(1);
			expect(body(target.messageId)).toBe(originalBody);
		} finally {
			post.mockRestore();
		}
	});
	test("concurrent preparations share at most two native rewrite threads", async () => {
		const target = withTools();
		const fixedSelection = await select({ kind: "tool_calls", toolCallIds: [target.tools[0]] });
		const threads = new Set<Worker>();
		const original = Worker.prototype.postMessage;
		const post = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
			this: Worker,
			...args: Parameters<Worker["postMessage"]>
		) {
			if (args[0]?.message?.id) threads.add(this);
			return Reflect.apply(original, this, args);
		});
		try {
			const tokens = await Promise.all(
				Array.from({ length: 6 }, () =>
					new RevertHistoryCommitService(db, { authorize }).prepare({ principal, fixedSelection }),
				),
			);
			expect(tokens).toHaveLength(6);
			expect(threads.size).toBe(2);
			expect(version()).toBe(7);
		} finally {
			post.mockRestore();
		}
	});
	test.each([
		"startup-error",
		"startup-timeout",
		"cancel",
		"timeout",
		"error",
		"messageerror",
		"close",
	] as const)("%s awaits actual rewrite exit without fallback, replay or COW mutation", async (mode) => {
		const target = withTools();
		ref(target.messageId, "fork", 1);
		const originalBody = body(target.messageId);
		const fixedSelection = await select({ kind: "tool_calls", toolCallIds: [target.tools[0]] });
		const controller = new AbortController();
		const threads = new Set<Worker>();
		const exited = new Set<Worker>();
		let business = 0;
		const original = Worker.prototype.postMessage;
		const post = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
			this: Worker,
			...args: Parameters<Worker["postMessage"]>
		) {
			const request = args[0];
			// The body pool is already warm. Only rewrite startup/business is intercepted.
			if (request?.action === "ping" || request?.message?.id) {
				if (!threads.has(this)) {
					threads.add(this);
					this.once("exit", () => exited.add(this));
				}
				if (request.action === "ping") {
					if (mode === "startup-error") throw Error("injected startup failure");
					if (mode === "startup-timeout") return;
					return Reflect.apply(original, this, args);
				}
				business++;
				if (mode === "cancel") controller.abort(Error("injected cancellation"));
				if (mode === "error" || mode === "messageerror")
					this.emit(mode, Error("injected runtime failure"));
				if (mode === "close") void closeRevertRewriteWorkers();
				return;
			}
			return Reflect.apply(original, this, args);
		});
		try {
			const history = new RevertHistoryCommitService(db, { authorize, timeoutMs: 220 });
			const error = await history
				.prepare({ principal, fixedSelection, signal: controller.signal })
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			expect(error).toBeDefined();
			expect(threads.size).toBe(1);
			expect(exited.size).toBe(1);
			expect(business).toBe(mode.startsWith("startup") ? 0 : 1);
			expect(body(target.messageId)).toBe(originalBody);
			expect(count("narrator_messages")).toBe(1);
			expect(version()).toBe(7);
			if (mode === "close") {
				await closeRevertRewriteWorkers();
				const closedError = await service.prepare({ principal, fixedSelection }).then(
					() => undefined,
					(error: unknown) => error,
				);
				expect(closedError).toMatchObject({ code: "REVERT_HISTORY_BODY_INVALID" });
				expect(business).toBe(1);
			}
		} finally {
			post.mockRestore();
		}
		if (mode !== "close")
			expect(await service.prepare({ principal, fixedSelection })).toBeDefined();
	});
	test("healthy rewrite commitment rejection does not retire its thread", async () => {
		const target = withTools();
		const fixedSelection = await select({ kind: "tool_calls", toolCallIds: [target.tools[0]] });
		const threads = new Set<Worker>();
		let corrupt = true;
		const original = Worker.prototype.postMessage;
		const post = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
			this: Worker,
			...args: Parameters<Worker["postMessage"]>
		) {
			if (args[0]?.message?.id) {
				threads.add(this);
				if (corrupt)
					args[0] = { ...args[0], message: { ...args[0].message, contentDigest: "0".repeat(64) } };
			}
			return Reflect.apply(original, this, args);
		});
		try {
			const error = await service.prepare({ principal, fixedSelection }).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(error).toMatchObject({ code: "REVERT_HISTORY_BODY_INVALID" });
			corrupt = false;
			expect(await service.prepare({ principal, fixedSelection })).toBeDefined();
			expect(threads.size).toBe(1);
		} finally {
			post.mockRestore();
		}
	});
});

describe("fixed selector history application", () => {
	test("real reused rewrite worker ignores stale success/error IDs without contaminating COW or rewrite", async () => {
		const shared = withTools(1, ["remove-shared", "keep-shared"]);
		const local = withTools(2, ["remove-local", "keep-local"]);
		ref(shared.messageId, "fork", 1);
		const sharedOriginal = body(shared.messageId);
		const fixedSelection = await select({
			kind: "tool_calls",
			toolCallIds: [shared.tools[0], local.tools[0]],
		});
		const requests: { worker: Worker; requestId: string; messageId: string }[] = [];
		let injectedErrors = 0;
		let injectedResults = 0;
		const realPost = Worker.prototype.postMessage;
		const post = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
			this: Worker,
			...args: Parameters<Worker["postMessage"]>
		) {
			const [request] = args;
			if (typeof request?.message?.id === "string" && typeof request.role === "string") {
				const wrongId = requests.at(-1)?.requestId ?? `wrong-${request.requestId}`;
				requests.push({
					worker: this,
					requestId: request.requestId,
					messageId: request.message.id,
				});
				this.emit("message", { requestId: wrongId, error: "stale rewrite error" });
				injectedErrors++;
				this.emit("message", {
					requestId: wrongId,
					result: {
						body: '[{"type":"text","text":"poisoned"}]',
						text: "poisoned",
						bytes: 50,
						contextCharsJson: '{"segments":[]}',
					},
				});
				injectedResults++;
			}
			return Reflect.apply(realPost, this, args);
		});
		try {
			const token = await service.prepare({ principal, fixedSelection });
			const result = apply(token);
			const replacement = result.replacements.find(
				(row) => row.previousMessageId === shared.messageId,
			);
			expect(replacement).toBeDefined();
			expect(body(shared.messageId)).toBe(sharedOriginal);
			expect(JSON.parse(body(replacement?.messageId ?? "missing"))).toEqual([
				{ type: "text", text: "keep" },
				{ type: "tool_use", id: "keep-shared", name: "Read", input: {} },
			]);
			expect(JSON.parse(body(local.messageId))).toEqual([
				{ type: "text", text: "keep" },
				{ type: "tool_use", id: "keep-local", name: "Read", input: {} },
			]);
			expect(injectedErrors).toBeGreaterThan(0);
			expect(injectedResults).toBeGreaterThan(0);
			expect(requests).toHaveLength(2);
			expect(new Set(requests.map((request) => request.worker)).size).toBe(1);
			expect(new Set(requests.map((request) => request.requestId)).size).toBe(2);
			for (const request of requests) {
				expect(typeof request.requestId).toBe("string");
				expect(request.requestId).not.toBe(request.messageId);
			}
		} finally {
			post.mockRestore();
		}
	});
	test.each([
		{ name: "null envelope", reply: (_id: string) => null },
		{ name: "array envelope", reply: (_id: string) => [] },
		{ name: "missing ID", reply: (_id: string) => ({ result: {} }) },
		{ name: "invalid ID", reply: (_id: string) => ({ requestId: 1 }) },
		{ name: "missing result", reply: (requestId: string) => ({ requestId }) },
		{ name: "null result", reply: (requestId: string) => ({ requestId, result: null }) },
		{
			name: "invalid result shape",
			reply: (requestId: string) => ({
				requestId,
				result: { body: "[]", text: null, bytes: -1, contextCharsJson: "{}" },
			}),
		},
		{ name: "invalid error", reply: (requestId: string) => ({ requestId, error: 1 }) },
		{
			name: "ambiguous result/error",
			reply: (requestId: string) => ({ requestId, error: "ambiguous", result: {} }),
		},
	])("malformed real rewrite worker reply fails explicitly: $name", async ({ reply }) => {
		const target = withTools();
		const original = body(target.messageId);
		const fixedSelection = await select({ kind: "tool_calls", toolCallIds: [target.tools[0]] });
		let injected = 0;
		let exited = false;
		const realPost = Worker.prototype.postMessage;
		const post = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
			this: Worker,
			...args: Parameters<Worker["postMessage"]>
		) {
			const [request] = args;
			if (typeof request?.message?.id === "string" && typeof request.role === "string") {
				this.once("exit", () => {
					exited = true;
				});
				this.emit("message", reply(request.requestId));
				injected++;
			}
			return Reflect.apply(realPost, this, args);
		});
		try {
			const error = await service
				.prepare({ principal, fixedSelection })
				.catch((error: unknown) => error);
			expect(error).toMatchObject({ code: "REVERT_HISTORY_BODY_INVALID" });
			expect(injected).toBeGreaterThan(0);
			expect(exited).toBe(true);
			expect(body(target.messageId)).toBe(original);
			expect(version()).toBe(7);
		} finally {
			post.mockRestore();
		}
	});
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
			"SELECT narrator_id,author_narrator_id,role,origin,original_content_json,turn_usage_json,tree_hash_after,snapshot_commit_sha,compact_pending FROM narrator_messages WHERE id=?",
			clonedId,
		)[0];
		// The copy belongs to the ref's holder; the narrator that wrote it stays its author.
		expect(cloned).toEqual({
			narrator_id: "fork",
			author_narrator_id: "root",
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
				diagnosticsJson: '{"raw":"do not load or erase"}',
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
			query("SELECT message_id,diagnostics_json FROM api_requests WHERE id='request'")[0],
		).toEqual({ message_id: null, diagnostics_json: '{"raw":"do not load or erase"}' });
		expect(
			query("SELECT source_message_id,content FROM spec_file_revisions WHERE id='revision'")[0],
		).toEqual({ source_message_id: null, content: "private revision" });
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
		const error = await prepare({ kind: "messages", messageIds: [compact] }).catch(
			(error: unknown) => error,
		);
		expect(error).toMatchObject({ code: "REVERT_HISTORY_UNAUTHORIZED_ASSOCIATION" });
		expect(count("narrator_messages")).toBe(2);
	});
	test("new inbound FK cascade through a leaf is executed by SQLite", async () => {
		const target = withTools();
		const q = question(target.tools[0]);
		sqlite.exec(
			"CREATE TABLE unplanned_leaf(id TEXT PRIMARY KEY, question_id TEXT REFERENCES narrator_questions(id) ON DELETE CASCADE)",
		);
		sqlite.query("INSERT INTO unplanned_leaf VALUES('leaf',?)").run(q);
		apply(await prepare());
		for (const table of [
			"unplanned_leaf",
			"narrator_questions",
			"narrator_tool_calls",
			"narrator_message_refs",
			"narrator_messages",
		])
			expect(count(table)).toBe(0);
		expect(version()).toBe(8);
	});
	for (const action of ["CASCADE", "SET NULL", "RESTRICT", "NO ACTION"])
		test(`an empty unfamiliar ${action} FK table does not block unrelated history`, async () => {
			withTools();
			sqlite.exec(
				`CREATE TABLE unfamiliar_fk(id TEXT PRIMARY KEY, message_id TEXT REFERENCES narrator_messages(id) ON DELETE ${action})`,
			);
			apply(await prepare());
			expect(count("unfamiliar_fk")).toBe(0);
			expect(count("narrator_messages")).toBe(0);
			expect(count("narrator_message_refs")).toBe(0);
			expect(count("narrator_tool_calls")).toBe(0);
			expect(version()).toBe(8);
		});
	for (const action of ["RESTRICT", "NO ACTION"])
		test(`a real ${action} association fails SQL and restores every earlier mutation`, async () => {
			const first = withTools(1);
			const blocked = withTools(2, ["c", "d"]);
			const firstQuestion = question(first.tools[0]);
			const blockedQuestion = question(blocked.tools[0]);
			sqlite.exec(
				`CREATE TABLE unfamiliar_fk(id TEXT PRIMARY KEY, message_id TEXT REFERENCES narrator_messages(id) ON DELETE ${action}); CREATE TABLE test_revert_journal(status TEXT NOT NULL); INSERT INTO test_revert_journal VALUES('files_verified')`,
			);
			sqlite.query("INSERT INTO unfamiliar_fk VALUES('blocked',?)").run(blocked.messageId);
			const beforeBodies = [body(first.messageId), body(blocked.messageId)];
			const token = await prepare();
			const statements: string[] = [];
			const realQuery = sqlite.query.bind(sqlite);
			const trace = spyOn(sqlite, "query").mockImplementation(((text: string) => {
				statements.push(text);
				return realQuery(text);
			}) as typeof sqlite.query);
			try {
				expect(() =>
					db.transaction((tx) => {
						service.applyToTransaction(tx, token);
						tx.run(sql`UPDATE test_revert_journal SET status='committed'`);
					}),
				).toThrow("FOREIGN KEY constraint failed");
			} finally {
				trace.mockRestore();
			}
			expect(
				statements.filter((text) => text.startsWith('DELETE FROM "narrator_messages"')),
			).toHaveLength(2);
			expect([body(first.messageId), body(blocked.messageId)]).toEqual(beforeBodies);
			expect(count("narrator_messages")).toBe(2);
			expect(count("narrator_message_refs")).toBe(2);
			expect(count("narrator_tool_calls")).toBe(4);
			expect(query("SELECT id FROM narrator_questions ORDER BY id")).toEqual([
				{ id: firstQuestion },
				{ id: blockedQuestion },
			]);
			expect(query("SELECT * FROM unfamiliar_fk")).toEqual([
				{ id: "blocked", message_id: blocked.messageId },
			]);
			expect(query("SELECT status FROM test_revert_journal")).toEqual([
				{ status: "files_verified" },
			]);
			expect(version()).toBe(7);
			expect(() => apply(token)).toThrow("Unknown");
		});
	test("application-owned triggers execute normally without disabling foreign keys", async () => {
		const target = withTools();
		sqlite.exec(
			"CREATE TABLE trigger_audit(message_id TEXT NOT NULL); CREATE TRIGGER history_audit AFTER DELETE ON narrator_message_refs BEGIN INSERT INTO trigger_audit VALUES(OLD.message_id); END",
		);
		apply(await prepare());
		expect(query("SELECT * FROM trigger_audit")).toEqual([{ message_id: target.messageId }]);
		expect(query("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
		expect(count("narrator_messages")).toBe(0);
		expect(count("narrator_message_refs")).toBe(0);
		expect(count("narrator_tool_calls")).toBe(0);
		expect(version()).toBe(8);
	});
	test("an application trigger SQL failure rolls back prior deletes and trigger writes", async () => {
		const first = withTools(1);
		const blocked = withTools(2, ["c", "d"]);
		const q = question(first.tools[0]);
		sqlite.exec(
			"CREATE TABLE trigger_audit(message_id TEXT NOT NULL); CREATE TRIGGER history_audit AFTER DELETE ON narrator_message_refs BEGIN INSERT INTO trigger_audit VALUES(OLD.message_id); END; CREATE TRIGGER history_failure BEFORE DELETE ON narrator_message_refs WHEN OLD.seq=2 BEGIN SELECT RAISE(ABORT, 'history trigger failure'); END; CREATE TABLE test_revert_journal(status TEXT NOT NULL); INSERT INTO test_revert_journal VALUES('files_verified')",
		);
		const beforeBodies = [body(first.messageId), body(blocked.messageId)];
		const token = await prepare();
		expect(() =>
			db.transaction((tx) => {
				service.applyToTransaction(tx, token);
				tx.run(sql`UPDATE test_revert_journal SET status='committed'`);
			}),
		).toThrow("history trigger failure");
		expect(count("trigger_audit")).toBe(0);
		expect([body(first.messageId), body(blocked.messageId)]).toEqual(beforeBodies);
		expect(count("narrator_messages")).toBe(2);
		expect(count("narrator_message_refs")).toBe(2);
		expect(count("narrator_tool_calls")).toBe(4);
		expect(query("SELECT id FROM narrator_questions")).toEqual([{ id: q }]);
		expect(query("SELECT status FROM test_revert_journal")).toEqual([{ status: "files_verified" }]);
		expect(version()).toBe(7);
		expect(() => apply(token)).toThrow("Unknown");
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
		// Delegation, not a read-only tool, is the authority that requires child binding.
		// The message body must contain the delegation call too, matching real execution.
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
			// Await natively: Bun's async matcher can starve an already reusable thread's RPC.
			const error = await service.prepare({ principal, fixedSelection }).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(error).toBeDefined();
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
			if (kind === "unrelated" || kind === "rollback") {
				apply(token);
				expect(count("narrator_messages")).toBe(0);
				expect(version()).toBe(8);
				return;
			}
			expect(() => apply(token)).toThrow("Selected history changed");
			expect(count("narrator_messages")).toBe(1);
			expect(count("narrator_tool_calls")).toBe(2);
			expect(version()).toBe(7);
		});
	test("unrelated same-narrator messages and working status do not stale a fixed point plan", async () => {
		const target = withTools();
		const fixedSelection = await select({ kind: "tool_calls", toolCallIds: [target.tools[0]] });
		const unrelated = message(20, [{ type: "text", text: "unrelated" }]);
		sqlite
			.query(
				"UPDATE narrators SET message_version=message_version+1,status='working' WHERE id='root'",
			)
			.run();
		let changedDuringPrepare = false;
		onAuthorize = () => {
			if (changedDuringPrepare) return;
			changedDuringPrepare = true;
			sqlite
				.query(
					"UPDATE narrators SET message_version=message_version+1,status='idle' WHERE id='root'",
				)
				.run();
		};
		apply(await service.prepare({ principal, fixedSelection }));
		expect(body(unrelated)).toBeDefined();
		expect(body(target.messageId)).toBeDefined();
		expect(count("narrator_tool_calls")).toBe(1);
		expect(version()).toBe(10);
	});
	test("a version bump during rewrite preparation binds the final current version rather than the consumed old row", async () => {
		const target = withTools();
		const fixedSelection = await select({ kind: "tool_calls", toolCallIds: [target.tools[0]] });
		const mutation = mutateAfterRead(
			(text) => text.includes("SELECT id,message_version,fork_message_id FROM narrators"),
			() =>
				sqlite
					.query("UPDATE narrators SET message_version=message_version+1 WHERE id='root'")
					.run(),
		);
		try {
			const token = await service.prepare({ principal, fixedSelection });
			expect(mutation.state.mutated).toBe(true);
			apply(token);
			expect(version()).toBe(9);
			expect(count("narrator_tool_calls")).toBe(1);
		} finally {
			mutation.restore();
		}
	});
	test("prepare-to-apply version CAS still rejects even unrelated semantic writes atomically", async () => {
		const target = withTools();
		const token = await prepare({ kind: "tool_calls", toolCallIds: [target.tools[0]] });
		sqlite.query("UPDATE narrators SET message_version=message_version+1 WHERE id='root'").run();
		expect(() => apply(token)).toThrow("Selected message history changed");
		expect(body(target.messageId)).toBeDefined();
		expect(count("narrator_tool_calls")).toBe(2);
		expect(version()).toBe(8);
	});
	test.each([
		"plan-to-prepare",
		"prepare-to-apply",
	])("%s rejects a new rollback suffix member even without a version bump", async (phase) => {
		const boundary = message(1, [
			{ type: "text", text: "keep" },
			{ type: "text", text: "remove" },
		]);
		message(2);
		const fixedSelection = await select({
			kind: "after_block",
			messageId: boundary,
			keepThroughBlockIndex: 0,
		});
		const token =
			phase === "prepare-to-apply"
				? await service.prepare({ principal, fixedSelection })
				: undefined;
		const later = message(3);
		if (token) expect(() => apply(token)).toThrow("Selected history changed");
		else {
			const error = await service.prepare({ principal, fixedSelection }).catch((error) => error);
			expect(error).toMatchObject({ code: "REVERT_HISTORY_STALE" });
		}
		expect(body(boundary)).toBeDefined();
		expect(body(later)).toBeDefined();
		expect(version()).toBe(7);
	});
	test("ACL changes after preparation reject before any history mutation", async () => {
		withTools();
		const token = await prepare();
		sqlite.query("UPDATE narrators SET visibility='public' WHERE id='root'").run();
		expect(() => apply(token)).toThrow("Selected history changed");
		expect(count("narrator_messages")).toBe(1);
		expect(version()).toBe(7);
	});
	test("new lazy dependencies after preparation reject without any automatic backfill", async () => {
		const target = withTools(10);
		const token = await prepare();
		sqlite
			.query(
				"UPDATE narrators SET refs_inherited_from='root',refs_backfill_cursor=11 WHERE id='other'",
			)
			.run();
		let error: unknown;
		try {
			apply(token);
		} catch (cause) {
			error = cause;
		}
		expect(error).toMatchObject({ code: "HISTORY_LAZY_DEPENDENCY_CHANGED", statusCode: 409 });
		expect(body(target.messageId)).toBeDefined();
		expect(version()).toBe(7);
		expect(scalar("SELECT refs_backfill_cursor AS n FROM narrators WHERE id='other'")).toBe(11);
	});
	test("status and unrelated lazy cursor loading after preparation do not invalidate the short commit", async () => {
		withTools(100);
		sqlite
			.query(
				"UPDATE narrators SET refs_inherited_from='other',refs_backfill_cursor=100 WHERE id='root'",
			)
			.run();
		const token = await prepare({ kind: "from_seq", minSeq: 100 });
		sqlite
			.query("UPDATE narrators SET status='working',refs_backfill_cursor=50 WHERE id='root'")
			.run();
		apply(token);
		expect(count("narrator_messages")).toBe(0);
		expect(version()).toBe(8);
	});
	test("a malformed lazy cursor after preparation still rejects before history writes", async () => {
		withTools(100);
		const token = await prepare();
		sqlite
			.query(
				"UPDATE narrators SET refs_inherited_from='other',refs_backfill_cursor=-1 WHERE id='root'",
			)
			.run();
		expect(() => apply(token)).toThrow("Selected history changed");
		expect(count("narrator_messages")).toBe(1);
		expect(version()).toBe(7);
	});
	test("external metadata-only writes preserve selected message versions", async () => {
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
		fileRoot.transaction((tx) => fileService.applyToTransaction(tx, token));
		expect(
			fileDb.query<{ n: number }, []>("SELECT count(*) AS n FROM narrator_messages").get()?.n,
		).toBe(0);
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
		expect(await service.prepare({ principal, fixedSelection })).toBeDefined();
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
		expect(() => apply(token)).toThrow("short SQLite waits");
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
	test("fake narrator/ref/block commitments are not accepted merely because digest matches", async () => {
		const target = withTools();
		const original = await select();
		for (const kind of ["narrator", "ref", "block"]) {
			const fixedSelection = structuredClone(original);
			if (kind === "narrator") fixedSelection.messageVersions[0].narratorId = "other";
			if (kind === "ref") fixedSelection.history.messages[0].refId = "fake-ref";
			if (kind === "block") fixedSelection.history.blocks[0].key = "fake-block";
			// Await natively: Bun's async matcher can starve an already reusable thread's RPC.
			const error = await service.prepare({ principal, fixedSelection }).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(error).toBeDefined();
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

describe("batched consumed history guards", () => {
	for (const index of [31, 32, 64])
		test(`message/ref equality covers page boundary index ${index}`, async () => {
			const ids = Array.from({ length: 65 }, (_, i) => message(i));
			const token = await prepare();
			sqlite
				.query("UPDATE narrator_message_refs SET is_compact=1 WHERE message_id=?")
				.run(ids[index]);
			expect(() => apply(token)).toThrow("Selected history changed");
			expect(count("narrator_messages")).toBe(65);
			expect(count("narrator_message_refs")).toBe(65);
			expect(version()).toBe(7);
		});
	for (const kind of ["empty", "replace", "retarget", "swap-across-page"] as const)
		test(`association ${kind} drift cannot hide behind a batch count`, async () => {
			const ids = Array.from({ length: 65 }, (_, i) => message(i));
			const add = (id: string, messageId: string) =>
				sqlite
					.query(
						"INSERT INTO api_requests(id,message_id,created_at,provider,model) VALUES(?,?,?,?,?)",
					)
					.run(id, messageId, time, "fixture", "fixture");
			if (kind !== "empty") add("first", ids[0]);
			if (kind === "swap-across-page") add("second", ids[32]);
			const token = await prepare();
			if (kind === "empty") add("new", ids[32]);
			if (kind === "replace") {
				sqlite.query("DELETE FROM api_requests WHERE id='first'").run();
				add("replacement", ids[0]);
			}
			if (kind === "retarget")
				sqlite.query("UPDATE api_requests SET message_id=? WHERE id='first'").run(ids[1]);
			if (kind === "swap-across-page") {
				sqlite.query("UPDATE api_requests SET message_id=? WHERE id='first'").run(ids[32]);
				sqlite.query("UPDATE api_requests SET message_id=? WHERE id='second'").run(ids[0]);
			}
			expect(() => apply(token)).toThrow("Selected history changed");
			expect(count("narrator_messages")).toBe(65);
			expect(version()).toBe(7);
		});
	test("an originally tool-free message remains a membership target after page 32", async () => {
		const ids = Array.from({ length: 33 }, (_, i) => message(i));
		const token = await prepare();
		tool(ids[32], "new");
		expect(() => apply(token)).toThrow("Selected history changed");
		expect(count("narrator_messages")).toBe(33);
		expect(count("narrator_tool_calls")).toBe(1);
	});
	for (const kind of ["replace", "retarget"] as const)
		test(`tool ${kind} with unchanged inventory count is rejected`, async () => {
			const first = withTools(1, ["first"]);
			const second = withTools(2, ["second"]);
			const token = await prepare();
			if (kind === "replace") {
				sqlite.query("DELETE FROM narrator_tool_calls WHERE id=?").run(first.tools[0]);
				tool(first.messageId, "first");
			} else {
				sqlite
					.query("UPDATE narrator_tool_calls SET message_id=? WHERE id=?")
					.run(second.messageId, first.tools[0]);
				sqlite
					.query("UPDATE narrator_tool_calls SET message_id=? WHERE id=?")
					.run(first.messageId, second.tools[0]);
			}
			expect(() => apply(token)).toThrow("Selected history changed");
			expect(count("narrator_messages")).toBe(2);
			expect(count("narrator_tool_calls")).toBe(2);
		});
	test("shared true to false is rejected without fixing an arbitrary other ref ID", async () => {
		const id = message(1);
		const other = ref(id, "fork", 1);
		const token = await prepare();
		sqlite.query("DELETE FROM narrator_message_refs WHERE id=?").run(other);
		expect(() => apply(token)).toThrow("Selected history changed");
		expect(body(id)).toBeDefined();
		expect(version()).toBe(7);
	});
	test("replacing the other owner ref preserves an unchanged shared predicate", async () => {
		const id = message(1);
		const other = ref(id, "fork", 1);
		const token = await prepare();
		sqlite.query("DELETE FROM narrator_message_refs WHERE id=?").run(other);
		ref(id, "other", 1);
		apply(token);
		expect(body(id)).toBeDefined();
		expect(count("narrator_message_refs")).toBe(1);
		expect(version()).toBe(8);
	});
	for (const action of ["rewrite", "copy_on_write", "unlink"] as const)
		test(`new hidden compact refs reject ${action} after preparation`, async () => {
			const target = withTools();
			if (action !== "rewrite") ref(target.messageId, "fork", 1);
			const hidden = message(2, undefined, action === "unlink" ? "root" : "other");
			const selector: FileChangeRevertSelector =
				action === "unlink"
					? { kind: "messages", messageIds: [target.messageId] }
					: { kind: "tool_calls", toolCallIds: [target.tools[0]] };
			const token = await prepare(selector);
			sqlite
				.query("UPDATE narrator_message_refs SET segment_compact_id=? WHERE message_id=?")
				.run(target.messageId, hidden);
			expect(() => apply(token)).toThrow("Selected history changed");
			expect(count("narrator_messages")).toBe(2);
			expect(version()).toBe(7);
		});
	test("unlink compact guard only fixes the selected owner's hidden refs", async () => {
		const id = message(1);
		ref(id, "fork", 1);
		const hidden = message(2, undefined, "other");
		const token = await prepare({ kind: "messages", messageIds: [id] });
		sqlite
			.query("UPDATE narrator_message_refs SET segment_compact_id=? WHERE message_id=?")
			.run(id, hidden);
		apply(token);
		expect(body(id)).toBeDefined();
		expect(version()).toBe(8);
	});
	for (const table of ["message", "tool"] as const)
		test(`complete COW ${table} fields reject equal-byte extra-field edits`, async () => {
			const target = withTools();
			ref(target.messageId, "fork", 1);
			const update =
				table === "message"
					? "UPDATE narrator_messages SET turn_usage_json=? WHERE id=?"
					: "UPDATE narrator_tool_calls SET error_message=? WHERE id=?";
			const id = table === "message" ? target.messageId : target.tools[1];
			sqlite.query(update).run("old", id);
			const token = await prepare({ kind: "tool_calls", toolCallIds: [target.tools[0]] });
			sqlite.query(update).run("new", id);
			expect(() => apply(token)).toThrow("Selected history changed");
			expect(count("narrator_messages")).toBe(1);
			expect(count("narrator_tool_calls")).toBe(2);
			expect(version()).toBe(7);
		});
	for (const table of ["message", "tool"] as const)
		test(`COW ${table} full read cannot rebaseline earlier consumed metadata`, async () => {
			const target = withTools();
			ref(target.messageId, "fork", 1);
			const fixedSelection = await select({ kind: "tool_calls", toolCallIds: [target.tools[0]] });
			const injection = mutateAfterRead(
				(text) =>
					table === "message"
						? text.startsWith("SELECT id,role,tree_hash_after,snapshot_commit_sha,")
						: text.includes(
								"is_file_history_checkpoint,status,execution_attempt,file_change_operation_id,tool_name,",
							),
				() =>
					table === "message"
						? sqlite
								.query("UPDATE narrator_messages SET role='different' WHERE id=?")
								.run(target.messageId)
						: sqlite
								.query("UPDATE narrator_tool_calls SET tool_name='Glob' WHERE id=?")
								.run(target.tools[1]),
			);
			try {
				const error = await service
					.prepare({ principal, fixedSelection })
					.catch((error: unknown) => error);
				expect(injection.state.mutated).toBe(true);
				expect(error).toMatchObject({
					code: "REVERT_HISTORY_STALE",
					message: "Selected history changed during preparation",
				});
			} finally {
				injection.restore();
			}
			expect(count("narrator_messages")).toBe(1);
			expect(version()).toBe(7);
		});
	for (const table of ["message", "tool"] as const)
		test(`COW ${table} full row consumed before await stays fixed through compilation`, async () => {
			const target = withTools();
			ref(target.messageId, "fork", 1);
			const update =
				table === "message"
					? "UPDATE narrator_messages SET turn_usage_json=? WHERE id=?"
					: "UPDATE narrator_tool_calls SET error_message=? WHERE id=?";
			const id = table === "message" ? target.messageId : target.tools[1];
			sqlite.query(update).run("old", id);
			const fixedSelection = await select({ kind: "tool_calls", toolCallIds: [target.tools[0]] });
			const injection = mutateAfterRead(
				(text) =>
					text.startsWith('SELECT "id",') &&
					text.includes(table === "message" ? '"turn_usage_json"' : '"error_message"'),
				() => {
					sqlite.query(update).run("new", id);
				},
			);
			let token: PreparedRevertHistory;
			try {
				token = await service.prepare({ principal, fixedSelection });
				expect(injection.state.mutated).toBe(true);
			} finally {
				injection.restore();
			}
			expect(() => apply(token)).toThrow("Selected history changed");
			expect(count("narrator_messages")).toBe(1);
			expect(count("narrator_tool_calls")).toBe(2);
			expect(version()).toBe(7);
		});
});

describe("materialized Send recipient receipts", () => {
	/** Real runtime mailbox: enqueue → claim → materialize into a recipient message/ref. */
	function materializeSend(
		recipient = "root",
		source = "sender",
		key = `send-${serial++}`,
		blocks: unknown[] = [{ type: "text", text: "hello" }],
		seq = serial,
	) {
		const store = createMailboxStore(db as unknown as RuntimeDb);
		const accepted = store.enqueue({
			kind: "agent_message",
			narratorId: recipient,
			text: "hello",
			projectedByteSize: 5,
			sourceNarratorId: source,
			sourceToolCallId: "source-tool",
			sourceAttempt: 1,
			sourceKey: key,
		});
		if (accepted.status !== "accepted") throw new Error(accepted.status);
		const [row] = store.claimBatch(recipient, { token: key, epoch: "epoch" });
		if (!row?.recipientMessageId) throw new Error("claim missing");
		const refId = `ref-${serial++}`;
		const materialized = store.materialize(
			{ id: row.id, narratorId: recipient, token: key, epoch: "epoch" },
			(tx) => {
				tx.insert(schema.narratorMessages)
					.values({
						id: row.recipientMessageId as string,
						narratorId: recipient,
						role: "user",
						contentJson: blocks as typeof schema.narratorMessages.$inferInsert.contentJson,
						createdAt: time,
					})
					.run();
				tx.insert(schema.narratorMessageRefs)
					.values({
						id: refId,
						narratorId: recipient,
						messageId: row.recipientMessageId as string,
						// Distinct per delivery so selectors can order received messages.
						seq,
					})
					.run();
				return { messageId: row.recipientMessageId as string, refId };
			},
		);
		if (materialized?.state !== "materialized") throw new Error("not materialized");
		return {
			deliveryId: row.deliveryId as string,
			messageId: row.recipientMessageId,
			refId,
			id: row.id,
		};
	}
	function receipt(id: string) {
		return query<{ receipt_disposition: string; current_message_id: string | null; state: string }>(
			"SELECT receipt_disposition,current_message_id,state FROM narrator_buffered_messages WHERE id=?",
			id,
		)[0];
	}
	test("confirmed revert deletion leaves a recipient_deleted receipt and refreshes the source", async () => {
		narrator("sender");
		const send = materializeSend();
		const sourceBefore = version("sender");
		const token = await prepare();
		expect(receipt(send.id)).toMatchObject({
			receipt_disposition: "active",
			current_message_id: send.messageId,
		});
		const result = apply(token);
		expect(receipt(send.id)).toEqual({
			receipt_disposition: "recipient_deleted",
			current_message_id: null,
			state: "materialized",
		});
		expect(count("narrator_message_refs")).toBe(0);
		expect(count("narrator_messages")).toBe(0);
		expect(version()).toBe(8);
		expect(version("sender")).toBe(sourceBefore + 1);
		expect(result.affectedNarratorIds).toEqual(["root"]);
		expect(result.refreshedNarratorIds).toEqual(["sender"]);
		// The sender's page-local Send lookup now observes the negative receipt.
		const [target] = await loadSendTargetDetails(
			[{ id: "root", deliveryId: send.deliveryId, deliveryMessageId: send.messageId, revision: 1 }],
			db as never,
		);
		expect(target).toMatchObject({ receiptDisposition: "recipient_deleted" });
	});
	test("a subagent source also refreshes its parent once; selected owners are not double counted", async () => {
		narrator("parent");
		narrator("child", "alice", {
			type: "subagent",
			parentNarratorId: "parent",
			aclRootNarratorId: "parent",
		});
		// The child sends to root; the parent is ALSO a removed recipient owner below.
		const send = materializeSend("root", "child");
		const parentBefore = version("parent");
		const childBefore = version("child");
		const token = await prepare();
		const result = apply(token);
		expect(receipt(send.id)?.receipt_disposition).toBe("recipient_deleted");
		expect(version("child")).toBe(childBefore + 1);
		expect(version("parent")).toBe(parentBefore + 1);
		expect(result.refreshedNarratorIds.sort()).toEqual(["child", "parent"]);
	});
	test("a source that is also an affected owner gets exactly one CAS increment", async () => {
		// root sends to itself: root is both the recipient owner and the source.
		const send = materializeSend("root", "root");
		const token = await prepare();
		const result = apply(token);
		expect(receipt(send.id)?.receipt_disposition).toBe("recipient_deleted");
		expect(version()).toBe(8);
		expect(result.refreshedNarratorIds).toEqual([]);
	});
	test("unlink of the current owner updates only its receipt; another owner's ref and receipt stay active", async () => {
		narrator("sender");
		const mine = materializeSend("root");
		const theirs = materializeSend("fork");
		// root's received message is also shared into fork; fork's own delivery is independent.
		ref(mine.messageId as string, "fork", 2);
		const token = await prepare({ kind: "messages", messageIds: [mine.messageId as string] });
		apply(token);
		expect(receipt(mine.id)?.receipt_disposition).toBe("recipient_deleted");
		expect(receipt(theirs.id)).toMatchObject({
			receipt_disposition: "active",
			current_message_id: theirs.messageId,
		});
		expect(body(mine.messageId as string)).toBeDefined();
		expect(version("fork")).toBe(7);
	});
	test("a source already deleted at preparation is a fixed empty target; the receipt is still marked", async () => {
		narrator("gone");
		const send = materializeSend("root", "gone");
		// Senders may be deleted while their receipt survives (mailbox has no source FK).
		sqlite.query("DELETE FROM narrators WHERE id='gone'").run();
		const token = await prepare();
		const result = apply(token);
		expect(receipt(send.id)?.receipt_disposition).toBe("recipient_deleted");
		expect(result.refreshedNarratorIds).toEqual([]);
		expect(version()).toBe(8);
	});
	for (const drift of ["vanish", "appear"] as const)
		test(`a source that ${drift === "vanish" ? "vanishes" : "appears"} after preparation is drift`, async () => {
			if (drift === "vanish") narrator("gone");
			const send = materializeSendWithSource("gone");
			const token = await prepare();
			if (drift === "vanish") sqlite.query("DELETE FROM narrators WHERE id='gone'").run();
			else narrator("gone");
			expect(() => apply(token)).toThrow("Selected history changed");
			expect(receipt(send.id)?.receipt_disposition).toBe("active");
			expect(version()).toBe(7);
		});
	/** enqueue needs a live source; restore the requested absence afterwards. */
	function materializeSendWithSource(source: string) {
		const absent = !query("SELECT id FROM narrators WHERE id=?", source).length;
		if (absent) narrator(source);
		const send = materializeSend("root", source);
		if (absent) sqlite.query("DELETE FROM narrators WHERE id=?").run(source);
		return send;
	}
	for (const drift of ["new-receipt", "rebind", "state", "source", "source-parent"] as const)
		test(`receipt ${drift} drift after preparation is rejected with no mutation`, async () => {
			narrator("sender");
			narrator("other-parent");
			narrator("parent-x");
			narrator("child", "alice", {
				type: "subagent",
				parentNarratorId: "parent-x",
				aclRootNarratorId: "root",
			});
			const plain = message(1);
			const send =
				drift === "new-receipt"
					? undefined
					: materializeSend("root", drift === "source-parent" ? "child" : "sender");
			const token = await prepare();
			if (drift === "new-receipt") {
				// A delivery bound to an originally receipt-free ref after preparation.
				const late = materializeSend();
				sqlite
					.query("UPDATE narrator_buffered_messages SET recipient_ref_id=? WHERE id=?")
					.run(
						query<{ id: string }>(
							"SELECT id FROM narrator_message_refs WHERE message_id=?",
							plain,
						)[0].id,
						late.id,
					);
			}
			if (drift === "rebind" && send)
				sqlite
					.query("UPDATE narrator_buffered_messages SET recipient_ref_id='elsewhere' WHERE id=?")
					.run(send.id);
			if (drift === "state" && send)
				sqlite
					.query("UPDATE narrator_buffered_messages SET state='cancelled' WHERE id=?")
					.run(send.id);
			if (drift === "source" && send)
				sqlite
					.query("UPDATE narrator_buffered_messages SET source_narrator_id='other' WHERE id=?")
					.run(send.id);
			if (drift === "source-parent")
				sqlite
					.query("UPDATE narrators SET parent_narrator_id='other-parent' WHERE id='child'")
					.run();
			expect(() => apply(token)).toThrow("Selected history changed");
			expect(version()).toBe(7);
			if (send) expect(receipt(send.id)?.receipt_disposition).toBe("active");
			expect(count("narrator_message_refs")).toBeGreaterThan(0);
		});
	test("unrelated source metadata and version changes do not veto the recipient revert", async () => {
		narrator("sender");
		const send = materializeSend();
		const token = await prepare();
		sqlite
			.query(
				"UPDATE narrators SET title='renamed',message_version=message_version+5 WHERE id='sender'",
			)
			.run();
		apply(token);
		expect(receipt(send.id)?.receipt_disposition).toBe("recipient_deleted");
		expect(version("sender")).toBe(13);
	});
	/** A received message whose last block is a removable tool_use with its tool row. */
	function receivedWithTool(recipient = "root") {
		const send = materializeSend(recipient, "sender", `send-${serial++}`, [
			{ type: "text", text: "keep" },
			{ type: "tool_use", id: "drop", name: "Read", input: {} },
		]);
		const toolId = tool(send.messageId as string, "drop", "Read", { narratorId: recipient });
		// The original delivery and the current content were both adopted before revert.
		sqlite
			.query(
				"UPDATE narrator_buffered_messages SET adopted_revision=1,adopted_at=?,current_revision=3,current_adopted_revision=3,current_adopted_at=? WHERE id=?",
			)
			.run(time, time, send.id);
		sqlite
			.query("UPDATE narrator_message_refs SET injection_consumed_at=? WHERE id=?")
			.run(Date.parse(time), send.refId);
		return { ...send, toolId };
	}
	function semantic(id: string) {
		return query<{
			receipt_disposition: string;
			current_message_id: string | null;
			current_revision: number;
			current_adopted_revision: number | null;
			current_adopted_at: string | null;
			adopted_revision: number | null;
			adopted_at: string | null;
		}>(
			"SELECT receipt_disposition,current_message_id,current_revision,current_adopted_revision,current_adopted_at,adopted_revision,adopted_at FROM narrator_buffered_messages WHERE id=?",
			id,
		)[0];
	}
	function consumed(refId: string) {
		return query<{ injection_consumed_at: number | null }>(
			"SELECT injection_consumed_at FROM narrator_message_refs WHERE id=?",
			refId,
		)[0]?.injection_consumed_at;
	}
	const superseded = (messageId: string) => ({
		receipt_disposition: "superseded",
		current_message_id: messageId,
		// max(current_revision=3, content_revision=1) + 1
		current_revision: 4,
		current_adopted_revision: null,
		current_adopted_at: null,
		// The original delivery's adoption fact is retained.
		adopted_revision: 1,
		adopted_at: time,
	});
	test("in-place rewrite of a received message supersedes its receipt and keeps the message ID", async () => {
		narrator("sender");
		const send = receivedWithTool();
		const sourceBefore = version("sender");
		const result = apply(await prepare({ kind: "tool_calls", toolCallIds: [send.toolId] }));
		expect(JSON.parse(body(send.messageId as string))).toEqual([{ type: "text", text: "keep" }]);
		expect(semantic(send.id)).toEqual(superseded(send.messageId as string));
		expect(consumed(send.refId)).toBeNull();
		expect(version()).toBe(8);
		expect(version("sender")).toBe(sourceBefore + 1);
		expect(result.refreshedNarratorIds).toEqual(["sender"]);
		const [target] = await loadSendTargetDetails(
			[{ id: "root", deliveryId: send.deliveryId, deliveryMessageId: send.messageId, revision: 1 }],
			db as never,
		);
		expect(target).toMatchObject({ receiptDisposition: "superseded", injectionConsumedAt: time });
	});
	test("COW of a shared received message points the receipt at the new copy only", async () => {
		narrator("sender");
		const send = receivedWithTool();
		// The fork shares the received message; its ref has no delivery of its own.
		const forkRef = ref(send.messageId as string, "fork", 2);
		sqlite
			.query("UPDATE narrator_message_refs SET injection_consumed_at=? WHERE id=?")
			.run(Date.parse(time), forkRef);
		const result = apply(await prepare({ kind: "tool_calls", toolCallIds: [send.toolId] }));
		const [replacement] = result.replacements;
		expect(replacement).toMatchObject({ refId: send.refId, previousMessageId: send.messageId });
		expect(replacement.messageId).not.toBe(send.messageId);
		// The receipt and the owner's ref share the newly inserted copy's identity.
		expect(semantic(send.id)).toEqual(superseded(replacement.messageId));
		expect(
			query<{ message_id: string }>(
				"SELECT message_id FROM narrator_message_refs WHERE id=?",
				send.refId,
			)[0].message_id,
		).toBe(replacement.messageId);
		expect(JSON.parse(body(replacement.messageId))).toEqual([{ type: "text", text: "keep" }]);
		expect(consumed(send.refId)).toBeNull();
		// The fork's shared original, its ref and its adoption fact are untouched.
		expect(JSON.parse(body(send.messageId as string))).toHaveLength(2);
		expect(consumed(forkRef)).toBe(Date.parse(time));
		expect(version("fork")).toBe(7);
		expect(result.refreshedNarratorIds).toEqual(["sender"]);
	});
	test("after_block truncation of a received message supersedes in the same apply as later deletes", async () => {
		narrator("sender");
		const send = receivedWithTool();
		const later = materializeSend();
		apply(
			await prepare({
				kind: "after_block",
				messageId: send.messageId as string,
				keepThroughBlockIndex: 0,
			}),
		);
		expect(JSON.parse(body(send.messageId as string))).toEqual([{ type: "text", text: "keep" }]);
		expect(semantic(send.id)).toEqual(superseded(send.messageId as string));
		expect(receipt(later.id)).toMatchObject({
			receipt_disposition: "recipient_deleted",
			current_message_id: null,
		});
		expect(version("sender")).toBe(8);
	});
	test("an edited ref without a mailbox still clears its legacy ref adoption fact", async () => {
		const target = withTools();
		const refId = query<{ id: string }>(
			"SELECT id FROM narrator_message_refs WHERE message_id=?",
			target.messageId,
		)[0].id;
		sqlite
			.query("UPDATE narrator_message_refs SET injection_consumed_at=? WHERE id=?")
			.run(Date.parse(time), refId);
		const result = apply(await prepare({ kind: "tool_calls", toolCallIds: [target.tools[0]] }));
		// Legacy updateRecipientRef clears it for every semantic edit, mailbox or not.
		expect(consumed(refId)).toBeNull();
		// No mailbox row changed, so no source page needs a refresh.
		expect(result.refreshedNarratorIds).toEqual([]);
		expect(version()).toBe(8);
	});
	for (const drift of [
		"new-receipt",
		"current-revision",
		"content-revision",
		"rebind",
		"state",
	] as const)
		test(`edited receipt ${drift} drift after preparation is rejected with no mutation`, async () => {
			narrator("sender");
			const send = receivedWithTool();
			const plain = withTools(2, ["plain"]);
			const token = await prepare({
				kind: "tool_calls",
				toolCallIds: [send.toolId, plain.tools[0]],
			});
			if (drift === "new-receipt") {
				// A delivery bound after preparation to an edited ref that had no receipt.
				const late = materializeSend();
				const plainRef = query<{ id: string }>(
					"SELECT id FROM narrator_message_refs WHERE message_id=?",
					plain.messageId,
				)[0].id;
				sqlite
					.query("UPDATE narrator_buffered_messages SET recipient_ref_id=? WHERE id=?")
					.run(plainRef, late.id);
			}
			if (drift === "current-revision")
				sqlite
					.query("UPDATE narrator_buffered_messages SET current_revision=9 WHERE id=?")
					.run(send.id);
			if (drift === "content-revision")
				sqlite
					.query("UPDATE narrator_buffered_messages SET content_revision=2 WHERE id=?")
					.run(send.id);
			if (drift === "rebind")
				sqlite
					.query("UPDATE narrator_buffered_messages SET recipient_ref_id='elsewhere' WHERE id=?")
					.run(send.id);
			if (drift === "state")
				sqlite
					.query("UPDATE narrator_buffered_messages SET state='cancelled' WHERE id=?")
					.run(send.id);
			expect(() => apply(token)).toThrow("Selected history changed");
			expect(JSON.parse(body(send.messageId as string))).toHaveLength(2);
			expect(consumed(send.refId)).toBe(Date.parse(time));
			expect(version()).toBe(7);
			if (drift !== "state" && drift !== "rebind")
				expect(semantic(send.id)?.receipt_disposition).toBe("active");
		});
	test("a receipt failure rolls back with the caller journal", async () => {
		narrator("sender");
		const send = materializeSend();
		sqlite.exec(
			"CREATE TRIGGER fail_receipt BEFORE UPDATE OF receipt_disposition ON narrator_buffered_messages BEGIN SELECT RAISE(ABORT,'receipt fault'); END",
		);
		const token = await prepare();
		expect(() => apply(token)).toThrow("receipt fault");
		expect(receipt(send.id)?.receipt_disposition).toBe("active");
		expect(count("narrator_message_refs")).toBe(1);
		expect(version()).toBe(7);
		expect(version("sender")).toBe(7);
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
	test("a materialized answer notice on a removed ref is cancelled once, not also receipt-updated", async () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		const event = answer(q, 2);
		const inbox = receipt(event);
		const refId = query<{ id: string }>(
			"SELECT id FROM narrator_message_refs WHERE message_id=?",
			event,
		)[0].id;
		// Bound to the removed ref exactly as the runtime materializes a question notice.
		sqlite
			.query(
				"UPDATE narrator_buffered_messages SET state='materialized',recipient_ref_id=?,current_message_id=? WHERE id=?",
			)
			.run(refId, event, inbox);
		apply(await prepare({ kind: "messages", messageIds: [event] }));
		expect(
			query<{ state: string; receipt_disposition: string }>(
				"SELECT state,receipt_disposition FROM narrator_buffered_messages WHERE id=?",
				inbox,
			)[0],
		).toEqual({ state: "cancelled", receipt_disposition: "recipient_deleted" });
		expect(count("narrator_question_events")).toBe(0);
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
	for (const action of ["unlink", "copy_on_write"] as const)
		test(`empty request candidates remain fixed for ${action}`, async () => {
			const creation = withTools(1, ["ask", "keep"]);
			ref(creation.messageId, "fork", 1);
			const token = await prepare(
				action === "unlink"
					? { kind: "messages", messageIds: [creation.messageId] }
					: { kind: "tool_calls", toolCallIds: [creation.tools[0]] },
			);
			question(creation.tools[0]);
			expect(() => apply(token)).toThrow("Selected history changed");
			expect(count("narrator_messages")).toBe(1);
			expect(version()).toBe(7);
		});
	for (const entry of ["event", "answer"] as const)
		test(`empty ${entry} candidates remain fixed for owner unlink`, async () => {
			const creation = withTools(1, ["ask"]);
			const q = question(creation.tools[0]);
			const selected = message(2);
			ref(selected, "fork", 2);
			const token = await prepare({ kind: "messages", messageIds: [selected] });
			if (entry === "event")
				sqlite
					.query(
						"INSERT INTO narrator_question_events(question_id,message_id,kind,created_at) VALUES(?,?,'answer',?)",
					)
					.run(q, selected, time);
			else
				sqlite
					.query("UPDATE narrator_questions SET answer_message_id=? WHERE id=?")
					.run(selected, q);
			expect(() => apply(token)).toThrow("Selected history changed");
			expect(count("narrator_message_refs")).toBe(3);
			expect(version()).toBe(7);
		});
	test("empty event sets of a fixed question cannot gain an unselected event", async () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		ref(creation.messageId, "fork", 1);
		const event = message(2);
		const token = await prepare({ kind: "messages", messageIds: [creation.messageId] });
		sqlite
			.query(
				"INSERT INTO narrator_question_events(question_id,message_id,kind,created_at) VALUES(?,?,'answer',?)",
			)
			.run(q, event, time);
		expect(() => apply(token)).toThrow("Selected history changed");
		expect(
			query<{ status: string }>("SELECT status FROM narrator_questions WHERE id=?", q)[0].status,
		).toBe("open");
		expect(version()).toBe(7);
	});
	for (const kind of ["resolution", "cursor", "question"] as const)
		test(`old event ${kind} drift is checked even when only the latest event is selected`, async () => {
			const creation = withTools(1, ["ask", "other"]);
			const q = question(creation.tools[0]);
			const another = question(creation.tools[1]);
			const previous = answer(q, 2, "answer", { note: "old" });
			const latest = answer(q, 3, "supplement");
			const token = await prepare({ kind: "messages", messageIds: [latest] });
			if (kind === "resolution")
				sqlite
					.query("UPDATE narrator_question_events SET resolution_json=? WHERE message_id=?")
					.run('{"note":"new"}', previous);
			if (kind === "cursor")
				sqlite
					.query("UPDATE narrator_question_events SET rowid=rowid+1000 WHERE message_id=?")
					.run(previous);
			if (kind === "question")
				sqlite
					.query("UPDATE narrator_question_events SET question_id=? WHERE message_id=?")
					.run(another, previous);
			expect(() => apply(token)).toThrow("Selected history changed");
			expect(count("narrator_question_events")).toBe(2);
			expect(count("narrator_messages")).toBe(3);
			expect(version()).toBe(7);
		});
	test("question event projection and membership span more than 32 historical rows", async () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		const events = Array.from({ length: 34 }, (_, i) =>
			answer(q, i + 2, "supplement", { note: "old" }),
		);
		const token = await prepare({ kind: "messages", messageIds: [events[33]] });
		sqlite
			.query("UPDATE narrator_question_events SET resolution_json=? WHERE message_id=?")
			.run('{"note":"new"}', events[32]);
		expect(() => apply(token)).toThrow("Selected history changed");
		expect(count("narrator_question_events")).toBe(34);
		expect(version()).toBe(7);
	});
	for (const drift of ["pk", "cursor", "bytes"] as const)
		test(`event byte preflight binds the actual raw read to ${drift}`, async () => {
			const creation = withTools(1, ["ask"]);
			const q = question(creation.tools[0]);
			const previous = answer(q, 2, "answer", { note: "old" });
			const latest = answer(q, 3, "supplement");
			const replacement = message(4);
			const fixedSelection = await select({ kind: "messages", messageIds: [latest] });
			const injection = mutateAfterRead(
				(text) =>
					text.startsWith(
						"SELECT question_id,message_id,coalesce(octet_length(resolution_json),0) AS resolutionBytes,",
					),
				() => {
					if (drift === "pk")
						sqlite
							.query("UPDATE narrator_question_events SET message_id=? WHERE message_id=?")
							.run(replacement, previous);
					if (drift === "cursor")
						sqlite
							.query("UPDATE narrator_question_events SET rowid=rowid+1000 WHERE message_id=?")
							.run(previous);
					if (drift === "bytes")
						sqlite
							.query("UPDATE narrator_question_events SET resolution_json=? WHERE message_id=?")
							.run("x".repeat(4 * 1024 * 1024 + 1), previous);
				},
			);
			try {
				const error = await service
					.prepare({ principal, fixedSelection })
					.catch((error: unknown) => error);
				expect(injection.state.mutated).toBe(true);
				expect(error).toMatchObject({
					code: "REVERT_HISTORY_STALE",
					message: "A fixed row disappeared",
				});
			} finally {
				injection.restore();
			}
			expect(count("narrator_question_events")).toBe(2);
			expect(version()).toBe(7);
		});
	test("raw historical resolution consumed before an await is never rebaselined", async () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		const previous = answer(q, 2, "answer", { note: "old" });
		const latest = answer(q, 3, "supplement");
		const fixedSelection = await select({ kind: "messages", messageIds: [latest] });
		const injection = mutateAfterRead(
			(text) =>
				text.startsWith(
					"SELECT question_id,message_id,kind,created_at,resolution_json,rowid AS cursor,",
				),
			() => {
				sqlite
					.query("UPDATE narrator_question_events SET resolution_json=? WHERE message_id=?")
					.run('{"note":"new"}', previous);
			},
		);
		let token: PreparedRevertHistory;
		try {
			token = await service.prepare({ principal, fixedSelection });
			expect(injection.state.mutated).toBe(true);
		} finally {
			injection.restore();
		}
		expect(() => apply(token)).toThrow("Selected history changed");
		expect(count("narrator_question_events")).toBe(2);
		expect(version()).toBe(7);
	});
	for (const kind of ["empty", "replace", "source", "kind"] as const)
		test(`question inbox ${kind} changes are fixed by owner/event and source predicate`, async () => {
			const creation = withTools(1, ["ask"]);
			const q = question(creation.tools[0]);
			const event = answer(q, 2);
			const existing = kind === "empty" ? undefined : receipt(event);
			const token = await prepare({ kind: "messages", messageIds: [event] });
			if (kind === "replace")
				sqlite.query("DELETE FROM narrator_buffered_messages WHERE id=?").run(existing ?? "");
			if (kind === "empty" || kind === "replace") receipt(event);
			if (kind === "source")
				sqlite
					.query("UPDATE narrator_buffered_messages SET source_key='unrelated' WHERE id=?")
					.run(existing ?? "");
			if (kind === "kind")
				sqlite
					.query("UPDATE narrator_buffered_messages SET kind='user' WHERE id=?")
					.run(existing ?? "");
			expect(() => apply(token)).toThrow("Selected history changed");
			expect(count("narrator_question_events")).toBe(1);
			expect(count("narrator_messages")).toBe(2);
			expect(version()).toBe(7);
		});
	test("unrelated inbox sources and kinds remain independent", async () => {
		const creation = withTools(1, ["ask"]);
		const q = question(creation.tools[0]);
		const event = answer(q, 2);
		const token = await prepare({ kind: "messages", messageIds: [event] });
		const unrelated = receipt(event);
		sqlite
			.query("UPDATE narrator_buffered_messages SET source_key='unrelated' WHERE id=?")
			.run(unrelated);
		const user = receipt(event);
		sqlite.query("UPDATE narrator_buffered_messages SET kind='user' WHERE id=?").run(user);
		apply(token);
		expect(
			query<{ state: string }>("SELECT state FROM narrator_buffered_messages ORDER BY id").map(
				(row) => row.state,
			),
		).toEqual(["claimed", "claimed"]);
		expect(version()).toBe(8);
	});
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
		expect(() => apply(token)).toThrow("Selected history changed after preparation");
		expect(count("narrator_question_events")).toBe(1);
	});
});

describe("bounded preparation and synchronous atomic commit", () => {
	test("1000 messages use bounded batched commit checks", async () => {
		db.transaction(() => {
			for (let i = 0; i < 1000; i++) message(i);
		});
		const token = await prepare();
		let checks = 0;
		let mutations = 0;
		let directCounts = 0;
		const realQuery = sqlite.query.bind(sqlite);
		const trace = spyOn(sqlite, "query").mockImplementation(((text: string) => {
			if (/^(SELECT|WITH|PRAGMA)\b/i.test(text) && !text.startsWith("SELECT changes()")) checks++;
			if (/^(INSERT|UPDATE|DELETE)\b/i.test(text)) mutations++;
			if (text.startsWith("SELECT changes()")) directCounts++;
			return realQuery(text);
		}) as typeof sqlite.query);
		try {
			apply(token);
		} finally {
			trace.mockRestore();
		}
		// 451 history checks + 32 fixed (owner,ref) recipient-receipt membership batches.
		expect(checks).toBeLessThanOrEqual(483);
		expect(mutations).toBe(2001);
		expect(directCounts).toBe(mutations);
		expect(count("narrator_messages")).toBe(0);
		expect(count("narrator_message_refs")).toBe(0);
		expect(version()).toBe(8);
	}, 30_000);
	test("expired prepared cannot execute even without intervening writes", async () => {
		withTools();
		const token = await prepare();
		const future = Date.now() + 60_000;
		const clock = spyOn(Date, "now").mockReturnValue(future);
		try {
			expect(() => apply(token)).toThrow("History preparation expired");
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
		// Await collection outside Bun's rejects matcher so paginated setImmediate yields run.
		const error = await prepare().catch((error: unknown) => error);
		expect(error).toMatchObject({ code: "REVERT_SELECTION_BUDGET_EXCEEDED" });
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
		// Await collection outside Bun's rejects matcher so paginated setImmediate yields run.
		const error = await prepare().catch((error: unknown) => error);
		expect(error).toMatchObject({ code: "REVERT_SELECTION_BUDGET_EXCEEDED" });
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
	for (const action of ["delete", "unlink", "rewrite"] as const)
		test(`stored-schema drift does not block ${action} without copying rows`, async () => {
			const target = withTools();
			if (action === "unlink") ref(target.messageId, "fork", 1);
			const original = body(target.messageId);
			for (const table of ["narrator_messages", "narrator_tool_calls"])
				sqlite.exec(
					`ALTER TABLE ${table} ADD COLUMN new_unhandled_reference TEXT DEFAULT 'preserved'`,
				);
			const selector: FileChangeRevertSelector =
				action === "rewrite"
					? { kind: "tool_calls", toolCallIds: [target.tools[0]] }
					: { kind: "all" };
			apply(await prepare(selector));
			expect(version()).toBe(8);
			expect(version("fork")).toBe(7);
			if (action === "delete") {
				expect(count("narrator_messages")).toBe(0);
				expect(count("narrator_tool_calls")).toBe(0);
			} else {
				expect(
					query(
						"SELECT new_unhandled_reference FROM narrator_messages WHERE id=?",
						target.messageId,
					),
				).toEqual([{ new_unhandled_reference: "preserved" }]);
				expect(
					query(
						"SELECT new_unhandled_reference FROM narrator_tool_calls WHERE message_id=?",
						target.messageId,
					),
				).toEqual(
					Array.from({ length: action === "unlink" ? 2 : 1 }, () => ({
						new_unhandled_reference: "preserved",
					})),
				);
				if (action === "unlink") {
					expect(body(target.messageId)).toBe(original);
					expect(query("SELECT narrator_id FROM narrator_message_refs")).toEqual([
						{ narrator_id: "fork" },
					]);
				} else {
					expect(JSON.parse(body(target.messageId))).toHaveLength(2);
					expect(query("SELECT id FROM narrator_tool_calls")).toEqual([{ id: target.tools[1] }]);
				}
			}
		});
	test("stored-schema drift in tools does not block COW that copies only a message", async () => {
		const target = withTools(1, ["remove"]);
		ref(target.messageId, "fork", 1);
		const original = body(target.messageId);
		sqlite.exec("ALTER TABLE narrator_tool_calls ADD COLUMN new_unhandled_reference TEXT");
		const result = apply(await prepare({ kind: "tool_calls", toolCallIds: target.tools }, "fork"));
		expect(result.replacements).toHaveLength(1);
		expect(body(target.messageId)).toBe(original);
		const forkMessage = query<{ message_id: string }>(
			"SELECT message_id FROM narrator_message_refs WHERE narrator_id='fork'",
		)[0].message_id;
		expect(forkMessage).not.toBe(target.messageId);
		expect(JSON.parse(body(forkMessage))).toEqual([{ type: "text", text: "keep" }]);
		expect(count("narrator_messages")).toBe(2);
		expect(count("narrator_tool_calls")).toBe(1);
		expect(version()).toBe(7);
		expect(version("fork")).toBe(8);
	});
	test("stored-schema drift copies unknown fields into COW rows", async () => {
		const target = withTools();
		ref(target.messageId, "fork", 1);
		for (const table of ["narrator_messages", "narrator_tool_calls"])
			sqlite.exec(`ALTER TABLE ${table} ADD COLUMN new_unhandled_reference TEXT`);
		sqlite
			.query("UPDATE narrator_messages SET new_unhandled_reference='message' WHERE id=?")
			.run(target.messageId);
		sqlite
			.query("UPDATE narrator_tool_calls SET new_unhandled_reference='tool' WHERE id=?")
			.run(target.tools[1]);
		const original = body(target.messageId);
		const result = apply(
			await prepare({ kind: "tool_calls", toolCallIds: [target.tools[0]] }, "fork"),
		);
		const forkMessage = result.replacements[0].messageId;
		expect(forkMessage).not.toBe(target.messageId);
		expect(body(target.messageId)).toBe(original);
		expect(
			query("SELECT new_unhandled_reference FROM narrator_messages WHERE id=?", forkMessage),
		).toEqual([{ new_unhandled_reference: "message" }]);
		expect(
			query(
				"SELECT new_unhandled_reference FROM narrator_tool_calls WHERE message_id=?",
				forkMessage,
			),
		).toEqual([{ new_unhandled_reference: "tool" }]);
		expect(count("narrator_tool_calls")).toBe(3);
		expect(version("fork")).toBe(8);
	});
	for (const action of ["copy_on_write", "rewrite"] as const)
		test(`unknown-field edit after preparation stales ${action}`, async () => {
			const target = withTools();
			if (action === "copy_on_write") ref(target.messageId, "fork", 1);
			sqlite.exec("ALTER TABLE narrator_messages ADD COLUMN new_unhandled_reference TEXT");
			const update = sqlite.query(
				"UPDATE narrator_messages SET new_unhandled_reference=? WHERE id=?",
			);
			update.run("old", target.messageId);
			const token = await prepare(
				{ kind: "tool_calls", toolCallIds: [target.tools[0]] },
				action === "copy_on_write" ? "fork" : undefined,
			);
			// COW fixes every copied field; an in-place rewrite fixes the complete row length.
			update.run(action === "copy_on_write" ? "new" : "longer", target.messageId);
			expect(() => apply(token)).toThrow("Selected history changed");
			expect(count("narrator_messages")).toBe(1);
			expect(count("narrator_tool_calls")).toBe(2);
		});
	for (const table of ["narrator_messages", "narrator_tool_calls"])
		for (const action of ["delete", "unlink", "rewrite"] as const)
			test(`a missing known ${table} column rejects ${action}`, async () => {
				const target = withTools();
				if (action === "unlink") ref(target.messageId, "fork", 1);
				sqlite.exec(
					`ALTER TABLE ${table} DROP COLUMN ${table === "narrator_messages" ? "turn_usage_json" : "error_message"}`,
				);
				await expect(
					prepare(
						action === "rewrite"
							? { kind: "tool_calls", toolCallIds: [target.tools[0]] }
							: { kind: "all" },
					),
				).rejects.toMatchObject({ code: "REVERT_HISTORY_UNSUPPORTED_SCHEMA" });
				expect(count("narrator_messages")).toBe(1);
				expect(count("narrator_tool_calls")).toBe(2);
				expect(version()).toBe(7);
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
	test("unrelated journal writes can share the short history transaction", async () => {
		withTools();
		sqlite.exec("CREATE TABLE test_journal(status TEXT)");
		const token = await prepare();
		db.transaction((tx) => {
			tx.run(sql`INSERT INTO test_journal VALUES('committed')`);
			service.applyToTransaction(tx, token);
		});
		expect(count("test_journal")).toBe(1);
		expect(count("narrator_messages")).toBe(0);
	});
});
