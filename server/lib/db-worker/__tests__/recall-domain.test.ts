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
		"CREATE TABLE narrator_messages(id TEXT PRIMARY KEY,role TEXT,content_text TEXT,created_at TEXT)",
	);
	database.run("CREATE TABLE narrator_message_refs(narrator_id TEXT,message_id TEXT,seq INTEGER)");
	database.run(
		"CREATE TABLE narrator_tool_calls(id TEXT PRIMARY KEY,tool_use_id TEXT,tool_name TEXT,status TEXT,input_json TEXT,output_json TEXT,duration_ms INTEGER,error_message TEXT,created_at TEXT,narrator_id TEXT,message_id TEXT)",
	);
	database.run("INSERT INTO narrators VALUES ('n1','First','model'),('n2','Second','model')");
	database.run("INSERT INTO narrator_messages VALUES ('shared','assistant',?,'2026-01-01')", [
		"preview".repeat(200),
	]);
	database.run("INSERT INTO narrator_message_refs VALUES ('n1','shared',1),('n2','shared',1)");
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
			{ narratorId: "n1", messageId: null, limit: 5 },
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
