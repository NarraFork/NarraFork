import { resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { chapters, containerInstances, narrators, portAllocations, projects } from "../db/schema";
import { chapterLock } from "../lib/async-mutex";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { slugify } from "../lib/slug";
import { chapterCleanup } from "./chapter-cleanup";
import { commitSyncService } from "./commit-sync-service";
import { containerService } from "./container-service";
import { gitService } from "./git-service";
import { narratorService } from "./narrator-service";
import { terminalService } from "./terminal-service";

interface ChapterSettings {
	autoCreateNarrator?: boolean;
	autoForkNarrators?: boolean;
}

const DEFAULT_CHAPTER_SETTINGS: ChapterSettings = {
	autoCreateNarrator: true,
	autoForkNarrators: true,
};

/** Resolve chapter settings from project, merging with defaults. */
export function resolveChapterSettings(projectSettings: unknown): Required<ChapterSettings> {
	const raw = (projectSettings ?? {}) as ChapterSettings;
	return { ...DEFAULT_CHAPTER_SETTINGS, ...raw } as Required<ChapterSettings>;
}

interface CreateChapterInput {
	projectId: string;
	title: string;
	description?: string;
	baseBranch?: string;
}

interface CreateRootChapterInput {
	projectId: string;
	title: string;
	gitPath: string;
	defaultBranch: string;
}

export const chapterService = {
	/**
	 * Create the root chapter for a project — represents the project's own git directory.
	 * No worktree or branch is created; it uses the project's gitPath and defaultBranch directly.
	 */
	async createRootChapter(input: CreateRootChapterInput) {
		const now = new Date().toISOString();
		const id = generateId();

		const [chapter] = await db
			.insert(chapters)
			.values({
				id,
				projectId: input.projectId,
				title: input.title,
				status: "active",
				role: "trunk",
				branch: input.defaultBranch,
				worktreePath: input.gitPath,
				baseBranch: input.defaultBranch,
				isRoot: 1,
				lastAccessedAt: now,
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		// Auto-create primary narrator if project setting enabled
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, input.projectId),
		});
		const chSettings = resolveChapterSettings(project?.chapterSettings);
		if (chSettings.autoCreateNarrator) {
			try {
				await narratorService.create({
					chapterId: id,
					type: "primary",
					model: settings.agent.defaultModel,
				});
			} catch (err) {
				logger.warn("Failed to auto-create primary narrator for root chapter", {
					chapterId: id,
					error: String(err),
				});
			}
		}

		logger.info("Root chapter created", { id, projectId: input.projectId });
		eventBus.emit({ type: "chapter:created", chapterId: id, projectId: input.projectId });

		// Sync existing commit history for the root chapter
		try {
			await commitSyncService.syncChapterCommits(id);
		} catch (err) {
			logger.warn("Failed to sync commits for root chapter (non-fatal)", {
				chapterId: id,
				error: String(err),
			});
		}

		return chapter;
	},

	async create(input: CreateChapterInput) {
		const now = new Date().toISOString();
		const id = generateId();

		const project = await db.query.projects.findFirst({
			where: eq(projects.id, input.projectId),
		});
		if (!project) throw new NotFoundError("Project", input.projectId);
		if (!project.gitPath) throw new ValidationError("Project has no git repository configured");

		const gitPath = project.gitPath;
		if (!(await gitService.isGitRepo(gitPath))) {
			throw new ValidationError(`Path is not a git repository: ${gitPath}`);
		}

		let baseBranch = input.baseBranch ?? project.defaultBranch ?? "main";
		if (!(await gitService.branchExists(gitPath, baseBranch))) {
			baseBranch = await gitService.getCurrentBranch(gitPath);
		}
		const slug = slugify(input.title);
		const shortId = generateShortId(6);
		const branchName = `chapter/${slug}-${shortId}`;
		const worktreePath = resolve(gitPath, ".worktrees", `${slug}-${shortId}`);

		const rollback: Array<() => Promise<void>> = [];

		try {
			await gitService.createBranch(gitPath, branchName, baseBranch);
			rollback.push(() => gitService.deleteBranch(gitPath, branchName));

			await gitService.createWorktree(gitPath, worktreePath, branchName);
			rollback.push(() => gitService.removeWorktree(gitPath, worktreePath));

			const [chapter] = await db
				.insert(chapters)
				.values({
					id,
					projectId: input.projectId,
					title: input.title,
					description: input.description,
					status: "active",
					branch: branchName,
					worktreePath,
					baseBranch,
					lastAccessedAt: now,
					createdAt: now,
					updatedAt: now,
				})
				.returning();

			// Auto-create primary narrator if project setting enabled
			const chSettings = resolveChapterSettings(project.chapterSettings);
			if (chSettings.autoCreateNarrator) {
				try {
					await narratorService.create({
						chapterId: id,
						type: "primary",
						model: settings.agent.defaultModel,
					});
				} catch (err) {
					logger.warn("Failed to auto-create primary narrator", {
						chapterId: id,
						error: String(err),
					});
				}
			}

			logger.info("Chapter created", { id, branch: branchName, worktreePath });
			eventBus.emit({ type: "chapter:created", chapterId: id, projectId: input.projectId });
			chapterCleanup.scheduleAutoDormant(input.projectId);

			// Sync commit history for the new chapter
			try {
				await commitSyncService.syncChapterCommits(id);
			} catch (err) {
				logger.warn("Failed to sync commits for new chapter (non-fatal)", {
					chapterId: id,
					error: String(err),
				});
			}

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

	async findById(id: string) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, id),
		});
		if (!chapter) throw new NotFoundError("Chapter", id);
		return chapter;
	},

	async getById(id: string) {
		const chapter = await this.findById(id);

		// Touch lastAccessedAt and schedule auto-dormant check
		if (chapter.status === "active") {
			const now = new Date().toISOString();
			await db.update(chapters).set({ lastAccessedAt: now }).where(eq(chapters.id, id));
			chapterCleanup.scheduleAutoDormant(chapter.projectId);
		}

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
			role: "trunk" | "branch" | "exploration";
			color: string | null;
			groupLabel: string | null;
		}>,
	) {
		return chapterLock.acquire(id, async () => {
			const existing = await this.findById(id);

			// Root chapters: only title and description can be changed
			if (existing.isRoot) {
				if (data.status !== undefined) {
					throw new ValidationError("Cannot change root chapter status");
				}
				if (data.role !== undefined) {
					throw new ValidationError("Cannot change root chapter role");
				}
			}

			const now = new Date().toISOString();
			const set: Record<string, unknown> = { updatedAt: now };
			if (data.title !== undefined) set.title = data.title;
			if (data.description !== undefined) set.description = data.description;
			if (data.status !== undefined) set.status = data.status;
			if (data.role !== undefined) set.role = data.role;
			if (data.color !== undefined) set.color = data.color;
			if (data.groupLabel !== undefined) set.groupLabel = data.groupLabel;

			const [updated] = await db.update(chapters).set(set).where(eq(chapters.id, id)).returning();
			if (!updated) throw new NotFoundError("Chapter", id);
			return updated;
		});
	},

	async remove(id: string) {
		return chapterLock.acquire(id, async () => {
			const chapter = await this.findById(id);

			if (chapter.isRoot) {
				throw new ValidationError("Cannot delete root chapter");
			}

			// Unbind narrators instead of deleting them — preserve conversation history.
			// Subagents and archived narrators are deleted; others are detached.
			const chapterNarrators = await db.query.narrators.findMany({
				where: eq(narrators.chapterId, id),
			});

			const toDelete = chapterNarrators.filter(
				(n) => n.type === "subagent" || n.status === "archived",
			);
			const toDetach = chapterNarrators.filter(
				(n) => n.type !== "subagent" && n.status !== "archived",
			);

			for (const narrator of toDelete) {
				await narratorService.remove(narrator.id);
			}

			if (toDetach.length > 0) {
				const now = new Date().toISOString();
				await db
					.update(narrators)
					.set({
						chapterId: null,
						// Preserve worktree path as cwd so the narrator retains a working directory
						cwd: chapter.worktreePath ?? narrators.cwd,
						updatedAt: now,
					})
					.where(
						inArray(
							narrators.id,
							toDetach.map((n) => n.id),
						),
					);
				logger.info("Detached narrators from chapter", {
					chapterId: id,
					detached: toDetach.map((n) => n.id),
				});
			}

			// Kill running terminals and delete records
			await terminalService.cleanupForChapter(id);

			// Stop and remove containers (+ release ports)
			try {
				await containerService.removeChapterContainers(id, { deleteVolumes: true });
			} catch (err) {
				logger.warn("Failed to remove containers during chapter delete", {
					chapterId: id,
					error: String(err),
				});
				// Fall back to DB-only cleanup
				await db.delete(containerInstances).where(eq(containerInstances.chapterId, id));
				await db.delete(portAllocations).where(eq(portAllocations.chapterId, id));
			}

			// Clean up git resources
			if (chapter.worktreePath) {
				const project = await db.query.projects.findFirst({
					where: eq(projects.id, chapter.projectId),
				});
				if (project?.gitPath) {
					try {
						await gitService.removeWorktree(project.gitPath, chapter.worktreePath);
						await gitService.deleteBranch(project.gitPath, chapter.branch);
					} catch (err) {
						logger.warn("Failed to clean up git resources", {
							error: String(err),
						});
					}
				}
			}

			// Detach self-referencing FKs pointing to this chapter
			await db
				.update(chapters)
				.set({ parentChapterId: null })
				.where(eq(chapters.parentChapterId, id));
			await db
				.update(chapters)
				.set({ mergedIntoChapterId: null })
				.where(eq(chapters.mergedIntoChapterId, id));

			await db.delete(chapters).where(eq(chapters.id, id));
			eventBus.emit({ type: "chapter:abandoned", chapterId: id });
		});
	},
};
