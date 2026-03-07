import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import {
	disableRoutineForProject,
	disableRoutineGlobal,
	enableRoutineForProject,
	enableRoutineGlobal,
	getGlobalRoutineStatuses,
	getProjectRoutineStatusesWithOverride,
	resetRoutineForProject,
} from "../services/routine-service";

export const routineRoutes = new Hono();

/** List all built-in routines with global enabled status. */
routineRoutes.get("/", (c) => {
	return c.json({ routines: getGlobalRoutineStatuses() });
});

/** Toggle a routine globally. */
routineRoutes.post("/:id/toggle", async (c) => {
	const routineId = c.req.param("id");
	const body = await c.req.json<{ enabled: boolean }>();
	if (typeof body.enabled !== "boolean") {
		throw new ValidationError("enabled must be a boolean");
	}

	const userId = c.get("user").sub;
	if (body.enabled) {
		await enableRoutineGlobal(routineId, userId);
	} else {
		await disableRoutineGlobal(routineId, userId);
	}

	return c.json({ ok: true });
});

/** List all built-in routines with project-level status. */
routineRoutes.get("/project/:projectId", async (c) => {
	const projectId = c.req.param("projectId");
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
		columns: { chapterSettings: true },
	});
	if (!project) throw new NotFoundError("Project", projectId);

	let routinesConf: { disabledRoutines?: string[]; enabledRoutines?: string[] } | undefined;
	try {
		const cs =
			typeof project.chapterSettings === "string"
				? JSON.parse(project.chapterSettings)
				: project.chapterSettings;
		routinesConf = cs?.routines;
	} catch {
		// ignore
	}

	return c.json({ routines: getProjectRoutineStatusesWithOverride(routinesConf) });
});

/** Toggle a routine for a specific project. */
routineRoutes.post("/project/:projectId/:id/toggle", async (c) => {
	const projectId = c.req.param("projectId");
	const routineId = c.req.param("id");
	const body = await c.req.json<{ action: "enable" | "disable" | "reset" }>();

	if (!["enable", "disable", "reset"].includes(body.action)) {
		throw new ValidationError("action must be 'enable', 'disable', or 'reset'");
	}

	switch (body.action) {
		case "enable":
			await enableRoutineForProject(routineId, projectId);
			break;
		case "disable":
			await disableRoutineForProject(routineId, projectId);
			break;
		case "reset":
			await resetRoutineForProject(routineId, projectId);
			break;
	}

	return c.json({ ok: true });
});
