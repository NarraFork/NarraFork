import { z } from "zod/v4";
import { hotSafe } from "../../hot-safe";
import type { ToolDefinition } from "../types";

export const GOAL_COMPLETE_CONFIRM_TOOL_NAME = "GoalCompleteConfirm";
export const GOAL_COMPLETE_REVISE_TOOL_NAME = "GoalCompleteRevise";
export const GOAL_COMPLETION_REFLECTION_TOOLS = new Set([
	GOAL_COMPLETE_CONFIRM_TOOL_NAME,
	GOAL_COMPLETE_REVISE_TOOL_NAME,
]);

export type GoalCompletionReflectionDecision =
	| { action: "confirm"; evidence: string; reflection?: string }
	| { action: "revise"; feedback: string; nextSteps?: string };

export const GOAL_REFLECTION_TYPE = "goal_reflection";

export type GoalCompletionReflectionStatus = "running" | "confirmed" | "cancelled" | "aborted";

interface GoalCompletionReflectionMeta {
	narratorId: string;
	broadcastTargetId: string;
	toolUseId: string;
	toolName: string;
	inputJson: Record<string, unknown>;
	activeGoal: unknown;
	toolCallId?: string;
}

interface GoalCompletionReflectionPending extends GoalCompletionReflectionMeta {
	requestId: string;
	resolve: (decision: GoalCompletionReflectionDecision) => void;
	resolved: boolean;
	startedAt: number;
}

const pendingGoalCompletionReflections = hotSafe<Map<string, GoalCompletionReflectionPending>>(
	"narrafork.pendingGoalCompletionReflections",
	() => new Map(),
);

const goalCompletionReflectionGrants = hotSafe<Set<string>>(
	"narrafork.goalCompletionReflectionGrants",
	() => new Set(),
);

function goalCompletionGrantKey(narratorId: string, toolUseId: string): string {
	return `${narratorId}:${toolUseId}`;
}

export function grantGoalCompletionReflection(narratorId: string, toolUseId: string): void {
	goalCompletionReflectionGrants.add(goalCompletionGrantKey(narratorId, toolUseId));
}

export function consumeGoalCompletionReflectionGrant(
	narratorId: string,
	toolUseId?: string,
): boolean {
	if (!toolUseId) return false;
	const key = goalCompletionGrantKey(narratorId, toolUseId);
	const granted = goalCompletionReflectionGrants.has(key);
	if (granted) goalCompletionReflectionGrants.delete(key);
	return granted;
}

function getActiveGoalCompletionReflectionRequestId(
	ctx: Parameters<ToolDefinition["execute"]>[1],
): string | null {
	if (ctx.reflectionLoop?.kind !== "goalCompletion") return null;
	return ctx.reflectionLoop.requestId ?? null;
}

function goalReflectionSuggestions(
	pending: Pick<GoalCompletionReflectionPending, "requestId" | "startedAt" | "activeGoal">,
	status: GoalCompletionReflectionStatus,
	reason?: string,
	nextSteps?: string,
) {
	return [
		{
			type: GOAL_REFLECTION_TYPE,
			status,
			requestId: pending.requestId,
			startedAt: new Date(pending.startedAt).toISOString(),
			activeGoal: pending.activeGoal,
			...(status === "confirmed" || status === "cancelled" || status === "aborted"
				? { resolvedAt: new Date().toISOString() }
				: {}),
			...(reason ? { reason } : {}),
			...(nextSteps ? { nextSteps } : {}),
		},
	];
}

function statusReason(
	status: GoalCompletionReflectionStatus,
	reason?: string,
	nextSteps?: string,
): string {
	if (reason?.trim() && nextSteps?.trim())
		return `${reason.trim()}\n\nNext steps: ${nextSteps.trim()}`;
	if (reason?.trim()) return reason.trim();
	switch (status) {
		case "running":
			return "Goal completion reflection is checking the active goal";
		case "confirmed":
			return "Goal completion reflection confirmed the active goal";
		case "cancelled":
			return "Goal completion reflection requested more work";
		case "aborted":
			return "Goal completion reflection aborted";
	}
}

async function resolveGoalReflectionToolCallId(
	pending: GoalCompletionReflectionPending,
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
		// Best-effort lookup. Live clients still receive websocket updates.
	}
	return null;
}

async function markGoalCompletionReflectionStatus(
	pending: GoalCompletionReflectionPending,
	status: GoalCompletionReflectionStatus,
	reason?: string,
	nextSteps?: string,
): Promise<void> {
	const message = statusReason(status, reason, nextSteps);
	try {
		const toolCallId = await resolveGoalReflectionToolCallId(pending);
		if (toolCallId) {
			const { eq } = await import("drizzle-orm");
			const { db } = await import("@server/db");
			const { narratorToolCalls } = await import("@server/db/schema");
			await db
				.update(narratorToolCalls)
				.set({
					status: status === "confirmed" ? "running" : status === "running" ? "pending" : "fail",
					inputJson: pending.inputJson,
					permissionDecisionReason: message,
					permissionSuggestions: goalReflectionSuggestions(pending, status, reason, nextSteps),
					...(status !== "running" ? { permissionDecidedAt: new Date().toISOString() } : {}),
					...(status === "cancelled" || status === "aborted" ? { errorMessage: message } : {}),
				})
				.where(eq(narratorToolCalls.id, toolCallId));
		}
	} catch {
		// Status persistence is best-effort; the in-memory decision still drives execution.
	}

	try {
		const { narratorService } = await import("@server/services/narrator-service");
		const nextStatus = status === "running" ? "waiting" : "working";
		const substatus = status === "running" ? ["silent_notification", "reflecting"] : [];
		await narratorService.updateStatus(pending.narratorId, nextStatus, { substatus });
		if (pending.broadcastTargetId !== pending.narratorId) {
			await narratorService.updateStatus(pending.broadcastTargetId, nextStatus, { substatus });
		}
	} catch {
		// Status update is best-effort; the in-memory decision still drives execution.
	}

	try {
		const { broadcastToNarrator } = await import("@server/websocket/narrator-ws");
		if (status === "running") {
			broadcastToNarrator(pending.broadcastTargetId, {
				type: "goal_reflection_started",
				narratorId: pending.broadcastTargetId,
				requestId: pending.requestId,
				toolUseId: pending.toolUseId,
				toolName: pending.toolName,
				inputJson: pending.inputJson,
				activeGoal: pending.activeGoal,
				reason: message,
			});
		} else {
			broadcastToNarrator(pending.broadcastTargetId, {
				type: "goal_reflection_resolved",
				narratorId: pending.broadcastTargetId,
				requestId: pending.requestId,
				toolUseId: pending.toolUseId,
				decision: status === "confirmed" ? "allow" : status === "aborted" ? "aborted" : "deny",
				reason: reason ?? message,
				nextSteps,
			});
		}
	} catch {
		// Broadcast is best-effort; clients can recover from persisted tool-call state.
	}
}

export function createGoalCompletionReflectionDecision(
	requestId: string,
	meta: GoalCompletionReflectionMeta,
): Promise<GoalCompletionReflectionDecision> {
	const { promise, resolve } = Promise.withResolvers<GoalCompletionReflectionDecision>();
	pendingGoalCompletionReflections.set(requestId, {
		...meta,
		requestId,
		resolve,
		resolved: false,
		startedAt: Date.now(),
	});
	return promise;
}

export async function markGoalCompletionReflectionStarted(requestId: string): Promise<boolean> {
	const pending = pendingGoalCompletionReflections.get(requestId);
	if (!pending || pending.resolved) return false;
	await markGoalCompletionReflectionStatus(pending, "running");
	return true;
}

async function resolveGoalCompletionReflection(
	requestId: string,
	decision: GoalCompletionReflectionDecision,
	status: Exclude<GoalCompletionReflectionStatus, "running" | "aborted">,
	reason?: string,
	nextSteps?: string,
): Promise<boolean> {
	const pending = pendingGoalCompletionReflections.get(requestId);
	if (!pending || pending.resolved) return false;
	pending.resolved = true;
	await markGoalCompletionReflectionStatus(pending, status, reason, nextSteps);
	pendingGoalCompletionReflections.delete(requestId);
	pending.resolve(decision);
	return true;
}

export async function confirmGoalCompletionReflection(
	requestId: string,
	evidence: string,
	reflection?: string,
): Promise<boolean> {
	const reason = reflection?.trim() || evidence.trim();
	return resolveGoalCompletionReflection(
		requestId,
		{ action: "confirm", evidence, reflection },
		"confirmed",
		reason,
	);
}

export async function cancelGoalCompletionReflection(
	requestId: string,
	feedback: string,
	nextSteps?: string,
): Promise<boolean> {
	return resolveGoalCompletionReflection(
		requestId,
		{ action: "revise", feedback, nextSteps },
		"cancelled",
		feedback,
		nextSteps,
	);
}

export function cleanupGoalCompletionReflection(requestId: string): void {
	pendingGoalCompletionReflections.delete(requestId);
}

export const goalCompleteConfirmTool: ToolDefinition = {
	name: GOAL_COMPLETE_CONFIRM_TOOL_NAME,
	reflectionOnly: true,
	description:
		"Confirm that the active user-set goal has actually been achieved. Use this only after checking the conversation/tool evidence against every requirement and finding no remaining work.",
	parameters: z.object({
		confirm: z.literal(true).describe("Must be true to confirm goal completion."),
		evidence: z
			.string()
			.min(20)
			.describe(
				"Concrete evidence that every material requirement in the active goal is satisfied.",
			),
		reflection: z
			.string()
			.optional()
			.describe("Optional brief explanation of why the goal is safe to mark complete."),
	}),
	execute: async (args, ctx) => {
		const requestId = getActiveGoalCompletionReflectionRequestId(ctx);
		if (!requestId) {
			return {
				output: "No goal-completion reflection is active for this reflection loop.",
				isError: true,
			};
		}
		const evidence = typeof args.evidence === "string" ? args.evidence.trim() : "";
		if (evidence.length < 20) {
			return {
				output: "The 'evidence' parameter must contain concrete completion evidence.",
				isError: true,
			};
		}
		const ok = await confirmGoalCompletionReflection(
			requestId,
			evidence,
			typeof args.reflection === "string" ? args.reflection.trim() : undefined,
		);
		return {
			output: ok
				? "Goal-completion reflection confirmed. The active goal may now be marked complete."
				: "The goal-completion reflection was already resolved by another decision path.",
			isError: !ok,
		};
	},
};

export const goalCompleteReviseTool: ToolDefinition = {
	name: GOAL_COMPLETE_REVISE_TOOL_NAME,
	reflectionOnly: true,
	description:
		"Reject an attempted goal completion. Use this when evidence is missing, uncertainty remains, or any user-set requirement still needs work.",
	parameters: z.object({
		confirm: z.literal(true).describe("Must be true to reject goal completion."),
		feedback: z
			.string()
			.min(1)
			.describe("Concise feedback describing why the goal cannot be completed yet."),
		nextSteps: z
			.string()
			.min(1)
			.describe(
				"Concrete next action for the main narrator: what to verify, implement, ask, or do before trying UpdateGoal again.",
			),
	}),
	execute: async (args, ctx) => {
		const requestId = getActiveGoalCompletionReflectionRequestId(ctx);
		if (!requestId) {
			return {
				output: "No goal-completion reflection is active for this reflection loop.",
				isError: true,
			};
		}
		const feedback = typeof args.feedback === "string" ? args.feedback.trim() : "";
		if (!feedback) {
			return { output: "The 'feedback' parameter is required.", isError: true };
		}
		const nextSteps = typeof args.nextSteps === "string" ? args.nextSteps.trim() : "";
		if (!nextSteps) {
			return { output: "The 'nextSteps' parameter is required.", isError: true };
		}
		const ok = await cancelGoalCompletionReflection(requestId, feedback, nextSteps);
		return {
			output: ok
				? "Goal-completion reflection requested more work. The active goal will not be marked complete yet."
				: "The goal-completion reflection was already resolved by another decision path.",
			isError: !ok,
		};
	},
};
