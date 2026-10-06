export type ScheduledTaskCleanupPolicy =
	| { mode: "none" }
	| { mode: "keepLatestN"; keepLatestN: number }
	| { mode: "olderThanDays"; olderThanDays: number };

export interface ScheduledTaskCleanupResult {
	deletedRoots: number;
	deletedNarrators: number;
	blockedRoots: number;
	/** More candidates may remain; each invocation performs only one bounded batch. */
	limited: boolean;
}
