/**
 * Shared recovery logic for both main narrators and subagents.
 *
 * Extracted to eliminate ~120 lines of near-identical context-overflow handling
 * and to give subagents the same transient-error retry resilience that main
 * narrators already enjoy.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { TRANSIENT_RETRY_BASE_MS } from "../lib/agent/types";
import { eventBus } from "../lib/event-bus";
import { getToolMessage } from "../lib/i18n";
import { logger } from "../lib/logger";
import { isSubagentVariant } from "../lib/narrator-utils";
import type { Locale } from "../lib/prompt-i18n";
import { getAutoCompactKeepPairs, getContextThresholds, settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorService } from "./narrator-service";
import { markCompactAsBlocking, runCustomCompact } from "./narrator-session";
import { compactLocks, hasPendingHistoryCompact } from "./narrator-session-state";

// ── Constants ────────────────────────────────────────────────────────────────

export const MAX_CONTEXT_OVERFLOW_RETRIES = 2;
export { TRANSIENT_RETRY_BASE_MS };

/** Read the user-configured max transient retries from settings. */
export function getMaxTransientRetries(): number {
	return settings.agent.maxTransientRetries;
}

/** Read the user-configured silent-tool-call threshold from settings. */
export function getSilentToolCallThreshold(): number {
	return settings.agent.silentToolCallThreshold;
}

/** Read the user-configured Pipeline capture inactivity threshold from settings. */
export function getPipelineUnusedToolCallThreshold(): number {
	return settings.agent.pipelineUnusedToolCallThreshold;
}

/** Read the user-configured retry backoff ceiling (ms) from settings. */
export function getRetryBackoffCeilMs(): number {
	return settings.agent.retryBackoffCeilMs;
}

/** Read the user-configured first-token timeout (ms) from settings. */
export function getFirstTokenTimeoutMs(): number {
	return settings.agent.firstTokenTimeoutMs;
}

// ── Context overflow recovery ────────────────────────────────────────────────

interface OverflowResultBase {
	overflowRetries: number;
}

interface OverflowPruned extends OverflowResultBase {
	action: "retry_pruned";
	/** The new prune boundary message ID. */
	boundaryMessageId: string;
}

interface OverflowCompacted extends OverflowResultBase {
	action: "retry_compacted";
	/** Fresh conversation ID to use after compact. */
	newConversationId: ReturnType<typeof randomUUID>;
}

export type ContextOverflowFailureReason =
	| "max_retries_exceeded"
	| "no_compact_boundary"
	| "compact_noop"
	| "compact_failed";

interface OverflowFailed extends OverflowResultBase {
	action: "failed";
	reason: ContextOverflowFailureReason;
}

export type OverflowResult = OverflowPruned | OverflowCompacted | OverflowFailed;

export function getContextOverflowFailureError(reason: ContextOverflowFailureReason): {
	message: string;
	errorCode: string;
} {
	switch (reason) {
		case "max_retries_exceeded":
			return {
				message: "Context is still too long after automatic recovery attempts",
				errorCode: "context_too_long_recovery_exhausted",
			};
		case "no_compact_boundary":
			return {
				message: "Context is too long, but there is not enough older conversation to compact",
				errorCode: "context_too_long_no_compact_boundary",
			};
		case "compact_noop":
			return {
				message: "Context is too long, but compact did not reduce the conversation",
				errorCode: "context_too_long_compact_noop",
			};
		case "compact_failed":
			return {
				message: "Context too long, compact failed",
				errorCode: "context_too_long_compact_failed",
			};
	}
}

/**
 * Handle a context-length-exceeded situation with aggressive prune → compact
 * escalation.  Returns a discriminated union so the caller can read the
 * relevant payload (boundaryMessageId or newConversationId) directly from
 * the result — no callbacks needed.
 *
 * @param onBroadcast  Optional hook to push events to the frontend (main
 *                     narrator broadcasts to WS; subagents skip this).
 */
export async function handleContextOverflow(opts: {
	narratorId: string;
	locale: Locale;
	provider: string;
	model: string;
	overflowRetries: number;
	maxRetries: number;
	/** Latest compact seq observed when the failed request's history was built. */
	baselineCompactSeq?: number | null;
	onBroadcast?: (event: Record<string, unknown>) => void;
}): Promise<OverflowResult> {
	const { narratorId, locale, provider, model, onBroadcast } = opts;
	let { overflowRetries } = opts;

	overflowRetries++;

	if (overflowRetries > opts.maxRetries) {
		return { action: "failed", overflowRetries, reason: "max_retries_exceeded" };
	}

	logger.warn("Context length exceeded, attempting emergency recovery", {
		narratorId,
		attempt: overflowRetries,
		provider,
	});

	onBroadcast?.({ type: "context_length_exceeded", narratorId });

	const latestCompactSeq = await narratorService.getLatestCompactSeq(narratorId);
	const baselineCompactSeq = opts.baselineCompactSeq ?? -1;
	if (latestCompactSeq != null && latestCompactSeq > baselineCompactSeq) {
		const newConversationId = randomUUID();
		onBroadcast?.({ type: "compact_done", narratorId, mode: "blocking" });
		logger.info("A completed compact already supersedes the failed request, retrying", {
			narratorId,
			baselineCompactSeq: opts.baselineCompactSeq ?? null,
			latestCompactSeq,
		});
		return { action: "retry_compacted", newConversationId, overflowRetries };
	}

	// If auto-compact was already triggered while the failed request was in flight,
	// wait for it. Only a completed history compact is enough to retry directly;
	// segment compacts and no-op probes do not reduce the overflow recovery history.
	const existingCompact = compactLocks.get(narratorId);
	if (existingCompact) {
		logger.warn("Context overflow detected while compact is in progress, waiting", {
			narratorId,
			attempt: overflowRetries,
			kind: existingCompact.kind,
			mode: existingCompact.mode,
		});
		if (existingCompact.mode === "background" && existingCompact.kind !== "segment") {
			await markCompactAsBlocking(narratorId).catch((err) => {
				logger.warn("Failed to mark existing compact as blocking during overflow recovery", {
					narratorId,
					error: String(err),
				});
			});
			existingCompact.mode = "blocking";
		}
		try {
			const compactResult = await existingCompact.promise;
			if (existingCompact.kind !== "segment" && compactResult.compacted) {
				const newConversationId = randomUUID();
				onBroadcast?.({ type: "compact_done", narratorId, mode: "blocking" });
				logger.info("Existing history compact finished after context overflow, retrying", {
					narratorId,
					kind: existingCompact.kind,
				});
				return { action: "retry_compacted", newConversationId, overflowRetries };
			}
			logger.info("Existing compact did not satisfy overflow recovery, continuing", {
				narratorId,
				kind: existingCompact.kind,
				compacted: compactResult.compacted,
			});
		} catch (compactErr) {
			logger.error("Existing compact failed during context overflow recovery", {
				narratorId,
				kind: existingCompact.kind,
				error: String(compactErr),
			});
		}
	}

	// Race window: a background/mid-turn compact may have COMPLETED after we
	// captured `baselineCompactSeq` but is not currently holding a lock — either
	// because triggerMidTurnCompact's probe lock briefly steps aside before
	// runCustomCompact installs the real history lock, or because the compact
	// finished between the failed request and this recovery running. In both
	// cases the history is already compacted, so retry directly instead of
	// starting a redundant compact (which would report compact_noop) or giving
	// up with max_retries_exceeded while a perfectly good summary sits in the DB.
	if (hasPendingHistoryCompact(narratorId)) {
		const newConversationId = randomUUID();
		onBroadcast?.({ type: "compact_done", narratorId, mode: "blocking" });
		logger.info("History compact completed but not yet applied to active history, retrying", {
			narratorId,
			attempt: overflowRetries,
		});
		return { action: "retry_compacted", newConversationId, overflowRetries };
	}
	const latestCompactSeqAfterWait = await narratorService.getLatestCompactSeq(narratorId);
	if (latestCompactSeqAfterWait != null && latestCompactSeqAfterWait > baselineCompactSeq) {
		const newConversationId = randomUUID();
		onBroadcast?.({ type: "compact_done", narratorId, mode: "blocking" });
		logger.info("A compact completed while overflow recovery was running, retrying", {
			narratorId,
			baselineCompactSeq,
			latestCompactSeq: latestCompactSeqAfterWait,
		});
		return { action: "retry_compacted", newConversationId, overflowRetries };
	}

	// ── Step 1: Codex aggressive prune (first attempt only) ──────────────
	if (provider === "codex" && overflowRetries === 1) {
		try {
			const before = await narratorService.getById(narratorId);
			const thresholds = getContextThresholds(model, provider);
			const pruneResult = await narratorService.computeAndUpdatePruneBoundary(
				narratorId,
				thresholds.compactStart,
				thresholds,
			);

			if (pruneResult) {
				onBroadcast?.({
					type: "prune_boundary",
					narratorId,
					boundaryMessageId: pruneResult.boundaryMessageId,
					prunedPercent: pruneResult.prunedPercent,
				});
			}

			const boundaryAdvanced =
				!!pruneResult && pruneResult.boundaryMessageId !== before.pruneBoundaryMessageId;
			if (boundaryAdvanced) {
				logger.warn("Applied aggressive prune, retrying before compact", {
					narratorId,
					boundaryMessageId: pruneResult.boundaryMessageId,
					prunedPercent: pruneResult.prunedPercent,
				});
				return {
					action: "retry_pruned",
					boundaryMessageId: pruneResult.boundaryMessageId,
					overflowRetries,
				};
			}
		} catch (pruneErr) {
			logger.error("Aggressive prune before compact failed", {
				narratorId,
				error: String(pruneErr),
			});
		}
	}

	// ── Step 2: Emergency compact ────────────────────────────────────────
	// generateCompactSummary now handles progressive input fitting internally
	// (pruning tool calls + dropping old messages to fit the summary model's
	// context window), so a single compact attempt with configured recent-turn retention suffices.
	let boundaryMessageId = await narratorService.getCompactBoundaryMessage(
		narratorId,
		getAutoCompactKeepPairs(),
	);

	// If the normal boundary is unavailable because there are too few messages to
	// satisfy the configured keepPairs (e.g. a single oversized message blew the
	// window), fall back to an emergency boundary that ignores keepPairs and keeps
	// only the most recent message. Anything summarizable is better than failing.
	let usedEmergencyBoundary = false;
	if (!boundaryMessageId) {
		boundaryMessageId = await narratorService.getEmergencyCompactBoundaryMessage(narratorId);
		usedEmergencyBoundary = boundaryMessageId != null;
		if (usedEmergencyBoundary) {
			logger.warn("Falling back to emergency compact boundary (ignoring keepPairs)", {
				narratorId,
				boundaryMessageId,
			});
		}
	}

	if (!boundaryMessageId) {
		logger.warn("No compact boundary found", { narratorId });
		return { action: "failed", overflowRetries, reason: "no_compact_boundary" };
	}

	// When recovering from a context overflow, append an emergency hint to the
	// summary so the next turn is warned against re-filling the window (e.g. by
	// using the Read tool's read-all mode on very large files).
	const appendHint = getToolMessage("compactContextOverflowHint", locale);

	try {
		const compacted = await runCustomCompact(narratorId, locale, boundaryMessageId, {
			appendHint,
		});
		if (compacted) {
			const newConversationId = randomUUID();
			onBroadcast?.({ type: "compact_done", narratorId, mode: "blocking" });
			logger.info("Emergency compact succeeded, retrying", {
				narratorId,
				usedEmergencyBoundary,
			});
			return { action: "retry_compacted", newConversationId, overflowRetries };
		}
		logger.warn("Emergency compact completed without compacting", {
			narratorId,
			boundaryMessageId,
		});
		return { action: "failed", overflowRetries, reason: "compact_noop" };
	} catch (compactErr) {
		logger.error("Emergency compact failed", {
			narratorId,
			error: String(compactErr),
		});
		return { action: "failed", overflowRetries, reason: "compact_failed" };
	}
}

// ── Transient error retry ────────────────────────────────────────────────────

/**
 * Abort-aware sleep that resolves early when the signal fires.
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Decide whether to retry a transient API error.
 *
 * Returns `true` if the caller should `continue` the loop, `false` if it
 * should give up.  Handles backoff delay, logging, and frontend notification.
 */
export async function handleTransientError(opts: {
	narratorId: string;
	error: string;
	retryCount: number;
	maxRetries: number;
	signal: AbortSignal;
}): Promise<{ shouldRetry: boolean; delayMs: number }> {
	const { narratorId, error, retryCount, maxRetries, signal } = opts;

	if (maxRetries !== -1 && retryCount > maxRetries) {
		logger.error("Transient error exceeded max retries", {
			narratorId,
			error,
			retries: retryCount,
		});
		return { shouldRetry: false, delayMs: 0 };
	}

	const delayMs = Math.min(
		TRANSIENT_RETRY_BASE_MS * 2 ** (retryCount - 1),
		getRetryBackoffCeilMs(),
	);
	logger.warn("Transient API error, retrying", {
		narratorId,
		error,
		attempt: retryCount,
		delayMs,
	});

	// Notify frontend (include retry metadata for statusbar display)
	const warningPayload = {
		type: "warning" as const,
		narratorId,
		message: error,
		retryCount,
		maxRetries,
		delayMs,
	};
	eventBus.emit({ type: "narrator:warning", narratorId, message: error });
	broadcastToNarrator(narratorId, warningPayload);

	// If this is a subagent, also notify the parent narrator so SubagentCard
	// can display the retry status inline.
	try {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { variant: true, parentNarratorId: true },
		});
		if (narrator && isSubagentVariant(narrator.variant) && narrator.parentNarratorId) {
			broadcastToNarrator(narrator.parentNarratorId, {
				type: "subagent_warning",
				narratorId: narrator.parentNarratorId,
				subagentNarratorId: narratorId,
				message: error,
				retryCount,
				maxRetries,
				delayMs,
			});
		}
	} catch {
		// Non-critical — don't let lookup failure break retry flow
	}

	// Abort-aware backoff
	await abortableSleep(delayMs, signal);

	return { shouldRetry: !signal.aborted, delayMs };
}
