import type { CredentialNetwork } from "@shared/credential-network";
import type { ToolResultImagesMode } from "@shared/tool-result-images";
import type { ResolvedNugModelMeta } from "../nug-model-cache";
import type { NUGProviderConfig, ProxyOverride } from "../settings";

export type NugInferenceConfig = NUGProviderConfig &
	Pick<CredentialNetwork, "userAgentMode" | "customUserAgent" | "extraHeaders">;

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
