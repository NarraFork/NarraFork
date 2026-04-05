import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	and,
	asc,
	type Column,
	count as countFn,
	desc,
	eq,
	gt,
	gte,
	isNotNull,
	isNull,
	lt,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import {
	chapters,
	containerInstances,
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narratorFileSnapshots,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
	projects,
	terminals,
	users,
} from "../db/schema";
import { agentGenerateWithHistory } from "../lib/agent";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { pathsEqual, resolvePath } from "../lib/platform-path";
import {
	getToolMessage,
	getUserLanguage,
	getUserReplyInLanguage,
	type Locale,
} from "../lib/prompt-i18n";
import { type ImageRef, saveUploadedImage, validateTextFile } from "../lib/uploads";
import {
	createBlacklistCmdSchema,
	createBlacklistDirSchema,
	createNarratorSchema,
	createWhitelistCmdSchema,
	createWhitelistDirSchema,
	forkNarratorSchema,
	permissionDecisionSchema,
	reorderBufferSchema,
	sendMessageSchema,
	suggestAnswersSchema,
	updateBlacklistCmdSchema,
	updateBlacklistDirSchema,
	updateBufferedMessageSchema,
	updateNarratorModelSchema,
	updateNarratorTitleSchema,
	updateWhitelistCmdSchema,
	updateWhitelistDirSchema,
} from "../lib/validators";
import type {
	LoadSkillResult,
	LoadToolNotFound,
	LoadToolResult,
} from "../services/command-service";
import { getSlashMenuItems, resolveCommand } from "../services/command-service";
import {
	applyToolCall,
	getAffectedFiles,
	groupByFile,
	queryOrderedToolCalls,
	rebuildFileState,
	rebuildFileStatesExcluding,
	rebuildFileStatesUpToSeq,
} from "../services/file-state-rebuild";
import {
	handleLoadSkillCommand,
	handleLoadToolCommand,
	narratorService,
} from "../services/narrator-service";
import {
	type BufferCreator,
	clearBufferedMessages,
	closeNarrator,
	continueNarrator,
	editAndRegenerate,
	getBufferedMessages,
	interruptNarrator,
	isCompactInProgress,
	isNarratorActive,
	pushBufferedMessage,
	regenerateFromMessage,
	removeBufferedMessage,
	reorderBufferedMessages,
	resolveAllPendingPermissions,
	resolvePermission,
	retryLastMessage,
	runCustomCompact,
	sendMessage,
	toBufferSummary,
	updateBufferedMessage,
	updateNarratorModel,
	updateNarratorPermissionMode,
} from "../services/narrator-session";
import { generateTitle, persistTitle } from "../services/narrator-title";
import { resolveNarratorCwd } from "../services/snapshot-revert";
import {
	broadcastToNarrator,
	getNarratorIdsWithPresence,
	getNarratorPresenceBatch,
} from "../websocket/narrator-ws";

/** Parse message request supporting both JSON and multipart/form-data (with images and text files) */
export async function parseMessageRequest(
	c: {
		req: {
			header: (name: string) => string | undefined;
			formData: () => Promise<FormData>;
			json: () => Promise<unknown>;
		};
	},
	narratorId: string,
): Promise<{ message: string; images: ImageRef[]; textFiles: File[] }> {
	const contentType = c.req.header("content-type") ?? "";
	if (contentType.includes("multipart/form-data")) {
		const formData = await c.req.formData();
		const message = formData.get("message") as string;
		if (!message?.trim()) throw new ValidationError("message is required");
		const imageFiles = formData.getAll("images") as File[];
		if (imageFiles.length > 10) {
			throw new ValidationError("Maximum 10 images per message");
		}
		const images: ImageRef[] = [];
		for (const file of imageFiles) {
			images.push(await saveUploadedImage(narratorId, file));
		}
		const textFileEntries = formData.getAll("textFiles") as File[];
		if (textFileEntries.length > 10) {
			throw new ValidationError("Maximum 10 text files per message");
		}
		for (const file of textFileEntries) {
			validateTextFile(file);
		}
		return { message, images, textFiles: textFileEntries };
	}
	const body = await c.req.json();
	const parsed = sendMessageSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return { message: parsed.data.message, images: [], textFiles: [] };
}

export const narratorRoutes = new Hono();

// List narrators — by chapterId, or standalone (chapterId IS NULL)
narratorRoutes.get("/", async (c) => {
	const chapterId = c.req.query("chapterId");
	const standalone = c.req.query("standalone");

	if (standalone === "true" || standalone === "all") {
		// Paginated session list
		// standalone=true: only standalone (chapterId IS NULL)
		// standalone=all: all sessions (standalone + chapter-bound)
		const status = c.req.query("status");
		const filter = c.req.query("filter"); // "standalone" | "chapter" | undefined (all)
		const rawSortBy = c.req.query("sortBy") ?? "updatedAt";
		const sortOrder = c.req.query("sortOrder") ?? "desc";
		const rawLimit = Number.parseInt(c.req.query("limit") ?? "20", 10);
		const limit = Math.min(Number.isNaN(rawLimit) ? 20 : rawLimit, 100);
		const cursorParam = c.req.query("cursor");

		// Presence-based filters
		const hasTerminals = c.req.query("hasTerminals") === "true";
		const hasContainers = c.req.query("hasContainers") === "true";
		const hasRunningContainers = c.req.query("hasRunningContainers") === "true";
		const hasViewers = c.req.query("hasViewers") === "true";

		// Build base where conditions
		const conditions = [ne(narrators.type, "subagent")];

		if (status === "archived") {
			conditions.push(eq(narrators.status, "archived"));
		} else {
			conditions.push(ne(narrators.status, "archived"));
		}

		// Filter by standalone vs chapter-bound
		if (standalone === "true" || filter === "standalone") {
			conditions.push(isNull(narrators.chapterId));
		} else if (filter === "chapter") {
			conditions.push(isNotNull(narrators.chapterId));
		}
		// standalone=all with no filter: show all

		// Filter: has active terminals
		if (hasTerminals) {
			conditions.push(
				sql`EXISTS (SELECT 1 FROM terminals WHERE terminals.narrator_id = ${narrators.id} AND terminals.status = 'running')`,
			);
		}

		// Filter: has containers (via chapter)
		if (hasContainers) {
			conditions.push(
				sql`EXISTS (SELECT 1 FROM container_instances WHERE container_instances.chapter_id = ${narrators.chapterId})`,
			);
		}

		// Filter: has running containers (via chapter)
		if (hasRunningContainers) {
			conditions.push(
				sql`EXISTS (SELECT 1 FROM container_instances WHERE container_instances.chapter_id = ${narrators.chapterId} AND container_instances.status = 'running')`,
			);
		}

		// Filter: has viewers (in-memory presence)
		if (hasViewers) {
			const viewedIds = getNarratorIdsWithPresence();
			if (viewedIds.size === 0) {
				// No narrators have viewers — return empty result
				return c.json({ items: [], hasMore: false, nextCursor: null, totalCount: 0 });
			}
			conditions.push(sql`${narrators.id} IN ${[...viewedIds]}`);
		}

		const baseWhere = and(...conditions);

		const sortColumnMap: Record<string, Column> = {
			updatedAt: narrators.updatedAt,
			createdAt: narrators.createdAt,
			title: narrators.title,
			messageCount: narrators.messageCount,
		};
		const sortBy = rawSortBy in sortColumnMap ? rawSortBy : "updatedAt";
		const column = sortColumnMap[sortBy];
		const orderFn = sortOrder === "asc" ? asc : desc;
		const cmpFn = sortOrder === "asc" ? gt : lt;

		// Decode cursor: { v: sortValue, id: narratorId }
		let cursorWhere: ReturnType<typeof and> | undefined;
		if (cursorParam) {
			try {
				const decoded = JSON.parse(Buffer.from(cursorParam, "base64url").toString());
				const cursorVal = decoded.v;
				const cursorId = decoded.id;
				cursorWhere = or(
					cmpFn(column, cursorVal),
					and(eq(column, cursorVal), cmpFn(narrators.id, cursorId)),
				);
			} catch {
				// Invalid cursor — ignore, start from beginning
			}
		}

		const whereClause = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

		const [list, countResult] = await Promise.all([
			db.query.narrators.findMany({
				where: whereClause,
				orderBy: [orderFn(column), orderFn(narrators.id)],
				limit: limit + 1,
			}),
			db.select({ count: sql<number>`count(*)` }).from(narrators).where(baseWhere),
		]);
		const totalCount = countResult[0]?.count ?? 0;

		const hasMore = list.length > limit;
		const rawItems = hasMore ? list.slice(0, limit) : list;
		const lastItem = rawItems[rawItems.length - 1];
		const nextCursor =
			hasMore && lastItem
				? Buffer.from(
						JSON.stringify({
							v: (lastItem as Record<string, unknown>)[sortBy] ?? lastItem.updatedAt,
							id: lastItem.id,
						}),
					).toString("base64url")
				: null;

		// Enrich items with chapter info, terminal counts, and viewers
		const narratorIds = rawItems.map((n) => n.id);
		const chapterIds = rawItems.map((n) => n.chapterId).filter(Boolean) as string[];

		// Batch fetch chapter info
		const chapterMap = new Map<
			string,
			{
				id: string;
				title: string;
				projectId: string;
				projectName: string | null;
				status: string;
				role: string;
			}
		>();
		if (chapterIds.length > 0) {
			const chapterRows = await db
				.select({
					id: chapters.id,
					title: chapters.title,
					projectId: chapters.projectId,
					projectName: projects.name,
					status: chapters.status,
					role: chapters.role,
				})
				.from(chapters)
				.leftJoin(projects, eq(chapters.projectId, projects.id))
				.where(sql`${chapters.id} IN ${chapterIds}`);
			for (const row of chapterRows) {
				chapterMap.set(row.id, row);
			}
		}

		// Batch fetch active terminal counts
		const terminalCounts = new Map<string, number>();
		if (narratorIds.length > 0) {
			const termRows = await db
				.select({
					narratorId: terminals.narratorId,
					count: countFn(),
				})
				.from(terminals)
				.where(and(sql`${terminals.narratorId} IN ${narratorIds}`, eq(terminals.status, "running")))
				.groupBy(terminals.narratorId);
			for (const row of termRows) {
				if (row.narratorId) terminalCounts.set(row.narratorId, row.count);
			}
		}

		// Batch fetch container counts per chapter (total + running)
		const containerCounts = new Map<string, { total: number; running: number }>();
		if (chapterIds.length > 0) {
			const containerRows = await db
				.select({
					chapterId: containerInstances.chapterId,
					total: countFn(),
					running: sql<number>`SUM(CASE WHEN ${containerInstances.status} = 'running' THEN 1 ELSE 0 END)`,
				})
				.from(containerInstances)
				.where(sql`${containerInstances.chapterId} IN ${chapterIds}`)
				.groupBy(containerInstances.chapterId);
			for (const row of containerRows) {
				containerCounts.set(row.chapterId, {
					total: row.total,
					running: row.running ?? 0,
				});
			}
		}

		// Batch fetch presence
		const presenceMap = getNarratorPresenceBatch(narratorIds);

		const items = rawItems.map((n) => ({
			...n,
			chapter: n.chapterId ? (chapterMap.get(n.chapterId) ?? null) : null,
			activeTerminalCount: terminalCounts.get(n.id) ?? 0,
			containerCount: n.chapterId ? (containerCounts.get(n.chapterId)?.total ?? 0) : 0,
			runningContainerCount: n.chapterId ? (containerCounts.get(n.chapterId)?.running ?? 0) : 0,
			viewers: presenceMap.get(n.id) ?? [],
		}));

		return c.json({ items, hasMore, nextCursor, totalCount });
	}

	if (!chapterId) throw new ValidationError("chapterId or standalone=true is required");
	const list = await narratorService.listByChapter(chapterId);
	return c.json(list);
});

// Create narrator
narratorRoutes.post("/", async (c) => {
	const body = await c.req.json();
	const parsed = createNarratorSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const narrator = await narratorService.create(parsed.data);
	return c.json(narrator, 201);
});

// Get narrator
narratorRoutes.get("/:id", async (c) => {
	const narrator = await narratorService.getById(c.req.param("id"));
	return c.json(narrator);
});

// Get available commands + skills for the slash menu
narratorRoutes.get("/:id/commands", async (c) => {
	const id = c.req.param("id");
	const userId = c.get("user").sub;
	const result = await getSlashMenuItems(id, userId);
	return c.json(result);
});

// Send message — fire-and-forget; all streaming events delivered via WebSocket
narratorRoutes.post("/:id/messages", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id); // throws NotFoundError if missing

	// Auto-unarchive on interaction
	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const { message, images, textFiles } = await parseMessageRequest(c, id);
	const userId = c.get("user").sub;

	// Resolve slash commands
	let finalMessage = message;
	let commandText: string | null = null;
	const cmdResult = await resolveCommand(message, id, userId);
	if (cmdResult.resolved && ("loadTool" in cmdResult || "loadToolNotFound" in cmdResult)) {
		const locale = await getUserLanguage(userId);
		const result = await handleLoadToolCommand(
			id,
			cmdResult as LoadToolResult | LoadToolNotFound,
			locale,
			userId,
		);
		return c.json(result, 200);
	}
	if (cmdResult.resolved && "loadSkill" in cmdResult) {
		const skillResult = await handleLoadSkillCommand(id, cmdResult as LoadSkillResult);
		if (!skillResult.found) {
			return c.json({ skillName: skillResult.skillName, loaded: false }, 200);
		}
		// Inject skill content into the message, preserving user input after the skill name
		const userInput = (cmdResult as LoadSkillResult).skillInput;
		finalMessage = `<command-name>${skillResult.skillName}</command-name>\n${skillResult.content}${userInput ? `\n\n${userInput}` : ""}`;
		commandText = cmdResult.rawCommand;
	}
	if (cmdResult.resolved && "expandedPrompt" in cmdResult) {
		finalMessage = cmdResult.expandedPrompt;
		commandText = cmdResult.rawCommand;
	}

	// Running narrator: buffer the message for execution after the current turn
	if (narrator.status === "thinking" || narrator.status === "waiting") {
		if (narrator.type === "subagent") {
			const { pushSubagentBufferedMessage, getSubagentBufferedMessages } = await import(
				"../services/narrator-subagent"
			);
			const result = pushSubagentBufferedMessage(id, finalMessage);
			if (!result.ok) {
				throw new ValidationError("Subagent is not running in foreground");
			}
			const messages = toBufferSummary(getSubagentBufferedMessages(id));
			broadcastToNarrator(id, {
				type: "buffer_set",
				narratorId: id,
				messages,
			});
			return c.json({ buffered: true, bufferedAt: result.bufferedAt, id: result.id }, 202);
		}

		// Primary narrator: push onto buffer queue
		const user = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { id: true, username: true, avatarColor: true, avatarImageId: true },
		});
		const creator: BufferCreator | null = user
			? {
					id: user.id,
					username: user.username,
					avatarColor: user.avatarColor,
					avatarImageId: user.avatarImageId,
				}
			: null;
		const result = pushBufferedMessage(
			id,
			finalMessage,
			images.length > 0 ? images : undefined,
			commandText,
			userId,
			creator,
			textFiles.length > 0 ? textFiles : undefined,
		);
		if (result.ok) {
			const messages = toBufferSummary(getBufferedMessages(id));
			broadcastToNarrator(id, {
				type: "buffer_set",
				narratorId: id,
				messages,
			});
			return c.json({ buffered: true, bufferedAt: result.bufferedAt, id: result.id }, 202);
		}
		// Narrator not active in memory — fall through to normal send
	}

	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	const userMsg = await sendMessage(
		id,
		finalMessage,
		images,
		locale,
		replyInUserLanguage,
		commandText,
		userId,
		textFiles,
	);
	return c.json(userMsg, 201);
});

// Retry last user message — re-run agent loop without creating a new message
narratorRoutes.post("/:id/retry", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);

	if (
		narrator.type === "subagent" &&
		(narrator.status === "thinking" || narrator.status === "waiting")
	) {
		throw new ValidationError("Cannot retry on a running subagent");
	}

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	const result = await retryLastMessage(id, locale, replyInUserLanguage);
	return c.json(result);
});

// Continue the agent loop — resume from trailing tool_use without a new user message
narratorRoutes.post("/:id/continue", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);

	if (narrator.status === "thinking" || narrator.status === "waiting") {
		throw new ValidationError("Cannot continue while narrator is already running");
	}

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	const result = await continueNarrator(id, locale, replyInUserLanguage);
	return c.json(result);
});

// Regenerate from a specific message — delete everything after it and re-run
narratorRoutes.post("/:id/regenerate/:messageId", async (c) => {
	const id = c.req.param("id");
	const messageId = c.req.param("messageId");
	const narrator = await narratorService.getById(id);

	if (
		narrator.type === "subagent" &&
		(narrator.status === "thinking" || narrator.status === "waiting")
	) {
		throw new ValidationError("Cannot regenerate on a running subagent");
	}

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	const result = await regenerateFromMessage(id, messageId, locale, replyInUserLanguage);
	return c.json(result);
});

// Edit a user message and regenerate the response
narratorRoutes.post("/:id/edit-and-regenerate/:messageId", async (c) => {
	const id = c.req.param("id");
	const messageId = c.req.param("messageId");
	const { content, rollback } = await c.req.json();

	if (!content || typeof content !== "string") {
		throw new ValidationError("content is required");
	}

	const narrator = await narratorService.getById(id);

	if (
		narrator.type === "subagent" &&
		(narrator.status === "thinking" || narrator.status === "waiting")
	) {
		throw new ValidationError("Cannot edit on a running subagent");
	}

	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	const result = await editAndRegenerate(
		id,
		messageId,
		content,
		locale,
		replyInUserLanguage,
		!!rollback,
	);
	return c.json(result);
});

// Get buffered message queue (for multi-device hydration on page load)
narratorRoutes.get("/:id/buffer", async (c) => {
	const id = c.req.param("id");
	let messages = toBufferSummary(getBufferedMessages(id));
	// Fallback: check subagent buffer
	if (messages.length === 0) {
		const { getSubagentBufferedMessages } = await import("../services/narrator-subagent");
		messages = toBufferSummary(getSubagentBufferedMessages(id));
	}
	return c.json(messages);
});

// Edit a queued buffered message
narratorRoutes.patch("/:id/buffer/:mid", async (c) => {
	const id = c.req.param("id");
	const mid = c.req.param("mid");
	const body = await c.req.json();
	const parsed = updateBufferedMessageSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const ok = updateBufferedMessage(id, mid, parsed.data.text.trim());
	if (!ok) throw new NotFoundError("Buffered message", mid);
	const messages = toBufferSummary(getBufferedMessages(id));
	broadcastToNarrator(id, { type: "buffer_set", narratorId: id, messages });
	return c.json({ ok: true });
});

// Remove a single queued buffered message
narratorRoutes.delete("/:id/buffer/:mid", async (c) => {
	const id = c.req.param("id");
	const mid = c.req.param("mid");
	const ok = removeBufferedMessage(id, mid);
	if (!ok) throw new NotFoundError("Buffered message", mid);
	const messages = toBufferSummary(getBufferedMessages(id));
	broadcastToNarrator(id, { type: "buffer_set", narratorId: id, messages });
	return c.json({ ok: true });
});

// Reorder queued buffered messages
narratorRoutes.put("/:id/buffer/reorder", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const parsed = reorderBufferSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const ok = reorderBufferedMessages(id, parsed.data.orderedIds);
	if (!ok) throw new ValidationError("Invalid reorder: ids do not match the current queue");
	const messages = toBufferSummary(getBufferedMessages(id));
	broadcastToNarrator(id, { type: "buffer_set", narratorId: id, messages });
	return c.json({ ok: true });
});

// Clear entire buffer queue
narratorRoutes.delete("/:id/buffer", async (c) => {
	const id = c.req.param("id");
	clearBufferedMessages(id);
	broadcastToNarrator(id, { type: "buffer_set", narratorId: id, messages: [] });
	return c.json({ ok: true });
});

// Get message history (cursor-based pagination, newest first)
narratorRoutes.get("/:id/messages", async (c) => {
	const id = c.req.param("id");
	const around = c.req.query("around") || undefined;
	if (around) {
		const parseWindowSize = (raw: string | undefined, fallback: number) => {
			const parsed = Number.parseInt(raw ?? "", 10);
			if (Number.isNaN(parsed)) return fallback;
			return Math.min(Math.max(parsed, 0), 100);
		};
		const result = await narratorService.getMessagesAround(id, around, {
			before: parseWindowSize(c.req.query("before"), 5),
			after: parseWindowSize(c.req.query("after"), 20),
		});
		return c.json(result);
	}
	const rawLimit = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const limit = Math.min(Number.isNaN(rawLimit) ? 50 : rawLimit, 200);
	const cursor = c.req.query("cursor") || undefined;
	const direction = c.req.query("direction") === "newer" ? "newer" : "older";
	const result = await narratorService.getMessagesCursor(id, limit, cursor, direction);
	const narrator = await narratorService.getById(id);
	return c.json({
		...result,
		pruneBoundaryMessageId: narrator.pruneBoundaryMessageId ?? null,
		prunedPercent: narrator.prunedPercent ?? null,
		messageVersion: narrator.messageVersion ?? 0,
	});
});

// Get full tool call detail (untruncated inputJson/outputJson)
narratorRoutes.get("/:id/tool-calls/:toolUseId", async (c) => {
	const id = c.req.param("id");
	const toolUseId = c.req.param("toolUseId");
	const tc = await narratorService.getToolCallDetail(id, toolUseId);
	return c.json(tc);
});

// Get compact summary for a specific compact message
narratorRoutes.get("/:id/compact/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const summary = await narratorService.getCompactSummary(narratorId, messageId);
	return c.json({ summary });
});

// Delete a compact message (undo compact)
narratorRoutes.delete("/:id/compact/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const result = await narratorService.deleteCompactMessage(narratorId, messageId);
	return c.json({ ok: true, ...result });
});

// Batch-delete multiple content blocks across messages
narratorRoutes.delete("/:id/messages/batch-blocks", async (c) => {
	const narratorId = c.req.param("id");
	const body = await c.req.json();
	const { batchDeleteBlocksSchema } = await import("../lib/validators");
	const { blocks } = batchDeleteBlocksSchema.parse(body);
	const result = await narratorService.deleteMessageBlocks(narratorId, blocks);
	return c.json({ ok: true, ...result });
});

// Delete a single content block from a message
narratorRoutes.delete("/:id/messages/:messageId/blocks/:blockIndex", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const blockIndex = Number.parseInt(c.req.param("blockIndex"), 10);
	if (Number.isNaN(blockIndex) || blockIndex < 0) {
		throw new ValidationError("Invalid block index");
	}
	const result = await narratorService.deleteMessageBlock(narratorId, messageId, blockIndex);
	return c.json({ ok: true, ...result });
});

// Delete a message and all subsequent messages
narratorRoutes.delete("/:id/messages/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const result = await narratorService.deleteMessage(narratorId, messageId);
	return c.json({ ok: true, ...result });
});

// Dismiss a single error system message
narratorRoutes.delete("/:id/error-messages/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	await narratorService.dismissErrorMessage(narratorId, messageId);
	return c.json({ ok: true });
});

// Update a compact message summary
narratorRoutes.patch("/:id/compact/:messageId", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.param("messageId");
	const { summary } = await c.req.json();
	if (!summary || typeof summary !== "string") throw new ValidationError("summary is required");
	await narratorService.updateCompactSummary(narratorId, messageId, summary);
	return c.json({ ok: true });
});

// Trigger manual compact
narratorRoutes.post("/:id/compact", async (c) => {
	const narratorId = c.req.param("id");
	await narratorService.getById(narratorId);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const body = await c.req.json().catch(() => ({}));
	const beforeMessageId = body.beforeMessageId ?? undefined;

	if (isCompactInProgress(narratorId)) {
		return c.json({ ok: false, reason: "compact_in_progress" }, 409);
	}

	// Fire-and-forget — compact may take a while (AI summary generation).
	// compact_done / compact_failed are broadcast from doRunCustomCompact itself.
	runCustomCompact(narratorId, locale, beforeMessageId).catch((err) => {
		logger.error("Manual compact failed", { narratorId, err: String(err) });
	});
	return c.json({ ok: true });
});

// Clear context — insert an empty compact marker so subsequent queries start fresh
narratorRoutes.post("/:id/clear-context", async (c) => {
	const narratorId = c.req.param("id");
	await narratorService.getById(narratorId);
	const msg = await narratorService.clearContext(narratorId);
	broadcastToNarrator(narratorId, { type: "message", narratorId, message: msg });
	broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
	return c.json({ ok: true });
});

// Create a plan compact message
narratorRoutes.post("/:id/plan", async (c) => {
	const narratorId = c.req.param("id");
	await narratorService.getById(narratorId);
	const { content } = await c.req.json();
	if (!content || typeof content !== "string") throw new ValidationError("content is required");
	const msg = await narratorService.persistPlanMessage(narratorId, content);
	return c.json(msg);
});

// Interrupt active session
narratorRoutes.post("/:id/interrupt", async (c) => {
	const id = c.req.param("id");
	let interrupted = interruptNarrator(id);
	if (!interrupted) {
		// Fallback: try interrupting a foreground subagent
		const { interruptForegroundSubagent } = await import("../services/narrator-subagent");
		interrupted = interruptForegroundSubagent(id);
	}
	// Fallback: if no active loop found but DB status is still thinking/waiting,
	// the narrator is a zombie (loop ended without updating status, e.g. after
	// hot reload or unhandled error). Force-reset to interrupted.
	if (!interrupted) {
		const narrator = await narratorService.getById(id);
		if (narrator.status === "thinking" || narrator.status === "waiting") {
			await narratorService.updateStatus(id, "interrupted");
			interrupted = true;
		}
	}
	return c.json({ interrupted });
});

// User left the narrator page — reset interrupted status to idle
narratorRoutes.post("/:id/leave", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	if (narrator?.status === "interrupted") {
		await narratorService.updateStatus(id, "idle");
	}
	return c.json({ ok: true });
});

// Update model
narratorRoutes.patch("/:id/model", async (c) => {
	const id = c.req.param("id");
	const parsed = updateNarratorModelSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	await narratorService.getById(id); // ensure exists
	await narratorService.updateModel(id, parsed.data.model);
	await updateNarratorModel(id, parsed.data.model);
	return c.json({ ok: true });
});

// Update permission mode
narratorRoutes.patch("/:id/permission-mode", async (c) => {
	const id = c.req.param("id");
	const { permissionMode } = await c.req.json();
	const validModes = ["default", "acceptEdits", "bypassPermissions", "readOnly", "plan", "dontAsk"];
	if (!permissionMode || !validModes.includes(permissionMode)) {
		throw new ValidationError(`permissionMode must be one of: ${validModes.join(", ")}`);
	}
	const narrator = await narratorService.getById(id);
	const currentMode = narrator.permissionMode;
	await narratorService.updatePermissionMode(id, permissionMode);
	await updateNarratorPermissionMode(id, permissionMode);

	// When switching to bypassPermissions, auto-approve all pending permission requests
	// for this narrator and its subagents so they don't stay stuck waiting.
	if (permissionMode === "bypassPermissions") {
		await resolveAllPendingPermissions(id);
	}

	// Persist synthetic tool call messages so the model sees mode transitions
	// when context is rebuilt from message history.
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);

	const isPlanLike = (m: string | null) => m === "plan";

	if (isPlanLike(permissionMode) && !isPlanLike(currentMode)) {
		// Entering plan mode — synthetic EnterPlanMode
		const toolUseId = `toolu_manual_${generateShortId()}`;
		const msg = await narratorService.persistAssistantMessage(id, {
			uuid: randomUUID(),
			session_id: randomUUID(),
			parent_tool_use_id: null,
			message: {
				content: [
					{
						type: "tool_use",
						id: toolUseId,
						name: "EnterPlanMode",
						input: { confirm: true },
					},
				],
			},
		});
		await narratorService.updateToolCallResult(toolUseId, {
			output: getToolMessage("enterPlanModeOutput", locale as Locale),
			status: "success",
		});
		const fullMsg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, msg.id),
			with: { toolCalls: true },
		});
		if (fullMsg) {
			broadcastToNarrator(id, { type: "message", narratorId: id, message: fullMsg });
		}
	} else if (isPlanLike(currentMode) && !isPlanLike(permissionMode)) {
		// Leaving plan mode — synthetic ExitPlanMode
		const toolUseId = `toolu_manual_${generateShortId()}`;
		const msg = await narratorService.persistAssistantMessage(id, {
			uuid: randomUUID(),
			session_id: randomUUID(),
			parent_tool_use_id: null,
			message: {
				content: [
					{
						type: "tool_use",
						id: toolUseId,
						name: "ExitPlanMode",
						input: {},
					},
				],
			},
		});
		await narratorService.updateToolCallResult(toolUseId, {
			output: getToolMessage("exitPlanModeOutput", locale as Locale),
			status: "success",
		});
		const fullMsg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, msg.id),
			with: { toolCalls: true },
		});
		if (fullMsg) {
			broadcastToNarrator(id, { type: "message", narratorId: id, message: fullMsg });
		}
	}

	return c.json({ ok: true });
});

// Update reasoning effort
narratorRoutes.patch("/:id/reasoning-effort", async (c) => {
	const id = c.req.param("id");
	const { reasoningEffort } = await c.req.json();
	const validEfforts = ["none", "low", "medium", "high", "xhigh"];
	if (
		reasoningEffort !== null &&
		reasoningEffort !== undefined &&
		!validEfforts.includes(reasoningEffort)
	) {
		throw new ValidationError(`reasoningEffort must be one of: ${validEfforts.join(", ")} or null`);
	}
	await narratorService.getById(id); // ensure exists
	await narratorService.updateReasoningEffort(id, reasoningEffort);
	return c.json({ ok: true });
});

// Update fast mode
narratorRoutes.patch("/:id/fast-mode", async (c) => {
	const id = c.req.param("id");
	const { fastMode } = await c.req.json();
	if (typeof fastMode !== "boolean") {
		throw new ValidationError("fastMode must be a boolean");
	}
	await narratorService.getById(id); // ensure exists
	await narratorService.updateFastMode(id, fastMode);
	return c.json({ ok: true });
});

// Update relaxed plan toggle
narratorRoutes.patch("/:id/relaxed-plan", async (c) => {
	const id = c.req.param("id");
	const { relaxedPlan } = await c.req.json();
	if (typeof relaxedPlan !== "boolean") {
		throw new ValidationError("relaxedPlan must be a boolean");
	}
	await narratorService.getById(id); // ensure exists
	await narratorService.updateRelaxedPlan(id, relaxedPlan);
	broadcastToNarrator(id, { type: "relaxed_plan_changed", narratorId: id, relaxedPlan });
	return c.json({ ok: true });
});

// Update prune enabled
narratorRoutes.patch("/:id/prune-enabled", async (c) => {
	const id = c.req.param("id");
	const { pruneEnabled } = await c.req.json();
	if (typeof pruneEnabled !== "boolean") {
		throw new ValidationError("pruneEnabled must be a boolean");
	}
	await narratorService.getById(id);
	await narratorService.updatePruneEnabled(id, pruneEnabled);
	return c.json({ ok: true });
});

// Update narrator title
narratorRoutes.patch("/:id/title", async (c) => {
	const id = c.req.param("id");
	const parsed = updateNarratorTitleSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	await narratorService.getById(id);
	await persistTitle(id, parsed.data.title);
	return c.json({ ok: true, title: parsed.data.title });
});

// Regenerate narrator title via AI
narratorRoutes.post("/:id/generate-title", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const title = await generateTitle(id, locale);
	await persistTitle(id, title);
	return c.json({ title });
});

// Archive narrator
narratorRoutes.patch("/:id/archive", async (c) => {
	const id = c.req.param("id");
	if (isNarratorActive(id)) closeNarrator(id);
	await narratorService.getById(id);
	await narratorService.updateStatus(id, "archived");
	return c.json({ ok: true });
});

// Unarchive narrator
narratorRoutes.patch("/:id/unarchive", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	await narratorService.updateStatus(id, "idle");
	return c.json({ ok: true });
});

// Delete narrator (must be archived)
narratorRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	if (narrator.status !== "archived") {
		throw new ValidationError("Only archived narrators can be deleted");
	}
	if (isNarratorActive(id)) closeNarrator(id);
	await narratorService.remove(id);
	return c.json({ ok: true });
});

// Mark narrator as read (done → idle)
// Error sessions are preserved because only status=done can transition.
// Subagents are skipped — their done/error status must be preserved for ContinueTask.
narratorRoutes.patch("/:id/mark-read", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	if (narrator.type === "subagent") return c.json({ ok: true });
	if (narrator.status === "done" && !narrator.errorMessage) {
		// Atomic CAS: only transition done→idle if status is still "done".
		// Avoids clobbering a "thinking" state set by a concurrent sendMessage.
		await narratorService.compareAndSetStatus(id, "done", "idle");
	}
	return c.json({ ok: true });
});

// Fork: create a new standalone narrator containing only the specified messages
narratorRoutes.post("/:id/fork-messages", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const { forkFromMessagesSchema } = await import("../lib/validators");
	const parsed = forkFromMessagesSchema.parse(body);
	const newNarrator = await narratorService.forkFromMessages(id, parsed.messageIds, {
		title: parsed.title,
	});
	return c.json(newNarrator, 201);
});

// Fork standalone narrator (chapter-bound narrators must fork via chapter fork)
narratorRoutes.post("/:id/fork", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const parsed = forkNarratorSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const newNarrator = await narratorService.forkNarrator(id, parsed.data.forkMessageUuid, {
		title: parsed.data.title,
		inheritMode: parsed.data.inheritMode ?? "full",
	});
	return c.json(newNarrator, 201);
});

// Get pending permissions
narratorRoutes.get("/:id/permissions", async (c) => {
	const id = c.req.param("id");
	const permissions = await narratorService.getPendingPermissions(id);
	return c.json(permissions);
});

// Approve permission
narratorRoutes.post("/permissions/:requestId/approve", async (c) => {
	const requestId = c.req.param("requestId");
	const userId = c.get("user").sub;
	await resolvePermission(requestId, "allow", { userId });
	return c.json({ ok: true });
});

// Deny permission
narratorRoutes.post("/permissions/:requestId/deny", async (c) => {
	const requestId = c.req.param("requestId");
	const body = await c.req.json().catch(() => ({}));
	const parsed = permissionDecisionSchema.safeParse({ decision: "deny", ...body });
	await resolvePermission(requestId, "deny", {
		denyMessage: parsed.success ? parsed.data.message : undefined,
	});
	return c.json({ ok: true });
});

// Suggest best-practice answers for AskUserQuestion
narratorRoutes.post("/:id/suggest-answers", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	const userId = c.get("user").sub;
	const locale = (await getUserLanguage(userId)) as Locale;

	const body = await c.req.json();
	const parsed = suggestAnswersSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { questions } = parsed.data;

	// Load full conversation context (since last compact)
	const dbMessages = await narratorService.getMessagesSinceLastCompact(id);
	const conversationLines: string[] = [];
	for (const m of dbMessages) {
		if (m.parentToolUseId) continue; // skip sub-messages
		const role = m.role === "assistant" ? "Assistant" : m.role === "user" ? "User" : "System";
		const text = m.contentText ?? "";
		if (!text.trim()) continue;
		conversationLines.push(`[${role}]: ${text}`);
	}
	const conversationContext = conversationLines.join("\n\n");

	const systemPrompt = getToolMessage("suggestAnswerSystem", locale);

	// Build a concise description of each question for the LLM
	const questionsText = questions
		.map((q) => {
			const opts = q.options.length
				? `\nOptions: ${q.options.map((o) => `${o.label} — ${o.description}`).join("; ")}`
				: "\n(free-text, no predefined options)";
			return `Key: "${q.question}"\nQuestion: ${q.header}${opts}`;
		})
		.join("\n\n");

	const userMessage = conversationContext
		? `<conversation>\n${conversationContext}\n</conversation>\n\n<questions>\n${questionsText}\n</questions>`
		: questionsText;

	const raw = await agentGenerateWithHistory(
		systemPrompt,
		userMessage,
		narrator.model ?? undefined,
		locale,
	);

	// Parse JSON from the response (strip markdown fences if present)
	let answers: Record<string, string> = {};
	try {
		const cleaned = raw
			.replace(/```(?:json)?\s*/g, "")
			.replace(/```\s*/g, "")
			.trim();
		answers = JSON.parse(cleaned);
	} catch {
		// If parsing fails, try to use the raw text as a single answer
		if (questions.length === 1) {
			answers = { [questions[0].question]: raw.trim() };
		}
	}

	return c.json({ answers });
});

// === Snapshot / Patch routes ===

/** List file snapshots for a narrator */
narratorRoutes.get("/:id/patches", async (c) => {
	const narratorId = c.req.param("id");

	const snapshots = await db.query.narratorFileSnapshots.findMany({
		where: eq(narratorFileSnapshots.narratorId, narratorId),
		orderBy: asc(narratorFileSnapshots.createdAt),
	});

	return c.json(snapshots);
});

/** Get the diff for a specific file snapshot (original vs current rebuilt state) */
narratorRoutes.get("/:id/patches/:patchId/diff", async (c) => {
	const narratorId = c.req.param("id");
	const patchId = c.req.param("patchId");
	const upToMessageId = c.req.query("upToMessageId");
	const fromMessageId = c.req.query("fromMessageId");

	const snap = await db.query.narratorFileSnapshots.findFirst({
		where: and(
			eq(narratorFileSnapshots.id, patchId),
			eq(narratorFileSnapshots.narratorId, narratorId),
		),
	});
	if (!snap) return c.json({ error: "Snapshot not found" }, 404);

	// Resolve "from" boundary: file state at fromMessageId (used as the diff base)
	let originalContent: string | null;
	if (fromMessageId) {
		const fromRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, fromMessageId),
			),
			columns: { seq: true },
		});
		if (fromRef) {
			const states = await rebuildFileStatesUpToSeq(narratorId, fromRef.seq);
			originalContent = states.get(snap.filePath) ?? snap.originalContent;
		} else {
			return c.json({ error: "fromMessageId not found in this narrator" }, 404);
		}
	} else {
		originalContent = snap.originalContent;
	}

	// Resolve "to" boundary: file state at upToMessageId (or current)
	let currentContent: string | null;
	if (upToMessageId) {
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, upToMessageId),
			),
			columns: { seq: true },
		});
		if (ref) {
			const states = await rebuildFileStatesUpToSeq(narratorId, ref.seq);
			currentContent = states.get(snap.filePath) ?? snap.originalContent;
		} else {
			return c.json({ error: "Message not found in this narrator" }, 404);
		}
	} else {
		currentContent = await rebuildFileState(narratorId, snap.filePath);
	}

	return c.json({
		filePath: snap.filePath,
		original: originalContent,
		current: currentContent,
	});
});

/** Revert file changes from a specific message onwards */
narratorRoutes.post("/:id/revert", async (c) => {
	const narratorId = c.req.param("id");
	const body = await c.req.json<{ messageId: string }>();
	if (!body.messageId) return c.json({ error: "messageId is required" }, 400);

	// Prevent revert while narrator is actively running
	if (isNarratorActive(narratorId)) {
		return c.json({ error: "Cannot revert while narrator is running" }, 409);
	}

	const cwd = await resolveNarratorCwd(narratorId);
	if (!cwd) return c.json({ error: "Narrator has no working directory" }, 400);

	// Find the target message's ref to get its seq
	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, body.messageId),
		),
		columns: { seq: true },
	});
	if (!targetRef) return c.json({ error: "Message not found" }, 404);

	// Find all tool calls at or after the target message
	const toolCallsToRevert = await db
		.select({
			toolUseId: narratorToolCalls.toolUseId,
			toolName: narratorToolCalls.toolName,
			inputJson: narratorToolCalls.inputJson,
		})
		.from(narratorToolCalls)
		.innerJoin(
			narratorMessageRefs,
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
			),
		)
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.status, "success"),
				gte(narratorMessageRefs.seq, targetRef.seq),
			),
		);

	const affectedFiles = getAffectedFiles(toolCallsToRevert);
	if (affectedFiles.length === 0) {
		return c.json({ fileCount: 0, files: [] });
	}

	const excludeIds = new Set(toolCallsToRevert.map((tc) => tc.toolUseId));

	try {
		// Re-check right before mutation
		if (isNarratorActive(narratorId)) {
			return c.json({ error: "Narrator became active during revert" }, 409);
		}

		const fileStates = await rebuildFileStatesExcluding(narratorId, affectedFiles, excludeIds);

		// Write files to disk
		const writtenFiles: string[] = [];

		for (const [filePath, content] of fileStates) {
			const absPath = resolve(cwd, filePath);
			try {
				if (content === null) {
					const file = Bun.file(absPath);
					if (await file.exists()) unlinkSync(absPath);
				} else {
					mkdirSync(dirname(absPath), { recursive: true });
					await Bun.write(absPath, content);
				}
				writtenFiles.push(filePath);
			} catch (err) {
				logger.warn("Failed to write reverted file", { filePath, error: String(err) });
			}
		}

		return c.json({ fileCount: writtenFiles.length, files: writtenFiles });
	} catch (err) {
		return c.json(
			{ error: `Revert failed: ${err instanceof Error ? err.message : String(err)}` },
			500,
		);
	}
});

/** Unrevert — rebuild current (full) file state and write to disk */
narratorRoutes.post("/:id/unrevert", async (c) => {
	const narratorId = c.req.param("id");

	if (isNarratorActive(narratorId)) {
		return c.json({ error: "Cannot unrevert while narrator is running" }, 409);
	}

	const cwd = await resolveNarratorCwd(narratorId);
	if (!cwd) return c.json({ error: "Narrator has no working directory" }, 400);

	try {
		if (isNarratorActive(narratorId)) {
			return c.json({ error: "Narrator became active during unrevert" }, 409);
		}

		// Rebuild full file state (all tool calls included)
		const fileStates = await rebuildFileStatesUpToSeq(narratorId, Number.MAX_SAFE_INTEGER);

		for (const [filePath, content] of fileStates) {
			if (content === null) continue;
			const absPath = resolve(cwd, filePath);
			mkdirSync(dirname(absPath), { recursive: true });
			await Bun.write(absPath, content);
		}

		return c.json({ success: true });
	} catch (err) {
		return c.json(
			{ error: `Restore failed: ${err instanceof Error ? err.message : String(err)}` },
			500,
		);
	}
});

/** Get aggregated file modification summary for a narrator */
narratorRoutes.get("/:id/file-modifications", async (c) => {
	const narratorId = c.req.param("id");
	const upToMessageId = c.req.query("upToMessageId");
	const fromMessageId = c.req.query("fromMessageId");

	const snapshots = await db.query.narratorFileSnapshots.findMany({
		where: eq(narratorFileSnapshots.narratorId, narratorId),
		orderBy: asc(narratorFileSnapshots.createdAt),
	});
	if (snapshots.length === 0) return c.json({ files: [], timeline: [] });

	// Always query all tool calls first to build the timeline
	const allToolCalls = await queryOrderedToolCalls(narratorId);

	// Build timeline from all top-level messages (user + assistant + system)
	// so the frontend can use any message as a range boundary.
	const allRefs = await db
		.select({
			messageId: narratorMessageRefs.messageId,
			seq: narratorMessageRefs.seq,
			role: narratorMessages.role,
			createdAt: narratorMessages.createdAt,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(
			and(eq(narratorMessageRefs.narratorId, narratorId), isNull(narratorMessages.parentToolUseId)),
		)
		.orderBy(asc(narratorMessageRefs.seq));

	const timeline: Array<{
		messageId: string;
		createdAt: string;
		seq: number;
		role: string;
		hasEdits: boolean;
	}> = [];
	// Pre-compute which messageIds have file edits
	const editMessageIds = new Set(allToolCalls.map((tc) => tc.messageId));
	for (const ref of allRefs) {
		timeline.push({
			messageId: ref.messageId,
			createdAt: ref.createdAt,
			seq: ref.seq,
			role: ref.role,
			hasEdits: editMessageIds.has(ref.messageId),
		});
	}

	// Resolve seq boundaries for range filtering
	let fromSeq: number | undefined;
	let toSeq: number | undefined;
	if (fromMessageId) {
		const entry = timeline.find((t) => t.messageId === fromMessageId);
		if (entry) fromSeq = entry.seq;
	}
	if (upToMessageId) {
		const entry = timeline.find((t) => t.messageId === upToMessageId);
		if (entry) toSeq = entry.seq;
	}

	// Filter tool calls to the [fromSeq, toSeq] range
	const isRangeFiltered = fromSeq !== undefined || toSeq !== undefined;
	const filteredToolCalls = allToolCalls.filter((tc) => {
		if (fromSeq !== undefined && tc.seq <= fromSeq) return false;
		if (toSeq !== undefined && tc.seq > toSeq) return false;
		return true;
	});

	const grouped = groupByFile(filteredToolCalls);

	const files = snapshots
		.map((snap) => {
			const ops = grouped.get(snap.filePath) ?? [];
			if (isRangeFiltered && ops.length === 0) return null; // hide files with no ops in filtered mode
			return {
				filePath: snap.filePath,
				snapshotId: snap.id,
				originalExists: snap.originalContent !== null,
				editCount: ops.length,
				lastModifiedAt: ops.length > 0 ? ops[ops.length - 1].createdAt : snap.createdAt,
				operations: ops.map((op) => ({
					toolUseId: op.toolUseId,
					toolName: op.toolName,
					messageId: op.messageId,
					createdAt: op.createdAt,
				})),
			};
		})
		.filter(Boolean);

	return c.json({ files, timeline });
});

/** Revert a single file to its original state (before narrator touched it) */
narratorRoutes.post("/:id/revert-file", async (c) => {
	const narratorId = c.req.param("id");
	const body = await c.req.json<{ filePath: string }>();
	if (!body.filePath) return c.json({ error: "filePath is required" }, 400);

	if (isNarratorActive(narratorId)) {
		return c.json({ error: "Cannot revert while narrator is running" }, 409);
	}

	const cwd = await resolveNarratorCwd(narratorId);
	if (!cwd) return c.json({ error: "Narrator has no working directory" }, 400);

	const snap = await db.query.narratorFileSnapshots.findFirst({
		where: and(
			eq(narratorFileSnapshots.narratorId, narratorId),
			eq(narratorFileSnapshots.filePath, body.filePath),
		),
		columns: { originalContent: true },
	});
	if (!snap) return c.json({ error: "No snapshot found for this file" }, 404);

	try {
		if (isNarratorActive(narratorId)) {
			return c.json({ error: "Narrator became active during revert" }, 409);
		}

		const absPath = resolve(cwd, body.filePath);
		if (snap.originalContent === null) {
			// File didn't exist before — delete it
			const file = Bun.file(absPath);
			if (await file.exists()) unlinkSync(absPath);
		} else {
			mkdirSync(dirname(absPath), { recursive: true });
			await Bun.write(absPath, snap.originalContent);
		}

		return c.json({ success: true, originalExists: snap.originalContent !== null });
	} catch (err) {
		return c.json(
			{ error: `Revert failed: ${err instanceof Error ? err.message : String(err)}` },
			500,
		);
	}
});

/** Preview file changes that would be reverted if a message is deleted */
narratorRoutes.get("/:id/delete-preview", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.query("messageId");
	if (!messageId) return c.json({ error: "messageId query param is required" }, 400);

	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
		columns: { seq: true },
	});
	if (!targetRef) return c.json({ error: "Message not found" }, 404);

	// Find all tool calls at or after the target message
	const toolCallsToRevert = await db
		.select({
			toolUseId: narratorToolCalls.toolUseId,
			toolName: narratorToolCalls.toolName,
			inputJson: narratorToolCalls.inputJson,
		})
		.from(narratorToolCalls)
		.innerJoin(
			narratorMessageRefs,
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
			),
		)
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.status, "success"),
				gte(narratorMessageRefs.seq, targetRef.seq),
			),
		);

	const affectedFilePaths = getAffectedFiles(toolCallsToRevert);
	if (affectedFilePaths.length === 0) {
		return c.json({ affectedFiles: [], toolCallCount: 0 });
	}

	const excludeIds = new Set(toolCallsToRevert.map((tc) => tc.toolUseId));

	// Current state (all tool calls applied)
	const currentStates = await rebuildFileStatesUpToSeq(narratorId, Number.MAX_SAFE_INTEGER);
	// State after revert (excluding deleted tool calls)
	const revertedStates = await rebuildFileStatesExcluding(
		narratorId,
		affectedFilePaths,
		excludeIds,
	);

	const affectedFiles = affectedFilePaths.map((filePath) => ({
		filePath,
		currentContent: currentStates.get(filePath) ?? null,
		revertedContent: revertedStates.get(filePath) ?? null,
		willBeDeleted: revertedStates.get(filePath) === null,
	}));

	return c.json({ affectedFiles, toolCallCount: toolCallsToRevert.length });
});

/** Preview file state for a pending Write/Edit permission request */
narratorRoutes.get("/:id/permission-file-preview", async (c) => {
	const narratorId = c.req.param("id");
	const toolUseId = c.req.query("toolUseId");
	if (!toolUseId) return c.json({ error: "toolUseId query param is required" }, 400);

	const toolCall = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			eq(narratorToolCalls.toolUseId, toolUseId),
		),
		columns: { toolName: true, inputJson: true },
	});
	if (!toolCall) return c.json({ error: "Tool call not found" }, 404);

	const input = toolCall.inputJson as Record<string, unknown> | null;
	const filePath = (input?.file_path as string) ?? null;
	if (!filePath) return c.json({ error: "Tool call has no file_path" }, 400);

	// Rebuild current file state (before this tool call is applied)
	const currentContent = await rebuildFileState(narratorId, filePath);

	// Simulate applying this tool call to get preview
	const fakeOrdered = {
		toolUseId,
		toolName: toolCall.toolName,
		inputJson: toolCall.inputJson,
		status: "success",
		messageId: "",
		seq: 0,
		createdAt: "",
	};
	const previewContent = applyToolCall(currentContent, fakeOrdered);

	return c.json({
		filePath,
		currentContent,
		previewContent,
		toolName: toolCall.toolName,
		inputJson: toolCall.inputJson,
	});
});

// === Background task routes ===

/**
 * GET /api/narrators/:id/background-tasks
 * List all background tasks spawned by this narrator.
 */
narratorRoutes.get("/:id/background-tasks", async (c) => {
	const parentNarratorId = c.req.param("id");
	const tasks = await db
		.select({
			id: narrators.id,
			subagentType: narrators.subagentType,
			backgroundStatus: narrators.backgroundStatus,
			backgroundResult: narrators.backgroundResult,
			backgroundCompletedAt: narrators.backgroundCompletedAt,
			status: narrators.status,
			createdAt: narrators.createdAt,
			title: narrators.title,
		})
		.from(narrators)
		.where(and(eq(narrators.parentNarratorId, parentNarratorId), eq(narrators.isBackground, true)))
		.orderBy(desc(narrators.createdAt));

	return c.json(tasks);
});

/**
 * POST /api/narrators/:id/background-tasks/:taskId/cancel
 * Cancel a running background task.
 */
narratorRoutes.post("/:id/background-tasks/:taskId/cancel", async (c) => {
	const taskId = c.req.param("taskId");

	const { cancelBackgroundTask } = await import("../services/narrator-subagent");
	const cancelled = await cancelBackgroundTask(taskId);

	if (!cancelled) {
		return c.json({ error: "Task is not running or does not exist" }, 404);
	}

	return c.json({ success: true });
});

// ── Whitelist directories ──────────────────────────────────

narratorRoutes.get("/:id/whitelist-dirs", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id); // ensure exists
	const dirs = await db.query.narratorWhitelistDirs.findMany({
		where: eq(narratorWhitelistDirs.narratorId, id),
		orderBy: asc(narratorWhitelistDirs.createdAt),
	});
	return c.json(dirs);
});

narratorRoutes.post("/:id/whitelist-dirs", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const body = await c.req.json();
	const parsed = createWhitelistDirSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	if (!isAbsolute(parsed.data.path)) {
		throw new ValidationError("Whitelist directory path must be absolute");
	}
	const normalizedPath = resolvePath(parsed.data.path);
	// Deduplicate: check if this narrator already has a whitelist entry for the same path
	// (handles Windows case-insensitive paths via pathsEqual)
	const existing = await db.query.narratorWhitelistDirs.findMany({
		where: eq(narratorWhitelistDirs.narratorId, id),
		columns: { id: true, path: true },
	});
	if (existing.some((e) => pathsEqual(e.path, normalizedPath))) {
		throw new ValidationError("This directory is already in the whitelist");
	}
	const now = new Date().toISOString();
	const dir = {
		id: generateId(),
		narratorId: id,
		path: normalizedPath,
		accessLevel: parsed.data.accessLevel,
		enabled: parsed.data.enabled,
		createdAt: now,
	};
	await db.insert(narratorWhitelistDirs).values(dir);
	return c.json(dir, 201);
});

narratorRoutes.patch("/whitelist-dirs/:dirId", async (c) => {
	const dirId = c.req.param("dirId");
	const body = await c.req.json();
	const parsed = updateWhitelistDirSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const updates: Record<string, unknown> = {};
	if (parsed.data.accessLevel !== undefined) updates.accessLevel = parsed.data.accessLevel;
	if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
	if (Object.keys(updates).length === 0) throw new ValidationError("No fields to update");
	await db.update(narratorWhitelistDirs).set(updates).where(eq(narratorWhitelistDirs.id, dirId));
	return c.json({ ok: true });
});

narratorRoutes.delete("/whitelist-dirs/:dirId", async (c) => {
	const dirId = c.req.param("dirId");
	await db.delete(narratorWhitelistDirs).where(eq(narratorWhitelistDirs.id, dirId));
	return c.json({ ok: true });
});

// ── Blacklist directories ──────────────────────────────────

narratorRoutes.get("/:id/blacklist-dirs", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id); // ensure exists
	const dirs = await db.query.narratorBlacklistDirs.findMany({
		where: eq(narratorBlacklistDirs.narratorId, id),
		orderBy: asc(narratorBlacklistDirs.createdAt),
	});
	return c.json(dirs);
});

narratorRoutes.post("/:id/blacklist-dirs", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const body = await c.req.json();
	const parsed = createBlacklistDirSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	if (!isAbsolute(parsed.data.path)) {
		throw new ValidationError("Blacklist directory path must be absolute");
	}
	const normalizedPath = resolvePath(parsed.data.path);
	const existing = await db.query.narratorBlacklistDirs.findMany({
		where: eq(narratorBlacklistDirs.narratorId, id),
		columns: { id: true, path: true },
	});
	if (existing.some((e) => pathsEqual(e.path, normalizedPath))) {
		throw new ValidationError("This directory is already in the blacklist");
	}
	const now = new Date().toISOString();
	const dir = {
		id: generateId(),
		narratorId: id,
		path: normalizedPath,
		denyLevel: parsed.data.denyLevel,
		enabled: parsed.data.enabled,
		createdAt: now,
	};
	await db.insert(narratorBlacklistDirs).values(dir);
	return c.json(dir, 201);
});

narratorRoutes.patch("/blacklist-dirs/:dirId", async (c) => {
	const dirId = c.req.param("dirId");
	const body = await c.req.json();
	const parsed = updateBlacklistDirSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const updates: Record<string, unknown> = {};
	if (parsed.data.denyLevel !== undefined) updates.denyLevel = parsed.data.denyLevel;
	if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
	if (Object.keys(updates).length === 0) throw new ValidationError("No fields to update");
	await db.update(narratorBlacklistDirs).set(updates).where(eq(narratorBlacklistDirs.id, dirId));
	return c.json({ ok: true });
});

narratorRoutes.delete("/blacklist-dirs/:dirId", async (c) => {
	const dirId = c.req.param("dirId");
	await db.delete(narratorBlacklistDirs).where(eq(narratorBlacklistDirs.id, dirId));
	return c.json({ ok: true });
});

// ── Command whitelist ──────────────────────────────────────

narratorRoutes.get("/:id/cmd-whitelist", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const cmds = await db.query.narratorWhitelistCmds.findMany({
		where: eq(narratorWhitelistCmds.narratorId, id),
		orderBy: asc(narratorWhitelistCmds.createdAt),
	});
	return c.json(cmds);
});

narratorRoutes.post("/:id/cmd-whitelist", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const body = await c.req.json();
	const parsed = createWhitelistCmdSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const existing = await db.query.narratorWhitelistCmds.findMany({
		where: eq(narratorWhitelistCmds.narratorId, id),
		columns: { id: true, pattern: true },
	});
	if (existing.some((e) => e.pattern === parsed.data.pattern)) {
		throw new ValidationError("This pattern is already in the command whitelist");
	}
	const entry = {
		id: generateId(),
		narratorId: id,
		pattern: parsed.data.pattern,
		enabled: parsed.data.enabled,
		createdAt: new Date().toISOString(),
	};
	await db.insert(narratorWhitelistCmds).values(entry);
	return c.json(entry, 201);
});

narratorRoutes.patch("/cmd-whitelist/:entryId", async (c) => {
	const entryId = c.req.param("entryId");
	const body = await c.req.json();
	const parsed = updateWhitelistCmdSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const updates: Record<string, unknown> = {};
	if (parsed.data.pattern !== undefined) updates.pattern = parsed.data.pattern;
	if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
	if (Object.keys(updates).length === 0) throw new ValidationError("No fields to update");
	await db.update(narratorWhitelistCmds).set(updates).where(eq(narratorWhitelistCmds.id, entryId));
	return c.json({ ok: true });
});

narratorRoutes.delete("/cmd-whitelist/:entryId", async (c) => {
	const entryId = c.req.param("entryId");
	await db.delete(narratorWhitelistCmds).where(eq(narratorWhitelistCmds.id, entryId));
	return c.json({ ok: true });
});

// ── Command blacklist ──────────────────────────────────────

narratorRoutes.get("/:id/cmd-blacklist", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const cmds = await db.query.narratorBlacklistCmds.findMany({
		where: eq(narratorBlacklistCmds.narratorId, id),
		orderBy: asc(narratorBlacklistCmds.createdAt),
	});
	return c.json(cmds);
});

narratorRoutes.post("/:id/cmd-blacklist", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const body = await c.req.json();
	const parsed = createBlacklistCmdSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const existing = await db.query.narratorBlacklistCmds.findMany({
		where: eq(narratorBlacklistCmds.narratorId, id),
		columns: { id: true, pattern: true },
	});
	if (existing.some((e) => e.pattern === parsed.data.pattern)) {
		throw new ValidationError("This pattern is already in the command blacklist");
	}
	const entry = {
		id: generateId(),
		narratorId: id,
		pattern: parsed.data.pattern,
		denyPrompt: parsed.data.denyPrompt ?? null,
		enabled: parsed.data.enabled,
		createdAt: new Date().toISOString(),
	};
	await db.insert(narratorBlacklistCmds).values(entry);
	return c.json(entry, 201);
});

narratorRoutes.patch("/cmd-blacklist/:entryId", async (c) => {
	const entryId = c.req.param("entryId");
	const body = await c.req.json();
	const parsed = updateBlacklistCmdSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const updates: Record<string, unknown> = {};
	if (parsed.data.pattern !== undefined) updates.pattern = parsed.data.pattern;
	if (parsed.data.denyPrompt !== undefined) updates.denyPrompt = parsed.data.denyPrompt;
	if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
	if (Object.keys(updates).length === 0) throw new ValidationError("No fields to update");
	await db.update(narratorBlacklistCmds).set(updates).where(eq(narratorBlacklistCmds.id, entryId));
	return c.json({ ok: true });
});

narratorRoutes.delete("/cmd-blacklist/:entryId", async (c) => {
	const entryId = c.req.param("entryId");
	await db.delete(narratorBlacklistCmds).where(eq(narratorBlacklistCmds.id, entryId));
	return c.json({ ok: true });
});
