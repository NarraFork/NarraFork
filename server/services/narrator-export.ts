/**
 * narrator-export.ts — stream a narrator's transcript out as Markdown or JSON.
 *
 * Three properties shape this module:
 *
 *  1. **Read-only.** A lazily-forked narrator keeps its older history in its
 *     ancestors. `ensureRefsCoverSeq` would materialize it, but that is a write
 *     path (a synchronous transaction per 400-ref window, up to 1000 windows,
 *     recursing through every ancestor) and running it from a GET would both
 *     block the main thread and permanently rewrite the database for what is a
 *     read. Instead we reuse the predicate shape that full-text search already
 *     relies on: `resolveLazyLineage` yields each ancestor plus the exclusive seq
 *     bound this descendant is entitled to see, and the paging query ORs those
 *     scopes together. Nothing is written.
 *
 *  2. **Bounded per page.** One page is a single indexed ranged select over
 *     `narrator_message_refs`, then two-step reads for tool calls and child
 *     messages: a metadata select that projects only `length()` of the large
 *     columns, and a second select that `substr`-projects the bodies for the
 *     longest prefix of rows that still fits the page byte budget. The budget is
 *     therefore enforced by SQL, not by a JS check after the bytes have already
 *     been materialized. Row counts are capped independently of how many messages
 *     a page holds, so the page ceiling is a constant (≈ 18 M characters, derived
 *     in the tunables below) rather than a function of the history's shape or of
 *     how large the stored payloads happen to be. Between pages the
 *     generator yields the event loop. No table scans, no `COUNT(*)`, no
 *     unbounded `.all()`.
 *
 *  3. **Honest about incompleteness.** Every truncation is labelled in the
 *     output, and the JSON form ends with a `"complete": true` sentinel. A file
 *     that lacks it (or fails to parse at all, when the client disconnects
 *     mid-stream) is by definition partial — a reader never has to guess.
 */

import { parseCompactMessageBlock } from "@shared/compact-message";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { narratorMessageRefs, narratorMessages, narrators, narratorToolCalls } from "../db/schema";
import { logger } from "../lib/logger";
import { isSubagentVariant } from "../lib/narrator-utils";
import { resolveLazyLineage } from "./narrator-refs-backfill";

// ── Tunables ───────────────────────────────────────────────────────────────

/**
 * Every limit below exists to make ONE page a constant, not a function of the
 * history's shape. `bun:sqlite` reads synchronously on the same thread that serves
 * HTTP and WebSocket traffic, so a page that materializes hundreds of megabytes
 * is not slow — it is a full stall for every other request.
 *
 * Worst case for one page, counted in characters (SQLite's `substr`/`length` are
 * character-based; JS keeps them as UTF-16, so multiply by ≤ 2 for resident bytes):
 *
 *   refs               100 × ~100 chars                    ≈  0.01 M
 *   tool metadata     1 000 × (~200 + 1 024 error chars)   ≈  1.2  M
 *   tool bodies       EXPORT_PAGE_TOOL_IO_BUDGET, in SQL   =  8.4  M
 *   child messages    1 001 × 2 × 4 096 chars              ≈  8.2  M
 *   ──────────────────────────────────────────────────────────────────
 *                                                          ≈ 17.8 M chars (≲ 36 MB)
 *
 * Compare the ceiling this replaced: the tool-call read alone allowed
 * `100 messages × 100 calls × 2 × 32 KB` ≈ 640 MB, because the row cap scaled with
 * the page's message count and the byte budget was checked in JS after SQLite had
 * already returned everything.
 *
 * Top-level message bodies are deliberately not clamped: they are the transcript
 * itself, and truncating them would defeat the export. `EXPORT_PAGE_REFS` is what
 * bounds them — 100 rows per page.
 */

/** Top-level refs per page. Small pages keep any single blocking span short. */
export const EXPORT_PAGE_REFS = 100;

/** Character ceiling for one tool call's input or output, applied in SQL. */
export const EXPORT_TOOL_FIELD_LIMIT = 32_768;

/**
 * Character ceiling for a tool call's error message, applied in SQL.
 *
 * `error_message` is not a short string in practice: a failed tool call stores the
 * whole tool output in it, so it is exactly as unbounded as the bodies are. Unlike
 * the bodies it is read for every row on the page (metadata has to be fetched
 * before the budget can be spent), so its ceiling has to survive being multiplied
 * by the row cap — hence a small one.
 */
export const EXPORT_TOOL_ERROR_LIMIT = 1_024;

/** Tool calls kept per message. Excess is dropped from the newest end. */
export const EXPORT_TOOL_CALLS_PER_MESSAGE = 100;

/**
 * Tool-call rows read per page, independent of how many messages the page holds.
 *
 * The previous cap was `messages × EXPORT_TOOL_CALLS_PER_MESSAGE` — up to 10 000
 * rows, each free to carry two `EXPORT_TOOL_FIELD_LIMIT` bodies, which is where a
 * ~640 MB single-page read came from. Row count is now a constant, and the rows
 * fetched in step one carry lengths only, so step one costs ≈ 1.2 M characters
 * whatever the history looks like.
 */
export const EXPORT_TOOL_CALLS_PER_PAGE = 1_000;

/**
 * Character budget for tool bodies per page, enforced in SQL.
 *
 * Spending it is a two-step read: a metadata select projects `length()` of the two
 * large columns, the budget is walked over those lengths, and only the rows that
 * fit get a second select that `substr`-projects their bodies. A JS-side check
 * cannot enforce this — by the time it runs, SQLite has already handed over the
 * bytes it was supposed to withhold.
 */
export const EXPORT_PAGE_TOOL_IO_BUDGET = 8 * 1024 * 1024;

/** Child (subagent) messages loaded per page. */
export const EXPORT_CHILD_MESSAGES_PER_PAGE = 1_000;

/**
 * Character ceiling for one child message's content, applied in SQL.
 *
 * Child rows are capped by count, so their ceiling is a product: 1 001 rows × two
 * clamped columns (`content_json` and the `content_text` fallback) ≈ 8.2 M chars.
 * Smaller than a tool body limit on purpose — subagent messages are secondary
 * content rendered inside a tool's `<details>`, and the alternative to a short
 * excerpt is not a longer one, it is a stalled server.
 *
 * A clamped `content_json` is no longer parseable JSON, so a truncated child is
 * exported as its `content_text` prefix plus an explicit truncation note rather
 * than as content blocks (see `loadChildMessages`).
 */
export const EXPORT_CHILD_CONTENT_LIMIT = 4_096;

/** A page slower than this is logged; it means a history shape worth knowing about. */
const SLOW_PAGE_MS = 500;

/** Matches `generateId`/`generateShortId` output. Anything else is refused. */
const NARRATOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// ── Options ────────────────────────────────────────────────────────────────

export type NarratorExportFormat = "markdown" | "json";

/**
 * How much history to export.
 *
 * `visible` is the default: it matches what the user is looking at when they
 * click export, which is what they almost always mean. `full` reaches back past
 * compact points for a genuine archive.
 *
 * The risk of a narrower default is a file that looks complete but is not, so it
 * is paid for elsewhere: whenever `visible` actually hides something, the export
 * says so in its own body (see `earlierHistoryOmitted`). A small default is fine;
 * a silently small default is not.
 */
export type NarratorExportScope =
	/** Everything: pre-compact history and segment-compacted messages included. */
	| "full"
	/** Only what the UI currently shows: after the last compact, folds excluded. */
	| "visible";

export type NarratorExportLang = "en" | "zh-CN";

export interface NarratorExportOptions {
	format: NarratorExportFormat;
	scope: NarratorExportScope;
	includeToolIO: boolean;
	lang: NarratorExportLang;
}

export const NARRATOR_EXPORT_DEFAULTS: NarratorExportOptions = {
	format: "markdown",
	scope: "visible",
	includeToolIO: true,
	lang: "en",
};

// ── Row shapes ─────────────────────────────────────────────────────────────

interface ExportRefRow {
	/** Ref row id — the tiebreaker that makes the paging cursor total. */
	refId: string;
	messageId: string;
	seq: number;
	isCompact: number;
	folded: boolean;
}

interface ExportMessageRow {
	id: string;
	role: string;
	// biome-ignore lint/suspicious/noExplicitAny: contentJson is dynamic SDK JSON
	contentJson: any;
	contentText: string | null;
	model: string | null;
	provider: string | null;
	origin: string | null;
	originLabel: string | null;
	createdAt: string;
	editedAt: string | null;
	tokensIn: number | null;
	outputTokens: number | null;
	costUsd: number | null;
	parentToolUseId: string | null;
	/**
	 * Only set on child (subagent) rows: their content is clamped in SQL, so a
	 * reader has to be told when what they see is an excerpt. Top-level rows are
	 * never clamped and leave both fields undefined.
	 */
	contentTruncated?: boolean;
	/** Untruncated length of the longest content column, projected alongside. */
	contentBytes?: number;
}

/**
 * A tool-call row as it comes back from SQL, after the page budget has decided
 * whether this row was allowed to carry its bodies.
 */
interface ExportToolRow {
	/** Primary key — the join key between the metadata pass and the body pass. */
	id: string;
	messageId: string;
	toolUseId: string;
	toolName: string;
	status: string;
	durationMs: number | null;
	errorMessage: string | null;
	/** Untruncated `error_message` length; it is clamped in SQL like the bodies. */
	errorBytes: number;
	createdAt: string;
	input: string | null;
	output: string | null;
	inputBytes: number;
	outputBytes: number;
	/** True when SQL was never asked for this row's bodies: budget already spent. */
	ioOmitted: boolean;
	/** 1-based position of this call within its message, from SQL. */
	rank?: number;
	/**
	 * How many tool calls the message really has, counted in SQL over the full
	 * partition. Rows past the per-message cap are never fetched, so this is the
	 * only way to report the omission exactly instead of guessing from row counts.
	 */
	toolCallsForMessage?: number;
}

interface ExportToolCall {
	toolUseId: string;
	toolName: string;
	status: string;
	durationMs: number | null;
	errorMessage: string | null;
	errorTruncated: boolean;
	errorBytes: number;
	input: string | null;
	output: string | null;
	inputTruncated: boolean;
	outputTruncated: boolean;
	inputBytes: number;
	outputBytes: number;
	/** True when the page's IO budget was already spent: metadata only. */
	ioOmitted: boolean;
	children: ExportMessageRow[];
}

interface ExportMessage {
	seq: number;
	row: ExportMessageRow;
	isCompactMarker: boolean;
	folded: boolean;
	toolCalls: ExportToolCall[];
	toolCallsOmitted: number;
}

interface TruncationStats {
	toolFieldsTruncated: number;
	toolCallsOmitted: number;
	pagesWithIoOmitted: number;
	childMessagesOmitted: number;
	/** Child messages whose content was exported as a clamped excerpt. */
	childMessagesTruncated: number;
	/**
	 * Set when `scope: "visible"` actually excluded messages older than the last
	 * compact point. This is what keeps the narrower default honest — a reader can
	 * tell "this session was short" apart from "this export starts partway in".
	 */
	earlierHistoryOmitted: boolean;
}

// ── Lineage scope ──────────────────────────────────────────────────────────

/**
 * Ref predicate covering the narrator itself plus the ancestry it still borrows
 * older refs from.
 *
 * Ancestor scopes always exclude segment-compacted refs, matching `copyWindow`
 * and `forkNarrator`: those rows never become visible history in a descendant,
 * so an export must not conjure them up either. The narrator's own refs follow
 * the requested scope.
 */
async function buildRefScope(narratorId: string, scope: NarratorExportScope) {
	if (!NARRATOR_ID_PATTERN.test(narratorId)) {
		throw new Error(`Invalid narrator id: ${narratorId}`);
	}

	const ownClauses = [eq(narratorMessageRefs.narratorId, narratorId)];
	if (scope === "visible") {
		ownClauses.push(isNull(narratorMessageRefs.segmentCompactId));
	}
	const clauses = [and(...ownClauses)];

	for (const step of await resolveLazyLineage(narratorId)) {
		if (!NARRATOR_ID_PATTERN.test(step.parentNarratorId)) continue;
		if (!Number.isFinite(step.upperBoundSeq)) continue;
		const bound = Math.trunc(step.upperBoundSeq);
		clauses.push(
			and(
				eq(narratorMessageRefs.narratorId, step.parentNarratorId),
				sql`${narratorMessageRefs.seq} < ${bound}`,
				isNull(narratorMessageRefs.segmentCompactId),
			),
		);
	}

	return clauses.length === 1 ? clauses[0] : or(...clauses);
}

/**
 * Seq of the narrator's most recent compact marker, or null when it has none.
 *
 * Deliberately a local query rather than a call into `narratorMessageQueries`:
 * that module pulls in the whole narrator service graph, and importing it from
 * here closes an import cycle (narrator-service imports narrator-messages at
 * module scope). One indexed `LIMIT 1` lookup is not worth that coupling.
 */
async function loadLatestCompactSeq(narratorId: string): Promise<number | null> {
	const rows = await db
		.select({ seq: narratorMessageRefs.seq })
		.from(narratorMessageRefs)
		.where(
			and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessageRefs.isCompact, 1)),
		)
		.orderBy(sql`${narratorMessageRefs.seq} DESC`)
		.limit(1);
	return rows[0]?.seq ?? null;
}

/**
 * Whether any exportable message sits strictly before `boundarySeq`.
 *
 * Used to decide whether a `visible` export is actually hiding something. Two
 * reasons it is a probe rather than an inference from "a compact marker exists":
 *
 *  - the bound is exclusive, because the marker itself lives exactly at
 *    `boundarySeq`; an inclusive test would always find it and report every
 *    compacted session as withholding history;
 *  - a session compacted at its very first message, or a fork whose pre-compact
 *    history belongs to an ancestor outside its scope, genuinely has nothing
 *    earlier to withhold, and must not be labelled as if it did.
 *
 * One indexed `LIMIT 1` lookup answers it exactly.
 */
async function hasHistoryBelow(
	// biome-ignore lint/suspicious/noExplicitAny: drizzle SQL predicate union
	scopeClause: any,
	boundarySeq: number,
	isSubagent: boolean,
): Promise<boolean> {
	const conditions = [scopeClause, sql`${narratorMessageRefs.seq} < ${boundarySeq}`];
	if (!isSubagent) conditions.push(isNull(narratorMessages.parentToolUseId));
	const rows = await db
		.select({ seq: narratorMessageRefs.seq })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
		.where(and(...conditions))
		.limit(1);
	return rows.length > 0;
}

// ── Paging ─────────────────────────────────────────────────────────────────

/**
 * One page of top-level refs, ordered by `(seq, refId)`.
 *
 * The cursor is composite rather than seq-only because seq is NOT unique across
 * the scope: an inherited ref keeps its ancestor's original seq, so a narrator
 * and its parent can both hold seq 7. A `seq > cursor` cursor would then skip
 * every same-seq row that happened to fall on the far side of a page boundary,
 * silently dropping messages from the middle of an export. Ordering by the ref id
 * as a tiebreaker makes the cursor total.
 *
 * Deduplication by messageId is the caller's job: choosing which copy of a
 * doubly-reachable message wins needs the running set, not a single page.
 */
async function loadRefPage(
	// The narrator is already encoded in `scopeClause` (together with any inherited
	// ancestry), so passing its id separately would invite the two disagreeing.
	// biome-ignore lint/suspicious/noExplicitAny: drizzle SQL predicate union
	scopeClause: any,
	cursor: { seq: number; refId: string } | null,
	latestCompactSeq: number | null,
	isSubagent: boolean,
): Promise<ExportRefRow[]> {
	const conditions = [scopeClause];
	if (cursor) {
		conditions.push(
			sql`(${narratorMessageRefs.seq}, ${narratorMessageRefs.id}) > (${cursor.seq}, ${cursor.refId})`,
		);
	}
	// Subagent transcripts ARE the child messages, so their top level is not
	// filtered by parentToolUseId; a primary narrator's is.
	if (!isSubagent) conditions.push(isNull(narratorMessages.parentToolUseId));
	if (latestCompactSeq != null) {
		conditions.push(gt(narratorMessageRefs.seq, latestCompactSeq));
	}

	const rows = await db
		.select({
			refId: narratorMessageRefs.id,
			messageId: narratorMessageRefs.messageId,
			seq: narratorMessageRefs.seq,
			isCompact: narratorMessageRefs.isCompact,
			segmentCompactId: narratorMessageRefs.segmentCompactId,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
		.where(and(...conditions))
		.orderBy(narratorMessageRefs.seq, narratorMessageRefs.id)
		.limit(EXPORT_PAGE_REFS);

	return rows.map((row) => ({
		refId: row.refId,
		messageId: row.messageId,
		seq: row.seq,
		isCompact: row.isCompact,
		folded: row.segmentCompactId != null,
	}));
}

const MESSAGE_COLUMNS = {
	id: narratorMessages.id,
	role: narratorMessages.role,
	contentJson: narratorMessages.contentJson,
	contentText: narratorMessages.contentText,
	model: narratorMessages.model,
	provider: narratorMessages.provider,
	origin: narratorMessages.origin,
	originLabel: narratorMessages.originLabel,
	createdAt: narratorMessages.createdAt,
	editedAt: narratorMessages.editedAt,
	tokensIn: narratorMessages.tokensIn,
	outputTokens: narratorMessages.outputTokens,
	costUsd: narratorMessages.costUsd,
	parentToolUseId: narratorMessages.parentToolUseId,
} as const;

async function loadMessages(messageIds: string[]): Promise<Map<string, ExportMessageRow>> {
	if (messageIds.length === 0) return new Map();
	const rows = await db
		.select(MESSAGE_COLUMNS)
		.from(narratorMessages)
		.where(inArray(narratorMessages.id, messageIds));
	return new Map(rows.map((row) => [row.id, row as ExportMessageRow]));
}

/**
 * Metadata for a page's tool calls: everything except the two large columns.
 *
 * `length()` of `input_json`/`output_json` is projected instead of their contents,
 * so this query's result size is a function of the ROW COUNT only — and the row
 * count is capped twice: `row_number()` keeps at most
 * `EXPORT_TOOL_CALLS_PER_MESSAGE` per message, and `LIMIT` caps the page at
 * `EXPORT_TOOL_CALLS_PER_PAGE`.
 *
 * Two details of the ordering are load-bearing:
 *
 *  - `ORDER BY rank` first walks the calls breadth-first across the page's
 *    messages (every message's 1st call, then every message's 2nd, …). Since a
 *    page holds at most `EXPORT_PAGE_REFS` (100) messages and the row cap is an
 *    order of magnitude larger, every message that has tool calls is guaranteed to
 *    appear in the result. That is what makes `toolCallsForMessage` sufficient to
 *    report omissions exactly: a message can never be silently reduced to "no tool
 *    calls at all" by the page-level cap. It also spreads the body budget below,
 *    so one message with enormous calls cannot starve the rest of the page.
 *  - `(created_at, id)` is the tiebreaker, because `created_at` alone is not
 *    unique — several calls in one assistant turn routinely share a timestamp, and
 *    an unstable order would make `rank` (and therefore which calls are kept)
 *    vary between the two reads below.
 */
async function loadToolCallMeta(messageIds: string[]) {
	const ranked = db
		.select({
			id: narratorToolCalls.id,
			messageId: narratorToolCalls.messageId,
			toolUseId: narratorToolCalls.toolUseId,
			toolName: narratorToolCalls.toolName,
			status: narratorToolCalls.status,
			durationMs: narratorToolCalls.durationMs,
			createdAt: narratorToolCalls.createdAt,
			errorMessage: sql<
				string | null
			>`substr(${narratorToolCalls.errorMessage}, 1, ${EXPORT_TOOL_ERROR_LIMIT})`.as(
				"error_excerpt",
			),
			errorBytes: sql<number>`length(COALESCE(${narratorToolCalls.errorMessage}, ''))`.as(
				"error_bytes",
			),
			inputBytes:
				sql<number>`length(COALESCE(CAST(${narratorToolCalls.inputJson} AS TEXT), ''))`.as(
					"input_bytes",
				),
			outputBytes:
				sql<number>`length(COALESCE(CAST(${narratorToolCalls.outputJson} AS TEXT), ''))`.as(
					"output_bytes",
				),
			rank: sql<number>`row_number() OVER (
					PARTITION BY ${narratorToolCalls.messageId}
					ORDER BY ${narratorToolCalls.createdAt}, ${narratorToolCalls.id}
				)`.as("tool_rank"),
			toolCallsForMessage: sql<number>`count(*) OVER (
					PARTITION BY ${narratorToolCalls.messageId}
				)`.as("tool_calls_for_message"),
		})
		.from(narratorToolCalls)
		.where(inArray(narratorToolCalls.messageId, messageIds))
		.as("ranked_tool_calls");

	return (
		db
			.select()
			.from(ranked)
			.where(sql`${ranked.rank} <= ${EXPORT_TOOL_CALLS_PER_MESSAGE}`)
			// Raw SQL because `rank` is a window-function alias on the subquery, not a
			// column reference drizzle's typed `orderBy` will accept.
			.orderBy(sql`${ranked.rank}, ${ranked.createdAt}, ${ranked.id}`)
			.limit(EXPORT_TOOL_CALLS_PER_PAGE)
	);
}

/**
 * Decide which of the page's tool calls may carry their bodies.
 *
 * The walk is over `length()` values only — numbers, already in hand — so nothing
 * large is touched to make the decision. `min(bytes, EXPORT_TOOL_FIELD_LIMIT)` is
 * the size the projection will actually return, which is what has to be budgeted;
 * budgeting the untruncated length would omit bodies that would have been clamped
 * to something small anyway.
 *
 * Once the budget is spent the remaining rows are omitted rather than skipped-and-
 * retried: a prefix rule keeps "everything up to here has bodies" true, which is a
 * far easier property to explain in an exported file than a scattered mix.
 */
function selectToolBodyIds(rows: Awaited<ReturnType<typeof loadToolCallMeta>>): Set<string> {
	const allowed = new Set<string>();
	let spent = 0;
	for (const row of rows) {
		const projected =
			Math.min(row.inputBytes, EXPORT_TOOL_FIELD_LIMIT) +
			Math.min(row.outputBytes, EXPORT_TOOL_FIELD_LIMIT);
		if (spent + projected > EXPORT_PAGE_TOOL_IO_BUDGET) break;
		spent += projected;
		allowed.add(row.id);
	}
	return allowed;
}

/**
 * Tool calls for a page, with the two large columns clamped inside SQLite AND the
 * page's total body volume capped before SQLite is asked for any of it.
 *
 * A per-field `substr` alone is not a bound: the old single query allowed
 * `messages × EXPORT_TOOL_CALLS_PER_MESSAGE` rows (up to 10 000) to each return
 * two clamped-but-still-32 KB fields, so one page could materialize hundreds of
 * megabytes on the thread that also serves every other request. A JS-side budget
 * could not prevent it either — it runs after `bun:sqlite` has already handed the
 * bytes over.
 *
 * Hence two reads: metadata (lengths, no bodies), then bodies for exactly the rows
 * that fit. Worst case for the pair is
 * `EXPORT_TOOL_CALLS_PER_PAGE × metadata + EXPORT_PAGE_TOOL_IO_BUDGET`, with no
 * dependence on how large the stored payloads are.
 */
async function loadToolCalls(
	messageIds: string[],
	includeToolIO: boolean,
): Promise<ExportToolRow[]> {
	if (messageIds.length === 0) return [];
	const meta = await loadToolCallMeta(messageIds);
	if (meta.length === 0) return [];

	// Without tool IO there is nothing to budget: no body is ever read.
	const allowed = includeToolIO ? selectToolBodyIds(meta) : new Set<string>();
	const bodies = new Map<string, { input: string | null; output: string | null }>();
	if (allowed.size > 0) {
		const bodyRows = await db
			.select({
				id: narratorToolCalls.id,
				input: sql<
					string | null
				>`substr(CAST(${narratorToolCalls.inputJson} AS TEXT), 1, ${EXPORT_TOOL_FIELD_LIMIT})`,
				output: sql<
					string | null
				>`substr(CAST(${narratorToolCalls.outputJson} AS TEXT), 1, ${EXPORT_TOOL_FIELD_LIMIT})`,
			})
			.from(narratorToolCalls)
			// Keyed by primary key, and the key set is what the budget just approved,
			// so this select cannot return more than the budget's worth of characters.
			.where(inArray(narratorToolCalls.id, [...allowed]))
			.limit(allowed.size);
		for (const row of bodyRows) bodies.set(row.id, { input: row.input, output: row.output });
	}

	return meta.map((row) => {
		const body = bodies.get(row.id);
		return {
			id: row.id,
			messageId: row.messageId,
			toolUseId: row.toolUseId,
			toolName: row.toolName,
			status: row.status,
			durationMs: row.durationMs,
			errorMessage: row.errorMessage,
			errorBytes: row.errorBytes,
			createdAt: row.createdAt,
			rank: row.rank,
			toolCallsForMessage: row.toolCallsForMessage,
			input: body?.input ?? null,
			output: body?.output ?? null,
			inputBytes: row.inputBytes,
			outputBytes: row.outputBytes,
			// Not "there was nothing to show": the bodies exist and were withheld.
			// Only claimed when tool IO was requested at all, so an export that opted
			// out is not labelled as having hit a budget it never spent.
			ioOmitted:
				includeToolIO && !allowed.has(row.id) && (row.inputBytes > 0 || row.outputBytes > 0),
		};
	});
}

const CHILD_MESSAGE_COLUMNS = {
	id: narratorMessages.id,
	role: narratorMessages.role,
	model: narratorMessages.model,
	provider: narratorMessages.provider,
	origin: narratorMessages.origin,
	originLabel: narratorMessages.originLabel,
	createdAt: narratorMessages.createdAt,
	editedAt: narratorMessages.editedAt,
	tokensIn: narratorMessages.tokensIn,
	outputTokens: narratorMessages.outputTokens,
	costUsd: narratorMessages.costUsd,
	parentToolUseId: narratorMessages.parentToolUseId,
} as const;

/**
 * Subagent messages for a page, with their content clamped inside SQLite.
 *
 * `content_json` is as unbounded as a tool body — a subagent turn carries the same
 * kind of payload — so a count-only cap (`EXPORT_CHILD_MESSAGES_PER_PAGE`) left
 * this read effectively unlimited in bytes. Both content columns are now
 * `substr`-projected and their untruncated lengths come back alongside.
 *
 * `content_json` is deliberately read as TEXT rather than through Drizzle's `json`
 * mode: a clamped JSON document does not parse, and `json` mode would throw while
 * mapping the row. Parsing is done here instead, and a row whose JSON was clamped
 * falls back to its `content_text` excerpt — a labelled excerpt is worth more than
 * a hard failure, and far more than silently dropping the message.
 */
async function loadChildMessages(toolUseIds: string[]): Promise<ExportMessageRow[]> {
	if (toolUseIds.length === 0) return [];
	const rows = await db
		.select({
			...CHILD_MESSAGE_COLUMNS,
			contentJsonText: sql<
				string | null
			>`substr(CAST(${narratorMessages.contentJson} AS TEXT), 1, ${EXPORT_CHILD_CONTENT_LIMIT})`,
			contentTextExcerpt: sql<
				string | null
			>`substr(${narratorMessages.contentText}, 1, ${EXPORT_CHILD_CONTENT_LIMIT})`,
			contentJsonBytes: sql<number>`length(COALESCE(CAST(${narratorMessages.contentJson} AS TEXT), ''))`,
			contentTextBytes: sql<number>`length(COALESCE(${narratorMessages.contentText}, ''))`,
		})
		.from(narratorMessages)
		.where(inArray(narratorMessages.parentToolUseId, toolUseIds))
		.orderBy(narratorMessages.createdAt)
		// One over the cap: enough to know more exist without reading them all.
		.limit(EXPORT_CHILD_MESSAGES_PER_PAGE + 1);

	return rows.map((row) => {
		const { contentJsonText, contentTextExcerpt, contentJsonBytes, contentTextBytes, ...rest } =
			row;
		const jsonClamped = contentJsonBytes > EXPORT_CHILD_CONTENT_LIMIT;
		const textClamped = contentTextBytes > EXPORT_CHILD_CONTENT_LIMIT;
		let contentJson: unknown = null;
		if (!jsonClamped && contentJsonText) {
			try {
				contentJson = JSON.parse(contentJsonText);
			} catch {
				// A row whose JSON is invalid for reasons other than clamping still has
				// its text form; treating it as absent lets the fallback take over.
				contentJson = null;
			}
		}
		return {
			...rest,
			contentJson,
			contentText: contentTextExcerpt,
			contentTruncated: jsonClamped || textClamped,
			contentBytes: Math.max(contentJsonBytes, contentTextBytes),
		} satisfies ExportMessageRow;
	});
}

/**
 * Assemble one page into export messages.
 *
 * The tool-body budget is NOT decided here — `loadToolCalls` spent it before SQL
 * returned, which is the only place it can be enforced. What is left is
 * bookkeeping: turning the row-level facts (`ioOmitted`, the projected lengths,
 * the per-message total) into flags the renderers can announce.
 *
 * Exported for tests: this bookkeeping is the part most worth pinning down, and it
 * is pure given the loaded rows.
 */
export function assemblePage(
	refs: ExportRefRow[],
	messages: Map<string, ExportMessageRow>,
	toolRows: ExportToolRow[],
	childRows: ExportMessageRow[],
	includeToolIO: boolean,
	stats: TruncationStats,
): ExportMessage[] {
	const childrenByTool = new Map<string, ExportMessageRow[]>();
	for (const child of childRows) {
		if (!child.parentToolUseId) continue;
		if (child.contentTruncated) stats.childMessagesTruncated += 1;
		const list = childrenByTool.get(child.parentToolUseId);
		if (list) list.push(child);
		else childrenByTool.set(child.parentToolUseId, [child]);
	}

	const toolsByMessage = new Map<string, ExportToolRow[]>();
	for (const row of toolRows) {
		if (!row.messageId) continue;
		const list = toolsByMessage.get(row.messageId);
		if (list) list.push(row);
		else toolsByMessage.set(row.messageId, [row]);
	}

	let pageOmittedIO = false;
	const page: ExportMessage[] = [];

	for (const ref of refs) {
		const row = messages.get(ref.messageId);
		if (!row) continue;

		// SQL returns the page's calls breadth-first across messages (see
		// `loadToolCallMeta`), so a message's own calls have to be put back in their
		// original order before rendering.
		const allTools = [...(toolsByMessage.get(row.id) ?? [])].sort(
			(a, b) =>
				(a.rank ?? 0) - (b.rank ?? 0) ||
				a.createdAt.localeCompare(b.createdAt) ||
				a.id.localeCompare(b.id),
		);
		// Keep the earliest calls: a message's first tool uses are the ones its
		// text refers to, so dropping from the newest end degrades most gracefully.
		const kept = allTools.slice(0, EXPORT_TOOL_CALLS_PER_MESSAGE);
		// `toolCallsForMessage` counts the whole partition in SQL, so it still sees
		// the calls that were never fetched; `allTools.length` only ever sees what
		// arrived. Preferring the former is what makes the omission count exact
		// rather than an underestimate.
		const totalTools = Math.max(allTools[0]?.toolCallsForMessage ?? 0, allTools.length);
		const toolCallsOmitted = totalTools - kept.length;
		if (toolCallsOmitted > 0) stats.toolCallsOmitted += toolCallsOmitted;

		const toolCalls: ExportToolCall[] = kept.map((tool) => {
			const inputTruncated = includeToolIO && tool.inputBytes > EXPORT_TOOL_FIELD_LIMIT;
			const outputTruncated = includeToolIO && tool.outputBytes > EXPORT_TOOL_FIELD_LIMIT;
			if (tool.ioOmitted) pageOmittedIO = true;
			// A withheld body was never truncated — it was not exported at all, and
			// `ioOmitted` says so. Counting it here too would double-report it.
			if (!tool.ioOmitted && inputTruncated) stats.toolFieldsTruncated += 1;
			if (!tool.ioOmitted && outputTruncated) stats.toolFieldsTruncated += 1;
			const errorTruncated = (tool.errorBytes ?? 0) > EXPORT_TOOL_ERROR_LIMIT;
			if (errorTruncated) stats.toolFieldsTruncated += 1;

			return {
				toolUseId: tool.toolUseId,
				toolName: tool.toolName,
				status: tool.status,
				durationMs: tool.durationMs,
				errorMessage: tool.errorMessage,
				errorTruncated,
				errorBytes: tool.errorBytes ?? 0,
				input: tool.ioOmitted ? null : tool.input,
				output: tool.ioOmitted ? null : tool.output,
				inputTruncated: !tool.ioOmitted && inputTruncated,
				outputTruncated: !tool.ioOmitted && outputTruncated,
				inputBytes: tool.inputBytes,
				outputBytes: tool.outputBytes,
				ioOmitted: tool.ioOmitted,
				children: childrenByTool.get(tool.toolUseId) ?? [],
			};
		});

		page.push({
			seq: ref.seq,
			row,
			isCompactMarker: ref.isCompact === 1,
			folded: ref.folded,
			toolCalls,
			toolCallsOmitted,
		});
	}

	if (pageOmittedIO) stats.pagesWithIoOmitted += 1;
	return page;
}

// ── Labels ─────────────────────────────────────────────────────────────────

type LabelKey =
	| "roleUser"
	| "roleAssistant"
	| "roleSystem"
	| "roleInfo"
	| "thinking"
	| "input"
	| "output"
	| "error"
	| "subagent"
	| "compactPoint"
	| "summary"
	| "folded"
	| "narratorId"
	| "model"
	| "createdAt"
	| "exportedAt"
	| "scopeFull"
	| "scopeVisible"
	| "withToolIO"
	| "withoutToolIO"
	| "truncatedBytes"
	| "toolCallsOmitted"
	| "ioOmitted"
	| "statsHeading"
	| "statsMessages"
	| "statsToolFieldsTruncated"
	| "statsToolCallsOmitted"
	| "statsPagesWithIoOmitted"
	| "statsChildMessagesOmitted"
	| "statsChildMessagesTruncated"
	| "earlierHistoryOmitted"
	| "complete"
	| "incomplete";

const LABELS: Record<NarratorExportLang, Record<LabelKey, string>> = {
	en: {
		roleUser: "User",
		roleAssistant: "Assistant",
		roleSystem: "System",
		roleInfo: "Context",
		thinking: "Thinking",
		input: "Input",
		output: "Output",
		error: "Error",
		subagent: "Subagent messages",
		compactPoint: "History compacted",
		summary: "Summary",
		folded: "folded",
		narratorId: "Narrator ID",
		model: "Model",
		createdAt: "Created",
		exportedAt: "Exported",
		scopeFull: "full history",
		scopeVisible: "currently visible history only",
		withToolIO: "with tool call details",
		withoutToolIO: "without tool call details",
		truncatedBytes: "truncated, {bytes} bytes original",
		toolCallsOmitted: "{count} more tool call(s) not exported",
		ioOmitted: "tool body omitted: page budget reached",
		statsHeading: "Export summary",
		statsMessages: "Messages",
		statsToolFieldsTruncated: "Truncated tool fields",
		statsToolCallsOmitted: "Omitted tool calls",
		statsPagesWithIoOmitted: "Pages over the tool body budget",
		// "at least": the query reads one row past the cap, which proves more exist
		// without revealing how many. Counting them exactly would need the very
		// unbounded read the cap is there to prevent.
		statsChildMessagesOmitted: "Omitted subagent messages (at least)",
		statsChildMessagesTruncated: "Truncated subagent messages",
		earlierHistoryOmitted:
			"**This is not the full history.** Messages older than the most recent compact point were not exported. Re-export with the full-history option to include them.",
		complete: "Export complete.",
		incomplete: "**Export incomplete** — it stopped early: {reason}",
	},
	"zh-CN": {
		roleUser: "用户",
		roleAssistant: "助手",
		roleSystem: "系统",
		roleInfo: "上下文",
		thinking: "思考",
		input: "输入",
		output: "输出",
		error: "错误",
		subagent: "子代理消息",
		compactPoint: "历史压缩点",
		summary: "摘要",
		folded: "已折叠",
		narratorId: "叙述者 ID",
		model: "模型",
		createdAt: "创建于",
		exportedAt: "导出于",
		scopeFull: "完整历史",
		scopeVisible: "仅当前界面可见的历史",
		withToolIO: "含工具调用详情",
		withoutToolIO: "不含工具调用详情",
		truncatedBytes: "已截断，原始 {bytes} 字节",
		toolCallsOmitted: "另有 {count} 个工具调用未导出",
		ioOmitted: "工具正文已省略：本页预算用尽",
		statsHeading: "导出统计",
		statsMessages: "消息数",
		statsToolFieldsTruncated: "被截断的工具字段",
		statsToolCallsOmitted: "被省略的工具调用",
		statsPagesWithIoOmitted: "超出工具正文预算的页数",
		statsChildMessagesOmitted: "被省略的子代理消息（至少）",
		statsChildMessagesTruncated: "被截断的子代理消息",
		earlierHistoryOmitted:
			"**这不是完整历史。** 最近一次压缩点之前的消息未被导出。如需包含，请勾选完整历史选项重新导出。",
		complete: "导出完成。",
		incomplete: "**导出未完成** —— 提前结束：{reason}",
	},
};

function label(lang: NarratorExportLang, key: LabelKey, params?: Record<string, string | number>) {
	let text = LABELS[lang][key];
	if (params) {
		for (const [name, value] of Object.entries(params)) {
			text = text.replaceAll(`{${name}}`, String(value));
		}
	}
	return text;
}

function roleLabel(lang: NarratorExportLang, role: string): string {
	switch (role) {
		case "user":
			return label(lang, "roleUser");
		case "assistant":
			return label(lang, "roleAssistant");
		case "system":
			return label(lang, "roleSystem");
		default:
			// "sys" (injected model-visible context) and "disp" (display-only).
			return label(lang, "roleInfo");
	}
}

// ── Markdown rendering ─────────────────────────────────────────────────────

/**
 * Pick a fence long enough to survive the content.
 *
 * Tool output frequently contains fenced code of its own; a fixed ``` fence
 * would end the block early and, inside `<details>`, break the whole structure.
 * CommonMark lets a fence be closed only by a run at least as long, so we take
 * one more backtick than the longest run present.
 */
export function fenceFor(content: string): string {
	let longest = 0;
	for (const run of content.match(/`+/g) ?? []) {
		if (run.length > longest) longest = run.length;
	}
	return "`".repeat(Math.max(3, longest + 1));
}

export function codeBlock(content: string, lang = ""): string {
	const fence = fenceFor(content);
	// A trailing newline keeps the closing fence on its own line even when the
	// content does not end with one.
	const body = content.endsWith("\n") ? content : `${content}\n`;
	return `${fence}${lang}\n${body}${fence}`;
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** Prefix every line with `> ` so nested content stays inside one blockquote. */
function blockquote(text: string): string {
	return text
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n");
}

/**
 * `<details>` needs blank lines around its body, otherwise GitHub and
 * CommonMark render the inner Markdown as literal text.
 */
function details(summary: string, body: string): string {
	return `<details>\n<summary>${escapeHtml(summary)}</summary>\n\n${body}\n\n</details>`;
}

function formatTimestamp(value: string | null | undefined): string {
	if (!value) return "—";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toISOString().replace("T", " ").slice(0, 16);
}

function prettyJson(raw: string): string {
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}

// biome-ignore lint/suspicious/noExplicitAny: content blocks are dynamic SDK JSON
function contentBlocks(contentJson: any): any[] {
	return Array.isArray(contentJson) ? contentJson : [];
}

function renderMessageBody(row: ExportMessageRow, lang: NarratorExportLang): string {
	const parts: string[] = [];
	for (const block of contentBlocks(row.contentJson)) {
		if (!block || typeof block !== "object") continue;
		const compact = parseCompactMessageBlock(block);
		if (compact) {
			const summary = compact.summary?.trim();
			parts.push(
				blockquote(
					`**[${label(lang, "compactPoint")}]**${
						summary ? `\n\n${label(lang, "summary")}: ${summary}` : ""
					}`,
				),
			);
			continue;
		}
		switch (block.type) {
			case "text": {
				const text = typeof block.text === "string" ? block.text.trim() : "";
				if (text) parts.push(text);
				break;
			}
			case "thinking": {
				const thinking = typeof block.thinking === "string" ? block.thinking.trim() : "";
				if (thinking) parts.push(details(label(lang, "thinking"), thinking));
				break;
			}
			case "image": {
				const imageId = typeof block.imageId === "string" ? block.imageId : "?";
				parts.push(`_[image: \`${imageId}\`]_`);
				break;
			}
			// tool_use blocks are rendered from narrator_tool_calls, which carries
			// the result and timing that the content block alone lacks.
			default:
				break;
		}
	}
	if (parts.length === 0 && row.contentText?.trim()) parts.push(row.contentText.trim());
	return parts.join("\n\n");
}

function renderToolCall(tool: ExportToolCall, lang: NarratorExportLang): string {
	const heading = [
		tool.toolName,
		tool.status,
		tool.durationMs != null ? `${tool.durationMs}ms` : null,
	]
		.filter(Boolean)
		.join(" · ");

	const sections: string[] = [];
	if (tool.ioOmitted) {
		sections.push(`_${label(lang, "ioOmitted")}_`);
	} else {
		if (tool.input) {
			const note = tool.inputTruncated
				? `\n\n_[${label(lang, "truncatedBytes", { bytes: tool.inputBytes })}]_`
				: "";
			sections.push(
				`${label(lang, "input")}:\n\n${codeBlock(prettyJson(tool.input), "json")}${note}`,
			);
		}
		if (tool.output) {
			const note = tool.outputTruncated
				? `\n\n_[${label(lang, "truncatedBytes", { bytes: tool.outputBytes })}]_`
				: "";
			sections.push(`${label(lang, "output")}:\n\n${codeBlock(prettyJson(tool.output))}${note}`);
		}
	}
	if (tool.errorMessage) {
		const note = tool.errorTruncated
			? ` _[${label(lang, "truncatedBytes", { bytes: tool.errorBytes })}]_`
			: "";
		sections.push(`${label(lang, "error")}: ${tool.errorMessage}${note}`);
	}
	if (tool.children.length > 0) {
		const childText = tool.children
			.map((child) => {
				const body = renderMessageBody(child, lang);
				// A clamped child body is an excerpt, and says so where it is read
				// rather than only in the footer totals.
				const note = child.contentTruncated
					? `\n\n_[${label(lang, "truncatedBytes", { bytes: child.contentBytes ?? 0 })}]_`
					: "";
				return `**${roleLabel(lang, child.role)}**${body ? `\n\n${body}` : ""}${note}`;
			})
			.join("\n\n");
		sections.push(`${label(lang, "subagent")}:\n\n${blockquote(childText)}`);
	}

	return details(heading, sections.join("\n\n") || "—");
}

function renderMessage(message: ExportMessage, lang: NarratorExportLang): string {
	const meta = [
		roleLabel(lang, message.row.role),
		formatTimestamp(message.row.createdAt),
		message.row.model || null,
		message.folded ? label(lang, "folded") : null,
	].filter(Boolean);

	const sections = [`## ${meta.join(" · ")}`];
	const body = renderMessageBody(message.row, lang);
	if (body) sections.push(body);
	for (const tool of message.toolCalls) sections.push(renderToolCall(tool, lang));
	if (message.toolCallsOmitted > 0) {
		sections.push(`_[${label(lang, "toolCallsOmitted", { count: message.toolCallsOmitted })}]_`);
	}
	return `${sections.join("\n\n")}\n\n`;
}

// ── JSON rendering ─────────────────────────────────────────────────────────

function jsonMessage(message: ExportMessage, includeToolIO: boolean) {
	return {
		seq: message.seq,
		id: message.row.id,
		role: message.row.role,
		origin: message.row.origin,
		originLabel: message.row.originLabel,
		createdAt: message.row.createdAt,
		editedAt: message.row.editedAt,
		model: message.row.model,
		provider: message.row.provider,
		tokensIn: message.row.tokensIn,
		outputTokens: message.row.outputTokens,
		costUsd: message.row.costUsd,
		isCompactMarker: message.isCompactMarker,
		folded: message.folded,
		content: contentBlocks(message.row.contentJson),
		toolCalls: message.toolCalls.map((tool) => ({
			toolUseId: tool.toolUseId,
			toolName: tool.toolName,
			status: tool.status,
			durationMs: tool.durationMs,
			errorMessage: tool.errorMessage,
			errorTruncated: tool.errorTruncated,
			errorBytes: tool.errorBytes,
			...(includeToolIO
				? {
						input: tool.input,
						output: tool.output,
						inputTruncated: tool.inputTruncated,
						outputTruncated: tool.outputTruncated,
						inputBytes: tool.inputBytes,
						outputBytes: tool.outputBytes,
						ioOmitted: tool.ioOmitted,
					}
				: {}),
			subagentMessages: tool.children.map((child) => ({
				id: child.id,
				role: child.role,
				createdAt: child.createdAt,
				model: child.model,
				// A clamped `content_json` did not survive as blocks, so the excerpt
				// travels as text and the flags say which one a reader is holding.
				content: contentBlocks(child.contentJson),
				contentText: child.contentText,
				contentTruncated: child.contentTruncated === true,
				contentBytes: child.contentBytes ?? 0,
			})),
		})),
		toolCallsOmitted: message.toolCallsOmitted,
	};
}

// ── File naming ────────────────────────────────────────────────────────────

/**
 * Build a download filename from a narrator title.
 *
 * Two names are produced because the title may contain CJK, quotes or (in a
 * corrupted row) control characters, and `Content-Disposition` is a header:
 * `ascii` is a conservative fallback, `utf8` feeds RFC 5987 `filename*`. CR/LF
 * and quotes are stripped from both so a title can never inject a header.
 */
export function buildExportFileName(
	title: string | null | undefined,
	format: NarratorExportFormat,
	now = new Date(),
): { ascii: string; utf8: string } {
	const ext = format === "json" ? "json" : "md";
	const stamp = now.toISOString().replace(/[:-]/g, "").replace("T", "-").slice(0, 13);

	// Control characters, quotes, backslashes and path separators are removed
	// because this string ends up inside a `Content-Disposition` header and, on the
	// client, as a filename. Matching them is the whole point of these patterns, so
	// the control-character rule is suppressed on the exact lines that need it.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the intent
	const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f"'\\/:*?<>|\r\n]/g;
	// Negated printable range: keeps only ASCII 0x20-0x7e, so control characters
	// are excluded by construction rather than enumerated.
	const NON_ASCII_PRINTABLE = /[^\x20-\x7e]/g;

	const cleanedUtf8 =
		(title ?? "").replace(UNSAFE_NAME_CHARS, " ").trim().replace(/\s+/g, "-").slice(0, 60) ||
		"narrator";

	const cleanedAscii =
		cleanedUtf8
			.replace(NON_ASCII_PRINTABLE, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "narrator";

	return {
		ascii: `narrafork-${cleanedAscii}-${stamp}.${ext}`,
		utf8: `narrafork-${cleanedUtf8}-${stamp}.${ext}`,
	};
}

// ── Stream ─────────────────────────────────────────────────────────────────

/**
 * Narrator-level metadata for the file head.
 *
 * There is deliberately no `provider` here: `narrators` has no such column (the
 * effective provider is resolved per turn from settings), and each exported
 * message already carries the provider that actually served it.
 */
export interface NarratorExportHeader {
	id: string;
	title: string | null;
	status: string | null;
	variant: string | null;
	model: string | null;
	cwd: string | null;
	chapterId: string | null;
	parentNarratorId: string | null;
	createdAt: string | null;
}

async function loadHeader(
	narratorId: string,
): Promise<NarratorExportHeader & { isSubagent: boolean }> {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: {
			id: true,
			title: true,
			status: true,
			variant: true,
			model: true,
			cwd: true,
			chapterId: true,
			parentNarratorId: true,
			createdAt: true,
		},
	});
	if (!row) throw new Error(`Narrator not found: ${narratorId}`);
	return {
		id: row.id,
		title: row.title ?? null,
		status: row.status ?? null,
		variant: row.variant ?? null,
		model: row.model ?? null,
		cwd: row.cwd ?? null,
		chapterId: row.chapterId ?? null,
		parentNarratorId: row.parentNarratorId ?? null,
		createdAt: row.createdAt ?? null,
		isSubagent: isSubagentVariant(row.variant),
	};
}

function markdownHeader(
	header: NarratorExportHeader,
	options: NarratorExportOptions,
	exportedAt: string,
	earlierHistoryOmitted: boolean,
): string {
	const { lang } = options;
	const scopeText = label(lang, options.scope === "visible" ? "scopeVisible" : "scopeFull");
	const ioText = label(lang, options.includeToolIO ? "withToolIO" : "withoutToolIO");
	const lines = [
		`# ${header.title?.trim() || header.id}`,
		"",
		`- ${label(lang, "narratorId")}: \`${header.id}\``,
		`- ${label(lang, "model")}: ${header.model || "—"}`,
		`- ${label(lang, "createdAt")}: ${formatTimestamp(header.createdAt)}`,
		`- ${label(lang, "exportedAt")}: ${formatTimestamp(exportedAt)} · ${scopeText} · ${ioText}`,
		"",
		// Only shown when history was genuinely left out, so it stays a real signal
		// rather than boilerplate readers learn to skip.
		...(earlierHistoryOmitted ? [`> ${label(lang, "earlierHistoryOmitted")}`, ""] : []),
		"---",
		"",
	];
	return lines.join("\n");
}

function markdownFooter(
	stats: TruncationStats,
	messageCount: number,
	lang: NarratorExportLang,
	failure: string | null,
): string {
	const lines = [
		"---",
		"",
		`### ${label(lang, "statsHeading")}`,
		"",
		`- ${label(lang, "statsMessages")}: ${messageCount}`,
		`- ${label(lang, "statsToolFieldsTruncated")}: ${stats.toolFieldsTruncated}`,
		`- ${label(lang, "statsToolCallsOmitted")}: ${stats.toolCallsOmitted}`,
		`- ${label(lang, "statsPagesWithIoOmitted")}: ${stats.pagesWithIoOmitted}`,
		// Both of these were tracked but never disclosed, which made the module's
		// "every truncation is labelled" claim false for subagent content.
		`- ${label(lang, "statsChildMessagesOmitted")}: ${stats.childMessagesOmitted}`,
		`- ${label(lang, "statsChildMessagesTruncated")}: ${stats.childMessagesTruncated}`,
		"",
		// Repeated from the header: whoever scrolls to the end to check the stats is
		// exactly the reader deciding whether this file is the whole story.
		...(stats.earlierHistoryOmitted ? [`> ${label(lang, "earlierHistoryOmitted")}`, ""] : []),
		failure ? label(lang, "incomplete", { reason: failure }) : label(lang, "complete"),
		"",
	];
	return lines.join("\n");
}

/**
 * Stream the transcript as a sequence of string chunks.
 *
 * Failure contract: a mid-stream error is caught, not rethrown. Both formats are
 * closed off properly and marked incomplete — JSON stays parseable with
 * `"complete": false` plus an `error` object, Markdown gets an explicit "export
 * incomplete" footer. Rethrowing would leave a JSON file that cannot be parsed
 * at all while the browser still reported a successful download.
 *
 * A client disconnect is different: the caller aborts the signal, paging stops,
 * and whatever reached the disk is truncated at an arbitrary point. That is
 * detectable (no sentinel / parse failure) and nothing further can be written to
 * a closed connection anyway.
 */
export async function* streamNarratorExport(
	narratorId: string,
	options: NarratorExportOptions,
	signal?: AbortSignal,
): AsyncGenerator<string> {
	const exportedAt = new Date().toISOString();
	const stats: TruncationStats = {
		toolFieldsTruncated: 0,
		toolCallsOmitted: 0,
		pagesWithIoOmitted: 0,
		childMessagesOmitted: 0,
		childMessagesTruncated: 0,
		earlierHistoryOmitted: false,
	};
	const isJson = options.format === "json";
	let messageCount = 0;
	let failure: string | null = null;
	let lastSeq = 0;

	const header = await loadHeader(narratorId);

	// Scope is resolved BEFORE the header is written, because a "this starts partway
	// in" notice belongs at the top of the file where it will actually be read, not
	// only in a footer after thousands of messages.
	//
	// It is guarded because it now runs outside the paging try-block: letting an
	// error escape here would abandon the response before a single byte, so the
	// client would get a truncated file with no explanation instead of the
	// parseable "incomplete" document the failure contract promises.
	// biome-ignore lint/suspicious/noExplicitAny: drizzle SQL predicate union
	let scopeClause: any = null;
	let latestCompactSeq: number | null = null;
	try {
		scopeClause = await buildRefScope(narratorId, options.scope);
		latestCompactSeq = options.scope === "visible" ? await loadLatestCompactSeq(narratorId) : null;
		if (latestCompactSeq != null) {
			stats.earlierHistoryOmitted = await hasHistoryBelow(
				scopeClause,
				latestCompactSeq,
				header.isSubagent,
			);
		}
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		logger.error("Narrator export failed while resolving scope", {
			narratorId,
			scope: options.scope,
			error: failure,
		});
	}

	if (isJson) {
		yield `{\n"narrafork": ${JSON.stringify({
			exportVersion: 1,
			exportedAt,
			options,
			earlierHistoryOmitted: stats.earlierHistoryOmitted,
			completenessRule:
				'This export is complete only if the top-level "complete" field is true. A file without it (or one that fails to parse) was cut short.',
			...(stats.earlierHistoryOmitted
				? {
						scopeNote:
							'scope="visible" was used: messages older than the most recent compact point are NOT in this file. Re-export with scope="full" for the complete history.',
					}
				: {}),
		})},\n"narrator": ${JSON.stringify(header)},\n"messages": [`;
	} else {
		yield markdownHeader(header, options, exportedAt, stats.earlierHistoryOmitted);
	}

	try {
		// A scope that failed to resolve has no usable predicate; skip paging and let
		// the tail report the failure rather than querying with a null clause.
		if (failure != null) throw new Error(failure);

		const seenMessageIds = new Set<string>();
		let cursor: { seq: number; refId: string } | null = null;
		let first = true;

		for (;;) {
			if (signal?.aborted) return;
			const pageStart = Date.now();

			const refs = await loadRefPage(scopeClause, cursor, latestCompactSeq, header.isSubagent);
			if (refs.length === 0) break;
			const lastRef = refs[refs.length - 1];
			cursor = { seq: lastRef.seq, refId: lastRef.refId };
			lastSeq = lastRef.seq;

			// The same message can be reachable through both the narrator's own ref
			// and an ancestor's, and an inherited ref keeps the ancestor's original
			// seq — so the two copies can land in the SAME page with equal seq. The
			// seen-set therefore has to be updated as we walk, not after filtering:
			// a batch filter would let both copies through on their first page.
			const fresh: ExportRefRow[] = [];
			for (const ref of refs) {
				if (seenMessageIds.has(ref.messageId)) continue;
				seenMessageIds.add(ref.messageId);
				fresh.push(ref);
			}

			if (fresh.length > 0) {
				const messageIds = fresh.map((ref) => ref.messageId);
				const [messages, toolRows] = await Promise.all([
					loadMessages(messageIds),
					loadToolCalls(messageIds, options.includeToolIO),
				]);
				const toolUseIds = toolRows.map((row) => row.toolUseId).filter(Boolean);
				// A subagent transcript is already the child level; descending again
				// would recurse without bound.
				const childRows = header.isSubagent ? [] : await loadChildMessages(toolUseIds);
				if (childRows.length > EXPORT_CHILD_MESSAGES_PER_PAGE) {
					stats.childMessagesOmitted += childRows.length - EXPORT_CHILD_MESSAGES_PER_PAGE;
					childRows.length = EXPORT_CHILD_MESSAGES_PER_PAGE;
				}

				const page = assemblePage(
					fresh,
					messages,
					toolRows,
					childRows,
					options.includeToolIO,
					stats,
				);

				for (const message of page) {
					if (isJson) {
						yield `${first ? "\n" : ",\n"}${JSON.stringify(jsonMessage(message, options.includeToolIO))}`;
						first = false;
					} else {
						yield renderMessage(message, options.lang);
					}
					messageCount += 1;
				}
			}

			const elapsed = Date.now() - pageStart;
			if (elapsed > SLOW_PAGE_MS) {
				logger.warn("Slow narrator export page", {
					narratorId,
					untilSeq: lastSeq,
					refs: refs.length,
					elapsedMs: elapsed,
				});
			}

			if (refs.length < EXPORT_PAGE_REFS) break;
			// Hand the event loop back so a long export cannot stall other requests.
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		logger.error("Narrator export failed mid-stream", {
			narratorId,
			afterSeq: lastSeq,
			messageCount,
			error: failure,
		});
	}

	if (isJson) {
		const tail = {
			truncation: stats,
			messageCount,
			partial: failure != null,
			...(failure ? { error: { message: failure, afterSeq: lastSeq } } : {}),
			complete: failure == null,
		};
		// `complete` is serialized last on purpose: it doubles as the end sentinel.
		yield `\n],\n${Object.entries(tail)
			.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
			.join(",\n")}\n}\n`;
	} else {
		yield markdownFooter(stats, messageCount, options.lang, failure);
	}
}

export const narratorExportService = {
	streamNarratorExport,
	buildExportFileName,
};
