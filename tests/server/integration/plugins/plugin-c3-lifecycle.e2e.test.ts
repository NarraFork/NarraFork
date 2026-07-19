import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@server/lib/agent/tool-registry";
import type { ToolContext } from "@server/lib/agent/types";
import {
	canonicalPluginToolName,
	PluginAgentToolBridge,
} from "@server/services/plugin-agent-tool-bridge";
import { CapabilityBroker, type PluginPrincipal } from "@server/services/plugin-capability-broker";
import { PluginHostServices } from "@server/services/plugin-host-services";
import { PluginManager, type PluginRuntimeSupervisorLike } from "@server/services/plugin-manager";
import { PluginPermissionStore } from "@server/services/plugin-permission-store";
import { createPluginPlatformServices } from "@server/services/plugin-platform-services";
import type {
	PluginRuntimeOptions,
	RuntimeDiagnostics,
	RuntimeState,
} from "@server/services/plugin-runtime";
import { PluginStateStore } from "@server/services/plugin-state-store";
import { PluginToolRegistry, type PluginToolRuntime } from "@server/services/plugin-tool-registry";

const referenceFixture = join(import.meta.dir, "../../../fixtures/plugins/e2e/reference-tool-rpc");
const tempRoots: string[] = [];

class FakeRuntime {
	state: RuntimeState = "stopped";
	generation = 0;
	readonly runtimeId: string;

	constructor(readonly options: PluginRuntimeOptions) {
		this.runtimeId = options.runtimeId ?? `fake-${options.pluginId}`;
	}

	getDiagnostics(): RuntimeDiagnostics {
		return {
			pluginId: this.options.pluginId,
			pluginVersion: this.options.pluginVersion,
			runtimeId: this.runtimeId,
			generation: this.generation,
			state: this.state,
			inFlight: 0,
			capabilities: [...(this.options.grantedCapabilities ?? [])],
			stderr: "",
			lateMessages: 0,
		};
	}

	async request(_method: string, params?: unknown): Promise<unknown> {
		const input =
			params && typeof params === "object" && !Array.isArray(params)
				? (params as { input?: { text?: string } }).input
				: undefined;
		const text = input?.text ?? "";
		return {
			output: JSON.stringify({ length: text.length, preview: text }),
			title: "Selection description",
			metadata: { length: text.length, preview: text },
		};
	}
}

class FakeSupervisor implements PluginRuntimeSupervisorLike {
	readonly runtimes = new Map<string, FakeRuntime>();

	register(options: PluginRuntimeOptions): FakeRuntime {
		const existing = this.runtimes.get(options.pluginId);
		if (existing) return existing;
		const runtime = new FakeRuntime(options);
		this.runtimes.set(options.pluginId, runtime);
		return runtime;
	}

	async start(options: PluginRuntimeOptions): Promise<FakeRuntime>;
	async start(pluginId: string, signal?: AbortSignal): Promise<FakeRuntime>;
	async start(optionsOrPluginId: PluginRuntimeOptions | string): Promise<FakeRuntime> {
		const runtime =
			typeof optionsOrPluginId === "string"
				? this.runtimes.get(optionsOrPluginId)
				: this.register(optionsOrPluginId);
		if (!runtime) throw new Error(`Runtime is not registered: ${optionsOrPluginId}`);
		const previous = runtime.state;
		runtime.state = "starting";
		runtime.options.onStateChange?.("starting", previous);
		runtime.generation += 1;
		const beforeActive = runtime.state;
		runtime.state = "active";
		runtime.options.onStateChange?.("active", beforeActive);
		return runtime;
	}

	async disable(pluginId: string): Promise<void> {
		const runtime = this.runtimes.get(pluginId);
		if (!runtime || runtime.state === "stopped") return;
		const previous = runtime.state;
		runtime.state = "draining";
		runtime.options.onStateChange?.("draining", previous);
		const beforeStopped = runtime.state;
		runtime.state = "stopped";
		runtime.options.onStateChange?.("stopped", beforeStopped);
	}

	async drain(pluginId: string): Promise<void> {
		const runtime = this.runtimes.get(pluginId);
		if (runtime?.state === "active") runtime.state = "draining";
	}

	async shutdown(): Promise<void> {
		await Promise.all([...this.runtimes.keys()].map((pluginId) => this.disable(pluginId)));
	}

	get(pluginId: string): FakeRuntime | undefined {
		return this.runtimes.get(pluginId);
	}

	getDiagnostics(pluginId?: string): RuntimeDiagnostics[] {
		const runtimes = pluginId
			? [this.runtimes.get(pluginId)].filter(
					(runtime): runtime is FakeRuntime => runtime !== undefined,
				)
			: [...this.runtimes.values()];
		return runtimes.map((runtime) => runtime.getDiagnostics());
	}

	quarantine(pluginId: string, _reason: string): void {
		const runtime = this.runtimes.get(pluginId);
		if (!runtime) return;
		const previous = runtime.state;
		runtime.state = "quarantine";
		runtime.options.onStateChange?.("quarantine", previous);
	}
}

function toolContext(): ToolContext {
	return {
		narratorId: "narrator-1",
		cwd: "/workspace",
		locale: "en",
		userId: "user-1",
		projectId: "project-1",
		chapterId: "chapter-1",
		currentToolUseId: "agent-tool-1",
		signal: new AbortController().signal,
		requestPermission: async () => ({ behavior: "allow" }),
	};
}

async function makeSource(root: string): Promise<string> {
	const source = join(root, "source");
	await cp(referenceFixture, source, { recursive: true });
	const manifestPath = join(source, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
	const permissions = manifest.permissions as Record<string, unknown>;
	permissions.host = ["provider.use"];
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	return source;
}

function principalFor(
	pluginId: string,
	stateStore: PluginStateStore,
	supervisor: FakeSupervisor,
	contributionId: string,
): Promise<PluginPrincipal | undefined> {
	return (async () => {
		const runtime = supervisor.get(pluginId);
		if (!runtime || !["active", "degraded"].includes(runtime.state)) return undefined;
		const state = await stateStore.getState(pluginId);
		if (!state?.current) return undefined;
		const diagnostics = runtime.getDiagnostics();
		return {
			pluginId,
			packageVersion: diagnostics.pluginVersion ?? state.current.version,
			installationId: state.current.hash,
			runtimeId: diagnostics.runtimeId,
			runtimeGeneration: diagnostics.generation,
			contributionId,
		};
	})();
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("C3 production plugin tool lifecycle", () => {
	test("connects install → enable → activate → Agent tool → disable → uninstall", async () => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-c3-"));
		tempRoots.push(root);
		const storeRoot = join(root, "plugins");
		const stateStore = new PluginStateStore(storeRoot);
		const permissionStore = new PluginPermissionStore({ root: storeRoot, stateStore });
		const capabilityBroker = new CapabilityBroker();
		const hostServices = new PluginHostServices({ capabilityBroker, permissionStore });
		const supervisor = new FakeSupervisor();
		const toolRegistry = new PluginToolRegistry({
			capabilityBroker,
			resolvePrincipal: (pluginId, contributionId) =>
				principalFor(pluginId, stateStore, supervisor, contributionId),
			resolveRuntime: (pluginId) => {
				const runtime = supervisor.get(pluginId);
				return runtime && ["active", "degraded"].includes(runtime.state)
					? (runtime as unknown as PluginToolRuntime)
					: undefined;
			},
		});
		const agentRegistry = new ToolRegistry();
		const toolBridge = new PluginAgentToolBridge({
			pluginToolRegistry: toolRegistry,
			agentToolRegistry: agentRegistry,
		});
		const platform = createPluginPlatformServices({
			runtimeSupervisor: supervisor as never,
			stateStore,
			permissionStore,
			capabilityBroker,
			hostServices,
			toolRegistry,
			toolBridge,
		});
		const manager = new PluginManager({
			root: storeRoot,
			disabled: false,
			stateStore,
			permissionStore,
			hostServices,
			runtimeSupervisor: supervisor,
			contributionRegistry: platform.contributionRegistry,
			toolRegistry,
			agentToolBridge: toolBridge,
			contributionCoordinator: platform.contributionCoordinator,
			lifecycleRevokeCoordinator: platform.lifecycleRevokeCoordinator,
			restorePluginLifecycle: platform.restorePlugin,
			runtimeOptionsFactory: async (context) => ({
				pluginId: context.pluginId,
				pluginVersion: context.manifest.version,
				packageDigest: context.package.hash,
				command: ["fake-plugin-runtime"],
				cwd: context.packagePath,
				runtimeId: "fake-runtime",
			}),
		});
		const source = await makeSource(root);
		const installed = await manager.install(source);
		const pluginId = installed.pluginId;
		const fullId = `${pluginId}/describe-selection`;
		const canonical = canonicalPluginToolName(pluginId, "describe-selection");

		expect(platform.contributionRegistry.get(fullId)).toMatchObject({
			status: "unavailable",
			unavailableReason: "Plugin is disabled",
		});
		expect(toolRegistry.get(fullId)).toMatchObject({
			status: "unavailable",
			unavailableReason: "Plugin is disabled",
		});
		expect(agentRegistry.get(canonical)?.isAvailable?.()).toBe(false);

		await stateStore.updateState(pluginId, { trustTier: "T2" });
		await manager.replacePermissions(pluginId, {
			expectedRevision: 0,
			grantedBy: "admin-user-1",
			grants: [
				{
					grantId: "grant-provider-use",
					capability: "provider.use",
					scope: { type: "global" },
					grantedBy: "admin-user-1",
				},
			],
		});
		await manager.enable(pluginId);
		expect(toolRegistry.get(fullId)?.status).toBe("available");
		expect(agentRegistry.get(canonical)?.isAvailable?.()).toBe(true);

		await manager.activate(pluginId);
		const result = await toolBridge.invokeCanonical(
			canonical,
			{ text: "production C3" },
			toolContext(),
		);
		expect(result).toEqual({
			output: JSON.stringify({ length: 13, preview: "production C3" }),
			title: "Selection description",
			metadata: { length: 13, preview: "production C3" },
		});

		await manager.disable(pluginId);
		expect(toolRegistry.get(fullId)?.status).toBe("unavailable");
		expect(agentRegistry.get(canonical)?.isAvailable?.()).toBe(false);
		await expect(
			toolBridge.invokeCanonical(canonical, { text: "blocked" }, toolContext()),
		).rejects.toMatchObject({
			code: "PLUGIN_DISABLED",
		});

		await manager.uninstall(pluginId);
		expect(platform.contributionRegistry.get(fullId)).toBeUndefined();
		expect(toolRegistry.get(fullId)).toBeUndefined();
		expect(agentRegistry.get(canonical)).toBeUndefined();
		await manager.shutdown();
	});
});
