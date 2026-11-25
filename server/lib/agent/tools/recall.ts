import { searchStore } from "../../../services/search/backend";
import { globalStrategy, sanitizeQuery } from "../../../services/search/query";
import type { RecallMessageRow } from "../../../services/search/types";
import { RECALL_LIMITS } from "../../recall-contract";
import type { ToolDefinition, ToolResult } from "../types";
import { type RecallArguments, recallParameters } from "./recall-schema";

export const recallTool: ToolDefinition = {
	name: "Recall",
	description: `Find saved conversation evidence, then read the original source. Do not mistake a search snippet, a preview, an assistant paraphrase, or an automatic approval for the user's own words.

Choose the smallest action:
- search: locate messages with plain keywords. Filters are applied before limit. Query arrays are alternatives, merged into ONE deduplicated result list; limit is the total, default 20/max 50. Use sort:oldest for early requirements, newest for recent statements.
- read_conversation: browse chronological previews without keywords. By default reads the latest page without tool logs. direction:newer starts at the earliest page. Copy the complete returned {seq,messageId} cursor with direction:older/newer; the ID avoids skipping messages tied on sequence. message_id reads around a known anchor; do not combine anchors with cursors.
- read_message: read one saved message body by message_id, including block-backed bodies. Previews are not complete bodies. offset/max_chars and nextOffset use Unicode code points, not bytes or UTF-16 units. Attachments and tool outputs are not fabricated as message text.
- read_tool_call: inspect saved input/output by toolUseId (tool_call_id). Use part:input for questions/arguments and part:output for results; continue each field with its own nextOffset. Question answers retain their decision provenance; reflection/auto is not a human decision.

Recipes (omit placeholder IDs until you have real results):
Find explicit human requirements: {action:"search",query:"requirements",roles:["user"],origins:["user"],sort:"oldest"}.
Browse the user's original statements: {action:"read_conversation",direction:"newer",roles:["user"],origins:["user"]}.
Read a located source: {action:"read_message",message_id:"<returned message ID>"}.
Find tool evidence: {action:"read_conversation",message_id:"<returned message ID>",include_tool_calls:true}, then read_tool_call using its returned toolUseId.

Scope: defaults to this conversation, including inherited fork history. narrator_id can narrow any action to one conversation. Access to another conversation ALWAYS requires all_narrators:true and may need approval. With that flag and no narrator_id, search and tool lookup span all conversations; transcript/message reads still default to this conversation. A hit's narratorId is a real history/ref scope for follow-up; ownerNarratorId is provenance and may no longer have that message in its own history.

roles are protocol roles, not authorship. origins are stored provenance: user/assistant/system/unknown. unknown means legacy NULL, not verified human; include it explicitly if investigating older records. Agent reports can be sys/system. Use roles:["user"] AND origins:["user"] for explicitly recorded human input. Search does not promise exhaustive tool-output indexing; read_tool_call is the evidence source. Copy IDs and continuation parameters from results; do not invent them.`,
	parameters: recallParameters,
	async execute(args, ctx): Promise<ToolResult> {
		ctx.signal.throwIfAborted();
		const parsed = recallParameters.safeParse(args);
		if (!parsed.success) {
			return {
				isError: true,
				output: `Invalid Recall arguments:\n${parsed.error.issues
					.slice(0, 5)
					.map((issue) => `- ${issue.path.join(".") || "arguments"}: ${issue.message}`)
					.join(
						"\n",
					)}\nChoose search, read_conversation, read_message, or read_tool_call; only supply fields for that action.`,
			};
		}
		const input = parsed.data;
		if (input.narrator_id && input.narrator_id !== ctx.narratorId && input.all_narrators !== true) {
			return {
				isError: true,
				output: `Recall is scoped to the current narrator (${ctx.narratorId}). To access narrator ${input.narrator_id}, explicitly pass all_narrators:true (may require approval). An ID alone never grants access.`,
			};
		}
		if (input.action === "read_tool_call")
			return boundedResult(await handleReadToolCall(input, ctx.narratorId, ctx.signal));
		if (input.action === "read_message")
			return boundedResult(await handleReadMessage(input, ctx.narratorId, ctx.signal));
		const times = buildTimeFilter({ from: input.from, to: input.to, timeRange: input.time_range });
		if (times.isError) return times;
		return boundedResult(
			await (input.action === "search"
				? handleSearch(input, ctx.narratorId, times.filter, ctx.signal)
				: handleReadConversation(input, ctx.narratorId, times.filter, ctx.signal)),
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
	ownerNarratorId?: string;
	role: string;
	origin: string;
	createdAt: string;
	snippet: string;
	matchedQueries: string[];
}

interface TimeFilter {
	from?: string;
	to?: string;
	timeRange?: string;
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
	origin: string;
	text: string;
	truncated: boolean;
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
	const dateOnly = isDateOnly(value);
	const normalized = dateOnly
		? `${value.trim()}T${boundary === "to" ? "23:59:59.999" : "00:00:00.000"}Z`
		: normalizeDateLike(value);
	const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
	const date = new Date(explicitZone ? normalized : `${normalized}Z`);
	if (Number.isNaN(date.getTime())) return null;
	if (dateOnly && date.toISOString().slice(0, 10) !== value.trim()) return null;
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
	const from = applyRelativeTimeRange(now, amount, match[2]);
	if (!Number.isFinite(from.getTime())) return null;
	return {
		from: from.toISOString(),
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
	input: RecallArguments,
	currentNarratorId: string,
	timeFilter: TimeFilter | undefined,
	signal: AbortSignal,
): Promise<ToolResult> {
	const queries = [
		...new Set(
			(Array.isArray(input.query) ? input.query : [input.query ?? ""]).map((query) => query.trim()),
		),
	];
	const limit = input.limit ?? RECALL_LIMITS.defaultResults;
	const narratorId = input.narrator_id ?? (input.all_narrators ? null : currentNarratorId);
	const lists: RecallMessageRow[][] = [];
	for (const query of queries) {
		signal.throwIfAborted();
		const text = sanitizeQuery(query);
		if (!text)
			return {
				isError: true,
				output:
					"A search query has no keywords after sanitization. Use plain keywords; to browse without keywords, use read_conversation.",
			};
		lists.push(
			await searchStore.searchRecallMessages({
				text,
				strategy: globalStrategy(text),
				limit: limit + 1,
				narratorId,
				roles: input.roles,
				origins: input.origins,
				sort: input.sort,
				...(timeFilter?.from ? { createdFrom: timeFilter.from } : {}),
				...(timeFilter?.to ? { createdTo: timeFilter.to } : {}),
				previewChars: 300,
				signal,
			}),
		);
	}
	signal.throwIfAborted();
	// Interleave query ranks instead of letting the first alternative consume the budget.
	const unique = new Map<string, SearchResultItem>();
	for (let rank = 0; rank <= limit; rank++) {
		for (let index = 0; index < lists.length; index++) {
			const row = lists[index][rank];
			if (!row) continue;
			const previous = unique.get(row.messageId);
			if (previous) {
				if (!previous.matchedQueries.includes(queries[index]))
					previous.matchedQueries.push(queries[index]);
				continue;
			}
			unique.set(row.messageId, {
				id: row.messageId,
				narratorId: row.narratorId,
				narratorTitle: row.narratorTitle,
				...(row.ownerNarratorId ? { ownerNarratorId: row.ownerNarratorId } : {}),
				role: row.role,
				origin: row.origin ?? "unknown",
				createdAt: row.createdAt,
				snippet: row.snippet.replace(/\n/g, " ").slice(0, 300),
				matchedQueries: [queries[index]],
			});
		}
	}
	const candidates = [...unique.values()];
	if (input.sort === "oldest" || input.sort === "newest") {
		const ascending = input.sort === "oldest";
		candidates.sort(
			(a, b) =>
				(ascending
					? a.createdAt.localeCompare(b.createdAt)
					: b.createdAt.localeCompare(a.createdAt)) || a.id.localeCompare(b.id),
		);
	}
	const results = candidates.slice(0, limit);
	const hasMore = candidates.length > limit || lists.some((rows) => rows.length > limit);
	const filters = {
		roles: input.roles,
		origins: input.origins,
		...(timeFilter ? { timeFilter } : {}),
	};
	const scope =
		narratorId === null
			? "all conversations (explicit cross-narrator scope)"
			: `conversation ${narratorId}`;
	const lines = [
		results.length
			? `Showing ${results.length} matching message(s) in ${scope}${describeTimeFilter(timeFilter)}.`
			: `No matching messages in ${scope}${describeTimeFilter(timeFilter)}. This does not mean the conversation has no history.`,
		`Queries: ${JSON.stringify(queries)}. Total result limit: ${limit}. Roles: ${input.roles?.join(", ") ?? "all"}; origins: ${input.origins?.join(", ") ?? "all (including unknown legacy provenance)"}.`,
	];
	for (const result of results) {
		lines.push(
			`\n- [${result.role}; origin=${result.origin}] message ${result.id}  narrator=${result.narratorId}${result.narratorTitle ? ` (${JSON.stringify(result.narratorTitle)})` : ""}${result.ownerNarratorId && result.ownerNarratorId !== result.narratorId ? `  owner=${result.ownerNarratorId}` : ""}  at ${result.createdAt}\n  ${result.snippet}`,
		);
	}
	if (results[0])
		lines.push(
			`\nSnippets are previews, not the complete source. Read the first hit: ${JSON.stringify({ action: "read_message", message_id: results[0].id, ...continuationScope(results[0].narratorId, currentNarratorId) })}. Use each hit's IDs to read another.`,
		);
	if (hasMore)
		lines.push(
			"More matches exist. Narrow query/roles/origins/time, or browse a matching conversation with read_conversation.",
		);
	return {
		output: lines.join("\n"),
		title: `Recall: ${queries.length === 1 ? queries[0] : `${queries.length} alternatives`}`,
		metadata: {
			action: "search",
			...(queries.length === 1 ? { query: queries[0] } : { queries }),
			results,
			hasMore,
			limit,
			narratorId,
			...filters,
		},
	};
}

// ---------------------------------------------------------------------------
// read_conversation
// ---------------------------------------------------------------------------

async function handleReadConversation(
	input: RecallArguments,
	currentNarratorId: string,
	timeFilter: TimeFilter | undefined,
	signal: AbortSignal,
): Promise<ToolResult> {
	const narratorId = input.narrator_id ?? currentNarratorId;
	const { recallConversation } = await import("../../../services/search/recall-store");
	const snapshot = await recallConversation(
		{
			narratorId,
			messageId: input.message_id ?? null,
			limit: input.limit ?? RECALL_LIMITS.defaultResults,
			direction: input.direction ?? (input.message_id ? "around" : "older"),
			cursor: input.cursor,
			roles: input.roles,
			origins: input.origins,
			includeToolCalls: input.include_tool_calls ?? false,
			...(timeFilter?.from ? { createdFrom: timeFilter.from } : {}),
			...(timeFilter?.to ? { createdTo: timeFilter.to } : {}),
		},
		signal,
	);
	signal.throwIfAborted();
	if (!snapshot.narrator) return { isError: true, output: `Narrator ${narratorId} was not found.` };
	if (snapshot.messageMissing)
		return {
			isError: true,
			output: `Message ${input.message_id} is not in conversation ${narratorId}. Use a message ID returned for this conversation; an owner ID and a fork's history scope can differ.`,
		};
	const toolsByMessage = new Map<string, ConversationToolCall[]>();
	for (const tool of snapshot.tools) {
		const list = toolsByMessage.get(tool.message_id) ?? [];
		list.push({
			toolUseId: tool.tool_use_id,
			toolName: tool.tool_name,
			status: tool.status,
			summary: tool.summary,
		});
		toolsByMessage.set(tool.message_id, list);
	}
	const messages: ConversationMessage[] = snapshot.rows.map((row) => ({
		id: row.id,
		seq: row.seq,
		role: row.role,
		origin: row.origin ?? "unknown",
		text: row.content_text ?? "",
		truncated: row.truncated,
		createdAt: row.created_at,
		...(toolsByMessage.has(row.id) ? { toolCalls: toolsByMessage.get(row.id) } : {}),
	}));
	const lines = [
		`Narrator: ${snapshot.narrator.title ?? narratorId} [${narratorId}]`,
		`Showing ${messages.length} message preview(s), in chronological order. Roles: ${input.roles?.join(", ") ?? "all"}; origins: ${input.origins?.join(", ") ?? "all"}.${describeTimeFilter(timeFilter)}`,
		`Tool summaries: ${input.include_tool_calls ? "included (target conversation only)" : "omitted; set include_tool_calls:true to investigate tool evidence"}.`,
	];
	for (const message of messages) {
		lines.push(
			`\n[seq=${message.seq}] ${message.role}; origin=${message.origin} (${message.id}) at ${message.createdAt}:\n  ${message.text.replace(/\n/g, "\n  ")}${message.truncated ? "\n  [Preview truncated; use read_message for the complete source.]" : ""}`,
		);
		for (const tool of message.toolCalls ?? [])
			lines.push(
				`  [${tool.status}] ${tool.toolName}: ${tool.summary} (toolUseId=${tool.toolUseId})`,
			);
	}
	const scope = continuationScope(narratorId, currentNarratorId);
	const filterArguments = {
		...(input.roles ? { roles: input.roles } : {}),
		...(input.origins ? { origins: input.origins } : {}),
		...(timeFilter?.from ? { from: timeFilter.from } : {}),
		...(timeFilter?.to ? { to: timeFilter.to } : {}),
		...(input.include_tool_calls ? { include_tool_calls: true } : {}),
	};
	const pagination = snapshot.pagination;
	if (pagination.hasOlder && pagination.olderCursor !== null)
		lines.push(
			`\nOlder page: ${JSON.stringify({ action: "read_conversation", ...scope, ...filterArguments, direction: "older", cursor: pagination.olderCursor, limit: input.limit ?? RECALL_LIMITS.defaultResults })}`,
		);
	if (pagination.hasNewer && pagination.newerCursor !== null)
		lines.push(
			`\nNewer page: ${JSON.stringify({ action: "read_conversation", ...scope, ...filterArguments, direction: "newer", cursor: pagination.newerCursor, limit: input.limit ?? RECALL_LIMITS.defaultResults })}`,
		);
	if (messages[0])
		lines.push(
			`\nComplete message body: ${JSON.stringify({ action: "read_message", ...scope, message_id: messages[0].id })}`,
		);
	else
		lines.push(
			"No messages match this page and these filters. Do not infer that the conversation has no history.",
		);
	return {
		output: lines.join("\n"),
		title: `Conversation: ${snapshot.narrator.title ?? narratorId}`,
		metadata: {
			action: "read_conversation",
			narratorId,
			narratorTitle: snapshot.narrator.title,
			model: snapshot.narrator.model,
			messages,
			pagination,
		},
	};
}

// ---------------------------------------------------------------------------
// read_tool_call
// ---------------------------------------------------------------------------

async function handleReadToolCall(
	input: RecallArguments,
	currentNarratorId: string,
	signal: AbortSignal,
): Promise<ToolResult> {
	const { recallToolCallPage } = await import("../../../services/search/recall-store");
	const result = await recallToolCallPage(
		{
			toolCallId: input.tool_call_id ?? "",
			narratorId: input.narrator_id ?? (input.all_narrators ? null : currentNarratorId),
			part: input.part ?? "both",
			offset: input.offset ?? 0,
			maxChars: input.max_chars ?? RECALL_LIMITS.defaultPageChars,
		},
		signal,
	);
	if (!result)
		return {
			isError: true,
			output: `Tool call ${input.tool_call_id} was not found in the requested scope. Use a toolUseId from include_tool_calls:true, not a message ID or ledger row ID. Other conversations require explicit all_narrators:true approval.`,
		};
	type PageCursor = { hasMore: boolean; nextOffset: number | null };
	const metadata = result.metadata as
		| {
				narratorId?: string;
				pages?: Partial<Record<"input" | "output", PageCursor | null>>;
				question?: { questions?: PageCursor | null; answers?: PageCursor | null } | null;
		  }
		| undefined;
	const next: string[] = [];
	const continuations = new Set<string>();
	const addContinuation = (label: string, part: "input" | "output", page?: PageCursor | null) => {
		if (!page?.hasMore || page.nextOffset === null) return;
		const key = `${part}:${page.nextOffset}`;
		if (continuations.has(key)) return;
		continuations.add(key);
		next.push(
			`${label}: ${JSON.stringify({ action: "read_tool_call", ...continuationScope(metadata?.narratorId ?? input.narrator_id ?? currentNarratorId, currentNarratorId), tool_call_id: input.tool_call_id, part, offset: page.nextOffset, max_chars: input.max_chars ?? RECALL_LIMITS.defaultPageChars })}`,
		);
	};
	addContinuation("Continue input", "input", metadata?.pages?.input);
	addContinuation("Continue output", "output", metadata?.pages?.output);
	// Async answers may outlive the short launch input. They must have their own way forward.
	addContinuation("Continue saved questions", "input", metadata?.question?.questions);
	addContinuation("Continue saved answers", "input", metadata?.question?.answers);
	return { ...result, output: [result.output, ...next].join("\n") };
}

/** Like outline's bounded results: the executor must not cut the head of an exact page. */
function boundedResult(result: ToolResult): ToolResult {
	if (result.isError) return result;
	if (Buffer.byteLength(result.output, "utf8") > 512 * 1024) {
		return {
			isError: true,
			output:
				"This Recall response exceeds its bounded output budget. Use a smaller limit/max_chars, narrower roles/origins, or omit include_tool_calls, then retry. No partial page was returned.",
		};
	}
	// This flag means the tool owns truncation/pagination, not that this page lost text.
	return { ...result, truncated: true };
}

function continuationScope(narratorId: string, currentNarratorId: string) {
	return {
		narrator_id: narratorId,
		...(narratorId !== currentNarratorId ? { all_narrators: true } : {}),
	};
}

async function handleReadMessage(
	input: RecallArguments,
	currentNarratorId: string,
	signal: AbortSignal,
): Promise<ToolResult> {
	const narratorId = input.narrator_id ?? currentNarratorId;
	const { recallMessage } = await import("../../../services/search/recall-store");
	const page = await recallMessage(
		{
			narratorId,
			messageId: input.message_id ?? "",
			offset: input.offset ?? 0,
			maxChars: input.max_chars ?? RECALL_LIMITS.defaultPageChars,
		},
		signal,
	);
	if (!page)
		return {
			isError: true,
			output: `Message ${input.message_id} is not in conversation ${narratorId}. Use the narrator_id and message ID from a Recall result; IDs do not grant access to another conversation.`,
		};
	const length = Array.from(page.text).length;
	const lines = [
		`Message ${page.messageId} in ${page.narratorTitle ?? narratorId} [${narratorId}], seq=${page.seq}, bodyRevision=${page.bodyRevision}.`,
		`Role: ${page.role}; stored origin: ${page.origin ?? "unknown (legacy provenance, not verified human)"}. Created: ${page.createdAt}.`,
		`Stored message text, Unicode code points [${page.offset}, ${page.offset + length}) of ${page.totalChars}. Tool outputs and attachment bytes are not part of this text.`,
		"\n--- Stored message text ---\n",
		page.text,
	];
	if (page.omittedBlocks?.length)
		lines.push(`\nNon-text blocks: ${page.omittedBlocks.join(", ")}.`);
	for (const tool of page.toolCalls ?? [])
		lines.push(
			`Tool evidence: ${tool.toolName} [${tool.status}] ${tool.summary} (toolUseId=${tool.toolUseId}).`,
		);
	if (page.hasMore && page.nextOffset !== null)
		lines.push(
			`\nContinue this message: ${JSON.stringify({ action: "read_message", ...continuationScope(narratorId, currentNarratorId), message_id: page.messageId, offset: page.nextOffset, max_chars: input.max_chars ?? RECALL_LIMITS.defaultPageChars })}`,
		);
	// origin_label is display-only provenance; never forward it to model text or metadata.
	const { originLabel: _displayOnlyLabel, ...messagePage } = page as typeof page & {
		originLabel?: unknown;
	};
	return {
		output: lines.join("\n"),
		title: `Message: ${page.messageId}`,
		metadata: {
			action: "read_message",
			...messagePage,
			truncated: page.offset > 0 || page.hasMore,
		},
	};
}
