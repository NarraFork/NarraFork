import { logger } from "@server/lib/logger";
import {
	type CapabilityBroker,
	capabilityBroker as defaultCapabilityBroker,
} from "./plugin-capability-broker";
import { PluginContributionRegistry } from "./plugin-contribution-registry";
import {
	pluginEventGateway as defaultPluginEventGateway,
	type PluginEventGateway,
} from "./plugin-event-gateway";
import {
	type PluginLifecycleRevokeAdapters,
	type PluginLifecycleRevokeContext,
	PluginLifecycleRevokeCoordinator,
} from "./plugin-lifecycle-revoke-coordinator";
import { PluginMcpAdapter } from "./plugin-mcp-adapter";
import {
	pluginProviderRegistry as defaultPluginProviderRegistry,
	type PluginProviderRegistry,
} from "./plugin-provider-registry";
import { RuntimeSupervisor } from "./plugin-runtime";
import { PluginScheduler } from "./plugin-scheduler";
import { PluginSecretBroker } from "./plugin-secret-broker";
import { PluginToolRegistry } from "./plugin-tool-registry";
import {
	pluginUiSessionService as defaultPluginUiSessionService,
	type PluginUiSessionService,
} from "./plugin-ui-session";

export interface PluginPlatformServices {
	runtimeSupervisor: RuntimeSupervisor;
	uiSession: PluginUiSessionService;
	capabilityBroker: CapabilityBroker;
	eventGateway: PluginEventGateway;
	scheduler: PluginScheduler;
	secretBroker: PluginSecretBroker;
	toolRegistry: PluginToolRegistry;
	mcpAdapter: PluginMcpAdapter;
	providerRegistry: PluginProviderRegistry;
	contributionRegistry: PluginContributionRegistry;
	lifecycleRevokeCoordinator: PluginLifecycleRevokeCoordinator;
	restorePlugin(pluginId: string): Promise<void>;
}

export interface PluginPlatformServicesOptions {
	runtimeSupervisor?: RuntimeSupervisor;
	uiSession?: PluginUiSessionService;
	capabilityBroker?: CapabilityBroker;
	eventGateway?: PluginEventGateway;
	scheduler?: PluginScheduler;
	secretBroker?: PluginSecretBroker;
	toolRegistry?: PluginToolRegistry;
	mcpAdapter?: PluginMcpAdapter;
	providerRegistry?: PluginProviderRegistry;
	contributionRegistry?: PluginContributionRegistry;
	lifecycleRevokeCoordinator?: PluginLifecycleRevokeCoordinator;
}

function lifecycleReason(context: PluginLifecycleRevokeContext): string {
	return context.event.reason ?? `plugin-${context.event.kind}`;
}

function revokeOrClearUiSession(
	services: Pick<PluginPlatformServices, "uiSession">,
	context: PluginLifecycleRevokeContext,
): void {
	services.uiSession.clearForPlugin(context.event.pluginId);
}

function revokeCapability(
	services: Pick<PluginPlatformServices, "capabilityBroker">,
	context: PluginLifecycleRevokeContext,
): void {
	if (context.action === "invalidate") {
		services.capabilityBroker.invalidate(context.event.pluginId);
		return;
	}
	if (context.action === "clear") {
		services.capabilityBroker.clearBindingsForPlugin(context.event.pluginId);
		return;
	}
	services.capabilityBroker.revoke(context.event.pluginId);
	services.capabilityBroker.invalidate(context.event.pluginId);
}

function revokeEventGateway(
	services: Pick<PluginPlatformServices, "eventGateway">,
	context: PluginLifecycleRevokeContext,
): void {
	if (context.action === "invalidate") {
		if (context.event.runtimeId) {
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
	>,
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
	const eventGateway = options.eventGateway ?? defaultPluginEventGateway;
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
			resolveRuntime: (pluginId) => {
				const runtime = runtimeSupervisor.get(pluginId);
				return runtime?.state === "active" ? runtime : undefined;
			},
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
		capabilityBroker,
		eventGateway,
		scheduler,
		secretBroker,
		toolRegistry,
		mcpAdapter,
		providerRegistry,
		contributionRegistry,
		lifecycleRevokeCoordinator,
	};
	return {
		...services,
		restorePlugin: (pluginId) => restorePluginAccess(services, pluginId),
	};
}

export const pluginPlatformServices = createPluginPlatformServices();
