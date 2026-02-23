import { and, asc, type Column, desc, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { narrators } from "../db/schema";
import { agentGenerateWithHistory } from "../lib/agent";
import { ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import {
	getToolMessage,
	getUserLanguage,
	getUserReplyInLanguage,
	type Locale,
} from "../lib/prompt-i18n";
import { type ImageRef, saveUploadedImage } from "../lib/uploads";
import {
	createNarratorSchema,
	forkNarratorSchema,
	permissionDecisionSchema,
	sendMessageSchema,
	suggestAnswersSchema,
	updateNarratorModelSchema,
	updateNarratorTitleSchema,
} from "../lib/validators";
import { narratorService } from "../services/narrator-service";
import {
	closeSession,
	getBufferedMessage,
	interruptSession,
	isSessionActive,
	resolvePermission,
	runCustomCompact,
	sendMessage,
	updateSessionModel,
	updateSessionPermissionMode,
} from "../services/narrator-session";
import { generateTitle } from "../services/narrator-title";

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

	if (standalone === "true") {
		// Standalone sessions (no chapter) — cursor-based pagination
		const status = c.req.query("status");
		const rawSortBy = c.req.query("sortBy") ?? "updatedAt";
		const sortOrder = c.req.query("sortOrder") ?? "desc";
		const rawLimit = Number.parseInt(c.req.query("limit") ?? "20", 10);
		const limit = Math.min(Number.isNaN(rawLimit) ? 20 : rawLimit, 100);
		const cursorParam = c.req.query("cursor");

		const baseWhere =
			status === "archived"
				? and(
						isNull(narrators.chapterId),
						eq(narrators.status, "archived"),
						ne(narrators.type, "subagent"),
					)
				: and(
						isNull(narrators.chapterId),
						ne(narrators.status, "archived"),
						ne(narrators.type, "subagent"),
					);

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
				// (column > cursorVal) OR (column = cursorVal AND id > cursorId) for asc
				// (column < cursorVal) OR (column = cursorVal AND id < cursorId) for desc
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
		const items = hasMore ? list.slice(0, limit) : list;
		const lastItem = items[items.length - 1];
		const nextCursor =
			hasMore && lastItem
				? Buffer.from(
						JSON.stringify({
							v: (lastItem as Record<string, unknown>)[sortBy] ?? lastItem.updatedAt,
							id: lastItem.id,
						}),
					).toString("base64url")
				: null;

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

// Send message — fire-and-forget; all streaming events delivered via WebSocket
narratorRoutes.post("/:id/messages", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id); // throws NotFoundError if missing

	// Auto-unarchive on interaction
	if (narrator.status === "archived") {
		await narratorService.updateStatus(id, "idle");
	}

	const { message, images } = await parseMessageRequest(c, id);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const replyInUserLanguage = await getUserReplyInLanguage(userId);

	const userMsg = await sendMessage(id, message, images, locale, replyInUserLanguage);
	return c.json(userMsg, 201);
});

// Get buffered message (for multi-device hydration on page load)
narratorRoutes.get("/:id/buffer", async (c) => {
	const id = c.req.param("id");
	const buffered = getBufferedMessage(id);
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
	return c.json({ ...result, pruneBoundaryMessageId: narrator.pruneBoundaryMessageId ?? null });
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
	// On failure, runCustomCompact rolls back the compacting marker and
	// broadcasts a compact_failed event via WebSocket so the frontend can react.
	runCustomCompact(narratorId, locale, beforeMessageId).catch((err) => {
		logger.error("Manual compact failed", { narratorId, err: String(err) });
	});
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
	const interrupted = await interruptSession(id);
	return c.json({ interrupted });
});

// Update model
narratorRoutes.patch("/:id/model", async (c) => {
	const id = c.req.param("id");
	const parsed = updateNarratorModelSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	await narratorService.getById(id); // ensure exists
	await narratorService.updateModel(id, parsed.data.model);
	await updateSessionModel(id, parsed.data.model);
	return c.json({ ok: true });
});

// Update permission mode
narratorRoutes.patch("/:id/permission-mode", async (c) => {
	const id = c.req.param("id");
	const { permissionMode } = await c.req.json();
	const validModes = ["default", "acceptEdits", "bypassPermissions", "dontAsk"];
	if (!permissionMode || !validModes.includes(permissionMode)) {
		throw new ValidationError(`permissionMode must be one of: ${validModes.join(", ")}`);
	}
	await narratorService.getById(id); // ensure exists
	await narratorService.updatePermissionMode(id, permissionMode);
	await updateSessionPermissionMode(id, permissionMode);
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
	if (isSessionActive(id)) closeSession(id);
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
narratorRoutes.patch("/:id/mark-read", async (c) => {
	const id = c.req.param("id");
	const narrator = await narratorService.getById(id);
	if (narrator.status === "done") {
		await narratorService.updateStatus(id, "idle");
	}
	return c.json({ ok: true });
});

// === Narrator Fork ===

// Fork narrator (create new narrator from a message)
narratorRoutes.post("/:id/fork", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const parsed = forkNarratorSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const newNarrator = await narratorService.forkNarrator(id, parsed.data.forkMessageId, {
		title: parsed.data.title,
	});
	return c.json(newNarrator, 201);
});

// Get related narrators (fork tree)
narratorRoutes.get("/:id/related", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id);
	const related = await narratorService.listRelatedNarrators(id);
	return c.json(related);
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
