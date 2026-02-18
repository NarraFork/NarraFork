import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import {
	createTerminalSchema,
	createTerminalTabSchema,
	reorderTerminalTabsSchema,
	updateTerminalTabSchema,
	updateTerminalViewStateSchema,
} from "../lib/validators";
import { requireAuth } from "../middleware/auth";
import { terminalService } from "../services/terminal-service";
import { terminalTabService } from "../services/terminal-tab-service";
import { terminalViewService } from "../services/terminal-view-service";

export const terminalRoutes = new Hono();

// === Terminal CRUD ===

terminalRoutes.get("/", async (c) => {
	const chapterId = c.req.query("chapterId");
	const narratorId = c.req.query("narratorId");
	if (!chapterId && !narratorId) {
		throw new ValidationError("chapterId or narratorId query parameter is required");
	}
	const list = chapterId
		? await terminalService.listByChapter(chapterId)
		: await terminalService.listByNarrator(narratorId!);
	return c.json(list);
});

terminalRoutes.post("/", async (c) => {
	const body = await c.req.json();
	const parsed = createTerminalSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const terminal = await terminalService.create({
		chapterId: parsed.data.chapterId,
		narratorId: parsed.data.narratorId,
		name: parsed.data.name,
		cols: parsed.data.cols,
		rows: parsed.data.rows,
	});
	return c.json(terminal, 201);
});

terminalRoutes.get("/:id", async (c) => {
	const terminal = await terminalService.getById(c.req.param("id"));
	return c.json(terminal);
});

terminalRoutes.delete("/:id", async (c) => {
	await terminalService.kill(c.req.param("id"));
	return c.json({ ok: true });
});

// === Terminal Tabs ===

terminalRoutes.get("/tabs", async (c) => {
	const chapterId = c.req.query("chapterId");
	const narratorId = c.req.query("narratorId");
	if (!chapterId && !narratorId) {
		throw new ValidationError("chapterId or narratorId query parameter is required");
	}
	const tabs = await terminalTabService.list({
		chapterId: chapterId ?? undefined,
		narratorId: narratorId ?? undefined,
	});
	return c.json(tabs);
});

terminalRoutes.post("/tabs", async (c) => {
	const body = await c.req.json();
	const parsed = createTerminalTabSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const tab = await terminalTabService.create(parsed.data);
	return c.json(tab, 201);
});

terminalRoutes.patch("/tabs/:id", async (c) => {
	const body = await c.req.json();
	const parsed = updateTerminalTabSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const tab = await terminalTabService.update(c.req.param("id"), parsed.data);
	return c.json(tab);
});

terminalRoutes.delete("/tabs/:id", async (c) => {
	await terminalTabService.delete(c.req.param("id"));
	return c.json({ ok: true });
});

terminalRoutes.put("/tabs/reorder", async (c) => {
	const body = await c.req.json();
	const parsed = reorderTerminalTabsSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	await terminalTabService.reorder(parsed.data.ids);
	return c.json({ ok: true });
});

// === Terminal View State ===

terminalRoutes.get("/view-state", requireAuth, async (c) => {
	const userId = c.get("userId" as never) as string;
	const chapterId = c.req.query("chapterId");
	const narratorId = c.req.query("narratorId");
	const state = await terminalViewService.get(userId, {
		chapterId: chapterId ?? undefined,
		narratorId: narratorId ?? undefined,
	});
	return c.json(state ?? { layout: "single", activeTabId: null, panelAssignments: null });
});

terminalRoutes.put("/view-state", requireAuth, async (c) => {
	const userId = c.get("userId" as never) as string;
	const body = await c.req.json();
	const parsed = updateTerminalViewStateSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const state = await terminalViewService.upsert(userId, parsed.data);
	return c.json(state);
});
