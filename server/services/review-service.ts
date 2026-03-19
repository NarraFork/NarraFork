import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chapterEdges, chapters, narrators, projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId, generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { buildReviewSystemPrompt, getReviewStartMessage } from "../lib/prompt-i18n";
import { slugify } from "../lib/slug";
import { commitSyncService } from "./commit-sync-service";
import { gitService } from "./git-service";
import { narratorService } from "./narrator-service";
import { closeNarrator, sendMessage, updateNarratorChapterRole } from "./narrator-session";

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
		if (source.status !== "active") {
			throw new ValidationError("Can only review active chapters");
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

			// Step 6: Create fresh narrator with review prompt
			const narrator = await narratorService.create({
				chapterId: id,
				type: "primary",
				cwd: worktreePath,
				systemPrompt,
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

			// Step 7: Auto-start the review by sending the initial message
			const locale = input.locale ?? "en";
			const startMsg = getReviewStartMessage(locale);
			sendMessage(narrator.id, startMsg, undefined, locale).catch((err) => {
				logger.error("Failed to auto-start review", {
					reviewChapterId: id,
					narratorId: narrator.id,
					error: String(err),
				});
			});

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
	 * Shows the source chapter's changes relative to its base branch.
	 */
	async buildDiffContext(
		gitPath: string,
		source: typeof chapters.$inferSelect,
		sourceHeadSha: string,
	): Promise<string> {
		try {
			const baseRef = source.startCommitSha ?? source.baseBranch;
			const diff = await gitService.getDiffBetweenRefs(gitPath, baseRef, sourceHeadSha);
			if (!diff.trim()) {
				return "No code changes detected in the source chapter.";
			}
			return diff;
		} catch (err) {
			logger.warn("Failed to get diff for review context", { error: String(err) });
			return "Unable to retrieve diff. Please use Read and Grep tools to examine the codebase.";
		}
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
			where: and(eq(narrators.chapterId, reviewChapterId), eq(narrators.type, "primary")),
		});
		if (!reviewNarrator) throw new ValidationError("Review has no narrator");

		// Get source chapter's primary narrator
		const sourceNarrator = await db.query.narrators.findFirst({
			where: and(
				eq(narrators.chapterId, chapter.reviewSourceChapterId),
				eq(narrators.type, "primary"),
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
				subagentType: "review",
				parentNarratorId: sourceNarrator.id,
				chapterId: chapter.reviewSourceChapterId,
				cwd: sourceChapter?.worktreePath ?? sourceNarrator.cwd,
				status: "done",
				updatedAt: now,
			})
			.where(eq(narrators.id, reviewNarrator.id));

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
			where: and(eq(narrators.chapterId, reviewChapterId), eq(narrators.type, "primary")),
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
};
