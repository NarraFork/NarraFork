import type { CommandBlacklistRule, CommandWhitelistRule } from "./types";

export type CommandPolicyDecision =
	| { decision: "deny"; rule: CommandBlacklistRule; command: readonly string[] }
	| { decision: "allow"; rules: CommandWhitelistRule[] }
	| { decision: "unmatched" };

export function tokenizeCommandPattern(pattern: string): string[] {
	return pattern.trim().split(/\s+/u).filter(Boolean);
}

function globTokenMatches(value: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (!pattern.includes("*")) return value === pattern;
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");
	return new RegExp(`^${escaped}$`, "u").test(value);
}

export function commandPatternMatches(commandTokens: readonly string[], pattern: string): boolean {
	const patternTokens = tokenizeCommandPattern(pattern);
	if (patternTokens.length === 0 || commandTokens.length < patternTokens.length) return false;
	return patternTokens.every((token, index) => globTokenMatches(commandTokens[index], token));
}

export function evaluateCommandPolicy(input: {
	commands: readonly (readonly string[])[];
	whitelist: readonly CommandWhitelistRule[];
	blacklist: readonly CommandBlacklistRule[];
}): CommandPolicyDecision {
	for (const command of input.commands) {
		const denied = input.blacklist.find(
			(rule) => rule.enabled && commandPatternMatches(command, rule.pattern),
		);
		if (denied) return { decision: "deny", rule: denied, command };
	}
	if (input.commands.length === 0) return { decision: "unmatched" };
	const matchedRules: CommandWhitelistRule[] = [];
	for (const command of input.commands) {
		const allowed = input.whitelist.find(
			(rule) => rule.enabled && commandPatternMatches(command, rule.pattern),
		);
		if (!allowed) return { decision: "unmatched" };
		matchedRules.push(allowed);
	}
	return { decision: "allow", rules: matchedRules };
}
