import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { projects } from "../db/schema";

const SCHEMA_VERSION = 3;
const PROJECT_DB_DIR = ".narrafork";
const PROJECT_DB_FILE = "project.db";

/** Get the project database path for a given gitPath. */
export function getProjectDbPath(gitPath: string): string {
	return resolve(gitPath, PROJECT_DB_DIR, PROJECT_DB_FILE);
}

// Project DB is a portable per-project backup. Keep machine-local runtime references
// (for example credential_id) out of this schema unless import/export truly depends on them.
const PROJECT_DB_SCHEMA_PATCHES: Array<{
	table: string;
	columns: Array<{ name: string; type: string }>;
}> = [
	{
		table: "narrator_messages",
		columns: [
			{ name: "provider", type: "TEXT" },
			{ name: "model", type: "TEXT" },
			{ name: "output_tokens", type: "INTEGER" },
			{ name: "cached_input_tokens", type: "INTEGER" },
			{ name: "cache_creation_input_tokens", type: "INTEGER" },
			{ name: "cache_creation_5m_tokens", type: "INTEGER" },
			{ name: "cache_creation_1h_tokens", type: "INTEGER" },
			{ name: "reasoning_tokens", type: "INTEGER" },
			{ name: "ttft_ms", type: "INTEGER" },
			{ name: "duration_ms", type: "INTEGER" },
		],
	},
	{
		table: "narrators",
		columns: [
			{ name: "substatus", type: "TEXT NOT NULL DEFAULT '[]'" },
			{ name: "variant", type: "TEXT NOT NULL DEFAULT 'primary'" },
			{ name: "traits", type: "TEXT NOT NULL DEFAULT '[]'" },
			{ name: "is_background", type: "INTEGER NOT NULL DEFAULT 0" },
			{ name: "background_status", type: "TEXT" },
			{ name: "background_result", type: "TEXT" },
			{ name: "background_completed_at", type: "TEXT" },
			{ name: "is_ask_in_passing", type: "INTEGER NOT NULL DEFAULT 0" },
			{ name: "turn_started_at", type: "TEXT" },
			{ name: "message_version", type: "INTEGER NOT NULL DEFAULT 0" },
			{ name: "prune_enabled", type: "INTEGER NOT NULL DEFAULT 1" },
			{ name: "fast_mode", type: "INTEGER NOT NULL DEFAULT 0" },
			{ name: "relaxed_plan", type: "INTEGER NOT NULL DEFAULT 0" },
			{ name: "reasoning_effort", type: "TEXT" },
			{ name: "previous_permission_mode", type: "TEXT" },
			{ name: "plan_file_id", type: "TEXT" },
		],
	},
];

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT,
	status TEXT NOT NULL DEFAULT 'active',
	git_path TEXT,
	remote_url TEXT,
	default_branch TEXT DEFAULT 'main',
	startup_script TEXT,
	copy_files TEXT,
	chapter_settings TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exploration_groups (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT,
	base_chapter_id TEXT,
	status TEXT NOT NULL DEFAULT 'active',
	decided_chapter_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT,
	status TEXT NOT NULL DEFAULT 'active',
	role TEXT NOT NULL DEFAULT 'branch',
	branch TEXT NOT NULL,
	worktree_path TEXT,
	base_branch TEXT NOT NULL,
	parent_chapter_id TEXT,
	fork_point TEXT,
	merged_into_chapter_id TEXT,
	merge_commit_sha TEXT,
	merge_strategy TEXT,
	container_config TEXT,
	exploration_group_id TEXT,
	is_root INTEGER DEFAULT 0,
	head_commit_sha TEXT,
	start_commit_sha TEXT,
	commit_count INTEGER DEFAULT 0,
	color TEXT,
	group_label TEXT,
	pinned INTEGER DEFAULT 0,
	anchor_commit_sha TEXT,
	axis_offset REAL DEFAULT 0,
	cross_offset REAL DEFAULT 0,
	last_accessed_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapter_edges (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	target_id TEXT NOT NULL,
	type TEXT NOT NULL,
	metadata TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapter_commits (
	id TEXT PRIMARY KEY,
	chapter_id TEXT NOT NULL,
	sha TEXT NOT NULL,
	message TEXT NOT NULL,
	full_message TEXT,
	author_name TEXT,
	author_email TEXT,
	authored_at TEXT NOT NULL,
	source TEXT NOT NULL DEFAULT 'manual',
	narrator_id TEXT,
	narrator_message_id TEXT,
	files_changed INTEGER,
	lines_added INTEGER,
	lines_removed INTEGER,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS narrators (
	id TEXT PRIMARY KEY,
	chapter_id TEXT,
	api_conversation_id TEXT,
	fork_message_id TEXT,
	type TEXT NOT NULL DEFAULT 'primary',
	subagent_type TEXT,
	title TEXT,
	inherit_mode TEXT NOT NULL DEFAULT 'fresh',
	parent_narrator_id TEXT,
	context_summary TEXT,
	model TEXT DEFAULT 'claude-sonnet',
	system_prompt TEXT,
	permission_mode TEXT DEFAULT 'default',
	message_count INTEGER DEFAULT 0,
	total_cost_usd REAL DEFAULT 0,
	last_message_at TEXT,
	status TEXT NOT NULL DEFAULT 'idle',
	plan_mode INTEGER NOT NULL DEFAULT 0,
	cwd TEXT,
	error_message TEXT,
	prune_boundary_message_id TEXT,
	pruned_percent INTEGER,
	created_at TEXT NOT NULL,
	substatus TEXT NOT NULL DEFAULT '[]',
	variant TEXT NOT NULL DEFAULT 'primary',
	traits TEXT NOT NULL DEFAULT '[]',
	is_background INTEGER NOT NULL DEFAULT 0,
	background_status TEXT,
	background_result TEXT,
	background_completed_at TEXT,
	is_ask_in_passing INTEGER NOT NULL DEFAULT 0,
	turn_started_at TEXT,
	message_version INTEGER NOT NULL DEFAULT 0,
	prune_enabled INTEGER NOT NULL DEFAULT 1,
	fast_mode INTEGER NOT NULL DEFAULT 0,
	relaxed_plan INTEGER NOT NULL DEFAULT 0,
	reasoning_effort TEXT,
	previous_permission_mode TEXT,
	plan_file_id TEXT,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS narrator_messages (
	id TEXT PRIMARY KEY,
	narrator_id TEXT NOT NULL,
	sdk_message_uuid TEXT,
	parent_tool_use_id TEXT,
	role TEXT NOT NULL,
	content_json TEXT NOT NULL,
	content_text TEXT,
	tokens_in INTEGER,
	cost_usd REAL,
	turn_usage_json TEXT,
	provider TEXT,
	model TEXT,
	output_tokens INTEGER,
	cached_input_tokens INTEGER,
	cache_creation_input_tokens INTEGER,
	cache_creation_5m_tokens INTEGER,
	cache_creation_1h_tokens INTEGER,
	reasoning_tokens INTEGER,
	ttft_ms INTEGER,
	duration_ms INTEGER,
	context_percent REAL,
	meter_usage REAL,
	meter_unit TEXT,
	commit_sha TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS narrator_message_refs (
	id TEXT PRIMARY KEY,
	narrator_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	is_compact INTEGER NOT NULL DEFAULT 0,
	pruned_percent INTEGER
);

CREATE TABLE IF NOT EXISTS narrator_tool_calls (
	id TEXT PRIMARY KEY,
	narrator_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	tool_use_id TEXT NOT NULL,
	tool_name TEXT NOT NULL,
	input_json TEXT,
	output_json TEXT,
	status TEXT NOT NULL DEFAULT 'initializing',
	duration_ms INTEGER,
	error_message TEXT,
	permission_decided_by TEXT,
	permission_decided_at TEXT,
	permission_deny_message TEXT,
	permission_decision_reason TEXT,
	permission_suggestions TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS narrator_patches (
	id TEXT PRIMARY KEY,
	narrator_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	tool_use_id TEXT NOT NULL,
	before_hash TEXT NOT NULL,
	after_hash TEXT NOT NULL,
	files_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merge_sessions (
	id TEXT PRIMARY KEY,
	target_chapter_id TEXT NOT NULL,
	source_chapter_ids TEXT NOT NULL,
	strategy TEXT NOT NULL DEFAULT 'merge',
	status TEXT NOT NULL,
	current_index INTEGER NOT NULL DEFAULT 0,
	merged_count INTEGER NOT NULL DEFAULT 0,
	current_source_chapter_id TEXT,
	conflict_files TEXT,
	error TEXT,
	locale TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
`;

function ensureProjectDbSchema(conn: Database): void {
	for (const patch of PROJECT_DB_SCHEMA_PATCHES) {
		const existing = new Set(
			(conn.prepare(`PRAGMA table_info("${patch.table}")`).all() as Array<{ name: string }>).map(
				(row) => row.name,
			),
		);
		for (const column of patch.columns) {
			if (existing.has(column.name)) continue;
			conn.run(`ALTER TABLE "${patch.table}" ADD COLUMN "${column.name}" ${column.type}`);
		}
	}
}

/** Initialize a project database: create dir, open connection, create tables. */
function initProjectDb(gitPath: string): Database {
	const dir = resolve(gitPath, PROJECT_DB_DIR);
	mkdirSync(dir, { recursive: true });
	const dbPath = resolve(dir, PROJECT_DB_FILE);
	const conn = new Database(dbPath);
	conn.run("PRAGMA journal_mode = WAL");
	conn.run("PRAGMA foreign_keys = OFF");
	// Keep waits short: bun:sqlite busy handlers block the JS thread.
	conn.run("PRAGMA busy_timeout = 250");
	conn.exec(CREATE_TABLES_SQL);
	ensureProjectDbSchema(conn);
	conn.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	return conn;
}

interface CachedConnection {
	conn: Database;
	gitPath: string;
	lastUsed: number;
}

class ProjectDbManager {
	private cache = new Map<string, CachedConnection>();
	private maxConnections = 8;
	/** Idle timeout: close connections unused for 30 minutes. */
	private idleTimeoutMs = 30 * 60 * 1000;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	/**
	 * Get or create a project database connection.
	 * Returns null if the project has no gitPath or the path doesn't exist.
	 */
	async getDb(projectId: string): Promise<Database | null> {
		const cached = this.cache.get(projectId);
		if (cached) {
			cached.lastUsed = Date.now();
			return cached.conn;
		}

		const project = await db.query.projects.findFirst({
			where: eq(projects.id, projectId),
			columns: { gitPath: true },
		});
		if (!project?.gitPath || !existsSync(project.gitPath)) return null;

		return this.openForGitPath(projectId, project.gitPath);
	}

	/**
	 * Open a project database for a known gitPath (skips DB lookup).
	 * Used during project creation when the project record already exists.
	 */
	openForGitPath(projectId: string, gitPath: string): Database {
		// Check cache first
		const cached = this.cache.get(projectId);
		if (cached) {
			cached.lastUsed = Date.now();
			return cached.conn;
		}

		this.evictIfNeeded();
		this.ensureCleanupTimer();

		const conn = initProjectDb(gitPath);
		this.cache.set(projectId, { conn, gitPath, lastUsed: Date.now() });
		return conn;
	}

	/** Close a specific project's connection. */
	close(projectId: string): void {
		const cached = this.cache.get(projectId);
		if (cached) {
			try {
				cached.conn.run("PRAGMA wal_checkpoint(TRUNCATE)");
			} catch {
				// best-effort
			}
			cached.conn.close();
			this.cache.delete(projectId);
		}
		if (this.cache.size === 0) this.stopCleanupTimer();
	}

	/** Close all connections (process exit). */
	closeAll(): void {
		for (const [, cached] of this.cache) {
			try {
				cached.conn.run("PRAGMA wal_checkpoint(TRUNCATE)");
				cached.conn.close();
			} catch {
				// best-effort
			}
		}
		this.cache.clear();
		this.stopCleanupTimer();
	}

	/** Evict least-recently-used connections if over limit. */
	private evictIfNeeded(): void {
		if (this.cache.size < this.maxConnections) return;
		let oldestId: string | null = null;
		let oldestTime = Number.POSITIVE_INFINITY;
		for (const [id, cached] of this.cache) {
			if (cached.lastUsed < oldestTime) {
				oldestTime = cached.lastUsed;
				oldestId = id;
			}
		}
		if (oldestId) this.close(oldestId);
	}

	/** Start periodic cleanup timer (every 10 minutes). */
	private ensureCleanupTimer(): void {
		if (this.cleanupTimer) return;
		this.cleanupTimer = setInterval(() => this.evictIdle(), 10 * 60 * 1000);
		// Don't prevent process exit
		if (
			this.cleanupTimer &&
			typeof this.cleanupTimer === "object" &&
			"unref" in this.cleanupTimer
		) {
			this.cleanupTimer.unref();
		}
	}

	private stopCleanupTimer(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}

	/** Close connections that have been idle longer than idleTimeoutMs. */
	private evictIdle(): void {
		const cutoff = Date.now() - this.idleTimeoutMs;
		const toEvict: string[] = [];
		for (const [id, cached] of this.cache) {
			if (cached.lastUsed < cutoff) toEvict.push(id);
		}
		for (const id of toEvict) this.close(id);
	}
}

export const projectDbManager = new ProjectDbManager();
