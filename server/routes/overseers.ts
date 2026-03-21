import { Hono } from "hono";
import { createOverseerSchema, updateOverseerSchema } from "../lib/validators";
import * as overseerService from "../services/overseer-service";

export const overseerRoutes = new Hono();

// Create overseer
overseerRoutes.post("/", async (c) => {
	const body = await c.req.json();
	const parsed = createOverseerSchema.parse(body);
	const overseer = await overseerService.createOverseer(parsed);
	return c.json(overseer, 201);
});

// List overseers
overseerRoutes.get("/", async (c) => {
	const scope = c.req.query("scope") as "global" | "project" | undefined;
	const projectId = c.req.query("projectId");
	const list = await overseerService.listOverseers({
		scope: scope || undefined,
		projectId: projectId || undefined,
	});
	return c.json(list);
});

// Get overseer by ID
overseerRoutes.get("/:id", async (c) => {
	const { id } = c.req.param();
	const overseer = await overseerService.getOverseerWithNarrator(id);
	return c.json(overseer);
});

// Update overseer
overseerRoutes.patch("/:id", async (c) => {
	const { id } = c.req.param();
	const body = await c.req.json();
	const parsed = updateOverseerSchema.parse(body);
	const overseer = await overseerService.updateOverseer(id, parsed);
	return c.json(overseer);
});

// Delete overseer
overseerRoutes.delete("/:id", async (c) => {
	const { id } = c.req.param();
	await overseerService.deleteOverseer(id);
	return c.json({ ok: true });
});

// List managed narrators
overseerRoutes.get("/:id/managed", async (c) => {
	const { id } = c.req.param();
	const managed = await overseerService.listManagedNarrators(id);
	return c.json(managed);
});

// Get decision history
overseerRoutes.get("/:id/decisions", async (c) => {
	const { id } = c.req.param();
	const limit = Number(c.req.query("limit")) || 50;
	const decisions = await overseerService.getOverseerDecisions(id, limit);
	return c.json(decisions);
});
