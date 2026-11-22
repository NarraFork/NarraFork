import { z } from "zod/v4";
import { sqlite } from "../../../db";
import { searchStore } from "../../../services/search/backend";
import { globalStrategy, sanitizeQuery } from "../../../services/search/query";
import type { RecallMessageRow } from "../../../services/search/types";
import { runReadTask, WorkersUnavailableError } from "../../db-worker/pool";
import type { RecallConversationSnapshot } from "../../db-worker/recall-conversation-query";
import type { ToolDefinition, ToolResult } from "../types";

/**
 * Recall — optional agent tool for full-text search and browsing of the
 * current narrator conversation stored in NarraFork.
 *
 * The message SEARCH runs through the search port (`services/search/`), so its FTS5
 * expression, snippet markup and time filtering live with the other search statements rather
 * than in a second copy here. Conversation browsing and tool-call payloads use committed SQLite Worker snapshots.
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
		"Search and browse narrator conversations stored in NarraFork. " +
		"By default this tool is self-scoped: search, conversation reads, and tool-call reads " +
		"can only access the narrator that is currently running this tool.\n\n" +
		"Set `all_narrators: true` to search and read across ALL narrators in NarraFork " +
		"instead of just the current one. This wider access requires user approval unless " +
		'the narrator is in "allow all" (bypass) permission mode, where it is granted automatically.\n\n' +
		"Three actions are available:\n" +
		'- "search": Full-text search across narrator messages. Returns matching snippets with metadata. ' +
		"Pass an array of strings to `query` to run multiple searches in one call. " +
		"Optionally restrict by absolute time (`from`, `to`) or relative time (`time_range`, e.g. 24h, 7d).\n" +
		'- "read_conversation": Read messages from a narrator session. ' +
		"Each assistant message includes a summary of its tool calls (tool name + key params). " +
		"Optionally center around a specific message ID (e.g. from a search result).\n" +
		'- "read_tool_call": Read the full input/output of a tool call by its toolUseId ' +
		"(obtained from read_conversation results).",
	parameters: z.object({
		action: z
			.enum(["search", "read_conversation", "read_tool_call"])
			.describe('The action to perform: "search", "read_conversation", or "read_tool_call"'),
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
			.describe(
				'Optional narrator ID for action "read_conversation". When `all_narrators` is false ' +
					"it must match the current narrator; when `all_narrators` is true it may be any narrator.",
			),
		all_narrators: z
			.boolean()
			.optional()
			.describe(
				"When true, search and read across ALL narrators instead of only the current one. " +
					'Requires user approval unless the narrator is in "allow all" (bypass) permission mode. ' +
					"Defaults to false (self-scoped).",
			),
		message_id: z
			.string()
			.optional()
			.describe(
				"Optional message ID to center the read around. " +
					"If omitted, returns the most recent messages.",
			),
		tool_call_id: z
			.string()
			.optional()
			.describe('The toolUseId of the tool call to read (required for action "read_tool_call")'),
		limit: z
			.number()
			.optional()
			.describe(
				`Number of results to return. Default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}.`,
			),
		from: z
			.string()
			.optional()
			.describe(
				'Optional absolute start time for search results, inclusive. Supports ISO strings, "YYYY-MM-DD", and "YYYY-MM-DD HH:mm".',
			),
		to: z
			.string()
			.optional()
			.describe(
				'Optional absolute end time for search results, inclusive. Supports ISO strings, "YYYY-MM-DD", and "YYYY-MM-DD HH:mm".',
			),
		time_range: z
			.string()
			.optional()
			.describe(
				'Optional relative time window for search results, such as "24h", "7d", "2w", "1mo", or "1y". Ignored when from/to is provided.',
			),
	}),

	async execute(args, ctx): Promise<ToolResult> {
		const currentNarratorId = ctx.narratorId;
		const {
			action,
			query,
			narrator_id,
			message_id,
			tool_call_id,
			limit,
			from,
			to,
			time_range,
			all_narrators,
		} = args as {
			action: "search" | "read_conversation" | "read_tool_call";
			query?: string | string[];
			narrator_id?: string;
			message_id?: string;
			tool_call_id?: string;
			limit?: number;
			from?: string;
			to?: string;
			time_range?: string;
			all_narrators?: boolean;
		};

		const allNarrators = all_narrators === true;

		if (action === "search") {
			const timeFilterResult = buildTimeFilter({ from, to, timeRange: time_range });
			if (timeFilterResult.isError) return timeFilterResult;
			const timeFilter = timeFilterResult.filter;
			const queries = Array.isArray(query) ? query : [query];
			if (queries.length === 1) {
				return handleSearch(
					queries[0],
					limit,
					timeFilter,
					currentNarratorId,
					allNarrators,
					ctx.signal,
				);
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
				const result = await handleSearch(
					q,
					limit,
					timeFilter,
					currentNarratorId,
					allNarrators,
					ctx.signal,
				);
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
					...(timeFilter ? { timeFilter } : {}),
				} satisfies BatchSearchMetadata,
			};
		}
		if (action === "read_tool_call") {
			return handleReadToolCall(tool_call_id, currentNarratorId, allNarrators, ctx.signal);
		}
		return handleReadConversation(
			narrator_id,
			message_id,
			limit,
			currentNarratorId,
			allNarrators,
			ctx.signal,
		);
	},
};

// ---------------------------------------------------------------------------
// Types for structured metadata
// ---------------------------------------------------------------------------

interface SearchResultItem {
	id: string;
	narratorId: string;
	narratorTitle: string | null;
	role: string;
	createdAt: string;
	snippet: string;
}

interface TimeFilter {
	from?: string;
	to?: string;
	timeRange?: string;
}

interface SearchMetadata {
	action: "search";
	query: string;
	results: SearchResultItem[];
	timeFilter?: TimeFilter;
}

interface BatchSearchMetadata {
	action: "search";
	queries: string[];
	results: SearchResultItem[];
	timeFilter?: TimeFilter;
}

interface ConversationToolCall {
	toolUseId: string;
	toolName: string;
	status: string;
	summary: string;
}

interface ConversationMessage {
	id: string;
	seq: number;
	role: string;
	text: string;
	createdAt: string;
	toolCalls?: ConversationToolCall[];
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

function isDateOnly(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function normalizeDateLike(value: string): string {
	const trimmed = value.trim();
	return trimmed.includes(" ") && !trimmed.includes("T") ? trimmed.replace(" ", "T") : trimmed;
}

function parseAbsoluteTime(value: string, boundary: "from" | "to"): string | null {
	const normalized = isDateOnly(value)
		? `${value.trim()}T${boundary === "to" ? "23:59:59.999" : "00:00:00.000"}`
		: normalizeDateLike(value);
	const date = new Date(normalized);
	if (Number.isNaN(date.getTime())) return null;
	return date.toISOString();
}

function applyRelativeTimeRange(now: Date, amount: number, unit: string): Date {
	const from = new Date(now);
	const normalized = unit.toLowerCase();
	if (["m", "min", "mins", "minute", "minutes"].includes(normalized)) {
		from.setMinutes(from.getMinutes() - amount);
	} else if (["h", "hr", "hrs", "hour", "hours"].includes(normalized)) {
		from.setHours(from.getHours() - amount);
	} else if (["d", "day", "days"].includes(normalized)) {
		from.setDate(from.getDate() - amount);
	} else if (["w", "week", "weeks"].includes(normalized)) {
		from.setDate(from.getDate() - amount * 7);
	} else if (["mo", "month", "months"].includes(normalized)) {
		from.setMonth(from.getMonth() - amount);
	} else if (["y", "yr", "yrs", "year", "years"].includes(normalized)) {
		from.setFullYear(from.getFullYear() - amount);
	}
	return from;
}

function parseRelativeTimeRange(value: string): { from: string; to: string } | null {
	const match = value
		.trim()
		.match(
			/^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|yr|yrs|year|years)$/i,
		);
	if (!match) return null;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return null;
	const now = new Date();
	return {
		from: applyRelativeTimeRange(now, amount, match[2]).toISOString(),
		to: now.toISOString(),
	};
}

function buildTimeFilter(input: {
	from?: string;
	to?: string;
	timeRange?: string;
}): { filter?: TimeFilter; isError?: false } | (ToolResult & { isError: true }) {
	const hasAbsolute = Boolean(input.from || input.to);
	if (hasAbsolute) {
		const from = input.from ? parseAbsoluteTime(input.from, "from") : undefined;
		const to = input.to ? parseAbsoluteTime(input.to, "to") : undefined;
		if (input.from && !from) {
			return { output: `Invalid from time: "${input.from}".`, isError: true };
		}
		if (input.to && !to) {
			return { output: `Invalid to time: "${input.to}".`, isError: true };
		}
		if (from && to && from > to) {
			return { output: `Invalid time range: from (${from}) is after to (${to}).`, isError: true };
		}
		return { filter: { ...(from ? { from } : {}), ...(to ? { to } : {}) } };
	}
	if (!input.timeRange) return {};
	const parsed = parseRelativeTimeRange(input.timeRange);
	if (!parsed) {
		return {
			output: `Invalid time_range: "${input.timeRange}". Use values like "24h", "7d", "2w", "1mo", or "1y".`,
			isError: true,
		};
	}
	return { filter: { from: parsed.from, to: parsed.to, timeRange: input.timeRange } };
}

function describeTimeFilter(filter: TimeFilter | undefined): string {
	if (!filter) return "";
	const parts: string[] = [];
	if (filter.from) parts.push(`from ${filter.from}`);
	if (filter.to) parts.push(`to ${filter.to}`);
	return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

async function handleSearch(
	query: string | undefined,
	limit: number | undefined,
	timeFilter: TimeFilter | undefined,
	currentNarratorId: string,
	allNarrators: boolean,
	signal: AbortSignal,
): Promise<ToolResult> {
	signal.throwIfAborted();
	if (!query) {
		return { output: 'Parameter "query" is required for action "search".', isError: true };
	}

	const safeQuery = sanitizeQuery(query);
	if (!safeQuery) {
		return { output: "Query is empty after sanitization.", isError: true };
	}

	const cap = Math.min(Math.max(limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
	const filter = timeFilter ?? {};

	const rows: RecallMessageRow[] = await searchStore.searchRecallMessages({
		text: safeQuery,
		strategy: globalStrategy(safeQuery),
		limit: cap,
		// `null` widens the search to every narrator. The tool's permission flow has already
		// approved that before this point; scoped mode resolves through the narrator's own
		// refs so fork-shared history stays visible to it.
		narratorId: allNarrators ? null : currentNarratorId,
		...(filter.from ? { createdFrom: filter.from } : {}),
		...(filter.to ? { createdTo: filter.to } : {}),
		previewChars: SNIPPET_CHARS,
		signal,
	});
	signal.throwIfAborted();

	if (rows.length === 0) {
		return {
			output: `No results found for "${query}"${describeTimeFilter(timeFilter)}.`,
			metadata: {
				action: "search",
				query,
				results: [],
				...(timeFilter ? { timeFilter } : {}),
			} satisfies SearchMetadata,
		};
	}

	const results: SearchResultItem[] = rows.map((row) => ({
		id: row.messageId,
		narratorId: row.narratorId,
		narratorTitle: row.narratorTitle,
		role: row.role,
		createdAt: row.createdAt,
		snippet: row.snippet.replace(/\n/g, " ").slice(0, SNIPPET_CHARS),
	}));

	const lines: string[] = [
		`Found ${rows.length} result(s) for "${query}"${describeTimeFilter(timeFilter)}:\n`,
	];
	for (const r of results) {
		lines.push(
			`- [${r.role}] message ${r.id}` +
				`  narrator=${r.narratorId}` +
				(r.narratorTitle ? ` ("${r.narratorTitle}")` : "") +
				`  at ${r.createdAt}` +
				`\n  ${r.snippet}`,
		);
	}

	return {
		output: lines.join("\n"),
		title: `Recall: ${query}`,
		metadata: {
			action: "search",
			query,
			results,
			...(timeFilter ? { timeFilter } : {}),
		} satisfies SearchMetadata,
	};
}

// ---------------------------------------------------------------------------
// read_conversation
// ---------------------------------------------------------------------------

async function handleReadConversation(
	narratorId: string | undefined,
	messageId: string | undefined,
	limit: number | undefined,
	currentNarratorId: string,
	allNarrators: boolean,
	signal: AbortSignal,
): Promise<ToolResult> {
	const targetNarratorId = narratorId ?? currentNarratorId;
	if (!allNarrators && targetNarratorId !== currentNarratorId) {
		return {
			output:
				`Recall is scoped to the current narrator (${currentNarratorId}); narrator "${targetNarratorId}" is not accessible. ` +
				"Pass `all_narrators: true` to read other narrators (may require user approval).",
			isError: true,
		};
	}

	const cap = Math.min(Math.max(limit ?? DEFAULT_READ_LIMIT, 1), MAX_READ_LIMIT);

	signal.throwIfAborted();
	if (!sqlite.filename || sqlite.filename === ":memory:" || sqlite.inTransaction) {
		throw new WorkersUnavailableError("requires_committed_file");
	}
	const snapshot = await runReadTask<RecallConversationSnapshot>(
		sqlite.filename,
		{ kind: "recallConversation", narratorId: targetNarratorId, messageId, limit: cap },
		{ timeoutMs: 15_000, signal },
	);
	signal.throwIfAborted();
	if (snapshot.kind === "narratorMissing") {
		return { output: `Narrator "${targetNarratorId}" not found.`, isError: true };
	}
	if (snapshot.kind === "messageMissing") {
		return { output: `Message "${messageId}" not found in the current narrator.`, isError: true };
	}
	const { narrator, rows } = snapshot;
	if (!rows.length) {
		return { output: `No messages found for the current narrator (${targetNarratorId}).` };
	}

	// Group tool calls by message ID
	const tcByMessage = new Map<string, ConversationToolCall[]>();
	for (const tc of snapshot.tools) {
		const entry: ConversationToolCall = {
			toolUseId: tc.tool_use_id,
			toolName: tc.tool_name,
			status: tc.status,
			summary: tc.summary,
		};
		const list = tcByMessage.get(tc.message_id);
		if (list) list.push(entry);
		else tcByMessage.set(tc.message_id, [entry]);
	}

	const messages: ConversationMessage[] = rows.map((row) => {
		const tcs = tcByMessage.get(row.id);
		return {
			id: row.id,
			seq: row.seq,
			role: row.role,
			text: row.text,
			createdAt: row.created_at,
			...(tcs && tcs.length > 0 ? { toolCalls: tcs } : {}),
		};
	});

	const header =
		`Narrator: ${narrator.title ?? targetNarratorId}` +
		(narrator.model ? ` [${narrator.model}]` : "") +
		`\nShowing ${rows.length} message(s):\n`;

	const lines: string[] = [header];
	for (const msg of messages) {
		const text = msg.text.replace(/\n/g, "\n  ");
		lines.push(`[seq=${msg.seq}] ${msg.role} (${msg.id}) at ${msg.createdAt}:\n  ${text}`);
		if (msg.toolCalls && msg.toolCalls.length > 0) {
			for (const tc of msg.toolCalls) {
				lines.push(`    [${tc.status}] ${tc.toolName}: ${tc.summary}  (toolUseId=${tc.toolUseId})`);
			}
		}
		lines.push("");
	}

	return {
		output: lines.join("\n"),
		title: `Conversation: ${narrator.title ?? targetNarratorId}`,
		metadata: {
			action: "read_conversation",
			narratorId: targetNarratorId,
			narratorTitle: narrator.title,
			model: narrator.model,
			messages,
		},
	};
}

// ---------------------------------------------------------------------------
// read_tool_call
// ---------------------------------------------------------------------------

async function handleReadToolCall(
	toolUseId: string | undefined,
	currentNarratorId: string,
	allNarrators: boolean,
	signal: AbortSignal,
): Promise<ToolResult> {
	signal.throwIfAborted();
	if (!toolUseId) {
		return {
			output: 'Parameter "tool_call_id" is required for action "read_tool_call".',
			isError: true,
		};
	}
	if (sqlite.filename === ":memory:" || sqlite.inTransaction) {
		throw new WorkersUnavailableError("requires_committed_file");
	}
	const result = await runReadTask<ToolResult | null>(
		sqlite.filename,
		{ kind: "recallToolCall", toolUseId, narratorId: allNarrators ? null : currentNarratorId },
		{ signal, timeoutMs: 15_000 },
	);
	signal.throwIfAborted();
	return (
		result ?? {
			output: allNarrators
				? `Tool call "${toolUseId}" not found.`
				: `Tool call "${toolUseId}" not found in the current narrator. ` +
					"Pass `all_narrators: true` to look it up across all narrators (may require user approval).",
			isError: true,
		}
	);
}
