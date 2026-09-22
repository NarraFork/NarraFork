import {
	getAnthropicProviderConfig,
	getOpenaiProviderConfig,
	isAnthropicProvider,
	settings,
	usesCodexModel,
} from "../settings";
import { getEffectiveModelMetadata } from "../model-catalog";
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

/**
 * Inline native search: the provider declares its own server-side search tool in
 * the main conversation request and the function-style `WebSearch` tool is hidden
 * from the model.
 *
 * Only Codex/Responses works this way. Its prompt caching is automatic prefix
 * caching computed upstream — the request carries no cache directives — so adding
 * a tool cannot cause cache *directives* to be dropped. Changing the tool list
 * still changes the prefix hash, but that is a one-time miss when the setting is
 * toggled, not a permanent regression.
 */
export function usesInlineNativeSearch(provider: string, model: string): boolean {
	if (provider === "codex" && settings.codex?.useWebSearch === false) return false;
	if (getOpenaiProviderConfig(provider)?.codexWebSearch === false) return false;
	return (
		getEffectiveModelMetadata(model.startsWith(`${provider}:`) ? model : `${provider}:${model}`)
			.metadata.nativeSearch?.supported !== false && usesCodexModel(provider, model)
	);
}

/**
 * Side-request native search: the server-side tool is declared ONLY in a separate
 * minimal request, and the main conversation keeps the ordinary `WebSearch`
 * function tool as the entry point.
 *
 * This is the only shape Anthropic's own client uses. The Claude CLI's WebSearch
 * tool builds a one-shot request with no function tools, a forced
 * `tool_choice: {type:"tool", name:"web_search"}` on `web_search_20250305`, and
 * prompt caching disabled, then flattens the results into a text tool_result.
 * Nothing ever declares a server tool in the main conversation.
 *
 * That property is what protects the cache: Anthropic caching is driven by
 * explicit client-side `cache_control` breakpoints, and `tools` sits at the very
 * front of the cached prefix, so a server tool in the main request both shifts
 * the prefix hash and hands the turn to an upstream search-orchestration path
 * that was measured dropping the cache markers entirely.
 *
 * Enabled by default for `officialApi` ("speaks the Claude Code request
 * format") providers, with a per-provider `nativeSearch: false` opt-out:
 * endpoints that present the official protocol overwhelmingly proxy the real
 * API surface including `web_search_20250305`, and a relay that doesn't serve
 * it fails the side request cleanly — the router then falls through to the
 * next configured channel. Non-official providers never qualify.
 */
export function usesSideRequestNativeSearch(provider: string, model?: string): boolean {
	if (
		model &&
		getEffectiveModelMetadata(model.startsWith(`${provider}:`) ? model : `${provider}:${model}`)
			.metadata.nativeSearch?.supported === false
	)
		return false;
	if (!isAnthropicProvider(provider)) return false;
	const config = getAnthropicProviderConfig(provider);
	return !!config?.officialApi && config.nativeSearch !== false;
}

/**
 * Whether any enabled Anthropic provider serves side-request search (officialApi
 * without the explicit `nativeSearch: false` opt-out).
 *
 * Used for tool-availability checks that have no narrator context. The exact
 * provider is still verified per request, and a mismatch simply falls through
 * to the next configured channel.
 */
export function hasSideRequestNativeSearchProvider(config: NarraForkSettings = settings): boolean {
	return (config.anthropicProviders ?? []).some(
		(provider) => !provider.disabled && !!provider.officialApi && provider.nativeSearch !== false,
	);
}

/** Whether this provider/model can perform provider-side web search at all. */
export function supportsNativeSearch(provider: string, model: string): boolean {
	return usesInlineNativeSearch(provider, model) || usesSideRequestNativeSearch(provider, model);
}

/**
 * Whether the model should see the provider's own search tool INSTEAD of the
 * function-style `WebSearch` tool.
 *
 * Deliberately narrower than {@link supportsNativeSearch}: side-request providers
 * must keep `WebSearch` visible, because that tool is what triggers the side
 * request.
 */
export function shouldUseNativeSearch(provider: string, model: string): boolean {
	return isNativeSearchChannelFirstEnabled() && usesInlineNativeSearch(provider, model);
}
