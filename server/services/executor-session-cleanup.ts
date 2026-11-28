/**
 * Durable stop-and-release of executor sessions (`session.durable.v1`), shared by
 * remote terminals and background Bash.
 *
 * An intent row is written before the owner's local state treats the session as
 * finished, and removed only when the executor confirms `session.kill { release: true }`
 * (or no longer knows the session). So a restart, an offline device or a deleted
 * owner row never orphans a process, and the executor keeps a session's output and
 * exit until the owner has persisted what it needs.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { executorSessionCleanups } from "../db/schema";
import { readQuery } from "../db/worker-read";
import { eventBus } from "../lib/event-bus";
import { hotOnce } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { SESSION_DURABLE_FEATURE } from "../terminal/remote-session";
// Namespace import, read at call time: tests spy on it.
import * as deviceConnections from "./device-connection-service";

/** Persist the intent to stop and release a session; idempotent. */
export async function recordExecutorCleanup(deviceId: string, sessionId: string): Promise<void> {
	await db
		.insert(executorSessionCleanups)
		.values({ deviceId, sessionId, createdAt: new Date().toISOString() })
		.onConflictDoNothing();
}

async function runExecutorCleanup(deviceId: string, sessionId: string): Promise<boolean> {
	if (!deviceConnections.isDeviceOnline(deviceId)) return false;
	try {
		await deviceConnections.sendRpc(
			deviceId,
			"session.kill",
			{ sessionId, release: true },
			{ requiredFeatures: [SESSION_DURABLE_FEATURE] },
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Already gone (released, or the executor restarted): nothing left to stop.
		if (!message.includes("session not found")) {
			logger.debug("Executor session cleanup deferred", { deviceId, sessionId, error: message });
			return false;
		}
	}
	await db
		.delete(executorSessionCleanups)
		.where(
			and(
				eq(executorSessionCleanups.deviceId, deviceId),
				eq(executorSessionCleanups.sessionId, sessionId),
			),
		);
	return true;
}

/** Persist the intent, then try to deliver it now (retried while the device is online). */
export async function stopExecutorSession(deviceId: string, sessionId: string): Promise<void> {
	await recordExecutorCleanup(deviceId, sessionId);
	void runExecutorCleanup(deviceId, sessionId)
		.catch((error) => {
			logger.warn("Executor session cleanup failed", { deviceId, sessionId, error: String(error) });
			return false;
		})
		.then((done) => {
			if (!done) scheduleExecutorCleanupRetry(deviceId);
		});
}

const CLEANUP_PAGE = 100;

/** Deliver every pending cleanup for a device, a bounded page at a time; true when none is left. */
async function reconcileExecutorCleanups(deviceId: string): Promise<boolean> {
	const pending = await readQuery(
		db
			.select({ sessionId: executorSessionCleanups.sessionId })
			.from(executorSessionCleanups)
			.where(eq(executorSessionCleanups.deviceId, deviceId))
			.limit(CLEANUP_PAGE),
		{ executionPolicy: "worker-required", maxRows: CLEANUP_PAGE },
	);
	for (const { sessionId } of pending) {
		if (!(await runExecutorCleanup(deviceId, sessionId))) return false;
	}
	if (pending.length === CLEANUP_PAGE) return reconcileExecutorCleanups(deviceId);
	return true;
}

/** Delays between reconcile attempts while the device stays online and stops remain. */
export const EXECUTOR_CLEANUP_RETRY_MS = [500, 5_000, 30_000, 120_000];
const cleanupRetries = new Map<string, { timer: ReturnType<typeof setTimeout>; attempt: number }>();

/**
 * Reconcile a device's pending stops now, and keep retrying with backoff while it stays
 * online and something is left: a transient failure (read Worker busy, RPC timeout) must
 * not wait for the next reconnect. Going offline ends the retries; coming online restarts them.
 */
function reconcileWithRetry(deviceId: string, attempt = 0): void {
	const scheduled = cleanupRetries.get(deviceId);
	if (scheduled) clearTimeout(scheduled.timer);
	cleanupRetries.delete(deviceId);
	void reconcileExecutorCleanups(deviceId)
		.catch((error) => {
			logger.warn("Executor session cleanup reconcile failed", { deviceId, error: String(error) });
			return false;
		})
		.then((done) => {
			if (!done) scheduleExecutorCleanupRetry(deviceId, attempt);
		});
}

function scheduleExecutorCleanupRetry(deviceId: string, attempt = 0): void {
	if (cleanupRetries.has(deviceId) || !deviceConnections.isDeviceOnline(deviceId)) return;
	const delay = EXECUTOR_CLEANUP_RETRY_MS[Math.min(attempt, EXECUTOR_CLEANUP_RETRY_MS.length - 1)];
	const timer = setTimeout(() => {
		cleanupRetries.delete(deviceId);
		if (deviceConnections.isDeviceOnline(deviceId)) reconcileWithRetry(deviceId, attempt + 1);
	}, delay);
	timer.unref?.();
	cleanupRetries.set(deviceId, { timer, attempt });
}

if (hotOnce("narrafork:executor-session-cleanup")) {
	eventBus.on("device:status", (event) => {
		if (event.status === "online") reconcileWithRetry(event.deviceId);
		// A late offline from a replaced connection must not cancel the live one's retries.
		else if (!deviceConnections.isDeviceOnline(event.deviceId)) {
			const scheduled = cleanupRetries.get(event.deviceId);
			if (scheduled) clearTimeout(scheduled.timer);
			cleanupRetries.delete(event.deviceId);
		}
	});
}
