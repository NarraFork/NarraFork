import {
	NOTIFICATION_RETENTION_MAX_AGE_MS,
	NOTIFICATION_RETENTION_MAX_ROWS,
} from "@shared/notification-center";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { hotSafe, hotTimer, hotTimerClear } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { notifyNotificationCenterChanged } from "./notification-center-service";

export const NOTIFICATION_MAINTENANCE_INTERVAL_MS = 60_000;
export const NOTIFICATION_MAINTENANCE_USERS_PER_TICK = 8;
export const NOTIFICATION_MAINTENANCE_DELETE_PER_USER = 100;
export const NOTIFICATION_MAINTENANCE_DELETE_PER_TICK = 400;
export const NOTIFICATION_MAINTENANCE_BUDGET_MS = 25;
const TIMER_KEY = "narrafork.notification-center.maintenance.timer";
const state = hotSafe("narrafork.notification-center.maintenance.state", () => ({
	cursor: "",
	running: false,
	stopped: true,
	generation: 0,
	drain: [] as Array<() => void>,
}));

interface Boundary {
	id: string;
	createdAt: number;
}

/** Only 500 indexed entries are inspected to find the retained count boundary. */
function deleteUserOverflow(userId: string, now: number, limit: number): number {
	const age = now - NOTIFICATION_RETENTION_MAX_AGE_MS;
	const boundary = db.all<Boundary>(sql`
		SELECT id, created_at AS createdAt FROM notifications WHERE user_id = ${userId}
		ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ${NOTIFICATION_RETENTION_MAX_ROWS - 1}
	`)[0];
	// A lexicographic cutoff covers both age and count without an unbounded OFFSET or NOT IN.
	const cutoff =
		boundary && boundary.createdAt >= age
			? sql`(created_at < ${boundary.createdAt} OR (created_at = ${boundary.createdAt} AND id < ${boundary.id}))`
			: sql`created_at < ${age}`;
	const candidates = db.all<{ id: string }>(sql`
		SELECT id FROM notifications WHERE user_id = ${userId} AND ${cutoff}
		ORDER BY created_at ASC, id ASC LIMIT ${limit}
	`);
	if (!candidates.length) return 0;
	const ids = sql.join(
		candidates.map(({ id }) => sql`${id}`),
		sql`, `,
	);
	db.run(sql`DELETE FROM notifications WHERE user_id = ${userId} AND id IN (${ids})`);
	const changes = db.all<{ count: number }>(sql`SELECT changes() AS count`)[0]?.count ?? 0;
	if (changes) notifyNotificationCenterChanged(userId);
	return changes;
}

/** Exposed for deterministic maintenance tests; disabled until start and guarded against overlap. */
export async function runNotificationCenterMaintenanceTick(): Promise<{
	users: number;
	deleted: number;
	skipped: boolean;
}> {
	const result = { users: 0, deleted: 0, skipped: false };
	if (state.stopped || state.running) return { ...result, skipped: true };
	state.running = true;
	const generation = state.generation;
	const started = performance.now();
	const now = Date.now();
	try {
		while (
			!state.stopped &&
			generation === state.generation &&
			result.users < NOTIFICATION_MAINTENANCE_USERS_PER_TICK &&
			result.deleted < NOTIFICATION_MAINTENANCE_DELETE_PER_TICK &&
			performance.now() - started < NOTIFICATION_MAINTENANCE_BUDGET_MS
		) {
			const user = db.all<{ id: string }>(sql`
				SELECT id FROM users WHERE id > ${state.cursor} ORDER BY id ASC LIMIT 1
			`)[0];
			if (!user) {
				state.cursor = "";
				break;
			}
			// Advance even on an individual failure so a damaged user's rows cannot starve others.
			state.cursor = user.id;
			result.users++;
			try {
				result.deleted += deleteUserOverflow(
					user.id,
					now,
					Math.min(
						NOTIFICATION_MAINTENANCE_DELETE_PER_USER,
						NOTIFICATION_MAINTENANCE_DELETE_PER_TICK - result.deleted,
					),
				);
			} catch (error) {
				logger.warn("notification-center: retention user failed", {
					userId: user.id,
					error: String(error),
				});
			}
			// All SQL batches are finite; yield between users instead of one long transaction.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	} catch (error) {
		logger.warn("notification-center: retention tick failed", { error: String(error) });
	} finally {
		state.running = false;
		for (const resolve of state.drain.splice(0)) resolve();
		const elapsedMs = performance.now() - started;
		if (elapsedMs > NOTIFICATION_MAINTENANCE_BUDGET_MS) {
			logger.warn("notification-center: slow retention tick", { elapsedMs, ...result });
		}
	}
	return result;
}

export function startNotificationCenterMaintenance(): void {
	state.stopped = false;
	state.generation++;
	const timer = hotTimer(TIMER_KEY, () =>
		setInterval(() => {
			void runNotificationCenterMaintenanceTick();
		}, NOTIFICATION_MAINTENANCE_INTERVAL_MS),
	);
	timer.unref();
}

export async function stopNotificationCenterMaintenance(): Promise<void> {
	state.stopped = true;
	state.generation++;
	hotTimerClear(TIMER_KEY);
	if (state.running) await new Promise<void>((resolve) => state.drain.push(resolve));
}
