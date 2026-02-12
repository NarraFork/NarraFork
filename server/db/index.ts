import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as relations from "./relations";
import * as schema from "./schema";

const narraforkDir = resolve(homedir(), ".narrafork");
mkdirSync(narraforkDir, { recursive: true });

const dbPath = resolve(narraforkDir, "narrafork.db");
const sqlite = new Database(dbPath);

sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA foreign_keys = ON");

export const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
export { sqlite };
