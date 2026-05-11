import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators, narratorToolCalls } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import {
	DISABLED_TOOLS_TRAIT_PREFIX,
	resolveEffectiveSubagentModelPolicy,
	resolveSubagentModelFromPolicy,
} from "../lib/narrator-custom-traits";
import {
	getSubagentType,
	hasTrait,
	isSubagentVariant,
	parseSubstatus,
	parseTraits,
} from "../lib/narrator-utils";
import type { Locale } from "../lib/prompt-i18n";
import {
	FOLLOW_DEFAULT_MODEL,
	resolveEffectiveModel,
	resolveProvider,
	settings,
} from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { backgroundTaskService } from "./background-task-service";
import { pushBgCompletionNotification } from "./bg-completion-queue";
import { customSubagentService } from "./custom-subagent-service";
import { narratorService } from "./narrator-service";
import { getSubagentResultMessageId } from "./narrator-session";
import { registerAndPersistSubagentAlias, registerTaskAlias } from "./subagent-alias";
import {
	attachSubagent,
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
	let wasInterrupted = false;
	let currentPrompt = input.prompt;
	let currentHistory: unknown[] = input.initialHistory;
	let currentTrailingToolResults: unknown[] | undefined = input.initialTrailingToolResults;

	// Wrap in a Promise so detach can resolve it early
	const { promise: foregroundPromise, resolve: foregroundResolve } =
		Promise.withResolvers<string>();

	// Track whether we've been detached (set by detachSubagent) and wait for setup if needed.
	let detached = false;
	let detachReadyPromise: Promise<DetachSetupResult> | undefined;

	const runLoop = async () => {
		const proxy = new ProxyAbortController();

		try {
			// Register detach entry so the API can detach this subagent
			getDetachableMap().set(subagentId, {
				markDetached: (setup) => {
					detached = true;
					detachReadyPromise = setup;
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
				if (result.aborted && signal.aborted) {
					wasInterrupted = true;
					finalText = "Subagent interrupted because parent narrator was interrupted";
					hasError = false;
				}
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
					if (signal.aborted) {
						wasInterrupted = true;
						finalText = "Subagent interrupted because parent narrator was interrupted";
						hasError = false;
					}
				}
				break;
			}
		} finally {
			getDetachableMap().delete(subagentId);
			proxy.dispose();
			getManualOverrideMap().delete(subagentId);
			getForegroundAbortControllers().delete(subagentId);

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

			if (detachSetupSucceeded) {
				try {
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
				} finally {
					getBackgroundAbortControllers().delete(subagentId);
					backgroundTaskService.unregisterAbortController(subagentId);
				}
			} else {
				// Normal foreground completion, or detach setup failed before background handoff finished.
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
	reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
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
		const allowedModels = modelPolicy.models.map((entry) => entry.model);
		throw new ValidationError(
			modelPolicy.isExplicitEmpty
				? `No models are allowed for "${modelPolicy.poolKey}" subagents by this narrator's custom trait.`
				: `No candidate model is in the allowed pool for "${modelPolicy.poolKey}" subagents. ` +
						`Allowed models: ${allowedModels.join(", ")}. Please specify one of these models explicitly.`,
		);
	}

	// 1. Create subagent narrator
	const inheritedTraits = parseTraits(parent.traits).filter((trait) =>
		trait.startsWith(DISABLED_TOOLS_TRAIT_PREFIX),
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
	toolUseId: string;
	prompt?: string;
	signal: AbortSignal;
	locale: string;
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

	// --- Attach path for a RUNNING background task (legacy pull-to-foreground path) ---
	if (original.isBackground && original.backgroundStatus === "running") {
		return attachSubagent(subagentId, parentNarratorId, toolUseId, signal);
	}

	// --- Return completed background task result directly when Await requests status only ---
	if (
		!prompt &&
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

	// 3. Broadcast subagent_started (same subagentId)
	broadcastSubagentStarted(subagentId, parentNarratorId, toolUseId, subagentType, model);

	// 4. Persist new user message with the caller toolUseId
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
