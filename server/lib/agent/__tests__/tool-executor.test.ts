import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { resolveRuntimePolicy } from "../../../services/agent-runtime/policy";
import {
	extractToolPaths,
	MAX_PLAN_FILE_BYTES,
	resolveExitPlanModeInput,
	resolvePermissionDecision,
} from "../../../services/narrator-permission";
import { activeNarrators } from "../../../services/narrator-session-state";
import {
	SUBAGENT_ALIAS_TRAIT_PREFIX,
	subagentMatchesSelector,
} from "../../../services/subagent-alias";
import { toolContinuationService } from "../../../services/tool-continuation-service";
import {
	beginQuiescingTools,
	capturePlannedUpdateRecoverySnapshot,
	failScheduledUpdate,
	getUpdateCoordinationStatus,
	resetUpdateCoordinationForTests,
	scheduleUpdate,
	waitForOrdinaryToolDrain,
	waitForUpdateCheckpointFence,
} from "../../../services/update-coordinator";
import { settings } from "../../settings";
import type { ExecutionBackend } from "../execution/backend";
import { posixPathSemantics } from "../execution/path-semantics";
import { setRemoteBackendResolver } from "../execution/registry";
import {
	buildExitPlanReflectionPrompt,
	buildTaskReflectionDenialFingerprint,
	buildTaskReflectionPrompt,
	getExitPlanReflectionAllowedTools,
	shouldInjectRelaxedPlanToolReminder,
	shouldRunExitPlanModeReflection,
} from "../loop";
import { classifyToolUpdateExecution, executeTool, preAdmitToolExecution } from "../tool-executor";
import { toolRegistry } from "../tool-registry";
import { askUserQuestionTool } from "../tools/ask-user-question";
import { browserTool } from "../tools/browser";
import { dangerCancelTool, dangerConfirmTool } from "../tools/danger-reflection";
import { EXIT_PLAN_CONFIRM_COMPACT_TOOL_NAME } from "../tools/exit-plan-reflection";
import {
	type AgentConfig,
	type AgentToolUse,
	type PermissionResult,
	PLAN_MODE_ALLOWED_TOOLS,
	type ToolCallBinding,
	type ToolDefinition,
	type ToolExecutionTarget,
} from "../types";

const TEST_TOOL_NAME = "__ExecutorGuardTest";
const ADMISSION_TOOL_NAME = "__AdmissionOrdinaryTest";
const DISABLED_ADMISSION_TOOL_NAME = "__AdmissionDisabledTest";
const originalUpsertContinuation = toolContinuationService.upsert;

const originalPlanReflectionAutoApprove = settings.agent.planReflectionAutoApprove;
const originalPlanReflectionAllowAutoCompact = settings.agent.planReflectionAllowAutoCompact;

function setPlanReflectionAutoApprove(value: boolean) {
	settings.agent.planReflectionAutoApprove = value;
}

function setPlanReflectionAllowAutoCompact(value: boolean) {
	settings.agent.planReflectionAllowAutoCompact = value;
}

afterEach(() => {
	toolRegistry.unregister(TEST_TOOL_NAME);
	toolRegistry.unregister(ADMISSION_TOOL_NAME);
	toolRegistry.unregister(DISABLED_ADMISSION_TOOL_NAME);
	toolRegistry.unregister("Agent");
	toolRegistry.unregister("Await");
	toolRegistry.unregister("Bash");
	toolContinuationService.upsert = originalUpsertContinuation;
	resetUpdateCoordinationForTests();
	setRemoteBackendResolver(null);
	settings.agent.planReflectionAutoApprove = originalPlanReflectionAutoApprove;
	settings.agent.planReflectionAllowAutoCompact = originalPlanReflectionAllowAutoCompact;
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
		requireToolCallBinding: true,
		// Unit fixture for a receipt already returned by block_complete. Real DB ordering is
		// covered by services/__tests__/tool-call-binding.test.ts, never by a latest-id lookup.
		toolExecutionBindings: new (class extends WeakMap<AgentToolUse, ToolCallBinding> {
			override get(tool: AgentToolUse): ToolCallBinding {
				const binding = super.get(tool) ?? { toolCallId: `row-${tool.toolUseId}`, attempt: 1 };
				super.set(tool, binding);
				return binding;
			}
		})(),
		onToolExecutionStarting: async (_toolUseId, binding) => binding,
	};
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

function stubAdmissionPersistence(records: Array<Record<string, unknown>>): void {
	toolContinuationService.upsert = mock(async (input) => {
		records.push(input as unknown as Record<string, unknown>);
		return input as never;
	}) as typeof toolContinuationService.upsert;
}

describe("executeTool trusted runtime policy", () => {
	test("passes the exact server policy to ToolContext and cannot be overwritten by tool input", async () => {
		const policy = resolveRuntimePolicy({
			variant: "subagent",
			subagentType: "custom",
			customDefinition: { toolAccess: "custom", customTools: ["Read"] },
		});
		const forgedPolicy = resolveRuntimePolicy({ variant: "primary" });
		let receivedPolicy: unknown;
		let receivedInput: unknown;
		toolRegistry.register({
			name: TEST_TOOL_NAME,
			description: "Test policy context",
			parameters: z.object({ runtimePolicy: z.unknown() }),
			execute: async (input, ctx) => {
				receivedPolicy = ctx.runtimePolicy;
				receivedInput = input.runtimePolicy;
				return { output: "policy received" };
			},
		});
		const config = makeConfig(async () => ({ behavior: "allow" }));
		config.parentNarratorId = "trusted-parent";
		config.runtimePolicy = policy;
		const result = await executeTool(
			{ toolUseId: "policy-probe", name: TEST_TOOL_NAME, input: { runtimePolicy: forgedPolicy } },
			config,
		);
		expect(result.isError).not.toBe(true);
		expect(result.output).toBe("policy received");
		expect(receivedPolicy).toBe(policy);
		expect(receivedInput).toEqual(forgedPolicy);
		expect(policy.capabilities.askUserQuestion).toBe("disabled");
	});

	test("a custom restriction survives real execution even when parent inference would allow async Ask", async () => {
		const previous = toolRegistry.get("AskUserQuestion");
		toolRegistry.register(askUserQuestionTool);
		try {
			const config = makeConfig(async () => ({ behavior: "allow" }));
			config.parentNarratorId = "trusted-parent";
			config.runtimePolicy = resolveRuntimePolicy({
				variant: "subagent",
				subagentType: "custom",
				customDefinition: { toolAccess: "custom", customTools: ["Read", "Await"] },
			});
			const result = await executeTool(
				{
					toolUseId: "policy-ask-denied",
					name: "AskUserQuestion",
					input: {
						async: true,
						questions: [{ question: "direction", header: "Which direction?", options: [] }],
						runtimePolicy: resolveRuntimePolicy({ variant: "primary" }),
					},
				},
				config,
			);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("not available under this runtime policy");
		} finally {
			if (previous) toolRegistry.register(previous);
			else toolRegistry.unregister("AskUserQuestion");
		}
	});

	test("server child policy rejects synchronous Ask even when a legacy config has no parent hint", async () => {
		const previous = toolRegistry.get("AskUserQuestion");
		toolRegistry.register(askUserQuestionTool);
		try {
			const config = makeConfig(async () => ({ behavior: "allow" }));
			config.runtimePolicy = resolveRuntimePolicy({ variant: "subagent", subagentType: "general" });
			const result = await executeTool(
				{
					toolUseId: "policy-sync-denied",
					name: "AskUserQuestion",
					input: {
						questions: [{ question: "direction", header: "Which direction?", options: [] }],
					},
				},
				config,
			);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("async: true");
		} finally {
			if (previous) toolRegistry.register(previous);
			else toolRegistry.unregister("AskUserQuestion");
		}
	});
});

describe("executeTool update admission gate", () => {
	test("classifies background Bash and resumable agent routes", () => {
		expect(
			classifyToolUpdateExecution({
				toolUseId: "classify-bash",
				name: "Bash",
				input: { run_in_background: true },
			}),
		).toBe("background_bash");
		expect(
			classifyToolUpdateExecution({
				toolUseId: "classify-agent",
				name: "Agent",
				input: { run_in_background: false },
			}),
		).toBe("resumable");
		expect(
			classifyToolUpdateExecution({
				toolUseId: "classify-await",
				name: "Await",
				input: { type: "agent", id: "worker" },
			}),
		).toBe("resumable");
		expect(
			classifyToolUpdateExecution({
				toolUseId: "classify-background-agent",
				name: "Agent",
				input: { run_in_background: true },
			}),
		).toBe("resumable");
		expect(
			classifyToolUpdateExecution({
				toolUseId: "classify-send-await",
				name: "Send",
				input: { await: true, message: "wait for reply" },
			}),
		).toBe("resumable");
		expect(
			classifyToolUpdateExecution({
				toolUseId: "classify-send-ordinary",
				name: "Send",
				input: { message: "fire and forget" },
			}),
		).toBe("ordinary");
	});

	test("phase 1 pauses background Bash while ordinary tools continue", async () => {
		const continuationRecords: Array<Record<string, unknown>> = [];
		stubAdmissionPersistence(continuationRecords);
		let backgroundPermissionCalls = 0;
		let backgroundExecutions = 0;
		let ordinaryExecutions = 0;
		toolRegistry.register({
			name: "Bash",
			description: "admission background bash",
			parameters: z.object({ run_in_background: z.boolean().optional() }),
			execute: async () => {
				backgroundExecutions++;
				return { output: "background started" };
			},
		});
		toolRegistry.register({
			name: ADMISSION_TOOL_NAME,
			description: "admission ordinary tool",
			parameters: z.object({}),
			execute: async () => {
				ordinaryExecutions++;
				return { output: "ordinary complete" };
			},
		});

		scheduleUpdate("test-version");
		const backgroundPromise = executeTool(
			{ toolUseId: "phase1-background", name: "Bash", input: { run_in_background: true } },
			makeConfig(async () => {
				backgroundPermissionCalls++;
				return { behavior: "allow" };
			}),
		);
		await waitForCondition(() => getUpdateCoordinationStatus().pausedToolCount === 1);
		expect(backgroundPermissionCalls).toBe(0);
		expect(backgroundExecutions).toBe(0);

		const ordinary = await executeTool(
			{ toolUseId: "phase1-ordinary", name: ADMISSION_TOOL_NAME, input: {} },
			makeConfig(async () => ({ behavior: "allow" })),
		);
		expect(ordinary.output).toBe("ordinary complete");
		expect(ordinaryExecutions).toBe(1);

		failScheduledUpdate("test update failed");
		const background = await backgroundPromise;
		expect(background.output).toBe("background started");
		expect(backgroundPermissionCalls).toBe(1);
		expect(backgroundExecutions).toBe(1);
		expect(continuationRecords.some((row) => row.state === "paused")).toBe(true);
		expect(continuationRecords.some((row) => row.state === "completed")).toBe(true);
	});

	test("phase 2 pauses before permission and resumes after update failure", async () => {
		const continuationRecords: Array<Record<string, unknown>> = [];
		stubAdmissionPersistence(continuationRecords);
		let permissionCalls = 0;
		let executions = 0;
		toolRegistry.register({
			name: ADMISSION_TOOL_NAME,
			description: "phase 2 admission tool",
			parameters: z.object({}),
			execute: async () => {
				executions++;
				return { output: "executed" };
			},
		});

		scheduleUpdate("test-version");
		beginQuiescingTools();
		const resultPromise = executeTool(
			{ toolUseId: "phase2-tool", name: ADMISSION_TOOL_NAME, input: {} },
			makeConfig(async () => {
				permissionCalls++;
				return { behavior: "allow" };
			}),
		);
		await waitForCondition(() => getUpdateCoordinationStatus().pausedToolCount === 1);
		expect(permissionCalls).toBe(0);
		expect(executions).toBe(0);

		failScheduledUpdate("test update failed");
		const result = await resultPromise;
		expect(result.output).toBe("executed");
		expect(permissionCalls).toBe(1);
		expect(executions).toBe(1);
	});

	test("phase 2 continuation metadata stays below the database limit for large tool input", async () => {
		const continuationRecords: Array<Record<string, unknown>> = [];
		stubAdmissionPersistence(continuationRecords);
		toolRegistry.register({
			name: ADMISSION_TOOL_NAME,
			description: "large-input deferred tool",
			parameters: z.object({ content: z.string() }),
			execute: async () => ({ output: "executed" }),
		});

		scheduleUpdate("test-version");
		beginQuiescingTools();
		const resultPromise = executeTool(
			{
				toolUseId: "phase2-large-input",
				name: ADMISSION_TOOL_NAME,
				input: { content: "x".repeat(70_000) },
			},
			makeConfig(async () => ({ behavior: "allow" })),
		);
		await waitForCondition(() => getUpdateCoordinationStatus().pausedToolCount === 1);

		const paused = continuationRecords.find((row) => row.state === "paused");
		expect(paused).toBeDefined();
		const payload = paused?.payloadJson as Record<string, unknown> | undefined;
		expect(payload).toBeDefined();
		expect(payload?.input).toBeUndefined();
		expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThan(64 * 1024);

		failScheduledUpdate("test update failed");
		await expect(resultPromise).resolves.toMatchObject({ output: "executed" });
	});

	test("phase-one grants remain started through phase-two deny, unknown, and exception exits", async () => {
		const continuationRecords: Array<Record<string, unknown>> = [];
		stubAdmissionPersistence(continuationRecords);
		toolRegistry.register({
			name: ADMISSION_TOOL_NAME,
			description: "early return after phase switch",
			parameters: z.object({}),
			execute: async () => ({ output: "must not execute" }),
		});
		const unknown = { toolUseId: "granted-unknown", name: "__GrantedUnknown", input: {} };
		const denied = { toolUseId: "granted-denied", name: ADMISSION_TOOL_NAME, input: {} };
		const errored = { toolUseId: "granted-error", name: ADMISSION_TOOL_NAME, input: {} };
		const unknownConfig = makeConfig(async () => ({ behavior: "allow" }));
		const deniedConfig = makeConfig(async () => ({ behavior: "deny", message: "denied" }));
		const erroredConfig = makeConfig(async () => {
			throw new Error("permission failed");
		});
		const unknownAdmission = await preAdmitToolExecution(unknown, unknownConfig);
		const deniedAdmission = await preAdmitToolExecution(denied, deniedConfig);
		const erroredAdmission = await preAdmitToolExecution(errored, erroredConfig);
		expect(getUpdateCoordinationStatus().pendingToolStartGrantCount).toBe(3);

		scheduleUpdate("test-version");
		beginQuiescingTools();
		let checkpointStable = false;
		const checkpointFence = waitForUpdateCheckpointFence().then(() => {
			checkpointStable = true;
		});
		await Promise.resolve();
		expect(checkpointStable).toBe(false);

		const [unknownResult, deniedResult, erroredResult] = await Promise.all([
			executeTool(unknown, unknownConfig, {
				admissionState: unknownAdmission,
				preAdmissionComplete: true,
			}),
			executeTool(denied, deniedConfig, {
				admissionState: deniedAdmission,
				preAdmissionComplete: true,
			}),
			executeTool(errored, erroredConfig, {
				admissionState: erroredAdmission,
				preAdmissionComplete: true,
			}),
		]);

		expect(unknownResult.output).toContain("Unknown tool");
		expect(deniedResult.output).toContain("denied");
		expect(erroredResult.output).toContain("permission failed");
		expect(continuationRecords).toEqual([]);
		await checkpointFence;
		expect(checkpointStable).toBe(true);
		expect(getUpdateCoordinationStatus()).toMatchObject({
			pendingToolStartGrantCount: 0,
			pendingPreAdmissionCount: 0,
			pendingOrdinaryExecutionCount: 0,
			pausedToolCount: 0,
		});
	});

	test("phase 2 pauses unknown, disabled, unauthorized, Agent, Await, and Bash before failures", async () => {
		const continuationRecords: Array<Record<string, unknown>> = [];
		stubAdmissionPersistence(continuationRecords);
		const executed: string[] = [];
		for (const name of [DISABLED_ADMISSION_TOOL_NAME, "Agent", "Await", "Bash"]) {
			toolRegistry.register({
				name,
				description: `phase 2 matrix ${name}`,
				parameters: z.record(z.string(), z.unknown()),
				execute: async () => {
					executed.push(name);
					return { output: `${name} executed` };
				},
			});
		}

		scheduleUpdate("test-version");
		beginQuiescingTools();
		let permissionCalls = 0;
		const basePermission = async () => {
			permissionCalls++;
			return { behavior: "allow" as const };
		};
		const disabledConfig = makeConfig(basePermission);
		disabledConfig.disabledTools = [DISABLED_ADMISSION_TOOL_NAME];
		const unauthorizedConfig = makeConfig(basePermission);
		unauthorizedConfig.allowedTools = [];
		const promises = [
			executeTool(
				{ toolUseId: "matrix-unknown", name: "__UnknownDuringUpdate", input: {} },
				makeConfig(basePermission),
			),
			executeTool(
				{
					toolUseId: "matrix-disabled",
					name: DISABLED_ADMISSION_TOOL_NAME,
					input: {},
				},
				disabledConfig,
			),
			executeTool(
				{ toolUseId: "matrix-unauthorized", name: "Agent", input: {} },
				unauthorizedConfig,
			),
			executeTool(
				{ toolUseId: "matrix-agent", name: "Agent", input: {} },
				makeConfig(basePermission),
			),
			executeTool(
				{ toolUseId: "matrix-await", name: "Await", input: { type: "agent", id: "worker" } },
				makeConfig(basePermission),
			),
			executeTool(
				{ toolUseId: "matrix-bash", name: "Bash", input: { command: "pwd" } },
				makeConfig(basePermission),
			),
		];
		const settled: string[] = [];
		for (const promise of promises) {
			void promise.then((result) => settled.push(result.output));
		}

		await waitForCondition(() => getUpdateCoordinationStatus().pausedToolCount === promises.length);
		expect(settled).toEqual([]);
		expect(executed).toEqual([]);
		expect(permissionCalls).toBe(0);
		expect(
			continuationRecords.filter((row) => row.state === "paused").map((row) => row.toolCallId),
		).toHaveLength(promises.length);

		failScheduledUpdate("test update failed");
		const results = await Promise.all(promises);
		expect(results[0]?.output).toContain("Unknown tool");
		expect(results[1]?.output).toContain("disabled");
		expect(results[2]?.output).toContain("not allowed");
		expect(results.slice(3).every((result) => !result.isError)).toBe(true);
		expect(executed).toEqual(["Agent", "Await", "Bash"]);
	});

	test("phase two pauses a newly requested background Agent", async () => {
		const continuationRecords: Array<Record<string, unknown>> = [];
		stubAdmissionPersistence(continuationRecords);
		let executions = 0;
		toolRegistry.register({
			name: "Agent",
			description: "background Agent phase-two admission",
			parameters: z.object({ run_in_background: z.boolean().optional() }),
			execute: async () => {
				executions++;
				return { output: "background Agent started" };
			},
		});

		scheduleUpdate("test-version");
		beginQuiescingTools();
		const resultPromise = executeTool(
			{
				toolUseId: "phase2-background-agent",
				name: "Agent",
				input: { run_in_background: true },
			},
			makeConfig(async () => ({ behavior: "allow" })),
		);
		await waitForCondition(() => getUpdateCoordinationStatus().pausedToolCount === 1);
		expect(executions).toBe(0);
		expect(continuationRecords.some((row) => row.state === "paused")).toBe(true);

		failScheduledUpdate("test update failed");
		const result = await resultPromise;
		expect(result.output).toBe("background Agent started");
		expect(executions).toBe(1);
	});

	test("phase-one Agent grant converts to resumable execution after phase two", async () => {
		const continuationRecords: Array<Record<string, unknown>> = [];
		stubAdmissionPersistence(continuationRecords);
		let releasePermission!: () => void;
		const permissionGate = new Promise<void>((resolve) => {
			releasePermission = resolve;
		});
		let releaseRunnerLease: (() => void) | undefined;
		toolRegistry.register({
			name: "Agent",
			description: "phase-one Agent grant",
			parameters: z.object({ run_in_background: z.boolean().optional() }),
			execute: async (_args, ctx) => {
				expect(ctx.updateExecutionLease?.kind).toBe("resumable");
				expect(ctx.updateExecutionLease?.transfer()).toBe(true);
				releaseRunnerLease = () => ctx.updateExecutionLease?.release();
				return { output: "Agent started" };
			},
		});

		const resultPromise = executeTool(
			{
				toolUseId: "phase-one-agent",
				name: "Agent",
				input: { run_in_background: true },
			},
			makeConfig(async () => {
				await permissionGate;
				return { behavior: "allow" };
			}),
		);
		await waitForCondition(() => getUpdateCoordinationStatus().pendingToolStartGrantCount === 1);
		scheduleUpdate("test-version");
		beginQuiescingTools();
		let checkpointStable = false;
		const checkpointFence = waitForUpdateCheckpointFence().then(() => {
			checkpointStable = true;
		});
		await Promise.resolve();
		expect(checkpointStable).toBe(false);

		releasePermission();
		const result = await resultPromise;
		await checkpointFence;
		expect(result.output).toBe("Agent started");
		expect(checkpointStable).toBe(true);
		expect(continuationRecords).toEqual([]);
		expect(getUpdateCoordinationStatus()).toMatchObject({
			pendingOrdinaryExecutionCount: 0,
			resumableExecutionCount: 1,
			pendingToolStartGrantCount: 0,
			pausedToolCount: 0,
		});
		expect(capturePlannedUpdateRecoverySnapshot().narrators).toContainEqual({
			narratorId: "narrator-self",
			locale: "en",
		});
		await waitForOrdinaryToolDrain();
		releaseRunnerLease?.();
		expect(getUpdateCoordinationStatus().resumableExecutionCount).toBe(0);
	});

	test("phase-one grant still executes when phase two closes during permission", async () => {
		const continuationRecords: Array<Record<string, unknown>> = [];
		stubAdmissionPersistence(continuationRecords);
		let executions = 0;
		let releaseExecution!: () => void;
		const executionGate = new Promise<void>((resolve) => {
			releaseExecution = resolve;
		});
		toolRegistry.register({
			name: ADMISSION_TOOL_NAME,
			description: "irrevocable phase-one admission tool",
			parameters: z.object({}),
			execute: async () => {
				executions++;
				await executionGate;
				return { output: "executed" };
			},
		});

		scheduleUpdate("test-version");
		const resultPromise = executeTool(
			{ toolUseId: "final-race-tool", name: ADMISSION_TOOL_NAME, input: {} },
			makeConfig(async () => {
				beginQuiescingTools();
				return { behavior: "allow" };
			}),
		);
		await waitForCondition(() => getUpdateCoordinationStatus().pendingOrdinaryExecutionCount === 1);
		expect(executions).toBe(1);
		expect(continuationRecords).toEqual([]);
		expect(getUpdateCoordinationStatus()).toMatchObject({
			phase: "quiescing_tools",
			pendingToolStartGrantCount: 0,
			pendingPreAdmissionCount: 0,
			pausedToolCount: 0,
		});

		let ordinaryDrained = false;
		const ordinaryDrain = waitForOrdinaryToolDrain().then(() => {
			ordinaryDrained = true;
		});
		await Promise.resolve();
		expect(ordinaryDrained).toBe(false);
		releaseExecution();
		const result = await resultPromise;
		await ordinaryDrain;
		expect(result.output).toBe("executed");
		expect(ordinaryDrained).toBe(true);
	});

	test("releases foreground leases and lets background tools transfer ownership", async () => {
		let releaseBackgroundLease: (() => void) | undefined;
		toolRegistry.register({
			name: "Bash",
			description: "lease transfer bash",
			parameters: z.object({ run_in_background: z.boolean().optional() }),
			execute: async (_args, ctx) => {
				expect(ctx.updateExecutionLease?.transfer()).toBe(true);
				releaseBackgroundLease = () => ctx.updateExecutionLease?.release();
				return { output: "background started" };
			},
		});
		toolRegistry.register({
			name: ADMISSION_TOOL_NAME,
			description: "lease release ordinary",
			parameters: z.object({}),
			execute: async () => ({ output: "ordinary complete" }),
		});

		await executeTool(
			{ toolUseId: "lease-ordinary", name: ADMISSION_TOOL_NAME, input: {} },
			makeConfig(async () => ({ behavior: "allow" })),
		);
		expect(getUpdateCoordinationStatus().pendingOrdinaryExecutionCount).toBe(0);

		await executeTool(
			{ toolUseId: "lease-background", name: "Bash", input: { run_in_background: true } },
			makeConfig(async () => ({ behavior: "allow" })),
		);
		expect(getUpdateCoordinationStatus().pendingBackgroundBashCount).toBe(1);
		releaseBackgroundLease?.();
		expect(getUpdateCoordinationStatus().pendingBackgroundBashCount).toBe(0);
	});

	test("a running background Agent is resumable and does not block ordinary drain", async () => {
		let releaseRunnerLease: (() => void) | undefined;
		toolRegistry.register({
			name: "Agent",
			description: "background Agent resumable lease",
			parameters: z.object({ run_in_background: z.boolean().optional() }),
			execute: async (_args, ctx) => {
				expect(ctx.updateExecutionLease?.kind).toBe("resumable");
				expect(ctx.updateExecutionLease?.transfer()).toBe(true);
				releaseRunnerLease = () => ctx.updateExecutionLease?.release();
				return { output: "background Agent started" };
			},
		});

		const result = await executeTool(
			{
				toolUseId: "background-agent-drain",
				name: "Agent",
				input: { run_in_background: true },
			},
			makeConfig(async () => ({ behavior: "allow" })),
		);
		expect(result.output).toBe("background Agent started");
		expect(getUpdateCoordinationStatus()).toMatchObject({
			pendingOrdinaryExecutionCount: 0,
			resumableExecutionCount: 1,
		});

		scheduleUpdate("test-version");
		beginQuiescingTools();
		await waitForOrdinaryToolDrain();
		expect(getUpdateCoordinationStatus().resumableExecutionCount).toBe(1);
		releaseRunnerLease?.();
		expect(getUpdateCoordinationStatus().resumableExecutionCount).toBe(0);
	});
});

describe("executeTool permission guard", () => {
	test("treats spec task queue maintenance as read-only session state", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Write",
				input: { file_path: "spec://tasks.json", content: "{}" },
				permMode: "readOnly",
				cwd: "/tmp/project",
			}),
		).toBe("allow");
		expect(
			resolvePermissionDecision({
				toolName: "Edit",
				input: { file_path: "spec://tasks.json", old_string: "todo", new_string: "doing" },
				permMode: "default",
				cwd: "/tmp/project",
				planMode: true,
			}),
		).toBe("allow");
	});

	test("allows knowledge reads but not knowledge writes in readOnly mode", () => {
		expect(
			resolvePermissionDecision({
				toolName: "KnowledgeSearch",
				input: { query: "runtime policy" },
				permMode: "readOnly",
				cwd: "/tmp/project",
			}),
		).toBe("allow");
		// KnowledgeLibrary only enumerates readable collections / the caller's own personal
		// entries, so it belongs with the reads.
		expect(
			resolvePermissionDecision({
				toolName: "KnowledgeLibrary",
				input: { action: "list_collections" },
				permMode: "readOnly",
				cwd: "/tmp/project",
			}),
		).toBe("allow");
		expect(
			resolvePermissionDecision({
				toolName: "KnowledgeCreate",
				input: { action: "create" },
				permMode: "readOnly",
				cwd: "/tmp/project",
			}),
		).toBe("deny");
	});

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
					severity: "high",
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

	test("enforces the runtime allow-list before permission or execution", async () => {
		let executed = false;
		let permissionCalls = 0;
		toolRegistry.register({
			name: TEST_TOOL_NAME,
			description: "runtime allow-list test",
			parameters: z.object({}),
			execute: async () => {
				executed = true;
				return { output: "executed" };
			},
		});
		const config = makeConfig(async () => {
			permissionCalls++;
			return { behavior: "allow" };
		});
		config.allowedTools = new Set(["KnowledgeRead"]);
		const result = await executeTool(
			{ toolUseId: "runtime-denied", name: TEST_TOOL_NAME, input: {} },
			config,
		);
		expect(executed).toBe(false);
		expect(permissionCalls).toBe(0);
		expect(result.isError).toBe(true);
		expect(result.fatal).toBe(true);
	});

	test("fails closed when the live runtime authorization guard expires", async () => {
		let executed = false;
		toolRegistry.register({
			name: TEST_TOOL_NAME,
			description: "runtime guard test",
			parameters: z.object({}),
			execute: async () => {
				executed = true;
				return { output: "executed" };
			},
		});
		const config = makeConfig(async () => ({ behavior: "allow" }));
		config.allowedTools = [TEST_TOOL_NAME];
		config.runtimeAuthorizationGuard = async () => {
			throw new Error("grant revoked");
		};
		const result = await executeTool(
			{ toolUseId: "runtime-expired", name: TEST_TOOL_NAME, input: {} },
			config,
		);
		expect(executed).toBe(false);
		expect(result.isError).toBe(true);
		expect(result.fatal).toBe(true);
		expect(result.output).toContain("grant revoked");
	});

	test("blocks local routed execution when runtime policy requires the provisioned device", async () => {
		let permissionCalls = 0;
		const config = makeConfig(async () => {
			permissionCalls++;
			return { behavior: "allow" };
		});
		config.allowLocalExecution = false;
		config.availableDevices = [];
		const result = await executeTool(
			{ toolUseId: "runtime-local", name: "Read", input: { file_path: "x.ts" } },
			config,
		);
		expect(permissionCalls).toBe(0);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Execution target error");
	});
});

describe("executeTool blocked-skills guard", () => {
	const alwaysPermit: AgentConfig["permissionHandler"] = async () => ({ behavior: "allow" });

	afterEach(() => {
		toolRegistry.unregister("Skill");
	});

	test("refuses the Skill tool when all skills are blocked", async () => {
		let executed = false;
		const skillStub: ToolDefinition = {
			name: "Skill",
			description: "skill",
			parameters: z.object({ skill: z.string().optional(), name: z.string().optional() }),
			execute: async () => {
				executed = true;
				return { output: "loaded" };
			},
		};
		toolRegistry.register(skillStub);

		const config: AgentConfig = {
			...makeConfig(alwaysPermit),
			blockedSkills: { all: true, names: [] },
		};
		const result = await executeTool(
			{ toolUseId: "skill-all", name: "Skill", input: { skill: "pdf" } },
			config,
		);

		expect(executed).toBe(false);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("disabled");
	});

	test("refuses a specifically blocked skill but allows others", async () => {
		const executed: (string | null)[] = [];
		const skillStub: ToolDefinition = {
			name: "Skill",
			description: "skill",
			parameters: z.object({ skill: z.string().optional(), name: z.string().optional() }),
			execute: async (args) => {
				executed.push((args as { skill?: string }).skill ?? null);
				return { output: "loaded" };
			},
		};
		toolRegistry.register(skillStub);

		const config: AgentConfig = {
			...makeConfig(alwaysPermit),
			blockedSkills: { all: false, names: ["pdf"] },
		};

		const blocked = await executeTool(
			{ toolUseId: "skill-blocked", name: "Skill", input: { skill: "pdf" } },
			config,
		);
		expect(blocked.isError).toBe(true);
		expect(blocked.output).toContain("blocked");
		expect(executed).toEqual([]);

		const allowed = await executeTool(
			{ toolUseId: "skill-allowed", name: "Skill", input: { skill: "commit" } },
			config,
		);
		expect(allowed.isError).toBeFalsy();
		expect(executed).toEqual(["commit"]);
	});
});

describe("executeTool execution target freeze", () => {
	function fakeRemoteBackend(deviceId: string, defaultCwd: string): ExecutionBackend {
		return {
			deviceId,
			kind: "remote",
			defaultCwd,
			platform: { os: "linux", arch: "x64" },
			paths: posixPathSemantics,
			pathFlavor: "posix",
			runtimeGeneration: 1,
			async resolvePathIdentity(path: string) {
				return {
					lexicalPath: posixPathSemantics.normalize(path),
					canonicalPath: posixPathSemantics.normalize(path),
					exists: true,
					runtimeGeneration: 1,
				};
			},
		} as ExecutionBackend;
	}
	const remoteBackend = fakeRemoteBackend("device-remote", "/remote/work");
	const availableRemote = {
		id: remoteBackend.deviceId,
		name: "Remote",
		slug: "remote",
		online: true,
		// These tests cover tool routing, not injection tiers; "global" preserves
		// the pre-change behaviour.
		scope: "global" as const,
	};

	test("persists the resolved remote target before permission handling", async () => {
		setRemoteBackendResolver((deviceId) =>
			deviceId === remoteBackend.deviceId ? remoteBackend : null,
		);
		const order: string[] = [];
		const persistedTargets: ToolExecutionTarget[] = [];
		const config: AgentConfig = {
			...makeConfig(async () => {
				order.push("permission");
				return { behavior: "deny" };
			}),
			defaultDeviceId: remoteBackend.deviceId,
			availableDevices: [availableRemote],
			onExecutionTargetResolved: async (_toolUseId, target) => {
				order.push("persist");
				persistedTargets.push(target);
			},
		};

		const result = await executeTool(
			{ toolUseId: "tool-target-1", name: "Read", input: { file_path: "src/a.ts" } },
			config,
		);

		expect(result.isError).toBe(true);
		expect(order).toEqual(["persist", "permission"]);
		const persistedTarget = persistedTargets[0];
		expect(persistedTarget).toBeDefined();
		expect(persistedTarget).toMatchObject({
			deviceId: "device-remote",
			backendKind: "remote",
			cwd: "/remote/work",
			pathFlavor: "posix",
			lexicalPath: "/remote/work/src/a.ts",
			canonicalPath: "/remote/work/src/a.ts",
			resolvedFilePath: "/remote/work/src/a.ts",
			runtimeGeneration: 1,
			selectionSource: "session_default",
		});
		expect(result.metadata?.executionTarget).toEqual(persistedTarget);
	});

	test("routes an explicit call to a secondary authorized remote device", async () => {
		const secondaryBackend = fakeRemoteBackend("device-secondary", "/secondary/work");
		setRemoteBackendResolver((deviceId) => {
			if (deviceId === remoteBackend.deviceId) return remoteBackend;
			if (deviceId === secondaryBackend.deviceId) return secondaryBackend;
			return null;
		});
		const persistedTargets: ToolExecutionTarget[] = [];
		const result = await executeTool(
			{
				toolUseId: "tool-target-secondary",
				name: "Read",
				input: { file_path: "src/b.ts", device: secondaryBackend.deviceId },
			},
			{
				...makeConfig(async () => ({ behavior: "deny" })),
				defaultDeviceId: remoteBackend.deviceId,
				availableDevices: [
					availableRemote,
					{
						id: secondaryBackend.deviceId,
						name: "Secondary",
						slug: "secondary",
						online: true,
						scope: "global" as const,
					},
				],
				onExecutionTargetResolved: async (_toolUseId, target) => {
					persistedTargets.push(target);
				},
			},
		);

		expect(result.isError).toBe(true);
		expect(persistedTargets[0]).toMatchObject({
			deviceId: secondaryBackend.deviceId,
			cwd: "/secondary/work",
			resolvedFilePath: "/secondary/work/src/b.ts",
			selectionSource: "explicit",
		});
	});

	test("freezes both endpoints for TransferFile", async () => {
		setRemoteBackendResolver((deviceId) =>
			deviceId === remoteBackend.deviceId ? remoteBackend : null,
		);
		const plans: import("../types").ToolExecutionPlan[] = [];
		const result = await executeTool(
			{
				toolUseId: "tool-transfer-plan",
				name: "TransferFile",
				input: {
					direction: "upload",
					device: remoteBackend.deviceId,
					localPath: "/server/source.txt",
					remotePath: "/remote/work/destination.txt",
				},
			},
			{
				...makeConfig(async () => ({ behavior: "deny" })),
				availableDevices: [availableRemote],
				onExecutionPlanResolved: async (_toolUseId, plan) => {
					plans.push(plan);
				},
			},
		);
		expect(result.isError).toBe(true);
		expect(plans[0]).toMatchObject({
			kind: "multi",
			primaryKey: "remote",
			endpoints: [
				{ key: "local", operation: "read", target: { deviceId: "local" } },
				{
					key: "remote",
					operation: "write",
					target: { deviceId: remoteBackend.deviceId },
				},
			],
		});
	});

	test("persists a canonicalized path before the permission decision", async () => {
		setRemoteBackendResolver((deviceId) =>
			deviceId === remoteBackend.deviceId ? remoteBackend : null,
		);
		const order: string[] = [];
		const persistedTargets: ToolExecutionTarget[] = [];
		const redirectedInput = { file_path: "plans/final.md" };
		const config: AgentConfig = {
			...makeConfig(async (_toolName, _input, _toolUseId, options) => {
				order.push("permission:start");
				await options?.onInputResolved?.(redirectedInput);
				order.push("permission:decide");
				return { behavior: "deny" };
			}),
			defaultDeviceId: remoteBackend.deviceId,
			availableDevices: [availableRemote],
			onExecutionTargetResolved: async (_toolUseId, target) => {
				persistedTargets.push(target);
				order.push(`persist:${target.resolvedFilePath}`);
			},
		};

		const result = await executeTool(
			{ toolUseId: "tool-target-redirect", name: "Write", input: { file_path: "draft.md" } },
			config,
		);

		expect(result.isError).toBe(true);
		expect(order).toEqual([
			"persist:/remote/work/draft.md",
			"permission:start",
			"persist:/remote/work/plans/final.md",
			"permission:decide",
		]);
		expect(persistedTargets.at(-1)?.resolvedFilePath).toBe("/remote/work/plans/final.md");
		expect(result.metadata?.executionTarget).toEqual(persistedTargets.at(-1));
	});

	test("rejects a path redirect that was not frozen before approval", async () => {
		setRemoteBackendResolver((deviceId) =>
			deviceId === remoteBackend.deviceId ? remoteBackend : null,
		);
		let persistedCount = 0;
		const config: AgentConfig = {
			...makeConfig(async () => ({
				behavior: "allow",
				updatedInput: { file_path: "plans/late.md" },
			})),
			defaultDeviceId: remoteBackend.deviceId,
			availableDevices: [availableRemote],
			onExecutionTargetResolved: async () => {
				persistedCount++;
			},
		};

		const result = await executeTool(
			{ toolUseId: "tool-target-late", name: "Read", input: { file_path: "draft.md" } },
			config,
		);

		expect(result.isError).toBe(true);
		expect(result.output).toContain("not frozen before approval");
		expect(persistedCount).toBe(1);
	});

	test("does not allow permission redirection to change the frozen device", async () => {
		setRemoteBackendResolver((deviceId) =>
			deviceId === remoteBackend.deviceId ? remoteBackend : null,
		);
		let persistedCount = 0;
		const config: AgentConfig = {
			...makeConfig(async () => ({
				behavior: "allow",
				updatedInput: { file_path: "src/a.ts", device: "local" },
			})),
			availableDevices: [availableRemote],
			onExecutionTargetResolved: async () => {
				persistedCount++;
			},
		};

		const result = await executeTool(
			{
				toolUseId: "tool-target-2",
				name: "Read",
				input: { file_path: "src/a.ts", device: remoteBackend.deviceId },
			},
			config,
		);

		expect(result.isError).toBe(true);
		expect(result.output).toContain("attempted to change");
		expect(result.output).toContain("device-remote");
		expect(persistedCount).toBe(1);
	});

	test("rejects an online explicit device outside availableDevices before permission", async () => {
		setRemoteBackendResolver((deviceId) =>
			deviceId === remoteBackend.deviceId ? remoteBackend : null,
		);
		let permissionCalled = false;
		let persisted = false;
		const result = await executeTool(
			{
				toolUseId: "tool-target-unauthorized-explicit",
				name: "Read",
				input: { file_path: "src/a.ts", device: remoteBackend.deviceId },
			},
			{
				...makeConfig(async () => {
					permissionCalled = true;
					return { behavior: "allow" };
				}),
				availableDevices: [],
				onExecutionTargetResolved: async () => {
					persisted = true;
				},
			},
		);

		expect(result.isError).toBe(true);
		expect(result.output).toContain("not authorized for this narrator session");
		expect(permissionCalled).toBe(false);
		expect(persisted).toBe(false);
	});

	test("rejects a stale session default even when its resolver is online", async () => {
		setRemoteBackendResolver((deviceId) =>
			deviceId === remoteBackend.deviceId ? remoteBackend : null,
		);
		let permissionCalled = false;
		const result = await executeTool(
			{ toolUseId: "tool-target-unauthorized-default", name: "Read", input: { file_path: "x" } },
			{
				...makeConfig(async () => {
					permissionCalled = true;
					return { behavior: "allow" };
				}),
				defaultDeviceId: remoteBackend.deviceId,
				availableDevices: [
					{
						id: "other-device",
						name: "Other",
						slug: "other",
						online: true,
						scope: "global" as const,
					},
				],
			},
		);

		expect(result.isError).toBe(true);
		expect(result.output).toContain("session default");
		expect(result.output).toContain("not authorized");
		expect(permissionCalled).toBe(false);
	});

	test("fails an unavailable default before permission and never falls back locally", async () => {
		setRemoteBackendResolver(() => null);
		const localPath = join(tmpdir(), `narrafork-no-fallback-${Date.now()}.txt`);
		rmSync(localPath, { force: true });
		let permissionCalled = false;
		let persisted = false;
		const config: AgentConfig = {
			...makeConfig(async () => {
				permissionCalled = true;
				return { behavior: "allow" };
			}),
			defaultDeviceId: "offline-device",
			availableDevices: [
				{
					id: "offline-device",
					name: "Offline",
					slug: "offline",
					online: false,
					scope: "global" as const,
				},
			],
			onExecutionTargetResolved: async () => {
				persisted = true;
			},
		};

		const result = await executeTool(
			{
				toolUseId: "tool-target-3",
				name: "Write",
				input: { file_path: localPath, content: "must never be written locally" },
			},
			config,
		);

		expect(result.isError).toBe(true);
		expect(result.output).toContain("was not run locally");
		expect(permissionCalled).toBe(false);
		expect(persisted).toBe(false);
		expect(existsSync(localPath)).toBe(false);
		rmSync(localPath, { force: true });
	});

	test("re-running with a preFrozenTarget reproduces the original local identity", async () => {
		// Regression for "already frozen ... after permission handling has begun".
		// The original live pass ran with no session default → selectionSource
		// "local_default". reExecuteDeniedToolCall would otherwise seed defaultDeviceId
		// with the frozen "local" device, recomputing selectionSource to
		// "session_default" and tripping the persistence guard. Passing the frozen
		// target back via preFrozenTarget must reproduce the identity byte-for-byte.
		const persisted: ToolExecutionTarget[] = [];
		const config: AgentConfig = {
			...makeConfig(async () => ({ behavior: "allow" })),
			defaultDeviceId: undefined,
			onExecutionTargetResolved: async (_toolUseId, target) => {
				persisted.push(target);
			},
		};

		await executeTool(
			{ toolUseId: "tool-local-original", name: "Read", input: { file_path: "src/a.ts" } },
			config,
		);
		const original = persisted[0];
		expect(original?.deviceId).toBe("local");
		expect(original?.selectionSource).toBe("local_default");

		// Re-run pass: defaultDeviceId is now the frozen "local" device id (as
		// reExecuteDeniedToolCall seeds it), but preFrozenTarget pins the identity.
		const rerunConfig: AgentConfig = {
			...makeConfig(async () => ({ behavior: "allow" })),
			defaultDeviceId: "local",
			onExecutionTargetResolved: async (_toolUseId, target) => {
				persisted.push(target);
			},
		};
		await executeTool(
			{ toolUseId: "tool-local-rerun", name: "Read", input: { file_path: "src/a.ts" } },
			rerunConfig,
			{ preGrantedPermission: { behavior: "allow" }, preFrozenTarget: original },
		);

		expect(persisted).toHaveLength(2);
		// Re-run reproduces the SAME identity, including the audit-only selectionSource.
		expect(persisted[1]).toEqual(original);
	});

	test("re-running with a preFrozenTarget pins a remote identity", async () => {
		setRemoteBackendResolver((deviceId) =>
			deviceId === remoteBackend.deviceId ? remoteBackend : null,
		);
		const persisted: ToolExecutionTarget[] = [];
		const config: AgentConfig = {
			...makeConfig(async () => ({ behavior: "allow" })),
			defaultDeviceId: remoteBackend.deviceId,
			availableDevices: [availableRemote],
			onExecutionTargetResolved: async (_toolUseId, target) => {
				persisted.push(target);
			},
		};

		await executeTool(
			{ toolUseId: "tool-remote-original", name: "Read", input: { file_path: "src/a.ts" } },
			config,
		);
		const original = persisted[0];
		expect(original).toMatchObject({
			deviceId: "device-remote",
			backendKind: "remote",
			cwd: "/remote/work",
			pathFlavor: "posix",
			lexicalPath: "/remote/work/src/a.ts",
			canonicalPath: "/remote/work/src/a.ts",
			resolvedFilePath: "/remote/work/src/a.ts",
			runtimeGeneration: 1,
			selectionSource: "session_default",
		});

		// Re-run with no availableDevices/defaultDeviceId still reproduces the frozen
		// remote target because preFrozenTarget resolves the backend directly.
		const rerunConfig: AgentConfig = {
			...makeConfig(async () => ({ behavior: "allow" })),
			onExecutionTargetResolved: async (_toolUseId, target) => {
				persisted.push(target);
			},
		};
		await executeTool(
			{ toolUseId: "tool-remote-rerun", name: "Read", input: { file_path: "src/a.ts" } },
			rerunConfig,
			{ preGrantedPermission: { behavior: "allow" }, preFrozenTarget: original },
		);

		expect(persisted).toHaveLength(2);
		expect(persisted[1]).toEqual(original);
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

	test("inherit override follows the current global setting at decision time", () => {
		const config = {
			permissionMode: "bypassPermissions",
			planReflectionAutoApproveOverride: "inherit" as const,
		};

		setPlanReflectionAutoApprove(false);
		expect(shouldRunExitPlanModeReflection(config)).toBe(false);

		setPlanReflectionAutoApprove(true);
		expect(shouldRunExitPlanModeReflection(config)).toBe(true);
	});

	test("explicit session override takes precedence over the global setting", () => {
		setPlanReflectionAutoApprove(false);
		expect(
			shouldRunExitPlanModeReflection({
				permissionMode: "bypassPermissions",
				planReflectionAutoApproveOverride: "on",
			}),
		).toBe(true);

		setPlanReflectionAutoApprove(true);
		expect(
			shouldRunExitPlanModeReflection({
				permissionMode: "bypassPermissions",
				planReflectionAutoApproveOverride: "off",
			}),
		).toBe(false);
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

	test("auto-compact reflection tool requires its setting", () => {
		setPlanReflectionAllowAutoCompact(false);
		expect(getExitPlanReflectionAllowedTools()).not.toContain(EXIT_PLAN_CONFIRM_COMPACT_TOOL_NAME);

		setPlanReflectionAllowAutoCompact(true);
		expect(getExitPlanReflectionAllowedTools()).toContain(EXIT_PLAN_CONFIRM_COMPACT_TOOL_NAME);
	});

	test("auto-compact prompt is appended only when enabled", () => {
		const input = { plan: "Implement the approved change." };

		setPlanReflectionAllowAutoCompact(false);
		expect(buildExitPlanReflectionPrompt("req-1", input, "en")).not.toContain(
			EXIT_PLAN_CONFIRM_COMPACT_TOOL_NAME,
		);

		setPlanReflectionAllowAutoCompact(true);
		expect(buildExitPlanReflectionPrompt("req-1", input, "en")).toContain(
			EXIT_PLAN_CONFIRM_COMPACT_TOOL_NAME,
		);
	});

	// `allowedPrompts` never granted a permission — its only consumer was a
	// section of this prompt. It is retired, so neither the section nor an
	// unreplaced placeholder may survive in either locale.
	test("no retired allowedPrompts section or leftover placeholder", () => {
		setPlanReflectionAllowAutoCompact(false);
		const input = {
			plan: "Implement the approved change.",
			allowedPrompts: [{ tool: "Bash", prompt: "install dependencies" }],
		};

		for (const locale of ["en", "zh-CN"] as const) {
			const prompt = buildExitPlanReflectionPrompt("req-1", input, locale);
			expect(prompt).not.toContain("{allowedPromptsList}");
			expect(prompt).not.toContain("Prompt-based permissions requested");
			expect(prompt).not.toContain("可选的实现权限说明");
			// The plan itself still reaches the reflection loop.
			expect(prompt).toContain("Implement the approved change.");
		}
	});
});

describe("taskReflection protected-task repair guidance", () => {
	const assistantConstraintMutation = {
		kind: "complete" as const,
		text: "Never modify files outside the terminal feature",
		fromStatus: "doing" as const,
		toStatus: "done" as const,
		details: "Protected task was marked done.",
		createdBy: "assistant" as const,
	};

	test("distinguishes malformed assistant constraints from user commitments", () => {
		const en = buildTaskReflectionPrompt(
			"task-reflect-1",
			{ file_path: "spec://tasks.json" },
			[assistantConstraintMutation],
			"en",
		);
		const zh = buildTaskReflectionPrompt(
			"task-reflect-1",
			{ file_path: "spec://tasks.json" },
			[assistantConstraintMutation],
			"zh-CN",
		);

		// The reviewer's question is about INTENT, not about task formalities. This was
		// previously framed evidence-first ("is there concrete evidence it is complete"),
		// which has no upper bound — a reviewer can always name one more unproven thing.
		// One real session spent 1.5 hours on five consecutive denials of a task titled
		// "阶段 0-4 全量验收"; by the last round the full 3067-test suite passed and it was
		// still denied for lacking a standalone benchmark.
		expect(en).toContain("betray what the user actually asked for");
		expect(en).toContain("not the standard itself");
		expect(zh).toContain("是否违背了用户真正要求的东西");
		expect(zh).toContain("不是审核标准本身");

		// An unbounded entry must be repairable by rewriting it into a finite task, rather
		// than being held open forever.
		expect(en).toContain("no decidable completion condition");
		expect(en).toContain("legitimate repair");
		expect(zh).toContain("没有可判定的完成条件");
		expect(zh).toContain("合法纠正");

		// A denial has to be actionable: if no passing instruction can be written, the task
		// shape is the problem.
		expect(en).toContain("do this and it passes");
		expect(zh).toContain("做完这一步就能通过");

		// Origin still weights conservatism, but no longer decides the outcome.
		expect(en).toContain("createdBy=user, system, or unknown");
		expect(zh).toContain("createdBy=user、system 或 unknown");
	});

	test("builds a status- and order-independent denial fingerprint", () => {
		const userMutation = {
			...assistantConstraintMutation,
			kind: "delete" as const,
			text: "Ship the release",
			toStatus: "deleted" as const,
			createdBy: "user" as const,
		};
		const sameConstraintFromTodo = {
			...assistantConstraintMutation,
			fromStatus: "todo" as const,
		};
		expect(buildTaskReflectionDenialFingerprint([assistantConstraintMutation, userMutation])).toBe(
			buildTaskReflectionDenialFingerprint([userMutation, sameConstraintFromTodo]),
		);
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
				{ toolUseId: "tu-context", name: "ContextAsk", input: { id: "sibling-1" } },
				relaxedPlanConfig,
			),
		).resolves.toBe(false);
		await expect(
			shouldInjectRelaxedPlanToolReminder(
				{
					toolUseId: "tu-task-write",
					name: "Write",
					input: { file_path: "spec://tasks.json", content: "{}" },
				},
				relaxedPlanConfig,
			),
		).resolves.toBe(false);
		await expect(
			shouldInjectRelaxedPlanToolReminder(
				{
					toolUseId: "tu-task-edit",
					name: "Edit",
					input: { file_path: "spec://tasks.json", old_string: "todo", new_string: "doing" },
				},
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

	test("ignores writes to the plan file itself", async () => {
		// The reminder exists to say "you are planning, not implementing". Attaching it to
		// the ONE write plan mode asked for tells the model its correct action was suspect,
		// which is the opposite of the intent.
		await expect(
			shouldInjectRelaxedPlanToolReminder(
				{
					toolUseId: "tu-plan-write",
					name: "Write",
					input: { file_path: ".narrafork/plans/plan-abc.md", content: "# Plan" },
				},
				relaxedPlanConfig,
			),
		).resolves.toBe(false);
		// Relaxed plan mode lets the model pick its own file inside the plan directory.
		await expect(
			shouldInjectRelaxedPlanToolReminder(
				{
					toolUseId: "tu-plan-write-custom",
					name: "Write",
					input: { file_path: "/tmp/.narrafork/plans/my-plan.md", content: "# Plan" },
				},
				relaxedPlanConfig,
			),
		).resolves.toBe(false);
		await expect(
			shouldInjectRelaxedPlanToolReminder(
				{
					toolUseId: "tu-plan-edit",
					name: "Edit",
					input: {
						file_path: ".narrafork/plans/plan-abc.md",
						old_string: "a",
						new_string: "b",
					},
				},
				relaxedPlanConfig,
			),
		).resolves.toBe(false);
		// A cycle anchored to the pre-`plans/` layout writes outside the directory, and
		// that file is just as much the plan.
		await expect(
			shouldInjectRelaxedPlanToolReminder(
				{
					toolUseId: "tu-legacy-plan-write",
					name: "Write",
					input: { file_path: ".narrafork/plan-abc.md", content: "# Plan" },
				},
				{ ...relaxedPlanConfig, planFilePath: ".narrafork/plan-abc.md" },
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
		// A `.md` outside the plan directory is documentation, not the plan.
		await expect(
			shouldInjectRelaxedPlanToolReminder(
				{ toolUseId: "tu-doc-write", name: "Write", input: { file_path: "docs/NOTES.md" } },
				relaxedPlanConfig,
			),
		).resolves.toBe(true);
		// The legacy plan path only counts when the cycle is actually anchored to it.
		await expect(
			shouldInjectRelaxedPlanToolReminder(
				{
					toolUseId: "tu-legacy-unanchored",
					name: "Write",
					input: { file_path: ".narrafork/plan-abc.md" },
				},
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

describe("Subagent selector matching", () => {
	const candidate = {
		id: "subagent-abc123",
		title: "Explore Payment Flow",
		traits: [`${SUBAGENT_ALIAS_TRAIT_PREFIX}payment-explorer`],
	};

	test("matches IDs, title slugs, and persisted aliases consistently", () => {
		expect(subagentMatchesSelector(candidate, "subagent-abc123")).toBe(true);
		expect(subagentMatchesSelector(candidate, "subagent-abc")).toBe(true);
		expect(subagentMatchesSelector(candidate, "Explore Payment Flow")).toBe(true);
		expect(subagentMatchesSelector(candidate, "explore-payment-flow")).toBe(true);
		expect(subagentMatchesSelector(candidate, "payment-explorer")).toBe(true);
		expect(subagentMatchesSelector(candidate, "other-agent")).toBe(false);
	});
});

describe("Browser screenshot file output permission integration", () => {
	test("accepts file_path for screenshot and treats it as a write path", () => {
		const input = {
			action: "screenshot",
			session_id: "session-test",
			file_path: "artifacts/browser-shot.png",
		};
		const cwd = "/tmp/narrafork-test";

		expect(browserTool.parameters.safeParse(input).success).toBe(true);
		expect(extractToolPaths("Browser", input)).toEqual(["artifacts/browser-shot.png"]);
		expect(
			resolvePermissionDecision({ toolName: "Browser", input, cwd, permMode: "default" }),
		).toBe("ask");
		expect(
			resolvePermissionDecision({ toolName: "Browser", input, cwd, permMode: "bypassPermissions" }),
		).toBe("allow");
	});

	test("blocks screenshot writes into protected paths", () => {
		const cwd = "/tmp/narrafork-test";
		const input = {
			action: "screenshot",
			session_id: "session-test",
			file_path: ".git/browser-shot.png",
		};
		const meta: { blacklistReason?: string } = {};

		expect(
			resolvePermissionDecision({
				toolName: "Browser",
				input,
				cwd,
				permMode: "bypassPermissions",
				meta,
			}),
		).toBe("deny");
		expect(meta.blacklistReason).toContain(".git");
	});

	test("ignores file_path on non-screenshot Browser actions", () => {
		const input = {
			action: "launch",
			url: "https://example.com",
			file_path: "ignored.png",
		};

		expect(extractToolPaths("Browser", input)).toEqual([]);
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

describe("ExitPlanMode custom plan file resolution", () => {
	test("resolves a custom Markdown plan file in relaxed plan mode", async () => {
		const narratorId = `plan-file-test-${Date.now()}`;
		const cwd = mkdtempSync(join(tmpdir(), "narrafork-plan-"));
		try {
			const plan = "# Custom plan\n\n- Keep the implementation focused.\n";
			mkdirSync(join(cwd, ".narrafork", "plans"), { recursive: true });
			writeFileSync(join(cwd, ".narrafork", "plans", "custom.md"), plan, "utf8");
			activeNarrators.set(narratorId, { _planFileId: "default-plan" } as never);

			const result = await resolveExitPlanModeInput(
				narratorId,
				cwd,
				{ plan_file_path: ".narrafork/plans/custom.md" },
				"en",
				true,
			);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.resolvedFromFile).toBe(true);
				expect(result.input.plan).toBe(plan);
				expect(result.input._planFile).toBe(".narrafork/plans/custom.md");
			}
		} finally {
			activeNarrators.delete(narratorId);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("rejects a custom plan path that is not Markdown", async () => {
		const narratorId = `plan-file-invalid-${Date.now()}`;
		const cwd = mkdtempSync(join(tmpdir(), "narrafork-plan-"));
		try {
			// Inside the plan directory, so the failure is unambiguously about the extension.
			mkdirSync(join(cwd, ".narrafork", "plans"), { recursive: true });
			writeFileSync(join(cwd, ".narrafork", "plans", "plan.txt"), "not a Markdown plan", "utf8");
			activeNarrators.set(narratorId, { _planFileId: "default-plan" } as never);

			const result = await resolveExitPlanModeInput(
				narratorId,
				cwd,
				{ plan_file_path: ".narrafork/plans/plan.txt" },
				"en",
				true,
			);

			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.message).toContain("Markdown");
		} finally {
			activeNarrators.delete(narratorId);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("rejects a custom plan path outside the plan directory", async () => {
		const narratorId = `plan-file-outside-${Date.now()}`;
		const cwd = mkdtempSync(join(tmpdir(), "narrafork-plan-"));
		try {
			writeFileSync(join(cwd, "custom.md"), "# Plan outside the plan directory\n", "utf8");
			activeNarrators.set(narratorId, { _planFileId: "default-plan" } as never);

			const result = await resolveExitPlanModeInput(
				narratorId,
				cwd,
				{ plan_file_path: "custom.md" },
				"en",
				true,
			);

			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.message).toContain(".narrafork/plans");
		} finally {
			activeNarrators.delete(narratorId);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("rejects an oversized custom plan file before reading it", async () => {
		const narratorId = `plan-file-large-${Date.now()}`;
		const cwd = mkdtempSync(join(tmpdir(), "narrafork-plan-"));
		try {
			mkdirSync(join(cwd, ".narrafork", "plans"), { recursive: true });
			writeFileSync(
				join(cwd, ".narrafork", "plans", "large.md"),
				"x".repeat(MAX_PLAN_FILE_BYTES + 1),
				"utf8",
			);
			activeNarrators.set(narratorId, { _planFileId: "default-plan" } as never);

			const result = await resolveExitPlanModeInput(
				narratorId,
				cwd,
				{ plan_file_path: ".narrafork/plans/large.md" },
				"en",
				true,
			);

			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.message).toContain("maximum supported size");
		} finally {
			activeNarrators.delete(narratorId);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
