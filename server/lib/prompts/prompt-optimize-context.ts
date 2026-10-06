/**
 * Helper functions for prompt optimization with conversation context.
 */

import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "../../db";
import { narratorMessageRefs } from "../../db/schema";

/**
 * Maximum number of context messages to include.
 * Reads from settings, with fallback to 3.
 */
export function getMaxContextMessages(): number {
	try {
		// Dynamic import to avoid circular dependency during module initialization
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const settingsModule = require("../../settings/index");
		return settingsModule.settings?.agent?.promptOptimizeContextMaxMessages ?? 3;
	} catch {
		// Fallback if settings not available
		return 3;
	}
}

/**
 * Maximum estimated tokens for context (rough estimate: 1 char ≈ 0.25 tokens).
 * This is a safety limit to prevent overwhelming the model.
 */
const MAX_CONTEXT_TOKENS_ESTIMATE = 8000;

export interface ContextMessage {
	role: "user" | "assistant";
	content: string;
}

/**
 * Load recent messages before a given message ID (or from the end if no messageId).
 * Returns messages in chronological order (oldest first).
 */
export async function loadRecentMessages(
	narratorId: string,
	beforeMessageId?: string,
	limit?: number,
): Promise<ContextMessage[]> {
	const maxLimit = limit ?? getMaxContextMessages();
	// Find the reference seq for the beforeMessageId (if provided)
	let maxSeq: number | undefined;
	if (beforeMessageId) {
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: (refs, { and, eq }) =>
				and(eq(refs.narratorId, narratorId), eq(refs.messageId, beforeMessageId)),
			columns: { seq: true },
		});
		if (ref) {
			maxSeq = ref.seq;
		}
	}

	// Query narrator_message_refs to get recent message IDs
	const conditions = [eq(narratorMessageRefs.narratorId, narratorId)];
	if (maxSeq !== undefined) {
		conditions.push(lt(narratorMessageRefs.seq, maxSeq));
	}

	const refsQuery = db
		.select({
			messageId: narratorMessageRefs.messageId,
			seq: narratorMessageRefs.seq,
		})
		.from(narratorMessageRefs)
		.where(conditions.length > 1 ? (and as any)(...conditions) : conditions[0])
		.orderBy(desc(narratorMessageRefs.seq))
		.limit(maxLimit);

	const refs = await refsQuery;
	if (refs.length === 0) return [];

	// Load the actual messages
	const messageIds = refs.map((r) => r.messageId);
	const messages = await db.query.narratorMessages.findMany({
		where: (msgs, { inArray }) => inArray(msgs.id, messageIds),
		columns: {
			id: true,
			role: true,
			contentJson: true,
		},
	});

	// Build a map for ordering
	const seqMap = new Map(refs.map((r) => [r.messageId, r.seq]));

	// Sort by seq (ascending = chronological order)
	const sorted = messages
		.filter((m) => seqMap.has(m.id))
		.sort((a, b) => {
			const seqA = seqMap.get(a.id) ?? 0;
			const seqB = seqMap.get(b.id) ?? 0;
			return seqA - seqB;
		});

	// Extract text content from contentJson
	const contextMessages: ContextMessage[] = [];
	for (const msg of sorted) {
		if (msg.role !== "user" && msg.role !== "assistant") continue;

		const content = extractTextContent(msg.contentJson);
		if (content) {
			contextMessages.push({
				role: msg.role,
				content,
			});
		}
	}

	// Truncate if total estimated tokens exceed limit
	return truncateContextByTokens(contextMessages, MAX_CONTEXT_TOKENS_ESTIMATE);
}

/**
 * Extract plain text from contentJson blocks.
 * Handles text blocks and ignores images/tool_use/etc.
 */
function extractTextContent(contentJson: unknown): string {
	if (!Array.isArray(contentJson)) return "";

	const textParts: string[] = [];
	for (const block of contentJson) {
		if (typeof block === "object" && block !== null) {
			const obj = block as Record<string, unknown>;
			if (obj.type === "text" && typeof obj.text === "string") {
				textParts.push(obj.text);
			}
		}
	}

	return textParts.join("\n").trim();
}

/**
 * Truncate context messages to fit within token estimate.
 * Rough estimate: 1 character ≈ 0.25 tokens (conservative for CJK).
 */
function truncateContextByTokens(messages: ContextMessage[], maxTokens: number): ContextMessage[] {
	const maxChars = maxTokens * 4; // 1 token ≈ 4 chars
	let totalChars = 0;
	const result: ContextMessage[] = [];

	for (const msg of messages) {
		const msgChars = msg.content.length;
		if (totalChars + msgChars > maxChars && result.length > 0) {
			break; // Stop adding messages
		}
		result.push(msg);
		totalChars += msgChars;
	}

	return result;
}

/**
 * Format context messages as a string for prompt optimization.
 * Uses explicit XML-style structure to separate completed conversation history from draft.
 *
 * Output format wraps history in clear boundaries with explicit instructions:
 * ```
 * <conversation_history>
 * IMPORTANT: This section contains COMPLETED conversation history for background context only.
 * These are NOT tasks to be done. These are FINISHED exchanges between user and assistant.
 * Do NOT include any part of this history in your optimized output.
 *
 * User: <message>
 * Assistant: <message>
 * ...
 * </conversation_history>
 *
 * ──────────────────────────────────────────────────────────────
 *
 * NOW OPTIMIZE THE FOLLOWING DRAFT TEXT (appears below in <prompt> tags):
 * ```
 */
export function formatMessagesAsContext(messages: ContextMessage[]): string {
	if (messages.length === 0) return "";

	const lines = [
		"<conversation_history>",
		"",
		"═══════════════════════════════════════════════════════════════",
		"⚠️  IMPORTANT - READ CAREFULLY:",
		"═══════════════════════════════════════════════════════════════",
		"",
		"This section contains COMPLETED conversation history.",
		"These are FINISHED exchanges that already happened.",
		"These are NOT tasks to do or instructions to follow.",
		"",
		"Your task is to optimize ONLY the user's current draft text,",
		"which appears BELOW this history section inside <prompt> tags.",
		"",
		"Use this history ONLY to understand background context.",
		"Do NOT optimize, rewrite, or include any part of this history.",
		"",
		"═══════════════════════════════════════════════════════════════",
		"",
	];

	for (const msg of messages) {
		const label = msg.role === "user" ? "User" : "Assistant";
		// Keep content compact but readable
		const content = msg.content
			.split("\n")
			.map((line, i) => (i === 0 ? line : `  ${line}`))
			.join("\n");
		lines.push(`${label}: ${content}`);
		lines.push(""); // Empty line between messages
	}

	lines.push("</conversation_history>");
	lines.push("");
	lines.push("──────────────────────────────────────────────────────────────");
	lines.push("");
	lines.push("NOW OPTIMIZE THE DRAFT TEXT THAT FOLLOWS:");
	lines.push("");

	return lines.join("\n");
}
