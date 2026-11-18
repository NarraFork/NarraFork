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
	createWatchObservation,
	type WatchObservation,
} from "./watch-observation";

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
			? `Watch reached its deadline for ${type} ${label}. Only the observation ended; the target was not stopped.`
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
): ToolResult {
	return {
		output: `Watching ${input.type} ${label} (watch ${JSON.stringify(observation.alias)}, deadline in ${input.timeout}ms). End your turn or continue independent work. Results arrive in the mailbox. Stop({ type: "bash", id: ${JSON.stringify(observation.alias)} }) cancels only this observation.`,
		metadata: {
			kind: "watch",
			type: input.type,
			id,
			targetId: input.id,
			watchId: observation.taskId,
			watchAlias: observation.alias,
			status: "watching",
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
	});
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
	ctx.signal.throwIfAborted();
	const observation = await createWatchObservation({
		narratorId: ctx.narratorId,
		title: `watch bash ${label}`,
		command: `bash ${JSON.stringify(task.id)} run ${JSON.stringify(task.logicalRunId)}${input.pattern ? ` for ${JSON.stringify(input.pattern)}` : ""}`,
		toolUseId: ctx.currentToolUseId,
	});
	if (ctx.signal.aborted) {
		await cancelWatchRegistration(observation);
		return { output: "Watch registration interrupted. The target was not stopped." };
	}
	void (async () => {
		try {
			const result = input.pattern
				? await backgroundTaskService.waitForText(
						task.id,
						input.pattern,
						input.timeout,
						observation.signal,
					)
				: await backgroundTaskService.waitForCompletion(task.id, input.timeout, observation.signal);
			await checkObservationAuthorization(ctx, input.type);
			await finishTargetObservation(
				observation,
				input,
				label,
				result,
				!(task.backgroundKind === "service" && result.status === "cancelled"),
			);
		} catch (error) {
			await observation.finish({
				status: "failed",
				output: `Watch could not observe Bash ${label}: ${String(error)}. The target was not stopped.`,
			});
		}
	})();
	return registeredResult(input, task.id, observation, label);
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
	ctx.signal.throwIfAborted();
	const observation = await createWatchObservation({
		narratorId: ctx.narratorId,
		title: `watch agent ${snapshot.title ?? label}`,
		command: `agent ${JSON.stringify(id)} run ${JSON.stringify(snapshot.publicationRun?.logicalRunId ?? null)}`,
		toolUseId: ctx.currentToolUseId,
	});
	if (ctx.signal.aborted) {
		await cancelWatchRegistration(observation);
		return { output: "Watch registration interrupted. The target was not stopped." };
	}
	void (async () => {
		try {
			const result = await waitForSubagentResult({
				subagentId: id,
				recipientId: snapshot.publicationRun?.recipientId ?? ctx.narratorId,
				expectedRunId: snapshot.publicationRun?.logicalRunId,
				reportTakenOver: true,
				timeoutMs: input.timeout,
				signal: observation.signal,
			});
			await checkObservationAuthorization(ctx, input.type);
			await finishTargetObservation(observation, input, label, result);
		} catch (error) {
			await observation.finish({
				status: "failed",
				output: `Watch could not observe agent ${label}: ${String(error)}. The target was not stopped.`,
			});
		}
	})();
	return registeredResult(input, id, observation, label);
}
