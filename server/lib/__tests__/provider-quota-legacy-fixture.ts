import { mock, spyOn } from "bun:test";
import {
	type CustomApiQuotaTarget,
	type ProviderQuotaData,
	type ProviderQuotaSnapshot,
	providerQuotaSourceSchema,
	type QuotaQueryResult,
} from "@shared/provider-quota";
import {
	type ProviderQuotaQueryOptions,
	ProviderQuotaService,
	type ProviderQuotaServiceOptions,
	type ProviderQuotaSource,
	providerQuotaService,
} from "../../services/provider-quota-service";
import { CustomApiQuotaTargetDirectory } from "../../services/provider-quota-targets";
import { type CustomApiProviderConfig, saveSettings, settings } from "../settings";

export function quotaConfig(
	overrides: Partial<CustomApiProviderConfig> = {},
): CustomApiProviderConfig {
	return {
		id: "relay-test",
		name: "Quota test",
		prefix: "relay-test",
		baseUrl: "https://relay.invalid/v1",
		apiKey: "test-secret-key",
		protocol: "completions-compatible",
		defaultModel: "test-model",
		...overrides,
	};
}

export const walletQuota: ProviderQuotaData = {
	format: "sub2api",
	scope: "wallet",
	unlimited: false,
	amounts: [{ id: "amount:0", unit: "USD", remaining: 12 }],
	windows: [],
};

export function quotaSnapshot(
	overrides: Partial<ProviderQuotaSnapshot> = {},
): ProviderQuotaSnapshot {
	return {
		providerId: "relay-test",
		targetId: "custom-api/relay-test",
		generation: "opaque-generation",
		sourceId: "test-quota/relay",
		status: "supported",
		data: structuredClone(walletQuota),
		fetchedAt: 1_000_000,
		attemptedAt: 1_000_000,
		stale: false,
		error: null,
		version: 1,
		...overrides,
	};
}

export function required<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("Missing test fixture value");
	return value;
}

/** Real generic lifecycle with an in-process test source; never starts a plugin or server. */
export function legacyQuotaFixture(
	providers: CustomApiProviderConfig[] = [quotaConfig()],
	data: ProviderQuotaData = walletQuota,
	options: Pick<
		ProviderQuotaServiceOptions,
		"maxConcurrent" | "maxQueued" | "persistence" | "roundTimeoutMs"
	> = {},
) {
	let now = 1_000_000;
	const originalProviders = settings.customApiProviders;
	settings.customApiProviders = [];
	const source: ProviderQuotaSource = {
		id: "test-quota/legacy",
		pluginId: "test-quota",
		contributionId: "legacy",
		revision: "revision-1",
		declaration: providerQuotaSourceSchema.parse({
			id: "legacy",
			title: "Legacy test source",
			match: { fallback: true },
			requests: [
				{ path: "/quota", auth: "bearer" },
				{ path: "/api/user/self", auth: "site-token" },
			],
			refresh: { keepLastGoodMs: 600000 },
		}),
	};
	let sources = [source];
	const query = mock(
		async (
			_source: ProviderQuotaSource,
			_target: CustomApiQuotaTarget,
			_options: ProviderQuotaQueryOptions,
		): Promise<QuotaQueryResult> => ({
			status: "supported",
			data: structuredClone(data),
			error: null,
		}),
	);
	const directory = new CustomApiQuotaTargetDirectory({
		providers: () => settings.customApiProviders ?? [],
		globalProxy: () => settings.proxy,
		userAgent: () => "Quota-test/1.0",
	});
	const service = new ProviderQuotaService({
		directory,
		driver: { listSources: () => sources, query },
		now: () => now,
		onChanged: () => {},
		...options,
	});
	service.start();
	settings.customApiProviders = providers;
	service.sync();
	bindLegacyQuotaService(service);
	return {
		service,
		directory,
		query,
		source,
		setEnabled(enabled: boolean) {
			sources = enabled ? [source] : [];
			service.invalidateSources();
		},
		advance(ms: number) {
			now += ms;
		},
		revoke() {
			sources = [];
			service.invalidateSources();
		},
		dispose() {
			service.dispose();
			settings.customApiProviders = originalProviders;
		},
	};
}

/** Point compatibility views at a real isolated service, preserving its routing and lifecycle. */
export function bindLegacyQuotaService(service: ProviderQuotaService) {
	spyOn(providerQuotaService, "sync").mockImplementation(() => service.sync());
	spyOn(providerQuotaService, "peek").mockImplementation((id) => service.peek(id));
	spyOn(providerQuotaService, "peekGeneration").mockImplementation((id) =>
		service.peekGeneration(id),
	);
	spyOn(providerQuotaService, "isStreamSnapshotCurrent").mockImplementation((keyId, generation) =>
		service.isStreamSnapshotCurrent(keyId, generation),
	);
	spyOn(providerQuotaService, "peekKey").mockImplementation((id) => service.peekKey(id));
	spyOn(providerQuotaService, "keySnapshots").mockImplementation(() => service.keySnapshots());
	spyOn(providerQuotaService, "refreshKey").mockImplementation((id, options) =>
		service.refreshKey(id, options),
	);
	spyOn(providerQuotaService, "peekKeyForSelection").mockImplementation((id) =>
		service.peekKeyForSelection(id),
	);
	spyOn(providerQuotaService, "capabilityEnabled").mockImplementation(() =>
		service.capabilityEnabled(),
	);
	spyOn(providerQuotaService, "generations").mockImplementation(() => service.generations());
	spyOn(providerQuotaService, "list").mockImplementation((options) => service.list(options));
	spyOn(providerQuotaService, "refresh").mockImplementation((id, options) =>
		service.refresh(id, options),
	);
	spyOn(providerQuotaService, "refreshStale").mockImplementation((ids) =>
		service.refreshStale(ids),
	);
	spyOn(providerQuotaService, "manualRetryAfterMs").mockImplementation((id, keyId) =>
		service.manualRetryAfterMs(id, keyId),
	);
	spyOn(providerQuotaService, "noteActivity").mockImplementation((id) => service.noteActivity(id));
}

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

/** Pure plugin parser plus the real credential/policy-owning Host connection for cache tests. */
export async function httpQuotaFixture(
	providers: CustomApiProviderConfig[] = [quotaConfig()],
	options: {
		fetch?: typeof import("../net/outbound-fetch").outboundFetch;
		requestTimeoutMs?: number;
		persistence?: ProviderQuotaServiceOptions["persistence"];
	} = {},
) {
	const { queryQuota, QUOTA_SOURCES } = await import("../../../plugins/provider-quota/src/query");
	const { QuotaQueryError } = await import("../../../plugins/provider-quota/src/errors");
	const { PluginProviderConnectionService } = await import(
		"../../services/plugin-provider-connection-service"
	);
	const f = legacyQuotaFixture(providers, walletQuota, { persistence: options.persistence });
	const declaration = providerQuotaSourceSchema.parse(
		QUOTA_SOURCES.find(({ id }) => id === "relay"),
	);
	f.source.declaration = declaration;
	const connection = new PluginProviderConnectionService({
		directory: f.directory,
		fetch: options.fetch,
		requestTimeoutMs: options.requestTimeoutMs,
	});
	const principal = {
		pluginId: "io.narrafork.provider-quota",
		installationId: "test-http",
		runtimeId: "test-http",
		runtimeGeneration: 1,
	};
	f.query.mockImplementation(async (_source, _target, queryOptions) => {
		const target = f.directory.getTarget(
			_target as import("@shared/provider-quota").CustomApiQuotaTarget,
		)?.target;
		if (!target) throw new Error("test target disappeared");
		const deadlineAt = Date.now() + 5000;
		const lease = connection.issue({
			principal,
			target,
			source: declaration,
			deadlineAt,
			signal: queryOptions.signal,
			isCurrent: () => f.service.capabilityEnabled(),
		});
		try {
			return await queryQuota(
				{
					protocolVersion: "1.0",
					contributionId: "relay",
					target,
					reference: lease.reference,
					deadlineAt,
					mode: queryOptions.mode,
					...(queryOptions.cursor ? { cursor: queryOptions.cursor } : {}),
				},
				async (request, signal) => {
					if (typeof request === "string" || !(signal instanceof AbortSignal))
						throw new Error("HTTP fixture requires a legacy provider connection request");
					try {
						return await connection.request(request, principal, signal);
					} catch (error) {
						throw new QuotaQueryError(
							error instanceof Error && "code" in error
								? (error.code as import("../../../plugins/provider-quota/src/protocol").QuotaErrorCode)
								: "request_failed",
						);
					}
				},
				queryOptions.signal,
			);
		} finally {
			lease.release();
		}
	});
	return {
		...f,
		connection,
		dispose() {
			connection.dispose();
			f.dispose();
		},
	};
}

let packageBuild: Promise<{ root: string; archivePath: string; packageRoot: string }> | undefined;
export async function quotaTestPackage() {
	packageBuild ??= (async () => {
		const { mkdtemp, realpath } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { buildProviderQuotaPlugin } = await import("../../../plugins/provider-quota/build");
		const root = await realpath(await mkdtemp(join(tmpdir(), "quota-test-package-")));
		return { root, ...(await buildProviderQuotaPlugin({ outDir: root })) };
	})();
	return packageBuild;
}
export async function closeQuotaTestPackage() {
	const built = await packageBuild?.catch(() => undefined);
	packageBuild = undefined;
	if (built)
		await (await import("node:fs/promises")).rm(built.root, { recursive: true, force: true });
}

/** Actual archived process, authority, quota registry and RPC. Never substitutes a runtime. */
export async function archivedQuotaFixture(
	options: {
		fetch?: typeof import("../net/outbound-fetch").outboundFetch;
		requestTimeoutMs?: number;
		approveSettings?: boolean;
		now?: () => number;
		persistence?: ProviderQuotaServiceOptions["persistence"];
	} = {},
) {
	// Build and host-module loading are independent; keep fixture setup within the normal test budget.
	const builtPromise = quotaTestPackage();
	const { createHash } = await import("node:crypto");
	const { mkdtemp, readFile, realpath, rm } = await import("node:fs/promises");
	const { z } = await import("zod");
	const { BuiltinPluginCatalog, builtinPluginCatalog } = await import(
		"../../services/builtin-plugin-catalog"
	);
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { PluginManager } = await import("../../services/plugin-manager");
	const { PluginStateStore } = await import("../../services/plugin-state-store");
	const { PluginPermissionStore, permissionGrantPayload } = await import(
		"../../services/plugin-permission-store"
	);
	const { RuntimeSupervisor } = await import("../../services/plugin-runtime");
	const { PluginProviderConnectionService } = await import(
		"../../services/plugin-provider-connection-service"
	);
	const { createPluginPlatformServices } = await import("../../services/plugin-platform-services");
	const { PluginProviderRegistry } = await import("../../services/plugin-provider-registry");
	const { PluginSecretVault } = await import("../../services/plugin-secret-vault");
	const { CapabilityBroker } = await import("../../services/plugin-capability-broker");
	const { ProviderSettingsBindings } = await import("../../services/provider-settings-bindings");
	const { forgetQuotaSettingsProjection, projectQuotaSettings } = await import(
		"../../services/provider-quota-settings-projection"
	);
	const { getProviderKeyStore, quotaKeyOwner } = await import("../provider-keys");
	const { sqlite } = await import("../../db");
	const root = await realpath(await mkdtemp(join(tmpdir(), "quota-archived-test-")));
	const storeRoot = join(root, "installed");
	const savedProviders = structuredClone(settings.customApiProviders);
	const fixtureProviderIds = new Set<string>();
	let providers: CustomApiProviderConfig[] = [];
	const directory = new CustomApiQuotaTargetDirectory({
		providers: () => providers.map(projectQuotaSettings),
		globalProxy: () => settings.proxy,
		userAgent: () => "Quota-archived-test",
	});
	const service = new ProviderQuotaService({
		directory,
		onChanged: () => {},
		now: options.now,
		persistence: options.persistence,
	});
	const { outboundFetch } = await import("../net/outbound-fetch");
	let testHttp = options.fetch ?? outboundFetch;
	const connectionOptions = {
		directory,
		fetch: (...args: Parameters<typeof outboundFetch>) => testHttp(...args),
		requestTimeoutMs: options.requestTimeoutMs,
	};
	const connection = new PluginProviderConnectionService(connectionOptions);
	const stateStore = new PluginStateStore(storeRoot);
	const permissionStore = new PluginPermissionStore({ root: storeRoot, stateStore });
	const supervisor = new RuntimeSupervisor();
	const platform = createPluginPlatformServices({
		runtimeSupervisor: supervisor,
		stateStore,
		permissionStore,
		quotaService: service,
		providerConnectionService: connection,
		providerSettingsBindings: new ProviderSettingsBindings({
			fetch: (...args: Parameters<typeof outboundFetch>) => testHttp(...args),
		}),
		providerRegistry: new PluginProviderRegistry(),
		capabilityBroker: new CapabilityBroker({ kernelEnforcement: true }),
		storageRoot: join(root, "storage"),
		secretVault: new PluginSecretVault({ root: join(root, "secrets") }),
	});
	const manager = new PluginManager({
		root: storeRoot,
		disabled: false,
		stateStore,
		permissionStore,
		runtimeSupervisor: supervisor,
		hostServices: platform.hostServices,
		quotaRegistry: platform.quotaRegistry,
		contributionRegistry: platform.contributionRegistry,
		contributionCoordinator: platform.contributionCoordinator,
		lifecycleRevokeCoordinator: platform.lifecycleRevokeCoordinator,
		restorePluginLifecycle: platform.restorePlugin,
		purgePluginSecrets: (id) => platform.secretVault.deletePlugin(id),
	});
	const pluginId = "io.narrafork.provider-quota";
	const approveSettings = async () => {
		const before = await manager.getPermissions(pluginId);
		await manager.replacePermissions(pluginId, {
			expectedRevision: before.revision,
			grantedBy: "quota-archive-test",
			grants: [
				...before.grants.map(permissionGrantPayload),
				...(["provider.settings.read_self", "provider.settings.connection.use"] as const)
					.filter((capability) => !before.grants.some((grant) => grant.capability === capability))
					.map((capability) => ({
						capability,
						scope: { type: "global" as const },
						grantedBy: "quota-archive-test",
					})),
			],
		});
	};
	const setProviders = (value: CustomApiProviderConfig[]) => {
		for (const provider of value) fixtureProviderIds.add(provider.id);
		saveSettings({ ...settings, customApiProviders: value });
		providers = required(settings.customApiProviders);
		service.sync();
	};
	const prepareProviders = async (value: CustomApiProviderConfig[]) => {
		// A reused real archive remains pinned after each test restores its other spies.
		catalogLookup = spyOn(builtinPluginCatalog, "get").mockImplementation((id) => catalog.get(id));
		setProviders(value);
		await platform.providerSettingsService.prepareQuotaMigrations();
		service.sync();
	};
	const built = await builtPromise;
	const artifact = z
		.object({
			pluginId: z.literal(pluginId),
			version: z.string().min(1),
			size: z
				.number()
				.int()
				.positive()
				.max(16 * 1024 * 1024),
			sha256: z.string().regex(/^[a-f0-9]{64}$/),
			packageHash: z.string().regex(/^[a-f0-9]{64}$/),
		})
		.parse(JSON.parse(await readFile(join(built.root, "provider-quota.asset.json"), "utf8")));
	const bytes = await readFile(built.archivePath);
	if (
		bytes.byteLength !== artifact.size ||
		createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
	)
		throw new Error("Built quota fixture archive does not match its asset identity");
	// Pin the test build before installation; the real migration still checks its exact package hash.
	const catalog = new BuiltinPluginCatalog({
		descriptors: [
			{
				pluginId,
				version: artifact.version,
				load: async (signal) => {
					signal?.throwIfAborted();
					return {
						bytes: new Uint8Array(bytes),
						sha256: artifact.sha256,
						packageHash: artifact.packageHash,
					};
				},
			},
		],
	});
	let catalogLookup = spyOn(builtinPluginCatalog, "get").mockImplementation((id) =>
		catalog.get(id),
	);
	try {
		await manager.install(built.archivePath);
		// Query fixtures explicitly act as an administrator; installation itself grants neither capability.
		if (options.approveSettings !== false) await approveSettings();
		await manager.enable(pluginId);
		await manager.activate(pluginId);
		service.start();
	} catch (error) {
		catalogLookup.mockRestore();
		await manager.shutdown();
		service.dispose();
		connection.dispose();
		platform.providerSettingsService.close();
		await rm(root, { recursive: true, force: true });
		throw error;
	}
	return {
		root,
		directory,
		service,
		connection,
		manager,
		supervisor,
		platform,
		pluginId,
		approveSettings,
		setProviders,
		prepareProviders,
		setTestHttp(value?: typeof outboundFetch) {
			testHttp = value ?? options.fetch ?? outboundFetch;
		},
		setRequestTimeout(value?: number) {
			connectionOptions.requestTimeoutMs = value;
		},
		async query(config: CustomApiProviderConfig, mode: "probe" | "refresh" = "probe") {
			await prepareProviders([config]);
			return service.refresh(config.id, { mode, manual: true });
		},
		async rpc(
			config: CustomApiProviderConfig,
			mode: "probe" | "refresh" = "probe",
			cursor?: string,
			signal = AbortSignal.timeout(5000),
		) {
			await prepareProviders([config]);
			const target = directory.get(config.id)?.target;
			const source = platform.quotaRegistry
				.listSources()
				.find(({ contributionId }) => contributionId === "relay");
			if (!target || !source) throw new Error("Quota source or saved target unavailable");
			return platform.quotaRegistry.query(source, target, {
				mode,
				...(cursor ? { cursor } : {}),
				signal,
				deadlineAt: Date.now() + 5000,
			});
		},
		async close() {
			service.stop();
			try {
				await manager.uninstall(pluginId);
			} finally {
				try {
					await manager.shutdown();
					await supervisor.shutdown();
				} finally {
					service.dispose();
					connection.dispose();
					platform.providerSettingsService.close();
					catalogLookup.mockRestore();
					for (const providerId of fixtureProviderIds) {
						forgetQuotaSettingsProjection(providerId);
						if (!savedProviders?.some(({ id }) => id === providerId)) {
							getProviderKeyStore().removeProvider(providerId);
							getProviderKeyStore().removeProvider(quotaKeyOwner(providerId));
						}
					}
					saveSettings({ ...settings, customApiProviders: savedProviders });
					for (const table of [
						"plugin_provider_settings",
						"plugin_resource_entries",
						"plugin_resource_budgets",
					])
						sqlite.run(`DELETE FROM ${table} WHERE plugin_id=?`, [pluginId]);
					await rm(root, { recursive: true, force: true });
				}
			}
		},
	};
}
