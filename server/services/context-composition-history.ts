import type { Database } from "bun:sqlite";
import { type ContextSegment, safeCharacters } from "@shared/context-composition";
import { readContextSegments } from "./context-composition-projection";

export const CONTEXT_COMPOSITION_LIMITS = {
	batch: 64,
	toolBatch: 256,
	toolCache: 1024,
	sliceMs: 4,
	pageSegments: 128,
	responseBytes: 256 * 1024,
} as const;
export const yieldContextReader = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export interface ContextHistoryEntry {
	messageId: string;
	seq: number;
	segments: ContextSegment[];
}
type Options = {
	profile: "primary" | "subagent";
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
const TOOL_COLUMNS = `t.id, t.message_id AS messageId, t.tool_use_id AS toolUseId,
 t.created_at AS createdAt, t.execution_attempt AS executionAttempt,
 t.input_chars AS inputChars, t.output_chars AS outputChars`;
const LATEST_TOOL = `NOT EXISTS (SELECT 1 FROM narrator_tool_calls newer
 WHERE newer.message_id = t.message_id AND newer.tool_use_id = t.tool_use_id AND
 (newer.execution_attempt, newer.created_at, newer.id) >
 (t.execution_attempt, t.created_at, t.id))`;
const placeholders = (length: number) => Array(length).fill("?").join(",");
const visible = (row: HistoryRow, profile: Options["profile"]) =>
	!row.hidden && row.role !== "disp" && (profile === "subagent" || row.parentToolUseId === null);
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

/** Check cancellation at boundaries; yield after 4ms or a hard work-count boundary. */
function timeSlice(check: () => void) {
	let started = performance.now();
	let work = 0;
	return async (count = 1, force = false) => {
		work += count;
		if (
			!force &&
			work < CONTEXT_COMPOSITION_LIMITS.toolBatch &&
			performance.now() - started < CONTEXT_COMPOSITION_LIMITS.sliceMs
		)
			return;
		check();
		await yieldContextReader();
		check();
		started = performance.now();
		work = 0;
	};
}

/** Common path: read raw numeric rows once, reduce attempts in a bounded temporary map. */
async function readBatchTools(
	database: Database,
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
		const tools = database
			.query<NumericTool, (string | number)[]>(
				`SELECT ${TOOL_COLUMNS} FROM narrator_tool_calls t
			 WHERE t.message_id IN (${placeholders(rows.length)}) AND (t.message_id, t.id) > (?, ?)
			 ORDER BY t.message_id, t.id LIMIT ?`,
			)
			.all(...rows.map((row) => row.id), messageId, id, CONTEXT_COMPOSITION_LIMITS.toolBatch);
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
			await slice();
		}
		if (tools.length < CONTEXT_COMPOSITION_LIMITS.toolBatch) return byMessage;
		messageId = tools[tools.length - 1].messageId;
		id = tools[tools.length - 1].id;
		await slice(0, true);
	}
}

/** Large-message fallback never collects tool rows; results are already entry output. */
async function* streamMessageTools(
	database: Database,
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
		const tools = database
			.query<NumericTool & { isLatest: number }, (string | number)[]>(
				`SELECT ${TOOL_COLUMNS}, ${LATEST_TOOL} AS isLatest
			 FROM narrator_tool_calls t WHERE t.message_id = ?
			 AND (t.created_at, t.id) > (?, ?)
			 ORDER BY t.created_at, t.id LIMIT ?`,
			)
			.all(messageId, time, id, CONTEXT_COMPOSITION_LIMITS.toolBatch);
		for (const tool of tools) {
			if (tool.isLatest) yield tool;
			await slice();
		}
		if (tools.length < CONTEXT_COMPOSITION_LIMITS.toolBatch) return;
		id = tools[tools.length - 1].id;
		time = tools[tools.length - 1].createdAt;
		await slice(0, true);
	}
}

async function projectRow(
	database: Database,
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
			await slice();
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
				const matches = database
					.query<NumericTool, (string | number)[]>(
						`WITH requested(tool_use_id) AS (VALUES ${ids.map(() => "(?)").join(",")})
					 SELECT ${TOOL_COLUMNS} FROM requested
					 JOIN narrator_tool_calls t ON t.id = (
					 SELECT latest.id FROM narrator_tool_calls latest
					 WHERE latest.message_id = ? AND latest.tool_use_id = requested.tool_use_id
					 ORDER BY latest.execution_attempt DESC, latest.created_at DESC, latest.id DESC LIMIT 1)
					 LIMIT ?`,
					)
					.all(...ids, row.id, CONTEXT_COMPOSITION_LIMITS.batch);
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
			await slice();
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
		for await (const tool of streamMessageTools(database, row.id, check, slice)) append(tool);
	} else {
		for (const tool of [...(tools?.values() ?? [])].sort(executionOrder)) {
			append(tool);
			await slice();
		}
	}
	for (const result of results) {
		segments.push(result);
		await slice();
	}
	return segments;
}

/** Numeric-only full or targeted refs projection; empty entries invalidate old contributions. */
export async function* readContextHistoryEntries(
	database: Database,
	narratorId: string,
	options: Options,
): AsyncGenerator<ContextHistoryEntry> {
	const { check, profile, messageIds } = options;
	const slice = timeSlice(check);
	check();
	const boundary =
		database
			.query<{ seq: number }, [string, string]>(
				`SELECT r.seq FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id
		 WHERE r.narrator_id = ? AND r.is_compact = 1
		 AND (? = 'subagent' OR m.parent_tool_use_id IS NULL) ORDER BY r.seq DESC LIMIT 1`,
			)
			.get(narratorId, profile)?.seq ?? -1;
	let seq = Math.max(boundary, options.afterSeq ?? -1);
	let targetOffset = 0;
	while (true) {
		check();
		const targets = messageIds?.slice(
			targetOffset,
			targetOffset + CONTEXT_COMPOSITION_LIMITS.batch,
		);
		if (targets && !targets.length) return;
		const rows = database
			.query<HistoryRow, (string | number)[]>(
				`SELECT r.seq, m.id, m.context_chars_json AS stats, m.role, r.segment_compact_id AS hidden,
			 m.parent_tool_use_id AS parentToolUseId FROM narrator_message_refs r
			 JOIN narrator_messages m ON m.id = r.message_id WHERE r.narrator_id = ?
			 AND ${targets ? `r.message_id IN (${placeholders(targets.length)})` : "r.seq > ?"}
			 ORDER BY r.seq LIMIT ?`,
			)
			.all(narratorId, ...(targets ?? [seq]), CONTEXT_COMPOSITION_LIMITS.batch);
		if (!rows.length && !targets) return;
		const active = rows.filter(
			(row) => row.seq > boundary && visible(row, profile) && row.role !== "system",
		);
		const tools = await readBatchTools(database, active, slice, check);
		for (const row of rows) {
			const segments =
				row.seq > boundary && visible(row, profile)
					? await projectRow(database, row, tools?.get(row.id), tools === null, slice, check)
					: [];
			yield { messageId: row.id, seq: row.seq, segments };
			await slice();
		}
		if (rows.length) seq = rows[rows.length - 1].seq;
		targetOffset += CONTEXT_COMPOSITION_LIMITS.batch;
		await slice(0, true);
	}
}

/** Compatibility wrapper for existing segment consumers. */
export async function* readContextHistory(
	database: Database,
	narratorId: string,
	options: Options,
): AsyncGenerator<ContextSegment> {
	const slice = timeSlice(options.check);
	for await (const entry of readContextHistoryEntries(database, narratorId, options)) {
		for (const segment of entry.segments) {
			yield segment;
			await slice();
		}
	}
}
