import { logger } from "@server/lib/logger";
import type { JsonValue } from "@server/lib/plugins/protocol";
import { registerExtraModelSource } from "@server/lib/settings";
import { PluginAgentToolBridge } from "./plugin-agent-tool-bridge";
import {
	type CapabilityBroker,
	capabilityBroker as defaultCapabilityBroker,
	type PluginPrincipal,
} from "./plugin-capability-broker";
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
import {
	findPluginProviderForModel,
	listPluginProviderModelValues,
} from "./plugin-provider-model-source";
import {
	pluginProviderRegistry as defaultPluginProviderRegistry,
	type PluginProviderRegistry,
} from "./plugin-provider-registry";
import {
	CommandRegistry,
	PluginPublicApi,
	type PluginPublicApiAdapters,
	QueryRegistry,
} from "./plugin-public-api";
import { RuntimeSupervisor } from "./plugin-runtime";
import { PluginScheduler } from "./plugin-scheduler";
import { PluginSecretBroker } from "./plugin-secret-broker";
import { type PluginSecretVault, pluginSecretVault } from "./plugin-secret-vault";
import { PluginStateStore } from "./plugin-state-store";
import {
	pluginStorageFactory as defaultPluginStorageFactory,
	PluginStorageFactory,
	type PluginStorageFactoryLike,
} from "./plugin-storage";
import { PluginToolRegistry } from "./plugin-tool-registry";
import { PluginUiHost } from "./plugin-ui-host";
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
	mcpAdapter?: PluginMcpAdapter;
	providerRegistry?: PluginProviderRegistry;
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
	const installationId = state?.current?.hash;
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
	const hostServices =
		options.hostServices ??
		createPluginHostServices({
			capabilityBroker,
			permissionStore,
			publicApi,
			eventGateway,
			storageFactory,
		});
	const secretVault = options.secretVault ?? pluginSecretVault;
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

	const uiHost =
		options.uiHost ??
		new PluginUiHost({
			publicApi,
			capabilityBroker,
			eventGateway,
			storageFactory,
			providerConfigReader: readPluginConfigForPlugin,
			secretKeyLister: listPluginSecretKeys,
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
	// Give registered providers a working `createAdapter()`. The runtime is resolved
	// (and started if needed) on first chat/generate rather than at registration, so
	// a catalog refresh never spawns plugin processes.
	providerRegistry.setRemoteProviderAdapterFactory(
		createPluginProviderAdapterFactory({ clientPool: providerClientPool }),
	);
	const providerCatalogRefresher =
		options.providerCatalogRefresher ??
		new PluginProviderCatalogRefresher({
			registry: providerRegistry,
			clientPool: providerClientPool,
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
	const contributionCoordinator =
		options.contributionCoordinator ??
		new PluginContributionCoordinator({
			contributionRegistry,
			toolRegistry,
			providerRegistry,
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
		mcpAdapter,
		providerRegistry,
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
