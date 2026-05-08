import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { resolvePermissionDecision } from "../../../services/narrator-permission";
import { settings } from "../../settings";
import {
	shouldInjectRelaxedPlanToolReminder,
	shouldRunExitPlanModeReflection,
	shouldRunGoalCompletionReflection,
} from "../loop";
import { executeTool } from "../tool-executor";
import { toolRegistry } from "../tool-registry";
import { dangerCancelTool, dangerConfirmTool } from "../tools/danger-reflection";
import { goalCompleteConfirmTool, goalCompleteReviseTool } from "../tools/goal-reflection";
import {
	type AgentConfig,
	type PermissionResult,
	PLAN_MODE_ALLOWED_TOOLS,
	type ToolDefinition,
} from "../types";

const TEST_TOOL_NAME = "__ExecutorGuardTest";

const originalPlanReflectionAutoApprove = settings.agent.planReflectionAutoApprove;

function setPlanReflectionAutoApprove(value: boolean) {
	settings.agent.planReflectionAutoApprove = value;
}

afterEach(() => {
	toolRegistry.unregister(TEST_TOOL_NAME);
	settings.agent.planReflectionAutoApprove = originalPlanReflectionAutoApprove;
});

function makeConfig(permissionHandler: AgentConfig["permissionHandler"]): AgentConfig {
	const abortController = new AbortController();
	return {
		narratorId: "narrator-self",
		conversationId: "conversation-test",
		model: "codex:gpt-5.5",
		provider: "codex",
		cwd: "/tmp",
		signal: abortController.signal,
		permissionHandler,
	};
}

describe("executeTool permission guard", () => {
	test("does not execute unresolved dangerReflection permission results", async () => {
		let executed = false;
		const testTool: ToolDefinition = {
			name: TEST_TOOL_NAME,
			description: "test tool",
			parameters: z.object({}),
			execute: async () => {
				executed = true;
				return { output: "executed" };
			},
		};
		toolRegistry.register(testTool);

		const unresolvedDecision = new Promise<PermissionResult>(() => {});
		const result = await executeTool(
			{ toolUseId: "tool-use-test", name: TEST_TOOL_NAME, input: {} },
			makeConfig(async () => ({
				behavior: "dangerReflection",
				requestId: "danger-request-test",
				fingerprint: "fingerprint-test",
				input: {},
				danger: {
					summary: "dangerous test operation",
					consequences: [],
					saferAlternatives: [],
				},
				decision: unresolvedDecision,
			})),
		);

		expect(executed).toBe(false);
		expect(result.isError).toBe(true);
		expect(result.fatal).toBe(false);
		expect(result.output).toContain("dangerReflection");
		expect(result.output).toContain("not executed");
	});
});

describe("ExitPlanMode reflection gate", () => {
	test("requires the auto-approve setting", () => {
		setPlanReflectionAutoApprove(false);

		expect(
			shouldRunExitPlanModeReflection({
				permissionMode: "bypassPermissions",
			}),
		).toBe(false);

		setPlanReflectionAutoApprove(true);
		expect(
			shouldRunExitPlanModeReflection({
				permissionMode: "bypassPermissions",
			}),
		).toBe(true);
	});

	test("runs in edit-capable modes outside reflection loops", () => {
		setPlanReflectionAutoApprove(true);

		expect(
			shouldRunExitPlanModeReflection({
				permissionMode: "bypassPermissions",
			}),
		).toBe(true);
		expect(
			shouldRunExitPlanModeReflection({
				permissionMode: "acceptEdits",
			}),
		).toBe(true);
		expect(
			shouldRunExitPlanModeReflection({
				permissionMode: "default",
			}),
		).toBe(false);
		expect(
			shouldRunExitPlanModeReflection({
				permissionMode: "bypassPermissions",
				reflectionLoop: { allowedTools: [], context: { kind: "exitPlanMode" } },
			}),
		).toBe(false);
	});
});

describe("Goal completion reflection gate", () => {
	test("runs outside reflection loops regardless of permission mode", () => {
		expect(shouldRunGoalCompletionReflection({})).toBe(true);
		expect(
			shouldRunGoalCompletionReflection({
				reflectionLoop: { allowedTools: [], context: { kind: "goalCompletion" } },
			}),
		).toBe(false);
	});
});

describe("relaxed plan reminder classifier", () => {
	const relaxedPlanConfig = {
		planMode: true,
		relaxedPlan: true,
		cwd: "/tmp",
	};

	test("ignores read-only tools and read-only subagents", async () => {
		await expect(
			shouldInjectRelaxedPlanToolReminder(
				{ toolUseId: "tu-read", name: "Read", input: { file_path: "x.ts" } },
				relaxedPlanConfig,
			),
		).resolves.toBe(false);
		await expect(
			shouldInjectRelaxedPlanToolReminder(
				{ toolUseId: "tu-agent", name: "Agent", input: { subagent_type: "explore" } },
				relaxedPlanConfig,
			),
		).resolves.toBe(false);
	});

	test("flags mutating tools and write-capable subagents", async () => {
		await expect(
			shouldInjectRelaxedPlanToolReminder(
				{ toolUseId: "tu-write", name: "Write", input: { file_path: "x.ts" } },
				relaxedPlanConfig,
			),
		).resolves.toBe(true);
		await expect(
			shouldInjectRelaxedPlanToolReminder(
				{ toolUseId: "tu-agent", name: "Agent", input: { subagent_type: "general" } },
				relaxedPlanConfig,
			),
		).resolves.toBe(true);
	});
});

describe("LearningGuide permission integration", () => {
	test("is available in safe permission modes and plan mode", () => {
		const base = {
			toolName: "LearningGuide",
			input: { mode: "list" },
			cwd: "/tmp",
		};

		expect(resolvePermissionDecision({ ...base, permMode: "default" })).toBe("allow");
		expect(resolvePermissionDecision({ ...base, permMode: "readOnly" })).toBe("allow");
		expect(resolvePermissionDecision({ ...base, permMode: "acceptEdits" })).toBe("allow");
		expect(PLAN_MODE_ALLOWED_TOOLS.has("LearningGuide")).toBe(true);
	});
});

describe("goal completion reflection tools", () => {
	test("GoalCompleteConfirm requires concrete evidence", () => {
		expect(
			goalCompleteConfirmTool.parameters.safeParse({ confirm: true, evidence: "too short" })
				.success,
		).toBe(false);
		expect(
			goalCompleteConfirmTool.parameters.safeParse({
				confirm: true,
				evidence: "Verified every requested requirement with concrete tool output.",
			}).success,
		).toBe(true);
	});

	test("GoalCompleteRevise requires feedback", () => {
		expect(
			goalCompleteReviseTool.parameters.safeParse({ confirm: true, feedback: "" }).success,
		).toBe(false);
		expect(
			goalCompleteReviseTool.parameters.safeParse({
				confirm: true,
				feedback: "Need to run the requested verification first.",
			}).success,
		).toBe(true);
	});
});

describe("danger reflection tools", () => {
	test("DangerConfirm accepts a reflection without confirm flag", () => {
		expect(
			dangerConfirmTool.parameters.safeParse({ reflection: "intentional validation" }).success,
		).toBe(true);
	});

	test("DangerCancel accepts a reason without confirm flag", () => {
		expect(dangerCancelTool.parameters.safeParse({ reason: "not necessary" }).success).toBe(true);
	});
});
