/**
 * tool-parallel-groups.ts — WHICH consecutive tool calls the agent loop runs at
 * the same time.
 *
 * The loop groups consecutive parallel-safe calls and executes one GROUP at a
 * time (`groupToolExecutions` in `server/lib/agent/tool-execution-groups.ts`,
 * which re-exports from here). That grouping is not only an execution detail: the
 * frontend needs it to tell two states apart that look identical on the wire.
 *
 * ── WHY THE FRONTEND NEEDS IT ─────────────────────────────────────────────────
 * A tool call at `initializing` has finished parsing its arguments and has not
 * been admitted yet. There are two reasons it can sit there:
 *
 *   1. an EARLIER call still owns the execution slot  → it is genuinely queued
 *   2. it is in the SAME parallel group as that call  → it is already starting
 *
 * Both show `initializing` next to a `running` sibling, so a sibling-order scan
 * alone cannot separate them — and painting case 2 as "parked, waiting its turn"
 * misreports concurrent work as blocked work. The predicate below is the only
 * thing that distinguishes them, which is why it lives in shared/ rather than
 * being approximated on either side.
 *
 * ── SCOPE ─────────────────────────────────────────────────────────────────────
 * Pure name/input predicates only. The execution machinery (promise settling,
 * streaming selection) stays server-side: it depends on `ToolExecResult` and has
 * no meaning in a renderer.
 */

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

/**
 * The shell tool's canonical name.
 *
 * Duplicated from `server/lib/agent/tool-name.ts` rather than imported: that
 * module is server-side and carries provider wire-format concerns (name
 * alphabets, length caps) that have no place in a shared predicate. The value is
 * a protocol constant — it appears verbatim in stored history and in every
 * provider's tool schema — so it cannot drift silently; `tool-name.ts` asserts
 * the same string.
 */
export const PARALLEL_GROUP_SHELL_TOOL_NAME = "Bash";

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
		getToolName(item) === PARALLEL_GROUP_SHELL_TOOL_NAME &&
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
	if (toolName === PARALLEL_GROUP_SHELL_TOOL_NAME) {
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
 * Whether two calls that are ADJACENT in provider order land in the same parallel
 * execution group — i.e. whether they start together.
 *
 * Adjacency is the whole question: grouping only ever merges CONSECUTIVE calls, so
 * a non-adjacent pair is in the same group only if everything between them is too,
 * which callers establish by walking the prefix (see `sharesParallelGroup`).
 */
function adjacentCallsShareGroup(
	earlier: ToolExecutionGroupItem,
	later: ToolExecutionGroupItem,
): boolean {
	if (!isParallelSafeToolExecution(earlier) || !isParallelSafeToolExecution(later)) return false;
	return !isAgentDependentToolExecutionGroup([earlier], [later]);
}

/**
 * Whether the LAST item of `sequence` runs concurrently with the given earlier
 * item, given the whole provider-order run between them.
 *
 * `sequence` must be the contiguous provider-order slice from the earlier call
 * through the call being judged (inclusive of both). Any serial barrier inside
 * that slice separates them, which is exactly what makes the later call queued
 * rather than concurrent.
 *
 * Returns false for a slice shorter than two entries: a call cannot be concurrent
 * with itself, and there is nothing to be queued behind either.
 */
export function sharesParallelGroup(sequence: readonly ToolExecutionGroupItem[]): boolean {
	if (sequence.length < 2) return false;
	for (let i = 1; i < sequence.length; i++) {
		const previous = sequence[i - 1];
		const current = sequence[i];
		if (!previous || !current) return false;
		if (!adjacentCallsShareGroup(previous, current)) return false;
	}
	return true;
}
