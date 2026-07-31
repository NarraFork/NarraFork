import { describe, expect, test } from "bun:test";
import { compileExecutionPolicy } from "../compiler";
import { mergeExecutionPolicyRuleSets, normalizeExecutionPolicyRuleSet } from "../normalize";
import { executionContext } from "./fixtures";

describe("execution policy three-layer merge", () => {
	test("preserves global, project, narrator precedence order", () => {
		const globalRules = normalizeExecutionPolicyRuleSet(
			{ commandBlacklist: [{ pattern: "global-cmd" }] },
			"global",
		);
		const projectRules = normalizeExecutionPolicyRuleSet(
			{ commandBlacklist: [{ pattern: "project-cmd" }] },
			"project",
		);
		const narratorRules = normalizeExecutionPolicyRuleSet(
			{ commandBlacklist: [{ pattern: "narrator-cmd" }] },
			"narrator",
		);
		const merged = mergeExecutionPolicyRuleSets(globalRules, projectRules, narratorRules);
		expect(merged.commandBlacklist.map((rule) => rule.source)).toEqual([
			"global",
			"project",
			"narrator",
		]);
		expect(merged.commandBlacklist.map((rule) => rule.pattern)).toEqual([
			"global-cmd",
			"project-cmd",
			"narrator-cmd",
		]);
	});

	test("compiler excludes scoped rules when target context is absent", () => {
		const rules = normalizeExecutionPolicyRuleSet(
			{
				commandWhitelist: [
					{ pattern: "always", selector: { kind: "all" } },
					{ pattern: "host-only", selector: { kind: "host" } },
					{ pattern: "device-only", deviceScope: "device-a" },
				],
			},
			"narrator",
		);
		expect(compileExecutionPolicy(rules).commandWhitelist.map((rule) => rule.pattern)).toEqual([
			"always",
		]);
		expect(
			compileExecutionPolicy(
				rules,
				executionContext({ deviceId: "device-a", kind: "remote" }),
			).commandWhitelist.map((rule) => rule.pattern),
		).toEqual(["always", "device-only"]);
		expect(
			compileExecutionPolicy(rules, executionContext()).commandWhitelist.map(
				(rule) => rule.pattern,
			),
		).toEqual(["always", "host-only"]);
	});

	test("compiled command policy applies deny before allow", () => {
		const rules = normalizeExecutionPolicyRuleSet(
			{
				commandWhitelist: [{ pattern: "git" }],
				commandBlacklist: [{ pattern: "git reset" }],
			},
			"global",
		);
		const compiled = compileExecutionPolicy(rules, executionContext());
		expect(compiled.evaluateCommands([["git", "status"]]).decision).toBe("allow");
		expect(compiled.evaluateCommands([["git", "reset", "--hard"]]).decision).toBe("deny");
	});
});
