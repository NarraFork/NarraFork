import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
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
