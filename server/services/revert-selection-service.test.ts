import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_CHANGE_LIMITS, type FileChangeRevertSelector } from "@shared/file-change-protocol";
import { createFileChangeIdentity, fileChangeIdentityKey } from "./file-change-identity";
import type { NarratorAclRow, NarratorPrincipal } from "./narrator-acl";
import { REVERT_SELECTION_LIMITS, RevertSelectionService } from "./revert-selection-service";

// Independent in-memory schema; importing the service never imports application DB/runtime.
const DDL = `
CREATE TABLE narrators (
 id TEXT PRIMARY KEY, owner_user_id TEXT, visibility TEXT NOT NULL DEFAULT 'private',
 write_audience TEXT NOT NULL DEFAULT 'owner', type TEXT NOT NULL DEFAULT 'primary',
 acl_root_narrator_id TEXT, chapter_id TEXT, context_project_id TEXT, message_version INTEGER NOT NULL DEFAULT 7,
 refs_inherited_from TEXT, status TEXT NOT NULL DEFAULT 'idle', parent_narrator_id TEXT, origin_tool_call_id TEXT,
 fork_message_id TEXT
);
CREATE INDEX idx_narrators_parent ON narrators(parent_narrator_id);
CREATE INDEX idx_narrators_fork_message ON narrators(fork_message_id);
CREATE TABLE narrator_messages (
 id TEXT PRIMARY KEY, narrator_id TEXT NOT NULL, parent_tool_use_id TEXT, role TEXT NOT NULL DEFAULT 'assistant', content_json TEXT NOT NULL,
 content_text TEXT, original_content_json TEXT, tree_hash_after TEXT, snapshot_commit_sha TEXT, created_at TEXT NOT NULL DEFAULT '2026-09-07'
);
CREATE INDEX idx_messages_parent_tool_use_lookup ON narrator_messages(parent_tool_use_id,created_at);
CREATE TABLE narrator_message_refs (
 id TEXT PRIMARY KEY, narrator_id TEXT NOT NULL, message_id TEXT NOT NULL, seq INTEGER NOT NULL, segment_compact_id TEXT
);
CREATE UNIQUE INDEX idx_narrator_refs_unique ON narrator_message_refs(narrator_id,message_id);
CREATE INDEX idx_narrator_refs_seq ON narrator_message_refs(narrator_id,seq);
CREATE INDEX idx_narrator_refs_message ON narrator_message_refs(message_id);
CREATE INDEX idx_narrator_refs_segment_compact ON narrator_message_refs(segment_compact_id);
CREATE TABLE narrator_tool_calls (
 id TEXT PRIMARY KEY, narrator_id TEXT NOT NULL, message_id TEXT NOT NULL, tool_use_id TEXT NOT NULL,
 tool_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'success', is_background INTEGER NOT NULL DEFAULT 0,
 execution_identity_version INTEGER NOT NULL DEFAULT 1, execution_origin_tool_call_id TEXT, execution_attempt INTEGER NOT NULL DEFAULT 1,
 file_change_operation_id TEXT, execution_device_id TEXT DEFAULT 'local', execution_path_flavor TEXT DEFAULT 'posix',
 resolved_file_path TEXT, canonical_file_path TEXT, runtime_generation INTEGER DEFAULT 1, execution_segment_id TEXT, is_file_history_checkpoint INTEGER NOT NULL DEFAULT 0,
 input_json TEXT, output_json TEXT, execution_targets_json TEXT
);
CREATE INDEX idx_toolcalls_message ON narrator_tool_calls(message_id);
CREATE TABLE background_tasks (
 id TEXT PRIMARY KEY, status TEXT NOT NULL, type TEXT NOT NULL, parent_narrator_id TEXT NOT NULL,
 subagent_narrator_id TEXT, tool_call_id TEXT, execution_attempt INTEGER
);
CREATE UNIQUE INDEX idx_bg_tasks_tool_attempt ON background_tasks(tool_call_id,execution_attempt);
CREATE TABLE file_change_scopes (
 id TEXT PRIMARY KEY, source_instance_id TEXT NOT NULL, device_id TEXT NOT NULL,
 workspace_instance_id TEXT NOT NULL, path_flavor TEXT NOT NULL, canonical_root TEXT NOT NULL, status TEXT NOT NULL
);
INSERT INTO file_change_scopes VALUES('scope','installation','local','workspace','posix','/repo','active');
CREATE TABLE file_change_operations (
 id TEXT PRIMARY KEY, execution_segment_id TEXT, evidence_version INTEGER NOT NULL DEFAULT 2, source_instance_id TEXT NOT NULL DEFAULT 'installation',
 source_kind TEXT NOT NULL DEFAULT 'tool', source_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
 tool_call_id TEXT, narrator_id TEXT, project_id TEXT, request_digest TEXT,
 execution_binding_json TEXT DEFAULT '{"deviceId":"local","runtimeEpoch":"test","runtimeGeneration":1,"fencingToken":0}',
 expected_effect_count INTEGER, prepared_effect_count INTEGER NOT NULL DEFAULT 1, settled_effect_count INTEGER NOT NULL DEFAULT 1,
 unresolved_effect_count INTEGER NOT NULL DEFAULT 0, evidence_bytes INTEGER NOT NULL DEFAULT 6,
 execution_outcome TEXT NOT NULL DEFAULT 'succeeded', effect_outcome TEXT NOT NULL DEFAULT 'changed', settlement TEXT NOT NULL DEFAULT 'settled',
 coverage TEXT NOT NULL DEFAULT 'complete', attribution_grade TEXT NOT NULL DEFAULT 'measured', reason TEXT,
 finished_at TEXT DEFAULT '2026-09-07', updated_at TEXT NOT NULL DEFAULT '2026-09-07'
);
CREATE TABLE file_change_effects (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, scope_id TEXT NOT NULL, file_key TEXT NOT NULL, scope_revision INTEGER NOT NULL DEFAULT 1,
 mutation_id TEXT NOT NULL, request_digest TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'apply',
 outcome TEXT NOT NULL DEFAULT 'changed', settlement TEXT NOT NULL DEFAULT 'settled', attribution_grade TEXT NOT NULL DEFAULT 'measured',
 execution_confirmed INTEGER NOT NULL DEFAULT 1, lines_added INTEGER, lines_removed INTEGER,
 before_blob_digest TEXT, intended_after_blob_digest TEXT, observed_after_blob_digest TEXT,
 identity_json TEXT NOT NULL, before_state_json TEXT NOT NULL, intended_after_state_json TEXT NOT NULL, observed_after_state_json TEXT NOT NULL, execution_receipt_json TEXT
);
CREATE UNIQUE INDEX idx_fc_effect_operation_file ON file_change_effects(operation_id,file_key,phase);
CREATE TABLE file_change_execution_segments (id TEXT PRIMARY KEY, narrator_id TEXT NOT NULL, parent_segment_id TEXT);
CREATE INDEX idx_fc_segment_parent ON file_change_execution_segments(parent_segment_id);
CREATE TABLE chapter_commits (id TEXT PRIMARY KEY, narrator_message_id TEXT);
CREATE INDEX idx_chapter_commits_narrator_message ON chapter_commits(narrator_message_id);
CREATE TABLE spec_file_revisions (id TEXT PRIMARY KEY, source_message_id TEXT);
CREATE INDEX idx_spec_file_revisions_source_message ON spec_file_revisions(source_message_id);
CREATE TABLE narrator_patches (id TEXT PRIMARY KEY, message_id TEXT);
CREATE INDEX idx_patches_message ON narrator_patches(message_id);
CREATE TABLE api_requests (id TEXT PRIMARY KEY, message_id TEXT);
CREATE INDEX idx_api_requests_message ON api_requests(message_id);
CREATE TABLE knowledge_injection_events (id TEXT PRIMARY KEY, trigger_message_id TEXT, trigger_tool_call_id TEXT);
CREATE INDEX idx_kie_trigger_message ON knowledge_injection_events(trigger_message_id);
CREATE INDEX idx_kie_trigger_tool_call ON knowledge_injection_events(trigger_tool_call_id);
CREATE TABLE narrator_questions (id TEXT PRIMARY KEY, tool_call_id TEXT);
CREATE TABLE narrator_question_events (message_id TEXT PRIMARY KEY, question_id TEXT, kind TEXT, created_at TEXT, resolution_json TEXT);
CREATE INDEX idx_narrator_questions_tool_call ON narrator_questions(tool_call_id);
CREATE TABLE permission_rule_requests (id TEXT PRIMARY KEY, tool_call_id TEXT, attempt INTEGER);
CREATE UNIQUE INDEX uq_permission_rule_request_attempt ON permission_rule_requests(tool_call_id,attempt);
CREATE TABLE narrator_tool_continuations (id TEXT PRIMARY KEY, tool_call_id TEXT);
CREATE INDEX idx_tool_continuations_tool_call ON narrator_tool_continuations(tool_call_id);
`;
const principal: NarratorPrincipal = { userId: "alice", isAdmin: false };
let sqlite: Database;
let service: RevertSelectionService;
let serial: number;
let authorized: string[];
let denied: Set<string>;
let queries: string[];
let beforeQuery: ((query: string) => void) | undefined;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

beforeEach(() => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	expect(process.env.HOME).not.toBe(process.env.NARRAFORK_ORIGINAL_HOME);
	sqlite = new Database(":memory:");
	sqlite.exec(DDL);
	serial = 0;
	authorized = [];
	denied = new Set();
	queries = [];
	beforeQuery = undefined;
	narrator("root");
	narrator("other", "bob");
	const traced = new Proxy(sqlite, {
		get(target, key) {
			if (key === "query")
				return (...args: Parameters<Database["query"]>) => {
					if (queries.length < 20_000) queries.push(args[0]);
					beforeQuery?.(args[0]);
					return Reflect.apply(target.query, target, args);
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	service = new RevertSelectionService({ $client: traced }, { authorize, onSlow: () => {} });
});
afterEach(() => sqlite.close());
async function authorize(
	owner: NarratorPrincipal,
	row: NarratorAclRow,
	need: "write",
	signal: AbortSignal,
) {
	expect(need).toBe("write");
	expect(sqlite.inTransaction).toBe(false);
	signal.throwIfAborted();
	authorized.push(row.id);
	if (denied.has(row.id) || (!owner.isAdmin && row.ownerUserId !== owner.userId))
		throw new Error("ACL denied");
}
function narrator(id: string, owner = "alice") {
	sqlite.query("INSERT INTO narrators(id, owner_user_id) VALUES(?,?)").run(id, owner);
}
function message(
	seq: number,
	blocks: unknown[] = [{ type: "text", text: "hello" }],
	narratorId = "root",
	id = `msg-${serial++}`,
	role = "assistant",
) {
	sqlite
		.query("INSERT INTO narrator_messages(id,narrator_id,role,content_json) VALUES(?,?,?,?)")
		.run(id, narratorId, role, JSON.stringify(blocks));
	sqlite
		.query("INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES(?,?,?,?)")
		.run(`ref-${serial++}`, narratorId, id, seq);
	return id;
}
function tool(
	seq: number,
	name = "Write",
	options: {
		messageId?: string;
		narratorId?: string;
		providerId?: string;
		id?: string;
		segment?: string;
	} = {},
) {
	const id = options.id ?? `tool-${serial++}`;
	const providerId = options.providerId ?? `provider-${serial++}`;
	const narratorId = options.narratorId ?? "root";
	const messageId =
		options.messageId ??
		message(seq, [{ type: "tool_use", id: providerId, name, input: {} }], narratorId);
	sqlite
		.query(
			"INSERT INTO narrator_tool_calls(id,narrator_id,message_id,tool_use_id,tool_name,resolved_file_path,canonical_file_path) VALUES(?,?,?,?,?,?,?)",
		)
		.run(id, narratorId, messageId, providerId, name, `/repo/${id}`, `/repo/${id}`);
	if (options.segment)
		sqlite
			.query("UPDATE narrator_tool_calls SET execution_segment_id=? WHERE id=?")
			.run(options.segment, id);
	return { id, messageId, providerId, narratorId };
}
function segment(id: string, narratorId: string, parentId: string | null = null) {
	sqlite
		.query(
			"INSERT INTO file_change_execution_segments(id,narrator_id,parent_segment_id) VALUES(?,?,?)",
		)
		.run(id, narratorId, parentId);
}
function journal(t: ReturnType<typeof tool>, count = 1, origin = t.id) {
	const id = `op-${serial++}`;
	sqlite
		.query(
			"INSERT INTO file_change_operations(id,source_id,tool_call_id,narrator_id,request_digest,expected_effect_count,prepared_effect_count,settled_effect_count) VALUES(?,?,?,?,?,?,?,?)",
		)
		.run(id, origin, origin, t.narratorId, hash(id), count, count, count);
	sqlite
		.query("UPDATE narrator_tool_calls SET file_change_operation_id=? WHERE id=?")
		.run(id, t.id);
	for (let i = 0; i < count; i++) effect(id, i);
	return id;
}
function effect(operationId: string, index = 0) {
	const id = `effect-${serial++}`;
	const mutationId = hash(id);
	const requestDigest = hash(`${id}-request`);
	const identity = createFileChangeIdentity(
		{
			id: "scope",
			sourceInstanceId: "installation",
			deviceId: "local",
			workspaceInstanceId: "workspace",
			pathFlavor: "posix",
			canonicalRoot: "/repo",
		},
		{
			deviceId: "local",
			pathFlavor: "posix",
			canonicalPath: `/repo/${operationId}-${index}.txt`,
			lexicalPath: `/repo/${operationId}-${index}.txt`,
			objectRole: "referent",
		},
	);
	const before = {
		kind: "regular",
		mode: 0o644,
		blob: { algorithm: "sha256", digest: hash("old"), sizeBytes: 3 },
	};
	const after = {
		kind: "regular",
		mode: 0o644,
		blob: { algorithm: "sha256", digest: hash("new"), sizeBytes: 3 },
	};
	const receipt = {
		receiptId: `receipt-${id}`,
		mutationId,
		requestDigest,
		executionBinding: {
			deviceId: "local",
			runtimeEpoch: "test",
			runtimeGeneration: 1,
			fencingToken: 0,
		},
		confirmed: true,
		outcome: "applied",
		observedAfter: after,
	};
	sqlite
		.query(
			"INSERT INTO file_change_effects(id,operation_id,scope_id,file_key,mutation_id,request_digest,before_blob_digest,intended_after_blob_digest,observed_after_blob_digest,identity_json,before_state_json,intended_after_state_json,observed_after_state_json,execution_receipt_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
		)
		.run(
			id,
			operationId,
			"scope",
			fileChangeIdentityKey(identity),
			mutationId,
			requestDigest,
			before.blob.digest,
			after.blob.digest,
			after.blob.digest,
			JSON.stringify(identity),
			JSON.stringify(before),
			JSON.stringify(after),
			JSON.stringify(after),
			JSON.stringify(receipt),
		);
	return id;
}
const collect = (
	selector: FileChangeRevertSelector = { kind: "all" },
	extra: Partial<Parameters<RevertSelectionService["collect"]>[0]> = {},
) =>
	service.collect({ principal, narratorId: "root", expectedMessageVersion: 7, selector, ...extra });
const hasIssue = (result: Awaited<ReturnType<typeof collect>>, code: string) =>
	result.issues.some((issue) => issue.code === code);
const rejected = async (pending: Promise<unknown>, code: string) => {
	// Bun's async .rejects matcher can starve paginated setImmediate work; await first.
	const error = await pending.catch((error: unknown) => error);
	expect(error).toMatchObject({ code: `REVERT_SELECTION_${code}` });
};

describe("authorized stable source selection", () => {
	test("empty actual refs can be completely enumerated but never execute", async () => {
		const result = await collect();
		expect(result.selectionComplete).toBe(true);
		expect(result.evidenceComplete).toBe(true);
		expect(result.executable).toBe(false);
		expect(result.history.messages).toHaveLength(0);
		expect(result.messageVersions).toEqual([{ narratorId: "root", messageVersion: 7 }]);
		expect(authorized).toEqual(["root", "root", "root"]);
		for (const name of ["execute", "delete", "commit", "apply", "finalize"])
			expect(name in service).toBe(false);
	});
	test("ACL is mandatory, runs before history and denies other owners even with known IDs", async () => {
		const m = message(1, [{ type: "text", text: "secret" }], "other");
		await expect(
			collect({ kind: "messages", messageIds: [m] }, { narratorId: "other" }),
		).rejects.toThrow("ACL denied");
		expect(
			() =>
				new RevertSelectionService(
					{ $client: sqlite },
					{} as ConstructorParameters<typeof RevertSelectionService>[1],
				),
		).toThrow();
	});
	test("ACL is rechecked at return and revocation never leaks a completed manifest", async () => {
		message(1);
		let calls = 0;
		service = new RevertSelectionService(
			{ $client: sqlite },
			{
				authorize: async (...args) => {
					if (++calls === 2) throw new Error("revoked");
					await authorize(...args);
				},
			},
		);
		await expect(collect()).rejects.toThrow("revoked");
	});
	test("all/from_seq/messages use actual refs, deduplicate targets and include tied sequences", async () => {
		const a = message(1);
		const b = message(2);
		const c = message(2);
		expect((await collect()).history.messages.map((m) => m.id)).toEqual([a, b, c]);
		expect(
			(await collect({ kind: "from_seq", minSeq: 2 })).history.messages.map((m) => m.id),
		).toEqual([b, c]);
		expect(
			(await collect({ kind: "messages", messageIds: [c, c] })).history.messages.map((m) => m.id),
		).toEqual([c]);
		await rejected(collect({ kind: "messages", messageIds: [a, "missing"] }), "NOT_FOUND");
	});
	test("lazily inherited refs reject instead of presenting a local prefix as all", async () => {
		message(100);
		sqlite.query("UPDATE narrators SET refs_inherited_from='other' WHERE id='root'").run();
		await rejected(collect(), "INHERITED_REFS_UNMATERIALIZED");
	});
	test("message version mismatch rejects before collection", async () => {
		message(1);
		await rejected(collect({ kind: "all" }, { expectedMessageVersion: 6 }), "STALE");
	});
	test("same provider ID in another narrator never selects a latest replacement", async () => {
		const chosen = tool(1, "Write", { providerId: "provider-reused" });
		journal(chosen);
		const unrelated = tool(1, "Write", { providerId: "provider-reused", narratorId: "other" });
		journal(unrelated);
		const result = await collect({ kind: "tool_calls", toolCallIds: [chosen.id] });
		expect(result.tools.map((t) => t.id)).toEqual([chosen.id]);
		expect(result.effects).toHaveLength(1);
		await rejected(collect({ kind: "tool_calls", toolCallIds: [unrelated.id] }), "NOT_FOUND");
	});
	test("tool-call selector preserves PK/attempt and cannot silently delete a different retry", async () => {
		const first = tool(1, "Read", { providerId: "same-block" });
		const retry = tool(1, "Read", { providerId: "same-block", messageId: first.messageId });
		sqlite.query("UPDATE narrator_tool_calls SET execution_attempt=2 WHERE id=?").run(retry.id);
		await rejected(collect({ kind: "tool_calls", toolCallIds: [retry.id] }), "AMBIGUOUS_ATTEMPT");
		const result = await collect({
			kind: "tool_calls",
			toolCallIds: [first.id, retry.id, first.id],
		});
		expect(result.tools.map((t) => t.executionAttempt)).toEqual([1, 2]);
	});
	test("COW clones reuse their actual origin journal rather than allocating duplicate effects", async () => {
		const original = tool(1);
		const op = journal(original);
		const clone = tool(2, "Write", { providerId: original.providerId });
		sqlite
			.query(
				"UPDATE narrator_tool_calls SET execution_origin_tool_call_id=?,file_change_operation_id=? WHERE id=?",
			)
			.run(original.id, op, clone.id);
		const result = await collect();
		expect(result.tools).toHaveLength(2);
		expect(result.operations).toHaveLength(1);
		expect(result.effects).toHaveLength(1);
		expect(result.evidenceComplete).toBe(true);
	});
});

describe("stable block boundary and COW history manifest", () => {
	test("after_block fixes retained boundary and all later message/ref changes in one capture", async () => {
		const early = message(0);
		const boundary = message(1, [
			{ type: "text", text: "keep" },
			{ type: "tool_use", id: "remove-tool", name: "Read", input: {} },
			{ type: "text", text: "remove" },
		]);
		const removed = tool(1, "Read", { messageId: boundary, providerId: "remove-tool" });
		const later = message(2);
		const result = await collect({
			kind: "after_block",
			messageId: boundary,
			keepThroughBlockIndex: 0,
		});
		expect(result.history.messages.map((m) => m.id)).toEqual([boundary, later]);
		expect(result.history.messages.some((m) => m.id === early)).toBe(false);
		expect(result.boundary?.retainedThroughKey).toMatch(/^[a-f0-9]{64}$/);
		expect(
			result.history.blocks.filter((b) => b.messageId === boundary).map((b) => b.action),
		).toEqual(["retain", "remove", "remove"]);
		expect(result.tools[0].id).toBe(removed.id);
		expect(JSON.stringify(result)).not.toContain('"index":');
	});
	test("after-block sequence ties and duplicate/missing block IDs are explicitly unverified", async () => {
		const boundary = message(1);
		message(1);
		await rejected(
			collect({ kind: "after_block", messageId: boundary, keepThroughBlockIndex: 0 }),
			"ORDER_UNVERIFIED",
		);
		const duplicate = message(2, [
			{ type: "tool_use", id: "same" },
			{ type: "tool_use", id: "same" },
		]);
		await rejected(collect({ kind: "messages", messageIds: [duplicate] }), "BODY_UNVERIFIED");
	});
	test("partial shared message is copied once and retained tool rows are budgeted without bodies", async () => {
		const boundary = message(1, [
			{ type: "tool_use", id: "keep-tool", name: "Read", input: {} },
			{ type: "tool_use", id: "remove-tool", name: "Read", input: {} },
		]);
		const keep = tool(1, "Read", { providerId: "keep-tool", messageId: boundary });
		const remove = tool(1, "Read", { providerId: "remove-tool", messageId: boundary });
		sqlite
			.query(
				"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES('shared','other',?,1)",
			)
			.run(boundary);
		const result = await collect({ kind: "tool_calls", toolCallIds: [remove.id] });
		expect(result.history.messages).toHaveLength(1);
		expect(result.history.messages[0].action).toBe("copy_on_write");
		expect(result.history.toolChanges).toContainEqual({ id: keep.id, action: "copy" });
		expect(result.history.toolChanges).toContainEqual({ id: remove.id, action: "retain" });
		expect(result.history.budget.messageRefChanges).toBe(2);
		expect(result.tools.map((t) => t.id)).toEqual([remove.id]);
	});
	test("all selected shared message is unlinked, not deleted with another narrator's tool rows", async () => {
		const t = tool(1, "Read");
		sqlite
			.query(
				"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES('shared','other',?,1)",
			)
			.run(t.messageId);
		const result = await collect();
		expect(result.history.messages[0].action).toBe("unlink");
		expect(result.history.budget.messageRefChanges).toBe(1);
		expect(result.history.toolChanges[0].action).toBe("retain");
	});
	test("potential cascades and SET NULL rows include question/continuation/spec/commit/API pointers", async () => {
		const t = tool(1, "Read");
		sqlite.query("INSERT INTO narrator_questions VALUES('q',?)").run(t.id);
		sqlite.query("INSERT INTO narrator_tool_continuations VALUES('continue',?)").run(t.id);
		sqlite.query("INSERT INTO knowledge_injection_events VALUES('k',?,?)").run(t.messageId, t.id);
		sqlite.query("INSERT INTO spec_file_revisions VALUES('s',?)").run(t.messageId);
		sqlite.query("INSERT INTO chapter_commits VALUES('c',?)").run(t.messageId);
		sqlite.query("INSERT INTO api_requests VALUES('a',?)").run(t.messageId);
		const result = await collect();
		expect(result.history.associations).toHaveLength(7);
		expect(result.history.budget.relatedRows).toBe(7); // one deleted call + 6 distinct dependent rows
	});
});

describe("complete mutation candidates, not just successful writes", () => {
	test("failed and interrupted actual measured writes remain in the effect set", async () => {
		for (const outcome of ["failed", "interrupted"]) {
			const t = tool(serial);
			const op = journal(t);
			sqlite.query("UPDATE narrator_tool_calls SET status='fail' WHERE id=?").run(t.id);
			sqlite
				.query("UPDATE file_change_operations SET execution_outcome=? WHERE id=?")
				.run(outcome, op);
		}
		const result = await collect();
		expect(result.effects).toHaveLength(2);
		expect(result.evidenceComplete).toBe(true);
	});
	test("a body tool block without its durable tool row remains an explicit missing candidate", async () => {
		message(1, [
			{ type: "tool_use", id: "missing-row", name: "Write", input: { content: "not evidence" } },
		]);
		const result = await collect();
		expect(result.evidenceComplete).toBe(false);
		expect(hasIssue(result, "TOOL_CALL_MISSING")).toBe(true);
	});
	test("unknown/plugin tools, missing journal and pending effects never become zero file changes", async () => {
		const unknown = tool(1, "plugin:writer");
		const pending = tool(2);
		const op = journal(pending);
		sqlite
			.query(
				"UPDATE file_change_effects SET settlement='reconcile_required',execution_confirmed=0 WHERE operation_id=?",
			)
			.run(op);
		const result = await collect();
		expect(result.tools.map((t) => t.id)).toEqual([unknown.id, pending.id]);
		expect(result.evidenceComplete).toBe(false);
		expect(result.noDiskTools).toContainEqual({
			toolCallId: unknown.id,
			reason: "non_file_change",
		});
		expect(hasIssue(result, "EFFECT_UNRESOLVED")).toBe(true);
	});
	test("explicit fixed no-dispatch zero-effect terminal is distinct from a missing effect journal", async () => {
		const t = tool(1);
		const op = journal(t, 0);
		sqlite
			.query(
				"UPDATE file_change_operations SET evidence_bytes=0,execution_outcome='failed',effect_outcome='no_change',attribution_grade='unknown',reason='no_dispatch:validation_rejected' WHERE id=?",
			)
			.run(op);
		const result = await collect();
		expect(result.evidenceComplete).toBe(true);
		expect(result.noDiskTools).toContainEqual({ toolCallId: t.id, reason: "no_dispatch" });
		sqlite.query("UPDATE file_change_operations SET reason=NULL WHERE id=?").run(op);
		expect(hasIssue(await collect(), "OPERATION_UNRESOLVED")).toBe(true);
	});
	test("sys/user leftover cards in a mixed from_seq window do not veto file coverage", async () => {
		const write = tool(1);
		journal(write);
		message(
			2,
			[{ type: "system_injection", source: "interrupt_task_guard" }],
			"root",
			"sys-card",
			"sys",
		);
		message(3, [{ type: "text", text: "later user" }], "root", "user-card", "user");
		const result = await collect({ kind: "from_seq", minSeq: 1 });
		expect(result.history.messages.map((m) => m.id)).toEqual([
			write.messageId,
			"sys-card",
			"user-card",
		]);
		expect(result.evidenceComplete).toBe(true);
		expect(result.issues).toEqual([]);
		expect(result.effects).toHaveLength(1);
	});
	test("an unmeasured Bash operation cannot veto independently journaled file effects", async () => {
		const write = tool(1, "Write");
		journal(write);
		const bash = tool(2, "Bash");
		const bashOperation = journal(bash);
		sqlite
			.query(
				"UPDATE file_change_operations SET settlement='reconcile_required',unresolved_effect_count=1 WHERE id=?",
			)
			.run(bashOperation);

		const result = await collect({ kind: "from_seq", minSeq: 1 });
		expect(result.evidenceComplete).toBe(true);
		expect(result.issues).toEqual([]);
		expect(result.effects).toHaveLength(1);
		expect(result.operations.map((operation) => operation.id)).toEqual(
			expect.not.arrayContaining([bashOperation]),
		);
		expect(result.noDiskTools).toContainEqual({ toolCallId: bash.id, reason: "non_file_change" });
	});
	test("an unknown non-file tool with a stale operation pointer cannot veto file effects", async () => {
		const write = tool(1, "Write");
		journal(write);
		const unknown = tool(2, "plugin:writer");
		sqlite
			.query(
				"UPDATE narrator_tool_calls SET file_change_operation_id='missing-op',status='pending' WHERE id=?",
			)
			.run(unknown.id);

		const result = await collect({ kind: "from_seq", minSeq: 1 });
		expect(result.evidenceComplete).toBe(true);
		expect(result.issues).toEqual([]);
		expect(result.effects).toHaveLength(1);
		expect(result.noDiskTools).toContainEqual({
			toolCallId: unknown.id,
			reason: "non_file_change",
		});
	});
	test("an active file tool is deferred without vetoing settled earlier effects", async () => {
		const write = tool(1, "Write");
		journal(write);
		const active = tool(2, "Write");
		sqlite.query("UPDATE narrator_tool_calls SET status='running' WHERE id=?").run(active.id);

		const result = await collect({ kind: "from_seq", minSeq: 1 });
		expect(result.evidenceComplete).toBe(true);
		expect(result.issues).toEqual([]);
		expect(result.effects).toHaveLength(1);
		expect(result.noDiskTools).toContainEqual({ toolCallId: active.id, reason: "pending" });
	});
});

for (const selector of [
	{ kind: "all" },
	{ kind: "messages", messageIds: ["checkpoint"] },
	{ kind: "from_seq", minSeq: 1 },
] satisfies FileChangeRevertSelector[]) {
	test(`disp file-history checkpoints retain file evidence for ${selector.kind}`, async () => {
		const hidden = message(1, [{ type: "file_history_checkpoint" }], "root", "checkpoint", "disp");
		const t = tool(1, "Write", { messageId: hidden });
		sqlite
			.query("UPDATE narrator_tool_calls SET is_file_history_checkpoint=1 WHERE id=?")
			.run(t.id);
		const op = journal(t);
		const result = await collect(selector);
		expect(result.history.toolChanges).toContainEqual({ id: t.id, action: "delete" });
		expect(result.tools.map((row) => row.id)).toEqual([t.id]);
		expect(result.operations.map((row) => row.id)).toEqual([op]);
		expect(result.effects).toHaveLength(1);
		expect(result.evidenceComplete).toBe(true);
		expect(result.issues).toEqual([]);

		sqlite
			.query("UPDATE narrator_tool_calls SET file_change_operation_id=NULL WHERE id=?")
			.run(t.id);
		const missing = await collect(selector);
		expect(missing.evidenceComplete).toBe(false);
		expect(missing.issues).toContainEqual({ code: "FILE_JOURNAL_MISSING", toolCallId: t.id });
	});
}
test("a leftover assistant write without a journal still refuses mixed from_seq coverage", async () => {
	const write = tool(1);
	journal(write);
	tool(2, "Write", { id: "assistant-gap-tool" });
	const result = await collect({ kind: "from_seq", minSeq: 1 });
	expect(result.evidenceComplete).toBe(false);
	expect(hasIssue(result, "FILE_JOURNAL_MISSING")).toBe(true);
});
test("spec writes and real read-only tools are excluded independently of unknown disk evidence", async () => {
	const read = tool(1, "Read");
	const spec = tool(2);
	sqlite
		.query(
			"UPDATE narrator_tool_calls SET execution_path_flavor='spec',resolved_file_path='spec://tasks.json',canonical_file_path=NULL WHERE id=?",
		)
		.run(spec.id);
	const disk = tool(3);
	const result = await collect();
	expect(result.noDiskTools).toEqual([
		{ toolCallId: read.id, reason: "read_only" },
		{ toolCallId: spec.id, reason: "spec" },
	]);
	expect(result.issues).toContainEqual({ code: "FILE_JOURNAL_MISSING", toolCallId: disk.id });
});
test("Bash background initial success does not settle a live or missing background task", async () => {
	const t = tool(1, "Bash");
	sqlite.query("UPDATE narrator_tool_calls SET is_background=1 WHERE id=?").run(t.id);
	sqlite
		.query(
			"INSERT INTO background_tasks(id,status,type,parent_narrator_id,tool_call_id,execution_attempt) VALUES('bg','running','bash','root',?,1)",
		)
		.run(t.id);
	let result = await collect();
	expect(hasIssue(result, "BACKGROUND_UNRESOLVED")).toBe(false);
	expect(result.evidenceComplete).toBe(true);
	expect(result.noDiskTools).toContainEqual({ toolCallId: t.id, reason: "non_file_change" });
	sqlite.query("UPDATE background_tasks SET status='failed'").run();
	result = await collect();
	expect(result.evidenceComplete).toBe(true);
	expect(result.tools).toHaveLength(1);
});
test("operation binding/expected count and reverse pins are not silently trusted", async () => {
	const t = tool(1);
	const op = journal(t, 2);
	sqlite
		.query("UPDATE file_change_operations SET attempt=2,expected_effect_count=3 WHERE id=?")
		.run(op);
	sqlite
		.query("UPDATE file_change_effects SET before_blob_digest=NULL WHERE operation_id=?")
		.run(op);
	const result = await collect();
	expect(result.effects).toHaveLength(2);
	expect(hasIssue(result, "ATTEMPT_BINDING_MISMATCH")).toBe(true);
	expect(hasIssue(result, "OPERATION_UNRESOLVED")).toBe(true);
	expect(hasIssue(result, "EFFECT_PIN_MISSING")).toBe(true);
});
test("active read tools and retired/mismatched scopes do not authorize history execution", async () => {
	const read = tool(1, "Read");
	const write = tool(2);
	journal(write);
	sqlite.query("UPDATE narrator_tool_calls SET status='running' WHERE id=?").run(read.id);
	sqlite.query("UPDATE file_change_scopes SET status='retired'").run();
	const result = await collect();
	expect(hasIssue(result, "TOOL_ACTIVE_OR_UNKNOWN")).toBe(false);
	expect(hasIssue(result, "EFFECT_SCOPE_UNVERIFIED")).toBe(true);
	expect(result.evidenceComplete).toBe(false);
});

test("a receipt from another runtime generation is not the selected attempt's evidence", async () => {
	const op = journal(tool(1));
	sqlite
		.query(
			"UPDATE file_change_effects SET execution_receipt_json=json_set(execution_receipt_json,'$.executionBinding.runtimeGeneration',2) WHERE operation_id=?",
		)
		.run(op);
	const result = await collect();
	expect(hasIssue(result, "EFFECT_UNRESOLVED")).toBe(true);
	expect(result.evidenceComplete).toBe(false);
});

test("the full selected operation budget is enforced, not 256MiB independently per operation", async () => {
	const first = journal(tool(1));
	const second = journal(tool(2));
	sqlite
		.query("UPDATE file_change_operations SET evidence_bytes=? WHERE id IN (?,?)")
		.run(160 * 1024 * 1024, first, second);
	await rejected(collect(), "BUDGET_EXCEEDED");
});

test("more than one effect page is fully included, not completed from its first 32 rows", async () => {
	const t = tool(1);
	journal(t, 70);
	const result = await collect();
	expect(result.effects).toHaveLength(70);
	expect(result.evidenceComplete).toBe(true);
});

describe("derived history requires actual origins and fresh authorization", () => {
	function childFixture() {
		const parent = tool(1, "Task");
		narrator("child");
		sqlite
			.query(
				"UPDATE narrators SET type='subagent',parent_narrator_id='root',origin_tool_call_id=?,acl_root_narrator_id='root' WHERE id='child'",
			)
			.run(parent.id);
		const child = tool(1, "Write", { narratorId: "child" });
		journal(child);
		sqlite
			.query("UPDATE narrator_messages SET parent_tool_use_id=? WHERE id=?")
			.run(parent.providerId, child.messageId);
		return { parent, child };
	}
	test("parent Task selects child initial segment and recursively includes grandchild", async () => {
		const parent = tool(1, "Task", { segment: "parent" });
		segment("parent", "root");
		narrator("child");
		sqlite
			.query(
				"UPDATE narrators SET type='subagent',parent_narrator_id='root',origin_tool_call_id=? WHERE id='child'",
			)
			.run(parent.id);
		segment("child-initial", "child", "parent");
		const child = tool(1, "Task", { narratorId: "child", segment: "child-initial" });
		narrator("grandchild");
		sqlite
			.query(
				"UPDATE narrators SET type='subagent',parent_narrator_id='child',origin_tool_call_id=? WHERE id='grandchild'",
			)
			.run(child.id);
		segment("grandchild-initial", "grandchild", "child-initial");
		const grandchild = tool(1, "Write", {
			narratorId: "grandchild",
			segment: "grandchild-initial",
		});
		journal(grandchild);
		const result = await collect();
		expect(result.effects).toHaveLength(1);
	});
	test("child writes in another segment are excluded explicitly", async () => {
		const { parent, child } = childFixture();
		segment("parent", "root");
		sqlite
			.query("UPDATE narrator_tool_calls SET execution_segment_id='parent' WHERE id=?")
			.run(parent.id);
		segment("child-initial", "child", "parent");
		sqlite
			.query("UPDATE narrator_tool_calls SET execution_segment_id='child-initial' WHERE id=?")
			.run(child.id);
		const later = tool(2, "Write", { narratorId: "child", segment: "other" });
		journal(later);
		const result = await collect();
		expect(result.noDiskTools).toContainEqual({
			toolCallId: later.id,
			reason: "outside_selected_call",
		});
	});
	test("exact child origin recursively includes child refs/tools/effects and COW budget", async () => {
		const { parent, child } = childFixture();
		const result = await collect();
		expect(result.effects).toHaveLength(1);
		expect(result.tools.map((t) => t.id)).toEqual([parent.id, child.id]);
		expect(result.history.messages).toHaveLength(2);
		expect(result.messageVersions.map((v) => v.narratorId)).toEqual(["root", "child"]);
		expect(result.evidenceComplete).toBe(true);
	});
	test("child denial, legacy origin and retry ambiguity cannot be repaired by toolUseId guesses", async () => {
		const { parent } = childFixture();
		denied.add("child");
		await expect(collect()).rejects.toThrow("ACL denied");
		denied.clear();
		sqlite.query("UPDATE narrators SET origin_tool_call_id=NULL WHERE id='child'").run();
		await rejected(collect(), "CHILD_ORIGIN_UNVERIFIED");
		sqlite.query("UPDATE narrators SET origin_tool_call_id=? WHERE id='child'").run(parent.id);
		sqlite.query("UPDATE narrator_tool_calls SET execution_attempt=2 WHERE id=?").run(parent.id);
		await rejected(collect(), "CHILD_ATTEMPT_UNVERIFIED");
	});
	test("selected launches share one complete parent scan instead of rescanning unrelated siblings", async () => {
		const launches = [tool(1, "Task"), tool(2, "Task"), tool(3, "Task")];
		for (let i = 0; i < 73; i++) {
			const id = `sibling-${i}`;
			narrator(id);
			sqlite
				.query(
					"UPDATE narrators SET type='subagent',parent_narrator_id='root',origin_tool_call_id=?,acl_root_narrator_id='root' WHERE id=?",
				)
				.run(launches[i]?.id ?? `unselected-launch-${i}`, id);
		}
		const result = await collect();
		expect(result.evidenceComplete).toBe(true);
		expect(result.noDiskTools.filter((row) => row.reason === "delegated")).toHaveLength(3);
		expect(
			queries.filter((query) => query.includes("SELECT id, origin_tool_call_id AS origin")),
		).toHaveLength(6); // One collection scan plus one bounded commitment verification.
		expect(authorized).not.toContain("sibling-72");
	});

	test("unrelated child candidates count toward a bounded inventory and cannot yield a complete prefix", async () => {
		tool(1, "Task");
		sqlite.transaction(() => {
			for (let i = 0; i <= REVERT_SELECTION_LIMITS.childNarrators; i++) {
				const id = `unrelated-${i}`;
				narrator(id);
				sqlite
					.query(
						"UPDATE narrators SET type='subagent',parent_narrator_id='root',origin_tool_call_id=? WHERE id=?",
					)
					.run(`unselected-${i}`, id);
			}
		})();
		await rejected(collect(), "BUDGET_EXCEEDED");
		expect(
			queries.filter((query) => query.includes("SELECT id, origin_tool_call_id AS origin")).length,
		).toBeLessThanOrEqual(32);
	});

	test("parent inventories are request-local and a later legacy child cannot hide behind a cache", async () => {
		childFixture();
		expect((await collect()).evidenceComplete).toBe(true);
		narrator("new-legacy-child");
		sqlite
			.query(
				"UPDATE narrators SET type='subagent',parent_narrator_id='root' WHERE id='new-legacy-child'",
			)
			.run();
		await rejected(collect(), "CHILD_ORIGIN_UNVERIFIED");
	});

	test("a complete parent inventory still rejects origin changes during child authorization", async () => {
		childFixture();
		service = new RevertSelectionService(
			{ $client: sqlite },
			{
				authorize: async (...args) => {
					await authorize(...args);
					if (args[1].id === "child")
						sqlite
							.query("UPDATE narrators SET origin_tool_call_id='changed-origin' WHERE id='child'")
							.run();
				},
				onSlow: () => {},
			},
		);
		await rejected(collect(), "STALE");
	});

	test("a child linked only by a globally reused provider ID is not silently selected", async () => {
		const parent = tool(1, "Task");
		const foreign = message(1, [{ type: "text", text: "foreign" }], "other");
		sqlite
			.query("UPDATE narrator_messages SET parent_tool_use_id=? WHERE id=?")
			.run(parent.providerId, foreign);
		await rejected(collect(), "CHILD_ORIGIN_UNVERIFIED");
	});
});

describe("bounded metadata collection and drift", () => {
	test("more than 32 refs including same sequence values are not lost", async () => {
		for (let i = 0; i < 75; i++) message(10);
		const result = await collect();
		expect(result.history.messages).toHaveLength(75);
		expect(new Set(result.history.messages.map((m) => m.id)).size).toBe(75);
	});
	test("oversized input/output stays unread for full deletion but rejects retained COW payload", async () => {
		const id = message(1, [
			{ type: "tool_use", id: "keep", name: "Read" },
			{ type: "text", text: "remove" },
		]);
		const t = tool(1, "Read", { providerId: "keep", messageId: id });
		sqlite
			.query("UPDATE narrator_tool_calls SET input_json=? WHERE id=?")
			.run("x".repeat(FILE_CHANGE_LIMITS.historyCowBytes + 1), t.id);
		expect((await collect()).evidenceComplete).toBe(true);
		sqlite.query("INSERT INTO narrator_message_refs VALUES('shared','other',?,1,NULL)").run(id);
		await rejected(
			collect({ kind: "after_block", messageId: id, keepThroughBlockIndex: 0 }),
			"BUDGET_EXCEEDED",
		);
	});
	test("message length is checked before parsing; oversized/invalid/compacting bodies cannot complete", async () => {
		const big = message(1, [
			{ type: "text", text: "x".repeat(REVERT_SELECTION_LIMITS.messageBytes) },
		]);
		await rejected(collect({ kind: "messages", messageIds: [big] }), "BUDGET_EXCEEDED");
		const compact = message(2, [{ type: "compact", status: "compacting" }]);
		await rejected(collect({ kind: "messages", messageIds: [compact] }), "BODY_UNVERIFIED");
	});
	test("5000 message/ref and 10000 related-row admission budgets include both deletion layers", async () => {
		sqlite.transaction(() => {
			for (let i = 0; i < 2501; i++) message(i);
		})();
		await rejected(collect(), "BUDGET_EXCEEDED");
		sqlite.exec("DELETE FROM narrator_message_refs; DELETE FROM narrator_messages;");
		const id = message(1);
		sqlite.transaction(() => {
			const insert = sqlite.query("INSERT INTO api_requests VALUES(?,?)");
			for (let i = 0; i < 10001; i++) insert.run(`api-${i}`, id);
		})();
		await rejected(collect(), "BUDGET_EXCEEDED");
	}, 30_000);
	test("cancellation/timeout and DB failure return no apparently complete manifest", async () => {
		message(1);
		const controller = new AbortController();
		const pending = collect({ kind: "all" }, { signal: controller.signal });
		controller.abort(new Error("cancelled"));
		await expect(pending).rejects.toThrow("cancelled");
		service = new RevertSelectionService(
			{ $client: sqlite },
			{ authorize, timeoutMs: 1, onSlow: () => {} },
		);
		await expect(collect()).rejects.toBeDefined();
		service = new RevertSelectionService({ $client: sqlite }, { authorize });
		sqlite.exec("DROP TABLE api_requests");
		await expect(collect()).rejects.toBeDefined();
	});
	test("unrelated same-connection writes do not invalidate source capture or metadata digest", async () => {
		for (let i = 0; i < 70; i++) message(i);
		const unrelated = message(1, [{ type: "text", text: "other" }], "other");
		const expected = await collect();
		let pages = 0;
		beforeQuery = (query) => {
			if (query.includes("FROM narrator_message_refs r") && query.includes("ORDER BY r.seq")) {
				pages++;
				sqlite
					.query("UPDATE narrators SET message_version=message_version+1 WHERE id='other'")
					.run();
				sqlite
					.query("UPDATE narrator_messages SET content_text=? WHERE id=?")
					.run(`changed-${pages}`, unrelated);
			}
		};
		const result = await collect();
		expect(pages).toBeGreaterThan(3);
		expect(result.selectionComplete).toBe(true);
		expect(result.metadataDigest).toBe(expected.metadataDigest);
		expect(queries.some((query) => /total_changes|data_version/i.test(query))).toBe(false);
	});

	test("unrelated commits on another connection do not invalidate preview via data_version", async () => {
		const directory = mkdtempSync(join(tmpdir(), "revert-selection-drift-"));
		const path = join(directory, "fixture.db");
		const source = new Database(path);
		const writer = new Database(path);
		try {
			source.exec(DDL);
			source.exec(`
				INSERT INTO narrators(id,owner_user_id) VALUES('root','alice'),('other','bob');
				INSERT INTO narrator_messages(id,narrator_id,content_json) VALUES('selected','root','[{"type":"text","text":"old"}]');
				INSERT INTO narrator_message_refs VALUES('selected-ref','root','selected',1,NULL);
			`);
			service = new RevertSelectionService({ $client: source }, { authorize, onSlow: () => {} });
			const initial = source
				.query<{ data_version: number }, []>("PRAGMA data_version")
				.get()?.data_version;
			const pending = collect();
			await new Promise<void>((resolve) => setImmediate(resolve));
			writer.query("UPDATE narrators SET message_version=message_version+1 WHERE id='other'").run();
			expect(
				source.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version,
			).not.toBe(initial);
			expect((await pending).selectionComplete).toBe(true);
		} finally {
			writer.close();
			source.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("a worker-await write to an unrelated source no longer refuses selection", async () => {
		message(1);
		const unrelated = message(1, [{ type: "text", text: "old" }], "other");
		const pending = collect();
		await new Promise<void>((resolve) => setImmediate(resolve));
		sqlite
			.query("UPDATE narrator_messages SET content_json=? WHERE id=?")
			.run(JSON.stringify([{ type: "text", text: "new" }]), unrelated);
		expect((await pending).selectionComplete).toBe(true);
	});

	test("same-connection mutation during the first worker await rejects despite same length/version", async () => {
		const id = message(1, [{ type: "text", text: "old" }]);
		const pending = collect();
		await new Promise<void>((resolve) => setImmediate(resolve));
		sqlite
			.query("UPDATE narrator_messages SET content_json=? WHERE id=?")
			.run(JSON.stringify([{ type: "text", text: "new" }]), id);
		await rejected(pending, "STALE");
	});
	test.each([
		["ref removal", "DELETE FROM narrator_message_refs WHERE narrator_id='root'"],
		["ref movement", "UPDATE narrator_message_refs SET seq=seq+1 WHERE narrator_id='root'"],
		["tool binding", "UPDATE narrator_tool_calls SET execution_attempt=2 WHERE narrator_id='root'"],
		["association removal", "DELETE FROM api_requests WHERE id='selected-request'"],
		[
			"association addition",
			"INSERT INTO api_requests VALUES('late-request', (SELECT id FROM narrator_messages WHERE narrator_id='root' LIMIT 1))",
		],
		[
			"shared ref addition",
			"INSERT INTO narrator_message_refs SELECT 'late-shared','other',id,1,NULL FROM narrator_messages WHERE narrator_id='root' LIMIT 1",
		],
	])("direct unversioned %s changes after collection still refuse the preview", async (_name, mutation) => {
		const t = tool(1, "Read");
		sqlite.query("INSERT INTO api_requests VALUES('selected-request',?)").run(t.messageId);
		let authorizations = 0;
		service = new RevertSelectionService(
			{ $client: sqlite },
			{
				authorize: async (...args) => {
					await authorize(...args);
					if (++authorizations === 2) sqlite.exec(mutation);
				},
				onSlow: () => {},
			},
		);
		await rejected(collect(), "STALE");
	});

	test("same-length body changes during the final digest are checked against the raw commitment", async () => {
		const selected = message(0, [{ type: "text", text: "old" }]);
		for (let i = 1; i < 80; i++) message(i);
		let authorizations = 0;
		service = new RevertSelectionService(
			{ $client: sqlite },
			{
				authorize: async (...args) => {
					await authorize(...args);
					if (++authorizations === 2)
						setImmediate(() => {
							sqlite
								.query("UPDATE narrator_messages SET content_json=? WHERE id=?")
								.run(JSON.stringify([{ type: "text", text: "new" }]), selected);
						});
				},
				onSlow: () => {},
			},
		);
		await rejected(collect(), "STALE");
	});

	test("final authorization rechecks the target version after its async callback", async () => {
		message(1);
		let authorizations = 0;
		service = new RevertSelectionService(
			{ $client: sqlite },
			{
				authorize: async (...args) => {
					await authorize(...args);
					if (++authorizations === 3)
						sqlite
							.query("UPDATE narrators SET message_version=message_version+1 WHERE id='root'")
							.run();
				},
				onSlow: () => {},
			},
		);
		await rejected(collect(), "STALE");
	});

	test("cancellation during the final metadata digest is observed between bounded rows", async () => {
		for (let i = 0; i < 80; i++) message(i);
		const controller = new AbortController();
		let authorizations = 0;
		service = new RevertSelectionService(
			{ $client: sqlite },
			{
				authorize: async (...args) => {
					await authorize(...args);
					if (++authorizations === 2)
						setImmediate(() => controller.abort(new Error("digest-cancelled")));
				},
				onSlow: () => {},
			},
		);
		await expect(collect({ kind: "all" }, { signal: controller.signal })).rejects.toThrow(
			"digest-cancelled",
		);
		expect(authorizations).toBe(2);
	});

	test("a mutation at the second reference page invalidates the whole capture", async () => {
		for (let i = 0; i < 70; i++) message(i);
		let pages = 0;
		beforeQuery = (query) => {
			if (
				query.includes("FROM narrator_message_refs r") &&
				query.includes("ORDER BY r.seq") &&
				++pages === 2
			)
				sqlite
					.query("UPDATE narrators SET message_version=message_version+1 WHERE id='root'")
					.run();
		};
		await rejected(collect(), "STALE");
		expect(pages).toBe(3);
	});

	test("a hung ACL callback is cancelled without holding a database transaction", async () => {
		const controller = new AbortController();
		service = new RevertSelectionService(
			{ $client: sqlite },
			{ authorize: () => new Promise(() => {}) },
		);
		const pending = collect({ kind: "all" }, { signal: controller.signal });
		controller.abort(new Error("stop-authorization"));
		await expect(pending).rejects.toThrow("stop-authorization");
		expect(sqlite.inTransaction).toBe(false);
	});

	test("dangling refs and hidden checkpoints cannot disappear through a join or visibility filter", async () => {
		sqlite
			.query("INSERT INTO narrator_message_refs VALUES('dangling','root','absent-message',0,NULL)")
			.run();
		await rejected(collect(), "BUDGET_EXCEEDED");
		sqlite.query("DELETE FROM narrator_message_refs WHERE id='dangling'").run();
		const hidden = message(1, [{ type: "text", text: "file checkpoint" }]);
		const t = tool(1, "Write", { messageId: hidden });
		journal(t);
		sqlite
			.query("UPDATE narrator_tool_calls SET is_file_history_checkpoint=1 WHERE id=?")
			.run(t.id);
		sqlite
			.query("UPDATE narrator_message_refs SET segment_compact_id=message_id WHERE message_id=?")
			.run(hidden);
		const result = await collect();
		expect(result.effects).toHaveLength(1);
		expect(result.evidenceComplete).toBe(true);
	});

	test("SQL selections have a source/key limit and never project tool input/output bodies", async () => {
		const t = tool(1);
		journal(t, 35);
		await collect();
		const selections = queries.filter((query) => /FROM /i.test(query));
		expect(selections.length).toBeGreaterThan(10);
		expect(selections.every((query) => /LIMIT (\?|1)/i.test(query))).toBe(true);
		expect(selections.some((query) => /COUNT\(|SUM\(|GROUP BY|SELECT \*/i.test(query))).toBe(false);
		expect(selections.some((query) => /input_json AS|output_json AS/i.test(query))).toBe(false);
		expect(
			selections.some(
				(query) =>
					query.includes("idx_fc_effect_operation_file") && query.includes("(file_key, phase) >"),
			),
		).toBe(true);
	});

	test("ambient transactions are refused, and read collection never opens a write transaction", async () => {
		sqlite.exec("BEGIN");
		expect(() => new RevertSelectionService({ $client: sqlite }, { authorize })).toThrow();
		sqlite.exec("ROLLBACK");
		message(1);
		await collect();
		expect(sqlite.inTransaction).toBe(false);
	});
	test("metadata is deterministic, no raw text/input/output returned, and database is not changed", async () => {
		const t = tool(1, "Read");
		sqlite
			.query(
				"UPDATE narrator_tool_calls SET input_json='private command input',output_json='private raw output' WHERE id=?",
			)
			.run(t.id);
		const before = sqlite.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n;
		const first = await collect();
		const second = await collect();
		expect(first.metadataDigest).toBe(second.metadataDigest);
		expect(JSON.stringify(first)).not.toContain("private command input");
		expect(JSON.stringify(first)).not.toContain("private raw output");
		expect(sqlite.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n).toBe(before);
	});
});
