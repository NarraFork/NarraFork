/**
 * narrator-timeline.ts — per-turn, per-agent continuous timelines.
 *
 * Every read is bounded and cheap on the HTTP thread:
 *   - row-heavy reads (`narrator_tool_calls`, `api_requests`) run on the read-worker pool,
 *     keyset-paged over (narrator_id, created_at) indexes so each page stays inside the
 *     worker's per-result byte budget whatever the row contents;
 *   - they select timing stamps only. Summary hints are pulled from `input_json` solely when
 *     `octet_length` (answered from the record header, no overflow pages) says the input is
 *     small; large or legacy inputs fall back to `resolved_file_path` / the child's title;
 *   - point lookups (turn row, children by `origin_tool_call_id`, last message by index) stay
 *     inline, where a worker round trip would cost more than the query;
 *   - a response holds at most {@link MAX_LANES} lanes of at most {@link MAX_ROWS_PER_SOURCE}
 *     rows per source, and only the item details its segments reference, so its size follows
 *     the (capped) segment count rather than the history; concurrent requests for the same
 *     turn share one build.
 *
 * The partition itself is the shared pure function in `@shared/narrator-timeline`.
 */

import { db } from "@server/db";
import {
	apiRequests,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorTurns,
} from "@server/db/schema";
import { readQuery } from "@server/db/worker-read";
import { redactExecutionLogText } from "@server/lib/execution-log-redaction";
import { logger } from "@server/lib/logger";
import {
	partitionTimeline,
	type TimelineInterval,
	type TimelineItem,
	type TimelineLane,
	type TimelineModelItem,
	type TimelineToolItem,
	type TimelineTurnStatus,
	type TimelineTurnSummary,
	type TimelineTurnsResponse,
	type TurnTimelineResponse,
} from "@shared/narrator-timeline";
import {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	lte,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { summarizeSubagentToolCall } from "./subagent-activity";

export const MAX_TURNS_PAGE = 50;
export const MAX_ROWS_PER_SOURCE = 2000;
export const MAX_LANES = 16;
export const MAX_CHILDREN_PER_LANE = 20;
export const MAX_DEPTH = 2;
/** Inputs above this many bytes are never parsed for summary hints. */
export const SUMMARY_SOURCE_MAX_BYTES = 16 * 1024;
const SUMMARY_FIELD_MAX_LENGTH = 160;
/**
 * Worst case per tool row: 13 hints × 160 chars + a 300-char error, at 4 UTF-8 bytes each,
 * about 10 KB. 300 rows stay under the worker's 4 MB result budget; model rows are ~1.5 KB.
 */
const TOOL_PAGE_ROWS = 300;
const MODEL_PAGE_ROWS = 1000;
const READ_TIMEOUT_MS = 10_000;
/** Sibling lanes built at once; each issues two reads, so at most four are in flight. */
const LANE_CONCURRENCY = 2;
const SLOW_BUILD_MS = 1000;
const TRIGGER_EXCERPT_LENGTH = 80;

/** Tools whose permission window is a question/approval addressed to the user. */
const USER_REPLY_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
/** Tools whose execution window is the agent waiting on another agent. */
const SUBAGENT_WAIT_TOOLS = new Set(["Agent", "Task", "Await"]);
/** Tools that create a child narrator (`narrators.origin_tool_call_id`). */
const SPAWN_TOOLS = new Set(["Agent", "Task"]);
const MAX_SPAWN_LOOKUPS = 200;

function inputHint(path: string) {
	const input = narratorToolCalls.inputJson;
	return sql<string | null>`CASE
		WHEN octet_length(${input}) <= ${SUMMARY_SOURCE_MAX_BYTES} AND json_valid(${input})
		THEN substr(CAST(json_extract(${input}, ${path}) AS TEXT), 1, ${SUMMARY_FIELD_MAX_LENGTH})
	END`;
}

const SUMMARY_HINT_COLUMNS = {
	description: inputHint("$.description"),
	filePath: inputHint("$.file_path"),
	path: inputHint("$.path"),
	pattern: inputHint("$.pattern"),
	query: inputHint("$.query"),
	url: inputHint("$.url"),
	mode: inputHint("$.mode"),
	action: inputHint("$.action"),
	targetId: inputHint("$.id"),
	targetName: inputHint("$.name"),
	awaitType: inputHint("$.type"),
	subagentTypeHint: inputHint("$.subagent_type"),
	skillName: inputHint("$.skill"),
	questionHeader: inputHint("$.questions[0].header"),
	resolvedFilePath: sql<
		string | null
	>`substr(${narratorToolCalls.resolvedFilePath}, 1, ${SUMMARY_FIELD_MAX_LENGTH})`,
} as const;

type SummaryHintRow = { [K in keyof typeof SUMMARY_HINT_COLUMNS]: string | null };

function buildSummary(toolName: string, row: SummaryHintRow): string | null {
	const summary = summarizeSubagentToolCall(toolName, {
		description: row.description,
		filePath: row.filePath ?? row.resolvedFilePath,
		path: row.path,
		pattern: row.pattern,
		query: row.query,
		url: row.url,
		mode: row.mode,
		action: row.action,
		targetId: row.targetId,
		targetName: row.targetName,
		awaitType: row.awaitType,
		subagentType: row.subagentTypeHint,
		skillName: row.skillName,
		questionHeader: row.questionHeader,
	});
	return summary ? redactExecutionLogText(summary) : null;
}

function parseMs(value: string | null | undefined): number | null {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

function toIso(ms: number): string {
	return new Date(ms).toISOString();
}

function excerpt(text: string | null): string | null {
	if (!text) return null;
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized ? normalized.slice(0, TRIGGER_EXCERPT_LENGTH) : null;
}

// ── Row → interval mapping (pure, exported for tests) ──────────────────────

export interface ToolTimingRow {
	id: string;
	toolName: string;
	status: string;
	createdAt: string;
	streamStartedAt: string | null;
	streamCompletedAt: string | null;
	permissionStartedAt: string | null;
	permissionDecidedAt: string | null;
	permissionDecidedBy: string | null;
	executionStartedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
	isBackground: boolean;
}

export interface ModelTimingRow {
	id: string;
	kind: string;
	createdAt: string;
	durationMs: number | null;
	ttftMs: number | null;
}

/**
 * One tool call's lifecycle → intervals.
 *
 * - The permission window is waiting on a human (`user`), an automated review
 *   (`reflection`), or nothing worth a segment (`auto`, immediate decisions).
 *   AskUserQuestion / ExitPlanMode prompts are a reply/approval wait, not a
 *   permission check, and are labelled as such.
 * - The execution window is tool work, or waiting on another agent for
 *   Agent / Task / Await. Background calls return at once, so their open-ended
 *   execution is not this agent's time and is skipped.
 * - An unfinished call extends to `nowMs`.
 */
export function toolIntervals(row: ToolTimingRow, nowMs: number): TimelineInterval[] {
	const intervals: TimelineInterval[] = [];
	const permissionStart = parseMs(row.permissionStartedAt);
	const permissionEnd =
		parseMs(row.permissionDecidedAt) ??
		parseMs(row.executionStartedAt) ??
		(row.status === "pending" ? nowMs : parseMs(row.completedAt));
	const decidedBy = row.permissionDecidedBy;
	const pendingNow = row.status === "pending" && !row.permissionDecidedAt;
	if (permissionStart !== null && permissionEnd !== null && permissionEnd > permissionStart) {
		if (USER_REPLY_TOOLS.has(row.toolName) && (decidedBy === "user" || pendingNow)) {
			intervals.push({
				category: "user_reply_wait",
				startMs: permissionStart,
				endMs: permissionEnd,
				itemId: row.id,
			});
		} else if (decidedBy === "user" || pendingNow) {
			intervals.push({
				category: "permission_wait",
				startMs: permissionStart,
				endMs: permissionEnd,
				itemId: row.id,
			});
		} else if (decidedBy === "reflection") {
			intervals.push({
				category: "review",
				startMs: permissionStart,
				endMs: permissionEnd,
				itemId: row.id,
			});
		}
	}

	const executionStart = parseMs(row.executionStartedAt);
	if (executionStart !== null && !(row.isBackground && row.toolName !== "Await")) {
		const executionEnd =
			parseMs(row.completedAt) ??
			(row.status === "running" ? nowMs : null) ??
			(row.durationMs !== null ? executionStart + row.durationMs : null);
		if (executionEnd !== null && executionEnd > executionStart) {
			intervals.push({
				category: SUBAGENT_WAIT_TOOLS.has(row.toolName) ? "subagent_wait" : "tool",
				startMs: executionStart,
				endMs: executionEnd,
				itemId: row.id,
			});
		}
	}
	return intervals;
}

/**
 * One provider request → intervals. `created_at` is written when the request ends,
 * so it starts `duration_ms` earlier; the first `ttft_ms` of that is waiting for the
 * first token, the rest is output streaming. A compaction request is one block.
 */
export function modelIntervals(row: ModelTimingRow): TimelineInterval[] {
	const end = parseMs(row.createdAt);
	if (end === null || !row.durationMs || row.durationMs <= 0) return [];
	const start = end - row.durationMs;
	if (row.kind === "compact") {
		return [{ category: "compact", startMs: start, endMs: end, itemId: row.id }];
	}
	const ttft = row.ttftMs !== null && row.ttftMs > 0 ? Math.min(row.ttftMs, row.durationMs) : 0;
	const intervals: TimelineInterval[] = [];
	if (ttft > 0) {
		intervals.push({ category: "model_wait", startMs: start, endMs: start + ttft, itemId: row.id });
	}
	if (end > start + ttft) {
		intervals.push({ category: "model_output", startMs: start + ttft, endMs: end, itemId: row.id });
	}
	return intervals;
}

// ── Bounded reads ───────────────────────────────────────────────────────────

interface Cursor {
	createdAt: string;
	id: string;
}

type ReadableQuery<T> = PromiseLike<T[]> & { toSQL(): { sql: string; params: unknown[] } };

/**
 * Keyset-paged read on the worker pool. At most `cap + 1` rows are read, so whether the
 * source had more is known without counting; `cutAt` is where the unread rows begin.
 */
async function readPaged<T extends Cursor>(
	page: (after: Cursor | null, limit: number) => ReadableQuery<T>,
	pageSize: number,
	cap: number,
): Promise<{ rows: T[]; cutAt: string | null }> {
	const rows: T[] = [];
	let after: Cursor | null = null;
	while (rows.length <= cap) {
		const limit = Math.min(pageSize, cap + 1 - rows.length);
		const batch: T[] = await readQuery(page(after, limit), {
			maxRows: limit,
			timeoutMs: READ_TIMEOUT_MS,
		});
		rows.push(...batch);
		const tail = batch[batch.length - 1];
		if (!tail || batch.length < limit) break;
		after = { createdAt: tail.createdAt, id: tail.id };
	}
	if (rows.length <= cap) return { rows, cutAt: null };
	return { rows: rows.slice(0, cap), cutAt: rows[cap].createdAt };
}

/** Rows strictly after `cursor` in (created_at, id) order; the first clause keeps the seek. */
function afterCursor(
	createdAt: typeof narratorToolCalls.createdAt | typeof apiRequests.createdAt,
	id: typeof narratorToolCalls.id | typeof apiRequests.id,
	cursor: Cursor | null,
): SQL | undefined {
	if (!cursor) return undefined;
	return and(
		gte(createdAt, cursor.createdAt),
		or(gt(createdAt, cursor.createdAt), gt(id, cursor.id)),
	);
}

interface RowWindow {
	fromIso: string;
	/** Inclusive upper bound on `created_at`; open when absent. */
	toIso?: string;
}

function toolPage(narratorId: string, window: RowWindow, after: Cursor | null, limit: number) {
	return db
		.select({
			id: narratorToolCalls.id,
			toolUseId: narratorToolCalls.toolUseId,
			toolName: narratorToolCalls.toolName,
			status: narratorToolCalls.status,
			createdAt: narratorToolCalls.createdAt,
			streamStartedAt: narratorToolCalls.streamStartedAt,
			streamCompletedAt: narratorToolCalls.streamCompletedAt,
			permissionStartedAt: narratorToolCalls.permissionStartedAt,
			permissionDecidedAt: narratorToolCalls.permissionDecidedAt,
			permissionDecidedBy: narratorToolCalls.permissionDecidedBy,
			executionStartedAt: narratorToolCalls.executionStartedAt,
			completedAt: narratorToolCalls.completedAt,
			durationMs: narratorToolCalls.durationMs,
			isBackground: narratorToolCalls.isBackground,
			executionDeviceId: narratorToolCalls.executionDeviceId,
			errorMessage: sql<string | null>`substr(${narratorToolCalls.errorMessage}, 1, 300)`,
			...SUMMARY_HINT_COLUMNS,
		})
		.from(narratorToolCalls)
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				gte(narratorToolCalls.createdAt, window.fromIso),
				window.toIso ? lte(narratorToolCalls.createdAt, window.toIso) : undefined,
				eq(narratorToolCalls.isInternal, false),
				eq(narratorToolCalls.isFileHistoryCheckpoint, false),
				afterCursor(narratorToolCalls.createdAt, narratorToolCalls.id, after),
			),
		)
		.orderBy(asc(narratorToolCalls.createdAt), asc(narratorToolCalls.id))
		.limit(limit);
}

function modelPage(narratorId: string, window: RowWindow, after: Cursor | null, limit: number) {
	return db
		.select({
			id: apiRequests.id,
			kind: apiRequests.kind,
			createdAt: apiRequests.createdAt,
			durationMs: apiRequests.durationMs,
			ttftMs: apiRequests.ttftMs,
			model: apiRequests.model,
			inputTokens: apiRequests.inputTokens,
			outputTokens: apiRequests.outputTokens,
			errorMessage: sql<string | null>`substr(${apiRequests.errorMessage}, 1, 300)`,
		})
		.from(apiRequests)
		.where(
			and(
				eq(apiRequests.narratorId, narratorId),
				gte(apiRequests.createdAt, window.fromIso),
				window.toIso ? lte(apiRequests.createdAt, window.toIso) : undefined,
				inArray(apiRequests.kind, ["narrator", "compact", "reflection", "context_ask"]),
				afterCursor(apiRequests.createdAt, apiRequests.id, after),
			),
		)
		.orderBy(asc(apiRequests.createdAt), asc(apiRequests.id))
		.limit(limit);
}

type ToolRow = Awaited<ReturnType<typeof toolPage>>[number];
type ModelRow = Awaited<ReturnType<typeof modelPage>>[number];

/** Newest message of a narrator in `[fromIso, toIso)`: one seek on idx_messages_narrator. */
async function lastMessageMs(narratorId: string, fromIso: string, toIso?: string) {
	const row = await db
		.select({ at: narratorMessages.createdAt })
		.from(narratorMessages)
		.where(
			and(
				eq(narratorMessages.narratorId, narratorId),
				gte(narratorMessages.createdAt, fromIso),
				toIso ? lt(narratorMessages.createdAt, toIso) : undefined,
			),
		)
		.orderBy(desc(narratorMessages.createdAt))
		.limit(1)
		.get();
	return parseMs(row?.at);
}

// ── Turns ───────────────────────────────────────────────────────────────────

interface TurnRow {
	id: string;
	status: string;
	startedAt: string;
	endedAt: string | null;
	stopReason: string | null;
	triggerText: string | null;
}

const TURN_COLUMNS = {
	id: narratorTurns.id,
	status: narratorTurns.status,
	startedAt: narratorTurns.startedAt,
	endedAt: narratorTurns.endedAt,
	stopReason: narratorTurns.stopReason,
	triggerText: sql<string | null>`(SELECT substr(m.content_text, 1, 200)
		FROM narrator_messages m WHERE m.id = ${narratorTurns.triggerMessageId})`,
};

function toTurnStatus(status: string): TimelineTurnStatus {
	return status === "running" || status === "interrupted" || status === "failed"
		? status
		: "completed";
}

function toTurnSummary(row: TurnRow, index: number): TimelineTurnSummary {
	return {
		id: row.id,
		index,
		status: toTurnStatus(row.status),
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		stopReason: row.stopReason,
		triggerExcerpt: excerpt(row.triggerText),
		derived: false,
	};
}

/** Counted on the covering (narrator_id, started_at) index. */
async function countTurnsBefore(narratorId: string, startedAt: string): Promise<number> {
	const row = await db
		.select({ n: count() })
		.from(narratorTurns)
		.where(and(eq(narratorTurns.narratorId, narratorId), lt(narratorTurns.startedAt, startedAt)))
		.get();
	return Number(row?.n ?? 0);
}

/** Top-level human inputs: the turn boundaries of histories older than `narrator_turns`. */
function userInputWhere(narratorId: string, before?: string) {
	return and(
		eq(narratorMessages.narratorId, narratorId),
		isNull(narratorMessages.parentToolUseId),
		eq(narratorMessages.role, "user"),
		or(isNull(narratorMessages.origin), eq(narratorMessages.origin, "user")),
		before ? lt(narratorMessages.createdAt, before) : undefined,
	);
}

/**
 * Turns derived from user inputs, for histories older than `narrator_turns`. Each human
 * input starts a turn that lasts until the next one. Both reads filter on non-indexed
 * columns over a possibly long history, so they run on the worker pool.
 */
async function derivedTurns(
	narratorId: string,
	before: string | undefined,
	limit: number,
): Promise<{ turns: TimelineTurnSummary[]; hasMore: boolean }> {
	const [rows, totals] = await Promise.all([
		readQuery(
			db
				.select({
					id: narratorMessages.id,
					createdAt: narratorMessages.createdAt,
					text: sql<string | null>`substr(${narratorMessages.contentText}, 1, 200)`,
				})
				.from(narratorMessages)
				.where(userInputWhere(narratorId, before))
				.orderBy(desc(narratorMessages.createdAt), desc(narratorMessages.id))
				.limit(limit + 1),
			{ maxRows: limit + 1, timeoutMs: READ_TIMEOUT_MS },
		),
		readQuery(
			db.select({ n: count() }).from(narratorMessages).where(userInputWhere(narratorId, before)),
			{ maxRows: 1, timeoutMs: READ_TIMEOUT_MS },
		),
	]);
	const total = Number(totals[0]?.n ?? rows.length);
	const page = rows.slice(0, limit);
	const turns = page.map(
		(row, i): TimelineTurnSummary => ({
			id: `msg:${row.id}`,
			index: total - i,
			status: "completed",
			startedAt: row.createdAt,
			// Rows are newest first: a turn ends where the next-newer input begins. The newest
			// turn's end is resolved from real activity when it is opened.
			endedAt: i === 0 ? (before ?? null) : page[i - 1].createdAt,
			stopReason: null,
			triggerExcerpt: excerpt(row.text),
			derived: true,
		}),
	);
	return { turns, hasMore: rows.length > limit };
}

export async function listTimelineTurns(
	narratorId: string,
	options: { before?: string; limit?: number } = {},
): Promise<TimelineTurnsResponse> {
	const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), MAX_TURNS_PAGE);
	const rows = (await db
		.select(TURN_COLUMNS)
		.from(narratorTurns)
		.where(
			and(
				eq(narratorTurns.narratorId, narratorId),
				options.before ? lt(narratorTurns.startedAt, options.before) : undefined,
			),
		)
		.orderBy(desc(narratorTurns.startedAt), desc(narratorTurns.id))
		.limit(limit + 1)) as TurnRow[];
	if (rows.length === 0) {
		const derived = await derivedTurns(narratorId, options.before, limit);
		return { narratorId, ...derived };
	}
	const page = rows.slice(0, limit);
	const oldest = page[page.length - 1];
	const baseIndex = oldest ? await countTurnsBefore(narratorId, oldest.startedAt) : 0;
	return {
		narratorId,
		turns: page.map((row, i) => toTurnSummary(row, baseIndex + (page.length - i))),
		hasMore: rows.length > limit,
	};
}

async function resolveTurn(
	narratorId: string,
	turnId: string | undefined,
): Promise<TimelineTurnSummary | null> {
	if (turnId?.startsWith("msg:")) {
		const messageId = turnId.slice(4);
		const anchor = await db
			.select({ createdAt: narratorMessages.createdAt })
			.from(narratorMessages)
			.where(and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)))
			.get();
		if (!anchor) return null;
		// The page starting just before the next input holds the anchor as its newest turn.
		const [next] = await readQuery(
			db
				.select({ createdAt: narratorMessages.createdAt })
				.from(narratorMessages)
				.where(
					and(
						userInputWhere(narratorId),
						or(
							gt(narratorMessages.createdAt, anchor.createdAt),
							and(
								eq(narratorMessages.createdAt, anchor.createdAt),
								gt(narratorMessages.id, messageId),
							),
						),
					),
				)
				.orderBy(asc(narratorMessages.createdAt), asc(narratorMessages.id))
				.limit(1),
			{ maxRows: 1, timeoutMs: READ_TIMEOUT_MS },
		);
		const { turns } = await derivedTurns(narratorId, next?.createdAt, 1);
		const turn = turns[0];
		return turn && turn.id === turnId ? turn : null;
	}
	if (turnId) {
		const row = (await db
			.select(TURN_COLUMNS)
			.from(narratorTurns)
			.where(and(eq(narratorTurns.id, turnId), eq(narratorTurns.narratorId, narratorId)))
			.get()) as TurnRow | undefined;
		if (!row) return null;
		return toTurnSummary(row, (await countTurnsBefore(narratorId, row.startedAt)) + 1);
	}
	const { turns } = await listTimelineTurns(narratorId, { limit: 1 });
	return turns[0] ?? null;
}

// ── Lanes ───────────────────────────────────────────────────────────────────

interface NarratorRow {
	id: string;
	title: string | null;
	type: "primary" | "subagent";
	subagentType: string | null;
	parentNarratorId: string | null;
	originToolCallId: string | null;
	status: string;
	createdAt: string;
}

const NARRATOR_COLUMNS = {
	id: narrators.id,
	title: narrators.title,
	type: narrators.type,
	subagentType: narrators.subagentType,
	parentNarratorId: narrators.parentNarratorId,
	originToolCallId: narrators.originToolCallId,
	status: narrators.status,
	createdAt: narrators.createdAt,
};

interface LaneWindow {
	startMs: number;
	/** Known end; `null` derives it from the lane's own latest activity. */
	endMs: number | null;
	/** Bound on the activity searched when `endMs` is derived (the next turn's start). */
	upperMs: number | null;
	live: boolean;
}

interface LaneMeta {
	depth: number;
	spawnItemId: string | null;
	spawnAtMs: number | null;
}

interface BuildContext {
	nowMs: number;
	items: Record<string, TimelineItem>;
}

interface LaneBuild {
	lane: TimelineLane;
	/** Spawn calls of this lane with the child narrator each one created. */
	spawns: Array<{ row: ToolRow; child: NarratorRow }>;
}

function toToolItem(row: ToolRow, child: NarratorRow | undefined): TimelineToolItem {
	return {
		kind: "tool",
		id: row.id,
		toolName: row.toolName,
		summary: buildSummary(row.toolName, row) ?? (child?.title ? excerpt(child.title) : null),
		status: row.status,
		isBackground: !!row.isBackground,
		executionDeviceId: row.executionDeviceId,
		errorMessage: row.errorMessage ? redactExecutionLogText(row.errorMessage) : null,
		permissionDecidedBy: row.permissionDecidedBy,
		durationMs: row.durationMs,
		childNarratorId: child?.id ?? null,
	};
}

function toModelItem(row: ModelRow): TimelineModelItem {
	return {
		kind: "model",
		id: row.id,
		requestKind: row.kind,
		model: row.model,
		ttftMs: row.ttftMs,
		durationMs: row.durationMs,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		errorMessage: row.errorMessage ? redactExecutionLogText(row.errorMessage) : null,
	};
}

/** Latest moment the loaded rows (or a message) show this narrator active. */
async function derivedEndMs(
	narratorId: string,
	window: LaneWindow,
	tools: ToolRow[],
	models: ModelRow[],
): Promise<number> {
	let last = window.startMs;
	for (const row of tools) {
		last = Math.max(last, parseMs(row.completedAt) ?? parseMs(row.createdAt) ?? last);
	}
	for (const row of models) last = Math.max(last, parseMs(row.createdAt) ?? last);
	const message = await lastMessageMs(
		narratorId,
		toIso(window.startMs),
		window.upperMs !== null ? toIso(window.upperMs) : undefined,
	);
	return Math.max(last, message ?? last);
}

async function loadChildren(
	narratorId: string,
	tools: ToolRow[],
): Promise<Map<string, NarratorRow>> {
	const spawnCallIds = tools
		.filter((row) => SPAWN_TOOLS.has(row.toolName))
		.map((row) => row.id)
		.slice(0, MAX_SPAWN_LOOKUPS);
	const byToolCall = new Map<string, NarratorRow>();
	if (spawnCallIds.length === 0) return byToolCall;
	const children = (await db
		.select(NARRATOR_COLUMNS)
		.from(narrators)
		.where(
			and(
				inArray(narrators.originToolCallId, spawnCallIds),
				eq(narrators.parentNarratorId, narratorId),
			),
		)) as NarratorRow[];
	for (const child of children) {
		if (child.originToolCallId) byToolCall.set(child.originToolCallId, child);
	}
	return byToolCall;
}

async function buildLane(
	narrator: NarratorRow,
	window: LaneWindow,
	meta: LaneMeta & { loadChildren: boolean },
	ctx: BuildContext,
): Promise<LaneBuild> {
	const upper = window.endMs ?? window.upperMs;
	const rowWindow: RowWindow = {
		fromIso: toIso(window.startMs),
		toIso: upper !== null ? toIso(upper) : undefined,
	};
	const [tools, models] = await Promise.all([
		readPaged(
			(after, limit) => toolPage(narrator.id, rowWindow, after, limit),
			TOOL_PAGE_ROWS,
			MAX_ROWS_PER_SOURCE,
		),
		readPaged(
			(after, limit) => modelPage(narrator.id, rowWindow, after, limit),
			MODEL_PAGE_ROWS,
			MAX_ROWS_PER_SOURCE,
		),
	]);
	const endMs =
		window.endMs ??
		(window.live ? ctx.nowMs : await derivedEndMs(narrator.id, window, tools.rows, models.rows));
	// Past the first unread row nothing is known: the lane stops there instead of showing idle.
	const cuts = [tools.cutAt, models.cutAt].map(parseMs).filter((ms): ms is number => ms !== null);
	const coveredUntilMs =
		cuts.length > 0 ? Math.max(window.startMs, Math.min(endMs, ...cuts)) : null;
	const children = meta.loadChildren ? await loadChildren(narrator.id, tools.rows) : new Map();

	const intervals: TimelineInterval[] = [];
	const spawns: LaneBuild["spawns"] = [];
	for (const row of tools.rows) {
		intervals.push(...toolIntervals(row, ctx.nowMs));
		const child = children.get(row.id);
		ctx.items[row.id] = toToolItem(row, child);
		if (child) spawns.push({ row, child });
	}
	for (const row of models.rows) {
		intervals.push(...modelIntervals(row));
		ctx.items[row.id] = toModelItem(row);
	}
	const partition = partitionTimeline({
		startMs: window.startMs,
		endMs: coveredUntilMs ?? endMs,
		intervals,
	});
	return {
		lane: {
			narratorId: narrator.id,
			title: narrator.title,
			type: narrator.type,
			subagentType: narrator.subagentType,
			depth: meta.depth,
			parentNarratorId: narrator.parentNarratorId,
			spawnItemId: meta.spawnItemId,
			spawnAtMs: meta.spawnAtMs,
			startMs: window.startMs,
			endMs,
			live: window.live,
			segments: partition.segments,
			totals: partition.totals,
			truncated: partition.truncated || coveredUntilMs !== null,
			coveredUntilMs,
		},
		spawns,
	};
}

interface PendingLane extends LaneMeta {
	narrator: NarratorRow;
	window: LaneWindow;
}

/** Child lanes of one built lane, in spawn order. */
function childLanes(build: LaneBuild, depth: number): { lanes: PendingLane[]; omitted: number } {
	const lanes: PendingLane[] = [];
	let omitted = 0;
	for (const { row, child } of build.spawns) {
		if (lanes.length >= MAX_CHILDREN_PER_LANE) {
			omitted++;
			continue;
		}
		const spawnAt =
			parseMs(row.executionStartedAt) ??
			parseMs(row.permissionStartedAt) ??
			parseMs(row.streamStartedAt) ??
			parseMs(child.createdAt);
		if (spawnAt === null) continue;
		const startMs = Math.max(spawnAt, parseMs(child.createdAt) ?? spawnAt);
		const live = child.status === "working" || (!row.completedAt && row.status === "running");
		// A foreground spawn returns when its child is done, so its completion ends the child's
		// lane; a later resume of the same child belongs to another turn.
		const completedAt = row.isBackground ? null : parseMs(row.completedAt);
		lanes.push({
			narrator: child,
			depth,
			spawnItemId: row.id,
			spawnAtMs: spawnAt,
			window: {
				startMs,
				endMs: live || completedAt === null ? null : Math.max(startMs, completedAt),
				upperMs: null,
				live,
			},
		});
	}
	return { lanes, omitted };
}

async function mapWithConcurrency<T, R>(
	values: readonly T[],
	limit: number,
	fn: (value: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(values.length);
	let next = 0;
	const run = async () => {
		while (next < values.length) {
			const index = next++;
			results[index] = await fn(values[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
	return results;
}

/** Keep only the details some segment (or a branch connector) points at. */
function referencedItems(
	lanes: TimelineLane[],
	items: Record<string, TimelineItem>,
): Record<string, TimelineItem> {
	const out: Record<string, TimelineItem> = {};
	const keep = (id: string | null) => {
		const item = id ? items[id] : undefined;
		if (id && item) out[id] = item;
	};
	for (const lane of lanes) {
		keep(lane.spawnItemId);
		for (const segment of lane.segments) for (const id of segment.itemIds) keep(id);
	}
	return out;
}

async function buildTurnTimeline(
	narratorId: string,
	turnId: string | undefined,
	nowMs: number,
): Promise<TurnTimelineResponse | null> {
	const root = (await db
		.select(NARRATOR_COLUMNS)
		.from(narrators)
		.where(eq(narrators.id, narratorId))
		.get()) as NarratorRow | undefined;
	if (!root) return null;

	const turn = await resolveTurn(narratorId, turnId);
	if (turnId && !turn) return null;

	let rootWindow: LaneWindow;
	if (turn && !turn.derived) {
		const live = turn.status === "running";
		const startMs = parseMs(turn.startedAt) ?? nowMs;
		rootWindow = {
			startMs,
			endMs: live ? nowMs : Math.max(startMs, parseMs(turn.endedAt) ?? nowMs),
			upperMs: null,
			live,
		};
	} else if (turn) {
		// A derived turn runs until the next input; it ends at its last real activity.
		const live = !turn.endedAt && root.status === "working";
		rootWindow = {
			startMs: parseMs(turn.startedAt) ?? nowMs,
			endMs: live ? nowMs : null,
			upperMs: parseMs(turn.endedAt),
			live,
		};
	} else {
		// No turns at all (a subagent opened directly): its whole recorded activity.
		const live = root.status === "working" || root.status === "waiting";
		rootWindow = {
			startMs: parseMs(root.createdAt) ?? nowMs,
			endMs: live ? nowMs : null,
			upperMs: null,
			live,
		};
	}

	const ctx: BuildContext = { nowMs, items: {} };
	const build = (pending: PendingLane) =>
		buildLane(
			pending.narrator,
			pending.window,
			{ ...pending, loadChildren: pending.depth < MAX_DEPTH },
			ctx,
		);
	let omittedLanes = 0;
	let slotsLeft = MAX_LANES - 1;

	// Siblings claim lane slots before their descendants and are built together; the
	// output is still depth-first, each lane followed by its own subtree.
	const subtree = async (pending: PendingLane, built: LaneBuild): Promise<TimelineLane[]> => {
		if (pending.depth >= MAX_DEPTH) return [built.lane];
		const children = childLanes(built, pending.depth + 1);
		const admitted = children.lanes.slice(0, Math.max(0, slotsLeft));
		slotsLeft -= admitted.length;
		omittedLanes += children.omitted + children.lanes.length - admitted.length;
		const builds = await mapWithConcurrency(admitted, LANE_CONCURRENCY, build);
		const out = [built.lane];
		for (let i = 0; i < admitted.length; i++) out.push(...(await subtree(admitted[i], builds[i])));
		return out;
	};
	const rootPending: PendingLane = {
		narrator: root,
		window: rootWindow,
		depth: 0,
		spawnItemId: null,
		spawnAtMs: null,
	};
	const lanes = await subtree(rootPending, await build(rootPending));

	// The primary lane is padded to the overall window, so a child outliving the turn
	// shows as `after_turn` on its parent instead of the parent simply stopping.
	const primary = lanes[0];
	const overallEnd = Math.max(...lanes.map((lane) => lane.endMs));
	if (primary && overallEnd > primary.endMs) {
		primary.segments.push({
			category: "after_turn",
			startMs: primary.endMs,
			endMs: overallEnd,
			itemIds: [],
		});
		primary.totals.after_turn = (primary.totals.after_turn ?? 0) + (overallEnd - primary.endMs);
		primary.endMs = overallEnd;
	}

	return {
		narratorId,
		turn,
		nowMs,
		startMs: rootWindow.startMs,
		endMs: primary?.endMs ?? rootWindow.startMs,
		lanes,
		items: referencedItems(lanes, ctx.items),
		omittedLanes,
	};
}

const inFlight = new Map<string, Promise<TurnTimelineResponse | null>>();

/**
 * The timeline of one turn: the narrator's own lane plus one lane per child agent
 * spawned during it (and their children, to {@link MAX_DEPTH}). The latest turn when
 * `turnId` is omitted.
 *
 * Callers are authorized before this runs, so concurrent requests for the same turn (several
 * viewers polling a live one) share a single build.
 */
export function getTurnTimeline(
	narratorId: string,
	turnId?: string,
	nowMs?: number,
): Promise<TurnTimelineResponse | null> {
	if (nowMs !== undefined) return buildTurnTimeline(narratorId, turnId, nowMs);
	const key = `${narratorId}\u0000${turnId ?? ""}`;
	const pending = inFlight.get(key);
	if (pending) return pending;
	const startedAt = performance.now();
	const build = buildTurnTimeline(narratorId, turnId, Date.now())
		.then((result) => {
			const elapsedMs = performance.now() - startedAt;
			if (elapsedMs > SLOW_BUILD_MS && result) {
				logger.warn("Slow narrator timeline build", {
					narratorId,
					turnId: result.turn?.id ?? null,
					elapsedMs: Math.round(elapsedMs),
					lanes: result.lanes.length,
					items: Object.keys(result.items).length,
				});
			}
			return result;
		})
		.finally(() => inFlight.delete(key));
	inFlight.set(key, build);
	return build;
}
