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

/**
 * The target status a finished agent/bash watch reported in its first line
 * (`Watch bash b1: found.`), or null when the output has no such header.
 */
export function watchResultTargetStatus(output: string | null | undefined): string | null {
	const header = output?.split("\n", 1)[0] ?? "";
	return /^Watch (?:agent|bash) .*: ([a-z_]+)\.$/.exec(header)?.[1] ?? null;
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

/** The watched target type of a background task's command, or null when it is no watch. */
export function watchCommandTargetType(command: string | null | undefined): WatchTargetType | null {
	if (!command) return null;
	if (command.startsWith(TERMINAL_WATCH_COMMAND_PREFIX)) return "terminal";
	return parseWatchCommand(command)?.type ?? null;
}

export type WatchNoticeOutcome =
	| "deadline"
	| "matched"
	| "ended"
	| "replaced"
	| "stopped"
	| "failed";

export interface WatchNotice {
	targetType: WatchTargetType | null;
	/** Watched target's name, from the observation's title. */
	targetName: string | null;
	outcome: WatchNoticeOutcome;
	/** The observed result without the "Watch agent X: completed." header line. */
	body: string;
}

function watchNoticeOutcome(
	status: string | null | undefined,
	output: string,
	targetStatus: string | null,
	targetType: WatchTargetType | null,
): WatchNoticeOutcome {
	if (status === "failed" || status === "fail" || status === "error") return "failed";
	if (status === "timeout" || isWatchDeadlineOutput(output)) return "deadline";
	if (targetStatus === "found" || targetStatus === "text_matched") return "matched";
	if (targetStatus === "superseded" || targetStatus === "taken_over") return "replaced";
	if (targetStatus && targetStatus !== "completed") return "stopped";
	if (output.startsWith("Terminal watch ended")) return "stopped";
	// A terminal watch completes on its pattern; agent and bash report their own status.
	return targetType === "terminal" && !targetStatus ? "matched" : "ended";
}

const WATCH_TITLE = /^watch (?:(agent|bash|terminal) )?/;
const LEGACY_WATCH_TITLE = /^watch (agent|bash) /;

/**
 * Which target a finished background "bash" notice watched, when it is really a Watch
 * observation's result; reads only the title and flag, never the (large) output.
 * `watch` is set by the server; older rows are recognized by their agent/bash title.
 */
export function watchNoticeIdentity(task: {
	title?: string | null;
	watch?: WatchTargetType | null;
}): Pick<WatchNotice, "targetType" | "targetName"> | null {
	const title = task.title?.trim() ?? "";
	if (!task.watch && !LEGACY_WATCH_TITLE.test(title)) return null;
	const titleMatch = WATCH_TITLE.exec(title);
	return {
		targetType: task.watch ?? (titleMatch?.[1] as WatchTargetType | undefined) ?? null,
		targetName: titleMatch ? title.slice(titleMatch[0].length).trim() || null : title || null,
	};
}

/** A Watch observation's result notice, read from its output; null for ordinary bash. */
export function watchNoticeFromTask(task: {
	title?: string | null;
	status?: string | null;
	preview?: string | null;
	watch?: WatchTargetType | null;
}): WatchNotice | null {
	const identity = watchNoticeIdentity(task);
	if (!identity) return null;
	const { targetType } = identity;
	const preview = task.preview?.trim() ?? "";
	const targetStatus = watchResultTargetStatus(preview);
	const outcome = watchNoticeOutcome(task.status, preview, targetStatus, targetType);
	const [header, ...rest] = preview.split(/\n\s*\n/);
	// Only a one-line result header is dropped; a terminal deadline runs straight into its
	// observed output, which may itself contain blank lines.
	const strip =
		!header.includes("\n") &&
		(targetStatus !== null || header.startsWith(WATCH_DEADLINE_OUTPUT_PREFIX));
	const body = strip ? rest.join("\n\n").trim() || preview : preview;
	return { ...identity, outcome, body };
}
