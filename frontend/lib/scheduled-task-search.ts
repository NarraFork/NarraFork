import type { ScheduleKind } from "@shared/scheduled-task-schedule";
import type { RunVerdict } from "@shared/scheduled-task-status";

export const RUN_VERDICTS: readonly RunVerdict[] = [
	"waiting",
	"running",
	"blocked",
	"completed",
	"succeeded",
	"unconfirmed",
	"incomplete",
	"failed",
	"timed_out",
	"interrupted",
	"skipped",
	"missed",
	"dispatched",
];

export interface ScheduledTaskSearch {
	lifecycle?: "paused" | "ended" | "all";
	attention?: true;
	creator?: "user" | "narrator" | "mine";
	owner?: string;
	projectId?: string;
	kind?: ScheduleKind;
	result?: RunVerdict;
	runContext?: "standalone" | "project";
	q?: string;
	sort?: "lastRun" | "createdAt" | "name";
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
function choice<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	return typeof value === "string" && allowed.includes(value as T) ? (value as T) : undefined;
}

/** URL state and API filters share one whitelist. Default active includes paused tasks. */
export function parseScheduledTaskSearch(input: Record<string, unknown>): ScheduledTaskSearch {
	const values: ScheduledTaskSearch = {
		lifecycle: choice(input.lifecycle, ["paused", "ended", "all"]),
		attention: input.attention === true || input.attention === "true" ? true : undefined,
		creator: choice(input.creator, ["user", "narrator", "mine"]),
		owner: typeof input.owner === "string" && ID.test(input.owner) ? input.owner : undefined,
		projectId:
			typeof input.projectId === "string" && ID.test(input.projectId) ? input.projectId : undefined,
		kind: choice(input.kind, ["at", "repeat", "cron"]),
		result: choice(input.result, RUN_VERDICTS),
		runContext: choice(input.runContext, ["standalone", "project"]),
		q:
			typeof input.q === "string" && input.q.trim().length <= 500
				? input.q.trim() || undefined
				: undefined,
		sort: choice(input.sort, ["lastRun", "createdAt", "name"]),
	};
	return Object.fromEntries(
		Object.entries(values).filter(([, value]) => value !== undefined),
	) as ScheduledTaskSearch;
}

export function parseScheduledTaskNewSearch(input: Record<string, unknown>) {
	return {
		...parseScheduledTaskSearch(input),
		...(typeof input.copyFrom === "string" && ID.test(input.copyFrom)
			? { copyFrom: input.copyFrom }
			: {}),
	};
}

export function parseScheduledTaskDetailSearch(input: Record<string, unknown>) {
	return {
		...parseScheduledTaskSearch(input),
		...(typeof input.runId === "string" && ID.test(input.runId) ? { runId: input.runId } : {}),
	};
}

export function hasScheduledTaskFilters(search: ScheduledTaskSearch): boolean {
	return Object.keys(search).some((key) => key !== "sort");
}
