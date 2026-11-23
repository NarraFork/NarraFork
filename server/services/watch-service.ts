import { isTeamMember, teamRootOf } from "@server/lib/runtime-source";
import { formatWatchTarget, WATCH_DEADLINE_OUTPUT_PREFIX } from "@shared/watch-command";
import type { ToolContext, ToolResult } from "../lib/agent/types";
import { isRuntimeToolAllowed, runtimeWatchTargets } from "./agent-runtime/policy";
import { prepareBackgroundBashResult } from "./background-bash-result";
import { type BackgroundTaskRecord, backgroundTaskService } from "./background-task-service";
import { assertOAuthNarratorRuntimeActive } from "./oauth-narrator-runtime-policy";
import { resolveTaskAlias } from "./subagent-alias";
import { TERMINAL_WATCH_COMMAND_PREFIX, WATCH_COMMAND_PREFIX } from "./terminal-watch-constants";
import { resolveNarratorRuntimePolicy } from "./trait-layer-service";
import {
	cancelWatchRegistration,
	MAX_WATCH_TIMEOUT_MS,
	registerWatchObservation,
	type WatchObservation,
} from "./watch-observation";
import { subscribeWatchSource } from "./watch-source";

export interface TaskWatchInput {
	type: "bash" | "agent";
	id: string;
	pattern?: string;
	timeout: number;
}

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
	ctx: ToolContext;
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
		onDeadline: () => void reachDeadline(),
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
	ctx: ToolContext,
	type: TaskWatchInput["type"],
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
	const runKey = `bash ${JSON.stringify(task.id)} run ${JSON.stringify(task.logicalRunId)}`;
	const condition = input.pattern ? ` for ${JSON.stringify(input.pattern)}` : "";
	return observeTarget({
		input,
		ctx,
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
	const { awaitAgentResultDetailed, waitForSubagentResult } = await import("./agent-communication");
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
	const { narratorService } = await import("./narrator-service");
	const recipientId = snapshot.publicationRun?.recipientId ?? ctx.narratorId;
	const expectedRunId = snapshot.publicationRun?.logicalRunId;
	// Committed reads verify the target against its team root, so watchers that share a
	// root and recipient share one waiter; each still re-checks its own access below.
	const teamRoot = teamRootOf(await narratorService.getById(id));
	const runKey = `agent ${JSON.stringify(id)} run ${JSON.stringify(expectedRunId ?? null)}`;
	return observeTarget({
		input,
		ctx,
		id,
		label,
		title: `watch agent ${snapshot.title ?? label}`,
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
