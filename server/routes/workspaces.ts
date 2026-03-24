import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { userPreferences, workspaces } from "../db/schema";
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

/**
 * Delete workspace DB records that are not referenced in any user's recentTabs.
 * Called on server startup to clean up orphans left by previous runs.
 */
export async function dissolveOrphanWorkspaces(): Promise<number> {
	// Collect all workspace IDs from DB
	const allWs = await db.select({ id: workspaces.id }).from(workspaces);
	if (allWs.length === 0) return 0;

	// Collect all workspace IDs referenced in any user's recentTabs
	const allPrefs = await db
		.select({ recentTabs: userPreferences.recentTabs })
		.from(userPreferences);

	const referencedWsIds = new Set<string>();
	for (const row of allPrefs) {
		let tabs: Record<string, unknown>[];
		try {
			tabs = JSON.parse(row.recentTabs);
		} catch {
			continue;
		}
		if (!Array.isArray(tabs)) continue;
		for (const t of tabs) {
			if (t.type === "workspace") referencedWsIds.add(t.id as string);
		}
	}

	// Delete orphans
	const orphanIds = allWs.filter((ws) => !referencedWsIds.has(ws.id)).map((ws) => ws.id);
	if (orphanIds.length > 0) {
		await db.delete(workspaces).where(inArray(workspaces.id, orphanIds));
	}
	return orphanIds.length;
}
