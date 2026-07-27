/**
 * vlist-live-events.ts — Pure translation of live WS lifecycle events into the
 * document patches defined by vlist-live-patch.ts.
 *
 * Separated from the shell so the FIELD MAPPING is unit-testable without React
 * or a WebSocket. That matters because these field sets must stay in lockstep
 * with the chunked path (useNarratorChunksWS.ts:1608-1926) — a card that renders
 * from a different field set than the other path is exactly the divergence this
 * work is fixing. Each builder below is annotated with the chunk-path line it
 * mirrors.
 *
 * One DELIBERATE divergence: the builders here write `status: "running"` /
 * `"pending"` unconditionally (as the chunk path does), but the patch layer they
 * feed refuses a TERMINAL → non-terminal regression (`withoutTerminalRegression`
 * in vlist-live-patch.ts). Reconnect catch-up can replay a `permission_resolved`
 * or `tool_started` after the `tool_completed` that superseded it, and unguarded
 * that flips a finished card back to a spinner forever. The chunk path still has
 * that hole; this channel is new code, so it starts out correct rather than
 * bug-compatible.
 *
 * Zero DOM, zero React.
 */

import type { SubagentToolCallHeader } from "@frontend/lib/api";
import {
	type LivePatch,
	patchReflection,
	patchSubagentActivity,
	patchToolCallFields,
} from "./vlist-live-patch";

/** The four reflection families, each with its own suggestion `type` tag. */
export type ReflectionKind =
	| "danger_reflection"
	| "plan_reflection"
	| "task_reflection"
	| "question_reflection";

/** A reflection decision as delivered by `*_reflection_resolved`. */
export type ReflectionDecision = "allow" | "deny" | "aborted" | (string & {});

// ─────────────────────────────────────────────────────────────────────────────
// Tool lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `tool_started` → the card flips to running and gains its start timestamps.
 * Mirrors useNarratorChunksWS.ts:1433-1446.
 */
export function toolStartedPatch(opts: {
	toolUseId: string;
	streamStartedAt?: number;
	input?: Record<string, unknown>;
}): LivePatch {
	const fields: Record<string, unknown> = {
		status: "running",
		startedAt: opts.streamStartedAt ?? Date.now(),
		...(opts.streamStartedAt != null ? { streamStartedAt: opts.streamStartedAt } : {}),
		...(opts.input ? { inputJson: opts.input } : {}),
	};
	// Await-style tools carry their own timeout on the input; the header shows it.
	if (typeof opts.input?.timeout === "number") fields._timeoutMs = opts.input.timeout;
	return (messages) => patchToolCallFields(messages, opts.toolUseId, fields);
}

/**
 * `tool_completed` → the terminal status, output, duration and any sidecars.
 * Mirrors useNarratorChunksWS.ts:1274-1312.
 *
 * `outputJson` is written even when undefined-in-event is possible because
 * mergeToolFields preserves an existing output when the field is absent, so a
 * result-less completion cannot blank a previously streamed body.
 */
export function toolCompletedPatch(opts: {
	toolUseId: string;
	status: string;
	output?: unknown;
	durationMs?: number;
	updatedInput?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	sideCars?: unknown[];
}): LivePatch {
	const fields: Record<string, unknown> = {
		status: opts.status,
		...(opts.output !== undefined ? { outputJson: opts.output } : {}),
		...(opts.durationMs != null ? { durationMs: opts.durationMs } : {}),
		...(opts.updatedInput ? { inputJson: opts.updatedInput } : {}),
		...(opts.metadata ? { _metadata: opts.metadata } : {}),
		...(opts.sideCars?.length ? { sideCars: opts.sideCars } : {}),
	};
	return (messages) => patchToolCallFields(messages, opts.toolUseId, fields);
}

/**
 * `permission_request` → the card is waiting on the user.
 * Mirrors useNarratorChunksWS.ts:1608-1616.
 */
export function permissionRequestedPatch(toolUseId: string): LivePatch {
	return (messages) => patchToolCallFields(messages, toolUseId, { status: "pending" });
}

/**
 * `permission_resolved` → allow resumes the tool, deny fails it with the
 * reviewer's message. Any other decision leaves the card alone.
 * Mirrors useNarratorChunksWS.ts:1626-1648.
 */
export function permissionResolvedPatch(opts: {
	toolUseId: string;
	decision?: "allow" | "deny";
	updatedInput?: Record<string, unknown>;
	feedbackText?: string;
}): LivePatch | null {
	if (opts.decision === "deny") {
		return (messages) =>
			patchToolCallFields(messages, opts.toolUseId, {
				status: "fail",
				permissionDenyMessage: opts.feedbackText?.trim() || null,
			});
	}
	if (opts.decision !== "allow") return null;
	return (messages) =>
		patchToolCallFields(messages, opts.toolUseId, {
			status: "running",
			startedAt: Date.now(),
			...(opts.updatedInput ? { inputJson: opts.updatedInput } : {}),
		});
}

/**
 * Background-task terminals write a text output preview plus the status.
 * Mirrors useNarratorChunksWS.ts:1871-1926.
 */
export function backgroundTaskPatch(opts: {
	toolUseId: string;
	status: "success" | "fail" | "cancelled";
	text: string;
}): LivePatch {
	return (messages) =>
		patchToolCallFields(messages, opts.toolUseId, {
			status: opts.status,
			outputJson: [{ type: "text", text: opts.text }],
			...(opts.status === "fail" ? { errorMessage: opts.text } : {}),
		});
}

/**
 * `subagent_conclusion_updated` → the parent Agent/Task card's own result.
 * Mirrors useNarratorChunksWS.ts:1591-1605.
 */
export function subagentConclusionPatch(opts: {
	toolUseId: string;
	output: unknown;
	hasError: boolean;
	completedAt?: string | number;
	durationMs?: number;
}): LivePatch {
	return (messages) =>
		patchToolCallFields(messages, opts.toolUseId, {
			outputJson: opts.output,
			status: opts.hasError ? "fail" : "success",
			...(opts.completedAt != null ? { completedAt: opts.completedAt } : {}),
			...(opts.durationMs != null ? { durationMs: opts.durationMs } : {}),
		});
}

/**
 * A child tool event routed to the PARENT card's activity summary (the "recent
 * calls" rows). Mirrors useNarratorChunksWS.ts:1223-1237 / 1403-1411.
 */
export function subagentActivityPatch(opts: {
	parentToolUseId: string;
	toolUseId: string;
	toolName: string;
	status: string;
	toolCallId?: string | null;
	createdAt?: string | number | null;
	timing?: SubagentToolCallHeader["timing"];
	subagentNarratorId?: string | null;
	model?: string | null;
	reasoningEffort?: string | null;
}): LivePatch {
	const header: SubagentToolCallHeader = {
		toolCallId: opts.toolCallId ?? null,
		toolUseId: opts.toolUseId,
		toolName: opts.toolName,
		status: opts.status,
		createdAt: opts.createdAt ?? opts.timing?.streamStartedAt ?? Date.now(),
		timing: opts.timing ?? null,
	};
	return (messages) =>
		patchSubagentActivity(messages, opts.parentToolUseId, header, {
			...(opts.subagentNarratorId != null ? { subagentNarratorId: opts.subagentNarratorId } : {}),
			...(opts.model != null ? { model: opts.model } : {}),
			...(opts.reasoningEffort != null ? { reasoningEffort: opts.reasoningEffort } : {}),
		});
}

// ─────────────────────────────────────────────────────────────────────────────
// Reflection gates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `*_reflection_started` → the gate is deliberating. The tool row goes `pending`
 * and carries a `running` suggestion, which is what makes the card render a
 * ReflectionNotice instead of raw approve/deny buttons.
 * Mirrors useNarratorChunksWS.ts:1654-1669 (and the plan/task/question twins).
 */
export function reflectionStartedPatch(opts: {
	kind: ReflectionKind;
	toolUseId: string;
	requestId: string;
	reason?: string;
	danger?: unknown;
	mutations?: unknown;
	inputJson?: Record<string, unknown>;
	fallbackReason: string;
}): LivePatch {
	return (messages) =>
		patchReflection(messages, opts.toolUseId, opts.requestId, opts.kind, "started", {
			status: "pending",
			...(opts.inputJson ? { inputJson: opts.inputJson } : {}),
			permissionDecisionReason: opts.reason ?? opts.fallbackReason,
			permissionSuggestions: [
				{
					type: opts.kind,
					status: "running",
					requestId: opts.requestId,
					...(opts.danger !== undefined ? { danger: opts.danger } : {}),
					...(opts.mutations !== undefined ? { mutations: opts.mutations } : {}),
					...(opts.reason !== undefined ? { reason: opts.reason } : {}),
				},
			],
		});
}

/**
 * `*_reflection_stopped` / `question_reflection_disarmed` → the gate handed the
 * decision back to the user, so the notice switches to `awaiting_user` and the
 * card is free to mount the real permission form.
 * Mirrors useNarratorChunksWS.ts:1670-1685 / 1726-1740 / 1808-1828.
 */
export function reflectionStoppedPatch(opts: {
	kind: ReflectionKind;
	toolUseId: string;
	requestId: string;
	reason?: string;
	danger?: unknown;
	mutations?: unknown;
	inputJson?: Record<string, unknown>;
	fallbackReason: string;
}): LivePatch {
	return (messages) =>
		patchReflection(messages, opts.toolUseId, opts.requestId, opts.kind, "terminal", {
			status: "pending",
			...(opts.inputJson ? { inputJson: opts.inputJson } : {}),
			permissionDecisionReason: opts.reason ?? opts.fallbackReason,
			permissionSuggestions: [
				{
					type: opts.kind,
					status: "awaiting_user",
					requestId: opts.requestId,
					...(opts.danger !== undefined ? { danger: opts.danger } : {}),
					...(opts.mutations !== undefined ? { mutations: opts.mutations } : {}),
					...(opts.reason !== undefined ? { reason: opts.reason } : {}),
				},
			],
		});
}

/**
 * Map a resolve decision to the suggestion status the notice renders.
 *
 * `question_reflection` is deliberately different: an aborted question gate
 * returns the decision to the user rather than ending it, so it resolves to
 * `awaiting_user` where the other three resolve to `aborted`. That asymmetry is
 * copied verbatim from the chunked path (compare :1686-1711 with :1843-1869) —
 * it is behaviour, not an oversight.
 */
export function reflectionResolvedStatus(
	kind: ReflectionKind,
	decision: ReflectionDecision,
): "confirmed" | "aborted" | "cancelled" | "awaiting_user" {
	if (decision === "allow") return "confirmed";
	if (decision === "aborted") return kind === "question_reflection" ? "awaiting_user" : "aborted";
	return "cancelled";
}

/**
 * `*_reflection_resolved` → the terminal state. Allowing resumes the tool
 * (`running`); anything else leaves it non-running with the reason attached.
 *
 * A question gate never FAILS the tool (the question is still answerable), so it
 * lands on `pending` rather than `fail` — again mirroring the chunked path.
 */
export function reflectionResolvedPatch(opts: {
	kind: ReflectionKind;
	toolUseId: string;
	requestId: string;
	decision: ReflectionDecision;
	reason?: string;
	nextSteps?: string;
}): LivePatch {
	const allowed = opts.decision === "allow";
	const isQuestion = opts.kind === "question_reflection";
	const toolStatus = allowed ? "running" : isQuestion ? "pending" : "fail";
	return (messages) =>
		patchReflection(messages, opts.toolUseId, opts.requestId, opts.kind, "terminal", {
			status: toolStatus,
			...(allowed ? { startedAt: Date.now() } : {}),
			...(!allowed && !isQuestion ? { errorMessage: opts.reason ?? null } : {}),
			permissionDecisionReason: opts.reason ?? null,
			permissionSuggestions: [
				{
					type: opts.kind,
					status: reflectionResolvedStatus(opts.kind, opts.decision),
					requestId: opts.requestId,
					...(opts.reason !== undefined ? { reason: opts.reason } : {}),
					...(opts.nextSteps !== undefined ? { nextSteps: opts.nextSteps } : {}),
				},
			],
		});
}
