import { eventBus } from "@server/lib/event-bus";
import { logger } from "@server/lib/logger";
import { getSubagentType, parseSubstatus } from "@server/lib/narrator-utils";
import type { Locale } from "@server/lib/prompt-i18n";
import { runDeliverToOf, teamRootOf } from "@server/lib/runtime-source";
import { isParentSelector, type SendDeliveryTarget } from "@shared/communication-tool";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorBufferedMessages } from "../db/schema";
import type { ToolCallBinding } from "../lib/agent/types";
import { createAgentMessageDelivery } from "./agent-message-delivery";
import {
	blockingStopReason,
	enqueueInboxAgent,
	type ResumableStopReason,
	wakeInboxIfEligible,
} from "./agent-runtime/inbox";
import { getExecutionOwner, getRunHold } from "./agent-runtime/ownership";
import { getRuntimePublicationService, type PublicationRun } from "./agent-runtime/publication";
import { controlRun, wakeHeldRun } from "./agent-runtime/run";
import { backgroundTaskService } from "./background-task-service";
import { authorizeAgentControl } from "./narrator-control";
import { narratorService } from "./narrator-service";
import { getSubagentFinalText } from "./narrator-session";
import { formatRecentSubagentActivity, getRecentSubagentToolActivity } from "./subagent-activity";
import { resolveTaskAlias, subagentMatchesSelector } from "./subagent-alias";
import { assertRuntimeCanAwaitAgent } from "./subagent-communication-policy";
import { agentLabelFromNarrator, resolveAgentLabel, shortAgentId } from "./subagent-label";
import {
	applySubagentModelSwitch,
	planSubagentModelSwitch,
	type SubagentModelSwitchPlan,
} from "./subagent-model-switch";

const TAKEN_OVER_SUBSTATUS = "taken_over";
const isTakenOver = (narratorId: string) => !!getRunHold(narratorId);

import { resolveNarratorRuntimePolicy } from "./trait-layer-service";

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
	/** Navigation only; reserved IDs must be checked for actual existence before opening. */
	onDeliveryResolved?: (target: SendDeliveryTarget & { deliveryMessageId: string }) => void;
	onTargetsResolved?: (count: number) => void;
	message: string;
	doInterrupt?: boolean;
	/**
	 * Explicitly restart a direct child whose last turn ended with an error. Agent
	 * messages alone never restart such a session; this is the one-call opt-in.
	 */
	resume?: boolean;
	/** Switch each direct child's model before delivery (`"parent"` follows the delegator again). */
	model?: string;
	toolUseId: string;
	signal: AbortSignal;
	locale: string;
	/**
	 * User who triggered the sending turn. Carried onto the delivered message so
	 * the receiving subagent resolves knowledge ACL and fast-mode "inherit"
	 * against a real user instead of anonymous/disabled.
	 */
	userId?: string | null;
}

export interface AwaitAgentInput {
	callerNarratorId: string;
	id: string;
	/** Execution principal of the caller's run; the ceiling is resolved for it. */
	userId?: string | null;
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
	 *
	 * `title` carries the narrator's current display name when the resolver already
	 * holds the row (the common case), so the running card can headline the session
	 * name rather than the slug. Null when the resolver never loaded it.
	 */
	onTargetResolved?: (subagentNarratorId: string, title?: string | null) => void;
}

export interface AwaitAgentResult {
	id: string;
	/**
	 * Human/model-facing label for `id` (alias → title slug → short id). The
	 * formatted text uses this; `id` stays the real narrator id so the tool layer
	 * can hand the frontend something it can navigate to.
	 */
	label: string;
	/**
	 * The subagent session's current title (the Agent call's `description`, or a
	 * generated title) when the producing path already had the narrator row in
	 * hand. Null when it did not — the frontend falls back to `label`.
	 */
	title?: string | null;
	status: string;
	output: string;
	formatted: string;
	terminalResultReceived?: boolean;
	publicationRun?: PublicationRun;
	sourceResultRef?: string;
}

export interface SendTargetResult extends SendDeliveryTarget {
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
		| "taken_over"
		| "blocked";
	/** `blocked` only: why the queued message cannot start the target by itself. */
	blockedReason?: ResumableStopReason;
	/** Model reference stored for the target by this Send's `model` switch. */
	model?: string;
	resumed?: boolean;
	interrupted?: boolean;
	error?: string;
}

export interface SendSubagentResult {
	output: string;
	targets: SendTargetResult[];
}

/** Stable coordinates survive COW and can be recovered by reserved address. */
function stableSendCoordinates(
	id: string,
	messageId?: string,
	delivery?: Pick<
		import("./agent-message-delivery").AgentMessageDelivery,
		"deliveryId" | "recipientRefId" | "revision"
	>,
): Partial<SendDeliveryTarget> {
	if (delivery?.deliveryId)
		return {
			deliveryId: delivery.deliveryId,
			recipientRefId: delivery.recipientRefId,
			revision: delivery.revision,
		};
	if (!messageId) return {};
	const row = db
		.select({
			deliveryId: narratorBufferedMessages.deliveryId,
			recipientRefId: narratorBufferedMessages.recipientRefId,
			revision: narratorBufferedMessages.contentRevision,
			receiptDisposition: narratorBufferedMessages.receiptDisposition,
		})
		.from(narratorBufferedMessages)
		.where(
			and(
				eq(narratorBufferedMessages.narratorId, id),
				eq(narratorBufferedMessages.recipientMessageId, messageId),
			),
		)
		.limit(1)
		.get();
	if (!row?.deliveryId) return {};
	return {
		deliveryId: row.deliveryId,
		recipientRefId: row.recipientRefId ?? undefined,
		revision: row.revision,
		receiptDisposition: row.receiptDisposition,
	};
}
function notifyDeliveryResolved(
	input: SendSubagentInput,
	id: string,
	deliveryMessageId: string,
	title?: string | null,
	delivery?: import("./agent-message-delivery").AgentMessageDelivery,
): void {
	try {
		input.onDeliveryResolved?.({
			id,
			deliveryMessageId,
			...stableSendCoordinates(id, deliveryMessageId, delivery),
			...(title !== undefined ? { title } : {}),
		});
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
	const teamParentId = teamRootOf(caller);
	return { caller, teamParentId, callerIsSubagent: teamParentId !== caller.id };
}

function assertTargetAllowed(
	target: Narrator,
	scope: Awaited<ReturnType<typeof getCommunicationScope>>,
) {
	// These messages reach the model, so they name the target the same readable
	// way every other Send/Await outlet does.
	const label = agentLabelFromNarrator(target, scope.teamParentId);
	const root = teamRootOf(target);
	if (root === target.id) {
		throw new Error(`${label} is not a subagent`);
	}
	if (root !== scope.teamParentId) {
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

	const siblings = await narratorService.listTeamMembers(scope.teamParentId);
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
				`Wait interrupted; agent ${label} is still running. Await again with the same id.` +
				(partial ? `\n\nPartial output so far:\n${partial}` : "")
			);
		case "running":
		case "timeout":
			return (
				`${tag}\n\n` +
				`Agent ${label} is still running — this wait timed out, not the subagent. ` +
				`Await again with the same id. ` +
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
				`Agent ${label} is being taken over by the user. Await again after takeover ends.` +
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
	receipt?: Pick<AwaitAgentResult, "terminalResultReceived" | "publicationRun" | "sourceResultRef">,
	knownTitle?: string | null,
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
		...(knownTitle ? { title: knownTitle } : {}),
		status,
		output: output ?? "(no output)",
		formatted: formatAgentAwaitResult(label, status, output ?? null, recentActivity),
		...(receipt
			? {
					terminalResultReceived: receipt.terminalResultReceived,
					publicationRun: receipt.publicationRun,
					sourceResultRef: receipt.sourceResultRef,
				}
			: {}),
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

type SubagentWaitResult = Pick<
	AwaitAgentResult,
	"status" | "output" | "terminalResultReceived" | "publicationRun" | "sourceResultRef"
>;

/** Never pair a later run lookup with an earlier assistant result. */
async function readSubagentTerminal(
	subagentId: string,
	recipientId: string,
	current: Narrator,
	observedRunningRunId?: string | null,
): Promise<SubagentWaitResult> {
	const run: PublicationRun | undefined = current.logicalRunId
		? {
				producerKind: "agent",
				taskId: subagentId,
				recipientId,
				logicalRunId: current.logicalRunId,
			}
		: undefined;
	// A matching narrator epoch is not proof that its last assistant belongs to
	// that epoch: an early failed continuation may still have only the old reply.
	// Require this run's immutable terminal source, or a post-boundary assistant
	// after the waiter observed this same run transition from running to settled.
	const terminalObserved = run !== undefined && observedRunningRunId === run.logicalRunId;
	const terminal = run
		? await getRuntimePublicationService()
				.readAgentTerminalResult(run, {
					settledRunId: terminalObserved ? run.logicalRunId : undefined,
				})
				.catch((error) => {
					logger.warn("Failed to read run-bound Await result", { run, error: String(error) });
					return null;
				})
		: null;
	const output =
		terminal?.output ??
		(run
			? "(no output for this run)"
			: current.isBackground && current.backgroundStatus
				? (current.backgroundResult ?? "(no output)")
				: await getSubagentFinalText(subagentId));
	const latest = await narratorService.getById(subagentId);
	const status = settledSubagentStatus(
		current,
		current.isBackground && current.backgroundStatus && current.backgroundStatus !== "running"
			? current.backgroundStatus
			: "completed",
	);
	const terminalResultReceived =
		terminal !== null &&
		status !== "taken_over" &&
		subagentRunHasSettled(subagentId, current.status, parseSubstatus(current.substatus)) &&
		subagentRunHasSettled(subagentId, latest.status, parseSubstatus(latest.substatus)) &&
		current.logicalRunId === latest.logicalRunId;
	return {
		status,
		output,
		...(terminalResultReceived
			? {
					terminalResultReceived: true,
					publicationRun: run,
					sourceResultRef: terminal?.sourceResultRef,
				}
			: {}),
	};
}

export async function waitForSubagentResult(opts: {
	subagentId: string;
	/** Recipient of the subagent's current run. */
	recipientId: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<SubagentWaitResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const current = await narratorService.getById(opts.subagentId);
	if (current.status !== "working" && current.status !== "waiting") {
		return readSubagentTerminal(opts.subagentId, opts.recipientId, current);
	}

	const observedRunningRunId = current.logicalRunId;
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

		let finishing = false;
		const finish = async (_status: string) => {
			if (settled || finishing) return;
			finishing = true;
			try {
				const current = await narratorService.getById(opts.subagentId);
				if (
					!subagentRunHasSettled(opts.subagentId, current.status, parseSubstatus(current.substatus))
				)
					return;
				const result = await readSubagentTerminal(
					opts.subagentId,
					opts.recipientId,
					current,
					observedRunningRunId,
				);
				if (settled) return; // Interrupt/timeout wins while result reads are in flight.
				cleanup();
				resolve(result);
			} catch (err) {
				logger.warn("Failed to read subagent terminal result", {
					subagentId: opts.subagentId,
					error: String(err),
				});
			} finally {
				finishing = false;
			}
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
function notifyTargetResolved(
	opts: AwaitAgentInput,
	subagentNarratorId: string,
	title?: string | null,
): void {
	if (!opts.onTargetResolved || !subagentNarratorId) return;
	try {
		opts.onTargetResolved(subagentNarratorId, title);
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
	const current = await narratorService.getById(subagentId).catch(() => null);
	notifyTargetResolved(opts, subagentId, current?.title);
	if (current && isTakenOver(subagentId)) return null;
	if (current && task.status !== "running" && !current.isBackground) {
		// The background task row is from a previous run. The same subagent may have
		// since been continued via Send, so fall through to narrator-state waiting.
		return null;
	}

	// The terminal row can restart before the waiter rechecks it. Both paths must
	// use the same deadline signal and preserve the waiter's exact result/run receipt.
	const { signal, relabel } = buildAwaitTimeoutContext(opts);
	const waited = await backgroundTaskService.waitForCompletion(
		task.id,
		opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		signal,
	);
	return {
		id: subagentId,
		...waited,
		status: relabel(waited.status),
		title: current?.title ?? null,
	};
}

export async function awaitAgentResultDetailed(opts: AwaitAgentInput): Promise<AwaitAgentResult> {
	const scope = await getCommunicationScope(opts.callerNarratorId);
	assertRuntimeCanAwaitAgent(
		await resolveNarratorRuntimePolicy(scope.caller.id, opts.userId ?? null),
	);

	const background = await awaitBackgroundAgentTask(opts);
	if (background) {
		return buildAwaitAgentResult(
			scope.teamParentId,
			background.id,
			background.status,
			background.output,
			undefined,
			background,
			background.title,
		);
	}

	const target = await resolveOneTarget(opts.id, scope);
	// Announce the target before waiting: every branch below may block for the full
	// timeout, and the UI needs this id to offer "open session" meanwhile.
	notifyTargetResolved(opts, target.id, target.title);
	// The narrator row is in hand, so the label needs no extra query.
	const label = agentLabelFromNarrator(target, scope.teamParentId);
	// The result belongs to whoever the target's current run delivers to.
	const recipientId = runDeliverToOf(target)?.narratorId ?? scope.teamParentId;
	const build = (
		status: string,
		output: string | null | undefined,
		receipt?: Pick<
			AwaitAgentResult,
			"terminalResultReceived" | "publicationRun" | "sourceResultRef"
		>,
	) =>
		buildAwaitAgentResult(
			scope.teamParentId,
			target.id,
			status,
			output,
			label,
			receipt,
			target.title,
		);
	// Every background run is projected by a task row (creation, detach, recovery and
	// each later run of the session), handled above; the session row alone never
	// settles a background wait.
	if (target.status === "working" || target.status === "waiting") {
		// If the subagent is being taken over by the user, do not block waiting for
		// a result that only arrives when takeover ends. Report it immediately.
		if (isTakenOver(target.id)) {
			return build("taken_over", await getSubagentFinalText(target.id));
		}
		const { signal, relabel } = buildAwaitTimeoutContext(opts);
		const waited = await waitForSubagentResult({
			subagentId: target.id,
			recipientId,
			timeoutMs: opts.timeoutMs,
			signal,
		});
		return build(relabel(waited.status), waited.output, waited);
	}
	const terminal = await readSubagentTerminal(target.id, recipientId, target);
	return build(terminal.status, terminal.output, terminal);
}

export async function awaitAgentResult(opts: AwaitAgentInput): Promise<string> {
	return (await awaitAgentResultDetailed(opts)).formatted;
}

export { isParentSelector };

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
 * Deliver a subagent → parent (team root) progress report. A working/waiting parent
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
		input.message,
		input.toolCallBinding,
	);
	const accepted = await enqueueInboxAgent(delivery, input.message, {
		channel: "parent",
		userId: input.userId ?? null,
		createdBy: input.userId ?? null,
	});
	if (accepted.delivery.state === "cancelled" || accepted.delivery.state === "failed")
		throw new Error(`Previous delivery is ${accepted.delivery.state}; explicit retry is required`);

	notifyDeliveryResolved(input, parentId, delivery.recipientMessageId, parent.title, delivery);

	// Wake the parent only when idle; a working/waiting parent drains the queue
	// at its next after_tools sidecar boundary.
	const started =
		accepted.delivery.state === "queued" && !getExecutionOwner(parentId)
			? await wakeInboxIfEligible(parentId, input.locale as Locale)
			: false;

	return {
		id: parentId,
		title: parent.title,
		status: started ? "started" : "queued",
		deliveryMessageId: delivery.recipientMessageId,
		...stableSendCoordinates(parentId, delivery.recipientMessageId, delivery),
	};
}

/** Resolve every Send destination before delivery; parent/main are reserved, not sibling aliases. */
async function resolveSendTargets(
	input: SendSubagentInput,
	scope: Awaited<ReturnType<typeof getCommunicationScope>>,
): Promise<Narrator[]> {
	const selectors = getSelectors(input);
	if (!selectors.length) throw new Error("At least one target id/name is required");
	const targets = new Map<string, Narrator>();
	for (const selector of selectors) {
		const targetsParent =
			scope.callerIsSubagent && (isParentSelector(selector) || selector === scope.teamParentId);
		const target = targetsParent
			? await narratorService.getById(scope.teamParentId)
			: await resolveOneTarget(selector, scope);
		if (targetsParent && teamRootOf(target) !== target.id)
			throw new Error("Parent is not a primary narrator");
		targets.set(target.id, target);
	}
	return [...targets.values()];
}

function blockedSendNote(
	label: string,
	reason: ResumableStopReason,
	resumeRequested: boolean,
): string {
	if (reason === "user_interrupt")
		return (
			`Sent to ${label}, but it is NOT running: the user stopped its last turn, so agent ` +
			"messages do not restart it" +
			(resumeRequested ? " and resume=true cannot override the user's stop" : "") +
			". The message stays queued (visible on its page) until the user resumes it; " +
			"do not assume it has been read."
		);
	return (
		`Sent to ${label}, but it is NOT running: its last turn ended with an error, so agent ` +
		"messages do not restart it automatically. The message stays queued (visible on its " +
		"page) and has not been read. Send again with resume=true to restart it (optionally " +
		"with model=... to switch its model first), or ask the user to resume it."
	);
}

export async function sendSubagentMessageDetailed(
	input: SendSubagentInput,
): Promise<SendSubagentResult> {
	const scope = await getCommunicationScope(input.callerNarratorId);

	// Resolve and authorize the WHOLE call before any enqueue or interrupt.
	// Reaching a target (step 4 owns that rule) is not control: an interrupt additionally
	// needs the target's registered controller grant for "steer".
	const targets = await resolveSendTargets(input, scope);
	const modelRequest = input.model?.trim() ? input.model : undefined;
	if (input.doInterrupt || input.resume || modelRequest !== undefined) {
		for (const target of targets)
			await authorizeAgentControl({
				callerNarratorId: scope.caller.id,
				targetNarratorId: target.id,
				action: "steer",
				userId: input.userId ?? null,
			});
	}
	// Validated for every target before anything is written, like the grant above.
	const modelPlans = new Map<string, SubagentModelSwitchPlan>();
	if (modelRequest !== undefined) {
		for (const target of targets) {
			if (isTakenOver(target.id))
				throw new Error(
					`Agent ${agentLabelFromNarrator(target, scope.teamParentId)} is taken over by the user; its model cannot be changed now.`,
				);
			modelPlans.set(
				target.id,
				await planSubagentModelSwitch(target, modelRequest, input.userId ?? null),
			);
		}
	}
	try {
		input.onTargetsResolved?.(targets.length);
	} catch (error) {
		logger.warn("Send target count notification failed", { error: String(error) });
	}

	const sections: string[] = [];
	const targetResults: SendTargetResult[] = [];
	for (const target of targets) {
		// Readable name for every message about this target, refreshed from `fresh`
		// below once it is loaded.
		let label = agentLabelFromNarrator(target, scope.teamParentId);
		try {
			if (scope.callerIsSubagent && target.id === scope.teamParentId) {
				label = "parent";
				const delivered = await deliverSubagentMessageToParent(input, scope);
				targetResults.push({ ...delivered, label });
				sections.push(
					delivered.status === "failed"
						? `Failed to send to parent: ${delivered.error}`
						: delivered.status === "started"
							? "Sent to parent; its next eligible turn was scheduled."
							: "Sent to parent; queued at a safe input boundary (reading not guaranteed).",
				);
				continue;
			}

			const fresh = await narratorService.getById(target.id);
			assertTargetAllowed(fresh, scope);
			label = agentLabelFromNarrator(fresh, scope.teamParentId);
			if (fresh.status === "archived") {
				throw new Error("Target subagent is archived");
			}

			// A taken-over subagent is driven by the user like an independent narrator, and
			// an independent narrator still receives its team's messages. Rejecting the Send
			// here (the old behaviour) silently dropped the parent's instruction: the model
			// was told "cannot be driven right now" and nothing was ever queued. The message
			// is delivered through the ordinary paths below instead — buffered into a running
			// turn, or waking the suspended runner — and the takeover itself is untouched,
			// so the subagent parks in `taken_over` again when that turn ends.
			//
			// What the parent may NOT do is cut into the user's turn: `doInterrupt` would stop
			// work the user is steering, so it is ignored for a taken-over target.
			const takenOver = isTakenOver(fresh.id);
			const takeoverNote = takenOver
				? ` Agent ${label} is taken over by the user: it will handle this message and then` +
					" wait for the user again; its final result arrives after the user stops the takeover."
				: "";
			const interruptTarget = input.doInterrupt && !takenOver;
			const running = fresh.status === "working" || fresh.status === "waiting";
			const modelPlan = modelPlans.get(fresh.id);
			let modelNote = "";
			if (modelPlan) {
				await applySubagentModelSwitch(fresh.id, modelPlan);
				modelNote =
					` Model switched to ${modelPlan.model}` +
					(running ? " (applies from its next model request)." : ".");
			}

			// Prefix sibling/child-bound messages with a sender label so the recipient
			// can tell who sent it (user-typed page messages bypass this path entirely).
			const deliveredMessage = withSenderPrefix(
				scope.caller,
				scope.callerIsSubagent,
				input.message,
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
				input.toolCallBinding,
			);
			let deliveryMessageId = delivery.recipientMessageId;

			if (running) {
				const enqueued = await enqueueInboxAgent(delivery, deliveredMessage, {
					createdBy: input.userId ?? null,
				});
				if (enqueued.delivery.state === "cancelled" || enqueued.delivery.state === "failed")
					throw new Error(
						`Previous delivery is ${enqueued.delivery.state}; explicit retry is required`,
					);
				const buffered = { duplicate: enqueued.status === "duplicate" };
				// The run may have ended while this was being queued; the ordinary wake
				// rechecks ownership, so a still-live run simply adopts it at its boundary.
				if (!buffered.duplicate)
					void wakeInboxIfEligible(fresh.id, input.locale as Locale).catch((error) =>
						logger.warn("Queued Send wake deferred", {
							narratorId: fresh.id,
							error: String(error),
						}),
					);
				deliveryMessageId = delivery.recipientMessageId;
				let interruptNote = modelNote + takeoverNote;
				let interrupted: boolean | undefined;
				if (interruptTarget && !buffered.duplicate) {
					interrupted = await controlRun(fresh.id, { kind: "stop" });
					interruptNote = interrupted
						? " Interrupted foreground subagent."
						: " Target is not an interruptible foreground subagent.";
				} else if (input.doInterrupt && takenOver) {
					interruptNote += " doInterrupt was ignored because the user is driving this subagent.";
				}
				sections.push(`Sent to ${label}; message queued.${interruptNote}`);
				targetResults.push({
					id: fresh.id,
					label,
					title: fresh.title,
					status: "queued",
					deliveryMessageId,
					...stableSendCoordinates(fresh.id, deliveryMessageId, delivery),
					...(modelPlan && { model: modelPlan.model }),
					interrupted,
				});
				notifyDeliveryResolved(input, fresh.id, deliveryMessageId, fresh.title, delivery);
				continue;
			}

			const accepted = await enqueueInboxAgent(delivery, deliveredMessage, {
				createdBy: input.userId ?? null,
				userId: input.userId ?? null,
			});
			deliveryMessageId = delivery.recipientMessageId;
			if (accepted.delivery.state === "cancelled" || accepted.delivery.state === "failed")
				throw new Error(
					`Previous delivery is ${accepted.delivery.state}; explicit retry is required`,
				);
			// Agent messages never restart a failed or user-stopped session by themselves;
			// `resume` is the explicit opt-in, and only for a failure (the user's stop stands).
			const stopped = takenOver ? null : blockingStopReason(fresh.lastStopReason);
			const resumeRequested = input.resume === true && stopped === "error";
			let wakeFailed = false;
			if (accepted.delivery.state === "queued") {
				// The ordinary wake of any idle session: a held run is woken in place, an
				// idle session starts a run that adopts the message in order. The sender's
				// identity is the message author only, never the recipient's principal.
				try {
					wakeFailed =
						!wakeHeldRun(fresh.id) &&
						!(await wakeInboxIfEligible(
							fresh.id,
							input.locale as Locale,
							resumeRequested ? { resumeStopped: ["error"] } : {},
						));
				} catch (error) {
					wakeFailed = true;
					logger.warn("Accepted mailbox input awaits eligible wake", {
						narratorId: fresh.id,
						error: String(error),
					});
				}
			} else wakeFailed = true;
			const blockedReason = wakeFailed && stopped && !resumeRequested ? stopped : undefined;
			const outcome = blockedReason
				? blockedSendNote(label, blockedReason, input.resume === true)
				: wakeFailed
					? resumeRequested
						? `Sent to ${label}; resume was requested but it cannot start right now, so the message stays queued for its next eligible turn.`
						: `Sent to ${label}; durable message retained for the next eligible turn.`
					: resumeRequested
						? `Sent to ${label}; resumed after its failed last turn and started asynchronously.`
						: `Sent to ${label}; subagent started asynchronously.`;
			sections.push(outcome + modelNote + takeoverNote);
			targetResults.push({
				id: fresh.id,
				label,
				title: fresh.title,
				status: blockedReason ? "blocked" : wakeFailed ? "queued" : "started",
				...(blockedReason && { blockedReason }),
				...(modelPlan && { model: modelPlan.model }),
				...(resumeRequested && !wakeFailed && { resumed: true }),
				deliveryMessageId,
				...stableSendCoordinates(fresh.id, deliveryMessageId, delivery),
			});
			notifyDeliveryResolved(input, fresh.id, deliveryMessageId, fresh.title, delivery);
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			sections.push(`Failed to send to ${label}: ${error}`);
			targetResults.push({
				id: target.id,
				label,
				title: target.title,
				status: "failed",
				error,
			});
		}
	}
	return { output: sections.join("\n\n"), targets: targetResults };
}

export async function sendSubagentMessage(input: SendSubagentInput): Promise<string> {
	return (await sendSubagentMessageDetailed(input)).output;
}
