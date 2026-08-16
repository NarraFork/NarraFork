/**
 * Registry of plugin-contributed web search sources.
 *
 * ## Why a separate registry from `plugin-provider-registry`
 *
 * A search source is not a provider: it has no model catalog, no prefix to claim, no adapter
 * to construct, and it is consumed by `lib/search/router.ts` rather than by the Agent loop.
 * Reusing the provider registry would have meant widening every provider entry with fields
 * that are meaningless for chat.
 *
 * What it *does* borrow from the provider side is config and credentials. A search
 * contribution declares `providerId`, and this registry resolves that provider's stored
 * config and vault secrets before every call, exactly the way `provider.chat` receives them.
 * The reason is recorded in `searchProviderContributionSchema`: the vault only recognises
 * `provider.<contributionId>.<field>` keys, and the writable-prefix check in
 * `plugin-command-secret-writes.ts` derives ownership from the provider registry.
 *
 * ## Availability is synchronous, on purpose
 *
 * `isUsable()` is called from `getNormalizedSearchChannels()`, which runs on every tool
 * execution and every provider request-body build. So it reads already-loaded state only:
 * lifecycle flags, the bound provider's registry entry, and whether the config fields the
 * manifest listed in `requiresConfig` are populated. It never activates a plugin and never
 * makes an RPC call.
 *
 * It follows that availability cannot mean "the credential works". An invalid credential
 * yields a channel that looks usable and fails when dispatched, after which the router falls
 * through to the next channel. Built-in `custom-api` channels behave identically.
 *
 * ## Authorization
 *
 * `execute()` does not consult the capability broker. This matches the provider execution
 * path, which does not authorize either: `search.provide` exists in the taxonomy as a
 * declaration, not as a runtime gate. See `docs/plugin-system/11-capability-policy.md`.
 */

import { logger } from "@server/lib/logger";
import type { JsonValue } from "@server/lib/plugins/protocol";
import { pluginSearchChannelId } from "@server/lib/search/settings";
import type { SearchChannelResult, SearchRequest } from "@server/lib/search/types";
import type { ProviderHostHintsContext } from "./plugin-provider-adapter-factory";
import { providerSecretKey } from "./plugin-provider-config-service";
import type { PluginProviderRegistry } from "./plugin-provider-registry";
import type { ProviderHostHints, ProviderSearchResult } from "./plugin-provider-rpc";

/** Manifest declaration for one search contribution, plus the plugin that owns it. */
export interface SearchProviderRegistration {
	pluginId: string;
	contributionId: string;
	title: string;
	description?: string;
	/** Provider contribution supplying config and credentials. */
	providerId: string;
	requiresConfig?: string[];
	capabilities?: {
		domainFilter?: boolean;
		recency?: boolean;
		maxResults?: boolean;
		purpose?: boolean;
	};
	limits?: { timeoutMs?: number; maxOutputBytes?: number };
	/** False while the plugin is disabled or its runtime is unavailable. */
	enabled?: boolean;
}

export interface SearchProviderEntry extends SearchProviderRegistration {
	/** Channel id the search layer uses. Derived, never supplied by the plugin. */
	channelId: string;
	enabled: boolean;
}

/** The RPC surface this registry needs. Narrowed so tests can supply a stub. */
export interface SearchRpcClientLike {
	search(
		params: {
			providerTypeId: string;
			providerInstanceId: string;
			config: Record<string, JsonValue>;
			contributionId: string;
			query: string;
			purpose?: string;
			allowedDomains?: string[];
			blockedDomains?: string[];
			recencyDays?: number;
			maxResults?: number;
			locale?: string;
			timeoutMs?: number;
			maxOutputBytes?: number;
			hostHints?: ProviderHostHints;
		},
		signal?: AbortSignal,
	): Promise<ProviderSearchResult>;
}

export interface SearchCredentialResolverLike {
	resolve(providerInstanceId: string): Promise<Record<string, JsonValue>>;
}

/**
 * Synchronous view of which secret keys a plugin has stored.
 *
 * A secret never appears in stored provider config — the config service reports it through an
 * async `hasSecret` lookup — but availability has to be decided synchronously (see the module
 * header). `PluginSecretVault.peekKeys` serves this from the already-loaded document and
 * returns `undefined` when the vault has not been read yet.
 */
export interface SearchSecretPeekLike {
	peekKeys(pluginId: string): string[] | undefined;
}

export interface PluginSearchRegistryOptions {
	/** Used to locate the bound provider instance and read its stored config. */
	providerRegistry: Pick<PluginProviderRegistry, "list" | "getConfig">;
	/** Resolves the bound provider's config with vault secrets merged in. */
	credentialResolver?: SearchCredentialResolverLike;
	/** Synchronous secret-presence source for `isUsable`. Omit to consider secrets absent. */
	secretPeek?: SearchSecretPeekLike;
	/** Yields an activated RPC client for the bound provider instance. */
	resolveClient: (input: {
		pluginId: string;
		providerTypeId: string;
		providerInstanceId: string;
	}) => Promise<SearchRpcClientLike>;
	/**
	 * Resolve host-provided hints (proxy URL, concurrency budget) for search requests.
	 * Uses the same resolver as the adapter factory so all plugin paths share one policy,
	 * including the per-provider proxy override.
	 */
	resolveHostHints?: (context: ProviderHostHintsContext) => ProviderHostHints | undefined;
}

export class PluginSearchRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PluginSearchRegistryError";
	}
}

export class PluginSearchRegistry {
	private readonly entries = new Map<string, SearchProviderEntry>();
	private readonly options: PluginSearchRegistryOptions;

	constructor(options: PluginSearchRegistryOptions) {
		this.options = options;
	}

	register(registration: SearchProviderRegistration): SearchProviderEntry {
		const channelId = pluginSearchChannelId(registration.pluginId, registration.contributionId);
		const entry: SearchProviderEntry = {
			...registration,
			channelId,
			enabled: registration.enabled !== false,
		};
		this.entries.set(channelId, entry);
		return entry;
	}

	/** Remove every contribution belonging to a plugin. Returns how many were dropped. */
	unregisterPlugin(pluginId: string): number {
		let removed = 0;
		for (const [channelId, entry] of [...this.entries.entries()]) {
			if (entry.pluginId !== pluginId) continue;
			this.entries.delete(channelId);
			removed += 1;
		}
		return removed;
	}

	/** Flip the lifecycle flag without dropping the registration. */
	setPluginEnabled(pluginId: string, enabled: boolean): void {
		for (const entry of this.entries.values()) {
			if (entry.pluginId === pluginId) entry.enabled = enabled;
		}
	}

	list(): SearchProviderEntry[] {
		return [...this.entries.values()].sort((left, right) =>
			left.channelId.localeCompare(right.channelId),
		);
	}

	get(channelId: string): SearchProviderEntry | undefined {
		return this.entries.get(channelId);
	}

	clear(): void {
		this.entries.clear();
	}

	/**
	 * Synchronous availability check. See the module header for why it cannot do more.
	 */
	isUsable(entry: SearchProviderEntry): boolean {
		if (!entry.enabled) return false;
		const provider = this.findProviderInstance(entry);
		if (!provider) return false;
		if (provider.disabled || provider.status === "unavailable") return false;
		if (!entry.requiresConfig?.length) return true;
		let config: Record<string, JsonValue>;
		try {
			config = this.options.providerRegistry.getConfig(provider.providerInstanceId);
		} catch {
			return false;
		}
		// A required field is satisfied either by a plain config value or by a stored secret.
		// Secrets are absent from stored config by design, so they are checked against the
		// vault's in-memory key list — see `SearchSecretPeekLike`.
		const secretKeys = this.options.secretPeek?.peekKeys(entry.pluginId);
		return entry.requiresConfig.every((field) => {
			const plain = config[field];
			if (typeof plain === "string" ? plain.length > 0 : plain !== undefined && plain !== null) {
				return true;
			}
			return secretKeys?.includes(providerSecretKey(provider.localId, field)) === true;
		});
	}

	/** Label shown in the search settings UI. */
	labelFor(entry: SearchProviderEntry): string {
		return entry.title || entry.contributionId;
	}

	/**
	 * Run a search. Resolves the bound provider's credentials, then makes one unary RPC call.
	 */
	async execute(
		channelId: string,
		request: SearchRequest,
		signal: AbortSignal,
	): Promise<SearchChannelResult> {
		const entry = this.entries.get(channelId);
		if (!entry) {
			throw new PluginSearchRegistryError(`Unknown plugin search channel: ${channelId}`);
		}
		if (!entry.enabled) {
			throw new PluginSearchRegistryError(`Plugin search channel is disabled: ${channelId}`);
		}
		const provider = this.findProviderInstance(entry);
		if (!provider) {
			throw new PluginSearchRegistryError(
				`Search channel ${channelId} is bound to provider ${entry.providerId}, which is not registered`,
			);
		}
		const config = this.options.credentialResolver
			? await this.options.credentialResolver.resolve(provider.providerInstanceId)
			: this.options.providerRegistry.getConfig(provider.providerInstanceId);

		const client = await this.options.resolveClient({
			pluginId: entry.pluginId,
			providerTypeId: provider.providerTypeId,
			providerInstanceId: provider.providerInstanceId,
		});
		// A search source authenticates as its bound provider, so it must also route through
		// that provider's proxy — otherwise search would bypass a policy chat obeys.
		const hostHints = this.options.resolveHostHints?.({
			pluginId: entry.pluginId,
			providerInstanceId: provider.providerInstanceId,
		});
		const result = await client.search(
			{
				providerTypeId: provider.providerTypeId,
				providerInstanceId: provider.providerInstanceId,
				config,
				contributionId: entry.contributionId,
				query: request.query,
				...(request.purpose ? { purpose: request.purpose } : {}),
				...(request.allowedDomains?.length ? { allowedDomains: request.allowedDomains } : {}),
				...(request.blockedDomains?.length ? { blockedDomains: request.blockedDomains } : {}),
				...(request.recencyDays != null ? { recencyDays: request.recencyDays } : {}),
				...(request.maxResults != null ? { maxResults: request.maxResults } : {}),
				...(request.locale ? { locale: request.locale } : {}),
				...(entry.limits?.timeoutMs != null ? { timeoutMs: entry.limits.timeoutMs } : {}),
				...(entry.limits?.maxOutputBytes != null
					? { maxOutputBytes: entry.limits.maxOutputBytes }
					: {}),
				...(hostHints ? { hostHints } : {}),
			},
			signal,
		);
		logger.debug("Plugin search channel returned", {
			channelId,
			hasText: !!result.text,
			resultCount: result.results?.length ?? 0,
		});
		return {
			channelId,
			channelLabel: this.labelFor(entry),
			...(result.text ? { text: result.text } : { text: "" }),
			...(result.results?.length ? { results: result.results } : {}),
		};
	}

	/**
	 * The registered provider instance backing this search contribution.
	 *
	 * Matched on `pluginId` + the provider's local contribution id, because
	 * `providerInstanceId` carries a package generation that changes across upgrades and is
	 * not something a manifest can name.
	 */
	private findProviderInstance(entry: SearchProviderEntry) {
		return this.options.providerRegistry
			.list()
			.find(
				(candidate) =>
					candidate.pluginId === entry.pluginId && candidate.localId === entry.providerId,
			);
	}
}
