/**
 * sqlite-dialect-inventory.guard.test.ts — Phase 0 inventory guard for the dual-database work.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every SQLite-specific thing in the codebase is a place the second dialect will have to
 * diverge. The problem is that these dependencies are INVISIBLE to every other check in the
 * pipeline: `PRAGMA busy_timeout`, `json_extract(...)`, `narrator_messages_fts MATCH ?` and
 * `INSERT OR REPLACE` are all just strings inside `sql\`\`` templates. tsgo type-checks them
 * (they are opaque template text), Biome formats them, and the tests pass — because the tests
 * run against SQLite. So a new `json_each(...)` added six months into the migration lands with
 * no signal at all, and the divergence surface silently grows while everyone believes it is
 * being tracked.
 *
 * This guard makes the surface a LEDGER. `DIALECT_INVENTORY` records, per file, exactly which
 * SQLite-only capabilities it uses today. Adding an unregistered one fails the test with the
 * file, the line and the capability, so the choice ("port this, or register it as SQLite-only")
 * is made deliberately at authoring time rather than discovered during the port.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a ban. Every entry below is legitimate SQLite usage in a SQLite-only product, and this
 * guard changes no runtime behavior whatsoever. Phase 0 is inventory, not migration. The test
 * asserts the inventory is COMPLETE and CURRENT — not that it is empty.
 *
 * HOW IT WORKS
 * ------------
 * Scan `server/` + `shared/` + `frontend/` for the patterns in `CAPABILITIES`. Compare the
 * result to `DIALECT_INVENTORY` in both directions (`diffAgainstLedger`):
 *
 *   - an unregistered hit  → a new dialect dependency appeared; register or port it.
 *   - a registered miss    → the dependency is gone; drop the stale entry so the ledger does
 *                            not overstate the remaining work.
 *
 * Both directions matter. A one-way check that only catches additions decays into a list of
 * files that used to matter, and a ledger nobody trusts is a ledger nobody reads.
 *
 * THE SCAN IS NOT A PROOF OF COMPLETENESS (read this before trusting it)
 * ---------------------------------------------------------------------
 * It is a lexical scan over comment-stripped source. It reliably catches SQL and imports
 * written literally, which is how essentially all of this repository's SQLite usage is
 * written. It CANNOT catch SQL that never exists as source text:
 *
 *   - fragments composed at runtime. `services/file-change-retention-inventory.ts` builds its
 *     `GLOB` filter inside `schemaName()`, and `services/revert-history-commit.ts` interpolates
 *     `INDEXED BY ${index}`. Both files happen to be registered because other literal text in
 *     them matches — but a NEW file that assembles its whole statement from variables
 *     (`sql.raw(\`... \${fn} ...\`)`) would not be seen at all.
 *   - capability names reached through a value: `sqlite[method](...)`, a helper that takes a
 *     PRAGMA name as an argument, a table name read from configuration.
 *   - anything in a file the walk skips (see `isExempt`).
 *
 * That gap is accepted rather than papered over: broadening the patterns enough to guess at
 * composed SQL produces false positives on ordinary TypeScript, and a guard that cries wolf
 * gets deleted, which costs more than the gap. The ledger is therefore a floor on the known
 * surface, not a ceiling on the real one. Two things narrow it: the `handle` /
 * `nativeClient` patterns catch the ACCESS PATH to the raw connection (composed SQL still has
 * to be executed through one of them), and `sqlite` is exported from exactly one module, which
 * the last test in this file pins.
 *
 * EXEMPTIONS (see `isExempt`)
 * ---------------------------
 * Three categories are out of scope by construction, and each is excluded by PATH so the
 * exclusion cannot quietly widen:
 *
 *   - tests + fixtures — they construct SQLite databases on purpose. Requiring registration
 *     for every `new Database(":memory:")` in a test would produce hundreds of entries that
 *     say nothing about production's portability, i.e. exactly the noise that gets a guard
 *     deleted.
 *   - operator scripts (`server/scripts/`, `scripts/`) — CLI tools run by a human against a
 *     local file. They are not part of the served application and need not follow it across
 *     dialects.
 *   - generated code (`server/generated/`) — build output. `embedded-changelog.ts` embeds
 *     release notes that literally quote "bun:sqlite" in prose, which is a pure false positive.
 *
 * The PROJECT DATABASE is exempt by a different mechanism: it stays SQLite permanently, so its
 * files are registered like any other, with `sqliteOnly: true` (see `SQLITE_ONLY_MODULES`).
 * That is a claim the guard checks rather than a hole in the scan — and the distinction is
 * load-bearing: `<gitPath>/.narrafork/project.db` is a portable artifact users copy between
 * machines, so it is not migrating anywhere regardless of what the main database does.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** Trees that contain application code. `scripts/` at the root is operator tooling. */
const SCAN_ROOTS = ["server", "shared", "frontend"] as const;

const SCAN_EXTENSIONS = [".ts", ".tsx"] as const;

/** Skipped anywhere by name: third-party, build output, VCS. */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set(["node_modules", "dist", "build", ".git"]);

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A SQLite-specific capability, and how to spot it in source text.
 *
 * `pattern` is deliberately conservative: it must match real usage without matching prose.
 * Comments are stripped before matching (`stripComments`), which is not optional here — this
 * repository documents its SQLite reasoning extensively ("bun:sqlite is synchronous, so …"
 * appears in a dozen headers), and matching those would bury the real hits.
 *
 * Case sensitivity is a per-capability decision, not a default. SQL keywords get `/i` because
 * `insert or replace` is valid SQL; identifiers that collide with ordinary TypeScript
 * (`rowid` vs `rowId`, `VACUUM` vs a `vacuum…` variable) stay case-sensitive precisely so the
 * camelCase spelling does NOT match.
 */
interface Capability {
	/** Stable key stored in `DIALECT_INVENTORY`. Renaming one is a ledger-wide edit. */
	readonly id: string;
	/** What the failure message tells the author they hit. */
	readonly what: string;
	/** Why it does not survive a dialect change. */
	readonly why: string;
	readonly pattern: RegExp;
}

/**
 * The main database module, in every spelling that resolves to `server/db/index.ts`:
 * a relative path (`../db`, `../../db`), the alias (`@server/db`), and either with the
 * `/index` suffix written out. Used by the `handle` pattern, which is the only capability
 * whose subject is a MODULE rather than a piece of SQL.
 */
const DB_MODULE_PATH = String.raw`(?:(?:\.\.?\/)+db|@server\/db)(?:\/index)?`;

/**
 * Reaching the raw `sqlite` connection, in the four forms that exist in TypeScript.
 *
 * Four branches rather than one, because the earlier single-branch version only understood a
 * static named import and therefore missed `const { sqlite } = await import("../db")` in
 * `services/routine-service.ts` — a real handle user that read as clean.
 */
const HANDLE_PATTERN = new RegExp(
	[
		// 1. `import { db, sqlite } from "../db"` (type-only imports included: the signature is
		//    still tied to this driver's shape).
		String.raw`\bimport\s+(?:type\s+)?\{[^}]*\bsqlite\b[^}]*\}\s*from\s*["']${DB_MODULE_PATH}["']`,
		// 2. `const { sqlite } = await import("../db")`. The bounded `[^}\n]{0,200}` keeps this
		//    linear-time and single-line; every real call site destructures on one line.
		String.raw`\{[^}\n]{0,200}\bsqlite\b[^}\n]{0,200}\}\s*=\s*(?:await\s+)?import\s*\(\s*["']${DB_MODULE_PATH}["']\s*\)`,
		// 3. `(await import("../db")).sqlite` — property access instead of destructuring.
		String.raw`\bimport\s*\(\s*["']${DB_MODULE_PATH}["']\s*\)\s*\)?\s*\.\s*sqlite\b`,
		// 4. `import * as database from "../db"`. Deliberately flagged on the IMPORT, not on a
		//    later `database.sqlite`: the member access can be built from a computed key, so the
		//    import is the only reliable anchor. This over-approximates (a namespace import that
		//    only touches `db` is still flagged) and there are currently no such imports; the
		//    branch exists so that adding one is a registration decision rather than a blind spot.
		String.raw`\bimport\s*\*\s*as\s+\w+\s*from\s*["']${DB_MODULE_PATH}["']`,
	].join("|"),
);

const CAPABILITIES: readonly Capability[] = [
	{
		id: "driver",
		what: "`bun:sqlite` driver import",
		why: "the driver itself: synchronous API, Bun-only, no equivalent in a networked client",
		// Static `from "bun:sqlite"` and dynamic `import("bun:sqlite")`. Type-only imports
		// count: `import type { Database }` still ties the signature to this driver's shape.
		pattern: /(?:\bfrom\s*|\b(?:import|require)\s*\(\s*)["']bun:sqlite["']/,
	},
	{
		id: "handle",
		what: "raw `sqlite` handle from `server/db`",
		why: "bypasses Drizzle entirely — raw `.prepare()`/`.run()`/`.transaction()` on the native connection",
		pattern: HANDLE_PATTERN,
	},
	{
		id: "nativeClient",
		what: "`$client` escape hatch on a Drizzle database",
		why: "Drizzle's own door to the underlying driver: `.inTransaction`, `.query()`, sync `bun:sqlite` semantics",
		// The other way to reach the native connection, and the one the import-based `handle`
		// pattern cannot see: these modules take a `{ $client }` object as a constructor
		// parameter, so nothing in them imports `server/db` at all.
		//
		// `\b` after `client` is what keeps `$clientId` / `$clientVersion` out.
		pattern: /\$client\b/,
	},
	{
		id: "connectionModule",
		what: "`server/db/connection` import (`openDatabase` / `getDbPath`)",
		why: "a file path plus a PRAGMA set — a networked dialect is configured by URL and has no local file",
		// Restricted to `openDatabase`/`getDbPath`. `getDbDir` is deliberately NOT included:
		// it returns the NarraFork home directory (used by `lib/pack-archives.ts` for archive
		// placement) and says nothing about the storage engine.
		pattern:
			/\bimport\s+(?:type\s+)?\{[^}]*\b(?:openDatabase|getDbPath)\b[^}]*\}\s*from\s*["'](?:\.\/connection|(?:\.\.?\/)+db\/connection|@server\/db\/connection)["']/,
	},
	{
		id: "drizzleDialect",
		what: "Drizzle SQLite dialect import (`drizzle-orm/bun-sqlite` or `/sqlite-core`)",
		why: "dialect-bound builder and types; a second backend needs the corresponding dialect module",
		pattern: /(?:\bfrom\s*|\bimport\s*\(\s*)["']drizzle-orm\/(?:bun-sqlite|sqlite-core)/,
	},
	{
		id: "sqliteCli",
		what: "`sqlite3` CLI invocation",
		why: "an external binary and its dot-commands (`.recover`, `.dump`) — a SQLite-only recovery path",
		// Requires whitespace before the quote so `sqlite3 "${path}" ".recover"` matches while
		// the binary-extension list in `shared/markdown-file-path.ts` ("… db sqlite sqlite3")
		// does not.
		pattern: /\bsqlite3\s+["'`]/,
	},
	{
		id: "pragma",
		what: "`PRAGMA` statement",
		why: "SQLite-only configuration/introspection surface with no portable equivalent",
		// `PRAGMA` + whitespace: matches statements, not the bare word in prose (which the
		// comment strip mostly handles) or an identifier like `pragmaFn`.
		pattern: /\bPRAGMA\s+/,
	},
	{
		id: "pragmaFn",
		what: "`pragma_*()` table-valued function",
		why: "SQLite-only introspection (`pragma_table_info`, `pragma_index_list`, …)",
		pattern: /\bpragma_\w+\s*\(/,
	},
	{
		id: "sqliteCatalog",
		what: "`sqlite_master` / `sqlite_schema` catalog table",
		why: "SQLite's schema catalog; other engines expose `information_schema` or pg_catalog",
		// Both spellings: `sqlite_schema` is the modern alias and is what the newer
		// storage/retention/revert code uses, so a `sqlite_master`-only pattern read four such
		// files as clean.
		pattern: /\bsqlite_(?:master|schema)\b/,
	},
	{
		id: "dbstat",
		what: "`dbstat` virtual table",
		why: "SQLite page-level storage introspection, and an optional compile-time extension at that",
		// Anchored to SQL position: `dbstat` also appears as a TypeScript union member
		// (`scanMode: "dbstat" | "approximate"`) and as field names in the worker protocol,
		// neither of which is a dialect dependency.
		pattern: /\b(?:FROM|JOIN)\s+dbstat\b/i,
	},
	{
		id: "rowid",
		what: "implicit `rowid` column",
		why: "SQLite's hidden integer key; it is also the join key every FTS5 external-content table needs",
		// Case-SENSITIVE on purpose. `rowid` is the SQL identifier; `rowId` is this codebase's
		// TypeScript field for an opaque page cursor (`useGit.ts`, `publication-outbox.ts`,
		// `plugin-integration-authority-service.ts`). Matching case-insensitively would flag
		// dozens of files that never touch the SQL column.
		pattern: /\browid\b/,
	},
	{
		id: "indexHint",
		what: "`INDEXED BY` / `NOT INDEXED` query hint",
		why: "SQLite-specific syntax that hard-fails if the named index is absent; other planners use different hints or none",
		pattern: /\b(?:INDEXED\s+BY|NOT\s+INDEXED)\b/,
	},
	{
		id: "json1",
		what: "JSON1 scalar function (`json_extract`, `json_valid`, `json_each`, …)",
		why: "SQLite's JSON1 syntax and semantics differ from other engines' JSON operators",
		pattern:
			/\bjson_(?:valid|extract|type|each|tree|array_length|patch|quote|insert|set|remove|group_array|group_object)\s*\(/,
	},
	{
		id: "fts5",
		what: "FTS5 virtual table (`*_fts`, `MATCH ?`)",
		why: "FTS5 tables, `MATCH` syntax, `snippet()`/`bm25()` and the sync triggers are SQLite-only",
		pattern: /\b\w+_fts\b|\bMATCH\s*\?/,
	},
	{
		id: "insertOr",
		what: "`INSERT OR IGNORE/REPLACE` conflict clause",
		why: "SQLite's OR-clause form; the portable spelling is `ON CONFLICT`",
		pattern: /\bINSERT\s+OR\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\b/i,
	},
	{
		id: "glob",
		what: "`GLOB` pattern operator",
		why: "SQLite's case-sensitive glob syntax (`*`, `?`, `[…]`); elsewhere it is `LIKE`/`SIMILAR TO`/regex",
		// Requires a following placeholder or quote so the operator is distinguished from the
		// many identifiers that merely start with those letters — `GIT_CONFIG_GLOBAL`,
		// `MAX_GLOBAL_PROMPT_BYTES`, `GLOBAL_SCOPE`, and "the GLOBAL knowledge base" in prompt
		// text. `NOT GLOB '…'` is covered, since the match starts at `GLOB`.
		pattern: /\bGLOB\s+(?:\?|['"])/,
	},
	{
		id: "blobFn",
		what: "`randomblob()` / `zeroblob()`",
		why: "SQLite blob builtins; `lower(hex(randomblob(16)))` is an in-SQL id generator with no portable spelling",
		// Found in the two INSERT…SELECT bulk paths (`narrator-service.ts` fork,
		// `narrator-refs-backfill.ts`) that must generate ids for thousands of rows without
		// round-tripping them through JS. `/i` because SQL is case-insensitive; the required
		// `(` keeps a `randomBlobSize` variable out.
		pattern: /\b(?:randomblob|zeroblob)\s*\(/i,
	},
	{
		id: "timeFn",
		what: "SQLite date/time function (`julianday`, `unixepoch`, `strftime`)",
		why: "SQLite's date model is a Julian-day/text hybrid; interval arithmetic elsewhere is unrelated syntax",
		pattern: /\b(?:julianday|unixepoch|strftime)\s*\(/i,
	},
	{
		id: "sessionFn",
		what: "connection-scoped counter (`total_changes()`, `last_insert_rowid()`)",
		why: "per-connection state; with a pooled/networked client the value belongs to whichever session served the call",
		// These back the revert stack's mutation-detection fingerprints, so the semantics
		// (counts my connection's changes) are load-bearing, not cosmetic.
		pattern: /\b(?:total_changes|last_insert_rowid)\s*\(\s*\)/i,
	},
	{
		id: "errorCode",
		what: "SQLite error identity (`SQLITE_BUSY`, `SQLiteError`, …)",
		why: "retry/conflict logic keyed to this engine's error codes and message text",
		// Anchored to the known code names rather than a bare `SQLITE_` prefix, so an unrelated
		// constant does not match. Note this is what turns "is this row a duplicate?" and "was
		// that lock contention?" into engine-specific string sniffing in eight modules.
		pattern:
			/\bSQLiteError\b|\bSQLITE_(?:BUSY|LOCKED|CONSTRAINT|CORRUPT|READONLY|CANTOPEN|FULL|IOERR|NOTADB|MISUSE|SCHEMA|TOOBIG|PROTOCOL|NOMEM|AUTH|RANGE|INTERNAL|PERM|ABORT|NOTFOUND|INTERRUPT)\w*/,
	},
	{
		id: "collate",
		what: "SQLite collation name (`COLLATE BINARY/NOCASE/RTRIM`)",
		why: "these three names are SQLite's built-ins; other engines name collations differently",
		pattern: /\bCOLLATE\s+(?:BINARY|NOCASE|RTRIM)\b/i,
	},
	{
		id: "vacuum",
		what: "`VACUUM` maintenance operation and its API chain",
		why: "a whole-file rewrite that blocks the process; other engines reclaim space online and expose no such call",
		// Covers the full chain, not just the `sqlite.run("VACUUM")` line: the operation is
		// admin-triggered, so the route, the client method and the button that calls it are all
		// SQLite-shaped surface. The frontend was previously invisible here, which understated
		// the operation as a backend detail when it is in fact user-facing.
		//
		// The two camelCase names exist only for this feature. Case-sensitive so `vacuuming`,
		// `vacuumHint` and lowercase prose do not match; `DatabaseVacuumResult` (a payload type
		// re-exported through `frontend/lib/api/types.ts`) is intentionally not matched — the
		// ledger tracks the call chain, not every alias that mentions it.
		pattern: /\bVACUUM\b|\bvacuum(?:Database|Supported)\b/,
	},
];

const CAPABILITY_IDS: ReadonlySet<string> = new Set(CAPABILITIES.map((c) => c.id));

// ─────────────────────────────────────────────────────────────────────────────
// The ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Modules that stay on SQLite permanently, with the reason.
 *
 * Registration alone does not mean "must be ported" — it means "known". This set marks the
 * subset that is known AND deliberately staying, so a reader can tell the remaining migration
 * work from the intentionally-SQLite floor. Listing a file here is a design claim; the guard
 * only checks that every name resolves to a registered file (a typo would silently exempt
 * nothing while looking like it exempted something).
 *
 * THE TEST FOR MEMBERSHIP: does a second backend REPLACE this file, or never call it at all?
 * ------------------------------------------------------------------------------------------
 * Three shapes are registered here, and they are not the same shape as a port adapter:
 *
 *   1. the PORTABLE ARCHIVE — `<gitPath>/.narrafork/project.db` and everything that opens it.
 *      Portability is the feature, so the file is SQLite regardless of what the main database
 *      becomes. A second backend still reads and writes these archives, through this same code.
 *   2. the SQLITE ENGINE ITSELF — the connection, migration replay, column patching, FTS5
 *      setup, WAL/`.recover` repair, and the lifecycle/maintenance adapters that orchestrate
 *      them. A server-managed engine has no local file to `.recover`, no `application_id` to
 *      stamp and no `VACUUM`, so it answers `notApplicable` (see `backend/capability.ts`)
 *      rather than reimplementing any of it.
 *   3. LEGACY SQLITE DATA REPAIR — statements that exist only because SQLite files written by
 *      older builds are still in the field.
 *
 * What is deliberately NOT here: a MAIN-DATABASE adapter behind a port
 * (`services/search/sqlite-store.ts`, `services/project-archive/sqlite-main-store.ts`). Those
 * are registered like any other pending work, because a second backend supplies its own
 * implementation of the same contract and the SQLite one stops being the answer. Marking them
 * as "staying" would say the port has nothing left to do, which is the opposite of true. The
 * last-but-one test in this file pins both directions of that distinction by name.
 */
const SQLITE_ONLY_MODULES: ReadonlyMap<string, string> = new Map([
	[
		"server/lib/project-db.ts",
		"per-project `<gitPath>/.narrafork/project.db` — a portable file users copy between machines",
	],
	["server/services/project-db-sync.ts", "writes the per-project SQLite file"],
	[
		"server/services/project-archive/archive-file.ts",
		"opens a portable `project.db` archive read-only; the archive is SQLite whatever the main database is",
	],
	[
		"server/services/project-archive/archive-writer.ts",
		"prepares the `INSERT OR REPLACE` statements that write into a portable archive file",
	],
	[
		"server/services/project-archive/export-rows.ts",
		"drives the archive-side (SQLite) writer while reading the main database through the port",
	],
	[
		"server/db/connection.ts",
		"the SQLite connection chokepoint itself (PRAGMA set + real-database test guard)",
	],
	[
		"server/db/backend/sqlite-lifecycle.ts",
		"the SQLite lifecycle adapter: instance lock over a local file, WAL, `application_id` marker, `sqlite3 .recover` — a second backend reports `notApplicable` instead of reimplementing it",
	],
	[
		"server/db/backend/sqlite-maintenance.ts",
		"the SQLite maintenance adapter: `PRAGMA wal_checkpoint`/`optimize`, freelist pages, `VACUUM`, `SQLITE_BUSY` classification — none of which a server-managed engine exposes",
	],
	["server/db/run-migrations.ts", "applies the SQLite migration SQL in `drizzle/`"],
	["server/db/migrate.ts", "the `bun run db:migrate` entry point: opens the file and applies SQL"],
	["server/db/ensure-columns.ts", "patches columns on SQLite databases from older versions"],
	[
		"server/db/data-backfills.ts",
		"repairs rows in SQLite databases written by older builds (status model, traits, handle fold, draft privacy); wired only into the SQLite lifecycle's backfill hook",
	],
	["server/db/fts.ts", "FTS5 virtual tables and triggers, which Drizzle cannot express"],
	["server/db/migrate-narrator-drafts.ts", "one-time SQLite data migration"],
	["server/db/integrity-probe-worker.ts", "read-only `PRAGMA integrity_check` subprocess"],
	[
		"server/db/integrity-check.ts",
		"orchestrates the SQLite integrity probe and the `sqlite3 .recover` fallback",
	],
	["server/lib/db-resilience.ts", "WAL recovery and `sqlite3 .recover` CLI fallback"],
	["server/lib/db-worker/worker-entry.ts", "read-only SQLite worker connection"],
	["server/lib/db-worker/search-query.ts", "bounded read-only SQLite search worker execution"],
	["server/lib/db-worker/storage-scan-runner.ts", "SQLite storage scan budgets"],
	["server/services/storage-scan-queries.ts", "`dbstat`/page-level SQLite storage accounting"],
	["server/services/database-cleanup-service.ts", "SQLite VACUUM / page accounting maintenance"],
	[
		"server/services/file-change-physical-audit-worker.ts",
		"SQLite-side physical audit in a worker",
	],
]);

/**
 * Every production file that depends on a SQLite-only capability, and which ones.
 *
 * Capability lists are stored in `CAPABILITIES` order so the expected/actual comparison is a
 * plain deep-equal and a diff reads cleanly.
 *
 * ⚠️ Regenerate rather than hand-edit when a change is large: this ledger was produced by the
 * same scan the test runs, so `bun test server/db/sqlite-dialect-inventory.guard.test.ts`
 * reports the exact delta to apply.
 */
const DIALECT_INVENTORY: Readonly<Record<string, readonly string[]>> = {
	// The admin VACUUM chain reaches the UI. `usePlatform` gates the button on a backend
	// capability flag, which is why these three are registered but NOT in SQLITE_ONLY_MODULES:
	// they already degrade when the backend says the operation is unsupported.
	"frontend/components/settings/StorageSection.tsx": ["vacuum"],
	"frontend/hooks/usePlatform.ts": ["vacuum"],
	"frontend/lib/api/misc.ts": ["vacuum"],
	// The two backend adapters below hold what used to be inline in `server/db/index.ts`. The
	// capabilities did not move out of the codebase, they moved BEHIND a port.
	"server/db/backend/sqlite-lifecycle.ts": ["driver", "connectionModule", "sqliteCli"],
	"server/db/backend/sqlite-maintenance.ts": ["driver", "pragma", "errorCode", "vacuum"],
	"server/db/connection.ts": ["driver", "pragma"],
	"server/db/data-backfills.ts": ["driver", "sqliteCatalog", "json1"],
	"server/db/ensure-columns.ts": ["driver", "drizzleDialect", "pragma", "sqliteCatalog"],
	"server/db/fts.ts": ["driver", "pragma", "sqliteCatalog", "rowid", "fts5", "insertOr"],
	// The PostgreSQL production wiring (P1) reintroduced two type/lookup-level capabilities
	// into the wiring module: the `bun:sqlite` Database TYPE (the `sqlite` export must carry
	// it even when the PG branch exports a fail-closed proxy instead of a connection) and
	// `getDbPath` (the PG branch acquires the same instance lock at the same path — the lock
	// guards local resources, not the database file). Neither opens a SQLite connection.
	"server/db/index.ts": ["drizzleDialect", "driver", "connectionModule"],
	"server/db/integrity-check.ts": ["connectionModule", "sqliteCli"],
	"server/db/integrity-probe-worker.ts": ["driver", "pragma"],
	"server/db/migrate-narrator-drafts.ts": ["driver"],
	"server/db/migrate.ts": ["connectionModule"],
	"server/db/run-migrations.ts": ["driver", "pragma", "pragmaFn", "sqliteCatalog", "insertOr"],
	"server/db/schema.ts": ["drizzleDialect", "json1"],
	// Recall's FTS5/rowid statements moved to `services/search/sqlite-store.ts`; what remains is
	// the raw-handle access path for its non-search reads.
	"server/lib/agent/tools/recall.ts": ["driver", "handle"],
	"server/lib/db-resilience.ts": ["driver", "sqliteCli", "pragma", "sqliteCatalog", "errorCode"],
	"server/lib/db-worker/storage-scan-runner.ts": ["driver", "fts5"],
	"server/lib/db-worker/worker-entry.ts": ["driver", "pragma"],
	"server/lib/db-worker/search-query.ts": ["driver"],
	"server/services/search/sqlite-worker-runner.ts": ["connectionModule"],
	"server/lib/project-db.ts": ["driver", "pragma"],
	"server/routes/storage.ts": ["vacuum"],
	"server/routes/user-preferences.ts": ["handle"],
	"server/services/agent-runtime/inbox.ts": ["json1"],
	"server/services/agent-runtime/publication-outbox.ts": ["nativeClient", "rowid"],
	"server/services/benchmark-service.ts": ["handle", "timeFn"],
	"server/services/chat-service.ts": ["drizzleDialect"],
	// `pragma` and `errorCode` left this file for `backend/sqlite-maintenance.ts`. `vacuum` stays
	// because the admin operation is still exposed from here (through the port), and the chain-
	// end test below depends on that remaining true.
	"server/services/database-cleanup-service.ts": ["handle", "connectionModule", "json1", "vacuum"],
	"server/services/execution-log-service.ts": ["json1"],
	"server/services/external-resource-service.ts": ["json1", "errorCode"],
	"server/services/file-change-blob-catalog.ts": ["drizzleDialect", "pragma"],
	"server/services/file-change-evidence.ts": ["nativeClient"],
	"server/services/file-change-physical-audit-worker.ts": [
		"driver",
		"pragma",
		"pragmaFn",
		"sqliteCatalog",
		"indexHint",
		"errorCode",
	],
	"server/services/file-change-retention-inventory.ts": [
		"driver",
		"pragma",
		"pragmaFn",
		"sqliteCatalog",
		"rowid",
		"indexHint",
		"json1",
		"glob",
		"collate",
	],
	"server/services/file-state-rebuild.ts": ["json1"],
	"server/services/git-current-diff-view.ts": ["rowid"],
	"server/services/integration-authority-service.ts": ["errorCode"],
	"server/services/narrator-messages.ts": ["json1", "glob"],
	"server/services/narrator-persistence.ts": ["handle", "json1"],
	"server/services/narrator-refs-backfill.ts": ["blobFn"],
	"server/services/narrator-scoped-revert.ts": ["json1"],
	"server/services/narrator-service.ts": ["blobFn"],
	"server/services/narrator-session.ts": ["handle"],
	"server/services/narrator-subagent-recovery.ts": ["handle"],
	"server/services/oauth-grant-service.ts": ["errorCode"],
	"server/services/parent-injection-queue.ts": ["json1"],
	// The archive seam. Three files below are SQLite-only (the portable FILE), one is not:
	// `sqlite-main-store.ts` is the MAIN database behind `ProjectArchiveMainStore`, so a second
	// backend replaces it. `store.ts` — the module that picks the implementation — has no
	// capability of its own and correctly does not appear here.
	"server/services/project-archive/archive-file.ts": ["driver", "pragma"],
	"server/services/project-archive/archive-writer.ts": ["driver", "pragma", "insertOr"],
	"server/services/project-archive/export-rows.ts": ["driver"],
	"server/services/project-archive/sqlite-main-store.ts": ["insertOr"],
	"server/services/project-archive/worker-sqlite-store.ts": ["driver", "pragma"],
	// `insertOr` left for `project-archive/archive-writer.ts`; the export's own SQLite reads and
	// PRAGMA work on the portable file stay.
	"server/services/project-db-sync.ts": ["driver", "pragma", "json1"],
	"server/services/revert-history-commit.ts": [
		"driver",
		"nativeClient",
		"drizzleDialect",
		"pragma",
		"pragmaFn",
		"sqliteCatalog",
		"rowid",
		"indexHint",
		"fts5",
		"insertOr",
		"sessionFn",
	],
	"server/services/revert-mutation-journal.ts": [
		"driver",
		"nativeClient",
		"drizzleDialect",
		"pragma",
		"json1",
	],
	"server/services/revert-plan-service.ts": [
		"driver",
		"nativeClient",
		"drizzleDialect",
		"pragma",
		"json1",
	],
	"server/services/revert-planner-local-access.ts": ["json1"],
	"server/services/revert-planner-service.ts": ["nativeClient", "pragma", "sessionFn"],
	"server/services/revert-selection-service.ts": [
		"driver",
		"nativeClient",
		"pragma",
		"rowid",
		"indexHint",
		"sessionFn",
	],
	"server/services/revert-transaction-service.ts": ["nativeClient", "pragma", "sessionFn"],
	"server/services/routine-service.ts": ["handle"],
	// The whole search surface, in one file behind `services/search/port.ts`. NOT SQLite-only: a
	// second backend implements the same `SearchStore` contract and this file stops being the
	// answer. `search-service.ts`, `knowledge-service.ts` and the Recall tool used to carry these
	// four capabilities between them; they no longer do.
	"server/services/search/sqlite-store.ts": ["rowid", "fts5"],
	"server/services/snapshot-capture-receipts.ts": ["nativeClient", "pragma"],
	"server/services/storage-scan-queries.ts": [
		"driver",
		"pragma",
		"sqliteCatalog",
		"dbstat",
		"json1",
		"fts5",
		"errorCode",
	],
	"server/services/subagent-activity.ts": ["json1"],
	"server/services/subagent-file-changes.ts": ["drizzleDialect"],
	"server/services/tool-continuation-service.ts": ["json1"],
	"server/services/tool-edit-preview.ts": ["json1"],
	"server/services/workspace-modification-view.ts": ["rowid"],
	"server/services/workspace-write-coordinator.ts": ["drizzleDialect", "pragma"],
	"shared/subagent-tool-summary.ts": ["json1"],
};

// ─────────────────────────────────────────────────────────────────────────────
// Scanning
// ─────────────────────────────────────────────────────────────────────────────

/** Repo-relative path with forward slashes, so the ledger keys are platform-independent. */
function toPosixRelative(absolute: string): string {
	return relative(REPO_ROOT, absolute).split(sep).join("/");
}

/**
 * Whether `posixPath` is out of scope. Every rule is anchored to a path PREFIX or a filename
 * shape — never a bare directory name matched at any depth, which is how an exemption meant
 * for one build directory silently spreads to hand-written code elsewhere in the tree.
 */
function isExempt(posixPath: string): boolean {
	// Tests and their fixtures construct SQLite databases on purpose.
	const fileName = posixPath.slice(posixPath.lastIndexOf("/") + 1);
	if (fileName.includes(".test.") || fileName.includes(".spec.")) return true;
	if (posixPath.includes("/__tests__/")) return true;
	if (posixPath.startsWith("tests/")) return true;

	// Operator CLI tools, run by a human against a local file — not part of the served app.
	if (posixPath.startsWith("server/scripts/")) return true;
	if (posixPath.startsWith("scripts/")) return true;

	// Build output. `server/generated/embedded-changelog.ts` quotes "bun:sqlite" in release
	// notes prose, which is a pure false positive.
	if (posixPath.startsWith("server/generated/")) return true;
	if (posixPath.startsWith("frontend/generated/")) return true;

	// This guard necessarily NAMES every capability it detects.
	if (posixPath === "server/db/sqlite-dialect-inventory.guard.test.ts") return true;

	return false;
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (SKIP_DIR_NAMES.has(entry)) continue;
			collectSourceFiles(full, out);
			continue;
		}
		if (SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
	}
	return out;
}

/**
 * Blank out line and block comments, preserving byte offsets so reported line numbers still
 * point at the real file. Without this the guard is dominated by its own documentation: the
 * modules below explain their SQLite reasoning at length in JSDoc.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

interface Finding {
	readonly capability: Capability;
	readonly line: number;
	readonly snippet: string;
}

/** Capabilities used by `source`, in `CAPABILITIES` order, with the first hit's location. */
function scanSource(source: string): Finding[] {
	const code = stripComments(source);
	const findings: Finding[] = [];
	for (const capability of CAPABILITIES) {
		const match = new RegExp(capability.pattern.source, capability.pattern.flags).exec(code);
		if (!match) continue;
		const line = code.slice(0, match.index).split("\n").length;
		findings.push({
			capability,
			line,
			snippet: (source.split("\n")[line - 1] ?? match[0]).trim().slice(0, 120),
		});
	}
	return findings;
}

/**
 * The live inventory: repo-relative path → findings, for all in-scope files.
 *
 * Memoized: the walk reads ~1500 files and several tests below need it. Recomputing per test
 * turned a sub-second guard into a multi-second one, and a slow guard is one people skip.
 */
let scanCache: Map<string, Finding[]> | undefined;

function scanRepository(): Map<string, Finding[]> {
	if (scanCache) return scanCache;
	const result = new Map<string, Finding[]>();
	for (const root of SCAN_ROOTS) {
		for (const absolute of collectSourceFiles(join(REPO_ROOT, root))) {
			const posixPath = toPosixRelative(absolute);
			if (isExempt(posixPath)) continue;
			const findings = scanSource(readFileSync(absolute, "utf8"));
			if (findings.length > 0) result.set(posixPath, findings);
		}
	}
	scanCache = result;
	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison
// ─────────────────────────────────────────────────────────────────────────────

interface LedgerDiff {
	/** Live capability uses with no matching ledger entry. */
	readonly unregistered: { file: string; finding: Finding }[];
	/** Ledger entries for files the scan no longer finds any usage in. */
	readonly vanishedFiles: string[];
	/** Ledger entries whose specific capability is no longer used by that file. */
	readonly vanishedCapabilities: { file: string; id: string }[];
}

/**
 * Both directions of the comparison, as a pure function of its inputs.
 *
 * Pure so the comparison logic itself is testable on synthetic input: a guard whose only
 * evidence is "it passes against the current repository" cannot distinguish working from
 * vacuously true, which is exactly the failure mode this file exists to prevent elsewhere.
 */
function diffAgainstLedger(
	live: ReadonlyMap<string, readonly Finding[]>,
	ledger: Readonly<Record<string, readonly string[]>>,
): LedgerDiff {
	const unregistered: { file: string; finding: Finding }[] = [];
	for (const [file, findings] of live) {
		const registered = new Set(ledger[file] ?? []);
		for (const finding of findings) {
			if (registered.has(finding.capability.id)) continue;
			unregistered.push({ file, finding });
		}
	}

	const vanishedFiles: string[] = [];
	const vanishedCapabilities: { file: string; id: string }[] = [];
	for (const [file, expected] of Object.entries(ledger)) {
		const findings = live.get(file);
		if (!findings) {
			vanishedFiles.push(file);
			continue;
		}
		const actual = new Set(findings.map((f) => f.capability.id));
		for (const id of expected) {
			if (!actual.has(id)) vanishedCapabilities.push({ file, id });
		}
	}

	return { unregistered, vanishedFiles, vanishedCapabilities };
}

/** Build a synthetic live-inventory map from source strings, for testing the comparison. */
function liveFromSources(sources: Readonly<Record<string, string>>): Map<string, Finding[]> {
	const live = new Map<string, Finding[]>();
	for (const [file, source] of Object.entries(sources)) {
		const findings = scanSource(source);
		if (findings.length > 0) live.set(file, findings);
	}
	return live;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("SQLite dialect inventory guard", () => {
	it("scan surface is non-empty and reaches every root", () => {
		// The comparisons below are only meaningful if the walk actually found files. A failed
		// readdir or an over-broad skip rule would otherwise make every assertion pass on an
		// empty set — the classic way a guard becomes decorative.
		const scanned = SCAN_ROOTS.flatMap((root) =>
			collectSourceFiles(join(REPO_ROOT, root)).map(toPosixRelative),
		);
		expect(scanned.length).toBeGreaterThan(500);
		for (const root of SCAN_ROOTS) {
			expect(scanned.some((p) => p.startsWith(`${root}/`))).toBe(true);
		}
		// Anchors: the connection chokepoint and a known JSON1 user in shared/.
		expect(scanned).toContain("server/db/connection.ts");
		expect(scanned).toContain("shared/subagent-tool-summary.ts");
	});

	it("registers every SQLite-only dependency in production code", () => {
		const { unregistered } = diffAgainstLedger(scanRepository(), DIALECT_INVENTORY);

		if (unregistered.length > 0) {
			const report = unregistered.map(
				({ file, finding }) =>
					`  ${file}:${finding.line}\n` +
					`    capability: ${finding.capability.id} — ${finding.capability.what}\n` +
					`    why it matters: ${finding.capability.why}\n` +
					`    ${finding.snippet}`,
			);
			throw new Error(
				"Unregistered SQLite-only dependencies found in production code.\n\n" +
					"Phase 0 of the dual-database work tracks this surface deliberately: nothing else in " +
					"the pipeline can see it, because SQL inside `sql``` templates is opaque to tsgo and " +
					"the tests run on SQLite.\n\n" +
					"Either use a portable construct, or add the capability to DIALECT_INVENTORY in " +
					"server/db/sqlite-dialect-inventory.guard.test.ts (and to SQLITE_ONLY_MODULES if the " +
					"module is deliberately staying on SQLite).\n\n" +
					`${report.join("\n")}\n`,
			);
		}
		expect(unregistered).toHaveLength(0);
	});

	it("has no stale inventory entries", () => {
		const { vanishedFiles, vanishedCapabilities } = diffAgainstLedger(
			scanRepository(),
			DIALECT_INVENTORY,
		);
		const stale = [
			...vanishedFiles.map(
				(file) => `  ${file} — registered, but no SQLite-only usage found (moved, or removed?)`,
			),
			...vanishedCapabilities.map(
				({ file, id }) => `  ${file} — registered capability "${id}" is no longer used`,
			),
		];

		if (stale.length > 0) {
			throw new Error(
				"Stale entries in DIALECT_INVENTORY. A ledger that overstates the remaining work is a " +
					"ledger nobody trusts — drop the entries below.\n\n" +
					`${stale.join("\n")}\n`,
			);
		}
		expect(stale).toHaveLength(0);
	});

	it("self-check: the comparison reports both directions on synthetic input", () => {
		// Without this, "the ledger matches the repo" could equally mean "the comparison is
		// broken and reports nothing". Synthetic sources only — no files are touched.
		const live = liveFromSources({
			"fake/registered.ts": 'import { Database } from "bun:sqlite";',
			"fake/unregistered.ts": 'sqlite.run("VACUUM");',
			"fake/partial.ts": 'import { Database } from "bun:sqlite";',
		});

		const diff = diffAgainstLedger(live, {
			"fake/registered.ts": ["driver"],
			"fake/partial.ts": ["driver", "fts5"],
			"fake/deleted.ts": ["json1"],
		});

		// An unregistered file's usage is reported, with the capability that caused it.
		expect(diff.unregistered.map((u) => [u.file, u.finding.capability.id])).toEqual([
			["fake/unregistered.ts", "vacuum"],
		]);
		// A ledger entry whose file no longer uses anything is reported.
		expect(diff.vanishedFiles).toEqual(["fake/deleted.ts"]);
		// A ledger entry that over-claims one capability is reported for that capability only.
		expect(diff.vanishedCapabilities).toEqual([{ file: "fake/partial.ts", id: "fts5" }]);
		// A correct entry produces nothing in any direction.
		expect(diff.unregistered.some((u) => u.file === "fake/registered.ts")).toBe(false);
		expect(diff.vanishedFiles).not.toContain("fake/registered.ts");
	});

	it("inventory is internally consistent", () => {
		for (const [file, ids] of Object.entries(DIALECT_INVENTORY)) {
			expect(ids.length, `${file} has an empty capability list`).toBeGreaterThan(0);
			expect(new Set(ids).size, `${file} lists a capability twice`).toBe(ids.length);
			for (const id of ids) {
				expect(CAPABILITY_IDS.has(id), `${file} references unknown capability "${id}"`).toBe(true);
			}
			// A registered file that the scan would never visit can never be validated, so the
			// entry would be permanently unfalsifiable.
			expect(isExempt(file), `${file} is registered but exempt from the scan`).toBe(false);
		}

		// Every SQLite-only claim must attach to a registered file: a typo here would look like
		// a documented decision while describing nothing.
		for (const [file, reason] of SQLITE_ONLY_MODULES) {
			expect(
				DIALECT_INVENTORY[file],
				`${file} is marked SQLite-only but not registered`,
			).toBeDefined();
			expect(reason.length, `${file} needs a reason for staying on SQLite`).toBeGreaterThan(0);
		}
	});

	it("capability definitions are unique and documented", () => {
		expect(CAPABILITY_IDS.size).toBe(CAPABILITIES.length);
		for (const capability of CAPABILITIES) {
			expect(capability.what.length, `${capability.id} needs a description`).toBeGreaterThan(0);
			expect(capability.why.length, `${capability.id} needs a rationale`).toBeGreaterThan(0);
			// Global flags would make `exec` stateful across calls and skip every other match.
			expect(capability.pattern.flags, `${capability.id} must not use the /g flag`).not.toContain(
				"g",
			);
		}
	});

	it("self-check: every capability has at least one live user", () => {
		// A pattern that matches nothing is indistinguishable from a broken one. Any capability
		// listed in the ledger must therefore be observed by the scan somewhere.
		//
		// The exception is deliberate and named: `handle`'s namespace-import branch (case 4 in
		// HANDLE_PATTERN) has no call site today and is covered by the detection self-check
		// below instead. That is an over-approximating branch of an already-live capability,
		// not a capability of its own, so it is not listed here.
		const live = new Set(
			[...scanRepository().values()].flatMap((findings) => findings.map((f) => f.capability.id)),
		);
		for (const capability of CAPABILITIES) {
			expect(live.has(capability.id), `capability "${capability.id}" matches nothing`).toBe(true);
		}
	});

	it("self-check: detects each capability in live code and ignores prose", () => {
		const detect = (source: string) => scanSource(source).map((f) => f.capability.id);

		expect(detect('import { Database } from "bun:sqlite";')).toContain("driver");
		expect(detect('import type { Database } from "bun:sqlite";')).toContain("driver");
		expect(detect('const m = await import("bun:sqlite");')).toContain("driver");
		expect(detect('import { db, sqlite } from "../db";')).toContain("handle");
		expect(detect('import { sqlite } from "@server/db";')).toContain("handle");
		expect(detect('import { drizzle } from "drizzle-orm/bun-sqlite";')).toContain("drizzleDialect");
		expect(detect('import { alias } from "drizzle-orm/sqlite-core";')).toContain("drizzleDialect");
		expect(detect("db.get(sql`PRAGMA busy_timeout`);")).toContain("pragma");
		expect(detect('sqlite.prepare("SELECT * FROM pragma_table_info(?)");')).toContain("pragmaFn");
		expect(detect('sqlite.prepare("SELECT name FROM sqlite_master");')).toContain("sqliteCatalog");
		expect(detect("q(\"SELECT SUM(pgsize) FROM dbstat WHERE schema = 'main'\");")).toContain(
			"dbstat",
		);
		// The placeholder below is fixture text on purpose: real call sites interpolate a column
		// into a `sql``` template, and the scan must still see `json_valid(` through it.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional fixture, not a template
		expect(detect("sql`AND json_valid(${col})`")).toContain("json1");
		expect(detect("sql`WHERE json_extract(content_json, '$[0].type') = 'compact'`")).toContain(
			"json1",
		);
		expect(detect("`WHERE narrator_messages_fts MATCH ?`")).toContain("fts5");
		expect(detect('"INSERT OR REPLACE INTO projects (id) VALUES (?)"')).toContain("insertOr");

		// Prose is not usage. These exact sentences appear across the repo's JSDoc.
		expect(detect("// bun:sqlite is synchronous, so a busy wait freezes the server")).toEqual([]);
		expect(
			detect("/**\n * `PRAGMA quick_check` reads every page, and json_valid() guards it.\n */"),
		).toEqual([]);
		expect(detect("/* FTS5 tables like narrator_messages_fts are rebuilt here. */")).toEqual([]);

		// Type-level lookalikes are not SQL. Both are real shapes in this codebase and both
		// were false positives in an earlier revision of this guard.
		expect(detect('scanMode: "dbstat" | "approximate";')).toEqual([]);
		expect(detect("interface Report { dbstatSupported: boolean; }")).toEqual([]);
	});

	it("self-check: detects the handle in every import form", () => {
		const detect = (source: string) => scanSource(source).map((f) => f.capability.id);

		// The form that a static-import-only pattern missed: `services/routine-service.ts`
		// reaches the raw connection through a lazy import and read as clean for it.
		expect(detect('const { sqlite } = await import("../db");')).toContain("handle");
		expect(detect('const { db, sqlite } = await import("../../db");')).toContain("handle");
		expect(detect('const { sqlite } = await import("@server/db/index");')).toContain("handle");
		expect(detect('const h = (await import("../db")).sqlite;')).toContain("handle");
		expect(detect('import * as database from "../db";')).toContain("handle");
		expect(detect('import * as database from "@server/db";')).toContain("handle");

		// Not the main database module, so not this capability. `db/schema` and `db/connection`
		// carry their own capabilities (`drizzleDialect`, `connectionModule`) and must not be
		// folded into `handle`, which specifically means "holds the native connection".
		expect(detect('import { narrators } from "../db/schema";')).toEqual([]);
		expect(detect('const { sqliteTable } = await import("../db/schema");')).toEqual([]);
		// A same-named export from an unrelated module is not the shared handle.
		expect(detect('import { sqlite } from "./local-sqlite-helper";')).toEqual([]);
	});

	it("self-check: detects the `$client` escape hatch without matching similar names", () => {
		const detect = (source: string) => scanSource(source).map((f) => f.capability.id);

		// These modules take the native connection as a parameter, so no import reveals them.
		expect(detect("if (this.db.$client.inTransaction) return;")).toContain("nativeClient");
		expect(detect("readonly $client: Database;")).toContain("nativeClient");
		expect(detect('type Root = Pick<typeof db, "transaction" | "$client">;')).toContain(
			"nativeClient",
		);
		expect(detect("legacyBoundaries.get(db.$client);")).toContain("nativeClient");

		// The trailing `\b` is what keeps these out.
		expect(detect("const id = payload.$clientId;")).toEqual([]);
		expect(detect("interface Meta { $clientVersion: string }")).toEqual([]);
	});

	it("self-check: detects the SQLite connection module without the directory helper", () => {
		const detect = (source: string) => scanSource(source).map((f) => f.capability.id);

		expect(detect('import { openDatabase } from "./connection";')).toContain("connectionModule");
		expect(detect('import { getDbPath, openDatabase } from "./connection";')).toContain(
			"connectionModule",
		);
		expect(detect('import { getDbPath } from "@server/db/connection";')).toContain(
			"connectionModule",
		);
		expect(detect('import { getDbPath } from "../db/connection";')).toContain("connectionModule");

		// `getDbDir` is the NarraFork home directory, not a database artifact:
		// `lib/pack-archives.ts` uses it to place archives. Flagging it would register a file
		// with no storage-engine dependency at all.
		expect(detect('import { getDbDir } from "../db/connection";')).toEqual([]);
		// A different module that happens to be called `connection`.
		expect(detect('import { openSocket } from "./connection";')).toEqual([]);
	});

	it("self-check: detects catalog, rowid and index hints without camelCase collisions", () => {
		const detect = (source: string) => scanSource(source).map((f) => f.capability.id);

		// `sqlite_schema` is the spelling the newer storage/retention/revert code uses; a
		// `sqlite_master`-only pattern read four such files as clean.
		expect(detect("q(\"SELECT sql FROM sqlite_schema WHERE type='trigger'\");")).toContain(
			"sqliteCatalog",
		);
		expect(detect('q("SELECT type FROM main.sqlite_schema WHERE name = ?");')).toContain(
			"sqliteCatalog",
		);

		expect(detect("`JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid`")).toContain(
			"rowid",
		);
		expect(detect('q("SELECT max(rowid) FROM background_tasks");')).toContain("rowid");
		// `rowId` is this codebase's TypeScript name for an opaque page cursor. Matching it
		// would flag frontend hooks and services that never touch the SQL column.
		expect(detect("nextCursor?: { changedAt: string; rowId: string } | null;")).toEqual([]);
		expect(detect("function pluginGrantRowId(id: string): string { return id; }")).toEqual([]);
		expect(detect("const rowIdx = rows.indexOf(row);")).toEqual([]);

		expect(
			detect('q("SELECT id FROM narrator_message_refs INDEXED BY idx_narrator_refs_seq");'),
		).toContain("indexHint");
		expect(detect('q("SELECT digest FROM t NOT INDEXED WHERE digest > ?");')).toContain(
			"indexHint",
		);
		expect(detect("const indexedByName = new Map();")).toEqual([]);
		expect(detect("const isIndexed = true;")).toEqual([]);
	});

	it("self-check: detects SQLite builtins without matching similar identifiers", () => {
		const detect = (source: string) => scanSource(source).map((f) => f.capability.id);

		// In-SQL id generation for bulk INSERT…SELECT (fork, refs backfill).
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional fixture, not a template
		expect(detect("sql`SELECT lower(hex(randomblob(16))), ${id}`")).toContain("blobFn");
		expect(detect('q("SELECT zeroblob(32)");')).toContain("blobFn");
		expect(detect("const randomBlobSize = 16;")).toEqual([]);

		expect(
			detect('q("SET d = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)");'),
		).toContain("timeFn");
		expect(detect("q(\"SELECT strftime('%s', 'now')\");")).toContain("timeFn");
		expect(detect("const julian = calendarDay(1);")).toEqual([]);

		expect(detect('q("SELECT total_changes() AS value");')).toContain("sessionFn");
		expect(detect('q("SELECT last_insert_rowid()");')).toContain("sessionFn");
		expect(detect("const n = countTotalChanges();")).toEqual([]);

		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional fixture, not a template
		expect(detect("`WHERE ${column} COLLATE BINARY = ?`")).toContain("collate");
		expect(detect('q("ORDER BY name COLLATE NOCASE");')).toContain("collate");
		expect(detect("const collated = collateResults(rows);")).toEqual([]);
	});

	it("self-check: detects GLOB without matching GLOBAL identifiers", () => {
		const detect = (source: string) => scanSource(source).map((f) => f.capability.id);

		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional fixture, not a template
		expect(detect("sql`${narrators.variant} GLOB 'subagent:*'`")).toContain("glob");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional fixture, not a template
		expect(detect("`CASE WHEN ${column} NOT GLOB '*[^a-zA-Z_0-9]*' THEN ${column} END`")).toContain(
			"glob",
		);
		expect(detect('q("SELECT 1 FROM t WHERE name GLOB ?");')).toContain("glob");

		// All four shapes below are real occurrences in this repository, and every one of them
		// matched an earlier `\bGLOB\b`-style pattern.
		expect(detect('env.GIT_CONFIG_GLOBAL = "/dev/null";')).toEqual([]);
		expect(detect("const MAX_GLOBAL_PROMPT_BYTES = 200_000;")).toEqual([]);
		expect(detect('export const GLOBAL_SCOPE: AclScope = { type: "global", id: null };')).toEqual(
			[],
		);
		expect(detect('const line = "- The GLOBAL knowledge base is the source of truth.";')).toEqual(
			[],
		);
	});

	it("self-check: detects SQLite error identity without matching unrelated constants", () => {
		const detect = (source: string) => scanSource(source).map((f) => f.capability.id);

		expect(detect("/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(message);")).toContain(
			"errorCode",
		);
		expect(detect("return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);")).toContain(
			"errorCode",
		);
		expect(detect("/unique constraint|SQLITE_CONSTRAINT_UNIQUE/i.test(String(error));")).toContain(
			"errorCode",
		);
		expect(detect("if (error instanceof SQLiteError) throw error;")).toContain("errorCode");

		// Anchored to the known code names, so a prefix lookalike does not match.
		expect(detect('const label = "SQLITEISH";')).toEqual([]);
		expect(detect("const SQLITE_LIKE_MODE = 1;")).toEqual([]);
	});

	it("self-check: detects the VACUUM chain without matching prose or variables", () => {
		const detect = (source: string) => scanSource(source).map((f) => f.capability.id);

		expect(detect('sqlite.run("VACUUM");')).toContain("vacuum");
		expect(detect("async vacuumDatabase(): Promise<DatabaseVacuumResult> {")).toContain("vacuum");
		expect(detect("const result = await api.vacuumDatabase();")).toContain("vacuum");
		expect(detect("vacuumSupported: boolean;")).toContain("vacuum");

		// Case-sensitive, so lowercase prose and unrelated variables stay out.
		expect(detect("const message = 'vacuum the database during a maintenance window';")).toEqual(
			[],
		);
		expect(detect("const vacuumHint = t('storageDatabaseVacuumDisabled');")).toEqual([]);
		expect(detect("setDatabaseVacuuming(true);")).toEqual([]);
	});

	it("self-check: exemptions are prefix-anchored, not name-matched at any depth", () => {
		expect(isExempt("server/db/fts.test.ts")).toBe(true);
		expect(isExempt("server/services/__tests__/knowledge-smoke.ts")).toBe(true);
		expect(isExempt("tests/fixtures/knowledge-grants.ts")).toBe(true);
		expect(isExempt("server/scripts/approve-all.ts")).toBe(true);
		expect(isExempt("scripts/purge-test-pollution.ts")).toBe(true);
		expect(isExempt("server/generated/embedded-changelog.ts")).toBe(true);

		// Production code is never exempt — including files whose names merely resemble the
		// exempt shapes. `services/` is not `server/scripts/`, and a module named after tests
		// still ships.
		expect(isExempt("server/db/connection.ts")).toBe(false);
		expect(isExempt("server/services/search-service.ts")).toBe(false);
		expect(isExempt("server/services/benchmark-service.ts")).toBe(false);
		expect(isExempt("shared/subagent-tool-summary.ts")).toBe(false);
		expect(isExempt("server/lib/scripts-helper.ts")).toBe(false);
		expect(isExempt("server/services/generated-image-service.ts")).toBe(false);
		expect(isExempt("frontend/components/settings/StorageSection.tsx")).toBe(false);
	});

	it("SQLite-only modules are the intentional floor, not the whole ledger", () => {
		// The point of the distinction: most registered files are candidates for the port, a
		// minority is staying. If these two ever coincide, the ledger has stopped tracking
		// migration work and become a list of things nobody plans to change.
		const registered = Object.keys(DIALECT_INVENTORY);
		expect(SQLITE_ONLY_MODULES.size).toBeLessThan(registered.length);
		for (const file of SQLITE_ONLY_MODULES.keys()) {
			expect(registered).toContain(file);
		}

		// The portable archive is permanently SQLite — a file users copy between machines. Its
		// modules must be marked as such rather than read as pending work. A second backend
		// still reads and writes these archives through this same code.
		for (const file of [
			"server/lib/project-db.ts",
			"server/services/project-db-sync.ts",
			"server/services/project-archive/archive-file.ts",
			"server/services/project-archive/archive-writer.ts",
			"server/services/project-archive/export-rows.ts",
		]) {
			expect(SQLITE_ONLY_MODULES.has(file), `${file} writes/reads the portable archive`).toBe(true);
		}

		// The SQLite engine adapters behind `server/db/backend/`. A server-managed engine has no
		// local file to `.recover` and no `VACUUM`; it answers `notApplicable` rather than
		// inheriting a stub, so these are the floor and not migration work.
		expect(SQLITE_ONLY_MODULES.has("server/db/backend/sqlite-lifecycle.ts")).toBe(true);
		expect(SQLITE_ONLY_MODULES.has("server/db/backend/sqlite-maintenance.ts")).toBe(true);
	});

	it("main-database port adapters are pending work, not the SQLite floor", () => {
		// The other half of the distinction above, and the one that decays silently. These two
		// files are SQLite implementations of a port whose whole purpose is that a second backend
		// supplies a DIFFERENT implementation of the same contract. Marking them SQLite-only
		// would read as "the port has nothing left to do", which is exactly backwards — and the
		// mistake is easy to make, because they sit in the same directories as files that ARE the
		// floor (`sqlite-main-store.ts` next to `archive-file.ts`).
		//
		// The test is on the SQLITE_ONLY_MODULES membership rather than on the capability lists,
		// because the capabilities will legitimately change as the port matures while the
		// classification must not.
		for (const file of [
			"server/services/search/sqlite-store.ts",
			"server/services/project-archive/sqlite-main-store.ts",
		]) {
			expect(DIALECT_INVENTORY[file], `${file} must be registered`).toBeDefined();
			expect(
				SQLITE_ONLY_MODULES.has(file),
				`${file} implements a main-database port and is replaced by a second backend, so it is not the SQLite floor`,
			).toBe(false);
		}
	});

	it("the admin VACUUM chain is registered end to end", () => {
		// The reason this is pinned by name: the frontend was previously outside the scan's
		// reach, so the ledger described VACUUM as a backend-only concern while a button in
		// settings called it. A capability whose chain is registered in the middle but not at
		// the ends understates the work and misleads whoever reads the ledger first.
		//
		// `backend/sqlite-maintenance.ts` is now the end that actually runs the statement — the
		// cleanup service asks the maintenance port. Both are listed: dropping either would let
		// the chain be registered at the UI and at the service while the engine call itself went
		// unregistered, which is the same understatement in a new place.
		for (const file of [
			"frontend/components/settings/StorageSection.tsx",
			"frontend/lib/api/misc.ts",
			"server/routes/storage.ts",
			"server/services/database-cleanup-service.ts",
			"server/db/backend/sqlite-maintenance.ts",
		]) {
			expect(DIALECT_INVENTORY[file], `${file} must register the VACUUM chain`).toContain("vacuum");
		}
	});

	it("the `sqlite` handle is exported from exactly one module", () => {
		// `handle` findings are only meaningful while `server/db/index.ts` is the single source
		// of the native connection. A second export site would make the import pattern above
		// miss real usage while still passing.
		const source = readFileSync(join(REPO_ROOT, "server", "db", "index.ts"), "utf8");
		expect(source).toContain("export { sqlite }");

		const otherExporters = SCAN_ROOTS.flatMap((root) =>
			collectSourceFiles(join(REPO_ROOT, root)),
		).filter((absolute) => {
			const posixPath = toPosixRelative(absolute);
			if (posixPath === "server/db/index.ts" || isExempt(posixPath)) return false;
			const code = stripComments(readFileSync(absolute, "utf8"));
			return /\bexport\s*\{[^}]*\bsqlite\b[^}]*\}\s*;/.test(code);
		});
		expect(otherExporters.map(toPosixRelative)).toEqual([]);
	});
});
