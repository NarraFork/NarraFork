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
import type { GraphAuxiliaryData } from "../../../../server/services/read/project-read-adapter";
import { type CommandResult, HarnessCommandError } from "../../../db/pg-test-harness";
import {
	BULK_CHAPTER_COUNT,
	bulkProjectIds,
	CASE_MIX_CHAPTER_IDS,
	CASE_MIX_CHAPTER_IDS_BYTE_ORDER,
	CASE_MIX_EDGE_IDS,
	CASE_MIX_EDGE_IDS_BYTE_ORDER,
	CASE_MIX_PROJECT_IDS,
	CASE_MIX_PROJECT_IDS_BYTE_ORDER,
	CHAPTER,
	caseInsensitiveOrderDiffers,
	GHOST_USER,
	PRIV_CHAPTER_IDS_ORDERED,
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
 * These four cases — `listChapters(bulk)` count and ids, `getGraph(bulk)` chapter count, and
 * the 200-row clamp of `listProjects(bulk)` — used to be skipped because their result sets
 * cannot cross `psql` in one command: the 201 chapter rows `listChapters` returns measure
 * ~221KB, thirteen times the harness' 16KiB `OUTPUT_LIMIT`, which aborts a command rather
 * than truncating it.
 *
 * They are now compared for real via {@link chunkedProxyDb}, which splits the RESPONSE
 * across several `psql` reads without touching the harness and without changing the adapter
 * call. Each adapter still issues its own single unpaged query, so what is asserted is the
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
	listChapters(projectId: string, principal: ProjectPrincipal, status?: string): Promise<unknown[]>;
	listChaptersPage(
		projectId: string,
		principal: ProjectPrincipal,
		page?: { limit?: number; cursor?: string },
		status?: string,
	): Promise<{ rows: unknown[]; nextCursor: string | null }>;
	getChapter(id: string, principal: ProjectPrincipal): Promise<unknown | null>;
	getGraph(projectId: string, principal: ProjectPrincipal): Promise<unknown>;
	getGraphAuxiliaryData(
		projectId: string,
		chapterIds: string[],
		principal: ProjectPrincipal,
	): Promise<GraphAuxiliaryData>;
}

export function principal(userId: string, isAdmin = false): ProjectPrincipal {
	return { userId, isAdmin };
}

/** Every migration in the PostgreSQL journal, verbatim. */
export async function migrationSql(): Promise<string[]> {
	const journal = JSON.parse(await readFile("drizzle-postgres/meta/_journal.json", "utf8")) as {
		entries: Array<{ tag: string }>;
	};
	if (journal.entries.length === 0) throw new Error("PostgreSQL migration journal is empty");
	return Promise.all(
		journal.entries.map((entry) => readFile(`drizzle-postgres/${entry.tag}.sql`, "utf8")),
	);
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
 * (16KiB), and `listChapters`/`getGraph` take no paging parameter, so their ~221KB
 * PostgreSQL payload has no smaller form to ask for. The result is therefore MATERIALIZED
 * server-side into a table and read back in `RELAY_CHUNK_CHARS` slices, each its own `psql`
 * invocation, then concatenated and parsed once.
 *
 * What this does and does not change:
 *   - the SQL the adapter issued is executed verbatim, once, unpaged. Only the delivery of
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

/** Stable order for comparison: row order is not part of either adapter's contract here. */
function sortById<T extends { id?: unknown; chapterId?: unknown }>(rows: T[]): T[] {
	return [...rows].sort((a, b) =>
		String(a.id ?? a.chapterId ?? "").localeCompare(String(b.id ?? b.chapterId ?? "")),
	);
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

function chapterShape(row: unknown) {
	const value = row as Record<string, unknown> | null;
	if (!value) return null;
	return {
		id: value.id,
		projectId: value.projectId,
		title: value.title,
		status: value.status,
		role: value.role,
		branch: value.branch,
		reviewSourceChapterId: value.reviewSourceChapterId ?? null,
	};
}

function edgeShape(row: unknown) {
	const value = row as Record<string, unknown>;
	return { id: value.id, sourceId: value.sourceId, targetId: value.targetId, type: value.type };
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
		["chapters", CASE_MIX_CHAPTER_IDS],
		["edges", CASE_MIX_EDGE_IDS],
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

	// listChapters over the same shapes: a complete, untruncated page whose ORDER is decided
	// entirely by the id tiebreak, since every row shares `createdAt`.
	const caseMixChaptersSqlite = (await sqliteAdapter.listChapters(
		PROJECT.caseMix,
		caseMixWho,
	)) as Array<{ id: string }>;
	const caseMixChaptersPg = (await attempt(() =>
		pgAdapter.listChapters(PROJECT.caseMix, caseMixWho),
	)) as Array<{ id: string }> | { error: string };
	comparisons.push({
		name: "case-mix listChapters order",
		sqlite: caseMixChaptersSqlite.map((row) => row.id),
		postgres: Array.isArray(caseMixChaptersPg)
			? caseMixChaptersPg.map((row) => row.id)
			: caseMixChaptersPg,
		nonEmpty: true,
	});
	if (
		caseMixChaptersSqlite.map((row) => row.id).join(",") !==
		CASE_MIX_CHAPTER_IDS_BYTE_ORDER.join(",")
	) {
		problems.push(
			`case-mix listChapters is not in byte order: got ${caseMixChaptersSqlite.map((row) => row.id).join(",")}`,
		);
	}

	// The chapter cursor, walked one row at a time for the same reason as the project one:
	// `createdAt` is shared across the whole group, so the id tiebreak carries every boundary.
	const walkChaptersOneByOne = async (adapter: ReadAdapterLike) => {
		const ids: string[] = [];
		const cursors: Array<string | null> = [];
		let cursor: string | undefined;
		for (let page = 0; page < 40; page += 1) {
			const result = await adapter.listChaptersPage(PROJECT.caseMix, caseMixWho, {
				limit: 1,
				cursor,
			});
			ids.push(...(result.rows as Array<{ id: string }>).map((row) => row.id));
			cursors.push(result.nextCursor);
			if (!result.nextCursor) return { ids, cursors };
			cursor = result.nextCursor;
		}
		throw new Error("case-mix chapter paging did not terminate");
	};
	const caseMixChapterWalkSqlite = await walkChaptersOneByOne(sqliteAdapter);
	const caseMixChapterWalkPg = await attempt(() => walkChaptersOneByOne(pgAdapter));
	comparisons.push({
		name: "case-mix listChaptersPage one-row paging order",
		sqlite: caseMixChapterWalkSqlite.ids,
		postgres: "error" in caseMixChapterWalkPg ? caseMixChapterWalkPg : caseMixChapterWalkPg.ids,
		nonEmpty: true,
	});
	comparisons.push({
		name: "case-mix listChaptersPage per-page cursors",
		sqlite: caseMixChapterWalkSqlite.cursors,
		postgres: "error" in caseMixChapterWalkPg ? caseMixChapterWalkPg : caseMixChapterWalkPg.cursors,
		nonEmpty: true,
	});

	// getGraph: its chapter and edge orderings decide WHICH rows a truncated canvas keeps, so
	// they are collation-sensitive even though this particular graph fits under the caps.
	const caseMixGraphSqlite = (await sqliteAdapter.getGraph(PROJECT.caseMix, caseMixWho)) as {
		chapters: Array<{ id: string }>;
		edges: Array<{ id: string }>;
	};
	const caseMixGraphPg = (await attempt(() => pgAdapter.getGraph(PROJECT.caseMix, caseMixWho))) as
		| { chapters: Array<{ id: string }>; edges: Array<{ id: string }> }
		| { error: string };
	comparisons.push({
		name: "case-mix getGraph chapter order",
		sqlite: caseMixGraphSqlite.chapters.map((ch) => ch.id),
		postgres:
			"error" in caseMixGraphPg ? caseMixGraphPg : caseMixGraphPg.chapters.map((ch) => ch.id),
		nonEmpty: true,
	});
	// Edge order is compared UNSORTED here, unlike the other graph cases: sorting it in JS
	// would discard the very property under test.
	comparisons.push({
		name: "case-mix getGraph edge order",
		sqlite: caseMixGraphSqlite.edges.map((edge) => edge.id),
		postgres:
			"error" in caseMixGraphPg ? caseMixGraphPg : caseMixGraphPg.edges.map((edge) => edge.id),
		nonEmpty: true,
	});
	if (
		caseMixGraphSqlite.edges.map((edge) => edge.id).join(",") !==
		CASE_MIX_EDGE_IDS_BYTE_ORDER.join(",")
	) {
		problems.push(
			`case-mix getGraph edges are not in byte order: got ${caseMixGraphSqlite.edges.map((e) => e.id).join(",")}`,
		);
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

	// --- listChapters ------------------------------------------------------------------
	for (const [label, projectId, who, status] of [
		["priv/read", PROJECT.priv, principal(USER.read), undefined],
		["priv/owner", PROJECT.priv, principal(USER.owner), undefined],
		["priv/dormant", PROJECT.priv, principal(USER.owner), "dormant"],
		["priv/no-grant", PROJECT.priv, principal(USER.none), undefined],
		["other/admin", PROJECT.other, principal(USER.admin, true), undefined],
		["other/read", PROJECT.other, principal(USER.read), undefined],
		["pub/unknown", PROJECT.pub, principal(GHOST_USER), undefined],
		["priv/absent", PROJECT.priv, principal(""), undefined],
	] as Array<[string, string, ProjectPrincipal, string | undefined]>) {
		const s = await attempt(() => sqliteAdapter.listChapters(projectId, who, status));
		const p = await attempt(() => pgAdapter.listChapters(projectId, who, status));
		comparisons.push({
			name: `listChapters(${label})`,
			sqlite: Array.isArray(s) ? s.map(chapterShape) : s,
			postgres: Array.isArray(p) ? p.map(chapterShape) : p,
			nonEmpty: ["priv/read", "priv/owner", "priv/dormant", "other/admin", "pub/unknown"].includes(
				label,
			),
		});
	}

	// --- oversized results, relayed rather than skipped ---------------------------------
	// `listChapters` and `getGraph` have a fixed 201-row cap and no paging parameter, so their
	// PostgreSQL payload (~221KB) cannot cross `psql` in one command. The pg adapter passed in
	// by the strict suite relays such a response in chunks (see `chunkedProxyDb`), so these are
	// now compared for real. The fixture must stay above the cap or the cases prove nothing.
	if (BULK_CHAPTER_COUNT <= 200) {
		problems.push("bulk chapter fixture no longer exceeds the 200-row cap");
	}
	const bulkChaptersSqlite = (await sqliteAdapter.listChapters(
		PROJECT.bulk,
		principal(USER.bulk),
	)) as Array<{ id: string }>;
	const bulkChaptersPg = (await attempt(() =>
		pgAdapter.listChapters(PROJECT.bulk, principal(USER.bulk)),
	)) as Array<{ id: string }> | { error: string };
	if (bulkChaptersSqlite.length === 0) {
		problems.push("SQLite bulk chapter fixtures missing");
	}
	comparisons.push({
		name: "listChapters(bulk) count",
		sqlite: bulkChaptersSqlite.length,
		postgres: Array.isArray(bulkChaptersPg) ? bulkChaptersPg.length : bulkChaptersPg,
	});
	// Ids, in order: a matching count with a different set or order would still mean the two
	// backends disagree about WHICH rows survive the cap.
	comparisons.push({
		name: "listChapters(bulk) ids",
		sqlite: bulkChaptersSqlite.map((row) => row.id),
		postgres: Array.isArray(bulkChaptersPg) ? bulkChaptersPg.map((row) => row.id) : bulkChaptersPg,
		nonEmpty: true,
	});

	const bulkGraphSqlite = (await sqliteAdapter.getGraph(PROJECT.bulk, principal(USER.bulk))) as {
		chapters: Array<{ id: string }>;
		truncated?: boolean;
	};
	const bulkGraphPg = (await attempt(() =>
		pgAdapter.getGraph(PROJECT.bulk, principal(USER.bulk)),
	)) as { chapters: Array<{ id: string }>; truncated?: boolean } | { error: string };
	comparisons.push({
		name: "getGraph(bulk) chapter count",
		sqlite: bulkGraphSqlite.chapters.length,
		postgres: "error" in bulkGraphPg ? bulkGraphPg : bulkGraphPg.chapters.length,
	});
	comparisons.push({
		name: "getGraph(bulk) chapter ids",
		sqlite: bulkGraphSqlite.chapters.map((ch) => ch.id),
		postgres: "error" in bulkGraphPg ? bulkGraphPg : bulkGraphPg.chapters.map((ch) => ch.id),
		nonEmpty: true,
	});
	// The truncation flag is the only way a caller learns the canvas is incomplete, so the
	// two backends must agree it is set — not merely agree on the row count.
	comparisons.push({
		name: "getGraph(bulk) truncated flag",
		sqlite: bulkGraphSqlite.truncated ?? null,
		postgres: "error" in bulkGraphPg ? bulkGraphPg : (bulkGraphPg.truncated ?? null),
	});

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

	// --- getChapter --------------------------------------------------------------------
	for (const [label, chapterId, who] of [
		["review/write", CHAPTER.review, principal(USER.write)],
		["a/read", CHAPTER.a, principal(USER.read)],
		["other1/admin", CHAPTER.other1, principal(USER.admin, true)],
		["other1/read", CHAPTER.other1, principal(USER.read)],
		["other1/domain-only", CHAPTER.other1, principal(USER.domain)],
		["pub/unknown", CHAPTER.pub, principal(GHOST_USER)],
		["a/absent", CHAPTER.a, principal("")],
		["missing id", "c_nope", principal(USER.admin, true)],
	] as Array<[string, string, ProjectPrincipal]>) {
		const s = await attempt(() => sqliteAdapter.getChapter(chapterId, who));
		const p = await attempt(() => pgAdapter.getChapter(chapterId, who));
		comparisons.push({
			name: `getChapter(${label})`,
			sqlite: s && typeof s === "object" && "error" in s ? s : chapterShape(s),
			postgres: p && typeof p === "object" && "error" in p ? p : chapterShape(p),
		});
	}

	// --- getGraph ----------------------------------------------------------------------
	// `hasEdges` is tracked separately from `nonEmpty`: p_pub holds a chapter but no edges,
	// so demanding non-empty edges there would be a false expectation rather than a guard.
	for (const [label, projectId, who, nonEmpty, hasEdges] of [
		["priv/read", PROJECT.priv, principal(USER.read), true, true],
		["priv/no-grant", PROJECT.priv, principal(USER.none), false, false],
		["other/admin", PROJECT.other, principal(USER.admin, true), true, true],
		["other/read", PROJECT.other, principal(USER.read), false, false],
		["pub/unknown", PROJECT.pub, principal(GHOST_USER), true, false],
		["priv/absent", PROJECT.priv, principal(""), false, false],
	] as Array<[string, string, ProjectPrincipal, boolean, boolean]>) {
		const s = (await attempt(() => sqliteAdapter.getGraph(projectId, who))) as {
			chapters?: unknown[];
			edges?: unknown[];
			error?: string;
		};
		const p = (await attempt(() => pgAdapter.getGraph(projectId, who))) as {
			chapters?: unknown[];
			edges?: unknown[];
			error?: string;
		};
		comparisons.push({
			name: `getGraph(${label}) chapters`,
			sqlite: s.error ? s : (s.chapters ?? []).map(chapterShape),
			postgres: p.error ? p : (p.chapters ?? []).map(chapterShape),
			nonEmpty,
		});
		comparisons.push({
			name: `getGraph(${label}) edges`,
			sqlite: s.error ? s : sortById((s.edges ?? []).map(edgeShape)),
			postgres: p.error ? p : sortById((p.edges ?? []).map(edgeShape)),
			nonEmpty: hasEdges,
		});
	}

	// --- getGraphAuxiliaryData ---------------------------------------------------------
	for (const [label, projectId, chapterIds, who, nonEmpty] of [
		["priv/read", PROJECT.priv, PRIV_CHAPTER_IDS_ORDERED, principal(USER.read), true],
		["priv/owner", PROJECT.priv, PRIV_CHAPTER_IDS_ORDERED, principal(USER.owner), true],
		["priv/admin", PROJECT.priv, PRIV_CHAPTER_IDS_ORDERED, principal(USER.admin, true), true],
		["pub/no-grant", PROJECT.pub, [CHAPTER.pub], principal(USER.none), true],
		["pub/unknown", PROJECT.pub, [CHAPTER.pub], principal(GHOST_USER), true],
		["other/read", PROJECT.other, [CHAPTER.other1, CHAPTER.other2], principal(USER.read), false],
		["priv/absent", PROJECT.priv, PRIV_CHAPTER_IDS_ORDERED, principal(""), false],
		["priv/empty ids", PROJECT.priv, [], principal(USER.read), false],
		[
			"priv/foreign chapter id",
			PROJECT.priv,
			[CHAPTER.a, CHAPTER.other1],
			principal(USER.admin, true),
			true,
		],
	] as Array<[string, string, string[], ProjectPrincipal, boolean]>) {
		const s = await attempt(() => sqliteAdapter.getGraphAuxiliaryData(projectId, chapterIds, who));
		const p = await attempt(() => pgAdapter.getGraphAuxiliaryData(projectId, chapterIds, who));
		comparisons.push({
			name: `aux(${label}) narrators`,
			sqlite: "error" in s ? s : s.narrators.map((n) => n.id).sort(),
			postgres: "error" in p ? p : p.narrators.map((n) => n.id).sort(),
			nonEmpty,
		});
		// No `nonEmpty` on containers: the SQLite side returns nothing for a non-admin
		// principal because of the predicate bug the SQLite suite pins as a red test. Demanding
		// data here would duplicate that failure instead of measuring parity.
		comparisons.push({
			name: `aux(${label}) containers`,
			sqlite: "error" in s ? s : s.containers.map((c) => c.chapterId).sort(),
			postgres: "error" in p ? p : p.containers.map((c) => c.chapterId).sort(),
		});
		comparisons.push({
			name: `aux(${label}) detachedPanels`,
			sqlite: "error" in s ? s : sortById(s.detachedPanels),
			postgres: "error" in p ? p : sortById(p.detachedPanels),
		});
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
