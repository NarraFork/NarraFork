import { logger } from "@server/lib/logger";
import { getOutboundProxy } from "@server/lib/net/proxy";
import type { JsonValue } from "@server/lib/plugins/protocol";
import { registerExtraSearchChannelSource } from "@server/lib/search/plugin-source";
import { registerExtraModelSource } from "@server/lib/settings";
import { PluginAgentToolBridge } from "./plugin-agent-tool-bridge";
import {
	type CapabilityBroker,
	capabilityBroker as defaultCapabilityBroker,
	type PluginPrincipal,
} from "./plugin-capability-broker";
import { PluginCommandRegistry } from "./plugin-command-registry";
import { applyCommandSecretWrites } from "./plugin-command-secret-writes";
import { PluginContributionCoordinator } from "./plugin-contribution-coordinator";
import { PluginContributionRegistry } from "./plugin-contribution-registry";
import { type PluginEventGateway, pluginEventGateway } from "./plugin-event-gateway";
import { createPluginHostServices, type PluginHostServices } from "./plugin-host-services";
import {
	type PluginLifecycleRevokeAdapters,
	type PluginLifecycleRevokeContext,
	PluginLifecycleRevokeCoordinator,
} from "./plugin-lifecycle-revoke-coordinator";
import { PluginMcpAdapter } from "./plugin-mcp-adapter";
import { PluginPermissionStore } from "./plugin-permission-store";
import { createPluginProviderAdapterFactory } from "./plugin-provider-adapter-factory";
import { PluginProviderCatalogRefresher } from "./plugin-provider-catalog-refresh";
import { PluginProviderClientPool, type ProviderRuntimeLike } from "./plugin-provider-client";
import { PluginProviderConfigService } from "./plugin-provider-config-service";
import { PluginProviderCredentialResolver } from "./plugin-provider-credential-resolver";
import {
	findPluginProviderForModel,
	listPluginProviderModelValues,
} from "./plugin-provider-model-source";
import {
	pluginProviderRegistry as defaultPluginProviderRegistry,
	type PluginProviderRegistry,
} from "./plugin-provider-registry";
import type { ProviderHostHints } from "./plugin-provider-rpc";
import {
	CommandRegistry,
	PluginPublicApi,
	type PluginPublicApiAdapters,
	QueryRegistry,
} from "./plugin-public-api";
import { RuntimeSupervisor } from "./plugin-runtime";
import { PluginScheduler } from "./plugin-scheduler";
import { PluginSearchRegistry } from "./plugin-search-registry";
import { pluginSearchChannelSource } from "./plugin-search-source";
import { PluginSecretBroker } from "./plugin-secret-broker";
import { type PluginSecretVault, pluginSecretVault } from "./plugin-secret-vault";
import { PluginStateStore } from "./plugin-state-store";
import {
	pluginStorageFactory as defaultPluginStorageFactory,
	PluginStorageFactory,
	type PluginStorageFactoryLike,
} from "./plugin-storage";
import { PluginToolRegistry } from "./plugin-tool-registry";
import { type PluginCommandDispatcher, PluginUiHost } from "./plugin-ui-host";
import {
	pluginUiSessionService as defaultPluginUiSessionService,
	type PluginUiSessionService,
} from "./plugin-ui-session";

export interface PluginPlatformServices {
	runtimeSupervisor: RuntimeSupervisor;
	uiSession: PluginUiSessionService;
	uiHost: PluginUiHost;
	capabilityBroker: CapabilityBroker;
	permissionStore: PluginPermissionStore;
	stateStore: PluginStateStore;
	queryRegistry: QueryRegistry;
	commandRegistry: CommandRegistry;
	publicApi: PluginPublicApi;
	storageFactory: PluginStorageFactoryLike;
	hostServices: PluginHostServices;
	eventGateway: PluginEventGateway;
	scheduler: PluginScheduler;
	secretBroker: PluginSecretBroker;
	toolRegistry: PluginToolRegistry;
	/** Plugin-declared `handler: "server"` commands. */
	pluginCommandRegistry: PluginCommandRegistry;
	mcpAdapter: PluginMcpAdapter;
	providerRegistry: PluginProviderRegistry;
	providerClientPool: PluginProviderClientPool;
	providerCatalogRefresher: PluginProviderCatalogRefresher;
	providerConfigService: PluginProviderConfigService;
	secretVault: PluginSecretVault;
	contributionRegistry: PluginContributionRegistry;
	toolBridge: PluginAgentToolBridge;
	contributionCoordinator: PluginContributionCoordinator;
	lifecycleRevokeCoordinator: PluginLifecycleRevokeCoordinator;
	restorePlugin(pluginId: string): Promise<void>;
}

export interface PluginPlatformServicesOptions {
	runtimeSupervisor?: RuntimeSupervisor;
	uiSession?: PluginUiSessionService;
	uiHost?: PluginUiHost;
	capabilityBroker?: CapabilityBroker;
	permissionStore?: PluginPermissionStore;
	stateStore?: PluginStateStore;
	queryRegistry?: QueryRegistry;
	commandRegistry?: CommandRegistry;
	publicApi?: PluginPublicApi;
	publicApiAdapters?: PluginPublicApiAdapters;
	storageFactory?: PluginStorageFactoryLike;
	storageRoot?: string;
	hostServices?: PluginHostServices;
	eventGateway?: PluginEventGateway;
	scheduler?: PluginScheduler;
	secretBroker?: PluginSecretBroker;
	secretVault?: PluginSecretVault;
	toolRegistry?: PluginToolRegistry;
	/** Dispatch for plugin-declared `handler: "server"` commands. */
	pluginCommandRegistry?: PluginCommandRegistry;
	mcpAdapter?: PluginMcpAdapter;
	providerRegistry?: PluginProviderRegistry;
	/** Registry of `contributes.searchProviders` sources. */
	searchRegistry?: PluginSearchRegistry;
	providerClientPool?: PluginProviderClientPool;
	providerCatalogRefresher?: PluginProviderCatalogRefresher;
	contributionRegistry?: PluginContributionRegistry;
	toolBridge?: PluginAgentToolBridge;
	contributionCoordinator?: PluginContributionCoordinator;
	lifecycleRevokeCoordinator?: PluginLifecycleRevokeCoordinator;
}

const PLUGIN_UI_PLATFORM_REMOVAL_LISTENER = Symbol.for(
	"narrafork.plugin-ui.platform-session-removal",
);

function lifecycleReason(context: PluginLifecycleRevokeContext): string {
	return context.event.reason ?? `plugin-${context.event.kind}`;
}

function revokeOrClearUiSession(
	services: Pick<PluginPlatformServices, "uiSession">,
	context: PluginLifecycleRevokeContext,
): void {
	services.uiSession.clearForPlugin(context.event.pluginId, lifecycleReason(context));
}

function revokeCapability(
	services: Pick<PluginPlatformServices, "capabilityBroker"> &
		Partial<Pick<PluginPlatformServices, "hostServices">>,
	context: PluginLifecycleRevokeContext,
): void {
	if (
		context.action === "invalidate" &&
		context.event.kind === "runtime_generation" &&
		context.event.runtimeId
	) {
		services.hostServices?.revokeRuntime(context.event.pluginId, context.event.runtimeId);
		services.capabilityBroker.revokeRuntime(context.event.pluginId, context.event.runtimeId);
		return;
	}
	if (context.action === "invalidate") {
		// Grant revision/upgrade invalidation has no safe binding-wide fallback: revoke every
		// binding so a stale generation cannot continue through a cached decision.
		services.hostServices?.revokeRuntime(context.event.pluginId);
		services.capabilityBroker.revoke(context.event.pluginId);
		services.capabilityBroker.invalidate(context.event.pluginId);
		return;
	}
	if (context.action === "clear") {
		services.hostServices?.revokeRuntime(context.event.pluginId);
		services.capabilityBroker.clearBindingsForPlugin(context.event.pluginId);
		return;
	}
	services.hostServices?.revokeRuntime(context.event.pluginId);
	services.capabilityBroker.revoke(context.event.pluginId);
	services.capabilityBroker.invalidate(context.event.pluginId);
}

function revokeEventGateway(
	services: Pick<PluginPlatformServices, "eventGateway">,
	context: PluginLifecycleRevokeContext,
): void {
	if (context.action === "invalidate") {
		if (context.event.kind === "runtime_generation" && context.event.runtimeId) {
			services.eventGateway.revokeRuntime(context.event.pluginId, context.event.runtimeId);
		} else {
			services.eventGateway.revokePlugin(context.event.pluginId, lifecycleReason(context));
		}
		return;
	}
	services.eventGateway.revokePlugin(context.event.pluginId, lifecycleReason(context));
}

function revokeSchedules(
	services: Pick<PluginPlatformServices, "scheduler">,
	context: PluginLifecycleRevokeContext,
): void {
	if (context.action === "clear") {
		for (const schedule of services.scheduler.list(context.event.pluginId)) {
			services.scheduler.remove(schedule.fullId, lifecycleReason(context));
		}
		return;
	}
	if (context.action === "revoke") {
		services.scheduler.revokePlugin(context.event.pluginId, lifecycleReason(context));
		return;
	}
	services.scheduler.disablePlugin(context.event.pluginId, lifecycleReason(context));
}

function revokeSecrets(
	services: Pick<PluginPlatformServices, "secretBroker">,
	context: PluginLifecycleRevokeContext,
): void {
	// SecretBroker intentionally retains configuration, but every active lease and future access
	// for this plugin is revoked. A later explicit enable/registration can restore access.
	services.secretBroker.revokePlugin(context.event.pluginId);
}

function revokeTools(
	services: Pick<PluginPlatformServices, "toolRegistry">,
	context: PluginLifecycleRevokeContext,
): void {
	if (context.action === "clear") {
		services.toolRegistry.removePlugin(context.event.pluginId);
		return;
	}
	if (context.action === "invalidate") {
		services.toolRegistry.runtimeCrashed(context.event.pluginId, lifecycleReason(context));
		return;
	}
	if (context.action === "revoke") {
		services.toolRegistry.revokePlugin(context.event.pluginId, lifecycleReason(context));
		return;
	}
	services.toolRegistry.disablePlugin(context.event.pluginId, lifecycleReason(context));
}

function revokeMcp(
	services: Pick<PluginPlatformServices, "mcpAdapter">,
	context: PluginLifecycleRevokeContext,
): void {
	if (context.action === "clear") {
		services.mcpAdapter.toolListChanged(context.event.pluginId, []);
		return;
	}
	services.mcpAdapter.markUnavailable(context.event.pluginId, lifecycleReason(context));
}

function revokeProviders(
	services: Pick<PluginPlatformServices, "providerRegistry">,
	context: PluginLifecycleRevokeContext,
): void {
	if (context.action === "clear") {
		for (const provider of services.providerRegistry.list()) {
			if (provider.pluginId === context.event.pluginId) {
				services.providerRegistry.unregister(provider.providerInstanceId);
			}
		}
		return;
	}
	if (context.action === "invalidate") {
		for (const provider of services.providerRegistry.list()) {
			if (provider.pluginId === context.event.pluginId) {
				services.providerRegistry.markUnavailable(
					provider.providerInstanceId,
					lifecycleReason(context),
				);
			}
		}
		return;
	}
	services.providerRegistry.disablePlugin(context.event.pluginId, lifecycleReason(context));
}

/** Build the fixed-order adapter set from the actual host-owned plugin platform services. */
export function createPluginLifecycleRevokeAdapters(
	services: Pick<
		PluginPlatformServices,
		| "uiSession"
		| "capabilityBroker"
		| "eventGateway"
		| "scheduler"
		| "secretBroker"
		| "toolRegistry"
		| "mcpAdapter"
		| "providerRegistry"
	> &
		Partial<Pick<PluginPlatformServices, "hostServices">>,
): PluginLifecycleRevokeAdapters {
	return {
		ui_session: (context) => revokeOrClearUiSession(services, context),
		capability_broker: (context) => revokeCapability(services, context),
		event_gateway: (context) => revokeEventGateway(services, context),
		scheduler: (context) => revokeSchedules(services, context),
		secret_broker: (context) => revokeSecrets(services, context),
		tool_registry: (context) => revokeTools(services, context),
		mcp_adapter: (context) => revokeMcp(services, context),
		provider_registry: (context) => revokeProviders(services, context),
	};
}

async function restorePluginAccess(
	services: Pick<
		PluginPlatformServices,
		"capabilityBroker" | "secretBroker" | "toolRegistry" | "mcpAdapter" | "providerRegistry"
	>,
	pluginId: string,
): Promise<void> {
	const failures: unknown[] = [];
	const steps = [
		() => services.capabilityBroker.restore(pluginId),
		() => services.secretBroker.restorePlugin(pluginId),
		() => services.toolRegistry.enablePlugin(pluginId),
		() => services.mcpAdapter.markAvailable(pluginId),
		() => services.providerRegistry.enablePlugin(pluginId),
	];
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) {
		throw new AggregateError(failures, `Unable to restore plugin platform access: ${pluginId}`);
	}
}

async function resolvePluginToolPrincipal(
	pluginId: string,
	contributionId: string,
	runtimeSupervisor: RuntimeSupervisor,
	stateStore: PluginStateStore,
): Promise<PluginPrincipal | undefined> {
	const runtime = runtimeSupervisor.get(pluginId);
	if (!runtime || !["active", "degraded"].includes(runtime.state)) return undefined;
	const diagnostics = runtime.getDiagnostics();
	const state = await stateStore.getState(pluginId);
	const packageVersion = diagnostics.pluginVersion ?? state?.current?.version;
	const installationId = state?.authorityInstallationId ?? state?.current?.hash;
	if (!packageVersion || !installationId) return undefined;
	return {
		pluginId,
		packageVersion,
		installationId,
		runtimeId: diagnostics.runtimeId,
		runtimeGeneration: diagnostics.generation,
		contributionId,
	};
}

/**
 * The production plugin platform composition root. Services without an existing singleton are
 * constructed here once, so PluginManager and future contribution hosts share the same state.
 */
export function createPluginPlatformServices(
	options: PluginPlatformServicesOptions = {},
): PluginPlatformServices {
	const runtimeSupervisor = options.runtimeSupervisor ?? new RuntimeSupervisor();
	const uiSession = options.uiSession ?? defaultPluginUiSessionService;
	const capabilityBroker = options.capabilityBroker ?? defaultCapabilityBroker;
	const stateStore = options.stateStore ?? new PluginStateStore();
	const permissionStore =
		options.permissionStore ?? new PluginPermissionStore({ root: stateStore.root, stateStore });
	const eventGateway =
		options.eventGateway ?? options.hostServices?.eventGateway ?? pluginEventGateway;
	const storageFactory =
		options.storageFactory ??
		options.hostServices?.storageFactory ??
		(options.storageRoot
			? new PluginStorageFactory({ root: options.storageRoot })
			: defaultPluginStorageFactory);
	const suppliedPublicApi = options.publicApi ?? options.hostServices?.publicApi;
	const queryRegistry = suppliedPublicApi?.queries ?? options.queryRegistry ?? new QueryRegistry();
	const commandRegistry =
		suppliedPublicApi?.commands ?? options.commandRegistry ?? new CommandRegistry();
	const publicApi =
		suppliedPublicApi ??
		new PluginPublicApi({
			capabilityBroker,
			queryRegistry,
			commandRegistry,
			adapters: options.publicApiAdapters,
		});
	const secretVault = options.secretVault ?? pluginSecretVault;
	const hostServices =
		options.hostServices ??
		createPluginHostServices({
			capabilityBroker,
			permissionStore,
			publicApi,
			eventGateway,
			storageFactory,
			secretKeyLister: (pluginId) => secretVault.listKeys(pluginId),
			secretReader: (pluginId, key) => secretVault.getSecret({ pluginId, key }),
			secretWriter: (pluginId, key, value) => secretVault.setSecret({ pluginId, key, value }),
			secretDeleter: (pluginId, key) => secretVault.deleteSecret({ pluginId, key }),
		});
	/**
	 * Config handed to plugin code, with secret-valued fields removed.
	 *
	 * `config.get` must never carry a credential, so the stripping happens here rather
	 * than in the host layer, which has no schema to tell which fields are secret.
	 */
	const readPluginConfigForPlugin = async (pluginId: string) => {
		const views = await providerConfigService.list(pluginId);
		const byContribution: Record<string, JsonValue> = {};
		for (const view of views) {
			const safe: Record<string, JsonValue> = {};
			const secretFields = new Set(view.secretFields);
			for (const [key, value] of Object.entries(view.config)) {
				if (!secretFields.has(key)) safe[key] = value;
			}
			byContribution[view.contributionId] = safe;
		}
		return byContribution as JsonValue;
	};
	const listPluginSecretKeys = (pluginId: string) => secretVault.listKeys(pluginId);
	// Secret read/write for `secrets.get|set|delete`. Each closure takes `pluginId` from the
	// host-validated principal, so the vault namespace is never caller-selectable. Same
	// functions for backend and UI: a view has no less right to its own plugin's secrets.
	const readPluginSecret = (pluginId: string, key: string) =>
		secretVault.getSecret({ pluginId, key });
	const writePluginSecret = (pluginId: string, key: string, value: string) =>
		secretVault.setSecret({ pluginId, key, value });
	const deletePluginSecret = (pluginId: string, key: string) =>
		secretVault.deleteSecret({ pluginId, key });

	// Dispatch for commands a plugin declares with `handler: "server"`. Before this existed,
	// `commands.execute` only resolved host-registered handlers (`commandRegistry` above), so
	// a plugin-declared command was unreachable dead code.
	const pluginCommandRegistry =
		options.pluginCommandRegistry ??
		new PluginCommandRegistry({
			resolveRuntime: (pluginId) => {
				const runtime = runtimeSupervisor.get(pluginId);
				return runtime && ["active", "degraded"].includes(runtime.state) ? runtime : undefined;
			},
		});

	/**
	 * Adapts the registry to the UI host's narrower dispatcher shape.
	 *
	 * `secretWrites` are validated and applied *here* rather than in the UI host, so
	 * credential material never enters a class whose job is talking to an iframe.
	 *
	 * `providerRegistry` is read lazily inside `invoke` because it is constructed further
	 * down; a direct reference here would capture it before it exists.
	 */
	const commandDispatcher: PluginCommandDispatcher = {
		has: (commandId, pluginId) => pluginCommandRegistry.has(commandId, pluginId),
		invoke: async (commandId, pluginId, input, context) => {
			const result = await pluginCommandRegistry.invoke(commandId, pluginId, input, context);
			if (result.secretWrites.length > 0) {
				await applyCommandSecretWrites({
					pluginId,
					writes: result.secretWrites,
					registry: providerRegistry,
					sink: secretVault,
				});
			}
			// Only `output` crosses back; the writes were consumed above.
			return { output: result.output };
		},
	};

	const uiHost =
		options.uiHost ??
		new PluginUiHost({
			publicApi,
			capabilityBroker,
			eventGateway,
			storageFactory,
			providerConfigReader: readPluginConfigForPlugin,
			secretKeyLister: listPluginSecretKeys,
			secretReader: readPluginSecret,
			secretWriter: writePluginSecret,
			secretDeleter: deletePluginSecret,
			pluginCommands: commandDispatcher,
		});
	uiSession.onRemoved((session, reason) => {
		uiHost.revokeSession(session.sessionId, reason);
		capabilityBroker.clearBinding(session.pluginId, `ui:${session.sessionId}`);
	}, PLUGIN_UI_PLATFORM_REMOVAL_LISTENER);
	const contributionRegistry = options.contributionRegistry ?? new PluginContributionRegistry();
	const scheduler =
		options.scheduler ??
		new PluginScheduler({
			capabilityBroker,
			resolveRuntime: (pluginId) => {
				const runtime = runtimeSupervisor.get(pluginId);
				return runtime?.state === "active" ? runtime : undefined;
			},
		});
	const secretBroker = options.secretBroker ?? new PluginSecretBroker();
	const toolRegistry =
		options.toolRegistry ??
		new PluginToolRegistry({
			capabilityBroker,
			resolvePrincipal: (pluginId, contributionId) =>
				resolvePluginToolPrincipal(pluginId, contributionId, runtimeSupervisor, stateStore),
			resolveRuntime: (pluginId) => {
				const runtime = runtimeSupervisor.get(pluginId);
				return runtime && ["active", "degraded"].includes(runtime.state) ? runtime : undefined;
			},
		});
	const toolBridge =
		options.toolBridge ??
		new PluginAgentToolBridge({
			pluginToolRegistry: toolRegistry,
			isRuntimeActive: (pluginId) => {
				const runtime = runtimeSupervisor.get(pluginId);
				return Boolean(runtime && ["active", "degraded"].includes(runtime.state));
			},
		});
	// Resolved before the contribution coordinator so provider contributions can be
	// registered from the manifest during the same refresh that syncs tools.
	const providerRegistry = options.providerRegistry ?? defaultPluginProviderRegistry;
	// One pool shared by the adapter factory and the catalog refresher, so a provider
	// is activated and handshaken once regardless of which path reaches it first.
	const providerClientPool =
		options.providerClientPool ??
		new PluginProviderClientPool(async (pluginId, { reason }) => {
			const existing = runtimeSupervisor.get(pluginId);
			if (existing && ["active", "degraded"].includes(existing.state)) {
				return existing as unknown as ProviderRuntimeLike;
			}
			const started = await runtimeSupervisor.start(pluginId);
			logger.debug("plugin runtime activated for provider use", { pluginId, reason });
			return started as unknown as ProviderRuntimeLike;
		});
	// Merges vault-held credentials into the config sent to a plugin. Shared by the
	// adapter factory and the catalog refresher so chat and model enumeration authenticate
	// identically; without it a provider can have a key stored yet never receive it.
	const providerCredentialResolver = new PluginProviderCredentialResolver({
		registry: providerRegistry,
		secretSource: secretVault,
	});
	const resolveProviderConfig = (providerInstanceId: string) =>
		providerCredentialResolver.resolve(providerInstanceId);
	// Resolve host-provided hints (proxy, concurrency budget) for plugin provider requests.
	// reflected immediately without restarting plugins.
	//
	// Concurrency budget is intentionally not populated: the only value the host could send
	// is the plugin's own declared maxConcurrentChat, which is noise. Real cross-path budget
	const resolveProviderHostHints = (): ProviderHostHints | undefined => {
		const proxyUrl = getOutboundProxy();
		// Only build hints when there is at least one piece of information to deliver.
		// An empty object would be harmless but noisy on the wire.
		if (!proxyUrl) return undefined;
		return {
			outbound: { proxyUrl },
		};
	};
	// Give registered providers a working `createAdapter()`. The runtime is resolved
	// (and started if needed) on first chat/generate rather than at registration, so
	// a catalog refresh never spawns plugin processes.
	providerRegistry.setRemoteProviderAdapterFactory(
		createPluginProviderAdapterFactory({
			clientPool: providerClientPool,
			resolveConfig: resolveProviderConfig,
			resolveHostHints: resolveProviderHostHints,
		}),
	);
	const providerCatalogRefresher =
		options.providerCatalogRefresher ??
		new PluginProviderCatalogRefresher({
			registry: providerRegistry,
			clientPool: providerClientPool,
			resolveConfig: resolveProviderConfig,
			resolveHostHints: resolveProviderHostHints,
		});
	const providerConfigService = new PluginProviderConfigService({
		registry: providerRegistry,
		stateStore,
		secretStore: secretVault,
	});
	// Surface plugin models to `getVisibleModels()` and prefix-less model resolution.
	// Reads are synchronous registry lookups, so this adds no work to request paths
	// beyond walking the already-cached catalogs.
	registerExtraModelSource("plugin-providers", {
		listModels: () => listPluginProviderModelValues(providerRegistry),
		resolveProvider: (bareModel) => findPluginProviderForModel(providerRegistry, bareModel),
	});
	// Plugin-contributed web search sources. Credentials and config come from the provider
	// each source binds to, which is why this reuses the provider registry, credential
	// resolver and client pool rather than owning any of them.
	const searchRegistry =
		options.searchRegistry ??
		new PluginSearchRegistry({
			providerRegistry,
			credentialResolver: providerCredentialResolver,
			// Availability is decided synchronously on a hot path, so secret presence is read
			// from the vault's in-memory document rather than awaited.
			secretPeek: secretVault,
			resolveClient: (input) => providerClientPool.get(input).acquire(),
			resolveHostHints: resolveProviderHostHints,
		});
	// Warm the vault so the first synchronous availability check can see stored secrets
	// instead of reporting every credentialed channel as unconfigured.
	void secretVault.warm().catch(() => undefined);
	registerExtraSearchChannelSource("plugins", pluginSearchChannelSource(searchRegistry));
	const contributionCoordinator =
		options.contributionCoordinator ??
		new PluginContributionCoordinator({
			contributionRegistry,
			toolRegistry,
			pluginCommandRegistry,
			providerRegistry,
			searchRegistry,
			agentToolBridge: toolBridge,
			lifecycleStates: () => stateStore.listStates(),
			// Synchronous read from the already-loaded state document, so a restart
			// re-registers providers with the config the user saved.
			providerConfigSource: (pluginId) => stateStore.getCachedState(pluginId)?.providerConfigs,
			providerPrefixSource: (pluginId) => stateStore.getCachedState(pluginId)?.providerPrefixes,
			providerConfigPruner: async (pluginId, keep) => {
				// The credential for a provider lives in the vault, not in state.json, so both
				// have to be pruned or a removed provider would leave a live secret behind that
				// only an uninstall could clear.
				await secretVault.pruneProviderSecrets(pluginId, keep);
				// Skip the state write entirely when there is nothing stored, which is the
				// common case for the many plugins that contribute no providers.
				const stored = stateStore.getCachedState(pluginId)?.providerConfigs;
				if (!stored || Object.keys(stored).length === 0) return;
				if (Object.keys(stored).every((id) => keep.includes(id))) return;
				await stateStore.pruneProviderConfigs(pluginId, keep);
			},
		});
	const mcpAdapter =
		options.mcpAdapter ??
		new PluginMcpAdapter({ registry: contributionRegistry, capabilityBroker });
	const lifecycleRevokeCoordinator =
		options.lifecycleRevokeCoordinator ??
		new PluginLifecycleRevokeCoordinator({
			adapters: createPluginLifecycleRevokeAdapters({
				uiSession,
				capabilityBroker,
				hostServices,
				eventGateway,
				scheduler,
				secretBroker,
				toolRegistry,
				mcpAdapter,
				providerRegistry,
			}),
			logger: {
				error: (message, context) => logger.error(message, context),
			},
		});

	const services = {
		runtimeSupervisor,
		uiSession,
		uiHost,
		capabilityBroker,
		permissionStore,
		stateStore,
		queryRegistry,
		commandRegistry,
		publicApi,
		storageFactory,
		hostServices,
		eventGateway,
		scheduler,
		secretBroker,
		toolRegistry,
		pluginCommandRegistry,
		mcpAdapter,
		providerRegistry,
		searchRegistry,
		providerClientPool,
		providerCatalogRefresher,
		providerConfigService,
		secretVault,
		contributionRegistry,
		toolBridge,
		contributionCoordinator,
		lifecycleRevokeCoordinator,
	};
	return {
		...services,
		restorePlugin: (pluginId) => restorePluginAccess(services, pluginId),
	};
}

export const pluginPlatformServices = createPluginPlatformServices();
