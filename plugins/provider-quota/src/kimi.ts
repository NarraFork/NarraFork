import { boundedJson, isoTimestamp, type QuotaData, type QuotaWindow, record } from "./protocol";

export interface KimiUsageWindow {
	used: number | null;
	limit: number | null;
	remaining: number | null;
	resetTime: string | null;
}
export interface KimiUsagePayload {
	fiveHour: KimiUsageWindow | null;
	weekly: KimiUsageWindow | null;
	monthly: KimiUsageWindow | null;
	extraWindows: Array<{ label: string } & KimiUsageWindow>;
}
export const KIMI_USAGES_PATH = "/coding/v1/usages";
export const KIMI_CLI_USER_AGENT = "KimiCLI/1.6";

export function isKimiCustomApiProvider(config: { baseUrl?: string; disabled?: boolean }): boolean {
	if (config.disabled || !config.baseUrl) return false;
	try {
		const host = new URL(config.baseUrl).hostname.toLowerCase();
		return (
			host === "kimi.com" ||
			host === "kimi.ai" ||
			host.endsWith(".kimi.com") ||
			host.endsWith(".kimi.ai")
		);
	} catch {
		return false;
	}
}
function normalizeNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}
function normalizeResetTime(value: unknown): string | null {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
		const ms = Date.now() + value * 1000;
		return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
	}
	return null;
}
function normalizeWindow(value: unknown): KimiUsageWindow | null {
	if (!record(value)) return null;
	const used = normalizeNumber(value.used);
	const limit = normalizeNumber(value.limit);
	const remaining = normalizeNumber(value.remaining ?? value.left);
	const resetTime = normalizeResetTime(value.resetTime ?? value.reset_time ?? value.reset_in);
	if (used == null && limit == null && remaining == null && resetTime == null) return null;
	return { used, limit, remaining, resetTime };
}
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const MINUTES_PER_MONTH = 30 * MINUTES_PER_DAY;
function windowDurationMinutes(value: unknown): number | null {
	if (!record(value)) return null;
	const duration = normalizeNumber(value.duration);
	if (duration == null || duration <= 0) return null;
	let multiplier: number;
	switch (String(value.timeUnit ?? "").toUpperCase()) {
		case "TIME_UNIT_MINUTE":
			multiplier = 1;
			break;
		case "TIME_UNIT_HOUR":
			multiplier = MINUTES_PER_HOUR;
			break;
		case "TIME_UNIT_DAY":
			multiplier = MINUTES_PER_DAY;
			break;
		case "TIME_UNIT_WEEK":
			multiplier = MINUTES_PER_WEEK;
			break;
		case "TIME_UNIT_MONTH":
			multiplier = MINUTES_PER_MONTH;
			break;
		default:
			return null;
	}
	const minutes = duration * multiplier;
	return Number.isFinite(minutes) ? minutes : null;
}
function formatWindowLabel(minutes: number): string {
	if (minutes % MINUTES_PER_MONTH === 0) return `${minutes / MINUTES_PER_MONTH}mo`;
	if (minutes % MINUTES_PER_WEEK === 0) return `${minutes / MINUTES_PER_WEEK}w`;
	if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}d`;
	if (minutes % MINUTES_PER_HOUR === 0) return `${minutes / MINUTES_PER_HOUR}h`;
	return `${minutes}min`;
}
function classifyWindowMinutes(minutes: number): "fiveHour" | "weekly" | "monthly" | null {
	if (minutes === 5 * MINUTES_PER_HOUR) return "fiveHour";
	if (minutes === MINUTES_PER_WEEK) return "weekly";
	if (minutes >= 28 * MINUTES_PER_DAY && minutes <= 31 * MINUTES_PER_DAY) return "monthly";
	return null;
}
function emptyPayload(): KimiUsagePayload {
	return { fiveHour: null, weekly: null, monthly: null, extraWindows: [] };
}
function parseWindowedShape(body: Record<string, unknown>, payload: KimiUsagePayload): boolean {
	let matched = false;
	if (Array.isArray(body.limits)) {
		for (const entry of body.limits) {
			if (!record(entry)) continue;
			const window = normalizeWindow(entry.detail ?? entry.usage ?? entry);
			if (!window) continue;
			matched = true;
			const minutes = windowDurationMinutes(entry.window);
			const bucket = minutes == null ? null : classifyWindowMinutes(minutes);
			if (bucket === "fiveHour" && !payload.fiveHour) payload.fiveHour = window;
			else if (bucket === "weekly" && !payload.weekly) payload.weekly = window;
			else if (bucket === "monthly" && !payload.monthly) payload.monthly = window;
			else
				payload.extraWindows.push({
					label: minutes == null ? "?" : formatWindowLabel(minutes),
					...window,
				});
		}
	}
	const usage = normalizeWindow(body.usage);
	if (usage) {
		matched = true;
		if (!payload.weekly) payload.weekly = usage;
	}
	return matched;
}
function parseDataListShape(body: Record<string, unknown>, payload: KimiUsagePayload): boolean {
	if (!Array.isArray(body.data)) return false;
	let matched = false;
	for (const entry of body.data) {
		if (!record(entry)) continue;
		const window = normalizeWindow(entry);
		if (!window) continue;
		matched = true;
		const name = String(entry.model_name ?? entry.modelName ?? "")
			.trim()
			.toLowerCase();
		if (name === "all") {
			if (!payload.weekly) payload.weekly = window;
		} else if (/5\s*h|five/.test(name)) {
			if (!payload.fiveHour) payload.fiveHour = window;
			else payload.extraWindows.push({ label: name, ...window });
		} else if (/week|周/.test(name)) {
			if (!payload.weekly) payload.weekly = window;
			else payload.extraWindows.push({ label: name, ...window });
		} else if (/month|月/.test(name)) {
			if (!payload.monthly) payload.monthly = window;
			else payload.extraWindows.push({ label: name, ...window });
		} else payload.extraWindows.push({ label: name || "?", ...window });
	}
	return matched;
}
export function parseKimiUsagesResponse(body: unknown): KimiUsagePayload {
	const payload = emptyPayload();
	if (!record(body) || !boundedJson(body)) return payload;
	if (!parseWindowedShape(body, payload)) parseDataListShape(body, payload);
	return payload;
}

export function kimiQuotaData(payload: KimiUsagePayload): QuotaData | null {
	const windows: QuotaWindow[] = [];
	function add(id: string, value: KimiUsageWindow | null, label?: string) {
		if (!value) return;
		const resetAt = isoTimestamp(value.resetTime);
		if (value.used === null && value.limit === null && value.remaining === null && resetAt === null)
			return;
		windows.push({
			id,
			...(label ? { label } : {}),
			used: value.used,
			limit: value.limit,
			remaining: value.remaining,
			resetAt,
			...(id === "fiveHour"
				? { durationMs: 5 * 3_600_000 }
				: id === "weekly"
					? { durationMs: 7 * 86_400_000 }
					: {}),
		});
	}
	add("fiveHour", payload.fiveHour);
	add("weekly", payload.weekly);
	add("monthly", payload.monthly);
	for (const [index, window] of payload.extraWindows.entries())
		add(`extra:${index}`, window, window.label);
	return windows.length && windows.length <= 32 ? { amounts: [], windows } : null;
}
