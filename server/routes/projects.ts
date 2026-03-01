import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { chapters, explorationGroups, projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { projectDbManager } from "../lib/project-db";
import { createProjectSchema, updateProjectSchema } from "../lib/validators";
import { chapterService } from "../services/chapter-service";
import { gitService } from "../services/git-service";
import { ensureGitignoreEntry } from "../services/project-db-sync";

export const projectRoutes = new Hono();

const validStatuses = ["active", "archived"] as const;

projectRoutes.get("/", async (c) => {
	const status = c.req.query("status");
	const where =
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
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

	let gitPath = body.gitPath.trim();
	// Expand ~ and resolve to absolute path so worktreePath / terminal cwd are correct
	if (gitPath.startsWith("~/") || gitPath === "~") {
		gitPath = gitPath.replace("~", process.env.HOME ?? "/root");
	}
	gitPath = resolve(gitPath);

	let remoteUrl: string | null = null;
	let defaultBranch = body.defaultBranch ?? "main";
	const mode = body.repoMode;

	if (mode === "existing") {
		if (!(await gitService.isGitRepo(gitPath))) {
			throw new ValidationError(`Path is not a git repository: ${gitPath}`);
		}
	} else if (mode === "init") {
		await gitService.initRepo(gitPath);
		const detectedBranch = await gitService.getCurrentBranch(gitPath);
		defaultBranch = body.defaultBranch ?? detectedBranch ?? "main";
	} else if (mode === "clone") {
		if (!body.cloneUrl) {
			throw new ValidationError('cloneUrl is required when repoMode is "clone"');
		}
		await gitService.cloneRepo(body.cloneUrl, gitPath, body.cloneBranch);
		const detectedBranch = await gitService.getCurrentBranch(gitPath);
		remoteUrl = body.cloneUrl;
		defaultBranch = body.cloneBranch ?? detectedBranch ?? "main";
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

	// Auto-create root chapter
	try {
		await chapterService.createRootChapter({
			projectId,
			title: body.name,
			gitPath,
			defaultBranch,
		});
	} catch (err) {
		// Non-fatal — project is still usable without root chapter
		console.warn("Failed to create root chapter:", err);
	}

	// Initialize project backup DB + .gitignore
	try {
		projectDbManager.openForGitPath(projectId, gitPath);
		ensureGitignoreEntry(gitPath);
	} catch (err) {
		logger.warn("Failed to initialize project backup DB", {
			projectId,
			error: String(err),
		});
	}

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
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, id),
	});
	if (!project) throw new NotFoundError("Project", id);

	const projectChapters = await db.query.chapters.findMany({
		where: eq(chapters.projectId, id),
	});

	// Remove non-root chapters first, then root chapters — full resource cleanup for all
	const nonRoot = projectChapters.filter((ch) => !ch.isRoot);
	const root = projectChapters.filter((ch) => ch.isRoot);

	for (const chapter of nonRoot) {
		try {
			await chapterService.removeForProjectDeletion(chapter.id, project.gitPath);
		} catch (err) {
			logger.warn("Failed to remove chapter during project delete", {
				chapterId: chapter.id,
				error: String(err),
			});
		}
	}
	for (const chapter of root) {
		try {
			await chapterService.removeForProjectDeletion(chapter.id, project.gitPath);
		} catch (err) {
			logger.warn("Failed to remove root chapter during project delete", {
				chapterId: chapter.id,
				error: String(err),
			});
		}
	}

	// Clean up exploration groups (should cascade, but be explicit)
	await db.delete(explorationGroups).where(eq(explorationGroups.projectId, id));

	// Prune any leftover worktrees in the git repo
	if (project.gitPath) {
		try {
			await gitService.pruneWorktrees(project.gitPath);
		} catch (err) {
			logger.warn("Failed to prune worktrees during project delete", {
				error: String(err),
			});
		}
	}

	await db.delete(projects).where(eq(projects.id, id));
	logger.info("Project deleted", { projectId: id, name: project.name });
	return c.json({ ok: true });
});
