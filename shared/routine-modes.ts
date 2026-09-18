/**
 * Optional tool routine modes — the three-position switch behind "可选工具".
 *
 * A tool routine is no longer on/off. It has one of three modes:
 *
 *   - `manual`   — the tool stays out of the session's tool table. Only `/load <id>`
 *                  (or a panel's one-click load button) puts it there for that session.
 *   - `auto`     — reserved for the future toolsearch mechanism, where the model
 *                  retrieves and loads a tool on demand. **Not implemented yet**, so
 *                  it currently behaves exactly like `manual` (see `isPreloadedMode`).
 *   - `resident` — preloaded into every new session, which is what the old "on"
 *                  position meant.
 *
 * This module is a dependency-free leaf on purpose: both `routine-service` and
 * `narrator-session` resolve modes, and importing either from the other would
 * re-form a circular chain. Keeping the derivation pure also makes it testable
 * without a database or a settings file. It lives in `shared/` because the
 * frontend needs the same mode vocabulary for its three-position control.
 */

/** The three switch positions. */
export type ToolRoutineMode = "manual" | "auto" | "resident";

export const TOOL_ROUTINE_MODES: readonly ToolRoutineMode[] = ["manual", "auto", "resident"];

/** A project override may also say "no opinion, follow global". */
export type ToolRoutineModeOverride = ToolRoutineMode | "global";

/**
 * The stored shape, in both `settings.routines` and
 * `projects.chapterSettings.routines`.
 *
 * `toolModes` is the new authority; the two legacy lists are kept in sync by
 * `applyToolRoutineMode` so that older config files, the `NarraForkAdmin` tool
 * writing `enabledRoutines` directly, and any not-yet-updated client keep
 * resolving to the same state instead of silently disagreeing.
 */
export interface RoutineModeConfig {
	disabledRoutines?: string[];
	enabledRoutines?: string[];
	toolModes?: Record<string, string>;
}

/**
 * A config layer after a write: the three mode fields are guaranteed present.
 *
 * Spelled out so callers (and tests) can read `.toolModes` off the result without
 * a non-null assertion, while any extra keys on the input layer — such as a
 * project's `commands` — survive untouched.
 */
export type ResolvedRoutineModeConfig<T extends RoutineModeConfig> = Omit<
	T,
	"disabledRoutines" | "enabledRoutines" | "toolModes"
> & {
	disabledRoutines: string[];
	enabledRoutines: string[];
	toolModes: Record<string, string>;
};

/** Minimal view of a built-in routine needed to derive its mode. */
export interface ToolRoutineModeSubject {
	id: string;
	defaultEnabled?: boolean;
}

/** Parse an untrusted value into a mode, or null when it is not one. */
export function normalizeToolRoutineMode(raw: unknown): ToolRoutineMode | null {
	if (typeof raw !== "string") return null;
	return (TOOL_ROUTINE_MODES as readonly string[]).includes(raw) ? (raw as ToolRoutineMode) : null;
}

/** Parse an untrusted value into a mode or the explicit "follow global" marker. */
export function normalizeToolRoutineModeOverride(raw: unknown): ToolRoutineModeOverride | null {
	if (raw === "global") return "global";
	return normalizeToolRoutineMode(raw);
}

/**
 * The mode one config layer expresses for a routine, or null when that layer
 * says nothing about it.
 *
 * Legacy fields are read as an equivalent mode rather than ignored:
 *   - present in `enabledRoutines` → `resident` (that is what the old "on" did)
 *   - `defaultEnabled` and not in `disabledRoutines` → `resident`
 *   - present in `disabledRoutines` → `manual`
 *
 * A layer with none of the above returns null, which is what lets a project
 * layer mean "follow global" without needing a sentinel value.
 */
export function resolveToolRoutineModeInLayer(
	routine: ToolRoutineModeSubject,
	config: RoutineModeConfig | undefined,
): ToolRoutineMode | null {
	if (!config) return null;
	const explicit = normalizeToolRoutineMode(config.toolModes?.[routine.id]);
	if (explicit) return explicit;
	if (config.enabledRoutines?.includes(routine.id)) return "resident";
	if (config.disabledRoutines?.includes(routine.id)) return "manual";
	if (routine.defaultEnabled) return "resident";
	return null;
}

/**
 * The global mode for a routine. Unlike a project layer this never returns null:
 * a routine nobody has configured is `manual` unless it is `defaultEnabled`.
 */
export function resolveToolRoutineMode(
	routine: ToolRoutineModeSubject,
	config: RoutineModeConfig | undefined,
): ToolRoutineMode {
	return (
		resolveToolRoutineModeInLayer(routine, config) ??
		(routine.defaultEnabled ? "resident" : "manual")
	);
}

/** What a project layer explicitly says, or "global" when it says nothing. */
export function resolveProjectToolRoutineModeOverride(
	routine: ToolRoutineModeSubject,
	projectConfig: RoutineModeConfig | undefined,
): ToolRoutineModeOverride {
	if (!projectConfig) return "global";
	// `defaultEnabled` is a property of the routine, not of this layer, so it must
	// not be read as a project opinion — otherwise every default-on routine would
	// look permanently pinned at the project level and "follow global" would be
	// unreachable in the UI.
	const explicit = normalizeToolRoutineMode(projectConfig.toolModes?.[routine.id]);
	if (explicit) return explicit;
	if (projectConfig.enabledRoutines?.includes(routine.id)) return "resident";
	if (projectConfig.disabledRoutines?.includes(routine.id)) return "manual";
	return "global";
}

/** The mode that actually applies, and which layer decided it. */
export function resolveEffectiveToolRoutineMode(
	routine: ToolRoutineModeSubject,
	globalConfig: RoutineModeConfig | undefined,
	projectConfig?: RoutineModeConfig,
): { mode: ToolRoutineMode; source: "global" | "project" } {
	const override = resolveProjectToolRoutineModeOverride(routine, projectConfig);
	if (override !== "global") return { mode: override, source: "project" };
	return { mode: resolveToolRoutineMode(routine, globalConfig), source: "global" };
}

/**
 * Whether a mode preloads the tool into every new session.
 *
 * `auto` returns false: toolsearch does not exist yet, so an "auto" tool is
 * simply absent until something loads it, same as `manual`. When toolsearch
 * lands, this predicate and the load path are the two places to revisit — the
 * stored mode does not need to change, so users who pick `auto` today get the
 * new behaviour without reconfiguring anything.
 */
export function isPreloadedMode(mode: ToolRoutineMode): boolean {
	return mode === "resident";
}

/**
 * Write a mode into a config layer, keeping the legacy lists consistent.
 *
 * Returns a new object; the input is not mutated. `resident` maps onto the old
 * whitelist and `manual` onto the old blacklist, so a downgrade or an old reader
 * still sees the same on/off state. `auto` deliberately lands in neither list:
 * to a legacy reader it is "not enabled", which matches how it currently behaves.
 */
export function applyToolRoutineMode<T extends RoutineModeConfig>(
	config: T,
	routineId: string,
	mode: ToolRoutineMode,
): ResolvedRoutineModeConfig<T> {
	const toolModes = { ...(config.toolModes ?? {}) };
	toolModes[routineId] = mode;

	const enabled = (config.enabledRoutines ?? []).filter((id) => id !== routineId);
	const disabled = (config.disabledRoutines ?? []).filter((id) => id !== routineId);
	if (mode === "resident") {
		enabled.push(routineId);
	} else if (mode === "manual") {
		disabled.push(routineId);
	}

	return {
		...config,
		toolModes,
		enabledRoutines: enabled,
		disabledRoutines: disabled,
	};
}

/**
 * Drop any opinion about a routine from a config layer, so it follows the layer
 * above (used by a project's "follow global").
 */
export function clearToolRoutineMode<T extends RoutineModeConfig>(
	config: T,
	routineId: string,
): ResolvedRoutineModeConfig<T> {
	const toolModes = { ...(config.toolModes ?? {}) };
	delete toolModes[routineId];
	return {
		...config,
		toolModes,
		enabledRoutines: (config.enabledRoutines ?? []).filter((id) => id !== routineId),
		disabledRoutines: (config.disabledRoutines ?? []).filter((id) => id !== routineId),
	};
}
