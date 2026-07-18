import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
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
import { settings } from "../../settings";
import type { ExecutionBackend } from "../execution/backend";
import { setRemoteBackendResolver } from "../execution/registry";
import {
	buildExitPlanReflectionPrompt,
	getExitPlanReflectionAllowedTools,
	shouldInjectRelaxedPlanToolReminder,
	shouldRunExitPlanModeReflection,
} from "../loop";
import { executeTool } from "../tool-executor";
import { toolRegistry } from "../tool-registry";
import { browserTool } from "../tools/browser";
import { dangerCancelTool, dangerConfirmTool } from "../tools/danger-reflection";
import { EXIT_PLAN_CONFIRM_COMPACT_TOOL_NAME } from "../tools/exit-plan-reflection";
import {
	type AgentConfig,
	type PermissionResult,
	PLAN_MODE_ALLOWED_TOOLS,
	type ToolDefinition,
	type ToolExecutionTarget,
} from "../types";

const TEST_TOOL_NAME = "__ExecutorGuardTest";

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
	};
}

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
	const remoteBackend = {
		deviceId: "device-remote",
		kind: "remote",
		defaultCwd: "/remote/work",
		platform: { os: "linux", arch: "x64" },
	} as ExecutionBackend;
	const availableRemote = {
		id: remoteBackend.deviceId,
		name: "Remote",
		slug: "remote",
		online: true,
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
		expect(persistedTarget).toEqual({
			deviceId: "device-remote",
			backendKind: "remote",
			cwd: "/remote/work",
			resolvedFilePath: "/remote/work/src/a.ts",
			selectionSource: "session_default",
		});
		expect(result.metadata?.executionTarget).toEqual(persistedTarget);
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
				availableDevices: [{ id: "other-device", name: "Other", slug: "other", online: true }],
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
			availableDevices: [{ id: "offline-device", name: "Offline", slug: "offline", online: false }],
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
		expect(original).toEqual({
			deviceId: "device-remote",
			backendKind: "remote",
			cwd: "/remote/work",
			resolvedFilePath: "/remote/work/src/a.ts",
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
			writeFileSync(join(cwd, "custom.md"), plan, "utf8");
			activeNarrators.set(narratorId, { _planFileId: "default-plan" } as never);

			const result = await resolveExitPlanModeInput(
				narratorId,
				cwd,
				{ plan_file_path: "custom.md" },
				"en",
				true,
			);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.resolvedFromFile).toBe(true);
				expect(result.input.plan).toBe(plan);
				expect(result.input._planFile).toBe("custom.md");
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
			writeFileSync(join(cwd, "plan.txt"), "not a Markdown plan", "utf8");
			activeNarrators.set(narratorId, { _planFileId: "default-plan" } as never);

			const result = await resolveExitPlanModeInput(
				narratorId,
				cwd,
				{ plan_file_path: "plan.txt" },
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

	test("rejects an oversized custom plan file before reading it", async () => {
		const narratorId = `plan-file-large-${Date.now()}`;
		const cwd = mkdtempSync(join(tmpdir(), "narrafork-plan-"));
		try {
			writeFileSync(join(cwd, "large.md"), "x".repeat(MAX_PLAN_FILE_BYTES + 1), "utf8");
			activeNarrators.set(narratorId, { _planFileId: "default-plan" } as never);

			const result = await resolveExitPlanModeInput(
				narratorId,
				cwd,
				{ plan_file_path: "large.md" },
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
