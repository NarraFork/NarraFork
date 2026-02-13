import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { createTerminalSchema } from "../lib/validators";
import { terminalService } from "../services/terminal-service";

export const terminalRoutes = new Hono();

terminalRoutes.get("/", async (c) => {
	const chapterId = c.req.query("chapterId");
	if (!chapterId) throw new ValidationError("chapterId query parameter is required");
	const list = await terminalService.listByChapter(chapterId);
	return c.json(list);
});

terminalRoutes.post("/", async (c) => {
	const body = await c.req.json();
	const parsed = createTerminalSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const terminal = await terminalService.create(
		parsed.data.chapterId,
		parsed.data.name,
		parsed.data.cols,
		parsed.data.rows,
	);
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
