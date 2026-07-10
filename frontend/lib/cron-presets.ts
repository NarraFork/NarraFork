/**
 * Friendly cron preset helpers. The backend always stores a raw cron expression;
 * these helpers let the UI offer beginner-friendly presets that compile to cron,
 * and reverse-parse a stored cron back into a preset when possible.
 */

export type CronPresetKind = "everyNMinutes" | "hourly" | "daily" | "weekly" | "custom";

export interface CronPresetState {
	kind: CronPresetKind;
	/** everyNMinutes */
	minutes: number;
	/** hourly: minute of the hour (0-59) */
	hourlyMinute: number;
	/** daily / weekly: hour (0-23) + minute (0-59) */
	hour: number;
	minute: number;
	/** weekly: day of week 0-6 (0 = Sunday) */
	weekday: number;
	/** custom raw expression */
	custom: string;
}

export const DEFAULT_CRON_PRESET: CronPresetState = {
	kind: "daily",
	minutes: 30,
	hourlyMinute: 0,
	hour: 9,
	minute: 0,
	weekday: 1,
	custom: "0 9 * * *",
};

/** Compile a preset state into a 5-field cron expression. */
export function presetToCron(state: CronPresetState): string {
	switch (state.kind) {
		case "everyNMinutes": {
			const n = Math.min(Math.max(Math.round(state.minutes), 1), 59);
			return `*/${n} * * * *`;
		}
		case "hourly":
			return `${clamp(state.hourlyMinute, 0, 59)} * * * *`;
		case "daily":
			return `${clamp(state.minute, 0, 59)} ${clamp(state.hour, 0, 23)} * * *`;
		case "weekly":
			return `${clamp(state.minute, 0, 59)} ${clamp(state.hour, 0, 23)} * * ${clamp(state.weekday, 0, 6)}`;
		default:
			return state.custom.trim();
	}
}

function clamp(n: number, min: number, max: number): number {
	if (Number.isNaN(n)) return min;
	return Math.min(Math.max(Math.round(n), min), max);
}

/**
 * Best-effort reverse parse of a stored cron into a preset state. Falls back to
 * "custom" for anything that doesn't match a known preset shape.
 */
export function cronToPreset(cron: string): CronPresetState {
	const base = { ...DEFAULT_CRON_PRESET, custom: cron };
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return { ...base, kind: "custom" };
	const [min, hr, dom, mon, dow] = parts;

	// every N minutes: "*/N * * * *"
	const everyN = /^\*\/(\d+)$/.exec(min);
	if (everyN && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
		return { ...base, kind: "everyNMinutes", minutes: Number(everyN[1]) };
	}
	// hourly: "M * * * *"
	if (/^\d+$/.test(min) && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
		return { ...base, kind: "hourly", hourlyMinute: Number(min) };
	}
	// daily: "M H * * *"
	if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === "*" && mon === "*" && dow === "*") {
		return { ...base, kind: "daily", hour: Number(hr), minute: Number(min) };
	}
	// weekly: "M H * * D"
	if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === "*" && mon === "*" && /^\d+$/.test(dow)) {
		return { ...base, kind: "weekly", hour: Number(hr), minute: Number(min), weekday: Number(dow) };
	}
	return { ...base, kind: "custom" };
}
