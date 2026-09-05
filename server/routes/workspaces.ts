import { WORKSPACE_PANEL_CONFIG_MAX_BYTES } from "@shared/workspace-panels";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { db } from "../db";
import { workspaces } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import {
	createWorkspacePanelSchema,
	createWorkspaceSchema,
	saveWorkspaceLayoutSchema,
	updateWorkspacePanelConfigSchema,
	updateWorkspaceSchema,
} from "../lib/validators";
import { WORKSPACE_TREE_MAX_BYTES } from "../lib/validators/workspaces";
import { ensureMigrated, hasRecentTab, removeRecentTab } from "../services/recent-tabs-service";
import {
	addWorkspacePanel,
	listWorkspacePanels,
	removeWorkspacePanel,
	saveWorkspaceLayout,
	updateWorkspacePanelConfig,
	WorkspaceLayoutConflictError,
} from "../services/workspace-panel-service";

export const workspaceRoutes = new Hono();

/**
 * Upper bound on the listing. Workspaces are user-assembled surfaces, so a few
 * dozen is already an unusual amount; the limit exists so the query can never
 * degrade into an unbounded scan as rows accumulate.
 */
const WORKSPACE_LIST_LIMIT = 200;

/**
 * Stream-level cap for the two routes that accept a layout.
 *
 * The Zod schema already bounds `tree`, but it only runs AFTER the whole body has
 * been buffered and JSON-parsed on the single JS thread — so without this an
 * oversized payload still costs that parse before being rejected. The allowance
 * is the tree budget plus a small margin for the JSON envelope (`{"tree":...}`,
 * an optional title, and the escaping the layout string picks up when nested
 * inside JSON).
 */
const WORKSPACE_WRITE_BODY_MAX_BYTES = WORKSPACE_TREE_MAX_BYTES + 256 * 1024;

const workspaceWriteBodyLimit = bodyLimit({
	maxSize: WORKSPACE_WRITE_BODY_MAX_BYTES,
	onError: (c) =>
		c.json(
			{
				error: `Workspace layout exceeds the ${Math.floor(
					WORKSPACE_TREE_MAX_BYTES / (1024 * 1024),
				)} MiB limit`,
				code: "WORKSPACE_TREE_TOO_LARGE",
			},
			413,
		),
});

/**
 * Body cap for a single-panel write.
 *
 * A panel's config is bounded by `WORKSPACE_PANEL_CONFIG_MAX_BYTES` (16 KiB), so
 * this is deliberately far below the layout cap — the panel routes have no reason
 * to buffer or parse a megabyte-scale body.
 */
const workspacePanelBodyLimit = bodyLimit({
	maxSize: WORKSPACE_PANEL_CONFIG_MAX_BYTES + 64 * 1024,
	onError: (c) =>
		c.json(
			{
				error: `Workspace panel config exceeds the ${Math.floor(
					WORKSPACE_PANEL_CONFIG_MAX_BYTES / 1024,
				)} KiB limit`,
				code: "WORKSPACE_PANEL_CONFIG_TOO_LARGE",
			},
			413,
		),
});

/**
 * Read the JSON body, letting an over-cap request surface as the 413 above.
 *
 * When the request carries no `Content-Length`, `bodyLimit` enforces its cap by
 * ERRORING THE BODY STREAM, which arrives here as a failed read. Rethrowing that
 * specific error lets the middleware produce its 413 instead of it being reported
 * as a generic malformed-body 400.
 */
async function readWorkspaceJson(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch (err) {
		if (err instanceof Error && err.name === "BodyLimitError") throw err;
		throw new ValidationError("Workspace request body must be valid JSON");
	}
}

// List current user's workspaces
//
// ⚠️ BREAKING SHAPE CHANGE: `tree` is no longer returned here, and `treeBytes` is
// new. Nothing consumes this route today (`api.listWorkspaces()` is defined in
// `frontend/lib/api/misc.ts` but has no call sites), which is why the change is
// safe to make now — a later consumer written against the old shape would find
// `tree` undefined only at runtime, since the client types these rows as a loose
// `ApiEntity` and TypeScript cannot flag it.
//
// `tree` is excluded because it is a per-workspace layout blob bounded by
// `WORKSPACE_TREE_MAX_BYTES` (2 MiB), and this route returns every workspace the
// user owns. Serializing all of them would put tens of megabytes of layout JSON
// through the single JS thread for a listing that only needs titles. `treeBytes`
// is returned instead so a caller can show size without reading the payload; the
// full layout is read only by `GET /workspaces/:id`.
workspaceRoutes.get("/", async (c) => {
	const userId = c.get("user").sub;
	const rows = await db
		.select({
			id: workspaces.id,
			userId: workspaces.userId,
			title: workspaces.title,
			treeBytes: sql<number>`length(cast(${workspaces.tree} as blob))`,
			createdAt: workspaces.createdAt,
			updatedAt: workspaces.updatedAt,
		})
		.from(workspaces)
		.where(eq(workspaces.userId, userId))
		.orderBy(desc(workspaces.updatedAt))
		.limit(WORKSPACE_LIST_LIMIT);
	return c.json(rows);
});

// Get a single workspace, WITH its membership.
//
// Membership rides along rather than living behind a second request so opening a
// workspace is one round trip, and — more importantly — so a client can never
// render from the layout before it knows the member set. That ordering is what
// made the old design able to show a workspace whose panels did not match its
// sidebar group.
//
// `layout` mirrors `tree` under the name that reflects its narrowed role
// (arrangement only). `tree` is still returned so nothing reading the old field
// breaks mid-rollout.
workspaceRoutes.get("/:id", async (c) => {
	const userId = c.get("user").sub;
	const id = c.req.param("id");
	const ws = await db.query.workspaces.findFirst({
		where: and(eq(workspaces.id, id), eq(workspaces.userId, userId)),
	});
	if (!ws) throw new NotFoundError("Workspace", id);
	// Materialises membership on first read for a workspace that predates the table.
	const panels = await listWorkspacePanels(userId, id);
	return c.json({ ...ws, layout: ws.tree, panels });
});

// === Membership ===

workspaceRoutes.get("/:id/panels", async (c) => {
	const userId = c.get("user").sub;
	const panels = await listWorkspacePanels(userId, c.req.param("id"));
	return c.json({ panels });
});

// Body cap is per-PANEL here, orders of magnitude below the layout cap: one
// panel's config is bounded by WORKSPACE_PANEL_CONFIG_MAX_BYTES, so accepting a
// layout-sized body on this route would only buy a pointless parse.
workspaceRoutes.post("/:id/panels", workspacePanelBodyLimit, async (c) => {
	const userId = c.get("user").sub;
	const parsed = createWorkspacePanelSchema.safeParse(await readWorkspaceJson(c));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const result = await addWorkspacePanel(userId, c.req.param("id"), parsed.data);
	// 200 for an existing member, 201 for a new one: the request is idempotent, and
	// the status is how a caller tells "already there" from "just created".
	return c.json({ panel: result.panel }, result.created ? 201 : 200);
});

workspaceRoutes.patch("/:id/panels/:panelId", workspacePanelBodyLimit, async (c) => {
	const userId = c.get("user").sub;
	const parsed = updateWorkspacePanelConfigSchema.safeParse(await readWorkspaceJson(c));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const panel = await updateWorkspacePanelConfig(
		userId,
		c.req.param("id"),
		c.req.param("panelId"),
		parsed.data.config,
	);
	return c.json({ panel });
});

workspaceRoutes.delete("/:id/panels/:panelId", async (c) => {
	const userId = c.get("user").sub;
	await removeWorkspacePanel(userId, c.req.param("id"), c.req.param("panelId"));
	return c.json({ ok: true });
});

// === Arrangement ===
//
// Separate from `PATCH /:id` (which still accepts `tree` for compatibility)
// because this one is guarded by `expectedRevision`. A 409 carries the current
// revision so the client can rebase and retry without an extra read.
workspaceRoutes.put("/:id/layout", workspaceWriteBodyLimit, async (c) => {
	const userId = c.get("user").sub;
	const parsed = saveWorkspaceLayoutSchema.safeParse(await readWorkspaceJson(c));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	try {
		const result = await saveWorkspaceLayout(
			userId,
			c.req.param("id"),
			parsed.data.layout,
			parsed.data.expectedRevision,
		);
		return c.json(result);
	} catch (err) {
		if (err instanceof WorkspaceLayoutConflictError) {
			return c.json(
				{
					error: err.message,
					code: err.code,
					currentRevision: err.currentRevision,
				},
				409,
			);
		}
		throw err;
	}
});

// Create a workspace
workspaceRoutes.post("/", workspaceWriteBodyLimit, async (c) => {
	const userId = c.get("user").sub;
	const parsed = createWorkspaceSchema.safeParse(await readWorkspaceJson(c));
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
workspaceRoutes.patch("/:id", workspaceWriteBodyLimit, async (c) => {
	const userId = c.get("user").sub;
	const id = c.req.param("id");
	const parsed = updateWorkspaceSchema.safeParse(await readWorkspaceJson(c));
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const ws = await db.query.workspaces.findFirst({
		where: and(eq(workspaces.id, id), eq(workspaces.userId, userId)),
	});
	if (!ws) throw new NotFoundError("Workspace", id);

	// Title only. The layout is written exclusively by `PUT /:id/layout`, which guards it
	// with `expectedRevision`; see `updateWorkspaceSchema`.
	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (parsed.data.title !== undefined) updates.title = parsed.data.title;

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
