import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_TO_HOST_REQUEST_METHODS } from "@server/lib/plugins/protocol";
import { CapabilityBroker } from "@server/services/plugin-capability-broker";
import { PluginEventGateway } from "@server/services/plugin-event-gateway";
import { PluginHostServices } from "@server/services/plugin-host-services";
import { PluginLifecycleRevokeCoordinator } from "@server/services/plugin-lifecycle-revoke-coordinator";
import type { StoredPermissionGrant } from "@server/services/plugin-permission-store";
import {
	createPluginLifecycleRevokeAdapters,
	createPluginPlatformServices,
} from "@server/services/plugin-platform-services";
import { PluginPublicApi } from "@server/services/plugin-public-api";
import { PluginStorageFactory } from "@server/services/plugin-storage";
import { z } from "zod";

const pluginId = "com.example.host-services";
const runtimeId = "runtime-host-1";
const installationId = "installation-host-1";
const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
	test("composes one public API, registry pair, event gateway, and storage factory", async () => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-platform-services-"));
		tempRoots.push(root);
		const platform = createPluginPlatformServices({ storageRoot: root });
		expect(platform.publicApi.queries).toBe(platform.queryRegistry);
		expect(platform.publicApi.commands).toBe(platform.commandRegistry);
		expect(platform.hostServices.publicApi).toBe(platform.publicApi);
		expect(platform.hostServices.eventGateway).toBe(platform.eventGateway);
		expect(platform.hostServices.storageFactory).toBe(platform.storageFactory);
		platform.eventGateway.close();
	});

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

	test("keeps admin-approved capabilities outside the manifest when binding", async () => {
		const capabilityBroker = new CapabilityBroker();
		const hostServices = new PluginHostServices({ capabilityBroker });
		const approvedCapability = "query.read.audit_self";
		const runtime = bind(hostServices, {
			manifestRequested: ["diagnostics.readOwnLogs"],
			grants: [grant("diagnostics.readOwnLogs"), grant(approvedCapability)],
		});

		// The binding snapshot keeps the admin-approved grant even though the manifest
		// did not declare it — filtering it here would silently undo the approval and
		// the plugin would keep re-raising the same pending request.
		expect((runtime.binding.installationGrants ?? []).map((g) => g.capability)).toEqual([
			"diagnostics.readOwnLogs",
			approvedCapability,
		]);
		// The requested set is extended so reporting / denial reasons stay consistent.
		expect(runtime.binding.manifestRequested).toContain(approvedCapability);
		expect(runtime.binding.hostPolicy).toContain(approvedCapability);

		// And the broker authorizes the approved capability on the next call.
		const result = await capabilityBroker.authorize({
			context: {
				requestId: "request-approved-1",
				correlationId: "correlation-approved-1",
				deadlineAt: new Date(Date.now() + 60_000).toISOString(),
				plugin: {
					pluginId,
					packageVersion: "1.0.0",
					runtimeId,
					runtimeGeneration: 3,
					installationId,
				},
				invocation: { kind: "user", userId: "user-1", userRole: "user", source: "ui" },
				scope: { userId: "user-1", projectId: "project-1" },
			},
			capability: approvedCapability,
			methodId: "audit.read",
		});
		expect(result.allowed).toBe(true);
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

	test("keeps the backend Host method inventory at protocol parity and wires every method", async () => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-host-parity-"));
		tempRoots.push(root);
		const capabilityBroker = new CapabilityBroker();
		const publicApi = new PluginPublicApi({ capabilityBroker, registerBuiltIns: false });
		publicApi.queries.register({
			queryId: "narrafork.test.query",
			capability: "query.read.projects",
			inputSchema: z.object({ value: z.string() }).strict(),
			handler: async (input) => ({ data: { echoed: input.value } }),
		});
		publicApi.commands.register({
			commandId: "narrafork.test.command",
			capability: "command.chapter.write",
			inputSchema: z.object({ value: z.string() }).strict(),
			sideEffect: "none",
			handler: async (input) => ({ data: { echoed: input.value } }),
		});
		const eventGateway = new PluginEventGateway({
			registerListener: false,
			capabilityBroker: { authorize: () => true, isRuntimeActive: () => true },
		});
		const hostServices = new PluginHostServices({
			capabilityBroker,
			publicApi,
			eventGateway,
			storageFactory: new PluginStorageFactory({ root }),
		});
		const capabilities: StoredPermissionGrant["capability"][] = [
			"query.read.projects",
			"command.chapter.write",
			"event.subscribe.public",
			"storage.read_self",
			"storage.write_self",
			"diagnostics.readOwnLogs",
		];
		const runtime = bind(hostServices, {
			manifestRequested: capabilities,
			grants: capabilities.map((capability) => grant(capability)),
			scope: { workspaceId: "workspace-bound" },
		});
		expect(runtime.dispatcher.listMethods()).toEqual([...PLUGIN_TO_HOST_REQUEST_METHODS].sort());

		const query = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "query-parity",
			method: "queries.execute",
			params: { queryId: "narrafork.test.query", input: { value: "query" } },
		});
		expect(query).toMatchObject({ result: { status: "succeeded", data: { echoed: "query" } } });

		const command = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "command-parity",
			method: "commands.execute",
			params: { commandId: "narrafork.test.command", input: { value: "command" } },
		});
		expect(command).toMatchObject({
			result: { status: "succeeded", data: { echoed: "command" } },
		});

		const subscribed = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "events-subscribe-parity",
			method: "events.subscribe",
			params: { topics: ["narrafork.events.overflow"] },
		});
		expect("result" in subscribed).toBe(true);
		if (!("result" in subscribed) || !isRecord(subscribed.result)) {
			throw new Error("Event subscription did not return a result");
		}
		const subscriptionId = subscribed.result.subscriptionId;
		if (typeof subscriptionId !== "string") throw new Error("Missing subscription id");
		const polled = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "events-poll-parity",
			method: "events.poll",
			params: { subscriptionId, limit: 10 },
		});
		expect(polled).toMatchObject({
			result: { subscriptionId, events: [], hasMore: false },
		});
		const unsubscribed = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "events-unsubscribe-parity",
			method: "events.unsubscribe",
			params: { subscriptionId },
		});
		expect(unsubscribed).toMatchObject({
			result: { subscriptionId, unsubscribed: true },
		});

		const scope = { type: "workspace", id: "workspace-bound" } as const;
		const stored = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "storage-set-parity",
			method: "storage.set",
			params: { scope, key: "shared", value: { enabled: true } },
		});
		expect(stored).toMatchObject({ result: { key: "shared", revision: 1 } });
		const loaded = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "storage-get-parity",
			method: "storage.get",
			params: { scope, key: "shared" },
		});
		expect(loaded).toMatchObject({ result: { key: "shared", value: { enabled: true } } });
		const listed = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "storage-list-parity",
			method: "storage.list",
			params: { scope, prefix: "sha" },
		});
		expect(listed).toMatchObject({ result: { items: [{ key: "shared", revision: 1 }] } });
		const deleted = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "storage-delete-parity",
			method: "storage.delete",
			params: { scope, key: "shared", expectedRevision: 1 },
		});
		expect(deleted).toMatchObject({ result: true });
		const outside = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "storage-outside-parity",
			method: "storage.get",
			params: { scope: { type: "workspace", id: "workspace-forged" }, key: "shared" },
		});
		expect(outside).toMatchObject({ error: { data: { code: "PERMISSION_DENIED" } } });

		const diagnostics = await runtime.dispatcher.dispatch({
			jsonrpc: "2.0",
			id: "diagnostics-parity",
			method: "diagnostics.getOwn",
			params: {},
		});
		expect(diagnostics).toMatchObject({ result: { plugin: { pluginId, runtimeId } } });
		eventGateway.close();
	});

	test("fails closed after a runtime binding is revoked and excludes unrequested grants", async () => {
		const capabilityBroker = new CapabilityBroker();
		const hostServices = new PluginHostServices({ capabilityBroker });
		// Neither declared by the manifest nor granted: the call must be denied. The
		// grant list is the authoritative allow set — a manifest declaration alone is
		// not enough (grants are seeded at install), and an admin-approved grant is
		// enough even without a declaration.
		const runtime = bind(hostServices, {
			manifestRequested: [],
			grants: [],
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
