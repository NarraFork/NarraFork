import {
	type CompactMessageTrigger,
	normalizeCompactAttempts,
	parseCompactMessageBlock,
} from "@shared/compact-message";
import { createThrottledProgressReporter, type ProgressSnapshot } from "@shared/progress-phase";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorMessages, narrators } from "../db/schema";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import type { Locale } from "../lib/prompt-i18n";
import { getAutoCompactKeepPairs, resolveDefaultReasoningEffort, settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import {
	appendLiveCompactDelta,
	finishLiveCompactProgress,
	startLiveCompactProgress,
} from "./compact-live-state";
import { drainQueuedMessagesAfterCompact } from "./compact-queue-drain";
import { narratorContext } from "./narrator-context";
import { estimateNarratorBuildHistoryTokens } from "./narrator-history-token-estimate";
import { narratorService } from "./narrator-service";
import type { CompactLock, CompactLockResult, CompactMode } from "./narrator-session-state";
import {
	activeNarrators,
	compactLocks,
	markActiveHistoryCompactPending,
	resetActiveUpstreamSession,
	withNarratorWorkAdmission,
} from "./narrator-session-state";

/**
 * How long a compact may make NO observable progress before it is aborted.
 *
 * This is a stall timer, not a total-duration budget. A large context is
 * summarized by cascading over several chunks, so a healthy compact can legitimately
 * run far longer than any single request; capping total duration killed those.
 */
const COMPACT_STALL_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Absolute ceiling as a backstop against a compact that trickles forever (each
 * chunk resets the stall timer, so progress alone cannot bound total runtime).
 */
const COMPACT_MAX_TOTAL_MS = 30 * 60 * 1000;
/**
 * How long we wait, after the watchdog aborted a run, for that run to actually
 * settle before flagging it as stuck.
 *
 * Aborting instead of racing means the lock is held until `doRunCustomCompact`
 * returns. That is the point — it prevents a second `[Compacting]` marker — but
 * it also means a provider that ignores its AbortSignal keeps the lock forever
 * and silently disables every later compact for that narrator. This timer cannot
 * fix that, so it makes it loud instead of invisible.
 */
const COMPACT_ABORT_GRACE_MS = 60 * 1000;
const COMPACT_PROGRESS_THROTTLE_MS = 120;

/**
 * Watchdog timing overrides for tests.
 *
 * The production windows are minutes long, so the only way to exercise what a
 * timeout DOES — keep the marker, record the reason, error a blocking run — is to
 * shorten them. Kept here rather than threaded through every call site, since the
 * timings are an internal policy of `runCustomCompact` / `runSegmentCompact`.
 */
let compactWatchdogTimingOverrides: { stallMs?: number; maxTotalMs?: number } | null = null;

export function __setCompactWatchdogTimingsForTests(
	overrides: { stallMs?: number; maxTotalMs?: number } | null,
): void {
	compactWatchdogTimingOverrides = overrides;
}
const COMPACT_FAILURE_TEXT = "[Compact Failed]";
const COMPACTING_SUBSTATUS = "compacting";
const BACKGROUND_COMPACTING_SUBSTATUS = "background_compacting";

interface CompactProgressReporter {
	onTextDelta: (delta: string) => void;
	onReasoningDelta: (delta: string) => void;
	/**
	 * Report that a failed summary attempt is being retried. Broadcasts
	 * immediately (retry events are rare and must not wait out the throttle
	 * window) with the CURRENT char counts plus the retry ordinal, so the UI can
	 * say "retrying (N)" instead of an unexplained 0-char spinner.
	 */
	reportRetry: (retryCount: number, error: string) => void;
	/** Stop progress ticks while final persistence completes. */
	finish: () => void;
	/** Close the on-demand text stream after the final marker state is persisted. */
	close: (status: "compacted" | "failed") => void;
}

/**
 * Human-readable duration for a timeout reason.
 *
 * The reason string is persisted on the failed marker and shown to the user, so
 * rounding minutes would print "0 minute ceiling" for any sub-minute window
 * (which the tests use).
 */
function formatDuration(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const minutes = ms / 60_000;
	const rendered = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
	return `${rendered} minutes`;
}

export interface CompactWatchdog {
	/** Record observable progress and restart the stall window. */
	beat: () => void;
	/** Stop every timer, including the post-abort grace timer. Idempotent. */
	stop: () => void;
	/** The reason this compact was aborted by the watchdog, or null if it wasn't. */
	firedReason: () => string | null;
}

/**
 * Hooks a compact run exposes to its watchdog.
 *
 * Bundled rather than passed as two more parameters, so a run's liveness and its
 * timeout classification always travel together.
 */
export interface CompactRunHooks {
	/** Liveness signal — resets the stall window. */
	beat?: () => void;
	/**
	 * Non-null once the watchdog aborted this run, and only then.
	 *
	 * The run reads this to tell a watchdog timeout apart from a user cancellation:
	 * both arrive as an `AbortError`, but a timeout must surface as a FAILED
	 * compact (marker kept, reason recorded, blocking runs marked errored) rather
	 * than the silent rollback a deliberate cancel gets. A caller-initiated cancel
	 * takes precedence, so this returns null whenever the caller's own signal
	 * aborted.
	 */
	timeoutReason?: () => string | null;
}

/**
 * Bound a compact by INACTIVITY rather than total duration, and make the bound
 * effective by aborting the underlying summary request.
 *
 * Two failure modes motivated this. A `Promise.race` against a total-duration
 * timer released the per-narrator lock while `doRunCustomCompact` kept running:
 * the still-live compact held its `[Compacting]` marker and `compacting`
 * substatus, and the freed lock let the next trigger insert a SECOND marker, so
 * two "compacting" rows sat side by side and neither shrank the context. And
 * because the budget covered the whole cascade, a healthy multi-chunk compact of
 * a large context was killed for taking longer than one request should.
 *
 * So: every chunk/delta resets the stall window, the abort actually cancels the
 * upstream request, and the caller keeps awaiting the aborted run so the lock is
 * released only after the compact has really settled. `COMPACT_MAX_TOTAL_MS`
 * remains as a backstop, since progress alone cannot bound total runtime.
 *
 * Holding the lock until the aborted run settles is the trade this design makes,
 * and it has a failure mode of its own: a provider that ignores its AbortSignal
 * would hold the lock forever and quietly disable compaction for that narrator.
 * `stop()` is expected within `COMPACT_ABORT_GRACE_MS` of firing; missing that
 * deadline is logged at error level so the stall is observable rather than a
 * narrator that mysteriously stops compacting.
 */
export function createCompactWatchdog(options: {
	narratorId: string;
	onTimeout: (reason: string) => void;
	stallMs?: number;
	maxTotalMs?: number;
	/** How long the aborted run may take to settle before it is logged as stuck. */
	abortGraceMs?: number;
	/** Test seam for the stuck-after-abort report (defaults to an error log). */
	onAbortNotSettled?: (info: { narratorId: string; reason: string; graceMs: number }) => void;
}): CompactWatchdog {
	const stallMs = options.stallMs ?? COMPACT_STALL_TIMEOUT_MS;
	const maxTotalMs = options.maxTotalMs ?? COMPACT_MAX_TOTAL_MS;
	const abortGraceMs = options.abortGraceMs ?? COMPACT_ABORT_GRACE_MS;
	let stallTimer: ReturnType<typeof setTimeout> | undefined;
	let totalTimer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let firedReason: string | null = null;
	let stopped = false;

	const clearTimers = () => {
		if (stallTimer !== undefined) clearTimeout(stallTimer);
		if (totalTimer !== undefined) clearTimeout(totalTimer);
		stallTimer = undefined;
		totalTimer = undefined;
	};

	const fire = (reason: string) => {
		if (stopped || firedReason) return;
		firedReason = reason;
		clearTimers();
		logger.warn("Compact watchdog aborting stalled compact", {
			narratorId: options.narratorId,
			reason,
		});
		// The lock stays held until the aborted run settles. If it never does, the
		// narrator silently loses compaction, so make that state visible.
		graceTimer = setTimeout(() => {
			graceTimer = undefined;
			if (stopped) return;
			if (options.onAbortNotSettled) {
				options.onAbortNotSettled({
					narratorId: options.narratorId,
					reason,
					graceMs: abortGraceMs,
				});
				return;
			}
			logger.error("Compact did not settle after watchdog abort; compact lock is still held", {
				narratorId: options.narratorId,
				reason,
				graceMs: abortGraceMs,
			});
		}, abortGraceMs);
		options.onTimeout(reason);
	};

	const armStall = () => {
		if (stopped || firedReason) return;
		if (stallTimer !== undefined) clearTimeout(stallTimer);
		stallTimer = setTimeout(
			() => fire(`Compact made no progress for ${formatDuration(stallMs)}`),
			stallMs,
		);
	};

	armStall();
	totalTimer = setTimeout(
		() => fire(`Compact exceeded the ${formatDuration(maxTotalMs)} ceiling`),
		maxTotalMs,
	);

	return {
		beat: armStall,
		stop: () => {
			stopped = true;
			clearTimers();
			if (graceTimer !== undefined) clearTimeout(graceTimer);
			graceTimer = undefined;
		},
		firedReason: () => firedReason,
	};
}

/**
 * Two-phase progress reporter for a compaction run.
 *
 * The summary model may spend a while in its thinking channel before producing
 * any visible summary text, during which an output-only counter sits at 0 and
 * looks stalled. The shared reporter tracks both counts, latches the phase
 * forward, flushes immediately on a phase switch, and de-duplicates on the WHOLE
 * snapshot — keying on `outputChars` alone would drop every thinking-phase
 * update, since that count stays 0 for the entire thinking window.
 *
 * Exported for unit tests: the delta→phase wiring (text ⇒ output, reasoning ⇒
 * thinking) is the part a refactor can silently swap.
 */
export function createCompactProgressReporter(options: {
	narratorId: string;
	messageId: string;
	mode: CompactMode;
	model?: string;
	reasoningEffort?: string;
	startedAt?: string;
	isSegment?: boolean;
	/**
	 * Called on every non-empty delta, BEFORE throttling. The stall watchdog uses
	 * this as its liveness signal, so it must not be tied to the throttled
	 * broadcast: a compact that streams slower than the throttle window is still
	 * making progress.
	 */
	onActivity?: () => void;
}): CompactProgressReporter {
	// The retry broadcast carries the CURRENT counts, so the reporter mirrors the
	// last published snapshot (the throttled accumulator does not expose one).
	let lastSnapshot: ProgressSnapshot = { phase: "thinking", thinkingChars: 0, outputChars: 0 };
	startLiveCompactProgress(options.messageId, {
		model: options.model ?? "",
		...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
		startedAt: options.startedAt ?? new Date().toISOString(),
	});
	const reporter = createThrottledProgressReporter((snapshot) => {
		lastSnapshot = snapshot;
		broadcastToNarrator(options.narratorId, {
			type: "compact_progress",
			narratorId: options.narratorId,
			messageId: options.messageId,
			phase: snapshot.phase,
			thinkingChars: snapshot.thinkingChars,
			outputChars: snapshot.outputChars,
			mode: options.mode,
			...(options.model ? { model: options.model } : {}),
			...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
			...(options.startedAt ? { startedAt: options.startedAt } : {}),
			...(options.isSegment ? { isSegment: true } : {}),
		});
	}, COMPACT_PROGRESS_THROTTLE_MS);
	const reportRetry = (retryCount: number, error: string) => {
		broadcastToNarrator(options.narratorId, {
			type: "compact_progress",
			narratorId: options.narratorId,
			messageId: options.messageId,
			phase: lastSnapshot.phase,
			thinkingChars: lastSnapshot.thinkingChars,
			outputChars: lastSnapshot.outputChars,
			mode: options.mode,
			...(options.isSegment ? { isSegment: true } : {}),
			retryCount,
			retryError: error,
		});
	};
	const onActivity = options.onActivity;
	let outputChars = 0;
	let thinkingChars = 0;
	const addOutput = (delta: string) => {
		if (delta) {
			outputChars += delta.length;
			appendLiveCompactDelta(options.messageId, "output", delta, {
				outputChars,
				thinkingChars,
			});
			onActivity?.();
		}
		reporter.addOutput(delta);
	};
	const addThinking = (delta: string) => {
		if (delta) {
			thinkingChars += delta.length;
			appendLiveCompactDelta(options.messageId, "thinking", delta, {
				outputChars,
				thinkingChars,
			});
			onActivity?.();
		}
		reporter.addThinking(delta);
	};
	let closed = false;
	return {
		onTextDelta: addOutput,
		onReasoningDelta: addThinking,
		reportRetry,
		finish: () => reporter.finish(),
		close: (status: "compacted" | "failed") => {
			if (closed) return;
			closed = true;
			finishLiveCompactProgress(options.messageId, status);
		},
	};
}

export interface CustomCompactOptions {
	userId?: string | null;
	mode?: CompactMode;
	appendHint?: string;
	signal?: AbortSignal;
	trigger?: CompactMessageTrigger;
	model?: string;
	contextPercentBefore?: number;
	reuseFailedMessageId?: string;
	preparedRetryMessage?: MessageWithSeq & {
		model?: string;
		compactBoundaryMessageId: string | null;
		oldMessageId?: string;
		replacedMessageId?: string;
	};
}

function compactTriggerFor(
	options: CustomCompactOptions | undefined,
	mode: CompactMode,
): CompactMessageTrigger {
	return options?.trigger ?? (mode === "background" ? "background" : "manual");
}

function compactAttemptNumber(message: unknown): number | undefined {
	if (!message || typeof message !== "object" || !("contentJson" in message)) return undefined;
	const contentJson = (message as { contentJson?: unknown }).contentJson;
	const blocks = Array.isArray(contentJson) ? contentJson : [];
	const block = blocks.map(parseCompactMessageBlock).find(Boolean);
	return block ? normalizeCompactAttempts(block.attempts).at(-1)?.attempt : undefined;
}

function compactReplacementFields(options: CustomCompactOptions | undefined): {
	oldMessageId?: string;
	replacedMessageId?: string;
	messageId?: string;
	newMessageId?: string;
	replacementMessageId?: string;
} {
	const prepared = options?.preparedRetryMessage;
	const oldMessageId = prepared?.replacedMessageId ?? prepared?.oldMessageId;
	const newMessageId = prepared?.id;
	if (!oldMessageId || !newMessageId || oldMessageId === newMessageId) return {};
	return {
		oldMessageId,
		replacedMessageId: oldMessageId,
		// `messageId` is the established HTTP response field. Keep explicit aliases
		// too so a WS-only retry can be resolved without interpreting deletion IDs.
		messageId: newMessageId,
		newMessageId,
		replacementMessageId: newMessageId,
	};
}

async function broadcastCompactDone(
	narratorId: string,
	payload: {
		contextPercentAfter?: number;
		isSegment?: boolean;
		mode?: CompactMode;
		oldMessageId?: string;
		replacedMessageId?: string;
		messageId?: string;
		newMessageId?: string;
		replacementMessageId?: string;
	},
): Promise<void> {
	const messageVersion = await narratorService.getMessageVersion(narratorId).catch((err) => {
		logger.warn("Failed to read authoritative message version for compact completion", {
			narratorId,
			error: String(err),
		});
		return undefined;
	});
	broadcastToNarrator(narratorId, {
		type: "compact_done",
		narratorId,
		...(messageVersion != null ? { messageVersion } : {}),
		...payload,
	});
}

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

async function clearCompactFailureStatus(narratorId: string) {
	const narrator = await narratorService.getById(narratorId);
	const errorMessage = narrator.errorMessage ?? "";
	const isCompactFailure =
		errorMessage.startsWith("Compact failed:") ||
		errorMessage === "Context too long, compact failed";
	if (!isCompactFailure) return;
	const substatus = parseSubstatus(narrator.substatus).filter((status) => status !== "error");
	await narratorService.updateStatus(narratorId, narrator.status, { substatus });
}

function currentHistoryCompactMode(narratorId: string, fallback: CompactMode): CompactMode {
	const existing = compactLocks.get(narratorId);
	return existing && existing.kind !== "segment" && existing.mode ? existing.mode : fallback;
}

export async function markCompactAsBlocking(narratorId: string) {
	await setCompactingSubstatus(narratorId, "blocking", true);
	try {
		const markers = await db.query.narratorMessages.findMany({
			where: and(
				eq(narratorMessages.narratorId, narratorId),
				eq(narratorMessages.role, "system"),
				eq(narratorMessages.contentText, "[Compacting]"),
			),
			columns: { id: true, contentJson: true },
		});
		for (const marker of markers) {
			const blocks = Array.isArray(marker.contentJson) ? marker.contentJson : [];
			const compactBlock = blocks.map(parseCompactMessageBlock).find(Boolean);
			if (!compactBlock) continue;
			await db
				.update(narratorMessages)
				.set({ contentJson: [{ ...compactBlock, mode: "blocking" }] })
				.where(
					and(eq(narratorMessages.id, marker.id), eq(narratorMessages.narratorId, narratorId)),
				);
		}
	} catch (err) {
		logger.warn("Failed to update compact marker mode", { narratorId, error: String(err) });
	}
}

/** Check whether a compact operation is already running for the given narrator. */
export function isCompactInProgress(narratorId: string): boolean {
	return compactLocks.has(narratorId);
}

function compactAbortError(): DOMException {
	return new DOMException("Aborted", "AbortError");
}

/**
 * A compact the watchdog aborted for inactivity (or for exceeding the ceiling).
 *
 * Distinct from an `AbortError` on purpose: callers treat `AbortError` as "the
 * user cancelled" and stay quiet, whereas a timeout is a real failure they should
 * log and, for blocking runs, surface.
 */
export class CompactTimeoutError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "CompactTimeoutError";
	}
}

function waitForCompactPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(compactAbortError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(compactAbortError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/**
 * Await any in-progress compact for this narrator to settle. A compact can hand
 * off to a follow-up lock (e.g. history_probe → history), so re-check after each
 * settles; the small iteration cap guards against unexpected relock churn.
 *
 * Each underlying compact is bounded by its watchdog: `COMPACT_STALL_TIMEOUT_MS`
 * without observable progress, or `COMPACT_MAX_TOTAL_MS` overall. A healthy
 * multi-chunk compact keeps beating, so this wait can legitimately last up to the
 * ceiling — pass a `signal` if the caller cannot afford to wait that long.
 * Rejections (cancel/failure) are swallowed unless the caller aborts its wait.
 */
export async function awaitCompactCompletion(
	narratorId: string,
	signal?: AbortSignal,
): Promise<void> {
	for (let i = 0; i < 5; i++) {
		if (signal?.aborted) throw compactAbortError();
		const lock = compactLocks.get(narratorId);
		if (!lock) return;
		try {
			await waitForCompactPromise(lock.promise, signal);
		} catch (err) {
			if (isCompactAbortError(err)) throw err;
		}
	}
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
 * Segment compacts are deliberately excluded even though they now carry an
 * AbortController (their watchdog needs one). This endpoint is the context
 * marker's cancel affordance, and the UI offers no cancel on segment markers —
 * their rollback path is a `[Segment Compact Failed]` row, not a silent removal.
 *
 * Returns true if a cancellable compact was found and aborted, false otherwise.
 */
export function cancelCompact(narratorId: string): boolean {
	const lock = compactLocks.get(narratorId);
	if (!lock?.abortController) return false;
	if (lock.kind === "segment") return false;
	if (lock.abortController.signal.aborted) return true;
	logger.info("Cancelling in-progress compact", { narratorId, kind: lock.kind });
	lock.abortController.abort();
	return true;
}

// Re-export locks so narrator-session can access them
export { compactLocks };

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
	contextPercentBefore?: number,
	userId?: string | null,
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
			userId,
			trigger: "background",
			...(contextPercentBefore != null ? { contextPercentBefore } : {}),
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
				// This probe lock normally steps aside for runCustomCompact's own lock,
				// which then owns the drain. Only a probe that found no boundary reaches
				// here still holding the lock — and a message queued behind it would
				// otherwise have no consumer at all.
				void drainQueuedMessagesAfterCompact(narratorId);
			}
		});
}

/**
 * Run custom compact with concurrency protection.
 */
export async function runCustomCompact(
	...args: Parameters<typeof runCustomCompactUnlocked>
): ReturnType<typeof runCustomCompactUnlocked> {
	return withNarratorWorkAdmission(args[0], () => runCustomCompactUnlocked(...args));
}

async function runCustomCompactUnlocked(
	narratorId: string,
	locale: Locale,
	beforeMessageId?: string,
	options?: CustomCompactOptions,
): Promise<boolean> {
	const mode = options?.mode ?? "blocking";
	const appendHint = options?.appendHint;
	const callerSignal = options?.signal;
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
			result = await waitForCompactPromise(existing.promise, callerSignal);
		} catch (err) {
			if (isCompactAbortError(err)) throw err;
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
			await broadcastCompactDone(narratorId, {
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

	if (callerSignal?.aborted) throw compactAbortError();
	const abortController = new AbortController();
	const abortFromCaller = () => abortController.abort();
	callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
	// The watchdog aborts the run instead of racing it. Racing a timer released
	// this lock while the compact kept running, so its `[Compacting]` marker and
	// `compacting` substatus stayed live and the freed lock let the next trigger
	// insert a second marker over the same stale context.
	const watchdog = createCompactWatchdog({
		narratorId,
		onTimeout: () => abortController.abort(),
		...(compactWatchdogTimingOverrides ?? {}),
	});
	// A caller-initiated cancel wins: the user asked for the silent rollback, so it
	// keeps that path even if the watchdog happens to fire in the same tick.
	const timeoutReason = () => (callerSignal?.aborted ? null : watchdog.firedReason());
	const compactPromise: Promise<CompactLockResult> = doRunCustomCompact({
		narratorId,
		locale,
		beforeMessageId,
		mode,
		signal: abortController.signal,
		...(appendHint !== undefined ? { appendHint } : {}),
		...(options !== undefined ? { options } : {}),
		hooks: { beat: watchdog.beat, timeoutReason },
	}).then(
		(compacted) => {
			watchdog.stop();
			return {
				kind: "history" as const,
				compacted,
				mode: currentHistoryCompactMode(narratorId, mode),
			};
		},
		(err) => {
			watchdog.stop();
			// A watchdog abort surfaces as an AbortError, which every caller reads as
			// "the user cancelled". Re-label it so timeouts stay distinguishable from
			// cancellation for waiters and logs; the run itself already recorded the
			// timeout as a compact FAILURE via `timeoutReason`.
			const reason = timeoutReason();
			if (reason && isCompactAbortError(err)) throw new CompactTimeoutError(reason);
			throw err;
		},
	);
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
		callerSignal?.removeEventListener("abort", abortFromCaller);
		watchdog.stop();
		if (compactLocks.get(narratorId) === compactLock) {
			compactLocks.delete(narratorId);
			// Deliver anything the user queued while this compact ran. Deliberately in
			// `finally`: a failed, cancelled or timed-out compact leaves the same queue
			// as a successful one, and only the lock-release path sees every exit.
			// `resumeBufferedMessagesIfIdle` declines when another owner exists, so a
			// blocking compact whose turn is still running is unaffected.
			void drainQueuedMessagesAfterCompact(narratorId);
		}
	}
}

export async function retryFailedCompact(
	...args: Parameters<typeof retryFailedCompactUnlocked>
): ReturnType<typeof retryFailedCompactUnlocked> {
	return withNarratorWorkAdmission(
		args[0],
		() => retryFailedCompactUnlocked(...args),
		(result) => result.promise,
	);
}

async function retryFailedCompactUnlocked(
	narratorId: string,
	locale: Locale,
	messageId: string,
	model?: string,
	userId?: string | null,
) {
	if (compactLocks.has(narratorId)) {
		throw new AppError("Compact already in progress", 409, "COMPACT_IN_PROGRESS");
	}

	let releaseReservation!: (result: CompactLockResult) => void;
	const reservationPromise = new Promise<CompactLockResult>((resolve) => {
		releaseReservation = resolve;
	});
	const reservationLock: CompactLock = {
		kind: "history",
		promise: reservationPromise,
		mode: "blocking",
	};
	compactLocks.set(narratorId, reservationLock);

	try {
		const prepared = await narratorService.prepareFailedCompactRetry(narratorId, messageId, model);
		if (compactLocks.get(narratorId) === reservationLock) {
			compactLocks.delete(narratorId);
		}

		// A shared marker's ref has moved atomically from the old row to the private
		// retry row. This broadcast is narrator-scoped; sibling refs still retain the
		// old row. Tell this narrator's clients about the replacement before starting
		// the async summary request, whose first frame carries the new ID.
		const replacedMessageId = prepared.replacedMessageId ?? prepared.oldMessageId;
		if (replacedMessageId && replacedMessageId !== prepared.id) {
			const replacementEvent = {
				type: "messages_deleted" as const,
				narratorId,
				deletedMessageIds: [replacedMessageId],
				...compactReplacementFields({ preparedRetryMessage: prepared }),
			};
			broadcastToNarrator(narratorId, replacementEvent);
		}

		// runCustomCompact installs the real history lock synchronously before this
		// async function yields again, closing the prepare→execute race window.
		const promise = runCustomCompact(narratorId, locale, prepared.id, {
			mode: "blocking",
			trigger: "retry",
			userId,
			model: prepared.model,
			reuseFailedMessageId: prepared.id,
			preparedRetryMessage: prepared,
		});
		releaseReservation({ kind: "history", compacted: false, mode: "blocking" });
		return {
			message: prepared,
			messageId: prepared.id,
			promise,
			...(replacedMessageId ? { oldMessageId: replacedMessageId, replacedMessageId } : {}),
		};
	} catch (error) {
		if (compactLocks.get(narratorId) === reservationLock) {
			compactLocks.delete(narratorId);
		}
		releaseReservation({ kind: "history", compacted: false, mode: "blocking" });
		throw error;
	}
}

/** Everything one history-compact run needs. Named to keep call sites readable. */
interface DoRunCustomCompactArgs {
	narratorId: string;
	locale: Locale;
	beforeMessageId?: string;
	mode: CompactMode;
	signal?: AbortSignal;
	/** Extra text appended to the summary (e.g. context-overflow recovery hint). */
	appendHint?: string;
	options?: CustomCompactOptions;
	hooks?: CompactRunHooks;
}

async function doRunCustomCompact({
	narratorId,
	locale,
	beforeMessageId,
	mode,
	signal,
	appendHint,
	options,
	hooks,
}: DoRunCustomCompactArgs): Promise<boolean> {
	const selectedModel = options?.model?.trim() || settings.agent.summaryModel;
	const replacementFields = compactReplacementFields(options);
	const isRetry = options?.preparedRetryMessage != null;
	logger.info("Starting custom compact", {
		narratorId,
		beforeMessageId,
		mode,
		model: selectedModel,
		retryingMessageId: options?.reuseFailedMessageId,
	});

	const messages = beforeMessageId
		? await narratorService.getMessagesBefore(narratorId, beforeMessageId)
		: undefined;
	let expectedAttempt = options?.preparedRetryMessage
		? compactAttemptNumber(options.preparedRetryMessage)
		: undefined;
	let expectedSeq = options?.preparedRetryMessage?.seq;

	if (beforeMessageId && (!messages || messages.length === 0)) {
		logger.info("No messages to compact before target", { narratorId, beforeMessageId });
		if (options?.preparedRetryMessage) {
			const error = "No messages are available before this compact marker";
			const failedMsg = await narratorService.finalizeCompactingMessage(
				options.preparedRetryMessage.id,
				narratorId,
				"",
				undefined,
				{ status: "failed", error, mode, expectedAttempt },
			);
			if (failedMsg) {
				const failedMessageEvent = {
					type: "message_updated" as const,
					narratorId,
					message: failedMsg,
					...replacementFields,
				};
				broadcastToNarrator(narratorId, failedMessageEvent);
			}
			const compactFailedEvent = {
				type: "compact_failed" as const,
				narratorId,
				messageId: failedMsg?.id ?? options.preparedRetryMessage.id,
				mode,
				error,
				...replacementFields,
			};
			broadcastToNarrator(narratorId, compactFailedEvent);
		}
		return false;
	}

	const compactingMsg =
		options?.preparedRetryMessage ??
		(await narratorService.persistCompactingMessage(narratorId, beforeMessageId, mode, {
			trigger: compactTriggerFor(options, mode),
			model: selectedModel,
			contextPercentBefore: options?.contextPercentBefore,
		}));
	expectedAttempt = compactAttemptNumber(compactingMsg);
	expectedSeq = compactingMsg.seq;
	const compactStartEvent = {
		type: options?.preparedRetryMessage ? ("message_updated" as const) : ("message" as const),
		narratorId,
		message: compactingMsg,
		...replacementFields,
	};
	broadcastToNarrator(narratorId, compactStartEvent);
	await setCompactingSubstatus(narratorId, mode, true);
	broadcastToNarrator(narratorId, { type: "compacting", narratorId, mode });

	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { variant: true },
	});
	const isSubagent = narrator?.variant ? narrator.variant.startsWith("subagent") : false;
	const compactProgress = createCompactProgressReporter({
		narratorId,
		messageId: compactingMsg.id,
		mode,
		model: selectedModel,
		reasoningEffort: resolveDefaultReasoningEffort(undefined, selectedModel),
		startedAt: "createdAt" in compactingMsg ? compactingMsg.createdAt : new Date().toISOString(),
		...(hooks?.beat ? { onActivity: hooks.beat } : {}),
	});

	try {
		// Counts every scheduled retry across BOTH retry layers (summaryGenerate's
		// internal backoff chain and the whole-chunk retry in narrator-context), so
		// the UI's "retrying (N)" ordinal never resets or goes backwards mid-run.
		let retryCount = 0;
		const { summary, contextPercent } = await narratorContext.generateCompactSummary(
			narratorId,
			locale,
			messages,
			signal,
			selectedModel,
			compactProgress.onTextDelta,
			compactProgress.onReasoningDelta,
			// Chunk boundaries are the only liveness signal for a summary model that
			// does not stream, so a multi-chunk cascade must not read as a stall.
			hooks?.beat,
			(info) => {
				retryCount += 1;
				compactProgress.reportRetry(retryCount, info.error);
			},
			options?.userId,
		);
		compactProgress.finish();
		// Providers should honor the signal, but enforce cancellation at the
		// persistence boundary as well so a late summary can never win the CAS.
		if (signal?.aborted) throw compactAbortError();

		// Append an optional emergency hint (e.g. context-overflow recovery) to the
		// end of the summary so the next turn's system prompt carries it forward.
		const finalSummary = appendHint ? `${summary}\n\n${appendHint}` : summary;

		const finalizeMode = currentHistoryCompactMode(narratorId, mode);
		const compactedMsg = await narratorService.finalizeCompactingMessage(
			compactingMsg.id,
			narratorId,
			finalSummary,
			contextPercent,
			{
				mode: finalizeMode,
				expectedAttempt,
				expectedSeq,
				...(options?.preparedRetryMessage
					? {
							expectedCompactBoundaryMessageId:
								options.preparedRetryMessage.compactBoundaryMessageId,
						}
					: {}),
			},
		);
		if (!compactedMsg) {
			throw new AppError(
				"Compact marker disappeared or its attempt changed before finalize",
				409,
				"COMPACT_FINALIZE_CONFLICT",
			);
		}

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
			const compactUpdatedEvent = {
				type: "message_updated" as const,
				narratorId,
				message: estimated.message,
				...replacementFields,
			};
			broadcastToNarrator(narratorId, compactUpdatedEvent);
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
		if (options?.reuseFailedMessageId) {
			await clearCompactFailureStatus(narratorId).catch((err) => {
				logger.warn("Failed to clear compact failure status after retry", {
					narratorId,
					error: String(err),
				});
			});
		}
		logger.info("Custom compact completed", {
			narratorId,
			model: selectedModel,
			summaryLength: summary.length,
		});
		await broadcastCompactDone(narratorId, {
			contextPercentAfter,
			mode: finalizeMode,
			...(isRetry ? { messageId: compactedMsg.id } : {}),
			...replacementFields,
		});
		compactProgress.close("compacted");
		return true;
	} catch (err) {
		compactProgress.finish();
		// A watchdog abort arrives as an AbortError but is NOT a cancellation: nobody
		// asked for it, the context was not compacted, and a blocking run must not
		// continue its turn believing the context shrank. Report the timeout reason
		// instead of "Aborted" and fall through to the failure path below.
		const watchdogTimeout = isCompactAbortError(err) ? (hooks?.timeoutReason?.() ?? null) : null;
		const errorMsg = watchdogTimeout ?? (err instanceof Error ? err.message : String(err));

		// Cancelled by the user — silently roll back the in-progress compact:
		// remove the placeholder marker, reset context state, and clear the
		// transient substatus WITHOUT marking the narrator as errored.
		if (isCompactAbortError(err) && !watchdogTimeout) {
			logger.info("Custom compact cancelled by user", {
				narratorId,
				messageId: compactingMsg.id,
			});
			let cancellationSettled = true;
			if (options?.reuseFailedMessageId) {
				const cancelledMsg = await narratorService.finalizeCompactingMessage(
					compactingMsg.id,
					narratorId,
					"",
					undefined,
					{
						status: "failed",
						error: "Compact retry cancelled",
						mode,
						expectedAttempt,
					},
				);
				if (cancelledMsg) {
					const cancelledMessageEvent = {
						type: "message_updated" as const,
						narratorId,
						message: cancelledMsg,
						...replacementFields,
					};
					broadcastToNarrator(narratorId, cancelledMessageEvent);
				} else {
					cancellationSettled = false;
				}
			} else {
				// A running marker is not directly deletable. Close the running attempt
				// first, then remove the now-failed marker through the normal delete path.
				const cancelledMsg = await narratorService
					.finalizeCompactingMessage(compactingMsg.id, narratorId, "", undefined, {
						status: "failed",
						error: "Compact cancelled",
						mode,
						expectedAttempt,
					})
					.catch((e) => {
						logger.warn("Failed to close compacting marker after cancel", {
							narratorId,
							messageId: compactingMsg.id,
							error: String(e),
						});
						return null;
					});
				if (cancelledMsg) {
					const deleted = await narratorService
						.deleteCompactMessage(narratorId, cancelledMsg.id)
						.then(
							() => true,
							(e) => {
								logger.warn("Failed to remove cancelled compact marker", {
									narratorId,
									messageId: cancelledMsg.id,
									error: String(e),
								});
								return false;
							},
						);
					if (deleted) {
						broadcastToNarrator(narratorId, {
							type: "messages_deleted",
							narratorId,
							deletedMessageIds: [cancelledMsg.id],
						});
					} else {
						cancellationSettled = false;
					}
				} else {
					cancellationSettled = false;
				}
			}
			const cancelledMode = currentHistoryCompactMode(narratorId, mode);
			await setCompactingSubstatus(narratorId, cancelledMode, false).catch(() => {});
			if (cancellationSettled) {
				await broadcastCompactDone(narratorId, {
					mode: cancelledMode,
					...(isRetry ? { messageId: compactingMsg.id } : {}),
					...replacementFields,
				});
			}
			compactProgress.close("failed");
			throw err;
		}

		logger.error("Custom compact failed after retries", {
			narratorId,
			messageId: compactingMsg.id,
			error: errorMsg,
			...(watchdogTimeout ? { timedOut: true } : {}),
		});

		const failureMode = currentHistoryCompactMode(narratorId, mode);
		const failedMsg = await narratorService
			.finalizeCompactingMessage(compactingMsg.id, narratorId, "", undefined, {
				status: "failed",
				error: errorMsg,
				mode: failureMode,
				expectedAttempt,
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
			const compactFailedMessageEvent = {
				type: "message_updated" as const,
				narratorId,
				message: failedMsg,
				...replacementFields,
			};
			broadcastToNarrator(narratorId, compactFailedMessageEvent);
		}

		if (failureMode === "blocking") {
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
				active.abortController.abort(new Error("Compacting narrator history; restarting the turn"));
			}
		}
		await setCompactingSubstatus(narratorId, failureMode, false).catch((err) => {
			logger.warn("Failed to clear compacting substatus after failed custom compact", {
				narratorId,
				error: String(err),
			});
		});
		const compactFailedEvent = {
			type: "compact_failed" as const,
			narratorId,
			messageId: compactingMsg.id,
			mode: failureMode,
			error: errorMsg,
			...replacementFields,
		};
		broadcastToNarrator(narratorId, compactFailedEvent);
		compactProgress.close("failed");
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
	...args: Parameters<typeof runSegmentCompactUnlocked>
): ReturnType<typeof runSegmentCompactUnlocked> {
	return withNarratorWorkAdmission(args[0], () => runSegmentCompactUnlocked(...args));
}

async function runSegmentCompactUnlocked(
	narratorId: string,
	locale: Locale,
	messageIds: string[],
	userId?: string | null,
): Promise<void> {
	const existing = compactLocks.get(narratorId);
	if (existing) {
		await existing.promise.catch(() => {});
		await broadcastCompactDone(narratorId, {
			isSegment: true,
			mode: "blocking",
		});

		return;
	}

	// Same stall-not-duration contract as the history path, for the same reason: a
	// raced timer would free the lock while the run kept its marker "compacting".
	const abortController = new AbortController();
	const watchdog = createCompactWatchdog({
		narratorId,
		onTimeout: () => abortController.abort(),
		...(compactWatchdogTimingOverrides ?? {}),
	});
	const promise: Promise<CompactLockResult> = doRunSegmentCompact({
		narratorId,
		locale,
		messageIds,
		userId,
		signal: abortController.signal,
		hooks: { beat: watchdog.beat, timeoutReason: watchdog.firedReason },
	}).then(
		(compacted) => {
			watchdog.stop();
			return { kind: "segment" as const, compacted, mode: "blocking" as const };
		},
		(err) => {
			watchdog.stop();
			const reason = watchdog.firedReason();
			if (reason && isCompactAbortError(err)) throw new CompactTimeoutError(reason);
			throw err;
		},
	);
	const lock: CompactLock = { kind: "segment", promise, mode: "blocking", abortController };
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
		watchdog.stop();
		if (compactLocks.get(narratorId) === lock) {
			compactLocks.delete(narratorId);
			// A segment compact holds the same lock the queue admission checks, so a
			// message queued behind one needs the same consumer.
			void drainQueuedMessagesAfterCompact(narratorId);
		}
	}
}

async function doRunSegmentCompact({
	narratorId,
	locale,
	messageIds,
	userId,
	signal,
	hooks,
}: {
	narratorId: string;
	locale: Locale;
	messageIds: string[];
	userId?: string | null;
	signal?: AbortSignal;
	hooks?: CompactRunHooks;
}): Promise<boolean> {
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
	const compactProgress = createCompactProgressReporter({
		narratorId,
		messageId: markerMsg.id,
		mode: "blocking",
		model: settings.agent.summaryModel,
		reasoningEffort: resolveDefaultReasoningEffort(undefined, settings.agent.summaryModel),
		startedAt: "createdAt" in markerMsg ? markerMsg.createdAt : new Date().toISOString(),
		isSegment: true,
		...(hooks?.beat ? { onActivity: hooks.beat } : {}),
	});

	try {
		const messages = await narratorService.getMessagesForSegmentCompact(narratorId, messageIds);

		if (messages.length === 0) {
			compactProgress.finish();
			await narratorService.deleteSegmentCompact(narratorId, markerMsg.id);
			await setCompactingSubstatus(narratorId, "blocking", false);
			await broadcastCompactDone(narratorId, {
				isSegment: true,
				mode: "blocking",
			});
			compactProgress.close("compacted");

			return false;
		}

		// Same retry-visibility contract as the history path: every scheduled retry
		// bumps one ordinal the UI can show instead of a silent 0-char spinner.
		let segmentRetryCount = 0;
		const { summary, contextPercent } = await narratorContext.generateCompactSummary(
			narratorId,
			locale,
			messages,
			signal,
			undefined,
			compactProgress.onTextDelta,
			compactProgress.onReasoningDelta,
			hooks?.beat,
			(info) => {
				segmentRetryCount += 1;
				compactProgress.reportRetry(segmentRetryCount, info.error);
			},
			userId,
		);
		compactProgress.finish();
		// Enforce cancellation at the persistence boundary too, so a summary that
		// arrives after the watchdog fired cannot finalize a marker whose lock is gone.
		if (signal?.aborted) throw compactAbortError();

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
			broadcastToNarrator(narratorId, {
				type: "message_updated",
				narratorId,
				message: estimated.message,
			});
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
		await broadcastCompactDone(narratorId, {
			contextPercentAfter,
			isSegment: true,
			mode: "blocking",
		});
		compactProgress.close("compacted");
		return true;
	} catch (err) {
		compactProgress.finish();
		// A watchdog abort is a bare "Aborted" AbortError, which tells the user
		// nothing about why their segment summary failed. Record the timeout reason.
		const watchdogTimeout = isCompactAbortError(err) ? (hooks?.timeoutReason?.() ?? null) : null;
		const errorMsg = watchdogTimeout ?? (err instanceof Error ? err.message : String(err));
		logger.error("Segment compact failed", {
			narratorId,
			messageId: markerMsg.id,
			error: errorMsg,
			...(watchdogTimeout ? { timedOut: true } : {}),
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
			broadcastToNarrator(narratorId, {
				type: "message_updated",
				narratorId,
				message: failedMsg,
			});
		}

		await setCompactingSubstatus(narratorId, "blocking", false).catch(() => {});
		broadcastToNarrator(narratorId, {
			type: "compact_failed",
			narratorId,
			messageId: markerMsg.id,
			mode: "blocking",
			error: errorMsg,
		});
		compactProgress.close("failed");
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
 * Run a plan compact: persist the plan text as a compact message.
 */
export async function runPlanCompact(narratorId: string, planText: string): Promise<void> {
	return withNarratorWorkAdmission(narratorId, () => runPlanCompactUnlocked(narratorId, planText));
}

async function runPlanCompactUnlocked(narratorId: string, planText: string): Promise<void> {
	logger.info("Starting plan compact", { narratorId, planLength: planText.length });

	// persistPlanMessage atomically inserts the message, sets isCompact=1,
	// and updates narrator's contextSummary + clears apiConversationId.
	const compactMsg = await narratorService.persistPlanMessage(narratorId, planText);
	if (compactMsg) {
		broadcastToNarrator(narratorId, { type: "message", narratorId, message: compactMsg });
	}

	logger.info("Plan compact completed", { narratorId, summaryLength: planText.length });
}
