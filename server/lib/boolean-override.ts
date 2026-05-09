export const BOOLEAN_OVERRIDE_VALUES = ["inherit", "on", "off"] as const;

export type BooleanOverride = (typeof BOOLEAN_OVERRIDE_VALUES)[number];

const BOOLEAN_OVERRIDE_SET = new Set<string>(BOOLEAN_OVERRIDE_VALUES);

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
