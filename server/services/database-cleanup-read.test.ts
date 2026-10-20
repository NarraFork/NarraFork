import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTransactionTask } from "../db/worker-read";
import { shutdownDbWorkerPool } from "../lib/db-worker/pool";
import {
	type DatabaseCleanupReadTask,
	executeDatabaseCleanupReadTask,
} from "./database-cleanup-read";

let root: string | undefined;
let connection: Database | undefined;
afterEach(async () => {
	await shutdownDbWorkerPool();
	connection?.close();
	if (root) await rm(root, { recursive: true, force: true });
});

test("cleanup worker preserves owner counts and excludes checkpoint payloads", async () => {
	root = await mkdtemp(join(tmpdir(), "nf-cleanup-read-"));
	connection = new Database(join(root, "fixture.sqlite"));
	connection.run("CREATE TABLE narrators (id TEXT PRIMARY KEY, title TEXT)");
	connection.run(
		"CREATE TABLE narrator_tool_calls (id TEXT PRIMARY KEY, narrator_id TEXT, created_at TEXT, is_file_history_checkpoint INTEGER, input_json TEXT, output_json TEXT)",
	);
	connection.run("INSERT INTO narrators VALUES ('owned','Owned'),('other','Other')");
	connection.run(
		"INSERT INTO narrator_tool_calls VALUES ('normal','owned','2025-01-01',0,'abc','def'),('checkpoint','owned','2025-01-01',1,'keep','keep'),('future','other','2027-01-01',0,'future',NULL)",
	);
	const tasks: DatabaseCleanupReadTask[] = [
		{
			kind: "databaseCleanupReadV1",
			action: "sessions",
			narratorIds: ["owned"],
			relations: [
				{
					tableName: "narrator_tool_calls",
					narratorColumn: "narrator_id",
					alias: "tc",
					countAs: "toolCalls",
				},
			],
		},
		{ kind: "databaseCleanupReadV1", action: "payloads", cutoffIso: "2026-01-01" },
	];
	for (const task of tasks) {
		const expected = executeDatabaseCleanupReadTask(connection, task);
		const result = await readTransactionTask<ReturnType<typeof executeDatabaseCleanupReadTask>>(
			{ $client: connection },
			task,
			() => {
				throw new Error("file query used main-thread fallback");
			},
		);
		expect(result).toEqual(expected);
		if (task.action === "sessions") expect(result).toMatchObject({ narrators: 1, toolCalls: 2 });
		else expect(result).toEqual({ count: 1, approxBytes: 6, oldestAt: "2025-01-01" });
	}
});
