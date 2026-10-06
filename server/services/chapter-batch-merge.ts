import { formatOriginLabel } from "@shared/message-origin";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { db } from "../db";
import { mergeSessions, narrators } from "../db/schema";
import { AsyncMutex } from "../lib/async-mutex";
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

/** Per-session serial lock for continue/cancel decisions. */
const mergeDecisionLock = new AsyncMutex();

/**
 * Startup gate error text. The interrupted worktree is left exactly as the process
 * died with it — never restored, never advanced — and the snapshot coordinates stay
 * on the row as diagnostic evidence.
 */
const STALE_MERGE_SESSION_ERROR =
	"Server restarted during merge; workspace preserved (not automatically restored)";

/** How many stale sessions one cursor page reads. Bounded so startup never `all()`s the table. */
const STALE_MERGE_BATCH_LIMIT = 100;

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
 * Snapshot-merge coordinates, cleared only when a conflict is *consumed* — a
 * successful cancel or continue that leaves `waiting_decision`.
 *
 * While a session is still awaiting a decision, `preMergeTree` is a live restore
 * instruction. Once the conflict is resolved or abandoned those coordinates are
 * spent: leaving them would let a later reader roll the worktree back past work it
 * should have kept.
 *
 * Deliberately NOT applied by `cleanupStaleSessions` or `rollback`. In an `error`
 * row the same fields are diagnostic evidence (what trees existed when the merge
 * was interrupted), not an instruction to restore. Startup never auto-restores,
 * and a human decision is no longer routed to an `error` row — so clearing the
 * coordinates there would destroy the only remaining record of the interrupted
 * state while protecting nothing on disk.
 */
const CLEARED_SNAPSHOT_MERGE_STATE = {
	preMergeTree: null,
	conflictTree: null,
	preMergeTargetSnapshot: null,
	mergeSourceSnapshot: null,
	preMergeTargetSha: null,
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
				// The user who started the batch merge owns the session it needs.
				ownerUserId: userId ?? null,
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
		// Same-session serial lock. Concurrent cancel/cancel or continue/cancel used to
		// both read `waiting_decision` before either wrote, so both would restore or both
		// would advance. Re-reading inside the lock turns the loser into a no-op.
		//
		// `processQueue` below stays fire-and-forget and never acquires this lock, so
		// holding it here cannot deadlock against the resume path.
		await mergeDecisionLock.acquire(mergeSessionId, async () => {
			const session = await db.query.mergeSessions.findFirst({
				where: eq(mergeSessions.id, mergeSessionId),
			});
			if (!session) {
				logger.warn("Merge decision for unknown session", { mergeSessionId });
				return;
			}

			// Shared state gate — before any chapter/source load or side effect.
			// Both continue and cancel are only meaningful while a conflict is pending;
			// every other status (including a cancelled row after a successful cancel)
			// must leave the worktree and the session coordinates untouched.
			if (session.status !== "waiting_decision") {
				logger.warn("Merge decision ignored for non-waiting session", {
					mergeSessionId,
					status: session.status,
					decision,
				});
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
				// Only a session still `waiting_decision` (enforced by the gate above) has a
				// conflicted tree to undo. Dual-guard abort: `conflictTree` is required and
				// `preMergeTargetSha` is passed through as-is (null means empty HEAD). A
				// missing `conflictTree` is a data-integrity failure — do not fall back to
				// `preMergeTree` as the expected current tree, and do not mark cancelled.
				if (session.preMergeTree) {
					if (!session.conflictTree) {
						throw new ValidationError(
							"Cannot cancel a snapshot merge without conflict tree coordinates",
						);
					}
					if (target.worktreePath) {
						// Restore failure must surface to the caller. Swallowing it into a
						// cancelled status would clear the coordinates and claim the merge was
						// dissolved, while the worktree may still hold conflict markers and the
						// only undo record is the row we just wiped. Status and coordinates stay
						// put until a cancel actually succeeds.
						await chapterMerge.abortInteractiveSnapshotMerge(
							target.worktreePath,
							session.preMergeTree,
							{
								expectedCurrentTree: session.conflictTree,
								expectedHeadSha: session.preMergeTargetSha ?? null,
							},
						);
					} else {
						throw new ValidationError(
							"Cannot cancel snapshot merge: target worktree is unavailable; recovery evidence preserved",
						);
					}
				}
				const now = new Date().toISOString();
				await db
					.update(mergeSessions)
					.set({
						status: "cancelled",
						error: "User cancelled on conflict",
						// Successful cancel: the merge is dissolved, so its coordinates must not
						// survive to route another restore at this tree.
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
					// goes back to `running` while the queue advances, and a stale decision
					// in that window would find a non-null `preMergeTree` and restore the
					// worktree to the state before a merge that has already completed.
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

			// Fire-and-forget on purpose: the decision lock must not stay held for the
			// duration of the remaining queue, and processQueue never re-enters resolveDecision.
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
		// Status + error text only. Snapshot coordinates stay on the row as diagnostic
		// evidence of what the interrupted merge looked like; this path never restores
		// from them, so clearing would destroy the record while protecting nothing.
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
	 * **DB metadata only.** No filesystem, git, snapshot capture, or chapter advance.
	 * A restart that preMergeTree-restore would overwrite new commits and uncommitted
	 * work written after the conflict — the exact data-loss this gate exists to stop.
	 *
	 * `preMergeTree` / `conflictTree` / snapshot fields are *not* cleared: in an `error`
	 * row they are diagnostic evidence, not an automatic restore instruction. The error
	 * text says the workspace was preserved and not automatically restored.
	 *
	 * Conditional update (id + the status just read) keeps the sweep idempotent and
	 * race-safe: a session that transitioned while we paged is left alone. Pages are
	 * id-cursor bounded so startup never materializes the whole table.
	 */
	async cleanupStaleSessions(): Promise<void> {
		const staleStatuses = ["running", "ai_resolving", "waiting_decision"] as const;
		const staleStatusList = [...staleStatuses];
		let cursor: string | null = null;
		let cleaned = 0;

		for (;;) {
			const batch = await db
				.select({
					id: mergeSessions.id,
					targetChapterId: mergeSessions.targetChapterId,
					status: mergeSessions.status,
					preMergeTree: mergeSessions.preMergeTree,
					conflictTree: mergeSessions.conflictTree,
					preMergeTargetSha: mergeSessions.preMergeTargetSha,
				})
				.from(mergeSessions)
				.where(
					cursor
						? and(inArray(mergeSessions.status, staleStatusList), gt(mergeSessions.id, cursor))
						: inArray(mergeSessions.status, staleStatusList),
				)
				.orderBy(asc(mergeSessions.id))
				.limit(STALE_MERGE_BATCH_LIMIT);

			if (batch.length === 0) break;
			cursor = batch[batch.length - 1].id;

			for (const session of batch) {
				const now = new Date().toISOString();
				const updated = await db
					.update(mergeSessions)
					.set({
						status: "error",
						error: STALE_MERGE_SESSION_ERROR,
						updatedAt: now,
					})
					.where(and(eq(mergeSessions.id, session.id), eq(mergeSessions.status, session.status)))
					.returning({ id: mergeSessions.id });

				if (updated.length === 0) {
					// Status changed under us (continue/cancel landed). Leave that transition alone.
					continue;
				}

				cleaned++;
				logger.info("Stale merge session marked error; workspace preserved", {
					sessionId: session.id,
					target: session.targetChapterId,
					oldStatus: session.status,
					preMergeTree: session.preMergeTree,
					conflictTree: session.conflictTree,
					preMergeTargetSha: session.preMergeTargetSha,
					worktreePreserved: true,
				});
			}

			if (batch.length < STALE_MERGE_BATCH_LIMIT) break;
		}

		if (cleaned > 0) {
			logger.info("Cleaned up stale merge sessions", {
				count: cleaned,
				worktreePreserved: true,
			});
		}
	},
};
