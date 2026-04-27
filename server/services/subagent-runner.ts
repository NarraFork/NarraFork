import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators, narratorToolCalls } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import {
	getSubagentType,
	hasTrait,
	isSubagentVariant,
	parseSubstatus,
	parseTraits,
} from "../lib/narrator-utils";
import type { Locale } from "../lib/prompt-i18n";
import { resolveEffectiveModel, resolveProvider, settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { backgroundTaskService } from "./background-task-service";
import { pushBgCompletionNotification } from "./bg-completion-queue";
import { customSubagentService } from "./custom-subagent-service";
import { narratorService } from "./narrator-service";
import { getSubagentResultMessageId } from "./narrator-session";
import {
	attachSubagent,
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
import { getManualOverrideMap, waitForManualOverride } from "./subagent-manual-override";
import { clearTeamInbox } from "./subagent-team";
import { buildSubagentSystemPrompt } from "./subagent-tools";

/** Maximum background task execution time (30 minutes). */
export const BACKGROUND_TASK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Shared helper: update narrator background fields, emit events, broadcast WS,
 * push notification, and mark in backgroundTaskService.
 * Used by both executeBackgroundTask and runForegroundLoop (detach path).
 */
async function finalizeBackgroundCompletion(
	narratorId: string,
	parentNarratorId: string,
	toolUseId: string,
	hasError: boolean,
	finalText: string,
): Promise<void> {
	const task = await backgroundTaskService.getById(narratorId).catch(() => null);
	if (task) {
		const transitioned = hasError
			? await backgroundTaskService.markFailed(narratorId, finalText || "Unknown error")
			: await backgroundTaskService.markCompleted(narratorId, finalText || "(no output)");
		if (!transitioned) return;
	}

	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({
			backgroundStatus: hasError ? "failed" : "completed",
			backgroundResult: finalText || "(no output)",
			backgroundCompletedAt: now,
			updatedAt: now,
		})
		.where(eq(narrators.id, narratorId));

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
		if (!task) {
			broadcastToNarrator(parentNarratorId, {
				type: "background_task_failed",
				narratorId: parentNarratorId,
				taskNarratorId: narratorId,
				toolUseId,
				error: finalText,
			});
		}
		pushBgCompletionNotification(parentNarratorId, {
			id: narratorId,
			title,
			status: "failed",
			resultPreview,
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
		});
	}
}

async function isBackgroundTaskCancelled(taskId: string): Promise<boolean> {
	const task = await backgroundTaskService.getById(taskId).catch(() => null);
	return task?.status === "cancelled";
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
	const { narratorId, parentNarratorId, toolUseId } = opts;

	// Set a maximum execution timeout
	const timeoutId = setTimeout(() => {
		const ctrl = getBackgroundAbortControllers().get(narratorId);
		if (ctrl) ctrl.abort("Background task timeout");
	}, BACKGROUND_TASK_TIMEOUT_MS);

	// Register in unified background_tasks table
	await backgroundTaskService
		.createAgentTask({
			id: narratorId,
			parentNarratorId,
			subagentNarratorId: narratorId,
			subagentType: opts.subagentType,
			toolUseId,
		})
		.catch((err) => {
			logger.warn("Failed to register background task in DB", {
				narratorId,
				error: err instanceof Error ? err.message : String(err),
			});
		});

	try {
		const result = await executeSubagent(opts);

		const finalText = result.contextLengthExceeded
			? "Error: context length exceeded"
			: result.finalText;
		const hasError = result.hasError || !!result.contextLengthExceeded;

		if (await isBackgroundTaskCancelled(narratorId)) return;

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
			hasError,
			finalText,
		);
	} catch (err) {
		if (await isBackgroundTaskCancelled(narratorId)) return;

		const errorText = err instanceof Error ? err.message : String(err);
		logger.error("Background task execution failed", { narratorId, error: errorText });

		await finalizeSubagent(narratorId, parentNarratorId, toolUseId, true, errorText);
		await finalizeBackgroundCompletion(narratorId, parentNarratorId, toolUseId, true, errorText);
	} finally {
		clearTimeout(timeoutId);
		getBackgroundAbortControllers().delete(narratorId);

		// Resolve attach waiter if any (Agent(resume) on a run_in_background task)
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
			status: "idle",
			substatus: JSON.stringify(["interrupted"]),
			updatedAt: now,
		})
		.where(eq(narrators.id, taskNarratorId));

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
 */
export function waitForBackgroundTask(
	taskNarratorId: string,
	timeoutMs = 30000,
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

		const cleanup = () => {
			clearTimeout(timeout);
			eventBus.offAny(handler);
		};

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
	systemPrompt: string;
	initialHistory: unknown[];
	initialTrailingToolResults?: unknown[];
	customDef: Awaited<ReturnType<typeof customSubagentService.loadByName>> | null;
	rebuildSystemPrompt?: (contextSummary?: string | null) => Promise<string>;
}

/**
 * Shared foreground execution loop for both runSubagent and continueSubagent.
 * Handles the while-loop, buffered message consumption, and manual override.
 * Returns the subagent_id-prefixed result string.
 */
export async function runForegroundLoop(input: ForegroundLoopInput): Promise<string> {
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
	let currentPrompt = input.prompt;
	let currentHistory: unknown[] = input.initialHistory;
	let currentTrailingToolResults: unknown[] | undefined = input.initialTrailingToolResults;

	// Wrap in a Promise so detach can resolve it early
	const { promise: foregroundPromise, resolve: foregroundResolve } =
		Promise.withResolvers<string>();

	// Track whether we've been detached (set by detachSubagent)
	let detached = false;

	const runLoop = async () => {
		const proxy = new ProxyAbortController();

		try {
			// Register detach entry so the API can detach this subagent
			getDetachableMap().set(subagentId, {
				markDetached: () => {
					detached = true;
				},
				foregroundResolve,
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
					model,
					provider,
					locale,
					signal: proxy.signal,
					systemPrompt,
					initialHistory: currentHistory,
					initialTrailingToolResults: currentTrailingToolResults,
					customDef,
					rebuildSystemPrompt,
				});
				finalText = result.contextLengthExceeded
					? "Error: context length exceeded"
					: result.finalText;
				hasError = result.hasError || !!result.contextLengthExceeded;
				getForegroundAbortControllers().delete(subagentId);

				// Check if we were detached during execution
				if (detached) {
					// Loop continues running in background mode.
					// foregroundResolve was already called by detachSubagent().
					// Continue to finally block for background completion.
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
						model,
						provider: resolveProvider(model),
					}));
				if (continueAfterInterrupt) {
					currentPrompt = continueAfterInterrupt.prompt;
					currentHistory = continueAfterInterrupt.history;
					currentTrailingToolResults = continueAfterInterrupt.trailingToolResults;
					finalText = "";
					continue;
				}
				// Detect subagent-only interrupt (not parent abort)
				if (!hasError && fgAbort.signal.aborted && !signal.aborted) {
					// --- Manual override: block until user clicks "Update Conclusion" ---
					await narratorService.updateStatus(subagentId, "idle", {
						substatus: ["manual_override"],
					});
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
						substatus: ["manual_override"],
					});

					const overrideResult = await waitForManualOverride(
						subagentId,
						signal,
						parentNarratorId,
						toolUseId,
					);

					finalText = overrideResult.finalText;
					hasError = overrideResult.hasError;
				}
				break;
			}
		} finally {
			getDetachableMap().delete(subagentId);
			proxy.dispose();
			getManualOverrideMap().delete(subagentId);
			getForegroundAbortControllers().delete(subagentId);

			try {
				await finalizeSubagent(
					subagentId,
					parentNarratorId,
					toolUseId,
					hasError,
					hasError ? finalText : null,
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

			if (detached) {
				// Background completion path — use shared helper
				try {
					await finalizeBackgroundCompletion(
						subagentId,
						parentNarratorId,
						toolUseId,
						hasError,
						finalText,
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
			} else {
				// Normal foreground completion
				const resultPrefix = `<subagent_id>${subagentId}</subagent_id>\n\n`;
				foregroundResolve(resultPrefix + (finalText || "(no output)"));
			}
		}
	};

	// Start the loop (don't await — foregroundPromise is resolved when done or detached).
	// Note: foregroundResolve may be called from multiple paths (detach, normal completion,
	// error catch below), but Promise.resolve is idempotent — only the first call takes effect.
	runLoop().catch((err) => {
		foregroundResolve(
			`<subagent_id>${subagentId}</subagent_id>\n\nSubagent error: ${err instanceof Error ? err.message : String(err)}`,
		);
	});

	return foregroundPromise;
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
	background?: boolean;
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
		background,
	} = input;

	// Load custom subagent definition once for non-builtin types
	const isBuiltin =
		subagentType === "explore" || subagentType === "plan" || subagentType === "general";
	const customDef = isBuiltin ? null : await customSubagentService.loadByName(subagentType);

	const rebuildSystemPrompt = (contextSummary?: string | null) =>
		buildSubagentSystemPrompt(
			subagentType,
			cwd,
			locale as Locale,
			contextSummary,
			customDef?.prompt,
		);
	const systemPrompt = await rebuildSystemPrompt();

	// Resolve model: explicit param > per-type setting / custom default > parent model > global default
	let subagentPref: string | undefined;
	if (subagentType === "explore" || subagentType === "plan") {
		subagentPref = settings.agent.subagentModels?.[subagentType] || undefined;
	} else if (customDef) {
		subagentPref = customDef.defaultModel || undefined;
	}

	// Apply per-type subagent allowed-model pool restriction.
	// When the pool is non-empty, only models in the pool may be used.
	// Walk the priority chain and pick the first allowed candidate.
	// Note: "review" and custom subagent types fall back to the "general" pool
	// since they don't have dedicated pool configurations.
	const poolKey =
		subagentType === "explore" || subagentType === "plan" || subagentType === "general"
			? subagentType
			: "general";
	const allowedPool = settings.agent.subagentAllowedModels?.[poolKey] ?? [];
	let resolvedModelInput: string | undefined;
	if (allowedPool.length > 0) {
		// Resolve sentinel values in the pool (e.g. "__default__" or bare "default")
		// to the actual default model so they can match real candidate model IDs.
		const poolSet = new Set(
			allowedPool.map((m) => resolveEffectiveModel(m === "default" ? null : m)),
		);
		const parent = await narratorService.getById(parentNarratorId);
		// Resolve __default__ sentinel to the actual default model so it can match the pool.
		const parentModel = parent.model ? resolveEffectiveModel(parent.model) : undefined;
		const candidates = [
			explicitModel,
			subagentPref,
			parentModel,
			settings.agent.defaultModel,
		].filter((m): m is string => !!m);
		resolvedModelInput = candidates.find((m) => poolSet.has(m));
		if (!resolvedModelInput) {
			throw new ValidationError(
				`No candidate model is in the allowed pool for "${poolKey}" subagents. ` +
					`Allowed models: ${[...poolSet].join(", ")}. ` +
					`Please specify one of these models explicitly.`,
			);
		}
	} else {
		resolvedModelInput = explicitModel || subagentPref || undefined;
	}

	// 1. Create subagent narrator
	const subagent = await narratorService.createSubagent({
		parentNarratorId,
		subagentType,
		title,
		cwd,
		systemPrompt,
		model: resolvedModelInput,
	});

	const subagentId = subagent.id;
	const model = subagent.model ?? settings.agent.defaultModel;
	const provider = resolveProvider(model);

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
		return (
			resultPrefix +
			"Background task started. Use Agent(resume) with this ID to attach and get results."
		);
	}

	// --- Foreground mode ---

	return runForegroundLoop({
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
}

// === Continue subagent ===

export interface ContinueSubagentInput {
	subagentId: string;
	parentNarratorId: string;
	toolUseId: string;
	prompt?: string;
	signal: AbortSignal;
	locale: string;
}

/**
 * Continue a previously completed/errored subagent in-place.
 *
 * Instead of forking, we directly resume the original subagent narrator:
 * persist a new user message (with the ContinueTask's toolUseId as
 * parentToolUseId), reload the full history, and run the agent loop.
 * The subagent keeps its single narrator record and accumulates a
 * continuous conversation visible on the subagent page.
 */
export async function continueSubagent(input: ContinueSubagentInput): Promise<string> {
	const { subagentId, parentNarratorId, toolUseId, prompt, signal, locale } = input;

	// 1. Validate original subagent
	const original = await narratorService.getById(subagentId);
	if (!isSubagentVariant(original.variant)) {
		throw new ValidationError("Target narrator is not a subagent");
	}
	if (original.parentNarratorId !== parentNarratorId) {
		throw new ValidationError("Subagent does not belong to the calling narrator");
	}

	// --- Attach path: resume a RUNNING background task (pull to foreground) ---
	if (original.isBackground && original.backgroundStatus === "running") {
		return attachSubagent(subagentId, parentNarratorId, toolUseId, signal);
	}

	// --- Return completed background task result directly ---
	if (
		original.isBackground &&
		(original.backgroundStatus === "completed" || original.backgroundStatus === "failed")
	) {
		const resultPrefix = `<subagent_id>${subagentId}</subagent_id>\n\n`;
		return resultPrefix + (original.backgroundResult ?? "(no output)");
	}

	// --- Standard continue path: idle subagent ---
	if (!prompt) {
		throw new ValidationError("prompt is required to continue an idle subagent");
	}
	const origSubstatus = parseSubstatus(original.substatus);
	if (
		!(
			original.status === "idle" &&
			(origSubstatus.includes("unread") || origSubstatus.includes("error"))
		)
	) {
		throw new ValidationError(`Cannot continue subagent in status "${original.status}"`);
	}

	const subagentType = getSubagentType(original.variant) ?? original.subagentType ?? "general";
	const model = original.model ?? settings.agent.defaultModel;
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
		);
	const systemPrompt = await rebuildSystemPrompt(original.contextSummary);

	// 2. Mark subagent as working (in-place, no fork)
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({ status: "working", substatus: "[]", errorMessage: null, updatedAt: now })
		.where(eq(narrators.id, subagentId));

	// 3. Broadcast subagent_started (same subagentId)
	broadcastSubagentStarted(subagentId, parentNarratorId, toolUseId, subagentType, model);

	// 4. Persist new user message with ContinueTask's toolUseId
	await narratorService.persistSubagentUserMessage(subagentId, prompt, toolUseId);

	// 5. Load full subagent history (all previous rounds included)
	const { history, trailingToolResults } = await loadSubagentHistory(subagentId, model, provider);

	// 6. Run via shared foreground loop (same subagentId)
	return runForegroundLoop({
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
		initialHistory: history,
		initialTrailingToolResults: trailingToolResults,
		customDef,
		rebuildSystemPrompt,
	});
}
