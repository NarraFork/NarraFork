import { z } from "zod";

export const PERMISSION_MODES = [
	"default",
	"acceptEdits",
	"bypassPermissions",
	"readOnly",
	"dontAsk",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const permissionModeSchema = z.enum(PERMISSION_MODES);

const PERMISSION_MODE_SET = new Set<string>(PERMISSION_MODES);
const LEGACY_PERMISSION_MODE_SET = new Set<string>(["allowByDefault", "denyByDefault", "plan"]);

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === "string" && PERMISSION_MODE_SET.has(value);
}

export function normalizeLegacyPermissionMode(
	value: unknown,
	fallback: PermissionMode = "default",
): PermissionMode {
	if (isPermissionMode(value)) return value;
	switch (value) {
		case "allowByDefault":
			return "acceptEdits";
		case "denyByDefault":
			return "dontAsk";
		case "plan":
			return "default";
		default:
			return fallback;
	}
}

/** Accepts current permission modes plus legacy wire values, rejecting unrelated strings. */
export const legacyPermissionModeSchema = z.preprocess((value) => {
	if (isPermissionMode(value) || LEGACY_PERMISSION_MODE_SET.has(String(value))) {
		return normalizeLegacyPermissionMode(value);
	}
	return value;
}, permissionModeSchema);

export function normalizeLegacyPlanPreviousPermissionMode(value: unknown): PermissionMode {
	return isPermissionMode(value) ? value : "default";
}

export function shouldMigrateLegacyPlanMode(value: unknown): boolean {
	return value === "plan";
}
