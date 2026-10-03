import type { PendingPermission } from "@frontend/types/narrator";

const RULE_TYPES = new Set([
	"directoryWhitelist",
	"directoryBlacklist",
	"commandWhitelist",
	"commandBlacklist",
]);

/** Display data only: authority remains with the frozen server proposal, never this renderer. */
export function permissionRuleRequestView(permission: PendingPermission) {
	if (permission.toolName !== "RequestPermissionRule") return null;
	const input = permission.inputJson as Record<string, unknown> | undefined;
	if (!input || typeof input.ruleType !== "string" || !RULE_TYPES.has(input.ruleType)) return null;
	const text = (key: string) =>
		typeof input[key] === "string" ? (input[key] as string) : undefined;
	return {
		ruleType: input.ruleType,
		scope: "narrator" as const,
		narratorId: permission.ownerNarratorId ?? permission.subagentNarratorId ?? "",
		deviceId:
			permission.executionTarget?.deviceId ?? permission.executionDeviceId ?? text("device"),
		path: text("path"),
		pattern: text("pattern"),
		access: text("accessLevel") ?? text("denyLevel"),
		reason: text("reason")?.slice(0, 2000),
	};
}
