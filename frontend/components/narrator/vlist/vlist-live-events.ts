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
import type { SubagentToolInputSummary } from "@shared/subagent-tool-summary";
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
 * `tool_started` → the card gains its resolved input and start timestamps.
 *
 * ⚠️ Writes `initializing`, NOT `running`. This frame means the tool's INPUT finished
 * parsing; the permission prompt, any reflection gate and the final admission wait all
 * come after it. `toolExecutingPatch` below carries the actual "now running" fact.
 *
 * `status` is omitted entirely when a later phase may already have landed — see the
 * `preserveStatus` option. Eager execution makes `tool_executing` arrive BEFORE this
 * frame for most tools, so writing a status unconditionally would demote a tool that
 * is demonstrably executing.
 */
export function toolStartedPatch(opts: {
	toolUseId: string;
	streamStartedAt?: number;
	input?: Record<string, unknown>;
}): LivePatch {
	const fields: Record<string, unknown> = {
		status: "initializing",
		startedAt: opts.streamStartedAt ?? Date.now(),
		...(opts.streamStartedAt != null ? { streamStartedAt: opts.streamStartedAt } : {}),
		...(opts.input ? { inputJson: opts.input } : {}),
	};
	// Await-style tools carry their own timeout on the input; the header shows it.
	if (typeof opts.input?.timeout === "number") fields._timeoutMs = opts.input.timeout;
	return (messages) => patchToolCallFields(messages, opts.toolUseId, fields);
}

/**
 * `tool_completed` → the terminal status, output and duration.
 * Mirrors useNarratorChunksWS.ts's onToolCompleted field merge.
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
}): LivePatch {
	const fields: Record<string, unknown> = {
		status: opts.status,
		...(opts.output !== undefined ? { outputJson: opts.output } : {}),
		...(opts.durationMs != null ? { durationMs: opts.durationMs } : {}),
		...(opts.updatedInput ? { inputJson: opts.updatedInput } : {}),
		...(opts.metadata ? { _metadata: opts.metadata } : {}),
	};
	return (messages) => patchToolCallFields(messages, opts.toolUseId, fields);
}

/**
 * `timeout_updated` → the header's `/ timeout` suffix adopts the new deadline.
 * Mirrors useNarratorChunksWS.ts:1564-1570.
 *
 * Written as `_timeoutMs` (not `inputJson.timeout`) because that is the field the
 * adapter's `effectiveTimeoutMs` reads FIRST — the server does persist the value
 * into `inputJson` for the next reload, but it never re-broadcasts the owning
 * message, so the loaded copy stays stale until this patch lands.
 *
 * `status` is deliberately absent: extending a deadline says nothing about the
 * tool's lifecycle, and writing one would let a replayed frame regress a card
 * that has since completed.
 */
export function timeoutUpdatedPatch(opts: { toolUseId: string; timeoutMs: number }): LivePatch {
	return (messages) =>
		patchToolCallFields(messages, opts.toolUseId, { _timeoutMs: opts.timeoutMs });
}

/**
 * `await_agent_resolved` → the row learns which child session it can open.
 *
 * HEIGHT-NEUTRAL BY CONSTRUCTION, and that is the point: the field only gates a
 * context-menu item, and it is deliberately NOT written as `_metadata.subagentId`
 * (which `classifyAwait` would render as an extra `subagent:` row, growing every
 * running Await card). Because nothing measurable changes, no `extractDataRevision`
 * component is needed either — the menu reads the message tree, not the measured
 * payload, so a cached height entry stays correct.
 *
 * `status` is deliberately absent: resolving a target says nothing about the
 * lifecycle, and writing one would let a replayed frame regress a finished card.
 */
export function awaitAgentResolvedPatch(opts: {
	toolUseId: string;
	subagentNarratorId: string;
}): LivePatch {
	return (messages) =>
		patchToolCallFields(messages, opts.toolUseId, {
			_awaitAgentNarratorId: opts.subagentNarratorId,
		});
}

/**
 * `subagent_takeover_changed` → the card says the user is driving its child.
 *
 * HEIGHT-NEUTRAL (the badge joins the card's fixed header/badge row) but,
 * unlike `awaitAgentResolvedPatch` above, the value is PAINTED — so it needs a
 * component in `extractDataRevision` / `subagentRevision`. That is not optional
 * insurance here: nothing else in the cache key can move, because the whole
 * point is that the call is STILL `running` while a person drives the child by
 * hand. Without the revision the rebuild would serve the pre-takeover payload
 * and the header would stay silent about why the session stopped.
 *
 * Written on the block (never into `_metadata`): `classifyAwait` turns metadata
 * into extra detail rows, which would grow every Await card.
 *
 * `status` is deliberately absent: a takeover says nothing about the tool's
 * lifecycle, and writing one would let a replayed frame regress a finished card.
 */
export function subagentTakeoverPatch(opts: { toolUseId: string; takenOver: boolean }): LivePatch {
	return (messages) =>
		patchToolCallFields(messages, opts.toolUseId, { _takenOver: opts.takenOver });
}

/**
 * `permission_request` → the card is waiting on the user.
 * Mirrors useNarratorChunksWS.ts:1608-1616.
 */
export function permissionRequestedPatch(toolUseId: string): LivePatch {
	return (messages) => patchToolCallFields(messages, toolUseId, { status: "pending" });
}

/**
 * `tool_executing` → the permission gate passed and the tool is now running.
 *
 * The positive evidence a persisted card needs. `tool_started` only means the input
 * finished parsing, and the auto-allow path writes `running` to the database without
 * broadcasting it — so before this frame existed a card had no way to learn that
 * execution had actually begun, and the client had to assume it.
 *
 * Structurally the same as `permissionResolvedPatch`'s allow branch, minus the
 * `startedAt` stamp: that field is the STREAM start (already set when the arguments
 * began arriving), and overwriting it here would restart the elapsed counter partway
 * through a call.
 */
export function toolExecutingPatch(toolUseId: string): LivePatch {
	return (messages) => patchToolCallFields(messages, toolUseId, { status: "running" });
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
	inputSummary?: SubagentToolInputSummary | null;
}): LivePatch {
	const header: SubagentToolCallHeader = {
		toolCallId: opts.toolCallId ?? null,
		toolUseId: opts.toolUseId,
		toolName: opts.toolName,
		status: opts.status,
		createdAt: opts.createdAt ?? opts.timing?.streamStartedAt ?? Date.now(),
		timing: opts.timing ?? null,
		// Conditional for the same reason as the chunked path's twin: the upsert merges
		// by spreading, so an explicit `undefined` would erase the label a previous
		// event set. `tool_completed` sends no summary of its own.
		...(opts.inputSummary ? { inputSummary: opts.inputSummary } : {}),
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
