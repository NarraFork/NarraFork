import { z } from "zod/v4";
import { hotSafe } from "../../hot-safe";
import type { ToolDefinition } from "../types";

export const TASK_REFLECT_CONFIRM_TOOL_NAME = "TaskReflectConfirm";
export const TASK_REFLECT_REVISE_TOOL_NAME = "TaskReflectRevise";
export const TASK_REFLECTION_TOOLS = new Set([
	TASK_REFLECT_CONFIRM_TOOL_NAME,
	TASK_REFLECT_REVISE_TOOL_NAME,
]);

export type TaskReflectionDecision =
	| { action: "confirm"; evidence: string; reflection?: string }
	| { action: "revise"; feedback: string; nextSteps?: string };

interface TaskReflectionMeta {
	narratorId: string;
	toolUseId: string;
	toolName: string;
	inputJson: Record<string, unknown>;
	mutations: unknown[];
}

interface PendingTaskReflection extends TaskReflectionMeta {
	requestId: string;
	resolve: (decision: TaskReflectionDecision) => void;
	resolved: boolean;
	startedAt: number;
}

const pendingTaskReflections = hotSafe<Map<string, PendingTaskReflection>>(
	"narrafork.pendingTaskReflections",
	() => new Map(),
);

const taskReflectionGrants = hotSafe<Set<string>>(
	"narrafork.taskReflectionGrants",
	() => new Set(),
);

function grantKey(narratorId: string, toolUseId: string): string {
	return `${narratorId}:${toolUseId}`;
}

export function grantTaskReflection(narratorId: string, toolUseId: string): void {
	taskReflectionGrants.add(grantKey(narratorId, toolUseId));
}

export function consumeTaskReflectionGrant(narratorId: string, toolUseId?: string): boolean {
	if (!toolUseId) return false;
	const key = grantKey(narratorId, toolUseId);
	const granted = taskReflectionGrants.has(key);
	if (granted) taskReflectionGrants.delete(key);
	return granted;
}

function getActiveTaskReflectionRequestId(
	ctx: Parameters<ToolDefinition["execute"]>[1],
): string | null {
	if (ctx.reflectionLoop?.kind !== "taskReflection") return null;
	return ctx.reflectionLoop.requestId ?? null;
}

export function createTaskReflectionDecision(
	requestId: string,
	meta: TaskReflectionMeta,
): Promise<TaskReflectionDecision> {
	const { promise, resolve } = Promise.withResolvers<TaskReflectionDecision>();
	pendingTaskReflections.set(requestId, {
		...meta,
		requestId,
		resolve,
		resolved: false,
		startedAt: Date.now(),
	});
	return promise;
}

async function resolveTaskReflection(
	requestId: string,
	decision: TaskReflectionDecision,
): Promise<boolean> {
	const pending = pendingTaskReflections.get(requestId);
	if (!pending || pending.resolved) return false;
	pending.resolved = true;
	pendingTaskReflections.delete(requestId);
	pending.resolve(decision);
	return true;
}

export function cleanupTaskReflection(requestId: string): void {
	pendingTaskReflections.delete(requestId);
}

export async function confirmTaskReflection(
	requestId: string,
	evidence: string,
	reflection?: string,
): Promise<boolean> {
	return resolveTaskReflection(requestId, { action: "confirm", evidence, reflection });
}

export async function reviseTaskReflection(
	requestId: string,
	feedback: string,
	nextSteps?: string,
): Promise<boolean> {
	return resolveTaskReflection(requestId, { action: "revise", feedback, nextSteps });
}

export const taskReflectConfirmTool: ToolDefinition = {
	name: TASK_REFLECT_CONFIRM_TOOL_NAME,
	reflectionOnly: true,
	description:
		"Confirm that a protected task change is justified. Use this only when the protected task is actually complete, or the proposed protected-task deletion/replacement is necessary and does not weaken the user's intent.",
	parameters: z.object({
		confirm: z.literal(true).describe("Must be true to confirm the protected task change."),
		evidence: z
			.string()
			.min(20)
			.describe("Concrete evidence or reasoning that justifies the protected task change."),
		reflection: z
			.string()
			.optional()
			.describe("Optional brief explanation of why the protected task change is safe."),
	}),
	execute: async (args, ctx) => {
		const requestId = getActiveTaskReflectionRequestId(ctx);
		if (!requestId) return { output: "No taskReflection is active.", isError: true };
		const evidence = typeof args.evidence === "string" ? args.evidence.trim() : "";
		if (evidence.length < 20) {
			return { output: "The 'evidence' parameter must contain concrete evidence.", isError: true };
		}
		const ok = await confirmTaskReflection(
			requestId,
			evidence,
			typeof args.reflection === "string" ? args.reflection.trim() : undefined,
		);
		return {
			output: ok
				? "taskReflection confirmed. The protected task change may proceed."
				: "The taskReflection was already resolved by another decision path.",
			isError: !ok,
		};
	},
};

export const taskReflectReviseTool: ToolDefinition = {
	name: TASK_REFLECT_REVISE_TOOL_NAME,
	reflectionOnly: true,
	description:
		"Reject a protected task change. Use this when evidence is missing, the task is not complete, or the change weakens the user's protected intent.",
	parameters: z.object({
		confirm: z.literal(true).describe("Must be true to reject the protected task change."),
		feedback: z.string().min(1).describe("Why the protected task change cannot proceed."),
		nextSteps: z
			.string()
			.min(1)
			.describe("Concrete next action the main narrator should take before trying again."),
	}),
	execute: async (args, ctx) => {
		const requestId = getActiveTaskReflectionRequestId(ctx);
		if (!requestId) return { output: "No taskReflection is active.", isError: true };
		const feedback = typeof args.feedback === "string" ? args.feedback.trim() : "";
		const nextSteps = typeof args.nextSteps === "string" ? args.nextSteps.trim() : "";
		if (!feedback || !nextSteps) {
			return { output: "feedback and nextSteps are required.", isError: true };
		}
		const ok = await reviseTaskReflection(requestId, feedback, nextSteps);
		return {
			output: ok
				? "taskReflection requested more work. The protected task change will not proceed yet."
				: "The taskReflection was already resolved by another decision path.",
			isError: !ok,
		};
	},
};
