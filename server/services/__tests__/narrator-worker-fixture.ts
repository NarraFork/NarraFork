import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { testEnvironment } from "../../../tests/preload";
import { getTestDb } from "../../../tests/setup";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";
import { closeReadDatabase, runReadTask, shutdownDbWorkerPool } from "../../lib/db-worker/pool";

/** Per-file isolated schema; strict Worker reads observe committed WAL pages. */
export function getNarratorWorkerTestDb() {
	const source = getTestDb();
	const directory = mkdtempSync(join(testEnvironment.narraforkHome, "narrator-worker-"));
	const path = join(directory, "fixture.sqlite");
	try {
		writeFileSync(path, source.sqlite.serialize());
	} finally {
		source.sqlite.close();
	}
	const sqlite = new Database(path);
	sqlite.run("PRAGMA journal_mode = WAL");
	sqlite.run("PRAGMA foreign_keys = ON");
	sqlite.run("PRAGMA busy_timeout = 50");
	const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
	const ready = runReadTask(
		path,
		{ kind: "selectRows", sql: "SELECT 1", params: [], maxRows: 1 },
		{ timeoutMs: 30_000 },
	);
	let closing: Promise<void> | undefined;
	function close(): Promise<void> {
		closing ??= (async () => {
			// A failed probe still needs the same acknowledged handle cleanup.
			await ready.catch(() => {});
			// Close this database's admission before retiring its native Worker handles.
			await closeReadDatabase(path);
			await shutdownDbWorkerPool();
			// Finalize Drizzle statements now; deferred disposal holds file locks on Windows.
			sqlite.close(true);
			rmSync(directory, { recursive: true, force: true });
		})();
		return closing;
	}
	return { db, sqlite, ready, close };
}

export async function captureWorkerRejection(work: PromiseLike<unknown>): Promise<unknown> {
	try {
		await work;
	} catch (error) {
		return error;
	}
	throw new Error("Expected the worker operation to reject");
}

export async function captureWorkerRejectionThrower(
	work: PromiseLike<unknown>,
): Promise<() => never> {
	const error = await captureWorkerRejection(work);
	return () => {
		throw error;
	};
}
