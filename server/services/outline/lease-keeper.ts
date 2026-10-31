/**
 * Keeping a running session's task leases alive (design §4.5, §7.2): a session that set a task in
 * progress holds it on a lease of {@link OUTLINE_TASK_LEASE.leaseMs}; while the session runs, its
 * leases are renewed every {@link OUTLINE_TASK_LEASE.renewEveryMs}, so the runs of a server that
 * crashed lose their tasks to the expiry job soon. The timer renews until the run ends, so a run
 * that hangs without ending keeps its tasks (no watchdog yet).
 *
 * The agent runtime keeps one keeper per run (`agent-runtime/orchestrator.ts`): it renews when the
 * run starts, at each tool boundary and on a timer while a long tool call runs, never more often
 * than once per `renewEveryMs` for a session. A renewal is one indexed, bounded UPDATE of the
 * session's claims (nothing when it holds none), fired without waiting for it.
 *
 * A renewal that fails is tried again after a back-off (from {@link OUTLINE_LEASE_RETRY.firstMs},
 * doubling up to `renewEveryMs`), not at every tool boundary, and a failing database is reported
 * once per {@link OUTLINE_LEASE_RETRY.warnEveryMs} per session, not once per attempt.
 *
 * When a run ends (normally or not: `stop` in the runtime's `finally`), the session is idle between
 * turns, often waiting for its person (D27b): its claims go on the idle lease of
 * `OUTLINE_TASK_IDLE_LEASE_MS` (D41), and a subagent's pass to its root on that lease
 * (`idleOutlineTaskClaims`): the work belongs to the session, and the root's next run renews it
 * back to the running lease. A server that crashes stops no keeper: its leases run out after
 * `leaseMs`. An archived session (or one whose session is) holds nothing: its end lets go of
 * its claims instead.
 */
import { logger } from "@server/lib/logger";
import { isOutlineEnabled } from "./feature";
import { OUTLINE_TASK_LEASE } from "./model";
import type { OutlineStore } from "./store/port";
import { idleOutlineTaskClaims, renewOutlineTaskLeases } from "./tasks";

export const OUTLINE_LEASE_RETRY = {
	/** First wait after a failed renewal; doubles up to `renewEveryMs`. */
	firstMs: 15_000,
	/** A session's failing renewals are reported at most this often. */
	warnEveryMs: 10 * 60_000,
};

export interface OutlineLeaseKeeper {
	/**
	 * Renew now unless the session renewed within `renewEveryMs`; resolves when done (or, when it
	 * does not renew, once the session's renewals still on their way are).
	 */
	touch(): Promise<void>;
	/**
	 * Stop renewing (the run ended). Unless another run of the session is still going, its claims
	 * go on the idle lease, and a subagent's pass to its root on it; resolves when that is done.
	 */
	stop(): Promise<void>;
}

/** When each session last renewed (ms), shared by its runs. */
const lastRenewal = new Map<string, number>();
/** Sessions whose renewals are failing: how often, when to try next, when last reported. */
const failing = new Map<string, { count: number; retryAt: number; warnedAt: number }>();
/** Keepers running, by session: for tests and diagnostics. */
const running = new Map<string, number>();
/**
 * Renewals on their way, by session, whichever of its keepers fired them: the last keeper to
 * stop waits for all of them before the idle lease, so none lands after it and cuts it back to
 * the running lease.
 */
const inFlight = new Map<string, Set<Promise<void>>>();

function track(narratorId: string, renewal: Promise<void>): void {
	let set = inFlight.get(narratorId);
	if (!set) {
		set = new Set();
		inFlight.set(narratorId, set);
	}
	set.add(renewal);
	void renewal.finally(() => {
		set.delete(renewal);
		if (set.size === 0 && inFlight.get(narratorId) === set) inFlight.delete(narratorId);
	});
}

/** Wait until the session has no renewal on its way. */
async function settle(narratorId: string): Promise<void> {
	for (let set = inFlight.get(narratorId); set && set.size > 0; set = inFlight.get(narratorId))
		await Promise.all([...set]);
}

export interface OutlineLeaseKeeperOptions {
	store?: OutlineStore;
	/** Clock in ms (tests). */
	now?: () => number;
	/** Whether to renew at all; the outline being switched on by default. */
	enabled?: () => boolean;
	/** Timer interval; `renewEveryMs` by default, 0 for no timer (tests drive `touch`). */
	intervalMs?: number;
}

/** Start keeping a session's leases alive for the length of a run. */
export function keepOutlineTaskLeases(
	narratorId: string,
	options: OutlineLeaseKeeperOptions = {},
): OutlineLeaseKeeper {
	const clock = options.now ?? Date.now;
	const enabled = options.enabled ?? isOutlineEnabled;
	const store = options.store ? { store: options.store } : {};
	let stopped = false;
	const touch = async (): Promise<void> => {
		if (stopped || !enabled()) return;
		const at = clock();
		const failed = failing.get(narratorId);
		if (failed && at < failed.retryAt) return;
		const last = lastRenewal.get(narratorId);
		if (!failed && last !== undefined && at - last < OUTLINE_TASK_LEASE.renewEveryMs) {
			await settle(narratorId);
			return;
		}
		lastRenewal.set(narratorId, at);
		const renewal = renew(at, failed);
		track(narratorId, renewal);
		await renewal;
	};
	/** One renewal; never rejects (a failure is backed off and reported). */
	const renew = async (
		at: number,
		failed: { count: number; retryAt: number; warnedAt: number } | undefined,
	): Promise<void> => {
		try {
			await renewOutlineTaskLeases(narratorId, { now: new Date(at), ...store });
			if (failed) {
				failing.delete(narratorId);
				logger.info("Outline task leases renewed again", {
					narratorId,
					failedAttempts: failed.count,
				});
			}
		} catch (error) {
			lastRenewal.delete(narratorId);
			const count = (failed?.count ?? 0) + 1;
			const waitMs = Math.min(
				OUTLINE_TASK_LEASE.renewEveryMs,
				OUTLINE_LEASE_RETRY.firstMs * 2 ** (count - 1),
			);
			const warn = !failed || at - failed.warnedAt >= OUTLINE_LEASE_RETRY.warnEveryMs;
			failing.set(narratorId, {
				count,
				retryAt: at + waitMs,
				warnedAt: warn ? at : (failed?.warnedAt ?? at),
			});
			if (warn) {
				logger.warn("Outline task leases could not be renewed", {
					narratorId,
					failedAttempts: count,
					retryInMs: waitMs,
					error: String(error),
				});
			}
		}
	};
	const intervalMs = options.intervalMs ?? OUTLINE_TASK_LEASE.renewEveryMs;
	const timer =
		intervalMs > 0
			? setInterval(() => {
					void touch();
				}, intervalMs)
			: null;
	timer?.unref?.();
	running.set(narratorId, (running.get(narratorId) ?? 0) + 1);
	void touch();
	return {
		touch,
		async stop() {
			if (stopped) return;
			stopped = true;
			if (timer) clearInterval(timer);
			const left = (running.get(narratorId) ?? 1) - 1;
			if (left > 0) {
				running.set(narratorId, left);
				return;
			}
			running.delete(narratorId);
			// Renewals still on their way (fired without waiting, at a tool boundary, by this or
			// another run of the session that stopped before) would land after the idle lease and
			// cut it back to the running one: they go first.
			await settle(narratorId);
			lastRenewal.delete(narratorId);
			failing.delete(narratorId);
			if (!enabled()) return;
			try {
				await idleOutlineTaskClaims(narratorId, { now: new Date(clock()), ...store });
			} catch (error) {
				// Its leases then run out on the running lease, as a crashed run's do.
				logger.warn("Outline task claims could not be put on the idle lease", {
					narratorId,
					error: String(error),
				});
			}
		},
	};
}

/** How many keepers are running for a session (tests, diagnostics). */
export function outlineLeaseKeepersOf(narratorId: string): number {
	return running.get(narratorId) ?? 0;
}
