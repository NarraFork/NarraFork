import { z } from "zod/v4";
import { hotSafe } from "../../hot-safe";
import type { ToolDefinition } from "../types";

export const EXIT_PLAN_CONFIRM_TOOL_NAME = "ExitPlanConfirm";
export const EXIT_PLAN_REVISE_TOOL_NAME = "ExitPlanRevise";
export const EXIT_PLAN_REFLECTION_TOOLS = new Set([
	EXIT_PLAN_CONFIRM_TOOL_NAME,
	EXIT_PLAN_REVISE_TOOL_NAME,
]);

export type ExitPlanReflectionDecision =
	| { action: "confirm"; reflection?: string }
	| { action: "revise"; feedback: string };

interface ExitPlanReflectionPending {
	resolve: (decision: ExitPlanReflectionDecision) => void;
	resolved: boolean;
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

export function createExitPlanReflectionDecision(
	requestId: string,
): Promise<ExitPlanReflectionDecision> {
	const { promise, resolve } = Promise.withResolvers<ExitPlanReflectionDecision>();
	pendingExitPlanReflections.set(requestId, { resolve, resolved: false });
	return promise;
}

function resolveExitPlanReflection(
	requestId: string,
	decision: ExitPlanReflectionDecision,
): boolean {
	const pending = pendingExitPlanReflections.get(requestId);
	if (!pending || pending.resolved) return false;
	pending.resolved = true;
	pendingExitPlanReflections.delete(requestId);
	pending.resolve(decision);
	return true;
}

export function cancelExitPlanReflection(requestId: string, feedback: string): boolean {
	return resolveExitPlanReflection(requestId, { action: "revise", feedback });
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
		const ok = resolveExitPlanReflection(requestId, {
			action: "confirm",
			reflection: typeof args.reflection === "string" ? args.reflection : undefined,
		});
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
		const ok = resolveExitPlanReflection(requestId, { action: "revise", feedback });
		return {
			output: ok
				? "ExitPlanMode reflection requested revision. The current plan will not be submitted yet."
				: "The ExitPlanMode reflection was already resolved by another decision path.",
			isError: !ok,
		};
	},
};
