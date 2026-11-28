/**
 * tool-execution-groups.ts — server-side execution machinery for tool groups.
 *
 * The GROUPING PREDICATES moved to `@shared/tool-parallel-groups` and are
 * re-exported here so existing server imports keep working. They had to be
 * shareable: the frontend needs the same rule to tell "queued behind an earlier
 * call" apart from "starting concurrently in the same group", and both states
 * look identical on the wire (`initializing` next to a `running` sibling). See
 * that module's header.
 *
 * What stays here is what cannot leave the server: promise settling and streaming
 * selection depend on `ToolExecResult`.
 *
 * `SHELL_TOOL_NAME` is deliberately NOT re-exported — server code that needs the
 * shell's name should keep importing it from `./tool-name`, which owns it.
 */

import {
	groupToolExecutions,
	isAgentDependentToolExecutionGroup,
	isBashParallelOptIn,
	isParallelSafeToolExecution,
	isStrictSerialToolExecution,
	type ToolExecutionGroupItem,
} from "@shared/tool-parallel-groups";
import { isCheckpointStop } from "../../services/agent-runtime/checkpoint-stop";
import type { ToolExecResult } from "./tool-executor";

export {
	groupToolExecutions,
	isAgentDependentToolExecutionGroup,
	isBashParallelOptIn,
	isParallelSafeToolExecution,
	isStrictSerialToolExecution,
	type ToolExecutionGroupItem,
};

function getToolName(item: ToolExecutionGroupItem): string {
	return "toolName" in item ? item.toolName : item.name;
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
 * Convert ordinary execution failures to a formal tool result. A checkpoint pause
 * remains process control: its caller drains every started sibling before unwinding,
 * preserving the paused call rather than publishing a synthetic tool result.
 */
export async function settleToolExecutionResult(
	run: Promise<ToolExecResult>,
): Promise<ToolExecResult> {
	try {
		return await run;
	} catch (err) {
		if (isCheckpointStop(err)) throw err;
		return {
			output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
			durationMs: 0,
		};
	}
}
