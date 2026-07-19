import { describe, expect, test } from "bun:test";
import { CapabilityBroker } from "@server/services/plugin-capability-broker";
import { PluginHostServices } from "@server/services/plugin-host-services";
import { PluginLifecycleRevokeCoordinator } from "@server/services/plugin-lifecycle-revoke-coordinator";
import type { StoredPermissionGrant } from "@server/services/plugin-permission-store";
import { createPluginLifecycleRevokeAdapters } from "@server/services/plugin-platform-services";

const pluginId = "com.example.host-services";
const runtimeId = "runtime-host-1";
const installationId = "installation-host-1";

function grant(
	capability: StoredPermissionGrant["capability"],
	revision = 4,
): StoredPermissionGrant {
	return {
		pluginId,
		installationId,
		grantId: `grant-${capability}`,
		capability,
		scope: { type: "global" },
		grantedBy: "admin-user-1",
		revision,
	};
}

function bind(
	hostServices: PluginHostServices,
	overrides: Partial<Parameters<PluginHostServices["bindRuntime"]>[0]> = {},
) {
	return hostServices.bindRuntime({
		pluginId,
		packageVersion: "1.0.0",
		installationId,
		runtimeId,
		runtimeGeneration: 3,
		grantRevision: 4,
		desiredState: "enabled",
		compatibilityState: "compatible",
		runtimeState: "active",
		trustTier: "T2",
		manifestRequested: ["diagnostics.readOwnLogs"],
		grants: [grant("diagnostics.readOwnLogs")],
		getDiagnostics: () => ({
			pluginId,
			pluginVersion: "1.0.0",
			runtimeId,
			generation: 3,
			state: "active",
			inFlight: 0,
			capabilities: ["diagnostics.readOwnLogs"],
			stderr: "token=do-not-return",
			lateMessages: 0,
		}),
		...overrides,
	});
}

describe("PluginHostServices", () => {
	test("creates a Host-owned dispatcher binding with bounded diagnostics and audit", async () => {
		const capabilityBroker = new CapabilityBroker();
		const hostServices = new PluginHostServices({ capabilityBroker });
		const runtime = bind(hostServices);

		expect(capabilityBroker.hasBinding(pluginId, runtimeId)).toBe(true);
		expect(runtime.grantRevision).toBe(4);
		const response = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "diagnostics",
			method: "diagnostics.getOwn",
			params: {},
		});
		expect(response).toMatchObject({
			jsonrpc: "2.0",
			id: "diagnostics",
			result: {
				plugin: {
					pluginId,
					installationId,
					runtimeId,
					runtimeGeneration: 3,
				},
				grantRevision: 4,
				capabilities: ["diagnostics.readOwnLogs"],
				runtime: { state: "active", generation: 3 },
			},
		});
		expect(JSON.stringify(response)).not.toContain("do-not-return");
		expect(hostServices.getDiagnostics().auditEntries.at(-1)).toMatchObject({
			pluginId,
			runtimeId,
			generation: 3,
			method: "diagnostics.getOwn",
			outcome: "succeeded",
		});
	});

	test("uses the runtime-scoped read-only query handler instead of a global fallback", async () => {
		const capabilityBroker = new CapabilityBroker();
		const hostServices = new PluginHostServices({ capabilityBroker });
		const runtime = bind(hostServices, {
			manifestRequested: ["query.read.audit_self"],
			grants: [grant("query.read.audit_self")],
			queryHandler: ({ queryId, input }) => ({ queryId, input: input ?? null, source: "runtime" }),
		});
		const response = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "query",
			method: "queries.execute",
			params: { queryId: "narrafork.plugin.getOwn", input: { include: "summary" } },
		});
		expect(response).toMatchObject({
			result: {
				queryId: "narrafork.plugin.getOwn",
				input: { include: "summary" },
				source: "runtime",
			},
		});
	});

	test("fails closed after a runtime binding is revoked and excludes unrequested grants", async () => {
		const capabilityBroker = new CapabilityBroker();
		const hostServices = new PluginHostServices({ capabilityBroker });
		const runtime = bind(hostServices, {
			manifestRequested: [],
			grants: [grant("diagnostics.readOwnLogs")],
		});
		const unrequested = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "unrequested",
			method: "diagnostics.getOwn",
			params: {},
		});
		expect("error" in unrequested).toBe(true);

		bind(hostServices);
		expect(hostServices.revokeRuntime(pluginId, runtimeId, 3)).toBe(1);
		expect(capabilityBroker.hasBinding(pluginId, runtimeId)).toBe(false);
		const revoked = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "revoked",
			method: "diagnostics.getOwn",
			params: {},
		});
		expect("error" in revoked).toBe(true);
		if ("error" in revoked) {
			expect(revoked.error.data).toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
		}
	});

	test("revokes the stale runtimeId binding before later lifecycle layers on generation change", async () => {
		const capabilityBroker = new CapabilityBroker();
		const hostServices = new PluginHostServices({ capabilityBroker });
		const firstGeneration = bind(hostServices, { runtimeGeneration: 1 });
		const observed: Array<{ layer: string; bindingPresent: boolean }> = [];
		const record = (layer: string) => {
			observed.push({ layer, bindingPresent: capabilityBroker.hasBinding(pluginId, runtimeId) });
		};
		const coordinator = new PluginLifecycleRevokeCoordinator({
			adapters: createPluginLifecycleRevokeAdapters({
				uiSession: { clearForPlugin: () => record("ui_session") },
				capabilityBroker,
				hostServices,
				eventGateway: { revokeRuntime: () => record("event_gateway") },
				scheduler: { revokePlugin: () => record("scheduler") },
				secretBroker: { revokePlugin: () => record("secret_broker") },
				toolRegistry: { runtimeCrashed: () => record("tool_registry") },
				mcpAdapter: { markUnavailable: () => record("mcp_adapter") },
				providerRegistry: { list: () => [] },
			} as never),
		});

		const report = await coordinator.revoke({
			eventId: "generation-change-1",
			pluginId,
			kind: "runtime_generation",
			runtimeId,
			runtimeGeneration: 2,
			reason: "test-generation-change",
		});
		expect(report.steps.map((step) => step.layer)).toEqual([
			"ui_session",
			"capability_broker",
			"event_gateway",
			"scheduler",
			"secret_broker",
			"tool_registry",
			"mcp_adapter",
			"provider_registry",
		]);
		expect(hostServices.hasRuntimeBinding(pluginId, runtimeId)).toBe(false);
		expect(capabilityBroker.hasBinding(pluginId, runtimeId)).toBe(false);
		expect(observed).toEqual([
			{ layer: "ui_session", bindingPresent: true },
			{ layer: "event_gateway", bindingPresent: false },
			{ layer: "scheduler", bindingPresent: false },
			{ layer: "secret_broker", bindingPresent: false },
			{ layer: "tool_registry", bindingPresent: false },
			{ layer: "mcp_adapter", bindingPresent: false },
		]);

		const secondGeneration = bind(hostServices, {
			runtimeGeneration: 2,
			getDiagnostics: () => ({
				pluginId,
				pluginVersion: "1.0.0",
				runtimeId,
				generation: 2,
				state: "active",
				inFlight: 0,
				capabilities: ["diagnostics.readOwnLogs"],
				stderr: "",
				lateMessages: 0,
			}),
		});
		expect(secondGeneration.dispatcher).toBe(firstGeneration.dispatcher);
		const rebound = await firstGeneration.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "generation-2-diagnostics",
			method: "diagnostics.getOwn",
			params: {},
		});
		expect(rebound).toMatchObject({
			result: {
				plugin: { runtimeGeneration: 2 },
				runtime: { generation: 2 },
			},
		});
	});
});
