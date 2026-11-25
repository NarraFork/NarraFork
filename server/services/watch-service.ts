import { isTeamMember, runDeliverToOf, teamRootOf } from "@server/lib/runtime-source";
import {
	formatWatchTarget,
	WATCH_DEADLINE_OUTPUT_PREFIX,
	type WatchTargetType,
} from "@shared/watch-command";
import type { ToolContext, ToolResult } from "../lib/agent/types";
import { isRuntimeToolAllowed, runtimeWatchTargets } from "./agent-runtime/policy";
import { prepareBackgroundBashResult } from "./background-bash-result";
import { type BackgroundTaskRecord, backgroundTaskService } from "./background-task-service";
import { assertOAuthNarratorRuntimeActive } from "./oauth-narrator-runtime-policy";
import { resolveTaskAlias } from "./subagent-alias";
import { agentLabelFromNarrator } from "./subagent-label";
import { TERMINAL_WATCH_COMMAND_PREFIX, WATCH_COMMAND_PREFIX } from "./terminal-watch-constants";
import { startTerminalWatch, terminalLifecycleReader } from "./terminal-watch-service";
import { resolveNarratorRuntimePolicy } from "./trait-layer-service";
import {
	type AdoptedWatchRow,
	cancelWatchRegistration,
	MAX_WATCH_TIMEOUT_MS,
	registerWatchObservation,
	type WatchObservation,
} from "./watch-observation";
import {
	type RestartWatchRow,
	type ResumableWatchTarget,
	restartWatchDeadline,
} from "./watch-restart";
import { subscribeWatchSource } from "./watch-source";

export interface TaskWatchInput {
	type: "bash" | "agent";
	id: string;
	pattern?: string;
	timeout: number;
}

/**
 * Who is observing. A tool call passes its whole `ToolContext`; a watch re-attached
 * after a restart has no tool call and acts as the identity that registered it.
 */
type WatchActor = Pick<ToolContext, "narratorId" | "signal" | "currentToolUseId"> & {
	userId?: string | null;
};

interface TargetResult {
	status: string;
	output: string | null;
	terminalResultReceived?: boolean;
	publicationRun?: { recipientId: string; logicalRunId?: string };
}

async function resultText(type: string, label: string, result: TargetResult): Promise<string> {
	const header =
		result.status === "timeout"
			? `${WATCH_DEADLINE_OUTPUT_PREFIX} for ${type} ${label}. Only the observation ended; the target was not stopped.`
			: `Watch ${type} ${label}: ${result.status}.`;
	const prepared = await prepareBackgroundBashResult(
		label,
		result.output ?? "(no captured output)",
	);
	return `${header}\n\n${prepared.content}`;
}

function registeredResult(
	input: TaskWatchInput,
	id: string,
	observation: WatchObservation,
	label: string,
	reused: boolean,
	remainingMs: number,
): ToolResult {
	const watching = reused
		? `Already watching ${input.type} ${label} for this condition (watch ${JSON.stringify(observation.alias)}); no second watch was added. Its deadline is now in ${remainingMs}ms.`
		: `Watching ${input.type} ${label} (watch ${JSON.stringify(observation.alias)}, deadline in ${remainingMs}ms).`;
	return {
		output: `${watching} End your turn or continue independent work. Results arrive in the mailbox. Stop({ type: "bash", id: ${JSON.stringify(observation.alias)} }) cancels only this observation.`,
		metadata: {
			kind: "watch",
			type: input.type,
			id,
			targetId: input.id,
			watchId: observation.taskId,
			watchAlias: observation.alias,
			status: "watching",
			...(reused ? { reused: true } : {}),
			...(input.type === "agent" ? { subagentId: id } : {}),
		},
	};
}

async function readBashTarget(narratorId: string, selector: string): Promise<BackgroundTaskRecord> {
	const resolved = resolveTaskAlias(narratorId, selector);
	const task =
		(await backgroundTaskService.getById(resolved)) ??
		(await backgroundTaskService.getByAlias(selector, narratorId));
	if (!task || task.parentNarratorId !== narratorId || task.type !== "bash") {
		throw new Error(`No Bash task ${JSON.stringify(selector)} belongs to this session.`);
	}
	return task;
}

async function finishTargetObservation(
	observation: WatchObservation,
	input: TaskWatchInput,
	label: string,
	result: TargetResult,
	runKey: string,
	sourceNotifies = true,
): Promise<void> {
	if (observation.signal.aborted || result.status === "aborted") return;
	// A single ordinary completion notice fulfils every observer of this recipient/run.
	// Never consume the source notification or publish a duplicate completion body.
	const silent =
		sourceNotifies &&
		result.terminalResultReceived === true &&
		result.publicationRun?.recipientId === observation.narratorId;
	await observation.finish({
		status: result.status === "timeout" ? "timeout" : "completed",
		output: silent
			? `Observation fulfilled by the ordinary ${input.type} completion notice for ${label}, run ${result.publicationRun?.logicalRunId ?? "legacy"}. This notice fulfils every watch of that recipient/run.`
			: await resultText(input.type, label, result),
		silent,
		// Every observation of this run's end (with or without a pattern) shares one notice.
		...(COALESCED_END_EXCLUDED.has(result.status) ? {} : { coalesceKey: `${runKey} end` }),
	});
}

/** Deadlines and pattern matches are per condition; registration already merges repeats. */
const COALESCED_END_EXCLUDED = new Set(["timeout", "found", "text_matched"]);

/** Lifecycle outcomes are not read from the agent's committed result. */
const AGENT_LIFECYCLE_STATUSES = new Set(["superseded", "taken_over", "unavailable", "timeout"]);

/** Keep waiting past the shared waiter's own budget: each observation owns its deadline. */
async function untilSettled(
	wait: (timeoutMs: number) => Promise<TargetResult>,
	signal: AbortSignal,
): Promise<TargetResult> {
	for (;;) {
		const result = await wait(MAX_WATCH_TIMEOUT_MS);
		if (result.status !== "timeout" || signal.aborted) return result;
	}
}

interface ObserveTargetOptions {
	input: TaskWatchInput;
	ctx: WatchActor;
	/** Re-attach to this restart-surviving row instead of creating a new observation. */
	adopt?: AdoptedWatchRow;
	id: string;
	label: string;
	title: string;
	command: string;
	/** Target + run: shared by every condition this watcher observes on the run. */
	runKey: string;
	/** Target + run + condition: identical repeats by this watcher reuse one observation. */
	conditionKey: string;
	/** Source waiter shared by every watcher with the same condition and read authority. */
	sourceKey: string;
	wait: (timeoutMs: number, signal: AbortSignal) => Promise<TargetResult>;
	deadlineOutput: () => string | null;
	/** Re-validate a shared result for this watcher before it is published. */
	accept?: (result: TargetResult) => Promise<TargetResult>;
	sourceNotifies?: (result: TargetResult) => boolean;
}

async function observeTarget(opts: ObserveTargetOptions): Promise<ToolResult> {
	const { input, ctx, label } = opts;
	const fail = (error: unknown) =>
		observation.finish({
			status: "failed",
			output: `Watch could not observe ${input.type === "agent" ? "agent" : "Bash"} ${label}: ${String(error)}. The target was not stopped.`,
		});
	const reachDeadline = async () => {
		try {
			await checkObservationAuthorization(ctx, input.type);
			await finishTargetObservation(
				observation,
				input,
				label,
				{ status: "timeout", output: opts.deadlineOutput() },
				opts.runKey,
			);
		} catch (error) {
			await fail(error);
		}
	};
	ctx.signal.throwIfAborted();
	const registered = await registerWatchObservation({
		narratorId: ctx.narratorId,
		title: opts.title,
		command: opts.command,
		toolUseId: ctx.currentToolUseId,
		dedupKey: opts.conditionKey,
		timeoutMs: input.timeout,
		principal: { userId: ctx.userId ?? null },
		onDeadline: () => void reachDeadline(),
		...(opts.adopt ? { adopt: opts.adopt } : {}),
	});
	const { observation, reused, remainingMs } = registered;
	if (reused) {
		if (ctx.signal.aborted)
			return { output: "Watch registration interrupted. The target was not stopped." };
		return registeredResult(input, opts.id, observation, label, true, remainingMs);
	}
	if (ctx.signal.aborted) {
		await cancelWatchRegistration(observation);
		return { output: "Watch registration interrupted. The target was not stopped." };
	}
	void (async () => {
		try {
			const shared = await subscribeWatchSource(
				opts.sourceKey,
				(signal) => untilSettled((timeoutMs) => opts.wait(timeoutMs, signal), signal),
				observation.signal,
			);
			if (!shared) return;
			const result = opts.accept ? await opts.accept(shared) : shared;
			await checkObservationAuthorization(ctx, input.type);
			await finishTargetObservation(
				observation,
				input,
				label,
				result,
				opts.runKey,
				opts.sourceNotifies?.(result) ?? true,
			);
		} catch (error) {
			await fail(error);
		}
	})();
	return registeredResult(input, opts.id, observation, label, false, remainingMs);
}

async function checkObservationAuthorization(
	ctx: WatchActor,
	type: WatchTargetType,
): Promise<void> {
	// Re-resolve the live principal, not the already-returned tool's signal/workspace lease.
	const policy = await resolveNarratorRuntimePolicy(ctx.narratorId, ctx.userId ?? null);
	if (!isRuntimeToolAllowed(policy, "Watch") || !runtimeWatchTargets(policy).includes(type)) {
		throw new Error("Observation access was revoked.");
	}
	const runtime = await assertOAuthNarratorRuntimeActive(ctx.narratorId, ctx.userId);
	if (runtime && !runtime.allowedTools.has("Watch"))
		throw new Error("Observation access was revoked.");
}
export async function watchTask(input: TaskWatchInput, ctx: ToolContext): Promise<ToolResult> {
	if (input.type === "agent") return watchAgent(input, ctx);
	const task = await readBashTarget(ctx.narratorId, input.id);
	const label = task.alias ?? task.id;
	if (
		[WATCH_COMMAND_PREFIX, TERMINAL_WATCH_COMMAND_PREFIX].some((prefix) =>
			task.command?.startsWith(prefix),
		)
	) {
		return {
			output: `No watch was registered: ${JSON.stringify(label)} is an observation handle, not an execution target. Use the original terminal, Bash task or agent ID. Use this handle with Stop to cancel it, or TeamStatus({ action: "get_task", target_id: ${JSON.stringify(label)} }) to inspect it.`,
			metadata: {
				kind: "watch",
				type: "bash",
				id: task.id,
				targetId: input.id,
				status: "unsupported_target",
			},
		};
	}
	if (task.status !== "running" || (input.pattern && task.output?.includes(input.pattern))) {
		const status = task.status === "running" ? "text_matched" : task.status;
		return {
			output: await resultText("bash", label, { status, output: task.output }),
			metadata: { kind: "watch", type: "bash", id: task.id, targetId: input.id, status },
		};
	}
	return observeBashTask(task, input, ctx);
}

function observeBashTask(
	task: BackgroundTaskRecord,
	input: TaskWatchInput,
	ctx: WatchActor,
	adopt?: AdoptedWatchRow,
): Promise<ToolResult> {
	const label = task.alias ?? task.id;
	const runKey = `bash ${JSON.stringify(task.id)} run ${JSON.stringify(task.logicalRunId)}`;
	const condition = input.pattern ? ` for ${JSON.stringify(input.pattern)}` : "";
	return observeTarget({
		input,
		ctx,
		adopt,
		id: task.id,
		label,
		title: `watch bash ${label}`,
		command: formatWatchTarget({
			type: "bash",
			id: task.id,
			runId: task.logicalRunId,
			pattern: input.pattern,
			timeoutMs: input.timeout,
		}),
		runKey,
		conditionKey: `${runKey}${condition}`,
		sourceKey: `${runKey}${condition}`,
		wait: (timeoutMs, signal) =>
			input.pattern
				? backgroundTaskService.waitForText(task.id, input.pattern, timeoutMs, signal)
				: backgroundTaskService.waitForCompletion(task.id, timeoutMs, signal),
		deadlineOutput: () => backgroundTaskService.getOutputBuffer(task.id),
		sourceNotifies: (result) =>
			!(task.backgroundKind === "service" && result.status === "cancelled"),
	});
}

async function watchAgent(input: TaskWatchInput, ctx: ToolContext): Promise<ToolResult> {
	const { awaitAgentResultDetailed } = await import("./agent-communication");
	const snapshot = await awaitAgentResultDetailed({
		callerNarratorId: ctx.narratorId,
		id: input.id,
		userId: ctx.userId,
		signal: ctx.signal,
		snapshotOnly: true,
	});
	const { id, label } = snapshot;
	if (snapshot.status !== "running") {
		ctx.signal.throwIfAborted();
		await checkObservationAuthorization(ctx, input.type);
		return {
			output: await resultText("agent", label, snapshot),
			metadata: {
				kind: "watch",
				type: "agent",
				id,
				targetId: input.id,
				status: snapshot.status,
				subagentId: id,
			},
		};
	}
	return observeAgentRun(
		input,
		ctx,
		{ id, label, title: snapshot.title },
		snapshot.publicationRun?.recipientId ?? ctx.narratorId,
		snapshot.publicationRun?.logicalRunId,
	);
}

async function observeAgentRun(
	input: TaskWatchInput,
	ctx: WatchActor,
	target: { id: string; label: string; title?: string | null },
	recipientId: string,
	expectedRunId: string | undefined,
	adopt?: AdoptedWatchRow,
): Promise<ToolResult> {
	const { id, label } = target;
	const { waitForSubagentResult } = await import("./agent-communication");
	const { narratorService } = await import("./narrator-service");
	// Committed reads verify the target against its team root, so watchers that share a
	// root and recipient share one waiter; each still re-checks its own access below.
	const teamRoot = teamRootOf(await narratorService.getById(id));
	const runKey = `agent ${JSON.stringify(id)} run ${JSON.stringify(expectedRunId ?? null)}`;
	return observeTarget({
		input,
		ctx,
		id,
		label,
		adopt,
		title: `watch agent ${target.title ?? label}`,
		command: formatWatchTarget({
			type: "agent",
			id,
			runId: expectedRunId ?? null,
			timeoutMs: input.timeout,
		}),
		runKey,
		conditionKey: runKey,
		sourceKey: `${runKey} to ${JSON.stringify(recipientId)} root ${JSON.stringify(teamRoot)}`,
		wait: (timeoutMs, signal) =>
			waitForSubagentResult({
				subagentId: id,
				recipientId,
				expectedRunId,
				reportTakenOver: true,
				watchOwnerNarratorId: teamRoot,
				timeoutMs,
				signal,
			}),
		deadlineOutput: () => "Subagent is still running.",
		accept: async (result) => {
			if (AGENT_LIFECYCLE_STATUSES.has(result.status)) return result;
			if (!isTeamMember(await narratorService.getById(id), ctx.narratorId))
				throw new Error("Observation access was revoked.");
			return result;
		},
	});
}

/**
 * Re-attach a lifecycle watch to the same target after a restart, keeping its original
 * deadline. Returns false when the target is gone, re-bound to another run, no longer
 * owned by the watcher, or (Bash/agent) no longer running; the caller then ends the row
 * as interrupted. A Bash task or agent ended by the restart publishes a `cancelled`
 * notice, which never wakes its recipient, so the interruption notice must still be
 * what tells the waiting session to look. A terminal's ending is reported by the watch
 * itself, so an exited or detached terminal is re-attached and reported as such.
 */
export async function resumeWatchAfterRestart(
	row: RestartWatchRow,
	target: ResumableWatchTarget,
): Promise<boolean> {
	const adopt: AdoptedWatchRow = {
		taskId: row.id,
		alias: row.alias,
		deadlineAt: restartWatchDeadline(row, target),
	};
	// Only the time left: a merge into another re-attached observation must not extend it.
	const timeout = Math.max(1, adopt.deadlineAt - Date.now());
	// Authorize as the identity that registered the watch, as its live observation
	// would, so a user-level revocation still applies and a later collaborator's policy
	// is never borrowed. A row that does not record it is never re-attached.
	if (!row.principal) return false;
	const { narratorService } = await import("./narrator-service");
	const actor: WatchActor = {
		narratorId: row.parentNarratorId,
		signal: new AbortController().signal,
		userId: row.principal.userId,
	};
	await checkObservationAuthorization(actor, target.type);
	if (target.type === "terminal") return resumeTerminalWatch(row, target.id, adopt, timeout);
	const input: TaskWatchInput = { type: target.type, id: target.id, timeout };
	let result: ToolResult;
	if (target.type === "bash") {
		const task = await backgroundTaskService.getById(target.id);
		if (
			!task ||
			task.type !== "bash" ||
			task.parentNarratorId !== row.parentNarratorId ||
			task.logicalRunId !== target.runId ||
			task.status !== "running"
		)
			return false;
		result = await observeBashTask(task, input, actor, adopt);
	} else {
		const { awaitAgentResultDetailed } = await import("./agent-communication");
		const narrator = await narratorService.getById(target.id);
		if (!narrator || narrator.logicalRunId !== target.runId) return false;
		if (!isTeamMember(narrator, row.parentNarratorId)) return false;
		const snapshot = await awaitAgentResultDetailed({
			callerNarratorId: row.parentNarratorId,
			id: target.id,
			userId: actor.userId,
			signal: actor.signal,
			snapshotOnly: true,
		});
		if (snapshot.status !== "running") return false;
		result = await observeAgentRun(
			input,
			actor,
			{
				id: narrator.id,
				label: agentLabelFromNarrator(narrator, row.parentNarratorId),
				title: narrator.title,
			},
			runDeliverToOf(narrator)?.narratorId ?? row.parentNarratorId,
			target.runId,
			adopt,
		);
	}
	// A duplicate leftover row merges into an earlier re-attached observation of the same
	// condition; only the row that owns the live observation counts as re-attached.
	return result.metadata?.status === "watching" && result.metadata.watchId === row.id;
}

async function resumeTerminalWatch(
	row: RestartWatchRow,
	terminalId: string,
	adopt: AdoptedWatchRow,
	timeoutMs: number,
): Promise<boolean> {
	const [{ terminalService }, { db }, { terminals }, { eq }] = await Promise.all([
		import("./terminal-service"),
		import("../db"),
		import("../db/schema"),
		import("drizzle-orm"),
	]);
	// Startup reattaches dtach sessions concurrently with narrator recovery; observe the
	// terminal only once that has settled, so a live session is not reported detached.
	await terminalService.whenStartupRecoverySettled();
	const readTerminal = () =>
		db.query.terminals.findFirst({
			where: eq(terminals.id, terminalId),
			columns: { name: true, status: true, narratorId: true },
		});
	const terminal = await readTerminal();
	if (!terminal || terminal.narratorId !== row.parentNarratorId) return false;
	const buffer = terminalService.getActiveBuffer(terminalId);
	const started = await startTerminalWatch({
		narratorId: row.parentNarratorId,
		terminalId,
		terminalName: terminal.name,
		timeoutMs,
		buffer,
		readLifecycleState: terminalLifecycleReader(
			terminalId,
			buffer,
			terminalService,
			async () => (await readTerminal())?.status,
		),
		adopt,
	});
	return started.status === "started" && started.taskId === row.id;
}
