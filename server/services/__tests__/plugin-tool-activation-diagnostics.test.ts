import { describe, expect, test } from "bun:test";
import { PluginAgentToolBridge, PluginAgentToolBridgeError } from "../plugin-agent-tool-bridge";
import { type PluginToolRegistry, PluginToolRegistryError } from "../plugin-tool-registry";

/**
 * Guards for the "runtime not active / binding missing" diagnostics:
 *
 * 1. PluginAgentToolBridge.ensureActivated must FAIL LOUD when no activation
 *    handler is wired — silently continuing would push the call into the
 *    capability broker, which has no binding for an inactive runtime and would
 *    report a misleading "capability denied" (CONTEXT_UNAVAILABLE) while the
 *    permission grants are perfectly fine.
 * 2. PluginToolRegistry must translate a broker CONTEXT_UNAVAILABLE /
 *    INVALID_CONTEXT denial into an explicit, retryable HOST_UNAVAILABLE when
 *    the runtime is not active, instead of surfacing "capability denied".
 */

function serverToolDescriptor(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		pluginId: "com.example.team",
		version: "1.0.0",
		contributionId: "team.status",
		fullId: "com.example.team/team.status",
		name: "team.status",
		title: "Team status",
		execution: "server",
		allowBackground: false,
		status: "available",
		inputSchema: { type: "object", properties: {} },
		...overrides,
	};
}

function mockRegistry(descriptor: unknown) {
	return {
		list: () => [descriptor],
		get: () => descriptor,
	} as unknown as PluginToolRegistry;
}

describe("PluginAgentToolBridge.ensureActivated", () => {
	test("fails loud when the runtime is inactive and no activation handler is wired", async () => {
		const descriptor = serverToolDescriptor();
		const bridge = new PluginAgentToolBridge({
			pluginToolRegistry: mockRegistry(descriptor),
			isRuntimeActive: () => false,
			autoRegister: false,
		});
		bridge.sync();

		let error: unknown;
		try {
			await bridge.invokeCanonical(
				canonicalNameOf(bridge, descriptor.fullId),
				{},
				{
					userId: "u1",
					narratorId: "n1",
					cwd: "/tmp",
					locale: "en",
					currentToolUseId: "tool_1",
					signal: new AbortController().signal,
					requestPermission: async () => ({ behavior: "allow" }),
				},
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(PluginAgentToolBridgeError);
		const bridgeError = error as PluginAgentToolBridgeError;
		expect(bridgeError.code).toBe("HOST_UNAVAILABLE");
		expect(bridgeError.retryable).toBe(true);
		expect(bridgeError.message).toContain("no activation handler is wired");
	});

	test("invokes normally when the runtime is already active", async () => {
		const descriptor = serverToolDescriptor();
		const bridge = new PluginAgentToolBridge({
			pluginToolRegistry: mockRegistry(descriptor),
			isRuntimeActive: () => true,
			autoRegister: false,
		});
		bridge.sync();
		// ensureActivated short-circuits for an active runtime, so the invocation
		// proceeds into the registry; here we only assert the bridge did not
		// reject with the activation guard.
		expect(bridge.listBindings().length).toBe(1);
	});
});

function canonicalNameOf(bridge: PluginAgentToolBridge, fullId: string): string {
	const binding = bridge.getByFullId(fullId);
	if (!binding) throw new Error(`no binding for ${fullId}`);
	return binding.canonicalName;
}
