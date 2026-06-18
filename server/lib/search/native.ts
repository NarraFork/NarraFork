import {
	getAnthropicProviderConfig,
	isAnthropicProvider,
	settings,
	usesCodexModel,
} from "../settings";
import type { NarraForkSettings } from "../settings/types";
import { getNormalizedSearchChannels, SEARCH_NATIVE_CHANNEL_ID } from "./settings";

export function isNativeSearchChannelFirstEnabled(config: NarraForkSettings = settings): boolean {
	const firstEnabled = getNormalizedSearchChannels(config).find((channel) => channel.enabled);
	return firstEnabled?.id === SEARCH_NATIVE_CHANNEL_ID;
}

export function isNativeSearchEnabled(config: NarraForkSettings = settings): boolean {
	return getNormalizedSearchChannels(config).some(
		(channel) => channel.id === SEARCH_NATIVE_CHANNEL_ID && channel.enabled,
	);
}

export function supportsNativeSearch(provider: string, model: string): boolean {
	if (usesCodexModel(provider, model)) return true;
	return isAnthropicProvider(provider) && !!getAnthropicProviderConfig(provider)?.officialApi;
}

export function shouldUseNativeSearch(provider: string, model: string): boolean {
	return isNativeSearchChannelFirstEnabled() && supportsNativeSearch(provider, model);
}
