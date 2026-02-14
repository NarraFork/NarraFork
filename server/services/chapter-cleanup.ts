import { resolve } from "node:path";
import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, projects } from "../db/schema";
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

async function getProjectGitPath(projectId: string): Promise<string | null> {
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
	});
	return project?.gitPath ?? null;
}

export const chapterCleanup = {
	async dormant(chapterId: string): Promise<void> {
		const chapter = await db.query.chapters.findFirst({ where: eq(chapters.id, chapterId) });
		if (!chapter) throw new NotFoundError("Chapter", chapterId);
		if (chapter.status !== "active")
			throw new ValidationError("Can only make active chapters dormant");
		if (!chapter.worktreePath) throw new ValidationError("Chapter has no worktree");

		const gitPath = await getProjectGitPath(chapter.projectId);
		if (!gitPath) throw new ValidationError("Project has no git repository configured");

		await terminalService.cleanupForChapter(chapterId);

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

		await gitService.autoCommit(chapter.worktreePath, "auto-save before dormant");
		await gitService.removeWorktree(gitPath, chapter.worktreePath);

		const now = new Date().toISOString();
		await db
			.update(chapters)
			.set({ status: "dormant", worktreePath: null, updatedAt: now })
			.where(eq(chapters.id, chapterId));

		logger.info("Chapter made dormant", { chapterId });
		eventBus.emit({ type: "chapter:dormant", chapterId });
	},

	async wake(chapterId: string): Promise<void> {
		const chapter = await db.query.chapters.findFirst({ where: eq(chapters.id, chapterId) });
		if (!chapter) throw new NotFoundError("Chapter", chapterId);
		if (chapter.status !== "dormant") throw new ValidationError("Can only wake dormant chapters");

		const gitPath = await getProjectGitPath(chapter.projectId);
		if (!gitPath) throw new ValidationError("Project has no git repository configured");

		const branchSuffix = chapter.branch.split("/").slice(1).join("/");
		const worktreePath = resolve(gitPath, ".worktrees", branchSuffix);

		await gitService.createWorktree(gitPath, worktreePath, chapter.branch);

		const now = new Date().toISOString();
		await db
			.update(chapters)
			.set({ status: "active", worktreePath, lastAccessedAt: now, updatedAt: now })
			.where(eq(chapters.id, chapterId));

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

				if (chapter.worktreePath && !options.force) {
					const status = await gitService.getStatus(chapter.worktreePath);
					if (status) {
						report.skipped.push(chapterId);
						continue;
					}
				}

				await terminalService.cleanupForChapter(chapterId);

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

				const gitPath = await getProjectGitPath(chapter.projectId);

				if (chapter.worktreePath && gitPath) {
					try {
						await gitService.removeWorktree(gitPath, chapter.worktreePath);
					} catch (err) {
						logger.warn("Failed to remove worktree during cleanup", {
							chapterId,
							error: String(err),
						});
					}
				}

				if (options.deleteBranch && gitPath) {
					try {
						await gitService.deleteBranch(gitPath, chapter.branch);
					} catch (err) {
						logger.warn("Failed to delete branch during cleanup", {
							chapterId,
							error: String(err),
						});
					}
				}

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

		logger.info("Batch cleanup completed", report as unknown as Record<string, unknown>);
		return report;
	},

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

	_dormantTimers: new Map<string, ReturnType<typeof setTimeout>>(),

	scheduleAutoDormant(projectId: string): void {
		if (settings.chapters.maxActiveWorktrees <= 0) return;

		const existing = this._dormantTimers.get(projectId);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(async () => {
			this._dormantTimers.delete(projectId);
			try {
				await this.dormantInactiveChapters(projectId);
			} catch (err) {
				logger.warn("Scheduled auto-dormant failed", {
					projectId,
					error: String(err),
				});
			}
		}, 30_000);

		this._dormantTimers.set(projectId, timer);
	},
};
