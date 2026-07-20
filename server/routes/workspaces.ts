import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { workspaces } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { createWorkspaceSchema, updateWorkspaceSchema } from "../lib/validators";
import { ensureMigrated, hasRecentTab, removeRecentTab } from "../services/recent-tabs-service";

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

	// Remove the authoritative header first so children are released and clients receive a delta.
	await removeRecentTab(userId, "workspace", id);
	// Keep DELETE semantics for legacy/inconsistent rows that had no recent-tab header.
	await db.delete(workspaces).where(eq(workspaces.id, id));

	return c.json({ ok: true });
});

/**
 * Delete workspace DB records that are not referenced by their owner's authoritative recent tabs.
 * Called on server startup to clean up orphans left by previous runs.
 */
export async function dissolveOrphanWorkspaces(): Promise<number> {
	const batchSize = 100;
	let cursor: string | undefined;
	let removed = 0;

	while (true) {
		const rows = await db
			.select({ id: workspaces.id, userId: workspaces.userId })
			.from(workspaces)
			.where(cursor ? gt(workspaces.id, cursor) : undefined)
			.orderBy(asc(workspaces.id))
			.limit(batchSize);
		if (rows.length === 0) break;
		cursor = rows.at(-1)?.id;

		for (const userId of new Set(rows.map((row) => row.userId))) {
			await ensureMigrated(userId);
		}
		const orphanIds = rows
			.filter((row) => !hasRecentTab(row.userId, `workspace:${row.id}`))
			.map((row) => row.id);
		if (orphanIds.length > 0) {
			await db.delete(workspaces).where(inArray(workspaces.id, orphanIds));
			removed += orphanIds.length;
		}
		if (rows.length < batchSize) break;
	}

	return removed;
}
