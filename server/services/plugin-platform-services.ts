import { logger } from "@server/lib/logger";
import { getOutboundProxy, resolveOverride } from "@server/lib/net/proxy";
import type { JsonValue } from "@server/lib/plugins/protocol";
import { registerExtraSearchChannelSource } from "@server/lib/search/plugin-source";
import { registerExtraModelSource } from "@server/lib/settings";
import type { ProxyOverride } from "@server/lib/settings/types";
import { PluginAgentToolBridge } from "./plugin-agent-tool-bridge";
import {
	type CapabilityBroker,
	capabilityBroker as defaultCapabilityBroker,
	type PluginPrincipal,
} from "./plugin-capability-broker";
import { applyCommandConfigWrites } from "./plugin-command-config-writes";
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
import {
	createPluginProviderAdapterFactory,
	type ProviderHostHintsContext,
} from "./plugin-provider-adapter-factory";
import type { ProviderCatalogRefreshResult } from "./plugin-provider-catalog-refresh";
import { PluginProviderCatalogRefresher } from "./plugin-provider-catalog-refresh";
import { PluginProviderClientPool, type ProviderRuntimeLike } from "./plugin-provider-client";
import { PluginProviderConfigService } from "./plugin-provider-config-service";
import { PluginProviderCredentialResolver } from "./plugin-provider-credential-resolver";
import {
	findPluginProviderForModel,
	listPluginProviderModelValues,
} from "./plugin-provider-model-source";
import { decideProviderProxy } from "./plugin-provider-proxy-policy";
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
	// runtime_generation events carry no authorization change for the UI: the
	// installation identity, authority and grants are unchanged, so UI sessions
	// (bound to the stable UUID, not the runtime generation) survive an idle
	// backend runtime restart. Only revoke/clear wipe them.
	if (context.action === "invalidate") return;
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
	// Bindings use the stable UUID installation identity when available; older
	// state files fall back through the authority generation and legacy package hash.
	const installationId =
		state?.installationId ?? state?.authorityInstallationId ?? state?.current?.hash;
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

/** Narrow catalog refresher surface the command dispatcher needs. */
export interface PluginProviderCatalogRefresherLike {
	refresh(
		providerInstanceId: string,
		options?: { signal?: AbortSignal; force?: boolean },
	): Promise<ProviderCatalogRefreshResult>;
}

interface AppliedCommandWrite {
	contributionId: string;
}

function contributionIdFromProviderWriteKey(key: string): string | undefined {
	const match = /^provider\.([^.]+)\..+$/.exec(key);
	return match?.[1];
}

/**
 * Refresh the provider catalogs affected by applied command writes.
 *
 * This runs after the writes themselves succeeded. A refresh failure must not roll back the
 * user's persisted choice, so the outcome is returned for the caller to surface instead of
 * thrown. Exported as a helper so the dispatcher's policy can be tested without constructing
 * the whole platform composition.
 */
export async function refreshCatalogsAfterCommandWrites(input: {
	pluginId: string;
	appliedWrites: readonly AppliedCommandWrite[];
	registry: Pick<PluginProviderRegistry, "list">;
	refresher: PluginProviderCatalogRefresherLike;
}): Promise<
	Array<
		| {
				providerInstanceId: string;
				ok: true;
				modelCount: number;
		  }
		| {
				providerInstanceId: string;
				ok: false;
				error: string;
		  }
	>
> {
	const { pluginId, appliedWrites, registry, refresher } = input;
	if (appliedWrites.length === 0) return [];

	const contributionIds = new Set<string>();
	for (const write of appliedWrites) {
		if (write.contributionId) contributionIds.add(write.contributionId);
	}
	const targets = new Map<string, string>();
	for (const entry of registry.list()) {
		if (entry.kind !== "executable-plugin" || entry.pluginId !== pluginId) continue;
		if (!contributionIds.has(entry.localId)) continue;
		targets.set(entry.providerInstanceId, entry.providerInstanceId);
	}

	const results: Awaited<ReturnType<typeof refreshCatalogsAfterCommandWrites>> = [];
	for (const providerInstanceId of targets.keys()) {
		try {
			const refreshed = await refresher.refresh(providerInstanceId, { force: true });
			// The real refresher reports an unreachable provider in-band ({ stale, error })
			// rather than throwing — treating any settled promise as success would report
			// ok: true with the pre-write model count, and the UI could never explain why
			// the list did not change.
			if (refreshed.error) {
				logger.warn("Plugin provider catalog refresh failed after command write", {
					pluginId,
					providerInstanceId,
					error: refreshed.error,
				});
				results.push({ providerInstanceId, ok: false, error: refreshed.error });
			} else {
				results.push({ providerInstanceId, ok: true, modelCount: refreshed.modelCount });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn("Plugin provider catalog refresh failed after command write", {
				pluginId,
				providerInstanceId,
				error: message,
			});
			results.push({ providerInstanceId, ok: false, error: message });
		}
	}
	return results;
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
			const appliedWrites: AppliedCommandWrite[] = [];
			if (result.secretWrites.length > 0) {
				const applied = await applyCommandSecretWrites({
					pluginId,
					writes: result.secretWrites,
					registry: providerRegistry,
					sink: secretVault,
				});
				for (const key of [...applied.written, ...applied.deleted]) {
					const contributionId = contributionIdFromProviderWriteKey(key);
					if (contributionId) appliedWrites.push({ contributionId });
				}
			}
			// Non-secret provider settings. Applied after secrets so a config write cannot land
			// while the credential it describes failed to store, and routed through
			// `providerConfigService` so it gets the same schema validation as the host's own
			// config form. `providerConfigService` is declared further down, hence the lazy read
			// inside `invoke` — same reason `providerRegistry` is read here rather than captured.
			if (result.configWrites.length > 0) {
				const applied = await applyCommandConfigWrites({
					pluginId,
					writes: result.configWrites,
					registry: providerRegistry,
					sink: providerConfigService,
				});
				for (const key of [...applied.written, ...applied.cleared]) {
					const contributionId = contributionIdFromProviderWriteKey(key);
					if (contributionId) appliedWrites.push({ contributionId });
				}
			}
			// Deliberately outside the command's deadline (the UI host's fence signal is not
			// threaded here): a refresh that outlives it must still run to completion, because
			// the writes above already persisted and the catalog is the only derived state that
			// has to converge. The trade is that a slow provider makes the *command response*
			// arrive after the client's TIMEOUT — the client sees a failure while the server
			// finishes the sync, which is reported accurately through catalogSync on the next
			// call. Moving the refresh off the response path entirely (fire-and-forget plus a
			// catalogInvalidated push) is the alternative; it was rejected because the command's
			// caller is exactly who needs the per-provider outcome.
			const catalogSync = await refreshCatalogsAfterCommandWrites({
				pluginId,
				appliedWrites,
				registry: providerRegistry,
				refresher: providerCatalogRefresher,
			});
			// Only `output` crosses back; the writes were consumed above. Catalog sync is
			// metadata, not credential material, so the UI can explain a stale list without
			// seeing any write values.
			return {
				output: result.output,
				...(catalogSync.length > 0 ? { catalogSync } : {}),
			};
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
	/**
	 * Resolve host-provided hints (proxy, concurrency budget) for plugin provider requests.
	 *
	 * Read per-call so a settings or override change takes effect without restarting plugins.
	 *
	 * The per-provider override is consulted first and the global policy is the fallback,
	 * which mirrors how the built-in providers resolve `settings.<provider>.proxy` through
	 * `resolveOverride`. Before this existed a plugin provider could only follow the global
	 * proxy: there was no way to send one plugin provider through a proxy and another direct,
	 * which every built-in provider has supported.
	 *
	 * `mode: "direct"` deliberately yields no proxy *and* no fallback — that is the point of
	 * the mode, and treating an empty result as "nothing to say" would silently restore the
	 * global proxy the user explicitly opted out of. So the hints object is still sent in that
	 * case, carrying an absent proxy, which `applyHostHints` on the plugin side reads as
	 * "clear it".
	 *
	 * Concurrency budget is intentionally not populated: the only value the host could send
	 * is the plugin's own declared maxConcurrentChat, which is noise. Real cross-path budget
	 * sharing requires provider-specific state that doesn't belong in the generic plugin path.
	 */
	const resolveProviderHostHints = (
		context?: ProviderHostHintsContext,
	): ProviderHostHints | undefined => {
		// The decision itself lives in `plugin-provider-proxy-policy.ts` as a pure function;
		// this only supplies the inputs.
		const decision = decideProviderProxy({
			...(context ? { override: resolveProviderProxyOverride(context) } : {}),
			resolveOverride,
			...(getOutboundProxy() ? { globalProxyUrl: getOutboundProxy() } : {}),
		});
		return decision as ProviderHostHints | undefined;
	};

	/**
	 * The stored proxy override for a provider instance, if any.
	 *
	 * Synchronous because it runs on the request path: `getCachedState` reads the already-loaded
	 * document, and awaiting a load here would put file I/O in front of every chat call. A miss
	 * (before the first load) is treated as "no override", which falls back to the global proxy
	 * — the behaviour that existed before per-provider overrides.
	 *
	 * Keyed by `localId` because that is the contribution id the override is stored under;
	 * `providerInstanceId` carries version and hash and would change on every upgrade.
	 */
	const resolveProviderProxyOverride = (
		context: ProviderHostHintsContext,
	): ProxyOverride | undefined => {
		const entry = providerRegistry.get(context.providerInstanceId);
		if (!entry || entry.kind !== "executable-plugin") return undefined;
		const record = stateStore.getCachedState(context.pluginId);
		return record?.providerProxies?.[entry.localId];
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
