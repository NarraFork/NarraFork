/** Bounded invalidation notice, never a rule/proposal body or grant receipt. */
export interface PermissionPolicyChangedEvent {
	type: "permission:policy_changed";
	narratorId: string;
	ruleType: "directoryWhitelist" | "directoryBlacklist" | "commandWhitelist" | "commandBlacklist";
	ruleId: string;
	change: "created" | "updated" | "deleted";
	changedAt: string;
}
