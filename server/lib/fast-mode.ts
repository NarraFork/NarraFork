import { type BooleanOverride, normalizeBooleanOverride } from "./boolean-override";

/**
 * Fast mode (priority service tier) resolution.
 *
 * `narrators.fastModeOverride` is the source of truth: "inherit" follows the
 * per-user `fastModeDefault` preference at request time, so changing that
 * preference immediately affects every narrator that never opted in or out
 * explicitly. "on"/"off" pin the session regardless of the default.
 *
 * The legacy `narrators.fastMode` boolean is only kept as a mirror of the
 * explicit override (see `legacyFastModeMirror`) for older readers of the same
 * database and for project-DB exports.
 */
export function resolveFastMode(override: unknown, userDefault: boolean): boolean {
	const normalized = normalizeBooleanOverride(override);
	if (normalized === "inherit") return userDefault;
	return normalized === "on";
}

/** Deprecated-column mirror: only an explicit "on" is recorded as enabled. */
export function legacyFastModeMirror(override: unknown): boolean {
	return normalizeBooleanOverride(override) === "on";
}

/** Coerce a legacy boolean `fastMode` input into the tri-state override. */
export function fastModeOverrideFromLegacyInput(
	override: BooleanOverride | undefined,
	legacy: boolean | undefined,
): BooleanOverride {
	if (override) return override;
	if (legacy === undefined) return "inherit";
	return legacy ? "on" : "off";
}

/**
 * Load database dependencies only when a preference is actually queried, so
 * importing this module (e.g. from a unit test of the pure resolvers above)
 * never opens a database connection.
 */
async function createUserPreferenceQueryDependencies() {
	const [{ eq }, { db }, { userPreferences }] = await Promise.all([
		import("drizzle-orm"),
		import("../db"),
		import("../db/schema"),
	]);
	return { db, eq, userPreferences };
}

let userPreferenceQueryDependencies:
	| ReturnType<typeof createUserPreferenceQueryDependencies>
	| undefined;

function loadUserPreferenceQueryDependencies() {
	userPreferenceQueryDependencies ??= createUserPreferenceQueryDependencies();
	return userPreferenceQueryDependencies;
}

/**
 * The user's "fast mode by default" preference. Null/unknown users (unattended
 * gateway paths) fall back to disabled.
 */
export async function getUserFastModeDefault(userId: string | null | undefined): Promise<boolean> {
	if (!userId) return false;
	const { db, eq, userPreferences } = await loadUserPreferenceQueryDependencies();
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
		columns: { fastModeDefault: true },
	});
	return pref?.fastModeDefault ?? false;
}

/** Resolve the effective fast mode for a narrator row + the acting user. */
export async function resolveFastModeForUser(
	override: unknown,
	userId: string | null | undefined,
): Promise<boolean> {
	const normalized = normalizeBooleanOverride(override);
	// Skip the preference lookup entirely when the session is pinned.
	if (normalized !== "inherit") return normalized === "on";
	return getUserFastModeDefault(userId);
}
