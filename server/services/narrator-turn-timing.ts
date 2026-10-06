export const TURN_PAUSED_MS_PREFIX = "turn_paused_ms:";
export const TURN_PAUSE_STARTED_MS_PREFIX = "turn_pause_started_ms:";

const RECOVERABLE_TURN_SUBSTATUSES = new Set(["error", "interrupted", "payment_required"]);

export interface TurnPauseTiming {
	pausedMs: number;
	pauseStartedAtMs: number | null;
}

function parseTimingTag(tag: string, prefix: string): number | null {
	if (!tag.startsWith(prefix)) return null;
	const value = Number(tag.slice(prefix.length));
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export function isTurnTimingSubstatus(tag: string): boolean {
	return tag.startsWith(TURN_PAUSED_MS_PREFIX) || tag.startsWith(TURN_PAUSE_STARTED_MS_PREFIX);
}

export function parseTurnPauseTiming(
	substatus: readonly string[] | null | undefined,
): TurnPauseTiming {
	let pausedMs = 0;
	let pauseStartedAtMs: number | null = null;
	for (const tag of substatus ?? []) {
		const paused = parseTimingTag(tag, TURN_PAUSED_MS_PREFIX);
		if (paused != null) pausedMs = Math.max(pausedMs, paused);
		const pauseStarted = parseTimingTag(tag, TURN_PAUSE_STARTED_MS_PREFIX);
		if (pauseStarted != null) {
			pauseStartedAtMs =
				pauseStartedAtMs == null ? pauseStarted : Math.min(pauseStartedAtMs, pauseStarted);
		}
	}
	return { pausedMs, pauseStartedAtMs };
}

export function hasRecoverableTurnSubstatus(substatus: readonly string[]): boolean {
	return substatus.some((tag) => RECOVERABLE_TURN_SUBSTATUSES.has(tag));
}

function withTurnPauseTiming(substatus: readonly string[], timing: TurnPauseTiming): string[] {
	const next = substatus.filter((tag) => !isTurnTimingSubstatus(tag));
	if (timing.pausedMs > 0) next.push(`${TURN_PAUSED_MS_PREFIX}${Math.floor(timing.pausedMs)}`);
	if (timing.pauseStartedAtMs != null) {
		next.push(`${TURN_PAUSE_STARTED_MS_PREFIX}${Math.floor(timing.pauseStartedAtMs)}`);
	}
	return next;
}

export function preserveTurnTimingSubstatus(
	current: readonly string[],
	next: readonly string[],
): string[] {
	return withTurnPauseTiming(next, parseTurnPauseTiming(current));
}

export function transitionTurnTimingSubstatus(
	current: readonly string[],
	next: readonly string[],
	options: {
		status: "idle" | "working" | "waiting" | "archived";
		nowMs: number;
		setTurnStart?: boolean;
		resumeTurn?: boolean;
		fallbackPauseStartedAtMs?: number | null;
	},
): string[] {
	const visibleNext = next.filter((tag) => !isTurnTimingSubstatus(tag));
	if (options.setTurnStart) return visibleNext;

	const timing = parseTurnPauseTiming(current);
	if (hasRecoverableTurnSubstatus(visibleNext) && timing.pauseStartedAtMs == null) {
		timing.pauseStartedAtMs = options.nowMs;
	}

	if (options.status === "working") {
		let pauseStartedAtMs = timing.pauseStartedAtMs;
		if (pauseStartedAtMs == null && options.resumeTurn && hasRecoverableTurnSubstatus(current)) {
			const fallback = options.fallbackPauseStartedAtMs;
			pauseStartedAtMs = fallback != null && Number.isFinite(fallback) ? fallback : options.nowMs;
		}
		if (pauseStartedAtMs != null) {
			timing.pausedMs += Math.max(0, options.nowMs - pauseStartedAtMs);
			timing.pauseStartedAtMs = null;
		}
	}

	return withTurnPauseTiming(visibleNext, timing);
}

export function resolveContinueTurnTiming(options: {
	substatus: readonly string[];
	turnStartedAt?: string | null;
	nowMs: number;
}): { preserveTurnStart: boolean; turnStartedAt: string } {
	const timing = parseTurnPauseTiming(options.substatus);
	const preserveTurnStart =
		hasRecoverableTurnSubstatus(options.substatus) || timing.pauseStartedAtMs != null;
	const parsedTurnStartedAt = options.turnStartedAt
		? new Date(options.turnStartedAt).getTime()
		: Number.NaN;
	return {
		preserveTurnStart,
		turnStartedAt:
			preserveTurnStart && Number.isFinite(parsedTurnStartedAt)
				? (options.turnStartedAt as string)
				: new Date(options.nowMs).toISOString(),
	};
}
