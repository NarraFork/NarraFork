import { logger } from "@server/lib/logger";
import { PluginAgentToolBridge } from "./plugin-agent-tool-bridge";
import {
	type CapabilityBroker,
	capabilityBroker as defaultCapabilityBroker,
	type PluginPrincipal,
} from "./plugin-capability-broker";
import { PluginContributionCoordinator } from "./plugin-contribution-coordinator";
import { PluginContributionRegistry } from "./plugin-contribution-registry";
import {
	type CapabilityAuthorizationRequest as EventCapabilityAuthorizationRequest,
	type PluginCapabilityBroker as PluginEventCapabilityBroker,
	PluginEventGateway,
} from "./plugin-event-gateway";
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
import { RuntimeSupervisor } from "./plugin-runtime";
import { PluginScheduler } from "./plugin-scheduler";
import { PluginSecretBroker } from "./plugin-secret-broker";
import { PluginStateStore } from "./plugin-state-store";
import { PluginToolRegistry } from "./plugin-tool-registry";
import {
	pluginUiSessionService as defaultPluginUiSessionService,
	type PluginUiSessionService,
} from "./plugin-ui-session";

export interface PluginPlatformServices {
	runtimeSupervisor: RuntimeSupervisor;
	uiSession: PluginUiSessionService;
	capabilityBroker: CapabilityBroker;
	permissionStore: PluginPermissionStore;
	stateStore: PluginStateStore;
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
	capabilityBroker?: CapabilityBroker;
	permissionStore?: PluginPermissionStore;
	stateStore?: PluginStateStore;
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

function createEventCapabilityBroker(
	capabilityBroker: CapabilityBroker,
): PluginEventCapabilityBroker {
	const authorize = async (input: EventCapabilityAuthorizationRequest) => {
		const runtimeId = input.plugin.runtimeId;
		const rawBinding = capabilityBroker.getBinding(input.plugin.pluginId, runtimeId);
		if (!rawBinding?.plugin) return { allowed: false, revoke: true, reason: "binding-missing" };
		const plugin = rawBinding.plugin;
		const context = capabilityBroker.withCallContext({
			plugin,
			invocation: { kind: "plugin_background", source: "event" },
			scope: input.scope,
		});
		const result = await capabilityBroker.authorize({
			context,
			capability: input.capability,
			methodId: `events.${input.phase}`,
			scope: input.scope,
			constraints: { topic: input.topic },
		});
		return result.allowed
			? { allowed: true }
			: { allowed: false, revoke: true, reason: result.error.reason };
	};
	return {
		authorize,
		isRuntimeActive: (plugin) => {
			const binding = capabilityBroker.getBinding(plugin.pluginId, plugin.runtimeId);
			return Boolean(
				binding &&
					(binding.runtimeState === "active" || binding.runtimeState === "degraded") &&
					(binding.runtimeGeneration === undefined ||
						plugin.generation === undefined ||
						binding.runtimeGeneration === plugin.generation),
			);
		},
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
	const hostServices =
		options.hostServices ??
		createPluginHostServices({
			capabilityBroker,
			permissionStore,
		});
	const eventGateway =
		options.eventGateway ??
		new PluginEventGateway({
			capabilityBroker: createEventCapabilityBroker(capabilityBroker),
		});
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
		capabilityBroker,
		permissionStore,
		stateStore,
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
