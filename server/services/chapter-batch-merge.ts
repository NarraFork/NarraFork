import { type Locale } from "../lib/prompt-i18n";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { chapterFork } from "./chapter-fork";
import { chapterMerge } from "./chapter-merge";
import { chapterService } from "./chapter-service";

export interface BatchMergeInput {
	/** The chapter to fork from as the merge base */
	baseChapterId: string;
	/** Chapters to merge into the forked chapter, in order */
	sourceChapterIds: string[];
	/** Title for the new forked chapter */
	title: string;
	description?: string;
	strategy?: "merge" | "squash" | "cherry-pick";
	locale?: Locale;
}

export type MergeDecision = "continue" | "cancel";

interface PendingDecision {
	resolve: (decision: MergeDecision) => void;
	timeoutId: ReturnType<typeof setTimeout>;
}

// In-memory state for pending conflict decisions (like permission requests)
const pendingDecisions = new Map<string, PendingDecision>();

const DECISION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Resolve a pending merge conflict decision.
 * Called from WebSocket when a user decides to continue or cancel.
 */
export function resolveMergeDecision(mergeSessionId: string, decision: MergeDecision): void {
	const pending = pendingDecisions.get(mergeSessionId);
	if (!pending) {
		logger.warn("Merge decision for unknown session", { mergeSessionId });
		return;
	}
	clearTimeout(pending.timeoutId);
	pendingDecisions.delete(mergeSessionId);
	pending.resolve(decision);
}

/**
 * Wait for a user decision on a merge conflict.
 * Returns "cancel" on timeout.
 */
function waitForDecision(mergeSessionId: string): Promise<MergeDecision> {
	return new Promise((resolve) => {
		const timeoutId = setTimeout(() => {
			pendingDecisions.delete(mergeSessionId);
			resolve("cancel");
		}, DECISION_TIMEOUT_MS);
		pendingDecisions.set(mergeSessionId, { resolve, timeoutId });
	});
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
	 * All progress is communicated via eventBus → WebSocket.
	 */
	async run(input: BatchMergeInput): Promise<{ mergeSessionId: string; targetChapterId: string }> {
		const mergeSessionId = generateId();
		const strategy = input.strategy ?? "merge";

		// Step 1: Fork base chapter
		const forkedChapter = await chapterFork.fork(input.baseChapterId, {
			title: input.title,
			description: input.description,
			inheritMode: "fresh",
		});

		const targetChapterId = forkedChapter.id;

		eventBus.emit({
			type: "merge:started",
			mergeSessionId,
			targetChapterId,
			sourceChapterIds: input.sourceChapterIds,
		});

		// Step 2: Process merges in background
		this.processQueue(mergeSessionId, targetChapterId, input.sourceChapterIds, strategy, input.locale);

		return { mergeSessionId, targetChapterId };
	},

	/** Internal: process the merge queue sequentially */
	async processQueue(
		mergeSessionId: string,
		targetChapterId: string,
		sourceChapterIds: string[],
		strategy: "merge" | "squash" | "cherry-pick",
		locale?: Locale,
	): Promise<void> {
		const total = sourceChapterIds.length;
		let mergedCount = 0;
		let currentSourceId = "";

		try {
		for (let i = 0; i < total; i++) {
			const sourceId = sourceChapterIds[i];
			currentSourceId = sourceId;

			// Try merge
			const result = await chapterMerge.merge(sourceId, {
				targetChapterId,
				strategy,
			});

			if (result.success) {
				mergedCount++;
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

			// Conflict — broadcast and wait for decision
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
				// Rollback: delete the forked chapter entirely
				eventBus.emit({
					type: "merge:cancelled",
					mergeSessionId,
					reason: "User cancelled on conflict",
				});
				await this.rollback(targetChapterId);
				return;
			}

			// User chose continue — AI resolve
			eventBus.emit({
				type: "merge:ai_resolving",
				mergeSessionId,
				sourceChapterId: sourceId,
			});

			const aiResult = await chapterMerge.aiResolveConflicts(sourceId, {
				targetChapterId,
				strategy,
			}, locale);

			if (!aiResult.resolved) {
				eventBus.emit({
					type: "merge:error",
					mergeSessionId,
					sourceChapterId: sourceId,
					error: aiResult.error ?? "AI resolution failed",
				});
				// Rollback
				eventBus.emit({
					type: "merge:cancelled",
					mergeSessionId,
					reason: aiResult.error ?? "AI resolution failed",
				});
				await this.rollback(targetChapterId);
				return;
			}

			mergedCount++;
			eventBus.emit({
				type: "merge:step_ok",
				mergeSessionId,
				sourceChapterId: sourceId,
				index: i,
				total,
				commitSha: aiResult.mergeResult?.commitSha,
			});
		}

		eventBus.emit({
			type: "merge:completed",
			mergeSessionId,
			targetChapterId,
			mergedCount,
		});
		} catch (err) {
			logger.error("Batch merge unexpected error", { mergeSessionId, sourceChapterId: currentSourceId, error: String(err) });
			eventBus.emit({
				type: "merge:error",
				mergeSessionId,
				sourceChapterId: currentSourceId,
				error: String(err),
			});
		}
	},

	/** Delete the forked chapter on cancellation/failure */
	async rollback(targetChapterId: string): Promise<void> {
		try {
			await chapterService.remove(targetChapterId);
			logger.info("Batch merge rolled back", { targetChapterId });
		} catch (err) {
			logger.error("Failed to rollback batch merge", {
				targetChapterId,
				error: String(err),
			});
		}
	},
};
