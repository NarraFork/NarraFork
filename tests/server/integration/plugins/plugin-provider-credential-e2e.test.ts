import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildConfigPayload,
	draftFromView,
	setSecretValue,
} from "@frontend/components/plugins-admin/config-form-state";
import { buildConfigFormModel } from "@frontend/components/plugins-admin/config-schema";
import { logger } from "@server/lib/logger";
import { parseManifest } from "@server/lib/plugins/manifest";
import { createPluginProviderAdapterFactory } from "@server/services/plugin-provider-adapter-factory";
import { PluginProviderCatalogRefresher } from "@server/services/plugin-provider-catalog-refresh";
import {
	PluginProviderClientPool,
	type ProviderRuntimeLike,
} from "@server/services/plugin-provider-client";
import {
	PluginProviderConfigService,
	SECRET_PLACEHOLDER,
} from "@server/services/plugin-provider-config-service";
import { PluginProviderCredentialResolver } from "@server/services/plugin-provider-credential-resolver";
import { providerRegistrationsFromManifest } from "@server/services/plugin-provider-manifest";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";
import { LocalProcessRunner, PluginRuntime } from "@server/services/plugin-runtime";
import { PluginSecretVault } from "@server/services/plugin-secret-vault";
import { PluginStateStore } from "@server/services/plugin-state-store";

/**
 * A provider plugin can hold a credential end to end.
 *
 * Before this path existed, `plugin-provider-config-service` wrote a secret to the vault
 * and nothing ever read it back out: a key could be configured and the plugin would still
 * authenticate as anonymous. The four failure modes that matter are each covered against
 * a real child process:
 *
 *  1. the credential never reaches the plugin → asserted by observing the streamed reply
 *     change, since the fixture reports whether a key arrived;
 *  2. it reaches the plugin but does not survive a restart → asserted with a fresh vault
 *     and registry built from disk, as a restart would;
 *  3. clearing it leaves the plugin still authenticated → asserted after a clear;
 *  4. the value leaks somewhere readable → asserted against `state.json`, every log line
 *     emitted during a real chat, and the view returned to the UI.
 *
 * Point 4 is the precondition D-04 attaches to sending resolved values in RPC `config`,
 * so it is asserted rather than assumed.
 */

const fixtureRoot = join(import.meta.dir, "../../../fixtures/plugins/e2e/reference-provider-rpc");

const API_KEY = "sk-credential-e2e-do-not-log";
const AUTHENTICATED_REPLY = "Hello from the example provider. [authenticated]";
const ANONYMOUS_REPLY = "Hello from the example provider. [anonymous]";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "narrafork-provider-credential-e2e-"));
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
		activationReason: "provider-credential-e2e",
		runner: new LocalProcessRunner({
			allowedCwds: [fixtureRoot],
			maxHeaderBytes: 8 * 1024,
			maxBodyBytes: 128 * 1024,
			maxStdoutBytes: 256 * 1024,
			stderrRingBytes: 8 * 1024,
			maxStderrBytes: 16 * 1024,
			maxStderrBytesPerSecond: 16 * 1024,
			// Generous on purpose: see the note in plugin-provider-rpc.e2e.test.ts. The full
			// suite spawns many real plugin subprocesses in parallel, and a 5s budget is
			// occasionally missed under CPU contention rather than because anything hung.
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

/**
 * Build the production wiring: registry, credential resolver, adapter factory and config
 * service, all sharing one vault. Mirrors `plugin-platform-services` so the test exercises
 * the same graph rather than a convenient shortcut.
 */
function createStack(
	runtime: PluginRuntime,
	manifest: Awaited<ReturnType<typeof loadManifest>>,
	stateStore: PluginStateStore,
	vault: PluginSecretVault,
) {
	const registry = new PluginProviderRegistry();
	const pool = new PluginProviderClientPool(async () => runtime as unknown as ProviderRuntimeLike);
	const credentialResolver = new PluginProviderCredentialResolver({
		registry,
		secretSource: vault,
	});
	const resolveConfig = (providerInstanceId: string) =>
		credentialResolver.resolve(providerInstanceId);
	registry.setRemoteProviderAdapterFactory(
		createPluginProviderAdapterFactory({ clientPool: pool, resolveConfig }),
	);
	for (const registration of providerRegistrationsFromManifest({
		manifest,
		generation: `${manifest.version}:credential-e2e`,
		configByProviderId: stateStore.getCachedState(manifest.pluginId)?.providerConfigs ?? {},
	})) {
		registry.register(registration);
	}
	const refresher = new PluginProviderCatalogRefresher({
		registry,
		clientPool: pool,
		resolveConfig,
	});
	const configService = new PluginProviderConfigService({
		registry,
		stateStore,
		secretStore: vault,
	});
	return { registry, pool, refresher, configService, credentialResolver };
}

function chatParams(model: string) {
	return {
		conversationId: "conv-provider-credential-e2e",
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
): Promise<string> {
	const deltas: string[] = [];
	for await (const event of adapter.chat(chatParams(model))) {
		if (event.text) deltas.push(event.text);
	}
	return deltas.join("");
}

function resolveAdapter(registry: PluginProviderRegistry) {
	const resolution = registry.resolveProvider("example:example/offline", {
		requireKnownModel: true,
	});
	const adapter = resolution.adapter;
	if (!adapter) throw new Error("resolution did not produce an adapter");
	return { adapter, model: resolution.model };
}

/**
 * Capture everything the logger emits while `run` executes.
 *
 * Serialized rather than inspected structurally, because a credential could leak through
 * any nested field or an interpolated message, and the assertion should not depend on
 * knowing which.
 */
async function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
	const levels = ["debug", "info", "warn", "error"] as const;
	const originals = levels.map((level) => [level, logger[level]] as const);
	const lines: string[] = [];
	for (const level of levels) {
		(logger as unknown as Record<string, unknown>)[level] = (...args: unknown[]) => {
			for (const arg of args) {
				lines.push(typeof arg === "string" ? arg : safeSerialize(arg));
			}
		};
	}
	try {
		return { result: await run(), output: lines.join("\n") };
	} finally {
		for (const [level, original] of originals) {
			(logger as unknown as Record<string, unknown>)[level] = original;
		}
	}
}

function safeSerialize(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

afterAll(async () => {
	for (const root of tempRoots) await rm(root, { recursive: true, force: true });
});

describe("stage E acceptance: provider plugin credentials", () => {
	test("a stored credential reaches the plugin, survives a restart, and never leaks", async () => {
		const root = await makeTempRoot();
		const manifest = await loadManifest();
		const runtime = createRuntime(manifest);
		try {
			await runtime.start();
			expect(runtime.state).toBe("active");

			const stateStore = new PluginStateStore({ root });
			const vault = new PluginSecretVault({ root });
			const { registry, refresher, configService } = createStack(
				runtime,
				manifest,
				stateStore,
				vault,
			);
			const instanceId = registry.list()[0].providerInstanceId;
			await refresher.refresh(instanceId);

			// --- Baseline: nothing stored, so the plugin sees no credential ---
			const baseline = resolveAdapter(registry);
			expect(await streamReply(baseline.adapter, baseline.model)).toBe(ANONYMOUS_REPLY);

			// --- Store the key through the same helpers the settings form uses ---
			const [view] = await configService.list(manifest.pluginId);
			const model = buildConfigFormModel(view.configSchema as never);
			const draft = setSecretValue(draftFromView(model.fields, view), "apiKey", API_KEY);
			const built = buildConfigPayload(model.fields, draft, view);
			expect(built.issues).toEqual([]);
			if (!built.payload) throw new Error("form produced no payload");
			const saved = await configService.update(
				manifest.pluginId,
				instanceId,
				built.payload as Record<string, never>,
			);

			// The UI is told a secret exists but never receives the value.
			expect(saved.secretFields).toEqual(["apiKey"]);
			expect(saved.secretsSet).toEqual(["apiKey"]);
			expect(saved.config.apiKey).toBe(SECRET_PLACEHOLDER);

			// --- The decisive assertion: the running plugin now authenticates ---
			const authed = resolveAdapter(registry);
			const { result: reply, output: logOutput } = await captureLogs(() =>
				streamReply(authed.adapter, authed.model),
			);
			expect(reply).toBe(AUTHENTICATED_REPLY);
			// D-04 permits sending resolved values in `config` only if logs stay clean.
			expect(logOutput).not.toContain(API_KEY);

			// --- The value must not be readable on disk outside the vault ---
			expect(await Bun.file(join(root, "state.json")).text()).not.toContain(API_KEY);
			// The plain-config half must be free of the secret key entirely, not merely of its
			// value: an `apiKey` entry here would mean the split routed it to the wrong store.
			const storedConfig =
				stateStore.getCachedState(manifest.pluginId)?.providerConfigs["example-provider"] ?? {};
			expect("apiKey" in storedConfig).toBe(false);
			// The vault is the one place it may exist.
			expect(
				await vault.getSecret({
					pluginId: manifest.pluginId,
					key: "provider.example-provider.apiKey",
				}),
			).toBe(API_KEY);

			// --- A real restart: fresh process, fresh vault and registry, disk only ---
			// Reusing the running process with a second client pool would re-`initialize` an
			// already-active runtime, which is not what a restart does.
			await runtime.shutdown();
			const reloadedStore = new PluginStateStore({ root });
			await reloadedStore.getState(manifest.pluginId);
			const restartedRuntime = createRuntime(manifest);
			await restartedRuntime.start();
			try {
				const restarted = createStack(
					restartedRuntime,
					manifest,
					reloadedStore,
					// A brand-new vault instance, so nothing is served from the previous
					// in-memory document.
					new PluginSecretVault({ root }),
				);
				const restartedInstanceId = restarted.registry.list()[0].providerInstanceId;
				await restarted.refresher.refresh(restartedInstanceId);
				const afterRestart = resolveAdapter(restarted.registry);
				// The decisive assertion: the credential survived a full restart.
				expect(await streamReply(afterRestart.adapter, afterRestart.model)).toBe(
					AUTHENTICATED_REPLY,
				);

				// --- Clearing it takes effect on the next call, without another restart ---
				const clearedView = (await restarted.configService.list(manifest.pluginId))[0];
				const clearedModel = buildConfigFormModel(clearedView.configSchema as never);
				// An empty string is the documented "delete this secret" signal.
				const clearedDraft = setSecretValue(
					draftFromView(clearedModel.fields, clearedView),
					"apiKey",
					"",
				);
				const clearedBuilt = buildConfigPayload(clearedModel.fields, clearedDraft, clearedView);
				expect(clearedBuilt.issues).toEqual([]);
				if (!clearedBuilt.payload) throw new Error("form produced no payload");
				const cleared = await restarted.configService.update(
					manifest.pluginId,
					restartedInstanceId,
					clearedBuilt.payload as Record<string, never>,
				);
				expect(cleared.secretsSet).toEqual([]);

				const afterClear = resolveAdapter(restarted.registry);
				expect(await streamReply(afterClear.adapter, afterClear.model)).toBe(ANONYMOUS_REPLY);
			} finally {
				await restartedRuntime.shutdown();
			}
		} finally {
			// Idempotent: the restart path above already shut this one down on the happy path.
			await runtime.shutdown().catch(() => undefined);
		}
	}, 30_000);

	test("model enumeration receives the credential too", async () => {
		const root = await makeTempRoot();
		const manifest = await loadManifest();
		const runtime = createRuntime(manifest);
		try {
			await runtime.start();
			const stateStore = new PluginStateStore({ root });
			const vault = new PluginSecretVault({ root });
			const { registry, refresher, credentialResolver } = createStack(
				runtime,
				manifest,
				stateStore,
				vault,
			);
			const instanceId = registry.list()[0].providerInstanceId;
			await vault.setSecret({
				pluginId: manifest.pluginId,
				key: "provider.example-provider.apiKey",
				value: API_KEY,
			});

			// Chat and listModels must authenticate identically, or a provider would show an
			// empty catalog while being perfectly able to chat.
			expect((await credentialResolver.resolve(instanceId)).apiKey).toBe(API_KEY);

			const { result, output } = await captureLogs(() => refresher.refresh(instanceId));
			expect(result.error).toBeUndefined();
			expect(result.modelCount).toBeGreaterThan(0);
			expect(output).not.toContain(API_KEY);
		} finally {
			await runtime.shutdown();
		}
	}, 30_000);
});
