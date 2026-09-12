// Shared reflection/override value types + helpers used by the interaction
// StatusBar controls (plan-reflection auto-approve, danger-reflection level) and
// by NarratorPanel's derived-value logic. Kept JSX-free so it can live in a `.ts`
// module both sides import from, instead of being duplicated inline.

export const BOOLEAN_OVERRIDE_VALUES = ["inherit", "on", "off"] as const;
export type BooleanOverride = (typeof BOOLEAN_OVERRIDE_VALUES)[number];

export const DANGER_REFLECTION_LEVEL_VALUES = ["off", "light", "standard", "strict"] as const;
export type DangerReflectionLevel = (typeof DANGER_REFLECTION_LEVEL_VALUES)[number];

export const DANGER_REFLECTION_OVERRIDE_VALUES = [
	"inherit",
	"on",
	...DANGER_REFLECTION_LEVEL_VALUES,
] as const;
export type DangerReflectionOverride = (typeof DANGER_REFLECTION_OVERRIDE_VALUES)[number];

export function normalizeBooleanOverride(value: unknown): BooleanOverride {
	return BOOLEAN_OVERRIDE_VALUES.includes(value as BooleanOverride)
		? (value as BooleanOverride)
		: "inherit";
}

export function normalizeDangerReflectionLevel(
	value: unknown,
	legacyEnabled = true,
): DangerReflectionLevel {
	return DANGER_REFLECTION_LEVEL_VALUES.includes(value as DangerReflectionLevel)
		? (value as DangerReflectionLevel)
		: legacyEnabled
			? "standard"
			: "off";
}

export function normalizeDangerReflectionOverride(value: unknown): DangerReflectionOverride {
	return DANGER_REFLECTION_OVERRIDE_VALUES.includes(value as DangerReflectionOverride)
		? (value as DangerReflectionOverride)
		: "inherit";
}

export function resolveDangerReflectionLevel(
	override: unknown,
	globalLevel: DangerReflectionLevel,
): DangerReflectionLevel {
	const normalizedOverride = normalizeDangerReflectionOverride(override);
	if (normalizedOverride === "inherit") return globalLevel;
	if (normalizedOverride === "on") return globalLevel === "off" ? "standard" : globalLevel;
	return normalizedOverride;
}

export function formatDangerReflectionLevel(
	level: DangerReflectionLevel,
	t: (key: string) => string,
): string {
	return t(`dangerReflectionLevel_${level}`);
}

export function resolveBooleanOverride(value: unknown, globalDefault: boolean): boolean {
	const override = normalizeBooleanOverride(value);
	if (override === "inherit") return globalDefault;
	return override === "on";
}
