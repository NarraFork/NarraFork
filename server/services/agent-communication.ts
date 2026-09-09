import { eventBus } from "@server/lib/event-bus";
import { logger } from "@server/lib/logger";
import { getSubagentType, isSubagentVariant, parseSubstatus } from "@server/lib/narrator-utils";
import type { Locale } from "@server/lib/prompt-i18n";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorToolCalls } from "../db/schema";
import type { ToolCallBinding } from "../lib/agent/types";
import { createAgentMessageDelivery } from "./agent-message-delivery";
import {
	type AgentReplyScope,
	type AgentReplyWaitHandle,
	type AgentReplyWaitResult,
	type AgentReplyWaitRunHandle,
	type AgentReplyWaitRunSnapshot,
	beginAgentReplyWaitRun,
	hasPendingAgentReply,
	registerAgentReplyWait,
	registerAgentReplyWaitFromSnapshot,
	resolvePendingAgentReply,
} from "./agent-reply-waiter";
import { backgroundTaskService } from "./background-task-service";
import { narratorService } from "./narrator-service";
import { getSubagentFinalText, startParentInboundContinuationIfPossible } from "./narrator-session";
import { pushParentInboundMessage } from "./parent-inbound-queue";
import { formatRecentSubagentActivity, getRecentSubagentToolActivity } from "./subagent-activity";
import { resolveTaskAlias, subagentMatchesSelector } from "./subagent-alias";
import {
	assertSubagentCanAwaitAgent,
	assertSubagentSendIsAsync,
} from "./subagent-communication-policy";
import { interruptForegroundSubagent } from "./subagent-detach";
import { pushSubagentBufferedMessage } from "./subagent-executor";
import { agentLabelFromNarrator, resolveAgentLabel, shortAgentId } from "./subagent-label";
import { hasActiveSubagentResumeRun, resumeSubagent } from "./subagent-resume";
import { waitForBackgroundTask } from "./subagent-runner";
import { isTakenOver, TAKEN_OVER_SUBSTATUS } from "./subagent-takeover";

const DEFAULT_TIMEOUT_MS = 30_000;

type Narrator = Awaited<ReturnType<typeof narratorService.getById>>;

export interface ResolveTargetsInput {
	callerNarratorId: string;
	id?: string;
	ids?: string[];
	name?: string;
	names?: string[];
}

export interface SendSubagentInput extends ResolveTargetsInput {
	toolCallBinding?: ToolCallBinding;
	/** Exact waiting Send message, resolved from its durable tool binding at setup. */
	requesterMessageId?: string;
	/** Navigation only; reserved IDs must be checked for actual existence before opening. */
	onDeliveryResolved?: (target: { id: string; deliveryMessageId: string }) => void;
	/** Internal original display text when reply-request instructions were appended. */
	displayMessage?: string;
	message: string;
	doInterrupt?: boolean;
	shouldAwait?: boolean;
	/** Explicit request id being answered by this Send call. */
	replyTo?: string;
	timeoutMs?: number;
	toolUseId: string;
	signal: AbortSignal;
	locale: string;
	/**
	 * User who triggered the sending turn. Carried onto the delivered message so
	 * the receiving subagent resolves knowledge ACL and fast-mode "inherit"
	 * against a real user instead of anonymous/disabled.
	 */
	userId?: string | null;
	/** Internal aggregate registry used to checkpoint an already-delivered Send await. */
	replyRun?: AgentReplyWaitRunHandle;
	/** Navigation only; called after authorization, before waiting for replies. */
	onTargetResolved?: (narratorId: string) => void;
}

export interface AwaitAgentInput {
	callerNarratorId: string;
	id: string;
	timeoutMs?: number;
	signal: AbortSignal;
	/**
	 * Optional reschedulable-timeout signal (from the Await tool). When it fires
	 * the wait ends with a "timeout" status rather than "aborted", so the UI can
	 * distinguish a deadline from a real parent interrupt. Extending the timeout
	 * mid-wait replaces the timer behind this signal.
	 */
	timeoutSignal?: AbortSignal;
	/**
	 * Invoked as soon as the target selector resolves to a real subagent narrator
	 * id — BEFORE the (potentially very long) wait begins.
	 *
	 * Exists so the UI can offer "open session" during the wait: the tool's own
	 * metadata carries this id only in its RETURN value, which for a 30-minute wait
	 * is 30 minutes too late. Must never throw and must never block; the caller
	 * treats it as fire-and-forget notification.
	 */
	onTargetResolved?: (subagentNarratorId: string) => void;
}

export interface AwaitAgentResult {
	id: string;
	/**
	 * Human/model-facing label for `id` (alias → title slug → short id). The
	 * formatted text uses this; `id` stays the real narrator id so the tool layer
	 * can hand the frontend something it can navigate to.
	 */
	label: string;
	status: string;
	output: string;
	formatted: string;
}

export interface SendTargetResult {
	/** Reply-wait special path: identifies the existing receiving tool row. */
	recipientToolUseId?: string;
	/** Exact receiving row, reserved while queued; not a delivery-status assertion. */
	deliveryMessageId?: string;
	/** Real narrator id, so the frontend can open the target's session. */
	id: string;
	/** Readable label (alias → title slug → short id) shown to the model. */
	label?: string;
	title?: string | null;
	status:
		| "queued"
		| "started"
		| "completed"
		| "failed"
		| "timeout"
		| "aborted"
		| "cancelled"
		| "taken_over";
	interrupted?: boolean;
	awaited?: boolean;
	error?: string;
}

export interface SendSubagentResult {
	output: string;
	targets: SendTargetResult[];
}

interface ReplyTarget {
	id: string;
	label?: string;
	title?: string | null;
}

interface PendingSendReply extends ReplyTarget {
	deliveryMessageId?: string;
	handle: AgentReplyWaitHandle;
	deliveryNote: string;
	interrupted?: boolean;
}

export function appendSendReplyRequest(
	message: string,
	requesterId: string,
	requestId: string,
	locale: Locale,
): string {
	const instruction =
		locale === "zh-CN"
			? `[请求回复 requestId=${requestId}] 请在有实质答复时调用 Send({ id: "${requesterId}", message: "<你的回复>", replyTo: "${requestId}" }) 回信。发送方等待的是你的 Send 回信，而不是等待你结束任务；不要仅为满足等待而中断当前工作。`
			: `[Reply requested requestId=${requestId}] When you have a substantive response, reply with Send({ id: "${requesterId}", message: "<your reply>", replyTo: "${requestId}" }). The sender is waiting for your Send reply, not for your task to finish; do not interrupt ongoing work merely to satisfy the wait.`;
	return `${message}\n\n${instruction}`;
}

/** A reply target paired with the scope its pending Send reply would live under. */
export interface ScopedReplyTarget extends ReplyTarget {
	scope: AgentReplyScope;
}

/**
 * Resolve incoming Send replies for a whole target list at once.
 *
 * IMPORTANT: this is a two-phase operation. Phase 1 only DETECTS which targets
 * have a pending reply (via the side-effect-free `hasPendingAgentReply`) and
 * validates the no-mixing rule. Only after that validation passes does phase 2
 * actually settle/deliver the replies. Callers must pass every target of the
 * Send in a single call — never one target at a time — otherwise a matched
 * reply would be delivered before the aggregate mix check runs, resuming the
 * waiter while the caller is told the Send failed (→ duplicate delivery).
 */
export function resolveIncomingSendReplies(
	fromNarratorId: string,
	targets: ScopedReplyTarget[],
	message: string,
	replyTo?: string,
): SendSubagentResult | null {
	const uniqueTargets = [...new Map(targets.map((target) => [target.id, target])).values()];
	if (replyTo && uniqueTargets.length !== 1) {
		return {
			output: "An explicit replyTo Send must address exactly one requester.",
			targets: uniqueTargets.map((target) => ({
				id: target.id,
				label: target.label ?? target.id,
				title: target.title,
				status: "failed" as const,
				awaited: false,
				error: "replyTo requires exactly one target.",
			})),
		};
	}

	// Phase 1 — detect (no settle). An explicit replyTo signals reply intent for
	// its single target; otherwise probe each target's scope for a pending reply.
	const replyTargets = replyTo
		? uniqueTargets
		: uniqueTargets.filter((target) =>
				hasPendingAgentReply(target.id, fromNarratorId, target.scope),
			);
	if (replyTargets.length === 0) return null;
	if (replyTargets.length !== uniqueTargets.length) {
		return {
			output:
				"A Send call cannot mix replies to waiting narrators with ordinary message targets. " +
				"Split this into separate Send calls.",
			targets: uniqueTargets.map((target) => ({
				id: target.id,
				label: target.label ?? target.id,
				title: target.title,
				status: "failed" as const,
				awaited: false,
				error: "Mixed reply and ordinary Send targets.",
			})),
		};
	}

	// Phase 2 — settle/deliver only now that the whole batch is confirmed replies.
	const sections: string[] = [];
	const results: SendTargetResult[] = [];
	for (const target of replyTargets) {
		const resolved = resolvePendingAgentReply({
			fromNarratorId,
			toNarratorId: target.id,
			scope: target.scope,
			message,
			replyTo,
		});
		if (!resolved.matched) {
			const error = resolved.error ?? "No matching Send reply request.";
			return {
				output: `Failed to deliver Send reply to ${target.label ?? target.id}: ${error}`,
				targets: [
					{
						id: target.id,
						label: target.label ?? target.id,
						title: target.title,
						status: "failed",
						awaited: false,
						error,
					},
				],
			};
		}
		sections.push(
			`Delivered Send reply to ${target.label ?? target.id} for request ${resolved.requestId}; ` +
				"the waiting Send call resumed immediately.",
		);
		results.push({
			id: target.id,
			label: target.label ?? target.id,
			title: target.title,
			status: "completed",
			...(resolved.recipientToolUseId ? { recipientToolUseId: resolved.recipientToolUseId } : {}),
			...(resolved.recipientMessageId ? { deliveryMessageId: resolved.recipientMessageId } : {}),
			awaited: false,
		});
	}
	return { output: sections.join("\n"), targets: results };
}

function formatSendReplyWaitResult(
	pending: Omit<PendingSendReply, "handle">,
	result: AgentReplyWaitResult,
): { section: string; target: SendTargetResult } {
	const label = pending.label ?? pending.id;
	const baseTarget = {
		id: pending.id,
		label,
		title: pending.title,
		interrupted: pending.interrupted,
		...(pending.deliveryMessageId ? { deliveryMessageId: pending.deliveryMessageId } : {}),
		awaited: true,
	};
	switch (result.status) {
		case "replied":
			return {
				section:
					`${pending.deliveryNote}\nReceived Send reply from ${label}:\n` +
					`<subagent_id>${label}</subagent_id>\n\n${result.message}`,
				target: { ...baseTarget, status: "completed" },
			};
		case "timeout":
			return {
				section:
					`${pending.deliveryNote}\nTimed out waiting for a Send reply from ${label}. ` +
					"Only the reply wait ended; the target task was not stopped and may still be running.",
				target: { ...baseTarget, status: "timeout" },
			};
		case "aborted":
			return {
				section:
					`${pending.deliveryNote}\nWaiting for a Send reply from ${label} was interrupted. ` +
					"The target task was not stopped.",
				target: { ...baseTarget, status: "aborted" },
			};
		case "failed":
			return {
				section: `${pending.deliveryNote}\nFailed while waiting for ${label} to reply: ${result.error}`,
				target: { ...baseTarget, status: "failed", error: result.error },
			};
		case "cancelled":
			return {
				section: `${pending.deliveryNote}\nThe Send reply wait for ${label} was cancelled.`,
				target: { ...baseTarget, status: "cancelled" },
			};
	}
}

async function waitForSendReplies(
	pendingReplies: PendingSendReply[],
	replyRun?: AgentReplyWaitRunHandle,
	prefix: { sections?: string[]; targets?: SendTargetResult[] } = {},
): Promise<SendSubagentResult> {
	replyRun?.markStable({
		prefixSections: prefix.sections,
		prefixTargets: prefix.targets,
	});
	const settled = await Promise.all(
		pendingReplies.map(async ({ handle, ...pending }) =>
			formatSendReplyWaitResult(pending, await handle.promise),
		),
	);
	const sections = [...(prefix.sections ?? []), ...settled.map((item) => item.section)];
	return {
		output: sections.join("\n\n"),
		targets: [...(prefix.targets ?? []), ...settled.map((item) => item.target)],
	};
}

export function formatSendAwaitSnapshotWithFallback(
	snapshot: AgentReplyWaitRunSnapshot,
	fallback: AgentReplyWaitResult,
): SendSubagentResult {
	const settled = snapshot.waiters.map((waiter) =>
		formatSendReplyWaitResult(
			{
				id: waiter.responderId,
				label: waiter.label,
				title: waiter.title,
				deliveryNote: waiter.deliveryNote,
				interrupted: waiter.interrupted,
				deliveryMessageId: waiter.deliveryMessageId,
			},
			waiter.result ?? fallback,
		),
	);
	const sections = [...snapshot.prefixSections, ...settled.map((item) => item.section)];
	return {
		output: sections.join("\n\n"),
		targets: [...snapshot.prefixTargets, ...settled.map((item) => item.target)],
	};
}

/** Restore only the reply waits from a checkpoint; the original messages are never sent again. */
export async function restoreSendAwaitFromSnapshot(
	snapshot: AgentReplyWaitRunSnapshot,
	signal: AbortSignal,
): Promise<SendSubagentResult> {
	const replyRun = beginAgentReplyWaitRun({
		toolUseId: snapshot.toolUseId,
		requesterId: snapshot.requesterId,
		requesterToolCallBinding: snapshot.requesterToolCallBinding,
		doInterrupt: snapshot.doInterrupt,
	});
	try {
		const handles = new Map<string, AgentReplyWaitHandle>();
		for (const waiter of snapshot.waiters) {
			const handle = registerAgentReplyWaitFromSnapshot(replyRun, waiter, signal);
			if (handle) handles.set(waiter.requestId, handle);
		}
		replyRun.markStable({
			prefixSections: snapshot.prefixSections,
			prefixTargets: snapshot.prefixTargets,
		});
		const settled = await Promise.all(
			snapshot.waiters.map(async (waiter) => {
				const result =
					waiter.result ?? (await (handles.get(waiter.requestId) as AgentReplyWaitHandle).promise);
				return formatSendReplyWaitResult(
					{
						id: waiter.responderId,
						label: waiter.label,
						title: waiter.title,
						deliveryNote: waiter.deliveryNote,
						interrupted: waiter.interrupted,
						deliveryMessageId: waiter.deliveryMessageId,
					},
					result,
				);
			}),
		);
		const sections = [...snapshot.prefixSections, ...settled.map((item) => item.section)];
		return {
			output: sections.join("\n\n"),
			targets: [...snapshot.prefixTargets, ...settled.map((item) => item.target)],
		};
	} finally {
		replyRun.complete();
	}
}

function notifyDeliveryResolved(
	input: SendSubagentInput,
	id: string,
	deliveryMessageId: string,
): void {
	try {
		input.onDeliveryResolved?.({ id, deliveryMessageId });
	} catch (error) {
		logger.warn("Send delivery navigation notification failed", { error: String(error) });
	}
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const trimmed = value?.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function getSelectors(input: ResolveTargetsInput): string[] {
	return uniqueStrings([input.id, ...(input.ids ?? []), input.name, ...(input.names ?? [])]);
}

async function getCommunicationScope(callerNarratorId: string): Promise<{
	caller: Narrator;
	teamParentId: string;
	callerIsSubagent: boolean;
}> {
	const caller = await narratorService.getById(callerNarratorId);
	const callerIsSubagent = isSubagentVariant(caller.variant);
	if (callerIsSubagent && !caller.parentNarratorId) {
		throw new Error("Subagent has no parent narrator");
	}
	return {
		caller,
		teamParentId: callerIsSubagent ? (caller.parentNarratorId as string) : callerNarratorId,
		callerIsSubagent,
	};
}

function assertTargetAllowed(
	target: Narrator,
	scope: Awaited<ReturnType<typeof getCommunicationScope>>,
) {
	// These messages reach the model, so they name the target the same readable
	// way every other Send/Await outlet does.
	const label = agentLabelFromNarrator(target, scope.teamParentId);
	if (!isSubagentVariant(target.variant)) {
		throw new Error(`${label} is not a subagent`);
	}
	if (target.parentNarratorId !== scope.teamParentId) {
		throw new Error(`${label} does not belong to this narrator's subagent team`);
	}
	if (scope.callerIsSubagent && target.id === scope.caller.id) {
		throw new Error("Subagents cannot target themselves");
	}
}

async function resolveAliasCandidate(
	selector: string,
	scope: Awaited<ReturnType<typeof getCommunicationScope>>,
) {
	for (const ownerId of [scope.caller.id, scope.teamParentId]) {
		const inMemory = resolveTaskAlias(ownerId, selector);
		if (inMemory !== selector) return inMemory;
		const task = await backgroundTaskService.getByAlias(selector, ownerId);
		if (task?.subagentNarratorId) return task.subagentNarratorId;
		if (task?.type === "agent") return task.id;
	}
	return selector;
}

async function resolveOneTarget(
	selector: string,
	scope: Awaited<ReturnType<typeof getCommunicationScope>>,
): Promise<Narrator> {
	const aliasCandidate = await resolveAliasCandidate(selector, scope);
	const direct = await narratorService.getById(aliasCandidate).catch(() => null);
	if (direct) {
		assertTargetAllowed(direct, scope);
		return direct;
	}

	const siblings = await narratorService.listSubagentsByParent(scope.teamParentId);
	const candidates = siblings.filter((s) => {
		if (scope.callerIsSubagent && s.id === scope.caller.id) return false;
		return subagentMatchesSelector(s, selector);
	});

	if (candidates.length === 0) {
		throw new Error(`No accessible subagent found for "${selector}"`);
	}
	if (candidates.length > 1) {
		// Lead with the label so the model's next attempt can disambiguate with an
		// alias instead of copying a nanoid back.
		const lines = candidates
			.map(
				(c) =>
					`- ${agentLabelFromNarrator(c, scope.teamParentId)} | ${c.title ?? "(untitled)"} ` +
					`(id: ${shortAgentId(c.id)})`,
			)
			.join("\n");
		throw new Error(`Ambiguous subagent target "${selector}". Candidates:\n${lines}`);
	}

	const target = await narratorService.getById(candidates[0].id);
	assertTargetAllowed(target, scope);
	return target;
}

export async function resolveSubagentTargets(input: ResolveTargetsInput): Promise<Narrator[]> {
	const selectors = getSelectors(input);
	if (selectors.length === 0) {
		throw new Error("At least one target id/name is required");
	}

	const scope = await getCommunicationScope(input.callerNarratorId);
	const resolved: Narrator[] = [];
	const seen = new Set<string>();
	for (const selector of selectors) {
		const target = await resolveOneTarget(selector, scope);
		if (seen.has(target.id)) continue;
		seen.add(target.id);
		resolved.push(target);
	}
	return resolved;
}

function formatSubagentResult(label: string, finalText: string | null | undefined): string {
	return `<subagent_id>${label}</subagent_id>\n\n${finalText || "(no output)"}`;
}

/**
 * Output placeholders that carry no real subagent result. When the wait ends
 * without a final result (aborted/timeout), these stand-ins must not be shown
 * as if they were the subagent's output.
 */
const EMPTY_AWAIT_OUTPUTS = new Set([
	"",
	"(no output)",
	"Await aborted.",
	"Subagent is still running.",
]);

/**
 * Format the result text an Await sees for an agent target.
 *
 * Non-terminal statuses (aborted/running/timeout) only mean the *wait* ended —
 * the subagent keeps running in the background with its own abort controller.
 * The wording makes this explicit so the model does not assume the subagent was
 * killed, and reminds it that Await can be called again with the same id.
 *
 * `label` is what the model reads and re-uses as an Await/Send selector, so it
 * is the readable alias rather than the raw nanoid. The real narrator id travels
 * separately in the tool metadata for the frontend's session link.
 */
export function formatAgentAwaitResult(
	label: string,
	status: string,
	output: string | null,
	recentActivity?: string,
): string {
	const trimmed = output?.trim() ?? "";
	const partial = EMPTY_AWAIT_OUTPUTS.has(trimmed) ? "" : trimmed;
	const tag = `<subagent_id>${label}</subagent_id>`;
	const activitySection = recentActivity ? `\n\n${recentActivity}` : "";
	switch (status) {
		case "aborted":
			return (
				`${tag}\n\n` +
				`Await on agent ${label} was interrupted — only this wait was canceled, not the subagent. ` +
				`The subagent is still running in the background. Call Await again with the same id to ` +
				`keep waiting for its result.` +
				(partial ? `\n\nPartial output so far:\n${partial}` : "")
			);
		case "running":
		case "timeout":
			return (
				`${tag}\n\n` +
				`Agent ${label} is still running — the wait timed out but the subagent has not stopped. ` +
				`Call Await again with the same id and a meaningful timeout to keep waiting. ` +
				`Do not send a progress check or interrupt it merely because this wait expired.` +
				activitySection +
				(partial ? `\n\nPartial output so far:\n${partial}` : "")
			);
		case "timed_out":
			return (
				`${tag}\n\n` +
				`Agent ${label} exceeded its execution time limit and was stopped.` +
				(partial ? `\n\nTimeout details:\n${partial}` : "")
			);
		case "taken_over":
			return (
				`${tag}\n\n` +
				`Agent ${label} is being taken over by the user. The user is operating it directly; ` +
				`its result will be returned only when the user stops the takeover. ` +
				`Call Await again later with the same id to retrieve the final result.` +
				(partial ? `\n\nOutput so far:\n${partial}` : "")
			);
		default:
			return `Agent ${label} status: ${status}\n\n${formatSubagentResult(label, output)}`;
	}
}

async function buildAwaitAgentResult(
	scopeNarratorId: string,
	id: string,
	status: string,
	output: string | null | undefined,
	knownLabel?: string,
): Promise<AwaitAgentResult> {
	let recentActivity: string | undefined;
	if (status === "timeout" || status === "running") {
		try {
			recentActivity = formatRecentSubagentActivity(await getRecentSubagentToolActivity(id));
		} catch (err) {
			logger.warn("Failed to load recent subagent activity for Await timeout", {
				subagentId: id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	const label = knownLabel ?? (await resolveAgentLabel(scopeNarratorId, id));
	return {
		id,
		label,
		status,
		output: output ?? "(no output)",
		formatted: formatAgentAwaitResult(label, status, output ?? null, recentActivity),
	};
}

function settledSubagentStatus(narrator: Narrator, fallback = "completed"): string {
	// A taken-over subagent is being operated directly by the user. Its result
	// is not final until the user stops takeover, so report it distinctly.
	if (isTakenOver(narrator.id)) return "taken_over";
	const substatus = parseSubstatus(narrator.substatus);
	if (substatus.includes("timeout")) return "timed_out";
	if (substatus.includes("error") || narrator.errorMessage) return "failed";
	if (substatus.includes("interrupted")) return "cancelled";
	return fallback;
}

/**
 * Whether a subagent status/substatus pair means "this run has ended".
 *
 * `working`/`waiting` are the only non-terminal states a subagent run can sit in,
 * so anything else is a settled run. A takeover is excluded on purpose: a
 * taken-over subagent parks in `idle[taken_over]` between the user's own turns,
 * which is idle-shaped but is NOT the end of the run — its result is handed back
 * only when the user stops the takeover. Treating it as terminal would end the
 * parent's Await with a partial result while the user is still working.
 */
function subagentRunHasSettled(
	subagentId: string,
	status: string,
	substatus: string[] | undefined,
): boolean {
	if (status === "working" || status === "waiting") return false;
	if (isTakenOver(subagentId)) return false;
	// The in-memory takeover Set is authoritative, but it is cleared slightly
	// before/after the mirrored tag depending on the path, so both are consulted.
	if (substatus?.includes(TAKEN_OVER_SUBSTATUS)) return false;
	return true;
}

export async function waitForSubagentResult(opts: {
	subagentId: string;
	parentNarratorId: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<{ status: string; output: string }> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const current = await narratorService.getById(opts.subagentId);
	if (current.status !== "working" && current.status !== "waiting") {
		return {
			status: settledSubagentStatus(current),
			output: await getSubagentFinalText(opts.subagentId),
		};
	}

	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			eventBus.off("narrator:subagent_completed", onCompleted);
			eventBus.off("narrator:status_changed", onStatusChanged);
			opts.signal?.removeEventListener("abort", onAbort);
		};

		const finish = async (status: string) => {
			const [output, latest] = await Promise.all([
				getSubagentFinalText(opts.subagentId).catch(() => "(no output)"),
				narratorService.getById(opts.subagentId).catch(() => null),
			]);
			cleanup();
			resolve({ status: latest ? settledSubagentStatus(latest, status) : status, output });
		};

		const onCompleted = (event: { narratorId: string; parentNarratorId: string }) => {
			if (settled) return;
			if (event.narratorId !== opts.subagentId) return;
			void finish("completed");
		};

		/**
		 * Second, independent wake-up source — and for some runs the ONLY one.
		 *
		 * `narrator:subagent_completed` is emitted by the subagent RUNNER
		 * (`finalizeSubagent`) and by the parent-interrupt path. A subagent driven by
		 * the generic session engine instead — which is exactly what a user takeover,
		 * and any `resumeSubagent` continuation started from the subagent's own page,
		 * produces — finishes inside `runAgentLoop`, which never emits it. So a parent
		 * that called `Await` on such a child waited out its whole timeout even though
		 * the child had settled minutes earlier, and kept re-waiting because the result
		 * still looked pending.
		 *
		 * `narrator:status_changed` is emitted by every status write path
		 * (`updateStatus` and `compareAndSetStatus` both emit unconditionally), so it
		 * covers the engines the dedicated event does not. Both listeners are kept:
		 * `cleanup` is idempotent and `finish` is guarded by `settled`, so whichever
		 * arrives first wins and the other is a no-op.
		 */
		const onStatusChanged = (event: {
			narratorId: string;
			status: string;
			substatus?: string[];
		}) => {
			if (settled) return;
			if (event.narratorId !== opts.subagentId) return;
			if (!subagentRunHasSettled(opts.subagentId, event.status, event.substatus)) return;
			// The status carries no result text, so `finish` re-reads the row and lets
			// `settledSubagentStatus` decide the real outcome (completed/failed/
			// cancelled/timed_out) rather than assuming success here.
			void finish("completed");
		};

		const onAbort = () => {
			cleanup();
			resolve({ status: "aborted", output: "Await aborted." });
		};

		eventBus.on("narrator:subagent_completed", onCompleted);
		eventBus.on("narrator:status_changed", onStatusChanged);
		if (opts.signal) {
			if (opts.signal.aborted) {
				onAbort();
				return;
			}
			opts.signal.addEventListener("abort", onAbort, { once: true });
		}
		timer = setTimeout(() => {
			cleanup();
			resolve({ status: "timeout", output: "Subagent is still running." });
		}, timeoutMs);

		// Re-read AFTER subscribing, to close the gap the status check above opens.
		// That check awaited a DB read, and a subagent that settled during that await
		// emitted both of its events before either listener existed — so the wait
		// would then run to its full timeout on a child that had already finished.
		// Subscribing first and verifying second means every ordering is covered:
		// settle-before-subscribe is caught here, settle-after-subscribe by the
		// listeners, and a settle in between is caught twice (harmlessly, since
		// `finish` is guarded by `settled`).
		void narratorService
			.getById(opts.subagentId)
			.then((fresh) => {
				if (settled) return;
				if (
					!subagentRunHasSettled(opts.subagentId, fresh.status, parseSubstatus(fresh.substatus))
				) {
					return;
				}
				void finish("completed");
			})
			.catch((err) => {
				// A failed re-read is not a reason to end the wait: the listeners are
				// already live, so the ordinary path still works.
				logger.warn("Failed to re-check subagent status after subscribing to its result", {
					subagentId: opts.subagentId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	});
}

/**
 * Build the effective wait signal and a status relabeler for an Await call.
 * When a reschedulable timeoutSignal is provided (from the Await tool), the wait
 * is bounded by the union of the parent-interrupt signal and the timeout signal,
 * and a plain "aborted" is relabeled to "timeout" when only the timeout fired.
 */
function buildAwaitTimeoutContext(opts: AwaitAgentInput): {
	signal: AbortSignal;
	relabel: (status: string) => string;
} {
	if (!opts.timeoutSignal) {
		return { signal: opts.signal, relabel: (status) => status };
	}
	const timeoutSignal = opts.timeoutSignal;
	return {
		signal: AbortSignal.any([opts.signal, timeoutSignal]),
		relabel: (status) =>
			status === "aborted" && !opts.signal.aborted && timeoutSignal.aborted ? "timeout" : status,
	};
}

/**
 * Report a resolved Await target without ever letting that reporting break the
 * wait. The callback only drives a UI affordance, so a throwing listener must not
 * turn a working Await into a failed tool call.
 */
function notifyTargetResolved(opts: AwaitAgentInput, subagentNarratorId: string): void {
	if (!opts.onTargetResolved || !subagentNarratorId) return;
	try {
		opts.onTargetResolved(subagentNarratorId);
	} catch (err) {
		logger.warn("Await target-resolved notification failed", {
			subagentId: subagentNarratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function awaitBackgroundAgentTask(opts: AwaitAgentInput) {
	const resolvedId = resolveTaskAlias(opts.callerNarratorId, opts.id);
	let task = await backgroundTaskService.getById(resolvedId);
	if (!task && resolvedId === opts.id) {
		task = await backgroundTaskService.getByAlias(opts.id, opts.callerNarratorId);
	}
	if (!task) return null;
	if (task.type !== "agent") {
		throw new Error(`Background task "${opts.id}" is ${task.type}, not agent`);
	}
	if (task.parentNarratorId !== opts.callerNarratorId) {
		throw new Error(`Background agent "${opts.id}" does not belong to this narrator`);
	}

	const subagentId = task.subagentNarratorId ?? task.id;
	notifyTargetResolved(opts, subagentId);
	const current = await narratorService.getById(subagentId).catch(() => null);
	if (current && task.status !== "running" && !current.isBackground) {
		// The background task row is from a previous run. The same subagent may have
		// since been continued via Send, so fall through to narrator-state waiting.
		return null;
	}

	if (task.status === "running") {
		const { signal, relabel } = buildAwaitTimeoutContext(opts);
		const waited = await backgroundTaskService.waitForCompletion(
			task.id,
			opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			signal,
		);
		return {
			id: subagentId,
			status: relabel(waited.status),
			output: waited.output,
		};
	}
	return {
		id: subagentId,
		status: task.status === "timeout" ? "timed_out" : task.status,
		output: task.output,
	};
}

export async function awaitAgentResultDetailed(opts: AwaitAgentInput): Promise<AwaitAgentResult> {
	const scope = await getCommunicationScope(opts.callerNarratorId);
	assertSubagentCanAwaitAgent(scope.callerIsSubagent);

	const background = await awaitBackgroundAgentTask(opts);
	if (background) {
		return buildAwaitAgentResult(
			scope.teamParentId,
			background.id,
			background.status,
			background.output,
		);
	}

	const target = await resolveOneTarget(opts.id, scope);
	// Announce the target before waiting: every branch below may block for the full
	// timeout, and the UI needs this id to offer "open session" meanwhile.
	notifyTargetResolved(opts, target.id);
	// The narrator row is in hand, so the label needs no extra query.
	const label = agentLabelFromNarrator(target, scope.teamParentId);
	const build = (status: string, output: string | null | undefined) =>
		buildAwaitAgentResult(scope.teamParentId, target.id, status, output, label);
	if (target.isBackground && target.backgroundStatus === "running") {
		const { signal, relabel } = buildAwaitTimeoutContext(opts);
		const waited = await waitForBackgroundTask(
			target.id,
			opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			signal,
		);
		return build(relabel(waited.status), waited.result);
	}
	if (target.isBackground && target.backgroundStatus) {
		return build(target.backgroundStatus, target.backgroundResult);
	}
	if (target.status === "working" || target.status === "waiting") {
		// If the subagent is being taken over by the user, do not block waiting for
		// a result that only arrives when takeover ends. Report it immediately.
		if (isTakenOver(target.id)) {
			return build("taken_over", await getSubagentFinalText(target.id));
		}
		const { signal, relabel } = buildAwaitTimeoutContext(opts);
		const waited = await waitForSubagentResult({
			subagentId: target.id,
			parentNarratorId: target.parentNarratorId as string,
			timeoutMs: opts.timeoutMs,
			signal,
		});
		return build(relabel(waited.status), waited.output);
	}
	return build(settledSubagentStatus(target), await getSubagentFinalText(target.id));
}

export async function awaitAgentResult(opts: AwaitAgentInput): Promise<string> {
	return (await awaitAgentResultDetailed(opts)).formatted;
}

/**
 * Reserved selectors a subagent can use to address the narrator that launched
 * it (its parent). Matched case-insensitively before sibling alias resolution.
 */
const PARENT_SELECTORS = new Set(["parent", "main", "@parent", "@main"]);

function isParentSelector(selector: string): boolean {
	return PARENT_SELECTORS.has(selector.trim().toLowerCase());
}

function parentChildReplyScope(parentNarratorId: string, childNarratorId: string): AgentReplyScope {
	return { type: "parent-child", id: `${parentNarratorId}\u0000${childNarratorId}` };
}

function teamReplyScope(teamParentId: string): AgentReplyScope {
	return { type: "team", id: teamParentId };
}

/** Subagent type label for a caller narrator (explore/plan/general/...). */
function callerSubagentType(caller: Narrator): string {
	return getSubagentType(caller.variant) ?? "subagent";
}

/**
 * Prefix a sibling/child-bound message with a sender label so the recipient can
 * tell who sent it. User-typed buffer messages (entered on the subagent page)
 * bypass this path and are unaffected.
 */
function withSenderPrefix(
	caller: Narrator,
	callerIsSubagent: boolean,
	message: string,
	locale: Locale,
): string {
	const isZh = locale === "zh-CN";
	if (callerIsSubagent) {
		// Stays synchronous: the caller's own row carries its alias/title, so no
		// query is needed to name the sender readably.
		const name = caller.title?.trim() || agentLabelFromNarrator(caller);
		const label = isZh
			? `[来自同级子代理"${name}"（${callerSubagentType(caller)}）的消息]`
			: `[Message from sibling subagent "${name}" (${callerSubagentType(caller)})]`;
		return `${label}\n${message}`;
	}
	const label = isZh ? "[来自父叙述者的消息]" : "[Message from the parent narrator]";
	return `${label}\n${message}`;
}

/**
 * Deliver a subagent → parent progress report. The parent is always a primary
 * narrator (subagents cannot spawn nested subagents). A working/waiting parent
 * drains the report at its next sidecar boundary; an idle parent is woken.
 */
async function deliverSubagentMessageToParent(
	input: SendSubagentInput,
	scope: Awaited<ReturnType<typeof getCommunicationScope>>,
): Promise<SendTargetResult> {
	const parentId = scope.teamParentId;
	const parent = await narratorService.getById(parentId).catch(() => null);
	if (!parent) {
		return { id: parentId, status: "failed", error: "Parent narrator not found" };
	}
	// Defensive: nested subagents are impossible (createSubagent rejects them),
	// so a subagent's parent must be a primary narrator. Guard anyway.
	if (isSubagentVariant(parent.variant)) {
		logger.warn("Subagent parent is unexpectedly a subagent; refusing parent delivery", {
			callerNarratorId: input.callerNarratorId,
			parentNarratorId: parentId,
		});
		return { id: parentId, status: "failed", error: "Parent is not a primary narrator" };
	}
	if (parent.status === "archived") {
		return { id: parentId, title: parent.title, status: "failed", error: "Parent is archived" };
	}

	// Send is an addressable tool row. The latest text message may be several
	// calls earlier (or absent entirely), so preserve the exact invocation instead.
	const delivery = createAgentMessageDelivery(
		parentId,
		{
			id: scope.caller.id,
			title: scope.caller.title,
			label: agentLabelFromNarrator(scope.caller, parentId),
			type: callerSubagentType(scope.caller),
			isParent: false,
		},
		input.toolUseId,
		input.displayMessage ?? input.message,
	);
	pushParentInboundMessage(parentId, {
		delivery,
		fromId: scope.caller.id,
		fromTitle: scope.caller.title,
		fromLabel: agentLabelFromNarrator(scope.caller, parentId),
		fromType: callerSubagentType(scope.caller),
		fromToolUseId: input.toolUseId,
		text: input.message,
		timestamp: new Date().toISOString(),
	});

	notifyDeliveryResolved(input, parentId, delivery.recipientMessageId);

	// Wake the parent only when idle; a working/waiting parent drains the queue
	// at its next after_tools sidecar boundary.
	const wake = await startParentInboundContinuationIfPossible(
		parentId,
		input.locale as Locale,
	).catch((err) => {
		logger.warn("Failed to wake parent narrator for subagent message", {
			parentNarratorId: parentId,
			error: err instanceof Error ? err.message : String(err),
		});
		return { started: false };
	});

	return {
		id: parentId,
		title: parent.title,
		status: wake.started ? "started" : "queued",
		deliveryMessageId: delivery.recipientMessageId,
	};
}

/**
 * Attempt to route a Send from a subagent to its parent narrator. Returns a
 * result when every selector targets the parent; returns null when no selector
 * is parent-bound (caller falls through to sibling routing). A mix of parent
 * and non-parent selectors is rejected.
 */
async function tryRouteToParent(
	input: SendSubagentInput,
	scope: Awaited<ReturnType<typeof getCommunicationScope>>,
): Promise<SendSubagentResult | null> {
	if (!scope.callerIsSubagent) return null;
	const selectors = getSelectors(input);
	if (selectors.length === 0) return null;

	const parentMatches = selectors.filter(
		(selector) => isParentSelector(selector) || selector === scope.teamParentId,
	);
	if (parentMatches.length === 0) return null;
	if (parentMatches.length !== selectors.length) {
		return {
			output:
				"Mixed parent and sibling Send targets are not delivered together; " +
				"split this into separate Send calls.",
			targets: selectors.map((selector) => ({
				id: selector,
				status: "failed" as const,
				error: "Mixed parent and sibling targets in one Send call.",
			})),
		};
	}

	const replyScope = parentChildReplyScope(scope.teamParentId, scope.caller.id);
	const incomingReply = resolveIncomingSendReplies(
		scope.caller.id,
		[{ id: scope.teamParentId, label: parentMatches[0], scope: replyScope }],
		input.message,
		input.replyTo,
	);
	if (incomingReply) return incomingReply;

	// Only background subagents may report to the parent. A foreground subagent
	// blocks the parent on the Task tool call that spawned it: the parent is not
	// idle (so it can't be woken) and never reaches a sidecar boundary (so it
	// can't drain the queue) until this subagent finishes — at which point the
	// final result is already returned, making interim reports pointless.
	if (!scope.caller.isBackground && !hasActiveSubagentResumeRun(scope.caller.id)) {
		return {
			output:
				"Cannot report to the parent narrator: you are a foreground subagent and the parent is " +
				"blocked waiting for you to finish. Your final result is returned to the parent " +
				"automatically when you complete. (Only background subagents can send interim progress " +
				"reports to the parent.)",
			targets: [
				{
					id: scope.teamParentId,
					label: parentMatches[0],
					status: "failed",
					error: "Foreground subagents block the parent and cannot send interim reports.",
				},
			],
		};
	}

	let replyHandle: AgentReplyWaitHandle | undefined;
	if (input.shouldAwait) {
		try {
			replyHandle = registerAgentReplyWait({
				requesterId: scope.caller.id,
				requesterMessageId: input.requesterMessageId,
				requesterToolCallBinding: input.toolCallBinding,
				responderId: scope.teamParentId,
				scope: replyScope,
				timeoutMs: input.timeoutMs,
				signal: input.signal,
				run: input.replyRun,
				toolUseId: input.toolUseId,
				label: parentMatches[0],
			});
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			return {
				output: `Cannot wait for a Send reply from the parent narrator: ${error}`,
				targets: [
					{
						id: scope.teamParentId,
						label: parentMatches[0],
						status: "failed",
						awaited: true,
						error,
					},
				],
			};
		}
	}

	const deliveredInput = replyHandle
		? {
				...input,
				displayMessage: input.message,
				message: appendSendReplyRequest(
					input.message,
					scope.caller.id,
					replyHandle.requestId,
					input.locale as Locale,
				),
			}
		: input;
	const target = await deliverSubagentMessageToParent(deliveredInput, scope);
	const note =
		target.status === "started"
			? "Reported to the parent narrator (woke it to read the report)."
			: target.status === "queued"
				? "Reported to the parent narrator; it will see the report on its next turn."
				: `Failed to report to the parent narrator: ${target.error}`;
	if (!replyHandle) {
		// The selector the subagent used ("parent"/"main") is already the most
		// readable name for this target.
		return { output: note, targets: [{ ...target, label: parentMatches[0], awaited: false }] };
	}
	const deliveryNote = `${note} Requested a Send reply.`;
	replyHandle.updateSnapshot({
		title: target.title,
		deliveryNote,
		deliveryMessageId: target.deliveryMessageId,
	});
	if (target.status === "failed") {
		replyHandle.fail(target.error ?? "Failed to report to the parent narrator");
	}
	return waitForSendReplies(
		[
			{
				id: scope.teamParentId,
				label: parentMatches[0],
				title: target.title,
				handle: replyHandle,
				deliveryMessageId: target.deliveryMessageId,
				deliveryNote,
			},
		],
		input.replyRun,
	);
}

async function sendSubagentMessageDetailedWithRun(
	input: SendSubagentInput,
): Promise<SendSubagentResult> {
	const scope = await getCommunicationScope(input.callerNarratorId);
	assertSubagentSendIsAsync(scope.callerIsSubagent, input.shouldAwait);

	if (input.doInterrupt && scope.callerIsSubagent) {
		throw new Error("doInterrupt is only supported from a primary narrator to its child subagents");
	}

	// Subagent → parent routing: a subagent may report progress to the narrator
	// that launched it via the reserved selector "parent"/"main" (or the parent's
	// id). Intercept before sibling alias resolution so it cannot collide with a
	// sibling's alias/title.
	const parentResult = await tryRouteToParent(input, scope);
	if (parentResult) return parentResult;

	const targets = await resolveSubagentTargets(input);
	if (targets.length === 1) input.onTargetResolved?.(targets[0].id);
	if (input.replyTo && targets.length !== 1) {
		return {
			output: "An explicit replyTo Send must address exactly one requester.",
			targets: targets.map((target) => ({
				id: target.id,
				label: agentLabelFromNarrator(target, scope.teamParentId),
				title: target.title,
				status: "failed" as const,
				error: "replyTo requires exactly one target.",
			})),
		};
	}
	const targetReplyScope = (target: Narrator): AgentReplyScope =>
		scope.callerIsSubagent
			? teamReplyScope(scope.teamParentId)
			: parentChildReplyScope(scope.caller.id, target.id);
	const incomingReplies = resolveIncomingSendReplies(
		scope.caller.id,
		targets.map((target) => ({
			id: target.id,
			label: agentLabelFromNarrator(target, scope.teamParentId),
			title: target.title,
			scope: targetReplyScope(target),
		})),
		input.message,
		input.replyTo,
	);
	if (incomingReplies) return incomingReplies;

	const sections: string[] = [];
	const targetResults: SendTargetResult[] = [];
	const pendingReplies: PendingSendReply[] = [];
	for (const target of targets) {
		let replyHandle: AgentReplyWaitHandle | undefined;
		// Readable name for every message about this target, refreshed from `fresh`
		// below once it is loaded.
		let label = agentLabelFromNarrator(target, scope.teamParentId);
		try {
			if (input.doInterrupt && target.parentNarratorId !== input.callerNarratorId) {
				throw new Error("doInterrupt is only supported for this narrator's direct child subagents");
			}

			const fresh = await narratorService.getById(target.id);
			label = agentLabelFromNarrator(fresh, scope.teamParentId);
			if (fresh.status === "archived") {
				throw new Error("Target subagent is archived");
			}

			// If the user has taken over this subagent, the parent must not drive it.
			// Report the takeover so the agent waits for the user to finish.
			if (isTakenOver(fresh.id)) {
				sections.push(
					`Agent ${label} is being taken over by the user and cannot be driven right now. ` +
						`Its result will be available after the user stops the takeover.`,
				);
				targetResults.push({
					id: fresh.id,
					label,
					title: fresh.title,
					status: "taken_over",
					awaited: input.shouldAwait,
				});
				continue;
			}

			if (input.shouldAwait) {
				replyHandle = registerAgentReplyWait({
					requesterId: scope.caller.id,
					requesterMessageId: input.requesterMessageId,
					requesterToolCallBinding: input.toolCallBinding,
					responderId: fresh.id,
					scope: targetReplyScope(fresh),
					timeoutMs: input.timeoutMs,
					signal: input.signal,
					run: input.replyRun,
					toolUseId: input.toolUseId,
					title: fresh.title,
				});
			}
			const message = replyHandle
				? appendSendReplyRequest(
						input.message,
						scope.caller.id,
						replyHandle.requestId,
						input.locale as Locale,
					)
				: input.message;
			// Prefix sibling/child-bound messages with a sender label so the recipient
			// can tell who sent it (user-typed page messages bypass this path entirely).
			const deliveredMessage = withSenderPrefix(
				scope.caller,
				scope.callerIsSubagent,
				message,
				input.locale as Locale,
			);
			// Keep display identity/body separate from unchanged model-facing text.
			const senderIdentity = {
				id: scope.caller.id,
				title: scope.caller.title,
				label: agentLabelFromNarrator(scope.caller, scope.teamParentId),
				type: scope.callerIsSubagent ? callerSubagentType(scope.caller) : null,
				isParent: !scope.callerIsSubagent,
			};
			const delivery = createAgentMessageDelivery(
				fresh.id,
				senderIdentity,
				input.toolUseId,
				input.message,
			);
			const deliveryMessageId = delivery.recipientMessageId;

			if (fresh.status === "working" || fresh.status === "waiting") {
				const buffered = pushSubagentBufferedMessage(fresh.id, deliveredMessage, {
					position: input.doInterrupt ? "front" : "back",
					delivery,
					createdBy: input.userId ?? null,
				});
				if (!buffered.ok) {
					throw new Error(
						buffered.full ? "Target message queue is full" : "Message was not buffered",
					);
				}
				let interruptNote = "";
				let interrupted: boolean | undefined;
				if (input.doInterrupt) {
					interrupted = interruptForegroundSubagent(fresh.id);
					interruptNote = interrupted
						? " Interrupted foreground subagent."
						: " Target is not an interruptible foreground subagent.";
				}
				if (replyHandle) {
					const deliveryNote = `Sent to ${label}; message queued.${interruptNote} Requested a Send reply.`;
					replyHandle.updateSnapshot({ deliveryNote, interrupted, deliveryMessageId });
					pendingReplies.push({
						id: fresh.id,
						label,
						title: fresh.title,
						handle: replyHandle,
						interrupted,
						deliveryMessageId,
						deliveryNote,
					});
				} else {
					sections.push(`Sent to ${label}; message queued.${interruptNote}`);
					targetResults.push({
						id: fresh.id,
						label,
						title: fresh.title,
						status: "queued",
						deliveryMessageId,
						interrupted,
						awaited: false,
					});
				}
				notifyDeliveryResolved(input, fresh.id, deliveryMessageId);
				continue;
			}

			const bgAbort = new AbortController();
			await resumeSubagent({
				subagentId: fresh.id,
				intent: "follow_up",
				actor: "parent_agent",
				prompt: deliveredMessage,
				delivery,
				createdBy: input.userId ?? null,
				signal: bgAbort.signal,
				locale: input.locale as Locale,
			});
			if (replyHandle) {
				const deliveryNote = `Sent to ${label}; subagent started asynchronously and a Send reply was requested.`;
				replyHandle.updateSnapshot({ deliveryNote, deliveryMessageId });
				pendingReplies.push({
					id: fresh.id,
					label,
					title: fresh.title,
					handle: replyHandle,
					deliveryMessageId,
					deliveryNote,
				});
			} else {
				sections.push(`Sent to ${label}; subagent started asynchronously.`);
				targetResults.push({
					id: fresh.id,
					label,
					title: fresh.title,
					status: "started",
					deliveryMessageId,
					awaited: false,
				});
			}
			notifyDeliveryResolved(input, fresh.id, deliveryMessageId);
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			if (replyHandle) {
				const deliveryNote = `Failed to send to ${label}.`;
				replyHandle.updateSnapshot({ deliveryNote });
				replyHandle.fail(error);
				pendingReplies.push({
					id: target.id,
					label,
					title: target.title,
					handle: replyHandle,
					deliveryNote,
				});
			} else {
				sections.push(`Failed to send to ${label}: ${error}`);
				targetResults.push({
					id: target.id,
					label,
					title: target.title,
					status: "failed",
					awaited: input.shouldAwait,
					error,
				});
			}
		}
	}
	if (pendingReplies.length > 0) {
		return waitForSendReplies(pendingReplies, input.replyRun, {
			sections,
			targets: targetResults,
		});
	}
	return { output: sections.join("\n\n"), targets: targetResults };
}

export async function sendSubagentMessageDetailed(
	input: SendSubagentInput,
): Promise<SendSubagentResult> {
	if (input.shouldAwait && input.toolCallBinding) {
		// Resolve at setup using the durable attempt, not a possibly reused provider ID
		// after the reply has already settled. Only the narrow PK row is read.
		const binding = input.toolCallBinding;
		try {
			const row = await db.query.narratorToolCalls.findFirst({
				where: and(
					eq(narratorToolCalls.id, binding.toolCallId),
					eq(narratorToolCalls.narratorId, input.callerNarratorId),
					eq(narratorToolCalls.toolUseId, input.toolUseId),
					eq(narratorToolCalls.executionAttempt, binding.attempt),
				),
				columns: { messageId: true },
			});
			input = { ...input, requesterMessageId: row?.messageId };
		} catch (error) {
			logger.warn("Failed to resolve waiting Send's bound message", { error: String(error) });
			input = { ...input, requesterMessageId: undefined };
		}
	}
	const replyRun =
		input.shouldAwait && !input.replyRun
			? beginAgentReplyWaitRun({
					toolUseId: input.toolUseId,
					requesterId: input.callerNarratorId,
					requesterToolCallBinding: input.toolCallBinding,
					doInterrupt: input.doInterrupt,
				})
			: undefined;
	try {
		const result = await sendSubagentMessageDetailedWithRun(
			replyRun ? { ...input, replyRun } : input,
		);
		// A reply is received by the already-existing waiting Send message. The
		// waiter preserved that exact address; no additional inbox row is created.
		for (const target of result.targets) {
			if (target.recipientToolUseId && target.deliveryMessageId) {
				notifyDeliveryResolved(input, target.id, target.deliveryMessageId);
			}
		}
		return result;
	} finally {
		replyRun?.complete();
	}
}

export async function sendSubagentMessage(input: SendSubagentInput): Promise<string> {
	return (await sendSubagentMessageDetailed(input)).output;
}
