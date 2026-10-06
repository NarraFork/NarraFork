/**
 * PostgreSQL full-text search indexing: pg_trgm shadow tables maintained by triggers.
 *
 * WHY SHADOW TABLES AT ALL
 * ------------------------
 * SQLite keeps search in FTS5 external-content virtual tables whose rows are bound to the
 * base table by rowid and maintained by sync triggers (`fts.ts`). PostgreSQL has neither
 * rowid nor FTS5, so this module builds the equivalent out of ordinary parts:
 *
 *   - one SHADOW TABLE per searchable base table, bound to the base row by its primary-key
 *     `id` (the PG stand-in for rowid binding — PG has no rowid), holding exactly the columns
 *     the corresponding FTS5 table indexes;
 *   - a GIN index over each text column using `pg_trgm`'s `gin_trgm_ops`, which accelerates
 *     the `ILIKE '%term%'` substring predicates the store issues — the same retrieval shape
 *     FTS5's trigram tokenizer provides (verified: a trigram `MATCH` is a case-insensitive
 *     substring match for tokens of 3+ characters);
 *   - one trigger function per base table, so the index is a WRITER-BLIND INVARIANT: any
 *     path that inserts, updates or deletes a base row maintains the shadow in the same
 *     transaction, with no cooperation from the caller.
 *
 * WHY PG-SPECIFIC DDL LIVES HERE AND NOT IN `drizzle-postgres/`
 * -------------------------------------------------------------
 * `CREATE EXTENSION`, GIN operator classes and trigger functions have no Drizzle schema
 * spelling, so the migration baseline cannot carry them. Every statement here is idempotent
 * (`IF NOT EXISTS` / `CREATE OR REPLACE`), and this module is written to be invoked from a
 * startup or maintenance path — it never runs implicitly on import. Large deployments should
 * note that `CREATE INDEX` (not `CONCURRENTLY`) takes a write lock on the shadow tables;
 * that is safe on the empty shadows of a fresh install and acceptable in a maintenance
 * window, but a migration-to-concurrent build is a deliberate follow-up decision.
 *
 * TRIGGER SEMANTICS THAT MUST NOT DRIFT (mirrors of `fts.ts`)
 * -----------------------------------------------------------
 *   - narrators: only rows with a non-null title are indexed. The insert/delete triggers
 *     fire `WHEN (title IS NOT NULL)`; the update trigger fires `AFTER UPDATE OF title` when
 *     either side is non-null, deletes the old shadow row, and re-inserts with
 *     `ON CONFLICT DO NOTHING` — the PG spelling of SQLite's `INSERT OR IGNORE`.
 *   - knowledge_drafts: the shadow `title` is DE-NORMALIZED from the parent entry
 *     (`COALESCE(entry.title, draft.title, '')`), because drafts edit content, not titles.
 *     A separate trigger on `knowledge_entries` (`AFTER UPDATE OF title`) refreshes the
 *     shadow title of every draft linked to the renamed entry.
 *   - knowledge_drafts binds the shadow row to `knowledge_drafts.id` directly (SQLite binds
 *     the FTS rowid to `knowledge_drafts.rowid` for the same O(log n) maintenance).
 *
 * DRIFT DETECTION WITHOUT THE SQLITE MACHINERY
 * --------------------------------------------
 * SQLite detects a dirty shutdown through `application_id` and probes FTS corruption with
 * `integrity-check`. Neither concept exists on a server-managed engine — PG's own WAL
 * guarantees committed shadow writes survive, so crash recovery is the server's job, not
 * this module's. What CAN drift here is the catalog (a migration or operator drops a
 * trigger) and the content (rows written while a trigger was missing). Detection is:
 *
 *   1. CATALOG PROBE — every expected extension, shadow table, GIN index, trigger function
 *      and trigger is named; a missing name is a durable retry signal (it persists until
 *      repaired, unlike a crash flag that clears itself).
 *   2. CONTENT RECONCILIATION — per table: base rows that belong in the index vs shadow
 *      rows present, plus missing / stale / content-mismatched counts. These are aggregate
 *      scans and belong in a startup or maintenance window, never on a request path.
 *
 * Repair is `ensurePgFts` (reinstall the catalog) plus batched backfill/purge so a large
 * base table is healed in bounded transactions rather than one long lock hold.
 */

import { logger } from "../lib/logger";

/**
 * The executor the module needs from a PostgreSQL client.
 *
 * Structural rather than `import { SQL } from "bun"` so the module is testable against any
 * driver-shaped object, and so this file carries no driver import of its own. Bun's `SQL`
 * instance satisfies this directly (`sql.unsafe(query, params)`).
 */
export interface PgExecutor {
	unsafe(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/** One searchable base table and the shadow that mirrors it. */
interface ShadowSpec {
	readonly base: string;
	readonly shadow: string;
	/** Shadow columns after `id`, in SELECT order. */
	readonly columns: readonly string[];
	/** Predicate over base alias `b`: which base rows belong in the shadow. */
	readonly indexable: string;
	/**
	 * SELECT-list expressions over base alias `b` producing {@link columns}, in order.
	 * Identical to the column names except where the shadow de-normalizes (drafts title).
	 */
	readonly select: readonly string[];
	/** Predicate over base alias `b` and shadow alias `f`: shadow content disagrees. */
	readonly mismatch: string;
}

const DRAFT_TITLE_EXPR =
	"COALESCE((SELECT e.title FROM knowledge_entries e WHERE e.id = b.entry_id), b.title, '')";

const SHADOW_SPECS: readonly ShadowSpec[] = [
	{
		base: "chapters",
		shadow: "search_chapters",
		columns: ["title", "description"],
		indexable: "TRUE",
		select: ["b.title", "b.description"],
		mismatch: "f.title IS DISTINCT FROM b.title OR f.description IS DISTINCT FROM b.description",
	},
	{
		base: "narrator_messages",
		shadow: "search_narrator_messages",
		columns: ["content_text"],
		indexable: "TRUE",
		select: ["b.content_text"],
		mismatch: "f.content_text IS DISTINCT FROM b.content_text",
	},
	{
		base: "narrators",
		shadow: "search_narrators",
		columns: ["title"],
		// The narrators index is title-only and null titles are excluded — a narrator
		// without a title must not become searchable under an empty string.
		indexable: "b.title IS NOT NULL",
		select: ["b.title"],
		mismatch: "f.title IS DISTINCT FROM b.title",
	},
	{
		base: "knowledge_entries",
		shadow: "search_knowledge_entries",
		columns: ["title", "current_content", "current_keywords"],
		indexable: "TRUE",
		select: ["b.title", "b.current_content", "b.current_keywords"],
		mismatch:
			"f.title IS DISTINCT FROM b.title OR f.current_content IS DISTINCT FROM b.current_content OR f.current_keywords IS DISTINCT FROM b.current_keywords",
	},
	{
		base: "knowledge_drafts",
		shadow: "search_knowledge_drafts",
		columns: ["title", "content"],
		indexable: "TRUE",
		// The title is the PARENT ENTRY's title (drafts never edit it), falling back to the
		// draft's own title for standalone personal entries.
		select: [DRAFT_TITLE_EXPR, "b.content"],
		mismatch: `f.title IS DISTINCT FROM ${DRAFT_TITLE_EXPR} OR f.content IS DISTINCT FROM b.content`,
	},
];

/** Every named object the catalog probe checks. A missing name is a durable retry signal. */
const EXPECTED = {
	extensions: ["pg_trgm"],
	tables: SHADOW_SPECS.map((s) => s.shadow),
	indexes: SHADOW_SPECS.flatMap((s) => s.columns.map((c) => `idx_${s.shadow}_${c}`)),
	functions: [
		"nf_search_chapters_sync",
		"nf_search_narrator_messages_sync",
		"nf_search_narrators_sync",
		"nf_search_knowledge_entries_sync",
		"nf_search_knowledge_drafts_sync",
		"nf_search_drafts_entry_title_sync",
	],
	triggers: [
		"chapters_fts_insert",
		"chapters_fts_update",
		"chapters_fts_delete",
		"narrator_messages_fts_insert",
		"narrator_messages_fts_update",
		"narrator_messages_fts_delete",
		"narrators_fts_insert",
		"narrators_fts_update",
		"narrators_fts_delete",
		"knowledge_entries_fts_insert",
		"knowledge_entries_fts_update",
		"knowledge_entries_fts_delete",
		"knowledge_drafts_fts_insert",
		"knowledge_drafts_fts_update",
		"knowledge_drafts_fts_delete",
		"knowledge_drafts_fts_entry_title",
	],
} as const;

/** Objects the catalog probe reports as missing. */
export interface PgFtsDriftReport {
	readonly missingExtensions: string[];
	readonly missingTables: string[];
	readonly missingIndexes: string[];
	readonly missingFunctions: string[];
	readonly missingTriggers: string[];
	/** Per-table content reconciliation, empty when the catalog is too broken to count. */
	readonly reconciliation: PgFtsReconciliation[];
	/** True when anything above is non-empty or any table disagrees with its shadow. */
	readonly drifted: boolean;
}

export interface PgFtsReconciliation {
	readonly base: string;
	readonly shadow: string;
	/** Base rows that belong in the index (after the table's indexable predicate). */
	readonly baseRows: number;
	readonly shadowRows: number;
	/** Indexable base rows with no shadow row. */
	readonly missingRows: number;
	/** Shadow rows whose base row is gone (or no longer indexable). */
	readonly staleRows: number;
	/** Shadow rows whose content disagrees with the base row. */
	readonly mismatchedRows: number;
}

export interface PgFtsRepairResult {
	/** Rows inserted or refreshed to match the base table, per shadow table. */
	readonly upserted: Record<string, number>;
	/** Shadow rows deleted because their base row vanished or stopped being indexable. */
	readonly purged: Record<string, number>;
	/** Number of bounded write batches completed by this invocation. */
	readonly batches: number;
	/** True when the post-repair probe found no remaining content or catalog drift. */
	readonly complete: boolean;
	/** The drift probe run AFTER repair; `drifted: false` is the repair's proof. */
	readonly report: PgFtsDriftReport;
}

export interface PgFtsRepairOptions {
	/** Rows per bounded INSERT/DELETE statement. */
	batchSize?: number;
	/** Maximum write batches in this invocation; a later startup can resume safely. */
	maxBatches?: number;
	/** Wall-clock budget for this invocation; 0 means do not write, only probe. */
	timeBudgetMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// DDL
// ─────────────────────────────────────────────────────────────────────────────

function shadowTableDdl(spec: ShadowSpec): string {
	const cols = spec.columns.map((c) => `"${c}" text`).join(", ");
	return `CREATE TABLE IF NOT EXISTS "${spec.shadow}" (id text PRIMARY KEY, ${cols})`;
}

function ginIndexDdl(spec: ShadowSpec): string[] {
	return spec.columns.map(
		(c) =>
			`CREATE INDEX IF NOT EXISTS "idx_${spec.shadow}_${c}" ON "${spec.shadow}" USING gin ("${c}" gin_trgm_ops)`,
	);
}

/**
 * The sync function shared by every shadow whose columns mirror the base row verbatim.
 *
 * Update is delete-then-insert, matching SQLite's FTS trigger pair exactly: after the
 * delete the insert cannot conflict, and the end state is the NEW row's values whether or
 * not a shadow row existed before (a missing shadow row self-heals on the next update).
 */
function mirrorFunctionDdl(spec: ShadowSpec): string {
	const cols = spec.columns.map((c) => `"${c}"`).join(", ");
	const news = spec.columns.map((c) => `NEW."${c}"`).join(", ");
	const indexable = spec.indexable.replaceAll("b.", "NEW.");
	return `
CREATE OR REPLACE FUNCTION "nf_${spec.shadow}_sync"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
	IF TG_OP = 'DELETE' THEN
		DELETE FROM "${spec.shadow}" WHERE id = OLD.id;
		RETURN OLD;
	END IF;
	IF TG_OP = 'UPDATE' THEN
		DELETE FROM "${spec.shadow}" WHERE id = OLD.id;
	END IF;
	IF ${indexable} THEN
		INSERT INTO "${spec.shadow}" (id, ${cols}) VALUES (NEW.id, ${news});
	END IF;
	RETURN NEW;
END
$fn$`;
}

/**
 * The narrators sync function: title-only, null-title rows excluded, and the update path
 * re-inserts with `ON CONFLICT DO NOTHING` — the exact spelling of SQLite's
 * `INSERT OR IGNORE` in `narrators_fts_update`.
 */
const NARRATORS_FUNCTION_DDL = `
CREATE OR REPLACE FUNCTION "nf_search_narrators_sync"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD.title IS NOT NULL THEN
			DELETE FROM "search_narrators" WHERE id = OLD.id;
		END IF;
		RETURN OLD;
	END IF;
	IF TG_OP = 'UPDATE' AND OLD.title IS NOT NULL THEN
		DELETE FROM "search_narrators" WHERE id = OLD.id;
	END IF;
	IF NEW.title IS NOT NULL THEN
		INSERT INTO "search_narrators" (id, title) VALUES (NEW.id, NEW.title)
		ON CONFLICT (id) DO NOTHING;
	END IF;
	RETURN NEW;
END
$fn$`;

/** Drafts: title de-normalized from the parent entry at write time. */
const DRAFTS_FUNCTION_DDL = `
CREATE OR REPLACE FUNCTION "nf_search_knowledge_drafts_sync"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
	IF TG_OP = 'DELETE' THEN
		DELETE FROM "search_knowledge_drafts" WHERE id = OLD.id;
		RETURN OLD;
	END IF;
	IF TG_OP = 'UPDATE' THEN
		DELETE FROM "search_knowledge_drafts" WHERE id = OLD.id;
	END IF;
	INSERT INTO "search_knowledge_drafts" (id, title, content)
	VALUES (
		NEW.id,
		COALESCE((SELECT e.title FROM knowledge_entries e WHERE e.id = NEW.entry_id), NEW.title, ''),
		NEW.content
	);
	RETURN NEW;
END
$fn$`;

/** An entry rename cascades to the de-normalized shadow title of all its drafts. */
const ENTRY_TITLE_FUNCTION_DDL = `
CREATE OR REPLACE FUNCTION "nf_search_drafts_entry_title_sync"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
	UPDATE "search_knowledge_drafts" f
	SET title = NEW.title
	FROM knowledge_drafts d
	WHERE f.id = d.id AND d.entry_id = NEW.id;
	RETURN NEW;
END
$fn$`;

/** Trigger attachment statements, one per expected trigger name. */
function triggerDdl(): string[] {
	const mirror = (spec: ShadowSpec, when?: { update?: string }) => [
		`CREATE OR REPLACE TRIGGER "${spec.base}_fts_insert" AFTER INSERT ON "${spec.base}"
			FOR EACH ROW EXECUTE FUNCTION "nf_${spec.shadow}_sync"()`,
		`CREATE OR REPLACE TRIGGER "${spec.base}_fts_update" AFTER UPDATE ON "${spec.base}"
			FOR EACH ROW ${when?.update ?? ""} EXECUTE FUNCTION "nf_${spec.shadow}_sync"()`,
		`CREATE OR REPLACE TRIGGER "${spec.base}_fts_delete" AFTER DELETE ON "${spec.base}"
			FOR EACH ROW EXECUTE FUNCTION "nf_${spec.shadow}_sync"()`,
	];
	const narrators = SHADOW_SPECS[2];
	if (narrators.base !== "narrators") throw new Error("shadow spec order changed");
	return [
		...mirror(SHADOW_SPECS[0]),
		...mirror(SHADOW_SPECS[1]),
		// WHEN clauses mirror SQLite's firing conditions exactly: they keep unrelated-column
		// updates from touching the index at all (the UPDATE OF title clause), and keep
		// null-title transitions out of the shadow.
		`CREATE OR REPLACE TRIGGER "narrators_fts_insert" AFTER INSERT ON "narrators"
			FOR EACH ROW WHEN (NEW.title IS NOT NULL) EXECUTE FUNCTION "nf_search_narrators_sync"()`,
		`CREATE OR REPLACE TRIGGER "narrators_fts_update" AFTER UPDATE OF title ON "narrators"
			FOR EACH ROW WHEN (OLD.title IS NOT NULL OR NEW.title IS NOT NULL)
			EXECUTE FUNCTION "nf_search_narrators_sync"()`,
		`CREATE OR REPLACE TRIGGER "narrators_fts_delete" AFTER DELETE ON "narrators"
			FOR EACH ROW WHEN (OLD.title IS NOT NULL) EXECUTE FUNCTION "nf_search_narrators_sync"()`,
		...mirror(SHADOW_SPECS[3]),
		...mirror(SHADOW_SPECS[4]),
		`CREATE OR REPLACE TRIGGER "knowledge_drafts_fts_entry_title" AFTER UPDATE OF title ON "knowledge_entries"
			FOR EACH ROW EXECUTE FUNCTION "nf_search_drafts_entry_title_sync"()`,
	];
}

/**
 * Install (or reinstall) the full search catalog: extension, shadow tables, GIN indexes,
 * trigger functions, triggers. Idempotent; safe to run on every startup.
 *
 * Requires a role that can `CREATE EXTENSION pg_trgm` (superuser or database owner on
 * PostgreSQL 13+). Index builds are plain `CREATE INDEX`: instant on the empty shadow
 * tables of a fresh install, but a write lock if ever run over populated shadows — a
 * CONCURRENTLY variant for large existing deployments is a deliberate follow-up.
 */
export async function ensurePgFts(sql: PgExecutor): Promise<void> {
	await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm");
	for (const spec of SHADOW_SPECS) {
		await sql.unsafe(shadowTableDdl(spec));
	}
	for (const spec of SHADOW_SPECS) {
		for (const ddl of ginIndexDdl(spec)) await sql.unsafe(ddl);
	}
	await sql.unsafe(mirrorFunctionDdl(SHADOW_SPECS[0]));
	await sql.unsafe(mirrorFunctionDdl(SHADOW_SPECS[1]));
	await sql.unsafe(NARRATORS_FUNCTION_DDL);
	await sql.unsafe(mirrorFunctionDdl(SHADOW_SPECS[3]));
	await sql.unsafe(DRAFTS_FUNCTION_DDL);
	await sql.unsafe(ENTRY_TITLE_FUNCTION_DDL);
	for (const ddl of triggerDdl()) await sql.unsafe(ddl);
}

// ─────────────────────────────────────────────────────────────────────────────
// Drift probe
// ─────────────────────────────────────────────────────────────────────────────

async function presentNames(
	sql: PgExecutor,
	query: string,
	names: readonly string[],
): Promise<Set<string>> {
	if (names.length === 0) return new Set();
	// A comma-joined string rather than an array parameter: drivers disagree on array
	// binding, and the probe must not depend on one. Names come from EXPECTED (quoted
	// identifier characters only), never from user input.
	const rows = await sql.unsafe(query, [names.join(",")]);
	return new Set(rows.map((r) => String(r.name)));
}

function missing(expected: readonly string[], present: Set<string>): string[] {
	return expected.filter((name) => !present.has(name));
}

async function reconcileTable(sql: PgExecutor, spec: ShadowSpec): Promise<PgFtsReconciliation> {
	const row = (
		await sql.unsafe(
			`SELECT
				(SELECT count(*)::int FROM "${spec.base}" b WHERE ${spec.indexable}) AS base_rows,
				(SELECT count(*)::int FROM "${spec.shadow}") AS shadow_rows,
				(SELECT count(*)::int FROM "${spec.base}" b WHERE ${spec.indexable}
					AND NOT EXISTS (SELECT 1 FROM "${spec.shadow}" f WHERE f.id = b.id)) AS missing_rows,
				(SELECT count(*)::int FROM "${spec.shadow}" f
					WHERE NOT EXISTS (SELECT 1 FROM "${spec.base}" b WHERE b.id = f.id AND ${spec.indexable}))
					AS stale_rows,
				(SELECT count(*)::int FROM "${spec.base}" b JOIN "${spec.shadow}" f ON f.id = b.id
					WHERE ${spec.indexable} AND (${spec.mismatch})) AS mismatched_rows`,
		)
	)[0];
	return {
		base: spec.base,
		shadow: spec.shadow,
		baseRows: Number(row?.base_rows ?? 0),
		shadowRows: Number(row?.shadow_rows ?? 0),
		missingRows: Number(row?.missing_rows ?? 0),
		staleRows: Number(row?.stale_rows ?? 0),
		mismatchedRows: Number(row?.mismatched_rows ?? 0),
	};
}

/**
 * Detect catalog and content drift.
 *
 * The catalog probe names every expected object; a missing trigger or function is a durable
 * retry signal — it stays missing until repaired, so a caller can poll this after a failed
 * repair without any crash-flag machinery. Content reconciliation runs five aggregate
 * scans (one per table) and belongs in a startup or maintenance window, not a request path.
 */
export async function probePgFtsDrift(sql: PgExecutor): Promise<PgFtsDriftReport> {
	const schema = "current_schema()";
	const [extensions, tables, indexes, functions, triggers] = await Promise.all([
		presentNames(
			sql,
			"SELECT extname AS name FROM pg_extension WHERE extname = ANY(string_to_array($1, ','))",
			EXPECTED.extensions,
		),
		presentNames(
			sql,
			`SELECT tablename AS name FROM pg_tables WHERE schemaname = ${schema} AND tablename = ANY(string_to_array($1, ','))`,
			EXPECTED.tables,
		),
		presentNames(
			sql,
			`SELECT indexname AS name FROM pg_indexes WHERE schemaname = ${schema} AND indexname = ANY(string_to_array($1, ','))`,
			EXPECTED.indexes,
		),
		presentNames(
			sql,
			`SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
				WHERE n.nspname = ${schema} AND p.proname = ANY(string_to_array($1, ','))`,
			EXPECTED.functions,
		),
		presentNames(
			sql,
			`SELECT t.tgname AS name FROM pg_trigger t
				JOIN pg_class c ON c.oid = t.tgrelid
				JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE NOT t.tgisinternal AND n.nspname = ${schema} AND t.tgname = ANY(string_to_array($1, ','))`,
			EXPECTED.triggers,
		),
	]);
	const report = {
		missingExtensions: missing(EXPECTED.extensions, extensions),
		missingTables: missing(EXPECTED.tables, tables),
		missingIndexes: missing(EXPECTED.indexes, indexes),
		missingFunctions: missing(EXPECTED.functions, functions),
		missingTriggers: missing(EXPECTED.triggers, triggers),
		reconciliation: [] as PgFtsReconciliation[],
		drifted: false,
	};
	// Content reconciliation only means something when both sides of the comparison exist.
	if (report.missingTables.length === 0) {
		for (const spec of SHADOW_SPECS) {
			report.reconciliation.push(await reconcileTable(sql, spec));
		}
	}
	report.drifted =
		report.missingExtensions.length > 0 ||
		report.missingTables.length > 0 ||
		report.missingIndexes.length > 0 ||
		report.missingFunctions.length > 0 ||
		report.missingTriggers.length > 0 ||
		report.reconciliation.some((r) => r.missingRows > 0 || r.staleRows > 0 || r.mismatchedRows > 0);
	return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// Repair
// ─────────────────────────────────────────────────────────────────────────────

/** Rows healed per statement batch: bounded locks, resumable progress. */
const DEFAULT_REPAIR_BATCH = 500;

async function countQuery(sql: PgExecutor, query: string): Promise<number> {
	const row = (await sql.unsafe(query))[0];
	return Number(row?.c ?? 0);
}

/**
 * Reinstall the catalog, then heal content in batches.
 *
 * Backfill is an upsert keyed by the shadow's `id` primary key, so it fixes both missing
 * and content-mismatched rows; purge removes shadow rows whose base row is gone or stopped
 * being indexable (a narrator whose title was nulled while the trigger was missing). Each
 * batch is its own statement, so a large base table is healed in bounded transactions —
 * the caller can run this in a background job and re-probe between invocations.
 */
export async function repairPgFts(
	sql: PgExecutor,
	options: PgFtsRepairOptions = {},
): Promise<PgFtsRepairResult> {
	const batchSize = Math.max(1, Math.trunc(options.batchSize ?? DEFAULT_REPAIR_BATCH));
	const maxBatches = Math.max(0, Math.trunc(options.maxBatches ?? Number.POSITIVE_INFINITY));
	const deadline =
		options.timeBudgetMs === undefined
			? Number.POSITIVE_INFINITY
			: performance.now() + Math.max(0, options.timeBudgetMs);
	let batches = 0;
	const canWrite = () => batches < maxBatches && performance.now() < deadline;
	await ensurePgFts(sql);
	const upserted: Record<string, number> = {};
	const purged: Record<string, number> = {};
	for (const spec of SHADOW_SPECS) {
		const cols = spec.columns.map((c) => `"${c}"`).join(", ");
		const updates = spec.columns.map((c) => `"${c}" = EXCLUDED."${c}"`).join(", ");
		// Upsert base rows that are missing from the shadow or disagree with it.
		for (;;) {
			if (!canWrite()) break;
			const remaining = await countQuery(
				sql,
				`SELECT count(*)::int AS c FROM "${spec.base}" b
					WHERE ${spec.indexable} AND (
						NOT EXISTS (SELECT 1 FROM "${spec.shadow}" f WHERE f.id = b.id)
						OR EXISTS (SELECT 1 FROM "${spec.shadow}" f WHERE f.id = b.id AND (${spec.mismatch}))
					)`,
			);
			if (remaining === 0) break;
			await sql.unsafe(
				`INSERT INTO "${spec.shadow}" (id, ${cols})
					SELECT s.id, ${spec.columns.map((_, i) => `s.c${i}`).join(", ")} FROM (
						SELECT b.id, ${spec.select.map((e, i) => `${e} AS c${i}`).join(", ")}
						FROM "${spec.base}" b
						WHERE ${spec.indexable} AND (
							NOT EXISTS (SELECT 1 FROM "${spec.shadow}" f WHERE f.id = b.id)
							OR EXISTS (SELECT 1 FROM "${spec.shadow}" f WHERE f.id = b.id AND (${spec.mismatch}))
						)
						ORDER BY b.id LIMIT $1
					) s
				ON CONFLICT (id) DO UPDATE SET ${updates}`,
				[batchSize],
			);
			batches++;
			upserted[spec.shadow] = (upserted[spec.shadow] ?? 0) + Math.min(remaining, batchSize);
		}
		// Purge shadow rows whose base row is gone or no longer belongs in the index.
		for (;;) {
			if (!canWrite()) break;
			const remaining = await countQuery(
				sql,
				`SELECT count(*)::int AS c FROM "${spec.shadow}" f
					WHERE NOT EXISTS (SELECT 1 FROM "${spec.base}" b WHERE b.id = f.id AND ${spec.indexable})`,
			);
			if (remaining === 0) break;
			await sql.unsafe(
				`DELETE FROM "${spec.shadow}" WHERE id IN (
					SELECT f.id FROM "${spec.shadow}" f
					WHERE NOT EXISTS (SELECT 1 FROM "${spec.base}" b WHERE b.id = f.id AND ${spec.indexable})
					LIMIT $1
				)`,
				[batchSize],
			);
			batches++;
			purged[spec.shadow] = (purged[spec.shadow] ?? 0) + Math.min(remaining, batchSize);
		}
	}
	const report = await probePgFtsDrift(sql);
	if (report.drifted) {
		logger.warn("PG FTS repair completed but drift remains", {
			missingTriggers: report.missingTriggers,
			reconciliation: report.reconciliation,
		});
	}
	return { upserted, purged, batches, complete: !report.drifted, report };
}
