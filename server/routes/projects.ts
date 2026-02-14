import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { chapters, projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { createProjectSchema, updateProjectSchema } from "../lib/validators";
import { chapterService } from "../services/chapter-service";
import { gitService } from "../services/git-service";

export const projectRoutes = new Hono();

const validStatuses = ["active", "archived"] as const;

projectRoutes.get("/", async (c) => {
	const status = c.req.query("status");
	const where =
		status && validStatuses.includes(status as any)
			? eq(projects.status, status as (typeof validStatuses)[number])
			: undefined;
	const result = await db.query.projects.findMany({
		where,
		orderBy: (projects, { desc }) => [desc(projects.updatedAt)],
	});
	return c.json(result);
});

projectRoutes.post("/", async (c) => {
	const parsed = createProjectSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const body = parsed.data;

	const now = new Date().toISOString();
	const projectId = generateId();

	let gitPath = body.gitPath?.trim() || null;
	let remoteUrl: string | null = null;
	let defaultBranch = body.defaultBranch ?? "main";
	const mode = body.repoMode;

	if (mode === "existing" && gitPath) {
		if (!(await gitService.isGitRepo(gitPath))) {
			throw new ValidationError(`Path is not a git repository: ${gitPath}`);
		}
	} else if (mode === "init" && gitPath) {
		await gitService.initRepo(gitPath);
		const detectedBranch = await gitService.getCurrentBranch(gitPath);
		defaultBranch = body.defaultBranch ?? detectedBranch ?? "main";
	} else if (mode === "clone" && body.cloneUrl && gitPath) {
		await gitService.cloneRepo(body.cloneUrl, gitPath, body.cloneBranch);
		const detectedBranch = await gitService.getCurrentBranch(gitPath);
		remoteUrl = body.cloneUrl;
		defaultBranch = body.cloneBranch ?? detectedBranch ?? "main";
	} else if (!mode) {
		gitPath = null;
	} else if (mode) {
		throw new ValidationError(
			`gitPath is required when repoMode is "${mode}"${mode === "clone" ? " (cloneUrl is also required)" : ""}`,
		);
	}

	const [project] = await db
		.insert(projects)
		.values({
			id: projectId,
			name: body.name,
			description: body.description,
			gitPath,
			remoteUrl,
			defaultBranch,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	return c.json(project, 201);
});

projectRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, id),
	});
	if (!project) throw new NotFoundError("Project", id);
	return c.json(project);
});

projectRoutes.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const parsed = updateProjectSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const body = parsed.data;

	const now = new Date().toISOString();
	const [updated] = await db
		.update(projects)
		.set({ ...body, updatedAt: now })
		.where(eq(projects.id, id))
		.returning();
	if (!updated) throw new NotFoundError("Project", id);
	return c.json(updated);
});

projectRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	// Cascade: remove chapters (which cascade-deletes narrators, messages, etc.)
	const projectChapters = await db.query.chapters.findMany({
		where: eq(chapters.projectId, id),
	});
	for (const chapter of projectChapters) {
		await chapterService.remove(chapter.id);
	}
	await db.delete(projects).where(eq(projects.id, id));
	return c.json({ ok: true });
});
