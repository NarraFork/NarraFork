import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "@server/lib/agent/tool-executor";
import { MAX_BYTES } from "@server/lib/agent/truncate";
import type { AgentConfig, AgentToolUse, ToolCallBinding } from "@server/lib/agent/types";
import { parseManifest } from "@server/lib/plugins/manifest";
import {
	PLUGIN_TOOL_INPUT_FRAME_MAX_BYTES,
	PLUGIN_TOOL_INPUT_MAX_BYTES,
	PLUGIN_TOOL_OUTPUT_FRAME_MAX_BYTES,
	PLUGIN_TOOL_OUTPUT_MAX_BYTES,
} from "@server/lib/plugins/protocol";
import {
	canonicalPluginToolName,
	PluginAgentToolBridge,
} from "@server/services/plugin-agent-tool-bridge";
import type { PluginPrincipal } from "@server/services/plugin-capability-broker";
import { PluginManager } from "@server/services/plugin-manager";
import {
	LocalProcessRunner,
	PluginRuntime,
	RuntimeSupervisor,
} from "@server/services/plugin-runtime";
import { PluginToolRegistry } from "@server/services/plugin-tool-registry";

const referenceFixture = join(import.meta.dir, "../../../fixtures/plugins/e2e/reference-tool-rpc");
const tempRoots: string[] = [];

async function copyReferenceFixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-acceptance-"));
	tempRoots.push(root);
	const packageRoot = join(root, "package");
	await cp(referenceFixture, packageRoot, { recursive: true });
	return packageRoot;
}

function createRuntime(
	packageRoot: string,
	manifest: ReturnType<typeof parseManifest>,
	onStateChange?: (state: string) => void,
): PluginRuntime {
	if (!manifest.server) throw new Error("reference fixture must declare a server entry");
	return new PluginRuntime({
		pluginId: manifest.pluginId,
		pluginVersion: manifest.version,
		command: [process.execPath, join(packageRoot, manifest.server.entry)],
		cwd: packageRoot,
		rpcProtocol: manifest.server.protocol,
		hostApiVersion: "1.0",
		grantedCapabilities: manifest.permissions.host,
		activationReason: "c1-c2-acceptance",
		runner: new LocalProcessRunner({
			allowedCwds: [packageRoot],
			maxHeaderBytes: 8 * 1024,
			maxBodyBytes: 128 * 1024,
			maxStdoutBytes: 256 * 1024,
			stderrRingBytes: 8 * 1024,
			maxStderrBytes: 16 * 1024,
			maxStderrBytesPerSecond: 16 * 1024,
			// Raised from 2s: see the note in plugin-to-host-dispatcher.e2e.test.ts. The budget
			// bounds a hung plugin, not the scheduler.
			spawnTimeoutMs: 20_000,
			idleTimeoutMs: 30_000,
			totalTimeoutMs: 45_000,
			killProcessTree: true,
			resourceLimits: { cpuTimeSeconds: 30, memoryBytes: 1024 * 1024 * 1024 },
			allowUnboundedResourceUsage: process.platform === "win32",
		}),
		timeouts: {
			handshakeMs: 20_000,
			activationMs: 20_000,
			rpcMs: 20_000,
			drainMs: 100,
			shutdownMs: 750,
			cancelGraceMs: 50,
		},
		idleTimeoutMs: 5_000,
		totalTimeoutMs: 8_000,
		maxInFlight: 4,
		onStateChange: (state) => onStateChange?.(state),
	});
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ESRCH" && code !== "EINVAL";
	}
}

async function waitForProcessExit(pid: number, timeoutMs = 1_500): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processIsAlive(pid)) return true;
		await Bun.sleep(10);
	}
	return !processIsAlive(pid);
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("C1/C2 reference plugin lifecycle acceptance", () => {
	test("production manager executes near-8/16 MiB through registry/bridge/executor and SQLite storage", async () => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-large-tool-"));
		tempRoots.push(root);
		const packageRoot = join(root, "source");
		await mkdir(packageRoot);
		await cp(
			join(import.meta.dir, "../../../fixtures/plugins/runtime/fixture.ts"),
			join(packageRoot, "fixture.ts"),
		);
		// This independent fixture intentionally has no demo's 2000-character business limit.
		const manifest = parseManifest({
			schemaVersion: 1,
			pluginId: "com.example.runtime",
			version: "1.0.0",
			displayName: "Large tool transport fixture",
			engine: {
				runtime: "bun",
				hostApi: ">=1.0 <2",
				rpc: "narrafork.rpc/1",
				runner: "local-process",
			},
			server: {
				entry: "fixture.ts",
				transport: "stdio",
				protocol: "narrafork.rpc/1",
				startupTimeoutMs: 20_000,
				activationTimeoutMs: 20_000,
			},
			activationEvents: ["onTool:double"],
			contributes: {
				tools: [
					{
						id: "double",
						title: "Double text",
						description: "Returns the supplied text twice",
						inputSchema: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
							additionalProperties: false,
						},
						execution: "server",
					},
				],
			},
			permissions: {
				host: [],
				network: { mode: "none", allow: [] },
				filesystem: { package: "readOnly", pluginData: "none", workspace: "none" },
				process: { spawn: "none" },
			},
		});
		await writeFile(join(packageRoot, "manifest.json"), JSON.stringify(manifest));
		const supervisor = new RuntimeSupervisor();
		const registry = new PluginToolRegistry({
			capabilityBroker: { authorize: async () => ({ allowed: true }) },
			resolveRuntime: (pluginId) => supervisor.get(pluginId),
			resolvePrincipal: async (pluginId, contributionId): Promise<PluginPrincipal | undefined> => {
				const runtime = supervisor.get(pluginId);
				const state = await manager.stateStore.getState(pluginId);
				if (!runtime || !state?.installationId) return undefined;
				const diagnostics = runtime.getDiagnostics();
				return {
					pluginId,
					contributionId,
					packageVersion: manifest.version,
					installationId: state.installationId,
					runtimeId: diagnostics.runtimeId,
					runtimeGeneration: diagnostics.generation,
				};
			},
		});
		const bridge = new PluginAgentToolBridge({
			pluginToolRegistry: registry,
			providerName: "production-large-tool-test",
		});
		let outputPath: string | undefined;
		// Do not supply runtimeOptionsFactory, a custom runner, or enlarged test-only limits.
		const manager = new PluginManager({
			root: join(root, "installed"),
			disabled: false,
			runtimeSupervisor: supervisor,
			toolRegistry: registry,
			agentToolBridge: bridge,
		});
		try {
			await manager.install(packageRoot);
			await manager.enable(manifest.pluginId);
			await manager.activate(manifest.pluginId);
			const runtime = supervisor.get(manifest.pluginId);
			if (!runtime) throw new Error("Missing production tool runtime");
			expect(runtime.pid).toBeGreaterThan(0);
			expect(runtime.rpcConnection?.getLimits()).toMatchObject({
				maxInboundFrameBytes: PLUGIN_TOOL_OUTPUT_FRAME_MAX_BYTES,
				maxOutboundFrameBytes: PLUGIN_TOOL_INPUT_FRAME_MAX_BYTES,
			});
			const seed = "中文插件正文 ";
			const text = seed.repeat(
				Math.floor((PLUGIN_TOOL_INPUT_MAX_BYTES - 64 * 1024) / Buffer.byteLength(seed)),
			);
			const input = { text };
			const inputBytes = Buffer.byteLength(JSON.stringify(input));
			expect(inputBytes).toBeGreaterThan(PLUGIN_TOOL_INPUT_MAX_BYTES * 0.98);
			expect(inputBytes).toBeLessThan(PLUGIN_TOOL_INPUT_MAX_BYTES);
			// Use the preload-isolated SQLite store; no live user database or PG path.
			const { sqlite } = await import("@server/db");
			await import("@server/services/narrator-service");
			const { narratorStore } = await import("@server/services/narrator-store");
			const narratorId = "large-rpc-executor-narrator";
			const now = new Date().toISOString();
			sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
				narratorId,
				"Large plugin result",
				now,
				now,
			]);
			const call: AgentToolUse = {
				toolUseId: "large-rpc-executor-call",
				name: canonicalPluginToolName(manifest.pluginId, "double"),
				input,
			};
			const step = await narratorStore.openStep(narratorId, {
				uuid: "large-rpc-step",
				session_id: "large-rpc",
			});
			const toolCallId = await narratorStore.writeStepItem(step.id, narratorId, {
				type: "tool_use",
				id: call.toolUseId,
				name: call.name,
				input,
				outputIndex: 0,
			});
			if (!toolCallId) throw new Error("Store did not persist the plugin tool call");
			const binding: ToolCallBinding = { toolCallId, attempt: 1 };
			const config: AgentConfig = {
				narratorId,
				conversationId: "large-rpc-conversation",
				model: "codex:gpt-5.5",
				provider: "codex",
				cwd: packageRoot,
				signal: new AbortController().signal,
				locale: "en",
				userId: "large-rpc-user",
				permissionHandler: async () => ({ behavior: "allow" }),
				requireToolCallBinding: true,
				toolExecutionBindings: new WeakMap([[call, binding]]),
				// Receipt callbacks are the executor unit fixture; storage writes below are real.
				onToolExecutionStarting: async (_toolUseId, receipt) => receipt,
				onToolExecutionFinalAuthorization: async () => ({ assertStillCurrent() {} }),
				recordToolNoDispatch: async () => {},
			};
			const rssBeforeBytes = process.memoryUsage().rss;
			const startedAt = performance.now();
			const result = await executeTool(call, config);
			const elapsedMs = Math.round(performance.now() - startedAt);
			const rssAfterBytes = process.memoryUsage().rss;
			if (result.isError) throw new Error(result.output.slice(0, 2048));
			expect(result.isError).toBe(false);
			expect(result.metadata?.toolCalls).toBe(1);
			outputPath = /Full output saved to: ([^\n]+)/.exec(result.output)?.[1];
			if (!outputPath) throw new Error("Executor did not provide a full-output file");
			expect(result.output).toContain("Do NOT re-run");
			expect(Buffer.byteLength(result.output)).toBeLessThan(MAX_BYTES + 2048);
			const fullOutput = await readFile(outputPath, "utf8");
			expect(fullOutput).toBe(text.repeat(2));
			const outputBytes = Buffer.byteLength(
				JSON.stringify({
					output: fullOutput,
					isError: false,
					metadata: result.metadata,
				}),
			);
			await narratorStore.settleTool(
				call.toolUseId,
				{ output: result.output, status: "success" },
				step.id,
				toolCallId,
			);
			const stored = sqlite
				.query("SELECT input_json, output_json, status FROM narrator_tool_calls WHERE id = ?")
				.get(toolCallId) as {
				input_json: string;
				output_json: string;
				status: string;
			};
			expect(JSON.parse(stored.input_json)).toEqual(input);
			expect(JSON.parse(stored.output_json)).toBe(result.output);
			expect(stored.status).toBe("success");
			expect(outputBytes).toBeGreaterThan(PLUGIN_TOOL_OUTPUT_MAX_BYTES * 0.98);
			expect(outputBytes).toBeLessThan(PLUGIN_TOOL_OUTPUT_MAX_BYTES);
			console.info(
				"[plugin-tool-large-rpc]",
				JSON.stringify({
					inputBytes,
					outputBytes,
					elapsedMs,
					rssBeforeBytes,
					rssAfterBytes,
					childRssBytes: result.metadata?.childRssBytes,
				}),
			);
			expect(runtime.state).toBe("active");
			expect(runtime.rpcConnection?.outboundPending.size).toBe(0);
			await expect(runtime.request("health")).resolves.toMatchObject({ healthy: true });
		} finally {
			bridge.dispose();
			if (outputPath) await unlink(outputPath);
			await manager.shutdown();
			// An idempotent lifecycle operation also drains queued state callbacks before
			// afterEach removes the package/state directory (shutdown only queues them).
			if (supervisor.get(manifest.pluginId)) await manager.deactivate(manifest.pluginId);
		}
	}, 60_000);

	test("runs hello → initialize → activate → health → tool → shutdown in a real child process", async () => {
		const packageRoot = await copyReferenceFixture();
		const manifest = parseManifest(
			JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8")),
		);
		const states: string[] = [];
		const runtime = createRuntime(packageRoot, manifest, (state) => states.push(state));

		try {
			await runtime.start();
			const active = runtime.getDiagnostics();
			expect(active).toMatchObject({
				pluginId: manifest.pluginId,
				pluginVersion: manifest.version,
				generation: 1,
				state: "active",
				inFlight: 0,
				lateMessages: 0,
			});
			expect(active.pid).toBeGreaterThan(0);

			const result = await runtime.request<{
				output: string;
				title: string;
				metadata: { length: number; preview: string };
			}>("tools.invoke", {
				contributionId: "describe-selection",
				input: { text: "C1/C2 reference lifecycle" },
				context: { requestId: "acceptance-tool", correlationId: "acceptance" },
			});
			expect(JSON.parse(result.output)).toEqual({
				length: 25,
				preview: "C1/C2 reference lifecycle",
			});
			expect(result.title).toBe("Selection description");
			expect(result.metadata.length).toBe(25);
			await expect(runtime.request("reference.unknown")).rejects.toMatchObject({ code: "-32601" });
		} finally {
			const pid = runtime.pid;
			await runtime.shutdown();
			const stopped = runtime.getDiagnostics();
			expect(stopped.state).toBe("stopped");
			expect(stopped.inFlight).toBe(0);
			expect(stopped.stoppedAt).toBeDefined();
			if (pid) expect(await waitForProcessExit(pid)).toBe(true);
		}
		expect(states).toEqual(["starting", "handshaking", "active", "draining", "stopped"]);
	}, 15_000);

	test("repeats bounded start/stop cycles without live child processes or pending RPC", async () => {
		const packageRoot = await copyReferenceFixture();
		const manifest = parseManifest(
			JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8")),
		);
		const pids: number[] = [];

		for (let cycle = 0; cycle < 8; cycle += 1) {
			const runtime = createRuntime(packageRoot, manifest);
			try {
				await runtime.start();
				const pid = runtime.pid;
				if (!pid) throw new Error(`cycle ${cycle} did not expose a child pid`);
				pids.push(pid);
				const result = await runtime.request<{ output: string }>("tools.invoke", {
					contributionId: "describe-selection",
					input: { text: `cycle-${cycle}` },
					context: { requestId: `cycle-${cycle}`, correlationId: "leak-check" },
				});
				expect(result.output).toContain(`cycle-${cycle}`);
			} finally {
				await runtime.shutdown();
				expect(runtime.getDiagnostics()).toMatchObject({ state: "stopped", inFlight: 0 });
			}
		}

		for (const pid of pids) expect(await waitForProcessExit(pid)).toBe(true);
	}, 45_000);
});
