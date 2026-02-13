import { eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../db";
import { narrators } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import {
	createSessionSchema,
	sendMessageSchema,
	updateNarratorTitleSchema,
} from "../lib/validators";
import { narratorService } from "../services/narrator-service";
import { startSession } from "../services/narrator-session";
import { generateTitle } from "../services/narrator-title";

export const sessionRoutes = new Hono();

// Create standalone session (narrator with no chapter)
sessionRoutes.post("/", async (c) => {
	const parsed = createSessionSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const session = await narratorService.create({
		chapterId: null,
		model: parsed.data.model,
		systemPrompt: parsed.data.systemPrompt,
		permissionMode: parsed.data.permissionMode,
	});

	return c.json(session, 201);
});

// List standalone sessions
sessionRoutes.get("/", async (c) => {
	const sessions = await db.query.narrators.findMany({
		where: isNull(narrators.chapterId),
		orderBy: (n, { desc }) => [desc(n.createdAt)],
	});
	return c.json(sessions);
});

// Get session detail
sessionRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	const session = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
	});
	if (!session) throw new NotFoundError("Session", id);
	if (session.chapterId !== null) {
		throw new ValidationError("This narrator is bound to a chapter, not a standalone session");
	}
	return c.json(session);
});

// Send message to standalone session (SSE stream)
sessionRoutes.post("/:id/messages", async (c) => {
	const id = c.req.param("id");
	const parsed = sendMessageSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	// Verify this is a standalone session
	const session = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
	});
	if (!session) throw new NotFoundError("Session", id);
	if (session.chapterId !== null) {
		throw new ValidationError("This narrator is bound to a chapter, not a standalone session");
	}

	return streamSSE(c, async (stream) => {
		for await (const event of startSession(id, parsed.data.message)) {
			await stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
		}
	});
});

// Get session messages
sessionRoutes.get("/:id/messages", async (c) => {
	const id = c.req.param("id");
	const session = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
	});
	if (!session) throw new NotFoundError("Session", id);
	if (session.chapterId !== null) {
		throw new ValidationError("This narrator is bound to a chapter, not a standalone session");
	}
	const rawLimit = Number.parseInt(c.req.query("limit") ?? "100", 10);
	const limit = Math.min(Number.isNaN(rawLimit) ? 100 : rawLimit, 500);
	const rawOffset = Number.parseInt(c.req.query("offset") ?? "0", 10);
	const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;
	const messages = await narratorService.getMessages(id, limit, offset);
	return c.json(messages);
});

// Delete standalone session
sessionRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const session = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
	});
	if (!session) throw new NotFoundError("Session", id);
	if (session.chapterId !== null) {
		throw new ValidationError("This narrator is bound to a chapter, use narrator delete instead");
	}
	await narratorService.remove(id);
	return c.json({ ok: true });
});

// Update session title
sessionRoutes.patch("/:id/title", async (c) => {
	const id = c.req.param("id");
	const parsed = updateNarratorTitleSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const session = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
	});
	if (!session) throw new NotFoundError("Session", id);
	if (session.chapterId !== null) {
		throw new ValidationError("This narrator is bound to a chapter, not a standalone session");
	}
	await narratorService.updateTitle(id, parsed.data.title);
	return c.json({ ok: true, title: parsed.data.title });
});

// Regenerate session title via AI
sessionRoutes.post("/:id/generate-title", async (c) => {
	const id = c.req.param("id");
	const session = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
	});
	if (!session) throw new NotFoundError("Session", id);
	if (session.chapterId !== null) {
		throw new ValidationError("This narrator is bound to a chapter, not a standalone session");
	}
	const title = await generateTitle(id);
	await narratorService.updateTitle(id, title);
	return c.json({ title });
});
