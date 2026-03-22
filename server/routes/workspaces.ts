import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { workspaces } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { createWorkspaceSchema, updateWorkspaceSchema } from "../lib/validators";

export const workspaceRoutes = new Hono();

// List current user's workspaces
workspaceRoutes.get("/", async (c) => {
	const userId = c.get("user").sub;
	const rows = await db.query.workspaces.findMany({
		where: eq(workspaces.userId, userId),
		orderBy: [desc(workspaces.updatedAt)],
	});
	return c.json(rows);
});

// Get a single workspace
workspaceRoutes.get("/:id", async (c) => {
	const userId = c.get("user").sub;
	const id = c.req.param("id");
	const ws = await db.query.workspaces.findFirst({
		where: and(eq(workspaces.id, id), eq(workspaces.userId, userId)),
	});
	if (!ws) throw new NotFoundError("Workspace", id);
	return c.json(ws);
});

// Create a workspace
workspaceRoutes.post("/", async (c) => {
	const userId = c.get("user").sub;
	const parsed = createWorkspaceSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const now = new Date();
	const id = generateId();
	const title = parsed.data.title || `Workspace ${Date.now().toString(36).slice(-4)}`;

	const [ws] = await db
		.insert(workspaces)
		.values({
			id,
			userId,
			title,
			tree: parsed.data.tree,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	return c.json(ws, 201);
});

// Update a workspace (tree or title)
workspaceRoutes.patch("/:id", async (c) => {
	const userId = c.get("user").sub;
	const id = c.req.param("id");
	const parsed = updateWorkspaceSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const ws = await db.query.workspaces.findFirst({
		where: and(eq(workspaces.id, id), eq(workspaces.userId, userId)),
	});
	if (!ws) throw new NotFoundError("Workspace", id);

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (parsed.data.title !== undefined) updates.title = parsed.data.title;
	if (parsed.data.tree !== undefined) updates.tree = parsed.data.tree;

	await db.update(workspaces).set(updates).where(eq(workspaces.id, id));

	return c.json({ ok: true });
});

// Delete a workspace
workspaceRoutes.delete("/:id", async (c) => {
	const userId = c.get("user").sub;
	const id = c.req.param("id");

	const ws = await db.query.workspaces.findFirst({
		where: and(eq(workspaces.id, id), eq(workspaces.userId, userId)),
	});
	if (!ws) throw new NotFoundError("Workspace", id);

	await db.delete(workspaces).where(eq(workspaces.id, id));

	return c.json({ ok: true });
});
