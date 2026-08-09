import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatOriginLabel } from "@shared/message-origin";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { chapterEdges, chapters, narrators, projects, reviewConclusions } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { buildReviewSystemPrompt, getReviewStartMessage } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import { slugify } from "../lib/slug";
import { ensureChapterSnapshot } from "./chapter-snapshot-ref";
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
	anchorCommitSha?: string;
	axisOffset?: number;
	crossOffset?: number;
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
	 * Check git state of a review chapter after an agent turn.
	 * If dirty (files modified or HEAD moved), reset and return a message for re-injection.
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

		try {
			// Check for uncommitted changes
			const status = await gitService.getStatusSummary(chapter.worktreePath);
			const hasChanges = status.staged > 0 || status.unstaged > 0 || status.untracked > 0;

			// Check HEAD hasn't moved
			const currentHead = await gitService.getHeadCommit(chapter.worktreePath);
			const headMoved = currentHead !== expectedSha;

			if (!hasChanges && !headMoved) {
				return { clean: true };
			}

			// Reset to expected state
			if (headMoved) {
				await gitService.resetHard(chapter.worktreePath, expectedSha);
			}
			await gitService.discardAll(chapter.worktreePath);

			const reasons: string[] = [];
			if (hasChanges) reasons.push("file modifications detected");
			if (headMoved) reasons.push("HEAD commit was moved");

			const message =
				`[System] Your working tree has been reset to the original state (${reasons.join(", ")}). ` +
				"As a reviewer, you must not modify any files. " +
				"Please re-examine the code and output your review conclusion based on the original source.";

			logger.info("Review git state reset", {
				reviewChapterId,
				reasons,
				expectedSha,
			});

			return { clean: false, message };
		} catch (err) {
			logger.error("Failed to check/reset review git state", {
				reviewChapterId,
				error: String(err),
			});
			return { clean: true }; // Don't block on errors
		}
	},

	/**
	 * Mark a review as concluded when the agent loop ends cleanly.
	 * If a structured conclusion exists in review_conclusions (written by ConcludeReview tool),
	 * the review is concluded with that data. Otherwise, it's concluded without structured data.
	 */
	async concludeReview(reviewChapterId: string) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, reviewChapterId),
		});
		if (!chapter || chapter.role !== "review") return;
		if (chapter.reviewStatus !== "reviewing") return;
		if (!chapter.reviewSourceChapterId) return;

		const now = new Date().toISOString();
		await db
			.update(chapters)
			.set({ reviewStatus: "concluded", updatedAt: now })
			.where(eq(chapters.id, reviewChapterId));

		eventBus.emit({
			type: "review:concluded",
			reviewChapterId,
			sourceChapterId: chapter.reviewSourceChapterId,
		});

		logger.info("Review concluded", { reviewChapterId });
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
	 * Never throws: a review that shows committed state plus a warning is far more
	 * useful than no review at all.
	 */
	async transferWorkingState(
		sourceWorktree: string,
		targetWorktree: string,
	): Promise<{ snapshotCommitSha: string | null; viaSnapshot: boolean }> {
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
				}
				return { snapshotCommitSha: adopted ?? null, viaSnapshot: true };
			}
		} catch (err) {
			logger.warn("Snapshot transfer into the review worktree failed; copying dirty files", {
				sourceWorktree,
				targetWorktree,
				error: String(err),
			});
		}
		await this.copyDirtyFiles(sourceWorktree, targetWorktree);
		return { snapshotCommitSha: null, viaSnapshot: false };
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
