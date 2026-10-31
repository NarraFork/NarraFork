/**
 * Keeping a running session's task leases alive (design §4.5, §7.2): a session that set a task in
 * progress holds it on a lease of {@link OUTLINE_TASK_LEASE.leaseMs}; while the session runs, its
 * leases are renewed every {@link OUTLINE_TASK_LEASE.renewEveryMs}, so a run that crashed or hangs
 * loses its tasks to the expiry job soon.
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
 * `leaseMs`, as a hung run's do.
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
	 * does not renew, once this keeper's renewal still on its way is).
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
	/** This keeper's renewal on its way, if any: `stop` waits for it (see there). */
	let inflight: Promise<void> | null = null;
	const touch = async (): Promise<void> => {
		if (stopped || !enabled()) return;
		const at = clock();
		const failed = failing.get(narratorId);
		if (failed && at < failed.retryAt) return;
		const last = lastRenewal.get(narratorId);
		if (!failed && last !== undefined && at - last < OUTLINE_TASK_LEASE.renewEveryMs) {
			await inflight;
			return;
		}
		lastRenewal.set(narratorId, at);
		const renewal = renew(at, failed);
		inflight = renewal;
		await renewal;
		if (inflight === renewal) inflight = null;
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
			// A renewal still on its way (fired without waiting, at the last tool boundary) would
			// land after the idle lease and cut it back to the running one: it goes first.
			await inflight;
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
