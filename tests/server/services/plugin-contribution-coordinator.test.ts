import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "@server/lib/agent/tool-registry";
import { type Manifest, type ManifestInput, parseManifest } from "@server/lib/plugins/manifest";
import {
	canonicalPluginToolName,
	PluginAgentToolBridge,
} from "@server/services/plugin-agent-tool-bridge";
import type {
	PluginCatalogPlugin,
	PluginCatalogSnapshot,
	PluginContributionSummary,
	PluginPackageSummary,
} from "@server/services/plugin-catalog";
import {
	PluginContributionCoordinator,
	type PluginContributionLifecycleState,
} from "@server/services/plugin-contribution-coordinator";
import { PluginContributionRegistry } from "@server/services/plugin-contribution-registry";
import { PluginToolRegistry } from "@server/services/plugin-tool-registry";

const pluginId = "com.example.coordinator";
const hash = "b".repeat(64);

function manifestInput(): ManifestInput {
	return {
		schemaVersion: 1,
		pluginId,
		version: "1.0.0",
		displayName: "Coordinator fixture",
		engine: {
			runtime: "bun",
			hostApi: ">=1.0 <2",
			rpc: "narrafork.rpc/1",
			runner: "local-process",
		},
		server: {
			entry: "server/index.js",
			transport: "stdio",
			protocol: "narrafork.rpc/1",
			args: [],
			workingDirectory: "package",
		},
		activationEvents: ["onTool:echo"],
		contributes: {
			providers: [],
			tools: [
				{
					id: "echo",
					title: "Echo",
					description: "Coordinator tool",
					inputSchema: {
						type: "object",
						properties: { text: { type: "string" } },
						required: ["text"],
						additionalProperties: false,
					},
					execution: "server",
					allowBackground: false,
				},
			],
			commands: [],
			events: [],
			views: [],
		},
		permissions: {
			host: ["provider.use"],
			network: { mode: "none", allow: [] },
			filesystem: { package: "readOnly", pluginData: "readWrite", workspace: "none" },
			process: { spawn: "none" },
		},
		secrets: [],
		dependencies: { plugins: {}, runtime: {} },
	};
}

function snapshotFor(manifest: Manifest): PluginCatalogSnapshot {
	const contribution: PluginContributionSummary = {
		pluginId,
		version: manifest.version,
		hash,
		id: "echo",
		fullId: `${pluginId}/echo`,
		kind: "tool",
		title: "Echo",
		description: "Coordinator tool",
		inputSchema: manifest.contributes.tools[0]?.inputSchema,
		execution: "server",
		allowBackground: false,
		hasSchema: true,
	};
	const packageSummary: PluginPackageSummary = {
		pluginId,
		version: manifest.version,
		hash,
		path: "/virtual/plugins/com.example.coordinator/1.0.0",
		status: "compatible",
		isCurrent: true,
		manifest: {
			schemaVersion: manifest.schemaVersion,
			pluginId,
			version: manifest.version,
			displayName: manifest.displayName,
			engine: manifest.engine,
			server: { entry: manifest.server?.entry ?? "server/index.js", protocol: "narrafork.rpc/1" },
			activationEvents: [...manifest.activationEvents],
		},
		contributions: [contribution],
		diagnostics: [],
	};
	const plugin: PluginCatalogPlugin = {
		pluginId,
		status: "compatible",
		current: { version: packageSummary.version, hash },
		packages: [packageSummary],
		contributions: [contribution],
		diagnostics: [],
	};
	return {
		generatedAt: "2026-07-18T00:00:00.000Z",
		plugins: [plugin],
		packages: [packageSummary],
		diagnostics: [],
	};
}

function emptySnapshot(): PluginCatalogSnapshot {
	return { generatedAt: "2026-07-18T00:00:01.000Z", plugins: [], packages: [], diagnostics: [] };
}

function broker() {
	return { authorize: async () => ({ allowed: true as const }) };
}

function state(
	desiredState: PluginContributionLifecycleState["desiredState"],
): PluginContributionLifecycleState {
	return {
		pluginId,
		desiredState,
		runtimeState: desiredState === "enabled" ? "inactive" : "inactive",
		compatibility: "compatible",
	};
}

describe("PluginContributionCoordinator", () => {
	test("atomically follows initialize/install/enable/disable/uninstall registry states", async () => {
		const manifest = parseManifest(manifestInput());
		const snapshot = snapshotFor(manifest);
		let lifecycle: readonly PluginContributionLifecycleState[] = [state("disabled")];
		const contributionRegistry = new PluginContributionRegistry();
		const toolRegistry = new PluginToolRegistry({ capabilityBroker: broker() });
		const agentRegistry = new ToolRegistry();
		const bridge = new PluginAgentToolBridge({
			pluginToolRegistry: toolRegistry,
			agentToolRegistry: agentRegistry,
		});
		const coordinator = new PluginContributionCoordinator({
			contributionRegistry,
			toolRegistry,
			agentToolBridge: bridge,
			lifecycleStates: () => lifecycle,
			manifestLoader: async () => manifest,
		});
		const canonical = canonicalPluginToolName(pluginId, "echo");

		const initialized = await coordinator.initialize(snapshot);
		expect(initialized.reason).toBe("initialize");
		expect(contributionRegistry.get(`${pluginId}/echo`)).toMatchObject({
			status: "unavailable",
			unavailableReason: "Plugin is disabled",
		});
		expect(toolRegistry.get(`${pluginId}/echo`)).toMatchObject({
			status: "unavailable",
			unavailableReason: "Plugin is disabled",
		});
		expect(agentRegistry.get(canonical)?.isAvailable?.()).toBe(false);

		lifecycle = [state("enabled")];
		const installed = await coordinator.install(snapshot);
		expect(installed.reason).toBe("install");
		expect(contributionRegistry.get(`${pluginId}/echo`)?.status).toBe("available");
		expect(toolRegistry.get(`${pluginId}/echo`)?.status).toBe("available");
		expect(agentRegistry.get(canonical)?.isAvailable?.()).toBe(true);

		const unchangedRevision = coordinator.revision;
		const unchanged = await coordinator.refresh(snapshot);
		expect(unchanged.changed).toBe(false);
		expect(coordinator.revision).toBe(unchangedRevision);

		lifecycle = [state("disabled")];
		const disabled = await coordinator.disable(snapshot);
		expect(disabled.reason).toBe("disable");
		expect(contributionRegistry.get(`${pluginId}/echo`)?.status).toBe("unavailable");
		expect(toolRegistry.get(`${pluginId}/echo`)?.status).toBe("unavailable");
		expect(agentRegistry.get(canonical)?.isAvailable?.()).toBe(false);

		const removed = await coordinator.uninstall(emptySnapshot());
		expect(removed.reason).toBe("uninstall");
		expect(contributionRegistry.get(`${pluginId}/echo`)).toBeUndefined();
		expect(toolRegistry.get(`${pluginId}/echo`)).toBeUndefined();
		expect(agentRegistry.get(canonical)).toBeUndefined();
	});

	test("replaces descriptors after a transient manifest load failure", async () => {
		const manifest = parseManifest(manifestInput());
		const recoveredInput = manifestInput();
		const recoveredTool = recoveredInput.contributes?.tools?.[0];
		if (!recoveredTool) throw new Error("Fixture tool is missing");
		recoveredTool.title = "Recovered Echo";
		const recoveredManifest = parseManifest(recoveredInput);
		const snapshot = snapshotFor(manifest);
		let failLoad = false;
		let useRecovered = false;
		const contributionRegistry = new PluginContributionRegistry();
		const toolRegistry = new PluginToolRegistry({ capabilityBroker: broker() });
		const coordinator = new PluginContributionCoordinator({
			contributionRegistry,
			toolRegistry,
			lifecycleStates: [state("enabled")],
			manifestLoader: async () => {
				if (failLoad) throw new Error("transient manifest read failure");
				return useRecovered ? recoveredManifest : manifest;
			},
		});
		await coordinator.initialize(snapshot);
		expect(toolRegistry.get(`${pluginId}/echo`)?.title).toBe("Echo");

		failLoad = true;
		await coordinator.refresh(snapshot);
		expect(toolRegistry.get(`${pluginId}/echo`)?.status).toBe("unavailable");

		failLoad = false;
		useRecovered = true;
		const recovered = await coordinator.refresh(snapshot);
		expect(recovered.changed).toBe(true);
		expect(toolRegistry.get(`${pluginId}/echo`)).toMatchObject({
			title: "Recovered Echo",
			status: "available",
		});
	});

	test("removes stale tool entries after a compatible package becomes unavailable and is uninstalled", async () => {
		const manifest = parseManifest(manifestInput());
		const snapshot = snapshotFor(manifest);
		const contributionRegistry = new PluginContributionRegistry();
		const toolRegistry = new PluginToolRegistry({ capabilityBroker: broker() });
		const coordinator = new PluginContributionCoordinator({
			contributionRegistry,
			toolRegistry,
			manifestLoader: async () => manifest,
			lifecycleStates: [state("enabled")],
		});
		await coordinator.initialize(snapshot);
		expect(toolRegistry.get(`${pluginId}/echo`)).toBeDefined();

		const unavailable = structuredClone(snapshot);
		const packageSummary = unavailable.packages[0];
		if (!packageSummary) throw new Error("Fixture package is missing");
		packageSummary.status = "incompatible";
		packageSummary.diagnostics = [{ code: "INCOMPATIBLE_TEST", message: "fixture unavailable" }];
		const plugin = unavailable.plugins[0];
		if (!plugin) throw new Error("Fixture plugin is missing");
		const pluginPackage = plugin.packages[0];
		if (!pluginPackage) throw new Error("Fixture plugin package is missing");
		pluginPackage.status = "incompatible";
		pluginPackage.diagnostics = packageSummary.diagnostics;
		plugin.status = "incompatible";
		plugin.diagnostics = packageSummary.diagnostics;
		await coordinator.refresh(unavailable);
		expect(toolRegistry.get(`${pluginId}/echo`)?.status).toBe("unavailable");

		await coordinator.uninstall(emptySnapshot());
		expect(toolRegistry.get(`${pluginId}/echo`)).toBeUndefined();
		expect(contributionRegistry.get(`${pluginId}/echo`)).toBeUndefined();
	});
});
