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
	const msg = String(err);
	return msg.includes("already exists");
}

/**
 * Read the journal from the resolved migrations folder and manually stamp all
 * migrations as applied in the `__drizzle_migrations` table. This lets Drizzle
 * skip them on subsequent runs.
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
		// Drizzle uses a hex-encoded hash of the SQL content
		const hash = hashMigrationContent(content);

		// Only insert if not already recorded
		const existing = sqlite
			.query("SELECT 1 FROM __drizzle_migrations WHERE hash = ?")
			.get(hash);
		if (!existing) {
			sqlite.run(
				"INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
				[hash, entry.when],
			);
		}
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
		return { source: resolved.source, folder: resolved.folder };
	} finally {
		resolved.cleanup?.();
	}
}
