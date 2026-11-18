import { type Context, Hono } from "hono";
import { NotFoundError, ValidationError } from "../lib/errors";
import { narratorPrincipalOf, requireNarratorAccess } from "../lib/narrator-access";
import { createTerminalSchema, updateTerminalViewStateSchema } from "../lib/validators";
import { requireAuth } from "../middleware/auth";
import type { NarratorAccessNeed } from "../services/narrator-acl";
import { canWriteNarrator } from "../services/narrator-acl";
import { listTreeTerminals } from "../services/subagent-terminals";
import {
	rememberStandaloneTerminalCreator,
	terminalAccessAllowed,
} from "../services/terminal-access";
import { terminalService } from "../services/terminal-service";
import { terminalViewService } from "../services/terminal-view-service";

export const terminalRoutes = new Hono();

/**
 * A narrator's terminal follows that narrator's access (a subagent's, its ACL root's): `read`
 * for its metadata, `write` to open, rename, close it or list its processes. A standalone
 * terminal is its creator's and admins' (`terminal-access.ts`). Refused exactly like a
 * terminal that does not exist, so ids cannot be probed.
 */
async function requireTerminalAccess(c: Context, terminalId: string, need: NarratorAccessNeed) {
	if (!(await terminalAccessAllowed(terminalId, narratorPrincipalOf(c), need)))
		throw new NotFoundError("Terminal", terminalId);
}

// === Terminal CRUD (collection) ===

terminalRoutes.get("/", async (c) => {
	const narratorId = c.req.query("narratorId");
	if (!narratorId) {
		throw new ValidationError("narratorId query parameter is required");
	}
	// Listing a narrator's terminals reveals what it is running, so it follows the
	// narrator's read access.
	await requireNarratorAccess(c, narratorId, "read");
	return c.json(await terminalService.listByNarrator(narratorId));
});

/**
 * The running terminals of the subagents below a narrator (the coordinator page's read-only
 * list). Listing needs read access; `canOpen` says whether this caller may open them, which is
 * write access on the ACL root.
 */
terminalRoutes.get("/tree", async (c) => {
	const narratorId = c.req.query("narratorId");
	if (!narratorId) {
		throw new ValidationError("narratorId query parameter is required");
	}
	const narrator = await requireNarratorAccess(c, narratorId, "read");
	const listing = await listTreeTerminals(narrator);
	const canOpen = await canWriteNarrator(narrator, narratorPrincipalOf(c));
	return c.json({ ...listing, canOpen });
});

/**
 * Whether this caller may open a narrator's terminals (write access), so the page can hide
 * the terminal panel and its create buttons from read-only viewers. Needs read access.
 */
terminalRoutes.get("/access", async (c) => {
	const narratorId = c.req.query("narratorId");
	if (!narratorId) {
		throw new ValidationError("narratorId query parameter is required");
	}
	const narrator = await requireNarratorAccess(c, narratorId, "read");
	return c.json({ canOpen: await canWriteNarrator(narrator, narratorPrincipalOf(c)) });
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
		narratorId: parsed.data.narratorId,
		name: parsed.data.name,
		cols: parsed.data.cols,
		rows: parsed.data.rows,
		deviceId: parsed.data.deviceId,
	});
	if (!parsed.data.narratorId)
		rememberStandaloneTerminalCreator(terminal.id, narratorPrincipalOf(c).userId);
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
	const narratorId = c.req.query("narratorId");
	const state = await terminalViewService.get(userId, {
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
	await requireTerminalAccess(c, c.req.param("id"), "read");
	const terminal = await terminalService.getById(c.req.param("id"));
	return c.json(terminal);
});

terminalRoutes.get("/:id/processes", async (c) => {
	await requireTerminalAccess(c, c.req.param("id"), "write");
	const processes = await terminalService.getProcesses(c.req.param("id"));
	return c.json(processes);
});

terminalRoutes.patch("/:id", async (c) => {
	const body = await c.req.json();
	const id = c.req.param("id");
	await requireTerminalAccess(c, id, "write");

	// Name update
	if (body?.name !== undefined) {
		const name = body.name;
		if (typeof name !== "string" || !name.trim()) {
			throw new ValidationError("name must be a non-empty string");
		}
		await terminalService.rename(id, name.trim());
	}

	const terminal = await terminalService.getById(id);
	return c.json(terminal);
});

terminalRoutes.delete("/:id", async (c) => {
	await requireTerminalAccess(c, c.req.param("id"), "write");
	await terminalService.kill(c.req.param("id"));
	return c.json({ ok: true });
});
