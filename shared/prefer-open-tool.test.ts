import { describe, expect, test } from "bun:test";
import { isPreferOpenTool, prefersOpenToolCategory } from "./prefer-open-tool";

describe("prefer-open-tool", () => {
	test("AskUserQuestion and ExitPlanMode are prefer-open", () => {
		expect(isPreferOpenTool({ toolName: "AskUserQuestion" })).toBe(true);
		expect(isPreferOpenTool({ toolName: "ExitPlanMode" })).toBe(true);
		expect(prefersOpenToolCategory("ask")).toBe(true);
	});

	test("only active Await question calls prefer an open answer surface", () => {
		for (const status of ["running", "executing", "success", "fail", "cancelled", undefined]) {
			for (const type of ["question", "agent", "bash", "transfer"]) {
				expect(isPreferOpenTool({ toolName: "Await", status, inputJson: { type, id: "q1" } })).toBe(
					type === "question" && (status === "running" || status === "executing"),
				);
			}
		}
		expect(isPreferOpenTool({ toolName: "Await", status: "running" })).toBe(false);
	});

	test("EnterPlanMode and ordinary tools are not", () => {
		// Category "plan" covers both plan-mode tools; only ExitPlanMode is prefer-open
		// by NAME so a short EnterPlanMode call does not inherit the plan-body default.
		expect(isPreferOpenTool({ toolName: "EnterPlanMode" })).toBe(false);
		expect(isPreferOpenTool({ toolName: "Bash" })).toBe(false);
		expect(isPreferOpenTool({ toolName: "Read" })).toBe(false);
		expect(prefersOpenToolCategory("plan")).toBe(false);
		expect(prefersOpenToolCategory("bash")).toBe(false);
		expect(prefersOpenToolCategory(undefined)).toBe(false);
	});
});
