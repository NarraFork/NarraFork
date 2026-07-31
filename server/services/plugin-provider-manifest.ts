/**
 * Translates manifest provider contributions into provider-registry registrations.
 *
 * This is the bridge that was missing: manifests declared `contributes.providers`
 * and the registry knew how to hold providers, but nothing converted between them,
 * so `pluginProviderRegistry.register()` was never called outside tests and plugin
 * providers were unreachable.
 *
 * Everything here is derived from static manifest data only. That is deliberate:
 * the host must be able to register a provider (and list it in the model picker)
 * without starting the plugin process. `provider.describe` may later refine the
 * catalog and capabilities over RPC, but it is not required for registration.
 */

import { getContributionFullId, type Manifest } from "@server/lib/plugins/manifest";
import type { JsonValue } from "@server/lib/plugins/protocol";
import type {
	ProviderRegistryRegistration,
	ProviderTypeCapabilities,
	ProviderTypeLimits,
} from "./plugin-provider-registry";

/** A single manifest provider contribution, as parsed by the manifest schema. */
type ManifestProvider = Manifest["contributes"]["providers"][number];

export interface ProviderRegistrationInput {
	manifest: Manifest;
	/**
	 * Package generation (`version:hash`) the registration belongs to. Recorded on
	 * the instance ID so a re-installed package produces a distinct instance rather
	 * than silently reusing state from the previous generation.
	 */
	generation?: string;
	/** Lifecycle state forwarded to the registry's availability calculation. */
	pluginState?: ProviderRegistryRegistration["pluginState"];
	/** Reason the provider should be registered but reported unavailable. */
	unavailableReason?: string;
	/** Per-provider config previously persisted by the host, keyed by contribution id. */
	configByProviderId?: Readonly<Record<string, Record<string, JsonValue>>>;
	/**
	 * Admin prefix overrides keyed by contribution id.
	 *
	 * The manifest prefix is a suggestion; the prefix is a globally unique namespace key,
	 * so an admin must be able to move a plugin out of the way of a conflict.
	 */
	prefixByProviderId?: Readonly<Record<string, string>>;
	/** Adapter factory used lazily by `entry.createAdapter()`. */
	adapterFactory?: ProviderRegistryRegistration["adapterFactory"];
}

/**
 * Stable instance identity for a manifest-declared provider.
 *
 * Shaped as `<pluginId>/<contributionId>` plus the package generation. The
 * generation suffix means an upgrade registers a fresh instance instead of
 * inheriting the previous one's cached catalog.
 */
export function providerInstanceIdFor(
	pluginId: string,
	contributionId: string,
	generation?: string,
): string {
	const base = getContributionFullId(pluginId, contributionId);
	return generation ? `${base}@${generation}` : base;
}

/**
 * The user-facing prefix for a provider contribution.
 *
 * `providerPrefix` is optional in the manifest; the contribution id is a sound
 * fallback because it is already unique within the plugin and constrained to
 * characters the registry accepts. The host still validates the result against
 * reserved and already-claimed prefixes at registration time.
 */
export function providerPrefixFor(provider: ManifestProvider): string {
	return provider.providerPrefix ?? provider.id;
}

function capabilitiesFor(provider: ManifestProvider): Partial<ProviderTypeCapabilities> {
	// Only forward what the manifest actually declared; the registry applies its own
	// defaults for anything omitted, so passing explicit `undefined` would be wrong.
	const declared = provider.capabilities ?? {};
	const result: Partial<ProviderTypeCapabilities> = {};
	if (declared.validateConfig !== undefined) result.validateConfig = declared.validateConfig;
	if (declared.listModels !== undefined) result.listModels = declared.listModels;
	if (declared.chat !== undefined) result.chat = declared.chat;
	if (declared.generate !== undefined) result.generate = declared.generate;
	if (declared.reasoningContinuation !== undefined) {
		result.reasoningContinuation = declared.reasoningContinuation;
	}
	if (declared.inputImages !== undefined) result.inputImages = declared.inputImages;
	if (declared.mayLeakXmlToolCalls !== undefined) {
		result.mayLeakXmlToolCalls = declared.mayLeakXmlToolCalls;
	}
	return result;
}

function limitsFor(provider: ManifestProvider): ProviderTypeLimits | undefined {
	const declared = provider.limits;
	// `maxConcurrency` is the older, coarser manifest field; treat it as the chat
	// ceiling when the finer-grained `limits` block does not override it.
	const maxConcurrentChat = declared?.maxConcurrentChat ?? provider.maxConcurrency;
	const result: ProviderTypeLimits = {};
	if (maxConcurrentChat !== undefined) result.maxConcurrentChat = maxConcurrentChat;
	if (declared?.maxConcurrentGenerate !== undefined) {
		result.maxConcurrentGenerate = declared.maxConcurrentGenerate;
	}
	if (declared?.maxConfigBytes !== undefined) result.maxConfigBytes = declared.maxConfigBytes;
	if (declared?.maxModelPageSize !== undefined) {
		result.maxModelPageSize = declared.maxModelPageSize;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * A manifest `configSchema` is the *properties* map, not a whole JSON Schema
 * document, so wrap it into the object schema the registry validates against.
 * `additionalProperties: false` keeps unknown config keys from silently passing.
 */
function configSchemaFor(provider: ManifestProvider): Record<string, JsonValue> | undefined {
	if (!provider.configSchema) return undefined;
	return {
		type: "object",
		properties: provider.configSchema as Record<string, JsonValue>,
		additionalProperties: false,
	};
}

/** Build the registry registrations for every provider a manifest contributes. */
export function providerRegistrationsFromManifest(
	input: ProviderRegistrationInput,
): ProviderRegistryRegistration[] {
	const { manifest } = input;
	return manifest.contributes.providers.map((provider) => {
		const capabilities = capabilitiesFor(provider);
		const limits = limitsFor(provider);
		const configSchema = configSchemaFor(provider);
		const config = input.configByProviderId?.[provider.id];
		const prefixOverride = input.prefixByProviderId?.[provider.id];
		return {
			kind: "executable-plugin" as const,
			pluginId: manifest.pluginId,
			localId: provider.id,
			providerInstanceId: providerInstanceIdFor(manifest.pluginId, provider.id, input.generation),
			providerPrefix: prefixOverride ?? providerPrefixFor(provider),
			displayName: provider.title ?? provider.id,
			...(provider.description ? { description: provider.description } : {}),
			...(provider.defaultModelId ? { defaultModelId: provider.defaultModelId } : {}),
			...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
			...(limits ? { limits } : {}),
			...(configSchema ? { configSchema } : {}),
			...(config ? { config } : {}),
			...(input.pluginState ? { pluginState: input.pluginState } : {}),
			...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
			...(input.adapterFactory ? { adapterFactory: input.adapterFactory } : {}),
		};
	});
}
