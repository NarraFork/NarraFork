import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearedToolOutput, historyClearedText } from "@shared/storage-retention";
import { runEphemeralReadTask } from "../pool";
import type { StorageHistoryBodyResult } from "../protocol";
import { runStorageHistoryBody, runStorageHistoryRead } from "../storage-history-query";

let db: Database;
const old = "2020-01-01T00:00:00.000Z";
const cutoff = "2020-01-02T00:00:00.000Z";
beforeEach(() => {
	db = new Database(":memory:");
	db.exec(`CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, narrator_id TEXT,
		created_at TEXT, body_revision INTEGER DEFAULT 0, body_format INTEGER DEFAULT 1,
		body_rows_only INTEGER DEFAULT 0, body_bytes INTEGER DEFAULT 0, content_json TEXT DEFAULT '[]',
		content_text TEXT, original_content_json TEXT, composer_document TEXT, command_text TEXT);
		CREATE TABLE narrator_blocks (id TEXT PRIMARY KEY, message_id TEXT, ordinal INTEGER,
		revision INTEGER DEFAULT 0, phase TEXT DEFAULT 'done', payload TEXT, state TEXT, original_payload TEXT, provider_meta TEXT);
		CREATE TABLE narrator_block_sync_queue (message_id TEXT);
		CREATE TABLE narrator_tool_calls (id TEXT PRIMARY KEY, message_id TEXT, model_revision INTEGER DEFAULT 0,
		created_at TEXT, status TEXT DEFAULT 'success', is_file_history_checkpoint INTEGER DEFAULT 0,
		tool_name TEXT DEFAULT 'Bash', result_message_id TEXT, input_json TEXT, output_json TEXT);
		CREATE TABLE narrator_tool_continuations (id TEXT PRIMARY KEY, narrator_id TEXT,
		tool_call_id TEXT, state TEXT, payload_json TEXT);
		CREATE TABLE narrators (id TEXT PRIMARY KEY, parent_narrator_id TEXT,
		refs_inherited_from TEXT, refs_backfill_cursor INTEGER);
		CREATE TABLE narrator_message_refs (narrator_id TEXT, message_id TEXT, seq INTEGER);`);
});
afterEach(() => db.close());

function tool(
	id: string,
	date = old,
	input = "{}",
	output = '"result"',
	checkpoint = 0,
	status = "success",
) {
	db.query(
		"INSERT INTO narrator_tool_calls (id, message_id, created_at, input_json, output_json, is_file_history_checkpoint, status) VALUES (?, 'm', ?, ?, ?, ?, ?)",
	).run(id, date, input, output, checkpoint, status);
}
function message(id: string, content: unknown[], date = old) {
	db.query(
		"INSERT INTO narrator_messages (id,narrator_id,created_at,content_json) VALUES (?, 'n', ?, ?)",
	).run(id, date, JSON.stringify(content));
}

describe("read-only history cleanup statistics", () => {
	test("tool preview and candidate predicates share strict cutoff, terminal and checkpoint rules", () => {
		tool("old");
		tool("boundary", cutoff);
		tool("checkpoint", old, "{}", '"x"', 1);
		tool("pending", old, "{}", '"x"', 0, "pending");
		tool("cleared", old, "null", JSON.stringify(clearedToolOutput(old)));
		const rows = runStorageHistoryRead(db, {
			kind: "storageHistoryRead",
			mode: "candidates",
			target: "toolCallPayloads",
			cutoffAt: cutoff,
			afterRowid: 0,
			limit: 500,
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: "old", messageId: "m", revision: 0, approxBytes: 10 });
		const buckets = runStorageHistoryRead(db, {
			kind: "storageHistoryRead",
			mode: "buckets",
			target: "toolCallPayloads",
		});
		expect(buckets).toEqual([
			{ day: "2020-01-01", count: 1, approxBytes: 10 },
			{ day: "2020-01-02", count: 1, approxBytes: 10 },
		]);
	});
	test("old JSON, rows-only blocks, originals and provider metadata contribute their bytes", () => {
		message("legacy", [{ type: "text", text: "hello" }]);
		message("rows", []);
		db.query(
			"UPDATE narrator_messages SET body_format=2, body_rows_only=1, body_bytes=20 WHERE id='rows'",
		).run();
		db.query(
			"INSERT INTO narrator_blocks (id,message_id,ordinal,payload,original_payload,provider_meta) VALUES ('b','rows',0,?,?,?)",
		).run(JSON.stringify({ raw: [{ type: "text", text: "new" }] }), "original", "metadata");
		message("cleared", [historyClearedText(old)]);
		message("cleared-rows", []);
		db.query(
			"UPDATE narrator_messages SET body_format=2, body_rows_only=1, body_bytes=100 WHERE id='cleared-rows'",
		).run();
		db.query(
			"INSERT INTO narrator_blocks(id,message_id,ordinal,payload) VALUES ('bc','cleared-rows',0,?)",
		).run(JSON.stringify({ raw: [historyClearedText(old)] }));
		const rows = runStorageHistoryRead(db, {
			kind: "storageHistoryRead",
			mode: "candidates",
			target: "messageHistory",
			cutoffAt: cutoff,
			afterRowid: 0,
			limit: 32,
		});
		expect(rows.map((r) => (r as { id?: string }).id)).toEqual(["legacy", "rows"]);
		expect(rows[1]).toMatchObject({ approxBytes: 38 });
		expect(
			runStorageHistoryRead(db, {
				kind: "storageHistoryRead",
				mode: "buckets",
				target: "messageHistory",
			}),
		).toEqual([
			{
				day: "2020-01-01",
				count: 2,
				approxBytes: Buffer.byteLength(JSON.stringify([{ type: "text", text: "hello" }])) + 38,
			},
		]);
	});
	test("partial-day buckets and candidates honor the user's exact absolute time", () => {
		tool("early", "2020-01-01T01:00:00.000Z");
		tool("late", "2020-01-01T12:00:00.000Z");
		const rows = runStorageHistoryRead(db, {
			kind: "storageHistoryRead",
			mode: "buckets",
			target: "toolCallPayloads",
			dayOffsetMs: 6 * 60 * 60 * 1000,
		});
		expect(rows).toEqual([
			{ day: "2019-12-31", count: 1, approxBytes: 10 },
			{ day: "2020-01-01", count: 1, approxBytes: 10 },
		]);
		const candidates = runStorageHistoryRead(db, {
			kind: "storageHistoryRead",
			mode: "candidates",
			target: "toolCallPayloads",
			cutoffAt: "2020-01-01T06:00:00.000Z",
			afterRowid: 0,
			limit: 32,
		});
		expect(candidates).toEqual([
			{ rowid: 1, id: "early", messageId: "m", revision: 0, approxBytes: 10 },
		]);
	});
});

describe("bounded authoritative history bodies", () => {
	test("legacy body budgets are checked before reading the JSON value", () => {
		message("m", [{ type: "text", text: "x".repeat(1000) }]);
		expect(
			runStorageHistoryBody(db, {
				kind: "storageHistoryBody",
				messageId: "m",
				maxBytes: 100,
				maxBlocks: 10,
			}),
		).toBeNull();
		expect(
			runStorageHistoryBody(db, {
				kind: "storageHistoryBody",
				messageId: "m",
				maxBytes: 2000,
				maxBlocks: 10,
			}),
		).toMatchObject({ revision: 0, compact: false, blocks: [] });
	});
	test("rows-only compact markers are assembled from bounded block payload/state", () => {
		message("m", []);
		db.query(
			"UPDATE narrator_messages SET body_format=2, body_rows_only=1, body_revision=7 WHERE id='m'",
		).run();
		db.query(
			"INSERT INTO narrator_blocks(id,message_id,ordinal,revision,payload,state) VALUES ('b','m',0,3,?,?)",
		).run(
			JSON.stringify({ raw: [{ type: "compact", summary: "hello" }] }),
			JSON.stringify({ raw: [{ status: "completed" }] }),
		);
		const result = runStorageHistoryBody(db, {
			kind: "storageHistoryBody",
			messageId: "m",
			maxBytes: 2000,
			maxBlocks: 10,
		});
		expect(result).toMatchObject({
			revision: 7,
			compact: true,
			content: [{ type: "compact", summary: "hello", status: "completed" }],
		});
		expect(result?.blocks[0]).toMatchObject({ id: "b", revision: 3 });
	});
});

test("edited originals share the body read budget and remain available for selective redaction", () => {
	message("edited", [{ type: "text", text: "x".repeat(1000) }]);
	const original = [{ type: "text", text: "original".repeat(150) }];
	db.query("UPDATE narrator_messages SET original_content_json = ? WHERE id = 'edited'").run(
		JSON.stringify(original),
	);
	expect(
		runStorageHistoryBody(db, {
			kind: "storageHistoryBody",
			messageId: "edited",
			maxBytes: 1500,
			maxBlocks: 10,
		}),
	).toBeNull();
	expect(
		runStorageHistoryBody(db, {
			kind: "storageHistoryBody",
			messageId: "edited",
			maxBytes: 3000,
			maxBlocks: 10,
		})?.originalContent,
	).toEqual(original);
});

test("real read workers execute retention tasks without database bootstrap or writes", async () => {
	message("worker", [{ type: "text", text: "worker body" }]);
	db.run("PRAGMA application_id = 12345");
	const home = await mkdtemp(join(tmpdir(), "nf-history-read-worker-"));
	const path = join(home, "fixture.db");
	try {
		await writeFile(path, db.serialize());
		const body = await runEphemeralReadTask<StorageHistoryBodyResult | null>(
			path,
			{
				kind: "storageHistoryBody",
				messageId: "worker",
				maxBytes: 1024,
				maxBlocks: 10,
			},
			{ timeoutMs: 10_000 },
		);
		expect(body?.content).toEqual([{ type: "text", text: "worker body" }]);
		const rows = await runEphemeralReadTask<Array<{ id: string }>>(
			path,
			{
				kind: "storageHistoryRead",
				mode: "candidates",
				target: "messageHistory",
				cutoffAt: cutoff,
				afterRowid: 0,
				limit: 32,
			},
			{ timeoutMs: 10_000 },
		);
		expect(rows.map((r) => r.id)).toEqual(["worker"]);
		const check = new Database(path, { readonly: true });
		try {
			expect(check.query("PRAGMA application_id").get()).toEqual({ application_id: 12345 });
		} finally {
			check.close();
		}
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}, 30_000);

test("preview excludes file-replay inputs that remain as internal recovery evidence", () => {
	tool("write", old, JSON.stringify({ content: "x".repeat(10_000) }), '"result"');
	db.query("UPDATE narrator_tool_calls SET tool_name='Write' WHERE id='write'").run();
	const rows = runStorageHistoryRead(db, {
		kind: "storageHistoryRead",
		mode: "candidates",
		target: "toolCallPayloads",
		cutoffAt: cutoff,
		afterRowid: 0,
		limit: 32,
	});
	expect(rows[0]).toMatchObject({ id: "write", approxBytes: 8 });
});

test("content_text-only prose is prepared within the same total budget", () => {
	message("fallback", [{ type: "tool_use", id: "call", name: "Bash", input: {} }]);
	db.query("UPDATE narrator_messages SET content_text=? WHERE id='fallback'").run(
		"kept prose".repeat(100),
	);
	expect(
		runStorageHistoryBody(db, {
			kind: "storageHistoryBody",
			messageId: "fallback",
			maxBytes: 100,
			maxBlocks: 10,
		}),
	).toBeNull();
	expect(
		runStorageHistoryBody(db, {
			kind: "storageHistoryBody",
			messageId: "fallback",
			maxBytes: 2000,
			maxBlocks: 10,
		})?.contentText,
	).toBe("kept prose".repeat(100));
});

test("time buckets align to the selected local midnight including exact boundary milliseconds", () => {
	tool("before", "2020-01-01T05:59:59.999Z");
	tool("equal", "2020-01-01T06:00:00.000Z");
	tool("after", "2020-01-01T12:00:00.000Z");
	const rows = runStorageHistoryRead(db, {
		kind: "storageHistoryRead",
		mode: "buckets",
		target: "toolCallPayloads",
		dayOffsetMs: 6 * 60 * 60 * 1000,
	});
	expect(rows).toEqual([
		{ day: "2019-12-31", count: 1, approxBytes: 10 },
		{ day: "2020-01-01", count: 2, approxBytes: 20 },
	]);
	expect(
		runStorageHistoryRead(db, {
			kind: "storageHistoryRead",
			mode: "candidates",
			target: "toolCallPayloads",
			cutoffAt: "2020-01-01T06:00:00.000Z",
			afterRowid: 0,
			limit: 32,
		}),
	).toEqual([{ rowid: 1, id: "before", messageId: "m", revision: 0, approxBytes: 10 }]);
});

test("worker protects all undelivered continuation epochs and cross-owner result sources", () => {
	message("protected", [{ type: "text", text: "body" }]);
	db.query(
		"INSERT INTO narrator_tool_continuations VALUES ('c', 'n', 'call', 'completed', '{}')",
	).run();
	const params = {
		kind: "storageHistoryBody" as const,
		messageId: "protected",
		holderIds: ["n"],
		maxBytes: 4096,
		maxBlocks: 10,
	};
	expect(runStorageHistoryBody(db, params)?.blocked).toBe(true);
	db.query("UPDATE narrator_tool_continuations SET payload_json = ? WHERE id='c'").run(
		JSON.stringify({ recoveryPhase: "owner_continuation_started" }),
	);
	expect(runStorageHistoryBody(db, params)?.blocked).not.toBe(true);
	tool("other");
	db.query("UPDATE narrator_tool_calls SET result_message_id='protected' WHERE id='other'").run();
	db.query(
		"INSERT INTO narrator_tool_continuations VALUES ('other-c', 'other-owner', 'other', 'completed', '{}')",
	).run();
	expect(runStorageHistoryBody(db, params)?.blocked).toBe(true);
	db.query("UPDATE narrator_tool_continuations SET state='cancelled' WHERE id='other-c'").run();
	expect(runStorageHistoryBody(db, params)?.blocked).not.toBe(true);
});

test("worker rejects oversized protection inputs rather than truncating the protected holder set", () => {
	message("protected", [{ type: "text", text: "body" }]);
	expect(() =>
		runStorageHistoryBody(db, {
			kind: "storageHistoryBody",
			messageId: "protected",
			holderIds: Array.from({ length: 513 }, (_, i) => `holder-${i}`),
			maxBytes: 4096,
			maxBlocks: 10,
		}),
	).toThrow();
});

test("worker enumerates real, lazy-fork and ancestor holders off the server thread", () => {
	message("shared", [{ type: "text", text: "body" }]);
	db.exec(`INSERT INTO narrators VALUES ('parent',NULL,NULL,NULL), ('n','parent',NULL,NULL),
		('lazy','n','n',11), ('nested','lazy','lazy',11), ('outside',NULL,'n',10);
		INSERT INTO narrator_message_refs VALUES ('n','shared',10);`);
	const body = runStorageHistoryBody(db, {
		kind: "storageHistoryBody",
		messageId: "shared",
		maxBytes: 4096,
		maxBlocks: 10,
	});
	expect(new Set(body?.holderIds)).toEqual(new Set(["n", "parent", "lazy", "nested"]));
});

test("open blocks and active tools are protection work performed by the read worker", () => {
	message("active", [{ type: "text", text: "body" }]);
	const params = {
		kind: "storageHistoryBody" as const,
		messageId: "active",
		maxBytes: 4096,
		maxBlocks: 10,
	};
	db.query(
		"INSERT INTO narrator_blocks(id,message_id,ordinal,payload,phase) VALUES ('b','active',0,?, 'open')",
	).run(JSON.stringify({ raw: [{ type: "text", text: "body" }] }));
	expect(runStorageHistoryBody(db, params)?.blocked).toBe(true);
	db.query("UPDATE narrator_blocks SET phase='done' WHERE id='b'").run();
	tool("running", old, "{}", "null", 0, "running");
	db.query("UPDATE narrator_tool_calls SET message_id='active' WHERE id='running'").run();
	expect(runStorageHistoryBody(db, params)?.blocked).toBe(true);
});
