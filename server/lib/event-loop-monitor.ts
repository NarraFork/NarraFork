import { hotTimer } from "./hot-safe";
import { logger } from "./logger";

/*
 * Event-loop lag monitor.
 *
 * Besides the snapshot for the admin page, every late tick is kept as a stall interval so a slow
 * request can tell whether its time went to awaiting I/O/workers or to a blocked main thread.
 * A blocked main thread may be the request itself or anything else running at that moment; the
 * lag warning therefore lists the requests that could have caused the stall: nothing else can
 * start while the thread is blocked, so a request that started in the stall's second half was
 * served after it. A synchronous blocker has usually finished before the late tick fires,
 * so recently finished requests count too. An empty list points at non-HTTP work (timers,
 * narrator execution). Long-lived requests that were merely awaiting can still appear.
 */

export interface EventLoopLagSnapshot {
	currentLagMs: number;
	maxLagMs: number;
	lastLagAt: string | null;
	maxLagAt: string | null;
	sampleCount: number;
	startedAt: string | null;
}

interface EventLoopMonitorOptions {
	intervalMs?: number;
	warnThresholdMs?: number;
	warnThrottleMs?: number;
}

// Short enough that a stall's measured span is close to its real length.
const DEFAULT_INTERVAL_MS = 50;
const STALL_MIN_MS = 50;
const MAX_STALLS = 256;
const MAX_REQUESTS_LOGGED = 10;
const MAX_FINISHED = 64;
const DEFAULT_WARN_THRESHOLD_MS = 1_000;
const DEFAULT_WARN_THROTTLE_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let expectedAt = 0;
let lastWarnAt = 0;
let nextRequestId = 0;

/** Stall intervals on the `performance.now()` clock, oldest first. */
const stalls: Array<{ start: number; end: number }> = [];
const inFlight = new Map<number, { label: string; startedAt: number }>();
const finished: Array<{ label: string; startedAt: number; endedAt: number }> = [];

const state: EventLoopLagSnapshot = {
	currentLagMs: 0,
	maxLagMs: 0,
	lastLagAt: null,
	maxLagAt: null,
	sampleCount: 0,
	startedAt: null,
};

function roundMs(value: number): number {
	return Math.round(value * 100) / 100;
}

export function startEventLoopMonitor(options: EventLoopMonitorOptions = {}): void {
	if (timer) return;

	const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	const warnThresholdMs = options.warnThresholdMs ?? DEFAULT_WARN_THRESHOLD_MS;
	const warnThrottleMs = options.warnThrottleMs ?? DEFAULT_WARN_THROTTLE_MS;

	state.startedAt = new Date().toISOString();
	expectedAt = performance.now() + intervalMs;

	const onTick = () => {
		const now = performance.now();
		const lagMs = Math.max(0, now - expectedAt);
		const roundedLag = roundMs(lagMs);
		const lagAt = new Date().toISOString();

		if (lagMs >= STALL_MIN_MS) {
			stalls.push({ start: now - lagMs, end: now });
			if (stalls.length > MAX_STALLS) stalls.shift();
		}

		state.currentLagMs = roundedLag;
		state.lastLagAt = lagAt;
		state.sampleCount++;

		if (roundedLag > state.maxLagMs) {
			state.maxLagMs = roundedLag;
			state.maxLagAt = lagAt;
		}

		const wallNow = Date.now();
		if (roundedLag >= warnThresholdMs && wallNow - lastWarnAt >= warnThrottleMs) {
			lastWarnAt = wallNow;
			logger.warn("Event loop lag detected", {
				lagMs: roundedLag,
				maxLagMs: state.maxLagMs,
				thresholdMs: warnThresholdMs,
				requests: requestsDuring(now - lagMs, now),
			});
		}

		expectedAt = now + intervalMs;
	};
	// Replace the previous module generation's interval without changing normal start semantics.
	timer = hotTimer("narrafork.eventLoopMonitor.timer", () => setInterval(onTick, intervalMs));

	if (typeof timer === "object" && "unref" in timer) timer.unref();
}

export function getEventLoopLagSnapshot(): EventLoopLagSnapshot {
	return { ...state };
}

/** Requests that overlap the stall and started no later than its first half. */
function requestsDuring(start: number, now: number): string[] {
	const latestStart = start + (now - start) / 2;
	return [
		...finished.filter((request) => request.endedAt >= start),
		...[...inFlight.values()].map((request) => ({ ...request, endedAt: now })),
	]
		.filter((request) => request.startedAt <= latestStart)
		.slice(-MAX_REQUESTS_LOGGED)
		.map((request) => `${request.label} (${Math.round(request.endedAt - request.startedAt)}ms)`);
}

/** Register a request for lag warnings; call the returned function when it ends. */
export function trackInFlight(label: string): () => void {
	const id = nextRequestId++;
	const startedAt = performance.now();
	inFlight.set(id, { label, startedAt });
	return () => {
		inFlight.delete(id);
		finished.push({ label, startedAt, endedAt: performance.now() });
		if (finished.length > MAX_FINISHED) finished.shift();
	};
}

/**
 * How much of `[start, end]` (`performance.now()` clock) the main thread spent stalled.
 *
 * Includes a stall still in progress: a request that blocked the thread itself ends before the
 * overdue tick records it, so the time since the tick was due counts as stalled as well.
 */
export function stallTimeBetween(
	start: number,
	end: number,
): { stalledMs: number; maxStallMs: number } {
	let stalledMs = 0;
	let maxStallMs = 0;
	const pending = timer && end - expectedAt >= STALL_MIN_MS ? [{ start: expectedAt, end }] : [];
	for (const stall of [...stalls, ...pending]) {
		const overlap = Math.min(end, stall.end) - Math.max(start, stall.start);
		if (overlap <= 0) continue;
		stalledMs += overlap;
		maxStallMs = Math.max(maxStallMs, overlap);
	}
	return { stalledMs: roundMs(stalledMs), maxStallMs: roundMs(maxStallMs) };
}
