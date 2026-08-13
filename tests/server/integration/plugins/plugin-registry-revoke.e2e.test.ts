import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Manifest, parseManifest } from "@server/lib/plugins/manifest";
import {
	CapabilityBroker,
	type HostCallContext,
	type PluginCapabilityBindingInput,
	type PluginPrincipal,
} from "@server/services/plugin-capability-broker";
import { PluginCatalog } from "@server/services/plugin-catalog";
import { PluginContributionRegistry } from "@server/services/plugin-contribution-registry";
import { PluginEventGateway } from "@server/services/plugin-event-gateway";
import {
	PLUGIN_LIFECYCLE_REVOKE_LAYERS,
	type PluginLifecycleRevokeAdapters,
	PluginLifecycleRevokeCoordinator,
} from "@server/services/plugin-lifecycle-revoke-coordinator";
import { PluginPackageStore } from "@server/services/plugin-package-store";
import { PluginToolRegistry } from "@server/services/plugin-tool-registry";
import { PluginUiSessionService } from "@server/services/plugin-ui-session";

const toolFixture = join(import.meta.dir, "../../../fixtures/plugins/e2e/reference-tool-rpc");
const uiFixture = join(import.meta.dir, "../../../fixtures/plugins/e2e/reference-ui-hostile");
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-registry-"));
	tempRoots.push(root);
	return root;
}

async function readManifest(root: string): Promise<Manifest> {
	return parseManifest(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")));
}

function peerManifest(source: Manifest): Manifest {
	const raw = structuredClone(source) as unknown as Record<string, unknown>;
	raw.pluginId = "com.example.tool-command-peer";
	raw.displayName = "Reference Tool Peer";
	return parseManifest(raw);
}

function principal(pluginId: string): PluginPrincipal {
	return {
		pluginId,
		packageVersion: "1.0.0",
		runtimeId: `rt-${pluginId}`,
		runtimeGeneration: 1,
		contributionId: "describe-selection",
		installationId: `installation-${pluginId}`,
	};
}

function binding(
	plugin: PluginPrincipal,
	revision = 1,
	granted = true,
): PluginCapabilityBindingInput {
	const capabilities = granted ? (["ui.panel"] as const) : ([] as const);
	return {
		plugin,
		desiredState: "enabled",
		compatibilityState: "compatible",
		runtimeState: "active",
		runtimeGeneration: plugin.runtimeGeneration,
		manifestRequested: ["ui.panel"],
		installationGrants: granted
			? [
					{
						capability: "ui.panel",
						scope: { type: "global" },
						grantId: `grant-${plugin.pluginId}`,
					},
				]
			: [],
		hostPolicy: capabilities,
		currentUserAuthority: capabilities,
		contributionPolicy: capabilities,
		runnerEnforcement: capabilities,
		grantRevision: revision,
	};
}

function context(broker: CapabilityBroker, plugin: PluginPrincipal): HostCallContext {
	return broker.withCallContext({
		requestId: `request-${plugin.pluginId}`,
		correlationId: `correlation-${plugin.pluginId}`,
		deadlineAt: new Date(Date.now() + 30_000).toISOString(),
		plugin,
		invocation: { kind: "user", userId: "user-1", userRole: "admin", source: "ui" },
		scope: { userId: "user-1" },
	});
}

interface RevokeHarness {
	pluginA: PluginPrincipal;
	pluginB: PluginPrincipal;
	contextA: HostCallContext;
	contextB: HostCallContext;
	broker: CapabilityBroker;
	uiSessions: PluginUiSessionService;
	eventGateway: PluginEventGateway;
	toolRegistry: PluginToolRegistry;
	coordinator: PluginLifecycleRevokeCoordinator;
	subscriptionA: string;
	subscriptionB: string;
	sessionA: string;
	sessionB: string;
	stubCalls: string[];
}

async function createRevokeHarness(): Promise<RevokeHarness> {
	const sourceManifest = await readManifest(toolFixture);
	const secondManifest = peerManifest(sourceManifest);
	const pluginA = principal(sourceManifest.pluginId);
	const pluginB = principal(secondManifest.pluginId);
	const broker = new CapabilityBroker({ cacheTtlMs: 60_000 });
	broker.setBinding(pluginA.pluginId, binding(pluginA));
	broker.setBinding(pluginB.pluginId, binding(pluginB));
	const contextA = context(broker, pluginA);
	const contextB = context(broker, pluginB);

	const uiSessions = new PluginUiSessionService({ ttlMs: 60_000, maxSessions: 20 });
	const sessionA = uiSessions.create({
		pluginId: pluginA.pluginId,
		version: pluginA.packageVersion,
		hash: "a".repeat(64),
		authorityInstallationId: pluginA.installationId,
		principalId: "user-1",
		contributionId: pluginA.contributionId ?? "describe-selection",
		panelInstanceId: "panel-a",
		surface: "workspace",
		surfaceScope: "global",
	}).session.sessionId;
	const sessionB = uiSessions.create({
		pluginId: pluginB.pluginId,
		version: pluginB.packageVersion,
		hash: "b".repeat(64),
		authorityInstallationId: pluginB.installationId,
		principalId: "user-1",
		contributionId: pluginB.contributionId ?? "describe-selection",
		panelInstanceId: "panel-b",
		surface: "workspace",
		surfaceScope: "global",
	}).session.sessionId;

	const eventGateway = new PluginEventGateway({
		registerListener: false,
		capabilityBroker: { authorize: () => true },
		maxSubscriptions: 20,
		defaultQueueEvents: 10,
		defaultQueueBytes: 32 * 1024,
	});
	const subscriptionA = (
		await eventGateway.subscribe({
			plugin: {
				pluginId: pluginA.pluginId,
				runtimeId: pluginA.runtimeId,
				generation: pluginA.runtimeGeneration,
				contributionId: pluginA.contributionId,
				packageVersion: pluginA.packageVersion,
			},
			topics: ["narrafork.plugin.lifecycle"],
			mode: "live",
		})
	).subscriptionId;
	const subscriptionB = (
		await eventGateway.subscribe({
			plugin: {
				pluginId: pluginB.pluginId,
				runtimeId: pluginB.runtimeId,
				generation: pluginB.runtimeGeneration,
				contributionId: pluginB.contributionId,
				packageVersion: pluginB.packageVersion,
			},
			topics: ["narrafork.plugin.lifecycle"],
			mode: "live",
		})
	).subscriptionId;

	const toolRegistry = new PluginToolRegistry({
		capabilityBroker: { authorize: async () => ({ allowed: true }) },
	});
	toolRegistry.registerManifest(sourceManifest, { principal: pluginA });
	toolRegistry.registerManifest(secondManifest, { principal: pluginB });

	const stubCalls: string[] = [];
	const adapters: PluginLifecycleRevokeAdapters = {
		ui_session: ({ event }) => {
			uiSessions.clearForPlugin(event.pluginId);
		},
		capability_broker: ({ event, action }) => {
			if (action === "clear") broker.clearBindingsForPlugin(event.pluginId);
			else if (action === "invalidate") broker.invalidate(event.pluginId);
			else broker.revoke(event.pluginId);
		},
		event_gateway: ({ event, action }) => {
			if (action === "invalidate" && event.runtimeId) {
				eventGateway.revokeRuntime(event.pluginId, event.runtimeId);
			} else {
				eventGateway.revokePlugin(event.pluginId);
			}
		},
		tool_registry: ({ event, action }) => {
			if (action === "clear") toolRegistry.removePlugin(event.pluginId);
			else if (action === "invalidate") toolRegistry.runtimeCrashed(event.pluginId);
			else if (action === "revoke") toolRegistry.revokePlugin(event.pluginId);
			else toolRegistry.disablePlugin(event.pluginId);
		},
		scheduler: ({ layer, action }) => {
			stubCalls.push(`${layer}:${action}`);
		},
		secret_broker: ({ layer, action }) => {
			stubCalls.push(`${layer}:${action}`);
		},
		mcp_adapter: ({ layer, action }) => {
			stubCalls.push(`${layer}:${action}`);
		},
		provider_registry: ({ layer, action }) => {
			stubCalls.push(`${layer}:${action}`);
		},
	};
	const coordinator = new PluginLifecycleRevokeCoordinator({ adapters });
	return {
		pluginA,
		pluginB,
		contextA,
		contextB,
		broker,
		uiSessions,
		eventGateway,
		toolRegistry,
		coordinator,
		subscriptionA,
		subscriptionB,
		sessionA,
		sessionB,
		stubCalls,
	};
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("C2 registry and lifecycle revoke acceptance", () => {
	test("keeps catalog contribution count equal to the host-owned contribution registry", async () => {
		const root = await makeTempRoot();
		const store = new PluginPackageStore(root);
		await store.install(toolFixture);
		await store.install(uiFixture);
		const snapshot = await new PluginCatalog(root).scan();
		const registry = new PluginContributionRegistry(snapshot);
		const catalogEntries = snapshot.plugins.flatMap((plugin) => plugin.contributions);

		expect(snapshot.plugins).toHaveLength(2);
		expect(catalogEntries).toHaveLength(3);
		expect(registry.list()).toHaveLength(catalogEntries.length);
		expect(registry.listByKind("tool")).toHaveLength(1);
		expect(registry.listByKind("view")).toHaveLength(2);

		registry.refresh(snapshot);
		expect(registry.list()).toHaveLength(catalogEntries.length);
		expect(new Set(registry.list().map((entry) => entry.fullId)).size).toBe(catalogEntries.length);
	});

	test("disable revokes one plugin across UI, capability, event, and tool layers only", async () => {
		const harness = await createRevokeHarness();
		try {
			expect(
				(
					await harness.broker.authorize({
						context: harness.contextA,
						capability: "ui.panel",
					})
				).allowed,
			).toBe(true);
			expect(
				(
					await harness.broker.authorize({
						context: harness.contextB,
						capability: "ui.panel",
					})
				).allowed,
			).toBe(true);

			const report = await harness.coordinator.revoke({
				eventId: "acceptance-disable-a",
				pluginId: harness.pluginA.pluginId,
				kind: "disable",
				runtimeId: harness.pluginA.runtimeId,
				runtimeGeneration: harness.pluginA.runtimeGeneration,
				reason: "acceptance-disable",
			});

			expect(report.status).toBe("succeeded");
			expect(report.steps).toHaveLength(PLUGIN_LIFECYCLE_REVOKE_LAYERS.length);
			expect(harness.uiSessions.get(harness.sessionA)).toBeUndefined();
			expect(harness.uiSessions.get(harness.sessionB)).toBeDefined();

			const denied = await harness.broker.authorize({
				context: harness.contextA,
				capability: "ui.panel",
			});
			expect(denied.allowed).toBe(false);
			if (!denied.allowed) expect(denied.error.reason).toBe("GRANT_REVOKED");
			expect(
				(
					await harness.broker.authorize({
						context: harness.contextB,
						capability: "ui.panel",
					})
				).allowed,
			).toBe(true);

			expect(
				harness.eventGateway
					.listSubscriptionDiagnostics()
					.some((item) => item.subscriptionId === harness.subscriptionA),
			).toBe(false);
			expect(
				harness.eventGateway
					.listSubscriptionDiagnostics()
					.some((item) => item.subscriptionId === harness.subscriptionB),
			).toBe(true);
			expect(
				harness.toolRegistry.get(`${harness.pluginA.pluginId}/describe-selection`)?.status,
			).toBe("unavailable");
			expect(
				harness.toolRegistry.get(`${harness.pluginB.pluginId}/describe-selection`)?.status,
			).toBe("available");
			expect(harness.stubCalls).toHaveLength(4);
		} finally {
			harness.eventGateway.close();
		}
	});

	test("grant revision invalidates old bindings, sessions, subscriptions, and tools", async () => {
		const harness = await createRevokeHarness();
		try {
			harness.broker.setBinding(harness.pluginA.pluginId, binding(harness.pluginA, 2, false));
			const report = await harness.coordinator.revoke({
				eventId: "acceptance-grant-revision-a",
				pluginId: harness.pluginA.pluginId,
				kind: "grant_revision",
				runtimeId: harness.pluginA.runtimeId,
				runtimeGeneration: harness.pluginA.runtimeGeneration,
				grantRevision: 2,
				reason: "grant-revision-changed",
			});

			expect(report.status).toBe("succeeded");
			expect(harness.uiSessions.get(harness.sessionA)).toBeUndefined();
			const denied = await harness.broker.authorize({
				context: harness.contextA,
				capability: "ui.panel",
			});
			expect(denied.allowed).toBe(false);
			expect(
				harness.eventGateway
					.listSubscriptionDiagnostics()
					.some((item) => item.subscriptionId === harness.subscriptionA),
			).toBe(false);
			expect(
				harness.toolRegistry.get(`${harness.pluginA.pluginId}/describe-selection`)?.status,
			).toBe("unavailable");

			expect(harness.uiSessions.get(harness.sessionB)).toBeDefined();
			expect(
				(
					await harness.broker.authorize({
						context: harness.contextB,
						capability: "ui.panel",
					})
				).allowed,
			).toBe(true);
			expect(
				harness.eventGateway
					.listSubscriptionDiagnostics()
					.some((item) => item.subscriptionId === harness.subscriptionB),
			).toBe(true);
		} finally {
			harness.eventGateway.close();
		}
	});

	test.skip("[BLOCKER] PluginManager refresh atomically populates contribution/tool registries", () => {
		// Unskip when the production manager owns a generation-aware contribution coordinator.
	});

	test.skip("[BLOCKER] catalog preserves each view's entryPath/stylePath", async () => {
		const root = await makeTempRoot();
		await new PluginPackageStore(root).install(uiFixture);
		const snapshot = await new PluginCatalog(root).scan();
		const views = snapshot.plugins[0]?.contributions.filter((item) => item.kind === "view") ?? [];
		expect(views).toHaveLength(2);
		expect(views[0]).toHaveProperty("entry");
		expect(views[0]).toHaveProperty("style");
	});
});
