import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { getAgentFileReferenceContext } from "@server/services/file-reference-context";
import type { WorkspaceContext } from "@shared/workspace-context";
import { z } from "zod/v4";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import { switchDeviceTool } from "../tools/switch-device";
import { switchWorkingDirectoryTool } from "../tools/switch-working-directory";
import type { AgentConfig, AgentEvent } from "../types";

const initial: WorkspaceContext = {
	revision: 0,
	deviceId: "local",
	cwd: "/old",
	pathFlavor: "posix",
	contextKey: "old",
	capabilities: { switchDirectory: true },
};
let current = initial;
let invalidated = false;
let streaming = false;
let writes: string[] = [];
let scenario: "switch-write" | "background-switch" | "device-switch" | "write" | "late-old" =
	"switch-write";
let backgroundResult: (() => { cwd: string; targetCwd: string | undefined }) | undefined;
const provider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		params.onRequestStart?.();
		streaming = true;
		if (
			scenario === "switch-write" ||
			scenario === "background-switch" ||
			scenario === "device-switch"
		) {
			yield {
				toolUses: [
					...(scenario === "background-switch" || scenario === "device-switch"
						? [
								{
									name: "Bash",
									toolUseId: "background",
									input: { command: "pwd", run_in_background: true },
								},
							]
						: []),
					{
						name: scenario === "device-switch" ? "SwitchDevice" : "SwitchWorkingDirectory",
						toolUseId: "switch",
						input:
							scenario === "device-switch"
								? { device: "remote" }
								: {
										expectedRevision: 0,
										requestId: "request",
										target: { deviceId: "local", cwd: "/new" },
									},
					},
					{
						name: "Write",
						toolUseId: "write-old",
						input: { file_path: "test.txt", content: "old" },
					},
				],
			};
		} else {
			yield {
				toolUses: [
					{
						name: "Write",
						toolUseId: "write-new",
						input: { file_path: "test.txt", content: "new" },
					},
				],
			};
		}
		yield { text: "stream is still open" };
		streaming = false;
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const realProvider = { ...(await import("../provider")) };
mock.module("../provider", () => ({
	getProvider: () => provider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:model",
		provider: "test",
		model: "test:model",
		adapter: provider,
	}),
}));
const { agentLoop } = await import("../loop");
const savedWrite = toolRegistry.get("Write");
const savedSwitch = toolRegistry.get("SwitchWorkingDirectory");
const savedBash = toolRegistry.get("Bash");
const savedDevice = toolRegistry.get("SwitchDevice");
toolRegistry.register(switchDeviceTool);
toolRegistry.register({
	name: "Bash",
	description: "Frozen background fixture",
	parameters: z.object({ command: z.string(), run_in_background: z.boolean() }),
	executionRouting: { kind: "single", resolve: () => ({ key: "primary", operation: "execute" }) },
	async execute(_input, ctx) {
		backgroundResult = () => ({ cwd: ctx.cwd, targetCwd: ctx.executionTarget?.cwd });
		return { output: "background started" };
	},
});
toolRegistry.register(switchWorkingDirectoryTool);
toolRegistry.register({
	name: "Write",
	description: "Test write",
	parameters: z.object({ file_path: z.string(), content: z.string() }),
	async execute(_input, ctx) {
		writes.push(ctx.cwd);
		return { output: "written" };
	},
});

afterAll(() => {
	mock.module("../provider", () => realProvider);
	toolRegistry.unregister("Write");
	toolRegistry.unregister("SwitchWorkingDirectory");
	if (savedWrite) toolRegistry.register(savedWrite);
	if (savedSwitch) toolRegistry.register(savedSwitch);
	toolRegistry.unregister("Bash");
	if (savedBash) toolRegistry.register(savedBash);
	toolRegistry.unregister("SwitchDevice");
	if (savedDevice) toolRegistry.register(savedDevice);
	mock.restore();
});
beforeEach(() => {
	current = initial;
	invalidated = false;
	streaming = false;
	writes = [];
	backgroundResult = undefined;
	scenario = "switch-write";
});
function config(context: WorkspaceContext): AgentConfig {
	return {
		narratorId: "workspace-test",
		conversationId: "workspace-conversation",
		model: "test:model",
		provider: "test",
		cwd: context.cwd,
		workspaceContext: context,
		signal: new AbortController().signal,
		maxTurns: 1,
		permissionHandler: async () => ({ behavior: "allow" }),
		assertWorkspaceCurrent: () => {
			if (invalidated || current.revision !== context.revision)
				throw new Error("Stale workspace pass");
		},
		shouldStop: () => invalidated,
		switchWorkingDirectory: async () => {
			expect(streaming).toBe(false);
			current = { ...initial, revision: 1, cwd: "/new", contextKey: "new" };
			invalidated = true;
			return { changed: true, previous: initial, current };
		},
	};
}
async function run(conf: AgentConfig) {
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(conf, "switch then write", [])) events.push(event);
	return events;
}

describe("workspace switch pass barrier", () => {
	test("SwitchDevice is a strict streaming barrier and leaves started background execution frozen", async () => {
		scenario = "device-switch";
		const conf = config(initial);
		conf.availableDevices = [
			{
				id: "remote",
				slug: "remote",
				scope: "global",
				name: "remote",
				online: true,
				defaultCwd: "/remote",
			},
		];
		conf.setDefaultDevice = async () => {
			expect(streaming).toBe(false);
			current = {
				...initial,
				deviceId: "remote",
				revision: 1,
				cwd: "/remote",
				contextKey: "remote",
				capabilities: { switchDirectory: false },
			};
			invalidated = true;
			return true;
		};
		const events = await run(conf);
		expect(
			events.filter((event) => event.type === "tool_result" && event.toolName === "SwitchDevice"),
		).toMatchObject([{ isError: false }]);
		expect(backgroundResult?.()).toEqual({ cwd: "/old", targetCwd: "/old" });
		expect(conf.defaultDeviceId).toBeUndefined();
		expect(writes).toEqual([]);
		expect(
			events.filter((event) => event.type === "tool_result" && event.toolName === "Write"),
		).toMatchObject([{ isError: true, metadata: { skippedForSoftStop: true } }]);
		invalidated = false;
		scenario = "write";
		const next = config(current);
		next.defaultDeviceId = "remote";
		await run(next);
		expect(writes).toEqual(["/remote"]);
		expect(backgroundResult?.()).toEqual({ cwd: "/old", targetCwd: "/old" });
	});
	test("the actual body boundary rechecks actor authorization after an awaited preparation", async () => {
		scenario = "write";
		let revoked = false;
		const conf = config(initial);
		conf.runtimeAuthorizationGuard = async () => {
			if (revoked) throw new Error("Actor grant was revoked");
		};
		conf.onToolExecutionBefore = async () => {
			revoked = true;
		};
		const events = await run(conf);
		expect(writes).toEqual([]);
		expect(
			events.some(
				(event) =>
					event.type === "tool_result" &&
					event.isError &&
					event.output.includes("Actor grant was revoked"),
			),
		).toBe(true);
	});
	test("an already-started background call retains the executor's frozen target after switch", async () => {
		scenario = "background-switch";
		await run(config(initial));
		expect(current.revision).toBe(1);
		expect(backgroundResult?.()).toEqual({ cwd: "/old", targetCwd: "/old" });
		expect(writes).toEqual([]);
	});
	test("Switch→Write in one response never eagerly writes or mixes cwd", async () => {
		const events = await run(config(initial));
		expect(
			events.filter(
				(event) =>
					event.type === "error" ||
					(event.type === "tool_result" &&
						event.toolName === "SwitchWorkingDirectory" &&
						event.isError),
			),
		).toEqual([]);
		expect(
			events.filter((event) => event.type === "tool_result" && event.toolName === "Write"),
		).toMatchObject([{ isError: true, metadata: { skippedForSoftStop: true } }]);
		expect(current.revision).toBe(1);
		expect(writes).toEqual([]);
		expect(
			events.some(
				(event) =>
					event.type === "tool_result" &&
					event.toolName === "SwitchWorkingDirectory" &&
					!event.isError,
			),
		).toBe(true);
	});
	test("the next rebuilt pass uses the new cwd; prior background closure stays frozen", async () => {
		const oldPass = config(initial);
		const background = () => oldPass.cwd;
		const oldLink = getAgentFileReferenceContext(oldPass);
		await run(oldPass);
		invalidated = false;
		scenario = "write";
		await run(config(current));
		expect(writes).toEqual(["/new"]);
		expect(background()).toBe("/old");
		expect(oldLink?.cwd).toBe("/old");
		expect(getAgentFileReferenceContext(oldPass)?.cwd).toBe("/old");
	});
	test("a stale deferred pass is rejected at real executor admission", async () => {
		const oldPass = config(initial);
		current = { ...initial, revision: 1, cwd: "/new", contextKey: "new" };
		scenario = "late-old";
		const events = await run(oldPass);
		expect(writes).toEqual([]);
		expect(events.some((event) => event.type === "tool_result" && event.isError)).toBe(true);
	});
});
