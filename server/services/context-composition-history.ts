import type { Database } from "bun:sqlite";
import { type ContextSegment, safeCharacters } from "@shared/context-composition";
import { readContextSegments } from "./context-composition-projection";

export const CONTEXT_COMPOSITION_LIMITS = {
	batch: 64,
	pageSegments: 128,
	responseBytes: 256 * 1024,
} as const;
export const yieldContextReader = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
type NumericTool = {
	id: string;
	toolUseId: string;
	createdAt: string;
	inputChars: number;
	outputChars: number;
};

/** Replay numeric tool metadata in execution order without collecting an unbounded tool list. */
async function* readLatestMessageTools(database: Database, messageId: string, check: () => void) {
	let toolId = "";
	let toolTime = "";
	while (true) {
		check();
		const tools = database
			.query<NumericTool, [string, string, string, number]>(
				`SELECT t.id, t.tool_use_id AS toolUseId, t.created_at AS createdAt,
			 t.input_chars AS inputChars, t.output_chars AS outputChars
			 FROM narrator_tool_calls t WHERE t.message_id = ? AND (t.created_at, t.id) > (?, ?)
			 AND NOT EXISTS (SELECT 1 FROM narrator_tool_calls newer
			 WHERE newer.message_id = t.message_id AND newer.tool_use_id = t.tool_use_id AND
			 (newer.execution_attempt > t.execution_attempt OR
			 (newer.execution_attempt = t.execution_attempt AND
			 (newer.created_at > t.created_at OR (newer.created_at = t.created_at AND newer.id > t.id)))))
			 ORDER BY t.created_at, t.id LIMIT ?`,
			)
			.all(messageId, toolTime, toolId, CONTEXT_COMPOSITION_LIMITS.batch);
		if (!tools.length) return;
		for (const tool of tools) yield tool;
		toolId = tools[tools.length - 1].id;
		toolTime = tools[tools.length - 1].createdAt;
		await yieldContextReader();
	}
}

/** Keyset reader over numeric metadata only. Every query and event-loop slice is bounded. */
export async function* readContextHistory(
	database: Database,
	narratorId: string,
	options: { profile: "primary" | "subagent"; check: () => void },
): AsyncGenerator<ContextSegment> {
	const { check, profile } = options;
	check();
	let seq =
		database
			.query<{ seq: number }, [string, string]>(
				`SELECT r.seq FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id
				 WHERE r.narrator_id = ? AND r.is_compact = 1
				 AND (? = 'subagent' OR m.parent_tool_use_id IS NULL) ORDER BY r.seq DESC LIMIT 1`,
			)
			.get(narratorId, profile)?.seq ?? -1;
	while (true) {
		check();
		const rows = database
			.query<
				{
					seq: number;
					id: string;
					stats: string | null;
					role: string;
					hidden: string | null;
					parentToolUseId: string | null;
				},
				[string, number, number]
			>(
				`SELECT r.seq, m.id, m.context_chars_json AS stats, m.role, r.segment_compact_id AS hidden,
			 m.parent_tool_use_id AS parentToolUseId
			 FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id
			 WHERE r.narrator_id = ? AND r.seq > ? ORDER BY r.seq LIMIT ?`,
			)
			.all(narratorId, seq, CONTEXT_COMPOSITION_LIMITS.batch);
		if (!rows.length) return;
		for (const row of rows) {
			check();
			// Filter after the limited read so long fully compacted ranges still yield between batches.
			if (
				row.hidden ||
				row.role === "disp" ||
				(profile === "primary" && row.parentToolUseId !== null)
			)
				continue;
			const segments = readContextSegments(row.stats);
			if (row.role === "system") {
				// Legacy system messages are presentation metadata, except active segment summaries.
				for (const segment of segments) if (segment.category === "summary") yield segment;
				continue;
			}
			const placedToolInputs = new Set<string>();
			for (const segment of segments) {
				check();
				if (segment.category === "toolCall") {
					if (!segment.toolUseId || placedToolInputs.has(segment.toolUseId)) continue;
					const tool = database
						.query<{ inputChars: number }, [string, string]>(
							`SELECT input_chars AS inputChars FROM narrator_tool_calls
						 WHERE message_id = ? AND tool_use_id = ?
						 ORDER BY execution_attempt DESC, created_at DESC, id DESC LIMIT 1`,
						)
						.get(row.id, segment.toolUseId);
					placedToolInputs.add(segment.toolUseId);
					if (tool && tool.inputChars > 0)
						yield { category: "toolCall", chars: safeCharacters(tool.inputChars) };
					await yieldContextReader();
				} else if (segment.category !== "toolResult") yield segment;
			}
			// Older metadata has no positional markers. Preserve its fallback position once per call.
			for await (const tool of readLatestMessageTools(database, row.id, check)) {
				if (!placedToolInputs.has(tool.toolUseId) && tool.inputChars > 0)
					yield { category: "toolCall", chars: safeCharacters(tool.inputChars) };
			}
			// Results belong to the following user packet, after every assistant text/attachment/call.
			for await (const tool of readLatestMessageTools(database, row.id, check)) {
				if (tool.outputChars > 0)
					yield { category: "toolResult", chars: safeCharacters(tool.outputChars) };
			}
			await yieldContextReader();
		}
		seq = rows[rows.length - 1].seq;
		await yieldContextReader();
	}
}
