import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { mergeSessions } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { chapterFork } from "./chapter-fork";
import { chapterMerge } from "./chapter-merge";
import { chapterService } from "./chapter-service";

export interface BatchMergeInput {
	/** The chapter to fork from as the merge base */
	baseChapterId: string;
	/** Chapters to merge into the forked chapter, in order */
	sourceChapterIds: string[];
	/** Title for the new forked chapter (only used when creating a new chapter) */
	title: string;
	description?: string;
	strategy?: "merge" | "squash" | "cherry-pick";
	locale?: Locale;
	userId?: string;
	/** If provided, merge directly into this existing chapter instead of forking a new one */
	targetChapterId?: string;
}

export type MergeDecision = "continue" | "cancel";

const DECISION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DECISION_POLL_INTERVAL_MS = 1000; // 1 second

/**
 * Resolve a pending merge conflict decision.
 * Called from WebSocket when a user decides to continue or cancel.
 */
export async function resolveMergeDecision(
	mergeSessionId: string,
	decision: MergeDecision,
): Promise<void> {
	const now = new Date().toISOString();
	const [updated] = await db
		.update(mergeSessions)
		.set({
			status: decision === "continue" ? "running" : "cancelled",
			updatedAt: now,
		})
		.where(eq(mergeSessions.id, mergeSessionId))
		.returning();

	if (!updated) {
		logger.warn("Merge decision for unknown session", { mergeSessionId });
	}
}

/**
 * Wait for a user decision on a merge conflict by polling DB.
 * Returns "cancel" on timeout.
 */
async function waitForDecision(mergeSessionId: string): Promise<MergeDecision> {
	const startTime = Date.now();
	while (Date.now() - startTime < DECISION_TIMEOUT_MS) {
		const session = await db.query.mergeSessions.findFirst({
			where: eq(mergeSessions.id, mergeSessionId),
		});
		if (!session) return "cancel";
		if (session.status === "running") return "continue";
		if (session.status === "cancelled") return "cancel";
		// Still waiting_decision — poll again
		await new Promise((r) => setTimeout(r, DECISION_POLL_INTERVAL_MS));
	}
	// Timeout — mark as cancelled
	const now = new Date().toISOString();
	await db
		.update(mergeSessions)
		.set({ status: "cancelled", error: "Decision timeout", updatedAt: now })
		.where(eq(mergeSessions.id, mergeSessionId));
	return "cancel";
}

export const chapterBatchMerge = {
	/**
	 * Orchestrate a batch merge:
	 * 1. Fork base chapter into a new chapter
	 * 2. Sequentially merge each source chapter into it
	 * 3. On conflict: broadcast event, wait for user decision
	 *    - continue → AI resolve, then next
	 *    - cancel → delete the forked chapter, stop
	 * 4. On completion: broadcast merge:completed
	 *
	 * Runs in the background (fire-and-forget from the HTTP handler).
	 * All progress is communicated via eventBus → WebSocket and persisted to DB.
	 */
	async run(input: BatchMergeInput): Promise<{ mergeSessionId: string; targetChapterId: string }> {
		const mergeSessionId = generateId();
		const strategy = input.strategy ?? "merge";
		// Deduplicate source chapters while preserving order
		const sourceChapterIds = [...new Set(input.sourceChapterIds)];

		let targetChapterId: string;

		if (input.targetChapterId) {
			// Merge into existing chapter — no fork
			const target = await chapterService.getById(input.targetChapterId);
			if (!target) throw new NotFoundError("Chapter", input.targetChapterId);
			if (target.status !== "active") throw new ValidationError("Target chapter must be active");
			if (!target.worktreePath) throw new ValidationError("Target chapter has no worktree");
			// Ensure target belongs to the same project as the base chapter
			const base = await chapterService.getById(input.baseChapterId);
			if (base && target.projectId !== base.projectId) {
				throw new ValidationError("Target chapter must be in the same project as the base chapter");
			}
			targetChapterId = target.id;
		} else {
			// Step 1: Fork base chapter (merge-new flow)
			const forkedChapter = await chapterFork.fork(input.baseChapterId, {
				title: input.title,
				description: input.description,
				inheritMode: "fresh",
			});
			targetChapterId = forkedChapter.id;
		}
		const now = new Date().toISOString();

		// Persist session to DB
		await db.insert(mergeSessions).values({
			id: mergeSessionId,
			targetChapterId,
			sourceChapterIds,
			strategy,
			status: "running",
			currentIndex: 0,
			mergedCount: 0,
			locale: input.locale ?? null,
			createdAt: now,
			updatedAt: now,
		});

		eventBus.emit({
			type: "merge:started",
			mergeSessionId,
			targetChapterId,
			sourceChapterIds,
		});

		// Step 2: Process merges in background (fire-and-forget)
		const isExistingTarget = !!input.targetChapterId;
		this.processQueue(
			mergeSessionId,
			targetChapterId,
			sourceChapterIds,
			strategy,
			isExistingTarget,
			input.locale,
			input.userId,
		).catch((err) => {
			logger.error("Batch merge processQueue unhandled error", {
				mergeSessionId,
				error: String(err),
			});
		});

		return { mergeSessionId, targetChapterId };
	},

	/** Internal: process the merge queue sequentially */
	async processQueue(
		mergeSessionId: string,
		targetChapterId: string,
		sourceChapterIds: string[],
		strategy: "merge" | "squash" | "cherry-pick",
		isExistingTarget: boolean,
		locale?: Locale,
		userId?: string,
	): Promise<void> {
		const total = sourceChapterIds.length;
		let mergedCount = 0;
		let currentSourceId = "";

		try {
			for (let i = 0; i < total; i++) {
				const sourceId = sourceChapterIds[i];
				currentSourceId = sourceId;
				const now = new Date().toISOString();

				// Update progress in DB
				await db
					.update(mergeSessions)
					.set({
						currentIndex: i,
						currentSourceChapterId: sourceId,
						updatedAt: now,
					})
					.where(eq(mergeSessions.id, mergeSessionId));

				// Try merge
				const result = await chapterMerge.merge(
					sourceId,
					{
						targetChapterId,
						strategy,
					},
					userId,
				);

				if (result.success) {
					mergedCount++;
					const stepNow = new Date().toISOString();
					await db
						.update(mergeSessions)
						.set({
							mergedCount,
							updatedAt: stepNow,
						})
						.where(eq(mergeSessions.id, mergeSessionId));

					eventBus.emit({
						type: "merge:step_ok",
						mergeSessionId,
						sourceChapterId: sourceId,
						index: i,
						total,
						commitSha: result.commitSha,
					});
					continue;
				}

				// Conflict — persist state and broadcast, then wait for decision
				const conflictNow = new Date().toISOString();
				await db
					.update(mergeSessions)
					.set({
						status: "waiting_decision",
						conflictFiles: result.conflictFiles ?? [],
						updatedAt: conflictNow,
					})
					.where(eq(mergeSessions.id, mergeSessionId));

				eventBus.emit({
					type: "merge:conflict",
					mergeSessionId,
					sourceChapterId: sourceId,
					index: i,
					total,
					conflictFiles: result.conflictFiles ?? [],
				});

				const decision = await waitForDecision(mergeSessionId);

				if (decision === "cancel") {
					// Rollback: delete the forked chapter entirely (skip if merging into existing)
					eventBus.emit({
						type: "merge:cancelled",
						mergeSessionId,
						reason: "User cancelled on conflict",
					});
					await this.rollback(mergeSessionId, targetChapterId, "User cancelled", isExistingTarget);
					return;
				}

				// User chose continue — AI resolve
				const aiNow = new Date().toISOString();
				await db
					.update(mergeSessions)
					.set({
						status: "ai_resolving",
						updatedAt: aiNow,
					})
					.where(eq(mergeSessions.id, mergeSessionId));

				eventBus.emit({
					type: "merge:ai_resolving",
					mergeSessionId,
					sourceChapterId: sourceId,
				});

				const aiResult = await chapterMerge.aiResolveConflicts(
					sourceId,
					{ targetChapterId, strategy },
					locale,
					userId,
				);

				if (!aiResult.resolved) {
					eventBus.emit({
						type: "merge:error",
						mergeSessionId,
						sourceChapterId: sourceId,
						error: aiResult.error ?? "AI resolution failed",
					});
					eventBus.emit({
						type: "merge:cancelled",
						mergeSessionId,
						reason: aiResult.error ?? "AI resolution failed",
					});
					await this.rollback(
						mergeSessionId,
						targetChapterId,
						aiResult.error ?? "AI resolution failed",
						isExistingTarget,
					);
					return;
				}

				mergedCount++;
				const resolvedNow = new Date().toISOString();
				await db
					.update(mergeSessions)
					.set({
						status: "running",
						mergedCount,
						conflictFiles: null,
						updatedAt: resolvedNow,
					})
					.where(eq(mergeSessions.id, mergeSessionId));

				eventBus.emit({
					type: "merge:step_ok",
					mergeSessionId,
					sourceChapterId: sourceId,
					index: i,
					total,
					commitSha: aiResult.mergeResult?.commitSha,
				});
			}

			// All merges completed
			const doneNow = new Date().toISOString();
			await db
				.update(mergeSessions)
				.set({
					status: "completed",
					mergedCount,
					currentIndex: total,
					updatedAt: doneNow,
				})
				.where(eq(mergeSessions.id, mergeSessionId));

			eventBus.emit({
				type: "merge:completed",
				mergeSessionId,
				targetChapterId,
				mergedCount,
			});
		} catch (err) {
			logger.error("Batch merge unexpected error", {
				mergeSessionId,
				sourceChapterId: currentSourceId,
				error: String(err),
			});
			eventBus.emit({
				type: "merge:error",
				mergeSessionId,
				sourceChapterId: currentSourceId,
				error: String(err),
			});
			// Rollback: delete the forked chapter (skip if merging into existing)
			await this.rollback(mergeSessionId, targetChapterId, String(err), isExistingTarget);
		}
	},

	/** Delete the forked chapter on cancellation/failure and update session status.
	 *  When isExistingTarget is true, skip chapter deletion (the target existed before the merge). */
	async rollback(
		mergeSessionId: string,
		targetChapterId: string,
		reason: string,
		isExistingTarget = false,
	): Promise<void> {
		if (!isExistingTarget) {
			try {
				await chapterService.remove(targetChapterId);
				logger.info("Batch merge rolled back", { mergeSessionId, targetChapterId });
			} catch (err) {
				logger.error("Failed to rollback batch merge", {
					mergeSessionId,
					targetChapterId,
					error: String(err),
				});
			}
		} else {
			logger.info("Batch merge into existing chapter failed, skipping chapter deletion", {
				mergeSessionId,
				targetChapterId,
			});
		}
		const now = new Date().toISOString();
		await db
			.update(mergeSessions)
			.set({ status: "error", error: reason, updatedAt: now })
			.where(eq(mergeSessions.id, mergeSessionId));
	},

	/** Get a merge session by ID. */
	async getSession(mergeSessionId: string) {
		return db.query.mergeSessions.findFirst({
			where: eq(mergeSessions.id, mergeSessionId),
		});
	},

	/**
	 * Mark stale sessions (running/ai_resolving) as error on server startup.
	 * These sessions were interrupted by a server restart.
	 */
	async cleanupStaleSessions(): Promise<void> {
		const now = new Date().toISOString();
		const staleStatuses = ["running", "ai_resolving", "waiting_decision"] as const;
		const stale = await db.query.mergeSessions.findMany({
			where: inArray(mergeSessions.status, [...staleStatuses]),
		});
		if (stale.length === 0) return;

		await db
			.update(mergeSessions)
			.set({
				status: "error",
				error: "Server restarted during merge",
				updatedAt: now,
			})
			.where(inArray(mergeSessions.status, [...staleStatuses]));

		logger.info("Cleaned up stale merge sessions", {
			count: stale.length,
			ids: stale.map((s) => s.id),
		});
	},
};
