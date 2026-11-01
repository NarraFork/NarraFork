/**
 * narrator-timeline.ts — per-turn, per-agent continuous timelines.
 *
 * Reads only small, indexed columns:
 *   - `narrator_turns` (idx_turns_narrator_started) for the turn window;
 *   - `narrator_tool_calls` (idx_toolcalls_created) lifecycle stamps, plus bounded
 *     `json_extract` hints for a one-line summary — never input/output bodies;
 *   - `api_requests` (idx_api_requests_narrator) timings for model segments;
 *   - `narrators` (idx_narrators_parent) for child lanes.
 *
 * Every query is LIMITed; a turn produces at most {@link MAX_LANES} lanes of at most
 * {@link MAX_ROWS_PER_SOURCE} rows per source. The partition itself is the shared
 * pure function in `@shared/narrator-timeline`.
 */

import { db } from "@server/db";
import { apiRequests, narrators, narratorToolCalls, narratorTurns } from "@server/db/schema";
import { redactExecutionLogText } from "@server/lib/execution-log-redaction";
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
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { summarizeSubagentToolCall } from "./subagent-activity";

export const MAX_TURNS_PAGE = 50;
export const MAX_ROWS_PER_SOURCE = 2000;
export const MAX_LANES = 16;
export const MAX_CHILDREN_PER_LANE = 20;
export const MAX_DEPTH = 2;
const TRIGGER_EXCERPT_LENGTH = 80;
const SUMMARY_FIELD_MAX_LENGTH = 160;

/** Tools whose permission window is a question/approval addressed to the user. */
const USER_REPLY_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
/** Tools whose execution window is the agent waiting on another agent. */
const SUBAGENT_WAIT_TOOLS = new Set(["Agent", "Task", "Await"]);
/** Tools that create a child narrator (`narrators.origin_tool_call_id`). */
const SPAWN_TOOLS = new Set(["Agent", "Task"]);
const MAX_SPAWN_LOOKUPS = 200;

function boundedJsonText(path: string) {
	return sql<string | null>`CASE
		WHEN json_valid(${narratorToolCalls.inputJson})
		THEN substr(CAST(json_extract(${narratorToolCalls.inputJson}, ${path}) AS TEXT), 1, ${SUMMARY_FIELD_MAX_LENGTH})
		ELSE NULL
	END`;
}

const SUMMARY_HINT_COLUMNS = {
	description: boundedJsonText("$.description"),
	filePath: boundedJsonText("$.file_path"),
	path: boundedJsonText("$.path"),
	pattern: boundedJsonText("$.pattern"),
	query: boundedJsonText("$.query"),
	url: boundedJsonText("$.url"),
	mode: boundedJsonText("$.mode"),
	action: boundedJsonText("$.action"),
	targetId: boundedJsonText("$.id"),
	targetName: boundedJsonText("$.name"),
	awaitType: boundedJsonText("$.type"),
	subagentTypeHint: boundedJsonText("$.subagent_type"),
	skillName: boundedJsonText("$.skill"),
	questionHeader: boundedJsonText("$.questions[0].header"),
} as const;

type SummaryHintRow = { [K in keyof typeof SUMMARY_HINT_COLUMNS]: string | null };

function buildSummary(toolName: string, row: SummaryHintRow): string | null {
	const summary = summarizeSubagentToolCall(toolName, {
		description: row.description,
		filePath: row.filePath,
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

// ── Queries ─────────────────────────────────────────────────────────────────

interface TurnRow {
	id: string;
	status: string;
	startedAt: string;
	endedAt: string | null;
	stopReason: string | null;
	triggerText: string | null;
}

function toTurnStatus(status: string): TimelineTurnStatus {
	return status === "running" || status === "interrupted" || status === "failed"
		? status
		: "completed";
}

async function countTurnsBefore(narratorId: string, startedAt: string): Promise<number> {
	const row = await db
		.select({ n: sql<number>`count(*)` })
		.from(narratorTurns)
		.where(and(eq(narratorTurns.narratorId, narratorId), lt(narratorTurns.startedAt, startedAt)))
		.get();
	return Number(row?.n ?? 0);
}

function turnRowsQuery(narratorId: string, before: string | undefined, limit: number) {
	return db
		.select({
			id: narratorTurns.id,
			status: narratorTurns.status,
			startedAt: narratorTurns.startedAt,
			endedAt: narratorTurns.endedAt,
			stopReason: narratorTurns.stopReason,
			triggerText: sql<string | null>`(SELECT substr(m.content_text, 1, 200)
				FROM narrator_messages m WHERE m.id = ${narratorTurns.triggerMessageId})`,
		})
		.from(narratorTurns)
		.where(
			before
				? and(eq(narratorTurns.narratorId, narratorId), lt(narratorTurns.startedAt, before))
				: eq(narratorTurns.narratorId, narratorId),
		)
		.orderBy(desc(narratorTurns.startedAt), desc(narratorTurns.id))
		.limit(limit);
}

/**
 * Turns derived from user inputs, for histories older than `narrator_turns`.
 * Each human input starts a turn that lasts until the next one (or the last
 * recorded activity, approximated by the last message in the window).
 */
async function derivedTurns(
	narratorId: string,
	before: string | undefined,
	limit: number,
): Promise<{ turns: TimelineTurnSummary[]; hasMore: boolean }> {
	const rows = await db.all<{ id: string; createdAt: string; text: string | null }>(sql`
		SELECT m.id AS id, m.created_at AS createdAt, substr(m.content_text, 1, 200) AS text
		FROM narrator_messages m
		WHERE m.narrator_id = ${narratorId} AND m.parent_tool_use_id IS NULL
			AND m.role = 'user' AND (m.origin IS NULL OR m.origin = 'user')
			${before ? sql`AND m.created_at < ${before}` : sql``}
		ORDER BY m.created_at DESC, m.id DESC
		LIMIT ${limit + 2}
	`);
	const hasMore = rows.length > limit + 1;
	const totalBefore = await db.all<{ n: number }>(sql`
		SELECT count(*) AS n FROM narrator_messages m
		WHERE m.narrator_id = ${narratorId} AND m.parent_tool_use_id IS NULL
			AND m.role = 'user' AND (m.origin IS NULL OR m.origin = 'user')
			${before ? sql`AND m.created_at < ${before}` : sql``}
	`);
	const total = Number(totalBefore[0]?.n ?? rows.length);
	const turns: TimelineTurnSummary[] = [];
	const page = rows.slice(0, limit);
	page.forEach((row, i) => {
		// rows are newest first: the turn ends where the next-newer input begins.
		const newer = i === 0 ? null : rows[i - 1];
		turns.push({
			id: `msg:${row.id}`,
			index: total - i,
			status: "completed",
			startedAt: row.createdAt,
			// The newest turn's end is resolved from real activity when it is opened.
			endedAt: newer ? newer.createdAt : (before ?? null),
			stopReason: null,
			triggerExcerpt: excerpt(row.text),
			derived: true,
		});
	});
	return { turns, hasMore };
}

export async function listTimelineTurns(
	narratorId: string,
	options: { before?: string; limit?: number } = {},
): Promise<TimelineTurnsResponse> {
	const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), MAX_TURNS_PAGE);
	const rows = (await turnRowsQuery(narratorId, options.before, limit + 1)) as TurnRow[];
	if (rows.length === 0) {
		const derived = await derivedTurns(narratorId, options.before, limit);
		return { narratorId, ...derived };
	}
	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit);
	const oldest = page[page.length - 1];
	const baseIndex = oldest ? await countTurnsBefore(narratorId, oldest.startedAt) : 0;
	const turns = page.map(
		(row, i): TimelineTurnSummary => ({
			id: row.id,
			index: baseIndex + (page.length - i),
			status: toTurnStatus(row.status),
			startedAt: row.startedAt,
			endedAt: row.endedAt,
			stopReason: row.stopReason,
			triggerExcerpt: excerpt(row.triggerText),
			derived: false,
		}),
	);
	return { narratorId, turns, hasMore };
}

async function resolveTurn(
	narratorId: string,
	turnId: string | undefined,
): Promise<TimelineTurnSummary | null> {
	if (turnId?.startsWith("msg:")) {
		const messageId = turnId.slice(4);
		const anchor = await db.all<{ createdAt: string }>(sql`
			SELECT created_at AS createdAt FROM narrator_messages
			WHERE id = ${messageId} AND narrator_id = ${narratorId}
		`);
		if (!anchor[0]) return null;
		// The page starting just after the anchor contains it as its newest turn.
		const next = await db.all<{ createdAt: string }>(sql`
			SELECT m.created_at AS createdAt FROM narrator_messages m
			WHERE m.narrator_id = ${narratorId} AND m.parent_tool_use_id IS NULL
				AND m.role = 'user' AND (m.origin IS NULL OR m.origin = 'user')
				AND (m.created_at > ${anchor[0].createdAt}
					OR (m.created_at = ${anchor[0].createdAt} AND m.id > ${messageId}))
			ORDER BY m.created_at ASC, m.id ASC LIMIT 1
		`);
		const { turns } = await derivedTurns(narratorId, next[0] ? next[0].createdAt : undefined, 1);
		const turn = turns[0];
		if (!turn || turn.id !== turnId) return null;
		if (next[0]) turn.endedAt = next[0].createdAt;
		return turn;
	}
	if (turnId) {
		const row = (await db
			.select({
				id: narratorTurns.id,
				status: narratorTurns.status,
				startedAt: narratorTurns.startedAt,
				endedAt: narratorTurns.endedAt,
				stopReason: narratorTurns.stopReason,
				triggerText: sql<string | null>`(SELECT substr(m.content_text, 1, 200)
					FROM narrator_messages m WHERE m.id = ${narratorTurns.triggerMessageId})`,
			})
			.from(narratorTurns)
			.where(and(eq(narratorTurns.id, turnId), eq(narratorTurns.narratorId, narratorId)))
			.get()) as TurnRow | undefined;
		if (!row) return null;
		return {
			id: row.id,
			index: (await countTurnsBefore(narratorId, row.startedAt)) + 1,
			status: toTurnStatus(row.status),
			startedAt: row.startedAt,
			endedAt: row.endedAt,
			stopReason: row.stopReason,
			triggerExcerpt: excerpt(row.triggerText),
			derived: false,
		};
	}
	const { turns } = await listTimelineTurns(narratorId, { limit: 1 });
	return turns[0] ?? null;
}

interface ToolQueryRow extends ToolTimingRow, SummaryHintRow {
	toolUseId: string;
	executionDeviceId: string | null;
	errorMessage: string | null;
}

async function loadToolRows(narratorId: string, fromIso: string, toIso: string) {
	// `created_at` is when the row was first written (stream start); a call that began
	// before the window but is still open (a long Await) must be included too.
	return (await db
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
				lte(narratorToolCalls.createdAt, toIso),
				gte(narratorToolCalls.createdAt, fromIso),
				eq(narratorToolCalls.isInternal, false),
				eq(narratorToolCalls.isFileHistoryCheckpoint, false),
			),
		)
		.orderBy(asc(narratorToolCalls.createdAt))
		.limit(MAX_ROWS_PER_SOURCE)) as ToolQueryRow[];
}

interface ModelQueryRow extends ModelTimingRow {
	model: string | null;
	inputTokens: number;
	outputTokens: number;
	errorMessage: string | null;
}

async function loadModelRows(narratorId: string, fromIso: string, toIso: string) {
	return (await db
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
				gte(apiRequests.createdAt, fromIso),
				lte(apiRequests.createdAt, toIso),
				inArray(apiRequests.kind, ["narrator", "compact", "reflection", "context_ask"]),
			),
		)
		.orderBy(asc(apiRequests.createdAt))
		.limit(MAX_ROWS_PER_SOURCE)) as ModelQueryRow[];
}

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

/** Latest recorded activity of a narrator in `[fromIso, toIso)` (toIso open when omitted). */
async function lastActivityMs(
	narratorId: string,
	fromIso: string,
	toIso?: string,
): Promise<number | null> {
	const upper = (column: string) => (toIso ? sql`AND ${sql.raw(column)} < ${toIso}` : sql``);
	const rows = await db.all<{ at: string | null }>(sql`
		SELECT max(at) AS at FROM (
			SELECT max(coalesce(completed_at, created_at)) AS at FROM narrator_tool_calls
				WHERE narrator_id = ${narratorId} AND created_at >= ${fromIso} ${upper("created_at")}
			UNION ALL
			SELECT max(created_at) AS at FROM api_requests
				WHERE narrator_id = ${narratorId} AND created_at >= ${fromIso} ${upper("created_at")}
			UNION ALL
			SELECT max(created_at) AS at FROM narrator_messages
				WHERE narrator_id = ${narratorId} AND created_at >= ${fromIso} ${upper("created_at")}
		)
	`);
	return parseMs(rows[0]?.at ?? null);
}

interface LaneBuild {
	lane: TimelineLane;
	toolItems: TimelineToolItem[];
	/** Child narrators keyed by the spawning tool call id. */
	children: Map<string, NarratorRow>;
}

function toToolItem(row: ToolQueryRow, childNarratorId: string | null): TimelineToolItem {
	return {
		kind: "tool",
		id: row.id,
		toolUseId: row.toolUseId,
		toolName: row.toolName,
		summary: buildSummary(row.toolName, row),
		status: row.status,
		isBackground: !!row.isBackground,
		executionDeviceId: row.executionDeviceId,
		errorMessage: row.errorMessage ? redactExecutionLogText(row.errorMessage) : null,
		permissionDecidedBy: row.permissionDecidedBy,
		streamStartedAt: row.streamStartedAt,
		permissionStartedAt: row.permissionStartedAt,
		permissionDecidedAt: row.permissionDecidedAt,
		executionStartedAt: row.executionStartedAt,
		completedAt: row.completedAt,
		durationMs: row.durationMs,
		childNarratorId,
	};
}

function toModelItem(row: ModelQueryRow): TimelineModelItem {
	const endMs = parseMs(row.createdAt) ?? 0;
	return {
		kind: "model",
		id: row.id,
		requestKind: row.kind,
		model: row.model,
		startedAt: new Date(endMs - (row.durationMs ?? 0)).toISOString(),
		endedAt: row.createdAt,
		ttftMs: row.ttftMs,
		durationMs: row.durationMs,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		errorMessage: row.errorMessage ? redactExecutionLogText(row.errorMessage) : null,
	};
}

async function buildLane(
	narrator: NarratorRow,
	window: { startMs: number; endMs: number; live: boolean },
	meta: {
		depth: number;
		spawnItemId: string | null;
		spawnAtMs: number | null;
		nowMs: number;
		loadChildren: boolean;
	},
	items: Record<string, TimelineItem>,
): Promise<LaneBuild> {
	const fromIso = new Date(window.startMs).toISOString();
	const toIso = new Date(window.endMs).toISOString();
	const [toolRows, modelRows] = await Promise.all([
		loadToolRows(narrator.id, fromIso, toIso),
		loadModelRows(narrator.id, fromIso, toIso),
	]);
	const spawnCallIds = toolRows
		.filter((row) => SPAWN_TOOLS.has(row.toolName))
		.map((row) => row.id)
		.slice(0, MAX_SPAWN_LOOKUPS);
	const children =
		meta.loadChildren && spawnCallIds.length > 0
			? ((await db
					.select(NARRATOR_COLUMNS)
					.from(narrators)
					.where(
						and(
							inArray(narrators.originToolCallId, spawnCallIds),
							eq(narrators.parentNarratorId, narrator.id),
						),
					)) as NarratorRow[])
			: [];
	const childByToolCall = new Map<string, NarratorRow>();
	for (const child of children) {
		if (child.originToolCallId) childByToolCall.set(child.originToolCallId, child);
	}

	const intervals: TimelineInterval[] = [];
	const toolItems: TimelineToolItem[] = [];
	for (const row of toolRows) {
		intervals.push(...toolIntervals(row, meta.nowMs));
		const item = toToolItem(row, childByToolCall.get(row.id)?.id ?? null);
		items[row.id] = item;
		toolItems.push(item);
	}
	for (const row of modelRows) {
		intervals.push(...modelIntervals(row));
		items[row.id] = toModelItem(row);
	}
	const partition = partitionTimeline({
		startMs: window.startMs,
		endMs: window.endMs,
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
			endMs: window.endMs,
			live: window.live,
			segments: partition.segments,
			totals: partition.totals,
			truncated: partition.truncated,
		},
		toolItems,
		children: childByToolCall,
	};
}

/**
 * The timeline of one turn: the narrator's own lane plus one lane per child agent
 * spawned during it (and their children, to {@link MAX_DEPTH}).
 */
export async function getTurnTimeline(
	narratorId: string,
	turnId?: string,
	nowMs: number = Date.now(),
): Promise<TurnTimelineResponse | null> {
	const root = (await db
		.select(NARRATOR_COLUMNS)
		.from(narrators)
		.where(eq(narrators.id, narratorId))
		.get()) as NarratorRow | undefined;
	if (!root) return null;

	const turn = await resolveTurn(narratorId, turnId);
	if (turnId && !turn) return null;
	const items: Record<string, TimelineItem> = {};
	const lanes: TimelineLane[] = [];
	let omittedLanes = 0;

	let rootStart: number;
	let rootEnd: number;
	let rootLive = false;
	if (turn) {
		rootStart = parseMs(turn.startedAt) ?? nowMs;
		rootLive = turn.status === "running";
		rootEnd = rootLive ? nowMs : (parseMs(turn.endedAt) ?? nowMs);
		if (turn.derived) {
			// A derived turn runs until the next input; it ends at its last real activity.
			const last = await lastActivityMs(narratorId, turn.startedAt, turn.endedAt ?? undefined);
			rootLive = !turn.endedAt && root.status === "working";
			rootEnd = rootLive ? nowMs : Math.max(rootStart, last ?? rootStart);
		}
	} else {
		// No turns at all (a subagent opened directly): its whole recorded activity.
		rootStart = parseMs(root.createdAt) ?? nowMs;
		const last = await lastActivityMs(narratorId, root.createdAt);
		rootLive = root.status === "working" || root.status === "waiting";
		rootEnd = rootLive ? nowMs : (last ?? rootStart);
	}
	if (rootEnd < rootStart) rootEnd = rootStart;

	interface Pending {
		narrator: NarratorRow;
		depth: number;
		startMs: number;
		endMs: number;
		live: boolean;
		spawnItemId: string | null;
		spawnAtMs: number | null;
	}

	// Children are discovered lane by lane, so a parent's lane (with its spawn calls)
	// exists before its children are placed beneath it.
	const process = (pending: Pending): Promise<LaneBuild> =>
		buildLane(
			pending.narrator,
			{ startMs: pending.startMs, endMs: pending.endMs, live: pending.live },
			{
				depth: pending.depth,
				spawnItemId: pending.spawnItemId,
				spawnAtMs: pending.spawnAtMs,
				nowMs,
				loadChildren: pending.depth < MAX_DEPTH,
			},
			items,
		);

	const placeChildren = async (build: LaneBuild, depth: number): Promise<Pending[]> => {
		const pendings: Pending[] = [];
		for (const tool of build.toolItems) {
			if (!tool.childNarratorId) continue;
			if (pendings.length >= MAX_CHILDREN_PER_LANE) {
				omittedLanes++;
				continue;
			}
			const child = build.children.get(tool.id);
			if (!child) continue;
			const spawnAt =
				parseMs(tool.executionStartedAt) ??
				parseMs(tool.permissionStartedAt) ??
				parseMs(tool.streamStartedAt) ??
				parseMs(child.createdAt);
			if (spawnAt === null) continue;
			const childStart = Math.max(spawnAt, parseMs(child.createdAt) ?? spawnAt);
			const childLive =
				child.status === "working" || (!tool.completedAt && tool.status === "running");
			const last = await lastActivityMs(child.id, new Date(childStart).toISOString());
			const childEnd = childLive
				? nowMs
				: Math.max(
						childStart,
						parseMs(tool.isBackground ? null : tool.completedAt) ?? 0,
						last ?? 0,
					);
			pendings.push({
				narrator: child,
				depth,
				startMs: childStart,
				endMs: childEnd,
				live: childLive,
				spawnItemId: tool.id,
				spawnAtMs: spawnAt,
			});
		}
		return pendings;
	};

	const rootBuild = await process({
		narrator: root,
		depth: 0,
		startMs: rootStart,
		endMs: rootEnd,
		live: rootLive,
		spawnItemId: null,
		spawnAtMs: null,
	});

	// Depth-first: each lane is followed by its own descendants.
	const emit = async (build: LaneBuild, children: Pending[]) => {
		lanes.push(build.lane);
		for (const pending of children) {
			if (lanes.length >= MAX_LANES) {
				omittedLanes++;
				continue;
			}
			const childBuild = await process(pending);
			const grandChildren =
				pending.depth < MAX_DEPTH ? await placeChildren(childBuild, pending.depth + 1) : [];
			await emit(childBuild, grandChildren);
		}
	};
	await emit(rootBuild, await placeChildren(rootBuild, 1));

	// The primary lane is padded to the overall window, so a child outliving the turn
	// shows as `after_turn` on its parent instead of the parent simply stopping.
	const overallEnd = Math.max(rootEnd, ...lanes.map((lane) => lane.endMs));
	const primary = lanes[0];
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
		startMs: rootStart,
		endMs: overallEnd,
		lanes,
		items,
		omittedLanes,
	};
}
