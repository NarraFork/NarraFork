import type { WatchTarget } from "@shared/watch-command";

/** A `[watch]` row the previous server process left `running`. */
export interface RestartWatchRow {
	id: string;
	parentNarratorId: string;
	alias: string | null;
	createdAt: string;
	/** Who registered the watch; undefined when the row does not record it. */
	principal: { userId: string | null } | undefined;
}

/** The stored registrant of a watch row, or undefined when absent or malformed. */
export function restartWatchPrincipal(value: unknown): { userId: string | null } | undefined {
	if (!value || typeof value !== "object" || !("userId" in value)) return undefined;
	const { userId } = value as { userId: unknown };
	return userId === null || (typeof userId === "string" && userId.length > 0)
		? { userId }
		: undefined;
}

export type ResumableWatchTarget = WatchTarget & { timeoutMs: number } & (
		| { type: "bash" | "agent"; runId: string }
		| { type: "terminal" }
	);

/**
 * Whether restart recovery should keep this watch row for re-attachment instead of
 * ending it. Only lifecycle observations qualify (no `pattern`): they need nothing
 * but the target's durable state. Text watches cannot prove they saw the output
 * produced while no server was running, so they still end as interrupted.
 * A watch whose original deadline passed during the downtime also ends: the restart
 * cannot tell whether the target finished before or after that deadline.
 */
export function restartResumableWatch(
	target: WatchTarget | null,
	createdAt: string,
	now = Date.now(),
): target is ResumableWatchTarget {
	if (!target || target.pattern || target.timeoutMs == null) return false;
	// Without a run binding a later run of the same Bash task or agent could be mistaken
	// for the observed one. A terminal is its own binding: a restart never reuses its id.
	if (target.type !== "terminal" && !target.runId) return false;
	const deadlineAt = Date.parse(createdAt) + target.timeoutMs;
	return Number.isFinite(deadlineAt) && deadlineAt > now;
}

/** The original absolute deadline of a re-attached watch, in epoch ms. */
export function restartWatchDeadline(row: RestartWatchRow, target: ResumableWatchTarget): number {
	return Date.parse(row.createdAt) + target.timeoutMs;
}
