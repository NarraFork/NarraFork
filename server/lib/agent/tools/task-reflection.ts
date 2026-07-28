import type { ProgressSnapshot } from "@shared/progress-phase";
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

export const TASK_REFLECTION_TYPE = "task_reflection";

export type TaskReflectionStatus =
	| "running"
	| "awaiting_user"
	| "confirmed"
	| "cancelled"
	| "aborted";

export type TaskReflectionDecidedBy = "reflection" | "user";

interface TaskReflectionMeta {
	narratorId: string;
	broadcastTargetId: string;
	parentToolUseId?: string;
	toolUseId: string;
	toolName: string;
	inputJson: Record<string, unknown>;
	mutations: unknown[];
	toolCallId?: string;
	abortController?: AbortController;
}

interface PendingTaskReflection extends TaskReflectionMeta {
	requestId: string;
	resolve: (decision: TaskReflectionDecision) => void;
	resolved: boolean;
	reflectionStoppedByUser?: boolean;
	startedAt: number;
}

const pendingTaskReflections = hotSafe<Map<string, PendingTaskReflection>>(
	"narrafork.pendingTaskReflections",
	() => new Map(),
);

function reflectionRoutingIdentity(pending: PendingTaskReflection) {
	return {
		ownerNarratorId: pending.narratorId,
		...(pending.narratorId !== pending.broadcastTargetId
			? { subagentNarratorId: pending.narratorId }
			: {}),
		...(pending.parentToolUseId ? { parentToolUseId: pending.parentToolUseId } : {}),
	};
}

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

/**
 * Broadcast one live progress tick for a running task reflection.
 *
 * Transient only — deliberately NOT persisted to `narratorToolCalls`: the
 * reflection loop reports on a throttled cadence, and writing the row per tick
 * would put repeated writes on the main-thread SQLite path. Clients that miss
 * ticks simply see the next one, and the terminal `*_resolved` event is the
 * authoritative state.
 */
export async function broadcastTaskReflectionProgress(
	requestId: string,
	snapshot: ProgressSnapshot,
): Promise<void> {
	const pending = pendingTaskReflections.get(requestId);
	if (!pending || pending.resolved) return;
	try {
		const { broadcastToNarrator } = await import("@server/websocket/narrator-ws");
		broadcastToNarrator(pending.broadcastTargetId, {
			type: "reflection_progress",
			narratorId: pending.broadcastTargetId,
			...reflectionRoutingIdentity(pending),
			requestId,
			toolUseId: pending.toolUseId,
			kind: TASK_REFLECTION_TYPE,
			phase: snapshot.phase,
			thinkingChars: snapshot.thinkingChars,
			outputChars: snapshot.outputChars,
		});
	} catch {
		// Progress is advisory; the terminal decision events carry the real state.
	}
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

function taskReflectionSuggestions(
	pending: Pick<PendingTaskReflection, "requestId" | "startedAt" | "mutations">,
	status: TaskReflectionStatus,
	reason?: string,
	nextSteps?: string,
) {
	return [
		{
			type: TASK_REFLECTION_TYPE,
			status,
			requestId: pending.requestId,
			startedAt: new Date(pending.startedAt).toISOString(),
			mutations: pending.mutations,
			...(status === "confirmed" || status === "cancelled" || status === "aborted"
				? { resolvedAt: new Date().toISOString() }
				: {}),
			...(reason ? { reason } : {}),
			...(nextSteps ? { nextSteps } : {}),
		},
	];
}

function statusReason(status: TaskReflectionStatus, reason?: string, nextSteps?: string): string {
	if (reason?.trim() && nextSteps?.trim())
		return `${reason.trim()}\n\nNext steps: ${nextSteps.trim()}`;
	if (reason?.trim()) return reason.trim();
	switch (status) {
		case "running":
			return "Task reflection is checking the protected task change";
		case "awaiting_user":
			return "Task reflection stopped; awaiting user decision";
		case "confirmed":
			return "Task reflection confirmed the protected task change";
		case "cancelled":
			return "Task reflection requested more work";
		case "aborted":
			return "Task reflection aborted";
	}
}

async function resolveTaskReflectionToolCallId(
	pending: PendingTaskReflection,
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

async function markTaskReflectionStatus(
	pending: PendingTaskReflection,
	status: TaskReflectionStatus,
	reason?: string,
	nextSteps?: string,
): Promise<void> {
	const message = statusReason(status, reason, nextSteps);
	try {
		const toolCallId = await resolveTaskReflectionToolCallId(pending);
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
					permissionSuggestions: taskReflectionSuggestions(pending, status, reason, nextSteps),
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
		// While the AI is reflecting we show a "reflecting" substatus; once we hand
		// control to the user (awaiting_user) we clear it so the UI shows a plain wait.
		const substatus = status === "running" ? ["reflecting"] : [];
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
				type: "task_reflection_started",
				narratorId: pending.broadcastTargetId,
				...reflectionRoutingIdentity(pending),
				requestId: pending.requestId,
				toolUseId: pending.toolUseId,
				toolName: pending.toolName,
				inputJson: pending.inputJson,
				mutations: pending.mutations,
				reason: message,
			});
		} else if (status === "awaiting_user") {
			broadcastToNarrator(pending.broadcastTargetId, {
				type: "task_reflection_stopped",
				narratorId: pending.broadcastTargetId,
				...reflectionRoutingIdentity(pending),
				requestId: pending.requestId,
				toolUseId: pending.toolUseId,
				toolName: pending.toolName,
				inputJson: pending.inputJson,
				mutations: pending.mutations,
				reason: message,
			});
		} else {
			broadcastToNarrator(pending.broadcastTargetId, {
				type: "task_reflection_resolved",
				narratorId: pending.broadcastTargetId,
				...reflectionRoutingIdentity(pending),
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

export async function markTaskReflectionStarted(requestId: string): Promise<boolean> {
	const pending = pendingTaskReflections.get(requestId);
	if (!pending || pending.resolved) return false;
	await markTaskReflectionStatus(pending, "running");
	return true;
}

async function resolveTaskReflection(
	requestId: string,
	decision: TaskReflectionDecision,
	status: Exclude<TaskReflectionStatus, "running" | "awaiting_user" | "aborted">,
	reason: string | undefined,
	nextSteps: string | undefined,
	decidedBy: TaskReflectionDecidedBy,
): Promise<boolean> {
	const pending = pendingTaskReflections.get(requestId);
	if (!pending || pending.resolved) return false;
	// Once the user has taken over, the AI reflection loop must not resolve the
	// decision — only the user's approve/deny may. (Mirrors danger reflection.)
	if (decidedBy === "reflection" && pending.reflectionStoppedByUser) return false;
	pending.resolved = true;
	await markTaskReflectionStatus(pending, status, reason, nextSteps);
	pendingTaskReflections.delete(requestId);
	pending.resolve(decision);
	return true;
}

export function cleanupTaskReflection(requestId: string): void {
	pendingTaskReflections.delete(requestId);
}

/** Whether a task reflection is still pending (used to route user approve/deny). */
export function hasPendingTaskReflection(requestId: string): boolean {
	return pendingTaskReflections.has(requestId);
}

export async function confirmTaskReflection(
	requestId: string,
	evidence: string,
	reflection?: string,
	decidedBy: TaskReflectionDecidedBy = "reflection",
): Promise<boolean> {
	const reason = reflection?.trim() || evidence.trim();
	return resolveTaskReflection(
		requestId,
		{ action: "confirm", evidence, reflection },
		"confirmed",
		reason,
		undefined,
		decidedBy,
	);
}

export async function reviseTaskReflection(
	requestId: string,
	feedback: string,
	nextSteps?: string,
	decidedBy: TaskReflectionDecidedBy = "reflection",
): Promise<boolean> {
	return resolveTaskReflection(
		requestId,
		{ action: "revise", feedback, nextSteps },
		"cancelled",
		feedback,
		nextSteps,
		decidedBy,
	);
}

/**
 * User takes over the AI reflection: stop the reflection loop and leave the
 * decision pending for the user to approve/deny (mirrors danger/plan takeover).
 */
export async function takeOverTaskReflection(requestId: string, reason?: string): Promise<boolean> {
	const pending = pendingTaskReflections.get(requestId);
	if (!pending || pending.resolved) return false;
	const message = reason?.trim() || "Task reflection stopped; awaiting user decision";
	pending.reflectionStoppedByUser = true;
	pending.abortController?.abort(new Error(message));
	await markTaskReflectionStatus(pending, "awaiting_user", message);
	return true;
}

export function isTaskReflectionWaitingForUser(requestId: string): boolean {
	return pendingTaskReflections.get(requestId)?.reflectionStoppedByUser === true;
}

export const taskReflectConfirmTool: ToolDefinition = {
	name: TASK_REFLECT_CONFIRM_TOOL_NAME,
	reflectionOnly: true,
	description:
		"Confirm that a protected task change is justified. Use this when the task is actually complete, or when deleting/unprotecting/replacing an assistant-created malformed non-task constraint is necessary and the underlying user intent remains enforced. User-created or unknown-origin commitments remain conservative.",
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
		"Reject a protected task change when evidence is missing, the task is incomplete, or user intent would be weakened. If an assistant-created protected entry is actually a standing behavior constraint with no terminal state, reject marking it done and direct the narrator to delete/unprotect it or replace it with a finite executable task instead.",
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
