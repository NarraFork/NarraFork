/**
 * The PostgreSQL/SQLite comparison matrix, plus the psql transport that carries it.
 *
 * Extracted from the parity test so the same matrix can be driven against a repaired
 * migration while `drizzle-postgres/0000_*.sql` cannot be applied to PostgreSQL at all
 * (see `pg-project-read-parity.test.ts`). The strict test always uses the migration
 * exactly as committed; nothing here rewrites it.
 *
 * Adapters are passed in rather than constructed here because the SQLite adapter has to
 * be imported after `server/db` is mocked, which only the test module can arrange.
 */

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import type { ProjectPrincipal } from "../../../../server/services/project-acl";
import { type CommandResult, HarnessCommandError } from "../../../db/pg-test-harness";
import {
	BULK_PROJECT_COUNT,
	bulkProjectIds,
	CASE_MIX_PROJECT_IDS,
	CASE_MIX_PROJECT_IDS_BYTE_ORDER,
	caseInsensitiveOrderDiffers,
	GHOST_USER,
	PROJECT,
	USER,
} from "./read-fixtures";

/**
 * Rows per PostgreSQL page for the cases that DO take a paging parameter, kept well under
 * the harness' 16KiB output cap (`OUTPUT_LIMIT`), which aborts a command rather than
 * truncating it. Paging is a property of the matrix, not of the adapters, so this changes
 * how the comparison is driven and not what it demands. Calls with no paging parameter
 * cannot use this and are relayed instead (see `chunkedProxyDb`).
 */
export const PG_PAGE_SIZE = 25;

/**
 * Cases still skipped on the PostgreSQL side. Empty, and pinned empty by the caller.
 *
 * The 200-row clamp of `listProjects(bulk)` used to be skipped because its result set cannot
 * cross `psql` in one command: 200 full project rows are several times the harness' 16KiB
 * `OUTPUT_LIMIT`, which aborts a command rather than truncating it.
 *
 * It is now compared for real via {@link chunkedProxyDb}, which splits the RESPONSE
 * across several `psql` reads without touching the harness and without changing the adapter
 * call. Each adapter still issues its own single query, so what is asserted is the
 * real oversized result — the size limit was a property of the transport, never of the
 * behaviour under test, and paging the adapter instead would have tested a different call.
 *
 * Kept as an exported (empty) list so the parity test keeps pinning the skip set: a case
 * that starts skipping itself again must fail rather than quietly stop being compared.
 */
export const OVERSIZED_CASES = [] as const;

/**
 * Characters of the JSON document to fetch per relay chunk.
 *
 * Counted in CHARACTERS because `substr` slices `text` by character, while the harness caps
 * BYTES. The two differ for non-ASCII, so this is set to a quarter of the 16KiB cap: even if
 * every character in a chunk were 4-byte UTF-8, one chunk still cannot trip the limit. The
 * fixtures are ASCII today, and a chunk sized at the cap would start failing the moment a
 * fixture gained a CJK title.
 */
const RELAY_CHUNK_CHARS = 4_000;

/** The adapter surface this matrix exercises, satisfied by both implementations. */
export interface ReadAdapterLike {
	listProjects(
		principal: ProjectPrincipal,
		page?: { limit?: number; cursor?: string },
		status?: string,
	): Promise<{ rows: unknown[]; nextCursor: string | null }>;
	getProject(id: string, principal: ProjectPrincipal): Promise<unknown | null>;
	anyProjectExists(): Promise<boolean>;
}

export function principal(userId: string, isAdmin = false): ProjectPrincipal {
	return { userId, isAdmin };
}

/**
 * The migration ledger Drizzle's PostgreSQL migrator creates before it runs anything (same
 * schema, table and columns). Migrations may read it: 0048 replays an upstream migration only
 * when its ledger fingerprint is absent. Applying the journal's SQL by hand skips the migrator,
 * so the ledger is created here, empty: a fresh database has applied nothing yet.
 */
const MIGRATION_LEDGER_SQL = `CREATE SCHEMA IF NOT EXISTS "drizzle";
CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
	id SERIAL PRIMARY KEY,
	hash text NOT NULL,
	created_at bigint
);
`;

/**
 * Every migration in the PostgreSQL journal, verbatim, one entry per migration. The first entry
 * also creates the migrator's (empty) ledger first, so callers that apply `[0]` as the baseline
 * and the rest as upgrades keep working.
 */
export async function migrationSql(): Promise<string[]> {
	const journal = JSON.parse(await readFile("drizzle-postgres/meta/_journal.json", "utf8")) as {
		entries: Array<{ tag: string }>;
	};
	if (journal.entries.length === 0) throw new Error("PostgreSQL migration journal is empty");
	const sqls = await Promise.all(
		journal.entries.map((entry) => readFile(`drizzle-postgres/${entry.tag}.sql`, "utf8")),
	);
	sqls[0] = `${MIGRATION_LEDGER_SQL}${sqls[0]}`;
	return sqls;
}

/** SQL literal for a fixture value. Only strings, numbers, booleans and null occur. */
function literal(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return `'${text.replace(/'/g, "''")}'`;
}

/**
 * A Drizzle handle that runs statements through the harness' `psql` exec.
 *
 * `psql` has no bind protocol here, so `$n` placeholders are inlined with the same
 * escaping used for fixtures. Queries are wrapped in `json_agg` so the transport stays one
 * line of text whatever the column types are; `Object.values` then restores the positional
 * order `pg-proxy` maps rows by. Writes are executed verbatim — wrapping an INSERT in a
 * SELECT is a syntax error.
 */
/** Inline `$n` placeholders, which `psql` has no bind protocol for here. */
function inlineParams(query: string, params: unknown[]): string {
	let inlined = "";
	for (let i = 0; i < query.length; i += 1) {
		if (query[i] === "$" && /[0-9]/.test(query[i + 1] ?? "")) {
			let digits = "";
			while (/[0-9]/.test(query[i + 1] ?? "")) {
				digits += query[i + 1];
				i += 1;
			}
			inlined += literal(params[Number(digits) - 1]);
			continue;
		}
		inlined += query[i];
	}
	return inlined;
}

export function proxyDb(exec: (sql: string) => Promise<CommandResult>): BunSQLDatabase {
	return drizzleProxy(async (query, params) => {
		const bare = inlineParams(query, params).replace(/;\s*$/, "");
		const isQuery = /^\s*(select|with)\b/i.test(bare);
		const statement = isQuery
			? `SELECT coalesce(json_agg(r), '[]'::json)::text FROM (${bare}) r`
			: bare;
		const result = await exec(statement);
		if (result.code !== 0) {
			throw new Error(
				`psql failed (${result.code}): ${result.stderr.slice(0, 400)} :: ${statement.slice(0, 300)}`,
			);
		}
		if (!isQuery) return { rows: [] };
		const text = result.stdout.trim();
		if (text.length === 0) return { rows: [] };
		const objects = JSON.parse(text) as Array<Record<string, unknown>>;
		return { rows: objects.map((row) => Object.values(row)) };
	}) as unknown as BunSQLDatabase;
}

/**
 * The same handle, but able to relay a response larger than the harness' output cap.
 *
 * The harness aborts any single command whose combined output exceeds `OUTPUT_LIMIT`
 * (16KiB), and the clamped 200-row `listProjects` page is the call under test, so asking for
 * a smaller page would test a different call. The result is therefore MATERIALIZED
 * server-side into a table and read back in `RELAY_CHUNK_CHARS` slices, each its own `psql`
 * invocation, then concatenated and parsed once.
 *
 * What this does and does not change:
 *   - the SQL the adapter issued is executed verbatim, once. Only the delivery of
 *     the bytes is split, so the assertion is still about the real oversized result;
 *   - `substr` slices the `::text` of a single JSON document by character offset. Chunk
 *     boundaries may land mid-token, which is why chunks are reassembled BEFORE parsing —
 *     each slice is not valid JSON on its own;
 *   - `-Atq` output is unaligned with no header, and a trailing newline per read is the only
 *     framing added, so exactly one is stripped per chunk rather than trimming (a JSON
 *     document cannot begin or end with meaningful whitespace here, but its contents can).
 *
 * Small responses take the direct path: paying three round trips for a 40-byte count would
 * slow every case in the matrix to buy nothing.
 *
 * `stats.relayed` counts the responses that actually needed relaying. The caller asserts it
 * is non-zero, because every oversized case would also "pass" if the fixtures shrank below
 * the cap — at which point the suite would no longer be testing an oversized result at all.
 */
export type RelayStats = { relayed: number };

export function chunkedProxyDb(
	exec: (sql: string) => Promise<CommandResult>,
	stats: RelayStats = { relayed: 0 },
): BunSQLDatabase {
	return drizzleProxy(async (query, params) => {
		const bare = inlineParams(query, params).replace(/;\s*$/, "");
		const isQuery = /^\s*(select|with)\b/i.test(bare);
		const wrapped = `SELECT coalesce(json_agg(r), '[]'::json)::text FROM (${bare}) r`;
		const statement = isQuery ? wrapped : bare;
		const fail = (result: CommandResult, what: string): never => {
			throw new Error(
				`psql ${what} failed (${result.code}): ${result.stderr.slice(0, 400)} :: ${statement.slice(0, 300)}`,
			);
		};

		let text: string;
		try {
			const direct = await exec(statement);
			if (direct.code !== 0) fail(direct, "query");
			if (!isQuery) return { rows: [] };
			text = direct.stdout.trim();
		} catch (error) {
			// Only an output-limit abort is retried through the relay. A timeout or spawn
			// failure means the server never produced the answer, and re-asking would report
			// an unrelated second attempt instead of the real fault.
			if (!(error instanceof HarnessCommandError && error.kind === "output-limit")) throw error;
			stats.relayed += 1;
			// Deliberately NOT a TEMP table: every `exec` is its own `psql` process, so a
			// session-scoped table would be gone before the first chunk is read. An unlogged
			// table with a random name is used instead and dropped once relayed; the container
			// is per-run and discarded, so nothing outlives the test either way.
			const table = `nf_relay_${randomBytes(6).toString("hex")}`;
			// Aliased to `t`: the wrapped query's output column would otherwise be named after
			// the outermost expression (`coalesce`), which the reads below do not know.
			const materialized = await exec(
				`CREATE UNLOGGED TABLE ${table} AS SELECT (${wrapped}) AS t;`,
			);
			if (materialized.code !== 0) fail(materialized, "materialize");
			// Reads against the materialized table are retried once on a transient harness
			// failure. Relaying one response costs ~20 `podman exec` round trips, and a single
			// slow one (the harness kills a command at 30s) previously surfaced as a `threw:`
			// marker on every oversized case — i.e. a parity difference that did not exist.
			// Retrying is sound here precisely because the data is already frozen in the table:
			// a re-read asks the same question of the same immutable rows. The ORIGINAL query
			// is never retried, since re-running it could hide a genuine adapter fault.
			const readFrozen = async (sql: string, what: string): Promise<string> => {
				let last: unknown;
				for (let attempt = 0; attempt < 2; attempt += 1) {
					try {
						const result = await exec(sql);
						if (result.code === 0) return result.stdout;
						last = new Error(
							`psql ${what} failed (${result.code}): ${result.stderr.slice(0, 200)}`,
						);
					} catch (readError) {
						// An output-limit abort is a sizing mistake in this relay, not a hiccup:
						// retrying an identical read would abort identically.
						if (readError instanceof HarnessCommandError && readError.kind === "output-limit") {
							throw readError;
						}
						last = readError;
					}
				}
				throw last instanceof Error ? last : new Error(`psql ${what} failed`);
			};

			const sized = await readFrozen(`SELECT length(t) FROM ${table};`, "size");
			const total = Number(sized.trim());
			if (!Number.isInteger(total) || total < 0) {
				throw new Error(`relay length unreadable: ${sized.slice(0, 120)}`);
			}
			let assembled = "";
			for (let offset = 1; offset <= total; offset += RELAY_CHUNK_CHARS) {
				const chunk = await readFrozen(
					`SELECT substr(t, ${offset}, ${RELAY_CHUNK_CHARS}) FROM ${table};`,
					"chunk",
				);
				assembled += chunk.replace(/\n$/, "");
			}
			const dropped = await exec(`DROP TABLE IF EXISTS ${table};`);
			if (dropped.code !== 0) fail(dropped, "drop");
			// Compared in CODE POINTS, matching PostgreSQL's `length()`. `String.length` counts
			// UTF-16 code units, so an emoji or other astral character in a fixture would make a
			// complete relay look short. Silently short output would parse as a truncated array
			// and be reported as a parity difference that does not exist.
			const assembledLength = [...assembled].length;
			if (assembledLength !== total) {
				throw new Error(`relay reassembly short: got ${assembledLength} of ${total}`);
			}
			text = assembled;
		}

		if (text.length === 0) return { rows: [] };
		const objects = JSON.parse(text) as Array<Record<string, unknown>>;
		return { rows: objects.map((row) => Object.values(row)) };
	}) as unknown as BunSQLDatabase;
}

type Comparison = { name: string; sqlite: unknown; postgres: unknown; nonEmpty?: boolean };

/**
 * Run one side of a comparison, turning a throw into a comparable marker.
 *
 * An adapter that throws IS a parity difference and must be reported as one, naming the
 * call. Propagating would abort the matrix at the first bad case and reach `withPostgres`,
 * which collapses any throw into an opaque `status: "failed"`.
 */
async function attempt<T>(run: () => Promise<T>): Promise<T | { error: string }> {
	try {
		return await run();
	} catch (error) {
		const cause = (error as { cause?: unknown }).cause;
		return { error: `threw: ${String(cause ?? error).slice(0, 200)}` };
	}
}

/** Only the columns both backends are expected to agree on. */
function projectShape(row: unknown) {
	const value = row as Record<string, unknown> | null;
	if (!value) return null;
	if ("error" in value) return value;
	return {
		id: value.id,
		name: value.name,
		status: value.status,
		visibility: value.visibility,
		ownerUserId: value.ownerUserId,
		updatedAt: value.updatedAt,
	};
}

/**
 * Compare every case and return a human-readable problem per disagreement.
 *
 * Results are collected as data rather than asserted here so the caller can rethrow
 * outside the `withPostgres` boundary with the offending case named.
 */
export async function compareAll(
	sqliteAdapter: ReadAdapterLike,
	pgAdapter: ReadAdapterLike,
): Promise<{ problems: string[]; skipped: string[]; compared: number }> {
	const problems: string[] = [];
	const skipped: string[] = [];
	const bulk = new Set(bulkProjectIds());
	const comparisons: Comparison[] = [];

	const listIds = async (adapter: ReadAdapterLike, who: ProjectPrincipal, status?: string) => {
		const ids: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 40; page += 1) {
			const result = await adapter.listProjects(who, { limit: PG_PAGE_SIZE, cursor }, status);
			ids.push(...(result.rows as Array<{ id: string }>).map((row) => row.id));
			if (!result.nextCursor) return ids.filter((id) => !bulk.has(id));
			cursor = result.nextCursor;
		}
		throw new Error("listProjects paging did not terminate");
	};

	// --- listProjects authority matrix -------------------------------------------------
	for (const [label, who, nonEmpty] of [
		["owner", principal(USER.owner), true],
		["admin", principal(USER.admin, true), true],
		["read grant", principal(USER.read), true],
		["write grant", principal(USER.write), true],
		["manage grant", principal(USER.manage), true],
		["domain-only grant", principal(USER.domain), true],
		["no grant", principal(USER.none), true],
		["unknown user", principal(GHOST_USER), true],
		["absent principal", principal(""), false],
		["absent principal flagged admin", { userId: "", isAdmin: true }, false],
	] as Array<[string, ProjectPrincipal, boolean]>) {
		comparisons.push({
			name: `listProjects(${label})`,
			sqlite: (await listIds(sqliteAdapter, who)).sort(),
			postgres: (await listIds(pgAdapter, who)).sort(),
			nonEmpty,
		});
	}

	for (const status of ["active", "archived"]) {
		comparisons.push({
			name: `listProjects(owner, status=${status})`,
			sqlite: (await listIds(sqliteAdapter, principal(USER.owner), status)).sort(),
			postgres: (await listIds(pgAdapter, principal(USER.owner), status)).sort(),
			nonEmpty: true,
		});
	}

	// --- limit boundaries ---------------------------------------------------------------
	// The 1..200 clamp itself is compared further down, on the ids of the clamped page, now
	// that an oversized response can be relayed.
	for (const limit of [0, -5, 1, 37]) {
		const s = await sqliteAdapter.listProjects(principal(USER.bulk), { limit });
		const p = await pgAdapter.listProjects(principal(USER.bulk), { limit });
		comparisons.push({
			name: `listProjects(bulk, limit=${limit}) ids`,
			sqlite: (s.rows as Array<{ id: string }>).map((row) => row.id),
			postgres: (p.rows as Array<{ id: string }>).map((row) => row.id),
			nonEmpty: true,
		});
		// Cursors are opaque but both encode {updatedAt,id}: differing values mean the two
		// backends resume at different rows.
		comparisons.push({
			name: `listProjects(bulk, limit=${limit}) cursor`,
			sqlite: s.nextCursor,
			postgres: p.nextCursor,
		});
	}

	const walk = async (adapter: ReadAdapterLike) => {
		const ids: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 40; page += 1) {
			const result = await adapter.listProjects(principal(USER.bulk), {
				limit: PG_PAGE_SIZE,
				cursor,
			});
			ids.push(...(result.rows as Array<{ id: string }>).map((row) => row.id));
			if (!result.nextCursor) return ids;
			cursor = result.nextCursor;
		}
		throw new Error("bulk paging did not terminate");
	};
	const sqliteWalk = await walk(sqliteAdapter);
	const pgWalk = await walk(pgAdapter);
	comparisons.push({
		name: "bulk paging order",
		sqlite: sqliteWalk,
		postgres: pgWalk,
		nonEmpty: true,
	});
	comparisons.push({
		name: "bulk paging completeness [unique, total]",
		sqlite: [new Set(sqliteWalk).size, sqliteWalk.length],
		postgres: [new Set(pgWalk).size, pgWalk.length],
	});

	// --- text collation: mixed-case ids ------------------------------------------------
	// The defect these cases exist for: SQLite compares `text` in byte order and cannot be
	// told otherwise, while PostgreSQL uses the database collation — glibc `en_US.utf8` on the
	// official image, which interleaves letter case. Ids come from `nanoid` (mixed-case
	// alphabet), so real data always straddles that difference, and the two backends then
	// disagree about page boundaries, about which rows survive a cap, and about what a cursor
	// means. The adapter answer is `COLLATE "C"` on every text sort key AND its keyset
	// comparison; these cases are what makes that answer observable.
	//
	// Note the previous fixture ids were all lowercase, under which both collations produce
	// the identical sequence — the comparison was green while unable to see the bug at all.
	//
	// First: confirm the fixtures still HAVE the property. A later edit that normalised the
	// ids would otherwise leave every case below passing while testing nothing.
	for (const [label, ids] of [
		["projects", CASE_MIX_PROJECT_IDS],
		["bulk projects", bulkProjectIds()],
	] as Array<[string, readonly string[]]>) {
		if (!caseInsensitiveOrderDiffers(ids)) {
			problems.push(
				`case-mix fixture (${label}) is no longer collation-sensitive: byte order and a case-insensitive order agree, so this comparison cannot detect the defect`,
			);
		}
	}

	const caseMixWho = principal(USER.caseMix);
	// Walked ONE ROW AT A TIME: with `limit: 1` every row is its own page, so every adjacent
	// pair in the group becomes a real cursor boundary. A larger page would return the group
	// in one read and never exercise the keyset comparison on these ids — which is the half of
	// the fix that drops rows outright when it disagrees with the ORDER BY.
	const walkOneByOne = async (adapter: ReadAdapterLike) => {
		const ids: string[] = [];
		const cursors: Array<string | null> = [];
		let cursor: string | undefined;
		for (let page = 0; page < 40; page += 1) {
			const result = await adapter.listProjects(caseMixWho, { limit: 1, cursor });
			ids.push(...(result.rows as Array<{ id: string }>).map((row) => row.id));
			cursors.push(result.nextCursor);
			if (!result.nextCursor) return { ids, cursors };
			cursor = result.nextCursor;
		}
		throw new Error("case-mix paging did not terminate");
	};
	const caseMixSqlite = await walkOneByOne(sqliteAdapter);
	const caseMixPg = await attempt(() => walkOneByOne(pgAdapter));
	comparisons.push({
		name: "case-mix listProjects one-row paging order",
		sqlite: caseMixSqlite.ids,
		postgres: "error" in caseMixPg ? caseMixPg : caseMixPg.ids,
		nonEmpty: true,
	});
	// Cursor STRINGS, page by page. Both backends encode {updatedAt,id} identically, so a
	// difference here is the two resuming at different rows — the portability claim
	// `read-cursor.ts` makes, asserted rather than assumed.
	comparisons.push({
		name: "case-mix listProjects per-page cursors",
		sqlite: caseMixSqlite.cursors,
		postgres: "error" in caseMixPg ? caseMixPg : caseMixPg.cursors,
		nonEmpty: true,
	});
	// Agreement is necessary but not sufficient: both could agree on a locale order if SQLite
	// ever gained one. The sequence is therefore pinned to the LITERAL byte order too.
	const caseMixProjectsSeen = caseMixSqlite.ids.filter((id) =>
		(CASE_MIX_PROJECT_IDS as readonly string[]).includes(id),
	);
	if (caseMixProjectsSeen.join(",") !== CASE_MIX_PROJECT_IDS_BYTE_ORDER.join(",")) {
		problems.push(
			`case-mix listProjects is not in byte order: got ${caseMixProjectsSeen.join(",")}`,
		);
	}

	// A cursor minted by one backend, replayed against the OTHER. Encoding parity alone does
	// not make a cursor portable; only identical comparison semantics do. This is the case
	// that fails if `COLLATE "C"` is applied to the ORDER BY but not the keyset predicate.
	const midCursor = caseMixSqlite.cursors[2];
	if (typeof midCursor !== "string") {
		problems.push("case-mix walk produced no mid-list cursor to cross-replay");
	} else {
		const resumedSqlite = await sqliteAdapter.listProjects(caseMixWho, { cursor: midCursor });
		const resumedPg = await attempt(() =>
			pgAdapter.listProjects(caseMixWho, { cursor: midCursor }),
		);
		comparisons.push({
			name: "case-mix cursor replayed cross-backend",
			sqlite: (resumedSqlite.rows as Array<{ id: string }>).map((row) => row.id),
			postgres:
				"error" in resumedPg
					? resumedPg
					: (resumedPg.rows as Array<{ id: string }>).map((row) => row.id),
			nonEmpty: true,
		});
	}

	// --- getProject --------------------------------------------------------------------
	for (const [label, projectId, who] of [
		["priv/read", PROJECT.priv, principal(USER.read)],
		["priv/write", PROJECT.priv, principal(USER.write)],
		["priv/manage", PROJECT.priv, principal(USER.manage)],
		["priv/owner", PROJECT.priv, principal(USER.owner)],
		["priv/domain-only", PROJECT.priv, principal(USER.domain)],
		["priv/no-grant", PROJECT.priv, principal(USER.none)],
		["other/admin", PROJECT.other, principal(USER.admin, true)],
		["other/read", PROJECT.other, principal(USER.read)],
		["pub/unknown", PROJECT.pub, principal(GHOST_USER)],
		["priv/absent", PROJECT.priv, principal("")],
		["missing id", "p_does_not_exist", principal(USER.admin, true)],
	] as Array<[string, string, ProjectPrincipal]>) {
		comparisons.push({
			name: `getProject(${label})`,
			sqlite: projectShape(await attempt(() => sqliteAdapter.getProject(projectId, who))),
			postgres: projectShape(await attempt(() => pgAdapter.getProject(projectId, who))),
		});
	}

	// --- oversized result, relayed rather than skipped ---------------------------------
	// The clamped 200-row page cannot cross `psql` in one command. The pg adapter passed in by
	// the strict suite relays such a response in chunks (see `chunkedProxyDb`), so it is
	// compared for real. The fixture must stay above the clamp or the case proves nothing.
	if (BULK_PROJECT_COUNT <= 200) {
		problems.push("bulk project fixture no longer exceeds the 200-row clamp");
	}
	// The 200-row clamp, compared on the ids of the clamped page rather than its size alone:
	// the earlier version asserted PostgreSQL returned 200 by hardcoding `200`, which would
	// have held even if PostgreSQL had never been asked.
	const clampedSqlite = await sqliteAdapter.listProjects(principal(USER.bulk), { limit: 5000 });
	const clampedPg = (await attempt(() =>
		pgAdapter.listProjects(principal(USER.bulk), { limit: 5000 }),
	)) as { rows: Array<{ id: string }>; nextCursor: string | null } | { error: string };
	comparisons.push({
		name: "listProjects(bulk, limit clamped to 200)",
		sqlite: (clampedSqlite.rows as Array<{ id: string }>).map((row) => row.id),
		postgres: "error" in clampedPg ? clampedPg : clampedPg.rows.map((row) => row.id),
		nonEmpty: true,
	});
	comparisons.push({
		name: "listProjects(bulk, limit clamped to 200) cursor",
		sqlite: clampedSqlite.nextCursor,
		postgres: "error" in clampedPg ? clampedPg : clampedPg.nextCursor,
	});

	// --- anyProjectExists ------------------------------------------------------------
	// Access-blind by contract, so it is the one read that must say "yes" on both sides
	// whatever the principal; a backend answering from the wrong store disagrees here.
	comparisons.push({
		name: "anyProjectExists",
		sqlite: await attempt(() => sqliteAdapter.anyProjectExists()),
		postgres: await attempt(() => pgAdapter.anyProjectExists()),
	});
	if ((await sqliteAdapter.anyProjectExists()) !== true) {
		problems.push("anyProjectExists: SQLite reports no project although fixtures exist");
	}

	for (const comparison of comparisons) {
		const sqliteJson = JSON.stringify(comparison.sqlite);
		const postgresJson = JSON.stringify(comparison.postgres);
		if (sqliteJson !== postgresJson) {
			problems.push(
				`${comparison.name}: sqlite=${sqliteJson?.slice(0, 240)} postgres=${postgresJson?.slice(0, 240)}`,
			);
			continue;
		}
		// Two empty results agree about nothing, so a positive case must carry data.
		if (comparison.nonEmpty && (sqliteJson === "[]" || sqliteJson === "null")) {
			problems.push(`${comparison.name}: expected non-empty fixture data, got ${sqliteJson}`);
		}
	}
	return { problems, skipped, compared: comparisons.length };
}
