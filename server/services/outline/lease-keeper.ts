/**
 * Keeping a running session's task leases alive (design §4.5, §7.2): a session that set a task in
 * progress holds it on a lease of {@link OUTLINE_TASK_LEASE.leaseMs}; while the session runs, its
 * leases are renewed every {@link OUTLINE_TASK_LEASE.renewEveryMs}, so only a session that stopped
 * (or stopped responding) loses its tasks to the expiry job.
 *
 * The agent runtime keeps one keeper per run (`agent-runtime/orchestrator.ts`): it renews when the
 * run starts, at each tool boundary and on a timer while a long tool call runs, never more often
 * than once per `renewEveryMs` for a session. A renewal is one indexed, bounded UPDATE of the
 * session's claims (nothing when it holds none), fired without waiting for it.
 */
import { logger } from "@server/lib/logger";
import { isOutlineEnabled } from "./feature";
import { OUTLINE_TASK_LEASE } from "./model";
import type { OutlineStore } from "./store/port";
import { renewOutlineTaskLeases } from "./tasks";

export interface OutlineLeaseKeeper {
	/** Renew now unless the session renewed within `renewEveryMs`; resolves when done. */
	touch(): Promise<void>;
	/** Stop renewing (the run ended); its leases then run out unless another run renews them. */
	stop(): void;
}

/** When each session last renewed (ms), shared by its runs. */
const lastRenewal = new Map<string, number>();
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
	let stopped = false;
	const touch = async (): Promise<void> => {
		if (stopped || !enabled()) return;
		const at = clock();
		const last = lastRenewal.get(narratorId);
		if (last !== undefined && at - last < OUTLINE_TASK_LEASE.renewEveryMs) return;
		lastRenewal.set(narratorId, at);
		try {
			await renewOutlineTaskLeases(narratorId, {
				now: new Date(at),
				...(options.store ? { store: options.store } : {}),
			});
		} catch (error) {
			// Try again at the next boundary rather than waiting out the interval.
			lastRenewal.delete(narratorId);
			logger.warn("Outline task leases could not be renewed", {
				narratorId,
				error: String(error),
			});
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
		stop() {
			if (stopped) return;
			stopped = true;
			if (timer) clearInterval(timer);
			const left = (running.get(narratorId) ?? 1) - 1;
			if (left > 0) running.set(narratorId, left);
			else {
				running.delete(narratorId);
				lastRenewal.delete(narratorId);
			}
		},
	};
}

/** How many keepers are running for a session (tests, diagnostics). */
export function outlineLeaseKeepersOf(narratorId: string): number {
	return running.get(narratorId) ?? 0;
}
