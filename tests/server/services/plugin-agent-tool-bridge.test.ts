import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "@server/lib/agent/tool-registry";
import type { ToolContext } from "@server/lib/agent/types";
import { type ManifestInput, parseManifest } from "@server/lib/plugins/manifest";
import {
	canonicalPluginToolName,
	PluginAgentToolBridge,
} from "@server/services/plugin-agent-tool-bridge";
import type { PluginPrincipal } from "@server/services/plugin-capability-broker";
import {
	type PluginToolCapabilityBroker,
	PluginToolRegistry,
} from "@server/services/plugin-tool-registry";

const principal: PluginPrincipal = {
	pluginId: "com.example.bridge",
	packageVersion: "1.0.0",
	runtimeId: "runtime-1",
	runtimeGeneration: 1,
	installationId: "a".repeat(64),
};

function toolManifest(): ManifestInput {
	return {
		schemaVersion: 1,
		pluginId: principal.pluginId,
		version: principal.packageVersion,
		displayName: "Bridge fixture",
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
					description: "Echoes input",
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

function context(): ToolContext {
	return {
		narratorId: "narrator-1",
		cwd: "/workspace",
		signal: new AbortController().signal,
		locale: "en",
		userId: "user-1",
		projectId: "project-1",
		chapterId: "chapter-1",
		currentToolUseId: "tooluse-1",
		requestPermission: async () => ({ behavior: "allow" }),
	};
}

function allowingBroker(): PluginToolCapabilityBroker {
	return { authorize: async () => ({ allowed: true }) };
}

describe("PluginAgentToolBridge", () => {
	test("maps a host tool to a reversible canonical Agent name and invokes it", async () => {
		let observedPluginId: string | undefined;
		let observedUserId: string | undefined;
		const registry = new PluginToolRegistry({
			capabilityBroker: allowingBroker(),
			handler: async (_input, call) => {
				observedPluginId = call.host.plugin.pluginId;
				observedUserId = call.host.invocation.userId;
				return { output: "bridge-ok", metadata: { source: "plugin" } };
			},
		});
		const [descriptor] = registry.registerManifest(parseManifest(toolManifest()), { principal });
		const agentRegistry = new ToolRegistry();
		let active = false;
		let activations = 0;
		const bridge = new PluginAgentToolBridge({
			pluginToolRegistry: registry,
			agentToolRegistry: agentRegistry,
			activatePlugin: async () => {
				activations += 1;
				active = true;
			},
			isRuntimeActive: () => active,
		});

		const bindings = bridge.sync();
		const canonical = canonicalPluginToolName(principal.pluginId, descriptor.contributionId);
		expect(bindings).toMatchObject([
			{
				fullId: descriptor.fullId,
				canonicalName: canonical,
			},
		]);
		expect(bridge.fullIdForCanonical(canonical)).toBe(descriptor.fullId);
		expect(bridge.canonicalNameForFullId(descriptor.fullId)).toBe(canonical);
		expect(agentRegistry.get(canonical)?.rawJsonSchema).toMatchObject({
			properties: { text: { type: "string" } },
		});

		await expect(bridge.invokeCanonical(canonical, { text: "hello" }, context())).resolves.toEqual({
			output: "bridge-ok",
			metadata: { source: "plugin" },
		});
		await bridge.invokeCanonical(canonical, { text: "again" }, context());
		expect(activations).toBe(1);
		expect(observedPluginId).toBe(principal.pluginId);
		expect(observedUserId).toBe("user-1");
	});

	test("keeps disabled descriptors unavailable and removes them after uninstall refresh", async () => {
		const registry = new PluginToolRegistry({
			capabilityBroker: allowingBroker(),
			handler: async () => ({ output: "ok" }),
		});
		const [descriptor] = registry.registerManifest(parseManifest(toolManifest()), { principal });
		const agentRegistry = new ToolRegistry();
		const bridge = new PluginAgentToolBridge({
			pluginToolRegistry: registry,
			agentToolRegistry: agentRegistry,
		});
		bridge.sync();
		const canonical = canonicalPluginToolName(principal.pluginId, descriptor.contributionId);
		const tool = agentRegistry.get(canonical);
		if (!tool) throw new Error("Agent tool was not registered");
		expect(tool.isAvailable?.()).toBe(true);

		registry.disablePlugin(principal.pluginId);
		bridge.sync();
		expect(agentRegistry.get(canonical)?.isAvailable?.()).toBe(false);
		await expect(
			bridge.invokeCanonical(canonical, { text: "blocked" }, context()),
		).rejects.toMatchObject({
			code: "PLUGIN_DISABLED",
		});

		registry.removePlugin(principal.pluginId);
		bridge.sync();
		expect(agentRegistry.get(canonical)).toBeUndefined();
		expect(bridge.getByCanonicalName(canonical)).toBeUndefined();
	});
});
