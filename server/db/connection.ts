import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const narraforkDir = resolve(homedir(), ".narrafork");

export function getDbDir(): string {
	return narraforkDir;
}

export function getDbPath(): string {
	return resolve(narraforkDir, "narrafork.db");
}

/** Open a SQLite connection with standard NarraFork PRAGMA settings. */
export function openDatabase(dbPath?: string): Database {
	mkdirSync(narraforkDir, { recursive: true });
	const conn = new Database(dbPath ?? getDbPath());
	conn.run("PRAGMA journal_mode = WAL");
	conn.run("PRAGMA foreign_keys = ON");
	conn.run("PRAGMA busy_timeout = 5000");
	return conn;
}
