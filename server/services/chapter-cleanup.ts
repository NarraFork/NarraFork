import { resolve } from "node:path";
import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, repositories } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { containerService } from "./container-service";
import { gitService } from "./git-service";
import { terminalService } from "./terminal-service";

export interface CleanupReport {
	cleaned: string[];
	skipped: string[];
	errors: Array<{ chapterId: string; error: string }>;
}

export const chapterCleanup = {
	/**
	 * Make a chapter dormant: auto-commit, remove worktree, keep branch.
	 */
	async dormant(chapterId: string): Promise<void> {
		const chapter = await db.query.chapters.findFirst({ where: eq(chapters.id, chapterId) });
		if (!chapter) throw new NotFoundError("Chapter", chapterId);
		if (chapter.status !== "active")
			throw new ValidationError("Can only make active chapters dormant");
		if (!chapter.worktreePath) throw new ValidationError("Chapter has no worktree");

		const repo = await db.query.repositories.findFirst({
			where: eq(repositories.id, chapter.repositoryId),
		});
		if (!repo) throw new NotFoundError("Repository", chapter.repositoryId);

		// Kill terminals
		await terminalService.cleanupForChapter(chapterId);

		// Pause containers (if any)
		if (chapter.containerConfig) {
			try {
				await containerService.pauseChapterContainers(chapterId);
			} catch (err) {
				logger.warn("Failed to pause containers during dormant", {
					chapterId,
					error: String(err),
				});
			}
		}

		// Auto-commit uncommitted changes
		await gitService.autoCommit(chapter.worktreePath, "auto-save before dormant");

		// Remove worktree (keep branch)
		await gitService.removeWorktree(repo.path, chapter.worktreePath);

		const now = new Date().toISOString();
		await db
			.update(chapters)
			.set({ status: "dormant", worktreePath: null, updatedAt: now })
			.where(eq(chapters.id, chapterId));

		logger.info("Chapter made dormant", { chapterId });
		eventBus.emit({ type: "chapter:dormant", chapterId });
	},

	/**
	 * Wake a dormant chapter: recreate worktree from existing branch.
	 */
	async wake(chapterId: string): Promise<void> {
		const chapter = await db.query.chapters.findFirst({ where: eq(chapters.id, chapterId) });
		if (!chapter) throw new NotFoundError("Chapter", chapterId);
		if (chapter.status !== "dormant") throw new ValidationError("Can only wake dormant chapters");

		const repo = await db.query.repositories.findFirst({
			where: eq(repositories.id, chapter.repositoryId),
		});
		if (!repo) throw new NotFoundError("Repository", chapter.repositoryId);

		// Reconstruct worktree path from branch name
		const branchSuffix = chapter.branch.split("/").slice(1).join("/");
		const worktreePath = resolve(repo.path, ".worktrees", branchSuffix);

		await gitService.createWorktree(repo.path, worktreePath, chapter.branch);

		const now = new Date().toISOString();
		await db
			.update(chapters)
			.set({ status: "active", worktreePath, lastAccessedAt: now, updatedAt: now })
			.where(eq(chapters.id, chapterId));

		// Restart containers (if chapter has containerConfig)
		if (chapter.containerConfig) {
			try {
				await containerService.unpauseChapterContainers(chapterId);
			} catch (err) {
				logger.warn("Failed to unpause containers during wake", {
					chapterId,
					error: String(err),
				});
			}
		}

		logger.info("Chapter woken", { chapterId, worktreePath });
		eventBus.emit({ type: "chapter:woken", chapterId });
	},

	/**
	 * Batch cleanup chapters. Skips chapters with uncommitted changes unless force=true.
	 */
	async batchCleanup(
		chapterIds: string[],
		options: { force?: boolean; deleteBranch?: boolean } = {},
	): Promise<CleanupReport> {
		const report: CleanupReport = { cleaned: [], skipped: [], errors: [] };

		for (const chapterId of chapterIds) {
			try {
				const chapter = await db.query.chapters.findFirst({ where: eq(chapters.id, chapterId) });
				if (!chapter) {
					report.errors.push({ chapterId, error: "Not found" });
					continue;
				}
				if (chapter.status === "merged" || chapter.status === "abandoned") {
					report.skipped.push(chapterId);
					continue;
				}

				const repo = await db.query.repositories.findFirst({
					where: eq(repositories.id, chapter.repositoryId),
				});
				if (!repo) {
					report.errors.push({ chapterId, error: "Repository not found" });
					continue;
				}

				// Dirty check
				if (chapter.worktreePath && !options.force) {
					const status = await gitService.getStatus(chapter.worktreePath);
					if (status) {
						report.skipped.push(chapterId);
						continue;
					}
				}

				// Kill terminals
				await terminalService.cleanupForChapter(chapterId);

				// Stop and remove containers
				if (chapter.containerConfig) {
					try {
						await containerService.removeChapterContainers(chapterId, {
							deleteVolumes: options.deleteBranch,
						});
					} catch (err) {
						logger.warn("Failed to remove containers during cleanup", {
							chapterId,
							error: String(err),
						});
					}
				}

				// Remove worktree
				if (chapter.worktreePath) {
					try {
						await gitService.removeWorktree(repo.path, chapter.worktreePath);
					} catch (err) {
						logger.warn("Failed to remove worktree during cleanup", {
							chapterId,
							error: String(err),
						});
					}
				}

				// Optionally delete branch
				if (options.deleteBranch) {
					try {
						await gitService.deleteBranch(repo.path, chapter.branch);
					} catch (err) {
						logger.warn("Failed to delete branch during cleanup", {
							chapterId,
							error: String(err),
						});
					}
				}

				// Update status
				const now = new Date().toISOString();
				await db
					.update(chapters)
					.set({ status: "abandoned", worktreePath: null, updatedAt: now })
					.where(eq(chapters.id, chapterId));

				eventBus.emit({ type: "chapter:abandoned", chapterId });
				report.cleaned.push(chapterId);
			} catch (err) {
				report.errors.push({ chapterId, error: String(err) });
			}
		}

		logger.info("Batch cleanup completed", report);
		return report;
	},

	/**
	 * Auto-dormant inactive chapters when active count exceeds maxActiveWorktrees.
	 * Sorts by lastAccessedAt ascending (least recently used first).
	 */
	async dormantInactiveChapters(projectId: string): Promise<string[]> {
		const maxActive = settings.chapters.maxActiveWorktrees;

		const activeChapters = await db.query.chapters.findMany({
			where: eq(chapters.projectId, projectId),
			orderBy: [asc(chapters.lastAccessedAt)],
		});

		const active = activeChapters.filter((c) => c.status === "active" && c.worktreePath);
		if (active.length <= maxActive) return [];

		const toDormant = active.slice(0, active.length - maxActive);
		const dormanted: string[] = [];

		for (const chapter of toDormant) {
			try {
				await this.dormant(chapter.id);
				dormanted.push(chapter.id);
			} catch (err) {
				logger.warn("Failed to auto-dormant chapter", {
					chapterId: chapter.id,
					error: String(err),
				});
			}
		}

		if (dormanted.length > 0) {
			logger.info("Auto-dormanted inactive chapters", { projectId, count: dormanted.length });
		}
		return dormanted;
	},
};
