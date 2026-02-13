import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ValidationError } from "../lib/errors";
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
// Send message — SSE streaming response
narratorRoutes.post("/:id/messages", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const parsed = sendMessageSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	return streamSSE(c, async (stream) => {
		for await (const event of startSession(id, parsed.data.message)) {
			await stream.writeSSE({
				event: event.type,
				data: JSON.stringify(event.data),
			});
		}
	});
});

// Get message history
narratorRoutes.get("/:id/messages", async (c) => {
	const id = c.req.param("id");
	const limit = Number(c.req.query("limit") ?? 100);
	const offset = Number(c.req.query("offset") ?? 0);
	const messages = await narratorService.getMessages(id, limit, offset);
	return c.json(messages);
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
	const title = await generateTitle(id);
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
