import { eventBus } from "@server/lib/event-bus";
import { logger } from "@server/lib/logger";
import { getSubagentType, isSubagentVariant, parseSubstatus } from "@server/lib/narrator-utils";
import type { Locale } from "@server/lib/prompt-i18n";
import { foldHandle } from "@shared/narrator-handle";
import {
	type AgentReplyScope,
	type AgentReplyWaitHandle,
	type AgentReplyWaitResult,
	hasPendingAgentReply,
	registerAgentReplyWait,
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
import { hasActiveSubagentResumeRun, resumeSubagent } from "./subagent-resume";
import { waitForBackgroundTask } from "./subagent-runner";
import { isTakenOver } from "./subagent-takeover";

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
	message: string;
	doInterrupt?: boolean;
	shouldAwait?: boolean;
	/** Explicit request id being answered by this Send call. */
	replyTo?: string;
	timeoutMs?: number;
	toolUseId: string;
	signal: AbortSignal;
	locale: string;
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
}

export interface AwaitAgentResult {
	id: string;
	status: string;
	output: string;
	formatted: string;
}

export interface SendTargetResult {
	id: string;
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
				id: target.label ?? target.id,
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
				id: target.label ?? target.id,
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
						id: target.label ?? target.id,
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
			id: target.label ?? target.id,
			title: target.title,
			status: "completed",
			awaited: false,
		});
	}
	return { output: sections.join("\n"), targets: results };
}

function formatSendReplyWaitResult(
	pending: PendingSendReply,
	result: AgentReplyWaitResult,
): { section: string; target: SendTargetResult } {
	const label = pending.label ?? pending.id;
	const baseTarget = {
		id: label,
		title: pending.title,
		interrupted: pending.interrupted,
		awaited: true,
	};
	switch (result.status) {
		case "replied":
			return {
				section:
					`${pending.deliveryNote}\nReceived Send reply from ${label}:\n` +
					`<subagent_id>${pending.id}</subagent_id>\n\n${result.message}`,
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

async function waitForSendReplies(pendingReplies: PendingSendReply[]): Promise<SendSubagentResult> {
	const settled = await Promise.all(
		pendingReplies.map(async (pending) =>
			formatSendReplyWaitResult(pending, await pending.handle.promise),
		),
	);
	return {
		output: settled.map((item) => item.section).join("\n\n"),
		targets: settled.map((item) => item.target),
	};
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
	if (!isSubagentVariant(target.variant)) {
		throw new Error(`${target.id} is not a subagent`);
	}
	if (target.parentNarratorId !== scope.teamParentId) {
		throw new Error(`${target.id} does not belong to this narrator's subagent team`);
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
		const lines = candidates.map((c) => `- ${c.id} | ${c.title ?? "(untitled)"}`).join("\n");
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

function formatSubagentResult(subagentId: string, finalText: string | null | undefined): string {
	return `<subagent_id>${subagentId}</subagent_id>\n\n${finalText || "(no output)"}`;
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
 */
export function formatAgentAwaitResult(
	id: string,
	status: string,
	output: string | null,
	recentActivity?: string,
): string {
	const trimmed = output?.trim() ?? "";
	const partial = EMPTY_AWAIT_OUTPUTS.has(trimmed) ? "" : trimmed;
	const tag = `<subagent_id>${id}</subagent_id>`;
	const activitySection = recentActivity ? `\n\n${recentActivity}` : "";
	switch (status) {
		case "aborted":
			return (
				`${tag}\n\n` +
				`Await on agent ${id} was interrupted — only this wait was canceled, not the subagent. ` +
				`The subagent is still running in the background. Call Await again with the same id to ` +
				`keep waiting for its result.` +
				(partial ? `\n\nPartial output so far:\n${partial}` : "")
			);
		case "running":
		case "timeout":
			return (
				`${tag}\n\n` +
				`Agent ${id} is still running — the wait timed out but the subagent has not stopped. ` +
				`Call Await again with the same id and a meaningful timeout to keep waiting. ` +
				`Do not send a progress check or interrupt it merely because this wait expired.` +
				activitySection +
				(partial ? `\n\nPartial output so far:\n${partial}` : "")
			);
		case "timed_out":
			return (
				`${tag}\n\n` +
				`Agent ${id} exceeded its execution time limit and was stopped.` +
				(partial ? `\n\nTimeout details:\n${partial}` : "")
			);
		case "taken_over":
			return (
				`${tag}\n\n` +
				`Agent ${id} is being taken over by the user. The user is operating it directly; ` +
				`its result will be returned only when the user stops the takeover. ` +
				`Call Await again later with the same id to retrieve the final result.` +
				(partial ? `\n\nOutput so far:\n${partial}` : "")
			);
		default:
			return `Agent ${id} status: ${status}\n\n${formatSubagentResult(id, output)}`;
	}
}

async function buildAwaitAgentResult(
	id: string,
	status: string,
	output: string | null | undefined,
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
	return {
		id,
		status,
		output: output ?? "(no output)",
		formatted: formatAgentAwaitResult(id, status, output ?? null, recentActivity),
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

		const onAbort = () => {
			cleanup();
			resolve({ status: "aborted", output: "Await aborted." });
		};

		eventBus.on("narrator:subagent_completed", onCompleted);
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
		return buildAwaitAgentResult(background.id, background.status, background.output);
	}

	const target = await resolveOneTarget(opts.id, scope);
	if (target.isBackground && target.backgroundStatus === "running") {
		const { signal, relabel } = buildAwaitTimeoutContext(opts);
		const waited = await waitForBackgroundTask(
			target.id,
			opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			signal,
		);
		const status = relabel(waited.status);
		return buildAwaitAgentResult(target.id, status, waited.result);
	}
	if (target.isBackground && target.backgroundStatus) {
		return buildAwaitAgentResult(target.id, target.backgroundStatus, target.backgroundResult);
	}
	if (target.status === "working" || target.status === "waiting") {
		// If the subagent is being taken over by the user, do not block waiting for
		// a result that only arrives when takeover ends. Report it immediately.
		if (isTakenOver(target.id)) {
			const finalText = await getSubagentFinalText(target.id);
			return buildAwaitAgentResult(target.id, "taken_over", finalText);
		}
		const { signal, relabel } = buildAwaitTimeoutContext(opts);
		const waited = await waitForSubagentResult({
			subagentId: target.id,
			parentNarratorId: target.parentNarratorId as string,
			timeoutMs: opts.timeoutMs,
			signal,
		});
		const status = relabel(waited.status);
		return buildAwaitAgentResult(target.id, status, waited.output);
	}
	const finalText = await getSubagentFinalText(target.id);
	const status = settledSubagentStatus(target);
	return buildAwaitAgentResult(target.id, status, finalText);
}

export async function awaitAgentResult(opts: AwaitAgentInput): Promise<string> {
	return (await awaitAgentResultDetailed(opts)).formatted;
}

/**
 * Resolve a single selector to a fellow chat-group member narrator of the caller.
 * Matches by exact id, handle, slugified title, or title. Returns the member's
 * narrator id and the shared group id, or null if the selector is not a fellow
 * group member.
 */
function normalizeGroupMemberSelector(selector: string): string {
	const trimmed = selector.trim();
	return trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
}

async function resolveGroupMemberSelector(
	callerNarratorId: string,
	selector: string,
): Promise<{ narratorId: string; groupId: string } | null> {
	const { chatGroupService } = await import("./chat-group-service");
	const groups = await chatGroupService.listGroupsForNarrator(callerNarratorId);
	if (groups.length === 0) return null;

	const rawSelector = selector.trim();
	const normalizedSelector = normalizeGroupMemberSelector(selector);
	// Case-insensitive handle key (matches the storage fold), so "@MyBot" resolves
	// a narrator whose stored handle is "MyBot" / "mybot".
	const foldedSelector = foldHandle(normalizedSelector);

	for (const group of groups) {
		const members = await chatGroupService.listNarratorMembers(group.id);
		for (const member of members) {
			if (!member.narratorId || member.narratorId === callerNarratorId) continue;
			const narrator = await narratorService.getById(member.narratorId).catch(() => null);
			if (!narrator) continue;
			const narratorFold =
				narrator.handleFold ?? (narrator.handle ? foldHandle(narrator.handle) : null);
			if (
				narrator.id === rawSelector ||
				narrator.id === normalizedSelector ||
				(narratorFold !== null && narratorFold === foldedSelector) ||
				subagentMatchesSelector(narrator, rawSelector) ||
				subagentMatchesSelector(narrator, normalizedSelector)
			) {
				return { narratorId: narrator.id, groupId: group.id };
			}
		}
	}
	return null;
}

/**
 * Attempt to route a Send via a chat group. Returns a result if every selector
 * resolves to a fellow group member; returns null if no selector matches a group
 * member (so the caller can fall through to the subagent-team path).
 */
async function tryRouteViaChatGroup(input: SendSubagentInput): Promise<SendSubagentResult | null> {
	const selectors = getSelectors(input);
	if (selectors.length === 0) return null;

	const { chatGroupService } = await import("./chat-group-service");
	const resolved: { selector: string; narratorId: string; groupId: string }[] = [];
	for (const selector of selectors) {
		const match = await resolveGroupMemberSelector(input.callerNarratorId, selector);
		if (match) resolved.push({ selector, ...match });
	}
	// If none of the selectors are group members, this isn't a group send.
	if (resolved.length === 0) return null;
	if (resolved.length !== selectors.length) {
		const resolvedSelectors = new Set(resolved.map((item) => item.selector));
		const targets = selectors.map((selector) => ({
			id: selector,
			status: "failed" as const,
			error: resolvedSelectors.has(selector)
				? "Mixed group and non-group Send targets are not delivered together; split this into separate Send calls."
				: "Target is not a fellow chat-group member.",
		}));
		return {
			output: targets
				.map((target) => `Failed to deliver to "${target.id}": ${target.error}`)
				.join("\n"),
			targets,
		};
	}

	const distinctTargets = [
		...new Map(resolved.map((target) => [target.narratorId, target])).values(),
	];
	if (input.replyTo && distinctTargets.length !== 1) {
		return {
			output: "An explicit replyTo Send must address exactly one requester.",
			targets: distinctTargets.map((target) => ({
				id: target.selector,
				status: "failed" as const,
				error: "replyTo requires exactly one target.",
			})),
		};
	}
	const incomingReplies = resolveIncomingSendReplies(
		input.callerNarratorId,
		distinctTargets.map((target) => ({
			id: target.narratorId,
			label: target.selector,
			scope: { type: "chat-group", id: target.groupId },
		})),
		input.message,
		input.replyTo,
	);
	if (incomingReplies) return incomingReplies;

	const replyHandles = new Map<string, AgentReplyWaitHandle>();
	if (input.shouldAwait) {
		try {
			for (const target of distinctTargets) {
				replyHandles.set(
					target.narratorId,
					registerAgentReplyWait({
						requesterId: input.callerNarratorId,
						responderId: target.narratorId,
						scope: { type: "chat-group", id: target.groupId },
						timeoutMs: input.timeoutMs,
						signal: input.signal,
					}),
				);
			}
		} catch (err) {
			for (const handle of replyHandles.values()) handle.cancel();
			const error = err instanceof Error ? err.message : String(err);
			return {
				output: `Cannot wait for chat-group Send replies: ${error}`,
				targets: distinctTargets.map((target) => ({
					id: target.selector,
					status: "failed",
					awaited: true,
					error,
				})),
			};
		}
	}

	const groupErrors = new Map<string, string>();
	if (input.shouldAwait) {
		for (const target of distinctTargets) {
			const handle = replyHandles.get(target.narratorId) as AgentReplyWaitHandle;
			try {
				await chatGroupService.postMessage({
					groupId: target.groupId,
					content: appendSendReplyRequest(
						input.message,
						input.callerNarratorId,
						handle.requestId,
						input.locale as Locale,
					),
					senderType: "narrator",
					senderNarratorId: input.callerNarratorId,
					locale: input.locale as Locale,
					deliverNarratorIds: [target.narratorId],
				});
			} catch (err) {
				groupErrors.set(target.narratorId, err instanceof Error ? err.message : String(err));
			}
		}
	} else {
		for (const groupId of new Set(distinctTargets.map((target) => target.groupId))) {
			try {
				await chatGroupService.postMessage({
					groupId,
					content: input.message,
					senderType: "narrator",
					senderNarratorId: input.callerNarratorId,
					locale: input.locale as Locale,
				});
			} catch (err) {
				for (const target of distinctTargets) {
					if (target.groupId === groupId) {
						groupErrors.set(target.narratorId, err instanceof Error ? err.message : String(err));
					}
				}
			}
		}
	}

	if (input.shouldAwait) {
		const pendingReplies: PendingSendReply[] = [];
		for (const target of distinctTargets) {
			const handle = replyHandles.get(target.narratorId) as AgentReplyWaitHandle;
			const error = groupErrors.get(target.narratorId);
			if (error) handle.fail(error);
			pendingReplies.push({
				id: target.narratorId,
				label: target.selector,
				handle,
				deliveryNote: error
					? `Could not deliver to group member "${target.selector}".`
					: `Delivered to group member "${target.selector}" and requested a Send reply.`,
			});
		}
		return waitForSendReplies(pendingReplies);
	}

	const sections: string[] = [];
	const targetResults: SendTargetResult[] = [];
	for (const target of distinctTargets) {
		const error = groupErrors.get(target.narratorId);
		if (error) {
			sections.push(`Failed to deliver to "${target.selector}": ${error}`);
			targetResults.push({ id: target.selector, status: "failed", error });
		} else {
			sections.push(`Delivered to group member "${target.selector}".`);
			targetResults.push({ id: target.selector, status: "completed" });
		}
	}
	return { output: sections.join("\n"), targets: targetResults };
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
		const name = caller.title?.trim() || caller.id.slice(0, 8);
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

	pushParentInboundMessage(parentId, {
		fromId: scope.caller.id,
		fromTitle: scope.caller.title,
		fromType: callerSubagentType(scope.caller),
		text: input.message,
		timestamp: new Date().toISOString(),
	});

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
	};
}

/**
 * Attempt to route a Send from a subagent to its parent narrator. Returns a
 * result when every selector targets the parent; returns null when no selector
 * is parent-bound (caller falls through to sibling routing). A mix of parent
 * and non-parent selectors is rejected (mirrors chat-group mixed-target rules).
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
				responderId: scope.teamParentId,
				scope: replyScope,
				timeoutMs: input.timeoutMs,
				signal: input.signal,
			});
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			return {
				output: `Cannot wait for a Send reply from the parent narrator: ${error}`,
				targets: [
					{
						id: scope.teamParentId,
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
		return { output: note, targets: [{ ...target, awaited: false }] };
	}
	if (target.status === "failed") {
		replyHandle.fail(target.error ?? "Failed to report to the parent narrator");
	}
	return waitForSendReplies([
		{
			id: scope.teamParentId,
			label: parentMatches[0],
			title: target.title,
			handle: replyHandle,
			deliveryNote: `${note} Requested a Send reply.`,
		},
	]);
}

export async function sendSubagentMessageDetailed(
	input: SendSubagentInput,
): Promise<SendSubagentResult> {
	const scope = await getCommunicationScope(input.callerNarratorId);
	assertSubagentSendIsAsync(scope.callerIsSubagent, input.shouldAwait);

	// Chat-group routing: if the caller is a primary narrator and the selector(s)
	// resolve to fellow chat-group member narrators, deliver via the group instead
	// of the subagent-team path. This is how named narrators converse across
	// sessions. Subagents continue to use the team path exclusively.
	if (!scope.callerIsSubagent && !input.doInterrupt) {
		const groupResult = await tryRouteViaChatGroup(input);
		if (groupResult) return groupResult;
	}

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
	if (input.replyTo && targets.length !== 1) {
		return {
			output: "An explicit replyTo Send must address exactly one requester.",
			targets: targets.map((target) => ({
				id: target.id,
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
		try {
			if (input.doInterrupt && target.parentNarratorId !== input.callerNarratorId) {
				throw new Error("doInterrupt is only supported for this narrator's direct child subagents");
			}

			const fresh = await narratorService.getById(target.id);
			if (fresh.status === "archived") {
				throw new Error("Target subagent is archived");
			}

			// If the user has taken over this subagent, the parent must not drive it.
			// Report the takeover so the agent waits for the user to finish.
			if (isTakenOver(fresh.id)) {
				sections.push(
					`Agent ${fresh.id} is being taken over by the user and cannot be driven right now. ` +
						`Its result will be available after the user stops the takeover.`,
				);
				targetResults.push({
					id: fresh.id,
					title: fresh.title,
					status: "taken_over",
					awaited: input.shouldAwait,
				});
				continue;
			}

			if (input.shouldAwait) {
				replyHandle = registerAgentReplyWait({
					requesterId: scope.caller.id,
					responderId: fresh.id,
					scope: targetReplyScope(fresh),
					timeoutMs: input.timeoutMs,
					signal: input.signal,
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

			if (fresh.status === "working" || fresh.status === "waiting") {
				const buffered = pushSubagentBufferedMessage(fresh.id, deliveredMessage, {
					position: input.doInterrupt ? "front" : "back",
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
					pendingReplies.push({
						id: fresh.id,
						title: fresh.title,
						handle: replyHandle,
						interrupted,
						deliveryNote: `Sent to ${fresh.id}; message queued.${interruptNote} Requested a Send reply.`,
					});
				} else {
					sections.push(`Sent to ${fresh.id}; message queued.${interruptNote}`);
					targetResults.push({
						id: fresh.id,
						title: fresh.title,
						status: "queued",
						interrupted,
						awaited: false,
					});
				}
				continue;
			}

			const bgAbort = new AbortController();
			await resumeSubagent({
				subagentId: fresh.id,
				intent: "follow_up",
				actor: "parent_agent",
				prompt: deliveredMessage,
				signal: bgAbort.signal,
				locale: input.locale as Locale,
			});
			if (replyHandle) {
				pendingReplies.push({
					id: fresh.id,
					title: fresh.title,
					handle: replyHandle,
					deliveryNote: `Sent to ${fresh.id}; subagent started asynchronously and a Send reply was requested.`,
				});
			} else {
				sections.push(`Sent to ${fresh.id}; subagent started asynchronously.`);
				targetResults.push({
					id: fresh.id,
					title: fresh.title,
					status: "started",
					awaited: false,
				});
			}
		} catch (err) {
			replyHandle?.cancel();
			const error = err instanceof Error ? err.message : String(err);
			sections.push(`Failed to send to ${target.id}: ${error}`);
			targetResults.push({
				id: target.id,
				title: target.title,
				status: "failed",
				awaited: input.shouldAwait,
				error,
			});
		}
	}
	if (pendingReplies.length > 0) {
		const replies = await waitForSendReplies(pendingReplies);
		sections.push(replies.output);
		targetResults.push(...replies.targets);
	}
	return { output: sections.join("\n\n"), targets: targetResults };
}

export async function sendSubagentMessage(input: SendSubagentInput): Promise<string> {
	return (await sendSubagentMessageDetailed(input)).output;
}
