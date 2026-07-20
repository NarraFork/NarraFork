import {
	type CompactMessageTrigger,
	normalizeCompactAttempts,
	parseCompactMessageBlock,
} from "@shared/compact-message";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorMessages, narrators } from "../db/schema";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import type { Locale } from "../lib/prompt-i18n";
import { getAutoCompactKeepPairs, settings } from "../lib/settings";
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
const COMPACT_PROGRESS_THROTTLE_MS = 120;
const COMPACT_FAILURE_TEXT = "[Compact Failed]";
const COMPACTING_SUBSTATUS = "compacting";
const BACKGROUND_COMPACTING_SUBSTATUS = "background_compacting";

interface CompactProgressReporter {
	onTextDelta: (delta: string) => void;
	finish: () => void;
}

function createCompactProgressReporter(options: {
	narratorId: string;
	messageId: string;
	mode: CompactMode;
	isSegment?: boolean;
}): CompactProgressReporter {
	let outputChars = 0;
	let lastBroadcastChars = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let finished = false;

	const broadcast = () => {
		timer = null;
		if (finished || outputChars === lastBroadcastChars) return;
		lastBroadcastChars = outputChars;
		broadcastToNarrator(options.narratorId, {
			type: "compact_progress",
			narratorId: options.narratorId,
			messageId: options.messageId,
			outputChars,
			mode: options.mode,
			...(options.isSegment ? { isSegment: true } : {}),
		});
	};

	return {
		onTextDelta: (delta) => {
			if (finished || !delta) return;
			outputChars += delta.length;
			if (!timer) timer = setTimeout(broadcast, COMPACT_PROGRESS_THROTTLE_MS);
		},
		finish: () => {
			if (finished) return;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			broadcast();
			finished = true;
		},
	};
}

export interface CustomCompactOptions {
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
 * settles. Each underlying compact promise is bounded by its own 5-minute
 * timeout; the small iteration cap guards against unexpected relock churn.
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
	contextPercentBefore?: number,
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
	let compactTimer: ReturnType<typeof setTimeout>;
	const compactPromise: Promise<CompactLockResult> = Promise.race([
		doRunCustomCompact(
			narratorId,
			locale,
			beforeMessageId,
			mode,
			abortController.signal,
			appendHint,
			options,
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
		callerSignal?.removeEventListener("abort", abortFromCaller);
		// biome-ignore lint/style/noNonNullAssertion: timer is always assigned before race settles
		clearTimeout(compactTimer!);
		if (compactLocks.get(narratorId) === compactLock) {
			compactLocks.delete(narratorId);
		}
	}
}

export async function retryFailedCompact(
	narratorId: string,
	locale: Locale,
	messageId: string,
	model?: string,
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

async function doRunCustomCompact(
	narratorId: string,
	locale: Locale,
	beforeMessageId: string | undefined,
	mode: CompactMode,
	signal?: AbortSignal,
	appendHint?: string,
	options?: CustomCompactOptions,
): Promise<boolean> {
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
		columns: { pruneBoundaryMessageId: true, variant: true },
	});
	const pruneBoundaryMessageId = narrator?.pruneBoundaryMessageId ?? null;
	const isSubagent = narrator?.variant ? narrator.variant.startsWith("subagent") : false;
	const compactProgress = createCompactProgressReporter({
		narratorId,
		messageId: compactingMsg.id,
		mode,
	});

	try {
		const { summary, contextPercent } = await narratorContext.generateCompactSummary(
			narratorId,
			locale,
			messages,
			pruneBoundaryMessageId,
			signal,
			selectedModel,
			compactProgress.onTextDelta,
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
		return true;
	} catch (err) {
		compactProgress.finish();
		const errorMsg = err instanceof Error ? err.message : String(err);

		// Cancelled by the user — silently roll back the in-progress compact:
		// remove the placeholder marker, reset context state, and clear the
		// transient substatus WITHOUT marking the narrator as errored.
		if (isCompactAbortError(err)) {
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
			throw err;
		}

		logger.error("Custom compact failed after retries", {
			narratorId,
			messageId: compactingMsg.id,
			error: errorMsg,
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
				active.abortController.abort();
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
			...replacementFields,
		};
		broadcastToNarrator(narratorId, compactFailedEvent);
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
		await broadcastCompactDone(narratorId, {
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
	const compactProgress = createCompactProgressReporter({
		narratorId,
		messageId: markerMsg.id,
		mode: "blocking",
		isSegment: true,
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

			return false;
		}

		const { summary, contextPercent } = await narratorContext.generateCompactSummary(
			narratorId,
			locale,
			messages,
			null,
			undefined,
			undefined,
			compactProgress.onTextDelta,
		);
		compactProgress.finish();

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
		return true;
	} catch (err) {
		compactProgress.finish();
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
