import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators, narratorToolCalls } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	BLOCKED_SKILLS_TRAIT_PREFIX,
	DISABLED_TOOLS_TRAIT_PREFIX,
	resolveEffectiveSubagentModelPolicy,
	resolveSubagentModelFromPolicy,
} from "../lib/narrator-custom-traits";
import { getSubagentType, hasTrait, isSubagentVariant, parseTraits } from "../lib/narrator-utils";
import type { Locale } from "../lib/prompt-i18n";
import {
	expandAllowedPoolForDisplay,
	FOLLOW_DEFAULT_MODEL,
	resolveEffectiveModel,
	resolveProvider,
	settings,
} from "../lib/settings";
import { type ImageRef, saveTextFileToWorktree, type TextFileRef } from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { backgroundTaskService } from "./background-task-service";
import { pushBgCompletionNotification } from "./bg-completion-queue";
import { customSubagentService } from "./custom-subagent-service";
import { narratorService } from "./narrator-service";
import {
	getSubagentResultMessageId,
	startBackgroundCompletionContinuationIfPossible,
} from "./narrator-session";
import { registerAndPersistSubagentAlias, registerTaskAlias } from "./subagent-alias";
import {
	attachSubagent,
	consumeForegroundSubagentHardInterrupt,
	type DetachSetupResult,
	getAttachWaitersMap,
	getBackgroundAbortControllers,
	getDetachableMap,
	getForegroundAbortControllers,
	ProxyAbortController,
} from "./subagent-detach";
import {
	consumeNextBufferedSubagentMessage,
	executeSubagent,
	finalizeSubagent,
	loadSubagentHistory,
	type SubagentExecOptions,
} from "./subagent-executor";
import { waitForManualOverride } from "./subagent-manual-override";
import {
	clearTakenOver,
	consumePendingStopTakeover,
	consumePendingTakeover,
	isBackgroundTakenOver,
	isTakenOver,
	markTakenOver,
} from "./subagent-takeover";
import { clearTeamInbox } from "./subagent-team";
import { buildSubagentSystemPrompt } from "./subagent-tools";

/** Maximum background task execution time (30 minutes). */
export const BACKGROUND_TASK_TIMEOUT_MS = 30 * 60 * 1000;

export type BackgroundCompletionOutcome = "completed" | "failed" | "timeout";

async function restorePendingSubagentModel(narratorId: string): Promise<void> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { pendingModelRestore: true },
	});
	if (!narrator?.pendingModelRestore) return;
	const model = narrator.pendingModelRestore;
	await db
		.update(narrators)
		.set({ model, pendingModelRestore: null, updatedAt: new Date().toISOString() })
		.where(eq(narrators.id, narratorId));
	broadcastToNarrator(narratorId, { type: "model_changed", narratorId, model });
}

export function resolveBackgroundCompletionOutcome(input: {
	timedOut: boolean;
	hasError: boolean;
	contextLengthExceeded?: boolean;
	aborted?: boolean;
}): BackgroundCompletionOutcome {
	if (input.timedOut) return "timeout";
	if (input.hasError || input.contextLengthExceeded || input.aborted) return "failed";
	return "completed";
}

/**
 * Shared helper: update narrator background fields, emit events, broadcast WS,
 * push notification, and mark in backgroundTaskService.
 * Used by both executeBackgroundTask and runForegroundLoop (detach path).
 */
async function finalizeBackgroundCompletion(
	narratorId: string,
	parentNarratorId: string,
	toolUseId: string,
	outcome: BackgroundCompletionOutcome,
	finalText: string,
	locale: Locale = "en",
): Promise<void> {
	const storedText =
		finalText ||
		(outcome === "timeout"
			? `Background task timed out after ${BACKGROUND_TASK_TIMEOUT_MS / 60_000} minutes`
			: outcome === "failed"
				? "Unknown error"
				: "(no output)");
	const task = await backgroundTaskService.getById(narratorId).catch(() => null);
	if (task) {
		const transitioned =
			outcome === "timeout"
				? await backgroundTaskService.markTimedOut(narratorId, storedText)
				: outcome === "failed"
					? await backgroundTaskService.markFailed(narratorId, storedText)
					: await backgroundTaskService.markCompleted(narratorId, storedText);
		if (!transitioned) return;
	}

	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({
			backgroundStatus: outcome === "completed" ? "completed" : "failed",
			backgroundResult: storedText,
			backgroundCompletedAt: now,
			updatedAt: now,
		})
		.where(eq(narrators.id, narratorId));

	const title = (await narratorService.getById(narratorId).catch(() => null))?.title ?? narratorId;
	const resultPreview = storedText.slice(0, 500);

	if (outcome !== "completed") {
		eventBus.emit({
			type: "narrator:background_task_failed",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			error: storedText,
		});
		if (!task) {
			broadcastToNarrator(parentNarratorId, {
				type: "background_task_failed",
				narratorId: parentNarratorId,
				taskNarratorId: narratorId,
				toolUseId,
				error: storedText,
			});
		}
		pushBgCompletionNotification(parentNarratorId, {
			id: narratorId,
			title,
			status: outcome === "timeout" ? "timed out" : "failed",
			resultPreview,
			result: storedText,
		});
	} else {
		eventBus.emit({
			type: "narrator:background_task_completed",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			resultPreview,
		});
		if (!task) {
			broadcastToNarrator(parentNarratorId, {
				type: "background_task_completed",
				narratorId: parentNarratorId,
				taskNarratorId: narratorId,
				toolUseId,
				resultPreview,
			});
		}
		pushBgCompletionNotification(parentNarratorId, {
			id: narratorId,
			title,
			status: "completed",
			resultPreview,
			result: storedText,
		});
	}

	startBackgroundCompletionContinuationIfPossible(parentNarratorId, locale).catch((err) => {
		logger.warn("Failed to start parent narrator for background task completion", {
			parentNarratorId,
			taskNarratorId: narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

async function isBackgroundTaskCancelled(taskId: string): Promise<boolean> {
	const task = await backgroundTaskService.getById(taskId).catch(() => null);
	return task?.status === "cancelled";
}

/**
 * Finalize a subagent that was taken over while it had been a background task.
 * Restores background completion semantics so the parent (which holds the
 * background_task_id) can retrieve the result via Await / completion sidecar.
 * Pushes the completion notification directly (the background task row was
 * silently ended during takeover, so the normal task-row transition is skipped).
 */
export async function finalizeTakenOverBackgroundSubagent(
	narratorId: string,
	parentNarratorId: string,
	toolUseId: string,
	hasError: boolean,
	finalText: string,
	locale: Locale = "en",
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({
			isBackground: true,
			backgroundStatus: hasError ? "failed" : "completed",
			backgroundResult: finalText || "(no output)",
			backgroundCompletedAt: now,
			updatedAt: now,
		})
		.where(eq(narrators.id, narratorId));

	// Restore the background task row (set to "cancelled" during takeover) to its
	// real terminal result so the parent's Await path returns the actual output
	// instead of a stale cancellation. The task id equals the subagent narrator id.
	await backgroundTaskService.finalizeTakenOver(narratorId, hasError, finalText || "(no output)");

	const title = (await narratorService.getById(narratorId).catch(() => null))?.title ?? narratorId;
	const resultPreview = (finalText || "").slice(0, 500);

	if (hasError) {
		eventBus.emit({
			type: "narrator:background_task_failed",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			error: finalText,
		});
		broadcastToNarrator(parentNarratorId, {
			type: "background_task_failed",
			narratorId: parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			error: finalText,
		});
		pushBgCompletionNotification(parentNarratorId, {
			id: narratorId,
			title,
			status: "failed",
			resultPreview,
			result: finalText,
		});
	} else {
		eventBus.emit({
			type: "narrator:background_task_completed",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			resultPreview,
		});
		broadcastToNarrator(parentNarratorId, {
			type: "background_task_completed",
			narratorId: parentNarratorId,
			taskNarratorId: narratorId,
			toolUseId,
			resultPreview,
		});
		pushBgCompletionNotification(parentNarratorId, {
			id: narratorId,
			title,
			status: "completed",
			resultPreview,
			result: finalText,
		});
	}

	startBackgroundCompletionContinuationIfPossible(parentNarratorId, locale).catch((err) => {
		logger.warn("Failed to start parent narrator for taken-over background completion", {
			parentNarratorId,
			taskNarratorId: narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

/**
 * Transition a background subagent that was just taken over into the idle
 * takeover state: leave background mode (so the user can operate it via the
 * normal narrator-session engine), keep the taken_over substatus, and stop
 * tracking it as a background task. The parent is NOT notified of completion —
 * results are returned only when the user stops takeover.
 */
async function transitionBackgroundTakenOverToIdle(
	narratorId: string,
	parentNarratorId: string,
	toolUseId: string,
): Promise<void> {
	const now = new Date().toISOString();
	const subNarrator = await narratorService.getById(narratorId).catch(() => null);
	const updatedTraits = subNarrator
		? parseTraits(subNarrator.traits).filter((t) => t !== "background")
		: undefined;
	await db
		.update(narrators)
		.set({
			isBackground: false,
			backgroundStatus: null,
			backgroundResult: null,
			backgroundCompletedAt: null,
			...(updatedTraits ? { traits: updatedTraits } : {}),
			updatedAt: now,
		})
		.where(eq(narrators.id, narratorId));

	// idle[taken_over] — preserveTakenOverSubstatus keeps the tag because the
	// in-memory takeover Set is still set.
	await narratorService.updateStatus(narratorId, "idle", {
		substatus: ["taken_over"],
		skipErrorMessage: true,
	});

	// Stop tracking as a background task (silently — no cancellation broadcast).
	getBackgroundAbortControllers().delete(narratorId);
	backgroundTaskService.unregisterAbortController(narratorId);
	await backgroundTaskService.markTakenOver(narratorId).catch(() => {});

	// Notify the parent's SubagentCard + the subagent page that it is now taken over.
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_suspended",
		narratorId: parentNarratorId,
		subagentNarratorId: narratorId,
		toolUseId,
	});
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_status_changed",
		narratorId: parentNarratorId,
		subagentNarratorId: narratorId,
		status: "idle",
		substatus: ["taken_over"],
	});
	broadcastToNarrator(narratorId, {
		type: "status_change",
		narratorId,
		status: "idle",
		substatus: ["taken_over"],
	});
}

/** Broadcast subagent_started event. */
export function broadcastSubagentStarted(
	subagentId: string,
	parentNarratorId: string,
	toolUseId: string,
	subagentType: string,
	model?: string,
): void {
	eventBus.emit({
		type: "narrator:subagent_started",
		narratorId: subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
	});
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_started",
		narratorId: parentNarratorId,
		subagentNarratorId: subagentId,
		toolUseId,
		subagentType,
		...(model && { model }),
	});
}

// === Background task management ===

/**
 * Execute a background task (fire-and-forget).
 * Updates narrator status and broadcasts events on completion/failure.
 */
export async function executeBackgroundTask(opts: SubagentExecOptions): Promise<void> {
	const { narratorId, parentNarratorId, toolUseId, locale } = opts;

	// Set a maximum execution timeout
	let timedOut = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		const ctrl = getBackgroundAbortControllers().get(narratorId);
		if (ctrl) ctrl.abort("Background task timeout");
	}, BACKGROUND_TASK_TIMEOUT_MS);

	try {
		const result = await executeSubagent(opts);

		const timeoutText = `Background task timed out after ${BACKGROUND_TASK_TIMEOUT_MS / 60_000} minutes`;
		const finalText = timedOut
			? result.finalText.trim()
				? `${timeoutText}\n\nLast output:\n${result.finalText}`
				: timeoutText
			: result.contextLengthExceeded
				? "Error: context length exceeded"
				: result.aborted && !result.finalText.trim()
					? "Background task was aborted"
					: result.finalText;
		const outcome = resolveBackgroundCompletionOutcome({
			timedOut,
			hasError: result.hasError,
			contextLengthExceeded: result.contextLengthExceeded,
			aborted: result.aborted,
		});
		const hasError = outcome !== "completed";

		if (await isBackgroundTaskCancelled(narratorId)) return;

		// Background takeover: the loop was interrupted by a user takeover. Do not
		// finalize/notify as completed/failed — transition to the idle takeover
		// state so the user can operate the subagent directly.
		if (isBackgroundTakenOver(narratorId)) {
			await transitionBackgroundTakenOverToIdle(narratorId, parentNarratorId, toolUseId);
			return;
		}

		// Finalize the subagent narrator status
		await finalizeSubagent(
			narratorId,
			parentNarratorId,
			toolUseId,
			hasError,
			hasError ? finalText : null,
		);

		await finalizeBackgroundCompletion(
			narratorId,
			parentNarratorId,
			toolUseId,
			outcome,
			finalText,
			locale as Locale,
		);
	} catch (err) {
		if (await isBackgroundTaskCancelled(narratorId)) return;

		// Background takeover during execution — same as above.
		if (isBackgroundTakenOver(narratorId)) {
			await transitionBackgroundTakenOverToIdle(narratorId, parentNarratorId, toolUseId);
			return;
		}

		const caughtError = err instanceof Error ? err.message : String(err);
		const errorText = timedOut
			? `Background task timed out after ${BACKGROUND_TASK_TIMEOUT_MS / 60_000} minutes`
			: caughtError;
		logger.error("Background task execution failed", {
			narratorId,
			error: errorText,
			timedOut,
		});

		await finalizeSubagent(narratorId, parentNarratorId, toolUseId, true, errorText);
		await finalizeBackgroundCompletion(
			narratorId,
			parentNarratorId,
			toolUseId,
			timedOut ? "timeout" : "failed",
			errorText,
			locale as Locale,
		);
	} finally {
		clearTimeout(timeoutId);
		getBackgroundAbortControllers().delete(narratorId);

		// Resolve attach waiter if any (legacy attach path for a run_in_background task)
		const attachWaiter = getAttachWaitersMap().get(narratorId);
		if (attachWaiter) {
			// Determine final result — on success path use the outer scope vars,
			// on catch path the DB was already updated so read from there.
			const nar = await narratorService.getById(narratorId).catch(() => null);
			const status = nar?.backgroundStatus ?? "failed";
			const result = nar?.backgroundResult ?? "(no output)";
			attachWaiter.resolve({
				finalText: result,
				hasError: status === "failed",
			});
			getAttachWaitersMap().delete(narratorId);
		}
	}
}

/**
 * Cancel a running background task.
 * Returns true if the task was found and cancelled.
 */
export async function cancelBackgroundTask(taskNarratorId: string): Promise<boolean> {
	const ctrl = getBackgroundAbortControllers().get(taskNarratorId);
	if (!ctrl) return false;

	ctrl.abort("Cancelled by user");

	const narrator = await narratorService.getById(taskNarratorId);
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({
			backgroundStatus: "cancelled",
			backgroundCompletedAt: now,
			updatedAt: now,
		})
		.where(eq(narrators.id, taskNarratorId));
	await narratorService.updateStatus(taskNarratorId, "idle", {
		substatus: ["interrupted"],
		skipErrorMessage: true,
	});

	const parentNarratorId = narrator.parentNarratorId;
	if (parentNarratorId) {
		eventBus.emit({
			type: "narrator:background_task_cancelled",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId,
			toolUseId: "",
		});
		broadcastToNarrator(parentNarratorId, {
			type: "background_task_cancelled",
			narratorId: parentNarratorId,
			taskNarratorId,
			toolUseId: "",
		});
	}

	getBackgroundAbortControllers().delete(taskNarratorId);
	await backgroundTaskService.markCancelled(taskNarratorId).catch(() => {});
	return true;
}

/**
 * Get the status of a background task.
 */
export async function getBackgroundTaskStatus(taskNarratorId: string): Promise<{
	status: string;
	result: string | null;
	completedAt: string | null;
	isRunning: boolean;
} | null> {
	const narrator = await narratorService.getById(taskNarratorId);
	if (!hasTrait(parseTraits(narrator.traits), "background")) return null;

	return {
		status: narrator.backgroundStatus ?? "unknown",
		result: narrator.backgroundResult ?? null,
		completedAt: narrator.backgroundCompletedAt ?? null,
		isRunning: getBackgroundAbortControllers().has(taskNarratorId),
	};
}

/**
 * Wait for a background task to complete (with timeout).
 * Returns the task status when done or when timeout expires.
 * An optional signal ends the wait early with status "aborted" when it fires
 * (used by Await to support extendable timeouts and parent interrupts).
 */
export function waitForBackgroundTask(
	taskNarratorId: string,
	timeoutMs = 30000,
	signal?: AbortSignal,
): Promise<{ status: string; result: string | null }> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			cleanup();
			resolve({ status: "running", result: null });
		}, timeoutMs);

		const WATCHED_EVENTS = new Set([
			"narrator:background_task_completed",
			"narrator:background_task_failed",
			"narrator:background_task_cancelled",
		]);

		const handler = (event: import("../lib/event-bus").NarraForkEvent) => {
			if (!WATCHED_EVENTS.has(event.type)) return;
			if (!("taskNarratorId" in event) || event.taskNarratorId !== taskNarratorId) return;
			cleanup();
			getBackgroundTaskStatus(taskNarratorId).then((s) => {
				resolve({ status: s?.status ?? "unknown", result: s?.result ?? null });
			});
		};

		const onAbort = () => {
			cleanup();
			resolve({ status: "aborted", result: null });
		};

		const cleanup = () => {
			clearTimeout(timeout);
			eventBus.offAny(handler);
			signal?.removeEventListener("abort", onAbort);
		};

		if (signal?.aborted) {
			clearTimeout(timeout);
			resolve({ status: "aborted", result: null });
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		// Check if already completed
		getBackgroundTaskStatus(taskNarratorId).then((s) => {
			if (s && s.status !== "running") {
				cleanup();
				resolve({ status: s.status, result: s.result });
				return;
			}
			eventBus.onAny(handler);
		});
	});
}

// === Foreground subagent execution loop ===

interface ForegroundLoopInput {
	subagentId: string;
	parentNarratorId: string;
	toolUseId: string;
	subagentType: string;
	prompt: string;
	cwd: string;
	model: string;
	provider: string;
	locale: string;
	signal: AbortSignal;
	userId?: string | null;
	systemPrompt: string;
	initialHistory: unknown[];
	initialTrailingToolResults?: unknown[];
	customDef: Awaited<ReturnType<typeof customSubagentService.loadByName>> | null;
	rebuildSystemPrompt?: (contextSummary?: string | null) => Promise<string>;
}

export interface ForegroundRunTerminal {
	runId: string;
	output: string;
	finalText: string;
	hasError: boolean;
	interrupted: boolean;
}

export type ForegroundRunPublication =
	| { kind: "handoff"; runId: string; output: string }
	| ({ kind: "terminal" } & ForegroundRunTerminal);

export interface ForegroundRunHandle {
	runId: string;
	/** Settles on detach handoff or terminal completion, whichever is published first. */
	foreground: Promise<ForegroundRunPublication>;
	/** Settles only after the underlying runner truly reaches a terminal state. */
	terminal: Promise<ForegroundRunTerminal>;
}

/**
 * Start the shared foreground execution loop for initial and resumed subagent runs.
 * The foreground publication and terminal completion are deliberately separate:
 * detach may hand control back to the parent without pretending the run finished.
 */
export function startForegroundRun(input: ForegroundLoopInput): ForegroundRunHandle {
	const {
		subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
		cwd,
		model,
		provider,
		locale,
		signal,
		systemPrompt,
		customDef,
		rebuildSystemPrompt,
	} = input;

	let finalText = "";
	let hasError = false;
	let wasInterrupted = false;
	let currentPrompt = input.prompt;
	let currentHistory: unknown[] = input.initialHistory;
	let currentTrailingToolResults: unknown[] | undefined = input.initialTrailingToolResults;
	let currentUserId = input.userId ?? null;
	let currentModel = model;
	let currentProvider = provider;
	let currentSystemPrompt = systemPrompt;

	const runId = generateId();
	const { promise: foregroundPromise, resolve: resolveForeground } =
		Promise.withResolvers<ForegroundRunPublication>();
	const { promise: terminalPromise, resolve: resolveTerminal } =
		Promise.withResolvers<ForegroundRunTerminal>();
	let foregroundPublished = false;
	let terminalPublished = false;
	const publishHandoff = (output: string): boolean => {
		if (foregroundPublished) return false;
		foregroundPublished = true;
		resolveForeground({ kind: "handoff", runId, output });
		return true;
	};
	const publishTerminal = (terminal: Omit<ForegroundRunTerminal, "runId">): boolean => {
		if (terminalPublished) return false;
		terminalPublished = true;
		const publication: ForegroundRunTerminal = { runId, ...terminal };
		resolveTerminal(publication);
		if (!foregroundPublished) {
			foregroundPublished = true;
			resolveForeground({ kind: "terminal", ...publication });
		}
		return true;
	};

	// Track whether we've been detached (set by detachSubagent) and wait for setup if needed.
	let detached = false;
	let detachReadyPromise: Promise<DetachSetupResult> | undefined;

	const suspendForUserControl = async (substatus: string[]) => {
		await narratorService.updateStatus(subagentId, "idle", { substatus });
		broadcastToNarrator(parentNarratorId, {
			type: "subagent_suspended",
			narratorId: parentNarratorId,
			subagentNarratorId: subagentId,
			toolUseId,
		});
		broadcastToNarrator(subagentId, {
			type: "status_change",
			narratorId: subagentId,
			status: "idle",
			substatus,
		});
		return waitForManualOverride(subagentId, signal, parentNarratorId, toolUseId);
	};

	const applyControlResult = async (
		result: Awaited<ReturnType<typeof waitForManualOverride>>,
	): Promise<"resume" | "finish"> => {
		if (result.action === "resume") {
			currentPrompt = result.prompt;
			currentHistory = result.history;
			currentTrailingToolResults = result.trailingToolResults;
			currentUserId = result.userId ?? null;
			const fresh = await narratorService.getById(subagentId);
			currentModel = resolveEffectiveModel(fresh.model);
			currentProvider = resolveProvider(currentModel);
			if (rebuildSystemPrompt) {
				currentSystemPrompt = await rebuildSystemPrompt(fresh.contextSummary);
			}
			finalText = "";
			hasError = false;
			await narratorService.updateStatus(subagentId, "working");
			broadcastSubagentStarted(subagentId, parentNarratorId, toolUseId, subagentType, currentModel);
			return "resume";
		}
		finalText = result.finalText;
		hasError = result.hasError;
		if (result.interrupted) {
			wasInterrupted = true;
			hasError = false;
		}
		return "finish";
	};

	const runLoop = async () => {
		const proxy = new ProxyAbortController();

		try {
			// Register detach entry so the API can detach this subagent
			getDetachableMap().set(subagentId, {
				runId,
				markDetached: (setup) => {
					detached = true;
					detachReadyPromise = setup;
				},
				publishHandoff,
				proxy,
				parentSignal: signal,
				fgAbort: new AbortController(), // placeholder, updated in loop
				toolUseId,
				parentNarratorId,
				subagentId,
			});

			while (true) {
				const fgAbort = new AbortController();
				getForegroundAbortControllers().set(subagentId, fgAbort);

				// Update detach entry's fgAbort reference
				const detachEntry = getDetachableMap().get(subagentId);
				if (detachEntry) detachEntry.fgAbort = fgAbort;

				// Use proxy instead of AbortSignal.any
				proxy.dispose();
				proxy.listenTo(signal, fgAbort.signal);

				const result = await executeSubagent({
					narratorId: subagentId,
					parentNarratorId,
					toolUseId,
					subagentType,
					prompt: currentPrompt,
					cwd,
					model: currentModel,
					provider: currentProvider,
					locale,
					signal: proxy.signal,
					userId: currentUserId,
					systemPrompt: currentSystemPrompt,
					initialHistory: currentHistory,
					initialTrailingToolResults: currentTrailingToolResults,
					customDef,
					rebuildSystemPrompt,
				});
				finalText = result.contextLengthExceeded
					? "Error: context length exceeded"
					: result.finalText;
				hasError = result.hasError || !!result.contextLengthExceeded;
				if (result.aborted && signal.aborted) {
					wasInterrupted = true;
					finalText = "Subagent interrupted because parent narrator was interrupted";
					hasError = false;
				}
				getForegroundAbortControllers().delete(subagentId);

				const hardSubagentInterrupt = consumeForegroundSubagentHardInterrupt(subagentId);

				// Check if we were detached during execution
				if (detached) {
					// Loop continues running in background mode.
					// The foreground handoff was already published by detachSubagent().
					// Continue to finally block for background completion.
					break;
				}

				if (hardSubagentInterrupt && fgAbort.signal.aborted && !signal.aborted) {
					wasInterrupted = true;
					finalText = "Subagent interrupted by user";
					hasError = false;
					break;
				}

				const continueAfterInterrupt =
					!hasError &&
					fgAbort.signal.aborted &&
					!signal.aborted &&
					(await consumeNextBufferedSubagentMessage({
						narratorId: subagentId,
						parentNarratorId,
						toolUseId,
						model: currentModel,
						provider: currentProvider,
						cwd,
					}));
				if (continueAfterInterrupt) {
					currentPrompt = continueAfterInterrupt.prompt;
					currentHistory = continueAfterInterrupt.history;
					currentTrailingToolResults = continueAfterInterrupt.trailingToolResults;
					currentUserId = continueAfterInterrupt.userId ?? null;
					finalText = "";
					continue;
				}
				// Detect subagent-only interrupt (not parent abort)
				if (!hasError && fgAbort.signal.aborted && !signal.aborted) {
					// --- Suspend: block until the user resolves (Update Conclusion)
					// or, for an explicit takeover, until the user stops takeover. ---
					// If this interrupt was triggered by a takeover request, mark the
					// subagent taken over and use the taken_over substatus so the
					// parent tool call stays running ("user is operating") instead of
					// showing a plain manual_override suspension.
					const isTakeover = consumePendingTakeover(subagentId);
					if (isTakeover) {
						markTakenOver(subagentId);
					}

					// The user may have already clicked "Stop takeover" during the
					// brief window between the takeover interrupt firing and the loop
					// reaching this suspension branch (the "settling" window). The
					// stop-takeover route records a pending marker instead of failing.
					// Consume it here: skip the manual-override wait entirely and let
					// the finalizer hand the current turn's result straight back to the
					// blocked parent. clearTakenOver must run before finalizeSubagent so
					// preserveTakenOverSubstatus does not re-inject the taken_over tag.
					if (isTakeover && consumePendingStopTakeover(subagentId)) {
						clearTakenOver(subagentId);
						break;
					}

					const control = await suspendForUserControl(
						isTakeover ? ["taken_over"] : ["manual_override"],
					);
					if ((await applyControlResult(control)) === "resume") continue;
					if (signal.aborted) {
						wasInterrupted = true;
						finalText = "Subagent interrupted because parent narrator was interrupted";
						hasError = false;
					}
				} else if (isTakenOver(subagentId) && !hasError && !signal.aborted) {
					// A takeover may span multiple normal turns. Keep the original
					// foreground runner alive and wait for another user command instead
					// of switching to the generic narrator-session engine.
					if (consumePendingStopTakeover(subagentId)) {
						clearTakenOver(subagentId);
						break;
					}
					const control = await suspendForUserControl(["taken_over"]);
					if ((await applyControlResult(control)) === "resume") continue;
					clearTakenOver(subagentId);
				} else if (consumePendingTakeover(subagentId) || isTakenOver(subagentId)) {
					// A takeover request that ends in an error cannot remain suspended.
					clearTakenOver(subagentId);
				}
				break;
			}
		} catch (err) {
			hasError = true;
			finalText = `Subagent error: ${err instanceof Error ? err.message : String(err)}`;
			logger.error("Foreground subagent loop failed", {
				subagentId,
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			const registeredDetach = getDetachableMap().get(subagentId);
			if (registeredDetach?.runId === runId) getDetachableMap().delete(subagentId);
			proxy.dispose();
			getForegroundAbortControllers().delete(subagentId);
			consumeForegroundSubagentHardInterrupt(subagentId);

			let detachSetupSucceeded = detached;
			if (detached) {
				if (!detachReadyPromise) {
					detachSetupSucceeded = false;
					logger.warn("Detached subagent setup promise missing", { subagentId });
				} else {
					try {
						await detachReadyPromise;
					} catch (err) {
						detachSetupSucceeded = false;
						logger.warn("Detached subagent setup failed before completion", {
							subagentId,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
			}

			try {
				await finalizeSubagent(
					subagentId,
					parentNarratorId,
					toolUseId,
					hasError,
					hasError ? finalText : null,
					{ interrupted: wasInterrupted },
				);

				// Bind the result to the subagent's last assistant message
				const resultMsgId = await getSubagentResultMessageId(subagentId);
				if (resultMsgId) {
					await db
						.update(narratorToolCalls)
						.set({ resultMessageId: resultMsgId })
						.where(eq(narratorToolCalls.toolUseId, toolUseId));
				}
			} catch {
				// Non-critical — don't fail the whole flow
			}
			await restorePendingSubagentModel(subagentId).catch((err) => {
				logger.warn("Failed to restore temporary subagent model", {
					subagentId,
					error: err instanceof Error ? err.message : String(err),
				});
			});

			if (detachSetupSucceeded) {
				try {
					// Background completion path — use shared helper
					try {
						await finalizeBackgroundCompletion(
							subagentId,
							parentNarratorId,
							toolUseId,
							hasError ? "failed" : "completed",
							finalText,
							locale as Locale,
						);
					} catch {
						// Non-critical
					}

					// Notify attach waiter if any (background → foreground transition)
					const attachWaiter = getAttachWaitersMap().get(subagentId);
					if (attachWaiter) {
						attachWaiter.resolve({ finalText, hasError });
						getAttachWaitersMap().delete(subagentId);
					}

					// Clean up team tracking
					clearTeamInbox(subagentId);
				} finally {
					getBackgroundAbortControllers().delete(subagentId);
					backgroundTaskService.unregisterAbortController(subagentId);
				}
			}

			const resultPrefix = `<subagent_id>${subagentId}</subagent_id>\n\n`;
			publishTerminal({
				output: resultPrefix + (finalText || "(no output)"),
				finalText: finalText || "(no output)",
				hasError,
				interrupted: wasInterrupted,
			});
		}
	};

	// Start the loop without awaiting: foreground may publish a detach handoff first,
	// while terminal remains pending until all finalization is complete.
	runLoop().catch((err) => {
		const finalText = `Subagent error: ${err instanceof Error ? err.message : String(err)}`;
		publishTerminal({
			output: `<subagent_id>${subagentId}</subagent_id>\n\n${finalText}`,
			finalText,
			hasError: true,
			interrupted: false,
		});
	});

	return { runId, foreground: foregroundPromise, terminal: terminalPromise };
}

/** Compatibility wrapper that preserves the legacy model-tool text boundary. */
export async function runForegroundLoop(input: ForegroundLoopInput): Promise<string> {
	return (await startForegroundRun(input).foreground).output;
}

// === Subagent runner ===

export interface RunSubagentInput {
	parentNarratorId: string;
	toolUseId: string;
	subagentType: string;
	prompt: string;
	cwd: string;
	title?: string;
	signal: AbortSignal;
	locale: string;
	model?: string;
	reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
	background?: boolean;
	alias?: string;
}

/**
 * Run a subagent synchronously (from the parent narrator's perspective),
 * or in background mode (fire-and-forget, returns immediately with a task ID).
 *
 * Creates a subagent narrator, runs the agent loop, persists all messages,
 * and returns the final text result.
 */
export async function runSubagent(input: RunSubagentInput): Promise<string> {
	const {
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt,
		cwd,
		title,
		signal,
		locale,
		model: explicitModel,
		reasoningEffort,
		background,
		alias,
	} = input;

	// Load custom subagent definition once for non-builtin types
	const isBuiltin =
		subagentType === "explore" ||
		subagentType === "plan" ||
		subagentType === "search" ||
		subagentType === "general";
	const customDef = isBuiltin ? null : await customSubagentService.loadByName(subagentType);

	const rebuildSystemPrompt = (contextSummary?: string | null) =>
		buildSubagentSystemPrompt(
			subagentType,
			cwd,
			locale as Locale,
			contextSummary,
			customDef?.prompt,
			// Only background subagents can report progress to the parent; a
			// foreground subagent blocks the parent until it finishes.
			background ?? false,
		);
	const systemPrompt = await rebuildSystemPrompt();

	// Resolve model: explicit param > per-type setting / custom default > parent model > global default
	let subagentPref: string | undefined;
	if (subagentType === "explore" || subagentType === "plan" || subagentType === "search") {
		subagentPref = settings.agent.subagentModels?.[subagentType] || undefined;
	} else if (customDef) {
		subagentPref = customDef.defaultModel || undefined;
	}

	// Apply effective per-narrator subagent model policy. Custom narrator traits override
	// global settings.agent.subagentAllowedModels.
	const parent = await narratorService.getById(parentNarratorId);
	const modelPolicy = resolveEffectiveSubagentModelPolicy(parent.traits, subagentType);
	const candidateModels = [
		subagentPref,
		parent.model ?? FOLLOW_DEFAULT_MODEL,
		settings.agent.defaultModel,
	];
	const resolvedModelInput = resolveSubagentModelFromPolicy({
		policy: modelPolicy,
		explicitModel,
		candidates: candidateModels,
	});
	if (modelPolicy.source !== "none" && !resolvedModelInput) {
		const allowedModels = expandAllowedPoolForDisplay(
			modelPolicy.models.map((entry) => entry.model),
		);
		throw new ValidationError(
			modelPolicy.isExplicitEmpty
				? `No models are allowed for "${modelPolicy.poolKey}" subagents by this narrator's custom trait.`
				: `No candidate model is in the allowed pool for "${modelPolicy.poolKey}" subagents. ` +
						`Allowed models: ${allowedModels.join(", ")}. Please specify one of these models explicitly.`,
		);
	}

	// 1. Create subagent narrator
	const inheritedTraits = parseTraits(parent.traits).filter(
		(trait) =>
			trait.startsWith(DISABLED_TOOLS_TRAIT_PREFIX) ||
			trait.startsWith(BLOCKED_SKILLS_TRAIT_PREFIX),
	);
	const subagent = await narratorService.createSubagent({
		parentNarratorId,
		subagentType,
		title,
		cwd,
		systemPrompt,
		model: resolvedModelInput,
		reasoningEffort,
		inheritedTraits,
	});

	const subagentId = subagent.id;
	const model = resolveEffectiveModel(subagent.model);
	const provider = resolveProvider(model);
	let aliasRegistration: { alias: string; conflicted: boolean };
	try {
		aliasRegistration = await registerAndPersistSubagentAlias(
			parentNarratorId,
			subagentId,
			alias || title,
		);
	} catch (err) {
		aliasRegistration = registerTaskAlias(parentNarratorId, subagentId, alias || title);
		logger.warn("Failed to persist subagent alias", {
			subagentId,
			alias: aliasRegistration.alias,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// 2. Persist subagent's user message (linked to parent's tool_use)
	await narratorService.persistSubagentUserMessage(subagentId, prompt, toolUseId);

	// Broadcast subagent_started after persist so the frontend only sees it
	// when the subagent record is fully consistent (narrator + user message).
	broadcastSubagentStarted(subagentId, parentNarratorId, toolUseId, subagentType, model);

	if (background) {
		// --- Background mode: fire-and-forget ---

		// Mark narrator and tool_call as background
		const now = new Date().toISOString();
		const subNarrator = await narratorService.getById(subagentId);
		const updatedTraits = [...new Set([...parseTraits(subNarrator.traits), "background"])];
		await db
			.update(narrators)
			.set({
				isBackground: true,
				backgroundStatus: "running",
				traits: updatedTraits,
				updatedAt: now,
			})
			.where(eq(narrators.id, subagentId));
		eventBus.emit({
			type: "narrator:background_task_started",
			narratorId: parentNarratorId,
			parentNarratorId,
			taskNarratorId: subagentId,
			toolUseId,
			subagentType,
		});
		broadcastToNarrator(parentNarratorId, {
			type: "background_task_started",
			narratorId: parentNarratorId,
			taskNarratorId: subagentId,
			toolUseId,
			subagentType,
		});

		// Create an independent AbortController for the background task
		// (parent's signal should not cancel background tasks)
		const bgAbort = new AbortController();

		// Store the abort controller for later cancellation
		getBackgroundAbortControllers().set(subagentId, bgAbort);
		backgroundTaskService.registerAbortController(subagentId, bgAbort);

		await backgroundTaskService
			.createAgentTask({
				id: subagentId,
				parentNarratorId,
				subagentNarratorId: subagentId,
				subagentType,
				toolUseId,
				alias: aliasRegistration.alias,
				title,
			})
			.catch((err) => {
				logger.warn("Failed to register background task in DB", {
					narratorId: subagentId,
					error: err instanceof Error ? err.message : String(err),
				});
			});

		// Fire-and-forget execution
		executeBackgroundTask({
			narratorId: subagentId,
			parentNarratorId,
			toolUseId,
			subagentType,
			prompt,
			cwd,
			model,
			provider,
			locale,
			signal: bgAbort.signal,
			systemPrompt,
			initialHistory: [],
			customDef,
			rebuildSystemPrompt,
		}).catch((err) => {
			logger.error("Background task unexpected error", {
				subagentId,
				error: err instanceof Error ? err.message : String(err),
			});
		});

		const resultPrefix = `<background_task_id>${subagentId}</background_task_id>\n\n`;
		let output =
			resultPrefix +
			'Background task started. Use Await({ type: "agent", id }) with this ID to get results, or Send({ id, message }) to continue.';
		if (aliasRegistration.conflicted) {
			output +=
				`\n\nNote: The requested alias "${alias || title}" was already taken. ` +
				`This agent was assigned "${aliasRegistration.alias}" instead.`;
		}
		return output;
	}

	// --- Foreground mode ---

	let output = await runForegroundLoop({
		subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt,
		cwd,
		model,
		provider,
		locale,
		signal,
		systemPrompt,
		initialHistory: [],
		customDef,
		rebuildSystemPrompt,
	});
	if (aliasRegistration.conflicted) {
		const requestedAliasLabel = alias || title || subagentId;
		output +=
			`\n\nNote: The requested alias "${requestedAliasLabel}" was already taken. ` +
			`This agent was assigned "${aliasRegistration.alias}" instead. ` +
			`Use this alias with Await or Send to reference this agent.`;
	}
	return output;
}

// === Continue subagent ===

export interface ContinueSubagentInput {
	subagentId: string;
	parentNarratorId: string;
	/** Stable tool call that originally created this subagent. */
	toolUseId: string;
	prompt?: string;
	images?: ImageRef[];
	textFiles?: File[];
	commandText?: string | null;
	createdBy?: string | null;
	userId?: string | null;
	canReportToParent?: boolean;
	signal: AbortSignal;
	locale: string;
	/** Skip user-message persistence for retry/tool-result continuation. */
	persistPrompt?: boolean;
	/** Prebuilt history for retry/tool-result continuation. */
	initialHistory?: unknown[];
	initialTrailingToolResults?: unknown[];
}

export interface StartedSubagentContinuation {
	runId: string;
	/** Legacy foreground boundary: may settle with a detach handoff. */
	completion: Promise<string>;
	/** True terminal boundary: never settles for a detach handoff. */
	terminalCompletion: Promise<string>;
	userMessage?: Awaited<ReturnType<typeof narratorService.persistSubagentUserMessage>>;
}

/**
 * Continue a previously completed/errored subagent in-place.
 *
 * Instead of forking, we directly continue the original subagent narrator:
 * persist a new user message (with the caller toolUseId as parentToolUseId),
 * reload the full history, and run the agent loop.
 * The subagent keeps its single narrator record and accumulates a
 * continuous conversation visible on the subagent page.
 */
export async function startContinuedSubagent(
	input: ContinueSubagentInput,
): Promise<StartedSubagentContinuation> {
	const { subagentId, parentNarratorId, toolUseId, prompt, signal, locale } = input;

	// 1. Validate original subagent
	const original = await narratorService.getById(subagentId);
	if (!isSubagentVariant(original.variant)) {
		throw new ValidationError("Target narrator is not a subagent");
	}
	if (original.parentNarratorId !== parentNarratorId) {
		throw new ValidationError("Subagent does not belong to the calling narrator");
	}

	// --- Attach path for a RUNNING background task (legacy pull-to-foreground path) ---
	if (original.isBackground && original.backgroundStatus === "running") {
		const completion = attachSubagent(subagentId, parentNarratorId, toolUseId, signal);
		return { runId: generateId(), completion, terminalCompletion: completion };
	}

	// --- Return completed background task result directly when Await requests status only ---
	if (
		!prompt &&
		input.persistPrompt !== false &&
		original.isBackground &&
		(original.backgroundStatus === "completed" || original.backgroundStatus === "failed")
	) {
		const resultPrefix = `<subagent_id>${subagentId}</subagent_id>\n\n`;
		const completion = Promise.resolve(resultPrefix + (original.backgroundResult ?? "(no output)"));
		return { runId: generateId(), completion, terminalCompletion: completion };
	}

	// --- Standard continue path: idle subagent ---
	if (input.persistPrompt !== false && prompt === undefined) {
		throw new ValidationError("prompt is required to continue an idle subagent");
	}
	// Any idle subagent is "settled and ready to resume" — regardless of whether
	// its result was already read (the transient unread/error/interrupted tags are
	// not preconditions for continuing). archived/working/waiting and taken-over
	// subagents are handled upstream (agent-communication) before reaching here;
	// reject them defensively for any other direct caller. The stale substatus
	// tags are cleared by updateStatus("working") below.
	if (original.status !== "idle") {
		throw new ValidationError(`Cannot continue subagent in status "${original.status}"`);
	}

	const subagentType = getSubagentType(original.variant) ?? original.subagentType ?? "general";
	const model = resolveEffectiveModel(original.model);
	const provider = resolveProvider(model);
	const cwd = original.cwd ?? ".";

	// Load custom subagent definition once for non-builtin types
	const isBuiltinContinue =
		subagentType === "explore" || subagentType === "plan" || subagentType === "general";
	const customDef = isBuiltinContinue ? null : await customSubagentService.loadByName(subagentType);
	const rebuildSystemPrompt = (contextSummary?: string | null) =>
		buildSubagentSystemPrompt(
			subagentType,
			cwd,
			locale as Locale,
			contextSummary,
			customDef?.prompt,
			// Parent-agent Send continuations run asynchronously and may reply through
			// Send({ id: "parent" }); user/manual-override continuations keep the
			// original foreground semantics.
			input.canReportToParent ?? false,
		);
	const systemPrompt = await rebuildSystemPrompt(original.contextSummary);

	// 2. Mark subagent as working (in-place, no fork)
	if (original.isBackground) {
		const now = new Date().toISOString();
		const updatedTraits = parseTraits(original.traits).filter((trait) => trait !== "background");
		await db
			.update(narrators)
			.set({
				isBackground: false,
				backgroundStatus: null,
				backgroundResult: null,
				backgroundCompletedAt: null,
				traits: updatedTraits,
				updatedAt: now,
			})
			.where(eq(narrators.id, subagentId));
	}
	await narratorService.updateStatus(subagentId, "working");

	// 3. Persist the follow-up before broadcasting/starting so the narrator and
	// parent card always observe a consistent linked transcript.
	let userMessage: StartedSubagentContinuation["userMessage"];
	if (input.persistPrompt !== false) {
		const savedTextFiles: TextFileRef[] = [];
		for (const file of input.textFiles ?? []) {
			savedTextFiles.push(await saveTextFileToWorktree(cwd, file));
		}
		userMessage = await narratorService.persistSubagentUserMessage(
			subagentId,
			prompt ?? "",
			toolUseId,
			{
				images: input.images,
				textFiles: savedTextFiles,
				commandText: input.commandText,
				createdBy: input.createdBy,
			},
		);
	}

	// 4. Broadcast subagent_started (same subagentId)
	broadcastSubagentStarted(subagentId, parentNarratorId, toolUseId, subagentType, model);

	// 5. Load full subagent history unless the resume service already prepared it.
	const rebuilt =
		input.initialHistory && input.initialTrailingToolResults
			? {
					history: input.initialHistory,
					trailingToolResults: input.initialTrailingToolResults,
				}
			: await loadSubagentHistory(subagentId, model, provider);

	// 6. Run via the structured foreground handle (same subagentId).
	const run = startForegroundRun({
		subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt: prompt ?? "",
		cwd,
		model,
		provider,
		locale,
		signal,
		userId: input.userId ?? input.createdBy ?? null,
		systemPrompt,
		initialHistory: rebuilt.history,
		initialTrailingToolResults: rebuilt.trailingToolResults,
		customDef,
		rebuildSystemPrompt,
	});
	return {
		runId: run.runId,
		completion: run.foreground.then((publication) => publication.output),
		terminalCompletion: run.terminal.then((terminal) => terminal.output),
		userMessage,
	};
}
