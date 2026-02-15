/**
 * Test setup: in-memory SQLite database with full schema.
 *
 * Usage:
 *   import { getTestDb, cleanDb } from "../setup";
 *   const { db, sqlite } = getTestDb();
 *   afterEach(() => cleanDb(sqlite));
 */
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as relations from "../server/db/relations";
import * as schema from "../server/db/schema";

const DDL = `
CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	username TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'user',
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT,
	status TEXT NOT NULL DEFAULT 'active',
	default_agent TEXT DEFAULT 'claude',
	settings TEXT,
	git_path TEXT,
	remote_url TEXT,
	default_branch TEXT DEFAULT 'main',
	startup_script TEXT,
	copy_files TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chapters (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	title TEXT NOT NULL,
	description TEXT,
	status TEXT NOT NULL DEFAULT 'active',
	branch TEXT NOT NULL,
	worktree_path TEXT,
	base_branch TEXT NOT NULL,
	parent_chapter_id TEXT REFERENCES chapters(id),
	fork_point TEXT,
	merged_into_chapter_id TEXT REFERENCES chapters(id),
	merge_commit_sha TEXT,
	merge_strategy TEXT,
	container_config TEXT,
	last_accessed_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS narrators (
	id TEXT PRIMARY KEY,
	chapter_id TEXT REFERENCES chapters(id),
	claude_session_id TEXT,
	title TEXT,
	type TEXT NOT NULL DEFAULT 'primary',
	inherit_mode TEXT NOT NULL DEFAULT 'fresh',
	parent_narrator_id TEXT REFERENCES narrators(id),
	context_summary TEXT,
	model TEXT DEFAULT 'claude-sonnet',
	system_prompt TEXT,
	permission_mode TEXT DEFAULT 'default',
	sdk_plan_mode INTEGER NOT NULL DEFAULT 0,
	message_count INTEGER DEFAULT 0,
	total_cost_usd REAL DEFAULT 0,
	last_message_at TEXT,
	status TEXT NOT NULL DEFAULT 'idle',
	cwd TEXT,
	error_message TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS narrator_messages (
	id TEXT PRIMARY KEY,
	narrator_id TEXT NOT NULL REFERENCES narrators(id),
	sdk_message_uuid TEXT,
	parent_tool_use_id TEXT,
	role TEXT NOT NULL,
	content_json TEXT NOT NULL,
	content_text TEXT,
	tokens_in INTEGER,
	tokens_out INTEGER,
	cost_usd REAL,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS narrator_tool_calls (
	id TEXT PRIMARY KEY,
	narrator_id TEXT NOT NULL REFERENCES narrators(id),
	message_id TEXT NOT NULL REFERENCES narrator_messages(id),
	tool_use_id TEXT NOT NULL,
	tool_name TEXT NOT NULL,
	input_json TEXT,
	output_json TEXT,
	status TEXT NOT NULL DEFAULT 'pending',
	duration_ms INTEGER,
	error_message TEXT,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS permission_requests (
	id TEXT PRIMARY KEY,
	narrator_id TEXT NOT NULL REFERENCES narrators(id),
	tool_call_id TEXT REFERENCES narrator_tool_calls(id),
	tool_name TEXT NOT NULL,
	input_json TEXT,
	decision_reason TEXT,
	suggestions TEXT,
	decision TEXT NOT NULL DEFAULT 'pending',
	decided_by TEXT,
	deny_message TEXT,
	created_at TEXT NOT NULL,
	decided_at TEXT
);
CREATE TABLE IF NOT EXISTS terminals (
	id TEXT PRIMARY KEY,
	chapter_id TEXT REFERENCES chapters(id),
	name TEXT NOT NULL,
	cwd TEXT,
	dtach_socket TEXT,
	status TEXT NOT NULL DEFAULT 'running',
	exit_code INTEGER,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS container_instances (
	id TEXT PRIMARY KEY,
	chapter_id TEXT NOT NULL REFERENCES chapters(id),
	container_id TEXT,
	service_name TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'created',
	host_port INTEGER,
	container_port INTEGER,
	volume_name TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS port_allocations (
	port INTEGER PRIMARY KEY,
	chapter_id TEXT REFERENCES chapters(id),
	service_name TEXT,
	allocated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_favorite_directories (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id),
	path TEXT NOT NULL,
	label TEXT,
	sort_order INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL
);
`;

export function getTestDb() {
	const sqlite = new Database(":memory:");
	sqlite.run("PRAGMA foreign_keys = ON");
	sqlite.exec(DDL);
	const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
	return { db, sqlite };
}

/** Delete all rows from all tables (order matters for FK constraints). */
export function cleanDb(sqlite: Database) {
	sqlite.run("PRAGMA foreign_keys = OFF");
	const tables = sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
		.all() as Array<{ name: string }>;
	for (const { name } of tables) {
		sqlite.run(`DELETE FROM "${name}"`);
	}
	sqlite.run("PRAGMA foreign_keys = ON");
}
