import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, gt, or } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { chapters, narrators, projects } from "../db/schema";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { narratorPrincipalOf } from "../lib/narrator-access";
import { getHome } from "../lib/platform";
import { requireProjectAccess } from "../lib/project-access";
import { getProjectDbPath } from "../lib/project-db";
import { importProjectSchema } from "../lib/validators";
import { planNarratorBackup } from "../services/narrator-backup/runtime";
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

	// Project manage/read is not ownership of each private narrator. Validate the entire
	// individually-authorized closure before writing a legacy complete export.
	const narratorIds: string[] = [];
	let after = "";
	for (;;) {
		const page = await db
			.select({ id: narrators.id })
			.from(narrators)
			.leftJoin(chapters, eq(chapters.id, narrators.chapterId))
			.where(
				and(
					or(eq(chapters.projectId, id), eq(narrators.contextProjectId, id)),
					gt(narrators.id, after),
				),
			)
			.orderBy(narrators.id)
			.limit(500);
		if (!page.length) break;
		narratorIds.push(...page.map((row) => row.id));
		if (narratorIds.length > 100_000)
			throw new ValidationError("Project backup selection exceeds row budget");
		after = page.at(-1)?.id ?? after;
	}
	if (narratorIds.length) {
		try {
			await planNarratorBackup(
				narratorPrincipalOf(c),
				{ narratorIds, profile: "conversation-state-v1" },
				c.req.raw.signal,
			);
		} catch {
			throw new AppError(
				"Project backup closure requires narrator owner/admin authority",
				403,
				"PROJECT_BACKUP_FORBIDDEN",
			);
		}
	}
	const result = await fullSync(id, {
		signal: c.req.raw.signal,
		actor: narratorPrincipalOf(c),
		worker: true,
	});
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

	const result = await importProject(
		gitPath,
		{},
		{
			actor: narratorPrincipalOf(c),
			signal: c.req.raw.signal,
			worker: true,
		},
	);
	return c.json(result, result.skipped ? 200 : 201);
});
