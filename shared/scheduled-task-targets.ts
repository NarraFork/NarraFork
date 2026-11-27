import type { ScheduledRunStatus, TaskLifecycle, TaskModelPolicy } from "./scheduled-task-status";

/** Small, authorized projections; never contain task prompts or narrator history. */
export interface ScheduledTaskTarget {
	id: string;
	title: string | null;
	status: string;
	cwd: string | null;
	projectId: string | null;
	model: string | null;
}

export interface ScheduledTaskTargetsPage {
	items: ScheduledTaskTarget[];
	nextCursor: string | null;
}

export interface ScheduledTaskAssociation {
	id: string;
	name: string;
	lifecycle: TaskLifecycle;
	firedCount: number;
	total: number | null;
	lastStatus: ScheduledRunStatus | null;
	hasUnfinishedRun: boolean;
	modelPolicy: TaskModelPolicy;
	requireReport: boolean;
}

export interface ScheduledTaskAssociationsPage {
	tasks: ScheduledTaskAssociation[];
	nextCursor: string | null;
}
