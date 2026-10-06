import type { TargetPathSemantics } from "@server/lib/agent/execution/backend";
import type { DirectoryBlacklistRule, DirectoryWhitelistRule } from "./types";

export type PathPolicyOperation = "read" | "write" | "full";

export type PathPolicyDecision =
	| { decision: "deny"; rule: DirectoryBlacklistRule }
	| { decision: "allow"; rule: DirectoryWhitelistRule }
	| { decision: "unmatched" };

const accessRank = { readOnly: 1, readWrite: 2, full: 3 } as const;
const operationRank = { read: 1, write: 2, full: 3 } as const;

function matchingPathRules<T extends DirectoryWhitelistRule | DirectoryBlacklistRule>(
	path: string,
	paths: TargetPathSemantics,
	rules: readonly T[],
): T[] {
	if (paths.flavor === "spec") return [];
	const normalized = paths.normalize(path);
	return rules.filter(
		(rule) =>
			rule.enabled && rule.pathFlavor === paths.flavor && paths.contains(rule.path, normalized),
	);
}

export function evaluatePathPolicy(input: {
	path: string;
	paths: TargetPathSemantics;
	operation: PathPolicyOperation;
	whitelist: readonly DirectoryWhitelistRule[];
	blacklist: readonly DirectoryBlacklistRule[];
}): PathPolicyDecision {
	const denied = matchingPathRules(input.path, input.paths, input.blacklist).find(
		(rule) => rule.denyLevel === "denyAll" || input.operation !== "read",
	);
	if (denied) return { decision: "deny", rule: denied };

	const required = operationRank[input.operation];
	const allowed = matchingPathRules(input.path, input.paths, input.whitelist)
		.filter((rule) => accessRank[rule.accessLevel] >= required)
		.sort((left, right) => right.pathKey.length - left.pathKey.length)[0];
	return allowed ? { decision: "allow", rule: allowed } : { decision: "unmatched" };
}
