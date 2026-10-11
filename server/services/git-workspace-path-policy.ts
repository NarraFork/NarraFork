import type { CompiledExecutionPolicy } from "./execution-policy/compiler";
import type { ExecutionTargetContext } from "./execution-policy/types";

/** A whole-tree operation cannot skip forbidden descendants or widen a subtree grant. */
export function gitPathPolicyAllows(
	policy: CompiledExecutionPolicy,
	context: ExecutionTargetContext,
	root: string,
	need: "read" | "write",
): boolean {
	const paths = context.paths;
	if (paths.nativeProofRequired) {
		for (const path of [
			root,
			...[...policy.directoryBlacklist, ...policy.directoryWhitelist]
				.filter((rule) => rule.enabled && rule.pathFlavor === paths.flavor)
				.map((rule) => rule.path),
		]) {
			if (!paths.nativeDescriptor?.(path))
				throw new Error(
					"NATIVE_PATH_CAPABILITY_NOT_READY: Git tree policy lacks an original native root/rule proof",
				);
		}
	}
	const denyContains = (parent: string, child: string) =>
		paths.containsDenied?.(parent, child) ?? paths.contains(parent, child);
	if (
		policy.directoryBlacklist.some(
			(rule) =>
				rule.enabled &&
				(rule.denyLevel === "denyAll" || need === "write") &&
				(paths.contains(root, rule.path) || denyContains(rule.path, root)),
		)
	)
		return false;
	const decision = policy.evaluatePath({ path: root, operation: need });
	if (decision.decision === "deny") return false;
	// An explicit narrower grant is not permission to manage its containing repository.
	// Only rules strictly INSIDE root count: a whitelist only ever grants, so an ancestor
	// (or identical) rule with a lower access level — e.g. a readOnly grant on the parent
	// directory holding sibling projects — must not downgrade the narrator's own workspace.
	const scoped = policy.directoryWhitelist.filter(
		(rule) => paths.contains(root, rule.path) && !paths.equals(root, rule.path),
	);
	if (scoped.length > 0 && decision.decision !== "allow") return false;
	return true;
}
