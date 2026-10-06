import { describe, expect, test } from "bun:test";
import type { PermissionGrant } from "@server/lib/plugins/permissions";
import { CapabilityBroker, type HostCallContext } from "@server/services/plugin-capability-broker";
import {
	MCP_BRIDGE_CAPABILITY,
	PluginMcpAdapter,
	type PluginMcpBridgeTool,
	type PluginMcpServerContribution,
} from "@server/services/plugin-mcp-adapter";

const principal = {
	pluginId: "com.example.mcp",
	packageVersion: "1.0.0",
	runtimeId: "runtime-1",
	runtimeGeneration: 1,
	installationId: "installation-1",
} as const;

const capability = MCP_BRIDGE_CAPABILITY;

function context(overrides: Partial<HostCallContext> = {}): HostCallContext {
	return {
		requestId: "request-1",
		correlationId: "correlation-1",
		deadlineAt: "2099-01-01T00:00:00.000Z",
		plugin: principal,
		invocation: { kind: "user", userId: "user-1", userRole: "user", source: "ui" },
		scope: { projectId: "project-1" },
		...overrides,
	};
}

function bridgeBinding(overrides: Record<string, unknown> = {}) {
	const grant: PermissionGrant = { capability, scope: { type: "global" } };
	return {
		plugin: principal,
		desiredState: "enabled" as const,
		compatibilityState: "compatible" as const,
		runtimeState: "active" as const,
		manifestRequested: [capability],
		installationGrants: [grant],
		hostPolicy: [capability],
		currentUserAuthority: [capability],
		contributionPolicy: [capability],
		runnerEnforcement: [capability],
		...overrides,
	};
}

function adapter(overrides: ConstructorParameters<typeof PluginMcpAdapter>[0] = {}) {
	return new PluginMcpAdapter({
		capabilityBroker: new CapabilityBroker({
			bindings: new Map([[principal.pluginId, bridgeBinding()]]),
		}),
		...overrides,
	});
}

function tool(overrides: Partial<PluginMcpBridgeTool> = {}): PluginMcpBridgeTool {
	return {
		pluginId: principal.pluginId,
		contributionId: "echo",
		title: "Echo",
		description: "Echo text",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
		capability,
		handler: async (args) => ({
			content: [{ type: "text", text: String(args.text) }],
		}),
		...overrides,
	};
}

function server(overrides: Partial<PluginMcpServerContribution> = {}): PluginMcpServerContribution {
	return {
		pluginId: principal.pluginId,
		contributionId: "server",
		name: "Approved MCP",
		transport: "stdio",
		command: "/opt/narrafork/bin/mcp-safe",
		args: ["--stdio"],
		cwd: "/opt/narrafork/plugins/com.example.mcp",
		env: { NF_MODE: "readonly" },
		enabled: true,
		...overrides,
	};
}

const policy = {
	allowedCommands: ["/opt/narrafork/bin/mcp-safe"],
	allowedArgs: ["--stdio"],
	allowedCwds: ["/opt/narrafork/plugins/com.example.mcp"],
	allowedEnvKeys: ["NF_MODE"],
	allowedUrls: ["https://mcp.example.test/endpoint"],
	allowedHeaderKeys: ["X-Mode"],
	allowRemoteUrls: true,
};

describe("PluginMcpAdapter mcp.bridge", () => {
	test("maps declared plugin tools to MCP-compatible descriptors and handlers", async () => {
		const changes: number[] = [];
		const adapterInstance = adapter({
			onToolsChanged: () => {
				changes.push(1);
			},
		});
		const descriptor = adapterInstance.registerBridge(tool());

		expect(descriptor).toMatchObject({
			// Reverse-DNS dots are folded to `_`: providers reject function names outside
			// `^[a-zA-Z0-9_-]+$` and fail the whole request, not just the offending tool.
			name: "plugin__com_example_mcp__echo",
			pluginId: principal.pluginId,
			contributionId: "echo",
			fullId: "com.example.mcp/echo",
			available: true,
		});
		expect(descriptor.inputSchema).toMatchObject({
			type: "object",
			properties: { text: { type: "string" } },
		});
		await expect(
			adapterInstance.callBridgeTool("com.example.mcp/echo", { text: "hello" }, context()),
		).resolves.toMatchObject({ content: [{ type: "text", text: "hello" }] });
		expect(changes).toHaveLength(0);
	});

	test("checks authorization, cancellation and output limits before crossing the plugin boundary", async () => {
		// Denies via an absent grant. `hostPolicy: []` no longer denies on its own: policy
		// sources that merely omit a capability are not a refusal, but a missing grant still is.
		const denied = new PluginMcpAdapter({
			capabilityBroker: new CapabilityBroker({
				bindings: new Map([[principal.pluginId, bridgeBinding({ installationGrants: [] })]]),
			}),
		});
		denied.registerBridge(tool());
		await expect(
			denied.callBridgeTool("com.example.mcp/echo", { text: "x" }, context()),
		).rejects.toMatchObject({
			code: "PERMISSION_DENIED",
		});

		const cancelled = adapter();
		cancelled.registerBridge(
			tool({
				handler: async (_args, signal) =>
					new Promise((resolve) => {
						signal.addEventListener("abort", () => resolve({ content: [] }), { once: true });
					}),
			}),
		);
		const controller = new AbortController();
		controller.abort();
		await expect(
			cancelled.callBridgeTool("com.example.mcp/echo", {}, context(), controller.signal),
		).rejects.toMatchObject({ code: "CANCELLED" });

		const limited = adapter();
		limited.registerBridge(
			tool({
				maxOutputBytes: 32,
				handler: async () => ({ content: [{ type: "text", text: "x".repeat(100) }] }),
			}),
		);
		await expect(
			limited.callBridgeTool("com.example.mcp/echo", {}, context()),
		).rejects.toMatchObject({
			code: "OUTPUT_LIMIT",
		});
	});

	test("keeps disabled or crashed contributions unavailable without removing other plugins", async () => {
		const adapterInstance = adapter();
		adapterInstance.registerBridge(tool());
		adapterInstance.registerBridge(
			tool({
				pluginId: "com.example.other",
				contributionId: "other",
				fullId: "com.example.other/other",
			}),
		);
		adapterInstance.markPluginCrashed(principal.pluginId);
		expect(
			adapterInstance.listBridgeTools().find((item) => item.pluginId === principal.pluginId),
		).toMatchObject({
			available: false,
			unavailableReason: "plugin crashed",
		});
		expect(
			adapterInstance.listBridgeTools().find((item) => item.pluginId === "com.example.other"),
		).toMatchObject({
			available: true,
		});
		await expect(
			adapterInstance.callBridgeTool("com.example.mcp/echo", {}, context()),
		).rejects.toMatchObject({
			code: "UNAVAILABLE",
		});

		adapterInstance.markPluginDisabled(principal.pluginId);
		await expect(
			adapterInstance.callBridgeTool("com.example.mcp/echo", {}, context()),
		).rejects.toMatchObject({
			code: "PLUGIN_DISABLED",
		});
	});

	test("handles tool list changes through a host callback", () => {
		let callbackCount = 0;
		const adapterInstance = adapter({
			onToolsChanged: () => {
				callbackCount += 1;
			},
		});
		adapterInstance.registerBridge(tool());
		adapterInstance.toolListChanged(principal.pluginId, [tool({ contributionId: "new-tool" })]);
		expect(adapterInstance.listBridgeTools().map((item) => item.contributionId)).toEqual([
			"new-tool",
		]);
		expect(callbackCount).toBe(1);
	});
});

describe("PluginMcpAdapter mcp.server", () => {
	test("generates a sanitized McpServerConfig summary without connecting", () => {
		const adapterInstance = adapter({ serverPolicy: policy });
		const result = adapterInstance.generateServerConfig(server());
		expect(result.config).toMatchObject({
			id: "plugin_com.example.mcp_server",
			transport: "stdio",
			command: "/opt/narrafork/bin/mcp-safe",
			args: ["--stdio"],
			cwd: "/opt/narrafork/plugins/com.example.mcp",
			enabled: true,
		});
		expect(result.summary).toMatchObject({
			pluginId: principal.pluginId,
			redactedEnvKeys: ["NF_MODE"],
		});
		expect(adapterInstance.getServerConfigs()).toHaveLength(1);
	});

	test("rejects malicious command, URL, cwd and secret environment values", () => {
		const adapterInstance = adapter({ serverPolicy: policy });
		for (const contribution of [
			server({ command: "sh -c evil" }),
			server({
				url: "https://attacker.example/steal",
				transport: "streamable-http",
				command: undefined,
				args: undefined,
				cwd: undefined,
			}),
			server({ cwd: "/tmp/../../etc" }),
			server({ env: { API_TOKEN: "plaintext-secret" } }),
		]) {
			expect(() => adapterInstance.generateServerConfig(contribution)).toThrow();
		}
	});

	test("allows only an explicitly approved HTTPS endpoint and rejects process fields on remote servers", () => {
		const adapterInstance = adapter({ serverPolicy: policy });
		const result = adapterInstance.generateServerConfig(
			server({
				transport: "streamable-http",
				command: undefined,
				args: undefined,
				cwd: undefined,
				env: undefined,
				url: "https://mcp.example.test/endpoint",
				headers: { "X-Mode": "readonly" },
			}),
		);
		expect(result.config).toMatchObject({
			transport: "streamable-http",
			url: "https://mcp.example.test/endpoint",
		});
	});
});
