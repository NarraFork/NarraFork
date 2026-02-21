import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import {
	branchMessages,
	chapters,
	conversationBranches,
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

/** Recursively truncate large inputJson/outputJson in tool calls within a message tree */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function truncateToolIO(tree: any[], maxLen = 2000): any[] {
	return tree.map((msg) => ({
		...msg,
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		toolCalls: msg.toolCalls?.map((tc: any) => ({
			...tc,
			inputJson: truncateJson(tc.inputJson, maxLen),
			outputJson: truncateJson(tc.outputJson, maxLen),
		})),
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

/** Insert a message into branch_messages junction table */
async function insertBranchMessage(
	branchId: string,
	messageId: string,
	seq: number,
	isCompact = 0,
): Promise<void> {
	await db.insert(branchMessages).values({
		id: generateId(),
		branchId,
		messageId,
		seq,
		isCompact,
	});
}

/** Atomically get next seq and insert into branch_messages (prevents race conditions) */
async function appendBranchMessage(
	branchId: string,
	messageId: string,
	isCompact = 0,
): Promise<number> {
	return db.transaction(async (tx) => {
		const result = await tx
			.select({ maxSeq: sql<number | null>`MAX(${branchMessages.seq})` })
			.from(branchMessages)
			.where(eq(branchMessages.branchId, branchId));
		const seq = (result[0]?.maxSeq ?? -1) + 1;
		await tx.insert(branchMessages).values({
			id: generateId(),
			branchId,
			messageId,
			seq,
			isCompact,
		});
		return seq;
	});
}

/**
 * Clear or set contextSummary + apiConversationId on the active branch (or narrator if no branch).
 * Pass `summary = null` to clear, or a string to set.
 */
async function clearContextSummary(narratorId: string, summary: string | null) {
	const now = new Date().toISOString();
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { activeBranchId: true },
	});
	if (narrator?.activeBranchId) {
		await db
			.update(conversationBranches)
			.set({ contextSummary: summary, apiConversationId: null, updatedAt: now })
			.where(eq(conversationBranches.id, narrator.activeBranchId));
	}
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
		const rootBranchId = `root-${id}`;
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
				activeBranchId: rootBranchId,
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

		// Auto-create root branch
		await db.insert(conversationBranches).values({
			id: rootBranchId,
			narratorId: id,
			name: "main",
			forkMessageId: null,
			parentBranchId: null,
			status: "active",
			messageCount: 0,
			createdAt: now,
			updatedAt: now,
		});

		logger.info("Narrator created", { id, chapterId: input.chapterId, type });
		return narrator;
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
			where: eq(narrators.chapterId, chapterId),
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
	 * Uses branch_messages junction table for branch-aware queries.
	 */
	async getMessagesSinceLastCompact(narratorId: string) {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { activeBranchId: true },
		});
		const activeBranchId = narrator?.activeBranchId;
		if (!activeBranchId) return [];

		// Find the last compact marker's seq in this branch
		const lastCompactRow = await db
			.select({ seq: branchMessages.seq })
			.from(branchMessages)
			.where(and(eq(branchMessages.branchId, activeBranchId), eq(branchMessages.isCompact, 1)))
			.orderBy(sql`${branchMessages.seq} DESC`)
			.limit(1);

		const compactSeq = lastCompactRow[0]?.seq;

		// Fetch message IDs from branch_messages
		const bmRows = await db
			.select({ messageId: branchMessages.messageId, seq: branchMessages.seq })
			.from(branchMessages)
			.where(
				and(
					eq(branchMessages.branchId, activeBranchId),
					compactSeq != null ? gt(branchMessages.seq, compactSeq) : undefined,
				),
			)
			.orderBy(branchMessages.seq);

		if (bmRows.length === 0) return [];

		const messageIds = bmRows.map((r) => r.messageId);
		const messages = await db.query.narratorMessages.findMany({
			where: and(
				eq(narratorMessages.narratorId, narratorId),
				inArray(narratorMessages.id, messageIds),
			),
			with: { toolCalls: true },
		});

		// Sort by seq order from branch_messages (not createdAt)
		const seqMap = new Map(bmRows.map((r) => [r.messageId, r.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		return messages;
	},

	/**
	 * Fetch messages between the last compact marker and a given message (exclusive).
	 * Used for partial compact — compress only messages before the target.
	 */
	async getMessagesBefore(narratorId: string, beforeMessageId: string) {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { activeBranchId: true },
		});
		const activeBranchId = narrator?.activeBranchId;
		if (!activeBranchId) return [];

		// Find the target message's seq
		const targetBm = await db.query.branchMessages.findFirst({
			where: and(
				eq(branchMessages.branchId, activeBranchId),
				eq(branchMessages.messageId, beforeMessageId),
			),
		});
		if (!targetBm) throw new NotFoundError("Message", beforeMessageId);

		// Find the last compact marker before the target
		const lastCompactRow = await db
			.select({ seq: branchMessages.seq })
			.from(branchMessages)
			.where(
				and(
					eq(branchMessages.branchId, activeBranchId),
					eq(branchMessages.isCompact, 1),
					lt(branchMessages.seq, targetBm.seq),
				),
			)
			.orderBy(sql`${branchMessages.seq} DESC`)
			.limit(1);

		const compactSeq = lastCompactRow[0]?.seq;

		const lowerBound = compactSeq != null ? gt(branchMessages.seq, compactSeq) : sql`1=1`;

		// Get message IDs in range (compactSeq, targetSeq)
		const bmRows = await db
			.select({ messageId: branchMessages.messageId, seq: branchMessages.seq })
			.from(branchMessages)
			.where(
				and(
					eq(branchMessages.branchId, activeBranchId),
					lowerBound,
					lt(branchMessages.seq, targetBm.seq),
				),
			)
			.orderBy(branchMessages.seq);

		if (bmRows.length === 0) return [];

		const messageIds = bmRows.map((r) => r.messageId);
		const messages = await db.query.narratorMessages.findMany({
			where: and(
				eq(narratorMessages.narratorId, narratorId),
				inArray(narratorMessages.id, messageIds),
			),
			with: { toolCalls: true },
		});

		// Sort by seq order from branch_messages (not createdAt)
		const seqMap = new Map(bmRows.map((r) => [r.messageId, r.seq]));
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

	async getMessagesCursor(
		narratorId: string,
		limit = 50,
		cursor?: string,
		branchId?: string | null,
	) {
		// Resolve effective branchId: use provided, or narrator's activeBranchId
		let effectiveBranchId = branchId;
		if (effectiveBranchId === undefined) {
			const narrator = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { activeBranchId: true },
			});
			effectiveBranchId = narrator?.activeBranchId ?? null;
		}

		if (!effectiveBranchId) {
			return { messages: [], hasMore: false, nextCursor: null };
		}

		// Build cursor condition on seq
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const cursorConditions: any[] = [eq(branchMessages.branchId, effectiveBranchId)];
		if (cursor) {
			const cursorSeq = Number.parseInt(cursor, 10);
			if (!Number.isNaN(cursorSeq)) {
				cursorConditions.push(lt(branchMessages.seq, cursorSeq));
			}
		}

		// Query top-level messages via junction table, ordered by seq DESC
		const bmRows = await db
			.select({
				messageId: branchMessages.messageId,
				seq: branchMessages.seq,
			})
			.from(branchMessages)
			.innerJoin(narratorMessages, eq(branchMessages.messageId, narratorMessages.id))
			.where(and(...cursorConditions, isNull(narratorMessages.parentToolUseId)))
			.orderBy(sql`${branchMessages.seq} DESC`)
			.limit(limit + 1);

		const hasMore = bmRows.length > limit;
		const pageRows = hasMore ? bmRows.slice(0, limit) : bmRows;
		pageRows.reverse(); // chronological order

		if (pageRows.length === 0) {
			return { messages: [], hasMore, nextCursor: null };
		}

		const messageIds = pageRows.map((r) => r.messageId);
		const topMessages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, messageIds),
			with: { toolCalls: true },
		});

		// Sort by seq order from branch_messages (not createdAt)
		const seqMap = new Map(pageRows.map((r) => [r.messageId, r.seq]));
		topMessages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));

		// Fetch child messages
		const parentToolUseIds = collectToolUseIds(topMessages);
		const childMessages =
			parentToolUseIds.length > 0
				? await db.query.narratorMessages.findMany({
						where: and(
							eq(narratorMessages.narratorId, narratorId),
							inArray(narratorMessages.parentToolUseId, parentToolUseIds),
						),
						with: { toolCalls: true },
						orderBy: (m, { asc }) => [asc(m.createdAt)],
						limit: 500,
					})
				: [];

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
	 * Fetch messages around a target message ID (tree-structured).
	 * If the target is a child message, finds its top-level ancestor first.
	 * Returns `contextSize` top-level messages before + the target's top-level + all after,
	 * with children nested.
	 */
	async getMessagesAround(
		narratorId: string,
		messageId: string,
		contextSize = 5,
		branchId?: string,
	) {
		let effectiveBranchId = branchId;
		if (!effectiveBranchId) {
			const narrator = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { activeBranchId: true },
			});
			effectiveBranchId = narrator?.activeBranchId ?? undefined;
		}
		if (!effectiveBranchId) {
			return this.getMessagesCursor(narratorId, 10);
		}

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

		// Find the anchor's seq in the branch
		const anchorBm = await db.query.branchMessages.findFirst({
			where: and(
				eq(branchMessages.branchId, effectiveBranchId),
				eq(branchMessages.messageId, anchorMessageId),
			),
		});
		if (!anchorBm) {
			return this.getMessagesCursor(narratorId, 10);
		}

		// Fetch older top-level messages (seq < anchorSeq)
		const olderBmRows = await db
			.select({ messageId: branchMessages.messageId, seq: branchMessages.seq })
			.from(branchMessages)
			.innerJoin(narratorMessages, eq(branchMessages.messageId, narratorMessages.id))
			.where(
				and(
					eq(branchMessages.branchId, effectiveBranchId),
					lt(branchMessages.seq, anchorBm.seq),
					isNull(narratorMessages.parentToolUseId),
				),
			)
			.orderBy(sql`${branchMessages.seq} DESC`)
			.limit(contextSize + 1);

		const hasMore = olderBmRows.length > contextSize;
		const olderRows = hasMore ? olderBmRows.slice(0, contextSize) : olderBmRows;
		olderRows.reverse();

		// Fetch anchor + all newer top-level messages
		const newerBmRows = await db
			.select({ messageId: branchMessages.messageId, seq: branchMessages.seq })
			.from(branchMessages)
			.innerJoin(narratorMessages, eq(branchMessages.messageId, narratorMessages.id))
			.where(
				and(
					eq(branchMessages.branchId, effectiveBranchId ?? ""),
					gte(branchMessages.seq, anchorBm.seq),
					isNull(narratorMessages.parentToolUseId),
				),
			)
			.orderBy(branchMessages.seq);

		const allIds = [...olderRows.map((r) => r.messageId), ...newerBmRows.map((r) => r.messageId)];
		if (allIds.length === 0) {
			return { messages: [], hasMore, nextCursor: null };
		}

		// Build seq map for ordering
		const seqMap = new Map<string, number>();
		for (const r of olderRows) seqMap.set(r.messageId, r.seq);
		for (const r of newerBmRows) seqMap.set(r.messageId, r.seq);

		const topMessages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, allIds),
			with: { toolCalls: true },
		});

		// Sort by seq order
		topMessages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));

		// Fetch child messages
		const parentToolUseIds = collectToolUseIds(topMessages);
		const childMessages =
			parentToolUseIds.length > 0
				? await db.query.narratorMessages.findMany({
						where: and(
							eq(narratorMessages.narratorId, narratorId),
							inArray(narratorMessages.parentToolUseId, parentToolUseIds),
						),
						with: { toolCalls: true },
						orderBy: (m, { asc }) => [asc(m.createdAt)],
						limit: 500,
					})
				: [];

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
		await db.delete(branchMessages).where(eq(branchMessages.messageId, messageId));
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
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { activeBranchId: true },
		});
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

		// Insert into branch_messages junction table
		if (narrator?.activeBranchId) {
			await appendBranchMessage(narrator.activeBranchId, id);
			await db
				.update(conversationBranches)
				.set({
					messageCount: sql`COALESCE(${conversationBranches.messageCount}, 0) + 1`,
					updatedAt: now,
				})
				.where(eq(conversationBranches.id, narrator.activeBranchId));
		}
		return msg;
	},

	async persistCompactingMessage(narratorId: string, beforeMessageId?: string) {
		const id = generateId();
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { activeBranchId: true },
		});
		const activeBranchId = narrator?.activeBranchId;

		let seq: number;
		if (beforeMessageId && activeBranchId) {
			// Atomically shift seq values and compute insertion point
			seq = await db.transaction(async (tx) => {
				const targetBm = await tx.query.branchMessages.findFirst({
					where: and(
						eq(branchMessages.branchId, activeBranchId),
						eq(branchMessages.messageId, beforeMessageId),
					),
				});
				if (!targetBm) throw new NotFoundError("Message", beforeMessageId);
				await tx
					.update(branchMessages)
					.set({ seq: sql`${branchMessages.seq} + 1` })
					.where(
						and(eq(branchMessages.branchId, activeBranchId), gte(branchMessages.seq, targetBm.seq)),
					);
				return targetBm.seq;
			});
		} else if (activeBranchId) {
			seq = await db.transaction(async (tx) => {
				const result = await tx
					.select({ maxSeq: sql<number | null>`MAX(${branchMessages.seq})` })
					.from(branchMessages)
					.where(eq(branchMessages.branchId, activeBranchId));
				return (result[0]?.maxSeq ?? -1) + 1;
			});
		} else {
			seq = 0;
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

		if (activeBranchId) {
			await insertBranchMessage(activeBranchId, id, seq);
		}

		return msg;
	},

	/**
	 * Insert a plan compact message — a compact marker with subtype "plan"
	 * that displays its content as a card rather than a collapsible indicator.
	 */
	async persistPlanMessage(narratorId: string, content: string) {
		const id = generateId();
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { activeBranchId: true },
		});
		const activeBranchId = narrator?.activeBranchId;

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

		if (activeBranchId) {
			await appendBranchMessage(activeBranchId, id, 1);
		}

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

		// Mark as compact in branch_messages
		await db
			.update(branchMessages)
			.set({ isCompact: 1 })
			.where(eq(branchMessages.messageId, msg.id));

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

		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { activeBranchId: true },
		});

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

		// Insert into branch_messages junction table
		if (narrator?.activeBranchId) {
			await appendBranchMessage(narrator.activeBranchId, id);
			await db
				.update(conversationBranches)
				.set({
					messageCount: sql`COALESCE(${conversationBranches.messageCount}, 0) + 1`,
					updatedAt: now,
				})
				.where(eq(conversationBranches.id, narrator.activeBranchId));
		}

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
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { activeBranchId: true },
		});
		if (narrator?.activeBranchId) {
			await db
				.update(conversationBranches)
				.set({ apiConversationId, updatedAt: now })
				.where(eq(conversationBranches.id, narrator.activeBranchId));
		} else {
			await db
				.update(narrators)
				.set({ apiConversationId, updatedAt: now })
				.where(eq(narrators.id, narratorId));
		}
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
		// Delete in dependency order within a transaction
		await db.transaction(async (tx) => {
			await tx.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId));
			// Delete branch_messages for all branches of this narrator
			const branches = await tx.query.conversationBranches.findMany({
				where: eq(conversationBranches.narratorId, narratorId),
				columns: { id: true },
			});
			if (branches.length > 0) {
				await tx.delete(branchMessages).where(
					inArray(
						branchMessages.branchId,
						branches.map((b) => b.id),
					),
				);
			}
			await tx.delete(narratorMessages).where(eq(narratorMessages.narratorId, narratorId));
			await tx.delete(conversationBranches).where(eq(conversationBranches.narratorId, narratorId));
			await tx.delete(narrators).where(eq(narrators.id, narratorId));
		});
		await deleteNarratorUploads(narratorId);
		logger.info("Narrator removed", { narratorId });
	},

	// === Branch CRUD ===

	async listBranches(narratorId: string) {
		return db.query.conversationBranches.findMany({
			where: eq(conversationBranches.narratorId, narratorId),
			orderBy: (b, { asc }) => [asc(b.createdAt)],
		});
	},

	async getBranch(branchId: string) {
		const branch = await db.query.conversationBranches.findFirst({
			where: eq(conversationBranches.id, branchId),
		});
		if (!branch) throw new NotFoundError("Branch", branchId);
		return branch;
	},

	async createBranch(narratorId: string, forkMessageId: string, name?: string) {
		const narrator = await this.getById(narratorId);
		const activeBranchId = narrator.activeBranchId;
		if (!activeBranchId) throw new ValidationError("Narrator has no active branch");

		// Verify fork message belongs to this narrator
		const forkMsg = await db.query.narratorMessages.findFirst({
			where: and(
				eq(narratorMessages.id, forkMessageId),
				eq(narratorMessages.narratorId, narratorId),
			),
		});
		if (!forkMsg) throw new NotFoundError("Message", forkMessageId);

		// Find the fork message's seq in the parent branch
		const forkBm = await db.query.branchMessages.findFirst({
			where: and(
				eq(branchMessages.branchId, activeBranchId),
				eq(branchMessages.messageId, forkMessageId),
			),
		});
		if (!forkBm) throw new ValidationError("Fork message not found in active branch");

		// Count existing branches for auto-naming
		const existingBranches = await db.query.conversationBranches.findMany({
			where: eq(conversationBranches.narratorId, narratorId),
			columns: { id: true },
		});
		const branchName = name || `Branch ${existingBranches.length + 1}`;

		const now = new Date().toISOString();
		const id = generateId();
		const [branch] = await db
			.insert(conversationBranches)
			.values({
				id,
				narratorId,
				name: branchName,
				forkMessageId,
				parentBranchId: activeBranchId,
				status: "active",
				messageCount: 0,
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		// Copy shared prefix: all messages from parent branch with seq <= forkSeq
		const prefixRows = await db
			.select({
				messageId: branchMessages.messageId,
				seq: branchMessages.seq,
				isCompact: branchMessages.isCompact,
			})
			.from(branchMessages)
			.where(
				and(
					eq(branchMessages.branchId, activeBranchId),
					sql`${branchMessages.seq} <= ${forkBm.seq}`,
				),
			)
			.orderBy(branchMessages.seq);

		for (const row of prefixRows) {
			await db.insert(branchMessages).values({
				id: generateId(),
				branchId: id,
				messageId: row.messageId,
				seq: row.seq,
				isCompact: row.isCompact,
			});
		}

		// Update branch message count
		await db
			.update(conversationBranches)
			.set({ messageCount: prefixRows.length, updatedAt: now })
			.where(eq(conversationBranches.id, id));

		// Switch to the new branch
		await db
			.update(narrators)
			.set({ activeBranchId: id, updatedAt: now })
			.where(eq(narrators.id, narratorId));

		eventBus.emit({ type: "narrator:branch_created", narratorId, branchId: id });
		eventBus.emit({ type: "narrator:branch_switched", narratorId, activeBranchId: id });

		logger.info("Branch created", { narratorId, branchId: id, forkMessageId });
		return branch;
	},

	async updateBranch(
		narratorId: string,
		branchId: string,
		data: { name?: string; status?: "active" | "archived" },
	) {
		const branch = await this.getBranch(branchId);
		if (branch.narratorId !== narratorId) {
			throw new ValidationError("Branch does not belong to this narrator");
		}

		const now = new Date().toISOString();
		const [updated] = await db
			.update(conversationBranches)
			.set({ ...data, updatedAt: now })
			.where(eq(conversationBranches.id, branchId))
			.returning();

		eventBus.emit({ type: "narrator:branch_updated", narratorId, branchId });
		return updated;
	},

	async deleteBranch(narratorId: string, branchId: string) {
		const branch = await this.getBranch(branchId);
		if (branch.narratorId !== narratorId) {
			throw new ValidationError("Branch does not belong to this narrator");
		}

		// Prevent deleting root branch
		if (!branch.parentBranchId) {
			throw new ValidationError("Cannot delete the root branch");
		}

		await db.transaction(async (tx) => {
			// Promote child branches: set their parentBranchId to this branch's parent
			await tx
				.update(conversationBranches)
				.set({ parentBranchId: branch.parentBranchId, updatedAt: new Date().toISOString() })
				.where(eq(conversationBranches.parentBranchId, branchId));

			// Find messages that are ONLY in this branch (not referenced by other branches)
			const orphanRows = await tx.all<{ message_id: string }>(sql`
				SELECT bm.message_id FROM branch_messages bm
				WHERE bm.branch_id = ${branchId}
				AND NOT EXISTS (
					SELECT 1 FROM branch_messages bm2
					WHERE bm2.message_id = bm.message_id AND bm2.branch_id != ${branchId}
				)
			`);
			const orphanIds = orphanRows.map((r) => r.message_id);

			// Delete branch_messages rows for this branch
			await tx.delete(branchMessages).where(eq(branchMessages.branchId, branchId));

			// Delete orphaned messages and their tool calls
			if (orphanIds.length > 0) {
				await tx.delete(narratorToolCalls).where(inArray(narratorToolCalls.messageId, orphanIds));
				await tx.delete(narratorMessages).where(inArray(narratorMessages.id, orphanIds));
			}

			// Delete the branch record
			await tx.delete(conversationBranches).where(eq(conversationBranches.id, branchId));

			// If this was the active branch, switch to parent
			const narrator = await tx.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { activeBranchId: true },
			});
			if (narrator?.activeBranchId === branchId) {
				const newActive = branch.parentBranchId ?? "";
				await tx
					.update(narrators)
					.set({ activeBranchId: newActive, updatedAt: new Date().toISOString() })
					.where(eq(narrators.id, narratorId));
				eventBus.emit({ type: "narrator:branch_switched", narratorId, activeBranchId: newActive });
			}
		});

		eventBus.emit({ type: "narrator:branch_deleted", narratorId, branchId });
		logger.info("Branch deleted", { narratorId, branchId });
	},

	async switchBranch(narratorId: string, branchId: string) {
		const branch = await this.getBranch(branchId);
		if (branch.narratorId !== narratorId) {
			throw new ValidationError("Branch does not belong to this narrator");
		}

		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ activeBranchId: branchId, updatedAt: now })
			.where(eq(narrators.id, narratorId));

		eventBus.emit({ type: "narrator:branch_switched", narratorId, activeBranchId: branchId });
		logger.info("Branch switched", { narratorId, activeBranchId: branchId });
	},
};
