import type { Statement } from "bun:sqlite";
import { z } from "zod/v4";
import { sqlite } from "../../../db";
import { buildFtsQuery, sanitizeQuery } from "../../../services/search-service";
import type { ToolDefinition, ToolResult } from "../types";

/**
 * Recall — optional agent tool for full-text search and browsing of the
 * current narrator conversation stored in NarraFork.
 */

const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_BATCH_QUERIES = 10;
const MAX_READ_LIMIT = 50;
const DEFAULT_READ_LIMIT = 20;
const SNIPPET_CHARS = 300;
const MAX_TOOL_CALL_OUTPUT = 4000;

// --- Cached prepared statements (lazy-initialized) ---
// Avoids creating a new Statement object on every Recall tool invocation.
// Search statements vary along three axes (mode × kind × time filter), so they
// are cached in a single Map keyed by a composite string instead of dozens of
// individually-named slots.

const _searchStmtCache = new Map<string, Statement>();
let _getNarrator: Statement | null = null;
let _getRefSeq: Statement | null = null;
let _msgsAround: Statement | null = null;
let _msgsLatest: Statement | null = null;
let _getToolCall: Statement | null = null;
let _getToolCallAny: Statement | null = null;

function timeWhereSuffix(filter: TimeFilter): string {
	if (filter.from && filter.to) return " AND m.created_at >= ? AND m.created_at <= ?";
	if (filter.from) return " AND m.created_at >= ?";
	if (filter.to) return " AND m.created_at <= ?";
	return "";
}

function timeFilterKey(filter: TimeFilter): string {
	if (filter.from && filter.to) return "range";
	if (filter.from) return "from";
	if (filter.to) return "to";
	return "none";
}

/**
 * Build the FTS search statement.
 * - scoped (allNarrators=false): join narrator_message_refs and filter by the
 *   current narrator, so fork-shared messages remain visible to this narrator.
 * - global (allNarrators=true): join on the owning narrator (narrator_id column)
 *   like search-service, deduplicating fork-shared messages to their origin.
 */
function buildSearchFtsSql(allNarrators: boolean, whereSuffix: string): string {
	if (allNarrators) {
		return `SELECT m.id, n.id AS narrator_id, m.role, m.created_at,
		        n.title AS narrator_title, n.chapter_id,
		        snippet(narrator_messages_fts, 0, '>>>', '<<<', '...', 64) AS snippet
		 FROM narrator_messages_fts
		 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
		 JOIN narrators n ON n.id = m.narrator_id
		 WHERE narrator_messages_fts MATCH ?${whereSuffix}
		 ORDER BY rank
		 LIMIT ?`;
	}
	return `SELECT m.id, r.narrator_id, m.role, m.created_at,
		        n.title AS narrator_title, n.chapter_id,
		        snippet(narrator_messages_fts, 0, '>>>', '<<<', '...', 64) AS snippet
		 FROM narrator_messages_fts
		 JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
		 JOIN narrator_message_refs r ON r.message_id = m.id
		 JOIN narrators n ON n.id = r.narrator_id
		 WHERE narrator_messages_fts MATCH ? AND r.narrator_id = ?${whereSuffix}
		 ORDER BY rank
		 LIMIT ?`;
}

function buildSearchLikeSql(allNarrators: boolean, whereSuffix: string): string {
	if (allNarrators) {
		return `SELECT m.id, n.id AS narrator_id, m.role, m.created_at,
		        n.title AS narrator_title, n.chapter_id,
		        substr(m.content_text, 1, ?) AS snippet
		 FROM narrator_messages m
		 JOIN narrators n ON n.id = m.narrator_id
		 WHERE m.content_text LIKE ?${whereSuffix}
		 ORDER BY m.created_at DESC
		 LIMIT ?`;
	}
	return `SELECT m.id, r.narrator_id, m.role, m.created_at,
		        n.title AS narrator_title, n.chapter_id,
		        substr(m.content_text, 1, ?) AS snippet
		 FROM narrator_messages m
		 JOIN narrator_message_refs r ON r.message_id = m.id
		 JOIN narrators n ON n.id = r.narrator_id
		 WHERE m.content_text LIKE ? AND r.narrator_id = ?${whereSuffix}
		 ORDER BY m.created_at DESC
		 LIMIT ?`;
}

function searchStmt(kind: "fts" | "like", allNarrators: boolean, filter: TimeFilter): Statement {
	const cacheKey = `${kind}:${allNarrators ? "global" : "scoped"}:${timeFilterKey(filter)}`;
	let stmt = _searchStmtCache.get(cacheKey);
	if (!stmt) {
		const suffix = timeWhereSuffix(filter);
		const sql =
			kind === "fts"
				? buildSearchFtsSql(allNarrators, suffix)
				: buildSearchLikeSql(allNarrators, suffix);
		stmt = sqlite.prepare(sql);
		_searchStmtCache.set(cacheKey, stmt);
	}
	return stmt;
}
function getNarratorStmt() {
	if (!_getNarrator) {
		_getNarrator = sqlite.prepare(
			"SELECT id, title, chapter_id, model FROM narrators WHERE id = ?",
		);
	}
	return _getNarrator;
}
function getRefSeqStmt() {
	if (!_getRefSeq) {
		_getRefSeq = sqlite.prepare(
			"SELECT seq FROM narrator_message_refs WHERE narrator_id = ? AND message_id = ?",
		);
	}
	return _getRefSeq;
}
function msgsAroundStmt() {
	if (!_msgsAround) {
		_msgsAround = sqlite.prepare(
			`SELECT m.id, m.role, m.content_text, m.created_at, r.seq
			 FROM narrator_message_refs r
			 JOIN narrator_messages m ON m.id = r.message_id
			 WHERE r.narrator_id = ? AND r.seq >= ? AND r.seq <= ?
			 ORDER BY r.seq ASC`,
		);
	}
	return _msgsAround;
}
function msgsLatestStmt() {
	if (!_msgsLatest) {
		_msgsLatest = sqlite.prepare(
			`SELECT m.id, m.role, m.content_text, m.created_at, r.seq
			 FROM narrator_message_refs r
			 JOIN narrator_messages m ON m.id = r.message_id
			 WHERE r.narrator_id = ?
			 ORDER BY r.seq DESC
			 LIMIT ?`,
		);
	}
	return _msgsLatest;
}
function getToolCallStmt() {
	if (!_getToolCall) {
		_getToolCall = sqlite.prepare(
			`SELECT tc.tool_use_id, tc.tool_name, tc.status, tc.input_json, tc.output_json,
			        tc.duration_ms, tc.error_message, tc.created_at,
			        tc.narrator_id, n.title AS narrator_title
			 FROM narrator_tool_calls tc
			 JOIN narrators n ON n.id = tc.narrator_id
			 WHERE tc.tool_use_id = ? AND tc.narrator_id = ?`,
		);
	}
	return _getToolCall;
}
function getToolCallAnyStmt() {
	if (!_getToolCallAny) {
		_getToolCallAny = sqlite.prepare(
			`SELECT tc.tool_use_id, tc.tool_name, tc.status, tc.input_json, tc.output_json,
			        tc.duration_ms, tc.error_message, tc.created_at,
			        tc.narrator_id, n.title AS narrator_title
			 FROM narrator_tool_calls tc
			 JOIN narrators n ON n.id = tc.narrator_id
			 WHERE tc.tool_use_id = ?`,
		);
	}
	return _getToolCallAny;
}

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
				return handleSearch(queries[0], limit, timeFilter, currentNarratorId, allNarrators);
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
				const result = handleSearch(q, limit, timeFilter, currentNarratorId, allNarrators);
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
			return handleReadToolCall(tool_call_id, currentNarratorId, allNarrators);
		}
		return handleReadConversation(narrator_id, message_id, limit, currentNarratorId, allNarrators);
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
// Tool call summary — lightweight server-side equivalent of frontend getSummary
// ---------------------------------------------------------------------------

function basename(p: string): string {
	const parts = p.split("/");
	return parts[parts.length - 1] || p;
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
function extractStr(obj: any, ...keys: string[]): string {
	if (!obj || typeof obj !== "object") return "";
	for (const k of keys) {
		if (typeof obj[k] === "string") return obj[k];
	}
	return "";
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Glob"]);
const BASH_TOOLS = new Set(["Bash", "Shell"]);

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
function getToolCallSummary(toolName: string, inputJson: any): string {
	if (!inputJson || typeof inputJson !== "object") return toolName;

	if (FILE_TOOLS.has(toolName)) {
		const fp = extractStr(inputJson, "file_path", "filePath", "path", "pattern");
		return fp ? basename(fp) : toolName;
	}
	if (BASH_TOOLS.has(toolName)) {
		const cmd = extractStr(inputJson, "command");
		if (!cmd) return toolName;
		return cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
	}
	if (toolName === "Grep") {
		const pat = extractStr(inputJson, "pattern");
		return pat ? (pat.length > 60 ? `${pat.slice(0, 57)}...` : pat) : toolName;
	}
	if (toolName === "WebSearch") {
		const q = extractStr(inputJson, "query");
		return q ? (q.length > 60 ? `${q.slice(0, 57)}...` : q) : "Web Search";
	}
	if (toolName === "WebFetch") {
		const url = extractStr(inputJson, "url");
		const mode = extractStr(inputJson, "mode");
		if (!url) return mode || "WebFetch";
		const short = url.length > 50 ? `${url.slice(0, 47)}...` : url;
		return mode ? `${mode}: ${short}` : short;
	}
	if (toolName === "Agent" || toolName === "Send") {
		return extractStr(inputJson, "description", "prompt", "message").slice(0, 60) || toolName;
	}
	if (toolName === "Terminal") {
		const action = extractStr(inputJson, "action");
		return action || "Terminal";
	}
	if (toolName === "ShareFile") {
		const fp = extractStr(inputJson, "path");
		return fp ? basename(fp) : "Share";
	}
	if (toolName === "AskUserQuestion") {
		const qs = inputJson.questions;
		if (Array.isArray(qs) && qs.length > 0) {
			return extractStr(qs[0], "header") || "Question";
		}
		return "Question";
	}
	if (toolName === "TaskCreate") return "Update todos";
	if (toolName === "EnterPlanMode") return "Enter plan mode";
	if (toolName === "ExitPlanMode") return "Plan ready";
	return toolName;
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

function timeFilterParams(filter: TimeFilter): string[] {
	if (filter.from && filter.to) return [filter.from, filter.to];
	if (filter.from) return [filter.from];
	if (filter.to) return [filter.to];
	return [];
}

function describeTimeFilter(filter: TimeFilter | undefined): string {
	if (!filter) return "";
	const parts: string[] = [];
	if (filter.from) parts.push(`from ${filter.from}`);
	if (filter.to) parts.push(`to ${filter.to}`);
	return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function handleSearch(
	query: string | undefined,
	limit: number | undefined,
	timeFilter: TimeFilter | undefined,
	currentNarratorId: string,
	allNarrators: boolean,
): ToolResult {
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

	const filter = timeFilter ?? {};
	const timeParams = timeFilterParams(filter);
	if (useFts) {
		const ftsExpr = buildFtsQuery(safeQuery);
		const stmt = searchStmt("fts", allNarrators, filter);
		rows = allNarrators
			? stmt.all(ftsExpr, ...timeParams, cap)
			: stmt.all(ftsExpr, currentNarratorId, ...timeParams, cap);
	} else {
		const like = `%${safeQuery}%`;
		const stmt = searchStmt("like", allNarrators, filter);
		rows = allNarrators
			? stmt.all(SNIPPET_CHARS, like, ...timeParams, cap)
			: stmt.all(SNIPPET_CHARS, like, currentNarratorId, ...timeParams, cap);
	}

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
		id: row.id,
		narratorId: row.narrator_id,
		narratorTitle: row.narrator_title ?? null,
		chapterId: row.chapter_id ?? null,
		role: row.role,
		createdAt: row.created_at,
		snippet: (row.snippet ?? "").replace(/\n/g, " ").slice(0, SNIPPET_CHARS),
	}));

	const lines: string[] = [
		`Found ${rows.length} result(s) for "${query}"${describeTimeFilter(timeFilter)}:\n`,
	];
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

function handleReadConversation(
	narratorId: string | undefined,
	messageId: string | undefined,
	limit: number | undefined,
	currentNarratorId: string,
	allNarrators: boolean,
): ToolResult {
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

	// Verify narrator exists
	const narrator = getNarratorStmt().get(targetNarratorId) as
		| { id: string; title: string | null; chapter_id: string | null; model: string | null }
		| undefined;

	if (!narrator) {
		return { output: `Narrator "${targetNarratorId}" not found.`, isError: true };
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic SQL rows
	let rows: any[];

	if (messageId) {
		// Find the seq of the target message in this narrator's refs
		const ref = getRefSeqStmt().get(targetNarratorId, messageId) as { seq: number } | undefined;

		if (!ref) {
			return {
				output: `Message "${messageId}" not found in the current narrator.`,
				isError: true,
			};
		}

		const half = Math.floor(cap / 2);
		rows = msgsAroundStmt().all(targetNarratorId, ref.seq - half, ref.seq + (cap - half));
	} else {
		// Latest messages
		rows = msgsLatestStmt().all(targetNarratorId, cap);
		rows.reverse();
	}

	if (rows.length === 0) {
		return { output: `No messages found for the current narrator (${targetNarratorId}).` };
	}

	// Batch-load tool calls for all message IDs
	const messageIds = rows.map((r) => r.id as string);
	const tcRows = sqlite
		.prepare(
			`SELECT tool_use_id, tool_name, status, input_json, message_id
			 FROM narrator_tool_calls
			 WHERE message_id IN (${messageIds.map(() => "?").join(",")}) AND narrator_id = ?
			 ORDER BY created_at ASC`,
		)
		.all(...messageIds, targetNarratorId) as Array<{
		tool_use_id: string;
		tool_name: string;
		status: string;
		input_json: string | null;
		message_id: string;
	}>;

	// Group tool calls by message ID
	const tcByMessage = new Map<string, ConversationToolCall[]>();
	for (const tc of tcRows) {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
		let parsed: any = null;
		try {
			parsed = tc.input_json ? JSON.parse(tc.input_json) : null;
		} catch {
			// ignore parse errors
		}
		const entry: ConversationToolCall = {
			toolUseId: tc.tool_use_id,
			toolName: tc.tool_name,
			status: tc.status,
			summary: getToolCallSummary(tc.tool_name, parsed),
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
			text: (row.content_text ?? "").slice(0, 500),
			createdAt: row.created_at,
			...(tcs && tcs.length > 0 ? { toolCalls: tcs } : {}),
		};
	});

	const header =
		`Narrator: ${narrator.title ?? targetNarratorId}` +
		(narrator.chapter_id ? ` (chapter ${narrator.chapter_id})` : "") +
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
			chapterId: narrator.chapter_id,
			model: narrator.model,
			messages,
		},
	};
}

// ---------------------------------------------------------------------------
// read_tool_call
// ---------------------------------------------------------------------------

function handleReadToolCall(
	toolCallId: string | undefined,
	currentNarratorId: string,
	allNarrators: boolean,
): ToolResult {
	if (!toolCallId) {
		return {
			output: 'Parameter "tool_call_id" is required for action "read_tool_call".',
			isError: true,
		};
	}

	const tc = (
		allNarrators
			? getToolCallAnyStmt().get(toolCallId)
			: getToolCallStmt().get(toolCallId, currentNarratorId)
	) as
		| {
				tool_use_id: string;
				tool_name: string;
				status: string;
				input_json: string | null;
				output_json: string | null;
				duration_ms: number | null;
				error_message: string | null;
				created_at: string;
				narrator_id: string;
				narrator_title: string | null;
		  }
		| undefined;

	if (!tc) {
		return {
			output: allNarrators
				? `Tool call "${toolCallId}" not found.`
				: `Tool call "${toolCallId}" not found in the current narrator. ` +
					"Pass `all_narrators: true` to look it up across all narrators (may require user approval).",
			isError: true,
		};
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
	let inputParsed: any = null;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
	let outputParsed: any = null;
	try {
		inputParsed = tc.input_json ? JSON.parse(tc.input_json) : null;
	} catch {
		// keep raw
	}
	try {
		outputParsed = tc.output_json ? JSON.parse(tc.output_json) : null;
	} catch {
		// keep raw
	}

	const summary = getToolCallSummary(tc.tool_name, inputParsed);

	const lines: string[] = [
		`Tool: ${tc.tool_name} — ${summary}`,
		`Status: ${tc.status}${tc.duration_ms != null ? ` (${tc.duration_ms}ms)` : ""}`,
		`Narrator: ${tc.narrator_title ?? tc.narrator_id}`,
		`Created: ${tc.created_at}`,
	];

	if (tc.error_message) {
		lines.push(`\nError: ${tc.error_message}`);
	}

	// Input
	lines.push("\n--- Input ---");
	const inputStr = inputParsed ? JSON.stringify(inputParsed, null, 2) : (tc.input_json ?? "(none)");
	lines.push(
		inputStr.length > MAX_TOOL_CALL_OUTPUT
			? `${inputStr.slice(0, MAX_TOOL_CALL_OUTPUT)}\n... (truncated, ${inputStr.length} chars total)`
			: inputStr,
	);

	// Output
	lines.push("\n--- Output ---");
	if (outputParsed) {
		// outputJson may have _text (common for bash/read results)
		const textContent = typeof outputParsed._text === "string" ? outputParsed._text : null;
		const outputStr = textContent ?? JSON.stringify(outputParsed, null, 2);
		lines.push(
			outputStr.length > MAX_TOOL_CALL_OUTPUT
				? `${outputStr.slice(0, MAX_TOOL_CALL_OUTPUT)}\n... (truncated, ${outputStr.length} chars total)`
				: outputStr,
		);
	} else {
		const raw = tc.output_json ?? "(none)";
		lines.push(
			raw.length > MAX_TOOL_CALL_OUTPUT
				? `${raw.slice(0, MAX_TOOL_CALL_OUTPUT)}\n... (truncated, ${raw.length} chars total)`
				: raw,
		);
	}

	return {
		output: lines.join("\n"),
		title: `${tc.tool_name}: ${summary}`,
		metadata: {
			action: "read_tool_call",
			toolUseId: tc.tool_use_id,
			toolName: tc.tool_name,
			status: tc.status,
			durationMs: tc.duration_ms,
			narratorId: tc.narrator_id,
			narratorTitle: tc.narrator_title,
			input: inputParsed,
			output: outputParsed,
		},
	};
}
