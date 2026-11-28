import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqlite } from "@server/db";
import { AppError } from "@server/lib/errors";
import { settings } from "@server/lib/settings";
import { createProviderSettingsRoutes } from "@server/routes/provider-settings";
import { CapabilityBroker } from "@server/services/plugin-capability-broker";
import { PluginCatalog } from "@server/services/plugin-catalog";
import { PluginManager } from "@server/services/plugin-manager";
import { PluginPackageStore } from "@server/services/plugin-package-store";
import { PluginPermissionStore } from "@server/services/plugin-permission-store";
import { createPluginPlatformServices } from "@server/services/plugin-platform-services";
import { RuntimeSupervisor } from "@server/services/plugin-runtime";
import { PluginSecretVault } from "@server/services/plugin-secret-vault";
import { PluginStateStore } from "@server/services/plugin-state-store";
import { ProviderSettingsService } from "@server/services/provider-settings-service";
import { Hono } from "hono";

const exampleRoot = join(
	import.meta.dir,
	"../../../../examples/plugins/provider-settings-reference",
);
const targetId = "provider-settings-custom-api";
const basePluginId = "com.example.provider-settings.reference";
const peerPluginId = "com.example.provider-settings.peer";
const priorCustomApiProviders = structuredClone(settings.customApiProviders);
const temporaryRoots: string[] = [];
const installedPluginIds = new Set<string>();

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function eventuallyFile(path: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await exists(path))) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
		await Bun.sleep(10);
	}
}

async function makePackage(root: string, pluginId: string): Promise<string> {
	const packageRoot = join(root, pluginId.replaceAll(".", "-"));
	await cp(exampleRoot, packageRoot, { recursive: true });
	if (pluginId !== basePluginId) {
		const manifestPath = join(packageRoot, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.pluginId = pluginId;
		manifest.displayName = "Provider Settings Peer";
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	}
	installedPluginIds.add(pluginId);
	return packageRoot;
}

function settingsApp(
	service: Pick<
		ProviderSettingsService,
		"list" | "save" | "remove" | "action" | "rebind" | "retained"
	>,
) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", {
			sub: "provider-settings-admin",
			sid: "provider-settings-session",
			role: "admin",
			username: "provider-settings-admin",
		} as never);
		await next();
	});
	app.onError((error, c) => {
		const status = error instanceof AppError ? error.statusCode : 500;
		return c.json(
			{
				code: error instanceof AppError ? error.code : "ERROR",
				...(error instanceof AppError || !(error instanceof Error)
					? {}
					: { message: error.message, name: error.name }),
			},
			status as never,
		);
	});
	app.route(
		"/api/provider-settings",
		createProviderSettingsRoutes(service, async () => undefined),
	);
	return app;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

async function saveValues(
	app: Hono,
	pluginId: string,
	values: { text: string; enabled: boolean; attempts: number },
): Promise<void> {
	const query = `?kind=custom-api&id=${encodeURIComponent(targetId)}`;
	const listed = await app.request(`/api/provider-settings${query}`);
	expect(listed.status).toBe(200);
	const body = await responseJson(listed);
	const extension = (body.extensions as Array<Record<string, unknown>>).find(
		(item) => item.pluginId === pluginId,
	);
	if (!extension) throw new Error(`Missing provider settings extension for ${pluginId}`);
	const config = extension.config as Record<string, unknown>;
	const saved = await app.request(`/api/provider-settings/${pluginId}/settings${query}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			schemaVersion: 1,
			schemaFingerprint: config.schemaFingerprint,
			expectedRevision: config.revision,
			expectedBindingRevision: config.bindingRevision,
			values,
			secrets: {},
		}),
	});
	expect(saved.status).toBe(200);
	const savedBody = await responseJson(saved);
	expect((savedBody.values as Record<string, unknown>).text).toBe(values.text);
}

async function createHarness() {
	const root = await mkdtemp(join(tmpdir(), "s-"));
	temporaryRoots.push(root);
	const storeRoot = join(root, "i");
	const stateStore = new PluginStateStore(storeRoot);
	const permissionStore = new PluginPermissionStore({ root: storeRoot, stateStore });
	const supervisor = new RuntimeSupervisor();
	const platform = createPluginPlatformServices({
		runtimeSupervisor: supervisor,
		stateStore,
		permissionStore,
		capabilityBroker: new CapabilityBroker({ kernelEnforcement: true }),
		storageRoot: join(root, "storage"),
		secretVault: new PluginSecretVault({ root: join(root, "secrets") }),
	});
	const manager = new PluginManager({
		root: storeRoot,
		disabled: false,
		stateStore,
		permissionStore,
		hostServices: platform.hostServices,
		runtimeSupervisor: supervisor,
		contributionRegistry: platform.contributionRegistry,
		contributionCoordinator: platform.contributionCoordinator,
		quotaRegistry: platform.quotaRegistry,
		lifecycleRevokeCoordinator: platform.lifecycleRevokeCoordinator,
		restorePluginLifecycle: platform.restorePlugin,
		purgePluginSecrets: (pluginId) => platform.secretVault.deletePlugin(pluginId),
	});
	const service = new ProviderSettingsService({
		registry: platform.contributionRegistry,
		states: stateStore,
		runtimes: supervisor,
		host: platform.hostServices,
		broker: platform.capabilityBroker,
		bindings: platform.providerSettingsBindings,
	});
	service.setActivationHandler((pluginId, options) =>
		manager.activate(pluginId, { ...options, automatic: true }),
	);
	return { root, storeRoot, stateStore, supervisor, platform, manager, service };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function grantSettingsRead(harness: Harness, pluginId: string): Promise<void> {
	const current = await harness.manager.getPermissions(pluginId);
	await harness.manager.replacePermissions(pluginId, {
		expectedRevision: current.revision,
		grantedBy: "provider-settings-e2e-admin",
		grants: [
			{
				capability: "provider.settings.read_self",
				scope: { type: "global" },
				grantId: `grant-${pluginId}`,
				grantedBy: "provider-settings-e2e-admin",
			},
		],
	});
}

async function cleanupHarness(harness: Harness): Promise<void> {
	for (const pluginId of installedPluginIds) {
		await harness.manager.uninstall(pluginId).catch(() => undefined);
	}
	await harness.manager.shutdown().catch(() => undefined);
	harness.service.close();
	harness.platform.providerSettingsService.close();
	harness.platform.providerSettingsBindings.close();
	for (const pluginId of installedPluginIds) {
		sqlite.run("DELETE FROM plugin_provider_settings WHERE plugin_id = ?", [pluginId]);
	}
	installedPluginIds.clear();
}

afterEach(async () => {
	settings.customApiProviders = priorCustomApiProviders;
	for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
	installedPluginIds.clear();
});

describe("provider-settings example over real plugin runtime", () => {
	test("static discovery reads only declarations and never starts the stdio server", async () => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-provider-settings-static-"));
		temporaryRoots.push(root);
		const storeRoot = join(root, "i");
		await new PluginPackageStore(storeRoot).install(exampleRoot);
		const snapshot = await new PluginCatalog(storeRoot).scan();
		const contribution = snapshot.packages
			.flatMap((pkg) => pkg.contributions)
			.find((item) => item.kind === "providerSettings");
		expect(contribution?.providerSettings?.targetKinds).toEqual([
			"custom-api",
			"nug",
			"platform",
			"executable-plugin",
		]);
		expect(await exists(join(storeRoot, "data", basePluginId, "provider-settings-started"))).toBe(
			false,
		);
	}, 20_000);

	test("admin save/action uses current target values, denies without grant, and isolates plugins", async () => {
		settings.customApiProviders = [
			{
				id: targetId,
				name: "Provider Settings E2E",
				prefix: "provider-settings-e2e",
				protocol: "completions-compatible",
				apiKey: "provider-settings-inference-key",
				baseUrl: "https://provider-settings.invalid/v1",
				defaultModel: "fixture-model",
			},
		];
		const harness = await createHarness();
		const packageRoot = await makePackage(harness.root, basePluginId);
		const peerRoot = await makePackage(harness.root, peerPluginId);
		const app = settingsApp(harness.service);
		try {
			await harness.manager.install(packageRoot);
			await harness.manager.install(peerRoot);
			await harness.manager.enable(basePluginId);
			await harness.manager.enable(peerPluginId);

			const foreignTarget = await app.request(
				`/api/provider-settings/${basePluginId}/settings/action?kind=custom-api&id=foreign-provider`,
				{ method: "POST" },
			);
			expect(foreignTarget.status).toBe(409);
			const foreignPlugin = await app.request(
				`/api/provider-settings/com.example.foreign/settings/action?kind=custom-api&id=${targetId}`,
				{ method: "POST" },
			);
			expect(foreignPlugin.status).toBe(409);

			await saveValues(app, basePluginId, { text: "alpha", enabled: true, attempts: 7 });
			await saveValues(app, peerPluginId, { text: "beta", enabled: false, attempts: 2 });

			const denied = await app.request(
				`/api/provider-settings/${basePluginId}/settings/action?kind=custom-api&id=${targetId}`,
				{ method: "POST" },
			);
			const deniedBody = await responseJson(denied);
			if (denied.status !== 403)
				throw new Error(
					`Unexpected denied action response: ${denied.status} ${JSON.stringify(deniedBody)}`,
				);
			expect(deniedBody.code).toBe("PROVIDER_SETTINGS_PERMISSION_DENIED");
			await eventuallyFile(
				join(harness.storeRoot, "data", basePluginId, "provider-settings-started"),
			);
			expect(
				await exists(
					join(harness.storeRoot, "data", basePluginId, "provider-settings-action.marker"),
				),
			).toBe(false);

			await grantSettingsRead(harness, basePluginId);
			await grantSettingsRead(harness, peerPluginId);

			const baseAction = await app.request(
				`/api/provider-settings/${basePluginId}/settings/action?kind=custom-api&id=${targetId}`,
				{ method: "POST" },
			);
			expect(baseAction.status).toBe(200);
			expect(await responseJson(baseAction)).toEqual({
				text: "provider-settings-reference:alpha:enabled:7",
			});

			const peerAction = await app.request(
				`/api/provider-settings/${peerPluginId}/settings/action?kind=custom-api&id=${targetId}`,
				{ method: "POST" },
			);
			expect(peerAction.status).toBe(200);
			expect(await responseJson(peerAction)).toEqual({
				text: "provider-settings-reference:beta:disabled:2",
			});

			for (const pluginId of [basePluginId, peerPluginId]) {
				const runtime = harness.supervisor.get(pluginId);
				expect(runtime?.pid).toBeGreaterThan(0);
				expect(runtime?.getDiagnostics().features).toContain("host_api.provider_settings");
				await eventuallyFile(
					join(harness.storeRoot, "data", pluginId, "provider-settings-action.marker"),
				);
			}
		} finally {
			await cleanupHarness(harness);
		}
	}, 60_000);
});
