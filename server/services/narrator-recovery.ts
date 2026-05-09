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
import { logger } from "../lib/logger";
import { isSubagentVariant } from "../lib/narrator-utils";
import type { Locale } from "../lib/prompt-i18n";
import { getAutoCompactKeepPairs, getContextThresholds, settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorService } from "./narrator-service";
import { runCustomCompact } from "./narrator-session";
import { compactLocks } from "./narrator-session-state";

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

interface OverflowFailed extends OverflowResultBase {
	action: "failed";
}

export type OverflowResult = OverflowPruned | OverflowCompacted | OverflowFailed;

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
	onBroadcast?: (event: Record<string, unknown>) => void;
}): Promise<OverflowResult> {
	const { narratorId, locale, provider, model, onBroadcast } = opts;
	let { overflowRetries } = opts;

	overflowRetries++;

	if (overflowRetries > opts.maxRetries) {
		return { action: "failed", overflowRetries };
	}

	logger.warn("Context length exceeded, attempting emergency recovery", {
		narratorId,
		attempt: overflowRetries,
		provider,
	});

	onBroadcast?.({ type: "context_length_exceeded", narratorId });

	// If auto-compact was already triggered while the failed request was in flight,
	// wait for it. Only a completed history compact is enough to retry directly;
	// segment compacts and no-op probes do not reduce the overflow recovery history.
	const existingCompact = compactLocks.get(narratorId);
	if (existingCompact) {
		logger.warn("Context overflow detected while compact is in progress, waiting", {
			narratorId,
			attempt: overflowRetries,
			kind: existingCompact.kind,
		});
		try {
			const compactResult = await existingCompact.promise;
			if (existingCompact.kind !== "segment" && compactResult.compacted) {
				const newConversationId = randomUUID();
				onBroadcast?.({ type: "compact_done", narratorId });
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
	const boundaryMessageId = await narratorService.getCompactBoundaryMessage(
		narratorId,
		getAutoCompactKeepPairs(),
	);
	if (!boundaryMessageId) {
		logger.warn("No compact boundary found", { narratorId });
		return { action: "failed", overflowRetries };
	}

	try {
		const compacted = await runCustomCompact(narratorId, locale, boundaryMessageId);
		if (compacted) {
			const newConversationId = randomUUID();
			onBroadcast?.({ type: "compact_done", narratorId });
			logger.info("Emergency compact succeeded, retrying", { narratorId });
			return { action: "retry_compacted", newConversationId, overflowRetries };
		}
		logger.warn("Emergency compact completed without compacting", {
			narratorId,
			boundaryMessageId,
		});
	} catch (compactErr) {
		logger.error("Emergency compact failed", {
			narratorId,
			error: String(compactErr),
		});
	}

	return { action: "failed", overflowRetries };
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
