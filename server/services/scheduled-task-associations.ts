import { taskLifecycle } from "@shared/scheduled-task-status";
import type { ScheduledTaskAssociationsPage } from "@shared/scheduled-task-targets";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { narrators, scheduledTasks } from "../db/schema";
import { readQuery } from "../db/worker-read";
import { NotFoundError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { hotOnce, hotSafe } from "../lib/hot-safe";
import { canReadNarrator, NARRATOR_ACL_COLUMNS } from "./narrator-acl";
import {
	resolveTaskPrincipal,
	type ScheduledTaskPrincipal,
	taskReadableWhere,
} from "./scheduled-task-acl";
import { readTaskSchedule } from "./scheduled-task-schedule-state";
import {
	decodeScheduledTaskCursor,
	encodeScheduledTaskCursor,
	type ScheduledTaskPageOptions,
	scheduledTaskPageLimit,
} from "./scheduled-task-targets";

const MAX_CACHED_PAGES = 2048;
const CACHE_TTL_MS = 30_000;
const cache = hotSafe(
	"scheduled-task-associations:pages",
	() => new Map<string, { ids: string[]; expiresAt: number }>(),
);

export function invalidateScheduledTaskAssociations(): void {
	cache.clear();
}

if (hotOnce("scheduled-task-associations:listeners")) {
	for (const type of [
		"scheduled_task:changed",
		"scheduled_task:transferred",
		"narrator:deleted",
		"narrator:access_changed",
		"project:access_changed",
		"auth:changed",
	] as const)
		eventBus.on(type, invalidateScheduledTaskAssociations);
}

/** Current references plus live runs. Historic borrowing does not make an enduring association. */
function associatedWhere(narratorId: string, createdByTaskId: string | null) {
	return sql`${scheduledTasks.id} IN (
		SELECT id FROM scheduled_tasks WHERE narrator_mode = 'existing' AND target_narrator_id = ${narratorId}
		UNION SELECT id FROM scheduled_tasks WHERE narrator_mode = 'reuse' AND reuse_narrator_id = ${narratorId}
		UNION SELECT task_id FROM scheduled_task_runs
			WHERE narrator_id = ${narratorId} AND status IN ('waiting','running','blocked')
		UNION SELECT id FROM scheduled_tasks WHERE id = ${createdByTaskId}
	)`;
}

function unfinishedRunExists() {
	return sql<boolean>`EXISTS (
		SELECT 1 FROM scheduled_task_runs r WHERE r.task_id = scheduled_tasks.id
		AND r.status IN ('waiting','running','blocked') LIMIT 1
	)`;
}

/** Cache only bounded IDs; every response rechecks current ACL, relations and lifecycle in SQL. */
export async function listNarratorScheduledTasks(
	narratorId: string,
	principal: ScheduledTaskPrincipal,
	options: ScheduledTaskPageOptions = {},
): Promise<ScheduledTaskAssociationsPage> {
	const live = await resolveTaskPrincipal(principal.userId);
	const narrator = await readQuery(
		db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { ...NARRATOR_ACL_COLUMNS, scheduledTaskId: true },
		}),
		{ executionPolicy: "worker-required" },
	);
	if (!narrator || !(await canReadNarrator(narrator, live)))
		throw new NotFoundError("Narrator", narratorId);
	const limit = scheduledTaskPageLimit(options.limit);
	const scope = `associations:${narratorId}`;
	const position = decodeScheduledTaskCursor(options.cursor, scope);
	const relation = associatedWhere(narratorId, narrator.scheduledTaskId);
	const unfinished = unfinishedRunExists();
	const where = and(
		relation,
		taskReadableWhere(live),
		or(isNull(scheduledTasks.completedAt), unfinished),
		position ? gt(scheduledTasks.id, position) : undefined,
	);
	const key = JSON.stringify([
		live.userId,
		live.isAdmin,
		narratorId,
		narrator.scheduledTaskId,
		position,
		limit,
	]);
	let cached = cache.get(key);
	if (!cached || cached.expiresAt <= Date.now()) {
		const candidates = await readQuery(
			db
				.select({ id: scheduledTasks.id })
				.from(scheduledTasks)
				.where(where)
				.orderBy(asc(scheduledTasks.id))
				.limit(limit + 1),
			{ executionPolicy: "worker-required" },
		);
		cached = { ids: candidates.map((row) => row.id), expiresAt: Date.now() + CACHE_TTL_MS };
		cache.delete(key);
		if (cache.size >= MAX_CACHED_PAGES) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		cache.set(key, cached);
	}
	if (!cached.ids.length) return { tasks: [], nextCursor: null };
	const rows = await readQuery(
		db
			.select({
				id: scheduledTasks.id,
				name: scheduledTasks.name,
				enabled: scheduledTasks.enabled,
				completedAt: scheduledTasks.completedAt,
				firedCount: scheduledTasks.firedCount,
				schedule: scheduledTasks.schedule,
				cronExpr: scheduledTasks.cronExpr,
				timezone: scheduledTasks.timezone,
				createdAt: scheduledTasks.createdAt,
				lastStatus: scheduledTasks.lastStatus,
				modelPolicy: scheduledTasks.modelPolicy,
				requireReport: scheduledTasks.requireReport,
				hasUnfinishedRun: unfinished.mapWith(Boolean).as("has_unfinished_run"),
			})
			.from(scheduledTasks)
			.where(and(where, inArray(scheduledTasks.id, cached.ids)))
			.orderBy(asc(scheduledTasks.id))
			.limit(limit + 1),
		{ executionPolicy: "worker-required" },
	);
	const tasks = rows.slice(0, limit).map((row) => {
		const schedule = readTaskSchedule(row);
		return {
			id: row.id,
			name: row.name,
			lifecycle: taskLifecycle(row),
			firedCount: row.firedCount,
			total:
				schedule.kind === "at"
					? schedule.times.length
					: schedule.end.type === "count"
						? schedule.end.count
						: null,
			lastStatus: row.lastStatus,
			hasUnfinishedRun: !!row.hasUnfinishedRun,
			modelPolicy: row.modelPolicy,
			requireReport: row.requireReport,
		};
	});
	return {
		tasks,
		nextCursor: rows.length > limit ? encodeScheduledTaskCursor(tasks[limit - 1].id, scope) : null,
	};
}
