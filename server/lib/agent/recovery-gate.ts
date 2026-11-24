import type { PermissionHandlerOptions } from "./types";

/** Snapshot captured before prepareToolCallReexecution clears the permission row. */
export interface PersistedRecoveryGate {
	id: string;
	status: string;
	permissionDecidedAt?: string | null;
	permissionSuggestions?: unknown;
	permissionStartedAt?: string | null;
	executionStartedAt?: string | null;
}

export interface RecoveryReflection {
	type: "danger_reflection" | "plan_reflection" | "task_reflection";
	status: string;
	requestId?: string;
	startedAt?: string;
	[key: string]: unknown;
}

export function recoveryReflection(gate?: PersistedRecoveryGate): RecoveryReflection | undefined {
	if (!Array.isArray(gate?.permissionSuggestions)) return undefined;
	return gate.permissionSuggestions.find(
		(value): value is RecoveryReflection =>
			value != null &&
			typeof value === "object" &&
			["danger_reflection", "plan_reflection", "task_reflection"].includes(value.type) &&
			typeof value.status === "string",
	);
}

export function isRecoveredHumanPermission(gate?: PersistedRecoveryGate): boolean {
	if (!gate || gate.executionStartedAt || gate.permissionDecidedAt) return false;
	if (
		Array.isArray(gate.permissionSuggestions) &&
		gate.permissionSuggestions.some(
			(value) =>
				value?.type === "permission_rule_request" && value.purpose === "permissionRuleRequest",
		)
	)
		return false;
	const reflection = recoveryReflection(gate);
	return reflection
		? reflection.type === "plan_reflection" && reflection.status === "awaiting_user"
		: gate.status === "pending";
}

// Keep restart-only metadata out of the wire/tool input and the public AgentConfig.
const permissionRecovery = new WeakMap<PermissionHandlerOptions, PersistedRecoveryGate>();
export function bindPermissionRecovery(
	options: PermissionHandlerOptions,
	gate: PersistedRecoveryGate,
): void {
	permissionRecovery.set(options, gate);
}
export function getPermissionRecovery(
	options?: PermissionHandlerOptions,
): PersistedRecoveryGate | undefined {
	return options ? permissionRecovery.get(options) : undefined;
}
