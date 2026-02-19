import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
	chapters,
	narratorMessages,
	narrators,
	narratorToolCalls,
	permissionRequests,
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
function buildMessageTree(flatMessages: any[]): any[] {
	// Shallow clone each message to avoid mutating drizzle results
	const cloned = flatMessages.map((msg) => ({ ...msg, children: [] as any[] }));

	// Map: toolUseId → cloned message that CONTAINS that tool_use block
	const toolUseIdToMsg = new Map<string, any>();
	for (const msg of cloned) {
		if (msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				toolUseIdToMsg.set(tc.toolUseId, msg);
			}
		}
	}

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
function truncateJson(val: any, maxLen: number): any {
	if (val === null || val === undefined) return val;
	const str = typeof val === "string" ? val : JSON.stringify(val);
	if (str.length <= maxLen) return val;
	return { _truncated: true, preview: str.slice(0, maxLen), fullLength: str.length };
}

/** Recursively truncate large inputJson/outputJson in tool calls within a message tree */
function truncateToolIO(tree: any[], maxLen = 2000): any[] {
	return tree.map((msg) => ({
		...msg,
		toolCalls: msg.toolCalls?.map((tc: any) => ({
			...tc,
			inputJson: truncateJson(tc.inputJson, maxLen),
			outputJson: truncateJson(tc.outputJson, maxLen),
		})),
		children: msg.children?.length ? truncateToolIO(msg.children, maxLen) : msg.children,
	}));
}

/** Collect all toolUseIds from a set of messages (for iterative child fetching) */
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

interface CreateNarratorInput {
	chapterId?: string | null;
	type?: "primary" | "secondary";
	model?: string;
	systemPrompt?: string;
	permissionMode?: string;
	cwd?: string;
	sdkPlanMode?: boolean;
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
				sdkPlanMode: input.sdkPlanMode ?? false,
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
			with: { toolCalls: { with: { permissionRequests: true } } },
			orderBy: (m, { asc }) => [asc(m.createdAt)],
			limit,
			offset,
		});
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
		// Query 1: top-level messages only (parentToolUseId IS NULL)
		const topConditions: any[] = [
			eq(narratorMessages.narratorId, narratorId),
			isNull(narratorMessages.parentToolUseId),
		];
		if (cursor) {
			// Composite cursor: "createdAt|id" — backward-compatible with plain timestamp
			const sepIdx = cursor.indexOf("|");
			if (sepIdx >= 0) {
				const cursorTs = cursor.slice(0, sepIdx);
				const cursorId = cursor.slice(sepIdx + 1);
				topConditions.push(
					or(
						lt(narratorMessages.createdAt, cursorTs),
						and(eq(narratorMessages.createdAt, cursorTs), lt(narratorMessages.id, cursorId)),
					)!,
				);
			} else {
				topConditions.push(lt(narratorMessages.createdAt, cursor));
			}
		}
		const topRows = await db.query.narratorMessages.findMany({
			where: and(...topConditions),
			with: { toolCalls: { with: { permissionRequests: true } } },
			orderBy: (m, { desc }) => [desc(m.createdAt)],
			limit: limit + 1,
		});
		const hasMore = topRows.length > limit;
		const topMessages = hasMore ? topRows.slice(0, limit) : topRows;
		topMessages.reverse(); // chronological order

		if (topMessages.length === 0) {
			return { messages: [], hasMore, nextCursor: null };
		}

		// Query 2: fetch child messages whose parentToolUseId matches a tool call
		// in the top-level messages.
		const parentToolUseIds = collectToolUseIds(topMessages);
		const childMessages =
			parentToolUseIds.length > 0
				? await db.query.narratorMessages.findMany({
						where: and(
							eq(narratorMessages.narratorId, narratorId),
							inArray(narratorMessages.parentToolUseId, parentToolUseIds),
						),
						with: { toolCalls: { with: { permissionRequests: true } } },
						orderBy: (m, { asc }) => [asc(m.createdAt)],
						limit: 500,
					})
				: [];

		// Build tree from combined set and truncate large tool I/O
		const tree = truncateToolIO(buildMessageTree([...topMessages, ...childMessages]));

		return {
			messages: tree,
			hasMore,
			nextCursor: hasMore ? `${topMessages[0].createdAt}|${topMessages[0].id}` : null,
		};
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
		let anchorTs = target.createdAt;
		if (target.parentToolUseId) {
			const parentTc = await db.query.narratorToolCalls.findFirst({
				where: and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, target.parentToolUseId),
				),
			});
			if (parentTc) {
				const parentMsg = await db.query.narratorMessages.findFirst({
					where: eq(narratorMessages.id, parentTc.messageId),
				});
				if (parentMsg) anchorTs = parentMsg.createdAt;
			}
		}

		// Fetch top-level messages before the anchor
		const olderRows = await db.query.narratorMessages.findMany({
			where: and(
				eq(narratorMessages.narratorId, narratorId),
				isNull(narratorMessages.parentToolUseId),
				lt(narratorMessages.createdAt, anchorTs),
			),
			with: { toolCalls: { with: { permissionRequests: true } } },
			orderBy: (m, { desc }) => [desc(m.createdAt)],
			limit: contextSize + 1,
		});
		const hasMore = olderRows.length > contextSize;
		const olderMessages = hasMore ? olderRows.slice(0, contextSize) : olderRows;
		olderMessages.reverse();

		// Fetch the anchor + all newer top-level messages
		const newerRows = await db.query.narratorMessages.findMany({
			where: and(
				eq(narratorMessages.narratorId, narratorId),
				isNull(narratorMessages.parentToolUseId),
				gte(narratorMessages.createdAt, anchorTs),
			),
			with: { toolCalls: { with: { permissionRequests: true } } },
			orderBy: (m, { asc }) => [asc(m.createdAt)],
		});

		const topMessages = [...olderMessages, ...newerRows];
		if (topMessages.length === 0) {
			return { messages: [], hasMore, nextCursor: null };
		}

		// Fetch child messages by parentToolUseId matching
		const parentToolUseIds = collectToolUseIds(topMessages);
		const childMessages =
			parentToolUseIds.length > 0
				? await db.query.narratorMessages.findMany({
						where: and(
							eq(narratorMessages.narratorId, narratorId),
							inArray(narratorMessages.parentToolUseId, parentToolUseIds),
						),
						with: { toolCalls: { with: { permissionRequests: true } } },
						orderBy: (m, { asc }) => [asc(m.createdAt)],
						limit: 500,
					})
				: [];

		const tree = truncateToolIO(buildMessageTree([...topMessages, ...childMessages]));
		return {
			messages: tree,
			hasMore,
			nextCursor: hasMore ? (olderMessages[0]?.createdAt ?? null) : null,
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

	async getPendingPermissions(narratorId: string) {
		const perms = await db.query.permissionRequests.findMany({
			where: and(
				eq(permissionRequests.narratorId, narratorId),
				eq(permissionRequests.decision, "pending"),
			),
			with: { toolCall: { columns: { toolUseId: true } } },
			orderBy: (p, { asc }) => [asc(p.createdAt)],
		});
		return perms.map((perm) => ({
			...perm,
			toolUseId: perm.toolCall?.toolUseId ?? null,
			toolCall: undefined,
		}));
	},

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
		return msg;
	},

	async persistCompactingMessage(narratorId: string) {
		const id = generateId();
		const now = new Date().toISOString();
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "system",
				contentJson: [{ type: "compact", status: "compacting" }],
				contentText: "[Compacting]",
				createdAt: now,
			})
			.returning();
		return msg;
	},

	async persistCompactMessage(narratorId: string, summary: string) {
		const id = generateId();
		const now = new Date().toISOString();
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "system",
				contentJson: [{ type: "compact", status: "compacted" }],
				contentText: `[Compact] ${summary.slice(0, 200)}...`,
				createdAt: now,
			})
			.returning();
		return msg;
	},

	/** Update the most recent "compacting" system message to "compacted" status. */
	async finalizeCompactingMessage(narratorId: string) {
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
				contentJson: [{ type: "compact", status: "compacted" }],
				contentText: "[Compacted]",
			})
			.where(eq(narratorMessages.id, msg.id))
			.returning();
		return updated;
	},

	async persistAssistantMessage(
		narratorId: string,
		sdkMessage: {
			uuid: string;
			session_id: string;
			parent_tool_use_id?: string | null;
			message: { content: any[]; usage?: any };
		},
	) {
		const id = generateId();
		const now = new Date().toISOString();
		const content = sdkMessage.message.content;

		// Extract plain text for search
		const contentText = content
			.filter((b: any) => b.type === "text")
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
				createdAt: now,
			})
			.returning();

		// Extract tool_use blocks and create tool call records
		const toolUseBlocks = content.filter((b: any) => b.type === "tool_use");
		for (const block of toolUseBlocks) {
			await db.insert(narratorToolCalls).values({
				id: generateId(),
				narratorId,
				messageId: id,
				toolUseId: block.id,
				toolName: block.name,
				inputJson: block.input,
				status: "running",
				createdAt: now,
			});
		}

		return msg;
	},

	async updateSessionId(narratorId: string, claudeSessionId: string) {
		await db
			.update(narrators)
			.set({ claudeSessionId, updatedAt: new Date().toISOString() })
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
	},

	async updateSdkPlanMode(narratorId: string, sdkPlanMode: boolean) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ sdkPlanMode, updatedAt: now })
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
			output?: any;
			status: "completed" | "failed";
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
			await tx.delete(permissionRequests).where(eq(permissionRequests.narratorId, narratorId));
			await tx.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId));
			await tx.delete(narratorMessages).where(eq(narratorMessages.narratorId, narratorId));
			await tx.delete(narrators).where(eq(narrators.id, narratorId));
		});
		await deleteNarratorUploads(narratorId);
		logger.info("Narrator removed", { narratorId });
	},
};
