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
import {
	abortSnapshotMerge,
	applySnapshotMerge,
	applySnapshotUnmerge,
	canMergeViaSnapshot,
	checkSnapshotConflicts,
	detectRemainingConflicts,
	materializeConflicts,
	planSnapshotMerge,
	planSnapshotUnmerge,
	restoreSourceSnapshot,
} from "./chapter-merge-snapshot";
import { advanceChapterSnapshot } from "./chapter-snapshot-ref";
import { commitSyncService } from "./commit-sync-service";
import { gitService } from "./git-service";
import { collectMergeContext, mergeSummaryService } from "./merge-summary-service";
import { startSession } from "./narrator-session";
import { terminalService } from "./terminal-service";
import { SNAPSHOT_HEAD_REF, worktreeTreeSnapshot } from "./worktree-tree-snapshot";

export interface MergeCheckResult {
	canMerge: boolean;
	hasConflicts: boolean;
	conflictFiles: string[];
	sourceBranch: string;
	targetBranch: string;
	isFastForward: boolean;
}

/**
 * Which space a merge is carried out in.
 *
 * `snapshot` merges the workspaces as they are, leaving the user's git history
 * untouched. `commit` is the historical behaviour: it requires — or silently
 * creates — commits first. Absent means "decide automatically", which prefers
 * snapshot; see `resolveMergeMode`.
 */
export type MergeMode = "snapshot" | "commit";

export interface MergeChapterInput {
	targetChapterId: string;
	strategy?: "merge" | "squash" | "cherry-pick";
	message?: string;
	mode?: MergeMode;
}

export interface MergeResult {
	success: boolean;
	commitSha?: string;
	conflictFiles?: string[];
	isFastForward?: boolean;
	/** Set when git merge succeeded but a non-fatal post-merge step failed. */
	warning?: string;
}

/**
 * The state an interactive snapshot merge needs carried between its two halves.
 *
 * A git-based interactive merge stores this implicitly, as the half-finished merge
 * left in the worktree and index. Snapshot mode writes only the conflicted tree, so
 * the way to finish or abort has to be stated explicitly and persisted.
 */
export interface InteractiveSnapshotState {
	/** Restore target for an abort. */
	preMergeTree: string;
	/** Conflicted tree written to the worktree. */
	conflictTree: string;
	/** Target side of the merge, one parent of the eventual snapshot commit. */
	targetSnapshot: string;
	/** Source side of the merge, the other parent. */
	sourceSnapshot: string;
	/** Target's git HEAD before the merge, recorded for parity with the commit path. */
	preMergeTargetSha: string | null;
	/** Paths the merge declared conflicted — the set conflict detection scans. */
	conflictFiles: string[];
}

export interface InteractiveMergeResult extends MergeResult {
	/** User-visible prompt to send to the target narrator when conflict markers are preserved. */
	conflictPrompt?: string;
	/**
	 * Present when the conflict arose in snapshot mode. The caller must persist it and
	 * hand it back to complete or abort the merge.
	 */
	snapshotState?: Omit<InteractiveSnapshotState, "conflictFiles">;
}

export interface AiResolveResult {
	resolved: boolean;
	mergeResult?: MergeResult;
	error?: string;
	remainingFiles?: string[];
}

type ChapterRow = typeof chapters.$inferSelect;

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

function buildPreMergeAutoCommitMessage(source: ChapterRow, target: ChapterRow): string {
	const sourceLabel = source.title?.trim() || source.branch;
	return `Auto-commit ${sourceLabel} changes before merge into ${target.branch}`;
}

async function autoCommitSourceBeforeMerge(
	source: ChapterRow,
	target: ChapterRow,
): Promise<string | null> {
	const sourceWorktree = source.worktreePath;
	if (!sourceWorktree) return null;

	const message = buildPreMergeAutoCommitMessage(source, target);
	return worktreeLock.acquire(sourceWorktree, async () => {
		const currentBranch = (await gitService.getCurrentBranch(sourceWorktree)).trim();
		if (currentBranch !== source.branch) {
			throw new ValidationError(
				`Source chapter worktree is on branch ${currentBranch || "(detached)"}, expected ${source.branch}`,
			);
		}

		const commitSha = await gitService.autoCommit(sourceWorktree, message);
		if (!commitSha) return null;

		const normalizedSha = commitSha.trim();
		logger.info("Auto-committed source chapter worktree before merge", {
			sourceChapterId: source.id,
			targetChapterId: target.id,
			worktreePath: sourceWorktree,
			commitSha: normalizedSha,
		});
		try {
			await commitSyncService.recordCommit({
				chapterId: source.id,
				sha: normalizedSha,
				message,
				source: "auto",
			});
		} catch (err) {
			logger.warn("Failed to record pre-merge auto-commit (non-fatal)", {
				sourceChapterId: source.id,
				commitSha: normalizedSha,
				error: String(err),
			});
		}
		return normalizedSha;
	});
}

function reviewCommitSha(
	reviewChapter: Pick<ChapterRow, "forkPoint" | "startCommitSha" | "headCommitSha">,
): string | null {
	const forkPoint = reviewChapter.forkPoint;
	if (forkPoint && typeof forkPoint === "object" && "commitSha" in forkPoint) {
		const commitSha = (forkPoint as { commitSha?: unknown }).commitSha;
		if (typeof commitSha === "string" && commitSha.trim()) return commitSha.trim();
	}
	return reviewChapter.startCommitSha?.trim() || reviewChapter.headCommitSha?.trim() || null;
}

async function ensureSourceReadyForRequiredReview(
	source: ChapterRow,
	gitPath: string,
): Promise<void> {
	if (source.worktreePath) {
		const status = await gitService.getStatus(source.worktreePath);
		if (status.trim()) {
			throw new ValidationError(
				"Source chapter has uncommitted changes. Commit them and run a new review before merging.",
			);
		}
	}

	const latestConclusion = await db.query.reviewConclusions.findFirst({
		where: eq(reviewConclusions.sourceChapterId, source.id),
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

	const reviewChapter = await db.query.chapters.findFirst({
		where: eq(chapters.id, latestConclusion.reviewChapterId),
		columns: { forkPoint: true, startCommitSha: true, headCommitSha: true },
	});
	const reviewedSha = reviewChapter ? reviewCommitSha(reviewChapter) : null;
	const sourceHeadSha = (
		source.worktreePath
			? await gitService.getHeadCommit(source.worktreePath)
			: await gitService.getRefCommit(gitPath, source.branch)
	).trim();
	if (reviewedSha && reviewedSha !== sourceHeadSha) {
		throw new ValidationError(
			"Review approval is stale: the source branch changed after the approved review. Run a new review before merging.",
		);
	}
}

async function prepareSourceBeforeMerge(
	source: ChapterRow,
	target: ChapterRow,
	gitPath: string,
	requireReviewBeforeMerge: boolean,
): Promise<void> {
	if (requireReviewBeforeMerge) {
		await ensureSourceReadyForRequiredReview(source, gitPath);
		return;
	}

	// If the source chapter still has uncommitted worktree changes, persist them
	// to its branch before computing merge context / fast-forward state. Otherwise
	// git merge only sees the old branch tip and silently drops those changes.
	await autoCommitSourceBeforeMerge(source, target);
}

/**
 * The snapshot merge coordinates, reset to null.
 *
 * Shared by every place that dissolves a merge relationship (unmerge, and waking a
 * merged chapter). Leaving a stale coordinate behind is not cosmetic: `unmerge`
 * routes on `mergeSnapshotCommitSha`, so a leftover value would send a later unmerge
 * down the snapshot path using coordinates from a merge that no longer exists.
 */
export function clearedSnapshotMergeFields() {
	return {
		mergeSnapshotCommitSha: null,
		preMergeTargetSnapshotSha: null,
		mergedSourceSnapshotSha: null,
	};
}

/**
 * Decide whether a merge runs in snapshot space or through git commits.
 *
 * Snapshot is the default because it is the only mode that can represent what the
 * user is actually looking at: the commit path has to either refuse a dirty chapter
 * or commit on their behalf, and both write to their history to satisfy NarraFork's
 * bookkeeping.
 *
 * Three things force the commit path:
 *   - an explicit `mode: "commit"` request,
 *   - `requireReviewBeforeMerge`, which is a governance rule about reviewed *commits*
 *     and would be meaningless against uncommitted state,
 *   - anything snapshot mode cannot express (cherry-pick, a dormant chapter with no
 *     worktree), which {@link canMergeViaSnapshot} reports.
 */
async function resolveMergeMode(
	source: ChapterRow,
	target: ChapterRow,
	strategy: string,
	requested: MergeMode | undefined,
	requireReviewBeforeMerge: boolean,
): Promise<"snapshot" | "commit"> {
	if (requested === "commit") return "commit";
	if (requireReviewBeforeMerge) return "commit";
	if (!(await canMergeViaSnapshot(source, target, strategy))) return "commit";
	return "snapshot";
}

/**
 * Record a completed snapshot merge and retire the source chapter.
 *
 * Mirrors {@link chapterMerge.markMerged} but stores snapshot coordinates.
 * `mergeCommitSha` is left null on purpose: it means "a real git merge commit" to
 * nine backend and five frontend readers, and putting a snapshot id there would be a
 * claim none of them could check. They all already tolerate null.
 *
 * The source worktree is only removed once its bytes are provably in the DAG. In
 * commit-free mode the branch tip does not hold them, so the snapshot is the sole
 * copy and `removeWorktree` — which always forces — would otherwise destroy it.
 */
async function markMergedSnapshot(
	sourceChapterId: string,
	targetChapterId: string,
	strategy: string,
	snapshot: {
		mergeSnapshotCommitSha: string;
		preMergeTargetSnapshotSha: string;
		mergedSourceSnapshotSha: string;
		preMergeTargetSha: string | null;
	},
	userId?: string,
	mergeContext?: { commits: string[]; diffStat: string },
): Promise<{ warning?: string }> {
	const source = await db.query.chapters.findFirst({ where: eq(chapters.id, sourceChapterId) });
	const now = new Date().toISOString();
	let warning: string | undefined;

	await db
		.update(chapters)
		.set({
			status: "merged",
			worktreePath: null,
			mergedIntoChapterId: targetChapterId,
			mergeStrategy: strategy as "merge" | "squash" | "cherry-pick",
			mergeSnapshotCommitSha: snapshot.mergeSnapshotCommitSha,
			preMergeTargetSnapshotSha: snapshot.preMergeTargetSnapshotSha,
			mergedSourceSnapshotSha: snapshot.mergedSourceSnapshotSha,
			preMergeTargetSha: snapshot.preMergeTargetSha,
			updatedAt: now,
		})
		.where(eq(chapters.id, sourceChapterId));

	if (source?.worktreePath) {
		// The snapshot was already taken while planning the merge; re-verify rather
		// than assume, because this is the last checkpoint before the bytes go away.
		const preserved = await worktreeTreeSnapshot
			.treeOfSnapshot(source.worktreePath, snapshot.mergedSourceSnapshotSha)
			.catch(() => null);
		if (!preserved) {
			warning =
				"The source worktree was kept because its uncommitted state could not be " +
				"verified in the snapshot store. Remove it manually once you have checked it.";
			logger.warn("Keeping source worktree after merge: snapshot not verifiable", {
				sourceChapterId,
				worktreePath: source.worktreePath,
			});
			// Leave worktreePath null in the DB but keep the directory: the chapter is
			// merged, and an orphan directory is recoverable while deleted bytes are not.
		} else {
			try {
				const gitPath = await getProjectGitPath(source.projectId);
				await terminalService.cleanupForChapter(sourceChapterId);
				await gitService.removeWorktree(gitPath, source.worktreePath);
			} catch (err) {
				logger.warn("Failed to clean up source worktree after snapshot merge", {
					sourceChapterId,
					error: String(err),
				});
			}
		}
	}

	if (source) {
		try {
			await chapterEdgeService.createMergeEdge(source.projectId, sourceChapterId, targetChapterId, {
				strategy: strategy as string,
				status: "completed",
				mergeSnapshotCommitSha: snapshot.mergeSnapshotCommitSha,
			});
		} catch (err) {
			logger.error("Failed to create merge edge after snapshot merge (non-fatal)", {
				sourceChapterId,
				targetChapterId,
				error: String(err),
			});
		}
	}

	logger.info("Chapter merged without a commit", {
		sourceId: sourceChapterId,
		targetId: targetChapterId,
		strategy,
		mergeSnapshotCommitSha: snapshot.mergeSnapshotCommitSha,
	});

	eventBus.emit({
		type: "chapter:merged",
		sourceId: sourceChapterId,
		targetId: targetChapterId,
		userId,
	});

	// Fire-and-forget, as the commit path does. No commit sha exists, so the summary
	// card records the merge without one; its `commitSha` field is already nullable.
	void mergeSummaryService
		.generateAndInject({
			sourceChapterId,
			targetChapterId,
			strategy,
			userId,
			// commitSha is deliberately omitted: there is no git commit to name.
			preCollectedCommits: mergeContext?.commits,
			preCollectedDiffStat: mergeContext?.diffStat,
		})
		.catch((err) =>
			logger.warn("Failed to inject merge summary after snapshot merge (non-fatal)", {
				sourceChapterId,
				error: String(err),
			}),
		);

	return warning ? { warning } : {};
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
		if (sourceChapterId === targetChapterId)
			throw new ValidationError("Cannot merge a chapter into itself");
		if (source.status !== "active") throw new ValidationError("Source chapter must be active");
		if (target.status !== "active") throw new ValidationError("Target chapter must be active");
		if (source.projectId !== target.projectId) {
			throw new ValidationError("Cannot merge chapters from different projects");
		}

		const gitPath = await getProjectGitPath(source.projectId);

		// Preview through whichever path the merge itself will take. The commit-based
		// check compares branch tips, while the merge auto-commits first — which is how
		// it could promise a clean merge and then conflict on uncommitted changes it
		// never looked at.
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, source.projectId),
		});
		const chapterSettings = project?.chapterSettings as Record<string, unknown> | null;
		const mode = await resolveMergeMode(
			source,
			target,
			"merge",
			undefined,
			chapterSettings?.requireReviewBeforeMerge === true,
		);
		if (mode === "snapshot") {
			// Held under the target's worktree lock even though this is a "check".
			//
			// Computing the preview through the real merge path is what makes it
			// trustworthy, but that path is not read-only: it captures both workspaces,
			// advances `refs/nf/head`, and fetches the source lineage across. Those are
			// the very refs the merge itself reads, so an unlocked preview could advance
			// the head between a concurrent merge's plan and its apply — making the
			// applied result derive from a state that no longer exists.
			//
			// Safe against the merge paths, which take this same lock BEFORE calling
			// `planSnapshotMerge`: the plan itself only takes the shadow lock, so there
			// is no reentrant acquire here (this mutex is not reentrant).
			const previewOwner = target.worktreePath ?? source.worktreePath;
			const runPreview = async () => {
				const { conflictFiles, hasConflicts } = await checkSnapshotConflicts(
					sourceChapterId,
					targetChapterId,
				);
				return {
					canMerge: !hasConflicts,
					hasConflicts,
					conflictFiles,
					sourceBranch: source.branch,
					targetBranch: target.branch,
					// Fast-forward is a commit-graph notion; a snapshot merge never produces a
					// user commit, so there is nothing to fast-forward.
					isFastForward: false,
				};
			};
			// `canMergeViaSnapshot` already established both worktrees exist, so the
			// fallback is defensive only.
			return previewOwner ? worktreeLock.acquire(previewOwner, runPreview) : runPreview();
		}

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

	/**
	 * Merge two workspaces as they currently stand, without requiring a commit.
	 *
	 * Held under the target's worktree lock for the same reason the commit path is:
	 * the plan is computed from a captured state, so another writer landing in between
	 * would make the applied result derive from a state that no longer exists.
	 *
	 * A conflict leaves the worktree untouched and reports the paths. That differs from
	 * the git path, which leaves conflict markers on disk — here materialising them is
	 * an explicit later step, taken only by the callers that want a narrator or the
	 * user to resolve them.
	 */
	async mergeViaSnapshot(
		source: ChapterRow,
		target: ChapterRow,
		strategy: string,
		message: string,
		userId?: string,
	): Promise<MergeResult> {
		const targetWorktree = target.worktreePath;
		if (!targetWorktree) throw new ValidationError("Target chapter has no worktree");
		const gitPath = await getProjectGitPath(source.projectId);

		// Collected before the merge, as the commit path does: afterwards the
		// baseBranch..branch range can be empty and the summary would lose its context.
		const mergeContext = await collectMergeContext(gitPath, source.branch, source.baseBranch).catch(
			(err) => {
				logger.warn("Failed to collect pre-merge context for snapshot merge (non-fatal)", {
					sourceChapterId: source.id,
					error: String(err),
				});
				return { commits: [] as string[], diffStat: "" };
			},
		);

		return worktreeLock.acquire(targetWorktree, async () => {
			// Recorded even though snapshot mode does not use it to undo: it keeps
			// `preMergeTargetSha` meaning "the target's HEAD before this merge" in both
			// modes, which several readers rely on.
			const preMergeTargetSha = (await gitService.getHeadCommit(targetWorktree))
				.trim()
				.slice(0, 40);
			const plan = await planSnapshotMerge(source, target);

			if (plan.conflicts.length > 0) {
				return { success: false, conflictFiles: plan.conflicts };
			}

			const applied = await applySnapshotMerge(targetWorktree, plan, message);
			const { warning } = await markMergedSnapshot(
				source.id,
				target.id,
				strategy,
				{
					mergeSnapshotCommitSha: applied.commitSha,
					preMergeTargetSnapshotSha: plan.preMergeTree,
					mergedSourceSnapshotSha: plan.sourceSnapshot,
					preMergeTargetSha: preMergeTargetSha || null,
				},
				userId,
				mergeContext,
			);
			return { success: true, ...(warning && { warning }) };
		});
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
		if (sourceChapterId === input.targetChapterId) {
			throw new ValidationError("Cannot merge a chapter into itself");
		}
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

		const project = await db.query.projects.findFirst({
			where: eq(projects.id, source.projectId),
		});
		const chapterSettings = project?.chapterSettings as Record<string, unknown> | null;
		const requireReview = chapterSettings?.requireReviewBeforeMerge === true;

		const mode = await resolveMergeMode(source, target, strategy, input.mode, requireReview);
		if (mode === "snapshot") {
			return this.mergeViaSnapshot(source, target, strategy, message, userId);
		}

		await prepareSourceBeforeMerge(source, target, gitPath, requireReview);

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

	/**
	 * First half of an interactive commit-free merge.
	 *
	 * The git path keeps its half-finished state on disk, which is how the second
	 * request knows what to finish or abort. Snapshot mode has no such state, so the
	 * three values that describe it — the pre-merge snapshot, the conflicted tree, and
	 * the declared conflict paths — are returned for the caller to persist. They go in
	 * the `merge_sessions` row rather than memory so a restart between the two halves
	 * cannot strand the worktree holding conflict markers with no way back.
	 */
	async startInteractiveSnapshotMerge(
		source: ChapterRow,
		target: ChapterRow,
		strategy: string,
		message: string,
		locale: Locale,
		userId?: string,
	): Promise<InteractiveMergeResult> {
		const targetWorktree = target.worktreePath;
		if (!targetWorktree) throw new ValidationError("Target chapter has no worktree");
		const gitPath = await getProjectGitPath(source.projectId);
		const mergeContext = await collectMergeContext(gitPath, source.branch, source.baseBranch).catch(
			() => ({ commits: [] as string[], diffStat: "" }),
		);

		return worktreeLock.acquire(targetWorktree, async () => {
			const preMergeTargetSha = (await gitService.getHeadCommit(targetWorktree))
				.trim()
				.slice(0, 40);
			const plan = await planSnapshotMerge(source, target);

			if (plan.conflicts.length === 0) {
				const applied = await applySnapshotMerge(targetWorktree, plan, message);
				const { warning } = await markMergedSnapshot(
					source.id,
					target.id,
					strategy,
					{
						mergeSnapshotCommitSha: applied.commitSha,
						preMergeTargetSnapshotSha: plan.preMergeTree,
						mergedSourceSnapshotSha: plan.sourceSnapshot,
						preMergeTargetSha: preMergeTargetSha || null,
					},
					userId,
					mergeContext,
				);
				return { success: true, ...(warning && { warning }) };
			}

			await materializeConflicts(targetWorktree, plan.tree);
			try {
				await chapterEdgeService.createMergeEdge(source.projectId, source.id, target.id, {
					strategy,
					status: "pending",
				});
			} catch (err) {
				logger.warn("Failed to create pending merge edge (non-fatal)", {
					sourceChapterId: source.id,
					targetChapterId: target.id,
					error: String(err),
				});
			}
			return {
				success: false,
				conflictFiles: plan.conflicts,
				conflictPrompt: buildConflictResolutionPrompt(
					plan.conflicts,
					source.branch,
					target.branch,
					locale,
					mergeContext,
				),
				snapshotState: {
					preMergeTree: plan.preMergeTree,
					conflictTree: plan.tree,
					targetSnapshot: plan.targetSnapshot,
					sourceSnapshot: plan.sourceSnapshot,
					preMergeTargetSha: preMergeTargetSha || null,
				},
			};
		});
	},

	/**
	 * Second half of an interactive commit-free merge: verify and record, or report
	 * what is still unresolved.
	 *
	 * Conflict detection scans the declared paths for markers rather than asking git,
	 * for the reason spelled out on {@link chapterMerge.aiResolveViaSnapshot}.
	 */
	async completeInteractiveSnapshotMerge(
		source: ChapterRow,
		target: ChapterRow,
		strategy: string,
		message: string,
		state: InteractiveSnapshotState,
		userId?: string,
	): Promise<AiResolveResult> {
		const targetWorktree = target.worktreePath;
		if (!targetWorktree) throw new ValidationError("Target chapter has no worktree");
		const gitPath = await getProjectGitPath(source.projectId);
		const mergeContext = await collectMergeContext(gitPath, source.branch, source.baseBranch).catch(
			() => ({ commits: [] as string[], diffStat: "" }),
		);

		return worktreeLock.acquire(targetWorktree, async () => {
			const remaining = await detectRemainingConflicts(targetWorktree, state.conflictFiles);
			if (remaining.length > 0) {
				return {
					resolved: false,
					error: `Conflicts are still unresolved: ${remaining.join(", ")}`,
					remainingFiles: remaining,
				};
			}
			// The resolution lives on disk, so it has to be captured; no previously
			// computed tree describes it.
			const resolvedTree = await worktreeTreeSnapshot.capture(targetWorktree);
			const commitSha = await worktreeTreeSnapshot.commitSnapshot(
				targetWorktree,
				resolvedTree,
				[state.targetSnapshot, state.sourceSnapshot],
				message,
			);
			await worktreeTreeSnapshot.setRef(targetWorktree, SNAPSHOT_HEAD_REF, commitSha);
			await advanceChapterSnapshot(targetWorktree, resolvedTree, message);
			const { warning } = await markMergedSnapshot(
				source.id,
				target.id,
				strategy,
				{
					mergeSnapshotCommitSha: commitSha,
					preMergeTargetSnapshotSha: state.preMergeTree,
					mergedSourceSnapshotSha: state.sourceSnapshot,
					preMergeTargetSha: state.preMergeTargetSha,
				},
				userId,
				mergeContext,
			);
			return { resolved: true, mergeResult: { success: true, ...(warning && { warning }) } };
		});
	},

	/**
	 * Chapter-id wrapper for {@link chapterMerge.completeInteractiveSnapshotMerge}, for
	 * callers resuming from a persisted session rather than holding the chapter rows.
	 */
	async completeInteractiveSnapshotMergeById(
		sourceChapterId: string,
		targetChapterId: string,
		strategy: string,
		state: InteractiveSnapshotState,
		userId?: string,
		message?: string,
	): Promise<AiResolveResult> {
		const source = await db.query.chapters.findFirst({
			where: eq(chapters.id, sourceChapterId),
		});
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);
		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, targetChapterId),
		});
		if (!target) throw new NotFoundError("Chapter", targetChapterId);
		if (!state.targetSnapshot || !state.sourceSnapshot) {
			// Both parents are required. Recording one would let the next merge recompute
			// a base that predates this combination and re-report resolved conflicts.
			return {
				resolved: false,
				error: "Interactive merge state is incomplete — the merge must be restarted",
			};
		}
		return this.completeInteractiveSnapshotMerge(
			source,
			target,
			strategy,
			message ?? `Merge ${source.branch} into ${target.branch}`,
			state,
			userId,
		);
	},

	/** Discard an in-flight interactive snapshot merge, restoring the pre-merge bytes. */
	async abortInteractiveSnapshotMerge(targetWorktree: string, preMergeTree: string): Promise<void> {
		await worktreeLock.acquire(targetWorktree, async () => {
			await abortSnapshotMerge(targetWorktree, preMergeTree);
		});
	},

	async startInteractiveConflictMerge(
		sourceChapterId: string,
		input: MergeChapterInput,
		locale: Locale = "en",
		userId?: string,
	): Promise<InteractiveMergeResult> {
		const source = await db.query.chapters.findFirst({
			where: eq(chapters.id, sourceChapterId),
		});
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);
		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, input.targetChapterId),
		});
		if (!target) throw new NotFoundError("Chapter", input.targetChapterId);
		if (sourceChapterId === input.targetChapterId) {
			throw new ValidationError("Cannot merge a chapter into itself");
		}
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
		if (strategy === "cherry-pick") {
			throw new ValidationError(
				"Interactive conflict resolution is not supported for cherry-pick batch merges yet",
			);
		}
		const message = input.message ?? `Merge ${source.branch} into ${target.branch}`;
		const targetWorktree = target.worktreePath;
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, source.projectId),
		});
		const chapterSettings = project?.chapterSettings as Record<string, unknown> | null;
		const requireReview = chapterSettings?.requireReviewBeforeMerge === true;

		const mode = await resolveMergeMode(source, target, strategy, input.mode, requireReview);
		if (mode === "snapshot") {
			return this.startInteractiveSnapshotMerge(source, target, strategy, message, locale, userId);
		}

		await prepareSourceBeforeMerge(source, target, gitPath, requireReview);

		const mergeContext = await collectMergeContext(gitPath, source.branch, source.baseBranch).catch(
			(err) => {
				logger.warn("Failed to collect pre-merge context for interactive merge (non-fatal)", {
					sourceChapterId,
					error: String(err),
				});
				return { commits: [] as string[], diffStat: "" };
			},
		);

		return worktreeLock.acquire(targetWorktree, async () => {
			const preMergeTargetSha = (await gitService.getHeadCommit(targetWorktree)).trim();
			const mergeResult = await gitService.mergeNoCommit(targetWorktree, source.branch, strategy);
			if (!mergeResult.hasConflicts) {
				const commitSha = await gitService.autoCommit(targetWorktree, message);
				const resolved = await this.markMergedResult(
					sourceChapterId,
					input.targetChapterId,
					strategy,
					commitSha ?? undefined,
					userId,
					mergeContext,
					preMergeTargetSha,
				);
				return { success: true, commitSha: resolved.mergeResult?.commitSha };
			}

			const conflictFiles = mergeResult.conflictFiles;
			try {
				await chapterEdgeService.createMergeEdge(
					source.projectId,
					sourceChapterId,
					input.targetChapterId,
					{
						strategy,
						status: "pending",
					},
				);
			} catch (err) {
				logger.warn("Failed to create pending merge edge (non-fatal)", {
					sourceChapterId,
					targetChapterId: input.targetChapterId,
					error: String(err),
				});
			}
			return {
				success: false,
				conflictFiles,
				conflictPrompt: buildConflictResolutionPrompt(
					conflictFiles,
					source.branch,
					target.branch,
					locale,
					mergeContext,
				),
			};
		});
	},

	async ensurePendingMergeEdge(
		sourceChapterId: string,
		targetChapterId: string,
		strategy: "merge" | "squash" | "cherry-pick" = "merge",
	): Promise<void> {
		const source = await db.query.chapters.findFirst({
			where: eq(chapters.id, sourceChapterId),
		});
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);
		await chapterEdgeService.createMergeEdge(source.projectId, sourceChapterId, targetChapterId, {
			strategy,
			status: "pending",
		});
	},

	async completeInteractiveConflictMerge(
		sourceChapterId: string,
		input: MergeChapterInput,
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
		if (target.status !== "active") throw new ValidationError("Target chapter must be active");
		if (!target.worktreePath) throw new ValidationError("Target chapter has no worktree");
		if (source.projectId !== target.projectId) {
			throw new ValidationError("Cannot merge chapters from different projects");
		}

		const strategy = input.strategy ?? "merge";
		const message = input.message ?? `Merge ${source.branch} into ${target.branch}`;
		const targetWorktree = target.worktreePath;
		const gitPath = await getProjectGitPath(source.projectId);
		const mergeContext = await collectMergeContext(gitPath, source.branch, source.baseBranch).catch(
			(err) => {
				logger.warn("Failed to collect merge context while completing interactive merge", {
					sourceChapterId,
					error: String(err),
				});
				return { commits: [] as string[], diffStat: "" };
			},
		);

		return worktreeLock.acquire(targetWorktree, async () => {
			const remainingFiles = await gitService.getConflictFiles(targetWorktree);
			if (remainingFiles.length > 0) {
				return {
					resolved: false,
					error: `Merge conflicts remain: ${remainingFiles.join(", ")}`,
					remainingFiles,
				};
			}

			let preMergeTargetSha = (await gitService.getHeadCommit(targetWorktree)).trim();
			let commitSha = await gitService.autoCommit(targetWorktree, message);
			if (!commitSha) {
				const status = await gitService.getStatus(targetWorktree);
				if (status.trim()) {
					return {
						resolved: false,
						error:
							"No resolved merge changes were available to commit. Resolve the conflicts without committing, then continue again.",
					};
				}
				commitSha = (await gitService.getHeadCommit(targetWorktree)).trim();
				preMergeTargetSha = (
					await gitService
						.getRefCommit(targetWorktree, `${commitSha}^1`)
						.catch(() => preMergeTargetSha)
				).trim();
			}
			return this.markMergedResult(
				sourceChapterId,
				input.targetChapterId,
				strategy,
				commitSha,
				userId,
				mergeContext,
				preMergeTargetSha,
			);
		});
	},

	/**
	 * Let a narrator resolve a commit-free merge's conflicts.
	 *
	 * Structurally the same as the git path, with each git-state step replaced by its
	 * snapshot equivalent:
	 *
	 *   git merge --no-commit   → merge the snapshots, then write the conflicted tree
	 *   git diff --diff-filter=U → scan the declared conflict paths for markers
	 *   git merge --abort        → restore the pre-merge snapshot
	 *
	 * The middle substitution is the one that matters most. `--diff-filter=U` reads the
	 * index's unmerged stages, which snapshot mode never creates, so it would report
	 * "no conflicts left" however little the narrator actually resolved — turning a
	 * failed resolution into a merge that silently commits conflict markers.
	 *
	 * The prompt is unchanged, because after materialisation the worktree looks exactly
	 * as it would mid-`git merge`.
	 */
	async aiResolveViaSnapshot(
		source: ChapterRow,
		target: ChapterRow,
		strategy: string,
		message: string,
		locale: Locale,
		userId?: string,
	): Promise<AiResolveResult> {
		const targetWorktree = target.worktreePath;
		if (!targetWorktree) throw new ValidationError("Target chapter has no worktree");
		const primaryNarrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, target.id), eq(narrators.variant, "primary")),
		});
		if (!primaryNarrator) {
			return { resolved: false, error: "Target chapter has no primary narrator" };
		}
		const gitPath = await getProjectGitPath(source.projectId);
		const mergeContext = await collectMergeContext(gitPath, source.branch, source.baseBranch).catch(
			() => ({ commits: [] as string[], diffStat: "" }),
		);

		return worktreeLock.acquire(targetWorktree, async () => {
			const preMergeTargetSha = (await gitService.getHeadCommit(targetWorktree))
				.trim()
				.slice(0, 40);
			const plan = await planSnapshotMerge(source, target);

			const finish = async (mergeTree: string, sourceSnapshot: string) => {
				const commitSha = await worktreeTreeSnapshot.commitSnapshot(
					targetWorktree,
					mergeTree,
					[plan.targetSnapshot, sourceSnapshot],
					message,
				);
				await worktreeTreeSnapshot.setRef(targetWorktree, SNAPSHOT_HEAD_REF, commitSha);
				await advanceChapterSnapshot(targetWorktree, mergeTree, message);
				const { warning } = await markMergedSnapshot(
					source.id,
					target.id,
					strategy,
					{
						mergeSnapshotCommitSha: commitSha,
						preMergeTargetSnapshotSha: plan.preMergeTree,
						mergedSourceSnapshotSha: sourceSnapshot,
						preMergeTargetSha: preMergeTargetSha || null,
					},
					userId,
					mergeContext,
				);
				return {
					resolved: true,
					mergeResult: { success: true, ...(warning && { warning }) },
				} satisfies AiResolveResult;
			};

			if (plan.conflicts.length === 0) {
				await worktreeTreeSnapshot.materializeTree(targetWorktree, plan.tree);
				return finish(plan.tree, plan.sourceSnapshot);
			}

			// Write the conflicted tree so the narrator sees standard markers.
			await materializeConflicts(targetWorktree, plan.tree);
			const prompt = buildConflictResolutionPrompt(
				plan.conflicts,
				source.branch,
				target.branch,
				locale,
				mergeContext,
			);
			logger.info("Starting AI conflict resolution (snapshot mode)", {
				sourceId: source.id,
				targetId: target.id,
				conflictFiles: plan.conflicts,
				narratorId: primaryNarrator.id,
			});

			try {
				for await (const _event of startSession(primaryNarrator.id, prompt)) {
					// drain — the narrator edits the worktree
				}
				const remaining = await detectRemainingConflicts(targetWorktree, plan.conflicts);
				if (remaining.length > 0) {
					await abortSnapshotMerge(targetWorktree, plan.preMergeTree);
					return {
						resolved: false,
						error: `Narrator could not resolve all conflicts. Remaining: ${remaining.join(", ")}`,
						remainingFiles: remaining,
					};
				}
				// The resolution is whatever is on disk now, which is not any tree computed
				// earlier — so it has to be captured rather than reused.
				const resolvedTree = await worktreeTreeSnapshot.capture(targetWorktree);
				return finish(resolvedTree, plan.sourceSnapshot);
			} catch (err) {
				logger.error("AI conflict resolution failed (snapshot mode)", { error: String(err) });
				try {
					await abortSnapshotMerge(targetWorktree, plan.preMergeTree);
				} catch {
					// best effort
				}
				return { resolved: false, error: String(err) };
			}
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
		if (sourceChapterId === input.targetChapterId) {
			throw new ValidationError("Cannot merge a chapter into itself");
		}
		if (!target.worktreePath) throw new ValidationError("Target chapter has no worktree");
		if (source.projectId !== target.projectId) {
			throw new ValidationError("Cannot merge chapters from different projects");
		}

		const primaryNarrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, input.targetChapterId), eq(narrators.variant, "primary")),
		});
		if (!primaryNarrator) {
			return { resolved: false, error: "Target chapter has no primary narrator" };
		}

		const gitPath = await getProjectGitPath(source.projectId);

		const strategy = input.strategy ?? "merge";
		const message = input.message ?? `Merge ${source.branch} into ${target.branch}`;
		const targetWorktree = target.worktreePath;
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, source.projectId),
		});
		const chapterSettings = project?.chapterSettings as Record<string, unknown> | null;
		const requireReview = chapterSettings?.requireReviewBeforeMerge === true;

		const mode = await resolveMergeMode(source, target, strategy, input.mode, requireReview);
		if (mode === "snapshot") {
			return this.aiResolveViaSnapshot(source, target, strategy, message, locale, userId);
		}

		await prepareSourceBeforeMerge(source, target, gitPath, requireReview);

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
						status: "completed",
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
	async unmerge(sourceChapterId: string): Promise<{ ok: true; warning?: string }> {
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
		// A snapshot merge produced no commit, so it is undone in snapshot space. The
		// presence of this coordinate is what identifies such a merge.
		if (source.mergeSnapshotCommitSha) {
			return this.unmergeSnapshot(source);
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
	 * Undo a commit-free merge.
	 *
	 * Two halves, and the second is the one that is easy to overlook. Reversing the
	 * target is a reverse three-way merge, which keeps whatever the target did after
	 * the merge. Restoring the *source* then has to replay its snapshot: a commit-free
	 * merge never advanced the source branch, so recreating its worktree from the
	 * branch alone would return a directory holding only its last commit, silently
	 * missing everything the user had not committed.
	 */
	async unmergeSnapshot(source: ChapterRow): Promise<{ ok: true; warning?: string }> {
		if (!source.mergedIntoChapterId) {
			throw new ValidationError("Chapter has no merge target recorded");
		}
		if (!source.mergeSnapshotCommitSha || !source.mergedSourceSnapshotSha) {
			throw new ValidationError("Chapter has no snapshot merge coordinates — cannot unmerge");
		}
		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, source.mergedIntoChapterId),
		});
		if (!target) throw new NotFoundError("Chapter", source.mergedIntoChapterId);
		if (!target.worktreePath) {
			throw new ValidationError("Target chapter has no active worktree — cannot unmerge");
		}
		const targetWorktree = target.worktreePath;
		const gitPath = await getProjectGitPath(source.projectId);
		const preMergeTargetSnapshot = source.preMergeTargetSnapshotSha;
		if (!preMergeTargetSnapshot) {
			throw new ValidationError("Chapter has no pre-merge target snapshot — cannot unmerge");
		}
		const warnings: string[] = [];

		// Step 1: reverse the source's contribution out of the target.
		await worktreeLock.acquire(targetWorktree, async () => {
			const plan = await planSnapshotUnmerge(
				targetWorktree,
				source.mergedSourceSnapshotSha as string,
				preMergeTargetSnapshot,
			);
			if (plan.conflicts.length > 0) {
				// The target has since edited the very lines being rolled back. Same
				// situation the commit path reports when a revert conflicts, and the
				// worktree is left untouched.
				throw new ValidationError(
					`Cannot automatically unmerge: reversing this merge conflicts in ${plan.conflicts.length} file(s) ` +
						`(${plan.conflicts.slice(0, 5).join(", ")}${plan.conflicts.length > 5 ? "…" : ""}). ` +
						"Resolve them manually in the target worktree.",
				);
			}
			await applySnapshotUnmerge(
				targetWorktree,
				plan,
				`Unmerge ${source.branch} from ${target.branch}`,
			);
		});

		// Step 2: recreate the source worktree, then put its uncommitted work back.
		const branchSuffix = source.branch.split("/").slice(1).join("/");
		const worktreePath = resolve(gitPath, ".worktrees", branchSuffix);
		await gitService.createWorktree(gitPath, worktreePath, source.branch);
		const restored = await restoreSourceSnapshot(worktreePath, source.mergedSourceSnapshotSha);
		if (!restored.restored) {
			// Deliberately not fatal, and deliberately loud. The target is already
			// reverted, so aborting now would leave a worse in-between state; the branch
			// tip content is present, and naming the snapshot lets the work be recovered.
			warnings.push(
				`The chapter was restored to its last commit, but its uncommitted work could not be ` +
					`reapplied (${restored.reason ?? "unknown reason"}). Snapshot ` +
					`${source.mergedSourceSnapshotSha.slice(0, 12)} holds that state.`,
			);
			logger.warn("Unmerge could not restore the source chapter's uncommitted work", {
				sourceChapterId: source.id,
				snapshot: source.mergedSourceSnapshotSha,
				reason: restored.reason,
			});
		}

		// Step 3: source chapter is active again, and this merge's coordinates are gone.
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
					...clearedSnapshotMergeFields(),
					lastAccessedAt: now,
					updatedAt: now,
				})
				.where(eq(chapters.id, source.id));
		} catch (dbErr) {
			try {
				await gitService.removeWorktree(gitPath, worktreePath);
			} catch {
				// best effort
			}
			throw dbErr;
		}

		try {
			await chapterEdgeService.deleteMergeEdgesBySource(source.id);
		} catch (err) {
			logger.warn("Failed to remove merge edges during snapshot unmerge", {
				sourceChapterId: source.id,
				error: String(err),
			});
		}

		// The summary card for this merge carries no commit sha, so it is located by
		// round instead. See `cleanupForMerge`.
		try {
			const { deletedCount, narratorIds } = await mergeSummaryService.cleanupForMerge(
				source.id,
				null,
			);
			if (deletedCount > 0) {
				for (const nid of narratorIds) {
					eventBus.emit({
						type: "narrator:ws_broadcast",
						narratorId: nid,
						message: { type: "full_reload", narratorId: nid },
					});
				}
			}
		} catch (err) {
			logger.warn("Failed to clean up merge summary during snapshot unmerge", {
				sourceChapterId: source.id,
				error: String(err),
			});
		}

		eventBus.emit({ type: "chapter:woken", chapterId: source.id });
		return warnings.length > 0 ? { ok: true, warning: warnings.join(" ") } : { ok: true };
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
