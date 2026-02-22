import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "../db";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { deleteNarratorUploads } from "../lib/uploads";

/**
 * For child messages belonging to subagent narrators, attach the subagent's
 * resolved model as `subagentModel` on each message. This avoids extra API
 * calls from the frontend.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
async function attachSubagentModels(childMessages: any[]): Promise<void> {
	if (childMessages.length === 0) return;
	const narratorIds = [...new Set(childMessages.map((m) => m.narratorId as string))];
	if (narratorIds.length === 0) return;
	const subagentRows = await db.query.narrators.findMany({
		where: and(inArray(narrators.id, narratorIds), eq(narrators.type, "subagent")),
		columns: { id: true, model: true },
	});
	const modelMap = new Map(subagentRows.map((r) => [r.id, r.model]));
	for (const msg of childMessages) {
		const model = modelMap.get(msg.narratorId);
		if (model) msg.subagentModel = model;
	}
}

/**
 * Build a tree from a flat array of messages.
 * Messages with parentToolUseId are nested under the message whose
 * toolCalls contains the matching toolUseId.
 * Returns only top-level messages (parentToolUseId is null).
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function buildMessageTree(flatMessages: any[]): any[] {
	// Shallow clone each message to avoid mutating drizzle results
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const cloned = flatMessages.map((msg) => ({ ...msg, children: [] as any[] }));

	// Map: toolUseId → cloned message that CONTAINS that tool_use block
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const toolUseIdToMsg = new Map<string, any>();
	for (const msg of cloned) {
		if (msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				toolUseIdToMsg.set(tc.toolUseId, msg);
			}
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const topLevel: any[] = [];
	for (const msg of cloned) {
		if (msg.parentToolUseId && toolUseIdToMsg.has(msg.parentToolUseId)) {
			toolUseIdToMsg.get(msg.parentToolUseId).children.push(msg);
		} else if (!msg.parentToolUseId) {
			topLevel.push(msg);
		}
		// Child messages whose parent isn't in the set are silently dropped
		// (they belong to a different page)
	}

	return topLevel;
}

/** Truncate a JSON value to a preview string if it exceeds maxLen characters */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function truncateJson(val: any, maxLen: number): any {
	if (val === null || val === undefined) return val;
	const str = typeof val === "string" ? val : JSON.stringify(val);
	if (str.length <= maxLen) return val;
	return { _truncated: true, preview: str.slice(0, maxLen), fullLength: str.length };
}

/** Tool names whose inputJson/outputJson should never be truncated in message lists
 *  (their content IS the primary display payload, e.g. plan text). */
const SKIP_TRUNCATE_TOOLS = new Set(["ExitPlanMode"]);

/** Recursively truncate large inputJson/outputJson in tool calls within a message tree */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function truncateToolIO(tree: any[], maxLen = 2000): any[] {
	return tree.map((msg) => ({
		...msg,
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		toolCalls: msg.toolCalls?.map((tc: any) => {
			if (SKIP_TRUNCATE_TOOLS.has(tc.toolName)) return tc;
			return {
				...tc,
				inputJson: truncateJson(tc.inputJson, maxLen),
				outputJson: truncateJson(tc.outputJson, maxLen),
			};
		}),
		children: msg.children?.length ? truncateToolIO(msg.children, maxLen) : msg.children,
	}));
}

/**
 * Remove assistant messages that only contain ExitPlanMode tool_use
 * when immediately followed by a plan compact system message.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function filterExitPlanBeforePlanCompact(tree: any[]): any[] {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const result: any[] = [];
	for (let i = 0; i < tree.length; i++) {
		const msg = tree[i];
		const next = tree[i + 1];
		// Check if next message is a plan compact
		if (
			next?.role === "system" &&
			Array.isArray(next.contentJson) &&
			next.contentJson.some(
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				(b: any) => b.type === "compact" && b.subtype === "plan",
			)
		) {
			// Check if current message only has ExitPlanMode tool_use (+ optional empty text)
			if (msg.role === "assistant" && Array.isArray(msg.contentJson)) {
				const blocks = msg.contentJson;
				const onlyExitPlan =
					blocks.length > 0 &&
					blocks.every(
						// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
						(b: any) =>
							(b.type === "tool_use" && b.name === "ExitPlanMode") ||
							(b.type === "text" && !b.text?.trim()),
					) &&
					// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
					blocks.some((b: any) => b.type === "tool_use");
				if (onlyExitPlan) continue; // skip this message
			}
		}
		result.push(msg);
	}
	return result;
}

/** Collect all toolUseIds from a set of messages (for iterative child fetching) */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function collectToolUseIds(messages: any[]): string[] {
	const ids: string[] = [];
	for (const msg of messages) {
		if (msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				ids.push(tc.toolUseId);
			}
		}
	}
	return ids;
}

/** Insert a message into narrator_message_refs junction table */
async function insertMessageRef(
	narratorId: string,
	messageId: string,
	seq: number,
	isCompact = 0,
): Promise<void> {
	await db.insert(narratorMessageRefs).values({
		id: generateId(),
		narratorId,
		messageId,
		seq,
		isCompact,
	});
}

/** Atomically get next seq and insert into narrator_message_refs (prevents race conditions) */
async function appendMessageRef(
	narratorId: string,
	messageId: string,
	isCompact = 0,
): Promise<number> {
	return db.transaction(async (tx) => {
		const result = await tx
			.select({ maxSeq: sql<number | null>`MAX(${narratorMessageRefs.seq})` })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, narratorId));
		const seq = (result[0]?.maxSeq ?? -1) + 1;
		await tx.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId,
			messageId,
			seq,
			isCompact,
		});
		return seq;
	});
}

/**
 * Clear or set contextSummary + apiConversationId on the narrator.
 * Pass `summary = null` to clear, or a string to set.
 */
async function clearContextSummary(narratorId: string, summary: string | null) {
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({ contextSummary: summary, apiConversationId: null, updatedAt: now })
		.where(eq(narrators.id, narratorId));
}

interface CreateNarratorInput {
	chapterId?: string | null;
	type?: "primary" | "secondary";
	model?: string;
	systemPrompt?: string;
	permissionMode?: string;
	cwd?: string;
	planMode?: boolean;
}

interface CreateSubagentInput {
	parentNarratorId: string;
	subagentType: "explore" | "plan" | "general";
	cwd: string;
	permissionMode?: string;
	model?: string;
	systemPrompt?: string;
}

export const narratorService = {
	async create(input: CreateNarratorInput) {
		if (input.chapterId) {
			const chapter = await db.query.chapters.findFirst({
				where: eq(chapters.id, input.chapterId),
			});
			if (!chapter) throw new NotFoundError("Chapter", input.chapterId);
			if (chapter.status !== "active") {
				throw new ValidationError("Cannot create narrator for non-active chapter");
			}
		}

		const type = input.type ?? "primary";

		// Enforce single primary narrator per chapter (only for chapter-bound narrators)
		if (type === "primary" && input.chapterId) {
			const existing = await db.query.narrators.findFirst({
				where: and(eq(narrators.chapterId, input.chapterId), eq(narrators.type, "primary")),
			});
			if (existing) {
				throw new ValidationError("Chapter already has a primary narrator");
			}
		}

		const now = new Date().toISOString();
		const id = generateId();
		const resolvedPermMode = (input.permissionMode ?? settings.agent.defaultPermissionMode) as
			| "default"
			| "acceptEdits"
			| "bypassPermissions"
			| "dontAsk";

		const [narrator] = await db
			.insert(narrators)
			.values({
				id,
				chapterId: input.chapterId ?? null,
				type,
				model: input.model ?? settings.agent.defaultModel,
				systemPrompt: input.systemPrompt,
				permissionMode: resolvedPermMode,
				planMode: input.planMode ?? false,
				cwd: input.cwd ?? null,
				inheritMode: "fresh",
				status: "idle",
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		logger.info("Narrator created", { id, chapterId: input.chapterId, type });
		return narrator;
	},

	async createSubagent(input: CreateSubagentInput) {
		const parent = await this.getById(input.parentNarratorId);

		// Prevent nested subagents
		if (parent.type === "subagent") {
			throw new ValidationError("Subagents cannot spawn nested subagents");
		}

		const now = new Date().toISOString();
		const id = generateId();
		const resolvedPermMode = (input.permissionMode ?? parent.permissionMode ?? "default") as
			| "default"
			| "acceptEdits"
			| "bypassPermissions"
			| "dontAsk";

		const [narrator] = await db
			.insert(narrators)
			.values({
				id,
				chapterId: parent.chapterId ?? null,
				type: "subagent",
				subagentType: input.subagentType,
				model: input.model ?? parent.model ?? settings.agent.defaultModel,
				systemPrompt: input.systemPrompt ?? null,
				permissionMode: resolvedPermMode,
				parentNarratorId: input.parentNarratorId,
				cwd: input.cwd,
				inheritMode: "fresh",
				status: "thinking",
				planMode: false,
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		logger.info("Subagent created", {
			id,
			parentNarratorId: input.parentNarratorId,
			subagentType: input.subagentType,
		});
		return narrator;
	},

	/**
	 * Persist a user message for a subagent, linked to the parent's tool_use via parentToolUseId.
	 */
	async persistSubagentUserMessage(narratorId: string, text: string, parentToolUseId: string) {
		const id = generateId();
		const now = new Date().toISOString();
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				parentToolUseId,
				role: "user",
				contentJson: [{ type: "text", text }],
				contentText: text,
				createdAt: now,
			})
			.returning();

		await appendMessageRef(narratorId, id);
		return msg;
	},

	async getById(id: string) {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, id),
		});
		if (!narrator) throw new NotFoundError("Narrator", id);
		return narrator;
	},

	async listByChapter(chapterId: string) {
		return db.query.narrators.findMany({
			where: and(eq(narrators.chapterId, chapterId), ne(narrators.type, "subagent")),
			orderBy: (n, { asc }) => [asc(n.createdAt)],
		});
	},

	async getMessages(narratorId: string, limit = 100, offset = 0) {
		return db.query.narratorMessages.findMany({
			where: eq(narratorMessages.narratorId, narratorId),
			with: { toolCalls: true },
			orderBy: (m, { asc }) => [asc(m.createdAt)],
			limit,
			offset,
		});
	},

	/**
	 * Fetch all messages after the most recent compact marker.
	 * If no compact marker exists, returns all messages.
	 * Uses narrator_message_refs junction table.
	 */
	async getMessagesSinceLastCompact(narratorId: string) {
		// Find the last compact marker's seq
		const lastCompactRow = await db
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessageRefs.isCompact, 1)),
			)
			.orderBy(sql`${narratorMessageRefs.seq} DESC`)
			.limit(1);

		const compactSeq = lastCompactRow[0]?.seq;

		// Fetch message IDs from narrator_message_refs
		const refRows = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					compactSeq != null ? gt(narratorMessageRefs.seq, compactSeq) : undefined,
				),
			)
			.orderBy(narratorMessageRefs.seq);

		if (refRows.length === 0) return [];

		const messageIds = refRows.map((r) => r.messageId);
		const messages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, messageIds),
			with: { toolCalls: true },
		});

		// Sort by seq order from refs (not createdAt)
		const seqMap = new Map(refRows.map((r) => [r.messageId, r.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		return messages;
	},

	/**
	 * Fetch messages between the last compact marker and a given message (exclusive).
	 * Used for partial compact — compress only messages before the target.
	 */
	async getMessagesBefore(narratorId: string, beforeMessageId: string) {
		// Find the target message's seq
		const targetRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, beforeMessageId),
			),
		});
		if (!targetRef) throw new NotFoundError("Message", beforeMessageId);

		// Find the last compact marker before the target
		const lastCompactRow = await db
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.isCompact, 1),
					lt(narratorMessageRefs.seq, targetRef.seq),
				),
			)
			.orderBy(sql`${narratorMessageRefs.seq} DESC`)
			.limit(1);

		const compactSeq = lastCompactRow[0]?.seq;

		const lowerBound = compactSeq != null ? gt(narratorMessageRefs.seq, compactSeq) : sql`1=1`;

		// Get message IDs in range (compactSeq, targetSeq)
		const refRows = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					lowerBound,
					lt(narratorMessageRefs.seq, targetRef.seq),
				),
			)
			.orderBy(narratorMessageRefs.seq);

		if (refRows.length === 0) return [];

		const messageIds = refRows.map((r) => r.messageId);
		const messages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, messageIds),
			with: { toolCalls: true },
		});

		// Sort by seq order from refs (not createdAt)
		const seqMap = new Map(refRows.map((r) => [r.messageId, r.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		return messages;
	},

	/** Fetch the N earliest top-level user/assistant messages with text content. */
	async getEarliestMessages(narratorId: string, limit = 2) {
		return db.query.narratorMessages.findMany({
			where: and(
				eq(narratorMessages.narratorId, narratorId),
				inArray(narratorMessages.role, ["user", "assistant"]),
				isNotNull(narratorMessages.contentText),
			),
			orderBy: (m, { asc }) => [asc(m.createdAt)],
			limit,
		});
	},

	/** Fetch the N most recent top-level user/assistant messages with text content (chronological order). */
	async getRecentMessages(narratorId: string, limit = 4) {
		const rows = await db.query.narratorMessages.findMany({
			where: and(
				eq(narratorMessages.narratorId, narratorId),
				inArray(narratorMessages.role, ["user", "assistant"]),
				isNotNull(narratorMessages.contentText),
			),
			orderBy: (m, { desc }) => [desc(m.createdAt)],
			limit,
		});
		return rows.reverse();
	},

	async getMessagesCursor(narratorId: string, limit = 50, cursor?: string) {
		// Build cursor condition on seq
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const cursorConditions: any[] = [eq(narratorMessageRefs.narratorId, narratorId)];
		if (cursor) {
			const cursorSeq = Number.parseInt(cursor, 10);
			if (!Number.isNaN(cursorSeq)) {
				cursorConditions.push(lt(narratorMessageRefs.seq, cursorSeq));
			}
		}

		// Query top-level messages via junction table, ordered by seq DESC
		const refRows = await db
			.select({
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
			})
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(and(...cursorConditions, isNull(narratorMessages.parentToolUseId)))
			.orderBy(sql`${narratorMessageRefs.seq} DESC`)
			.limit(limit + 1);

		const hasMore = refRows.length > limit;
		const pageRows = hasMore ? refRows.slice(0, limit) : refRows;
		pageRows.reverse(); // chronological order

		if (pageRows.length === 0) {
			return { messages: [], hasMore, nextCursor: null };
		}

		const messageIds = pageRows.map((r) => r.messageId);
		const topMessages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, messageIds),
			with: { toolCalls: true },
		});

		// Sort by seq order from refs (not createdAt)
		const seqMap = new Map(pageRows.map((r) => [r.messageId, r.seq]));
		topMessages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));

		// Fetch child messages (don't filter by narratorId — forked narrators
		// share messages whose narratorId points to the original creator)
		const parentToolUseIds = collectToolUseIds(topMessages);
		const childMessages =
			parentToolUseIds.length > 0
				? await db.query.narratorMessages.findMany({
						where: inArray(narratorMessages.parentToolUseId, parentToolUseIds),
						with: { toolCalls: true },
						orderBy: (m, { asc }) => [asc(m.createdAt)],
						limit: 500,
					})
				: [];

		await attachSubagentModels(childMessages);

		const tree = filterExitPlanBeforePlanCompact(
			truncateToolIO(buildMessageTree([...topMessages, ...childMessages])),
		);

		return {
			messages: tree,
			hasMore,
			nextCursor: hasMore ? String(pageRows[0].seq) : null,
		};
	},

	/**
	 * Fetch messages added after a given message ID (for WS catch-up).
	 * Returns tree-structured messages in chronological order, capped at `limit`.
	 */
	async getMessagesAfter(narratorId: string, afterMessageId: string, limit = 100) {
		// Find the seq of the reference message
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, afterMessageId),
			),
			columns: { seq: true },
		});
		if (!ref) return [];

		// Fetch top-level messages with seq > ref.seq (chronological order)
		const refRows = await db
			.select({
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
			})
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					gt(narratorMessageRefs.seq, ref.seq),
					isNull(narratorMessages.parentToolUseId),
				),
			)
			.orderBy(sql`${narratorMessageRefs.seq} ASC`)
			.limit(limit);

		if (refRows.length === 0) return [];

		const messageIds = refRows.map((r) => r.messageId);
		const topMessages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, messageIds),
			with: { toolCalls: true },
		});

		const seqMap = new Map(refRows.map((r) => [r.messageId, r.seq]));
		topMessages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));

		const parentToolUseIds = collectToolUseIds(topMessages);
		const childMessages =
			parentToolUseIds.length > 0
				? await db.query.narratorMessages.findMany({
						where: inArray(narratorMessages.parentToolUseId, parentToolUseIds),
						with: { toolCalls: true },
						orderBy: (m, { asc }) => [asc(m.createdAt)],
						limit: 500,
					})
				: [];

		await attachSubagentModels(childMessages);

		return filterExitPlanBeforePlanCompact(
			truncateToolIO(buildMessageTree([...topMessages, ...childMessages])),
		);
	},

	/**
	 * Fetch messages around a target message ID (tree-structured).
	 * If the target is a child message, finds its top-level ancestor first.
	 * Returns `contextSize` top-level messages before + the target's top-level + all after,
	 * with children nested.
	 */
	async getMessagesAround(narratorId: string, messageId: string, contextSize = 5) {
		// Find the target message
		const target = await db.query.narratorMessages.findFirst({
			where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)),
		});
		if (!target) {
			return this.getMessagesCursor(narratorId, 10);
		}

		// If target is a child message, walk up to find the top-level ancestor
		let anchorMessageId = target.id;
		if (target.parentToolUseId) {
			const parentTc = await db.query.narratorToolCalls.findFirst({
				where: and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, target.parentToolUseId),
				),
			});
			if (parentTc) anchorMessageId = parentTc.messageId;
		}

		// Find the anchor's seq in the refs
		const anchorRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, anchorMessageId),
			),
		});
		if (!anchorRef) {
			return this.getMessagesCursor(narratorId, 10);
		}

		// Fetch older top-level messages (seq < anchorSeq)
		const olderRefRows = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					lt(narratorMessageRefs.seq, anchorRef.seq),
					isNull(narratorMessages.parentToolUseId),
				),
			)
			.orderBy(sql`${narratorMessageRefs.seq} DESC`)
			.limit(contextSize + 1);

		const hasMore = olderRefRows.length > contextSize;
		const olderRows = hasMore ? olderRefRows.slice(0, contextSize) : olderRefRows;
		olderRows.reverse();

		// Fetch anchor + all newer top-level messages
		const newerRefRows = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					gte(narratorMessageRefs.seq, anchorRef.seq),
					isNull(narratorMessages.parentToolUseId),
				),
			)
			.orderBy(narratorMessageRefs.seq);

		const allIds = [...olderRows.map((r) => r.messageId), ...newerRefRows.map((r) => r.messageId)];
		if (allIds.length === 0) {
			return { messages: [], hasMore, nextCursor: null };
		}

		// Build seq map for ordering
		const seqMap = new Map<string, number>();
		for (const r of olderRows) seqMap.set(r.messageId, r.seq);
		for (const r of newerRefRows) seqMap.set(r.messageId, r.seq);

		const topMessages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, allIds),
			with: { toolCalls: true },
		});

		// Sort by seq order
		topMessages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));

		// Fetch child messages (don't filter by narratorId — shared messages)
		const parentToolUseIds = collectToolUseIds(topMessages);
		const childMessages =
			parentToolUseIds.length > 0
				? await db.query.narratorMessages.findMany({
						where: inArray(narratorMessages.parentToolUseId, parentToolUseIds),
						with: { toolCalls: true },
						orderBy: (m, { asc }) => [asc(m.createdAt)],
						limit: 500,
					})
				: [];

		await attachSubagentModels(childMessages);

		const tree = filterExitPlanBeforePlanCompact(
			truncateToolIO(buildMessageTree([...topMessages, ...childMessages])),
		);
		return {
			messages: tree,
			hasMore,
			nextCursor: hasMore ? String(olderRows[0]?.seq) : null,
		};
	},

	async getToolCallDetail(narratorId: string, toolUseId: string) {
		const tc = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
		});
		if (!tc) throw new NotFoundError("ToolCall", toolUseId);
		return tc;
	},

	/** Extract the full compact summary from a compact system message. */
	async getCompactSummary(narratorId: string, messageId: string): Promise<string> {
		const msg = await db.query.narratorMessages.findFirst({
			where: and(
				eq(narratorMessages.id, messageId),
				eq(narratorMessages.narratorId, narratorId),
				eq(narratorMessages.role, "system"),
			),
		});
		if (!msg) throw new NotFoundError("Message", messageId);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const blocks = Array.isArray(msg.contentJson) ? (msg.contentJson as any[]) : [];
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const compactBlock = blocks.find((b: any) => b.type === "compact" && b.status === "compacted");
		if (!compactBlock?.summary) {
			throw new NotFoundError("CompactSummary", messageId);
		}
		return compactBlock.summary;
	},

	/** Delete a compact message and clear the narrator's contextSummary. */
	async deleteCompactMessage(narratorId: string, messageId: string) {
		const msg = await db.query.narratorMessages.findFirst({
			where: and(
				eq(narratorMessages.id, messageId),
				eq(narratorMessages.narratorId, narratorId),
				eq(narratorMessages.role, "system"),
			),
		});
		if (!msg) throw new NotFoundError("Message", messageId);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const blocks = Array.isArray(msg.contentJson) ? (msg.contentJson as any[]) : [];
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const compactBlock = blocks.find((b: any) => b.type === "compact");
		if (!compactBlock) throw new ValidationError("Message is not a compact message");

		const isPlan = compactBlock.subtype === "plan";

		// Delete from junction table first
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, messageId));
		await db.delete(narratorMessages).where(eq(narratorMessages.id, messageId));

		// Plan messages don't affect contextSummary; regular compacts need to clear it
		if (!isPlan) {
			await clearContextSummary(narratorId, null);
		}
	},

	/** Update the summary text of a compact message and sync to narrator's contextSummary. */
	async updateCompactSummary(narratorId: string, messageId: string, summary: string) {
		const msg = await db.query.narratorMessages.findFirst({
			where: and(
				eq(narratorMessages.id, messageId),
				eq(narratorMessages.narratorId, narratorId),
				eq(narratorMessages.role, "system"),
			),
		});
		if (!msg) throw new NotFoundError("Message", messageId);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const blocks = Array.isArray(msg.contentJson) ? (msg.contentJson as any[]) : [];
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const compactBlock = blocks.find((b: any) => b.type === "compact" && b.status === "compacted");
		if (!compactBlock) throw new ValidationError("Message is not a compacted message");

		const isPlan = compactBlock.subtype === "plan";
		const newBlock: Record<string, unknown> = {
			type: "compact",
			status: "compacted",
			summary,
		};
		if (isPlan) newBlock.subtype = "plan";

		const prefix = isPlan ? "[Plan]" : "[Compact]";
		await db
			.update(narratorMessages)
			.set({
				contentJson: [newBlock],
				contentText: `${prefix} ${summary.slice(0, 200)}...`,
			})
			.where(eq(narratorMessages.id, messageId));

		// Plan messages don't affect contextSummary; regular compacts do
		if (!isPlan) {
			await clearContextSummary(narratorId, summary);
		}
	},

	async getPendingPermissions(narratorId: string) {
		const tcs = await db.query.narratorToolCalls.findMany({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.status, "pending"),
			),
			orderBy: (tc, { asc }) => [asc(tc.createdAt)],
		});
		return tcs.map((tc) => ({
			id: tc.id,
			toolName: tc.toolName,
			toolUseId: tc.toolUseId,
			inputJson: tc.inputJson,
			decisionReason: tc.permissionDecisionReason,
			suggestions: tc.permissionSuggestions,
		}));
	},

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	async persistUserMessage(narratorId: string, text: string, contentBlocks?: any[]) {
		const id = generateId();
		const now = new Date().toISOString();
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "user",
				contentJson: contentBlocks ?? [{ type: "text", text }],
				contentText: text,
				createdAt: now,
			})
			.returning();

		// Insert into narrator_message_refs junction table
		await appendMessageRef(narratorId, id);
		return msg;
	},

	async persistCompactingMessage(narratorId: string, beforeMessageId?: string) {
		const id = generateId();

		let seq: number;
		if (beforeMessageId) {
			// Atomically shift seq values and compute insertion point
			seq = await db.transaction(async (tx) => {
				const targetRef = await tx.query.narratorMessageRefs.findFirst({
					where: and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, beforeMessageId),
					),
				});
				if (!targetRef) throw new NotFoundError("Message", beforeMessageId);
				await tx
					.update(narratorMessageRefs)
					.set({ seq: sql`${narratorMessageRefs.seq} + 1` })
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							gte(narratorMessageRefs.seq, targetRef.seq),
						),
					);
				return targetRef.seq;
			});
		} else {
			seq = await db.transaction(async (tx) => {
				const result = await tx
					.select({ maxSeq: sql<number | null>`MAX(${narratorMessageRefs.seq})` })
					.from(narratorMessageRefs)
					.where(eq(narratorMessageRefs.narratorId, narratorId));
				return (result[0]?.maxSeq ?? -1) + 1;
			});
		}

		const createdAt = new Date().toISOString();
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "system",
				contentJson: [{ type: "compact", status: "compacting" }],
				contentText: "[Compacting]",
				createdAt,
			})
			.returning();

		await insertMessageRef(narratorId, id, seq);

		return msg;
	},

	/**
	 * Insert a plan compact message — a compact marker with subtype "plan"
	 * that displays its content as a card rather than a collapsible indicator.
	 */
	async persistPlanMessage(narratorId: string, content: string) {
		const id = generateId();

		const createdAt = new Date().toISOString();
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "system",
				contentJson: [{ type: "compact", status: "compacted", subtype: "plan", summary: content }],
				contentText: `[Plan] ${content.slice(0, 200)}...`,
				createdAt,
			})
			.returning();

		await appendMessageRef(narratorId, id, 1);

		return msg;
	},

	/** Update the most recent "compacting" system message to "compacted" with the full summary. */
	async finalizeCompactingMessage(narratorId: string, summary: string, contextPercent?: number) {
		const msg = await db.query.narratorMessages.findFirst({
			where: and(
				eq(narratorMessages.narratorId, narratorId),
				eq(narratorMessages.role, "system"),
				eq(narratorMessages.contentText, "[Compacting]"),
			),
			orderBy: (m, { desc }) => [desc(m.createdAt)],
		});
		if (!msg) return null;
		const [updated] = await db
			.update(narratorMessages)
			.set({
				contentJson: [{ type: "compact", status: "compacted", summary }],
				contentText: `[Compact] ${summary.slice(0, 200)}...`,
				contextPercent: contextPercent ?? null,
			})
			.where(eq(narratorMessages.id, msg.id))
			.returning();

		// Mark as compact in narrator_message_refs
		await db
			.update(narratorMessageRefs)
			.set({ isCompact: 1 })
			.where(eq(narratorMessageRefs.messageId, msg.id));

		return updated;
	},

	async persistAssistantMessage(
		narratorId: string,
		sdkMessage: {
			uuid: string;
			session_id: string;
			parent_tool_use_id?: string | null;
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			message: { content: any[]; usage?: any };
			contextPercent?: number;
			meterUsage?: number;
			meterUnit?: string;
		},
	) {
		const id = generateId();
		const now = new Date().toISOString();
		const content = sdkMessage.message.content;

		// Extract plain text for search
		const contentText = content
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			.filter((b: any) => b.type === "text")
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			.map((b: any) => b.text)
			.join("\n");

		const usage = sdkMessage.message.usage;
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				sdkMessageUuid: sdkMessage.uuid,
				parentToolUseId: sdkMessage.parent_tool_use_id ?? null,
				role: "assistant",
				contentJson: content,
				contentText: contentText || null,
				tokensIn: usage?.input_tokens,
				contextPercent: sdkMessage.contextPercent ?? null,
				meterUsage: sdkMessage.meterUsage ?? null,
				meterUnit: sdkMessage.meterUnit ?? null,
				createdAt: now,
			})
			.returning();

		// Insert into narrator_message_refs junction table
		await appendMessageRef(narratorId, id);

		// Extract tool_use blocks and create tool call records
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const toolUseBlocks = content.filter((b: any) => b.type === "tool_use");
		for (const block of toolUseBlocks) {
			await db.insert(narratorToolCalls).values({
				id: generateId(),
				narratorId,
				messageId: id,
				toolUseId: block.id,
				toolName: block.name,
				inputJson: block.input,
				status: "initializing",
				createdAt: now,
			});
		}

		return msg;
	},

	async updateConversationId(narratorId: string, apiConversationId: string) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ apiConversationId, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},

	async updateStats(narratorId: string, costUsd: number) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({
				messageCount: sql`COALESCE(${narrators.messageCount}, 0) + 1`,
				totalCostUsd: sql`COALESCE(${narrators.totalCostUsd}, 0) + ${costUsd}`,
				lastMessageAt: now,
				updatedAt: now,
			})
			.where(eq(narrators.id, narratorId));
	},

	async updateMessageCost(messageId: string, costUsd: number, turnUsage?: Record<string, unknown>) {
		await db
			.update(narratorMessages)
			.set({
				costUsd,
				...(turnUsage ? { turnUsageJson: turnUsage } : {}),
			})
			.where(eq(narratorMessages.id, messageId));
	},

	async updateTitle(narratorId: string, title: string) {
		const now = new Date().toISOString();
		await db.update(narrators).set({ title, updatedAt: now }).where(eq(narrators.id, narratorId));
	},

	async updateModel(narratorId: string, model: string) {
		const now = new Date().toISOString();
		await db.update(narrators).set({ model, updatedAt: now }).where(eq(narrators.id, narratorId));
	},

	async updatePermissionMode(
		narratorId: string,
		permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "dontAsk",
	) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ permissionMode, updatedAt: now })
			.where(eq(narrators.id, narratorId));

		// 同步权限模式到所有活跃的 subagent
		await db
			.update(narrators)
			.set({ permissionMode, updatedAt: now })
			.where(
				and(
					eq(narrators.parentNarratorId, narratorId),
					eq(narrators.type, "subagent"),
					inArray(narrators.status, ["thinking", "waiting", "idle"]),
				),
			);
	},

	async updatePlanMode(narratorId: string, planMode: boolean) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ planMode, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},

	async updateStatus(
		narratorId: string,
		status: "idle" | "thinking" | "waiting" | "done" | "archived" | "error" | "interrupted",
		errorMessage?: string,
	) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ status, errorMessage, updatedAt: now })
			.where(eq(narrators.id, narratorId));

		eventBus.emit(
			status === "error"
				? { type: "narrator:error", narratorId, error: errorMessage ?? "Unknown error" }
				: { type: "narrator:status_changed", narratorId, status },
		);
	},

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	async updateTodos(narratorId: string, todos: any[], toolUseId?: string) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ todosJson: todos, todosToolUseId: toolUseId ?? null, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},

	async updateToolCallResult(
		toolUseId: string,
		result: {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			output?: any;
			status: "success" | "fail";
			errorMessage?: string;
			durationMs?: number;
		},
	) {
		await db
			.update(narratorToolCalls)
			.set({
				outputJson: result.output ?? null,
				status: result.status,
				errorMessage: result.errorMessage ?? null,
				durationMs: result.durationMs ?? null,
			})
			.where(eq(narratorToolCalls.toolUseId, toolUseId));
	},

	async remove(narratorId: string) {
		// Recursively remove child narrators (subagents, forks) first
		const children = await db.query.narrators.findMany({
			where: eq(narrators.parentNarratorId, narratorId),
			columns: { id: true },
		});
		for (const child of children) {
			await this.remove(child.id);
		}

		// Delete in dependency order within a transaction
		await db.transaction(async (tx) => {
			await tx.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId));
			// Delete narrator_message_refs for this narrator
			await tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, narratorId));

			// Find messages that are ONLY owned by this narrator (not referenced by other narrators)
			const orphanRows = await tx
				.select({ id: narratorMessages.id })
				.from(narratorMessages)
				.where(
					and(
						eq(narratorMessages.narratorId, narratorId),
						sql`NOT EXISTS (
							SELECT 1 FROM narrator_message_refs nmr
							WHERE nmr.message_id = ${narratorMessages.id}
							AND nmr.narrator_id != ${narratorId}
						)`,
					),
				);
			const orphanIds = orphanRows.map((r) => r.id);

			if (orphanIds.length > 0) {
				await tx.delete(narratorMessages).where(inArray(narratorMessages.id, orphanIds));
			}

			await tx.delete(narrators).where(eq(narrators.id, narratorId));
		});
		await deleteNarratorUploads(narratorId);
		logger.info("Narrator removed", { narratorId });
	},

	// === Fork ===

	async forkNarrator(
		parentNarratorId: string,
		forkMessageId: string | null,
		opts?: {
			title?: string;
			newChapterId?: string;
			inheritMode?: "full" | "compressed" | "fresh";
			type?: "primary" | "secondary";
			locale?: string;
		},
	) {
		const parent = await this.getById(parentNarratorId);

		if (parent.type === "subagent") {
			throw new ValidationError("Cannot fork from a subagent narrator");
		}

		const inheritMode = opts?.inheritMode ?? "fresh";
		const now = new Date().toISOString();
		const id = generateId();

		const resolvedPermMode = (parent.permissionMode ?? "default") as
			| "default"
			| "acceptEdits"
			| "bypassPermissions"
			| "dontAsk";

		// Determine fork type
		const targetChapterId = opts?.newChapterId ?? parent.chapterId ?? null;
		const forkType: "primary" | "secondary" =
			opts?.type ?? (targetChapterId ? "secondary" : (parent.type as "primary" | "secondary"));

		// Handle context inheritance
		let contextSummary: string | null = null;
		let apiConversationId: string | null = null;
		let systemPrompt = parent.systemPrompt;

		if (inheritMode === "compressed") {
			const { narratorContext } = await import("./narrator-context");
			const locale = (opts?.locale ?? "en") as import("../lib/prompt-i18n").Locale;
			contextSummary = await narratorContext.generateContextSummary(parentNarratorId, locale);
			if (contextSummary && parent.systemPrompt) {
				systemPrompt = `${parent.systemPrompt}\n\n## Previous Context Summary\n\nThis session continues from a previous conversation. Here is a summary of the prior context:\n\n${contextSummary}`;
			}
		} else if (inheritMode === "full") {
			// Store parent session ID so we can fork on first message
			apiConversationId = parent.apiConversationId ?? null;
		}

		// Copy message refs if forkMessageId is provided
		let prefixRows: Array<{
			messageId: string;
			seq: number;
			isCompact: number;
		}> = [];

		if (forkMessageId) {
			// Verify forkMessage belongs to parent narrator (via refs)
			const forkRef = await db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, parentNarratorId),
					eq(narratorMessageRefs.messageId, forkMessageId),
				),
			});
			if (!forkRef) throw new ValidationError("Fork message not found in parent narrator's refs");

			prefixRows = await db
				.select({
					messageId: narratorMessageRefs.messageId,
					seq: narratorMessageRefs.seq,
					isCompact: narratorMessageRefs.isCompact,
				})
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, parentNarratorId),
						sql`${narratorMessageRefs.seq} <= ${forkRef.seq}`,
					),
				)
				.orderBy(narratorMessageRefs.seq);
		}

		// Create narrator + copy refs atomically
		const newNarrator = await db.transaction(async (tx) => {
			const [created] = await tx
				.insert(narrators)
				.values({
					id,
					chapterId: targetChapterId,
					type: forkType,
					model: parent.model ?? "claude-sonnet",
					systemPrompt,
					permissionMode: resolvedPermMode,
					parentNarratorId,
					forkMessageId: forkMessageId ?? null,
					inheritMode,
					apiConversationId,
					contextSummary,
					status: "idle",
					title: opts?.title ?? null,
					cwd: parent.cwd ?? null,
					createdAt: now,
					updatedAt: now,
				})
				.returning();

			// Batch insert refs
			if (prefixRows.length > 0) {
				await tx.insert(narratorMessageRefs).values(
					prefixRows.map((row) => ({
						id: generateId(),
						narratorId: id,
						messageId: row.messageId,
						seq: row.seq,
						isCompact: row.isCompact,
					})),
				);
			}

			return created;
		});

		eventBus.emit({ type: "narrator:forked", narratorId: id, parentNarratorId });
		logger.info("Narrator forked", { parentNarratorId, newNarratorId: id, forkMessageId });
		return newNarrator;
	},

	async listRelatedNarrators(narratorId: string) {
		// Walk up to find root
		let rootId = narratorId;
		let current = await this.getById(narratorId);
		while (current.parentNarratorId) {
			rootId = current.parentNarratorId;
			current = await this.getById(rootId);
		}

		// Use recursive CTE to find all descendants efficiently (exclude subagents)
		const rows = await db.all<{
			id: string;
			title: string | null;
			parent_narrator_id: string | null;
			fork_message_id: string | null;
			type: string;
			status: string;
			message_count: number | null;
			created_at: string;
		}>(sql`
			WITH RECURSIVE tree AS (
				SELECT id, title, parent_narrator_id, fork_message_id, type, status, message_count, created_at
				FROM narrators WHERE id = ${rootId} AND type != 'subagent'
				UNION ALL
				SELECT n.id, n.title, n.parent_narrator_id, n.fork_message_id, n.type, n.status, n.message_count, n.created_at
				FROM narrators n JOIN tree t ON n.parent_narrator_id = t.id
				WHERE n.type != 'subagent'
			)
			SELECT * FROM tree ORDER BY created_at ASC
		`);

		return rows.map((n) => ({
			id: n.id,
			title: n.title,
			parentNarratorId: n.parent_narrator_id,
			forkMessageId: n.fork_message_id,
			type: n.type,
			status: n.status,
			messageCount: n.message_count,
			createdAt: n.created_at,
		}));
	},
};
