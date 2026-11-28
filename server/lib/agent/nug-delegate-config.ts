import type { CredentialNetwork } from "@shared/credential-network";
import type { ToolResultImagesMode } from "@shared/tool-result-images";
import { type ResolvedNugModelMeta, resolveNugModelMeta } from "../nug-model-cache";
import { getNugRelayChannelIdForCredential, usesLocalEgress } from "../nug-relay/manager";
import type { NUGProviderConfig, ProxyOverride } from "../settings";
import { resolveModelProtocol } from "../settings/provider";

export type NugInferenceConfig = NUGProviderConfig &
	Pick<CredentialNetwork, "userAgentMode" | "customUserAgent" | "extraHeaders">;

/** Shared Auto/pool candidate check; never starts a relay, reads a file, or guesses a channel. */
export function isNugRelayEligible(config: NUGProviderConfig, model?: string): boolean {
	if (!model || !usesLocalEgress(config) || config.egressAllowDirectFallback === true) return true;
	// Explicit protocol switching builds a non-NUG delegate, so it does not use the Codex relay.
	if (resolveModelProtocol(config.prefix, model)) return true;
	let meta: ResolvedNugModelMeta;
	try {
		meta = resolveNugModelMeta(config.id, config.prefix, model);
	} catch {
		// Missing catalog metadata still fails in the adapter's existing model resolver.
		return true;
	}
	return meta.channelType !== "codex" || !!getNugRelayChannelIdForCredential(config);
}

export interface NugDelegateBaseConfig {
	toolResultImages?: ToolResultImagesMode;
	id: string;
	name: string;
	prefix: string;
	apiKey: string;
	defaultModel: string;
	proxy?: ProxyOverride;
	userAgentMode?: CredentialNetwork["userAgentMode"];
	customUserAgent?: string;
	extraHeaders: Record<string, string>;
}

/** Shared configuration inherited by every NUG protocol delegate. */
export function buildNugDelegateBaseConfig(
	config: NugInferenceConfig,
	meta: ResolvedNugModelMeta,
	extraHeaders: Record<string, string>,
): NugDelegateBaseConfig {
	return {
		toolResultImages: config.toolResultImages,
		id: config.id,
		name: config.name,
		prefix: config.prefix,
		apiKey: config.apiKey,
		defaultModel: meta.routedModel,
		proxy: config.proxy,
		userAgentMode: config.userAgentMode,
		customUserAgent: config.customUserAgent,
		extraHeaders: { ...config.extraHeaders, ...extraHeaders },
	};
}
