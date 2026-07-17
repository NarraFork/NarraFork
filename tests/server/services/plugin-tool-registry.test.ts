import { describe, expect, test } from "bun:test";
import type { ManifestInput } from "@server/lib/plugins/manifest";
import type { HostCallContext, PluginPrincipal } from "@server/services/plugin-capability-broker";
import {
	type PluginToolCapabilityBroker,
	PluginToolRegistry,
	PluginToolRegistryError,
} from "@server/services/plugin-tool-registry";

const principal: PluginPrincipal = {
	pluginId: "com.example.tools",
	packageVersion: "1.0.0",
	runtimeId: "runtime-1",
	runtimeGeneration: 2,
	installationId: "installation-1",
};

function manifest(
	tools: Array<{
		id: string;
		title?: string;
		inputSchema?: Record<string, unknown>;
		allowBackground?: boolean;
	}> = [{ id: "echo" }],
): ManifestInput {
	return {
		schemaVersion: 1,
		pluginId: principal.pluginId,
		version: principal.packageVersion,
		displayName: "Tool test plugin",
		engine: {
			runtime: "bun",
			hostApi: ">=1.0 <2",
			rpc: "narrafork.rpc/1",
			runner: "local-process",
		},
		server: {
			entry: "server/index.ts",
			transport: "stdio",
			protocol: "narrafork.rpc/1",
			args: [],
			workingDirectory: "package",
			startupTimeoutMs: 15_000,
			activationTimeoutMs: 30_000,
		},
		activationEvents: tools.map((tool) => `onTool:${tool.id}`),
		contributes: {
			providers: [],
			commands: [],
			events: [],
			views: [],
			tools: tools.map((tool) => ({
				id: tool.id,
				title: tool.title ?? tool.id,
				description: "Test tool",
				inputSchema: tool.inputSchema ?? {
					type: "object",
					properties: { text: { type: "string", minLength: 1 } },
					required: ["text"],
					additionalProperties: false,
				},
				execution: "server",
				allowBackground: tool.allowBackground ?? false,
			})),
		},
		permissions: {
			host: ["provider.use"],
			network: { mode: "none", allow: [] },
			filesystem: {
				package: "readOnly",
				pluginData: "readWrite",
				workspace: "none",
			},
			process: { spawn: "none" },
		},
		secrets: [],
		dependencies: { plugins: {}, runtime: {} },
	};
}

function context(overrides: Partial<HostCallContext> = {}): HostCallContext {
	return {
		requestId: "request-1",
		correlationId: "correlation-1",
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		plugin: principal,
		invocation: {
			kind: "user",
			userId: "user-1",
			userRole: "user",
			source: "command",
		},
		scope: { projectId: "project-1", narratorId: "narrator-1" },
		...overrides,
	};
}

function broker(
	authorize: PluginToolCapabilityBroker["authorize"] = async () => ({ allowed: true }),
): PluginToolCapabilityBroker {
	return { authorize };
}

describe("PluginToolRegistry", () => {
	test("registers immutable descriptors from Manifest and rejects duplicates", () => {
		const registry = new PluginToolRegistry({ capabilityBroker: broker() });
		const [descriptor] = registry.registerManifest(manifest(), { principal });

		expect(descriptor).toMatchObject({
			pluginId: principal.pluginId,
			contributionId: "echo",
			fullId: `${principal.pluginId}/echo`,
			status: "available",
		});
		expect(registry.get(descriptor.fullId)?.inputSchema).toEqual({
			type: "object",
			properties: { text: { type: "string", minLength: 1 } },
			required: ["text"],
			additionalProperties: false,
		});
		expect(() => registry.registerManifest(manifest(), { principal })).toThrow(
			expect.objectContaining({ code: "CONFLICT" }),
		);
	});

	test("strictly validates schema input before authorization or execution", async () => {
		let authorizeCalls = 0;
		let handlerCalls = 0;
		const registry = new PluginToolRegistry({
			capabilityBroker: broker(async () => {
				authorizeCalls += 1;
				return { allowed: true };
			}),
			handler: () => {
				handlerCalls += 1;
				return "ok";
			},
		});
		const [descriptor] = registry.registerManifest(manifest(), { principal });

		await expect(
			registry.invoke(
				descriptor.fullId,
				{ text: "hello", unexpected: true },
				{ context: context() },
			),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		await expect(
			registry.invoke(descriptor.fullId, { text: "" }, { context: context() }),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		expect(authorizeCalls).toBe(0);
		expect(handlerCalls).toBe(0);
	});

	test("authorizes with a host-bound principal and freezes target/permission for Runtime request", async () => {
		const authorization: Array<{ context: HostCallContext; capability: string }> = [];
		let runtimeParams: unknown;
		const registry = new PluginToolRegistry({
			capabilityBroker: broker(async (request) => {
				authorization.push({ context: request.context, capability: request.capability });
				return { allowed: true };
			}),
			resolveRuntime: () => ({
				request: async (_method, params) => {
					runtimeParams = params;
					return { output: "done", metadata: { safe: true } };
				},
			}),
		});
		const [descriptor] = registry.registerManifest(manifest(), { principal });
		const forgedContext = context({
			plugin: {
				...principal,
				pluginId: "com.example.forged",
				runtimeId: "forged-runtime",
			},
		});

		const result = await registry.invoke(
			descriptor.fullId,
			{ text: "hello" },
			{
				context: forgedContext,
				target: { kind: "device", deviceId: "device-1", backendKind: "remote" },
				permission: { behavior: "allow", decisionId: "permission-1", decidedBy: "user-1" },
			},
		);

		expect(result).toEqual({ output: "done", metadata: { safe: true } });
		expect(authorization).toHaveLength(1);
		expect(authorization[0]).toMatchObject({
			capability: "provider.use",
			context: {
				plugin: {
					pluginId: principal.pluginId,
					runtimeId: principal.runtimeId,
				},
			},
		});
		expect(runtimeParams).toMatchObject({
			contributionId: "echo",
			input: { text: "hello" },
			context: {
				target: { kind: "device", deviceId: "device-1", backendKind: "remote" },
				permission: { behavior: "allow", decisionId: "permission-1" },
				invocation: { kind: "user", userId: "user-1", source: "command" },
			},
		});
		expect(JSON.stringify(runtimeParams)).not.toContain("decidedBy");
		expect(JSON.stringify(runtimeParams)).not.toContain("com.example.forged");
	});

	test("fails closed when CapabilityBroker denies the invocation", async () => {
		let handlerCalls = 0;
		const registry = new PluginToolRegistry({
			capabilityBroker: broker(async () => ({
				allowed: false,
				error: { code: "PERMISSION_DENIED", reason: "CAPABILITY_NOT_GRANTED" },
			})),
			handler: () => {
				handlerCalls += 1;
				return "no";
			},
		});
		const [descriptor] = registry.registerManifest(manifest(), { principal });

		await expect(
			registry.invoke(descriptor.fullId, { text: "hello" }, { context: context() }),
		).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
		expect(handlerCalls).toBe(0);
		expect(registry.getAuditEntries().at(-1)).toMatchObject({ outcome: "denied" });
	});

	test("propagates caller cancellation to the handler", async () => {
		let observedAbort = false;
		const registry = new PluginToolRegistry({
			capabilityBroker: broker(),
			defaultTimeoutMs: 200,
			handler: (_input, toolContext) =>
				new Promise((_resolve, reject) => {
					if (toolContext.signal.aborted) {
						observedAbort = true;
						reject(new DOMException("cancelled", "AbortError"));
						return;
					}
					toolContext.signal.addEventListener("abort", () => {
						observedAbort = true;
						reject(new DOMException("cancelled", "AbortError"));
					});
				}),
		});
		const [descriptor] = registry.registerManifest(manifest(), { principal });
		const controller = new AbortController();
		const invocation = registry.invoke(
			descriptor.fullId,
			{ text: "hello" },
			{ context: context(), signal: controller.signal },
		);
		controller.abort("test-cancel");

		await expect(invocation).rejects.toMatchObject({ name: "AbortError" });
		expect(observedAbort).toBe(true);
		expect(registry.getAuditEntries().at(-1)).toMatchObject({ outcome: "cancelled" });
	});

	test("enforces the host timeout and aborts the tool handler", async () => {
		let observedAbort = false;
		const registry = new PluginToolRegistry({
			capabilityBroker: broker(),
			defaultTimeoutMs: 15,
			maxTimeoutMs: 20,
			handler: (_input, toolContext) =>
				new Promise((_resolve, reject) => {
					toolContext.signal.addEventListener("abort", () => {
						observedAbort = true;
						reject(new DOMException("timed out", "AbortError"));
					});
				}),
		});
		const [descriptor] = registry.registerManifest(manifest(), { principal });

		await expect(
			registry.invoke(descriptor.fullId, { text: "hello" }, { context: context() }),
		).rejects.toMatchObject({ code: "TIMEOUT" });
		expect(observedAbort).toBe(true);
		expect(registry.getAuditEntries().at(-1)).toMatchObject({
			outcome: "timeout",
			errorCode: "TIMEOUT",
		});
	});

	test("rejects oversized output instead of silently truncating it", async () => {
		const registry = new PluginToolRegistry({
			capabilityBroker: broker(),
			maxOutputBytes: 32,
			handler: () => ({ output: "x".repeat(200) }),
		});
		const [descriptor] = registry.registerManifest(manifest(), { principal });

		await expect(
			registry.invoke(descriptor.fullId, { text: "hello" }, { context: context() }),
		).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
		expect(registry.getAuditEntries().at(-1)).toMatchObject({
			outcome: "failed",
			errorCode: "PAYLOAD_TOO_LARGE",
		});
	});

	test("retains disabled and crashed tools as unavailable descriptors", async () => {
		const registry = new PluginToolRegistry({
			capabilityBroker: broker(),
			handler: () => "ok",
		});
		const [descriptor] = registry.registerManifest(manifest(), { principal });

		expect(registry.disablePlugin(principal.pluginId)).toBe(1);
		expect(registry.get(descriptor.fullId)).toMatchObject({
			status: "unavailable",
			unavailableReason: "plugin-disabled",
		});
		await expect(
			registry.invoke(descriptor.fullId, { text: "hello" }, { context: context() }),
		).rejects.toMatchObject({ code: "PLUGIN_DISABLED" });

		expect(registry.enablePlugin(principal.pluginId)).toBe(1);
		expect(registry.runtimeCrashed(principal.pluginId)).toBe(1);
		expect(registry.get(descriptor.fullId)).toMatchObject({
			status: "unavailable",
			unavailableReason: "runtime-crashed",
		});
	});

	test("rejects plugin attempts to append target/principal/permission fields to the result", async () => {
		const registry = new PluginToolRegistry({
			capabilityBroker: broker(),
			resolveRuntime: () => ({
				request: async () => ({ output: "done", target: "other-device" }),
			}),
		});
		const [descriptor] = registry.registerManifest(manifest(), { principal });

		await expect(
			registry.invoke(descriptor.fullId, { text: "hello" }, { context: context() }),
		).rejects.toBeInstanceOf(PluginToolRegistryError);
		await expect(
			registry.invoke(descriptor.fullId, { text: "hello" }, { context: context() }),
		).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
	});
});
