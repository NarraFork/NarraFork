import type { ToolResultImagesMode } from "@shared/tool-result-images";
import type { ResolvedNugModelMeta } from "../nug-model-cache";
import type { NUGProviderConfig, ProxyOverride } from "../settings";

export interface NugDelegateBaseConfig {
	toolResultImages?: ToolResultImagesMode;
	id: string;
	name: string;
	prefix: string;
	apiKey: string;
	defaultModel: string;
	proxy?: ProxyOverride;
	extraHeaders: Record<string, string>;
}

/** Shared configuration inherited by every NUG protocol delegate. */
export function buildNugDelegateBaseConfig(
	config: NUGProviderConfig,
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
		extraHeaders,
	};
}
