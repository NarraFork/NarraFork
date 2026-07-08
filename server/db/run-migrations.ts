import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";

const FILESYSTEM_MIGRATIONS_FOLDER = "./drizzle";

type EmbeddedMigrationDataModule = {
	embeddedMigrationJournalJson: string;
	embeddedMigrationSqlFiles: ReadonlyArray<{ name: string; content: string }>;
};

type ResolvedMigrationsFolder = {
	folder: string;
	source: "filesystem" | "embedded";
	cleanup?: () => void;
};

function materializeEmbeddedMigrations(data: EmbeddedMigrationDataModule): {
	folder: string;
	cleanup: () => void;
} {
	const tempRoot = mkdtempSync(join(tmpdir(), "narrafork-migrations-"));
	const migrationsRoot = join(tempRoot, "drizzle");
	const metaDir = join(migrationsRoot, "meta");
	mkdirSync(metaDir, { recursive: true });

	writeFileSync(join(metaDir, "_journal.json"), data.embeddedMigrationJournalJson);
	for (const file of data.embeddedMigrationSqlFiles) {
		writeFileSync(join(migrationsRoot, file.name), file.content);
	}

	return {
		folder: migrationsRoot,
		cleanup: () => {
			rmSync(tempRoot, { recursive: true, force: true });
		},
	};
}

async function resolveMigrationsFolder(): Promise<ResolvedMigrationsFolder> {
	// Prefer filesystem migrations in source/dev mode so the latest SQL is always used.
	if (existsSync(FILESYSTEM_MIGRATIONS_FOLDER)) {
		return { folder: FILESYSTEM_MIGRATIONS_FOLDER, source: "filesystem" };
	}

	// Fallback for compiled single-binary mode where ./drizzle doesn't exist on disk.
	try {
		const generatedMigrationsDataModulePath = "../generated/embedded-migrations-data";
		const generatedModule = (await import(generatedMigrationsDataModulePath)) as
			| EmbeddedMigrationDataModule
			| undefined;
		if (
			typeof generatedModule?.embeddedMigrationJournalJson === "string" &&
			Array.isArray(generatedModule.embeddedMigrationSqlFiles)
		) {
			const materialized = materializeEmbeddedMigrations(generatedModule);
			return {
				folder: materialized.folder,
				source: "embedded",
				cleanup: materialized.cleanup,
			};
		}
	} catch {
		// No embedded migration data module available.
	}

	return { folder: FILESYSTEM_MIGRATIONS_FOLDER, source: "filesystem" };
}

/**
 * Check if a migration failure is due to objects (tables/indexes) already existing.
 * This happens when the database was created by a previous build with a different
 * migration hash — the schema is identical but Drizzle sees it as a new migration.
 */
function isAlreadyExistsError(err: unknown): boolean {
	const alreadyExistsPatterns = ["already exists", "duplicate column name"];
	const check = (msg: string) => alreadyExistsPatterns.some((p) => msg.includes(p));
	if (check(String(err))) return true;
	// DrizzleError wraps the original SQLiteError in `cause`
	if (err instanceof Error && err.cause && check(String(err.cause))) return true;
	return false;
}

/**
 * Read the journal from the resolved migrations folder, execute each migration's
 * SQL statements (skipping individual statements that fail with "already exists"
 * or "duplicate column name"), then stamp the migration as applied.
 *
 * This handles the case where a database was partially migrated — some objects
 * already exist but others (e.g. new tables in the same migration) do not.
 */
function stampMigrationsAsApplied(sqlite: Database, migrationsFolder: string): void {
	const journalPath = join(migrationsFolder, "meta", "_journal.json");
	if (!existsSync(journalPath)) return;

	const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
		entries: Array<{ tag: string; when: number }>;
	};

	// Ensure the migrations tracking table exists (same schema Drizzle uses)
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS __drizzle_migrations (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)
	`);

	for (const entry of journal.entries) {
		const sqlPath = join(migrationsFolder, `${entry.tag}.sql`);
		if (!existsSync(sqlPath)) continue;
		const content = readFileSync(sqlPath, "utf-8");
		const hash = hashMigrationContent(content);

		// Skip if already recorded
		const existing = sqlite.query("SELECT 1 FROM __drizzle_migrations WHERE hash = ?").get(hash);
		if (existing) continue;

		// Execute each statement individually, tolerating already-exists errors
		// so partial migrations (some objects exist, some don't) are handled correctly.
		const statements = content
			.split("--> statement-breakpoint")
			.map((s) => s.trim())
			.filter(Boolean);

		for (const stmt of statements) {
			try {
				sqlite.run(stmt);
			} catch (err) {
				if (isAlreadyExistsError(err)) {
					logger.debug("Skipping already-applied migration statement", {
						tag: entry.tag,
						stmt: stmt.slice(0, 80),
					});
				} else {
					throw err;
				}
			}
		}

		sqlite.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [
			hash,
			entry.when,
		]);
	}
}

/** Reproduce Drizzle's migration hash: hex-encoded SHA-256 of the SQL content. */
function hashMigrationContent(content: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

export async function runMigrations(sqlite: Database): Promise<{
	source: "filesystem" | "embedded";
	folder: string;
}> {
	// Snapshot pre-migration schema state so post-migration data backfills can
	// tell a genuine upgrade (column about to be added) from an already-migrated
	// database. Captured before migrate() runs.
	const hadMfaEnabledColumn = usersHasColumn(sqlite, "mfa_enabled");

	// Capture legacy narrator todos BEFORE migrate() runs, because the Dynamic Spec
	// migration destructively drops `narrators.todos_json`. SQLite DROP COLUMN
	// physically removes the data, so this pre-migration read is the only chance to
	// preserve it. Empty on already-migrated / fresh databases (column absent).
	const legacyTodos = captureLegacyTodos(sqlite);

	const resolved = await resolveMigrationsFolder();
	try {
		const db = drizzle({ client: sqlite });
		try {
			migrate(db, { migrationsFolder: resolved.folder });
		} catch (err) {
			if (isAlreadyExistsError(err)) {
				logger.warn(
					"Migration failed with 'already exists' — database likely created by a previous build. " +
						"Stamping migrations as applied.",
				);
				stampMigrationsAsApplied(sqlite, resolved.folder);
			} else {
				throw err;
			}
		}
		// Run one-time data backfills gated on the pre-migration snapshot. Safe to
		// run from both the standalone `db:migrate` process and server startup —
		// whichever adds the column first performs the backfill; the other sees the
		// column already present and skips it.
		if (!hadMfaEnabledColumn) {
			backfillMfaEnabled(sqlite);
		}
		// Move any captured legacy todos into each narrator's spec://tasks.json. The
		// column is gone by now (dropped by the Dynamic Spec migration), so this only
		// runs on the single upgrade that removes it; afterwards captureLegacyTodos
		// returns [] and this is skipped.
		if (legacyTodos.length > 0) {
			backfillLegacyTodosToSpec(sqlite, legacyTodos);
		}
		return { source: resolved.source, folder: resolved.folder };
	} finally {
		resolved.cleanup?.();
	}
}

/** Whether the `users` table exists and already has the given column. */
function usersHasColumn(sqlite: Database, column: string): boolean {
	const usersTableExists = sqlite
		.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'")
		.get();
	if (!usersTableExists) return true; // fresh DB — no legacy rows to backfill
	const cols = sqlite.prepare("PRAGMA table_info('users')").all() as { name: string }[];
	return cols.some((c) => c.name === column);
}

/**
 * One-time backfill: preserve the pre-existing 2FA behavior for accounts that
 * upgraded from a version without the `users.mfa_enabled` column. Before that
 * column existed, holding ANY second factor (active TOTP or a passkey) forced a
 * second step at login. We keep that promise for those users by turning the new
 * opt-in flag on wherever a factor is already enrolled. Only ever runs on the
 * first startup after the column is added, so a user who later turns 2FA off is
 * never re-enrolled.
 */
function backfillMfaEnabled(sqlite: Database): void {
	try {
		const result = sqlite
			.prepare(
				`UPDATE users SET mfa_enabled = 1
				 WHERE mfa_enabled = 0
				   AND (
				     EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = users.id AND t.status = 'active')
				     OR EXISTS (SELECT 1 FROM user_passkeys p WHERE p.user_id = users.id)
				   )`,
			)
			.run();
		if (result.changes > 0) {
			logger.info("Backfilled mfa_enabled for users with an enrolled second factor", {
				count: result.changes,
			});
		}
	} catch (err) {
		// Non-fatal: never block startup on an optional backfill.
		logger.warn("mfa_enabled backfill failed (non-fatal)", { error: String(err) });
	}
}

// ── Legacy todo → Dynamic Spec backfill ─────────────────────────────────────
//
// Before Dynamic Spec, narrator todos lived in `narrators.todos_json` (a JSON
// array of { id?, content?, status?, priority?, activeForm? }). The Dynamic Spec
// migration drops that column, so upgrading users would lose their todos. To
// preserve them we snapshot the column before migrate() drops it, then write the
// items into each narrator's spec://tasks.json here.

/** Legacy todo status → Dynamic Spec status. Keeps completed items (mapped to done). */
const LEGACY_TODO_STATUS_MAP: Record<string, "todo" | "doing" | "done" | "blocked"> = {
	pending: "todo",
	in_progress: "doing",
	active: "doing",
	completed: "done",
	complete: "done",
	todo: "todo",
	doing: "doing",
	done: "done",
	blocked: "blocked",
};

// Mirror the spec-task-service limits so the produced tasks.json passes parsing.
const LEGACY_TASK_TEXT_MAX_CHARS = 1000;
const LEGACY_TASKS_MAX_ITEMS = 100;

interface CapturedLegacyTodos {
	narratorId: string;
	/** Raw parsed todos array from todos_json (unknown shape, validated later). */
	todos: unknown[];
}

/** Whether `narrators` exists and still has the given column. */
function narratorsHasColumn(sqlite: Database, column: string): boolean {
	const tableExists = sqlite
		.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='narrators'")
		.get();
	if (!tableExists) return false;
	const cols = sqlite.prepare("PRAGMA table_info('narrators')").all() as { name: string }[];
	return cols.some((c) => c.name === column);
}

/**
 * Read legacy todos from `narrators.todos_json` before the Dynamic Spec migration
 * drops the column. Returns [] when the column is absent (already migrated / fresh
 * database) or nothing has todos.
 *
 * Exported for testing; not part of the public migration API.
 */
export function captureLegacyTodos(sqlite: Database): CapturedLegacyTodos[] {
	try {
		if (!narratorsHasColumn(sqlite, "todos_json")) return [];
		const rows = sqlite
			.prepare(
				`SELECT id, todos_json FROM narrators
				 WHERE todos_json IS NOT NULL AND todos_json != '' AND todos_json != '[]'`,
			)
			.all() as { id: string; todos_json: string | null }[];
		const captured: CapturedLegacyTodos[] = [];
		for (const row of rows) {
			if (!row.todos_json) continue;
			try {
				const parsed = JSON.parse(row.todos_json);
				if (Array.isArray(parsed) && parsed.length > 0) {
					captured.push({ narratorId: row.id, todos: parsed });
				}
			} catch {
				// Ignore malformed todos_json for this narrator.
			}
		}
		return captured;
	} catch (err) {
		logger.warn("Failed to capture legacy todos (non-fatal)", { error: String(err) });
		return [];
	}
}

/** Convert a captured legacy todos array into the minimal Dynamic Spec tasks. */
function legacyTodosToSpecTasks(
	todos: unknown[],
): { text: string; status: "todo" | "doing" | "done" | "blocked" }[] {
	const tasks: { text: string; status: "todo" | "doing" | "done" | "blocked" }[] = [];
	const seen = new Set<string>();
	for (const raw of todos) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const item = raw as Record<string, unknown>;
		const rawText =
			(typeof item.content === "string" && item.content) ||
			(typeof item.activeForm === "string" && item.activeForm) ||
			"";
		const text = rawText.trim().slice(0, LEGACY_TASK_TEXT_MAX_CHARS);
		if (!text) continue;
		if (seen.has(text)) continue;
		seen.add(text);
		const statusKey = typeof item.status === "string" ? item.status : "todo";
		const status = LEGACY_TODO_STATUS_MAP[statusKey] ?? "todo";
		tasks.push({ text, status });
		if (tasks.length >= LEGACY_TASKS_MAX_ITEMS) break;
	}
	return tasks;
}

/** Whether a narrator's spec://tasks.json already holds a non-empty task list. */
function specTasksAlreadyPopulated(sqlite: Database, namespaceId: string): boolean {
	const file = sqlite
		.prepare(
			`SELECT r.content AS content
			 FROM spec_namespace_files f
			 JOIN spec_file_revisions r ON r.id = f.revision_id
			 WHERE f.namespace_id = ? AND f.path = 'tasks.json' AND f.deleted = 0`,
		)
		.get(namespaceId) as { content: string } | undefined;
	if (!file?.content) return false;
	try {
		const parsed = JSON.parse(file.content);
		return (
			!!parsed &&
			typeof parsed === "object" &&
			Array.isArray((parsed as { tasks?: unknown }).tasks) &&
			(parsed as { tasks: unknown[] }).tasks.length > 0
		);
	} catch {
		return false;
	}
}

/**
 * Write captured legacy todos into each narrator's spec://tasks.json using raw SQL
 * (the app service layer is not booted during migrations). Idempotent: skips a
 * narrator whose tasks.json already has tasks, so it never clobbers newer data.
 *
 * Exported for testing; not part of the public migration API.
 */
export function backfillLegacyTodosToSpec(sqlite: Database, entries: CapturedLegacyTodos[]): void {
	let migratedNarrators = 0;
	let migratedTasks = 0;
	for (const entry of entries) {
		try {
			const tasks = legacyTodosToSpecTasks(entry.todos);
			if (tasks.length === 0) continue;

			// Confirm the narrator still exists (avoid orphan spec rows).
			const narratorRow = sqlite
				.prepare("SELECT 1 FROM narrators WHERE id = ?")
				.get(entry.narratorId);
			if (!narratorRow) continue;

			const now = new Date().toISOString();

			// Ensure a spec namespace for this narrator.
			let namespace = sqlite
				.prepare("SELECT id FROM spec_namespaces WHERE narrator_id = ?")
				.get(entry.narratorId) as { id: string } | undefined;
			if (!namespace) {
				const namespaceId = generateId();
				sqlite
					.prepare(
						`INSERT INTO spec_namespaces (id, narrator_id, created_at, updated_at)
						 VALUES (?, ?, ?, ?)`,
					)
					.run(namespaceId, entry.narratorId, now, now);
				namespace = { id: namespaceId };
			} else if (specTasksAlreadyPopulated(sqlite, namespace.id)) {
				// Never overwrite tasks the user/agent already produced under Dynamic Spec.
				continue;
			}

			const content = `${JSON.stringify({ tasks }, null, "\t")}\n`;
			const contentHash = hashMigrationContent(content);
			const revisionId = generateId();
			sqlite
				.prepare(
					`INSERT INTO spec_file_revisions
					 (id, namespace_id, path, content, content_hash, created_by, created_at)
					 VALUES (?, ?, 'tasks.json', ?, ?, 'system', ?)`,
				)
				.run(revisionId, namespace.id, content, contentHash, now);

			const existingFile = sqlite
				.prepare(
					"SELECT id FROM spec_namespace_files WHERE namespace_id = ? AND path = 'tasks.json'",
				)
				.get(namespace.id) as { id: string } | undefined;
			if (existingFile) {
				sqlite
					.prepare(
						"UPDATE spec_namespace_files SET revision_id = ?, deleted = 0, updated_at = ? WHERE id = ?",
					)
					.run(revisionId, now, existingFile.id);
			} else {
				sqlite
					.prepare(
						`INSERT INTO spec_namespace_files
						 (id, namespace_id, path, revision_id, deleted, updated_at)
						 VALUES (?, ?, 'tasks.json', ?, 0, ?)`,
					)
					.run(generateId(), namespace.id, revisionId, now);
			}

			migratedNarrators++;
			migratedTasks += tasks.length;
		} catch (err) {
			// Non-fatal per narrator: never block startup on the backfill.
			logger.warn("Legacy todo backfill failed for narrator (non-fatal)", {
				narratorId: entry.narratorId,
				error: String(err),
			});
		}
	}
	if (migratedNarrators > 0) {
		logger.info("Migrated legacy narrator todos into spec://tasks.json", {
			narrators: migratedNarrators,
			tasks: migratedTasks,
		});
	}
}
