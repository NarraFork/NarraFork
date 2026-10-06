import { logger } from "./logger";

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

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_WARN_THRESHOLD_MS = 1_000;
const DEFAULT_WARN_THROTTLE_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let expectedAt = 0;
let lastWarnAt = 0;

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

	timer = setInterval(() => {
		const now = performance.now();
		const lagMs = Math.max(0, now - expectedAt);
		const roundedLag = roundMs(lagMs);
		const lagAt = new Date().toISOString();

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
			});
		}

		expectedAt = now + intervalMs;
	}, intervalMs);

	if (typeof timer === "object" && "unref" in timer) timer.unref();
}

export function getEventLoopLagSnapshot(): EventLoopLagSnapshot {
	return { ...state };
}
