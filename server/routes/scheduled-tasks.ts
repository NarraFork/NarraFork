import { Hono } from "hono";
import { NotFoundError, ValidationError } from "../lib/errors";
import {
	createScheduledTaskSchema,
	toggleScheduledTaskSchema,
	updateScheduledTaskSchema,
} from "../lib/validators";
import { scheduledTaskService } from "../services/scheduled-task-service";

export const scheduledTaskRoutes = new Hono();

/**
 * List scheduled tasks.
 *
 * Returns a bare array, which is the shape the UI has always consumed. The service's
 * `truncated` flag is surfaced as a header rather than by wrapping the body in an
 * object: changing the body shape would break every existing client for a signal that
 * only fires above 500 tasks, and a header is readable by the ones that care.
 */
scheduledTaskRoutes.get("/", async (c) => {
	const { tasks, truncated } = await scheduledTaskService.list();
	if (truncated) c.header("X-NarraFork-Truncated", "1");
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

/** List a task's run history (newest first, cursor-paginated). */
scheduledTaskRoutes.get("/:id/runs", async (c) => {
	const id = c.req.param("id");
	const existing = await scheduledTaskService.get(id);
	if (!existing) throw new NotFoundError("ScheduledTask", id);
	const limitRaw = Number(c.req.query("limit"));
	const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
	const cursor = c.req.query("cursor") || null;
	const result = await scheduledTaskService.listRuns(id, { limit, cursor });
	return c.json(result);
});

/** Delete a scheduled task. */
scheduledTaskRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const existing = await scheduledTaskService.get(id);
	if (!existing) throw new NotFoundError("ScheduledTask", id);
	await scheduledTaskService.delete(id);
	return c.json({ ok: true });
});
