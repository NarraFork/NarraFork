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
const MAX_BATCH_QUERIES = 10;
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
		'- "search": Full-text search across all narrator messages. Returns matching snippets with metadata. ' +
		"Pass an array of strings to `query` to run multiple searches in one call.\n" +
		'- "read_conversation": Read messages from a specific narrator session. ' +
		"Optionally center around a specific message ID (e.g. from a search result).",
	parameters: z.object({
		action: z
			.enum(["search", "read_conversation"])
			.describe('The action to perform: "search" or "read_conversation"'),
		query: z
			.union([z.string(), z.array(z.string())])
			.optional()
			.describe(
				'Search query (required for action "search"). ' +
					"Pass an array to run multiple searches in one call.",
			),
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
			query?: string | string[];
			narrator_id?: string;
			message_id?: string;
			limit?: number;
		};

		if (action === "search") {
			const queries = Array.isArray(query) ? query : [query];
			if (queries.length === 1) {
				return handleSearch(queries[0], limit);
			}
			if (queries.length > MAX_BATCH_QUERIES) {
				return {
					output: `Too many queries (${queries.length}). Maximum is ${MAX_BATCH_QUERIES}.`,
					isError: true,
				};
			}
			// Batch: run each query independently and merge results
			const sections: string[] = [];
			const allResults: SearchResultItem[] = [];
			const queryList: string[] = [];
			let errorCount = 0;
			for (const q of queries) {
				const result = handleSearch(q, limit);
				if (result.isError) errorCount++;
				sections.push(result.output);
				// Collect structured results from each sub-search
				const meta = result.metadata as SearchMetadata | undefined;
				if (meta?.results) allResults.push(...meta.results);
				if (q) queryList.push(q);
			}
			return {
				output: sections.join("\n\n---\n\n"),
				isError: errorCount === queries.length,
				title: `Recall: ${queries.length} queries`,
				metadata: {
					action: "search",
					queries: queryList,
					results: allResults,
				} satisfies BatchSearchMetadata,
			};
		}
		return handleReadConversation(narrator_id, message_id, limit);
	},
};

// ---------------------------------------------------------------------------
// Types for structured metadata
// ---------------------------------------------------------------------------

interface SearchResultItem {
	id: string;
	narratorId: string;
	narratorTitle: string | null;
	chapterId: string | null;
	role: string;
	createdAt: string;
	snippet: string;
}

interface SearchMetadata {
	action: "search";
	query: string;
	results: SearchResultItem[];
}

interface BatchSearchMetadata {
	action: "search";
	queries: string[];
	results: SearchResultItem[];
}

interface ConversationMessage {
	id: string;
	seq: number;
	role: string;
	text: string;
	createdAt: string;
}

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
		return {
			output: `No results found for "${query}".`,
			metadata: { action: "search", query, results: [] } satisfies SearchMetadata,
		};
	}

	const results: SearchResultItem[] = rows.map((row) => ({
		id: row.id,
		narratorId: row.narrator_id,
		narratorTitle: row.narrator_title ?? null,
		chapterId: row.chapter_id ?? null,
		role: row.role,
		createdAt: row.created_at,
		snippet: (row.snippet ?? "").replace(/\n/g, " ").slice(0, SNIPPET_CHARS),
	}));

	const lines: string[] = [`Found ${rows.length} result(s) for "${query}":\n`];
	for (const r of results) {
		lines.push(
			`- [${r.role}] message ${r.id}` +
				`  narrator=${r.narratorId}` +
				(r.narratorTitle ? ` ("${r.narratorTitle}")` : "") +
				(r.chapterId ? `  chapter=${r.chapterId}` : "") +
				`  at ${r.createdAt}` +
				`\n  ${r.snippet}`,
		);
	}

	return {
		output: lines.join("\n"),
		title: `Recall: ${query}`,
		metadata: { action: "search", query, results } satisfies SearchMetadata,
	};
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

	const messages: ConversationMessage[] = rows.map((row) => ({
		id: row.id,
		seq: row.seq,
		role: row.role,
		text: (row.content_text ?? "").slice(0, 500),
		createdAt: row.created_at,
	}));

	const header =
		`Narrator: ${narrator.title ?? narratorId}` +
		(narrator.chapter_id ? ` (chapter ${narrator.chapter_id})` : "") +
		(narrator.model ? ` [${narrator.model}]` : "") +
		`\nShowing ${rows.length} message(s):\n`;

	const lines: string[] = [header];
	for (const msg of messages) {
		const text = msg.text.replace(/\n/g, "\n  ");
		lines.push(`[seq=${msg.seq}] ${msg.role} (${msg.id}) at ${msg.createdAt}:\n  ${text}\n`);
	}

	return {
		output: lines.join("\n"),
		title: `Conversation: ${narrator.title ?? narratorId}`,
		metadata: {
			action: "read_conversation",
			narratorId,
			narratorTitle: narrator.title,
			chapterId: narrator.chapter_id,
			model: narrator.model,
			messages,
		},
	};
}
