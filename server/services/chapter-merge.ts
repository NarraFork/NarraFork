import { resolve } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, projects, reviewConclusions } from "../db/schema";
import { worktreeLock } from "../lib/async-mutex";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { getPrompt, type Locale } from "../lib/prompt-i18n";
import { chapterEdgeService } from "./chapter-edge-service";
import { commitSyncService } from "./commit-sync-service";
import { gitService } from "./git-service";
import { collectMergeContext, mergeSummaryService } from "./merge-summary-service";
import { startSession } from "./narrator-session";
import { terminalService } from "./terminal-service";

export interface MergeCheckResult {
	canMerge: boolean;
	hasConflicts: boolean;
	conflictFiles: string[];
	sourceBranch: string;
	targetBranch: string;
	isFastForward: boolean;
}

export interface MergeChapterInput {
	targetChapterId: string;
	strategy?: "merge" | "squash" | "cherry-pick";
	message?: string;
}

export interface MergeResult {
	success: boolean;
	commitSha?: string;
	conflictFiles?: string[];
	isFastForward?: boolean;
	/** Set when git merge succeeded but a non-fatal post-merge step failed. */
	warning?: string;
}

export interface AiResolveResult {
	resolved: boolean;
	mergeResult?: MergeResult;
	error?: string;
}

export interface RulerAiResolveResult {
	resolved: boolean;
	mergeResult?: MergeResult;
	/** Temporary chapter ID — preserved on failure for user interaction */
	tempChapterId?: string;
	error?: string;
	remainingFiles?: string[];
}

async function getProjectGitPath(projectId: string): Promise<string> {
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
	});
	if (!project?.gitPath) throw new ValidationError("Project has no git repository configured");
	return project.gitPath;
}

export const chapterMerge = {
	async checkConflicts(
		sourceChapterId: string,
		targetChapterId: string,
	): Promise<MergeCheckResult> {
		const source = await db.query.chapters.findFirst({
			where: eq(chapters.id, sourceChapterId),
		});
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);
		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, targetChapterId),
		});
		if (!target) throw new NotFoundError("Chapter", targetChapterId);
		if (source.status !== "active") throw new ValidationError("Source chapter must be active");
		if (target.status !== "active") throw new ValidationError("Target chapter must be active");
		if (source.projectId !== target.projectId) {
			throw new ValidationError("Cannot merge chapters from different projects");
		}

		const gitPath = await getProjectGitPath(source.projectId);

		const baseSha = await gitService.getMergeBase(gitPath, target.branch, source.branch);

		// Fast-forward is possible when the target branch tip is an ancestor of the source branch tip
		const isFastForward = await gitService.isAncestor(gitPath, target.branch, source.branch);

		const { hasConflicts, conflictFiles } = await gitService.mergeTree(
			gitPath,
			baseSha,
			target.branch,
			source.branch,
		);

		return {
			canMerge: !hasConflicts,
			hasConflicts,
			conflictFiles,
			sourceBranch: source.branch,
			targetBranch: target.branch,
			isFastForward: !hasConflicts && isFastForward,
		};
	},

	async merge(
		sourceChapterId: string,
		input: MergeChapterInput,
		userId?: string,
	): Promise<MergeResult> {
		const source = await db.query.chapters.findFirst({
			where: eq(chapters.id, sourceChapterId),
		});
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);
		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, input.targetChapterId),
		});
		if (!target) throw new NotFoundError("Chapter", input.targetChapterId);
		if (source.status !== "active" && source.status !== "dormant") {
			throw new ValidationError("Source chapter must be active or dormant");
		}
		if (target.status !== "active") throw new ValidationError("Target chapter must be active");
		if (!target.worktreePath) throw new ValidationError("Target chapter has no worktree");
		if (source.projectId !== target.projectId) {
			throw new ValidationError("Cannot merge chapters from different projects");
		}

		const gitPath = await getProjectGitPath(source.projectId);
		const strategy = input.strategy ?? "merge";
		const message = input.message ?? `Merge ${source.branch} into ${target.branch}`;
		const targetWorktree = target.worktreePath;

		// Review gate: if project requires review approval before merge
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, source.projectId),
		});
		const chapterSettings = project?.chapterSettings as Record<string, unknown> | null;
		if (chapterSettings?.requireReviewBeforeMerge) {
			const latestConclusion = await db.query.reviewConclusions.findFirst({
				where: eq(reviewConclusions.sourceChapterId, sourceChapterId),
				orderBy: [desc(reviewConclusions.createdAt)],
			});
			if (!latestConclusion || latestConclusion.verdict !== "approve") {
				throw new ValidationError(
					"Review approval required before merge. " +
						(latestConclusion
							? `Latest review verdict: ${latestConclusion.verdict}`
							: "No review found."),
				);
			}
		}

		// Check if fast-forward is possible (only for "merge" strategy)
		const canFastForward =
			strategy === "merge" && (await gitService.isAncestor(gitPath, target.branch, source.branch));

		// Collect commit messages and diff stat BEFORE the merge — after merge,
		// the commit range baseBranch..branch may be empty (fast-forward).
		const mergeContext = await collectMergeContext(gitPath, source.branch, source.baseBranch).catch(
			(err) => {
				logger.warn("Failed to collect pre-merge context (non-fatal)", {
					sourceChapterId,
					error: String(err),
				});
				return { commits: [] as string[], diffStat: "" };
			},
		);

		// Lock the target worktree to prevent concurrent git operations.
		// preMergeTargetSha is captured INSIDE the lock to eliminate the race
		// window where another operation could modify the target between the
		// SHA read and the actual merge.
		return worktreeLock.acquire(targetWorktree, async () => {
			const preMergeTargetSha = (await gitService.getHeadCommit(targetWorktree)).trim();
			let result: MergeResult;
			if (strategy === "cherry-pick") {
				const baseSha = await gitService.getMergeBase(gitPath, target.branch, source.branch);
				result = await gitService.cherryPick(targetWorktree, gitPath, source.branch, baseSha);
			} else {
				result = await gitService.merge(targetWorktree, source.branch, strategy, message, {
					fastForward: canFastForward,
				});
			}

			if (result.success) {
				// Git succeeded — persist to DB with retry on failure
				try {
					await this.markMerged(
						sourceChapterId,
						input.targetChapterId,
						strategy,
						result.commitSha,
						userId,
						mergeContext,
						preMergeTargetSha,
					);
				} catch (dbErr) {
					logger.error("Failed to mark chapter as merged after successful git merge, retrying", {
						sourceChapterId,
						targetChapterId: input.targetChapterId,
						commitSha: result.commitSha,
						error: String(dbErr),
					});
					try {
						await this.markMerged(
							sourceChapterId,
							input.targetChapterId,
							strategy,
							result.commitSha,
							userId,
							mergeContext,
							preMergeTargetSha,
						);
					} catch (retryErr) {
						// DB update failed twice — try to undo the git merge so we
						// don't leave git and DB in an inconsistent state.
						logger.error("Retry also failed, attempting git rollback", {
							sourceChapterId,
							error: String(retryErr),
						});
						try {
							const currentHead = (await gitService.getHeadCommit(targetWorktree)).trim();
							logger.info("Recording current HEAD before git rollback", {
								sourceChapterId,
								currentHead,
								rollbackTarget: preMergeTargetSha,
							});
							await gitService.resetHard(targetWorktree, preMergeTargetSha);
							logger.info("Git rollback succeeded after DB failure", {
								sourceChapterId,
							});
							return {
								success: false,
								warning: `Merge rolled back: database update failed after git merge. Please retry. (${String(retryErr)})`,
							};
						} catch (resetErr) {
							// Both DB and git rollback failed — critical state
							logger.error("CRITICAL: Both DB update and git rollback failed", {
								sourceChapterId,
								dbError: String(retryErr),
								gitError: String(resetErr),
							});
							return {
								...result,
								warning: `CRITICAL: Git merge succeeded but database update failed, and git rollback also failed. Manual intervention required. DB error: ${String(retryErr)}`,
							};
						}
					}
				}
			} else if (result.conflictFiles) {
				eventBus.emit({
					type: "chapter:conflict",
					sourceId: sourceChapterId,
					targetId: input.targetChapterId,
					files: result.conflictFiles,
				});
				if (strategy !== "cherry-pick") {
					try {
						await gitService.mergeAbort(targetWorktree);
					} catch {
						// merge-abort may fail if no merge in progress
					}
				}
			}

			return result;
		});
	},

	async aiResolveConflicts(
		sourceChapterId: string,
		input: MergeChapterInput,
		locale: Locale = "en",
		userId?: string,
	): Promise<AiResolveResult> {
		const source = await db.query.chapters.findFirst({
			where: eq(chapters.id, sourceChapterId),
		});
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);
		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, input.targetChapterId),
		});
		if (!target) throw new NotFoundError("Chapter", input.targetChapterId);
		if (!target.worktreePath) throw new ValidationError("Target chapter has no worktree");
		if (source.projectId !== target.projectId) {
			throw new ValidationError("Cannot merge chapters from different projects");
		}

		const primaryNarrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, input.targetChapterId), eq(narrators.type, "primary")),
		});
		if (!primaryNarrator) {
			return { resolved: false, error: "Target chapter has no primary narrator" };
		}

		const gitPath = await getProjectGitPath(source.projectId);

		const strategy = input.strategy ?? "merge";
		const message = input.message ?? `Merge ${source.branch} into ${target.branch}`;
		const targetWorktree = target.worktreePath;

		// Collect commit messages and diff stat BEFORE the merge — this is a
		// read-only operation so it's safe (and desirable) to run outside the lock.
		const mergeContext = await collectMergeContext(gitPath, source.branch, source.baseBranch).catch(
			(err) => {
				logger.warn("Failed to collect pre-merge context for AI resolve (non-fatal)", {
					sourceChapterId,
					error: String(err),
				});
				return { commits: [] as string[], diffStat: "" };
			},
		);

		// Lock the target worktree for the entire AI resolution.
		// preMergeTargetSha is captured inside the lock (same rationale as merge()).
		return worktreeLock.acquire(targetWorktree, async () => {
			const preMergeTargetSha = (await gitService.getHeadCommit(targetWorktree)).trim();
			let conflictFiles: string[];

			if (strategy === "cherry-pick") {
				const baseSha = await gitService.getMergeBase(gitPath, target.branch, source.branch);
				const cpResult = await gitService.cherryPick(
					targetWorktree,
					gitPath,
					source.branch,
					baseSha,
				);
				if (cpResult.success) {
					return this.markMergedResult(
						sourceChapterId,
						input.targetChapterId,
						strategy,
						cpResult.commitSha,
						userId,
						mergeContext,
						preMergeTargetSha,
					);
				}
				conflictFiles = cpResult.conflictFiles ?? [];
			} else {
				const mergeResult = await gitService.mergeNoCommit(targetWorktree, source.branch, strategy);
				if (!mergeResult.hasConflicts) {
					const commitSha = await gitService.autoCommit(targetWorktree, message);
					return this.markMergedResult(
						sourceChapterId,
						input.targetChapterId,
						strategy,
						commitSha ?? undefined,
						userId,
						mergeContext,
						preMergeTargetSha,
					);
				}
				conflictFiles = mergeResult.conflictFiles;
			}

			const prompt = buildConflictResolutionPrompt(
				conflictFiles,
				source.branch,
				target.branch,
				locale,
				mergeContext,
			);
			logger.info("Starting AI conflict resolution", {
				sourceId: sourceChapterId,
				targetId: input.targetChapterId,
				conflictFiles,
				narratorId: primaryNarrator.id,
			});

			try {
				for await (const _event of startSession(primaryNarrator.id, prompt)) {
					// drain the session — the narrator resolves conflicts in the worktree
				}

				const remainingConflicts = await gitService.getConflictFiles(targetWorktree);
				if (remainingConflicts.length > 0) {
					await gitService.mergeAbort(targetWorktree);
					return {
						resolved: false,
						error: `Narrator could not resolve all conflicts. Remaining: ${remainingConflicts.join(", ")}`,
					};
				}

				const commitSha = await gitService.autoCommit(targetWorktree, message);
				return this.markMergedResult(
					sourceChapterId,
					input.targetChapterId,
					strategy,
					commitSha ?? undefined,
					userId,
					mergeContext,
					preMergeTargetSha,
				);
			} catch (err) {
				logger.error("AI conflict resolution failed", { error: String(err) });
				try {
					await gitService.mergeAbort(targetWorktree);
				} catch {
					// best effort
				}
				return { resolved: false, error: String(err) };
			}
		});
	},

	async markMerged(
		sourceChapterId: string,
		targetChapterId: string,
		strategy: string,
		commitSha?: string,
		userId?: string,
		mergeContext?: { commits: string[]; diffStat: string },
		preMergeTargetSha?: string,
	): Promise<void> {
		const source = await db.query.chapters.findFirst({
			where: eq(chapters.id, sourceChapterId),
		});
		const now = new Date().toISOString();

		// Update DB FIRST — if this fails the worktree is still intact and the
		// chapter remains active, so the user doesn't lose their working directory.
		await db
			.update(chapters)
			.set({
				status: "merged",
				worktreePath: null,
				mergedIntoChapterId: targetChapterId,
				mergeCommitSha: commitSha,
				mergeStrategy: strategy as "merge" | "squash" | "cherry-pick",
				preMergeTargetSha: preMergeTargetSha ?? null,
				updatedAt: now,
			})
			.where(eq(chapters.id, sourceChapterId));

		// Clean up source chapter's worktree AFTER DB update — merged chapters
		// don't need one.  Failure here is non-fatal: the worktree is orphaned
		// but the DB state is already consistent.
		if (source?.worktreePath) {
			try {
				const gitPath = await getProjectGitPath(source.projectId);
				await terminalService.cleanupForChapter(sourceChapterId);
				await gitService.removeWorktree(gitPath, source.worktreePath);
			} catch (err) {
				logger.warn("Failed to clean up source worktree after merge", {
					sourceChapterId,
					error: String(err),
				});
			}
		}

		// Create merge edge in chapter_edges
		if (source) {
			try {
				await chapterEdgeService.createMergeEdge(
					source.projectId,
					sourceChapterId,
					targetChapterId,
					{
						mergeCommitSha: commitSha,
						strategy: strategy as string,
					},
				);
			} catch (err) {
				// Edge is auxiliary data — log but don't fail the merge operation,
				// otherwise the retry path in merge() could create duplicate edges.
				logger.error("Failed to create merge edge (non-fatal)", {
					sourceChapterId,
					targetChapterId,
					error: String(err),
				});
			}
		}

		logger.info("Chapter merged", {
			sourceId: sourceChapterId,
			targetId: targetChapterId,
			strategy,
			commitSha,
		});

		// Record merge commit in the target chapter
		if (commitSha) {
			try {
				// TODO: use the actual git commit message instead of this synthetic one
				await commitSyncService.recordCommit({
					chapterId: targetChapterId,
					sha: commitSha,
					message: `Merge ${source?.branch ?? sourceChapterId} (${strategy})`,
					source: strategy === "cherry-pick" ? "cherry_pick" : "merge",
				});
			} catch (err) {
				logger.warn("Failed to record merge commit (non-fatal)", {
					targetChapterId,
					commitSha,
					error: String(err),
				});
			}
		}

		eventBus.emit({
			type: "chapter:merged",
			sourceId: sourceChapterId,
			targetId: targetChapterId,
			userId,
		});

		// Fire-and-forget: generate merge summary asynchronously
		mergeSummaryService
			.generateAndInject({
				sourceChapterId,
				targetChapterId,
				userId,
				strategy,
				commitSha,
				preCollectedCommits: mergeContext?.commits,
				preCollectedDiffStat: mergeContext?.diffStat,
			})
			.catch((err) => {
				logger.error("Merge summary fire-and-forget failed", {
					sourceChapterId,
					targetChapterId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	},

	async markMergedResult(
		sourceChapterId: string,
		targetChapterId: string,
		strategy: string,
		commitSha?: string,
		userId?: string,
		mergeContext?: { commits: string[]; diffStat: string },
		preMergeTargetSha?: string,
	): Promise<AiResolveResult> {
		await this.markMerged(
			sourceChapterId,
			targetChapterId,
			strategy,
			commitSha,
			userId,
			mergeContext,
			preMergeTargetSha,
		);
		return { resolved: true, mergeResult: { success: true, commitSha } };
	},

	/**
	 * Unmerge a chapter: reset the target branch to before the merge commit,
	 * then wake the source chapter back to active.
	 *
	 * Uses `git reset --hard <mergeCommit>~1` instead of `git revert` because
	 * revert poisons the merge base — a subsequent re-merge would silently
	 * skip all previously merged commits.
	 */
	async unmerge(sourceChapterId: string): Promise<{ ok: true }> {
		const source = await db.query.chapters.findFirst({
			where: eq(chapters.id, sourceChapterId),
		});
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);
		if (source.status !== "merged") {
			throw new ValidationError("Can only unmerge chapters with merged status");
		}
		if (!source.mergedIntoChapterId) {
			throw new ValidationError("Chapter has no merge target recorded");
		}
		if (!source.mergeCommitSha) {
			throw new ValidationError("Chapter has no merge commit SHA recorded — cannot unmerge");
		}

		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, source.mergedIntoChapterId),
		});
		if (!target) throw new NotFoundError("Chapter", source.mergedIntoChapterId);
		if (!target.worktreePath) {
			throw new ValidationError("Target chapter has no active worktree — cannot unmerge");
		}

		const gitPath = await getProjectGitPath(source.projectId);

		// Step 1: Undo the merge on the target branch.
		// When preMergeTargetSha is available and HEAD hasn't advanced past the merge,
		// reset directly to it (handles fast-forward merges that introduce multiple commits).
		// Fall back to git revert when the target has advanced (preserves later commits).
		const headSha = (await gitService.getHeadCommit(target.worktreePath)).trim();
		if (headSha === source.mergeCommitSha) {
			// HEAD is the merge commit — safe to reset
			const resetTarget = source.preMergeTargetSha ?? `${source.mergeCommitSha}~1`;
			await gitService.resetHard(target.worktreePath, resetTarget);
			logger.info("Reset target branch to before merge commit", {
				sourceChapterId,
				targetChapterId: target.id,
				mergeCommitSha: source.mergeCommitSha,
				resetTarget,
			});
		} else {
			// Target has new commits — revert instead to preserve them
			const isMerge = await gitService.isMergeCommit(target.worktreePath, source.mergeCommitSha);
			try {
				const revertSha = isMerge
					? await gitService.revertMergeCommit(target.worktreePath, source.mergeCommitSha)
					: await gitService.revertCommit(target.worktreePath, source.mergeCommitSha);
				logger.info("Reverted merge commit on target (target had advanced)", {
					sourceChapterId,
					targetChapterId: target.id,
					mergeCommitSha: source.mergeCommitSha,
					revertSha,
				});
			} catch {
				throw new ValidationError(
					`Cannot automatically unmerge: revert of ${source.mergeCommitSha.slice(0, 7)} ` +
						`conflicts with later commits on the target branch. ` +
						`Please resolve manually in the target worktree.`,
				);
			}
		}

		// Step 2: Sync target chapter's commit list after undo
		try {
			await commitSyncService.syncChapterCommits(target.id);
		} catch (err) {
			logger.warn("Failed to sync target commits after unmerge (non-fatal)", {
				targetChapterId: target.id,
				error: String(err),
			});
		}

		// Step 3: Re-create worktree for the source chapter
		const branchSuffix = source.branch.split("/").slice(1).join("/");
		const worktreePath = resolve(gitPath, ".worktrees", branchSuffix);
		await gitService.createWorktree(gitPath, worktreePath, source.branch);

		// Step 4: Update source chapter DB state
		const now = new Date().toISOString();
		try {
			await db
				.update(chapters)
				.set({
					status: "active",
					worktreePath,
					mergedIntoChapterId: null,
					mergeCommitSha: null,
					mergeStrategy: null,
					preMergeTargetSha: null,
					lastAccessedAt: now,
					updatedAt: now,
				})
				.where(eq(chapters.id, sourceChapterId));
		} catch (dbErr) {
			// Clean up orphan worktree on DB failure
			try {
				await gitService.removeWorktree(gitPath, worktreePath);
			} catch {
				// best effort
			}
			throw dbErr;
		}

		// Step 5: Remove merge edges
		try {
			await chapterEdgeService.deleteMergeEdgesBySource(sourceChapterId);
		} catch (err) {
			logger.warn("Failed to remove merge edges during unmerge", {
				sourceChapterId,
				error: String(err),
			});
		}

		// Step 6: Remove merge summary message for THIS specific merge only
		// (preserves historical cards from earlier merge rounds)
		try {
			const { deletedCount, narratorIds } = await mergeSummaryService.cleanupForMerge(
				sourceChapterId,
				source.mergeCommitSha,
			);
			if (deletedCount > 0) {
				// Notify all affected narrators to reload messages
				for (const nid of narratorIds) {
					eventBus.emit({
						type: "narrator:ws_broadcast",
						narratorId: nid,
						message: { type: "full_reload", narratorId: nid },
					});
				}
			}
		} catch (err) {
			logger.warn("Failed to clean up merge summary messages during unmerge", {
				sourceChapterId,
				error: String(err),
			});
		}

		eventBus.emit({ type: "chapter:woken", chapterId: sourceChapterId });

		return { ok: true };
	},

	/**
	 * Ruler-mode AI conflict resolution: fork a temporary chapter from trunk,
	 * merge the source branch into it, let AI resolve conflicts, then merge
	 * the result back into trunk.
	 *
	 * On success: cleans up the temporary chapter.
	 * On failure: preserves the temporary chapter for user interaction.
	 */
	async rulerAiResolve(
		sourceChapterId: string,
		targetChapterId: string,
		options: {
			strategy?: "merge" | "squash";
			message?: string;
			locale?: Locale;
			userId?: string;
		},
	): Promise<RulerAiResolveResult> {
		const { chapterFork } = await import("./chapter-fork");
		const { chapterService } = await import("./chapter-service");
		const { narratorService } = await import("./narrator-service");

		const source = await db.query.chapters.findFirst({
			where: eq(chapters.id, sourceChapterId),
		});
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);
		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, targetChapterId),
		});
		if (!target) throw new NotFoundError("Chapter", targetChapterId);
		if (!target.worktreePath) throw new ValidationError("Target chapter has no worktree");

		const gitPath = await getProjectGitPath(source.projectId);
		const strategy = options.strategy ?? "merge";
		const message = options.message ?? `Merge ${source.branch} into ${target.branch}`;
		const locale = options.locale ?? "en";

		// Collect merge context before any merge operation
		const mergeContext = await collectMergeContext(gitPath, source.branch, source.baseBranch).catch(
			(err) => {
				logger.warn("Failed to collect pre-merge context for ruler AI resolve (non-fatal)", {
					sourceChapterId,
					error: String(err),
				});
				return { commits: [] as string[], diffStat: "" };
			},
		);

		// Step 1: Fork a temporary chapter from trunk
		const tempTitle = `merge-resolve-${generateShortId(6)}`;
		let tempChapter: { id: string; worktreePath: string | null; branch: string };
		try {
			tempChapter = await chapterFork.fork(targetChapterId, {
				title: tempTitle,
				inheritMode: "fresh",
			});
		} catch (err) {
			logger.error("Failed to fork temporary chapter for ruler AI resolve", {
				sourceChapterId,
				targetChapterId,
				error: String(err),
			});
			return { resolved: false, error: `Failed to create temporary chapter: ${String(err)}` };
		}

		if (!tempChapter.worktreePath) {
			return { resolved: false, error: "Temporary chapter has no worktree" };
		}

		const tempWorktree = tempChapter.worktreePath;

		try {
			// Step 2: Merge source branch into temp worktree (no commit)
			const mergeResult = await gitService.mergeNoCommit(tempWorktree, source.branch, strategy);

			if (!mergeResult.hasConflicts) {
				// No conflicts (race condition) — commit and merge back to trunk
				const commitSha = await gitService.autoCommit(tempWorktree, message);
				return await this.finalizeTempMerge(
					sourceChapterId,
					targetChapterId,
					tempChapter,
					strategy,
					message,
					commitSha ?? undefined,
					options.userId,
					mergeContext,
					gitPath,
					chapterService,
				);
			}

			const conflictFiles = mergeResult.conflictFiles;

			// Step 3: Create narrator on temp chapter and start AI resolution
			const narrator = await narratorService.create({
				chapterId: tempChapter.id,
				permissionMode: "default",
			});

			const prompt = buildConflictResolutionPrompt(
				conflictFiles,
				source.branch,
				target.branch,
				locale,
				mergeContext,
			);

			logger.info("Starting ruler AI conflict resolution", {
				sourceId: sourceChapterId,
				targetId: targetChapterId,
				tempChapterId: tempChapter.id,
				conflictFiles,
				narratorId: narrator.id,
			});

			try {
				for await (const _event of startSession(narrator.id, prompt)) {
					// drain the session — the narrator resolves conflicts in the temp worktree
				}
			} catch (err) {
				logger.error("Ruler AI conflict resolution session failed", {
					error: String(err),
				});
				// Preserve temp chapter for user interaction
				return {
					resolved: false,
					tempChapterId: tempChapter.id,
					error: `AI session failed: ${String(err)}`,
					remainingFiles: conflictFiles,
				};
			}

			// Step 4: Check remaining conflicts
			const remainingConflicts = await gitService.getConflictFiles(tempWorktree);
			if (remainingConflicts.length > 0) {
				// AI didn't resolve everything — preserve temp chapter
				return {
					resolved: false,
					tempChapterId: tempChapter.id,
					error: `AI could not resolve all conflicts. Remaining: ${remainingConflicts.join(", ")}`,
					remainingFiles: remainingConflicts,
				};
			}

			// All conflicts resolved — commit
			const commitSha = await gitService.autoCommit(tempWorktree, message);

			// Step 5: Merge temp branch back into trunk
			return await this.finalizeTempMerge(
				sourceChapterId,
				targetChapterId,
				tempChapter,
				strategy,
				message,
				commitSha ?? undefined,
				options.userId,
				mergeContext,
				gitPath,
				chapterService,
			);
		} catch (err) {
			logger.error("Ruler AI resolve unexpected error", {
				sourceChapterId,
				targetChapterId,
				tempChapterId: tempChapter.id,
				error: String(err),
			});
			// Preserve temp chapter on unexpected errors
			return {
				resolved: false,
				tempChapterId: tempChapter.id,
				error: String(err),
			};
		}
	},

	/**
	 * Finalize a ruler AI resolve: merge the temp branch into trunk,
	 * mark the source as merged, and clean up the temp chapter.
	 */
	async finalizeTempMerge(
		sourceChapterId: string,
		targetChapterId: string,
		tempChapter: { id: string; worktreePath: string | null; branch: string },
		strategy: string,
		message: string,
		_commitSha: string | undefined,
		userId: string | undefined,
		mergeContext: { commits: string[]; diffStat: string },
		gitPath: string,
		chapterService: { remove: (id: string) => Promise<unknown> },
	): Promise<RulerAiResolveResult> {
		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, targetChapterId),
		});
		if (!target?.worktreePath) {
			return { resolved: false, error: "Target chapter lost worktree during resolve" };
		}

		// Capture target HEAD right before the merge — this is the most
		// accurate point for unmerge since AI resolution may have taken a while.
		const preMergeTargetSha = (await gitService.getHeadCommit(target.worktreePath)).trim();

		// Merge temp branch into trunk (should be clean merge or fast-forward)
		const trunkMerge = await gitService.merge(
			target.worktreePath,
			tempChapter.branch,
			"merge",
			message,
		);

		if (!trunkMerge.success) {
			return {
				resolved: false,
				tempChapterId: tempChapter.id,
				error: "Failed to merge resolved result back into trunk",
			};
		}

		// Mark source chapter as merged
		await this.markMerged(
			sourceChapterId,
			targetChapterId,
			strategy,
			trunkMerge.commitSha,
			userId,
			mergeContext,
			preMergeTargetSha,
		);

		// Clean up temp chapter
		try {
			await chapterService.remove(tempChapter.id);
			await gitService.deleteBranch(gitPath, tempChapter.branch).catch(() => {});
		} catch (err) {
			logger.warn("Failed to clean up temporary chapter after ruler AI resolve", {
				tempChapterId: tempChapter.id,
				error: String(err),
			});
		}

		return {
			resolved: true,
			mergeResult: { success: true, commitSha: trunkMerge.commitSha },
		};
	},
};

function buildConflictResolutionPrompt(
	conflictFiles: string[],
	sourceBranch: string,
	targetBranch: string,
	locale: Locale = "en",
	mergeContext?: { commits: string[]; diffStat: string },
): string {
	const fileList = conflictFiles.map((f) => `  - ${f}`).join("\n");

	// Use enhanced prompt when merge context is available
	if (mergeContext && (mergeContext.commits.length > 0 || mergeContext.diffStat)) {
		return getPrompt("conflictResolutionEnhanced", locale)
			.replace("{sourceBranch}", sourceBranch)
			.replace("{targetBranch}", targetBranch)
			.replace("{commitMessages}", mergeContext.commits.join("\n") || "(none)")
			.replace("{diffStat}", mergeContext.diffStat || "(none)")
			.replace("{fileList}", fileList);
	}

	return getPrompt("conflictResolution", locale)
		.replace("{sourceBranch}", sourceBranch)
		.replace("{targetBranch}", targetBranch)
		.replace("{fileList}", fileList);
}
