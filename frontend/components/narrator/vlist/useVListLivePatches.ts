/**
 * useVListLivePatches.ts — Subscribes the exact vlist to the LIVE LIFECYCLE
 * events the shell previously ignored, and applies them as coalesced in-place
 * document patches.
 *
 * The gap this closes
 * -------------------
 * The exact shell only listened for STRUCTURAL events (message added / edited /
 * deleted) and answered each with a full document refetch. But a tool call
 * finishing and a reflection gate resolving mutate an already-loaded message
 * without re-broadcasting it — and reflections do not even bump `messageVersion`.
 * With no subscription and no structural signal, a completed tool rendered as
 * "running" and a resolved reflection as "reflecting" indefinitely.
 *
 * Design
 * ------
 * - Every event is translated to a pure patch (vlist-live-events.ts) and pushed
 *   onto a queue drained once per animation frame. A turn that completes several
 *   tools at once therefore costs ONE document rebuild, not one per event.
 * - Nothing here refetches. The patch keeps `messageVersion` and the message
 *   count fixed, so the rebuild reuses every untouched card's cached measurement.
 * - Top-level `tool_use_chunk` / `tool_output` belong to the streaming tail.
 *   Reduced child chunks only merge their bounded activity header here; repeated
 *   headers are no-ops and never introduce top-level tools.
 *
 * Subagent routing follows the same rule as the chunked path: on a parent page a
 * child tool event only updates the parent card's activity summary, while on the
 * subagent's OWN page those same events are its top-level tools.
 */

import { useNarratorWS } from "@frontend/hooks/useNarratorWS";
import type { SubagentActivityCatchUp, TreeMessage } from "@frontend/lib/api";
import { messageBody } from "@shared/narrator-blocks/message-blocks";
import { MAX_SUBAGENT_RESULT_TEXT_CHARS } from "@shared/subagent-result-text";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
	awaitAgentResolvedPatch,
	backgroundTaskPatch,
	permissionRequestedPatch,
	permissionResolvedPatch,
	type ReflectionKind,
	reflectionResolvedPatch,
	reflectionStartedPatch,
	reflectionStoppedPatch,
	sendDeliveryResolvedPatch,
	subagentActivityUpdate,
	subagentConclusionPatch,
	subagentTakeoverPatch,
	timeoutUpdatedPatch,
	toolCompletedPatch,
	toolExecutingPatch,
	toolStartedPatch,
} from "./vlist-live-events";
import {
	type LivePatch,
	LivePatchQueue,
	patchDiscardedSubagentTools,
	patchSubagentActivitySnapshots,
	patchSubagentIdentity,
	patchSubagentNested,
	patchSubagentTakeoverByNarrator,
	SubagentActivityPatchStore,
} from "./vlist-live-patch";

export interface UseVListLivePatchesOptions {
	/** Only subscribe once a complete document exists to patch. */
	enabled: boolean;
	/** Replay retained activity after an in-flight page/checkpoint commits. */
	messages: readonly TreeMessage[];
	/** A subagent page treats its own (parent-pointing) tool events as top-level. */
	isSubagent: boolean;
	/** Apply a patch to the loaded document; returns true when it changed something. */
	applyLivePatch: (
		patch: (messages: readonly TreeMessage[]) => {
			readonly messages: readonly TreeMessage[];
			changed: boolean;
		},
	) => boolean;
	/** Revalidate when a terminal event arrived before its message was loaded. */
	onUnappliedToolCompletion?: () => void;
}

/**
 * Fallback wording when a gate reports no reason. Kept byte-identical to the
 * chunked path so both lists show the same text for the same event.
 */
const REFLECTION_FALLBACK: Record<ReflectionKind, { started: string; stopped: string }> = {
	danger_reflection: {
		started: "Danger reflection in progress",
		stopped: "Danger reflection stopped; awaiting user decision",
	},
	plan_reflection: {
		started: "Plan reflection in progress",
		stopped: "Plan reflection stopped; awaiting user decision",
	},
	task_reflection: {
		started: "Task reflection in progress",
		stopped: "Task reflection stopped; awaiting user decision",
	},
	question_reflection: {
		started: "Question reflection in progress",
		stopped: "Question reflection stopped; awaiting user decision",
	},
};

/** Danger reflections describe themselves through a `danger.summary` payload. */
function dangerStartedReason(danger: unknown): string {
	if (danger && typeof danger === "object" && "summary" in danger) {
		return `Danger reflection: ${String((danger as { summary?: unknown }).summary ?? "")}`;
	}
	return REFLECTION_FALLBACK.danger_reflection.started;
}

export function useVListLivePatches(
	narratorId: string | undefined,
	options: UseVListLivePatchesOptions,
): void {
	const { enabled, isSubagent, applyLivePatch, onUnappliedToolCompletion } = options;
	const applyRef = useRef(applyLivePatch);
	applyRef.current = applyLivePatch;
	/**
	 * Completions that arrived before their tool_use was loaded.
	 *
	 * A `tool_completed` patch is a pure merge by toolUseId; when the assistant
	 * message has not landed yet the patch reports no-change and would otherwise
	 * be dropped. The spinner then stays on that call until the NEXT tool's
	 * structural reload — the "status lags by one tool call" symptom. Replay them
	 * when a message event indicates the document may now own the tool.
	 */
	const pendingCompletionsRef = useRef(
		new Map<
			string,
			{ patch: LivePatch; chars: number; canRetain?: (messages: readonly TreeMessage[]) => boolean }
		>(),
	);
	const pendingCompletionCharsRef = useRef(0);
	const childActivityRef = useRef(new SubagentActivityPatchStore());
	const childActivityQueuedRef = useRef(false);
	const childOverflowQueuedRef = useRef(false);
	// Read fresh on every enqueue AND every flush: the queue rejects a batch whose
	// narrator changed between the two (see LivePatchQueue for why the effect
	// cleanup alone cannot cover that window).
	const narratorRef = useRef<string | undefined>(narratorId);
	narratorRef.current = narratorId;

	const queueRef = useRef<LivePatchQueue | null>(null);
	if (!queueRef.current) {
		queueRef.current = new LivePatchQueue({
			currentNarratorId: () => narratorRef.current,
			apply: (patch) => applyRef.current(patch),
			schedule: (drain) =>
				typeof requestAnimationFrame === "function"
					? requestAnimationFrame(drain)
					: (setTimeout(drain, 0) as unknown as number),
			cancel: (handle) => {
				if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
				else clearTimeout(handle);
			},
		});
	}

	const enqueue = useCallback((patch: LivePatch | null, onMiss?: () => void) => {
		queueRef.current?.enqueue(patch, onMiss);
	}, []);

	const replayChildActivities = useCallback(() => {
		if (childActivityQueuedRef.current || childActivityRef.current.size === 0) return;
		childActivityQueuedRef.current = true;
		enqueue(
			(messages) => {
				childActivityQueuedRef.current = false;
				return childActivityRef.current.apply(messages, narratorRef.current);
			},
			() => {
				childActivityQueuedRef.current = false;
			},
		);
	}, [enqueue]);

	const notifyChildOverflow = useCallback(() => {
		if (childOverflowQueuedRef.current) return;
		childOverflowQueuedRef.current = true;
		enqueue((messages) => {
			childOverflowQueuedRef.current = false;
			return { messages, changed: false };
		}, onUnappliedToolCompletion);
	}, [enqueue, onUnappliedToolCompletion]);

	const enqueueChildActivity = useCallback(
		(event: Parameters<typeof subagentActivityUpdate>[0]) => {
			if (!childActivityRef.current.remember(narratorRef.current, subagentActivityUpdate(event)))
				notifyChildOverflow();
			replayChildActivities();
		},
		[notifyChildOverflow, replayChildActivities],
	);

	useEffect(() => {
		if (enabled && options.messages) replayChildActivities();
	}, [enabled, options.messages, replayChildActivities]);

	const forgetPendingCompletion = useCallback((key: string) => {
		const entry = pendingCompletionsRef.current.get(key);
		if (!entry) return;
		pendingCompletionCharsRef.current -= entry.chars;
		pendingCompletionsRef.current.delete(key);
	}, []);

	/** Enqueue a completion, remembering bounded payloads until their row lands. */
	const enqueueCompletion = useCallback(
		(
			key: string,
			patch: LivePatch,
			chars: number | null = 0,
			canRetain?: (messages: readonly TreeMessage[]) => boolean,
		) => {
			enqueue((messages) => {
				const result = patch(messages);
				forgetPendingCompletion(key);
				if (
					!result.changed &&
					chars != null &&
					chars <= MAX_SUBAGENT_RESULT_TEXT_CHARS &&
					pendingCompletionsRef.current.size < 128 &&
					pendingCompletionCharsRef.current + chars <= 512_000 &&
					(canRetain?.(messages) ?? true)
				) {
					pendingCompletionsRef.current.set(key, { patch, chars, canRetain });
					pendingCompletionCharsRef.current += chars;
				}
				// Rich/oversized misses use the existing structural reconciliation;
				// never truncate a final result just to retain it here.
				return result;
			}, onUnappliedToolCompletion);
		},
		[enqueue, forgetPendingCompletion, onUnappliedToolCompletion],
	);

	/** Replay completions that missed while their tool_use was still unloaded. */
	const replayPendingCompletions = useCallback(() => {
		if (pendingCompletionsRef.current.size === 0) return;
		// A launch completion can race the child's final conclusion. Restore tool
		// lifecycle first, then the final result, independent of arrival order.
		for (const conclusions of [false, true]) {
			for (const [toolUseId, entry] of pendingCompletionsRef.current) {
				if (toolUseId.startsWith("conclusion:") !== conclusions) continue;
				enqueue((messages) => {
					if (entry.canRetain && !entry.canRetain(messages)) {
						forgetPendingCompletion(toolUseId);
						return { messages, changed: false };
					}
					const result = entry.patch(messages);
					if (result.changed) forgetPendingCompletion(toolUseId);
					return result;
				});
			}
		}
	}, [enqueue, forgetPendingCompletion]);

	useEffect(() => {
		if (enabled && options.messages) replayPendingCompletions();
	}, [enabled, options.messages, replayPendingCompletions]);

	// Drop anything still queued on unmount / narrator switch: those patches target
	// a document this hook no longer owns. narratorId/enabled are cleanup TRIGGERS
	// (not values the effect reads), so they must stay in the dependency list.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset triggers
	useEffect(() => {
		return () => {
			pendingCompletionsRef.current.clear();
			pendingCompletionCharsRef.current = 0;
			childActivityRef.current.clear();
			childActivityQueuedRef.current = false;
			childOverflowQueuedRef.current = false;
			queueRef.current?.dispose();
		};
	}, [narratorId, enabled]);

	/**
	 * Resolve where a tool event belongs. On a parent page an event carrying a
	 * parentToolUseId describes a CHILD tool, so it may only touch the parent
	 * card's activity summary; on the subagent's own page the parent pointer is
	 * noise and the event is top-level.
	 */
	const routeParent = useCallback(
		(rawParentToolUseId?: string) => (isSubagent ? undefined : rawParentToolUseId),
		[isSubagent],
	);

	const reflectionHandlers = useMemo(
		() => ({
			started:
				(kind: ReflectionKind) =>
				(event: {
					requestId: string;
					toolUseId: string;
					reason?: string;
					danger?: unknown;
					mutations?: unknown;
					inputJson?: Record<string, unknown>;
				}) => {
					enqueue(
						reflectionStartedPatch({
							kind,
							toolUseId: event.toolUseId,
							requestId: event.requestId,
							...(event.reason !== undefined ? { reason: event.reason } : {}),
							...(event.danger !== undefined ? { danger: event.danger } : {}),
							...(event.mutations !== undefined ? { mutations: event.mutations } : {}),
							...(event.inputJson ? { inputJson: event.inputJson } : {}),
							fallbackReason:
								kind === "danger_reflection"
									? dangerStartedReason(event.danger)
									: REFLECTION_FALLBACK[kind].started,
						}),
					);
				},
			stopped:
				(kind: ReflectionKind) =>
				(event: {
					requestId: string;
					toolUseId: string;
					reason?: string;
					danger?: unknown;
					mutations?: unknown;
					inputJson?: Record<string, unknown>;
				}) => {
					enqueue(
						reflectionStoppedPatch({
							kind,
							toolUseId: event.toolUseId,
							requestId: event.requestId,
							...(event.reason !== undefined ? { reason: event.reason } : {}),
							...(event.danger !== undefined ? { danger: event.danger } : {}),
							...(event.mutations !== undefined ? { mutations: event.mutations } : {}),
							...(event.inputJson ? { inputJson: event.inputJson } : {}),
							fallbackReason: REFLECTION_FALLBACK[kind].stopped,
						}),
					);
				},
			resolved:
				(kind: ReflectionKind) =>
				(event: {
					requestId: string;
					toolUseId: string;
					decision: string;
					reason?: string;
					nextSteps?: string;
				}) => {
					enqueue(
						reflectionResolvedPatch({
							kind,
							toolUseId: event.toolUseId,
							requestId: event.requestId,
							decision: event.decision,
							...(event.reason !== undefined ? { reason: event.reason } : {}),
							...(event.nextSteps !== undefined ? { nextSteps: event.nextSteps } : {}),
						}),
					);
				},
		}),
		[enqueue],
	);

	useNarratorWS(
		enabled ? narratorId : undefined,
		{
			// ── Tool lifecycle ──────────────────────────────────────────────────
			onToolUseDiscarded: (toolUseIds, rawParent, subagentNarratorId) => {
				const parentToolUseId = routeParent(rawParent);
				if (!parentToolUseId) return;
				childActivityRef.current.discard(parentToolUseId, toolUseIds, subagentNarratorId);
				enqueue((messages) =>
					patchDiscardedSubagentTools(messages, parentToolUseId, toolUseIds, subagentNarratorId),
				);
			},
			onToolUseChunk: (
				toolUseId,
				toolName,
				_inputCharsTotal,
				rawParent,
				_extractedFilePath,
				_contentCharsReceived,
				_extractedFields,
				_metadata,
				_streamingField,
				meta,
			) => {
				const parentToolUseId = routeParent(rawParent);
				if (!parentToolUseId) return;
				enqueueChildActivity({
					parentToolUseId,
					toolUseId,
					toolName,
					status: "streaming",
					toolCallId: meta?.toolCallId,
					executionAttempt: meta?.executionAttempt,
					createdAt: meta?.createdAt,
					timing: meta?.timing,
					subagentNarratorId: meta?.subagentNarratorId,
					model: meta?.model,
					inputSummary: meta?.inputSummary,
				});
			},
			onToolStarted: (
				toolUseId,
				toolName,
				streamStartedAt,
				streamCompletedAt,
				input,
				rawParent,
				meta,
				streamingEditOrigin,
			) => {
				const parentToolUseId = routeParent(rawParent);
				if (parentToolUseId) {
					enqueueChildActivity({
						parentToolUseId,
						toolUseId,
						toolName,
						status: "running",
						toolCallId: meta?.toolCallId ?? null,
						executionAttempt: meta?.executionAttempt,
						createdAt: meta?.createdAt ?? null,
						timing: meta?.timing ?? null,
						subagentNarratorId: meta?.subagentNarratorId ?? null,
						model: meta?.model ?? null,
						inputSummary: meta?.inputSummary,
					});
					return;
				}
				enqueue(
					toolStartedPatch({
						toolUseId,
						...(meta?.blockId ? { blockId: meta.blockId } : {}),
						...(streamStartedAt != null ? { streamStartedAt } : {}),
						...(streamCompletedAt != null ? { streamCompletedAt } : {}),
						...(input ? { input } : {}),
						...(streamingEditOrigin ? { streamingEditOrigin } : {}),
					}),
				);
			},
			onStreamingSnapshot: (snapshot) => {
				for (const chunk of snapshot.toolChunks) {
					const parentToolUseId = routeParent(chunk.parentToolUseId);
					if (parentToolUseId) {
						enqueueChildActivity({
							parentToolUseId,
							toolUseId: chunk.toolUseId,
							toolName: chunk.toolName,
							toolCallId: chunk.toolCallId,
							executionAttempt: chunk.executionAttempt,
							createdAt: chunk.createdAt,
							timing: chunk.timing,
							model: chunk.model,
							subagentNarratorId: chunk.subagentNarratorId,
							inputSummary: chunk.inputSummary,
							status: chunk.started ? "running" : "streaming",
						});
						continue;
					}
					if (!chunk.started) continue;
					enqueue(
						toolStartedPatch({
							toolUseId: chunk.toolUseId,
							input: chunk.input as Record<string, unknown> | undefined,
							streamStartedAt: chunk.streamStartedAt,
							streamingEditOrigin: chunk.streamingEditOrigin,
						}),
					);
					if (chunk.executing) enqueue(toolExecutingPatch(chunk.toolUseId));
				}
			},
			onToolCompleted: (
				toolUseId,
				status,
				output,
				durationMs,
				updatedInput,
				metadata,
				rawParent,
				meta,
			) => {
				const parentToolUseId = routeParent(rawParent);
				if (parentToolUseId) {
					enqueueChildActivity({
						parentToolUseId,
						toolUseId,
						toolName: meta?.toolName ?? "Tool",
						status,
						toolCallId: meta?.toolCallId ?? null,
						executionAttempt: meta?.executionAttempt,
						createdAt: meta?.createdAt ?? null,
						timing: meta?.timing ?? null,
						subagentNarratorId: meta?.subagentNarratorId ?? null,
						model: meta?.model ?? null,
						inputSummary: meta?.inputSummary,
					});
					return;
				}
				enqueueCompletion(
					`tool:${toolUseId}`,
					toolCompletedPatch({
						toolUseId,
						...(meta?.blockId ? { blockId: meta.blockId } : {}),
						status,
						output,
						...(durationMs != null ? { durationMs } : {}),
						...(updatedInput ? { updatedInput } : {}),
						...(metadata ? { metadata } : {}),
					}),
					// Keep deferred payloads bounded. Rich/large missed completions use
					// the existing structural reconciliation rather than retaining blobs.
					!updatedInput && !metadata && (output == null || typeof output === "string")
						? typeof output === "string"
							? output.length
							: 0
						: null,
				);
			},

			// The header's timeout editor commits over WS and the server answers with
			// `timeout_updated`. Without this the popover closed and the suffix kept
			// showing the OLD deadline until an unrelated reload — the change had taken
			// effect on the server, only the card was lying about it.
			//
			// No subagent routing: the event carries no parentToolUseId, and the
			// activity summary rows have no timeout to show.
			onTimeoutUpdated: (toolUseId, timeoutMs) => {
				if (!toolUseId) return;
				enqueue(timeoutUpdatedPatch({ toolUseId, timeoutMs }));
			},

			// A running Await-agent call resolved its target. Without this the row's
			// "open session" item stays hidden for the whole wait — exactly when the
			// child's progress is only visible inside its own session — because the
			// id does not reach the persisted row until the tool returns.
			onSendDeliveryResolved: (
				toolUseId,
				targets,
				_parentToolUseId,
				toolCallBinding,
				targetCount,
			) => {
				if (!toolUseId) return;
				// The patch walks loaded children too; parent pages must receive child receipts.
				enqueue(sendDeliveryResolvedPatch({ toolUseId, targets, toolCallBinding, targetCount }));
			},
			onAwaitAgentResolved: (toolUseId, subagentNarratorId, _parentToolUseId, subagentTitle) => {
				if (!toolUseId || !subagentNarratorId) return;
				enqueue(awaitAgentResolvedPatch({ toolUseId, subagentNarratorId, subagentTitle }));
			},

			// The user took over a subagent, so this card's call is now blocked on a
			// PERSON. Without the badge a suspended Agent card and an in-flight Await
			// look exactly like ordinary running work, and a forgotten takeover stalls
			// the session with nothing on screen explaining why.
			//
			// BOTH addressing routes run, they are not fallbacks for each other. The
			// frame's `toolUseId` is the call that SPAWNED the child (resolved from its
			// first user message), while a separate in-flight `Await({type:"agent"})`
			// waiting on the same child is a DIFFERENT card that only carries the child's
			// narrator id (`_awaitAgentNarratorId`, server-resolved). Treating the id as
			// exclusive left the Await card lit forever after the user stopped the
			// takeover, because the message-load path (`collectTakenOverToolUseIds`) does
			// flag it while no live frame ever cleared it.
			//
			// Running both is safe: each patch reports `changed: false` when it matches
			// nothing, and they write the same fields with the same value, so the card
			// cannot end up in a mixed state.
			onSubagentTakeoverChanged: ({ subagentNarratorId, toolUseId, takenOver }) => {
				if (toolUseId) enqueue(subagentTakeoverPatch({ toolUseId, takenOver }));
				if (!subagentNarratorId) return;
				enqueue((messages) =>
					patchSubagentTakeoverByNarrator(messages, subagentNarratorId, takenOver),
				);
			},

			// The helpers of a first-level subagent changed (this page is the tree's root):
			// its card's nested rows are replaced by the server's bounded summary.
			onSubagentNestedChanged: ({ subagentNarratorId, toolUseId, nested }) => {
				if (!toolUseId) return;
				enqueue((messages) => patchSubagentNested(messages, toolUseId, subagentNarratorId, nested));
			},

			// Execution began (permission granted). The persisted half of the same signal
			// `useVListStreamingMessage` folds into the live store.
			onToolExecuting: (toolUseId) => {
				if (!toolUseId) return;
				enqueue(toolExecutingPatch(toolUseId));
			},

			// ── Permissions (persisted status half; the live form is separate) ──
			onPermissionRequest: (request) => {
				if (request.toolUseId) enqueue(permissionRequestedPatch(request.toolUseId));
			},
			onPermissionResolved: (_requestId, toolUseId, updatedInput, decision, feedbackText) => {
				if (!toolUseId) return;
				enqueue(
					permissionResolvedPatch({
						toolUseId,
						...(decision ? { decision } : {}),
						...(updatedInput ? { updatedInput } : {}),
						...(feedbackText !== undefined ? { feedbackText } : {}),
					}),
				);
			},

			// ── Reflection gates (4 families × started / stopped / resolved) ────
			onDangerReflectionStarted: reflectionHandlers.started("danger_reflection"),
			onDangerReflectionStopped: reflectionHandlers.stopped("danger_reflection"),
			onDangerReflectionResolved: reflectionHandlers.resolved("danger_reflection"),
			onPlanReflectionStarted: reflectionHandlers.started("plan_reflection"),
			onPlanReflectionStopped: reflectionHandlers.stopped("plan_reflection"),
			onPlanReflectionResolved: reflectionHandlers.resolved("plan_reflection"),
			onTaskReflectionStarted: reflectionHandlers.started("task_reflection"),
			onTaskReflectionStopped: reflectionHandlers.stopped("task_reflection"),
			onTaskReflectionResolved: reflectionHandlers.resolved("task_reflection"),
			onQuestionReflectionStarted: reflectionHandlers.started("question_reflection"),
			// A disarmed question gate is the same transition as a "stopped" one:
			// the decision returns to the user.
			onQuestionReflectionDisarmed: reflectionHandlers.stopped("question_reflection"),
			onQuestionReflectionResolved: reflectionHandlers.resolved("question_reflection"),

			// ── Subagents ───────────────────────────────────────────────────────
			// NOTE the argument order: (toolUseId, model, subagentNarratorId, …).
			// `toolUseId` here IS the parent Agent/Task card's id — the event announces
			// which child narrator that card now owns.
			onSubagentStarted: (
				toolUseId,
				model,
				subagentNarratorId,
				reasoningEffort,
				modelInheritance,
			) => {
				if (!toolUseId) return;
				if (subagentNarratorId) childActivityRef.current.identify(toolUseId, subagentNarratorId);
				enqueue((messages) =>
					patchSubagentIdentity(messages, toolUseId, {
						...(subagentNarratorId ? { subagentNarratorId } : {}),
						...(model ? { model } : {}),
						...(reasoningEffort ? { reasoningEffort } : {}),
						...(modelInheritance ? { modelInheritance } : {}),
					}),
				);
			},
			onSubagentConclusionUpdated: (
				subagentNarratorId,
				toolUseId,
				output,
				hasError,
				completedAt,
				durationMs,
			) => {
				if (!toolUseId) return;
				enqueueCompletion(
					`conclusion:${subagentNarratorId}:${toolUseId}`,
					subagentConclusionPatch({
						toolUseId,
						subagentNarratorId,
						output,
						hasError,
						...(completedAt != null ? { completedAt } : {}),
						...(durationMs != null ? { durationMs } : {}),
					}),
					typeof output === "string" ? output.length : null,
					(messages) =>
						messages.every((message) => {
							const block = messageBody(message).find(
								(entry) => entry.type === "tool_use" && entry.id === toolUseId,
							);
							const call = message.toolCalls?.find((entry) => entry.toolUseId === toolUseId);
							const owner =
								block?._subagentActivity?.subagentNarratorId ??
								call?._subagentActivity?.subagentNarratorId;
							return !owner || owner === subagentNarratorId;
						}),
				);
			},

			// ── Background tasks ────────────────────────────────────────────────
			onBackgroundTaskCompleted: (_taskNarratorId, toolUseId, resultPreview) => {
				if (!toolUseId) return;
				enqueue(backgroundTaskPatch({ toolUseId, status: "success", text: resultPreview ?? "" }));
			},
			onBackgroundTaskFailed: (_taskNarratorId, toolUseId, error) => {
				if (!toolUseId) return;
				enqueue(backgroundTaskPatch({ toolUseId, status: "fail", text: error ?? "" }));
			},
			onBackgroundTaskCancelled: (_taskNarratorId, toolUseId) => {
				if (!toolUseId) return;
				enqueue(backgroundTaskPatch({ toolUseId, status: "cancelled", text: "Cancelled" }));
			},

			// ── Reconnect catch-up: authoritative activity snapshots ────────────
			// The shell's own onCatchUp only decides whether to reload structurally;
			// the activity summaries it carries would otherwise be dropped.
			onCatchUp: (_orphanChildren, _topLevel, subagentActivities) => {
				// A catch-up reload may finally load the tool_use a completion missed.
				replayPendingCompletions();
				if (subagentActivities.length === 0) {
					replayChildActivities();
					return;
				}
				const snapshots = subagentActivities as SubagentActivityCatchUp[];
				for (const snapshot of snapshots) {
					if (
						!childActivityRef.current.rememberSnapshot(
							narratorRef.current,
							snapshot.parentToolUseId,
							snapshot.activity,
						)
					)
						notifyChildOverflow();
				}
				enqueue((messages) => patchSubagentActivitySnapshots(messages, snapshots));
				replayChildActivities();
			},
			// A landed / updated message can introduce the tool_use a completion
			// previously could not find. Replay before other patches so the spinner
			// clears in the same frame the card appears.
			onMessage: () => {
				replayPendingCompletions();
				replayChildActivities();
			},
			onMessageUpdated: () => {
				replayPendingCompletions();
				replayChildActivities();
			},
			onMessagesDeleted: () => {
				// Unloaded parents have no message id to correlate; deletion invalidates
				// this short compensation window rather than resurrecting removed tools.
				childActivityRef.current.clear();
			},
		},
		undefined,
		{ kind: "messages" },
	);
}
