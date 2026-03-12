/**
 * Shared recovery logic for both main narrators and subagents.
 *
 * Extracted to eliminate ~120 lines of near-identical context-overflow handling
 * and to give subagents the same transient-error retry resilience that main
 * narrators already enjoy.
 */

import { randomUUID } from "node:crypto";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorService } from "./narrator-service";
import { COMPACT_CONTEXT_USAGE_PCT, runCustomCompact } from "./narrator-session";

// ── Constants ────────────────────────────────────────────────────────────────

export const MAX_CONTEXT_OVERFLOW_RETRIES = 2;
export const MAX_TRANSIENT_RETRIES = 10;
export const TRANSIENT_RETRY_BASE_MS = 5_000;

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
	overflowRetries: number;
	maxRetries: number;
	onBroadcast?: (event: Record<string, unknown>) => void;
}): Promise<OverflowResult> {
	const { narratorId, locale, provider, onBroadcast } = opts;
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

	// ── Step 1: Codex aggressive prune (first attempt only) ──────────────
	if (provider === "codex" && overflowRetries === 1) {
		try {
			const before = await narratorService.getById(narratorId);
			const pruneResult = await narratorService.computeAndUpdatePruneBoundary(
				narratorId,
				COMPACT_CONTEXT_USAGE_PCT,
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
	// context window), so a single compact attempt with keepPairs=2 suffices.
	const boundaryMessageId = await narratorService.getCompactBoundaryMessage(narratorId);
	if (!boundaryMessageId) {
		logger.warn("No compact boundary found", { narratorId });
		return { action: "failed", overflowRetries };
	}

	try {
		await runCustomCompact(narratorId, locale, boundaryMessageId);
		const newConversationId = randomUUID();
		onBroadcast?.({ type: "compact_done", narratorId });
		logger.info("Emergency compact succeeded, retrying", { narratorId });
		return { action: "retry_compacted", newConversationId, overflowRetries };
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

	if (retryCount > maxRetries) {
		logger.error("Transient error exceeded max retries", {
			narratorId,
			error,
			retries: retryCount,
		});
		return { shouldRetry: false, delayMs: 0 };
	}

	const delayMs = Math.min(TRANSIENT_RETRY_BASE_MS * 2 ** (retryCount - 1), 20_000);
	logger.warn("Transient API error, retrying", {
		narratorId,
		error,
		attempt: retryCount,
		delayMs,
	});

	// Notify frontend
	eventBus.emit({ type: "narrator:warning", narratorId, message: error });
	broadcastToNarrator(narratorId, { type: "warning", narratorId, message: error });

	// Abort-aware backoff
	await abortableSleep(delayMs, signal);

	return { shouldRetry: !signal.aborted, delayMs };
}
