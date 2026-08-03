import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AsyncMutex } from "@server/lib/async-mutex";
import { type Manifest, safeParseManifest } from "@server/lib/plugins/manifest";
import type { JsonValue } from "@server/lib/plugins/protocol";
import type { PluginAgentToolBridge } from "./plugin-agent-tool-bridge";
import type {
	PluginCatalogPlugin,
	PluginCatalogSnapshot,
	PluginPackageSummary,
} from "./plugin-catalog";
import type { PluginCommandRegistry } from "./plugin-command-registry";
import type { PluginContributionRegistry } from "./plugin-contribution-registry";
import { providerRegistrationsFromManifest } from "./plugin-provider-manifest";
import type { PluginProviderRegistry } from "./plugin-provider-registry";
import type { PluginSearchRegistry } from "./plugin-search-registry";
import type { PluginStateRecord } from "./plugin-state-store";
import type { PluginToolRegistry } from "./plugin-tool-registry";

const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;

export interface PluginContributionLifecycleState {
	pluginId: string;
	desiredState?: PluginStateRecord["desiredState"];
	runtimeState?: PluginStateRecord["runtimeState"] | string;
	compatibility?: PluginStateRecord["compatibility"];
}

export type PluginContributionLifecycleStateSource =
	| readonly PluginContributionLifecycleState[]
	| (() =>
			| readonly PluginContributionLifecycleState[]
			| Promise<readonly PluginContributionLifecycleState[]>);

export type PluginManifestLoader = (packageSummary: PluginPackageSummary) => Promise<Manifest>;

/**
 * Supplies persisted provider config at registration time, keyed by contribution id.
 *
 * Without this a restart would re-register every provider with empty config, so a
 * configured provider would silently lose its settings. Reads must be synchronous:
 * registration happens inside the contribution refresh critical section.
 */
export type PluginProviderConfigSource = (
	pluginId: string,
) => Readonly<Record<string, Record<string, JsonValue>>> | undefined;

/**
 * Removes stored provider config outside the `keep` set for one plugin. Best-effort:
 * a rejection is logged as a diagnostic and does not fail the refresh, because the
 * registry is already live and leftover config is harmless until the next pass.
 */
export type PluginProviderConfigPruner = (
	pluginId: string,
	keepContributionIds: readonly string[],
) => Promise<unknown> | unknown;

/** Reads persisted prefix overrides for one plugin, keyed by contribution id. */
export type PluginProviderPrefixSource = (
	pluginId: string,
) => Readonly<Record<string, string>> | undefined;

export interface PluginContributionCoordinatorOptions {
	contributionRegistry: PluginContributionRegistry;
	toolRegistry: PluginToolRegistry;
	/**
	 * Provider registry kept in sync with `contributes.providers`. Optional so
	 * existing callers and tests that only exercise tools keep working; when it is
	 * absent no provider registration happens at all.
	 */
	providerRegistry?: PluginProviderRegistry;
	/**
	 * Registry for plugin-declared commands, kept in sync with `contributes.commands`.
	 * Optional for the same reason as `providerRegistry`: callers that only exercise tools
	 * should not have to construct one.
	 */
	pluginCommandRegistry?: PluginCommandRegistry;
	/**
	 * Registry kept in sync with `contributes.searchProviders`. Optional for the same reason
	 * as `providerRegistry`; when absent, plugin search channels are simply never offered.
	 */
	searchRegistry?: PluginSearchRegistry;
	/** Persisted provider config, so a restart re-registers with the user's settings. */
	providerConfigSource?: PluginProviderConfigSource;
	/** Persisted prefix overrides, so a restart keeps the admin's chosen namespace. */
	providerPrefixSource?: PluginProviderPrefixSource;
	/**
	 * Drops persisted config for provider contributions a plugin no longer declares.
	 *
	 * Called only after a refresh has fully succeeded and only for plugins whose
	 * manifest actually parsed. A transient manifest read failure must never be read as
	 * "the provider is gone", or a restart glitch would silently erase user settings.
	 */
	providerConfigPruner?: PluginProviderConfigPruner;
	agentToolBridge?: PluginAgentToolBridge;
	manifestLoader?: PluginManifestLoader;
	lifecycleStates?: PluginContributionLifecycleStateSource;
	now?: () => Date;
}

export interface PluginContributionCoordinatorRefreshOptions {
	lifecycleStates?: PluginContributionLifecycleStateSource;
	force?: boolean;
	reason?: string;
}

export interface PluginContributionCoordinatorReport {
	changed: boolean;
	rolledBack: boolean;
	revision: number;
	packageGenerations: Readonly<Record<string, string>>;
	contributionCount: number;
	toolCount: number;
	/** Executable-plugin providers currently registered, across all plugins. */
	providerCount: number;
	agentToolCount: number;
	diagnostics: readonly string[];
	reason?: string;
}

export class PluginContributionCoordinatorError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable = false) {
		super(message);
		this.name = "PluginContributionCoordinatorError";
		this.code = code;
		this.retryable = retryable;
	}
}

interface PreparedPlugin {
	plugin: PluginCatalogPlugin;
	packageSummary?: PluginPackageSummary;
	generation?: string;
	manifest?: Manifest;
	manifestError?: string;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function packageForPlugin(
	snapshot: PluginCatalogSnapshot,
	plugin: PluginCatalogPlugin,
): PluginPackageSummary | undefined {
	if (plugin.current) {
		return (
			plugin.packages.find(
				(item) => item.version === plugin.current?.version && item.hash === plugin.current.hash,
			) ??
			snapshot.packages.find(
				(item) =>
					item.pluginId === plugin.pluginId &&
					item.version === plugin.current?.version &&
					item.hash === plugin.current.hash,
			)
		);
	}
	return plugin.packages.find((item) => item.isCurrent);
}

function generationFor(packageSummary: PluginPackageSummary | undefined): string | undefined {
	return packageSummary ? `${packageSummary.version}:${packageSummary.hash}` : undefined;
}

function stateMap(
	states: readonly PluginContributionLifecycleState[],
): Map<string, PluginContributionLifecycleState> {
	return new Map(states.map((state) => [state.pluginId, { ...state }]));
}

async function resolveStates(
	source: PluginContributionLifecycleStateSource | undefined,
): Promise<readonly PluginContributionLifecycleState[]> {
	if (!source) return [];
	return typeof source === "function" ? source() : source;
}

function lifecycleUnavailableReason(
	state: PluginContributionLifecycleState | undefined,
	packageSummary: PluginPackageSummary | undefined,
): string | undefined {
	if (!packageSummary) return "Plugin current package is unavailable";
	if (packageSummary.status !== "compatible") return `Plugin package is ${packageSummary.status}`;
	if (!state) return undefined;
	if (state.desiredState === "disabled" || state.desiredState === "uninstalling") {
		return "Plugin is disabled";
	}
	if (state.compatibility === "incompatible") return "Plugin is incompatible";
	if (
		["crashed", "failed", "quarantine", "draining", "deactivating"].includes(
			String(state.runtimeState),
		)
	) {
		return `Plugin runtime is ${state.runtimeState}`;
	}
	return undefined;
}

async function defaultManifestLoader(packageSummary: PluginPackageSummary): Promise<Manifest> {
	const manifestPath = join(packageSummary.path, "manifest.json");
	const info = await lstat(manifestPath);
	if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_MANIFEST_BYTES) {
		throw new PluginContributionCoordinatorError(
			"PLUGIN_MANIFEST_UNAVAILABLE",
			"Plugin manifest is unavailable for contribution registration",
		);
	}
	const bytes = await readFile(manifestPath);
	if (bytes.byteLength > MAX_MANIFEST_BYTES) {
		throw new PluginContributionCoordinatorError(
			"PLUGIN_MANIFEST_TOO_LARGE",
			"Plugin manifest exceeds the contribution registration limit",
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
	} catch {
		throw new PluginContributionCoordinatorError(
			"PLUGIN_MANIFEST_CORRUPT",
			"Plugin manifest is not valid JSON",
		);
	}
	const parsed = safeParseManifest(raw);
	if (!parsed.success) {
		throw new PluginContributionCoordinatorError(
			"PLUGIN_MANIFEST_INVALID",
			"Plugin manifest failed strict validation",
		);
	}
	if (
		parsed.data.pluginId !== packageSummary.pluginId ||
		parsed.data.version !== packageSummary.version
	) {
		throw new PluginContributionCoordinatorError(
			"PLUGIN_IDENTITY_MISMATCH",
			"Plugin manifest identity does not match the catalog package",
		);
	}
	return parsed.data;
}

function emptySnapshot(): PluginCatalogSnapshot {
	return { generatedAt: new Date(0).toISOString(), plugins: [], packages: [], diagnostics: [] };
}

function sameManifestGeneration(
	manifest: Manifest | undefined,
	packageSummary: PluginPackageSummary | undefined,
): boolean {
	return Boolean(
		manifest &&
			packageSummary &&
			manifest.pluginId === packageSummary.pluginId &&
			manifest.version === packageSummary.version,
	);
}

/**
 * Coordinates static catalog metadata, host-owned contribution/tool registries, and the Agent
 * bridge. It never starts a runtime itself; lazy activation is owned by PluginAgentToolBridge.
 */
export class PluginContributionCoordinator {
	readonly contributionRegistry: PluginContributionRegistry;
	readonly toolRegistry: PluginToolRegistry;
	private readonly pluginCommandRegistry?: PluginCommandRegistry;
	readonly providerRegistry?: PluginProviderRegistry;
	readonly searchRegistry?: PluginSearchRegistry;
	private readonly providerConfigSource?: PluginProviderConfigSource;
	private readonly providerPrefixSource?: PluginProviderPrefixSource;
	private readonly providerConfigPruner?: PluginProviderConfigPruner;
	readonly agentToolBridge?: PluginAgentToolBridge;

	private readonly manifestLoader: PluginManifestLoader;
	private readonly defaultLifecycleStates?: PluginContributionLifecycleStateSource;
	private readonly now: () => Date;
	private readonly mutex = new AsyncMutex();
	private lastSnapshot?: PluginCatalogSnapshot;
	private lastStates: PluginContributionLifecycleState[] = [];
	private manifests = new Map<string, Manifest>();
	private generations = new Map<string, string>();
	private fingerprint = "";
	private revisionValue = 0;

	constructor(options: PluginContributionCoordinatorOptions) {
		this.contributionRegistry = options.contributionRegistry;
		this.toolRegistry = options.toolRegistry;
		this.pluginCommandRegistry = options.pluginCommandRegistry;
		this.providerRegistry = options.providerRegistry;
		this.searchRegistry = options.searchRegistry;
		this.providerConfigSource = options.providerConfigSource;
		this.providerPrefixSource = options.providerPrefixSource;
		this.providerConfigPruner = options.providerConfigPruner;
		this.agentToolBridge = options.agentToolBridge;
		this.manifestLoader = options.manifestLoader ?? defaultManifestLoader;
		this.defaultLifecycleStates = options.lifecycleStates;
		this.now = options.now ?? (() => new Date());
	}

	get revision(): number {
		return this.revisionValue;
	}

	get catalogSnapshot(): PluginCatalogSnapshot | undefined {
		return this.lastSnapshot ? clone(this.lastSnapshot) : undefined;
	}

	get packageGenerationMap(): Readonly<Record<string, string>> {
		return Object.fromEntries(this.generations);
	}

	generationFor(pluginId: string): string | undefined {
		return this.generations.get(pluginId);
	}

	async refreshCatalog(
		snapshot: PluginCatalogSnapshot,
		options: PluginContributionCoordinatorRefreshOptions = {},
	): Promise<PluginContributionCoordinatorReport> {
		return this.refresh(snapshot, options);
	}

	async initialize(
		snapshot: PluginCatalogSnapshot,
		options: PluginContributionCoordinatorRefreshOptions = {},
	): Promise<PluginContributionCoordinatorReport> {
		return this.refresh(snapshot, { ...options, reason: options.reason ?? "initialize" });
	}

	async install(
		snapshot: PluginCatalogSnapshot,
		options: PluginContributionCoordinatorRefreshOptions = {},
	): Promise<PluginContributionCoordinatorReport> {
		return this.refresh(snapshot, { ...options, reason: options.reason ?? "install" });
	}

	async enable(
		snapshot: PluginCatalogSnapshot,
		options: PluginContributionCoordinatorRefreshOptions = {},
	): Promise<PluginContributionCoordinatorReport> {
		return this.refresh(snapshot, { ...options, reason: options.reason ?? "enable" });
	}

	async activate(
		snapshot: PluginCatalogSnapshot,
		options: PluginContributionCoordinatorRefreshOptions = {},
	): Promise<PluginContributionCoordinatorReport> {
		return this.refresh(snapshot, { ...options, reason: options.reason ?? "activate" });
	}

	async disable(
		snapshot: PluginCatalogSnapshot,
		options: PluginContributionCoordinatorRefreshOptions = {},
	): Promise<PluginContributionCoordinatorReport> {
		return this.refresh(snapshot, { ...options, reason: options.reason ?? "disable" });
	}

	async uninstall(
		snapshot: PluginCatalogSnapshot,
		options: PluginContributionCoordinatorRefreshOptions = {},
	): Promise<PluginContributionCoordinatorReport> {
		return this.refresh(snapshot, { ...options, reason: options.reason ?? "uninstall" });
	}

	async refresh(
		snapshot: PluginCatalogSnapshot,
		options: PluginContributionCoordinatorRefreshOptions = {},
	): Promise<PluginContributionCoordinatorReport> {
		return this.mutex.acquire("plugin-contribution-registry", () =>
			this.refreshLocked(snapshot, options),
		);
	}

	private async refreshLocked(
		snapshot: PluginCatalogSnapshot,
		options: PluginContributionCoordinatorRefreshOptions,
	): Promise<PluginContributionCoordinatorReport> {
		const states = [
			...(await resolveStates(options.lifecycleStates ?? this.defaultLifecycleStates)),
		];
		const prepared = await this.prepare(snapshot);
		const nextGenerations = new Map<string, string>();
		for (const item of prepared) {
			if (item.generation) nextGenerations.set(item.plugin.pluginId, item.generation);
		}
		const nextFingerprint = JSON.stringify({
			packages: prepared
				.map((item) => [
					item.plugin.pluginId,
					item.plugin.status,
					item.generation ?? null,
					item.packageSummary?.status ?? null,
					item.plugin.diagnostics.map((diagnostic) => [
						diagnostic.code,
						diagnostic.message,
						diagnostic.path ?? null,
					]),
					item.packageSummary?.diagnostics.map((diagnostic) => [
						diagnostic.code,
						diagnostic.message,
						diagnostic.path ?? null,
					]) ?? null,
					item.manifestError ?? null,
				])
				.sort(([a], [b]) => String(a).localeCompare(String(b))),
			states: states
				.map((state) => [
					state.pluginId,
					state.desiredState ?? null,
					state.runtimeState ?? null,
					state.compatibility ?? null,
				])
				.sort(([a], [b]) => String(a).localeCompare(String(b))),
		});
		if (!options.force && nextFingerprint === this.fingerprint && this.lastSnapshot) {
			return this.report(false, false, states, options.reason);
		}

		const previousSnapshot = this.lastSnapshot;
		const previousStates = this.lastStates;
		const previousManifests = new Map(this.manifests);
		const previousGenerations = new Map(this.generations);
		const previousFingerprint = this.fingerprint;
		const previousRevision = this.revisionValue;
		const touchedPluginIds = new Set([
			...previousManifests.keys(),
			...prepared.map((item) => item.plugin.pluginId),
			...this.toolRegistry.list().map((descriptor) => descriptor.pluginId),
			...this.contributionRegistry.list().map((entry) => entry.pluginId),
		]);
		const diagnostics: string[] = [];

		try {
			// ContributionRegistry.refresh() replaces its complete map synchronously. All manifest
			// reads and schema preflight happen before this mutation, so malformed candidates cannot
			// leave a half-refreshed registry.
			this.contributionRegistry.refresh(snapshot);

			const nextManifests = new Map<string, Manifest>();
			for (const item of prepared) {
				if (item.manifest) nextManifests.set(item.plugin.pluginId, item.manifest);
				if (item.manifestError) diagnostics.push(item.manifestError);
			}

			for (const pluginId of touchedPluginIds) {
				const item = prepared.find((candidate) => candidate.plugin.pluginId === pluginId);
				const manifest = nextManifests.get(pluginId);
				const packageSummary = item?.packageSummary;
				if (!item) {
					this.toolRegistry.removePlugin(pluginId);
					this.providerRegistry?.removePlugin(pluginId);
					this.pluginCommandRegistry?.removePlugin(pluginId);
					this.searchRegistry?.unregisterPlugin(pluginId);
					continue;
				}
				if (!manifest || !sameManifestGeneration(manifest, packageSummary)) {
					this.markUnavailable(
						pluginId,
						item.manifestError ?? "Plugin contribution manifest is unavailable",
					);
					continue;
				}

				const generation = item.generation;
				const existing = this.toolRegistry.list(pluginId);
				const previousManifest = previousManifests.get(pluginId);
				const shouldReplace =
					generation !== previousGenerations.get(pluginId) ||
					existing.length !== manifest.contributes.tools.length ||
					!previousManifest ||
					JSON.stringify(previousManifest) !== JSON.stringify(manifest);
				if (shouldReplace) {
					this.toolRegistry.replaceManifest(manifest);
					// `registerManifest` replaces this plugin's commands wholesale, so a
					// contribution the new generation dropped cannot linger as a dispatchable id.
					this.pluginCommandRegistry?.registerManifest(manifest);
					this.replaceProviderManifest(pluginId, manifest, generation, diagnostics);
					this.replaceSearchManifest(pluginId, manifest);
				}
				const state = stateMap(states).get(pluginId);
				const unavailable = lifecycleUnavailableReason(state, packageSummary);
				if (unavailable) this.markUnavailable(pluginId, unavailable);
				else {
					this.contributionRegistry.markAvailable(pluginId);
					this.toolRegistry.enablePlugin(pluginId);
					this.providerRegistry?.enablePlugin(pluginId);
					this.searchRegistry?.setPluginEnabled(pluginId, true);
				}
			}

			// Prune only for plugins whose manifest parsed this pass, so an unavailable
			// manifest leaves stored config untouched rather than discarding it.
			for (const [pluginId, manifest] of nextManifests) {
				const keep = manifest.contributes.providers.map((provider) => provider.id);
				try {
					await this.providerConfigPruner?.(pluginId, keep);
				} catch (pruneError) {
					diagnostics.push(
						`Provider config prune failed for ${pluginId}: ${
							pruneError instanceof Error ? pruneError.message : String(pruneError)
						}`,
					);
				}
			}

			this.manifests = nextManifests;
			this.generations = nextGenerations;
			this.lastSnapshot = clone(snapshot);
			this.lastStates = states.map((state) => ({ ...state }));
			this.fingerprint = nextFingerprint;
			this.revisionValue += 1;
			this.agentToolBridge?.sync();
			return this.report(true, false, states, options.reason, diagnostics);
		} catch (error) {
			try {
				await this.restorePrevious(
					previousSnapshot,
					previousStates,
					previousManifests,
					previousGenerations,
					touchedPluginIds,
				);
			} catch (rollbackError) {
				diagnostics.push(
					`Registry rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
				);
			}
			this.fingerprint = previousFingerprint;
			this.revisionValue = previousRevision;
			throw new PluginContributionCoordinatorError(
				"REGISTRY_REFRESH_FAILED",
				`Plugin contribution refresh failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async prepare(snapshot: PluginCatalogSnapshot): Promise<PreparedPlugin[]> {
		const prepared: PreparedPlugin[] = [];
		for (const plugin of [...snapshot.plugins].sort((left, right) =>
			left.pluginId.localeCompare(right.pluginId),
		)) {
			const packageSummary = packageForPlugin(snapshot, plugin);
			const generation = generationFor(packageSummary);
			const item: PreparedPlugin = { plugin, packageSummary, generation };
			if (!packageSummary || packageSummary.status !== "compatible") {
				prepared.push(item);
				continue;
			}
			try {
				item.manifest = await this.manifestLoader(packageSummary);
			} catch (error) {
				item.manifestError = error instanceof Error ? error.message : String(error);
			}
			prepared.push(item);
		}
		return prepared;
	}

	private markUnavailable(pluginId: string, reason: string): void {
		const normalizedReason = reason.trim() || "Plugin contribution is unavailable";
		this.contributionRegistry.markUnavailable(pluginId, normalizedReason);
		this.toolRegistry.disablePlugin(pluginId, normalizedReason);
		this.providerRegistry?.disablePlugin(pluginId, normalizedReason);
		// Keep the registration but mark it unusable, so the channel stays in the user's
		// saved order and reappears when the plugin recovers.
		this.searchRegistry?.setPluginEnabled(pluginId, false);
	}

	/**
	 * Re-register this plugin's providers from the manifest.
	 *
	 * Mirrors `PluginToolRegistry.replaceManifest()`: drop the plugin's existing
	 * providers first so a renamed or removed contribution cannot linger, and so a
	 * changed prefix is free to be re-claimed. On failure the previously registered
	 * providers are restored, keeping the registry all-or-nothing for this plugin —
	 * the same invariant the surrounding refresh relies on.
	 */
	private replaceProviderManifest(
		pluginId: string,
		manifest: Manifest,
		generation: string | undefined,
		diagnostics: string[],
	): void {
		const registry = this.providerRegistry;
		if (!registry) return;
		// Persisted config is applied at registration so a restart does not silently
		// reset a provider the user configured.
		const configByProviderId = this.providerConfigSource?.(pluginId);
		const prefixByProviderId = this.providerPrefixSource?.(pluginId);
		const buildRegistrations = (usePrefixOverrides: boolean) =>
			providerRegistrationsFromManifest({
				manifest,
				generation,
				...(configByProviderId ? { configByProviderId } : {}),
				...(usePrefixOverrides && prefixByProviderId ? { prefixByProviderId } : {}),
			});

		const registrations = buildRegistrations(true);
		const hadEntries = registry.list().some((entry) => entry.pluginId === pluginId);
		if (registrations.length === 0 && !hadEntries) return;

		// Detach rather than remove: the snapshot keeps config and adapter factories that
		// the public entry shape does not expose, so a rollback restores working
		// providers instead of configless husks.
		const snapshot = registry.detachPlugin(pluginId);
		try {
			for (const registration of registrations) registry.register(registration);
			return;
		} catch (error) {
			registry.removePlugin(pluginId);
			// A stored prefix override can conflict with a provider this plugin does not own
			// — the other plugin may have been installed after the prefix was chosen. That is
			// persisted state, not a manifest defect, so failing here would let one stale
			// override abort the whole platform refresh. Retry with manifest prefixes so the
			// plugin still loads, and report the override as ignored.
			if (prefixByProviderId && Object.keys(prefixByProviderId).length > 0) {
				const reason = error instanceof Error ? error.message : String(error);
				try {
					const fallback = buildRegistrations(false);
					for (const registration of fallback) registry.register(registration);
					diagnostics.push(
						`Ignored provider prefix override for ${pluginId} and used the manifest prefix: ${reason}`,
					);
					return;
				} catch {
					// The manifest prefixes conflict too, so the override was not the cause.
					registry.removePlugin(pluginId);
				}
			}
			registry.restorePlugin(snapshot);
			throw error;
		}
	}

	/**
	 * Re-register this plugin's search contributions from the manifest.
	 *
	 * Simpler than the provider case: a search registration claims no prefix and builds no
	 * adapter, so there is nothing to conflict and nothing to roll back. Dropping the
	 * plugin's entries first is still required, so a contribution the new generation removed
	 * cannot linger as a dispatchable channel.
	 */
	private replaceSearchManifest(pluginId: string, manifest: Manifest): void {
		const registry = this.searchRegistry;
		if (!registry) return;
		registry.unregisterPlugin(pluginId);
		for (const contribution of manifest.contributes.searchProviders) {
			registry.register({
				pluginId,
				contributionId: contribution.id,
				title: contribution.title,
				providerId: contribution.providerId,
				...(contribution.description ? { description: contribution.description } : {}),
				...(contribution.requiresConfig ? { requiresConfig: contribution.requiresConfig } : {}),
				...(contribution.capabilities ? { capabilities: contribution.capabilities } : {}),
				...(contribution.limits ? { limits: contribution.limits } : {}),
			});
		}
	}

	private async restorePrevious(
		previousSnapshot: PluginCatalogSnapshot | undefined,
		previousStates: readonly PluginContributionLifecycleState[],
		previousManifests: Map<string, Manifest>,
		previousGenerations: Map<string, string>,
		touchedPluginIds: Set<string>,
	): Promise<void> {
		for (const pluginId of touchedPluginIds) {
			this.toolRegistry.removePlugin(pluginId);
			this.providerRegistry?.removePlugin(pluginId);
			this.pluginCommandRegistry?.removePlugin(pluginId);
			this.searchRegistry?.unregisterPlugin(pluginId);
		}
		for (const [pluginId, manifest] of previousManifests) {
			this.toolRegistry.replaceManifest(manifest);
			this.pluginCommandRegistry?.registerManifest(manifest);
			// Diagnostics collected during a rollback are discarded: the caller reports the
			// original failure, which is the one worth surfacing.
			this.replaceProviderManifest(pluginId, manifest, previousGenerations.get(pluginId), []);
			this.replaceSearchManifest(pluginId, manifest);
			const packageSummary = previousSnapshot
				? packageForPlugin(
						previousSnapshot,
						previousSnapshot.plugins.find((item) => item.pluginId === pluginId) ?? {
							pluginId,
							status: "missing",
							current: null,
							packages: [],
							contributions: [],
							diagnostics: [],
						},
					)
				: undefined;
			const unavailable = lifecycleUnavailableReason(
				stateMap(previousStates).get(pluginId),
				packageSummary,
			);
			if (unavailable) this.markUnavailable(pluginId, unavailable);
			else {
				this.contributionRegistry.markAvailable(pluginId);
				this.toolRegistry.enablePlugin(pluginId);
				this.providerRegistry?.enablePlugin(pluginId);
			}
		}
		this.contributionRegistry.refresh(previousSnapshot ?? emptySnapshot());
		this.manifests = new Map(previousManifests);
		this.generations = new Map(previousGenerations);
		this.lastSnapshot = previousSnapshot ? clone(previousSnapshot) : undefined;
		this.lastStates = previousStates.map((state) => ({ ...state }));
		this.agentToolBridge?.sync();
	}

	private report(
		changed: boolean,
		rolledBack: boolean,
		_states: readonly PluginContributionLifecycleState[],
		reason: string | undefined,
		diagnostics: readonly string[] = [],
	): PluginContributionCoordinatorReport {
		return {
			changed,
			rolledBack,
			revision: this.revisionValue,
			packageGenerations: Object.fromEntries(this.generations),
			contributionCount: this.contributionRegistry.list().length,
			toolCount: this.toolRegistry.list().length,
			providerCount:
				this.providerRegistry?.list().filter((entry) => entry.kind === "executable-plugin")
					.length ?? 0,
			agentToolCount: this.agentToolBridge?.listBindings().length ?? 0,
			diagnostics: [...diagnostics],
			...(reason ? { reason } : {}),
		};
	}
}
