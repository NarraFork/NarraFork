import { describe, expect, test } from "bun:test";
import { isPreferOpenTool, prefersOpenToolCategory } from "./prefer-open-tool";

describe("prefer-open-tool", () => {
	test("compact policy folds answered questions and finished plans, not async acknowledgements", () => {
		const policy = { compactAuxiliaryContent: true };
		expect(isPreferOpenTool({ toolName: "AskUserQuestion", status: "running" }, policy)).toBe(true);
		expect(
			isPreferOpenTool(
				{
					toolName: "AskUserQuestion",
					status: "success",
					inputJson: { answers: { topic: "yes" } },
				},
				policy,
			),
		).toBe(false);
		expect(
			isPreferOpenTool(
				{ toolName: "AskUserQuestion", status: "success", inputJson: { async: true } },
				policy,
			),
		).toBe(true);
		expect(
			isPreferOpenTool(
				{
					toolName: "AskUserQuestion",
					status: "success",
					inputJson: { async: true, answers: { topic: "yes" } },
				},
				policy,
			),
		).toBe(false);
		expect(isPreferOpenTool({ toolName: "ExitPlanMode", status: "success" }, policy)).toBe(false);
		expect(isPreferOpenTool({ toolName: "ExitPlanMode", status: "pending" }, policy)).toBe(true);
		expect(isPreferOpenTool({ toolName: "ExitPlanMode", status: "success" })).toBe(true);
	});

	test("only authoritative question terminal states retire async answer surfaces", () => {
		const tool = { toolName: "AskUserQuestion", status: "success", inputJson: { async: true } };
		for (const questionStatus of [
			"open",
			"answered",
			"dismissed",
			"withdrawn",
			"resolved",
			"unknown",
			undefined,
		]) {
			expect(isPreferOpenTool(tool, { compactAuxiliaryContent: true, questionStatus })).toBe(
				questionStatus === "open" || questionStatus === "unknown" || questionStatus === undefined,
			);
			expect(isPreferOpenTool(tool, { compactAuxiliaryContent: false, questionStatus })).toBe(true);
		}
	});

	test("compact GenUI keeps actual UI and live forms but folds inspection/status receipts", () => {
		for (const action of ["render", "show", "inspect", "kit_status", "create", "kit_build"]) {
			expect(
				isPreferOpenTool(
					{ toolName: "GenUI", status: "success", inputJson: { action } },
					{ compactAuxiliaryContent: true },
				),
			).toBe(action === "render" || action === "show");
			expect(
				isPreferOpenTool({ toolName: "GenUI", status: "success", inputJson: { action } }),
			).toBe(true);
		}
		expect(
			isPreferOpenTool(
				{ toolName: "GenUI", status: "running", inputJson: { action: "render", wait: true } },
				{ compactAuxiliaryContent: true },
			),
		).toBe(true);
		expect(
			isPreferOpenTool(
				{ toolName: "GenUI", status: "running", inputJson: { action: "kit_build" } },
				{ compactAuxiliaryContent: true },
			),
		).toBe(true);
	});

	test("completed GenUI calls still expose pending kit confirmation in persisted result metadata", () => {
		expect(
			isPreferOpenTool(
				{
					toolName: "GenUI",
					status: "success",
					inputJson: { action: "kit_build" },
					outputJson: {
						_metadata: {
							genUiKit: {
								state: "unbuilt",
								request: { id: "request", kind: "build", state: "pending" },
							},
						},
					},
				},
				{ compactAuxiliaryContent: true },
			),
		).toBe(true);
	});

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
