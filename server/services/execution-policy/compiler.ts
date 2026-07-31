import type { TargetPathSemantics } from "@server/lib/agent/execution/backend";
import { localPathSemantics } from "@server/lib/agent/execution/path-semantics";
import { evaluateCommandPolicy } from "./command-policy";
import { evaluatePathPolicy } from "./path-policy";
import { ruleTargetMatches } from "./selector";
import type { ExecutionPolicyRuleSet, ExecutionTargetContext } from "./types";

export interface CompiledExecutionPolicy extends ExecutionPolicyRuleSet {
	readonly targetContext: ExecutionTargetContext | null;
	evaluatePath(input: {
		path: string;
		operation: "read" | "write" | "full";
		/** Compatibility escape hatch for context-free unit callers. Main permission flow never uses it. */
		paths?: TargetPathSemantics;
	}): ReturnType<typeof evaluatePathPolicy>;
	evaluateCommands(
		commands: readonly (readonly string[])[],
	): ReturnType<typeof evaluateCommandPolicy>;
}

/**
 * Compile a merged rule set for one concrete frozen execution target. Scoped rules cannot
 * match without the complete context. Directory rules are additionally restricted to the
 * target's path grammar so a Windows rule can never authorize a POSIX target (or vice versa).
 */
export function compileExecutionPolicy(
	rules: ExecutionPolicyRuleSet,
	targetContext?: ExecutionTargetContext | null,
): CompiledExecutionPolicy {
	const context = targetContext ?? null;
	const directoryWhitelist = rules.directoryWhitelist.filter(
		(rule) =>
			rule.enabled &&
			ruleTargetMatches(rule.selector, context) &&
			(!context || context.paths.flavor === rule.pathFlavor),
	);
	const directoryBlacklist = rules.directoryBlacklist.filter(
		(rule) =>
			rule.enabled &&
			ruleTargetMatches(rule.selector, context) &&
			(!context || context.paths.flavor === rule.pathFlavor),
	);
	const commandWhitelist = rules.commandWhitelist.filter(
		(rule) => rule.enabled && ruleTargetMatches(rule.selector, context),
	);
	const commandBlacklist = rules.commandBlacklist.filter(
		(rule) => rule.enabled && ruleTargetMatches(rule.selector, context),
	);
	return {
		targetContext: context,
		directoryWhitelist,
		directoryBlacklist,
		commandWhitelist,
		commandBlacklist,
		evaluatePath: (input) => {
			const paths = context?.paths ?? input.paths ?? localPathSemantics;
			return evaluatePathPolicy({
				path: input.path,
				paths,
				operation: input.operation,
				whitelist: directoryWhitelist,
				blacklist: directoryBlacklist,
			});
		},
		evaluateCommands: (commands) =>
			evaluateCommandPolicy({ commands, whitelist: commandWhitelist, blacklist: commandBlacklist }),
	};
}
