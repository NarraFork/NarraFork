import type { ToolExecResult } from "./tool-executor";
import { SHELL_TOOL_NAME } from "./tools/bash";

/**
 * Tools that may share a parallel execution group by default.
 * Bash is intentionally absent: consecutive Bash calls are serial unless each
 * call opts in with `parallel: true`.
 */
const PARALLEL_SAFE_TOOL_NAMES = new Set([
	"Agent",
	"Read",
	"Glob",
	"Grep",
	"StructView",
	"WebSearch",
	"WebFetch",
	"Await",
	"Send",
]);

const ALWAYS_STRICT_SERIAL_TOOL_NAMES = new Set([
	"StartPipeline",
	"ExtractPipeline",
	"EnterPlanMode",
	"ExitPlanMode",
]);

/**
 * Tools that communicate with a spawned subagent. When an Agent already sits in the
 * current parallel batch, these must observe that agent's registered/running state,
 * so they start in a fresh group after the Agent batch settles instead of racing it.
 */
const AGENT_BARRIER_DEPENDENT_TOOL_NAMES = new Set(["Await", "Send"]);

const AGENT_TOOL_NAME = "Agent";

export type ToolExecutionGroupItem =
	| { name: string; input: Record<string, unknown> }
	| { toolName: string; input: Record<string, unknown> };

function getToolName(item: ToolExecutionGroupItem): string {
	return "toolName" in item ? item.toolName : item.name;
}

/**
 * Whether a group containing Await/Send must start only after the preceding Agent
 * group has registered its spawned work. Live grouping uses this to create the
 * boundary; recovery uses the same predicate to await the Agent's mount rather
 * than its long-running terminal completion.
 */
export function isAgentDependentToolExecutionGroup<T extends ToolExecutionGroupItem>(
	previousGroup: readonly T[] | undefined,
	currentGroup: readonly T[],
): boolean {
	return (
		(previousGroup?.some((member) => getToolName(member) === AGENT_TOOL_NAME) ?? false) &&
		currentGroup.some((member) => AGENT_BARRIER_DEPENDENT_TOOL_NAMES.has(getToolName(member)))
	);
}

/**
 * Bash opt-in to parallel grouping. Default Bash is serial; only an explicit
 * `parallel: true` (without `strict_serial`) may join a parallel batch.
 */
export function isBashParallelOptIn(item: ToolExecutionGroupItem): boolean {
	return (
		getToolName(item) === SHELL_TOOL_NAME &&
		item.input.parallel === true &&
		item.input.strict_serial !== true
	);
}

/**
 * Whether a tool must form a serial execution barrier.
 * Bash defaults to serial — only `parallel: true` opts out; `strict_serial` always wins.
 */
export function isStrictSerialToolExecution(item: ToolExecutionGroupItem): boolean {
	const toolName = getToolName(item);
	if (toolName === SHELL_TOOL_NAME) {
		return item.input.strict_serial === true || item.input.parallel !== true;
	}
	return ALWAYS_STRICT_SERIAL_TOOL_NAMES.has(toolName);
}

/** Whether this tool call may join a parallel group with its neighbors. */
export function isParallelSafeToolExecution(item: ToolExecutionGroupItem): boolean {
	if (isStrictSerialToolExecution(item)) return false;
	return PARALLEL_SAFE_TOOL_NAMES.has(getToolName(item)) || isBashParallelOptIn(item);
}

/**
 * Preserve provider tool_use order while grouping consecutive parallel-safe calls.
 * Non-parallel and strict-serial tools each form their own group. Bash is serial
 * unless the call sets `parallel: true`.
 *
 * Additionally, an Agent already present in the current parallel batch forms a
 * deterministic barrier for a subsequent Await/Send: those open a new group so the
 * spawned agent is observable before the wait/message runs. Agent+Agent and Agent+Read
 * stay parallel. The same grouping drives both the live loop and planned-update recovery.
 */
export function groupToolExecutions<T extends ToolExecutionGroupItem>(items: readonly T[]): T[][] {
	const groups: T[][] = [];
	for (const item of items) {
		const isParallel = isParallelSafeToolExecution(item);
		const lastGroup = groups[groups.length - 1];
		const firstInLastGroup = lastGroup?.[0];
		const lastGroupIsParallel =
			firstInLastGroup !== undefined && isParallelSafeToolExecution(firstInLastGroup);
		const crossesAgentBarrier = isAgentDependentToolExecutionGroup(lastGroup, [item]);
		if (isParallel && lastGroupIsParallel && !crossesAgentBarrier) {
			lastGroup.push(item);
		} else {
			groups.push([item]);
		}
	}
	return groups;
}

/**
 * Select work from the first unfinished group in provider order. Callers must retain
 * every observed identity (including incomplete calls) and mark selections started
 * before selecting again. This function does not mutate its inputs.
 *
 * Incomplete, deferred, and fatal calls stop the eligible prefix, even inside a
 * parallel group. Complete members before that boundary may still start. Running
 * parallel groups can accept new siblings, but later groups wait for all members
 * to settle. A settled nonfatal call is no longer deferred, regardless of allowed.
 */
export function selectStreamingToolExecutions<T extends ToolExecutionGroupItem>(
	items: readonly {
		tool?: T;
		ready: boolean;
		started: boolean;
		settled: boolean;
		fatal?: boolean;
		allowed: boolean;
	}[],
): T[] {
	const prefix = [];
	for (const item of items) {
		const { tool } = item;
		if (!tool || !item.ready || item.fatal || (!item.allowed && !item.settled)) break;
		prefix.push({ toolName: getToolName(tool), input: tool.input, tool, state: item });
	}

	for (const group of groupToolExecutions(prefix)) {
		if (group.every(({ state }) => state.settled)) continue;
		return group.filter(({ state }) => !state.started && !state.settled).map(({ tool }) => tool);
	}
	return [];
}

/**
 * Resolve a tool execution promise into a settled ToolExecResult, guaranteeing it never
 * rejects. A genuine rejection thrown from executeTool/executeToolAfterReflections becomes
 * a formal isError result so parallel siblings keep yielding/persisting and the model still
 * receives a tool_result in the original call order.
 */
export async function settleToolExecutionResult(
	run: Promise<ToolExecResult>,
): Promise<ToolExecResult> {
	try {
		return await run;
	} catch (err) {
		return {
			output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
			durationMs: 0,
		};
	}
}
