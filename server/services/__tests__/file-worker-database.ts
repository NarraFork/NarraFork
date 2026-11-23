import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSchemaCopyAt } from "../../../tests/sqlite-schema-image";
import { closeReadDatabase } from "../../lib/db-worker/pool";

const roots = new WeakMap<Database, string>();

export function openFileWorkerDatabase(template?: Database): Database {
	const root = mkdtempSync(join(tmpdir(), "file-read-worker-"));
	const path = join(root, "state.db");
	const database = template ? openSchemaCopyAt(template, path) : new Database(path);
	database.exec(
		"PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;",
	);
	roots.set(database, root);
	return database;
}

export async function closeFileWorkerDatabase(database: Database): Promise<void> {
	const root = roots.get(database);
	if (root) await closeReadDatabase(database.filename, { timeoutMs: 5000 });
	database.close(true);
	if (root) {
		roots.delete(database);
		rmSync(root, { recursive: true, force: true });
	}
}

export async function settleWorkerRead<T>(pending: Promise<T>) {
	// Settle Worker I/O before entering Bun's synchronous rejection matcher.
	try {
		const value = await pending;
		return { result: () => Promise.resolve(value) };
	} catch (error) {
		return { result: () => Promise.reject(error) };
	}
}
