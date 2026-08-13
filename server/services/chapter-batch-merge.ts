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

/**
 * The in-flight snapshot merge coordinates, reset to null.
 *
 * Applied at every exit from `waiting_decision`, because `preMergeTree` is not a
 * record of what happened — it is a live instruction to restore the worktree, read
 * by cancellation and by the startup sweep. Once the conflict is resolved or the
 * merge is abandoned, that instruction has to stop existing, or a later reader would
 * roll the worktree back past work it should have kept.
 */
const CLEARED_SNAPSHOT_MERGE_STATE = {
	preMergeTree: null,
	conflictTree: null,
	preMergeTargetSnapshot: null,
	mergeSourceSnapshot: null,
} as const;

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
				worktreeSource: "workspace",
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
						// A snapshot merge leaves no git state behind, so how to finish or
						// abort it has to be written down. Persisted rather than kept in memory
						// because the decision arrives in a later request, possibly after a
						// restart — and a lost pre-merge tree would strand the worktree with
						// conflict markers and no way back.
						preMergeTree: result.snapshotState?.preMergeTree ?? null,
						conflictTree: result.snapshotState?.conflictTree ?? null,
						preMergeTargetSnapshot: result.snapshotState?.targetSnapshot ?? null,
						mergeSourceSnapshot: result.snapshotState?.sourceSnapshot ?? null,
						preMergeTargetSha: result.snapshotState?.preMergeTargetSha ?? null,
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
			// A cancelled snapshot merge has to be undone explicitly. The commit path can
			// rely on `git merge --abort`, but here the conflicted tree was written straight
			// into the worktree — leaving it would hand the user a directory full of
			// conflict markers with no pending merge to abort.
			//
			// Gated on `waiting_decision` for the same reason the continue branch is, and
			// here it is destructive rather than merely wasteful: restoring writes the
			// pre-merge tree over the worktree, so a second cancellation — a double click,
			// a re-delivered WebSocket frame, a cancel arriving after startup already
			// restored this session — would discard everything done since the first one.
			// Only a session still awaiting a decision has a conflicted tree to undo.
			const restorable = session.status === "waiting_decision" && !!session.preMergeTree;
			if (restorable && target.worktreePath) {
				try {
					await chapterMerge.abortInteractiveSnapshotMerge(
						target.worktreePath,
						session.preMergeTree as string,
					);
				} catch (err) {
					logger.error("Failed to restore the worktree after cancelling a snapshot merge", {
						mergeSessionId,
						targetChapterId: session.targetChapterId,
						preMergeTree: session.preMergeTree,
						error: String(err),
					});
				}
			}
			const now = new Date().toISOString();
			await db
				.update(mergeSessions)
				.set({
					status: "cancelled",
					error: "User cancelled on conflict",
					// The merge is dissolved, so its coordinates must not survive to route
					// another restore at this tree.
					...CLEARED_SNAPSHOT_MERGE_STATE,
					updatedAt: now,
				})
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

		// A session carrying snapshot state was started in snapshot mode, so it has to be
		// finished the same way: there is no git merge in progress for the commit path to
		// conclude.
		const result = session.preMergeTree
			? await chapterMerge.completeInteractiveSnapshotMergeById(
					sourceId,
					session.targetChapterId,
					session.strategy,
					{
						preMergeTree: session.preMergeTree,
						conflictTree: session.conflictTree ?? session.preMergeTree,
						targetSnapshot: session.preMergeTargetSnapshot ?? "",
						sourceSnapshot: session.mergeSourceSnapshot ?? "",
						preMergeTargetSha: session.preMergeTargetSha ?? null,
						conflictFiles: session.conflictFiles ?? [],
					},
				)
			: await chapterMerge.completeInteractiveConflictMerge(
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
				// This conflict is resolved and recorded, so its coordinates are spent.
				// Leaving them would be actively harmful rather than untidy: the session
				// goes back to `running` while the queue advances, and a restart in that
				// window would find a non-null `preMergeTree` and restore the worktree to
				// the state before a merge that has already completed.
				...CLEARED_SNAPSHOT_MERGE_STATE,
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
	 *
	 * A stale SNAPSHOT merge cannot just be marked: its conflicted tree was written
	 * straight into the target worktree, and `preMergeTree` is the only way back. Once
	 * the session is `error` nothing reaches `resolveDecision` any more — the decision
	 * only arrives over WebSocket, and the notification that carried it died with the
	 * previous process — so the recorded tree would become dead data while the user is
	 * left holding a directory full of conflict markers with no UI path to undo it.
	 * That is exactly the restart the tree was persisted to survive, so the restore
	 * happens here, before the row stops being actionable.
	 */
	async cleanupStaleSessions(): Promise<void> {
		const staleStatuses = ["running", "ai_resolving", "waiting_decision"] as const;
		const stale = await db.query.mergeSessions.findMany({
			where: inArray(mergeSessions.status, [...staleStatuses]),
		});
		if (stale.length === 0) return;

		// Only snapshot-mode sessions left bytes on disk. The commit path has git's own
		// half-finished merge state, which `git merge --abort` can still resolve later.
		const snapshotStale = stale.filter((session) => session.preMergeTree !== null);
		const restored: string[] = [];
		for (const session of snapshotStale) {
			const outcome = await this.restoreStaleSnapshotWorktree(session);
			if (outcome.restored) restored.push(session.id);
			const now = new Date().toISOString();
			await db
				.update(mergeSessions)
				.set({
					status: "error",
					error: outcome.restored
						? "Server restarted during merge; the target worktree was restored to its pre-merge state"
						: `Server restarted during merge; the target worktree may still contain conflict markers (${outcome.reason})`,
					// Cleared whether or not the restore succeeded. These coordinates describe
					// a merge that can no longer be completed, and `resolveDecision` reads
					// `preMergeTree` to route a cancellation — a leftover value would let a
					// stale decision overwrite whatever the user has done since the restart
					// with pre-merge bytes.
					...CLEARED_SNAPSHOT_MERGE_STATE,
					updatedAt: now,
				})
				.where(eq(mergeSessions.id, session.id));
		}

		const remaining = stale
			.filter((session) => session.preMergeTree === null)
			.map((session) => session.id);
		if (remaining.length > 0) {
			const now = new Date().toISOString();
			await db
				.update(mergeSessions)
				.set({
					status: "error",
					error: "Server restarted during merge",
					updatedAt: now,
				})
				.where(inArray(mergeSessions.id, remaining));
		}

		logger.info("Cleaned up stale merge sessions", {
			count: stale.length,
			ids: stale.map((s) => s.id),
			snapshotSessions: snapshotStale.length,
			worktreesRestored: restored.length,
		});
	},

	/**
	 * Return one interrupted snapshot merge's target worktree to its pre-merge bytes.
	 *
	 * Never throws: this runs during startup over every stale session, so one
	 * unrestorable worktree must not stop the others from being cleaned up. The reason
	 * is returned instead, to be recorded on the session where the user can see it.
	 */
	async restoreStaleSnapshotWorktree(
		session: MergeSessionRow,
	): Promise<{ restored: boolean; reason?: string }> {
		const preMergeTree = session.preMergeTree;
		if (!preMergeTree) return { restored: false, reason: "no pre-merge tree recorded" };
		try {
			const target = await chapterService.getById(session.targetChapterId);
			if (!target?.worktreePath) {
				// Nothing to restore into. The snapshot itself still exists in the shadow
				// repository, so waking the chapter can recover the state.
				return { restored: false, reason: "target chapter has no worktree" };
			}
			await chapterMerge.abortInteractiveSnapshotMerge(target.worktreePath, preMergeTree);
			logger.info("Restored a worktree left conflicted by an interrupted snapshot merge", {
				mergeSessionId: session.id,
				targetChapterId: session.targetChapterId,
				preMergeTree,
			});
			return { restored: true };
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			logger.error("Could not restore a worktree left conflicted by an interrupted merge", {
				mergeSessionId: session.id,
				targetChapterId: session.targetChapterId,
				preMergeTree,
				error: reason,
			});
			return { restored: false, reason };
		}
	},
};
