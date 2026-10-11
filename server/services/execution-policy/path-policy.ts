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
	denying = false,
): T[] {
	if (paths.flavor === "spec") return [];
	const normalized = paths.normalize(path);
	if (paths.nativeProofRequired) {
		if (!paths.nativeDescriptor?.(path)) {
			throw new Error(
				"NATIVE_PATH_CAPABILITY_NOT_READY: requested path lacks its original native proof",
			);
		}
		for (const rule of rules) {
			if (
				rule.enabled &&
				rule.pathFlavor === paths.flavor &&
				!paths.nativeDescriptor?.(rule.path)
			) {
				throw new Error(
					"NATIVE_PATH_CAPABILITY_NOT_READY: directory rule lacks its original native proof",
				);
			}
		}
	}
	return rules.filter(
		(rule) =>
			rule.enabled &&
			rule.pathFlavor === paths.flavor &&
			(denying && paths.containsDenied
				? paths.containsDenied(rule.path, normalized)
				: paths.contains(rule.path, normalized)),
	);
}

export function evaluatePathPolicy(input: {
	path: string;
	paths: TargetPathSemantics;
	operation: PathPolicyOperation;
	whitelist: readonly DirectoryWhitelistRule[];
	blacklist: readonly DirectoryBlacklistRule[];
}): PathPolicyDecision {
	const denied = matchingPathRules(input.path, input.paths, input.blacklist, true).find(
		(rule) => rule.denyLevel === "denyAll" || input.operation !== "read",
	);
	if (denied) return { decision: "deny", rule: denied };

	const required = operationRank[input.operation];
	const allowed = matchingPathRules(input.path, input.paths, input.whitelist)
		.filter((rule) => accessRank[rule.accessLevel] >= required)
		.sort((left, right) => right.pathKey.length - left.pathKey.length)[0];
	return allowed ? { decision: "allow", rule: allowed } : { decision: "unmatched" };
}
