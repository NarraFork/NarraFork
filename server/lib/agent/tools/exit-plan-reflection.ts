import { notifyHumanAttentionChanged } from "@server/services/human-attention-events";
import type { ProgressSnapshot } from "@shared/progress-phase";
import { z } from "zod/v4";
import { hotSafe } from "../../hot-safe";
import type { ToolDefinition } from "../types";
import { describeReflectionOnlyTool, PLAN_REVIEW_TOOL_NAME } from "./reflection-description";

export const EXIT_PLAN_CONFIRM_TOOL_NAME = "ExitPlanConfirm";
export const EXIT_PLAN_CONFIRM_COMPACT_TOOL_NAME = "ExitPlanConfirmAndCompact";
export const EXIT_PLAN_REVISE_TOOL_NAME = "ExitPlanRevise";
export const EXIT_PLAN_REFLECTION_TOOLS = new Set([
	EXIT_PLAN_CONFIRM_TOOL_NAME,
	EXIT_PLAN_REVISE_TOOL_NAME,
]);
/**
 * The one tool of an outline plan's review (outline P2 PR 8b, D48 Q1): it leaves comments under
 * the plan instead of sending it back. Spec sessions keep the three tools above.
 */
export { PLAN_REVIEW_TOOL_NAME };
export const PLAN_REFLECTION_TYPE = "plan_reflection";

export type PlanReflectionStatus =
	| "running"
	| "awaiting_user"
	| "confirmed"
	| "cancelled"
	| "failed"
	| "aborted";

export type ExitPlanReflectionDecision =
	| { action: "confirm"; reflection?: string }
	| { action: "confirm_compact"; reflection?: string }
	| { action: "revise"; feedback: string }
	/**
	 * An outline plan's review handed it to a person (PR 8b): it left comments (`input`: the
	 * submission with them), or it could not finish. The call waits for a person like any
	 * ExitPlanMode; nothing goes back to the agent.
	 */
	| { action: "human"; reason: string; input?: Record<string, unknown> };

interface ExitPlanReflectionMeta {
	narratorId: string;
	broadcastTargetId: string;
	parentToolUseId?: string;
	toolUseId: string;
	toolName: string;
	inputJson: Record<string, unknown>;
	toolCallId?: string;
	abortController?: AbortController;
	/** Original persisted start time when restoring this gate. */
	restoredStartedAt?: string;
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
			...(status === "confirmed" ||
			status === "cancelled" ||
			status === "failed" ||
			status === "aborted"
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
		case "failed":
			return "Plan reflection failed before reaching a decision";
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
					// Only the custom reflection text goes into `reason`. Status defaults
					// stay in `permissionDecisionReason` for details/logs; the notice
					// classifies and localizes them at display time (reflection-reason.ts).
					permissionSuggestions: planReflectionSuggestions(pending, status, reason, compactAfter),
					// A confirmed reflection skips the normal permission handler. Persist its
					// approval source too, so the final-start gate can verify the receipt.
					...(status === "confirmed" ? { permissionDecidedBy: "reflection" } : {}),
					...(status !== "running" && status !== "awaiting_user"
						? { permissionDecidedAt: new Date().toISOString() }
						: {}),
					...(status === "cancelled" || status === "failed" || status === "aborted"
						? { errorMessage: message }
						: {}),
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
				decision:
					status === "confirmed"
						? "allow"
						: status === "failed"
							? "failed"
							: status === "aborted"
								? "aborted"
								: "deny",
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
		startedAt:
			meta.restoredStartedAt && Number.isFinite(Date.parse(meta.restoredStartedAt))
				? Date.parse(meta.restoredStartedAt)
				: Date.now(),
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
	options?: { failed?: boolean },
): Promise<boolean> {
	return resolveExitPlanReflection(
		requestId,
		{ action: "revise", feedback },
		options?.failed ? "failed" : "cancelled",
		feedback,
	);
}

/**
 * Hand an outline plan's review over to a person (PR 8b; see {@link ExitPlanReflectionDecision}):
 * persisted as waiting for the user (with `input`, the submission as it now is, when given), so a
 * restart asks the person, not the reviewer. False when the gate was decided or taken over.
 */
export async function handOverExitPlanReflection(
	requestId: string,
	handover: { reason: string; input?: Record<string, unknown> },
): Promise<boolean> {
	const pending = pendingExitPlanReflections.get(requestId);
	if (!pending || pending.resolved || pending.reflectionStoppedByUser) return false;
	pending.resolved = true;
	if (handover.input) pending.inputJson = handover.input;
	await markExitPlanReflectionStatus(pending, "awaiting_user", handover.reason);
	if (pendingExitPlanReflections.delete(requestId)) notifyHumanAttentionChanged();
	pending.resolve({
		action: "human",
		reason: handover.reason,
		...(handover.input ? { input: handover.input } : {}),
	});
	return true;
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

export const planReviewTool: ToolDefinition = {
	name: PLAN_REVIEW_TOOL_NAME,
	reflectionOnly: true,
	description: describeReflectionOnlyTool(
		"Give the verdict of a plan review of a plan in the outline (the plan an outline session's " +
			"ExitPlanMode submitted). This is only for an active plan review, not the ordinary plan-mode " +
			"turn: in the ordinary plan-mode turn, call ExitPlanMode to submit the plan; do not call this " +
			'review tool. verdict "ok" with no comments: you have no concerns, and the plan is approved as ' +
			'a draft on the user\'s behalf. verdict "concerns" with 1 to 20 comments: they are written under ' +
			"the plan and the user decides with them in view; the plan is not sent back to the planner.",
	),
	parameters: z.object({
		verdict: z
			.enum(["ok", "concerns"])
			.describe('"ok": no concerns (no comments). "concerns": 1 to 20 comments for the user.'),
		comments: z
			.array(
				z.object({
					target: z
						.string()
						.optional()
						.describe(
							"The short id of the block of the plan the comment is about (the root or a block under it); omit when it is about the plan as a whole.",
						),
					text: z.string().describe("One concern, short and concrete (at most 1000 characters)."),
				}),
			)
			.optional()
			.describe('The concerns, one per comment; none with verdict "ok".'),
	}),
	execute: async (args, ctx) => {
		const requestId = getActiveExitPlanReflectionRequestId(ctx);
		const pending = requestId ? pendingExitPlanReflections.get(requestId) : undefined;
		if (!requestId || !pending) {
			return { output: "No plan review is active for this reflection loop.", isError: true };
		}
		if (pending.resolved || pending.reflectionStoppedByUser) {
			return {
				output: "The plan review was already resolved by another decision path.",
				isError: true,
			};
		}
		const comments = Array.isArray(args.comments)
			? (args.comments as Array<{ target?: unknown; text?: unknown }>).map((comment) => ({
					target: typeof comment?.target === "string" ? comment.target : null,
					text: typeof comment?.text === "string" ? comment.text : "",
				}))
			: [];
		if (args.verdict === "ok") {
			if (comments.length > 0) {
				return {
					output:
						'verdict "ok" takes no comments. If any comment should reach the user, use verdict "concerns"; otherwise call PlanReview again with verdict "ok" and no comments.',
					isError: true,
				};
			}
			// No reason of its own: the notice's localized "confirmed" title says it all.
			const ok = await confirmExitPlanReflection(requestId);
			return {
				output: ok
					? "Plan review: no concerns. The plan is approved as a draft on the user's behalf."
					: "The plan review was already resolved by another decision path.",
				isError: !ok,
			};
		}
		if (args.verdict !== "concerns") {
			return { output: 'verdict must be "ok" or "concerns".', isError: true };
		}
		const { reviewOutlinePlan } = await import("@server/services/outline-plan-mode");
		const reviewed = await reviewOutlinePlan({
			narratorId: pending.narratorId,
			requestId,
			toolUseId: pending.toolUseId,
			toolCallId: pending.toolCallId ?? null,
			input: pending.inputJson,
			comments,
			userId: ctx.userId ?? null,
			locale: ctx.locale === "zh-CN" ? "zh-CN" : "en",
		});
		if (!reviewed.ok) return { output: `PlanReview refused: ${reviewed.message}`, isError: true };
		const ok = await handOverExitPlanReflection(requestId, {
			reason: `Plan review left ${reviewed.review.count} comment(s) under the plan; awaiting user decision`,
			input: reviewed.input,
		});
		return {
			output: ok
				? `Plan review: ${reviewed.review.count} comment(s) written under the plan (${reviewed.review.address}). The user decides with them in view.`
				: "The plan review was already resolved by another decision path.",
			isError: !ok,
		};
	},
};
