import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { executeTool } from "../tool-executor";
import { toolRegistry } from "../tool-registry";
import { dangerCancelTool, dangerConfirmTool } from "../tools/danger-reflection";
import type { AgentConfig, PermissionResult, ToolDefinition } from "../types";

const TEST_TOOL_NAME = "__ExecutorGuardTest";

afterEach(() => {
	toolRegistry.unregister(TEST_TOOL_NAME);
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
