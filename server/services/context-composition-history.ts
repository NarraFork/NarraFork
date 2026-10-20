import type { Database, SQLQueryBindings } from "bun:sqlite";
import { type ContextSegment, safeCharacters } from "@shared/context-composition";
import type { SQL } from "bun";
import { readNativeRows } from "../db/worker-read";
import { isTopLevelMessage, type OwnTurnPlacement } from "../lib/runtime-source";
import { readContextSegments } from "./context-composition-projection";

/** Shared by SQLite and PostgreSQL. `?` placeholders are rewritten to `$1` for Postgres. */
export interface ContextQuery {
	get<T>(sql: string, bindings: readonly SQLQueryBindings[]): Promise<T | null>;
	all<T>(sql: string, bindings: readonly SQLQueryBindings[]): Promise<T[]>;
	run(sql: string, bindings: readonly SQLQueryBindings[]): Promise<void>;
	transaction(fn: (tx: ContextQuery) => Promise<void>): Promise<void>;
}

export function sqliteContextQuery(database: Database): ContextQuery {
	const query: ContextQuery = {
		async get<T>(sql: string, bindings: readonly SQLQueryBindings[]) {
			return (
				(
					await readNativeRows<T>(database, sql, [...bindings], {
						site: "context-composition.get",
					})
				)[0] ?? null
			);
		},
		async all<T>(sql: string, bindings: readonly SQLQueryBindings[]) {
			return readNativeRows<T>(database, sql, [...bindings], {
				site: "context-composition.all",
			});
		},
		async run(sql: string, bindings: readonly SQLQueryBindings[]) {
			database.query(sql).run(...bindings);
		},
		async transaction(fn) {
			const queued: Array<{ sql: string; bindings: readonly SQLQueryBindings[] }> = [];
			const tx: ContextQuery = {
				...query,
				async run(sql, bindings) {
					queued.push({ sql, bindings });
				},
				async transaction() {
					throw new Error("Nested context composition transaction");
				},
			};
			await fn(tx);
			database.transaction(() => {
				for (const statement of queued) database.query(statement.sql).run(...statement.bindings);
			})();
		},
	};
	return query;
}

const NUMERIC_FIELDS = new Set([
	"seq",
	"inputChars",
	"outputChars",
	"executionAttempt",
	"isLatest",
	"systemChars",
	"summaryChars",
	"toolsChars",
]);

function normalizeRow<T>(row: Record<string, unknown>): T {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (typeof value === "bigint") out[key] = Number(value);
		else if (typeof value === "string" && NUMERIC_FIELDS.has(key) && /^-?\d+$/.test(value))
			out[key] = Number(value);
		else if (
			(key === "stats" || key === "json" || key === "usage") &&
			value &&
			typeof value === "object"
		)
			out[key] = JSON.stringify(value);
		else out[key] = value;
	}
	return out as T;
}

/** `?` only appears as bindings in these statements, never inside literals. */
export function postgresPlaceholders(sql: string): string {
	let index = 0;
	return sql.replace(/\?/g, () => `$${++index}`);
}

export function postgresContextQuery(sql: SQL): ContextQuery {
	const run = async (statement: string, bindings: readonly SQLQueryBindings[]) =>
		sql.unsafe(postgresPlaceholders(statement), [...bindings]);
	const query: ContextQuery = {
		async get<T>(statement: string, bindings: readonly SQLQueryBindings[]) {
			const rows = (await run(statement, bindings)) as Record<string, unknown>[];
			return rows[0] ? normalizeRow<T>(rows[0]) : null;
		},
		async all<T>(statement: string, bindings: readonly SQLQueryBindings[]) {
			const rows = (await run(statement, bindings)) as Record<string, unknown>[];
			return rows.map((row) => normalizeRow<T>(row));
		},
		async run(statement: string, bindings: readonly SQLQueryBindings[]) {
			await run(statement, bindings);
		},
		async transaction(fn) {
			await sql.begin(async (tx) => {
				await fn(postgresContextQuery(tx as unknown as SQL));
			});
		},
	};
	return query;
}

function resolveContextQuery(source: Database | ContextQuery): ContextQuery {
	return typeof (source as Database).query === "function"
		? sqliteContextQuery(source as Database)
		: (source as ContextQuery);
}

export const CONTEXT_COMPOSITION_LIMITS = {
	batch: 64,
	toolBatch: 256,
	toolCache: 1024,
	sliceMs: 4,
	/**
	 * Cheap rows must still pause eventually so cancellation can run, but a timer
	 * turn per SQL batch made cold rebuild wall time track history length and
	 * tripped the slow-rebuild warning while SQL itself stayed small.
	 */
	sliceUnits: 2048,
	pageSegments: 128,
	responseBytes: 256 * 1024,
} as const;
export const yieldContextReader = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export interface ContextHistoryEntry {
	messageId: string;
	seq: number;
	segments: ContextSegment[];
}
/**
 * Which rows are the session's own turns (the `isTopLevelMessage` rule): rows with no
 * placement, plus rows placed under `topLevelToolUseId` — the tool call this session's
 * run delivers to. `"*"` keeps every placement (an unregistered legacy delegation,
 * whose destination is not known without a history lookup).
 */
export type TopLevelPlacement = { topLevelToolUseId: OwnTurnPlacement };
type Options = TopLevelPlacement & {
	check: () => void;
	messageIds?: readonly string[];
	afterSeq?: number;
};
type HistoryRow = {
	seq: number;
	id: string;
	stats: string | null;
	role: string;
	hidden: string | null;
	parentToolUseId: string | null;
};
type NumericTool = {
	id: string;
	messageId: string;
	toolUseId: string;
	createdAt: string;
	executionAttempt: number;
	inputChars: number;
	outputChars: number;
};
const TOOL_COLUMNS = `t.id, t.message_id AS "messageId", t.tool_use_id AS "toolUseId",
 t.created_at AS "createdAt", t.execution_attempt AS "executionAttempt",
 t.input_chars AS "inputChars", t.output_chars AS "outputChars"`;
const LATEST_TOOL = `NOT EXISTS (SELECT 1 FROM narrator_tool_calls newer
 WHERE newer.message_id = t.message_id AND newer.tool_use_id = t.tool_use_id AND
 (newer.execution_attempt, newer.created_at, newer.id) >
 (t.execution_attempt, t.created_at, t.id))`;
const placeholders = (length: number) => Array(length).fill("?").join(",");
/** SQL form of the own-turn rule: historical mount and current destination. */
export const topLevelSql = (alias: string) =>
	`(${alias}.parent_tool_use_id IS NULL OR ? IN ('*', ${alias}.parent_tool_use_id) OR ${alias}.parent_tool_use_id = ?)`;
export const topLevelBindings = (placement: OwnTurnPlacement): [string | null, string | null] =>
	Array.isArray(placement) ? placement : [placement, placement];
const visible = (row: HistoryRow, placement: OwnTurnPlacement) =>
	!row.hidden && row.role !== "disp" && isTopLevelMessage(row, placement);
const newerThan = (a: NumericTool, b: NumericTool) =>
	a.executionAttempt > b.executionAttempt ||
	(a.executionAttempt === b.executionAttempt &&
		(a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id)));
const executionOrder = (a: NumericTool, b: NumericTool) =>
	a.createdAt < b.createdAt
		? -1
		: a.createdAt > b.createdAt
			? 1
			: a.id < b.id
				? -1
				: a.id > b.id
					? 1
					: 0;

/**
 * Pause only after 4ms of work or a large cheap-unit budget.
 * Returning undefined (instead of an already-resolved promise) keeps the fast path
 * synchronous: awaiting a resolved promise once per segment is itself a timer-scale cost.
 */
function timeSlice(check: () => void) {
	let started = performance.now();
	let work = 0;
	return (count = 1): Promise<void> | undefined => {
		work += count;
		if (
			work < CONTEXT_COMPOSITION_LIMITS.sliceUnits &&
			performance.now() - started < CONTEXT_COMPOSITION_LIMITS.sliceMs
		)
			return;
		check();
		return yieldContextReader().then(() => {
			check();
			started = performance.now();
			work = 0;
		});
	};
}

/** Common path: read raw numeric rows once, reduce attempts in a bounded temporary map. */
async function readBatchTools(
	query: ContextQuery,
	rows: HistoryRow[],
	slice: ReturnType<typeof timeSlice>,
	check: () => void,
) {
	if (!rows.length) return new Map<string, Map<string, NumericTool>>();
	const byMessage = new Map<string, Map<string, NumericTool>>();
	let messageId = "";
	let id = "";
	let count = 0;
	while (true) {
		check();
		const tools = await query.all<NumericTool>(
			`SELECT ${TOOL_COLUMNS} FROM narrator_tool_calls t
			 WHERE t.message_id IN (${placeholders(rows.length)}) AND (t.message_id, t.id) > (?, ?)
			 ORDER BY t.message_id, t.id LIMIT ?`,
			[...rows.map((row) => row.id), messageId, id, CONTEXT_COMPOSITION_LIMITS.toolBatch],
		);
		for (const tool of tools) {
			// The sentinel is not retained. Large messages switch to bounded SQL streaming.
			if (++count > CONTEXT_COMPOSITION_LIMITS.toolCache) return null;
			let calls = byMessage.get(tool.messageId);
			if (!calls) {
				calls = new Map();
				byMessage.set(tool.messageId, calls);
			}
			const previous = calls.get(tool.toolUseId);
			if (!previous || newerThan(tool, previous)) calls.set(tool.toolUseId, tool);
			const pending = slice();
			if (pending) await pending;
		}
		if (tools.length < CONTEXT_COMPOSITION_LIMITS.toolBatch) return byMessage;
		messageId = tools[tools.length - 1].messageId;
		id = tools[tools.length - 1].id;
	}
}

/** Large-message fallback never collects tool rows; results are already entry output. */
async function* streamMessageTools(
	query: ContextQuery,
	messageId: string,
	check: () => void,
	slice: ReturnType<typeof timeSlice>,
) {
	let id = "";
	let time = "";
	while (true) {
		check();
		// Limit raw candidates, not matching latest rows: a 5000-attempt single call
		// must not scan all 5000 candidates synchronously merely to return one row.
		const tools = await query.all<NumericTool & { isLatest: number }>(
			`SELECT ${TOOL_COLUMNS}, ${LATEST_TOOL} AS "isLatest"
			 FROM narrator_tool_calls t WHERE t.message_id = ?
			 AND (t.created_at, t.id) > (?, ?)
			 ORDER BY t.created_at, t.id LIMIT ?`,
			[messageId, time, id, CONTEXT_COMPOSITION_LIMITS.toolBatch],
		);
		for (const tool of tools) {
			if (tool.isLatest) yield tool;
			const pending = slice();
			if (pending) await pending;
		}
		if (tools.length < CONTEXT_COMPOSITION_LIMITS.toolBatch) return;
		id = tools[tools.length - 1].id;
		time = tools[tools.length - 1].createdAt;
		// A 5000-attempt call is many full pages. Pause between pages so that scan cannot
		// run to completion on the main thread; the common batched reader stays on sliceUnits.
		await yieldContextReader();
	}
}

async function projectRow(
	query: ContextQuery,
	row: HistoryRow,
	tools: Map<string, NumericTool> | undefined,
	fallback: boolean,
	slice: ReturnType<typeof timeSlice>,
	check: () => void,
): Promise<ContextSegment[]> {
	const metadata = readContextSegments(row.stats);
	const segments: ContextSegment[] = [];
	if (row.role === "system") {
		for (const segment of metadata) {
			if (segment.category === "summary") segments.push(segment);
			const pending = slice();
			if (pending) await pending;
		}
		return segments;
	}
	const placed = new Set<string>();
	// Chunk marker lookups on fallback; do not query once per marker or retain every tool.
	for (let offset = 0; offset < metadata.length; offset += CONTEXT_COMPOSITION_LIMITS.batch) {
		const chunk = metadata.slice(offset, offset + CONTEXT_COMPOSITION_LIMITS.batch);
		let markerTools = tools;
		if (fallback) {
			const ids = [
				...new Set(
					chunk
						.filter((s) => s.category === "toolCall" && s.toolUseId && !placed.has(s.toolUseId))
						.map((s) => s.toolUseId as string),
				),
			];
			markerTools = new Map();
			if (ids.length) {
				check();
				const matches = await query.all<NumericTool>(
					`WITH requested(tool_use_id) AS (VALUES ${ids.map(() => "(?)").join(",")})
					 SELECT ${TOOL_COLUMNS} FROM requested
					 JOIN narrator_tool_calls t ON t.id = (
					 SELECT latest.id FROM narrator_tool_calls latest
					 WHERE latest.message_id = ? AND latest.tool_use_id = requested.tool_use_id
					 ORDER BY latest.execution_attempt DESC, latest.created_at DESC, latest.id DESC LIMIT 1)
					 LIMIT ?`,
					[...ids, row.id, CONTEXT_COMPOSITION_LIMITS.batch],
				);
				for (const tool of matches) markerTools.set(tool.toolUseId, tool);
			}
		}
		for (const segment of chunk) {
			if (segment.category === "toolCall") {
				if (segment.toolUseId && !placed.has(segment.toolUseId)) {
					placed.add(segment.toolUseId);
					const tool = markerTools?.get(segment.toolUseId);
					if (tool && tool.inputChars > 0)
						segments.push({ category: "toolCall", chars: safeCharacters(tool.inputChars) });
				}
			} else if (segment.category !== "toolResult") segments.push(segment);
			const pending = slice();
			if (pending) await pending;
		}
	}
	const results: ContextSegment[] = [];
	const append = (tool: NumericTool) => {
		if (!placed.has(tool.toolUseId) && tool.inputChars > 0)
			segments.push({ category: "toolCall", chars: safeCharacters(tool.inputChars) });
		if (tool.outputChars > 0)
			results.push({ category: "toolResult", chars: safeCharacters(tool.outputChars) });
	};
	if (fallback) {
		for await (const tool of streamMessageTools(query, row.id, check, slice)) append(tool);
	} else {
		for (const tool of [...(tools?.values() ?? [])].sort(executionOrder)) {
			append(tool);
			const pending = slice();
			if (pending) await pending;
		}
	}
	for (const result of results) {
		segments.push(result);
		const pending = slice();
		if (pending) await pending;
	}
	return segments;
}

/** Numeric-only full or targeted refs projection; empty entries invalidate old contributions. */
export async function* readContextHistoryEntries(
	source: Database | ContextQuery,
	narratorId: string,
	options: Options,
): AsyncGenerator<ContextHistoryEntry> {
	const query = resolveContextQuery(source);
	const { check, topLevelToolUseId: placement, messageIds } = options;
	const slice = timeSlice(check);
	check();
	const boundaryRow = await query.get<{ seq: number }>(
		`SELECT r.seq AS "seq" FROM narrator_message_refs r
		 JOIN narrator_message_context_stats s ON s.message_id = r.message_id
		 WHERE r.narrator_id = ? AND r.is_compact = 1
		 AND ${topLevelSql("s")} ORDER BY r.seq DESC LIMIT 1`,
		[narratorId, ...topLevelBindings(placement)],
	);
	const boundary = boundaryRow?.seq ?? -1;
	let seq = Math.max(boundary, options.afterSeq ?? -1);
	let targetOffset = 0;
	while (true) {
		check();
		const targets = messageIds?.slice(
			targetOffset,
			targetOffset + CONTEXT_COMPOSITION_LIMITS.batch,
		);
		if (targets && !targets.length) return;
		const rows = await query.all<HistoryRow>(
			`SELECT r.seq AS "seq", s.message_id AS "id", s.segments_json AS "stats", s.role AS "role",
			 r.segment_compact_id AS "hidden", s.parent_tool_use_id AS "parentToolUseId"
			 FROM narrator_message_refs r
			 JOIN narrator_message_context_stats s ON s.message_id = r.message_id
			 WHERE r.narrator_id = ?
			 AND ${targets ? `r.message_id IN (${placeholders(targets.length)})` : "r.seq > ?"}
			 ORDER BY r.seq LIMIT ?`,
			[narratorId, ...(targets ?? [seq]), CONTEXT_COMPOSITION_LIMITS.batch],
		);
		if (!rows.length && !targets) return;
		const active = rows.filter(
			(row) => row.seq > boundary && visible(row, placement) && row.role !== "system",
		);
		const tools = await readBatchTools(query, active, slice, check);
		for (const row of rows) {
			const segments =
				row.seq > boundary && visible(row, placement)
					? await projectRow(query, row, tools?.get(row.id), tools === null, slice, check)
					: [];
			yield { messageId: row.id, seq: row.seq, segments };
			const pending = slice();
			if (pending) await pending;
		}
		if (rows.length) seq = rows[rows.length - 1].seq;
		targetOffset += CONTEXT_COMPOSITION_LIMITS.batch;
	}
}

/** Compatibility wrapper for existing segment consumers. */
export async function* readContextHistory(
	source: Database | ContextQuery,
	narratorId: string,
	options: Options,
): AsyncGenerator<ContextSegment> {
	const slice = timeSlice(options.check);
	for await (const entry of readContextHistoryEntries(source, narratorId, options)) {
		for (const segment of entry.segments) {
			yield segment;
			const pending = slice();
			if (pending) await pending;
		}
	}
}
