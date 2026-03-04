import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

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

export async function runMigrations(sqlite: Database): Promise<{
	source: "filesystem" | "embedded";
	folder: string;
}> {
	const resolved = await resolveMigrationsFolder();
	try {
		const db = drizzle({ client: sqlite });
		migrate(db, { migrationsFolder: resolved.folder });
		return { source: resolved.source, folder: resolved.folder };
	} finally {
		resolved.cleanup?.();
	}
}
