import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { createTerminalSchema } from "../lib/validators";
import { terminalService } from "../services/terminal-service";

export const terminalRoutes = new Hono();

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
