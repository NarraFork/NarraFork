import { z } from "zod/v4";
import { RECALL_LIMITS, RECALL_ORIGINS, RECALL_ROLES } from "../../recall-contract";

const reference = z.string().trim().min(1).max(256);
const query = z.string().trim().min(1).max(RECALL_LIMITS.queryChars);

/** Keep an object at the provider boundary; action-specific errors are checked here too. */
export const recallParameters = z
	.object({
		action: z
			.enum(["search", "read_conversation", "read_message", "read_tool_call"])
			.describe(
				"search locates messages; read_conversation browses previews; read_message reads one original body; read_tool_call reads saved tool evidence.",
			),
		query: z
			.union([query, z.array(query).min(1).max(RECALL_LIMITS.queries)])
			.optional()
			.describe(
				"search only. Plain keywords, not regex/SQL/FTS syntax. Words in one string must all match; an array searches alternatives and returns one deduplicated list.",
			),
		narrator_id: reference
			.optional()
			.describe(
				"Target conversation for any action. Defaults to this conversation, except search/read_tool_call with all_narrators:true and no ID search all conversations. A different ID still requires all_narrators:true.",
			),
		all_narrators: z
			.boolean()
			.optional()
			.describe(
				"Explicit permission to access other conversations (may require approval). This flag is not granted automatically by a narrator_id, message_id, or tool_call_id. Omit for this conversation, including its inherited fork history.",
			),
		roles: z
			.array(z.enum(RECALL_ROLES))
			.min(1)
			.max(RECALL_ROLES.length)
			.optional()
			.describe(
				"search/read_conversation only. Match stored protocol roles before limiting results. role=user alone is NOT proof of a human author; combine roles:[user] with origins:[user] for explicitly recorded human input.",
			),
		origins: z
			.array(z.enum(RECALL_ORIGINS))
			.min(1)
			.max(RECALL_ORIGINS.length)
			.optional()
			.describe(
				"search/read_conversation only. Stored authorship, independent of role: user, assistant, system, or unknown (NULL legacy provenance). user does not include unknown. Agent reports can be sys/system; this is not a sender-kind filter.",
			),
		limit: z
			.number()
			.int()
			.min(1)
			.max(RECALL_LIMITS.maxResults)
			.optional()
			.describe(
				"Maximum messages returned, default 20, max 50. For search this is the TOTAL across all alternative queries, not per query. For read_conversation this is a strict page size.",
			),
		sort: z
			.enum(["relevance", "newest", "oldest"])
			.optional()
			.describe(
				"search only. Default relevance; choose oldest to find early decisions or newest for recent statements. Equal ranks/times have stable ID ordering.",
			),
		message_id: reference
			.optional()
			.describe(
				"Required for read_message; optional anchor for read_conversation (defaults to direction:around). Copy a message ID from Recall results; it must belong to the target conversation's history.",
			),
		direction: z
			.enum(["older", "newer", "around"])
			.optional()
			.describe(
				"read_conversation only. older starts at the latest page; newer starts at the earliest page. around requires message_id and cannot use cursor. Output is always chronological. Default around with message_id, otherwise older.",
			),
		cursor: z
			.number()
			.int()
			.min(0)
			.max(Number.MAX_SAFE_INTEGER)
			.optional()
			.describe(
				"read_conversation only. Exclusive sequence boundary copied from olderCursor/newerCursor. Combine with direction:older/newer. Do not combine with message_id or direction:around.",
			),
		include_tool_calls: z
			.boolean()
			.optional()
			.describe(
				"read_conversation only, default false. Include saved tool IDs and short summaries when investigating execution or question answers; otherwise omit to keep the transcript quiet.",
			),
		tool_call_id: reference
			.optional()
			.describe(
				"read_tool_call only, required. Use the toolUseId returned in conversation tool summaries, not a message ID or database row ID.",
			),
		part: z
			.enum(["both", "input", "output"])
			.optional()
			.describe(
				"read_tool_call only, default both. Choose input for saved arguments/questions/answers or output for results. Each field has its own continuation offset.",
			),
		offset: z
			.number()
			.int()
			.min(0)
			.max(Number.MAX_SAFE_INTEGER)
			.optional()
			.describe(
				"read_message/read_tool_call only. Zero-based Unicode code-point offset, default 0. Copy nextOffset from the previous page; it is not a byte or UTF-16 offset.",
			),
		max_chars: z
			.number()
			.int()
			.min(1)
			.max(RECALL_LIMITS.maxPageChars)
			.optional()
			.describe(
				"read_message/read_tool_call only. Characters per body/field page, default 8000, max 20000. Follow nextOffset rather than assuming a preview is the complete source.",
			),
		from: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.optional()
			.describe(
				"search/read_conversation only. Inclusive creation-time lower bound: ISO timestamp or YYYY-MM-DD. Date-only bounds are UTC.",
			),
		to: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.optional()
			.describe(
				"search/read_conversation only. Inclusive creation-time upper bound: ISO timestamp or YYYY-MM-DD (through end of that UTC date).",
			),
		time_range: z
			.string()
			.trim()
			.min(1)
			.max(32)
			.optional()
			.describe(
				"search/read_conversation only. Relative creation-time window such as 24h, 7d, 2w, 1mo. Use this OR from/to, not both.",
			),
	})
	.strict()
	.superRefine((args, context) => {
		const fail = (key: string, message: string) =>
			context.addIssue({ code: "custom", path: [key], message });
		const allowed: Record<typeof args.action, ReadonlySet<string>> = {
			search: new Set(["query", "roles", "origins", "limit", "sort", "from", "to", "time_range"]),
			read_conversation: new Set([
				"roles",
				"origins",
				"limit",
				"message_id",
				"direction",
				"cursor",
				"include_tool_calls",
				"from",
				"to",
				"time_range",
			]),
			read_message: new Set(["message_id", "offset", "max_chars"]),
			read_tool_call: new Set(["tool_call_id", "part", "offset", "max_chars"]),
		};
		for (const [key, value] of Object.entries(args)) {
			if (
				value !== undefined &&
				!["action", "narrator_id", "all_narrators"].includes(key) &&
				!allowed[args.action].has(key)
			)
				fail(key, `${key} is not used by ${args.action}; remove it.`);
		}
		if (args.action === "search" && args.query === undefined)
			fail("query", "search requires query. To browse without keywords, use read_conversation.");
		if (args.action === "read_message" && !args.message_id)
			fail("message_id", "read_message requires a message_id from Recall results.");
		if (args.action === "read_tool_call" && !args.tool_call_id)
			fail(
				"tool_call_id",
				"read_tool_call requires a tool_call_id (toolUseId) from a conversation tool summary.",
			);
		if (args.time_range && (args.from || args.to))
			fail("time_range", "Use either time_range or from/to, not both.");
		if (args.action === "read_conversation") {
			if (args.message_id && args.cursor !== undefined)
				fail("cursor", "Use a message_id anchor or a sequence cursor, not both.");
			if (args.direction === "around" && !args.message_id)
				fail("message_id", "direction:around requires message_id.");
			if (args.message_id && args.direction && args.direction !== "around")
				fail(
					"direction",
					"message_id is an around anchor; to read older/newer pages, use cursor instead.",
				);
		}
	});

export type RecallArguments = z.infer<typeof recallParameters>;
