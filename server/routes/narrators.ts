import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../db";
import { narrators } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { type ImageRef, saveUploadedImage } from "../lib/uploads";
import {
	createNarratorSchema,
	permissionDecisionSchema,
	sendMessageSchema,
	updateNarratorModelSchema,
	updateNarratorTitleSchema,
} from "../lib/validators";
import { narratorService } from "../services/narrator-service";
import {
	getBufferedMessage,
	interruptSession,
	isSessionActive,
	resolvePermission,
	startSession,
} from "../services/narrator-session";
import { generateTitle } from "../services/narrator-title";
import { getUserLanguage } from "../lib/prompt-i18n";

/** Parse message request supporting both JSON and multipart/form-data (with images) */
export async function parseMessageRequest(
	c: {
		req: {
			header: (name: string) => string | undefined;
			formData: () => Promise<FormData>;
			json: () => Promise<any>;
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
		// Standalone sessions (no chapter)
		const status = c.req.query("status");
		const sortBy = c.req.query("sortBy") ?? "updatedAt";
		const sortOrder = c.req.query("sortOrder") ?? "desc";

		const whereClause =
			status === "archived"
				? and(isNull(narrators.chapterId), eq(narrators.status, "archived"))
				: and(isNull(narrators.chapterId), ne(narrators.status, "archived"));

		const sortColumnMap: Record<string, any> = {
			updatedAt: narrators.updatedAt,
			createdAt: narrators.createdAt,
			title: narrators.title,
			messageCount: narrators.messageCount,
		};
		const column = sortColumnMap[sortBy] ?? narrators.updatedAt;
		const orderFn = sortOrder === "asc" ? asc : desc;

		const list = await db.query.narrators.findMany({
			where: whereClause,
			orderBy: [orderFn(column)],
		});
		return c.json(list);
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

// Send message — SSE streaming response (supports text + image uploads)
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

	return streamSSE(c, async (stream) => {
		const MAX_CHAIN_DEPTH = 10;
		let chainCount = 0;
		let sessionGen = startSession(id, message, images, locale);
		while (chainCount < MAX_CHAIN_DEPTH) {
			chainCount++;
			let feedbackMessage: string | null = null;
			let bufferedSend: { message: string; images?: any[] } | null = null;
			for await (const event of sessionGen) {
				if (event.type === "auto_feedback") {
					// Session was interrupted for "allow with feedback" — start a new session
					feedbackMessage = event.data.message;
					break;
				}
				if (event.type === "buffered_send") {
					// User queued a message while narrator was thinking — chain into new session
					bufferedSend = event.data;
					break;
				}
				await stream.writeSSE({
					event: event.type,
					data: JSON.stringify(event.data),
				});
			}
			if (feedbackMessage) {
				sessionGen = startSession(id, feedbackMessage, undefined, locale);
				continue;
			}
			if (bufferedSend) {
				sessionGen = startSession(id, bufferedSend.message, bufferedSend.images, locale);
				continue;
			}
			break;
		}
	});
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
	return c.json(result);
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
	return c.json({ ok: true });
});

// Update permission mode
narratorRoutes.patch("/:id/permission-mode", async (c) => {
	const id = c.req.param("id");
	const { permissionMode } = await c.req.json();
	const validModes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"];
	if (!permissionMode || !validModes.includes(permissionMode)) {
		throw new ValidationError(`permissionMode must be one of: ${validModes.join(", ")}`);
	}
	await narratorService.getById(id); // ensure exists
	await narratorService.updatePermissionMode(id, permissionMode);
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
	const title = await generateTitle(id, [], locale);
	await narratorService.updateTitle(id, title);
	return c.json({ title });
});

// Archive narrator
narratorRoutes.patch("/:id/archive", async (c) => {
	const id = c.req.param("id");
	if (isSessionActive(id)) await interruptSession(id);
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
