import { eventBus } from "@server/lib/event-bus";
import { logger } from "@server/lib/logger";
import { getSubagentType, isSubagentVariant, parseSubstatus } from "@server/lib/narrator-utils";
import type { Locale } from "@server/lib/prompt-i18n";
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
	/**
	 * User who triggered the sending turn. Carried onto the delivered message so
	 * the receiving subagent resolves knowledge ACL and fast-mode "inherit"
	 * against a real user instead of anonymous/disabled.
	 */
	userId?: string | null;
	/** Internal aggregate registry used to checkpoint an already-delivered Send await. */
	replyRun?: AgentReplyWaitRunHandle;
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
	pending: Omit<PendingSendReply, "handle">,
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
	const deliveryNote = `${note} Requested a Send reply.`;
	replyHandle.updateSnapshot({ title: target.title, deliveryNote });
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

			if (fresh.status === "working" || fresh.status === "waiting") {
				const buffered = pushSubagentBufferedMessage(fresh.id, deliveredMessage, {
					position: input.doInterrupt ? "front" : "back",
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
					const deliveryNote = `Sent to ${fresh.id}; message queued.${interruptNote} Requested a Send reply.`;
					replyHandle.updateSnapshot({ deliveryNote, interrupted });
					pendingReplies.push({
						id: fresh.id,
						title: fresh.title,
						handle: replyHandle,
						interrupted,
						deliveryNote,
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
				createdBy: input.userId ?? null,
				signal: bgAbort.signal,
				locale: input.locale as Locale,
			});
			if (replyHandle) {
				const deliveryNote = `Sent to ${fresh.id}; subagent started asynchronously and a Send reply was requested.`;
				replyHandle.updateSnapshot({ deliveryNote });
				pendingReplies.push({
					id: fresh.id,
					title: fresh.title,
					handle: replyHandle,
					deliveryNote,
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
			const error = err instanceof Error ? err.message : String(err);
			if (replyHandle) {
				const deliveryNote = `Failed to send to ${target.id}.`;
				replyHandle.updateSnapshot({ deliveryNote });
				replyHandle.fail(error);
				pendingReplies.push({
					id: target.id,
					title: target.title,
					handle: replyHandle,
					deliveryNote,
				});
			} else {
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
	const replyRun =
		input.shouldAwait && !input.replyRun
			? beginAgentReplyWaitRun({
					toolUseId: input.toolUseId,
					requesterId: input.callerNarratorId,
					doInterrupt: input.doInterrupt,
				})
			: undefined;
	try {
		return await sendSubagentMessageDetailedWithRun(replyRun ? { ...input, replyRun } : input);
	} finally {
		replyRun?.complete();
	}
}

export async function sendSubagentMessage(input: SendSubagentInput): Promise<string> {
	return (await sendSubagentMessageDetailed(input)).output;
}
