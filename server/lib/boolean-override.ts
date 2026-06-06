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

const BOOLEAN_OVERRIDE_SET = new Set<string>(BOOLEAN_OVERRIDE_VALUES);
const DANGER_REFLECTION_LEVEL_SET = new Set<string>(DANGER_REFLECTION_LEVEL_VALUES);
const DANGER_REFLECTION_OVERRIDE_SET = new Set<string>(DANGER_REFLECTION_OVERRIDE_VALUES);

export function normalizeBooleanOverride(value: unknown): BooleanOverride {
	return typeof value === "string" && BOOLEAN_OVERRIDE_SET.has(value)
		? (value as BooleanOverride)
		: "inherit";
}

export function resolveBooleanOverride(value: unknown, globalDefault: boolean): boolean {
	const override = normalizeBooleanOverride(value);
	if (override === "inherit") return globalDefault;
	return override === "on";
}

export function normalizeDangerReflectionLevel(
	value: unknown,
	legacyEnabled = true,
): DangerReflectionLevel {
	if (typeof value === "string" && DANGER_REFLECTION_LEVEL_SET.has(value)) {
		return value as DangerReflectionLevel;
	}
	return legacyEnabled ? "standard" : "off";
}

export function normalizeDangerReflectionOverride(value: unknown): DangerReflectionOverride {
	return typeof value === "string" && DANGER_REFLECTION_OVERRIDE_SET.has(value)
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
