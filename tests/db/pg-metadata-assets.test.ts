import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
	CURRENT_SNAPSHOT,
	HISTORY_FILE,
	readPgMetadata,
} from "../../scripts/lib/postgres-migration-metadata";

const folder = resolve(import.meta.dir, "../../drizzle-postgres");

test("committed PostgreSQL history keeps exactly one full schema baseline", () => {
	const metadata = readPgMetadata(folder);
	expect(metadata.mode).toBe("baseline");
	expect(metadata.legacySnapshots).toEqual([]);
	expect(readdirSync(resolve(folder, "meta")).sort()).toEqual(
		[CURRENT_SNAPSHOT, HISTORY_FILE, "_journal.json"].sort(),
	);
	expect(metadata.history.entries).toHaveLength(metadata.journal.entries.length);
	expect(metadata.history.entries.at(-1)?.id).toBe(metadata.snapshot.id);
	// The runtime still reads the complete SQL history through the unchanged journal.
	expect(readMigrationFiles({ migrationsFolder: folder })).toHaveLength(
		metadata.journal.entries.length,
	);
});
