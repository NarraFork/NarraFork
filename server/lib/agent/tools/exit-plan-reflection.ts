import { z } from "zod/v4";
import { hotSafe } from "../../hot-safe";
import type { ToolDefinition } from "../types";

export const EXIT_PLAN_CONFIRM_TOOL_NAME = "ExitPlanConfirm";
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
	| { action: "revise"; feedback: string };

interface ExitPlanReflectionMeta {
	narratorId: string;
	broadcastTargetId: string;
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
					permissionDecisionReason: message,
					permissionSuggestions: planReflectionSuggestions(pending, status, message),
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
		const { broadcastToNarrator } = await import("@server/websocket/narrator-ws");
		if (status === "running") {
			broadcastToNarrator(pending.broadcastTargetId, {
				type: "plan_reflection_started",
				narratorId: pending.broadcastTargetId,
				requestId: pending.requestId,
				toolUseId: pending.toolUseId,
				toolName: pending.toolName,
				inputJson: pending.inputJson,
				reason: message,
			});
		} else if (status === "awaiting_user") {
			broadcastToNarrator(pending.broadcastTargetId, {
				type: "plan_reflection_stopped",
				narratorId: pending.broadcastTargetId,
				requestId: pending.requestId,
				toolUseId: pending.toolUseId,
				toolName: pending.toolName,
				inputJson: pending.inputJson,
				reason: message,
			});
		} else {
			broadcastToNarrator(pending.broadcastTargetId, {
				type: "plan_reflection_resolved",
				narratorId: pending.broadcastTargetId,
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
	await markExitPlanReflectionStatus(pending, status, reason);
	pendingExitPlanReflections.delete(requestId);
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
	return true;
}

export function isExitPlanReflectionWaitingForUser(requestId: string): boolean {
	return pendingExitPlanReflections.get(requestId)?.reflectionStoppedByUser === true;
}

export function cleanupExitPlanReflection(requestId: string): void {
	pendingExitPlanReflections.delete(requestId);
}

export const exitPlanConfirmTool: ToolDefinition = {
	name: EXIT_PLAN_CONFIRM_TOOL_NAME,
	reflectionOnly: true,
	description:
		"Confirm that the ExitPlanMode plan is ready to present to the user for approval. " +
		"Use this only after checking that the plan is concrete, actionable, and has no obvious gaps.",
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

export const exitPlanReviseTool: ToolDefinition = {
	name: EXIT_PLAN_REVISE_TOOL_NAME,
	reflectionOnly: true,
	description:
		"Reject the current ExitPlanMode plan before it reaches the user. Use this when the plan " +
		"needs more detail, has unresolved decisions, or should be revised first.",
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
