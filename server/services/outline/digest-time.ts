/**
 * Days in a person's time zone, for the reports (汇报, outline P2 PR 11, owner decision Q2 = B).
 *
 * A person's day is midnight to midnight in their IANA time zone; the report of a day is made at
 * their chosen time of day on the next day. Both default (null in `user_preferences`) to the
 * server's time zone and {@link OUTLINE_DIGEST_DEFAULT_TIME}.
 *
 * Wall times are turned into instants with `Intl` alone (no tables of our own), and every day is
 * cut by the same function, so day D ends exactly where day D+1 starts, whatever the clocks do in
 * between:
 *   - a local time that happens twice (clocks going back) is its first occurrence;
 *   - one that does not exist (clocks going forward over it) moves forward by the gap: a day
 *     whose midnight is skipped (clocks jumping from 00:00 to 01:00) starts at the jump.
 * A day is therefore 23 or 25 hours long around a change of daylight saving time.
 */
import { OUTLINE_DIGEST_DEFAULT_TIME, OUTLINE_DIGEST_TIME_PATTERN } from "@shared/outline-digest";

const DAY_MS = 86_400_000;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
	let found = formatters.get(timeZone);
	if (!found) {
		found = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(timeZone, found);
	}
	return found;
}

interface Wall {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function wallOf(ms: number, timeZone: string): Wall {
	const out: Record<string, number> = {};
	for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
		if (part.type !== "literal") out[part.type] = Number(part.value);
	}
	return {
		year: out.year as number,
		month: out.month as number,
		day: out.day as number,
		// Some engines write midnight as 24 even with h23.
		hour: (out.hour as number) % 24,
		minute: out.minute as number,
		second: out.second as number,
	};
}

/** Milliseconds the zone is ahead of UTC at the instant `ms`. */
function offsetAt(ms: number, timeZone: string): number {
	const w = wallOf(ms, timeZone);
	const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
	return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Whether `timeZone` names a time zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
	if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 64) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}

/** The runtime's name for a time zone (`asia/shanghai` → `Asia/Shanghai`); null when unknown. */
export function canonicalTimeZone(timeZone: string): string | null {
	if (!isValidTimeZone(timeZone)) return null;
	return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
}

/** The server's time zone: what a person's day is cut in until they choose one. */
export function serverTimeZone(): string {
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return zone && isValidTimeZone(zone) ? zone : "UTC";
}

/** `HH:MM` as minutes after midnight; the default time when absent or malformed. */
export function digestTimeMinutes(time: string | null | undefined): number {
	const value = time && OUTLINE_DIGEST_TIME_PATTERN.test(time) ? time : OUTLINE_DIGEST_DEFAULT_TIME;
	const [hours, minutes] = value.split(":").map(Number) as [number, number];
	return hours * 60 + minutes;
}

function parseKey(key: string): { year: number; month: number; day: number } {
	const m = DATE_KEY.exec(key);
	if (!m) throw new Error(`not a day: ${key}`);
	return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function keyOf(year: number, month: number, day: number): string {
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The day `n` days after `key` (calendar arithmetic, no time zone involved). */
export function addDays(key: string, n: number): string {
	const { year, month, day } = parseKey(key);
	const d = new Date(Date.UTC(year, month - 1, day + n));
	return keyOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** The day (`YYYY-MM-DD`) it is at the instant `ms` in the zone. */
export function localDayOf(ms: number, timeZone: string): string {
	const w = wallOf(ms, timeZone);
	return keyOf(w.year, w.month, w.day);
}

/**
 * The instant the wall time `minutes` after midnight of day `key` happens in the zone: its first
 * occurrence, or, when the clocks skip it, the same wall time read with the offset before the jump
 * (so it lands just past the gap).
 */
export function wallTimeInstant(key: string, minutes: number, timeZone: string): number {
	const { year, month, day } = parseKey(key);
	const wall = Date.UTC(year, month - 1, day, 0, minutes);
	// Offsets around the target: one of them holds on each side of a transition near it.
	const candidates = [
		...new Set([
			wall - offsetAt(wall - DAY_MS, timeZone),
			wall - offsetAt(wall, timeZone),
			wall - offsetAt(wall + DAY_MS, timeZone),
		]),
	].sort((a, b) => a - b);
	const wallMs = (ms: number) => {
		const w = wallOf(ms, timeZone);
		return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
	};
	const exact = candidates.find((u) => wallMs(u) === wall);
	if (exact !== undefined) return exact;
	// A wall time the clocks skip: the first candidate past it is the transition itself.
	return candidates.find((u) => wallMs(u) > wall) ?? (candidates[candidates.length - 1] as number);
}

/** Day `key` in the zone: `[start, end)`, end being the next day's start. */
export function dayWindow(key: string, timeZone: string): { start: number; end: number } {
	return {
		start: wallTimeInstant(key, 0, timeZone),
		end: wallTimeInstant(addDays(key, 1), 0, timeZone),
	};
}

/**
 * The latest day whose report is due at `now`: yesterday once today's report time has passed,
 * the day before otherwise.
 */
export function latestDueDay(now: number, timeZone: string, time: string | null): string {
	const today = localDayOf(now, timeZone);
	const due = wallTimeInstant(today, digestTimeMinutes(time), timeZone);
	return addDays(today, now >= due ? -1 : -2);
}
