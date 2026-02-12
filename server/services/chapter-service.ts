import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, repositories } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { gitService } from "./git-service";

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 30);
}

interface CreateChapterInput {
	projectId: string;
	repositoryId: string;
	title: string;
	description?: string;
	type?: "meanwhile" | "whatif";
	baseBranch?: string;
}

export const chapterService = {
	async create(input: CreateChapterInput) {
		const now = new Date().toISOString();
		const id = generateId();

		const repo = await db.query.repositories.findFirst({
			where: eq(repositories.id, input.repositoryId),
		});
		if (!repo) throw new NotFoundError("Repository", input.repositoryId);

		if (!(await gitService.isGitRepo(repo.path))) {
			throw new ValidationError(`Path is not a git repository: ${repo.path}`);
		}

		const type = input.type ?? "meanwhile";
		const baseBranch = input.baseBranch ?? repo.defaultBranch ?? "main";
		const slug = slugify(input.title);
		const shortId = generateShortId(6);
		const branchName = `${type}/${slug}-${shortId}`;
		const worktreePath = resolve(repo.path, ".worktrees", `${slug}-${shortId}`);

		const rollback: Array<() => Promise<void>> = [];

		try {
			await gitService.createBranch(repo.path, branchName, baseBranch);
			rollback.push(() => gitService.deleteBranch(repo.path, branchName));

			await gitService.createWorktree(repo.path, worktreePath, branchName);
			rollback.push(() => gitService.removeWorktree(repo.path, worktreePath));

			const [chapter] = await db
				.insert(chapters)
				.values({
					id,
					projectId: input.projectId,
					repositoryId: input.repositoryId,
					title: input.title,
					description: input.description,
					type,
					status: "active",
					branch: branchName,
					worktreePath,
					baseBranch,
					lastAccessedAt: now,
					createdAt: now,
					updatedAt: now,
				})
				.returning();

			logger.info("Chapter created", { id, branch: branchName, worktreePath });
			eventBus.emit({ type: "chapter:created", chapterId: id, projectId: input.projectId });
			return chapter;
		} catch (err) {
			logger.error("Chapter creation failed, rolling back", { error: String(err) });
			for (const fn of rollback.reverse()) {
				try {
					await fn();
				} catch (rollbackErr) {
					logger.error("Rollback step failed", { error: String(rollbackErr) });
				}
			}
			throw err;
		}
	},

	async getById(id: string) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, id),
		});
		if (!chapter) throw new NotFoundError("Chapter", id);
		return chapter;
	},

	async listByProject(projectId: string, status?: string) {
		const validStatuses = ["active", "dormant", "merged", "abandoned"] as const;
		type ChapterStatus = (typeof validStatuses)[number];
		const where =
			status && validStatuses.includes(status as ChapterStatus)
				? and(eq(chapters.projectId, projectId), eq(chapters.status, status as ChapterStatus))
				: eq(chapters.projectId, projectId);
		return db.query.chapters.findMany({
			where,
			orderBy: (chapters, { desc }) => [desc(chapters.updatedAt)],
		});
	},

	async update(
		id: string,
		data: Partial<{
			title: string;
			description: string;
			status: "active" | "dormant" | "merged" | "abandoned";
		}>,
	) {
		const now = new Date().toISOString();
		const set: Record<string, unknown> = { updatedAt: now };
		if (data.title !== undefined) set.title = data.title;
		if (data.description !== undefined) set.description = data.description;
		if (data.status !== undefined) set.status = data.status;

		const [updated] = await db.update(chapters).set(set).where(eq(chapters.id, id)).returning();
		if (!updated) throw new NotFoundError("Chapter", id);
		return updated;
	},

	async remove(id: string) {
		const chapter = await this.getById(id);
		if (chapter.worktreePath) {
			const repo = await db.query.repositories.findFirst({
				where: eq(repositories.id, chapter.repositoryId),
			});
			if (repo) {
				try {
					await gitService.removeWorktree(repo.path, chapter.worktreePath);
					await gitService.deleteBranch(repo.path, chapter.branch);
				} catch (err) {
					logger.warn("Failed to clean up git resources", { error: String(err) });
				}
			}
		}
		await db.delete(chapters).where(eq(chapters.id, id));
		eventBus.emit({ type: "chapter:abandoned", chapterId: id });
	},
};
