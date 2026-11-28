import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { testEnvironment } from "../../../tests/preload";
import { getTestDb } from "../../../tests/setup";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";
import { runReadTask, shutdownDbWorkerPool } from "../../lib/db-worker/pool";

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
			await shutdownDbWorkerPool();
			sqlite.close();
			for (let attempt = 0; ; attempt++) {
				try {
					await rm(directory, { recursive: true, force: true });
					break;
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (
						process.platform !== "win32" ||
						attempt >= 4 ||
						!["EBUSY", "EPERM"].includes(code ?? "")
					)
						throw error;
					await delay(50 * (attempt + 1));
				}
			}
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
