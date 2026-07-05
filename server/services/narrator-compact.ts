import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorMessages, narrators } from "../db/schema";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { getAutoCompactKeepPairs } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorContext } from "./narrator-context";
import { estimateNarratorBuildHistoryTokens } from "./narrator-history-token-estimate";
import { narratorService } from "./narrator-service";
import type { CompactLock, CompactLockResult, CompactMode } from "./narrator-session-state";
import {
	activeNarrators,
	compactLocks,
	markActiveHistoryCompactPending,
	pruneLocks,
	resetActiveUpstreamSession,
} from "./narrator-session-state";

/** Compact operation timeout in milliseconds (5 minutes). */
const COMPACT_TIMEOUT_MS = 5 * 60 * 1000;
const COMPACT_FAILURE_TEXT = "[Compact Failed]";
const COMPACTING_SUBSTATUS = "compacting";
const BACKGROUND_COMPACTING_SUBSTATUS = "background_compacting";

function compactSubstatusForMode(mode: CompactMode): string {
	return mode === "background" ? BACKGROUND_COMPACTING_SUBSTATUS : COMPACTING_SUBSTATUS;
}

function syncActiveSubstatus(narratorId: string, substatus: string[]) {
	const active = activeNarrators.get(narratorId);
	if (active?.alive) {
		active._substatus = new Set(substatus);
	}
}

async function setCompactingSubstatus(narratorId: string, mode: CompactMode, enabled: boolean) {
	const target = compactSubstatusForMode(mode);
	const other = mode === "background" ? COMPACTING_SUBSTATUS : BACKGROUND_COMPACTING_SUBSTATUS;
	let updated: string[];
	if (enabled) {
		updated = await narratorService.removeSubstatus(narratorId, other);
		updated = await narratorService.addSubstatus(narratorId, target);
	} else {
		// Remove both tags so a background compact that later becomes blocking
		// cannot leave either transient state behind after completion/failure.
		updated = await narratorService.removeSubstatus(narratorId, target);
		updated = await narratorService.removeSubstatus(narratorId, other);
	}
	syncActiveSubstatus(narratorId, updated);
}

function currentHistoryCompactMode(narratorId: string, fallback: CompactMode): CompactMode {
	const existing = compactLocks.get(narratorId);
	return existing && existing.kind !== "segment" && existing.mode ? existing.mode : fallback;
}

export async function markCompactAsBlocking(narratorId: string) {
	await setCompactingSubstatus(narratorId, "blocking", true);
	try {
		await db
			.update(narratorMessages)
			.set({ contentJson: [{ type: "compact", status: "compacting", mode: "blocking" }] })
			.where(
				and(
					eq(narratorMessages.narratorId, narratorId),
					eq(narratorMessages.role, "system"),
					eq(narratorMessages.contentText, "[Compacting]"),
				),
			);
	} catch (err) {
		logger.warn("Failed to update compact marker mode", { narratorId, error: String(err) });
	}
}

/** Check whether a compact operation is already running for the given narrator. */
export function isCompactInProgress(narratorId: string): boolean {
	return compactLocks.has(narratorId);
}

/** Check whether an error is an abort/cancellation error from a cancelled compact. */
function isCompactAbortError(err: unknown): boolean {
	if (err instanceof DOMException && err.name === "AbortError") return true;
	if (err instanceof Error && err.name === "AbortError") return true;
	return false;
}

/**
 * Cancel an in-progress history compact for the given narrator.
 *
 * Aborts the underlying summary-model request via the lock's AbortController.
 * The rollback (removing the placeholder marker, resetting context state,
 * clearing the transient substatus) is performed by `doRunCustomCompact`'s
 * abort branch once the aborted request rejects.
 *
 * Returns true if a cancellable compact was found and aborted, false otherwise.
 */
export function cancelCompact(narratorId: string): boolean {
	const lock = compactLocks.get(narratorId);
	if (!lock?.abortController) return false;
	if (lock.abortController.signal.aborted) return true;
	logger.info("Cancelling in-progress compact", { narratorId, kind: lock.kind });
	lock.abortController.abort();
	return true;
}

// Re-export locks so narrator-session can access them
export { compactLocks, pruneLocks };

type MessageWithSeq = { id: string; seq?: number };

async function attachBuildHistoryTokenEstimate<T extends MessageWithSeq>(
	narratorId: string,
	locale: Locale,
	message: T,
): Promise<{ message: T; contextPercent?: number }> {
	try {
		const estimate = await estimateNarratorBuildHistoryTokens(narratorId, locale);
		const updated = await narratorService.updateMessageHistoryTokenEstimate(
			message.id,
			narratorId,
			estimate,
		);
		return {
			message: (updated ? { ...updated, seq: updated.seq ?? message.seq } : message) as T,
			contextPercent: estimate.contextPercent,
		};
	} catch (err) {
		logger.warn("Failed to estimate build history tokens after compact", {
			narratorId,
			messageId: message.id,
			error: String(err),
		});
		return { message };
	}
}

/**
 * Trigger a mid-turn compact: eagerly reserve the lock, find the boundary, and run compact.
 */
export function triggerMidTurnCompact(
	narratorId: string,
	locale: Locale,
	onCompactDone?: () => void,
	mode: CompactMode = "background",
): void {
	if (compactLocks.has(narratorId)) {
		logger.debug("Compact already in progress, skipping mid-turn trigger", { narratorId });
		return;
	}

	logger.info("Context usage high, triggering compact (mid-turn)", { narratorId, mode });
	let compactLock!: CompactLock;
	const compactPromise: Promise<CompactLockResult> = (async () => {
		const boundaryMessageId = await narratorService.getCompactBoundaryMessage(
			narratorId,
			getAutoCompactKeepPairs(),
		);
		if (!boundaryMessageId) {
			logger.debug("No compact boundary found, aborting mid-turn compact", { narratorId });
			return { kind: "history_probe", compacted: false, mode };
		}

		// Release this wrapper lock before delegating to runCustomCompact(), which
		// installs the real history-compact lock. Existing waiters still await this
		// wrapper, and new waiters will see runCustomCompact()'s lock.
		if (compactLocks.get(narratorId) === compactLock) {
			compactLocks.delete(narratorId);
		}
		const effectiveMode = compactLock.mode ?? mode;
		logger.info("Starting runCustomCompact", {
			narratorId,
			boundaryMessageId,
			hasLock: compactLocks.has(narratorId),
			mode: effectiveMode,
		});
		const compacted = await runCustomCompact(narratorId, locale, boundaryMessageId, {
			mode: effectiveMode,
		});
		if (compacted) {
			onCompactDone?.();
		}
		return { kind: "history_probe", compacted, mode: effectiveMode };
	})();
	compactLock = { kind: "history_probe", promise: compactPromise, mode };
	compactLocks.set(narratorId, compactLock);
	compactPromise
		.catch((err) => {
			logger.error("Auto-compact failed (mid-turn)", {
				narratorId,
				error: String(err),
			});
		})
		.finally(() => {
			if (compactLocks.get(narratorId) === compactLock) {
				compactLocks.delete(narratorId);
			}
		});
}

/**
 * Run custom compact with concurrency protection.
 */
export async function runCustomCompact(
	narratorId: string,
	locale: Locale,
	beforeMessageId?: string,
	options?: { mode?: CompactMode; appendHint?: string },
): Promise<boolean> {
	const mode = options?.mode ?? "blocking";
	const appendHint = options?.appendHint;
	while (true) {
		const existing = compactLocks.get(narratorId);
		if (!existing) break;

		logger.info("Compact already in progress, waiting for it to finish", {
			narratorId,
			kind: existing.kind,
			mode: existing.mode,
			requestedMode: mode,
		});
		if (mode === "blocking" && existing.mode === "background" && existing.kind !== "segment") {
			await markCompactAsBlocking(narratorId).catch((err) => {
				logger.warn("Failed to mark background compact as blocking", {
					narratorId,
					error: String(err),
				});
			});
			existing.mode = "blocking";
		}
		let result: CompactLockResult;
		try {
			result = await existing.promise;
		} catch (err) {
			if (existing.kind !== "segment") {
				throw err;
			}
			logger.warn("Existing segment compact lock failed, continuing history compact", {
				narratorId,
				kind: existing.kind,
				error: String(err),
			});
			continue;
		}

		if (existing.kind !== "segment" && result.compacted) {
			broadcastToNarrator(narratorId, {
				type: "compact_done",
				narratorId,
				mode: existing.mode ?? result.mode ?? mode,
			});
			return true;
		}

		logger.info("Existing compact lock did not satisfy history compact request, continuing", {
			narratorId,
			kind: existing.kind,
			compacted: result.compacted,
		});
	}

	const abortController = new AbortController();
	let compactTimer: ReturnType<typeof setTimeout>;
	const compactPromise: Promise<CompactLockResult> = Promise.race([
		doRunCustomCompact(
			narratorId,
			locale,
			beforeMessageId,
			mode,
			abortController.signal,
			appendHint,
		).then((compacted) => ({
			kind: "history" as const,
			compacted,
			mode: currentHistoryCompactMode(narratorId, mode),
		})),
		new Promise<CompactLockResult>((_, reject) => {
			compactTimer = setTimeout(
				() => reject(new Error("Compact operation timed out after 5 minutes")),
				COMPACT_TIMEOUT_MS,
			);
		}),
	]);
	const compactLock: CompactLock = {
		kind: "history",
		promise: compactPromise,
		mode,
		abortController,
	};
	compactLocks.set(narratorId, compactLock);
	try {
		const result = await compactPromise;
		return result.compacted;
	} catch (err) {
		logger.error("Compact operation failed or timed out", {
			narratorId,
			error: String(err),
		});
		throw err;
	} finally {
		// biome-ignore lint/style/noNonNullAssertion: timer is always assigned before race settles
		clearTimeout(compactTimer!);
		if (compactLocks.get(narratorId) === compactLock) {
			compactLocks.delete(narratorId);
		}
	}
}

async function doRunCustomCompact(
	narratorId: string,
	locale: Locale,
	beforeMessageId: string | undefined,
	mode: CompactMode,
	signal?: AbortSignal,
	appendHint?: string,
): Promise<boolean> {
	logger.info("Starting custom compact", { narratorId, beforeMessageId, mode });

	const messages = beforeMessageId
		? await narratorService.getMessagesBefore(narratorId, beforeMessageId)
		: undefined;

	if (beforeMessageId && (!messages || messages.length === 0)) {
		logger.info("No messages to compact before target", { narratorId, beforeMessageId });
		return false;
	}

	const compactingMsg = await narratorService.persistCompactingMessage(
		narratorId,
		beforeMessageId,
		mode,
	);
	broadcastToNarrator(narratorId, { type: "message", narratorId, message: compactingMsg });
	await setCompactingSubstatus(narratorId, mode, true);
	broadcastToNarrator(narratorId, { type: "compacting", narratorId, mode });

	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { pruneBoundaryMessageId: true, variant: true },
	});
	const pruneBoundaryMessageId = narrator?.pruneBoundaryMessageId ?? null;
	const isSubagent = narrator?.variant ? narrator.variant.startsWith("subagent") : false;

	try {
		const { summary, contextPercent } = await narratorContext.generateCompactSummary(
			narratorId,
			locale,
			messages,
			pruneBoundaryMessageId,
			signal,
		);

		// Append an optional emergency hint (e.g. context-overflow recovery) to the
		// end of the summary so the next turn's system prompt carries it forward.
		const finalSummary = appendHint ? `${summary}\n\n${appendHint}` : summary;

		const finalizeMode = currentHistoryCompactMode(narratorId, mode);
		const compactedMsg = await narratorService.finalizeCompactingMessage(
			compactingMsg.id,
			narratorId,
			finalSummary,
			contextPercent,
			{ mode: finalizeMode },
		);

		await narratorService.clearPruneBoundary(narratorId);
		resetActiveUpstreamSession(narratorId);
		// Record that a history compact has completed but the active agent loop
		// has not yet rebuilt its in-memory history from the new summary. This
		// guards against a second background compact firing on the same (stale)
		// context before the first one is consumed, which previously dropped a
		// large chunk of context.
		markActiveHistoryCompactPending(narratorId, compactedMsg?.seq ?? null);

		let contextPercentAfter = contextPercent;
		if (compactedMsg) {
			const estimated = await attachBuildHistoryTokenEstimate(narratorId, locale, compactedMsg);
			contextPercentAfter = estimated.contextPercent ?? contextPercentAfter;
			broadcastToNarrator(narratorId, { type: "message", narratorId, message: estimated.message });
		}

		// Clear the compacting tag before compact_done so clients never process
		// completion while the transient substatus still says compacting. This is
		// UI-state cleanup only, so failure must not turn a completed compact into
		// a failed compact.
		await setCompactingSubstatus(narratorId, finalizeMode, false).catch((err) => {
			logger.warn("Failed to clear compacting substatus before compact_done", {
				narratorId,
				error: String(err),
			});
		});
		logger.info("Custom compact completed", { narratorId, summaryLength: summary.length });
		broadcastToNarrator(narratorId, {
			type: "compact_done",
			narratorId,
			contextPercentAfter,
			mode: finalizeMode,
		});
		return true;
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);

		// Cancelled by the user — silently roll back the in-progress compact:
		// remove the placeholder marker, reset context state, and clear the
		// transient substatus WITHOUT marking the narrator as errored.
		if (isCompactAbortError(err)) {
			logger.info("Custom compact cancelled by user", {
				narratorId,
				messageId: compactingMsg.id,
			});
			await narratorService.deleteCompactMessage(narratorId, compactingMsg.id).catch((e) => {
				logger.warn("Failed to remove compacting placeholder after cancel", {
					narratorId,
					messageId: compactingMsg.id,
					error: String(e),
				});
			});
			broadcastToNarrator(narratorId, {
				type: "messages_deleted",
				narratorId,
				deletedMessageIds: [compactingMsg.id],
			});
			await setCompactingSubstatus(
				narratorId,
				currentHistoryCompactMode(narratorId, mode),
				false,
			).catch(() => {});
			broadcastToNarrator(narratorId, {
				type: "compact_done",
				narratorId,
				mode: currentHistoryCompactMode(narratorId, mode),
			});
			throw err;
		}

		logger.error("Custom compact failed after retries", {
			narratorId,
			messageId: compactingMsg.id,
			error: errorMsg,
		});

		const failureMode = currentHistoryCompactMode(narratorId, mode);
		const failedSummary = `${COMPACT_FAILURE_TEXT}\n${errorMsg}`;
		const failedMsg = await narratorService
			.finalizeCompactingMessage(compactingMsg.id, narratorId, failedSummary, undefined, {
				status: "failed",
				error: errorMsg,
				mode: failureMode,
			})
			.catch((e) => {
				logger.error("Failed to finalize failed compact marker", {
					narratorId,
					messageId: compactingMsg.id,
					error: String(e),
				});
				return null;
			});

		if (failedMsg) {
			broadcastToNarrator(narratorId, { type: "message", narratorId, message: failedMsg });
		}

		if (failureMode === "blocking") {
			await narratorService.clearPruneBoundary(narratorId).catch(() => {});
			// Only override status for primary narrators — subagent status is
			// managed by finalizeSubagent; overwriting it here would race.
			if (!isSubagent) {
				await narratorService.updateStatus(narratorId, "idle", {
					substatus: ["error"],
					errorMessage: `Compact failed: ${errorMsg}`,
				});
			}
			// activeNarrators only tracks primary narrators; subagents are not
			// registered there, so this abort is a no-op for them (which is fine —
			// the subagent's own signal is managed by executeSubagent).
			const active = activeNarrators.get(narratorId);
			if (active?.alive) {
				active.abortController.abort();
			}
		}
		await setCompactingSubstatus(narratorId, failureMode, false).catch((err) => {
			logger.warn("Failed to clear compacting substatus after failed custom compact", {
				narratorId,
				error: String(err),
			});
		});
		broadcastToNarrator(narratorId, {
			type: "compact_failed",
			narratorId,
			messageId: compactingMsg.id,
			mode: failureMode,
		});
		throw err;
	} finally {
		await setCompactingSubstatus(
			narratorId,
			currentHistoryCompactMode(narratorId, mode),
			false,
		).catch((err) => {
			logger.warn("Failed to clear compacting substatus after custom compact", {
				narratorId,
				error: String(err),
			});
		});
	}
}

// === Segment compact ===

export async function runSegmentCompact(
	narratorId: string,
	locale: Locale,
	messageIds: string[],
): Promise<void> {
	const existing = compactLocks.get(narratorId);
	if (existing) {
		await existing.promise.catch(() => {});
		broadcastToNarrator(narratorId, {
			type: "compact_done",
			narratorId,
			isSegment: true,
			mode: "blocking",
		});

		return;
	}

	let timer: ReturnType<typeof setTimeout>;
	const promise: Promise<CompactLockResult> = Promise.race([
		doRunSegmentCompact(narratorId, locale, messageIds).then((compacted) => ({
			kind: "segment" as const,
			compacted,
			mode: "blocking" as const,
		})),
		new Promise<CompactLockResult>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("Segment compact timed out after 5 minutes")),
				COMPACT_TIMEOUT_MS,
			);
		}),
	]);
	const lock: CompactLock = { kind: "segment", promise, mode: "blocking" };
	compactLocks.set(narratorId, lock);
	try {
		await promise;
	} catch (err) {
		logger.error("Segment compact failed or timed out", {
			narratorId,
			error: String(err),
		});
		throw err;
	} finally {
		// biome-ignore lint/style/noNonNullAssertion: timer is always assigned before race settles
		clearTimeout(timer!);
		if (compactLocks.get(narratorId) === lock) {
			compactLocks.delete(narratorId);
		}
	}
}

async function doRunSegmentCompact(
	narratorId: string,
	locale: Locale,
	messageIds: string[],
): Promise<boolean> {
	logger.info("Starting segment compact", { narratorId, messageCount: messageIds.length });

	const { message: markerMsg, hiddenMessageIds } =
		await narratorService.persistSegmentCompactMarker(narratorId, messageIds);
	broadcastToNarrator(narratorId, { type: "message", narratorId, message: markerMsg });
	await setCompactingSubstatus(narratorId, "blocking", true);
	broadcastToNarrator(narratorId, {
		type: "segment_compact_hide",
		narratorId,
		hiddenMessageIds,
	});
	broadcastToNarrator(narratorId, { type: "compacting", narratorId, mode: "blocking" });

	try {
		const messages = await narratorService.getMessagesForSegmentCompact(narratorId, messageIds);

		if (messages.length === 0) {
			await narratorService.deleteSegmentCompact(narratorId, markerMsg.id);
			await setCompactingSubstatus(narratorId, "blocking", false);
			broadcastToNarrator(narratorId, {
				type: "compact_done",
				narratorId,
				isSegment: true,
				mode: "blocking",
			});

			return false;
		}

		const { summary, contextPercent } = await narratorContext.generateCompactSummary(
			narratorId,
			locale,
			messages,
			null,
		);

		const finalizedMsg = await narratorService.finalizeSegmentCompact(
			markerMsg.id,
			narratorId,
			summary,
			contextPercent,
		);

		let contextPercentAfter = contextPercent;
		if (finalizedMsg) {
			const estimated = await attachBuildHistoryTokenEstimate(narratorId, locale, finalizedMsg);
			contextPercentAfter = estimated.contextPercent ?? contextPercentAfter;
			broadcastToNarrator(narratorId, { type: "message", narratorId, message: estimated.message });
		}

		logger.info("Segment compact completed", {
			narratorId,
			messageCount: messageIds.length,
			summaryLength: summary.length,
		});
		await setCompactingSubstatus(narratorId, "blocking", false).catch((err) => {
			logger.warn("Failed to clear compacting substatus before segment compact_done", {
				narratorId,
				error: String(err),
			});
		});
		broadcastToNarrator(narratorId, {
			type: "compact_done",
			narratorId,
			contextPercentAfter,
			isSegment: true,
			mode: "blocking",
		});
		return true;
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		logger.error("Segment compact failed", {
			narratorId,
			messageId: markerMsg.id,
			error: errorMsg,
		});

		const failedSummary = `${COMPACT_FAILURE_TEXT}\n${errorMsg}`;
		const failedMsg = await narratorService
			.finalizeSegmentCompact(markerMsg.id, narratorId, failedSummary, undefined, {
				status: "failed",
				error: errorMsg,
			})
			.catch((e) => {
				logger.error("Failed to finalize failed segment compact marker", {
					narratorId,
					messageId: markerMsg.id,
					error: String(e),
				});
				return null;
			});

		if (failedMsg) {
			broadcastToNarrator(narratorId, { type: "message", narratorId, message: failedMsg });
		}

		await setCompactingSubstatus(narratorId, "blocking", false).catch(() => {});
		broadcastToNarrator(narratorId, {
			type: "compact_failed",
			narratorId,
			messageId: markerMsg.id,
			mode: "blocking",
		});
		throw err;
	}
}

// === shouldFinalizeAbortBeforeRecovery ===

export function shouldFinalizeAbortBeforeRecovery(
	aborted: boolean | undefined,
	signalAborted: boolean,
	planApprovedContinue?: "continue" | "compact",
): boolean {
	return (aborted || signalAborted) && planApprovedContinue == null;
}

// === pruneToolCalls ===

/** Tool names whose tool_use + tool_result pairs should survive pruning. */
const PRUNE_PROTECTED_TOOLS = new Set(["ExitPlanMode", "Skill"]);

export function pruneToolCalls(
	dbMessages: import("../lib/agent/provider").DbMessage[],
	boundaryMessageId: string,
): void {
	const boundaryIdx = dbMessages.findIndex((m) => m.id === boundaryMessageId);
	if (boundaryIdx < 0) return;

	const pruneIds = new Set(dbMessages.slice(0, boundaryIdx + 1).map((m) => m.id));

	for (const msg of dbMessages) {
		if (!pruneIds.has(msg.id)) continue;

		const keptToolCalls = msg.toolCalls?.length
			? msg.toolCalls.filter((tc) => PRUNE_PROTECTED_TOOLS.has(tc.toolName))
			: [];
		msg.toolCalls = keptToolCalls.length > 0 ? keptToolCalls : [];

		let hasProtectedToolContext = keptToolCalls.length > 0;
		if (Array.isArray(msg.contentJson)) {
			let mutated = false;
			const keptToolUseIds = new Set(
				keptToolCalls
					.map((tc) => tc.toolUseId)
					.filter((toolUseId): toolUseId is string => typeof toolUseId === "string"),
			);
			const blocks = msg.contentJson.filter((block) => {
				if (!block || typeof block !== "object") return true;
				const toolBlock = block as { type?: string; id?: string; name?: string };
				if (toolBlock.type !== "tool_use") return true;
				const keep =
					(typeof toolBlock.id === "string" && keptToolUseIds.has(toolBlock.id)) ||
					(typeof toolBlock.name === "string" && PRUNE_PROTECTED_TOOLS.has(toolBlock.name));
				if (keep) hasProtectedToolContext = true;
				if (!keep) mutated = true;
				return keep;
			});
			if (mutated) {
				msg.contentJson = blocks;
			}

			if (!hasProtectedToolContext) {
				let reasoningMutated = false;
				const prunedBlocks = msg.contentJson as Array<{ type: string; providerMetadata?: unknown }>;
				for (const block of prunedBlocks) {
					if (block.type === "reasoning" && block.providerMetadata) {
						block.providerMetadata = undefined;
						reasoningMutated = true;
					}
				}
				if (reasoningMutated) {
					msg.contentJson = [...prunedBlocks];
				}
			}
		}
	}
}

// === computeLineDiff ===

/**
 * Compute a simple line-level unified diff between two strings.
 * Returns a compact diff string showing only changed lines with context,
 * or null if the texts are identical.
 */
export function computeLineDiff(oldText: string, newText: string): string | null {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const CONTEXT = 2;

	const m = oldLines.length;
	const n = newLines.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			if (oldLines[i] === newLines[j]) {
				dp[i][j] = dp[i + 1][j + 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
	}

	const diffLines: Array<{ type: "keep" | "del" | "add"; text: string }> = [];
	let i = 0;
	let j = 0;
	while (i < m || j < n) {
		if (i < m && j < n && oldLines[i] === newLines[j]) {
			diffLines.push({ type: "keep", text: oldLines[i] });
			i++;
			j++;
		} else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
			diffLines.push({ type: "add", text: newLines[j] });
			j++;
		} else {
			diffLines.push({ type: "del", text: oldLines[i] });
			i++;
		}
	}

	if (!diffLines.some((l) => l.type !== "keep")) return null;

	const changeIndices: number[] = [];
	for (let k = 0; k < diffLines.length; k++) {
		if (diffLines[k].type !== "keep") changeIndices.push(k);
	}

	const hunks: string[] = [];
	let hunkStart = Math.max(0, changeIndices[0] - CONTEXT);
	let hunkEnd = Math.min(diffLines.length - 1, changeIndices[0] + CONTEXT);

	for (let ci = 1; ci < changeIndices.length; ci++) {
		const nextStart = Math.max(0, changeIndices[ci] - CONTEXT);
		const nextEnd = Math.min(diffLines.length - 1, changeIndices[ci] + CONTEXT);
		if (nextStart <= hunkEnd + 1) {
			hunkEnd = nextEnd;
		} else {
			const lines: string[] = [];
			for (let h = hunkStart; h <= hunkEnd; h++) {
				const d = diffLines[h];
				if (d.type === "keep") lines.push(`  ${d.text}`);
				else if (d.type === "del") lines.push(`- ${d.text}`);
				else lines.push(`+ ${d.text}`);
			}
			hunks.push(lines.join("\n"));
			hunkStart = nextStart;
			hunkEnd = nextEnd;
		}
	}
	const lines: string[] = [];
	for (let h = hunkStart; h <= hunkEnd; h++) {
		const d = diffLines[h];
		if (d.type === "keep") lines.push(`  ${d.text}`);
		else if (d.type === "del") lines.push(`- ${d.text}`);
		else lines.push(`+ ${d.text}`);
	}
	hunks.push(lines.join("\n"));

	return hunks.join("\n...\n");
}

/**
 * Run a plan compact: persist the plan text as a compact message and clear prune boundary.
 */
export async function runPlanCompact(narratorId: string, planText: string): Promise<void> {
	logger.info("Starting plan compact", { narratorId, planLength: planText.length });

	// persistPlanMessage atomically inserts the message, sets isCompact=1,
	// and updates narrator's contextSummary + clears apiConversationId.
	const compactMsg = await narratorService.persistPlanMessage(narratorId, planText);
	if (compactMsg) {
		broadcastToNarrator(narratorId, { type: "message", narratorId, message: compactMsg });
	}

	await narratorService.clearPruneBoundary(narratorId);
	logger.info("Plan compact completed", { narratorId, summaryLength: planText.length });
}
