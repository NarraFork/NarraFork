import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
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
	narratorMessages,
	narratorPatches,
	narrators,
	narratorWhitelistDirs,
	projects,
	terminals,
} from "../db/schema";
import { agentGenerateWithHistory } from "../lib/agent";
import { ValidationError } from "../lib/errors";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { resolvePath } from "../lib/platform-path";
import {
	getToolMessage,
	getUserLanguage,
	getUserReplyInLanguage,
	type Locale,
} from "../lib/prompt-i18n";
import { type ImageRef, saveUploadedImage } from "../lib/uploads";
import {
	createNarratorSchema,
	createWhitelistDirSchema,
	forkNarratorSchema,
	permissionDecisionSchema,
	sendMessageSchema,
	suggestAnswersSchema,
	updateNarratorModelSchema,
	updateNarratorTitleSchema,
	updateWhitelistDirSchema,
} from "../lib/validators";
import { getSlashMenuItems, resolveCommand } from "../services/command-service";
import { narratorService } from "../services/narrator-service";
import {
	closeNarrator,
	getBufferedMessage,
	interruptNarrator,
	isNarratorActive,
	resolvePermission,
	retryLastMessage,
	runCustomCompact,
	sendMessage,
	updateNarratorModel,
	updateNarratorPermissionMode,
} from "../services/narrator-session";
import { generateTitle } from "../services/narrator-title";
import { snapshot } from "../services/snapshot";
import {
	broadcastToNarrator,
	getNarratorIdsWithPresence,
	getNarratorPresenceBatch,
} from "../websocket/narrator-ws";

/** Parse message request supporting both JSON and multipart/form-data (with images) */
export async function parseMessageRequest(
	c: {
		req: {
			header: (name: string) => string | undefined;
			formData: () => Promise<FormData>;
			json: () => Promise<unknown>;
		};
	},
	narratorId: string,
): Promise<{ message: string; images: ImageRef[] }> {
	const contentType = c.req.header("content-type") ?? "";
	if (contentType.includes("multipart/form-data")) {
		const formData = await c.req.formData();
		const message = formData.get("message") as string;
		if (!message?.trim()) throw new ValidationError("message is required");
		const files = formData.getAll("images") as File[];
		if (files.length > 10) {
			throw new ValidationError("Maximum 10 images per message");
		}
		const images: ImageRef[] = [];
		for (const file of files) {
			images.push(await saveUploadedImage(narratorId, file));
		}
		return { message, images };
	}
	const body = await c.req.json();
	const parsed = sendMessageSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return { message: parsed.data.message, images: [] };
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

	// Running subagent: buffer the message for injection into the agent loop
	if (
		narrator.type === "subagent" &&
		(narrator.status === "thinking" || narrator.status === "waiting")
	) {
		const { message } = await parseMessageRequest(c, id);
		const userId = c.get("user").sub;
		// Resolve slash commands before buffering
		let bufferText = message;
		const cmdResult = await resolveCommand(message, id, userId);
		if (cmdResult.resolved) {
			bufferText = cmdResult.expandedPrompt;
		}
		const { bufferSubagentMessage } = await import("../services/narrator-subagent");
		const result = bufferSubagentMessage(id, bufferText);
		if (!result.ok) {
			throw new ValidationError("Subagent is not running in foreground");
		}
		// Broadcast buffer_set so the frontend shows the queued state
		broadcastToNarrator(id, {
			type: "buffer_set",
			narratorId: id,
			text: message,
			bufferedAt: result.bufferedAt,
		});
		return c.json({ buffered: true, bufferedAt: result.bufferedAt }, 202);
	}

	// Auto-unarchive on interaction
	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const { message, images } = await parseMessageRequest(c, id);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	// Resolve slash commands before sending
	let finalMessage = message;
	let commandText: string | null = null;
	const cmdResult = await resolveCommand(message, id, userId);
	if (cmdResult.resolved) {
		finalMessage = cmdResult.expandedPrompt;
		commandText = cmdResult.rawCommand;
	}

	const userMsg = await sendMessage(
		id,
		finalMessage,
		images,
		locale,
		replyInUserLanguage,
		commandText,
		userId,
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

// Get buffered message (for multi-device hydration on page load)
narratorRoutes.get("/:id/buffer", async (c) => {
	const id = c.req.param("id");
	let buffered = getBufferedMessage(id);
	// Fallback: check subagent buffer
	if (!buffered) {
		const { getSubagentBufferedMessage } = await import("../services/narrator-subagent");
		buffered = getSubagentBufferedMessage(id);
	}
	return c.json(buffered ? { text: buffered.text, bufferedAt: buffered.bufferedAt } : null);
});

// Get message history (cursor-based pagination, newest first)
narratorRoutes.get("/:id/messages", async (c) => {
	const id = c.req.param("id");
	const around = c.req.query("around") || undefined;
	if (around) {
		const result = await narratorService.getMessagesAround(id, around);
		return c.json(result);
	}
	const rawLimit = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const limit = Math.min(Number.isNaN(rawLimit) ? 50 : rawLimit, 200);
	const cursor = c.req.query("cursor") || undefined;
	const result = await narratorService.getMessagesCursor(id, limit, cursor);
	const narrator = await narratorService.getById(id);
	return c.json({
		...result,
		pruneBoundaryMessageId: narrator.pruneBoundaryMessageId ?? null,
		prunedPercent: narrator.prunedPercent ?? null,
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
	// Fire-and-forget — compact may take a while (AI summary generation).
	// On failure, runCustomCompact keeps a failed compact marker, marks narrator error,
	// and broadcasts a compact_failed event via WebSocket so the frontend can react.
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
	return c.json({ interrupted });
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

	// Persist synthetic tool call messages so the model sees mode transitions
	// when context is rebuilt from message history.
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);

	if (permissionMode === "plan" && currentMode !== "plan") {
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
						input: {},
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
	} else if (currentMode === "plan" && permissionMode !== "plan") {
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
	const validEfforts = ["low", "medium", "high", "xhigh"];
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
	await narratorService.updateTitle(id, parsed.data.title);
	return c.json({ ok: true, title: parsed.data.title });
});

// Regenerate narrator title via AI
narratorRoutes.post("/:id/generate-title", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const title = await generateTitle(id, locale);
	await narratorService.updateTitle(id, title);
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

// Mark narrator as read (done → idle)
// Error sessions are preserved because only status=done can transition.
// Subagents are skipped — their done/error status must be preserved for ContinueTask.
narratorRoutes.patch("/:id/mark-read", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	if (narrator.type === "subagent") return c.json({ ok: true });
	if (narrator.status === "done" && !narrator.errorMessage) {
		await narratorService.updateStatus(id, "idle");
	}
	return c.json({ ok: true });
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
	await resolvePermission(requestId, "allow");
	return c.json({ ok: true });
});

// Deny permission
narratorRoutes.post("/permissions/:requestId/deny", async (c) => {
	const requestId = c.req.param("requestId");
	const body = await c.req.json().catch(() => ({}));
	const parsed = permissionDecisionSchema.safeParse({ decision: "deny", ...body });
	await resolvePermission(requestId, "deny", parsed.success ? parsed.data.message : undefined);
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

/** List patches for a narrator, optionally filtered by messageId */
narratorRoutes.get("/:id/patches", async (c) => {
	const narratorId = c.req.param("id");
	const messageId = c.req.query("messageId");

	const conditions = [eq(narratorPatches.narratorId, narratorId)];
	if (messageId) {
		conditions.push(eq(narratorPatches.messageId, messageId));
	}

	const patches = await db.query.narratorPatches.findMany({
		where: and(...conditions),
		orderBy: asc(narratorPatches.createdAt),
	});

	return c.json(patches);
});

/** Get the full diff for a specific patch */
narratorRoutes.get("/:id/patches/:patchId/diff", async (c) => {
	const narratorId = c.req.param("id");
	const patchId = c.req.param("patchId");

	const patch = await db.query.narratorPatches.findFirst({
		where: and(eq(narratorPatches.id, patchId), eq(narratorPatches.narratorId, narratorId)),
	});
	if (!patch) return c.json({ error: "Patch not found" }, 404);

	// Resolve chapter + worktree
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true },
	});
	if (!narrator?.chapterId) return c.json({ error: "Narrator not bound to a chapter" }, 400);

	const chapter = await db.query.chapters.findFirst({
		where: eq(chapters.id, narrator.chapterId),
		columns: { worktreePath: true },
	});
	if (!chapter?.worktreePath) return c.json({ error: "Chapter has no worktree" }, 400);

	const diff = await snapshot.diff(
		narrator.chapterId,
		chapter.worktreePath,
		patch.beforeHash,
		patch.afterHash,
	);
	return c.json({ diff });
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

	// Resolve chapter + worktree
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true },
	});
	if (!narrator?.chapterId) return c.json({ error: "Narrator not bound to a chapter" }, 400);

	const chapter = await db.query.chapters.findFirst({
		where: eq(chapters.id, narrator.chapterId),
		columns: { worktreePath: true },
	});
	if (!chapter?.worktreePath) return c.json({ error: "Chapter has no worktree" }, 400);

	const chapterId = narrator.chapterId;
	const worktreePath = chapter.worktreePath;

	// Find the target message's createdAt to filter patches from that point onwards
	const targetMessage = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, body.messageId),
		columns: { createdAt: true },
	});
	if (!targetMessage) return c.json({ error: "Message not found" }, 404);

	// Collect all patches at or after the target message (reverse chronological for revert)
	const allPatches = await db.query.narratorPatches.findMany({
		where: and(
			eq(narratorPatches.narratorId, narratorId),
			gte(narratorPatches.createdAt, targetMessage.createdAt),
		),
		orderBy: desc(narratorPatches.createdAt),
	});

	if (allPatches.length === 0) {
		return c.json({ snapshotHash: null, patchCount: 0, files: [] });
	}

	// Save current state for unrevert
	let snapshotHash: string;
	try {
		snapshotHash = await snapshot.track(chapterId, worktreePath);
	} catch (err) {
		return c.json(
			{
				error: `Failed to save current state: ${err instanceof Error ? err.message : String(err)}`,
			},
			500,
		);
	}

	// Build PatchInfo array
	const patchInfos = allPatches.map((p) => ({
		beforeHash: p.beforeHash,
		afterHash: p.afterHash,
		files: p.filesJson as string[],
	}));

	// Revert
	try {
		// Re-check right before mutation to narrow the TOCTOU window
		if (isNarratorActive(narratorId)) {
			return c.json({ error: "Narrator became active during revert" }, 409);
		}
		await snapshot.revert(chapterId, worktreePath, patchInfos);
	} catch (err) {
		return c.json(
			{
				error: `Revert failed: ${err instanceof Error ? err.message : String(err)}`,
				snapshotHash, // allow unrevert even on partial failure
				partial: true,
			},
			500,
		);
	}

	// Collect all affected files
	const allFiles = [...new Set(patchInfos.flatMap((p) => p.files))];

	return c.json({ snapshotHash, patchCount: allPatches.length, files: allFiles });
});

/** Unrevert — restore to the state before the last revert */
narratorRoutes.post("/:id/unrevert", async (c) => {
	const narratorId = c.req.param("id");
	const body = await c.req.json<{ snapshotHash: string }>();
	if (!body.snapshotHash) return c.json({ error: "snapshotHash is required" }, 400);

	if (isNarratorActive(narratorId)) {
		return c.json({ error: "Cannot unrevert while narrator is running" }, 409);
	}

	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true },
	});
	if (!narrator?.chapterId) return c.json({ error: "Narrator not bound to a chapter" }, 400);

	const chapter = await db.query.chapters.findFirst({
		where: eq(chapters.id, narrator.chapterId),
		columns: { worktreePath: true },
	});
	if (!chapter?.worktreePath) return c.json({ error: "Chapter has no worktree" }, 400);

	try {
		// Re-check right before mutation to narrow the TOCTOU window
		if (isNarratorActive(narratorId)) {
			return c.json({ error: "Narrator became active during unrevert" }, 409);
		}
		await snapshot.restore(narrator.chapterId, chapter.worktreePath, body.snapshotHash);
	} catch (err) {
		return c.json(
			{ error: `Restore failed: ${err instanceof Error ? err.message : String(err)}` },
			500,
		);
	}

	return c.json({ success: true });
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
