import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
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

/** Whether a table with the given name currently exists. */
function tableExists(sqlite: Database, name: string): boolean {
	return (
		sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !=
		null
	);
}

/** Whether an index with the given name currently exists (any owning table). */
function indexExists(sqlite: Database, name: string): boolean {
	return (
		sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) !=
		null
	);
}

/**
 * Whether `table` currently has `column`. Identifiers come from migration SQL we authored, and
 * PRAGMA cannot bind them, so the table name is quoted rather than parameterized.
 */
function columnExists(sqlite: Database, table: string, column: string): boolean {
	const columns = sqlite
		.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(table)})`)
		.all() as Array<{ name: string }>;
	return columns.some((row) => sameObjectName(row.name, column));
}

/** A SQLite identifier: bare, `"quoted"`, backtick-quoted, or `[bracketed]`. */
const SQLITE_IDENTIFIER = String.raw`"(?:[^"]|"")*"|\`(?:[^\`]|\`\`)*\`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*`;
/** A table reference with an optional schema prefix (`main.foo`, `"main"."foo"`). */
const SQLITE_TABLE_REF = String.raw`(?:${SQLITE_IDENTIFIER})(?:\s*\.\s*(?:${SQLITE_IDENTIFIER}))?`;
const DROP_TABLE_PREFIX = String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?`;
const DROP_INDEX_PREFIX = String.raw`DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?`;

/**
 * Reduce an object reference to its bare name: drop any schema prefix and identifier quoting so
 * the spelling in a migration's SQL can be compared against the spelling SQLite echoes back in
 * an error message. Case is preserved because `sqlite_master.name` lookups are BINARY-collated.
 */
function normalizeObjectName(raw: string): string {
	const parts = raw.match(new RegExp(SQLITE_IDENTIFIER, "g")) ?? [];
	const last = (parts.at(-1) ?? raw).trim();
	const first = last[0];
	const end = last.at(-1);
	if (last.length >= 2) {
		if ((first === '"' && end === '"') || (first === "`" && end === "`")) {
			return last.slice(1, -1).replaceAll(first + first, first);
		}
		if (first === "[" && end === "]") return last.slice(1, -1);
	}
	return last;
}

/** SQLite resolves ASCII identifiers case-insensitively, so tolerate spelling differences. */
function sameObjectName(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

const SQLITE_IDENTIFIER_LIST = String.raw`(?:${SQLITE_IDENTIFIER})(?:\s*,\s*(?:${SQLITE_IDENTIFIER}))*`;
const CANONICAL_REBUILD_COPY = new RegExp(
	String.raw`^\s*INSERT\s+INTO\s+(${SQLITE_IDENTIFIER})\s*\(\s*(${SQLITE_IDENTIFIER_LIST})\s*\)\s*SELECT\s+(${SQLITE_IDENTIFIER_LIST})\s+FROM\s+(${SQLITE_IDENTIFIER})\s*;?\s*$`,
	"i",
);
// Above SQLite's default 2000-column limit, but still bounded for custom SQLite builds.
const REBUILD_COPY_MAX_COLUMNS = 2048;

type RebuildCopyColumn = { name: string; notnull: number; dflt_value: string | null };

/** SQLite identifier folding is ASCII-only; Unicode lowercasing could mistake a DQS literal for a column. */
function rebuildIdentifierKey(name: string): string {
	return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function rebuildCopyColumns(sqlite: Database, table: string): RebuildCopyColumn[] {
	// The table-valued PRAGMA accepts a bound name and a LIMIT; never inspect table data here.
	const columns = sqlite
		.prepare('SELECT name, "notnull", dflt_value FROM pragma_table_info(?) LIMIT ?')
		.all(table, REBUILD_COPY_MAX_COLUMNS + 1) as RebuildCopyColumn[];
	if (columns.length === 0) throw new Error(`no such table: ${table} (Drizzle rebuild-copy)`);
	if (columns.length > REBUILD_COPY_MAX_COLUMNS) {
		throw new Error(`Drizzle rebuild-copy metadata exceeds ${REBUILD_COPY_MAX_COLUMNS} columns`);
	}
	return columns;
}

/**
 * Drizzle can rebuild a table while adding columns, yet put those new names in BOTH sides of
 * its INSERT ... SELECT. SQLite DQS then treats absent double-quoted source names as strings:
 * a successful copy can silently corrupt rows before the original table is dropped.
 *
 * Only the complete, identifier-only __new_<table> copy is eligible. Preserve source-backed
 * mappings (including renames) verbatim; omit a pair only when the destination really exists,
 * the source lacks that same name, and both sides name the same column. Omission lets SQLite
 * supply the destination DEFAULT/NULL, not an invented value. Unknown mappings are fatal.
 * Expressions, aliases, schema-qualified references and other SQL shapes remain untouched.
 * A null result means the source is empty and no source-backed column remains to copy.
 */
function compatibleRebuildCopyStatement(sqlite: Database, stmt: string): string | null {
	const match = CANONICAL_REBUILD_COPY.exec(stmt);
	if (!match) return stmt;
	const [, targetRef, targetList, sourceList, sourceRef] = match;
	const targetName = normalizeObjectName(targetRef);
	if (!rebuildIdentifierKey(targetName).startsWith("__new_")) return stmt;
	const sourceTokens = sourceList.match(new RegExp(SQLITE_IDENTIFIER, "g")) ?? [];
	// These unquoted SQL literals are expressions, not identifier mappings.
	if (
		sourceTokens.some((token) =>
			/^(NULL|TRUE|FALSE|CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP)$/i.test(token),
		)
	) {
		return stmt;
	}
	const targetTokens = targetList.match(new RegExp(SQLITE_IDENTIFIER, "g")) ?? [];
	const sourceName = normalizeObjectName(sourceRef);
	const sourceColumns = new Set(
		rebuildCopyColumns(sqlite, sourceName).map((column) => rebuildIdentifierKey(column.name)),
	);
	if (
		rebuildIdentifierKey(targetName) !== `__new_${rebuildIdentifierKey(sourceName)}` ||
		targetTokens.length !== sourceTokens.length ||
		targetTokens.length > REBUILD_COPY_MAX_COLUMNS
	) {
		throw new Error(`Unrecognized Drizzle rebuild-copy mapping from ${sourceRef} to ${targetRef}`);
	}
	const targetColumns = new Map(
		rebuildCopyColumns(sqlite, targetName).map((column) => [
			rebuildIdentifierKey(column.name),
			column,
		]),
	);
	const seenTargets = new Set<string>();
	const keptTargets: string[] = [];
	const keptSources: string[] = [];
	const omitted: RebuildCopyColumn[] = [];
	for (let i = 0; i < targetTokens.length; i++) {
		const targetKey = rebuildIdentifierKey(normalizeObjectName(targetTokens[i]));
		const sourceKey = rebuildIdentifierKey(normalizeObjectName(sourceTokens[i]));
		const targetColumn = targetColumns.get(targetKey);
		if (!targetColumn || seenTargets.has(targetKey)) {
			throw new Error(`Unrecognized Drizzle rebuild-copy destination mapping: ${targetTokens[i]}`);
		}
		seenTargets.add(targetKey);
		if (sourceColumns.has(sourceKey)) {
			keptTargets.push(targetTokens[i]);
			keptSources.push(sourceTokens[i]);
		} else if (targetKey === sourceKey && !sourceColumns.has(targetKey)) {
			omitted.push(targetColumn);
		} else {
			throw new Error(
				`Unrecognized Drizzle rebuild-copy column mapping: ${targetTokens[i]} <- ${sourceTokens[i]}`,
			);
		}
	}
	if (omitted.length === 0) return stmt;

	const requiredWithoutDefault = omitted.filter(
		(column) => column.notnull !== 0 && column.dflt_value === null,
	);
	if (requiredWithoutDefault.length > 0 || keptTargets.length === 0) {
		// LIMIT 1 checks emptiness without counting/scanning the entire source table.
		const hasRows = sqlite.prepare(`SELECT 1 FROM ${sourceRef} LIMIT 1`).get() != null;
		if (hasRows) {
			if (requiredWithoutDefault.length > 0) {
				throw new Error(
					`Drizzle rebuild-copy cannot populate required columns without defaults: ${requiredWithoutDefault.map((column) => column.name).join(", ")}`,
				);
			}
			throw new Error("Drizzle rebuild-copy has no source-backed column mapping for existing rows");
		}
		if (keptTargets.length === 0) return null;
	}

	return `INSERT INTO ${targetRef} (${keptTargets.join(", ")}) SELECT ${keptSources.join(", ")} FROM ${sourceRef};`;
}

/** The names SQLite reported for a failure, including the DrizzleError-wrapped `cause`. */
function errorMessages(err: unknown): string[] {
	const messages = [String(err instanceof Error ? err.message : err)];
	// DrizzleError wraps the original SQLiteError in `cause`.
	if (err instanceof Error && err.cause) messages.push(String(err.cause));
	return messages;
}

/**
 * The table SQLite reported as absent (`no such table: main.foo`), or null for any other
 * failure. Returning null for unrecognized errors keeps the caller's tolerance narrow: it can
 * only ever skip a failure whose missing table it was able to identify.
 */
function missingTableFromError(err: unknown): string | null {
	for (const message of errorMessages(err)) {
		const match = /no such table:\s*([^\s;]+)/i.exec(message);
		if (match) return normalizeObjectName(match[1]);
	}
	return null;
}

/** The index SQLite reported as absent (`no such index: main.idx_foo`), or null otherwise. */
function missingIndexFromError(err: unknown): string | null {
	for (const message of errorMessages(err)) {
		const match = /no such index:\s*([^\s;]+)/i.exec(message);
		if (match) return normalizeObjectName(match[1]);
	}
	return null;
}

/**
 * The column SQLite reported as absent, or null otherwise. `ALTER TABLE ... DROP COLUMN` echoes
 * the name back exactly as written, so backtick-quoted migration SQL yields
 * `no such column: "`gone`"` — the quoting has to be peeled off twice.
 */
function missingColumnFromError(err: unknown): string | null {
	for (const message of errorMessages(err)) {
		const match = /no such column:\s*(.+?)\s*$/i.exec(message);
		if (!match) continue;
		let name = match[1].trim();
		if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
			name = name.slice(1, -1).replaceAll('""', '"');
		}
		return normalizeObjectName(name);
	}
	return null;
}

/**
 * The table this single statement drops, or null when the statement is anything else. Anchored
 * at the statement start so a `DROP TABLE` appearing inside a trigger body or string literal
 * cannot make an unrelated statement look like a plain drop.
 */
function droppedTableOfStatement(stmt: string): string | null {
	const match = new RegExp(String.raw`^\s*${DROP_TABLE_PREFIX}(${SQLITE_TABLE_REF})`, "i").exec(
		stmt,
	);
	return match ? normalizeObjectName(match[1]) : null;
}

/** The index this statement drops, or null when the statement is anything else. */
function droppedIndexOfStatement(stmt: string): string | null {
	const match = new RegExp(
		String.raw`^\s*${DROP_INDEX_PREFIX}(${SQLITE_TABLE_REF})\s*;?\s*$`,
		"i",
	).exec(stmt);
	return match ? normalizeObjectName(match[1]) : null;
}

/**
 * The `{ table, column }` this statement drops via `ALTER TABLE ... DROP COLUMN`, or null when
 * the statement is anything else. Anchored and terminated so only a lone column drop matches.
 */
function droppedColumnOfStatement(stmt: string): { table: string; column: string } | null {
	const match = new RegExp(
		String.raw`^\s*ALTER\s+TABLE\s+(${SQLITE_TABLE_REF})\s+DROP\s+(?:COLUMN\s+)?(${SQLITE_IDENTIFIER})\s*;?\s*$`,
		"i",
	).exec(stmt);
	if (!match) return null;
	return { table: normalizeObjectName(match[1]), column: normalizeObjectName(match[2]) };
}

/**
 * Return the names of real tables a migration's statements would `DROP TABLE`, excluding
 * Drizzle's `__new_*` rebuild scratch tables. A non-empty result marks the migration as
 * "destructive": re-running it against a database where those tables already hold the final
 * shape would drop live data (Drizzle's table-rebuild pattern is
 * `CREATE __new_x → INSERT __new_x SELECT FROM x → DROP TABLE x → RENAME __new_x TO x`).
 */
function migrationDropsRealTables(statements: readonly string[]): string[] {
	const dropped: string[] = [];
	const dropPattern = new RegExp(`${DROP_TABLE_PREFIX}(${SQLITE_TABLE_REF})`, "gi");
	for (const stmt of statements) {
		for (const match of stmt.matchAll(dropPattern)) {
			const table = normalizeObjectName(match[1]);
			if (table.startsWith("__new_")) continue;
			dropped.push(table);
		}
	}
	return dropped;
}

/**
 * Whether a failed statement is exactly the harmless case of dropping a table this database
 * never had: the statement itself is a `DROP TABLE`, and the table SQLite reported missing is
 * the one that statement targets and one this migration legitimately drops.
 *
 * The narrowness is the point. Tolerating "no such table" for *every* statement of a
 * destructive migration silently destroys data, because Drizzle's rebuild sequence keeps
 * going after a failure: an `INSERT INTO __new_x SELECT ... FROM y` that fails on an unrelated
 * missing `y` would be skipped, then `DROP TABLE x` deletes the live rows and the RENAME
 * leaves an empty table behind — a successful-looking migration with the data gone.
 */
function isMissingDropTargetError(
	err: unknown,
	stmt: string,
	droppedTables: readonly string[],
): boolean {
	const missingTable = missingTableFromError(err);
	if (missingTable === null) return false;
	const target = droppedTableOfStatement(stmt);
	if (target === null || !sameObjectName(target, missingTable)) return false;
	return droppedTables.some((table) => sameObjectName(table, missingTable));
}

/**
 * Whether a failed statement is the already-satisfied case of dropping an index or column this
 * database no longer has — the drop's own goal is already true, so skipping it leaves the schema
 * exactly where the migration wanted it.
 *
 * This is what makes a hash "hole" self-healing. A source-built machine that upgrades to a
 * release binary can carry a database whose schema already advanced past a migration whose hash
 * was never recorded (locally generated migrations hash differently from the released files).
 * Replaying such a migration re-runs its `DROP INDEX`/`DROP COLUMN`, which then fails on a
 * target that the earlier local run already removed, and startup aborts.
 *
 * Three guards keep this from masking a real problem:
 * - the statement must be exactly a lone `DROP INDEX` / `ALTER TABLE ... DROP COLUMN`;
 * - the object SQLite reported missing must be that statement's own target, so an unrelated
 *   failure inside a multi-statement migration is still fatal;
 * - the catalog is consulted: the object must genuinely be absent right now. A "no such
 *   index/column" error raised for any other reason keeps propagating.
 */
function isAlreadySatisfiedDropError(sqlite: Database, err: unknown, stmt: string): boolean {
	const missingIndex = missingIndexFromError(err);
	if (missingIndex !== null) {
		const target = droppedIndexOfStatement(stmt);
		if (target === null || !sameObjectName(target, missingIndex)) return false;
		return !indexExists(sqlite, target);
	}

	const missingColumn = missingColumnFromError(err);
	if (missingColumn !== null) {
		const target = droppedColumnOfStatement(stmt);
		if (target === null || !sameObjectName(target.column, missingColumn)) return false;
		// A missing table is a different failure; report it rather than swallowing it here.
		if (!tableExists(sqlite, target.table)) return false;
		return !columnExists(sqlite, target.table, target.column);
	}

	return false;
}

/**
 * Apply pending migrations by hash-membership instead of Drizzle's `MAX(created_at)`
 * high-water mark. This replaces `migrate()` on the main path because the built-in SQLite
 * migrator (see `drizzle-orm/sqlite-core/dialect`) only compares the newest applied
 * `created_at` and silently skips every journal entry whose `when` is smaller — even when
 * that entry's hash is absent from `__drizzle_migrations`. That foot-gun is what leaves a
 * database missing tables after a branch/version whose migrations carried larger timestamps
 * polluted the watermark (drizzle-orm issue #5769, still open upstream).
 *
 * Behavior:
 * - A migration whose hash is already recorded is skipped (idempotent no-op).
 * - A destructive migration (drops a real table) whose target table already exists is treated
 *   as "already effective but unstamped": its SQL is NOT re-run, only its hash is recorded.
 *   This protects live data on a dirty database from a needless DROP/rebuild.
 * - Every other pending migration is executed statement-by-statement, tolerating
 *   "already exists"/"duplicate column" (safe re-create) and a `DROP TABLE` of a table this
 *   database never had. "no such table" from any other statement is fatal.
 *
 * Runs inside a single transaction with foreign keys disabled (matching Drizzle's own
 * table-rebuild migrations); any unexpected error rolls back and rethrows so real failures
 * stay visible.
 *
 * Exported for tests so the statement-level error tolerance can be exercised against purpose-
 * built migration folders instead of only the committed journal.
 */
export function applyPendingMigrationsByHash(sqlite: Database, migrationsFolder: string): void {
	const journalPath = join(migrationsFolder, "meta", "_journal.json");
	if (!existsSync(journalPath)) {
		throw new Error(`Can't find meta/_journal.json in ${migrationsFolder}`);
	}

	// Ensure the migrations tracking table exists (same schema Drizzle uses).
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS __drizzle_migrations (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)
	`);

	const appliedHashes = new Set(
		(sqlite.prepare("SELECT hash FROM __drizzle_migrations").all() as Array<{ hash: string }>).map(
			(row) => row.hash,
		),
	);

	// readMigrationFiles returns entries in journal order, with `sql` already split on
	// `--> statement-breakpoint` and `hash`/`folderMillis` matching what Drizzle records.
	const migrations = readMigrationFiles({ migrationsFolder });
	// Index of the last migration whose hash is already recorded. Any pending migration
	// positioned *before* this high-water index is a "hole" — the database already advanced
	// past that journal position (normal incremental upgrades only ever leave a trailing
	// suffix pending). A destructive migration in a hole must not be re-run: its rebuild
	// already happened, so replaying the DROP would destroy live data.
	let lastAppliedIndex = -1;
	for (let i = 0; i < migrations.length; i++) {
		if (appliedHashes.has(migrations[i].hash)) lastAppliedIndex = i;
	}

	const pending = migrations
		.map((migration, index) => ({ migration, index }))
		.filter(({ migration }) => !appliedHashes.has(migration.hash));
	if (pending.length === 0) return;

	const foreignKeyState = sqlite.prepare("PRAGMA foreign_keys").get() as {
		foreign_keys: number | bigint;
	} | null;
	const foreignKeysWereEnabled = Number(foreignKeyState?.foreign_keys ?? 0) === 1;
	if (foreignKeysWereEnabled) sqlite.run("PRAGMA foreign_keys = OFF");

	let stampedWithoutRun = 0;
	try {
		const apply = sqlite.transaction(() => {
			for (const { migration, index } of pending) {
				const statements = migration.sql.map((stmt) => stmt.trim()).filter(Boolean);
				const droppedTables = migrationDropsRealTables(statements);
				const isDestructive = droppedTables.length > 0;
				// A destructive migration is only skipped when the database already advanced past
				// its journal position (a hole below the high-water mark) AND every table it would
				// drop already exists — i.e. its rebuild is already in effect. A destructive
				// migration at or above the high-water mark is a normal forward step and must run
				// (e.g. a fresh database applying the whole journal, where the target table was
				// created by an earlier migration in the very same run).
				const isUnstampedHole = index < lastAppliedIndex;
				const alreadyEffective =
					isDestructive &&
					isUnstampedHole &&
					droppedTables.every((table) => tableExists(sqlite, table));

				if (alreadyEffective) {
					// The rebuild already happened on a prior run; the hash just never got stamped.
					// Re-running the DROP/rebuild would risk live data, so only record the hash.
					stampedWithoutRun++;
					logger.warn("Stamping already-effective destructive migration without re-running", {
						folderMillis: migration.folderMillis,
						droppedTables,
					});
				} else {
					for (const stmt of statements) {
						// Validate before SQLite can accept missing DQS names as literals. Neither
						// compatibility failures nor repaired-copy failures are tolerable DDL errors.
						const copyStatement = compatibleRebuildCopyStatement(sqlite, stmt);
						if (copyStatement !== stmt) {
							if (copyStatement !== null) sqlite.run(copyStatement);
							continue;
						}
						try {
							sqlite.run(stmt);
						} catch (err) {
							if (isAlreadyExistsError(err)) continue;
							// An index/column drop whose target is already gone: the statement's
							// own goal is satisfied, verified against the live catalog.
							if (isAlreadySatisfiedDropError(sqlite, err, stmt)) continue;
							// Scoped to the failing statement, not the whole migration: only a
							// `DROP TABLE` whose own target is the table SQLite reports missing is
							// harmless. Anything else failing with "no such table" means the
							// migration's assumptions are broken, and continuing through the rest of
							// a rebuild sequence would drop live rows into an empty replacement.
							if (isDestructive && isMissingDropTargetError(err, stmt, droppedTables)) {
								continue;
							}
							throw err;
						}
					}
				}

				sqlite.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [
					migration.hash,
					migration.folderMillis,
				]);
			}
		});
		apply();
	} finally {
		if (foreignKeysWereEnabled) sqlite.run("PRAGMA foreign_keys = ON");
	}

	logger.info("Applied pending migrations by hash", {
		applied: pending.length,
		stampedWithoutRun,
	});
}

type SpecColumnSpec = {
	name: string;
	/** Declared SQLite type, compared case-insensitively. */
	type: "text" | "integer";
	notNull: boolean;
	primaryKey?: boolean;
	/** Exact SQLite default expression; omitted means no default. */
	defaultSql?: string;
	/** SQL expression used when an old table lacks this required column but still has rows. */
	repairFallbackSql?: string;
};

type SpecForeignKeySpec = {
	column: string;
	referencesTable: string;
	/** Defaults to the canonical id primary key. */
	referencesColumn?: string;
	/** SQLite's omitted-action default is NO ACTION. */
	onUpdate?: "CASCADE" | "SET NULL" | "NO ACTION";
	onDelete: "CASCADE" | "SET NULL" | "NO ACTION";
};

type SpecIndexSpec = {
	name: string;
	unique: boolean;
	columns: string[];
	createSql: string;
};

type SpecTableDefinition = {
	name: string;
	/** Idempotent CREATE TABLE ... IF NOT EXISTS matching the 0058 migration exactly. */
	createSql: string;
	columns: SpecColumnSpec[];
	primaryKey: string[];
	foreignKeys: SpecForeignKeySpec[];
	indexes: SpecIndexSpec[];
};

/**
 * Full expected shape of the four Living Work Spec tables, mirroring migration 0058
 * and server/db/schema.ts. Ordered so that a table is always created after the tables
 * its foreign keys reference (spec_namespaces → spec_file_revisions → the rest).
 */
const SPEC_TABLE_DEFINITIONS: readonly SpecTableDefinition[] = [
	{
		name: "spec_namespaces",
		createSql: `
			CREATE TABLE IF NOT EXISTS spec_namespaces (
				id text PRIMARY KEY NOT NULL,
				narrator_id text NOT NULL,
				forked_from_namespace_id text,
				created_at text NOT NULL,
				updated_at text NOT NULL,
				FOREIGN KEY (narrator_id) REFERENCES narrators(id) ON DELETE cascade,
				FOREIGN KEY (forked_from_namespace_id) REFERENCES spec_namespaces(id) ON DELETE set null
			)
		`,
		columns: [
			{ name: "id", type: "text", notNull: true, primaryKey: true },
			{ name: "narrator_id", type: "text", notNull: true },
			{ name: "forked_from_namespace_id", type: "text", notNull: false },
			{ name: "created_at", type: "text", notNull: true },
			{ name: "updated_at", type: "text", notNull: true },
		],
		primaryKey: ["id"],
		foreignKeys: [
			{ column: "narrator_id", referencesTable: "narrators", onDelete: "CASCADE" },
			{
				column: "forked_from_namespace_id",
				referencesTable: "spec_namespaces",
				onDelete: "SET NULL",
			},
		],
		indexes: [
			{
				name: "idx_spec_namespaces_narrator",
				unique: true,
				columns: ["narrator_id"],
				createSql:
					"CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_namespaces_narrator ON spec_namespaces (narrator_id)",
			},
			{
				name: "idx_spec_namespaces_forked_from",
				unique: false,
				columns: ["forked_from_namespace_id"],
				createSql:
					"CREATE INDEX IF NOT EXISTS idx_spec_namespaces_forked_from ON spec_namespaces (forked_from_namespace_id)",
			},
		],
	},
	{
		name: "spec_file_revisions",
		createSql: `
			CREATE TABLE IF NOT EXISTS spec_file_revisions (
				id text PRIMARY KEY NOT NULL,
				namespace_id text NOT NULL,
				path text NOT NULL,
				content text NOT NULL,
				content_hash text NOT NULL,
				parent_revision_id text,
				source_tool_use_id text,
				source_message_id text,
				created_by text DEFAULT 'assistant' NOT NULL,
				created_at text NOT NULL,
				FOREIGN KEY (namespace_id) REFERENCES spec_namespaces(id) ON DELETE cascade,
				FOREIGN KEY (parent_revision_id) REFERENCES spec_file_revisions(id) ON DELETE set null,
				FOREIGN KEY (source_message_id) REFERENCES narrator_messages(id) ON DELETE set null
			)
		`,
		columns: [
			{ name: "id", type: "text", notNull: true, primaryKey: true },
			{ name: "namespace_id", type: "text", notNull: true },
			{ name: "path", type: "text", notNull: true },
			{ name: "content", type: "text", notNull: true },
			{ name: "content_hash", type: "text", notNull: true },
			{ name: "parent_revision_id", type: "text", notNull: false },
			{ name: "source_tool_use_id", type: "text", notNull: false },
			{ name: "source_message_id", type: "text", notNull: false },
			{
				name: "created_by",
				type: "text",
				notNull: true,
				defaultSql: "'assistant'",
				repairFallbackSql: "'assistant'",
			},
			{ name: "created_at", type: "text", notNull: true },
		],
		primaryKey: ["id"],
		foreignKeys: [
			{ column: "namespace_id", referencesTable: "spec_namespaces", onDelete: "CASCADE" },
			{
				column: "parent_revision_id",
				referencesTable: "spec_file_revisions",
				onDelete: "SET NULL",
			},
			{
				column: "source_message_id",
				referencesTable: "narrator_messages",
				onDelete: "SET NULL",
			},
		],
		indexes: [
			{
				name: "idx_spec_file_revisions_namespace_path",
				unique: false,
				columns: ["namespace_id", "path"],
				createSql:
					"CREATE INDEX IF NOT EXISTS idx_spec_file_revisions_namespace_path ON spec_file_revisions (namespace_id, path)",
			},
			{
				name: "idx_spec_file_revisions_parent",
				unique: false,
				columns: ["parent_revision_id"],
				createSql:
					"CREATE INDEX IF NOT EXISTS idx_spec_file_revisions_parent ON spec_file_revisions (parent_revision_id)",
			},
			{
				// FK covering index for narrator_messages deletion (ON DELETE SET NULL).
				name: "idx_spec_file_revisions_source_message",
				unique: false,
				columns: ["source_message_id"],
				createSql:
					"CREATE INDEX IF NOT EXISTS idx_spec_file_revisions_source_message ON spec_file_revisions (source_message_id)",
			},
		],
	},
	{
		name: "spec_namespace_files",
		createSql: `
			CREATE TABLE IF NOT EXISTS spec_namespace_files (
				id text PRIMARY KEY NOT NULL,
				namespace_id text NOT NULL,
				path text NOT NULL,
				revision_id text,
				deleted integer DEFAULT false NOT NULL,
				updated_at text NOT NULL,
				FOREIGN KEY (namespace_id) REFERENCES spec_namespaces(id) ON DELETE cascade,
				FOREIGN KEY (revision_id) REFERENCES spec_file_revisions(id) ON DELETE set null
			)
		`,
		columns: [
			{ name: "id", type: "text", notNull: true, primaryKey: true },
			{ name: "namespace_id", type: "text", notNull: true },
			{ name: "path", type: "text", notNull: true },
			{ name: "revision_id", type: "text", notNull: false },
			{
				name: "deleted",
				type: "integer",
				notNull: true,
				defaultSql: "false",
				repairFallbackSql: "0",
			},
			{ name: "updated_at", type: "text", notNull: true },
		],
		primaryKey: ["id"],
		foreignKeys: [
			{ column: "namespace_id", referencesTable: "spec_namespaces", onDelete: "CASCADE" },
			{ column: "revision_id", referencesTable: "spec_file_revisions", onDelete: "SET NULL" },
		],
		indexes: [
			{
				name: "idx_spec_namespace_files_namespace_path",
				unique: true,
				columns: ["namespace_id", "path"],
				createSql:
					"CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_namespace_files_namespace_path ON spec_namespace_files (namespace_id, path)",
			},
			{
				name: "idx_spec_namespace_files_revision",
				unique: false,
				columns: ["revision_id"],
				createSql:
					"CREATE INDEX IF NOT EXISTS idx_spec_namespace_files_revision ON spec_namespace_files (revision_id)",
			},
		],
	},
	{
		name: "spec_protected_tasks",
		createSql: `
			CREATE TABLE IF NOT EXISTS spec_protected_tasks (
				id text PRIMARY KEY NOT NULL,
				namespace_id text NOT NULL,
				text_hash text NOT NULL,
				text text NOT NULL,
				status text DEFAULT 'todo' NOT NULL,
				first_revision_id text,
				last_revision_id text,
				created_at text NOT NULL,
				updated_at text NOT NULL,
				completed_at text,
				deleted_at text,
				FOREIGN KEY (namespace_id) REFERENCES spec_namespaces(id) ON DELETE cascade,
				FOREIGN KEY (first_revision_id) REFERENCES spec_file_revisions(id) ON DELETE set null,
				FOREIGN KEY (last_revision_id) REFERENCES spec_file_revisions(id) ON DELETE set null
			)
		`,
		columns: [
			{ name: "id", type: "text", notNull: true, primaryKey: true },
			{ name: "namespace_id", type: "text", notNull: true },
			{ name: "text_hash", type: "text", notNull: true },
			{ name: "text", type: "text", notNull: true },
			{
				name: "status",
				type: "text",
				notNull: true,
				defaultSql: "'todo'",
				repairFallbackSql: "'todo'",
			},
			{ name: "first_revision_id", type: "text", notNull: false },
			{ name: "last_revision_id", type: "text", notNull: false },
			{ name: "created_at", type: "text", notNull: true },
			{ name: "updated_at", type: "text", notNull: true },
			{ name: "completed_at", type: "text", notNull: false },
			{ name: "deleted_at", type: "text", notNull: false },
		],
		primaryKey: ["id"],
		foreignKeys: [
			{ column: "namespace_id", referencesTable: "spec_namespaces", onDelete: "CASCADE" },
			{
				column: "first_revision_id",
				referencesTable: "spec_file_revisions",
				onDelete: "SET NULL",
			},
			{
				column: "last_revision_id",
				referencesTable: "spec_file_revisions",
				onDelete: "SET NULL",
			},
		],
		indexes: [
			{
				name: "idx_spec_protected_tasks_namespace_hash",
				unique: true,
				columns: ["namespace_id", "text_hash"],
				createSql:
					"CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_protected_tasks_namespace_hash ON spec_protected_tasks (namespace_id, text_hash)",
			},
			{
				name: "idx_spec_protected_tasks_namespace_status",
				unique: false,
				columns: ["namespace_id", "status"],
				createSql:
					"CREATE INDEX IF NOT EXISTS idx_spec_protected_tasks_namespace_status ON spec_protected_tasks (namespace_id, status)",
			},
			{
				// FK covering index for spec-file-revision deletion. Must stay listed here:
				// validateNoUnexpectedSpecIndexes rejects any index on a spec table that this
				// definition does not declare, so a schema.ts index without an entry here makes
				// startup migrations throw SpecSchemaDriftError.
				name: "idx_spec_protected_tasks_first_revision",
				unique: false,
				columns: ["first_revision_id"],
				createSql:
					"CREATE INDEX IF NOT EXISTS idx_spec_protected_tasks_first_revision ON spec_protected_tasks (first_revision_id)",
			},
			{
				name: "idx_spec_protected_tasks_last_revision",
				unique: false,
				columns: ["last_revision_id"],
				createSql:
					"CREATE INDEX IF NOT EXISTS idx_spec_protected_tasks_last_revision ON spec_protected_tasks (last_revision_id)",
			},
		],
	},
];

/**
 * Thrown when Living Work Spec structural drift cannot be repaired while preserving existing
 * rows and referential integrity. Repair is attempted transactionally first; this error leaves
 * the original schema and data intact.
 */
export class SpecSchemaDriftError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SpecSchemaDriftError";
	}
}

function specTableExists(sqlite: Database, table: string): boolean {
	const row = sqlite
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(table);
	return row !== null && row !== undefined;
}

function getSpecIndexOwner(sqlite: Database, indexName: string): string | null {
	const row = sqlite
		.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?")
		.get(indexName) as { tbl_name: string } | null;
	return row?.tbl_name ?? null;
}

/** SQLite reports declared types verbatim; compare case-insensitively. */
function normalizeSqliteType(declaredType: string): string {
	return declaredType.trim().toLowerCase();
}

/** Normalize a PRAGMA foreign_key_list `on_delete` value to our canonical union. */
function normalizeForeignKeyAction(action: string): string {
	return action.trim().toUpperCase().replace(/\s+/g, " ");
}

function normalizeDefaultSql(value: string | null | undefined): string | null {
	if (value == null) return null;
	return value.trim().replace(/\s+/g, " ");
}

function sameStringList(actual: readonly string[], expected: readonly string[]): boolean {
	if (actual.length !== expected.length) return false;
	return actual.every((value, index) => value === expected[index]);
}

/**
 * Bounded, read-only structural validation of an already-present Spec table via PRAGMA.
 * Only reads catalog metadata (no table scans). Throws {@link SpecSchemaDriftError} on
 * any drift we refuse to silently repair (columns / primary key / foreign keys). The
 * table/index names come from our own constant definitions, so interpolating them into
 * PRAGMA statements (which cannot bind identifiers) carries no injection risk.
 */
function validateExistingSpecTable(sqlite: Database, def: SpecTableDefinition): void {
	const columns = sqlite.prepare(`PRAGMA table_info(${def.name})`).all() as Array<{
		name: string;
		type: string;
		notnull: number;
		dflt_value: string | null;
		pk: number;
	}>;
	const byName = new Map(columns.map((column) => [column.name, column]));
	const expectedNames = new Set(def.columns.map((column) => column.name));
	const unexpectedColumns = columns.filter((column) => !expectedNames.has(column.name));
	if (columns.length !== def.columns.length || unexpectedColumns.length > 0) {
		throw new SpecSchemaDriftError(
			`Table "${def.name}" has an unexpected column set; extra columns: ${
				unexpectedColumns.map((column) => column.name).join(", ") || "none"
			}.`,
		);
	}

	for (const expected of def.columns) {
		const actual = byName.get(expected.name);
		if (!actual) {
			throw new SpecSchemaDriftError(
				`Table "${def.name}" is missing column "${expected.name}"; refusing to auto-repair structural drift.`,
			);
		}
		if (normalizeSqliteType(actual.type) !== expected.type) {
			throw new SpecSchemaDriftError(
				`Column "${def.name}.${expected.name}" has type "${actual.type}", expected "${expected.type}".`,
			);
		}
		const actualNotNull = actual.notnull === 1;
		if (actualNotNull !== expected.notNull) {
			throw new SpecSchemaDriftError(
				`Column "${def.name}.${expected.name}" nullability drifted (notNull=${actualNotNull}, expected ${expected.notNull}).`,
			);
		}
		const actualDefault = normalizeDefaultSql(actual.dflt_value);
		const expectedDefault = normalizeDefaultSql(expected.defaultSql);
		if (actualDefault !== expectedDefault) {
			throw new SpecSchemaDriftError(
				`Column "${def.name}.${expected.name}" default drifted (${actualDefault ?? "none"}, expected ${expectedDefault ?? "none"}).`,
			);
		}
	}

	const actualPrimaryKey = columns
		.filter((column) => column.pk > 0)
		.sort((a, b) => a.pk - b.pk)
		.map((column) => column.name);
	if (!sameStringList(actualPrimaryKey, def.primaryKey)) {
		throw new SpecSchemaDriftError(
			`Table "${def.name}" primary key is [${actualPrimaryKey.join(", ")}], expected [${def.primaryKey.join(", ")}].`,
		);
	}

	const foreignKeys = sqlite.prepare(`PRAGMA foreign_key_list(${def.name})`).all() as Array<{
		table: string;
		from: string;
		to: string;
		on_update: string;
		on_delete: string;
	}>;
	const actualForeignKeys = foreignKeys
		.map(
			(row) =>
				`${row.from}\u0000${row.table}\u0000${row.to}\u0000${normalizeForeignKeyAction(row.on_update)}\u0000${normalizeForeignKeyAction(row.on_delete)}`,
		)
		.sort();
	const expectedForeignKeys = def.foreignKeys
		.map(
			(expected) =>
				`${expected.column}\u0000${expected.referencesTable}\u0000${expected.referencesColumn ?? "id"}\u0000${expected.onUpdate ?? "NO ACTION"}\u0000${expected.onDelete}`,
		)
		.sort();
	if (!sameStringList(actualForeignKeys, expectedForeignKeys)) {
		throw new SpecSchemaDriftError(
			`Table "${def.name}" foreign keys differ from the expected complete definition.`,
		);
	}
}

/**
 * Validate an already-present index: its uniqueness flag and covered columns must match
 * the spec. Diverging uniqueness or columns is structural drift we refuse to mask. A
 * genuinely absent index is handled by the caller (created as a safe, additive repair).
 */
function validateNoUnexpectedSpecIndexes(sqlite: Database, def: SpecTableDefinition): void {
	const expectedNames = new Set(def.indexes.map((index) => index.name));
	const unexpected = (
		sqlite.prepare(`PRAGMA index_list(${def.name})`).all() as Array<{
			name: string;
			origin: string;
		}>
	).filter((row) => row.origin !== "pk" && !expectedNames.has(row.name));
	if (unexpected.length > 0) {
		throw new SpecSchemaDriftError(
			`Table "${def.name}" has unexpected indexes that cannot be removed safely: ${unexpected
				.map((row) => row.name)
				.join(", ")}.`,
		);
	}
}

function validateExistingSpecIndex(
	sqlite: Database,
	tableName: string,
	index: SpecIndexSpec,
): void {
	const listed = (
		sqlite.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{
			name: string;
			unique: number;
			partial: number;
		}>
	).find((row) => row.name === index.name);
	if (!listed) {
		throw new SpecSchemaDriftError(
			`Index "${index.name}" exists but is not attached to expected table "${tableName}".`,
		);
	}

	const actualUnique = listed.unique === 1;
	if (actualUnique !== index.unique) {
		throw new SpecSchemaDriftError(
			`Index "${index.name}" uniqueness drifted (unique=${actualUnique}, expected ${index.unique}).`,
		);
	}
	if (listed.partial !== 0) {
		throw new SpecSchemaDriftError(`Index "${index.name}" must not be partial.`);
	}

	const keyColumns = (
		sqlite.prepare(`PRAGMA index_xinfo(${index.name})`).all() as Array<{
			seqno: number;
			name: string | null;
			desc: number;
			coll: string;
			key: number;
		}>
	)
		.filter((row) => row.key === 1)
		.sort((a, b) => a.seqno - b.seqno);
	const columns = keyColumns.map((row) => row.name ?? "<expression>");
	if (!sameStringList(columns, index.columns)) {
		throw new SpecSchemaDriftError(
			`Index "${index.name}" covers [${columns.join(", ")}], expected [${index.columns.join(", ")}].`,
		);
	}
	const nonCanonicalColumn = keyColumns.find(
		(row) => row.desc !== 0 || row.coll.toUpperCase() !== "BINARY",
	);
	if (nonCanonicalColumn) {
		throw new SpecSchemaDriftError(
			`Index "${index.name}" has non-canonical sort or collation semantics.`,
		);
	}
}

function quoteSqliteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function createSpecRepairTableSql(def: SpecTableDefinition, repairTableName: string): string {
	const declaration = `CREATE TABLE IF NOT EXISTS ${def.name}`;
	if (!def.createSql.includes(declaration)) {
		throw new SpecSchemaDriftError(`Unable to construct repair table for "${def.name}".`);
	}
	return def.createSql.replace(
		declaration,
		`CREATE TABLE ${quoteSqliteIdentifier(repairTableName)}`,
	);
}

/**
 * Rebuild one structurally-drifted table while preserving every expected column that still
 * exists. Missing nullable/defaulted columns are populated safely; if a required column with no
 * defensible fallback is absent and the table contains rows, the transaction aborts unchanged.
 */
function rebuildExistingSpecTable(sqlite: Database, def: SpecTableDefinition): void {
	const actualColumns = sqlite.prepare(`PRAGMA table_info(${def.name})`).all() as Array<{
		name: string;
	}>;
	const actualColumnNames = new Set(actualColumns.map((column) => column.name));
	const expectedColumnNames = new Set(def.columns.map((column) => column.name));
	const unexpectedColumns = actualColumns.filter((column) => !expectedColumnNames.has(column.name));
	const hasRows =
		sqlite.prepare(`SELECT 1 FROM ${quoteSqliteIdentifier(def.name)} LIMIT 1`).get() != null;
	if (hasRows && unexpectedColumns.length > 0) {
		throw new SpecSchemaDriftError(
			`Table "${def.name}" has populated unknown columns that cannot be discarded safely: ${unexpectedColumns
				.map((column) => column.name)
				.join(", ")}.`,
		);
	}
	const unrepairableMissing = def.columns.filter(
		(column) =>
			!actualColumnNames.has(column.name) &&
			column.notNull &&
			column.repairFallbackSql === undefined,
	);
	if (hasRows && unrepairableMissing.length > 0) {
		throw new SpecSchemaDriftError(
			`Table "${def.name}" has rows but is missing required columns without safe defaults: ${unrepairableMissing
				.map((column) => column.name)
				.join(", ")}.`,
		);
	}

	const repairTableName = `__narrafork_repair_${def.name}`;
	sqlite.run(`DROP TABLE IF EXISTS ${quoteSqliteIdentifier(repairTableName)}`);
	sqlite.run(createSpecRepairTableSql(def, repairTableName));

	if (hasRows) {
		const destinationColumns: string[] = [];
		const sourceExpressions: string[] = [];
		for (const column of def.columns) {
			destinationColumns.push(quoteSqliteIdentifier(column.name));
			if (actualColumnNames.has(column.name)) {
				sourceExpressions.push(quoteSqliteIdentifier(column.name));
			} else if (column.repairFallbackSql !== undefined) {
				sourceExpressions.push(column.repairFallbackSql);
			} else {
				sourceExpressions.push("NULL");
			}
		}
		sqlite.run(
			`INSERT INTO ${quoteSqliteIdentifier(repairTableName)} (${destinationColumns.join(", ")}) ` +
				`SELECT ${sourceExpressions.join(", ")} FROM ${quoteSqliteIdentifier(def.name)}`,
		);
	}

	sqlite.run(`DROP TABLE ${quoteSqliteIdentifier(def.name)}`);
	sqlite.run(
		`ALTER TABLE ${quoteSqliteIdentifier(repairTableName)} RENAME TO ${quoteSqliteIdentifier(def.name)}`,
	);
	for (const index of def.indexes) sqlite.run(index.createSql);
}

/**
 * Repair databases that crossed migration 0058 before the Living Work Spec tables were added to
 * that historical migration. Besides additive missing-object repair, structurally drifted tables
 * are transactionally rebuilt when their existing rows can be mapped without inventing required
 * data. If safe preservation is impossible, {@link SpecSchemaDriftError} aborts the transaction
 * and leaves the original schema/data intact.
 */
export function repairMissingSpecTables(sqlite: Database): boolean {
	const tableExists = new Map<string, boolean>();
	const driftedTables = new Map<string, SpecSchemaDriftError>();
	for (const def of SPEC_TABLE_DEFINITIONS) {
		const exists = specTableExists(sqlite, def.name);
		tableExists.set(def.name, exists);
		if (!exists) continue;
		try {
			validateExistingSpecTable(sqlite, def);
		} catch (error) {
			if (!(error instanceof SpecSchemaDriftError)) throw error;
			driftedTables.set(def.name, error);
		}
	}

	const missingTables = SPEC_TABLE_DEFINITIONS.filter((def) => !tableExists.get(def.name));
	const missingIndexes: Array<{ table: string; index: SpecIndexSpec }> = [];
	const driftedIndexes: Array<{ table: string; index: SpecIndexSpec; error: Error }> = [];
	for (const def of SPEC_TABLE_DEFINITIONS) {
		if (!tableExists.get(def.name) || driftedTables.has(def.name)) continue;
		try {
			validateNoUnexpectedSpecIndexes(sqlite, def);
		} catch (error) {
			if (!(error instanceof SpecSchemaDriftError)) throw error;
			// Extra indexes can alter write semantics; refuse automatic repair so user data stays intact.
			throw error;
		}
		for (const index of def.indexes) {
			const indexOwner = getSpecIndexOwner(sqlite, index.name);
			if (indexOwner === null) {
				missingIndexes.push({ table: def.name, index });
				continue;
			}
			if (indexOwner !== def.name) {
				throw new SpecSchemaDriftError(
					`Index "${index.name}" belongs to unrelated table "${indexOwner}", expected "${def.name}"; refusing to drop it automatically.`,
				);
			}
			try {
				validateExistingSpecIndex(sqlite, def.name, index);
			} catch (error) {
				if (!(error instanceof SpecSchemaDriftError)) throw error;
				driftedIndexes.push({ table: def.name, index, error });
			}
		}
	}

	if (
		missingTables.length === 0 &&
		driftedTables.size === 0 &&
		missingIndexes.length === 0 &&
		driftedIndexes.length === 0
	) {
		return false;
	}

	const foreignKeyState = sqlite.prepare("PRAGMA foreign_keys").get() as {
		foreign_keys: number | bigint;
	} | null;
	const foreignKeysWereEnabled = Number(foreignKeyState?.foreign_keys ?? 0) === 1;
	if (foreignKeysWereEnabled) sqlite.run("PRAGMA foreign_keys = OFF");
	try {
		const repair = sqlite.transaction(() => {
			for (const def of SPEC_TABLE_DEFINITIONS) {
				if (driftedTables.has(def.name)) {
					rebuildExistingSpecTable(sqlite, def);
				} else if (!tableExists.get(def.name)) {
					sqlite.run(def.createSql);
					for (const index of def.indexes) sqlite.run(index.createSql);
				}
			}
			for (const { index } of driftedIndexes) {
				sqlite.run(`DROP INDEX ${quoteSqliteIdentifier(index.name)}`);
				sqlite.run(index.createSql);
			}
			for (const { index } of missingIndexes) sqlite.run(index.createSql);

			// Validate both shape and referential integrity before committing the replacement tables.
			for (const def of SPEC_TABLE_DEFINITIONS) {
				validateExistingSpecTable(sqlite, def);
				for (const index of def.indexes) validateExistingSpecIndex(sqlite, def.name, index);
				const violations = sqlite.prepare(`PRAGMA foreign_key_check(${def.name})`).all();
				if (violations.length > 0) {
					throw new SpecSchemaDriftError(
						`Repair of "${def.name}" would preserve ${violations.length} foreign-key violation(s).`,
					);
				}
			}
		});
		repair();
	} finally {
		if (foreignKeysWereEnabled) sqlite.run("PRAGMA foreign_keys = ON");
	}

	logger.warn("Repaired Living Work Spec database schema", {
		missingTables: missingTables.map((def) => def.name),
		rebuiltTables: [...driftedTables.keys()],
		missingIndexes: missingIndexes.map(({ index }) => index.name),
		rebuiltIndexes: driftedIndexes.map(({ index }) => index.name),
	});
	return true;
}

export async function runMigrations(sqlite: Database): Promise<{
	source: "filesystem" | "embedded";
	folder: string;
}> {
	// Snapshot pre-migration schema state so post-migration data backfills can
	// tell a genuine upgrade (column about to be added) from an already-migrated
	// database. Captured before migrations run.
	const hadMfaEnabledColumn = usersHasColumn(sqlite, "mfa_enabled");
	const hadFastModeOverrideColumn = tableHasColumn(sqlite, "narrators", "fast_mode_override");
	const hadNarratorVisibilityColumn = tableHasColumn(sqlite, "narrators", "visibility");
	const hadProjectVisibilityColumn = tableHasColumn(sqlite, "projects", "visibility");
	const hadCollectionProjectGateColumn = tableHasColumn(
		sqlite,
		"knowledge_collections",
		"inherit_project_gate",
	);
	const hadAclGrantsTable = tableExists(sqlite, "acl_grants");

	const resolved = await resolveMigrationsFolder();
	try {
		// Apply migrations by hash-membership rather than Drizzle's timestamp watermark,
		// so a database whose `__drizzle_migrations` was polluted by a branch/version with
		// larger migration timestamps still gets every unapplied migration (issue #5769).
		applyPendingMigrationsByHash(sqlite, resolved.folder);
		repairMissingSpecTables(sqlite);
		// Run one-time data backfills gated on the pre-migration snapshot. Safe to
		// run from both the standalone `db:migrate` process and server startup —
		// whichever adds the column first performs the backfill; the other sees the
		// column already present and skips it.
		if (!hadMfaEnabledColumn) {
			backfillMfaEnabled(sqlite);
		}
		if (!hadFastModeOverrideColumn) {
			backfillFastModeOverride(sqlite);
		}
		if (!hadNarratorVisibilityColumn) {
			backfillNarratorVisibility(sqlite);
		}
		if (!hadProjectVisibilityColumn) {
			backfillProjectVisibility(sqlite);
		}
		if (!hadCollectionProjectGateColumn) {
			backfillCollectionProjectGate(sqlite);
		}
		// Unconditional, unlike the backfills above: this one is idempotent and gates
		// itself on whether any subagent still lacks a root, so a failed attempt is
		// retried instead of skipped forever. See its doc comment for why the
		// column-absence gate is wrong specifically here.
		backfillSubagentAclRoot(sqlite);
		if (!hadAclGrantsTable) {
			migrateGrantsToUnifiedAcl(sqlite);
		}
		return { source: resolved.source, folder: resolved.folder };
	} finally {
		resolved.cleanup?.();
	}
}

/** Whether the `users` table exists and already has the given column. */
function usersHasColumn(sqlite: Database, column: string): boolean {
	return tableHasColumn(sqlite, "users", column);
}

/**
 * Whether `table` exists and already has `column`. A missing table reports true
 * so a fresh database (created straight from the latest schema) never runs a
 * legacy data backfill.
 */
function tableHasColumn(sqlite: Database, table: string, column: string): boolean {
	const tableExists = sqlite
		.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
		.get(table);
	if (!tableExists) return true; // fresh DB — no legacy rows to backfill
	const cols = sqlite.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[];
	return cols.some((c) => c.name === column);
}

/**
 * One-time backfill: `narrators.fast_mode` used to be the only source of truth,
 * so the user's "fast mode by default" preference was frozen into each row at
 * creation time and changing it never affected existing narrators. The new
 * `fast_mode_override` tri-state defaults to "inherit" (follow the preference),
 * so narrators that had fast mode ON must be pinned to "on" to keep behaving the
 * same. Rows that were OFF stay "inherit" and start following the default.
 */
function backfillFastModeOverride(sqlite: Database): void {
	try {
		const result = sqlite
			.prepare(
				`UPDATE narrators SET fast_mode_override = 'on'
				 WHERE fast_mode = 1 AND fast_mode_override = 'inherit'`,
			)
			.run();
		if (result.changes > 0) {
			logger.info("Backfilled fast_mode_override for narrators with fast mode enabled", {
				count: result.changes,
			});
		}
	} catch (err) {
		// Non-fatal: never block startup on an optional backfill.
		logger.warn("fast_mode_override backfill failed (non-fatal)", { error: String(err) });
	}
}

/**
 * One-time backfill: every narrator that predates access control is made
 * `public`, so upgrading never hides work that the whole team could already see.
 *
 * Gated on the pre-migration absence of `narrators.visibility`, exactly like the
 * backfills above, which makes it run at most once. That gate is the whole point:
 * a heuristic such as "owner IS NULL AND created_at < cutover" would re-run on
 * every startup and keep flipping rows back to `public` after an admin had
 * deliberately made an old narrator private again.
 *
 * These rows keep `owner_user_id = NULL` on purpose — there is no trustworthy
 * creator to infer. A null owner means only admins can change the sharing
 * settings, and an admin hands one over with `transfer-owner`.
 */
function backfillNarratorVisibility(sqlite: Database): void {
	try {
		const result = sqlite
			.prepare("UPDATE narrators SET visibility = 'public' WHERE owner_user_id IS NULL")
			.run();
		if (result.changes > 0) {
			logger.info("Backfilled visibility=public for pre-ACL narrators", {
				count: result.changes,
			});
		}
	} catch (err) {
		// Non-fatal: never block startup on an optional backfill.
		logger.warn("narrator visibility backfill failed (non-fatal)", { error: String(err) });
	}
}

/**
 * One-time backfill: every project that predates project-level access control
 * becomes `public`, so upgrading never hides work the whole team could already see.
 *
 * Owners are deliberately NOT invented: there is no trustworthy creator to infer
 * (the table never had one). A null owner means only admins can change the
 * project's membership until one of them hands it over.
 *
 * Gated on the pre-migration absence of `projects.visibility`, exactly like the
 * narrator backfill above, which makes it run at most once — an admin who later
 * makes a project private must not have it flipped back on the next restart.
 */
function backfillProjectVisibility(sqlite: Database): void {
	try {
		const result = sqlite
			.prepare("UPDATE projects SET visibility = 'public' WHERE owner_user_id IS NULL")
			.run();
		if (result.changes > 0) {
			logger.info("Backfilled visibility=public for pre-ACL projects", {
				count: result.changes,
			});
		}
	} catch (err) {
		// Non-fatal: never block startup on an optional backfill.
		logger.warn("project visibility backfill failed (non-fatal)", { error: String(err) });
	}
}

/**
 * One-time backfill: existing knowledge collections do NOT inherit their project's
 * membership gate.
 *
 * The column defaults to true so newly created project-scoped collections are
 * gated, but every collection that already exists was created when any signed-in
 * user could reach any project. Turning the gate on for those during an upgrade
 * would hide content that was readable a minute earlier, and the symptom — entries
 * simply stop appearing — gives no hint of the cause. Enabling the gate is left as
 * an explicit choice by the collection's owner.
 */
function backfillCollectionProjectGate(sqlite: Database): void {
	try {
		const result = sqlite
			.prepare("UPDATE knowledge_collections SET inherit_project_gate = 0")
			.run();
		if (result.changes > 0) {
			logger.info("Backfilled inherit_project_gate=false for pre-ACL knowledge collections", {
				count: result.changes,
			});
		}
	} catch (err) {
		// Non-fatal: never block startup on an optional backfill.
		logger.warn("collection project-gate backfill failed (non-fatal)", { error: String(err) });
	}
}

/**
 * Point every existing subagent at the root narrator its access decisions delegate to.
 *
 * The root is the first non-subagent ancestor, found by walking `parent_narrator_id`.
 * One recursive CTE does the whole walk; `depth < 64` guards against a cycle, which
 * would otherwise spin inside SQLite on the main thread.
 *
 * Three things this must get right, each the opposite of what a plain
 * `SET acl_root_narrator_id = parent_narrator_id` would do:
 *   - a NESTED subagent gets the ROOT, not its immediate parent. Decisions read this
 *     column once and never walk, so a pointer at another subagent would resolve to a
 *     row whose own audiences deny everyone.
 *   - a FORK is skipped. It carries a `parent_narrator_id` too but is an independent
 *     session, and filling this in would put it permanently under its origin.
 *   - an unresolvable chain (deleted ancestor, cycle) stays NULL.
 *
 * Exported so its behaviour can be asserted directly; see
 * `__tests__/subagent-acl-root-backfill.test.ts`.
 */
export const SUBAGENT_ACL_ROOT_BACKFILL_SQL = `WITH RECURSIVE lineage(id, ancestor_id, depth) AS (
	SELECT id, parent_narrator_id, 0
	FROM narrators
	WHERE type = 'subagent' AND parent_narrator_id IS NOT NULL
	UNION ALL
	SELECT l.id, n.parent_narrator_id, l.depth + 1
	FROM lineage l
	JOIN narrators n ON n.id = l.ancestor_id
	WHERE n.type = 'subagent' AND n.parent_narrator_id IS NOT NULL AND l.depth < 64
)
UPDATE narrators SET acl_root_narrator_id = (
	SELECT l.ancestor_id FROM lineage l
	JOIN narrators root ON root.id = l.ancestor_id
	WHERE l.id = narrators.id AND root.type != 'subagent'
	LIMIT 1
)
WHERE type = 'subagent'`;

/**
 * How many subagents still have no delegation target, i.e. are readable only by their
 * owner and admins until the backfill fills them in.
 *
 * Returns null when the question cannot be asked (the column or table is not there yet),
 * which is different from "none" and must not be reported as success.
 */
function countSubagentsMissingAclRoot(sqlite: Database): number | null {
	try {
		const row = sqlite
			.prepare(
				"SELECT count(*) as c FROM narrators WHERE type = 'subagent' AND acl_root_narrator_id IS NULL",
			)
			.get() as { c: number } | undefined;
		return row?.c ?? 0;
	} catch {
		return null;
	}
}

/**
 * Point every existing subagent at its root, applying
 * {@link SUBAGENT_ACL_ROOT_BACKFILL_SQL}.
 *
 * Subagents used to carry a copy of their parent's `visibility`/`owner_user_id`,
 * snapshotted at creation and never updated, so sharing a parent afterwards never
 * reached its subagents. Access is now delegated to the root, and
 * `acl_root_narrator_id` is the single authority for it — an unfilled row is denied to
 * everyone but its owner and admins.
 *
 * NOT gated on the column having just been added, unlike the `visibility` backfills
 * above, and the difference is deliberate. Those backfills PUBLISH rows, so re-running
 * one would keep undoing an admin's later decision to make something private; the gate
 * protects a human choice. This one records a structural fact — which narrator a subagent
 * belongs to — that no user can set and that does not change. So it is safe to re-run,
 * and it must be: the migration itself commits inside a transaction and is stamped, while
 * this runs outside and only warns on failure. Gated on the column's prior absence, a
 * single failure (a lock, a timeout on a large table) would be permanent, and every
 * affected subagent would stay invisible to the people the parent is shared with, with
 * nothing left to retry it.
 *
 * Instead it is gated on there being work to do, so a failed attempt is retried on the
 * next startup and a completed one costs a single indexed COUNT.
 *
 * The unresolved count is logged because those rows are the fail-closed ones: they became
 * NARROWER than before the upgrade, which a user notices and reports. The opposite
 * mistake would not be noticed at all.
 */
function backfillSubagentAclRoot(sqlite: Database): void {
	const before = countSubagentsMissingAclRoot(sqlite);
	// null means the column is absent — nothing to do, and nothing to warn about.
	if (before === null || before === 0) return;
	try {
		const result = sqlite.prepare(SUBAGENT_ACL_ROOT_BACKFILL_SQL).run();
		const after = countSubagentsMissingAclRoot(sqlite);
		logger.info("Backfilled acl_root_narrator_id for existing subagents", {
			count: result.changes,
			// Rows whose chain is genuinely unresolvable (deleted ancestor, cycle). These
			// are now owner/admin-only until repaired, and re-running cannot fix them.
			unresolved: after ?? 0,
		});
	} catch (err) {
		// Non-fatal: startup must not depend on this. Unfilled rows fail closed rather
		// than falling back to their stale snapshot, and because the gate above is "is
		// there still work", the next startup tries again instead of skipping forever.
		logger.warn("subagent acl root backfill failed; will retry on next startup", {
			error: String(err),
			pending: before,
		});
	}
}

/**
 * There is deliberately NO backfill for `write_audience`.
 *
 * Every existing row keeps the column default, `owner`, because that is what those
 * sessions already enforced. A backfill deriving the write audience from `visibility`
 * was written and reverted; it is worth recording why, because the argument for it is
 * superficially compelling and its failure mode is a silent privilege escalation.
 *
 * The argument was that "who may drive" had not been a stored decision, so anyone who
 * could reach a session could already drive it, and deriving write from read would
 * merely restore the status quo. That premise is false. Since the ACL kernel shipped,
 * `canWriteNarrator` has consulted only ownership, admin, and an explicit write grant —
 * `visibility` has never granted write, and the released code says so at that branch:
 * making a narrator public shares a view of the work, it must never hand strangers the
 * ability to approve a tool call.
 *
 * So deriving `write_audience = 'public'` from `visibility = 'public'` would not restore
 * anything; it would hand write access to every signed-in user. The rows it would hit
 * hardest are the pre-ACL ones {@link backfillNarratorVisibility} publishes with
 * `owner_user_id = NULL`, which on an older instance is usually the entire history. And
 * because `resolveProjectGate(null)` reports "no gate here" for a session belonging to
 * no project, nothing downstream would have narrowed it again.
 *
 * A `WHERE write_audience = 'owner'` guard does not help: the column is added by the
 * same migration, so that condition is true for every row on the only run that matters.
 *
 * The bug that motivated the backfill was real but unrelated: scheduled tasks judged
 * their creator with a hard-coded `isAdmin: false`, so an admin-created task was refused
 * on a session that admin could drive by hand. That is fixed at its source, in
 * `scheduled-task-service.ts`'s `principalForTask`, and needed no change to anyone's
 * stored access.
 *
 * If a deployment does want its old public sessions team-drivable, that is an explicit
 * administrative act on a session whose consequences someone accepted — not a silent
 * consequence of upgrading.
 */

/**
 * One-time migration: fold `knowledge_grants` and `narrator_grants` into the
 * unified `acl_grants` table.
 *
 * Runs once, gated on `acl_grants` having been absent before this migration pass.
 * The source tables are left intact and unread afterwards, so a bad migration can
 * be rolled back as code rather than as data.
 *
 * The mapping is the delicate part, and one rule dominates it: a knowledge grant is
 * NOT converted into a plain `read` capability. Knowledge readability was never
 * "holds a grant" — it is the result of comparing clearance rank and compartment
 * tags. Emitting an unconditional `capability='read'` row for a user who merely
 * holds one low clearance would promote them to "can read everything", which is
 * privilege escalation. Domain credentials therefore migrate as credential rows
 * whose `capability` column is only an index placeholder (see the `acl_grants`
 * comment in schema.ts), and the knowledge layer keeps deciding readability itself.
 *
 * `canWrite` is the one part that IS a plain capability: it was a boolean riding on
 * an arbitrary grant row, so it becomes its own `write` row. Several source rows
 * carrying canWrite for the same principal and scope collapse onto one row, which
 * the unique index enforces — hence `INSERT OR IGNORE`.
 */
function migrateGrantsToUnifiedAcl(sqlite: Database): void {
	try {
		if (!tableExists(sqlite, "acl_grants")) return;

		let knowledgeCredentials = 0;
		let knowledgeWrites = 0;
		let narratorCapabilities = 0;

		sqlite.transaction(() => {
			if (tableExists(sqlite, "knowledge_grants")) {
				// Shape B — domain credentials. `capability` is pinned to 'read' as a
				// placeholder; it does not authorize reading.
				knowledgeCredentials = sqlite
					.prepare(
						`INSERT OR IGNORE INTO acl_grants
						   (id, scope_type, scope_id, principal_type, principal_id,
						    capability, domain_kind, domain_value, granted_by, created_at)
						 SELECT
						   'aclg_kc_' || g.id,
						   CASE WHEN g.collection_id IS NULL THEN 'global' ELSE 'knowledge_collection' END,
						   g.collection_id,
						   g.principal_type,
						   g.principal_id,
						   'read',
						   g.grant_type,
						   CASE g.grant_type
						     WHEN 'clearance' THEN g.clearance_level
						     ELSE g.tag_id
						   END,
						   NULL,
						   g.created_at
						 FROM knowledge_grants g
						 WHERE g.grant_type IN ('clearance','tag','review')
						   AND COALESCE(
						         CASE g.grant_type
						           WHEN 'clearance' THEN g.clearance_level
						           ELSE g.tag_id
						         END, '') <> ''`,
					)
					.run().changes;

				// Shape A — the canWrite boolean becomes a real capability row.
				knowledgeWrites = sqlite
					.prepare(
						`INSERT OR IGNORE INTO acl_grants
						   (id, scope_type, scope_id, principal_type, principal_id,
						    capability, domain_kind, domain_value, granted_by, created_at)
						 SELECT
						   'aclg_kw_' || g.id,
						   CASE WHEN g.collection_id IS NULL THEN 'global' ELSE 'knowledge_collection' END,
						   g.collection_id,
						   g.principal_type,
						   g.principal_id,
						   'write',
						   NULL,
						   NULL,
						   NULL,
						   g.created_at
						 FROM knowledge_grants g
						 WHERE g.can_write = 1`,
					)
					.run().changes;
			}

			if (tableExists(sqlite, "narrator_grants")) {
				// Narrator grants were already plain capabilities: a straight mapping.
				narratorCapabilities = sqlite
					.prepare(
						`INSERT OR IGNORE INTO acl_grants
						   (id, scope_type, scope_id, principal_type, principal_id,
						    capability, domain_kind, domain_value, granted_by, created_at)
						 SELECT
						   'aclg_n_' || g.id,
						   'narrator',
						   g.narrator_id,
						   g.principal_type,
						   g.principal_id,
						   g.access,
						   NULL,
						   NULL,
						   g.granted_by,
						   g.created_at
						 FROM narrator_grants g
						 WHERE g.access IN ('read','write')`,
					)
					.run().changes;
			}
		})();

		const total = knowledgeCredentials + knowledgeWrites + narratorCapabilities;
		if (total > 0) {
			logger.info("Migrated grants into unified acl_grants", {
				knowledgeCredentials,
				knowledgeWrites,
				narratorCapabilities,
			});
		}
	} catch (err) {
		// Non-fatal by the same rule as the backfills above: a failed migration leaves
		// the legacy tables authoritative, and the domain layers still read them until
		// their own cut-over step. Logged loudly because it needs attention.
		logger.error("unified ACL grant migration failed (non-fatal)", { error: String(err) });
	}
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
