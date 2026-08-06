import { resolve } from "node:path";
import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, projects } from "../db/schema";
import { chapterLock } from "../lib/async-mutex";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { chapterEdgeService } from "./chapter-edge-service";
import { clearedSnapshotMergeFields } from "./chapter-merge";
import { restoreSourceSnapshot } from "./chapter-merge-snapshot";
import { ensureChapterSnapshot } from "./chapter-snapshot-ref";
import { commitSyncService } from "./commit-sync-service";
import { containerService } from "./container-service";
import { gitService } from "./git-service";
import { terminalService } from "./terminal-service";
import { worktreeWatcher } from "./worktree-watcher";

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
		return chapterLock.acquire(chapterId, async () => {
			const chapter = await db.query.chapters.findFirst({
				where: eq(chapters.id, chapterId),
			});
			if (!chapter) throw new NotFoundError("Chapter", chapterId);
			if (chapter.isRoot) throw new ValidationError("Cannot make root chapter dormant");
			if (chapter.status !== "active")
				throw new ValidationError("Can only make active chapters dormant");
			if (!chapter.worktreePath) throw new ValidationError("Chapter has no worktree");

			const gitPath = await getProjectGitPath(chapter.projectId);
			if (!gitPath) throw new ValidationError("Project has no git repository configured");

			// Step 1: Clean up terminals
			await terminalService.cleanupForChapter(chapterId);

			// Step 2: Pause containers — fail loudly if config exists but pause fails
			if (chapter.containerConfig) {
				try {
					await containerService.pauseChapterContainers(chapterId);
				} catch (err) {
					logger.warn("Failed to pause containers during dormant", {
						chapterId,
						error: String(err),
					});
					// Still proceed — containers may have been removed externally
				}
			}

			// Step 2.5: Record the workspace in the snapshot DAG before anything removes
			// it. The auto-commit below is allowed to fail (see the recovery block, which
			// ends in "Proceed anyway"), and the worktree is then deleted regardless — so
			// without a snapshot taken here, a chapter that went dormant with a failing
			// commit loses every uncommitted byte with no record of them anywhere.
			//
			// Taken BEFORE the commit rather than after so it captures the workspace as the
			// user left it, including files the commit would not pick up.
			const dormantSnapshot = await ensureChapterSnapshot(
				chapter.worktreePath,
				"state before going dormant",
			);
			if (!dormantSnapshot) {
				logger.warn("Could not snapshot a chapter's workspace before making it dormant", {
					chapterId,
					worktreePath: chapter.worktreePath,
				});
			}

			// Step 3: Auto-commit with conflict recovery
			//
			// `commitFailed` decides whether the snapshot above is still needed on wake. When
			// the commit succeeds the branch tip carries the work, and restoring a snapshot
			// on top would be a pointless (and slightly risky) rewrite of a clean worktree.
			// When it fails, that snapshot is the ONLY copy.
			let commitFailed = false;
			try {
				await gitService.autoCommit(chapter.worktreePath, "auto-save before dormant");
			} catch (commitErr) {
				// If worktree has merge conflicts, abort merge and retry
				logger.warn("Auto-commit failed, attempting conflict recovery", {
					chapterId,
					error: String(commitErr),
				});
				try {
					await gitService.mergeAbort(chapter.worktreePath);
					await gitService.autoCommit(
						chapter.worktreePath,
						"auto-save before dormant (after merge abort)",
					);
				} catch (recoveryErr) {
					logger.error("Conflict recovery failed during dormant", {
						chapterId,
						error: String(recoveryErr),
					});
					// Proceed anyway — worktree will be removed, branch state preserved
					commitFailed = true;
				}
			}

			// Step 4: Stop file watcher before removing worktree
			worktreeWatcher.unwatchAll(chapter.worktreePath);

			// Step 5: Remove worktree BEFORE updating DB
			// This ensures we don't lose the worktreePath reference if removal fails
			try {
				await gitService.removeWorktree(gitPath, chapter.worktreePath);
			} catch (err) {
				// Worktree removal failed — still mark as dormant since terminals
				// are already cleaned and containers paused. The stale worktree
				// directory can be cleaned up manually or on next wake.
				logger.warn("Worktree removal failed during dormant, proceeding anyway", {
					chapterId,
					worktreePath: chapter.worktreePath,
					error: String(err),
				});
			}

			// Step 6: Update DB — external resources already cleaned
			const now = new Date().toISOString();
			await db
				.update(chapters)
				.set({
					status: "dormant",
					worktreePath: null,
					// Recorded only when the commit failed, so it means exactly one thing:
					// "the branch does not carry this chapter's work, the snapshot does".
					// Waking reads it to decide whether a restore is needed at all, and a
					// value written after a SUCCESSFUL commit would make every wake rewrite
					// a worktree that git had already restored correctly.
					...(commitFailed && dormantSnapshot
						? { dormantSnapshotCommitSha: dormantSnapshot.commitSha }
						: {}),
					updatedAt: now,
				})
				.where(eq(chapters.id, chapterId));

			logger.info("Chapter made dormant", { chapterId });
			eventBus.emit({ type: "chapter:dormant", chapterId });
		});
	},

	async wake(chapterId: string): Promise<void> {
		return chapterLock.acquire(chapterId, async () => {
			const chapter = await db.query.chapters.findFirst({
				where: eq(chapters.id, chapterId),
			});
			if (!chapter) throw new NotFoundError("Chapter", chapterId);
			if (chapter.status !== "dormant" && chapter.status !== "merged")
				throw new ValidationError("Can only wake dormant or merged chapters");

			const gitPath = await getProjectGitPath(chapter.projectId);
			if (!gitPath) throw new ValidationError("Project has no git repository configured");

			const branchSuffix = chapter.branch.split("/").slice(1).join("/");
			const worktreePath = resolve(gitPath, ".worktrees", branchSuffix);

			// Step 1: Create worktree
			await gitService.createWorktree(gitPath, worktreePath, chapter.branch);

			// Step 1.5: Put back the uncommitted work the branch does not carry.
			//
			// Two ways a chapter can hold state its branch tip does not:
			//   - it was merged without a commit, so the merge never advanced the branch and
			//     `mergedSourceSnapshotSha` is the only copy of what it contributed;
			//   - it went dormant while the auto-commit failed, which `dormant` explicitly
			//     tolerates ("Proceed anyway") before deleting the worktree — leaving the
			//     snapshot taken at that point as the only copy.
			//
			// The merge coordinate wins when both exist: it names the state that was actually
			// merged away, which is what waking a merged chapter is expected to hand back.
			// `restoreSourceSnapshot` verifies the commit against the shadow repository and
			// reports rather than throws, so a pruned or missing snapshot degrades to "you got
			// the last commit" instead of failing the wake.
			const restoreTarget = chapter.mergedSourceSnapshotSha ?? chapter.dormantSnapshotCommitSha;
			if (restoreTarget) {
				const restored = await restoreSourceSnapshot(worktreePath, restoreTarget);
				if (!restored.restored) {
					logger.warn("Wake could not restore the chapter's uncommitted work", {
						chapterId,
						snapshot: restoreTarget,
						reason: restored.reason,
					});
				}
			}

			// Step 2: Update DB — if this fails, clean up the orphan worktree
			const now = new Date().toISOString();
			try {
				await db
					.update(chapters)
					.set({
						status: "active",
						worktreePath,
						lastAccessedAt: now,
						updatedAt: now,
						// The dormant snapshot has been consumed (or was found unrestorable), and
						// the chapter now has a live worktree whose state is tracked by
						// `snapshotCommitSha`. Cleared so it keeps meaning "the branch is missing
						// this chapter's work": left behind, a LATER dormant cycle whose commit
						// succeeded would still find this stale value and restore an old workspace
						// over the one git had just restored correctly.
						dormantSnapshotCommitSha: null,
						// Clear merge metadata when waking a merged chapter. Every coordinate of
						// the dissolved merge has to go, snapshot ones included: `unmerge` routes
						// on `mergeSnapshotCommitSha`, so a leftover value would later send it
						// down the snapshot path with coordinates for a merge that no longer
						// exists. `preMergeTargetSha` was already being missed here.
						...(chapter.status === "merged"
							? {
									mergedIntoChapterId: null,
									mergeCommitSha: null,
									mergeStrategy: null,
									preMergeTargetSha: null,
									...clearedSnapshotMergeFields(),
								}
							: {}),
					})
					.where(eq(chapters.id, chapterId));
			} catch (dbErr) {
				logger.error("DB update failed during wake, removing orphan worktree", {
					chapterId,
					error: String(dbErr),
				});
				try {
					await gitService.removeWorktree(gitPath, worktreePath);
				} catch (cleanupErr) {
					logger.error("Failed to clean up orphan worktree", {
						chapterId,
						worktreePath,
						error: String(cleanupErr),
					});
				}
				throw dbErr;
			}

			// Step 3: Remove merge edges when waking a merged chapter
			if (chapter.status === "merged") {
				try {
					await chapterEdgeService.deleteMergeEdgesBySource(chapterId);
				} catch (err) {
					logger.warn("Failed to remove merge edges during wake", {
						chapterId,
						error: String(err),
					});
				}
			}

			// Step 4: Restore containers (non-fatal — chapter is already usable)
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

			// Sync commits that may have been added externally while dormant
			try {
				await commitSyncService.syncChapterCommits(chapterId);
			} catch (err) {
				logger.warn("Failed to sync commits after wake (non-fatal)", {
					chapterId,
					error: String(err),
				});
			}
		});
	},

	async batchCleanup(
		chapterIds: string[],
		options: { force?: boolean; deleteBranch?: boolean } = {},
	): Promise<CleanupReport> {
		const report: CleanupReport = { cleaned: [], skipped: [], errors: [] };

		for (const chapterId of chapterIds) {
			try {
				const chapter = await db.query.chapters.findFirst({
					where: eq(chapters.id, chapterId),
				});
				if (!chapter) {
					report.errors.push({ chapterId, error: "Not found" });
					continue;
				}
				if (chapter.isRoot) {
					report.skipped.push(chapterId);
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

				eventBus.emit({ type: "chapter:abandoned", chapterId, projectId: chapter.projectId });
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

		const active = activeChapters.filter(
			(c) => c.status === "active" && c.worktreePath && !c.isRoot,
		);
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
		const existing = this._dormantTimers.get(projectId);
		if (existing) clearTimeout(existing);

		// When disabled, clean up any existing timer and return
		if (settings.chapters.maxActiveWorktrees <= 0) {
			this._dormantTimers.delete(projectId);
			return;
		}

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

	/** Clear all pending timers (for graceful shutdown). */
	clearAllTimers(): void {
		for (const timer of this._dormantTimers.values()) {
			clearTimeout(timer);
		}
		this._dormantTimers.clear();
	},
};
