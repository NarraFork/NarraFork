/**
 * Telemetry of the old Dynamic Spec plugin commands converted in outline sessions (outline P2
 * PR 12a; PR 12 design §2.10): the public API marks each converted call in its audit record
 * (`compat: "outline"`), and this module logs a warning at most once an hour per plugin and
 * command, with how many calls it stands for, so whoever runs the host sees which plugins still
 * need to move before the commands retire (one release after outline plan PR 13; plan §8.5).
 * Kept apart from the conversions so the public API can import it without the outline services.
 */
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";

/** The old commands and what replaces each. */
export const SPEC_COMPAT_REPLACEMENTS = {
	spec_tasks_get: "narrafork.narrator.tasks_read",
	spec_task_add: "narrafork.narrator.task_add",
	spec_write: "narrafork.narrator.task_add / task_set_status",
	spec_behavior_fence_update: "narrafork.narrator.behavior_rules_set",
} as const;

export type SpecCompatCommand = keyof typeof SPEC_COMPAT_REPLACEMENTS;

export const SPEC_COMPAT_TELEMETRY = {
	/** One warning per plugin and command at most this often. */
	warnEveryMs: 60 * 60_000,
	/** Plugin and command pairs remembered; the least recently warned go first. */
	maxPairs: 1024,
} as const;

interface PairState {
	warnedAt: number;
	/** Calls since the last warning. */
	calls: number;
}

const pairs = hotSafe("narrafork.pluginSpecCompat.warnings", () => new Map<string, PairState>());

/**
 * Record one converted call. Logs a warning when the pair was not warned about within the hour
 * (returns true then), otherwise counts it for the next warning.
 */
export function noteSpecCompatCall(
	pluginId: string,
	command: SpecCompatCommand,
	now: number = Date.now(),
): boolean {
	const key = `${pluginId}\u0000${command}`;
	const state = pairs.get(key);
	if (state && now - state.warnedAt < SPEC_COMPAT_TELEMETRY.warnEveryMs) {
		state.calls++;
		return false;
	}
	logger.warn(
		"A plugin still uses a Dynamic Spec command; it was converted for an outline session",
		{
			pluginId,
			command: `narrafork.narrator.${command}`,
			replacement: SPEC_COMPAT_REPLACEMENTS[command],
			callsSinceLastWarning: (state?.calls ?? 0) + 1,
			retires: "one release after outline plan PR 13",
		},
	);
	pairs.delete(key);
	pairs.set(key, { warnedAt: now, calls: 0 });
	while (pairs.size > SPEC_COMPAT_TELEMETRY.maxPairs) {
		const oldest = pairs.keys().next().value;
		if (oldest === undefined) break;
		pairs.delete(oldest);
	}
	return true;
}

/** Forget every pair (tests). */
export function resetSpecCompatTelemetry(): void {
	pairs.clear();
}
