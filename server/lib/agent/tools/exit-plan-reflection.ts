import { notifyHumanAttentionChanged } from "@server/services/human-attention-events";
import type { ProgressSnapshot } from "@shared/progress-phase";
import { z } from "zod/v4";
import { hotSafe } from "../../hot-safe";
import type { ToolDefinition } from "../types";
import { describeReflectionOnlyTool } from "./reflection-description";

export const EXIT_PLAN_CONFIRM_TOOL_NAME = "ExitPlanConfirm";
export const EXIT_PLAN_CONFIRM_COMPACT_TOOL_NAME = "ExitPlanConfirmAndCompact";
export const EXIT_PLAN_REVISE_TOOL_NAME = "ExitPlanRevise";
export const EXIT_PLAN_REFLECTION_TOOLS = new Set([
	EXIT_PLAN_CONFIRM_TOOL_NAME,
	EXIT_PLAN_REVISE_TOOL_NAME,
]);
export const PLAN_REFLECTION_TYPE = "plan_reflection";

export type PlanReflectionStatus =
	| "running"
	| "awaiting_user"
	| "confirmed"
	| "cancelled"
	| "aborted";

export type ExitPlanReflectionDecision =
	| { action: "confirm"; reflection?: string }
	| { action: "confirm_compact"; reflection?: string }
	| { action: "revise"; feedback: string };

interface ExitPlanReflectionMeta {
	narratorId: string;
	broadcastTargetId: string;
	parentToolUseId?: string;
	toolUseId: string;
	toolName: string;
	inputJson: Record<string, unknown>;
	toolCallId?: string;
	abortController?: AbortController;
}

interface ExitPlanReflectionPending extends ExitPlanReflectionMeta {
	requestId: string;
	resolve: (decision: ExitPlanReflectionDecision) => void;
	resolved: boolean;
	reflectionStoppedByUser?: boolean;
	startedAt: number;
}

const pendingExitPlanReflections = hotSafe<Map<string, ExitPlanReflectionPending>>(
	"narrafork.pendingExitPlanReflections",
	() => new Map(),
);

/**
 * Broadcast one live progress tick for a running plan reflection.
 *
 * Transient only (never written to `narratorToolCalls`) — see
 * `broadcastTaskReflectionProgress` for the reasoning.
 */
export async function broadcastPlanReflectionProgress(
	requestId: string,
	snapshot: ProgressSnapshot,
): Promise<void> {
	const pending = pendingExitPlanReflections.get(requestId);
	if (!pending || pending.resolved) return;
	try {
		const { broadcastReflectionFrame } = await import("@server/services/reflection-broadcast");
		broadcastReflectionFrame(pending, {
			type: "reflection_progress",
			requestId,
			toolUseId: pending.toolUseId,
			kind: PLAN_REFLECTION_TYPE,
			phase: snapshot.phase,
			thinkingChars: snapshot.thinkingChars,
			outputChars: snapshot.outputChars,
		});
	} catch {
		// Progress is advisory; the terminal decision events carry the real state.
	}
}

function getActiveExitPlanReflectionRequestId(
	ctx: Parameters<ToolDefinition["execute"]>[1],
): string | null {
	if (ctx.reflectionLoop?.kind !== "exitPlanMode") return null;
	return ctx.reflectionLoop.requestId ?? null;
}

function planReflectionSuggestions(
	pending: Pick<ExitPlanReflectionPending, "requestId" | "startedAt">,
	status: PlanReflectionStatus,
	reason?: string,
	compactAfter?: boolean,
) {
	return [
		{
			type: PLAN_REFLECTION_TYPE,
			status,
			requestId: pending.requestId,
			startedAt: new Date(pending.startedAt).toISOString(),
			...(status === "confirmed" || status === "cancelled" || status === "aborted"
				? { resolvedAt: new Date().toISOString() }
				: {}),
			...(reason ? { reason } : {}),
			...(compactAfter ? { compactAfter: true } : {}),
		},
	];
}

function statusReason(status: PlanReflectionStatus, reason?: string): string {
	if (reason?.trim()) return reason.trim();
	switch (status) {
		case "running":
			return "Plan reflection is checking this plan";
		case "awaiting_user":
			return "Plan reflection stopped; awaiting user decision";
		case "confirmed":
			return "Plan reflection confirmed the plan";
		case "cancelled":
			return "Plan reflection requested revision";
		case "aborted":
			return "Plan reflection aborted";
	}
}

async function resolveExitPlanReflectionToolCallId(
	pending: ExitPlanReflectionPending,
): Promise<string | null> {
	if (pending.toolCallId) return pending.toolCallId;
	try {
		const { and, eq } = await import("drizzle-orm");
		const { db } = await import("@server/db");
		const { narratorToolCalls } = await import("@server/db/schema");
		const row = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, pending.narratorId),
				eq(narratorToolCalls.toolUseId, pending.toolUseId),
			),
			columns: { id: true },
		});
		if (row?.id) {
			pending.toolCallId = row.id;
			return row.id;
		}
	} catch {
		// Best-effort lookup. The broadcast path below still updates live clients.
	}
	return null;
}

async function markExitPlanReflectionStatus(
	pending: ExitPlanReflectionPending,
	status: PlanReflectionStatus,
	reason?: string,
	compactAfter?: boolean,
): Promise<void> {
	const message = statusReason(status, reason);
	try {
		const toolCallId = await resolveExitPlanReflectionToolCallId(pending);
		if (toolCallId) {
			const { eq } = await import("drizzle-orm");
			const { db } = await import("@server/db");
			const { narratorToolCalls } = await import("@server/db/schema");
			await db
				.update(narratorToolCalls)
				.set({
					status:
						status === "confirmed"
							? "running"
							: status === "running" || status === "awaiting_user"
								? "pending"
								: "fail",
					inputJson: pending.inputJson,
					permissionDecisionReason: message,
					permissionSuggestions: planReflectionSuggestions(pending, status, message, compactAfter),
					...(status !== "running" && status !== "awaiting_user"
						? { permissionDecidedAt: new Date().toISOString() }
						: {}),
					...(status === "cancelled" || status === "aborted" ? { errorMessage: message } : {}),
				})
				.where(eq(narratorToolCalls.id, toolCallId));
		}
	} catch {
		// Status persistence is best-effort; the in-memory decision still drives execution.
	}

	try {
		const { narratorService } = await import("@server/services/narrator-service");
		const nextStatus = status === "running" || status === "awaiting_user" ? "waiting" : "working";
		const substatus = status === "running" ? ["reflecting"] : [];
		await narratorService.updateStatus(pending.narratorId, nextStatus, { substatus });
		// Broadcast the child gate to its parent card without changing the parent's
		// own status. Only explicit manual takeover is a user-facing wait there.
		if (pending.reflectionStoppedByUser && pending.broadcastTargetId !== pending.narratorId) {
			await narratorService.updateStatus(pending.broadcastTargetId, nextStatus, { substatus });
		}
	} catch {
		// Status update is best-effort; the in-memory decision still drives execution.
	}

	try {
		const { broadcastReflectionFrame } = await import("@server/services/reflection-broadcast");
		if (status === "running") {
			broadcastReflectionFrame(pending, {
				type: "plan_reflection_started",
				requestId: pending.requestId,
				toolUseId: pending.toolUseId,
				toolName: pending.toolName,
				inputJson: pending.inputJson,
				reason: message,
			});
		} else if (status === "awaiting_user") {
			broadcastReflectionFrame(pending, {
				type: "plan_reflection_stopped",
				requestId: pending.requestId,
				toolUseId: pending.toolUseId,
				toolName: pending.toolName,
				inputJson: pending.inputJson,
				reason: message,
			});
		} else {
			broadcastReflectionFrame(pending, {
				type: "plan_reflection_resolved",
				requestId: pending.requestId,
				toolUseId: pending.toolUseId,
				decision: status === "confirmed" ? "allow" : status === "aborted" ? "aborted" : "deny",
				reason: message,
			});
		}
	} catch {
		// Broadcast is best-effort; clients can recover from persisted tool-call state.
	}
}

export function createExitPlanReflectionDecision(
	requestId: string,
	meta: ExitPlanReflectionMeta,
): Promise<ExitPlanReflectionDecision> {
	const { promise, resolve } = Promise.withResolvers<ExitPlanReflectionDecision>();
	pendingExitPlanReflections.set(requestId, {
		...meta,
		requestId,
		resolve,
		resolved: false,
		startedAt: Date.now(),
	});
	notifyHumanAttentionChanged();
	return promise;
}

export async function markExitPlanReflectionStarted(requestId: string): Promise<boolean> {
	const pending = pendingExitPlanReflections.get(requestId);
	if (!pending || pending.resolved) return false;
	await markExitPlanReflectionStatus(pending, "running");
	return true;
}

async function resolveExitPlanReflection(
	requestId: string,
	decision: ExitPlanReflectionDecision,
	status: Exclude<PlanReflectionStatus, "running" | "awaiting_user" | "aborted">,
	reason?: string,
): Promise<boolean> {
	const pending = pendingExitPlanReflections.get(requestId);
	if (!pending || pending.resolved || pending.reflectionStoppedByUser) return false;
	pending.resolved = true;
	await markExitPlanReflectionStatus(
		pending,
		status,
		reason,
		decision.action === "confirm_compact",
	);
	if (pendingExitPlanReflections.delete(requestId)) notifyHumanAttentionChanged();
	pending.resolve(decision);
	return true;
}

export async function confirmExitPlanReflection(
	requestId: string,
	reflection?: string,
): Promise<boolean> {
	return resolveExitPlanReflection(
		requestId,
		{ action: "confirm", reflection },
		"confirmed",
		reflection,
	);
}

export async function confirmAndCompactExitPlanReflection(
	requestId: string,
	reflection?: string,
): Promise<boolean> {
	const message =
		reflection?.trim() ||
		"Plan reflection confirmed the plan and requested a context reset before execution.";
	return resolveExitPlanReflection(
		requestId,
		{ action: "confirm_compact", reflection: message },
		"confirmed",
		message,
	);
}

export async function cancelExitPlanReflection(
	requestId: string,
	feedback: string,
): Promise<boolean> {
	return resolveExitPlanReflection(
		requestId,
		{ action: "revise", feedback },
		"cancelled",
		feedback,
	);
}

export async function takeOverExitPlanReflection(
	requestId: string,
	reason?: string,
): Promise<boolean> {
	const pending = pendingExitPlanReflections.get(requestId);
	if (!pending || pending.resolved) return false;
	const message = reason?.trim() || "Plan reflection stopped; awaiting user decision";
	pending.reflectionStoppedByUser = true;
	pending.abortController?.abort(new Error(message));
	await markExitPlanReflectionStatus(pending, "awaiting_user", message);
	// This synthetic gate is NOT approvable; the subsequent real permission registration
	// sends its own invalidation once it is discoverable.
	notifyHumanAttentionChanged();
	return true;
}

export function isExitPlanReflectionWaitingForUser(requestId: string): boolean {
	return pendingExitPlanReflections.get(requestId)?.reflectionStoppedByUser === true;
}

/**
 * The narrator owning a pending plan reflection, for authorizing a user decision.
 *
 * The plan gate's request id (`exit_plan_*`) is SYNTHETIC — it never appears as a
 * `narrator_tool_calls` row id — so a resolver that only knows permission rows and
 * the danger/task registries reports this gate as unresolvable and the takeover
 * route answers 404 "Narrator not found: unknown" before the handler ever runs.
 * See `resolveDecisionNarratorId` in narrator-permission.ts.
 */
export function getExitPlanReflectionNarratorId(requestId: string): string | null {
	return pendingExitPlanReflections.get(requestId)?.narratorId ?? null;
}

export function cleanupExitPlanReflection(requestId: string): void {
	if (pendingExitPlanReflections.delete(requestId)) notifyHumanAttentionChanged();
}

export const exitPlanConfirmTool: ToolDefinition = {
	name: EXIT_PLAN_CONFIRM_TOOL_NAME,
	reflectionOnly: true,
	description: describeReflectionOnlyTool(
		"Confirm that the ExitPlanMode plan is ready to present to the user for approval. " +
			"This is only for an active ExitPlanMode plan reflection, not the ordinary plan-mode turn. " +
			"In the ordinary plan-mode turn, call ExitPlanMode to submit the plan; do not call this " +
			"reflection decision tool. Use it only after checking that the plan is concrete, actionable, " +
			"and has no obvious gaps.",
	),
	parameters: z.object({
		confirm: z.literal(true).describe("Must be true to confirm the ExitPlanMode plan."),
		reflection: z
			.string()
			.optional()
			.describe("Brief explanation of why the plan is ready for user approval."),
	}),
	execute: async (args, ctx) => {
		const requestId = getActiveExitPlanReflectionRequestId(ctx);
		if (!requestId) {
			return {
				output: "No ExitPlanMode reflection is active for this reflection loop.",
				isError: true,
			};
		}
		const ok = await confirmExitPlanReflection(
			requestId,
			typeof args.reflection === "string" ? args.reflection : undefined,
		);
		return {
			output: ok
				? "ExitPlanMode reflection confirmed. The plan will now be submitted for user approval."
				: "The ExitPlanMode reflection was already resolved by another decision path.",
			isError: !ok,
		};
	},
};

export const exitPlanConfirmAndCompactTool: ToolDefinition = {
	name: EXIT_PLAN_CONFIRM_COMPACT_TOOL_NAME,
	reflectionOnly: true,
	description: describeReflectionOnlyTool(
		"Confirm that the ExitPlanMode plan is ready and should be approved with a context reset. " +
			"This is only for an active ExitPlanMode plan reflection, not the ordinary plan-mode turn. " +
			"In the ordinary plan-mode turn, call ExitPlanMode to submit the plan; do not call this " +
			"reflection decision tool. Use it only when the plan contains enough detail to continue safely " +
			"after clearing prior conversation context.",
	),
	parameters: z.object({
		confirm: z.literal(true).describe("Must be true to confirm and reset context."),
		reflection: z
			.string()
			.optional()
			.describe(
				"Brief explanation of why the plan is ready and safe to execute after a context reset.",
			),
	}),
	execute: async (args, ctx) => {
		const requestId = getActiveExitPlanReflectionRequestId(ctx);
		if (!requestId) {
			return {
				output: "No ExitPlanMode reflection is active for this reflection loop.",
				isError: true,
			};
		}
		const ok = await confirmAndCompactExitPlanReflection(
			requestId,
			typeof args.reflection === "string" ? args.reflection : undefined,
		);
		return {
			output: ok
				? "ExitPlanMode reflection confirmed. The plan will be approved and context will be reset before execution."
				: "The ExitPlanMode reflection was already resolved by another decision path.",
			isError: !ok,
		};
	},
};

export const exitPlanReviseTool: ToolDefinition = {
	name: EXIT_PLAN_REVISE_TOOL_NAME,
	reflectionOnly: true,
	description: describeReflectionOnlyTool(
		"Reject the current ExitPlanMode plan before it reaches the user. This is only for an active " +
			"ExitPlanMode plan reflection, not the ordinary plan-mode turn. In the ordinary plan-mode turn, " +
			"call ExitPlanMode to submit the plan; do not call this reflection decision tool. Use it when the " +
			"plan needs more detail, has unresolved decisions, or should be revised first.",
	),
	parameters: z.object({
		confirm: z.literal(true).describe("Must be true to request plan revision."),
		feedback: z
			.string()
			.min(1)
			.describe("Concise, actionable feedback for what must be revised before ExitPlanMode."),
	}),
	execute: async (args, ctx) => {
		const requestId = getActiveExitPlanReflectionRequestId(ctx);
		if (!requestId) {
			return {
				output: "No ExitPlanMode reflection is active for this reflection loop.",
				isError: true,
			};
		}
		const feedback = typeof args.feedback === "string" ? args.feedback.trim() : "";
		if (!feedback) {
			return { output: "The 'feedback' parameter is required.", isError: true };
		}
		const ok = await cancelExitPlanReflection(requestId, feedback);
		return {
			output: ok
				? "ExitPlanMode reflection requested revision. The current plan will not be submitted yet."
				: "The ExitPlanMode reflection was already resolved by another decision path.",
			isError: !ok,
		};
	},
};
