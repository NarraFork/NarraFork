export interface AppliedPermissionRuleBase {
	id: string;
	enabled: true;
	selector: { kind: "host" } | { kind: "device"; deviceId: string };
	source: "narrator";
	createdAt?: string;
	updatedAt?: string;
}
export type AppliedPermissionRule = AppliedPermissionRuleBase &
	(
		| {
				ruleType: "directoryWhitelist";
				path: string;
				pathFlavor: "posix" | "windows";
				pathKey: string;
				accessLevel: "readOnly" | "readWrite" | "full";
		  }
		| {
				ruleType: "directoryBlacklist";
				path: string;
				pathFlavor: "posix" | "windows";
				pathKey: string;
				denyLevel: "denyWrite" | "denyAll";
		  }
		| { ruleType: "commandWhitelist"; pattern: string }
		| { ruleType: "commandBlacklist"; pattern: string; denyPrompt?: string }
	);

/** A consumed attempt-bound receipt, not a pending proposal or an authorization shortcut. */
export interface PermissionRuleRequestResult {
	requestId: string;
	status: "applied" | "alreadyExists";
	ruleId: string;
	proposalHash: string;
	scope: "narrator";
	deviceId: string;
	approvalSource: "user" | "reflection";
	approvalUserId: string | null;
	rule: AppliedPermissionRule;
}
