/**
 * Format a date string as a compact relative time, e.g. "<1m", "5m", "3h", "2d".
 */
export function formatRelativeTime(dateStr: string): string {
	const ts = new Date(dateStr).getTime();
	if (Number.isNaN(ts)) return "";
	const diff = Date.now() - ts;
	if (diff < 0) return "<1m";
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return "<1m";
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

/**
 * Strip a base directory prefix from an absolute file path to produce a
 * project-relative display path.  If the path doesn't start with `basePath`,
 * it is returned unchanged.
 *
 * Example: toRelativePath("/home/u/proj/src/a.ts", "/home/u/proj") → "src/a.ts"
 */
export function toRelativePath(filePath: string, basePath: string | null | undefined): string {
	if (!basePath) return filePath;
	const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
	if (filePath.startsWith(base)) return filePath.slice(base.length);
	return filePath;
}

/**
 * Format a date string as relative time when within 24h,
 * or as a concrete date+time (YYYY-MM-DD HH:mm) when older.
 */
export function formatSmartTime(dateStr: string): string {
	const d = new Date(dateStr);
	const ts = d.getTime();
	if (Number.isNaN(ts)) return "";
	const diff = Date.now() - ts;
	if (diff < 0) return "<1m";
	if (diff < 86400000) return formatRelativeTime(dateStr);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type DurationTextStyle = "timer" | "precise" | "timeout";

export interface FormatDurationTextOptions {
	/**
	 * timer: whole-second h/m/s text for right-side live timers and completed durations.
	 * precise: preserves ms/sub-minute precision for timing breakdowns, then h/m/s.
	 * timeout: compact timeout text for "elapsed / timeout" labels.
	 */
	style?: DurationTextStyle;
	fallback?: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const TURN_PAUSED_MS_PREFIX = "turn_paused_ms:";
const TURN_PAUSE_STARTED_MS_PREFIX = "turn_pause_started_ms:";

export interface TurnPauseTiming {
	pausedMs: number;
	pauseStartedAtMs: number | null;
}

function parseNonNegativeTimingTag(tag: string, prefix: string): number | null {
	if (!tag.startsWith(prefix)) return null;
	const value = Number(tag.slice(prefix.length));
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** Parse the internal per-turn pause timing tags stored in narrator substatus. */
export function parseTurnPauseTiming(
	substatus: readonly string[] | null | undefined,
): TurnPauseTiming {
	let pausedMs = 0;
	let pauseStartedAtMs: number | null = null;
	for (const tag of substatus ?? []) {
		const paused = parseNonNegativeTimingTag(tag, TURN_PAUSED_MS_PREFIX);
		if (paused != null) pausedMs = Math.max(pausedMs, paused);
		const pauseStarted = parseNonNegativeTimingTag(tag, TURN_PAUSE_STARTED_MS_PREFIX);
		if (pauseStarted != null) {
			pauseStartedAtMs =
				pauseStartedAtMs == null ? pauseStarted : Math.min(pauseStartedAtMs, pauseStarted);
		}
	}
	return { pausedMs, pauseStartedAtMs };
}

function toTimestamp(value: Date | string | number | null | undefined): number | null {
	if (value == null) return null;
	const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isFinite(timestamp) ? timestamp : null;
}

/** Calculate active turn time, excluding completed pauses and freezing at an active pause. */
export function calculateEffectiveTurnElapsedMs(options: {
	turnStartedAt: Date | string | number | null | undefined;
	endAt?: Date | string | number | null;
	nowMs?: number;
	substatus?: readonly string[] | null;
}): number | null {
	const startMs = toTimestamp(options.turnStartedAt);
	if (startMs == null) return null;
	const nowMs = Number.isFinite(options.nowMs) ? (options.nowMs as number) : Date.now();
	const requestedEndMs = toTimestamp(options.endAt) ?? nowMs;
	const timing = parseTurnPauseTiming(options.substatus);
	const endMs =
		timing.pauseStartedAtMs == null
			? requestedEndMs
			: Math.min(requestedEndMs, timing.pauseStartedAtMs);
	return Math.max(0, endMs - startMs - timing.pausedMs);
}

/** Format whole seconds as M:SS, H:MM:SS, or D:HH:MM:SS. */
export function formatColonDuration(totalSeconds: number | null | undefined): string {
	const safeSeconds =
		totalSeconds != null && Number.isFinite(totalSeconds)
			? Math.max(0, Math.floor(totalSeconds))
			: 0;
	const days = Math.floor(safeSeconds / 86_400);
	const hours = Math.floor((safeSeconds % 86_400) / 3_600);
	const minutes = Math.floor((safeSeconds % 3_600) / 60);
	const seconds = safeSeconds % 60;
	if (days > 0) return `${days}:${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
	if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
	return `${minutes}:${pad2(seconds)}`;
}

/**
 * Format a duration for tool-call timing UI.
 *
 * Examples: 950ms (precise), 12.3s (precise), 1m02s, 1h02m03s.
 */
export function formatDurationText(
	durationMs: number | null | undefined,
	options: FormatDurationTextOptions = {},
): string {
	if (durationMs == null || !Number.isFinite(durationMs)) return options.fallback ?? "";

	const ms = Math.max(0, durationMs);
	const style = options.style ?? "timer";

	if (style === "timeout") {
		if (ms >= 3_600_000) {
			const hours = Math.floor(ms / 3_600_000);
			const minutes = Math.round((ms % 3_600_000) / 60_000);
			return minutes > 0 ? `${hours}h${pad2(minutes)}m` : `${hours}h`;
		}
		if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
		return `${Math.round(ms / 1000)}s`;
	}

	if (style === "precise") {
		if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
	}

	const totalSeconds = Math.max(
		0,
		style === "timer" ? Math.floor(ms / 1000) : Math.round(ms / 1000),
	);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `${hours}h${pad2(minutes)}m${pad2(seconds)}s`;
	if (minutes > 0) return `${minutes}m${pad2(seconds)}s`;
	return `${seconds}s`;
}
