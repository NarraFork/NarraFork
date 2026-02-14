import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ValidationError } from "../lib/errors";
import { type ImageRef, saveUploadedImage } from "../lib/uploads";
import {
	createNarratorSchema,
	permissionDecisionSchema,
	sendMessageSchema,
	updateNarratorTitleSchema,
} from "../lib/validators";
import { narratorService } from "../services/narrator-service";
import {
	interruptSession,
	isSessionActive,
	resolvePermission,
	startSession,
} from "../services/narrator-session";
import { generateTitle } from "../services/narrator-title";

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

// List narrators for a chapter
narratorRoutes.get("/", async (c) => {
	const chapterId = c.req.query("chapterId");
	if (!chapterId) throw new ValidationError("chapterId query parameter is required");
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

// Delete narrator
narratorRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	if (isSessionActive(id)) await interruptSession(id);
	await narratorService.remove(id);
	return c.json({ ok: true });
});
// Send message — SSE streaming response (supports text + image uploads)
narratorRoutes.post("/:id/messages", async (c) => {
	const id = c.req.param("id");
	await narratorService.getById(id); // throws NotFoundError if missing
	const { message, images } = await parseMessageRequest(c, id);

	return streamSSE(c, async (stream) => {
		for await (const event of startSession(id, message, images)) {
			await stream.writeSSE({
				event: event.type,
				data: JSON.stringify(event.data),
			});
		}
	});
});

// Find parent message by tool_use_id (for lazy-loading subagent parents)
narratorRoutes.get("/:id/messages/find-parent", async (c) => {
	const id = c.req.param("id");
	const toolUseId = c.req.query("toolUseId");
	if (!toolUseId) throw new ValidationError("toolUseId query parameter is required");
	const result = await narratorService.findMessageByToolUseId(id, toolUseId);
	return c.json(result ?? { messageId: null, createdAt: null });
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
	const title = await generateTitle(id, []);
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
