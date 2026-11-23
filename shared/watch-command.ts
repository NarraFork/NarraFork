/**
 * `command` prefixes of Watch observation rows in the background-task list.
 * Shared so the server can reject them as watch targets and the task panel can
 * filter them out of the default view.
 */

/** Legacy terminal-watch observations. */
export const TERMINAL_WATCH_COMMAND_PREFIX = "[terminal watch]";
/** All new observations, regardless of the target kind. */
export const WATCH_COMMAND_PREFIX = "[watch]";

/** Leading text of the stored output when an observation hit its deadline. */
export const WATCH_DEADLINE_OUTPUT_PREFIX = "Watch reached its deadline";
/** Same, for terminal watches. */
export const TERMINAL_WATCH_DEADLINE_OUTPUT_PREFIX = "Terminal watch timed out";

export function isWatchDeadlineOutput(output: string | null | undefined): boolean {
	if (!output) return false;
	return (
		output.startsWith(WATCH_DEADLINE_OUTPUT_PREFIX) ||
		output.startsWith(TERMINAL_WATCH_DEADLINE_OUTPUT_PREFIX)
	);
}

export function isWatchCommand(command: string | null | undefined): boolean {
	if (!command) return false;
	return (
		command.startsWith(WATCH_COMMAND_PREFIX) || command.startsWith(TERMINAL_WATCH_COMMAND_PREFIX)
	);
}

export type WatchTargetType = "bash" | "agent" | "terminal";

export interface WatchTarget {
	type: WatchTargetType;
	/** Target task or subagent narrator id. */
	id: string;
	/** Logical run of a bash or agent target; terminals have none. */
	runId?: string | null;
	pattern?: string;
	/** Observation deadline in ms from registration; absent on rows written before it was recorded. */
	timeoutMs?: number;
}

/** The part of a watch row's `command` after {@link WATCH_COMMAND_PREFIX}. */
export function formatWatchTarget(target: WatchTarget): string {
	return [
		target.type,
		JSON.stringify(target.id),
		...(target.runId !== undefined ? ["run", JSON.stringify(target.runId)] : []),
		...(target.pattern ? ["for", JSON.stringify(target.pattern)] : []),
		...(target.timeoutMs != null ? ["timeout", String(target.timeoutMs)] : []),
	].join(" ");
}

const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const WATCH_TARGET_PATTERN = new RegExp(
	String.raw`^(bash|agent|terminal) (${JSON_STRING})(?: run (${JSON_STRING}|null))?(?: for (${JSON_STRING}))?(?: timeout (\d+))?$`,
);

/** Parse a `[watch] …` row's command; null for legacy terminal watches or unknown shapes. */
export function parseWatchCommand(command: string | null | undefined): WatchTarget | null {
	if (!command?.startsWith(`${WATCH_COMMAND_PREFIX} `)) return null;
	const match = WATCH_TARGET_PATTERN.exec(command.slice(WATCH_COMMAND_PREFIX.length + 1));
	if (!match) return null;
	try {
		const [, type, id, runId, pattern, timeout] = match;
		return {
			type: type as WatchTargetType,
			id: JSON.parse(id as string) as string,
			...(runId ? { runId: JSON.parse(runId) as string | null } : {}),
			...(pattern ? { pattern: JSON.parse(pattern) as string } : {}),
			...(timeout ? { timeoutMs: Number(timeout) } : {}),
		};
	} catch {
		return null;
	}
}
