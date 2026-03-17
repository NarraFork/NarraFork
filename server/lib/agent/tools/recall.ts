import { z } from "zod/v4";
import { sqlite } from "../../../db";
import { buildFtsQuery, sanitizeQuery } from "../../../services/search-service";
import type { ToolDefinition, ToolResult } from "../types";

/**
 * Recall — optional agent tool for full-text search and browsing of all
 * narrator conversations stored in NarraFork.
 */

const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_READ_LIMIT = 50;
const DEFAULT_READ_LIMIT = 20;
const SNIPPET_CHARS = 300;

export const recallTool: ToolDefinition = {
	name: "Recall",
	description:
		"Search and browse all narrator conversations in NarraFork. " +
		"Use this to recall previous discussions, find relevant context from other sessions, " +
		"or explore what was discussed in any chapter.\n\n" +
		"Two actions are available:\n" +
		'- "search": Full-text search across all narrator messages. Returns matching snippets with metadata.\n' +
		'- "read_conversation": Read messages from a specific narrator session. ' +
		"Optionally center around a specific message ID (e.g. from a search result).",
	parameters: z.object({
		action: z
			.enum(["search", "read_conversation"])
			.describe('The action to perform: "search" or "read_conversation"'),
		query: z.string().optional().describe('Search query string (required for action "search")'),
		narrator_id: z
			.string()
			.optional()
			.describe('Narrator ID to read messages from (required for action "read_conversation")'),
		message_id: z
			.string()
			.optional()
			.describe(
				"Optional message ID to center the read around. " +
					"If omitted, returns the most recent messages.",
			),
		limit: z
			.number()
			.optional()
			.describe(
				`Number of results to return. Default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}.`,
			),
	}),

	async execute(args): Promise<ToolResult> {
		const { action, query, narrator_id, message_id, limit } = args as {
			action: "search" | "read_conversation";
			query?: string;
			narrator_id?: string;
			message_id?: string;
			limit?: number;
		};

		if (action === "search") {
			return handleSearch(query, limit);
		}
		return handleReadConversation(narrator_id, message_id, limit);
	},
};

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

function handleSearch(query: string | undefined, limit: number | undefined): ToolResult {
	if (!query) {
		return { output: 'Parameter "query" is required for action "search".', isError: true };
	}

	const safeQuery = sanitizeQuery(query);
	if (!safeQuery) {
		return { output: "Query is empty after sanitization.", isError: true };
	}

	const cap = Math.min(Math.max(limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
	const useFts = safeQuery.length >= 3;

	// biome-ignore lint/suspicious/noExplicitAny: dynamic SQL rows
	let rows: any[];

	if (useFts) {
		const ftsExpr = buildFtsQuery(safeQuery);
		rows = sqlite
			.prepare(
				`SELECT m.id, m.narrator_id, m.role, m.created_at,
				        n.title AS narrator_title, n.chapter_id,
				        snippet(narrator_messages_fts, 0, '>>>', '<<<', '...', 64) AS snippet
				 FROM narrator_messages_fts
				 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
				 JOIN narrators n ON n.id = m.narrator_id
				 WHERE narrator_messages_fts MATCH ?
				 ORDER BY rank
				 LIMIT ?`,
			)
			.all(ftsExpr, cap);
	} else {
		const like = `%${safeQuery}%`;
		rows = sqlite
			.prepare(
				`SELECT m.id, m.narrator_id, m.role, m.created_at,
				        n.title AS narrator_title, n.chapter_id,
				        substr(m.content_text, 1, ?) AS snippet
				 FROM narrator_messages m
				 JOIN narrators n ON n.id = m.narrator_id
				 WHERE m.content_text LIKE ?
				 ORDER BY m.created_at DESC
				 LIMIT ?`,
			)
			.all(SNIPPET_CHARS, like, cap);
	}

	if (rows.length === 0) {
		return { output: `No results found for "${query}".` };
	}

	const lines: string[] = [`Found ${rows.length} result(s) for "${query}":\n`];
	for (const row of rows) {
		lines.push(
			`- [${row.role}] message ${row.id}` +
				`  narrator=${row.narrator_id}` +
				(row.narrator_title ? ` ("${row.narrator_title}")` : "") +
				(row.chapter_id ? `  chapter=${row.chapter_id}` : "") +
				`  at ${row.created_at}` +
				`\n  ${(row.snippet ?? "").replace(/\n/g, " ").slice(0, SNIPPET_CHARS)}`,
		);
	}

	return { output: lines.join("\n"), title: `Recall: ${query}` };
}

// ---------------------------------------------------------------------------
// read_conversation
// ---------------------------------------------------------------------------

function handleReadConversation(
	narratorId: string | undefined,
	messageId: string | undefined,
	limit: number | undefined,
): ToolResult {
	if (!narratorId) {
		return {
			output: 'Parameter "narrator_id" is required for action "read_conversation".',
			isError: true,
		};
	}

	const cap = Math.min(Math.max(limit ?? DEFAULT_READ_LIMIT, 1), MAX_READ_LIMIT);

	// Verify narrator exists
	const narrator = sqlite
		.prepare("SELECT id, title, chapter_id, model FROM narrators WHERE id = ?")
		.get(narratorId) as
		| { id: string; title: string | null; chapter_id: string | null; model: string | null }
		| undefined;

	if (!narrator) {
		return { output: `Narrator "${narratorId}" not found.`, isError: true };
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic SQL rows
	let rows: any[];

	if (messageId) {
		// Find the seq of the target message in this narrator's refs
		const ref = sqlite
			.prepare("SELECT seq FROM narrator_message_refs WHERE narrator_id = ? AND message_id = ?")
			.get(narratorId, messageId) as { seq: number } | undefined;

		if (!ref) {
			return {
				output: `Message "${messageId}" not found in narrator "${narratorId}".`,
				isError: true,
			};
		}

		const half = Math.floor(cap / 2);
		rows = sqlite
			.prepare(
				`SELECT m.id, m.role, m.content_text, m.created_at, r.seq
				 FROM narrator_message_refs r
				 JOIN narrator_messages m ON m.id = r.message_id
				 WHERE r.narrator_id = ? AND r.seq >= ? AND r.seq <= ?
				 ORDER BY r.seq ASC`,
			)
			.all(narratorId, ref.seq - half, ref.seq + (cap - half));
	} else {
		// Latest messages
		rows = sqlite
			.prepare(
				`SELECT m.id, m.role, m.content_text, m.created_at, r.seq
				 FROM narrator_message_refs r
				 JOIN narrator_messages m ON m.id = r.message_id
				 WHERE r.narrator_id = ?
				 ORDER BY r.seq DESC
				 LIMIT ?`,
			)
			.all(narratorId, cap);
		rows.reverse();
	}

	if (rows.length === 0) {
		return { output: `No messages found for narrator "${narratorId}".` };
	}

	const header =
		`Narrator: ${narrator.title ?? narratorId}` +
		(narrator.chapter_id ? ` (chapter ${narrator.chapter_id})` : "") +
		(narrator.model ? ` [${narrator.model}]` : "") +
		`\nShowing ${rows.length} message(s):\n`;

	const lines: string[] = [header];
	for (const row of rows) {
		const text = (row.content_text ?? "").slice(0, 500).replace(/\n/g, "\n  ");
		lines.push(`[seq=${row.seq}] ${row.role} (${row.id}) at ${row.created_at}:\n  ${text}\n`);
	}

	return {
		output: lines.join("\n"),
		title: `Conversation: ${narrator.title ?? narratorId}`,
	};
}
