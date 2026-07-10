import { Hono } from "hono";
import { NotFoundError, ValidationError } from "../lib/errors";
import {
	createScheduledTaskSchema,
	toggleScheduledTaskSchema,
	updateScheduledTaskSchema,
} from "../lib/validators";
import { scheduledTaskService } from "../services/scheduled-task-service";

export const scheduledTaskRoutes = new Hono();

/** List all scheduled tasks. */
scheduledTaskRoutes.get("/", async (c) => {
	const tasks = await scheduledTaskService.list();
	return c.json(tasks);
});

/** Get a single scheduled task. */
scheduledTaskRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	const task = await scheduledTaskService.get(id);
	if (!task) throw new NotFoundError("ScheduledTask", id);
	return c.json(task);
});

/** Create a scheduled task. */
scheduledTaskRoutes.post("/", async (c) => {
	const body = await c.req.json();
	const parsed = createScheduledTaskSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const createdBy = c.get("user").sub;
	const task = await scheduledTaskService.create({ ...parsed.data, createdBy });
	return c.json(task, 201);
});

/** Update a scheduled task. */
scheduledTaskRoutes.put("/:id", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const parsed = updateScheduledTaskSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const task = await scheduledTaskService.update(id, parsed.data);
	return c.json(task);
});

/** Enable/disable a scheduled task. */
scheduledTaskRoutes.post("/:id/toggle", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	const parsed = toggleScheduledTaskSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const task = await scheduledTaskService.setEnabled(id, parsed.data.enabled);
	return c.json(task);
});

/** Trigger a task immediately (out of schedule). */
scheduledTaskRoutes.post("/:id/run", async (c) => {
	const id = c.req.param("id");
	const existing = await scheduledTaskService.get(id);
	if (!existing) throw new NotFoundError("ScheduledTask", id);
	await scheduledTaskService.runTask(id, { manual: true });
	const task = await scheduledTaskService.get(id);
	return c.json(task);
});

/** Delete a scheduled task. */
scheduledTaskRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const existing = await scheduledTaskService.get(id);
	if (!existing) throw new NotFoundError("ScheduledTask", id);
	await scheduledTaskService.delete(id);
	return c.json({ ok: true });
});
