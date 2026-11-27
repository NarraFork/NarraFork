import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ForbiddenError, ValidationError } from "../lib/errors";
import { narratorPrincipalOf } from "../lib/narrator-access";
import {
	createScheduledTaskSchema,
	scheduledTaskAssociationsQuerySchema,
	scheduledTaskFiltersSchema,
	scheduledTaskPreviewSchema,
	scheduledTaskTargetsQuerySchema,
	toggleScheduledTaskSchema,
	updateScheduledTaskSchema,
} from "../lib/validators/scheduled-tasks";
import { listNarratorScheduledTasks } from "../services/scheduled-task-associations";
import { cleanupScheduledTaskNarrators } from "../services/scheduled-task-cleanup";
import { scheduledTaskService } from "../services/scheduled-task-service";
import { listScheduledTaskTargets } from "../services/scheduled-task-targets";

export const scheduledTaskRoutes = new Hono();
scheduledTaskRoutes.use("*", bodyLimit({ maxSize: 256 * 1024 }));
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
	const result = schema.safeParse(input);
	if (!result.success) throw new ValidationError(result.error.message);
	return result.data;
}

scheduledTaskRoutes.get("/", async (c) => {
	const filters = parse(scheduledTaskFiltersSchema, c.req.query());
	const { tasks, truncated } = await scheduledTaskService.list(narratorPrincipalOf(c), filters);
	if (truncated) c.header("X-NarraFork-Truncated", "1");
	return c.json(tasks);
});

scheduledTaskRoutes.post("/preview-schedule", async (c) => {
	return c.json(
		scheduledTaskService.preview(parse(scheduledTaskPreviewSchema, await c.req.json())),
	);
});

scheduledTaskRoutes.get("/targets", async (c) =>
	c.json(
		await listScheduledTaskTargets(
			narratorPrincipalOf(c),
			parse(scheduledTaskTargetsQuerySchema, c.req.query()),
		),
	),
);

scheduledTaskRoutes.get("/for-narrator/:narratorId", async (c) =>
	c.json(
		await listNarratorScheduledTasks(
			c.req.param("narratorId"),
			narratorPrincipalOf(c),
			parse(scheduledTaskAssociationsQuerySchema, c.req.query()),
		),
	),
);

scheduledTaskRoutes.get("/:id", async (c) =>
	c.json(await scheduledTaskService.detail(c.req.param("id"), narratorPrincipalOf(c))),
);

scheduledTaskRoutes.post("/", async (c) => {
	const principal = narratorPrincipalOf(c);
	const task = await scheduledTaskService.create(
		parse(createScheduledTaskSchema, await c.req.json()),
		principal,
		{ kind: "user" },
	);
	return c.json(await scheduledTaskService.detail(task.id, principal), 201);
});

scheduledTaskRoutes.put("/:id", async (c) => {
	const principal = narratorPrincipalOf(c);
	const task = await scheduledTaskService.update(
		c.req.param("id"),
		parse(updateScheduledTaskSchema, await c.req.json()),
		principal,
		{ kind: "user" },
	);
	return c.json(await scheduledTaskService.detail(task.id, principal));
});

scheduledTaskRoutes.post("/:id/toggle", async (c) => {
	const principal = narratorPrincipalOf(c);
	const { enabled } = parse(toggleScheduledTaskSchema, await c.req.json());
	await scheduledTaskService.setEnabled(c.req.param("id"), enabled, principal);
	return c.json(await scheduledTaskService.detail(c.req.param("id"), principal));
});

scheduledTaskRoutes.post("/:id/run", async (c) => {
	const principal = narratorPrincipalOf(c);
	await scheduledTaskService.runTask(c.req.param("id"), { manual: true, principal });
	return c.json(await scheduledTaskService.detail(c.req.param("id"), principal));
});

scheduledTaskRoutes.get("/:id/runs", async (c) => {
	const query = parse(
		z.object({
			limit: z.coerce.number().int().min(1).max(200).optional(),
			cursor: z.string().max(300).optional(),
			result: scheduledTaskFiltersSchema.shape.result,
		}),
		c.req.query(),
	);
	return c.json(
		await scheduledTaskService.listRuns(c.req.param("id"), {
			...query,
			principal: narratorPrincipalOf(c),
		}),
	);
});

scheduledTaskRoutes.post("/:id/cleanup", async (c) => {
	const task = await scheduledTaskService.detail(c.req.param("id"), narratorPrincipalOf(c));
	if (!task.capabilities.canEdit) throw new ForbiddenError();
	return c.json(await cleanupScheduledTaskNarrators(task.id));
});

scheduledTaskRoutes.post("/:id/transfer", async (c) => {
	const { ownerUserId } = parse(
		z.object({ ownerUserId: z.string().min(1).max(100) }),
		await c.req.json(),
	);
	return c.json(
		await scheduledTaskService.transfer(c.req.param("id"), ownerUserId, narratorPrincipalOf(c)),
	);
});

scheduledTaskRoutes.delete("/:id", async (c) => {
	await scheduledTaskService.delete(c.req.param("id"), narratorPrincipalOf(c));
	return c.json({ ok: true });
});
