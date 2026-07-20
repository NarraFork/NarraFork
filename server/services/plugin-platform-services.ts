import { logger } from "@server/lib/logger";
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
	toolRegistry?: PluginToolRegistry;
	mcpAdapter?: PluginMcpAdapter;
	providerRegistry?: PluginProviderRegistry;
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
	const uiHost =
		options.uiHost ??
		new PluginUiHost({
			publicApi,
			capabilityBroker,
			eventGateway,
			storageFactory,
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
	const contributionCoordinator =
		options.contributionCoordinator ??
		new PluginContributionCoordinator({
			contributionRegistry,
			toolRegistry,
			agentToolBridge: toolBridge,
			lifecycleStates: () => stateStore.listStates(),
		});
	const mcpAdapter =
		options.mcpAdapter ??
		new PluginMcpAdapter({ registry: contributionRegistry, capabilityBroker });
	const providerRegistry = options.providerRegistry ?? defaultPluginProviderRegistry;
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
