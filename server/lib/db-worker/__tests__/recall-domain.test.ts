import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDomainTask } from "../../../db/worker-read";
import { drainDbWorkerPool, resetDbWorkerPoolForTest } from "../pool";

let home: string;
let database: Database;
const strict = { executionPolicy: "worker-required" as const };
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "nf-recall-domain-"));
	database = new Database(join(home, "fixture.db"));
	database.run("PRAGMA journal_mode=WAL");
	database.run("CREATE TABLE narrators(id TEXT PRIMARY KEY,title TEXT,model TEXT)");
	database.run(
		"CREATE TABLE narrator_messages(id TEXT PRIMARY KEY,role TEXT,content_text TEXT,created_at TEXT,origin TEXT)",
	);
	database.run("CREATE TABLE narrator_message_refs(narrator_id TEXT,message_id TEXT,seq INTEGER)");
	database.run(
		"CREATE TABLE narrator_tool_calls(id TEXT PRIMARY KEY,tool_use_id TEXT,tool_name TEXT,status TEXT,input_json TEXT,output_json TEXT,duration_ms INTEGER,error_message TEXT,created_at TEXT,narrator_id TEXT,message_id TEXT)",
	);
	database.run("INSERT INTO narrators VALUES ('n1','First','model'),('n2','Second','model')");
	database.run("INSERT INTO narrator_messages VALUES ('shared','assistant',?,'2026-01-01',NULL)", [
		"preview".repeat(200),
	]);
	database.run("INSERT INTO narrator_message_refs VALUES ('n1','shared',1),('n2','shared',1)");
	database.run("ALTER TABLE narrators ADD COLUMN refs_inherited_from TEXT");
	database.run("ALTER TABLE narrators ADD COLUMN refs_backfill_cursor INTEGER");
	database.run("ALTER TABLE narrator_message_refs ADD COLUMN segment_compact_id TEXT");
	database.run(
		"INSERT INTO narrator_tool_calls VALUES ('t1','use1','Bash','completed',?,NULL,12,NULL,'2026-01-01','n1','shared'),('t2','use2','Bash','completed',?,NULL,13,NULL,'2026-01-01','n2','shared')",
		[JSON.stringify({ command: "pwd" }), JSON.stringify({ command: "private" })],
	);
	resetDbWorkerPoolForTest();
});
afterEach(async () => {
	await drainDbWorkerPool({ timeoutMs: 5000 });
	database.close();
	rmSync(home, { recursive: true, force: true });
});

test("fixed Recall conversation handler runs off-thread with shared refs and target-owned tools", async () => {
	const prepare = spyOn(database, "prepare").mockImplementation(() => {
		throw new Error("main-thread SQL is forbidden");
	});
	try {
		const result = await readDomainTask(
			database,
			"recallConversation",
			{ narratorId: "n1", messageId: null, limit: 5, includeToolCalls: true },
			strict,
		);
		expect(result.narrator?.id).toBe("n1");
		expect(result.messageMissing).toBe(false);
		expect(result.rows.map((row) => row.id)).toEqual(["shared"]);
		expect(result.rows[0].content_text?.length).toBe(500);
		expect(result.tools.map((tool) => tool.tool_use_id)).toEqual(["use1"]);
		expect(result.tools[0].summary.length).toBeLessThanOrEqual(60);
		const missing = await readDomainTask(
			database,
			"recallConversation",
			{ narratorId: "n1", messageId: "missing", limit: 1 },
			strict,
		);
		expect(missing.messageMissing).toBe(true);
		expect(missing.rows).toEqual([]);
	} finally {
		prepare.mockRestore();
	}
});

test("message page domain reads stored Unicode text after refs validation, never on owner thread", async () => {
	database.run("ALTER TABLE narrator_messages ADD COLUMN content_json TEXT");
	database.run("ALTER TABLE narrator_messages ADD COLUMN origin_label TEXT");
	database.run("ALTER TABLE narrator_messages ADD COLUMN body_revision INTEGER DEFAULT 7");
	database.run("ALTER TABLE narrator_messages ADD COLUMN state_revision INTEGER DEFAULT 0");
	const text = "用户😄原话".repeat(100);
	database.run("UPDATE narrator_messages SET content_json=? WHERE id='shared'", [
		JSON.stringify([{ type: "text", text }]),
	]);
	const prepare = spyOn(database, "prepare").mockImplementation(() => {
		throw new Error("owning-thread SQL forbidden");
	});
	try {
		const page = await readDomainTask(
			database,
			"recallMessage",
			{ narratorId: "n2", messageId: "shared", offset: 3, maxChars: 9 },
			strict,
		);
		expect(page).toMatchObject({
			narratorId: "n2",
			text: Array.from(text).slice(3, 12).join(""),
			nextOffset: 12,
			totalChars: Array.from(text).length,
			bodyRevision: 7,
		});
		expect(
			await readDomainTask(
				database,
				"recallMessage",
				{ narratorId: "missing", messageId: "shared", offset: 0, maxChars: 10 },
				strict,
			),
		).toBeNull();
	} finally {
		prepare.mockRestore();
	}
});

test("worker resolves inherited anchors and exact cursors without materializing refs on its owner", async () => {
	database.run(
		"UPDATE narrators SET refs_inherited_from='n2', refs_backfill_cursor=3 WHERE id='n1'",
	);
	database.run("DELETE FROM narrator_message_refs WHERE narrator_id='n1'");
	database.run(
		"INSERT INTO narrator_messages VALUES ('tie','user','old request','2026-01-01','user')",
	);
	database.run(
		"INSERT INTO narrator_message_refs(narrator_id,message_id,seq) VALUES ('n2','tie',1)",
	);
	const prepare = spyOn(database, "prepare").mockImplementation(() => {
		throw new Error("main-thread SQL is forbidden");
	});
	try {
		const around = await readDomainTask(
			database,
			"recallConversation",
			{ narratorId: "n1", messageId: "tie", limit: 1 },
			strict,
		);
		expect(around.narrator?.id).toBe("n1");
		expect(around.rows.map((row) => row.id)).toEqual(["tie"]);
		expect(around.pagination.olderCursor).toEqual({ seq: 1, messageId: "tie" });
		const older = await readDomainTask(
			database,
			"recallConversation",
			{
				narratorId: "n1",
				messageId: null,
				limit: 1,
				cursor: around.pagination.olderCursor ?? undefined,
			},
			strict,
		);
		expect(older.rows.map((row) => row.id)).toEqual(["shared"]);
		expect(older.pagination.hasNewer).toBe(true);
		expect(prepare).not.toHaveBeenCalled();
	} finally {
		prepare.mockRestore();
	}
	expect(
		database.query("SELECT * FROM narrator_message_refs WHERE narrator_id='n1'").all(),
	).toEqual([]);
});

test("dedicated tool-detail budget preserves complete payloads beyond generic SELECT size", async () => {
	const size = 5 * 1024 * 1024;
	database.run("UPDATE narrator_tool_calls SET output_json=? WHERE id='t1'", ["x".repeat(size)]);
	const prepare = spyOn(database, "prepare").mockImplementation(() => {
		throw new Error("main-thread SQL is forbidden");
	});
	try {
		const result = await readDomainTask(
			database,
			"recallToolCallDetail",
			{ toolCallId: "use1", narratorId: "n1" },
			strict,
		);
		expect(result?.tool_use_id).toBe("use1");
		expect(result?.output_json?.length).toBe(size);
		expect(result?.input_json).toBe(JSON.stringify({ command: "pwd" }));
		expect(
			await readDomainTask(
				database,
				"recallToolCallDetail",
				{ toolCallId: "use1", narratorId: "n2" },
				strict,
			),
		).toBeNull();
		expect(
			(
				await readDomainTask(
					database,
					"recallToolCallDetail",
					{ toolCallId: "use2", narratorId: null },
					strict,
				)
			)?.narrator_id,
		).toBe("n2");
	} finally {
		prepare.mockRestore();
	}
}, 30_000);
