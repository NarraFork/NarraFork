import { normalizeDirectoryPath, normalizePathKey } from "./path";
import { normalizeRuleTargetSelector } from "./selector";
import type {
	CommandBlacklistRule,
	CommandWhitelistRule,
	DirectoryBlacklistRule,
	DirectoryWhitelistRule,
	ExecutionPolicyRuleSet,
	LegacyCommandBlacklistEntry,
	LegacyCommandWhitelistEntry,
	LegacyDirectoryBlacklistEntry,
	LegacyDirectoryWhitelistEntry,
	LegacyExecutionPolicyRuleSet,
	PermissionRuleSource,
} from "./types";

function baseRule(
	entry: {
		id?: string;
		enabled?: boolean | null;
		createdAt?: string | null;
		updatedAt?: string | null;
		selector?: LegacyDirectoryWhitelistEntry["selector"];
		targetKind?: LegacyDirectoryWhitelistEntry["targetKind"];
		targetValue?: string | null;
		deviceScope?: string | null;
	},
	source: PermissionRuleSource,
) {
	return {
		...(entry.id ? { id: entry.id } : {}),
		enabled: entry.enabled !== false,
		selector: normalizeRuleTargetSelector(entry),
		source,
		...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
		...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
	};
}

export function normalizeDirectoryWhitelistRule(
	entry: LegacyDirectoryWhitelistEntry,
	source: PermissionRuleSource,
): DirectoryWhitelistRule {
	const path = normalizeDirectoryPath(entry.path, entry.pathFlavor);
	return {
		...baseRule(entry, source),
		ruleType: "directoryWhitelist",
		...path,
		pathKey: entry.pathKey?.trim()
			? normalizePathKey(entry.pathKey, path.pathFlavor)
			: path.pathKey,
		accessLevel: entry.accessLevel ?? "readOnly",
	};
}

export function normalizeDirectoryBlacklistRule(
	entry: LegacyDirectoryBlacklistEntry,
	source: PermissionRuleSource,
): DirectoryBlacklistRule {
	const path = normalizeDirectoryPath(entry.path, entry.pathFlavor);
	return {
		...baseRule(entry, source),
		ruleType: "directoryBlacklist",
		...path,
		pathKey: entry.pathKey?.trim()
			? normalizePathKey(entry.pathKey, path.pathFlavor)
			: path.pathKey,
		denyLevel: entry.denyLevel ?? "denyAll",
	};
}

export function normalizeCommandWhitelistRule(
	entry: LegacyCommandWhitelistEntry,
	source: PermissionRuleSource,
): CommandWhitelistRule {
	const pattern = entry.pattern.trim();
	if (!pattern) throw new Error("Command rule pattern cannot be empty");
	return {
		...baseRule(entry, source),
		ruleType: "commandWhitelist",
		pattern,
	};
}

export function normalizeCommandBlacklistRule(
	entry: LegacyCommandBlacklistEntry,
	source: PermissionRuleSource,
): CommandBlacklistRule {
	const pattern = entry.pattern.trim();
	if (!pattern) throw new Error("Command rule pattern cannot be empty");
	return {
		...baseRule(entry, source),
		ruleType: "commandBlacklist",
		pattern,
		...(entry.denyPrompt ? { denyPrompt: entry.denyPrompt } : {}),
	};
}

export function normalizeExecutionPolicyRuleSet(
	input: LegacyExecutionPolicyRuleSet | null | undefined,
	source: PermissionRuleSource,
): ExecutionPolicyRuleSet {
	return {
		directoryWhitelist: (input?.whitelistDirs ?? []).map((entry) =>
			normalizeDirectoryWhitelistRule(entry, source),
		),
		directoryBlacklist: (input?.blacklistDirs ?? []).map((entry) =>
			normalizeDirectoryBlacklistRule(entry, source),
		),
		commandWhitelist: (input?.commandWhitelist ?? []).map((entry) =>
			normalizeCommandWhitelistRule(entry, source),
		),
		commandBlacklist: (input?.commandBlacklist ?? []).map((entry) =>
			normalizeCommandBlacklistRule(entry, source),
		),
	};
}

export function mergeExecutionPolicyRuleSets(
	...sets: readonly ExecutionPolicyRuleSet[]
): ExecutionPolicyRuleSet {
	return {
		directoryWhitelist: sets.flatMap((set) => set.directoryWhitelist),
		directoryBlacklist: sets.flatMap((set) => set.directoryBlacklist),
		commandWhitelist: sets.flatMap((set) => set.commandWhitelist),
		commandBlacklist: sets.flatMap((set) => set.commandBlacklist),
	};
}
