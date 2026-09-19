import { describe, expect, test } from "bun:test";
import { dangerCancelTool, dangerConfirmTool } from "../danger-reflection";
import {
	exitPlanConfirmAndCompactTool,
	exitPlanConfirmTool,
	exitPlanReviseTool,
} from "../exit-plan-reflection";
import { REFLECTION_ONLY_TOOL_AVAILABILITY } from "../reflection-description";
import { taskReflectConfirmTool, taskReflectReviseTool } from "../task-reflection";

const reflectionTools = [
	dangerConfirmTool,
	dangerCancelTool,
	exitPlanConfirmTool,
	exitPlanConfirmAndCompactTool,
	exitPlanReviseTool,
	taskReflectConfirmTool,
	taskReflectReviseTool,
];

describe("reflection-only tool descriptions", () => {
	test("explain why these tools remain declared and when they are callable", () => {
		for (const tool of reflectionTools) {
			expect(tool.reflectionOnly).toBe(true);
			expect(tool.description).toContain(REFLECTION_ONLY_TOOL_AVAILABILITY);
			expect(tool.description).toContain("active matching reflection loop");
			expect(tool.description).toContain("prompt-cache prefix");
		}
	});

	test("distinguish ordinary plan-mode use from plan reflection decisions", () => {
		expect(exitPlanConfirmTool.description).toContain("ordinary plan-mode turn");
		expect(exitPlanConfirmTool.description).toContain("ExitPlanMode");
		expect(exitPlanConfirmAndCompactTool.description).toContain("ordinary plan-mode turn");
		expect(exitPlanReviseTool.description).toContain("ordinary plan-mode turn");
	});

	test("distinguish ordinary task and danger turns from their reflection gates", () => {
		expect(taskReflectConfirmTool.description).toContain("ordinary task/tool turn");
		expect(taskReflectReviseTool.description).toContain("ordinary task/tool turn");
		expect(dangerConfirmTool.description).toContain("ordinary turn");
		expect(dangerCancelTool.description).toContain("ordinary turn");
	});
});
