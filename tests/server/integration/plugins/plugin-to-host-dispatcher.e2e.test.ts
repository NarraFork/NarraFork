import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest } from "@server/lib/plugins/manifest";
import type { JsonValue } from "@server/lib/plugins/protocol";
import {
	PluginHostDispatcher,
	type PluginHostResolverInput,
} from "@server/services/plugin-host-dispatcher";
import { LocalProcessRunner, PluginRuntime } from "@server/services/plugin-runtime";

const fixtureRoot = join(import.meta.dir, "../../../fixtures/plugins/e2e/reference-host-call-rpc");

async function loadManifest() {
	return parseManifest(JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8")));
}

async function pollHostResults(
	runtime: PluginRuntime,
	timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = (await runtime.request("reference.hostResults", {})) as Record<string, unknown>;
		if (value.settled === true) return value;
		await Bun.sleep(5);
	}
	throw new Error("Plugin→Host fixture did not settle all Host calls");
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

describe("C1 real Plugin→Host dispatcher acceptance", () => {
	test("dispatches a real child-process request with Host identity, capability denial, and -32601", async () => {
		const manifest = await loadManifest();
		const entry = join(fixtureRoot, manifest.server?.entry ?? "server/index.js");
		const entrySource = await readFile(entry, "utf8");
		const negotiatedEntry = entrySource.replace(
			"features: [],",
			'features: ["host_api.requests"],',
		);
		const authorizationCalls: Array<{
			method: string;
			capability?: string;
			pluginId: string;
			projectId?: string;
		}> = [];
		let deniedHandlerCalls = 0;
		const authorize = (input: PluginHostResolverInput) => {
			authorizationCalls.push({
				method: input.method,
				capability: input.capability,
				pluginId: input.context.plugin.pluginId,
				projectId: input.context.scope.projectId,
			});
			if (input.method === "commands.execute") {
				return {
					allowed: false,
					code: "PERMISSION_DENIED",
					message: "Reference fixture is not allowed to mutate chapters",
					retryable: false,
				};
			}
			return true;
		};
		const dispatcher = new PluginHostDispatcher({
			identity: {
				pluginId: manifest.pluginId,
				packageVersion: manifest.version,
				installationId: "installation-host-call-e2e",
				runtimeId: "runtime-host-call-e2e",
				runtimeGeneration: 3,
			},
			scope: { projectId: "host-owned-project" },
			authorize,
			methods: {
				"queries.execute": {
					method: "queries.execute",
					capability: "query.read.projects",
					handler: async (params, context) => ({
						hostPluginId: context.plugin.pluginId,
						hostRuntimeId: context.plugin.runtimeId,
						hostGeneration: context.plugin.runtimeGeneration,
						hostUserId: context.invocation.userId ?? null,
						hostProjectId: context.scope.projectId ?? null,
						params: params as JsonValue,
					}),
				},
				"commands.execute": {
					method: "commands.execute",
					capability: "command.chapter.write",
					sideEffect: "unknown",
					handler: async () => {
						deniedHandlerCalls += 1;
						return { mutated: true };
					},
				},
			},
		});
		const runner = new LocalProcessRunner({
			allowedCwds: [fixtureRoot],
			maxHeaderBytes: 8 * 1024,
			maxBodyBytes: 256 * 1024,
			maxStdoutBytes: 512 * 1024,
			stderrRingBytes: 8 * 1024,
			maxStderrBytes: 32 * 1024,
			maxStderrBytesPerSecond: 16 * 1024,
			// Raised from 2s: the suite now spawns enough real plugin subprocesses in parallel
			// that the original budget was occasionally missed under CPU contention rather than
			// because anything hung. Still bounded, just not racing the scheduler.
			spawnTimeoutMs: 20_000,
			idleTimeoutMs: 30_000,
			totalTimeoutMs: 45_000,
			killProcessTree: true,
			resourceLimits: { cpuTimeSeconds: 30, memoryBytes: 1024 * 1024 * 1024 },
			allowUnboundedResourceUsage: process.platform === "win32",
		});
		const runtime = new PluginRuntime({
			pluginId: manifest.pluginId,
			pluginVersion: manifest.version,
			runtimeId: "runtime-host-call-e2e",
			generation: 3,
			command: [process.execPath, "-e", negotiatedEntry],
			cwd: fixtureRoot,
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				LANG: process.env.LANG ?? "C.UTF-8",
				NODE_ENV: "test",
			},
			grantedCapabilities: manifest.permissions.host,
			runner,
			dispatcher,
			timeouts: {
				handshakeMs: 20_000,
				activationMs: 20_000,
				rpcMs: 20_000,
				shutdownMs: 5_000,
				drainMs: 500,
			},
		});
		let childPid: number | undefined;

		try {
			await runtime.start();
			childPid = runtime.pid;
			const activeGeneration = runtime.generation;
			expect(childPid).toBeGreaterThan(0);
			const hostResults = await pollHostResults(runtime);
			const results = hostResults.results as Record<
				string,
				{ result?: Record<string, unknown>; error?: Record<string, unknown> }
			>;

			expect(results.query?.result).toMatchObject({
				hostPluginId: manifest.pluginId,
				hostRuntimeId: "runtime-host-call-e2e",
				hostGeneration: activeGeneration,
				hostUserId: null,
				hostProjectId: "host-owned-project",
				params: {
					pluginId: "com.example.forged-plugin",
					userId: "forged-admin",
					scope: { projectId: "forged-project" },
					payload: "reference-query",
				},
			});
			expect(results.denied?.error).toMatchObject({
				code: -32008,
				data: { code: "PERMISSION_DENIED", retryable: false },
			});
			expect(results.unknown?.error).toMatchObject({
				code: -32601,
				data: { code: "METHOD_NOT_FOUND", retryable: false },
			});
			expect(deniedHandlerCalls).toBe(0);
			expect(authorizationCalls).toEqual([
				{
					method: "queries.execute",
					capability: "query.read.projects",
					pluginId: manifest.pluginId,
					projectId: "host-owned-project",
				},
				{
					method: "commands.execute",
					capability: "command.chapter.write",
					pluginId: manifest.pluginId,
					projectId: "host-owned-project",
				},
			]);
			expect(runtime.getDiagnostics()).toMatchObject({
				state: "active",
				outboundPending: 0,
				inboundActive: 0,
			});
		} finally {
			if (runtime.state !== "stopped") await runtime.shutdown().catch(() => undefined);
		}
		if (childPid) expect(await waitForProcessExit(childPid)).toBe(true);
	}, 20_000);
});
