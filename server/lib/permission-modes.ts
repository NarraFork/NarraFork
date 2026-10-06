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

/**
 * 全部允许（bypassPermissions）下忽略用户的宽松规划默认值，始终强制宽松规划，
 * 避免计划模式软拒绝/工具禁用导致无人值守路径被阻塞。
 */
export function forcesRelaxedPlan(permissionMode: string | null | undefined): boolean {
	return permissionMode === "bypassPermissions";
}

/** 运行时生效的宽松规划：全部允许时恒为 true，否则使用叙述者自身开关。 */
export function resolveEffectiveRelaxedPlan(
	permissionMode: string | null | undefined,
	relaxedPlan: boolean | null | undefined,
): boolean {
	return forcesRelaxedPlan(permissionMode) || !!relaxedPlan;
}

/**
 * 新建叙述者时的宽松规划初值。
 * - 全部允许：始终 true（忽略 default 与显式 false）
 * - 其余模式：显式值优先，否则回退全局默认
 */
export function resolveInitialRelaxedPlan(opts: {
	permissionMode: string | null | undefined;
	explicit?: boolean;
	defaultRelaxedPlan?: boolean;
}): boolean {
	if (forcesRelaxedPlan(opts.permissionMode)) return true;
	if (opts.explicit !== undefined) return opts.explicit;
	return !!opts.defaultRelaxedPlan;
}
