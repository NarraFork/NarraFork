import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatOriginLabel } from "@shared/message-origin";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { chapterEdges, chapters, narrators, projects, reviewConclusions } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { worktreeLock } from "../lib/async-mutex";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { buildReviewSystemPrompt, getReviewStartMessage } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import { slugify } from "../lib/slug";
import { advanceChapterSnapshot, ensureChapterSnapshot } from "./chapter-snapshot-ref";
import { commitSyncService } from "./commit-sync-service";
import { gitService } from "./git-service";
import { narratorService } from "./narrator-service";
import { closeNarrator, sendMessage, updateNarratorChapterRole } from "./narrator-session";
import {
	SNAPSHOT_BASE_REF,
	SNAPSHOT_HEAD_REF,
	treeSnapshotKey,
	worktreeTreeSnapshot,
} from "./worktree-tree-snapshot";

export interface CreateReviewInput {
	title?: string;
	locale?: Locale;
	/** Ruler position: offsets relative to `anchorCommitSha`'s tick. */
	anchorCommitSha?: string;
	axisOffset?: number;
	crossOffset?: number;
	/**
	 * Classic canvas position: absolute React Flow world coordinates. Omitted leaves
	 * the review node unplaced there, so the canvas auto-lays it out — see
	 * `chapters.graphX` for why these cannot share the ruler columns.
	 */
	graphX?: number;
	graphY?: number;
	/** The user requesting the review; becomes the owner of the review narrator. */
	createdByUserId?: string | null;
}

export const reviewService = {
	/**
	 * Create a review node from a source chapter.
	 * Forks at the source's HEAD, creates a fresh narrator with review-specific prompt.
	 */
	async createReview(sourceChapterId: string, input: CreateReviewInput = {}) {
		const source = await db.query.chapters.findFirst({
			where: eq(chapters.id, sourceChapterId),
		});
		if (!source) throw new NotFoundError("Chapter", sourceChapterId);
		// Dormant sources are reviewable for the same reason they are forkable: dormant
		// only means the worktree was removed, and every worktree-dependent step here
		// already falls back to the repository path (`sourceWorktree` below, and the diff
		// context builder). Refusing it turned auto-dormant — which fires at a default of
		// 10 active worktrees — into "you must wake this chapter before it can be
		// reviewed", where waking rebuilds a worktree and mutates the chapter just to read
		// its branch tip. Merged and abandoned stay rejected: their branches may be gone.
		if (source.status !== "active" && source.status !== "dormant") {
			throw new ValidationError("Can only review active or dormant chapters");
		}

		const project = await db.query.projects.findFirst({
			where: eq(projects.id, source.projectId),
		});
		if (!project?.gitPath) throw new ValidationError("Project has no git repository configured");
		const gitPath = project.gitPath;

		// Get source HEAD commit
		const sourceWorktree = source.worktreePath ?? gitPath;
		const sourceHeadSha = await gitService.getHeadCommit(sourceWorktree);

		// Generate names
		const autoTitle = `Review: ${source.title.slice(0, 160)}`;
		const title = input.title || autoTitle;
		const slug = slugify(title);
		const shortId = generateShortId(6);
		const branchName = `review/${slug}-${shortId}`;
		const worktreePath = resolve(gitPath, ".worktrees", `${slug}-${shortId}`);
		const now = new Date().toISOString();
		const id = generateId();

		// Compute position (anchor to same commit as source, auto-avoid existing chapters)
		const NODE_CROSS_SIZE = 100;
		const resolvedAnchor = input.anchorCommitSha ?? source.anchorCommitSha ?? sourceHeadSha;
		const anchorCommitSha = resolvedAnchor;
		const axisOffset = input.axisOffset ?? source.axisOffset ?? 0;

		let crossOffset: number;
		if (input.crossOffset != null) {
			crossOffset = input.crossOffset;
		} else {
			// Find first free slot at this anchor commit
			const existing = await db
				.select({ crossOffset: chapters.crossOffset })
				.from(chapters)
				.where(eq(chapters.anchorCommitSha, resolvedAnchor));
			const occupied = new Set(
				existing.map((r) => Math.round((r.crossOffset ?? 0) / NODE_CROSS_SIZE)),
			);
			let slot = 0;
			while (occupied.has(slot)) slot++;
			crossOffset = slot * NODE_CROSS_SIZE;
		}

		const rollback: Array<() => Promise<void>> = [];

		try {
			// Step 1: Create git branch + worktree from source HEAD
			await gitService.createBranch(gitPath, branchName, sourceHeadSha);
			rollback.push(() => gitService.deleteBranch(gitPath, branchName));

			await gitService.createWorktree(gitPath, worktreePath, branchName);
			rollback.push(() => gitService.removeWorktree(gitPath, worktreePath));
			// `transferWorkingState` creates a shadow repository for this worktree and points
			// `refs/nf/head` into it, and a rollback that only removed the worktree left it
			// stranded forever: `gcAll` deletes only directories missing a HEAD (this one has
			// one), and the orphan sweep only walks `.worktrees` directories still present on
			// disk (rollback just deleted this one). Registered before the repo exists so it
			// covers every later failure point; `destroy` on a missing directory is a no-op,
			// and `force` is needed because the chapter row would otherwise be read as an
			// owner of this key.
			rollback.push(async () => {
				await worktreeTreeSnapshot.destroy(worktreePath, undefined, { force: true });
			});

			// Step 1.5: Reproduce the source's working state, so the reviewer sees what the
			// author is actually looking at rather than only the last commit.
			const transferred = await this.transferWorkingState(sourceWorktree, worktreePath);

			// Step 2: Create chapter record
			const [chapter] = await db
				.insert(chapters)
				.values({
					id,
					projectId: source.projectId,
					title,
					status: "active",
					role: "review",
					branch: branchName,
					worktreePath,
					baseBranch: source.branch,
					parentChapterId: sourceChapterId,
					reviewSourceChapterId: sourceChapterId,
					reviewStatus: "reviewing",
					forkPoint: { commitSha: sourceHeadSha },
					startCommitSha: sourceHeadSha,
					headCommitSha: sourceHeadSha,
					// Recorded here rather than left to the first tool call, so the review
					// workspace has a DAG position from the moment it exists: without one it
					// cannot be forked from, and the orphan sweep cannot tell its shadow
					// repository from an abandoned one.
					snapshotCommitSha: transferred.snapshotCommitSha,
					snapshotShadowKey: treeSnapshotKey(LOCAL_DEVICE_ID, worktreePath),
					anchorCommitSha,
					axisOffset,
					crossOffset,
					graphX: input.graphX ?? null,
					graphY: input.graphY ?? null,
					lastAccessedAt: now,
					createdAt: now,
					updatedAt: now,
				})
				.returning();
			rollback.push(async () => {
				await db.delete(chapters).where(eq(chapters.id, id));
			});

			// Step 3: Create review edge
			const edgeId = generateId();
			await db.insert(chapterEdges).values({
				id: edgeId,
				projectId: source.projectId,
				sourceId: sourceChapterId,
				targetId: id,
				type: "review",
				metadata: { commitSha: sourceHeadSha },
				createdAt: now,
			});

			// Step 4: Copy commit history
			try {
				await commitSyncService.copyCommitsForFork(sourceChapterId, id, sourceHeadSha);
			} catch (err) {
				logger.warn("Failed to copy commit history for review (non-fatal)", {
					sourceChapterId,
					reviewChapterId: id,
					error: String(err),
				});
			}

			// Step 5: Get diff for system prompt context
			const diffContext = await this.buildDiffContext(gitPath, source, sourceHeadSha);
			const systemPrompt = buildReviewSystemPrompt(diffContext, input.locale);

			// Step 6: Create fresh narrator with review prompt. Apply the configured
			// review subagent default model when set; empty string falls back to the
			// global default via FOLLOW_DEFAULT_MODEL inside narratorService.create.
			const reviewModel = settings.agent.subagentModels?.review || undefined;
			const narrator = await narratorService.create({
				chapterId: id,
				type: "primary",
				cwd: worktreePath,
				systemPrompt,
				ownerUserId: input.createdByUserId ?? null,
				...(reviewModel ? { model: reviewModel } : {}),
			});
			rollback.push(async () => {
				await narratorService.remove(narrator.id);
			});

			logger.info("Review node created", {
				id,
				sourceChapterId,
				branch: branchName,
				sourceHeadSha,
			});

			eventBus.emit({
				type: "review:created",
				reviewChapterId: id,
				sourceChapterId,
			});

			// Step 7: Auto-start the review by sending the initial message.
			// Awaited so that a failure triggers the outer catch → rollback.
			// A review that can't start is useless — better to roll back cleanly.
			const locale = input.locale ?? "en";
			const startMsg = getReviewStartMessage(locale);
			// Kickoff prompt generated by the review service, not typed by a user.
			await sendMessage(
				narrator.id,
				startMsg,
				undefined,
				locale,
				false,
				null,
				null,
				undefined,
				null,
				{
					origin: "system",
					originLabel: formatOriginLabel("review"),
				},
			);

			return chapter;
		} catch (err) {
			logger.error("Review creation failed, rolling back", { error: String(err) });
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

	/**
	 * Build diff context string for the review narrator's system prompt.
	 * Shows the source chapter's changes relative to its base branch,
	 * plus any uncommitted/untracked changes in the source worktree.
	 *
	 * Diff output is capped at ~80k chars (~20k tokens) to avoid exceeding
	 * the model's context window.  Committed changes take priority; uncommitted
	 * changes fill the remaining budget.
	 */
	async buildDiffContext(
		gitPath: string,
		source: typeof chapters.$inferSelect,
		sourceHeadSha: string,
	): Promise<string> {
		// ~20k tokens ≈ 80k chars — leave room for the rest of the system prompt
		const MAX_DIFF_CHARS = 80_000;
		const TRUNCATION_COMMITTED =
			"\n\n[Diff truncated — committed changes exceed size limit. " +
			"Use the Read and Grep tools to examine specific files in detail.]\n";
		const TRUNCATION_UNCOMMITTED =
			"\n\n[Uncommitted diff truncated. " +
			"Use the Read and Grep tools to examine specific files in detail.]\n";

		const parts: string[] = [];
		let totalLen = 0;

		// Committed diff (higher priority)
		try {
			const baseRef = source.startCommitSha ?? source.baseBranch;
			const committedDiff = await gitService.getDiffBetweenRefs(gitPath, baseRef, sourceHeadSha);
			if (committedDiff.trim()) {
				if (committedDiff.length <= MAX_DIFF_CHARS) {
					parts.push(committedDiff);
					totalLen += committedDiff.length;
				} else {
					parts.push(truncateAtLine(committedDiff, MAX_DIFF_CHARS));
					totalLen = MAX_DIFF_CHARS;
					parts.push(TRUNCATION_COMMITTED);
				}
			}
		} catch (err) {
			logger.warn("Failed to get committed diff for review context", { error: String(err) });
		}

		// Uncommitted diff (lower priority, only if budget remains)
		if (totalLen < MAX_DIFF_CHARS) {
			const sourceWorktree = source.worktreePath ?? gitPath;
			try {
				const uncommittedDiff = await gitService.getFullDiff(sourceWorktree);
				if (uncommittedDiff.trim()) {
					const header = "\n--- Uncommitted changes in source worktree ---\n";
					const remaining = MAX_DIFF_CHARS - totalLen;
					if (uncommittedDiff.length + header.length <= remaining) {
						parts.push(header, uncommittedDiff);
					} else {
						const budget = remaining - header.length;
						parts.push(header, budget > 0 ? truncateAtLine(uncommittedDiff, budget) : "");
						parts.push(TRUNCATION_UNCOMMITTED);
					}
				}
			} catch (err) {
				logger.warn("Failed to get uncommitted diff for review context", {
					error: String(err),
				});
			}
		}

		if (parts.length === 0) {
			return "No code changes detected in the source chapter.";
		}
		return parts.join("\n");
	},

	/**
	 * Check a review workspace after an agent turn, restoring it if the reviewer wrote.
	 *
	 * ## Why this compares tree hashes and not `git status`
	 *
	 * It used to ask `git status` whether anything was uncommitted, and that question is
	 * unanswerable here: `createReview` deliberately transfers the AUTHOR's uncommitted
	 * work into this worktree (see {@link transferWorkingState}), so the reviewed changes
	 * are themselves uncommitted and untracked. Every turn therefore read as dirty, and
	 * the "repair" — `reset --hard` plus `git checkout HEAD -- .` and `git clean -fd` —
	 * deleted the very code under review. The reviewer then re-examined an empty
	 * workspace, reported that the files no longer existed, and the check fired again on
	 * the next turn: a loop that could not terminate while the source had any
	 * uncommitted work.
	 *
	 * `refs/nf/base` names the exact state the reviewer was handed, which is the only
	 * thing "did the reviewer change something" can honestly be measured against. It is
	 * stable by construction: `transferWorkingState` writes it once, and the snapshot
	 * hooks that run on the review narrator's own tool calls only advance
	 * `refs/nf/head`.
	 *
	 * ## Why a missing baseline means "clean" rather than falling back
	 *
	 * The old `git status` path is not a safe fallback — it is the bug. Declining to
	 * check costs a soft guard (the system prompt already tells the reviewer not to
	 * modify files, and a stray edit lives only in a throwaway worktree); falling back
	 * costs the user the code being reviewed.
	 */
	async checkAndResetGitState(
		reviewChapterId: string,
	): Promise<{ clean: boolean; message?: string }> {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, reviewChapterId),
		});
		if (!chapter || chapter.role !== "review" || !chapter.worktreePath) {
			return { clean: true };
		}

		const expectedSha = chapter.startCommitSha ?? chapter.headCommitSha;
		if (!expectedSha) return { clean: true };

		const worktreePath = chapter.worktreePath;
		try {
			// Held across the whole observe-then-restore sequence rather than relying on the
			// individual writes' own locks. The decision of *what* to restore comes from the
			// state read at the top, so a write landing between the read and the restore
			// would be judged by an observation that no longer describes the worktree.
			// Two overlapping turn-end checks are the realistic trigger, and both would
			// otherwise pass through the per-method locks one after the other.
			return await worktreeLock.acquire(worktreePath, async () => {
				const baselineTree = await this.resolveReviewBaselineTree(worktreePath);
				if (!baselineTree) {
					logger.warn("Review workspace has no baseline snapshot; skipping the dirty check", {
						reviewChapterId,
						worktreePath,
					});
					return { clean: true };
				}

				const currentTree = await worktreeTreeSnapshot.tryCapture(worktreePath);
				if (!currentTree) {
					logger.warn("Could not capture the review workspace; skipping the dirty check", {
						reviewChapterId,
						worktreePath,
					});
					return { clean: true };
				}

				const contentChanged = currentTree !== baselineTree;
				const currentHead = await gitService.getHeadCommit(worktreePath);
				const headMoved = currentHead !== expectedSha;

				if (!contentChanged && !headMoved) {
					return { clean: true };
				}

				// Order is load-bearing. `reset --hard` throws away uncommitted work, and in
				// this worktree that work IS the change under review, so the baseline has to
				// be written back afterwards — unconditionally, because a commit the reviewer
				// made may also have absorbed some of it.
				if (headMoved) {
					await gitService.resetHardUnlocked(worktreePath, expectedSha);
				}
				await worktreeTreeSnapshot.materializeTree(worktreePath, baselineTree);

				const reasons: string[] = [];
				if (contentChanged) reasons.push("file modifications detected");
				if (headMoved) reasons.push("HEAD commit was moved");

				// Says "the state under review" rather than "the original state": the earlier
				// wording implied a return to the last commit, and a reviewer reading it
				// concluded the changes were never supposed to be there.
				const message =
					`[System] Your working tree has been restored to the state under review (${reasons.join(", ")}). ` +
					"The changes being reviewed — including uncommitted ones — are present again. " +
					"As a reviewer, you must not modify any files. " +
					"Please re-examine the code and submit your review conclusion with ConcludeReview.";

				logger.info("Review workspace restored to its baseline", {
					reviewChapterId,
					reasons,
					expectedSha,
					baselineTree,
					currentTree,
				});

				return { clean: false, message };
			});
		} catch (err) {
			logger.error("Failed to check/restore review git state", {
				reviewChapterId,
				error: String(err),
			});
			return { clean: true }; // Don't block on errors
		}
	},

	/**
	 * Announce a review conclusion, moving the chapter to `concluded` the first time.
	 *
	 * An already-concluded review still emits the event. The event means "there is a new
	 * conclusion", not "the status changed": a reviewer that revises its verdict (after
	 * the workspace guard restored its files, say) must be able to reach the source
	 * chapter again, and gating the announcement on the status transition made the second
	 * submission silently go nowhere.
	 *
	 * `converted` and `dismissed` stay closed — those reviews have had their worktree and
	 * narrator torn down, so there is no consistent thing left to announce.
	 */
	async concludeReview(reviewChapterId: string) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, reviewChapterId),
		});
		if (!chapter || chapter.role !== "review") return;
		if (chapter.reviewStatus !== "reviewing" && chapter.reviewStatus !== "concluded") return;
		if (!chapter.reviewSourceChapterId) return;

		const revised = chapter.reviewStatus === "concluded";
		const now = new Date().toISOString();
		if (!revised) {
			await db
				.update(chapters)
				.set({ reviewStatus: "concluded", updatedAt: now })
				.where(eq(chapters.id, reviewChapterId));
		}

		eventBus.emit({
			type: "review:concluded",
			reviewChapterId,
			sourceChapterId: chapter.reviewSourceChapterId,
			revised,
		});

		logger.info(revised ? "Review conclusion revised" : "Review concluded", { reviewChapterId });
	},

	/**
	 * Get the latest structured conclusion for a review chapter.
	 * Returns null if no structured conclusion was submitted via ConcludeReview tool.
	 */
	async getConclusion(reviewChapterId: string) {
		return db.query.reviewConclusions.findFirst({
			where: eq(reviewConclusions.reviewChapterId, reviewChapterId),
			orderBy: [desc(reviewConclusions.createdAt)],
		});
	},

	/**
	 * Get the latest structured conclusion for a source chapter (across all its reviews).
	 * Returns the most recent conclusion from any review of this source chapter.
	 */
	async getLatestConclusionForSource(sourceChapterId: string) {
		return db.query.reviewConclusions.findFirst({
			where: eq(reviewConclusions.sourceChapterId, sourceChapterId),
			orderBy: [desc(reviewConclusions.createdAt)],
		});
	},

	/**
	 * Dismiss a review — clean up resources and mark as dismissed.
	 */
	async dismissReview(reviewChapterId: string) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, reviewChapterId),
		});
		if (!chapter || chapter.role !== "review") {
			throw new ValidationError("Not a review chapter");
		}
		if (chapter.reviewStatus === "converted") {
			throw new ValidationError("Cannot dismiss a converted review");
		}

		const project = await db.query.projects.findFirst({
			where: eq(projects.id, chapter.projectId),
		});

		// Interrupt any running narrators before removing git resources
		const chapterNarrators = await db.query.narrators.findMany({
			where: eq(narrators.chapterId, reviewChapterId),
		});
		for (const n of chapterNarrators) {
			closeNarrator(n.id);
		}

		// Clean up git resources
		if (chapter.worktreePath && project?.gitPath) {
			try {
				await gitService.removeWorktree(project.gitPath, chapter.worktreePath);
			} catch (err) {
				logger.warn("Failed to remove review worktree", { error: String(err) });
			}
			try {
				await gitService.deleteBranch(project.gitPath, chapter.branch);
			} catch (err) {
				logger.warn("Failed to delete review branch", { error: String(err) });
			}
			// The review workspace now has a shadow repository of its own, and the chapter
			// row that claims it is about to go. `force` is required for exactly that
			// reason: the ownership guard reads the row being deleted.
			await worktreeTreeSnapshot
				.destroy(chapter.worktreePath, undefined, { force: true })
				.catch((err) =>
					logger.debug("Failed to remove review tree snapshots", { error: String(err) }),
				);
		}

		// Archive narrators (already closed above)
		for (const n of chapterNarrators) {
			await narratorService.updateStatus(n.id, "archived");
		}

		const now = new Date().toISOString();
		await db
			.update(chapters)
			.set({
				reviewStatus: "dismissed",
				status: "abandoned",
				worktreePath: null,
				updatedAt: now,
			})
			.where(eq(chapters.id, reviewChapterId));

		eventBus.emit({ type: "review:dismissed", reviewChapterId });
		logger.info("Review dismissed", { reviewChapterId });
	},

	/**
	 * Convert review narrator into a subagent of the source chapter's narrator.
	 * The review chapter is cleaned up, and the narrator is re-parented.
	 */
	async convertToSubagent(reviewChapterId: string) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, reviewChapterId),
		});
		if (!chapter || chapter.role !== "review") {
			throw new ValidationError("Not a review chapter");
		}
		if (chapter.reviewStatus !== "concluded") {
			throw new ValidationError("Review must be concluded before converting to subagent");
		}
		if (!chapter.reviewSourceChapterId) {
			throw new ValidationError("Review has no source chapter");
		}

		// Get review's primary narrator
		const reviewNarrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, reviewChapterId), eq(narrators.variant, "primary")),
		});
		if (!reviewNarrator) throw new ValidationError("Review has no narrator");

		// Get source chapter's primary narrator
		const sourceNarrator = await db.query.narrators.findFirst({
			where: and(
				eq(narrators.chapterId, chapter.reviewSourceChapterId),
				eq(narrators.variant, "primary"),
			),
		});
		if (!sourceNarrator) throw new ValidationError("Source chapter has no narrator");

		const now = new Date().toISOString();

		// Re-parent the review narrator as a subagent of the source narrator
		// Also update cwd to source chapter's worktree since the review worktree will be removed
		const sourceChapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, chapter.reviewSourceChapterId),
			columns: { worktreePath: true },
		});
		await db
			.update(narrators)
			.set({
				type: "subagent",
				variant: "subagent:review",
				subagentType: "review",
				parentNarratorId: sourceNarrator.id,
				chapterId: chapter.reviewSourceChapterId,
				cwd: sourceChapter?.worktreePath ?? sourceNarrator.cwd,
				updatedAt: now,
			})
			.where(eq(narrators.id, reviewNarrator.id));

		// Use updateStatus to ensure event bus + WS broadcast
		await narratorService.updateStatus(reviewNarrator.id, "idle", {
			substatus: ["unread"],
		});

		// Clean up review chapter's git resources
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, chapter.projectId),
		});
		if (chapter.worktreePath && project?.gitPath) {
			try {
				await gitService.removeWorktree(project.gitPath, chapter.worktreePath);
			} catch (err) {
				logger.warn("Failed to remove review worktree during conversion", {
					error: String(err),
				});
			}
			try {
				await gitService.deleteBranch(project.gitPath, chapter.branch);
			} catch (err) {
				logger.warn("Failed to delete review branch during conversion", {
					error: String(err),
				});
			}
			// Same reasoning as `deleteReview`: the workspace is gone and the row that
			// claims its shadow repository is being emptied, so nothing will read the
			// lineage again.
			await worktreeTreeSnapshot
				.destroy(chapter.worktreePath, undefined, { force: true })
				.catch((err) =>
					logger.debug("Failed to remove review tree snapshots during conversion", {
						error: String(err),
					}),
				);
		}

		// Update review chapter status
		await db
			.update(chapters)
			.set({
				reviewStatus: "converted",
				status: "abandoned",
				worktreePath: null,
				updatedAt: now,
			})
			.where(eq(chapters.id, reviewChapterId));

		eventBus.emit({
			type: "review:converted",
			reviewChapterId,
			action: "subagent",
		});

		logger.info("Review converted to subagent", {
			reviewChapterId,
			reviewNarratorId: reviewNarrator.id,
			sourceNarratorId: sourceNarrator.id,
		});

		return reviewNarrator;
	},

	/**
	 * Promote a review node to a regular branch chapter.
	 * The review keeps its worktree and narrator, just changes role.
	 */
	async promoteToChapter(reviewChapterId: string) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, reviewChapterId),
		});
		if (!chapter || chapter.role !== "review") {
			throw new ValidationError("Not a review chapter");
		}
		if (chapter.reviewStatus !== "concluded" && chapter.reviewStatus !== "reviewing") {
			throw new ValidationError("Review must be in reviewing or concluded state to promote");
		}

		const now = new Date().toISOString();

		// Change role to branch, keep everything else
		await db
			.update(chapters)
			.set({
				role: "branch",
				reviewStatus: "converted",
				reviewSourceChapterId: null,
				updatedAt: now,
			})
			.where(eq(chapters.id, reviewChapterId));

		// Convert review edge to fork edge
		await db
			.update(chapterEdges)
			.set({ type: "fork" })
			.where(and(eq(chapterEdges.targetId, reviewChapterId), eq(chapterEdges.type, "review")));

		// Sync in-memory narrator cache so the agent loop stops treating this as a review
		const reviewNarrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, reviewChapterId), eq(narrators.variant, "primary")),
			columns: { id: true },
		});
		if (reviewNarrator) {
			updateNarratorChapterRole(reviewNarrator.id, "branch");
		}

		eventBus.emit({
			type: "review:converted",
			reviewChapterId,
			action: "promote",
		});

		logger.info("Review promoted to chapter", { reviewChapterId });

		return await db.query.chapters.findFirst({
			where: eq(chapters.id, reviewChapterId),
		});
	},

	/**
	 * Reproduce a source workspace's exact state in a freshly created review worktree.
	 *
	 * Prefers the snapshot DAG, which is byte-exact and gives the review workspace a
	 * lineage of its own — the fallback has neither property. `copyDirtyFiles` walks
	 * `git status --porcelain`, and porcelain reports a wholly new directory as a single
	 * `?? dir/` entry, so reading it as a file fails and the entire subtree silently
	 * misses the review. Adopting the source's lineage additionally means the review
	 * chapter can later be forked or merged in snapshot space like any other.
	 *
	 * Whichever path runs, `refs/nf/base` ends up naming the state the reviewer was
	 * handed. That ref is what {@link checkAndResetGitState} compares against, and it is
	 * the only stable answer available: `refs/nf/head` advances on every tool call the
	 * review narrator makes, and `git status` cannot answer the question at all, because
	 * the transferred work IS uncommitted by construction (see A2 below).
	 *
	 * Never throws: a review that shows committed state plus a warning is far more
	 * useful than no review at all.
	 */
	async transferWorkingState(
		sourceWorktree: string,
		targetWorktree: string,
	): Promise<{
		snapshotCommitSha: string | null;
		viaSnapshot: boolean;
		/** Snapshot commit `refs/nf/base` was left pointing at, when one could be recorded. */
		baselineCommitSha: string | null;
	}> {
		try {
			const source = await ensureChapterSnapshot(sourceWorktree, "review base state");
			if (source) {
				await worktreeTreeSnapshot.restoreInto(sourceWorktree, targetWorktree, source.treeHash);
				// The review continues from the reviewed state, so its lineage starts there.
				// Fetched rather than referenced, because shadow repositories share no objects
				// and the source's may be removed while the review is still open.
				const adopted = await worktreeTreeSnapshot.fetchSnapshotFrom(
					targetWorktree,
					sourceWorktree,
					SNAPSHOT_HEAD_REF,
					SNAPSHOT_BASE_REF,
				);
				if (adopted) {
					await worktreeTreeSnapshot.setRef(targetWorktree, SNAPSHOT_HEAD_REF, adopted);
					return { snapshotCommitSha: adopted, viaSnapshot: true, baselineCommitSha: adopted };
				}
				// The bytes are right (`restoreInto` already ran) but the lineage did not
				// come across, so `refs/nf/base` is still unset. Recording one locally keeps
				// the dirty check working: without it every turn-end check falls into the
				// "no baseline" branch and stops guarding at all.
				const baseline = await this.recordReviewBaseline(targetWorktree);
				return { snapshotCommitSha: baseline, viaSnapshot: true, baselineCommitSha: baseline };
			}
		} catch (err) {
			logger.warn("Snapshot transfer into the review worktree failed; copying dirty files", {
				sourceWorktree,
				targetWorktree,
				error: String(err),
			});
		}
		await this.copyDirtyFiles(sourceWorktree, targetWorktree);
		// Same reasoning as the `!adopted` branch: the copy path never touches the DAG,
		// so the baseline has to be captured here or the guard has nothing to compare to.
		const baseline = await this.recordReviewBaseline(targetWorktree);
		return { snapshotCommitSha: null, viaSnapshot: false, baselineCommitSha: baseline };
	},

	/**
	 * Capture the review workspace as it stands and record it as `refs/nf/base`.
	 *
	 * For the transfer paths that produced correct bytes without carrying a lineage
	 * across. Advancing the DAG first (rather than only writing a tree) is what makes
	 * the baseline a commit, which `refs/nf/base` requires and which keeps the review
	 * workspace forkable/mergeable like any other.
	 *
	 * ## Write-once
	 *
	 * An existing baseline is returned unchanged rather than replaced. The guard is a
	 * comparison AGAINST this ref, so re-recording it on a workspace the reviewer has
	 * already written to would adopt those writes as "the state under review" — after
	 * which every later check compares the workspace with itself, reports clean, and
	 * silently stops reverting anything. There is no error in that state and no symptom
	 * other than a reviewer's edits surviving, which looks like the reviewer complying.
	 *
	 * Only ever called right after a transfer, so the early return is not a behaviour
	 * change for the real call sites — it is a guard against a second caller appearing.
	 *
	 * Returns null instead of throwing: a review with no baseline degrades to "the
	 * reviewer's edits are not reverted", while a throw here would abort the whole
	 * review creation and roll it back.
	 */
	async recordReviewBaseline(worktreePath: string): Promise<string | null> {
		try {
			const existing = await worktreeTreeSnapshot
				.getRef(worktreePath, SNAPSHOT_BASE_REF)
				.catch(() => null);
			if (existing) {
				logger.debug("Review baseline already recorded; keeping the original", {
					worktreePath,
					baselineCommitSha: existing,
				});
				return existing;
			}
			const advanced = await advanceChapterSnapshot(worktreePath, null, "review base state");
			if (!advanced) return null;
			await worktreeTreeSnapshot.setRef(worktreePath, SNAPSHOT_BASE_REF, advanced.commitSha);
			return advanced.commitSha;
		} catch (err) {
			logger.warn("Could not record the review baseline snapshot", {
				worktreePath,
				error: String(err),
			});
			return null;
		}
	},

	/**
	 * The tree the reviewer was handed, or null when it cannot be resolved.
	 *
	 * Read from `refs/nf/base` rather than from a column, because the ref is already
	 * the stable answer: `transferWorkingState` writes it once and nothing moves it
	 * afterwards (`advanceChapterSnapshot` only touches `refs/nf/head`).
	 */
	async resolveReviewBaselineTree(worktreePath: string): Promise<string | null> {
		const baseCommit = await worktreeTreeSnapshot
			.getRef(worktreePath, SNAPSHOT_BASE_REF)
			.catch(() => null);
		if (!baseCommit) return null;
		return worktreeTreeSnapshot.treeOfSnapshot(worktreePath, baseCommit).catch(() => null);
	},

	/**
	 * Copy uncommitted/untracked files from source worktree to target worktree.
	 * Uses `git status --porcelain` to enumerate dirty files, then copies them.
	 * Deleted files are also removed in the target.
	 *
	 * Fallback for {@link transferWorkingState}; see there for why it is not preferred.
	 */
	async copyDirtyFiles(sourceWorktree: string, targetWorktree: string): Promise<void> {
		try {
			const status = await gitService.getStatus(sourceWorktree);
			if (!status.trim()) return; // nothing dirty

			// Parse porcelain output (line-based)
			const lines = status.split("\n").filter(Boolean);
			let copied = 0;
			for (const line of lines) {
				const x = line[0]; // index status
				const y = line[1]; // worktree status
				let filePath = line.slice(3).trim();
				if (!filePath) continue;

				// Handle renames: porcelain format is "R  old -> new"
				const isRename = x === "R" || y === "R";
				if (isRename && filePath.includes(" -> ")) {
					const parts = filePath.split(" -> ");
					// Copy the new file; the old path no longer exists in worktree
					filePath = parts[1].trim();
				}

				// Deleted in worktree
				if (y === "D" || (x === "D" && y === " ")) {
					try {
						rmSync(resolve(targetWorktree, filePath), { force: true });
					} catch {}
					continue;
				}

				// For all other statuses (modified, added, untracked, etc.), copy the file
				try {
					const srcPath = resolve(sourceWorktree, filePath);
					const dstPath = resolve(targetWorktree, filePath);
					const content = await Bun.file(srcPath).arrayBuffer();
					mkdirSync(dirname(dstPath), { recursive: true });
					await Bun.write(dstPath, content);
					copied++;
				} catch (err) {
					// Skip files that can't be read (e.g. broken symlinks)
					logger.debug("Failed to copy dirty file for review", {
						filePath,
						error: String(err),
					});
				}
			}
			if (copied > 0) {
				logger.info("Copied dirty files to review worktree", {
					sourceWorktree,
					targetWorktree,
					fileCount: copied,
				});
			}
		} catch (err) {
			// Non-fatal: review can still work with committed-only state
			logger.warn("Failed to copy dirty files for review (non-fatal)", {
				error: String(err),
			});
		}
	},
};

/** Truncate a string at the last newline before `maxLen`, avoiding mid-line cuts. */
function truncateAtLine(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	const lastNewline = text.lastIndexOf("\n", maxLen);
	return lastNewline > 0 ? text.slice(0, lastNewline) : text.slice(0, maxLen);
}
