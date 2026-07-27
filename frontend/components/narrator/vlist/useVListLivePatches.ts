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
 * - Deliberately NOT handled: `tool_use_chunk` / `tool_output`. Those fire at
 *   streaming frequency; routing them through the document would rebuild the
 *   whole layout per chunk. They belong to the streaming tail instead.
 *
 * Subagent routing follows the same rule as the chunked path: on a parent page a
 * child tool event only updates the parent card's activity summary, while on the
 * subagent's OWN page those same events are its top-level tools.
 */

import { useNarratorWS } from "@frontend/hooks/useNarratorWS";
import type { SubagentActivityCatchUp, TreeMessage } from "@frontend/lib/api";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
	backgroundTaskPatch,
	permissionRequestedPatch,
	permissionResolvedPatch,
	type ReflectionKind,
	reflectionResolvedPatch,
	reflectionStartedPatch,
	reflectionStoppedPatch,
	subagentActivityPatch,
	subagentConclusionPatch,
	toolCompletedPatch,
	toolStartedPatch,
} from "./vlist-live-events";
import {
	type LivePatch,
	LivePatchQueue,
	patchSubagentActivitySnapshots,
	patchSubagentIdentity,
} from "./vlist-live-patch";

export interface UseVListLivePatchesOptions {
	/** Only subscribe once a complete document exists to patch. */
	enabled: boolean;
	/** A subagent page treats its own (parent-pointing) tool events as top-level. */
	isSubagent: boolean;
	/** Apply a patch to the loaded document; returns true when it changed something. */
	applyLivePatch: (
		patch: (messages: readonly TreeMessage[]) => {
			readonly messages: readonly TreeMessage[];
			changed: boolean;
		},
	) => boolean;
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
	const { enabled, isSubagent, applyLivePatch } = options;
	const applyRef = useRef(applyLivePatch);
	applyRef.current = applyLivePatch;
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

	const enqueue = useCallback((patch: LivePatch | null) => {
		queueRef.current?.enqueue(patch);
	}, []);

	// Drop anything still queued on unmount / narrator switch: those patches target
	// a document this hook no longer owns. narratorId/enabled are cleanup TRIGGERS
	// (not values the effect reads), so they must stay in the dependency list.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset triggers
	useEffect(() => {
		return () => queueRef.current?.dispose();
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
			onToolStarted: (toolUseId, toolName, streamStartedAt, input, rawParent, meta) => {
				const parentToolUseId = routeParent(rawParent);
				if (parentToolUseId) {
					enqueue(
						subagentActivityPatch({
							parentToolUseId,
							toolUseId,
							toolName,
							status: "running",
							toolCallId: meta?.toolCallId ?? null,
							createdAt: meta?.createdAt ?? null,
							timing: meta?.timing ?? null,
							subagentNarratorId: meta?.subagentNarratorId ?? null,
							model: meta?.model ?? null,
						}),
					);
					return;
				}
				enqueue(
					toolStartedPatch({
						toolUseId,
						...(streamStartedAt != null ? { streamStartedAt } : {}),
						...(input ? { input } : {}),
					}),
				);
			},
			onToolCompleted: (
				toolUseId,
				status,
				output,
				durationMs,
				updatedInput,
				metadata,
				rawParent,
				sideCars,
				meta,
			) => {
				const parentToolUseId = routeParent(rawParent);
				if (parentToolUseId) {
					enqueue(
						subagentActivityPatch({
							parentToolUseId,
							toolUseId,
							toolName: meta?.toolName ?? "Tool",
							status,
							toolCallId: meta?.toolCallId ?? null,
							createdAt: meta?.createdAt ?? null,
							timing: meta?.timing ?? null,
							subagentNarratorId: meta?.subagentNarratorId ?? null,
							model: meta?.model ?? null,
						}),
					);
					return;
				}
				enqueue(
					toolCompletedPatch({
						toolUseId,
						status,
						output,
						...(durationMs != null ? { durationMs } : {}),
						...(updatedInput ? { updatedInput } : {}),
						...(metadata ? { metadata } : {}),
						...(sideCars?.length ? { sideCars } : {}),
					}),
				);
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
			onSubagentStarted: (toolUseId, model, subagentNarratorId, reasoningEffort) => {
				if (!toolUseId) return;
				enqueue((messages) =>
					patchSubagentIdentity(messages, toolUseId, {
						...(subagentNarratorId ? { subagentNarratorId } : {}),
						...(model ? { model } : {}),
						...(reasoningEffort ? { reasoningEffort } : {}),
					}),
				);
			},
			onSubagentConclusionUpdated: (
				_subagentNarratorId,
				toolUseId,
				output,
				hasError,
				completedAt,
				durationMs,
			) => {
				if (!toolUseId) return;
				enqueue(
					subagentConclusionPatch({
						toolUseId,
						output,
						hasError,
						...(completedAt != null ? { completedAt } : {}),
						...(durationMs != null ? { durationMs } : {}),
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
				if (subagentActivities.length === 0) return;
				const snapshots = subagentActivities as SubagentActivityCatchUp[];
				enqueue((messages) => patchSubagentActivitySnapshots(messages, snapshots));
			},
		},
		undefined,
		{ kind: "messages" },
	);
}
