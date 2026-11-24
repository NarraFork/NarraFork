import { ensureReplyContext, syncActiveReplyContext } from "../narrator-reply-context";

/**
 * The one way a narrator run starts, is controlled, and ends.
 *
 * Every entry — a user message, a delegation, a Send wake, a user continue, a
 * continue after a takeover, a tool replay, restart and update recovery — goes
 * through {@link startNarratorRun}:
 *
 *   load registration → short start admission / owner → logical run → session →
 *   orchestrator → durable terminal and delivery → release owner
 *
 * Nothing here knows how a narrator was created. A run is related to other sessions
 * only through its registration (`deliverTo`, `cancelWith`, `principal`, `deadlineAt`)
 * and the live {@link RunControl} on its owner record. A delegation is a caller that
 * registers those facts; any two sessions can be related the same way.
 */

import { type ReadQueryOptions, readQuery, readQueryFirst } from "@server/db/worker-read";
import type { MediaRef } from "@shared/media-attachments";
import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { narrators, narratorToolCalls } from "../../db/schema";
import { diagnosticsFromError } from "../../lib/agent/error-diagnostics";
import { withDbRetry } from "../../lib/db-resilience";
import { AppError } from "../../lib/errors";
import { eventBus } from "../../lib/event-bus";
import { logger } from "../../lib/logger";
import { getSubagentType, parseSubstatus } from "../../lib/narrator-utils";
import type { Locale } from "../../lib/prompt-i18n";
import {
	executionPrincipalOf,
	RUNTIME_SOURCE_COLUMNS,
	runDeliverToOf,
} from "../../lib/runtime-source";
import { withSqlTraceSpan } from "../../lib/sql-trace";
import type { ImageRef } from "../../lib/uploads";
import {
	type DelegatedTaskRegistration,
	type RunBindingInput,
	type RunDeliverTo,
	type RuntimeRunBinding,
	readRuntimeRegistrationColumn,
} from "../../lib/validators/runtime-registration";
import { broadcastToNarrator } from "../../websocket/narrator-ws";
import { backgroundOccupancyStore } from "../background-occupancy-store";
import type { ActiveNarrator } from "../narrator-session-state";
import {
	withNarratorMutationAdmission,
	withNarratorStartAdmission,
	withNarratorWorkAdmission,
} from "../narrator-session-state";
import { waitForRestartBeforeFailure } from "../update-coordinator";
import { freezeCheckpointStopAdmission, matchesCheckpointRun } from "./checkpoint-stop";
import {
	type ExecutionOwner,
	getRunControl,
	getRunHold,
	listRuns,
	listRunsCancelledWith,
	type RunControl,
	type RunHold,
	type RunResult,
	setExecutionSuspended,
	setRunControl,
	setRunHold,
	tryClaimExecution,
} from "./ownership";
import { getRuntimePublicationService, publicationEvent, runtimePublication } from "./publication";
import { assertPublicationTaskIdentity, type PublicationRun } from "./publication-outbox";

export type { RunResult } from "./ownership";

export interface StartNarratorRunRequest {
	narratorId: string;
	locale: Locale;
	text: string;
	images?: ImageRef[];
	media?: MediaRef[];
	replyInUserLanguage?: boolean;
	/** An already prepared session (an input path persisted the user turn into it). */
	active?: ActiveNarrator;
	/**
	 * Execution principal. Omitted: the run's registered principal (recovery, Send wake)
	 * or the prepared session's. Explicit null is anonymous. Never borrowed from a
	 * related session.
	 */
	principal?: string | null;
	/**
	 * Register a NEW logical run with these relationships. Omitted: a run that delivers
	 * somewhere (the session's last registered destination) continues to owe its result
	 * there. Runs without a destination still register their identity and relations,
	 * but reserve no publication slots.
	 */
	binding?: RunBindingInput;
	/** Run an already registered logical run (adopted task run, or recovery); facts are kept. */
	resumeRunId?: string;
	registeredStart?: RegisteredAgentStart;
	/** Recovery of a run that already executed: its attribution window is kept. */
	recovered?: boolean;
	recoveryObservation?: import("../recovery-observation").RestartNarrator;
	parentRecoveryTurn?: import("../recovery-observation").ParentRecoveryTurn;
	onRegistered?: () => void;
	/** A recovery explanation may settle active projections, never overwrite terminal ones. */
	convergeOnlyActiveProjections?: boolean;
	/** Recovery that must not deliver into a call that already has its result. */
	deliver?: boolean;
	/** The caller's own cancellation (the caller attempt of a foreground delegation). */
	cancelSignal?: AbortSignal;
	/** A caller waits for this run's result (foreground delegation). */
	foreground?: boolean;
	/** An accepted `/bash` pre-command the run executes before its first model pass. */
	prePromptBashCommand?: string;
	/**
	 * Hooks of a token-scoped recovery start: `check` runs inside the start admission
	 * and throws when the recovery owner was cancelled or replaced; `onAdmitted` runs
	 * synchronously with the execution-owner claim.
	 */
	admission?: { check(): void; onAdmitted(): void };
	/** Delegation creation already selected this run's model. */
	skipModelReselect?: boolean;
}

export interface RegisteredAgentStart {
	narratorId: string;
	logicalRunId: string;
	deliverTo: RunDeliverTo;
}

export interface RunHandle {
	started: boolean;
	notStartedReason?: "owned" | "admission_closed";
	logicalRunId?: string;
	/** The caller's result: terminal, or a handoff when the run is detached. */
	foreground: Promise<RunResult>;
	/** The true terminal of the run. */
	terminal: Promise<RunResult>;
	/** The terminal, rejecting when the run threw (session-level error reporting). */
	completion: Promise<RunResult>;
}

const notStarted: RunResult = {
	started: false,
	output: "",
	finalText: "",
	hasError: false,
	interrupted: false,
	timedOut: false,
};

let acceptingRuns = true;
const pendingRunCompletions = new Set<Promise<RunResult>>();
let shutdownRunFailures = 0;
export function stopNarratorRunAdmission(): void {
	acceptingRuns = false;
	freezeCheckpointStopAdmission();
}

export function getNarratorRunShutdownSnapshot() {
	return {
		stopped: !acceptingRuns,
		pending: pendingRunCompletions.size,
		failed: shutdownRunFailures,
	};
}

export async function drainNarratorRunCompletions(options: { deadlineAt: number }): Promise<void> {
	while (pendingRunCompletions.size) {
		const remaining = options.deadlineAt - Date.now();
		if (remaining <= 0) throw new Error("Narrator run cleanup drain deadline expired");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.allSettled([...pendingRunCompletions]),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Narrator run cleanup drain deadline expired")),
						remaining,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	if (shutdownRunFailures) throw new Error("Narrator run cleanup failed during shutdown");
}

type Session = typeof import("../narrator-session");
const session = (): Promise<Session> => import("../narrator-session");

/** The session row a run start reads once: its registration and its runtime source. */
async function readRunSource(narratorId: string, signal?: AbortSignal) {
	const row = await readQueryFirst(
		db.query.narrators.findMany({
			limit: 1,
			where: eq(narrators.id, narratorId),
			columns: {
				...RUNTIME_SOURCE_COLUMNS,
				title: true,
				model: true,
				reasoningEffort: true,
				variant: true,
				subagentType: true,
				ownerUserId: true,
				type: true,
			},
		}),
		{ executionPolicy: "worker-required", maxRows: 1, signal },
	);
	if (!row) throw new AppError("Narrator not found", 404, "NOT_FOUND");
	return row;
}
type RunSource = Awaited<ReturnType<typeof readRunSource>>;

/** Unknown is distinct from the explicit anonymous principal (`null`). */
function registeredPrincipalOf(row: {
	runtimeRegistrationJson?: unknown;
	ownerUserId?: string | null;
}) {
	return executionPrincipalOf(row)?.userId;
}

/**
 * Where the run being started delivers its result, and whether it is a new run. A
 * session projected as a background task carries that projection into every run:
 * the task row moves to the new run and is `running` again, so Await, the task card
 * and the terminal all describe the run that is actually executing.
 */
async function prepareLogicalRun(
	narratorId: string,
	row: RunSource,
	req: StartNarratorRunRequest,
	principal: string | null,
): Promise<{ binding: RuntimeRunBinding; publicationRun?: PublicationRun }> {
	const deliverTo = req.binding ? req.binding.deliverTo : runDeliverToOf(row);
	// A result destination is optional; every run registers the same durable facts.
	const binding: RunBindingInput = {
		...req.binding,
		...(deliverTo ? { deliverTo } : {}),
		principal: { userId: principal },
	};
	const { binding: registered, publication: publicationRun } =
		await getRuntimePublicationService().startRun({
			narratorId,
			resumeRunId: req.resumeRunId,
			binding,
			expectedSource: row,
			recoveryObservation: req.recoveryObservation,
			parentRecoveryTurn: req.parentRecoveryTurn,
		});
	req.onRegistered?.();
	if (!deliverTo || !publicationRun) return { binding: registered };
	// A caller waiting in the foreground receives the result itself, never via a task.
	// A new run that only inherits a destination which already holds an earlier
	// result delivers through a task row instead of rewriting that result.
	const inherited = !(req.binding || req.resumeRunId || req.recovered);
	if (!req.foreground && (deliverTo.viaTask || (inherited && (await settled(deliverTo)))))
		await projectRunAsTask(narratorId, row, deliverTo, publicationRun, binding, req.recovered);
	return { binding: registered, publicationRun };
}

async function settled(deliverTo: RunDeliverTo): Promise<boolean> {
	if (!deliverTo.toolCallId) return false;
	const call = await readQueryFirst(
		db.query.narratorToolCalls.findMany({
			limit: 1,
			where: eq(narratorToolCalls.id, deliverTo.toolCallId),
			columns: { status: true },
		}),
		{ executionPolicy: "worker-required", maxRows: 1 },
	);
	return call?.status === "success" || call?.status === "fail";
}

/**
 * Project a run as a background task: the task card, Await, Stop and the completion
 * notice all describe the run that is executing, and a destination tool call whose
 * result an earlier run already delivered is never rewritten. The row is created, or moved to this run and back to `running`; a row
 * that already projects this run is left alone.
 */
async function projectRunAsTask(
	narratorId: string,
	row: RunSource,
	deliverTo: RunDeliverTo,
	publicationRun: PublicationRun,
	binding: RunBindingInput,
	recovered?: boolean,
): Promise<void> {
	const [{ backgroundTaskService }, { registerAndPersistSubagentAlias }] = await Promise.all([
		import("../background-task-service"),
		import("../subagent-alias"),
	]);
	const task = await backgroundTaskService.getById(narratorId).catch(() => null);
	if (task?.status === "running" && task.logicalRunId === publicationRun.logicalRunId) return;
	// Recovery continues THIS run. Restarting its settled task row here would mint a
	// new logical run before the recovered-run check, leaving the old result undelivered
	// and the new row running forever. The terminal row already describes this run.
	if (recovered && task && task.logicalRunId === publicationRun.logicalRunId) return;
	// The id belongs to another caller's task: deliver to the tool call instead.
	if (task && (task.type !== "agent" || task.parentNarratorId !== deliverTo.narratorId)) return;
	const alias =
		task?.alias ??
		(
			await registerAndPersistSubagentAlias(
				deliverTo.narratorId,
				narratorId,
				row.title ?? undefined,
			)
		).alias;
	await backgroundTaskService.createAgentTask({
		id: narratorId,
		subagentNarratorId: narratorId,
		subagentType: task?.subagentType ?? row.subagentType ?? "general",
		alias,
		title: task?.title ?? row.title ?? undefined,
		binding: { ...binding, deliverTo },
	});
	await backgroundTaskService.markNarratorRunning(narratorId);
	backgroundTaskService.notifyDerivedStatusChanged(deliverTo.narratorId, narratorId);
}

/**
 * Display adapter: (re)announce the destination's tool card with the model this run
 * actually uses. Execution never reads it.
 */
async function announceRunToDestination(
	id: string,
	row: RunSource,
	deliverTo: RunDeliverTo,
	principal: string | null,
): Promise<void> {
	const [{ broadcastSubagentStarted }, { resolveSubagentModelForRun, subagentRunReasoningEffort }] =
		await Promise.all([import("../subagent-runner"), import("../subagent-model")]);
	const { resolveDefaultReasoningEffort, resolveProvider } = await import("../../lib/settings");
	const { getSubagentType } = await import("../../lib/narrator-utils");
	const resolved = await resolveSubagentModelForRun({ ...row, id }, principal);
	broadcastSubagentStarted(
		id,
		deliverTo.narratorId,
		deliverTo.toolUseId,
		getSubagentType(row.variant ?? "") ?? row.subagentType ?? "general",
		row.model === FOLLOW_PARENT_MODEL ? FOLLOW_PARENT_MODEL : resolved.model,
		subagentRunReasoningEffort(
			resolved,
			row.reasoningEffort,
			resolveDefaultReasoningEffort(resolveProvider(resolved.model), resolved.model),
		),
		resolved.inheritance,
	);
}

/**
 * Start a run of `narratorId`. Returns `started: false` when another execution owns
 * the narrator; the caller's input stays queued for that owner.
 */
export async function startNarratorRun(req: StartNarratorRunRequest): Promise<RunHandle> {
	const id = req.narratorId;
	let notStartedReason: RunHandle["notStartedReason"] = "owned";
	const launch = await withNarratorStartAdmission(id, async () => {
		if (!acceptingRuns) {
			notStartedReason = "admission_closed";
			return null;
		}
		req.admission?.check();
		const owner = tryClaimExecution(id, "run");
		if (!owner) return null;
		try {
			req.admission?.onAdmitted();
		} catch (error) {
			owner.release();
			throw error;
		}
		const {
			promise: terminal,
			resolve: resolveTerminal,
			reject: rejectTerminal,
		} = Promise.withResolvers<RunResult>();
		void terminal.catch(() => {});
		const {
			promise: foreground,
			resolve: resolveForeground,
			reject: rejectForeground,
		} = Promise.withResolvers<RunResult>();
		void foreground.catch(() => {});
		let foregroundSettled = false;
		const settleForeground = (result: RunResult) => {
			if (foregroundSettled) return;
			foregroundSettled = true;
			resolveForeground(result);
		};
		const run: RunControl = {
			startedAt: Date.now(),
			cancel: new AbortController(),
			timedOut: false,
			terminal,
			// The live caller relation; detach or the finalizer claims it exactly once.
			...(req.foreground ? { waiter: settleForeground } : {}),
		};
		setRunControl(owner, run);
		// The model and every preparation step run outside the short start mutex. A
		// foreground caller not handed back by a detach receives the terminal itself.
		const completion = withSqlTraceSpan(
			"agent",
			"agent run",
			{ narratorId: id, ...(req.foreground ? { foreground: true } : {}) },
			() => withNarratorWorkAdmission(id, () => executeRun(req, owner, run)),
		).then(
			(result) => {
				resolveTerminal(result);
				settleForeground(result);
				return result;
			},
			(error) => {
				if (run.checkpointStop) {
					if (error !== run.checkpointStop) run.checkpointStop.cleanupFailure ??= error;
					if (error !== run.checkpointStop || run.checkpointStop.cleanupFailure !== undefined) {
						shutdownRunFailures++;
						logger.warn("Checkpoint run local cleanup failed", {
							narratorId: id,
							error: String(run.checkpointStop.cleanupFailure ?? error),
						});
					}
					rejectTerminal(run.checkpointStop);
					if (!foregroundSettled) {
						foregroundSettled = true;
						rejectForeground(run.checkpointStop);
					}
					throw run.checkpointStop;
				}
				const failed: RunResult = {
					...notStarted,
					started: true,
					output: String(error),
					finalText: String(error),
					hasError: true,
				};
				resolveTerminal(failed);
				// Model failures are ordinary RunResults. Infrastructure/start/commit
				// exceptions must retain the foreground tool's error boundary.
				if (!foregroundSettled) {
					foregroundSettled = true;
					rejectForeground(error);
				}
				throw error;
			},
		);
		pendingRunCompletions.add(completion);
		void completion.then(
			() => pendingRunCompletions.delete(completion),
			(error) => {
				pendingRunCompletions.delete(completion);
				if (!acceptingRuns && run.checkpointStop !== error) shutdownRunFailures++;
			},
		);
		return { run, completion, foreground: req.foreground ? foreground : terminal };
	});
	if (!launch) {
		const idle = Promise.resolve(notStarted);
		return { started: false, notStartedReason, foreground: idle, terminal: idle, completion: idle };
	}
	return {
		started: true,
		logicalRunId: launch.run.logicalRunId,
		foreground: launch.foreground,
		terminal: launch.run.terminal,
		completion: launch.completion,
	};
}

/** Settle only this successful registration; a later execution or source attempt wins. */
export async function settleRegisteredAgentStartFailure(
	registered: RegisteredAgentStart,
	error: unknown,
	existingOwner?: ExecutionOwner,
	eventKind: "failed" | "cancelled" = "failed",
): Promise<boolean> {
	try {
		return await withNarratorMutationAdmission(registered.narratorId, async () => {
			const owner = existingOwner ?? tryClaimExecution(registered.narratorId, "run");
			if (!owner || owner.narratorId !== registered.narratorId || !owner.isCurrent()) return false;
			const hold = getRunHold(registered.narratorId);
			try {
				const live = getRunControl(registered.narratorId);
				if (live?.checkpointStop) return false;
				// Release either runs before this claim and is honored by terminal delivery,
				// or is refused until this failing execution has released its owner.
				if (existingOwner && hold && live) live.finalizing = true;
				// Retained answers belong to normal finish/release, not startup failure.
				if (hold?.result) return false;
				const retainHeldResult = !!hold && !hold.released;
				const assertOwner = () => {
					if (!owner.isCurrent()) throw new Error("Agent startup cleanup owner changed");
					if (retainHeldResult && (getRunHold(registered.narratorId) !== hold || hold.released))
						throw new Error("Agent startup cleanup hold changed");
				};
				const finalText = error instanceof Error ? error.message : String(error);
				const pub = getRuntimePublicationService();
				await withDbRetry(
					() =>
						pub.commitAgentTerminal({
							run: {
								producerKind: "agent",
								taskId: registered.narratorId,
								recipientId: registered.deliverTo.narratorId,
								logicalRunId: registered.logicalRunId,
							},
							eventKind,
							// Before handoff the Agent call receives the original exception itself.
							delivery: existingOwner ? "background" : "foreground",
							text: finalText,
							summary: `[System] Background agent (ID: ${registered.narratorId}) failed to start.`,
							startupFailure: { deliverTo: registered.deliverTo, retainHeldResult, assertOwner },
						}),
					{ label: "run.failRegisteredAgentStart", maxRetries: 3 },
				);
				assertOwner();
				if (retainHeldResult) {
					hold.result = {
						...notStarted,
						started: true,
						logicalRunId: registered.logicalRunId,
						output: finalText,
						finalText,
						hasError: eventKind === "failed",
						interrupted: eventKind === "cancelled",
					};
				} else if (getRunHold(registered.narratorId) === hold)
					setRunHold(registered.narratorId, undefined);
				const { backgroundTaskService } = await import("../background-task-service");
				backgroundTaskService.notifyDerivedStatusChanged(
					registered.deliverTo.narratorId,
					registered.narratorId,
				);
				if (retainHeldResult && existingOwner) return true;
				await backgroundTaskService.announcePersistedAgentTerminal(
					registered.narratorId,
					registered.logicalRunId,
				);
				pub.schedule();
				return true;
			} finally {
				if (!existingOwner) owner.release();
			}
		});
	} catch (cleanupError) {
		try {
			logger.warn("Registered agent startup cleanup failed", {
				narratorId: registered.narratorId,
				logicalRunId: registered.logicalRunId,
				error: String(error),
				cleanupError: String(cleanupError),
			});
		} catch {
			// Diagnostics must not replace the caller's original startup exception.
		}
		return false;
	}
}

async function executeRun(
	req: StartNarratorRunRequest,
	owner: ExecutionOwner,
	run: RunControl,
): Promise<RunResult> {
	const id = req.narratorId;
	const sessionModule = await session();
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let removeCallerListener: (() => void) | undefined;
	let removeCancelListener: (() => void) | undefined;
	let allowInboxWake = false;
	let active: ActiveNarrator | undefined;
	let deliverTo: RunDeliverTo | undefined;
	/** False until `prepareLogicalRun` has returned the destination, including "none". */
	let deliverToResolved = false;
	let publicationRun: PublicationRun | undefined;
	/** The outline task the session was sent to do: its results are attached under it. */
	let delegated: DelegatedTaskRegistration | undefined;
	let finished = false;
	try {
		// Notification locale is display-only. A trusted recovery snapshot may seed a legacy row.
		const replyContext = await ensureReplyContext(
			id,
			req.recovered
				? {
						locale: req.locale,
						replyInUserLanguage: req.replyInUserLanguage ?? false,
					}
				: undefined,
		);
		// The one session construction, outside every admission transaction.
		active =
			req.active ??
			(await sessionModule.ensureNarrator(id, req.locale, req.replyInUserLanguage ?? false));
		syncActiveReplyContext(id, replyContext);
		const session = active;
		let source = await readRunSource(id, req.cancelSignal);
		delegated = readRuntimeRegistrationColumn(source.runtimeRegistrationJson)?.delegatedTask;
		// Only human input or this session's own registration establishes identity.
		// An explicitly anonymous binding must not fall through to an old session user.
		const principal =
			req.principal !== undefined
				? req.principal
				: req.binding?.principal
					? req.binding.principal.userId
					: (session._currentUserId ?? registeredPrincipalOf(source));
		if (principal === undefined) {
			logger.warn("Run not started: execution principal is unknown", {
				narratorId: id,
				entrySource: req.recovered
					? "recovery"
					: req.binding
						? "binding_start"
						: req.active
							? "prepared_session"
							: "run_start",
			});
			return notStarted;
		}
		if (getSubagentType(source.variant)) {
			const { isNewSubagentModelSelectionRun, reselectSubagentModelForNewRun } = await import(
				"../subagent-model-switch"
			);
			if (
				isNewSubagentModelSelectionRun(req) &&
				(await reselectSubagentModelForNewRun(id, principal))
			)
				source = await readRunSource(id, req.cancelSignal);
		}
		const prepared = await prepareLogicalRun(id, source, req, principal);
		const binding = prepared.binding;
		publicationRun = prepared.publicationRun;
		// Known as soon as registration returns, including a primary run with no destination.
		// Throws before this must not look like a foreground failure: a subagent whose
		// startRun failed still has to stay `working` for restart recovery.
		deliverTo = binding.deliverTo;
		deliverToResolved = true;
		run.binding = binding;
		run.logicalRunId = binding.logicalRunId;
		if (!binding.principal) throw new Error("Run registration requires an execution principal");
		run.principal = binding.principal.userId;
		session._currentUserId = run.principal;
		run.deliverTo = deliverTo;
		run.cancelWith = binding.cancelWith;
		run.deadlineAt = binding.deadlineAt;
		if (deliverTo) {
			const { startSubagentOutputCharCount } = await import("../narrator-event-handler");
			startSubagentOutputCharCount(id, binding.logicalRunId);
		}
		if (deliverTo)
			await announceRunToDestination(id, source, deliverTo, principal).catch((error) =>
				logger.debug("Run announcement skipped", { id, error: String(error) }),
			);
		// Caller cancellation: only this exact caller attempt, removed again by detach.
		if (req.cancelSignal) {
			const signal = req.cancelSignal;
			const onCancel = () => run.cancel.abort(signal.reason ?? "Caller interrupted");
			if (signal.aborted) onCancel();
			else signal.addEventListener("abort", onCancel, { once: true });
			removeCallerListener = () => signal.removeEventListener("abort", onCancel);
			run.detachCaller = removeCallerListener;
		}
		// Whole-run cancellation always reaches the turn in flight. The map itself is a
		// module singleton, so resolving it here (this caller is async) is equivalent to
		// resolving it inside the listener — and `require` is not an option: the transitive
		// dependency reaches `db/index.ts`, whose top-level await `require` cannot carry.
		const { activeNarrators } = await import("../narrator-session-state");
		const onRunCancel = () => {
			activeNarrators.get(id)?.abortController.abort(run.cancel.signal.reason);
		};
		run.cancel.signal.addEventListener("abort", onRunCancel, { once: true });
		removeCancelListener = () => run.cancel.signal.removeEventListener("abort", onRunCancel);
		// Absolute deadline: recovery and detach never restart it.
		if (run.deadlineAt) {
			const onDeadline = () => {
				run.timedOut = true;
				run.cancel.abort("Run deadline reached");
			};
			const remaining = Date.parse(run.deadlineAt) - Date.now();
			if (remaining <= 0) onDeadline();
			else deadlineTimer = setTimeout(onDeadline, remaining);
		}
		if (deliverTo && publicationRun) {
			const { establishSubagentExecutionSegment } = await import("../subagent-execution-boundary");
			// A background task's first start adopts the run its Agent call registered
			// (same logical run), so that registration is this run's own receipt. A fresh
			// continuation never inherits it; recovery reuses the persisted segment.
			const exact =
				req.binding?.deliverTo ?? (req.resumeRunId && !req.recovered ? deliverTo : undefined);
			const segment = await establishSubagentExecutionSegment({
				childNarratorId: id,
				parentNarratorId: deliverTo.narratorId,
				logicalRunId: publicationRun.logicalRunId,
				toolUseId: deliverTo.toolUseId,
				binding:
					exact?.toolCallId && exact.attempt !== undefined
						? { toolCallId: exact.toolCallId, attempt: exact.attempt }
						: undefined,
			});
			run.executionSegmentId = segment.executionSegmentId;
			if (!req.recovered)
				await db
					.update(narrators)
					.set({ turnStartedAt: new Date().toISOString() })
					.where(eq(narrators.id, id));
			const { backgroundTaskService } = await import("../background-task-service");
			const task = await backgroundTaskService.getById(id).catch(() => null);
			if (task?.status === "running" && task.logicalRunId === publicationRun.logicalRunId)
				backgroundTaskService.registerAbortController(id, run.cancel);
		}
		if (req.recovered && publicationRun) {
			// The publication slots, not the readability of the result, decide whether this
			// run may execute again. A settled run NEVER runs the model a second time.
			const publicationState =
				await getRuntimePublicationService().readRunPublicationState(publicationRun);
			const settled = publicationState.state === "settled";
			const committed = settled
				? await getRuntimePublicationService().readAgentTerminalResult(publicationRun, {
						includeEventKind: true,
					})
				: null;
			const checkpoint = !settled
				? await readQueryFirst(
						db.query.narrators.findMany({
							limit: 1,
							where: and(eq(narrators.id, id), eq(narrators.logicalRunId, binding.logicalRunId)),
							columns: {
								backgroundResult: true,
								backgroundCompletedAt: true,
								backgroundStatus: true,
								substatus: true,
								errorMessage: true,
							},
						}),
						{ executionPolicy: "worker-required", maxRows: 1 },
					)
				: undefined;
			const pending =
				checkpoint?.backgroundCompletedAt &&
				checkpoint.backgroundResult != null &&
				parseSubstatus(checkpoint.substatus).includes(`terminal_run:${binding.logicalRunId}`)
					? {
							output: checkpoint.backgroundResult,
							eventKind: (parseSubstatus(checkpoint.substatus).includes("timeout")
								? "timed_out"
								: checkpoint.backgroundStatus === "completed"
									? "completed"
									: checkpoint.backgroundStatus === "cancelled"
										? "cancelled"
										: "failed") as NonNullable<RunOutcome["committedEvent"]>,
						}
					: undefined;
			const saved = committed ?? pending;
			if (saved) {
				finished = true;
				allowInboxWake = true;
				return await finishRun(
					id,
					run,
					deliverTo,
					publicationRun,
					{
						delegated,
						finalText: saved.output,
						committedEvent: saved.eventKind,
						...(pending && checkpoint
							? {
									terminalStatus: {
										substatus: parseSubstatus(checkpoint.substatus).filter(
											(tag) => !tag.startsWith("terminal_run:"),
										),
										errorMessage: checkpoint.errorMessage ?? undefined,
									},
								}
							: {}),
					},
					settled ? { ...req, convergeOnlyActiveProjections: true } : req,
				);
			}
			if (settled) {
				// The terminal was already published but its snapshot is unreadable. Reuse the
				// normal delivery path so task/narrator projections, legacy targets and PG
				// composites all converge, but only projections that are still ACTIVE may be
				// written; an existing terminal result is never replaced by this explanation.
				finished = true;
				allowInboxWake = true;
				return await finishRun(
					id,
					run,
					deliverTo,
					publicationRun,
					{
						finalText:
							"Recovered after restart: this run had already published its terminal result, but the stored result is no longer readable. The run was not executed again.",
						committedEvent: publicationState.eventKind ?? "failed",
					},
					{ ...req, convergeOnlyActiveProjections: true },
				);
			}
		}
		const { runAgentLoopUnlocked } = await import("./orchestrator");
		let outcome: RunOutcome = run.cancel.signal.aborted
			? { aborted: true }
			: await runAgentLoopUnlocked(
					active,
					owner,
					req.text,
					req.images,
					run,
					req.prePromptBashCommand,
					req.media,
				);
		for (;;) {
			// The loop's async cleanup may have admitted a hold after its last boundary.
			// Arbitrate again before claiming terminal delivery, without an intervening await.
			while (
				!outcome.freshInput &&
				getRunHold(id) &&
				!getRunHold(id)?.released &&
				!run.cancel.signal.aborted
			) {
				const { hasInboxKind } = await import("./inbox");
				const woke = await awaitRunHold(owner, run, () =>
					hasInboxKind(id, ["user_input", "agent_message"]),
				);
				if (woke === "input") outcome.freshInput = true;
			}
			// A delivering run whose turn ended while work it started is still pending has not
			// produced its result yet: it waits for that work to wake it and continues.
			if (
				!outcome.freshInput &&
				deliverTo &&
				req.deliver !== false &&
				outcome.allowInboxWake === true &&
				!run.cancel.signal.aborted &&
				!activeHold(id)
			) {
				const woke = await awaitPendingWake(owner, run);
				if (woke === "input") outcome.freshInput = true;
				else if (woke === "hold") continue;
				// The answer so far was provisional: a cancelled wait ends the run cancelled.
				else if (woke === "cancel") outcome = { ...outcome, aborted: true };
			}
			if (!outcome.freshInput || run.cancel.signal.aborted) break;
			// The old session finalizer has restored its temporary model. Rotate the epoch
			// in the short admission, retaining this run, hold and all three caller promises.
			owner = await withNarratorStartAdmission(id, async () => {
				if (!owner.release()) throw new Error("Lost fresh-pass execution owner");
				const next = tryClaimExecution(id, "run");
				if (!next) throw new Error("Fresh-pass execution owner unavailable");
				setRunControl(next, run);
				return next;
			});
			run.finalizing = false;
			active = await sessionModule.ensureNarrator(id, req.locale, req.replyInUserLanguage ?? false);
			// Restored before Send/notice adoption and pre-execution: only human input
			// may subsequently replace the registered principal.
			active._currentUserId = run.principal ?? null;
			const input = await sessionModule.prepareQueuedRunInput(active, owner, run);
			outcome.freshInput = false;
			// Withdrawn input and terminal control commands do not execute a model pass.
			if (input)
				outcome = await runAgentLoopUnlocked(
					active,
					owner,
					input.text,
					input.images,
					run,
					input.prePromptBashCommand,
					input.media,
				);
		}
		allowInboxWake = outcome.allowInboxWake === true;
		finished = true;
		return await finishRun(id, run, deliverTo, publicationRun, { ...outcome, delegated }, req);
	} catch (error) {
		if (run.checkpointStop) {
			allowInboxWake = false;
			if (active) active._resumeBufferedAfterLoop = false;
			throw error;
		}
		const preparingRunId = run.logicalRunId ?? req.registeredStart?.logicalRunId;
		if (
			preparingRunId &&
			!run.cancel.signal.aborted &&
			matchesCheckpointRun(error, {
				narratorId: id,
				logicalRunId: preparingRunId,
				executionEpoch: owner.epoch,
			})
		) {
			run.checkpointStop = error;
			allowInboxWake = false;
			if (active) active._resumeBufferedAfterLoop = false;
			throw error;
		}
		// An exiting process may have closed a worker while this run was preparing.
		const pausedForRestart = await waitForRestartBeforeFailure(run.cancel.signal);
		// Infrastructure failure is not a successful turn boundary. In particular,
		// do not auto-start queued work over a retained same-run terminal checkpoint.
		allowInboxWake = false;
		if (active) active._resumeBufferedAfterLoop = false;
		const failureText = error instanceof Error ? error.message : String(error);
		// Cancellation and deadlines still finalize normally when they release the pause gate.
		if (pausedForRestart && !finished && deliverToResolved && run.cancel.signal.aborted) {
			return await finishRun(
				id,
				run,
				deliverTo,
				publicationRun,
				{ aborted: true, finalText: failureText, delegated },
				req,
			);
		}
		if (!finished && !deliverToResolved && req.registeredStart && !pausedForRestart)
			await settleRegisteredAgentStartFailure(req.registeredStart, error, owner);
		// A run that threw still ends exactly once at its destination (the same
		// finalizer); the error then reaches the session's own error reporting.
		if (!finished && deliverTo && publicationRun)
			await finishRun(
				id,
				run,
				deliverTo,
				publicationRun,
				{ hasError: true, finalText: failureText, delegated },
				req,
			).catch((finalizeError) =>
				logger.warn("Run finalization after failure failed", {
					id,
					error: String(finalizeError),
				}),
			);
		else if (deliverToResolved && !deliverTo)
			// 前台 run 没有交付目标，收尾只能在这里做：漏掉它 status 会停在 working，
			// 下次重启被当成「被上个进程切断的 run」再次续跑，于是空输入重放上一轮。
			// 截止时间到了也会 abort，超时必须压过 interrupted，和 finishRun 一致。
			await settleStatus(
				id,
				undefined,
				{
					hasError: true,
					interrupted: !run.timedOut && run.cancel.signal.aborted,
					timedOut: run.timedOut,
					finalText: failureText,
				},
				{ skipErrorMessage: false, diagnostics: diagnosticsFromError(error) },
			).catch((statusError) =>
				logger.warn("Run status settle after failure failed", {
					id,
					error: String(statusError),
				}),
			);
		throw error;
	} finally {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		if (run.logicalRunId) {
			const { retireSubagentOutputCharCount } = await import("../narrator-event-handler");
			retireSubagentOutputCharCount(id, run.logicalRunId);
		}
		removeCallerListener?.();
		removeCancelListener?.();
		try {
			const { backgroundTaskService } = await import("../background-task-service");
			backgroundTaskService.unregisterAbortController(id, run.cancel);
		} finally {
			if (owner.release() && !run.checkpointStop) afterRunRelease(id, active, allowInboxWake);
		}
	}
}

/**
 * The owner just released: deliver what queued up behind the run. Failed or
 * runtime-paused runs keep their input for an explicit retry.
 */
function afterRunRelease(id: string, active: ActiveNarrator | undefined, allowInboxWake: boolean) {
	if (!acceptingRuns) {
		if (active) active._resumeBufferedAfterLoop = false;
		return;
	}
	const resumeBuffered = active?._resumeBufferedAfterLoop === true;
	if (active) active._resumeBufferedAfterLoop = false;
	if (!allowInboxWake && !resumeBuffered) return;
	void (async () => {
		const [{ retryDeferredQuestionAnswerDeliveries }, { hasInboxKind, wakeInboxIfEligible }] =
			await Promise.all([session(), import("./inbox")]);
		if (allowInboxWake) await retryDeferredQuestionAnswerDeliveries(id, active?.locale ?? "en");
		if (resumeBuffered || (await hasInboxKind(id, ["user_input", "agent_message", "task_notice"])))
			await wakeInboxIfEligible(id, active?.locale ?? "en");
	})().catch((error) =>
		logger.warn("Inbox wake deferred after run release", { id, error: String(error) }),
	);
}

/** Runs that deliver to a tool call, for checkpointing before a planned update. */
export function listDeliveringRuns(): Array<{
	narratorId: string;
	toolUseId: string;
	recipientId: string;
	startedAt: number;
	deadlineAt: string | null;
	logicalRunId?: string;
}> {
	return listRuns().flatMap(({ narratorId, run }) =>
		run.deliverTo
			? [
					{
						narratorId,
						toolUseId: run.deliverTo.toolUseId,
						recipientId: run.deliverTo.narratorId,
						startedAt: run.startedAt,
						deadlineAt: run.deadlineAt ?? null,
						logicalRunId: run.logicalRunId,
					},
				]
			: [],
	);
}

interface RunOutcome {
	terminalStatus?: import("./input").RuntimeTerminalStatus;
	finalText?: string;
	hasError?: boolean;
	aborted?: boolean;
	contextLengthExceeded?: boolean;
	allowInboxWake?: boolean;
	/** The mailbox head needs the normal fresh-session input preparation. */
	freshInput?: boolean;
	/** Immutable classification when recovery observes an already committed terminal. */
	committedEvent?: "completed" | "failed" | "timed_out" | "cancelled";
	/** The outline task the session was sent to do (outline P2 PR 9a): see `delegatedDelivery`. */
	delegated?: DelegatedTaskRegistration;
}

/**
 * The only finalizer: classify the terminal once, then deliver it exactly once to the
 * destination the run registered. The terminal snapshot and every recipient's intent
 * commit in one short transaction (publication); waking recipients happens after.
 */
type TerminalEvent = "completed" | "failed" | "timed_out" | "cancelled";
/** The session's background projection of a terminal event. */
const backgroundStatusOf = (event: TerminalEvent) =>
	event === "completed" || event === "cancelled" ? event : "failed";
/** Why a run with no output of its own was cancelled (caller interrupt, user stop, ...). */
function cancelReason(signal: AbortSignal): string {
	const reason = signal.reason instanceof Error ? signal.reason.message : signal.reason;
	return typeof reason === "string" && reason.trim()
		? `Interrupted: ${reason}`
		: "Interrupted because the caller was interrupted";
}

async function finishRun(
	id: string,
	run: RunControl,
	deliverTo: RunDeliverTo | undefined,
	publicationRun: PublicationRun | undefined,
	outcome: RunOutcome,
	req: StartNarratorRunRequest,
): Promise<RunResult> {
	// Claim how the result is delivered before the first await: from here a detach is
	// refused, and one already in progress is finished before the branch is chosen.
	run.finalizing = true;
	if (run.detaching) await run.detaching;
	// A completed detach took the caller; a failed one handed it back.
	const foregroundCaller = !!run.waiter;
	run.waiter = undefined;
	const timedOut = outcome.committedEvent ? outcome.committedEvent === "timed_out" : run.timedOut;
	const cancelled = !timedOut && run.cancel.signal.aborted;
	const hold = getRunHold(id);
	const interrupted = !timedOut && (!!outcome.aborted || outcome.committedEvent === "cancelled");
	const hasError =
		timedOut ||
		(!interrupted &&
			!!(outcome.hasError || outcome.contextLengthExceeded || outcome.committedEvent === "failed"));
	const finalText = outcome.committedEvent
		? outcome.finalText || "(no output)"
		: (timedOut
				? `Run timed out${outcome.finalText?.trim() ? `\n\nLast output:\n${outcome.finalText}` : ""}`
				: outcome.contextLengthExceeded
					? "Error: context length exceeded"
					: cancelled && !outcome.finalText?.trim()
						? cancelReason(run.cancel.signal)
						: outcome.finalText) || "(no output)";
	const base: RunResult = {
		started: true,
		logicalRunId: run.logicalRunId,
		output: finalText,
		finalText,
		hasError,
		interrupted,
		timedOut,
		terminalStatus: outcome.terminalStatus,
	};
	// Keep the exact answer for a release retry even when rendering/commit fails.
	if (hold) hold.result = base;
	const eventKind = timedOut
		? "timed_out"
		: hasError
			? "failed"
			: interrupted
				? "cancelled"
				: "completed";
	// What reaches the destination: a session sent with an outline task attaches its result under
	// the task first, and the destination gets the result with a note saying where and how.
	const delegatedResult =
		deliverTo && publicationRun && req.deliver !== false && outcome.delegated
			? await delegatedDelivery(id, outcome.delegated, publicationRun.logicalRunId, {
					delivered: finalText,
					report: outcome.finalText ?? "",
					ending: eventKind,
					principal: run.principal ?? null,
				})
			: null;
	const delivered = delegatedResult?.text ?? finalText;
	const output =
		deliverTo && publicationRun
			? await renderResult(id, deliverTo, publicationRun, delivered)
			: finalText;
	const result: RunResult = {
		...base,
		output,
		...(delegatedResult?.note ? { outlineReport: delegatedResult.note } : {}),
	};
	try {
		if (deliverTo && publicationRun && req.deliver !== false) {
			if (foregroundCaller) {
				// The caller is still waiting in the foreground: it receives the result as its
				// tool result, so the terminal is stored and consumed in one transaction.
				await getRuntimePublicationService().commitAgentTerminal({
					run: publicationRun,
					eventKind,
					text: delivered,
					summary: "Foreground agent result delivered",
					delivery: "foreground",
				});
				await bindResultMessage(id, deliverTo);
			} else {
				const deliver = () =>
					deliverDetachedResult(
						id,
						deliverTo,
						publicationRun,
						{
							eventKind,
							finalText: delivered,
							hasError,
							principal: run.principal ?? null,
						},
						req.convergeOnlyActiveProjections,
					);
				// No caller can retry a background/detached source transaction. Retry
				// transient locks here; a hold keeps its explicit release-retry contract.
				if (hold) await deliver();
				else await withDbRetry(deliver, { label: "run.commitBackgroundTerminal", maxRetries: 3 });
			}
		}
	} catch (error) {
		// A held result remains retryable. An unheld failed foreground call already
		// reports failure to its caller and retains the previous unused-slot cleanup.
		if (!hold && publicationRun) {
			if (foregroundCaller)
				await getRuntimePublicationService().releaseUnusedRunSlots(publicationRun);
			else {
				// These existing result fields are a same-run terminal checkpoint, not
				// a completion signal: status stays working and the task stays running.
				// Keep the reservation so restart can commit this exact answer, not a
				// synthetic restart cancellation or a second model execution.
				await withDbRetry(
					() =>
						db
							.update(narrators)
							.set({
								backgroundResult: finalText,
								backgroundStatus: backgroundStatusOf(eventKind),
								backgroundCompletedAt: new Date().toISOString(),
								substatus: JSON.stringify([
									...(outcome.terminalStatus?.substatus ??
										(timedOut
											? ["timeout"]
											: interrupted
												? ["interrupted"]
												: hasError
													? ["error"]
													: [])),
									`terminal_run:${publicationRun.logicalRunId}`,
								]),
							})
							.where(
								and(eq(narrators.id, id), eq(narrators.logicalRunId, publicationRun.logicalRunId)),
							),
					{ label: "run.checkpointBackgroundTerminal", maxRetries: 5 },
				);
				backgroundOccupancyStore.refreshNarrator(id);
			}
		}
		throw error;
	}
	// A failed held commit must retain its reservation for an explicit retry.
	if (publicationRun) await getRuntimePublicationService().releaseUnusedRunSlots(publicationRun);
	await clearDeliveredHold(id, hold);
	// A subagent that was stopped or ran out of time takes its helpers with it.
	if (runStopsHelpers({ cancelled, timedOut }))
		void stopSubagentHelpers(
			id,
			timedOut ? "Parent subagent timed out" : "Parent subagent stopped",
		);
	// Terminal persistence (snapshot + delivery intent) precedes visible idle.
	await settleStatus(id, deliverTo, {
		hasError,
		interrupted,
		timedOut,
		finalText,
		terminalStatus: outcome.terminalStatus,
	});
	// A subagent done with its run gives back its browser tabs unless work is pending; a
	// person holding it keeps everything open (`subagent-resources.ts`).
	if (!hold)
		void import("../subagent-resources").then(({ releaseSubagentBrowsersAtRunEnd }) =>
			releaseSubagentBrowsersAtRunEnd(id, {
				stopped: runStopsHelpers({ cancelled, timedOut }),
				run,
			}),
		);
	return result;
}

/**
 * A delegated session's result as it is delivered (outline P2 PR 9a): attached under its outline
 * task first (`outline/delegation.ts`, idempotent per logical run), then handed on with the note
 * saying where and whether it is late. Never throws: the result is delivered either way.
 */
async function delegatedDelivery(
	id: string,
	delegated: DelegatedTaskRegistration,
	logicalRunId: string,
	result: {
		delivered: string;
		report: string;
		ending: TerminalEvent;
		principal: string | null;
	},
): Promise<{ text: string; note: import("@shared/outline-report-note").OutlineReportNote | null }> {
	try {
		const { deliverDelegatedResult } = await import("../outline/delegation");
		return await deliverDelegatedResult({ subagentId: id, delegated, logicalRunId, ...result });
	} catch (error) {
		logger.warn("Delegated result delivered without its report", { id, error: String(error) });
		return { text: result.delivered, note: null };
	}
}

async function clearDeliveredHold(id: string, hold: RunHold | undefined): Promise<void> {
	if (!hold || getRunHold(id) !== hold) return;
	const { narratorService } = await import("../narrator-service");
	await narratorService.removeSubstatus(id, "taken_over");
	if (getRunHold(id) === hold) setRunHold(id, undefined);
}

async function renderResult(
	id: string,
	deliverTo: RunDeliverTo,
	publicationRun: PublicationRun,
	finalText: string,
): Promise<string> {
	const [{ appendSubagentFileChanges }, { agentResultTag, resolveAgentLabel }, boundary] =
		await Promise.all([
			import("../subagent-file-changes"),
			import("../subagent-label"),
			import("../subagent-execution-boundary"),
		]);
	const turn = await readQueryFirst(
		db.query.narrators.findMany({
			limit: 1,
			where: eq(narrators.id, id),
			columns: { turnStartedAt: true, title: true },
		}),
		{ executionPolicy: "worker-required", maxRows: 1 },
	);
	let executionBoundary: Awaited<ReturnType<typeof boundary.readSubagentExecutionBoundary>>;
	try {
		executionBoundary = await boundary.readSubagentExecutionBoundary(
			id,
			publicationRun.logicalRunId,
		);
	} catch (error) {
		logger.warn("Agent result delivered without its file-change summary", {
			id,
			error: String(error),
		});
		return `${finalText}\n\n<subagent_file_changes>\nFile-change summary unavailable: execution boundary could not be read.\n</subagent_file_changes>`;
	}
	return appendSubagentFileChanges(
		{
			parentNarratorId: deliverTo.narratorId,
			childNarratorId: id,
			executionBoundary,
			scope: {
				sourceToolUseId: deliverTo.toolUseId,
				startedAt: turn?.turnStartedAt ?? null,
				completedAt: new Date().toISOString(),
			},
		},
		agentResultTag(await resolveAgentLabel(deliverTo.narratorId, id), id, turn?.title) + finalText,
	);
}

async function settleStatus(
	id: string,
	deliverTo: RunDeliverTo | undefined,
	outcome: Pick<
		RunResult,
		"hasError" | "interrupted" | "timedOut" | "finalText" | "terminalStatus"
	>,
	options?: {
		/** Foreground throws record one error row here. finishRun keeps the default. */
		skipErrorMessage?: boolean;
		diagnostics?: ReturnType<typeof diagnosticsFromError>;
	},
): Promise<void> {
	const { narratorService } = await import("../narrator-service");
	const failure =
		outcome.hasError && !outcome.interrupted && !outcome.timedOut
			? outcome.terminalStatus
			: undefined;
	const substatus =
		failure?.substatus ??
		(outcome.interrupted
			? ["interrupted"]
			: outcome.timedOut
				? ["timeout"]
				: outcome.hasError
					? ["error"]
					: ["unread"]);
	const changed = await narratorService.updateStatus(id, "idle", {
		...failure,
		substatus,
		errorMessage:
			failure?.errorMessage ??
			(outcome.hasError && !outcome.interrupted ? outcome.finalText : undefined),
		// `failure` already carries the loop's diagnostics. Only a foreground throw,
		// which has no terminal status, supplies them here — an explicit undefined
		// would wipe the ones just spread.
		...(options?.diagnostics ? { diagnostics: options.diagnostics } : {}),
		skipErrorMessage: options?.skipErrorMessage ?? true,
		unlessArchived: true,
	});
	if (changed === false) return;
	// Display adapter for the destination's tool card; execution never reads it.
	if (!deliverTo) return;
	broadcastToNarrator(deliverTo.narratorId, {
		type: "subagent_status_changed",
		narratorId: deliverTo.narratorId,
		subagentNarratorId: id,
		status: "idle",
		substatus,
	});
	eventBus.emit({
		type: "narrator:subagent_completed",
		narratorId: id,
		parentNarratorId: deliverTo.narratorId,
		toolUseId: deliverTo.toolUseId,
	});
}

/**
 * The exact tool-call row a run delivers to: the row it registered, else (legacy rows
 * registered before exact attempts) the session's original creating tool call.
 */
async function resolveDeliveryTarget(
	id: string,
	deliverTo: RunDeliverTo,
): Promise<{ toolCallId: string; messageId: string }> {
	const { narratorPersistence } = await import("../narrator-persistence");
	if (deliverTo.toolCallId) {
		const reference = await narratorPersistence.resolveToolCallConclusionReference(
			deliverTo.narratorId,
			deliverTo.toolUseId,
			{ toolCallId: deliverTo.toolCallId },
		);
		const { narratorService } = await import("../narrator-service");
		if (!(await narratorService.isMessageSharedByMultipleNarrators(reference.messageId)))
			return reference;
		await narratorService.copyOnWriteToolCallMessage(
			deliverTo.narratorId,
			reference.messageId,
			deliverTo.toolUseId,
		);
		return narratorPersistence.resolveToolCallConclusionReference(
			deliverTo.narratorId,
			deliverTo.toolUseId,
			{ toolCallId: deliverTo.toolCallId },
		);
	}
	const { prepareSubagentConclusionReference } = await session();
	return prepareSubagentConclusionReference(id, deliverTo.narratorId, deliverTo.toolUseId);
}

async function bindResultMessage(id: string, deliverTo: RunDeliverTo): Promise<void> {
	try {
		const { getSubagentResultMessageId } = await session();
		const resultMessageId = await getSubagentResultMessageId(id);
		if (!resultMessageId) return;
		const reference = await resolveDeliveryTarget(id, deliverTo);
		const { narratorToolCalls } = await import("../../db/schema");
		await db
			.update(narratorToolCalls)
			.set({ resultMessageId })
			.where(eq(narratorToolCalls.id, reference.toolCallId));
	} catch (error) {
		logger.debug("Result message binding skipped", { id, error: String(error) });
	}
}

/**
 * Deliver a run whose caller is no longer waiting: through its running task row when
 * it has one (task card, Await, notice), otherwise by rewriting the destination tool
 * call's conclusion with the notice committed in the same transaction.
 */
async function deliverDetachedResult(
	id: string,
	deliverTo: RunDeliverTo,
	publicationRun: PublicationRun,
	terminal: {
		eventKind: TerminalEvent;
		finalText: string;
		hasError: boolean;
		/** Execution principal the notice is attributed to. */
		principal: string | null;
	},
	onlyIfActive = false,
): Promise<void> {
	const { eventKind, finalText, hasError } = terminal;
	const { recordTaskNoticeUser } = await import("../parent-injection-queue");
	recordTaskNoticeUser(id, terminal.principal);
	const { backgroundTaskService } = await import("../background-task-service");
	const task = await backgroundTaskService.getById(id).catch(() => null);
	if (task?.status === "running" && task.logicalRunId === publicationRun.logicalRunId) {
		const transitioned =
			eventKind === "timed_out"
				? await backgroundTaskService.markTimedOut(id, finalText)
				: eventKind === "completed"
					? await backgroundTaskService.markCompleted(id, finalText)
					: eventKind === "cancelled"
						? await backgroundTaskService.markCancelled(id)
						: await backgroundTaskService.markFailed(id, finalText);
		if (transitioned) {
			await backgroundTaskService.markNarratorTerminal(
				id,
				backgroundStatusOf(eventKind),
				finalText,
			);
			getRuntimePublicationService().schedule();
			return;
		}
	}
	try {
		const { getSubagentResultMessageId, updateToolCallConclusion } = await session();
		const reference = await resolveDeliveryTarget(id, deliverTo);
		const summary = `[System] Agent ${id} ${publicationEvent(eventKind)}. Its run has ended.`;
		const sqlite = getRuntimePublicationService().backend === "sqlite";
		if (!sqlite) {
			const output = await renderResult(id, deliverTo, publicationRun, finalText);
			const committed = await getRuntimePublicationService().commitAgentTerminal({
				run: publicationRun,
				eventKind,
				text: finalText,
				summary,
				toolConclusion: {
					...reference,
					toolUseId: deliverTo.toolUseId,
					attempt: deliverTo.attempt,
					output,
					status: hasError ? "fail" : "success",
					resultMessageId: await getSubagentResultMessageId(id),
					onlyIfActive,
				},
			});
			if (committed.toolConclusionApplied !== false)
				broadcastToNarrator(deliverTo.narratorId, {
					type: "subagent_conclusion_updated",
					narratorId: deliverTo.narratorId,
					subagentNarratorId: id,
					toolUseId: deliverTo.toolUseId,
					output,
					hasError,
				});
			await backgroundTaskService.announcePersistedAgentTerminal(id, publicationRun.logicalRunId);
			getRuntimePublicationService().schedule();
			return;
		}
		await updateToolCallConclusion({
			subagentId: id,
			parentNarratorId: deliverTo.narratorId,
			toolUseId: deliverTo.toolUseId,
			toolCallId: reference.toolCallId,
			messageId: reference.messageId,
			finalText,
			hasError,
			resultMessageId: await getSubagentResultMessageId(id),
			refreshTiming: true,
			onlyIfActive,
			onPersist: (tx) => {
				runtimePublication.commit(
					{
						...publicationRun,
						eventKind,
						resultRef: runtimePublication.persistResult(publicationRun, finalText, tx, eventKind),
						summary,
					},
					tx,
				);
			},
		});
		await backgroundTaskService.announcePersistedAgentTerminal(id, publicationRun.logicalRunId);
		getRuntimePublicationService().schedule();
	} catch (error) {
		// A recovery explanation is best-effort for a receipt that may already be gone.
		const validation =
			error instanceof Error && "code" in error && error.code === "VALIDATION_ERROR";
		if (onlyIfActive && validation) {
			getRuntimePublicationService().schedule();
			return;
		}
		throw error;
	}
}

// === Control ===

export type RunControlAction =
	/** Stop the current turn only; a held run stays held, a plain run ends. */
	| { kind: "stop" }
	/** End the run; it delivers a cancelled result. */
	| { kind: "cancel"; reason?: string }
	/** Hand the caller back now; the same run keeps its destination and deadline. */
	| { kind: "detach" }
	/** Hold the result for the user (takeover). */
	| { kind: "hold" }
	/** Let go of a hold; a parked result is delivered now, a running one when it ends. */
	| { kind: "release" };

/**
 * Apply one control action to whatever run `narratorId` executes. Authorization is
 * the caller's job (human ACL or `authorizeAgentControl`).
 */
export function controlRun(narratorId: string, action: RunControlAction): Promise<boolean> {
	return action.kind === "hold"
		? withNarratorMutationAdmission(narratorId, () => controlRunUnlocked(narratorId, action))
		: controlRunUnlocked(narratorId, action);
}

async function controlRunUnlocked(narratorId: string, action: RunControlAction): Promise<boolean> {
	const run = getRunControl(narratorId);
	switch (action.kind) {
		case "hold": {
			// Claim synchronously, before imports or mirror writes. Either the hold or
			// the terminal owns this result, never a successful but ineffective takeover.
			if (run?.finalizing) return false;
			const previous = getRunHold(narratorId);
			if (previous && !previous.released) return true;
			const hold: RunHold = { released: false };
			setRunHold(narratorId, hold);
			try {
				const { narratorService } = await import("../narrator-service");
				await narratorService.addSubstatus(narratorId, "taken_over");
			} catch (error) {
				if (getRunHold(narratorId) === hold) setRunHold(narratorId, previous);
				throw error;
			}
			return true;
		}
		case "release": {
			const claim = await withNarratorStartAdmission(narratorId, async () => {
				const hold = getRunHold(narratorId);
				if (!hold) return false;
				const live = getRunControl(narratorId);
				if (live) {
					if (live.finalizing) return false;
					hold.released = true;
					live.wake?.("release");
					return true;
				}
				// A bounded delivery owner excludes new input starts and a second release.
				// Its registration is captured before any async final-text lookup.
				const owner = tryClaimExecution(narratorId, "run");
				if (!owner) return false;
				const delivery: RunControl = {
					startedAt: Date.now(),
					cancel: new AbortController(),
					timedOut: false,
					terminal: Promise.resolve(hold.result ?? notStarted),
					finalizing: true,
				};
				setRunControl(owner, delivery);
				return { owner, delivery, hold };
			});
			if (typeof claim === "boolean") return claim;
			try {
				await withNarratorWorkAdmission(narratorId, () =>
					deliverHeldResult(narratorId, claim.hold, claim.delivery),
				);
				return true;
			} finally {
				if (claim.owner.release()) {
					// A failed delivery keeps the hold, not a veto on human input that
					// arrived while this bounded owner excluded its initial wake.
					const { hasInboxKind } = await import("./inbox");
					afterRunRelease(
						narratorId,
						undefined,
						!getRunHold(narratorId) || (await hasInboxKind(narratorId, ["user_input"])),
					);
				}
			}
		}
		case "stop": {
			if (run?.wake) return false;
			const { activeNarrators } = await import("../narrator-session-state");
			const active = activeNarrators.get(narratorId);
			if (!active?.alive) return false;
			if (!getRunHold(narratorId)) run?.cancel.abort("Stopped by user");
			active.abortController.abort("Stopped by user");
			return true;
		}
		case "cancel": {
			if (!run) return false;
			run.cancel.abort(action.reason ?? "Cancelled");
			run.wake?.("cancel");
			const { activeNarrators } = await import("../narrator-session-state");
			activeNarrators.get(narratorId)?.abortController.abort(action.reason ?? "Cancelled");
			return true;
		}
		case "detach":
			return detachRun(narratorId, run);
	}
}

/**
 * Hand the foreground caller back and keep the run going as a task. The claim is
 * synchronous: once the finalizer started (`finalizing`) a detach is refused, and a
 * detach in progress is awaited by the finalizer (`detaching`) before it chooses how
 * to deliver. Either the caller gets the handoff and the task row the terminal, or
 * the caller gets the terminal and no task row exists.
 */
async function detachRun(narratorId: string, run: RunControl | undefined): Promise<boolean> {
	const waiter = run?.waiter;
	const deliverTo = run?.deliverTo;
	if (!run || !waiter || !deliverTo || !run.logicalRunId || run.finalizing || run.detaching)
		return false;
	const { promise: detaching, resolve: settled } = Promise.withResolvers<void>();
	run.detaching = detaching;
	try {
		const output = await registerDetachedTask(narratorId, run, deliverTo);
		// Handed back: the caller's interrupt no longer cancels this run.
		run.waiter = undefined;
		run.cancelWith = undefined;
		if (run.binding) run.binding = { ...run.binding, cancelWith: undefined };
		run.detachCaller?.();
		waiter({ ...notStarted, started: true, output, finalText: output, handoff: true });
		broadcastToNarrator(deliverTo.narratorId, {
			type: "subagent_detached",
			narratorId: deliverTo.narratorId,
			subagentNarratorId: narratorId,
			toolUseId: deliverTo.toolUseId,
		});
		return true;
	} finally {
		// On failure nothing was handed back: the caller still waits for the terminal.
		run.detaching = undefined;
		settled();
	}
}

/** The task projection a detached run delivers through; returns the caller's handoff. */
async function registerDetachedTask(
	narratorId: string,
	run: RunControl,
	deliverTo: RunDeliverTo,
): Promise<string> {
	const row = await readQueryFirst(
		db.query.narrators.findMany({
			limit: 1,
			where: eq(narrators.id, narratorId),
			columns: { title: true, subagentType: true },
		}),
		{ executionPolicy: "worker-required", maxRows: 1 },
	);
	const [{ backgroundTaskService }, { registerAndPersistSubagentAlias }] = await Promise.all([
		import("../background-task-service"),
		import("../subagent-alias"),
	]);
	const { alias } = await registerAndPersistSubagentAlias(
		deliverTo.narratorId,
		narratorId,
		row?.title ?? undefined,
		{
			signal: run.cancel.signal,
			deadlineAt: run.deadlineAt ? Date.parse(run.deadlineAt) : undefined,
		},
	);
	// Re-registering the same run keeps its destination and absolute deadline.
	await backgroundTaskService.createAgentTask({
		id: narratorId,
		subagentNarratorId: narratorId,
		subagentType: row?.subagentType ?? "general",
		alias,
		title: row?.title ?? undefined,
		binding: { deliverTo, cancelWith: undefined },
	});
	// The session's background projection follows only a task row that exists.
	await backgroundTaskService.markNarratorRunning(narratorId);
	backgroundTaskService.registerAbortController(narratorId, run.cancel);
	return (
		`<background_task_id>${alias}</background_task_id>\n\n` +
		`Subagent detached to background. Results notify automatically. Watch({ type: "agent", id: "${alias}" }) registers an observation or retrieves the saved result.`
	);
}

/**
 * Whether a finished run takes the subagent's helpers with it: only when the run itself
 * was cancelled (a controller's Stop, a `Send({ doInterrupt })`, its task cancelled, its
 * caller cancelled) or ran out of time.
 *
 * Deliberately NOT on the loop's own "interrupted" outcome: the loop also reports that
 * when it merely breaks to handle queued input (a queued /new or /goal with more input
 * behind it) or when a planned update pauses it for resumption — cancelling helpers
 * there would kill work nobody stopped, including runs update recovery resumes. A
 * person's stop goes through `interruptNarrator`, which stops the helpers itself.
 *
 * Nor on an error: an errored subagent is resumable, and its helpers' results wait in
 * its inbox for that resume rather than being thrown away.
 */
export function runStopsHelpers(run: { cancelled: boolean; timedOut: boolean }): boolean {
	return run.cancelled || run.timedOut;
}

/** Helpers one stop reaches; a subagent rarely runs more than a few at once. */
const HELPER_STOP_LIMIT = 100;

/**
 * Stopping a SUBAGENT stops the helpers it launched (its own team: rows it controls),
 * background ones included, so nothing keeps working, spending and delivering to a
 * subagent that was stopped. A helper a person has taken over is left alone, as control
 * actions never cut into a person's work. Primary narrators are untouched: their
 * background agents keep running when the primary's turn is interrupted, as before.
 * Never throws, unless given an `assertAuthorized` fence (explicit Stop).
 */
export async function stopSubagentHelpers(
	narratorId: string,
	reason: string,
	options: {
		/**
		 * The caller's authorization fence, asserted immediately before each helper is
		 * cancelled. Its failure (and, on this explicit path, any failure) is thrown to the
		 * caller instead of being swallowed.
		 */
		assertAuthorized?: () => void;
	} = {},
): Promise<number> {
	try {
		const owner = await db
			.select({ type: narrators.type })
			.from(narrators)
			.where(eq(narrators.id, narratorId))
			.get();
		if (owner?.type !== "subagent") return 0;
		const { teamMembersWhere } = await import("../../lib/runtime-source");
		const helpers = await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(and(teamMembersWhere(narratorId), inArray(narrators.status, ["working", "waiting"])))
			.limit(HELPER_STOP_LIMIT)
			.all();
		if (helpers.length === 0) return 0;
		const { backgroundTaskService } = await import("../background-task-service");
		let stopped = 0;
		for (const helper of helpers) {
			if (getRunHold(helper.id)) continue;
			options.assertAuthorized?.();
			const cancelled =
				(await backgroundTaskService
					.cancel(helper.id, { assertAuthorized: options.assertAuthorized })
					.catch((error) => {
						if (options.assertAuthorized) throw error;
						return false;
					})) || (await controlRun(helper.id, { kind: "cancel", reason }).catch(() => false));
			if (cancelled) stopped++;
		}
		if (stopped > 0) logger.info("Stopped helpers of a stopped subagent", { narratorId, stopped });
		return stopped;
	} catch (error) {
		if (options.assertAuthorized) throw error;
		logger.warn("Failed to stop a stopped subagent's helpers", {
			narratorId,
			error: error instanceof Error ? error.message : String(error),
		});
		return 0;
	}
}

/**
 * Cancel the live runs registered to be cancelled with `callerNarratorId` (matched by
 * narrator, every attempt: the caller as a whole stops). Cancelling exactly one caller
 * attempt is the run's `cancelSignal`, wired at start.
 */
export function cancelRunsBoundTo(callerNarratorId: string, reason: string): number {
	const runs = listRunsCancelledWith(callerNarratorId);
	for (const run of runs) {
		run.cancel.abort(reason);
		run.wake?.("cancel");
	}
	return runs.length;
}

/**
 * Suspend the run at a turn boundary while the user holds its result. The owner is
 * kept; input, a release or a cancellation wakes it. Returns why it woke.
 */
export async function awaitRunHold(
	owner: ExecutionOwner,
	run: RunControl,
	hasInput: () => Promise<boolean>,
): Promise<"input" | "release" | "cancel"> {
	const id = owner.narratorId;
	if (run.cancel.signal.aborted) return "cancel";
	if (!getRunHold(id) || getRunHold(id)?.released) return "release";
	const { narratorService } = await import("../narrator-service");
	await narratorService.updateStatus(id, "idle", { substatus: ["taken_over"] });
	// Timing metadata is not a hold label; parking replaces the visible substatus.
	await narratorService.updateSubstatus(id, ["taken_over"], { preserveTiming: false });
	const { promise, resolve } = Promise.withResolvers<"input" | "release" | "cancel">();
	let wakeReason: "input" | "release" | "cancel" | undefined;
	const wake = (reason: "input" | "release" | "cancel") => {
		if (wakeReason !== undefined) return;
		wakeReason = reason;
		resolve(reason);
	};
	run.wake = wake;
	const onCancel = () => wake("cancel");
	run.cancel.signal.addEventListener("abort", onCancel, { once: true });
	setExecutionSuspended(owner, true);
	try {
		if (run.cancel.signal.aborted) wake("cancel");
		else if (!getRunHold(id) || getRunHold(id)?.released) wake("release");
		else if (await hasInput()) wake("input");
		// A queued input wake can win while the Worker probe is pending. Reconcile
		// release state only if no wake has already been observed; cancellation always wins.
		if (run.cancel.signal.aborted) return "cancel";
		if (wakeReason === undefined && (!getRunHold(id) || getRunHold(id)?.released)) wake("release");
		return await promise;
	} finally {
		run.cancel.signal.removeEventListener("abort", onCancel);
		if (run.wake === wake) {
			run.wake = undefined;
			setExecutionSuspended(owner, false);
		}
	}
}

/** How often a run waiting on pending work re-checks it, as a backstop to its wake. */
export const PENDING_WAKE_RECHECK_MS = 2_000;

/**
 * Keep a delivering run open while work its session started will still wake it
 * (background tasks, Watch observations, subagents, open questions, queued notices):
 * the result snapshot is the answer after that work, not the turn that started it.
 * The owner is kept, so queued input wakes this same run (`wakeHeldRun`). Returns
 * "settled" once nothing is pending, "hold" when the user took the run over.
 */
async function awaitPendingWake(
	owner: ExecutionOwner,
	run: RunControl,
): Promise<"input" | "settled" | "hold" | "cancel"> {
	const id = owner.narratorId;
	const { hasPendingWork, hasQueuedWake } = await import("./pending-wake");
	const { flushInboxPublicationBarrier } = await import("./inbox");
	// Work is read before the outbox flush: a task that settled before the read has its
	// notice in the outbox, so the flush moves it into the inbox before the inbox read.
	// Unreadable pending state before waiting keeps the previous behavior: the run settles
	// with this answer. Once waiting (e.g. the store stopped for a restart), it keeps waiting.
	const pending = async (waiting: boolean): Promise<"input" | "settled" | undefined> => {
		try {
			const working = await hasPendingWork(id);
			await flushInboxPublicationBarrier(id);
			if (await hasQueuedWake(id)) return "input";
			return working ? undefined : "settled";
		} catch (error) {
			logger.warn("Pending wake state unavailable", { id, waiting, error: String(error) });
			return waiting ? undefined : "settled";
		}
	};
	const first = await pending(false);
	if (first) return first;
	const { narratorService } = await import("../narrator-service");
	await narratorService.updateStatus(id, "idle");
	const { promise, resolve } = Promise.withResolvers<"input" | "settled" | "hold" | "cancel">();
	let done = false;
	const finish = (reason: "input" | "settled" | "hold" | "cancel") => {
		if (done) return;
		done = true;
		resolve(reason);
	};
	run.wake = (reason) => finish(reason === "release" ? "hold" : reason);
	const onCancel = () => finish("cancel");
	run.cancel.signal.addEventListener("abort", onCancel, { once: true });
	// A takeover may claim the run while it waits: it is not finalizing yet.
	run.finalizing = false;
	setExecutionSuspended(owner, true);
	const check = async () => {
		if (done) return;
		if (run.cancel.signal.aborted) return finish("cancel");
		if (activeHold(id)) return finish("hold");
		const woke = await pending(true);
		if (woke) finish(woke);
	};
	const timer = setInterval(() => void check(), PENDING_WAKE_RECHECK_MS);
	try {
		await check();
		return await promise;
	} finally {
		clearInterval(timer);
		run.wake = undefined;
		run.cancel.signal.removeEventListener("abort", onCancel);
		setExecutionSuspended(owner, false);
		if (!activeHold(id)) run.finalizing = true;
	}
}

const activeHold = (id: string) => {
	const hold = getRunHold(id);
	return hold && !hold.released ? hold : undefined;
};

/** Wake a held run for queued input. Returns whether a held run was woken. */
export function wakeHeldRun(narratorId: string): boolean {
	const run = getRunControl(narratorId);
	if (!run?.wake) return false;
	run.wake("input");
	return true;
}

/**
 * Deliver the current result of a session whose run already ended while held (or
 * whose hold was restored after a restart): the same delivery as a detached run.
 */
async function deliverHeldResult(
	narratorId: string,
	hold: RunHold,
	run: RunControl,
): Promise<void> {
	const row = await readRunSource(narratorId);
	const current = await readQueryFirst(
		db.query.narrators.findMany({
			limit: 1,
			where: eq(narrators.id, narratorId),
			columns: {
				substatus: true,
				logicalRunId: true,
				backgroundResult: true,
				backgroundStatus: true,
				backgroundCompletedAt: true,
			},
		}),
		{ executionPolicy: "worker-required", maxRows: 1 },
	);
	const registered = readRuntimeRegistrationColumn(row.runtimeRegistrationJson)?.run;
	const prepared = registered
		? {
				binding: registered,
				publicationRun: registered.deliverTo
					? {
							producerKind: "agent" as const,
							taskId: narratorId,
							recipientId: registered.deliverTo.narratorId,
							logicalRunId: registered.logicalRunId,
						}
					: undefined,
			}
		: await prepareLogicalRun(
				narratorId,
				row,
				{
					narratorId,
					locale: "en",
					text: "",
					recovered: true,
					resumeRunId: current?.logicalRunId ?? undefined,
				},
				registeredPrincipalOf(row) ?? null,
			);
	run.binding = prepared.binding;
	run.logicalRunId = prepared.binding.logicalRunId;
	const checkpoint =
		current?.logicalRunId === prepared.binding.logicalRunId &&
		current.backgroundCompletedAt &&
		current.backgroundResult != null &&
		parseSubstatus(current.substatus).includes(`terminal_run:${prepared.binding.logicalRunId}`)
			? {
					finalText: current.backgroundResult,
					hasError: current.backgroundStatus === "failed",
					interrupted: current.backgroundStatus === "cancelled",
					timedOut: parseSubstatus(current.substatus).includes("timeout"),
				}
			: undefined;
	const heldResult =
		!hold.result?.logicalRunId || hold.result.logicalRunId === prepared.binding.logicalRunId
			? hold.result
			: undefined;
	const saved = heldResult ?? checkpoint;
	const { getSubagentFinalText } = await session();
	const finalText = saved?.finalText ?? (await getSubagentFinalText(narratorId));
	const hasError = saved?.hasError ?? parseSubstatus(current?.substatus).includes("error");
	const deliverTo = prepared.binding.deliverTo;
	if (deliverTo && prepared.publicationRun) {
		const state = await getRuntimePublicationService().readRunPublicationState(
			prepared.publicationRun,
		);
		let alreadyDelivered = false;
		if (state.state === "settled") {
			const { backgroundTaskService } = await import("../background-task-service");
			const task = await backgroundTaskService.getById(narratorId);
			if (task) assertPublicationTaskIdentity(prepared.publicationRun, task);
			alreadyDelivered = !!task && task.status !== "running";
		}
		if (!alreadyDelivered) {
			const eventKind: TerminalEvent = saved?.timedOut
				? "timed_out"
				: saved?.interrupted
					? "cancelled"
					: hasError
						? "failed"
						: "completed";
			const principal = prepared.binding.principal?.userId ?? null;
			const delegated = readRuntimeRegistrationColumn(row.runtimeRegistrationJson)?.delegatedTask;
			await deliverDetachedResult(narratorId, deliverTo, prepared.publicationRun, {
				eventKind,
				finalText: delegated
					? (
							await delegatedDelivery(narratorId, delegated, prepared.publicationRun.logicalRunId, {
								delivered: finalText,
								report: finalText,
								ending: eventKind,
								principal,
							})
						).text
					: finalText,
				hasError,
				principal,
			});
		}
		await getRuntimePublicationService().releaseUnusedRunSlots(prepared.publicationRun);
	}
	await clearDeliveredHold(narratorId, hold);
	await settleStatus(narratorId, deliverTo, {
		hasError,
		interrupted: saved?.interrupted ?? false,
		timedOut: saved?.timedOut ?? false,
		finalText,
		terminalStatus: heldResult?.terminalStatus,
	});
}

/** Restore holds after a restart from their durable `taken_over` mirror; returns the ids. */
export async function hydrateRunHolds(
	options: Pick<ReadQueryOptions, "signal" | "deadlineAt" | "timeoutMs"> = {},
): Promise<Set<string>> {
	const { asc, gt } = await import("drizzle-orm");
	const PAGE = 500;
	const startedAt = Date.now();
	const held = new Set<string>();
	let scanned = 0;
	// Bound rows scanned, not matches: a sparse hold must never cause a full-table
	// synchronous scan in one request. Parse labels exactly (SQL LIKE treats _ as wildcard).
	for (let after = ""; ; ) {
		const rows = await readQuery(
			db
				.select({ id: narrators.id, substatus: narrators.substatus })
				.from(narrators)
				.where(gt(narrators.id, after))
				.orderBy(asc(narrators.id))
				.limit(PAGE),
			{ ...options, executionPolicy: "worker-required", maxRows: PAGE },
		);
		scanned += rows.length;
		for (const row of rows) {
			if (!parseSubstatus(row.substatus).includes("taken_over")) continue;
			if (!getRunHold(row.id)) setRunHold(row.id, { released: false });
			held.add(row.id);
		}
		if (rows.length < PAGE) break;
		after = rows[rows.length - 1].id;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	logger.info("Restored run holds after restart", {
		count: held.size,
		scanned,
		durationMs: Date.now() - startedAt,
	});
	return held;
}

// A pre-protocol run in this process is admitted by the live run registry itself.
void import("./publication").then(({ runtimePublication }) =>
	runtimePublication.setLegacyRuntimeAdmissionReader("agent", (source) => {
		const run = getRunControl(source.taskId);
		return run && run.deliverTo?.narratorId === source.recipientId
			? { ...source, startedAtMs: run.startedAt }
			: undefined;
	}),
);
