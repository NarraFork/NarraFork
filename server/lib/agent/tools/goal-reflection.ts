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
	| { action: "revise"; feedback: string };

interface GoalCompletionReflectionPending {
	requestId: string;
	resolve: (decision: GoalCompletionReflectionDecision) => void;
	resolved: boolean;
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

export function createGoalCompletionReflectionDecision(
	requestId: string,
): Promise<GoalCompletionReflectionDecision> {
	const { promise, resolve } = Promise.withResolvers<GoalCompletionReflectionDecision>();
	pendingGoalCompletionReflections.set(requestId, { requestId, resolve, resolved: false });
	return promise;
}

async function resolveGoalCompletionReflection(
	requestId: string,
	decision: GoalCompletionReflectionDecision,
): Promise<boolean> {
	const pending = pendingGoalCompletionReflections.get(requestId);
	if (!pending || pending.resolved) return false;
	pending.resolved = true;
	pendingGoalCompletionReflections.delete(requestId);
	pending.resolve(decision);
	return true;
}

export async function confirmGoalCompletionReflection(
	requestId: string,
	evidence: string,
	reflection?: string,
): Promise<boolean> {
	return resolveGoalCompletionReflection(requestId, { action: "confirm", evidence, reflection });
}

export async function cancelGoalCompletionReflection(
	requestId: string,
	feedback: string,
): Promise<boolean> {
	return resolveGoalCompletionReflection(requestId, { action: "revise", feedback });
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
			.describe("Concise, actionable feedback describing what is missing before completion."),
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
		const ok = await cancelGoalCompletionReflection(requestId, feedback);
		return {
			output: ok
				? "Goal-completion reflection requested more work. The active goal will not be marked complete yet."
				: "The goal-completion reflection was already resolved by another decision path.",
			isError: !ok,
		};
	},
};
