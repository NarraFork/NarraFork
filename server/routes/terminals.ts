import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { requireNarratorAccess } from "../lib/narrator-access";
import { createTerminalSchema, updateTerminalViewStateSchema } from "../lib/validators";
import { requireAuth } from "../middleware/auth";
import { terminalService } from "../services/terminal-service";
import { terminalViewService } from "../services/terminal-view-service";

export const terminalRoutes = new Hono();

// === Terminal CRUD (collection) ===

terminalRoutes.get("/", async (c) => {
	const chapterId = c.req.query("chapterId");
	const narratorId = c.req.query("narratorId");
	if (!chapterId && !narratorId) {
		throw new ValidationError("chapterId or narratorId query parameter is required");
	}
	// Listing a narrator's terminals reveals what it is running, so it follows the
	// narrator's read access. The chapter branch is unchanged: chapters have no
	// per-user ACL of their own.
	if (narratorId) await requireNarratorAccess(c, narratorId, "read");
	const list = chapterId
		? await terminalService.listByChapter(chapterId)
		: await terminalService.listByNarrator(narratorId ?? "");
	return c.json(list);
});

terminalRoutes.post("/", async (c) => {
	const body = await c.req.json();
	const parsed = createTerminalSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	// A terminal attached to a narrator executes commands in its workspace, which is
	// exactly the authority `write` denotes — read-only viewers must not get a shell.
	if (parsed.data.narratorId) {
		await requireNarratorAccess(c, parsed.data.narratorId, "write");
	}
	const terminal = await terminalService.create({
		chapterId: parsed.data.chapterId,
		narratorId: parsed.data.narratorId,
		name: parsed.data.name,
		cols: parsed.data.cols,
		rows: parsed.data.rows,
		deviceId: parsed.data.deviceId,
	});
	return c.json(terminal, 201);
});

/**
 * === Terminal Tabs: removed ===
 *
 * `/tabs` had a full CRUD surface (GET/POST/PATCH/DELETE plus `PUT /tabs/reorder`) backed
 * by a `terminal_tabs` table and `terminal-tab-service`. Nothing ever called it: all five
 * frontend clients had zero call sites, and the hook and component built on them had zero
 * importers.
 *
 * The live terminal UI (`NarratorTerminal.tsx`) derives its tabs from the *running
 * terminals* and persists only their order, so a separate tab entity was never needed.
 * `terminal_view_state` below is unrelated and very much in use.
 */

// === Terminal View State ===

terminalRoutes.get("/view-state", requireAuth, async (c) => {
	const userId = c.get("user").sub;
	const chapterId = c.req.query("chapterId");
	const narratorId = c.req.query("narratorId");
	const state = await terminalViewService.get(userId, {
		chapterId: chapterId ?? undefined,
		narratorId: narratorId ?? undefined,
	});
	return c.json(state ?? { layout: "single", activeTabId: null, panelAssignments: null });
});

terminalRoutes.put("/view-state", requireAuth, async (c) => {
	const userId = c.get("user").sub;
	const body = await c.req.json();
	const parsed = updateTerminalViewStateSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const state = await terminalViewService.upsert(userId, parsed.data);
	return c.json(state);
});

// === Terminal by ID (must be AFTER static paths to avoid shadowing) ===

terminalRoutes.get("/:id", async (c) => {
	const terminal = await terminalService.getById(c.req.param("id"));
	return c.json(terminal);
});

terminalRoutes.get("/:id/processes", async (c) => {
	const processes = await terminalService.getProcesses(c.req.param("id"));
	return c.json(processes);
});

terminalRoutes.patch("/:id", async (c) => {
	const body = await c.req.json();
	const id = c.req.param("id");

	// Name update
	if (body?.name !== undefined) {
		const name = body.name;
		if (typeof name !== "string" || !name.trim()) {
			throw new ValidationError("name must be a non-empty string");
		}
		await terminalService.rename(id, name.trim());
	}

	// Graph-state updates used to be accepted here, for terminals shown as their own
	// canvas nodes. That node type is gone — a chapter's terminals live in its dock's
	// terminal panel — so the route now only renames.

	const terminal = await terminalService.getById(id);
	return c.json(terminal);
});

terminalRoutes.delete("/:id", async (c) => {
	await terminalService.kill(c.req.param("id"));
	return c.json({ ok: true });
});
