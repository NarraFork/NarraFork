import type { Database } from "bun:sqlite";
import { getToolCallSummary } from "../agent/recall-tool-summary";

export interface RecallConversationParams {
	kind: "recallConversation";
	narratorId: string;
	messageId?: string;
	limit: number;
}

interface ConversationMessageRow {
	id: string;
	role: string;
	created_at: string;
	seq: number;
}

interface ConversationToolRow {
	tool_use_id: string;
	tool_name: string;
	status: string;
	message_id: string;
}

export type RecallConversationSnapshot =
	| { kind: "narratorMissing" }
	| { kind: "messageMissing" }
	| {
			kind: "found";
			narrator: { title: string | null; model: string | null };
			rows: (ConversationMessageRow & { text: string })[];
			tools: (ConversationToolRow & { summary: string })[];
	  };

const MAX_MESSAGES = 50;
const MAX_TOOLS = 10_000;
const MAX_TOOL_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MESSAGE_TEXT_LIMIT = 500;

export function readRecallConversation(
	db: Database,
	{ narratorId, messageId, limit }: RecallConversationParams,
	signal: AbortSignal,
): RecallConversationSnapshot {
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGES) {
		throw new Error("Invalid Recall conversation limit");
	}
	const check = () => signal.throwIfAborted();
	const budgetError = () => new Error("Recall conversation exceeds its read budget");
	check();
	return db.transaction((): RecallConversationSnapshot => {
		const narrator = db
			.query<{ title: string | null; model: string | null; oversized: number }, [string]>(
				`SELECT CASE WHEN octet_length(title) <= ${MAX_RESULT_BYTES} THEN title END AS title,
					CASE WHEN octet_length(model) <= ${MAX_RESULT_BYTES} THEN model END AS model,
					coalesce(octet_length(title), 0) + coalesce(octet_length(model), 0) > ${MAX_RESULT_BYTES} AS oversized
				FROM narrators WHERE id = ?`,
			)
			.get(narratorId);
		if (!narrator) return { kind: "narratorMissing" };
		if (narrator.oversized) throw budgetError();

		type MessageSource = ConversationMessageRow & { content_prefix: Uint8Array | null };
		const messagesSql = `SELECT m.id, m.role, m.created_at, r.seq,
				substr(CAST(m.content_text AS BLOB), 1, ${MESSAGE_TEXT_LIMIT * 4}) AS content_prefix
			FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id
			WHERE r.narrator_id = ?`;
		let messages: MessageSource[];
		if (messageId) {
			const ref = db
				.query<{ seq: number }, [string, string]>(
					"SELECT seq FROM narrator_message_refs WHERE narrator_id = ? AND message_id = ?",
				)
				.get(narratorId, messageId);
			if (!ref) return { kind: "messageMissing" };
			const half = Math.floor(limit / 2);
			// The anchored window is inclusive, and can contain limit + 1 messages.
			messages = db
				.query<MessageSource, [string, number, number]>(
					`${messagesSql} AND r.seq BETWEEN ? AND ? ORDER BY r.seq ASC LIMIT ${MAX_MESSAGES + 2}`,
				)
				.all(narratorId, ref.seq - half, ref.seq + limit - half);
			if (messages.length > MAX_MESSAGES + 1) throw budgetError();
		} else {
			messages = db
				.query<MessageSource, [string, number]>(`${messagesSql} ORDER BY r.seq DESC LIMIT ?`)
				.all(narratorId, limit)
				.reverse();
		}

		const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
		const rows = messages.map(({ content_prefix, ...row }) => ({
			...row,
			text: content_prefix ? decoder.decode(content_prefix).slice(0, MESSAGE_TEXT_LIMIT) : "",
		}));
		const result: Extract<RecallConversationSnapshot, { kind: "found" }> = {
			kind: "found",
			narrator: { title: narrator.title, model: narrator.model },
			rows,
			tools: [],
		};
		let resultBytes = Buffer.byteLength(JSON.stringify(result));
		if (resultBytes > MAX_RESULT_BYTES) throw budgetError();
		if (!rows.length) return result;
		const messageIds = rows.map((row) => row.id);
		const toolScope = `FROM narrator_tool_calls
			WHERE narrator_id = ? AND message_id IN (${messageIds.map(() => "?").join(",")})`;
		const args = [narratorId, ...messageIds];
		const admission = db
			.query<{ rows: number; bytes: number }, string[]>(
				`SELECT count(*) AS rows, coalesce(sum(bytes), 0) AS bytes FROM (
					SELECT coalesce(octet_length(input_json), 0) + octet_length(tool_use_id) +
						octet_length(tool_name) + octet_length(status) + octet_length(message_id) AS bytes
					${toolScope} LIMIT ${MAX_TOOLS + 1}
				)`,
			)
			.get(...args);
		if (!admission || admission.rows > MAX_TOOLS || admission.bytes > MAX_TOOL_SOURCE_BYTES) {
			throw budgetError();
		}
		const tools = db.query<ConversationToolRow & { input_json: string | null }, string[]>(
			`SELECT tool_use_id, tool_name, status, message_id, input_json
			${toolScope} ORDER BY created_at ASC`,
		);
		for (const { input_json, ...tool } of tools.iterate(...args)) {
			check();
			let input: unknown;
			try {
				input = input_json ? JSON.parse(input_json) : null;
			} catch {
				// Old malformed payloads still have a tool-name summary.
			}
			const item = { ...tool, summary: getToolCallSummary(tool.tool_name, input) };
			resultBytes += Buffer.byteLength(JSON.stringify(item)) + 1;
			if (resultBytes > MAX_RESULT_BYTES) throw budgetError();
			result.tools.push(item);
		}
		return result;
	})();
}
