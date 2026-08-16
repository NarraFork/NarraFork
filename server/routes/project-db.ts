import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { getHome } from "../lib/platform";
import { requireProjectAccess } from "../lib/project-access";
import { getProjectDbPath } from "../lib/project-db";
import { importProjectSchema } from "../lib/validators";
import { fullSync } from "../services/project-db-sync";
import { importProject } from "../services/project-import";

export const projectDbRoutes = new Hono();

/** POST /api/projects/:id/backup/sync — Trigger full sync to project DB. */
projectDbRoutes.post("/:id/backup/sync", async (c) => {
	// Backing up a project's database is a project-management operation: the dump
	// contains everything in it.
	await requireProjectAccess(c, c.req.param("id"), "manage");
	const id = c.req.param("id");
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, id),
		columns: { id: true, gitPath: true },
	});
	if (!project) throw new NotFoundError("Project", id);
	if (!project.gitPath) throw new ValidationError("Project has no git path configured");

	const result = await fullSync(id);
	return c.json(result);
});

/** GET /api/projects/:id/backup/status — Check backup status. */
projectDbRoutes.get("/:id/backup/status", async (c) => {
	await requireProjectAccess(c, c.req.param("id"), "read");
	const id = c.req.param("id");
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, id),
		columns: { id: true, gitPath: true },
	});
	if (!project) throw new NotFoundError("Project", id);

	const dbPath = project.gitPath ? getProjectDbPath(project.gitPath) : null;
	const exists = dbPath ? existsSync(dbPath) : false;

	return c.json({ projectId: id, backupExists: exists, backupPath: dbPath });
});

/** POST /api/projects/import — Import a project from its backup DB. */
projectDbRoutes.post("/import", async (c) => {
	const parsed = importProjectSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	let gitPath = parsed.data.gitPath.trim();
	if (gitPath.startsWith("~/") || gitPath === "~") {
		gitPath = gitPath.replace("~", getHome());
	}
	gitPath = resolve(gitPath);

	if (!existsSync(gitPath)) {
		throw new ValidationError(`Path does not exist: ${gitPath}`);
	}

	const result = await importProject(gitPath);
	return c.json(result, result.skipped ? 200 : 201);
});
