import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildConfigPayload,
	draftFromView,
	setFieldValue,
} from "@frontend/components/plugins-admin/config-form-state";
import { buildConfigFormModel } from "@frontend/components/plugins-admin/config-schema";
import { parseManifest } from "@server/lib/plugins/manifest";
import { PluginContributionCoordinator } from "@server/services/plugin-contribution-coordinator";
import { PluginContributionRegistry } from "@server/services/plugin-contribution-registry";
import { createPluginProviderAdapterFactory } from "@server/services/plugin-provider-adapter-factory";
import { PluginProviderCatalogRefresher } from "@server/services/plugin-provider-catalog-refresh";
import {
	PluginProviderClientPool,
	type ProviderRuntimeLike,
} from "@server/services/plugin-provider-client";
import { PluginProviderConfigService } from "@server/services/plugin-provider-config-service";
import { providerRegistrationsFromManifest } from "@server/services/plugin-provider-manifest";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";
import { LocalProcessRunner, PluginRuntime } from "@server/services/plugin-runtime";
import { PluginStateStore } from "@server/services/plugin-state-store";
import { PluginToolRegistry } from "@server/services/plugin-tool-registry";

/**
 * Stage C acceptance: the example plugin's `apiMode` is editable in the host, is
 * persisted, and actually reaches the plugin process.
 *
 * The three ways this could be broken in production are each covered end to end:
 *
 *  1. the form produces a payload the config service rejects → asserted by driving the
 *     real `config-form-state` helpers rather than hand-writing a request body;
 *  2. the value is accepted but never persisted → asserted by re-reading `state.json`
 *     through a fresh state store, as a restart would;
 *  3. the value is persisted but the plugin never sees it → asserted by streaming chat
 *     from a real child process and observing the reply change.
 *
 * Point 3 is the reason `apiMode` has two enum values. A config field that changes no
 * observable behaviour cannot demonstrate that persistence reaches the plugin at all.
 */

const fixtureRoot = join(import.meta.dir, "../../../fixtures/plugins/e2e/reference-provider-rpc");
const exampleRoot = join(import.meta.dir, "../../../../examples/plugins/provider");

/**
 * Mirrors CHAT_WORDS_BY_MODE in the fixture's server entry.
 *
 * This suite exercises the non-secret `apiMode` field only, so the fixture always
 * reports `[anonymous]`. Credential injection has its own suite; keeping this one
 * credential-free proves the two config halves stay independent.
 */
const OFFLINE_REPLY = "Hello from the example provider. [anonymous]";
const VERBOSE_REPLY = "Hello from the example provider in verbose mode. [anonymous]";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "narrafork-provider-config-e2e-"));
	tempRoots.push(root);
	return root;
}

async function loadManifest() {
	return parseManifest(JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8")));
}

function createRuntime(manifest: Awaited<ReturnType<typeof loadManifest>>): PluginRuntime {
	if (!manifest.server) throw new Error("provider fixture must declare a server entry");
	return new PluginRuntime({
		pluginId: manifest.pluginId,
		pluginVersion: manifest.version,
		command: [process.execPath, join(fixtureRoot, manifest.server.entry)],
		cwd: fixtureRoot,
		rpcProtocol: manifest.server.protocol,
		hostApiVersion: "1.0",
		grantedCapabilities: manifest.permissions.host,
		activationReason: "provider-config-e2e",
		runner: new LocalProcessRunner({
			allowedCwds: [fixtureRoot],
			maxHeaderBytes: 8 * 1024,
			maxBodyBytes: 128 * 1024,
			maxStdoutBytes: 256 * 1024,
			stderrRingBytes: 8 * 1024,
			maxStderrBytes: 16 * 1024,
			maxStderrBytesPerSecond: 16 * 1024,
			// Generous on purpose: see the note in plugin-provider-rpc.e2e.test.ts.
			spawnTimeoutMs: 20_000,
			idleTimeoutMs: 30_000,
			totalTimeoutMs: 45_000,
			killProcessTree: true,
			resourceLimits: { cpuTimeSeconds: 30, memoryBytes: 1024 * 1024 * 1024 },
			allowUnboundedResourceUsage: process.platform === "win32",
		}),
		timeouts: {
			handshakeMs: 20_000,
			activationMs: 20_000,
			rpcMs: 20_000,
			drainMs: 200,
			shutdownMs: 1_000,
			cancelGraceMs: 1_000,
		},
		idleTimeoutMs: 30_000,
		totalTimeoutMs: 45_000,
		maxInFlight: 4,
	});
}

function createStack(
	runtime: PluginRuntime,
	manifest: Awaited<ReturnType<typeof loadManifest>>,
	stateStore: PluginStateStore,
) {
	const registry = new PluginProviderRegistry();
	const pool = new PluginProviderClientPool(async () => runtime as unknown as ProviderRuntimeLike);
	registry.setRemoteProviderAdapterFactory(
		createPluginProviderAdapterFactory({ clientPool: pool }),
	);
	// Register through the same path production uses, including the persisted-config hook.
	for (const registration of providerRegistrationsFromManifest({
		manifest,
		generation: `${manifest.version}:e2e`,
		configByProviderId: stateStore.getCachedState(manifest.pluginId)?.providerConfigs ?? {},
	})) {
		registry.register(registration);
	}
	const refresher = new PluginProviderCatalogRefresher({ registry, clientPool: pool });
	const configService = new PluginProviderConfigService({ registry, stateStore });
	return { registry, pool, refresher, configService };
}

function chatParams(model: string) {
	return {
		conversationId: "conv-provider-config-e2e",
		content: "hello",
		model,
		cwd: fixtureRoot,
		history: [],
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
	};
}

async function streamReply(
	adapter: NonNullable<ReturnType<PluginProviderRegistry["resolveProvider"]>["adapter"]>,
	model: string,
): Promise<{ text: string; deltas: number; stopReason?: string }> {
	const deltas: string[] = [];
	let stopReason: string | undefined;
	for await (const event of adapter.chat(chatParams(model))) {
		if (event.text) deltas.push(event.text);
		if (event.stopReason) stopReason = event.stopReason;
	}
	return { text: deltas.join(""), deltas: deltas.length, ...(stopReason ? { stopReason } : {}) };
}

describe("stage C acceptance: example plugin apiMode", () => {
	test("the shipped example and the e2e fixture stay in sync", async () => {
		// The fixture is what this test drives; a drift means it stops covering what ships.
		expect(await readFile(join(fixtureRoot, "server/index.js"), "utf8")).toBe(
			await readFile(join(exampleRoot, "server/index.js"), "utf8"),
		);
		expect(await readFile(join(fixtureRoot, "manifest.json"), "utf8")).toBe(
			await readFile(join(exampleRoot, "manifest.json"), "utf8"),
		);
	});

	test("apiMode renders as an editable select over the manifest schema", async () => {
		const manifest = await loadManifest();
		const provider = manifest.contributes.providers[0];
		// The host wraps the manifest's property map into a full object schema; mirror that
		// so the form sees exactly what the registry will validate against.
		const model = buildConfigFormModel({
			type: "object",
			properties: provider.configSchema as Record<string, never>,
			additionalProperties: false,
		});

		expect(model.rawOnly).toBe(false);
		const field = model.fields.find((item) => item.name === "apiMode");
		expect(field?.kind).toBe("select");
		expect(field?.options?.map((option) => option.value)).toEqual(["offline", "verbose"]);
		expect(field?.defaultValue).toBe("offline");
		// A single-value enum would render a select the user cannot meaningfully change.
		expect(field?.options?.length ?? 0).toBeGreaterThan(1);
	});

	test("editing apiMode persists it and changes what the real plugin streams", async () => {
		const root = await makeTempRoot();
		const manifest = await loadManifest();
		const runtime = createRuntime(manifest);
		try {
			await runtime.start();
			expect(runtime.state).toBe("active");

			const stateStore = new PluginStateStore({ root });
			const { registry, refresher, configService } = createStack(runtime, manifest, stateStore);
			const instanceId = registry.list()[0].providerInstanceId;
			await refresher.refresh(instanceId);

			// --- Baseline: no stored config, so the plugin falls back to `offline` ---
			const resolution = registry.resolveProvider("example:example/offline", {
				requireKnownModel: true,
			});
			const adapter = resolution.adapter;
			if (!adapter) throw new Error("resolution did not produce an adapter");
			const before = await streamReply(adapter, resolution.model);
			expect(before.text).toBe(OFFLINE_REPLY);
			expect(before.stopReason).toBe("end_turn");

			// --- Edit through the same helpers the settings form uses ---
			const [view] = await configService.list(manifest.pluginId);
			const fields = buildConfigFormModel(view.configSchema).fields;
			const formView = {
				config: view.config,
				secretFields: view.secretFields,
				secretsSet: view.secretsSet,
			};
			const draft = setFieldValue(draftFromView(fields, formView), "apiMode", "verbose");
			const payload = buildConfigPayload(fields, draft, formView);
			expect(payload.issues).toEqual([]);
			if (!payload.payload) throw new Error("form produced no payload");

			const updated = await configService.update(manifest.pluginId, instanceId, payload.payload);
			expect(updated.config.apiMode).toBe("verbose");

			// --- The live plugin now streams the other reply ---
			// A fresh adapter is required: the previous one captured the old config, which is
			// the intended isolation (a mid-stream config change must not splice replies).
			const afterResolution = registry.resolveProvider("example:example/offline", {
				requireKnownModel: true,
			});
			const afterAdapter = afterResolution.adapter;
			if (!afterAdapter) throw new Error("resolution did not produce an adapter");
			const after = await streamReply(afterAdapter, afterResolution.model);
			expect(after.text).toBe(VERBOSE_REPLY);
			expect(after.deltas).toBeGreaterThan(before.deltas);

			// --- Persistence: a fresh store reads it back, as a restart would ---
			const reloaded = new PluginStateStore({ root });
			const persisted = await reloaded.getState(manifest.pluginId);
			expect(persisted?.providerConfigs["example-provider"]).toEqual({ apiMode: "verbose" });

			// --- A real restart: fresh process, fresh registry, config only from disk ---
			// Reusing the running process with a second client pool would re-`initialize` an
			// already-active runtime, which is not what a restart does and quarantines it.
			await runtime.shutdown();
			const restarted = createRuntime(manifest);
			await restarted.start();
			try {
				const restartedStack = createStack(restarted, manifest, reloaded);
				const restartedInstanceId = restartedStack.registry.list()[0].providerInstanceId;
				// Nothing between the state file and registration re-applies the value by hand.
				expect(restartedStack.registry.getConfig(restartedInstanceId)).toEqual({
					apiMode: "verbose",
				});
				await restartedStack.refresher.refresh(restartedInstanceId);
				const restartedResolution = restartedStack.registry.resolveProvider(
					"example:example/offline",
					{ requireKnownModel: true },
				);
				const restartedAdapter = restartedResolution.adapter;
				if (!restartedAdapter) throw new Error("resolution did not produce an adapter");
				// The decisive assertion: after a restart the plugin still behaves as configured.
				expect((await streamReply(restartedAdapter, restartedResolution.model)).text).toBe(
					VERBOSE_REPLY,
				);
			} finally {
				await restarted.shutdown();
			}
		} finally {
			// Idempotent: the restart path above already shut this one down on the happy path.
			await runtime.shutdown().catch(() => undefined);
			for (const dir of tempRoots.splice(0)) await rm(dir, { recursive: true, force: true });
		}
	});

	test("an out-of-enum apiMode is rejected before it reaches disk", async () => {
		const root = await makeTempRoot();
		const manifest = await loadManifest();
		const runtime = createRuntime(manifest);
		try {
			await runtime.start();
			const stateStore = new PluginStateStore({ root });
			const { registry, configService } = createStack(runtime, manifest, stateStore);
			const instanceId = registry.list()[0].providerInstanceId;

			await expect(
				configService.update(manifest.pluginId, instanceId, { apiMode: "turbo" }),
			).rejects.toThrow(/invalid/i);
			// Nothing persisted, and the live registry keeps its previous value.
			expect(
				stateStore.getCachedState(manifest.pluginId)?.providerConfigs["example-provider"],
			).toBeUndefined();
			expect(registry.getConfig(instanceId).apiMode).toBeUndefined();
		} finally {
			await runtime.shutdown();
			for (const dir of tempRoots.splice(0)) await rm(dir, { recursive: true, force: true });
		}
	});

	test("the coordinator re-applies stored config when it registers the plugin", async () => {
		const root = await makeTempRoot();
		try {
			const manifest = await loadManifest();
			const stateStore = new PluginStateStore({ root });
			await stateStore.setProviderConfig(manifest.pluginId, "example-provider", {
				apiMode: "verbose",
			});

			const registry = new PluginProviderRegistry();
			const coordinator = new PluginContributionCoordinator({
				contributionRegistry: new PluginContributionRegistry(),
				toolRegistry: new PluginToolRegistry({
					capabilityBroker: { authorize: async () => ({ allowed: true as const }) },
				}),
				providerRegistry: registry,
				manifestLoader: async () => manifest,
				providerConfigSource: (id) => stateStore.getCachedState(id)?.providerConfigs,
			});

			const hash = "e".repeat(64);
			const packageSummary = {
				pluginId: manifest.pluginId,
				version: manifest.version,
				hash,
				path: `/virtual/${manifest.pluginId}`,
				status: "compatible" as const,
				isCurrent: true,
				manifest: {
					schemaVersion: manifest.schemaVersion,
					pluginId: manifest.pluginId,
					version: manifest.version,
					displayName: manifest.displayName,
					engine: manifest.engine,
					server: {
						entry: manifest.server?.entry ?? "server/index.js",
						protocol: "narrafork.rpc/1" as const,
					},
					activationEvents: [...manifest.activationEvents],
				},
				contributions: [],
				diagnostics: [],
			};
			await coordinator.initialize(
				{
					generatedAt: "2026-08-01T00:00:00.000Z",
					plugins: [
						{
							pluginId: manifest.pluginId,
							status: "compatible",
							current: { version: manifest.version, hash },
							packages: [packageSummary],
							contributions: [],
							diagnostics: [],
						},
					],
					packages: [packageSummary],
					diagnostics: [],
				},
				{
					lifecycleStates: [
						{
							pluginId: manifest.pluginId,
							desiredState: "enabled",
							runtimeState: "inactive",
							compatibility: "compatible",
						},
					],
				},
			);

			const entry = registry.list().find((item) => item.pluginId === manifest.pluginId);
			expect(entry).toBeDefined();
			// This is the production wiring: nothing between the state file and registration
			// re-applies the config by hand.
			expect(registry.getConfig(entry?.providerInstanceId ?? "")).toEqual({
				apiMode: "verbose",
			});
		} finally {
			for (const dir of tempRoots.splice(0)) await rm(dir, { recursive: true, force: true });
		}
	});
});
