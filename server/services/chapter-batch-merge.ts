import { formatOriginLabel } from "@shared/message-origin";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { mergeSessions, narrators } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getUserReplyInLanguage, type Locale } from "../lib/prompt-i18n";
import { chapterFork } from "./chapter-fork";
import { chapterMerge } from "./chapter-merge";
import { chapterService } from "./chapter-service";
import { narratorService } from "./narrator-service";
import { sendMessage } from "./narrator-session";

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

type MergeStrategy = "merge" | "squash" | "cherry-pick";
type MergeSessionRow = typeof mergeSessions.$inferSelect;

interface ProcessQueueInput {
	mergeSessionId: string;
	projectId: string;
	targetChapterId: string;
	sourceChapterIds: string[];
	strategy: MergeStrategy;
	isExistingTarget: boolean;
	locale?: Locale | null;
	userId?: string;
	startIndex?: number;
	mergedCount?: number;
	preserveTargetOnFailure?: boolean;
}

/**
 * Resolve a pending merge conflict decision.
 * Called from WebSocket when a user decides to continue or cancel.
 */
export async function resolveMergeDecision(
	mergeSessionId: string,
	decision: MergeDecision,
): Promise<void> {
	await chapterBatchMerge.resolveDecision(mergeSessionId, decision);
}

function sourceIdAt(session: MergeSessionRow): string | null {
	return session.currentSourceChapterId ?? session.sourceChapterIds[session.currentIndex] ?? null;
}

export const chapterBatchMerge = {
	/**
	 * Orchestrate a batch merge:
	 * 1. Fork base chapter into a new chapter (unless merging into an existing target)
	 * 2. Sequentially merge each source chapter into it
	 * 3. On conflict: keep the target worktree conflicted, start the target narrator,
	 *    then pause the session until the user chooses continue/cancel
	 * 4. On continue: verify conflicts are resolved, commit, mark the source merged, then resume
	 */
	async run(input: BatchMergeInput): Promise<{ mergeSessionId: string; targetChapterId: string }> {
		const mergeSessionId = generateId();
		const strategy = input.strategy ?? "merge";
		// Deduplicate source chapters while preserving order
		const sourceChapterIds = [...new Set(input.sourceChapterIds)];

		const base = await chapterService.getById(input.baseChapterId);
		if (!base) throw new NotFoundError("Chapter", input.baseChapterId);
		const projectId = base.projectId;
		let targetChapterId: string;

		if (input.targetChapterId) {
			// Merge into existing chapter — no fork
			const target = await chapterService.getById(input.targetChapterId);
			if (!target) throw new NotFoundError("Chapter", input.targetChapterId);
			if (target.status !== "active") throw new ValidationError("Target chapter must be active");
			if (!target.worktreePath) throw new ValidationError("Target chapter has no worktree");
			if (target.projectId !== projectId) {
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
			projectId,
			targetChapterId,
			sourceChapterIds,
		});

		// Step 2: Process merges in background (fire-and-forget)
		this.processQueue({
			mergeSessionId,
			projectId,
			targetChapterId,
			sourceChapterIds,
			strategy,
			isExistingTarget: !!input.targetChapterId,
			locale: input.locale,
			userId: input.userId,
		}).catch((err) => {
			logger.error("Batch merge processQueue unhandled error", {
				mergeSessionId,
				error: String(err),
			});
		});

		return { mergeSessionId, targetChapterId };
	},

	/** Internal: process the merge queue sequentially until complete or paused on conflict. */
	async processQueue(input: ProcessQueueInput): Promise<void> {
		const total = input.sourceChapterIds.length;
		let mergedCount = input.mergedCount ?? 0;
		let currentSourceId = "";

		try {
			for (let i = input.startIndex ?? 0; i < total; i++) {
				const sourceId = input.sourceChapterIds[i];
				currentSourceId = sourceId;
				const now = new Date().toISOString();

				await db
					.update(mergeSessions)
					.set({
						status: "running",
						currentIndex: i,
						currentSourceChapterId: sourceId,
						error: null,
						updatedAt: now,
					})
					.where(eq(mergeSessions.id, input.mergeSessionId));

				const result = await chapterMerge.startInteractiveConflictMerge(
					sourceId,
					{
						targetChapterId: input.targetChapterId,
						strategy: input.strategy,
					},
					input.locale ?? undefined,
					input.userId,
				);

				if (result.success) {
					mergedCount++;
					const stepNow = new Date().toISOString();
					await db
						.update(mergeSessions)
						.set({
							status: "running",
							mergedCount,
							conflictFiles: null,
							updatedAt: stepNow,
						})
						.where(eq(mergeSessions.id, input.mergeSessionId));

					eventBus.emit({
						type: "merge:step_ok",
						mergeSessionId: input.mergeSessionId,
						projectId: input.projectId,
						targetChapterId: input.targetChapterId,
						sourceChapterId: sourceId,
						index: i,
						total,
						commitSha: result.commitSha,
					});
					continue;
				}

				const conflictFiles = result.conflictFiles ?? [];
				const conflictNow = new Date().toISOString();
				await db
					.update(mergeSessions)
					.set({
						status: "waiting_decision",
						conflictFiles,
						updatedAt: conflictNow,
					})
					.where(eq(mergeSessions.id, input.mergeSessionId));

				let narratorId: string | undefined;
				if (result.conflictPrompt) {
					try {
						narratorId = await this.startConflictNarrator(
							input.targetChapterId,
							result.conflictPrompt,
							input.locale ?? undefined,
							input.userId,
						);
					} catch (err) {
						logger.error("Failed to start conflict resolution narrator; preserving merge chapter", {
							mergeSessionId: input.mergeSessionId,
							targetChapterId: input.targetChapterId,
							error: String(err),
						});
					}
				}

				eventBus.emit({
					type: "merge:conflict",
					mergeSessionId: input.mergeSessionId,
					projectId: input.projectId,
					targetChapterId: input.targetChapterId,
					sourceChapterId: sourceId,
					index: i,
					total,
					conflictFiles,
					narratorId,
				});
				if (narratorId) {
					eventBus.emit({
						type: "merge:ai_resolving",
						mergeSessionId: input.mergeSessionId,
						projectId: input.projectId,
						targetChapterId: input.targetChapterId,
						sourceChapterId: sourceId,
						narratorId,
					});
				}
				return;
			}

			const doneNow = new Date().toISOString();
			await db
				.update(mergeSessions)
				.set({
					status: "completed",
					mergedCount,
					currentIndex: total,
					currentSourceChapterId: null,
					conflictFiles: null,
					error: null,
					updatedAt: doneNow,
				})
				.where(eq(mergeSessions.id, input.mergeSessionId));

			eventBus.emit({
				type: "merge:completed",
				mergeSessionId: input.mergeSessionId,
				projectId: input.projectId,
				targetChapterId: input.targetChapterId,
				mergedCount,
			});
		} catch (err) {
			logger.error("Batch merge unexpected error", {
				mergeSessionId: input.mergeSessionId,
				sourceChapterId: currentSourceId,
				error: String(err),
			});
			eventBus.emit({
				type: "merge:error",
				mergeSessionId: input.mergeSessionId,
				projectId: input.projectId,
				targetChapterId: input.targetChapterId,
				sourceChapterId: currentSourceId,
				error: String(err),
			});
			await this.rollback(
				input.mergeSessionId,
				input.targetChapterId,
				String(err),
				input.isExistingTarget || input.preserveTargetOnFailure === true,
			);
		}
	},

	async startConflictNarrator(
		targetChapterId: string,
		prompt: string,
		locale?: Locale,
		userId?: string,
	): Promise<string> {
		const target = await chapterService.getById(targetChapterId);
		if (!target) throw new NotFoundError("Chapter", targetChapterId);
		if (!target.worktreePath) throw new ValidationError("Target chapter has no worktree");

		let narrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, targetChapterId), eq(narrators.variant, "primary")),
		});
		if (!narrator) {
			narrator = await narratorService.create({
				chapterId: targetChapterId,
				type: "primary",
				cwd: target.worktreePath,
				permissionMode: "default",
			});
		}

		const replyInUserLanguage = userId ? await getUserReplyInLanguage(userId) : false;
		// Conflict-resolution prompt assembled from the merge state. The user
		// started the merge, so keep their id, but they did not write this text.
		await sendMessage(
			narrator.id,
			prompt,
			[],
			locale ?? "en",
			replyInUserLanguage,
			null,
			userId,
			undefined,
			null,
			{ origin: "system", originLabel: formatOriginLabel("batchMerge") },
		);
		return narrator.id;
	},

	async resolveDecision(mergeSessionId: string, decision: MergeDecision): Promise<void> {
		const session = await db.query.mergeSessions.findFirst({
			where: eq(mergeSessions.id, mergeSessionId),
		});
		if (!session) {
			logger.warn("Merge decision for unknown session", { mergeSessionId });
			return;
		}

		const target = await chapterService.getById(session.targetChapterId);
		if (!target) throw new NotFoundError("Chapter", session.targetChapterId);
		const projectId = target.projectId;
		const sourceId = sourceIdAt(session);
		if (!sourceId) {
			throw new ValidationError("Merge session has no current source chapter");
		}

		if (decision === "cancel") {
			const now = new Date().toISOString();
			await db
				.update(mergeSessions)
				.set({ status: "cancelled", error: "User cancelled on conflict", updatedAt: now })
				.where(eq(mergeSessions.id, mergeSessionId));
			eventBus.emit({
				type: "merge:cancelled",
				mergeSessionId,
				projectId,
				targetChapterId: session.targetChapterId,
				reason: "User cancelled on conflict",
			});
			return;
		}

		if (session.status !== "waiting_decision") {
			logger.warn("Merge continue decision ignored for non-waiting session", {
				mergeSessionId,
				status: session.status,
			});
			return;
		}

		const result = await chapterMerge.completeInteractiveConflictMerge(
			sourceId,
			{
				targetChapterId: session.targetChapterId,
				strategy: session.strategy,
			},
			undefined,
		);
		if (!result.resolved) {
			const remainingFiles = result.remainingFiles ?? [];
			await chapterMerge.ensurePendingMergeEdge(
				sourceId,
				session.targetChapterId,
				session.strategy,
			);
			const now = new Date().toISOString();
			await db
				.update(mergeSessions)
				.set({
					status: "waiting_decision",
					conflictFiles: remainingFiles,
					error: result.error ?? "Merge conflicts remain",
					updatedAt: now,
				})
				.where(eq(mergeSessions.id, mergeSessionId));
			eventBus.emit({
				type: "merge:conflict",
				mergeSessionId,
				projectId,
				targetChapterId: session.targetChapterId,
				sourceChapterId: sourceId,
				index: session.currentIndex,
				total: session.sourceChapterIds.length,
				conflictFiles: remainingFiles,
			});
			return;
		}

		const mergedCount = session.mergedCount + 1;
		const now = new Date().toISOString();
		await db
			.update(mergeSessions)
			.set({
				status: "running",
				mergedCount,
				conflictFiles: null,
				error: null,
				updatedAt: now,
			})
			.where(eq(mergeSessions.id, mergeSessionId));
		eventBus.emit({
			type: "merge:step_ok",
			mergeSessionId,
			projectId,
			targetChapterId: session.targetChapterId,
			sourceChapterId: sourceId,
			index: session.currentIndex,
			total: session.sourceChapterIds.length,
			commitSha: result.mergeResult?.commitSha,
		});

		this.processQueue({
			mergeSessionId,
			projectId,
			targetChapterId: session.targetChapterId,
			sourceChapterIds: session.sourceChapterIds,
			strategy: session.strategy,
			isExistingTarget: true,
			locale: session.locale as Locale | null,
			startIndex: session.currentIndex + 1,
			mergedCount,
			preserveTargetOnFailure: true,
		}).catch((err) => {
			logger.error("Batch merge resume unhandled error", {
				mergeSessionId,
				error: String(err),
			});
		});
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
			logger.info("Batch merge failed, preserving target chapter", {
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
	 * Mark stale sessions (running/ai_resolving/waiting_decision) as error on server startup.
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
