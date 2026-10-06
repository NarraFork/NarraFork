import type {
	ExecutionBackend,
	PathFlavor as ExecutionPathFlavor,
	TargetPathSemantics,
} from "@server/lib/agent/execution/backend";
import type { ToolExecutionTarget } from "@server/lib/agent/types";

export const OAUTH_RULE_TARGET_GROUPS = ["global", "selfRegistered"] as const;

export type OAuthRuleTargetGroup = (typeof OAUTH_RULE_TARGET_GROUPS)[number];
export type ExecutionDeviceClass = "host" | OAuthRuleTargetGroup;

export type RuleTargetSelector =
	| { kind: "all" }
	| { kind: "host" }
	| { kind: "device"; deviceId: string }
	| { kind: "oauthGroup"; group: OAuthRuleTargetGroup };

export type RuleTargetKind = RuleTargetSelector["kind"];
export type PathFlavor = Exclude<ExecutionPathFlavor, "spec">;
export type PermissionRuleSource = "global" | "project" | "narrator";

/**
 * Frozen execution identity used by every routed permission decision.
 *
 * `backend` is the live executor selected before permission handling, `target` is the
 * immutable serializable identity retained for pending/reprocessing, `paths` is the exact
 * grammar used by that target, and `deviceClass` is the OAuth capability group when one is
 * present. Ordinary narrators use `null` and therefore cannot match oauthGroup selectors.
 */
export type FrozenExecutionTarget = Readonly<
	ToolExecutionTarget & {
		pathFlavor: NonNullable<ToolExecutionTarget["pathFlavor"]>;
		runtimeGeneration: number;
	}
>;

export interface ExecutionTargetContext {
	readonly backend: ExecutionBackend;
	readonly target: FrozenExecutionTarget;
	readonly paths: TargetPathSemantics;
	readonly deviceClass: ExecutionDeviceClass | null;
}

export interface PermissionRuleBase {
	id?: string;
	enabled: boolean;
	selector: RuleTargetSelector;
	source: PermissionRuleSource;
	createdAt?: string;
	updatedAt?: string;
}

export interface DirectoryWhitelistRule extends PermissionRuleBase {
	ruleType: "directoryWhitelist";
	path: string;
	pathFlavor: PathFlavor;
	pathKey: string;
	accessLevel: "readOnly" | "readWrite" | "full";
}

export interface DirectoryBlacklistRule extends PermissionRuleBase {
	ruleType: "directoryBlacklist";
	path: string;
	pathFlavor: PathFlavor;
	pathKey: string;
	denyLevel: "denyWrite" | "denyAll";
}

export interface CommandWhitelistRule extends PermissionRuleBase {
	ruleType: "commandWhitelist";
	pattern: string;
}

export interface CommandBlacklistRule extends PermissionRuleBase {
	ruleType: "commandBlacklist";
	pattern: string;
	denyPrompt?: string;
}

export type DirectoryPermissionRule = DirectoryWhitelistRule | DirectoryBlacklistRule;
export type CommandPermissionRule = CommandWhitelistRule | CommandBlacklistRule;
export type ExecutionPermissionRule = DirectoryPermissionRule | CommandPermissionRule;

export interface ExecutionPolicyRuleSet {
	directoryWhitelist: DirectoryWhitelistRule[];
	directoryBlacklist: DirectoryBlacklistRule[];
	commandWhitelist: CommandWhitelistRule[];
	commandBlacklist: CommandBlacklistRule[];
}

export interface LegacyTargetFields {
	selector?: RuleTargetSelector;
	targetKind?: RuleTargetKind | null;
	targetValue?: string | null;
	deviceScope?: string | null;
}

export interface LegacyDirectoryWhitelistEntry extends LegacyTargetFields {
	id?: string;
	path: string;
	pathFlavor?: PathFlavor | null;
	pathKey?: string | null;
	accessLevel?: "readOnly" | "readWrite" | "full" | null;
	enabled?: boolean | null;
	createdAt?: string | null;
	updatedAt?: string | null;
}

export interface LegacyDirectoryBlacklistEntry extends LegacyTargetFields {
	id?: string;
	path: string;
	pathFlavor?: PathFlavor | null;
	pathKey?: string | null;
	denyLevel?: "denyWrite" | "denyAll" | null;
	enabled?: boolean | null;
	createdAt?: string | null;
	updatedAt?: string | null;
}

export interface LegacyCommandWhitelistEntry extends LegacyTargetFields {
	id?: string;
	pattern: string;
	enabled?: boolean | null;
	createdAt?: string | null;
	updatedAt?: string | null;
}

export interface LegacyCommandBlacklistEntry extends LegacyTargetFields {
	id?: string;
	pattern: string;
	denyPrompt?: string | null;
	enabled?: boolean | null;
	createdAt?: string | null;
	updatedAt?: string | null;
}

export interface LegacyExecutionPolicyRuleSet {
	whitelistDirs?: readonly LegacyDirectoryWhitelistEntry[] | null;
	blacklistDirs?: readonly LegacyDirectoryBlacklistEntry[] | null;
	commandWhitelist?: readonly LegacyCommandWhitelistEntry[] | null;
	commandBlacklist?: readonly LegacyCommandBlacklistEntry[] | null;
}
