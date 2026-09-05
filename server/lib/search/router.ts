
import { logger } from "../logger";
import {
	getAnthropicProviderConfig,
	resolveEffectiveModel,
	resolveProvider,
	settings,
} from "../settings";
import type {
	CustomSearchProviderConfig,
	NarraForkSettings,
	NUGProviderConfig,
	SearchChannelConfig,
} from "../settings/types";
import { executeCustomSearchProvider, isCustomSearchProviderUsable } from "./adapters/index";
import {
	hasSideRequestNativeSearchProvider,
	supportsNativeSearch,
	usesSideRequestNativeSearch,
} from "./native";
import { executeExtraSearchChannel, findExtraSearchChannel } from "./plugin-source";
import {
	DEFAULT_SEARCH_MAX_OUTPUT_CHARS,
	DEFAULT_SEARCH_TIMEOUT_MS,
	getNormalizedSearchChannels,
} from "./settings";
import { isAbortError, withSearchTimeout } from "./timeout";
import type { SearchChannelResult, SearchExecutionResult, SearchRequest } from "./types";

/**
 * JSON-RPC shape an MCP `tools/call` reply takes.
 *
 * Declared locally rather than imported: the only remaining MCP search channel
 * speaks to the NUG gateway over plain HTTP, so there is no client library to
 * borrow the type from.
 */
interface McpResponse {
	error?: { message?: string };
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
}

function textFromMcpResponse(response: McpResponse): { text: string; isError?: boolean } {
	if (response.error) {
		return { text: `Search error: ${response.error.message ?? "Unknown error"}`, isError: true };
	}
	const text =
		response.result?.content
			?.filter((content) => content.type === "text" && content.text)
			.map((content) => content.text)
			.join("\n\n") ?? "";
	return { text: text || "No results found", isError: response.result?.isError };
}

function truncateSearchOutput(text: string, config: NarraForkSettings = settings): string {
	const max = config.search?.maxOutputChars ?? DEFAULT_SEARCH_MAX_OUTPUT_CHARS;
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[Search output truncated at ${max} characters]`;
}

function channelLabel(channel: SearchChannelConfig, config: NarraForkSettings = settings): string {
	switch (channel.kind) {
		case "native":
			return "Model native search";
		case "nug-mcp":
			return `NUG: ${findNugProvider(channel, config)?.name ?? channel.providerId ?? channel.id}`;
		case "custom-api":
			return `Custom: ${findCustomProvider(channel, config)?.name ?? channel.providerId ?? channel.id}`;
		case "subagent":
			return "Search subagent";
		case "plugin":
			// The owning source resolves the plugin and contribution titles; the settings
			// object knows nothing about plugin contributions.
			return findExtraSearchChannel(channel.id)?.label ?? channel.id;
	}
}

function findNugProvider(
	channel: SearchChannelConfig,
	config: NarraForkSettings = settings,
): NUGProviderConfig | undefined {
	return (config.nugProviders ?? []).find((provider) => provider.id === channel.providerId);
}

function findCustomProvider(
	channel: SearchChannelConfig,
	config: NarraForkSettings = settings,
): CustomSearchProviderConfig | undefined {
	return (config.search?.customProviders ?? []).find(
		(provider) => provider.id === channel.providerId,
	);
}

async function nugMcpSearch(
	channel: SearchChannelConfig,
	request: SearchRequest,
	signal: AbortSignal,
): Promise<SearchChannelResult> {
	const config = findNugProvider(channel);
	if (!config || config.disabled || !config.apiKey || !config.baseUrl) {
		throw new Error("NUG provider is not configured or is disabled");
	}
	const baseUrl = config.baseUrl.replace(/\/+$/, "");
	const response = await fetch(`${baseUrl}/v1/mcp/search`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.apiKey}`,
		},
		body: JSON.stringify({ query: request.query }),
		signal,
	});
	if (!response.ok) {
		const errText = await response.text().catch(() => "");
		throw new Error(`NUG MCP search error ${response.status}: ${errText}`);
	}
	const mcp = (await response.json()) as McpResponse;
	const parsed = textFromMcpResponse(mcp);
	return { channelId: channel.id, channelLabel: channelLabel(channel), text: parsed.text };
}

/**
 * Whether this channel could serve a search request at all.
 *
 * A PREDICATE, so it must never throw: it is reached from `WebSearch.isAvailable()`
 * while the agent loop builds its tool list, and a throw there fails the whole turn
 * rather than hiding one channel. `resolveEffectiveModel` throws when the channel
 * follows the (deliberately unset-able) instance default model — a fresh install
 * with this channel already enabled — and "no model to resolve" is precisely the
 * definition of an unusable channel, so it is answered as false here instead of
 * being propagated. Mirrors `resolveMetaModelForLookup`, which returns its sentinel
 * unchanged for the same reason.
 */
function isSubagentChannelUsable(channel: SearchChannelConfig): boolean {
	if (!channel.model) return false;
	let model: string;
	try {
		model = resolveEffectiveModel(channel.model);
	} catch {
		return false;
	}
	const provider = resolveProvider(model);
	return supportsNativeSearch(provider, model);
}

async function searchSubagent(
	channel: SearchChannelConfig,
	request: SearchRequest,
): Promise<SearchChannelResult> {
	if (!request.purpose) {
		throw new Error("Search subagent requires a purpose");
	}
	if (!isSubagentChannelUsable(channel)) {
		throw new Error("Search subagent model is not configured or does not support native search");
	}
	if (!request.parentNarratorId || !request.parentToolUseId || !request.cwd) {
		throw new Error("Search subagent requires narrator context");
	}
	const { runSubagent } = await import("../../services/subagent-runner");
	const prompt = [
		`Search query: ${request.query}`,
		`Purpose: ${request.purpose}`,
		request.allowedDomains?.length ? `Allowed domains: ${request.allowedDomains.join(", ")}` : null,
		request.blockedDomains?.length ? `Blocked domains: ${request.blockedDomains.join(", ")}` : null,
		request.recencyDays != null
			? `Prefer results from the last ${request.recencyDays} days.`
			: null,
		request.maxResults != null ? `Return at most ${request.maxResults} key results.` : null,
		"Return a concise answer with sources as markdown links when available.",
	]
		.filter(Boolean)
		.join("\n");
	const text = await runSubagent({
		parentNarratorId: request.parentNarratorId,
		toolUseId: request.parentToolUseId,
		subagentType: "search",
		prompt,
		cwd: request.cwd,
		title: `Search: ${request.query.slice(0, 60)}`,
		signal: request.signal ?? new AbortController().signal,
		locale: request.locale ?? "en",
		model: channel.model,
		reasoningEffort: channel.reasoningEffort,
		background: false,
		userId: request.userId ?? null,
	});
	return { channelId: channel.id, channelLabel: channelLabel(channel), text };
}

/**
 * Native side-request search: run the CLI-style one-shot `web_search_20250305`
 * request against the requesting session's own Anthropic provider. The main
 * conversation request never declares the server tool, so prompt caching is
 * unaffected (see `usesSideRequestNativeSearch`).
 */
async function nativeSideRequestSearch(
	channel: SearchChannelConfig,
	request: SearchRequest,
	signal: AbortSignal,
): Promise<SearchChannelResult> {
	const provider = request.provider;
	if (!provider || !usesSideRequestNativeSearch(provider)) {
		throw new Error("Current provider does not support native server-side search");
	}
	const config = getAnthropicProviderConfig(provider);
	if (!config) throw new Error(`Anthropic provider "${provider}" is not configured`);
	// Lazy import mirrors searchSubagent: keeps the search router free of a
	// static dependency on the agent layer.
	const { AnthropicProvider } = await import("../agent/anthropic-provider");
	const adapter = new AnthropicProvider(config);
	const result = await adapter.performWebSearch({
		model: request.model || config.defaultModel,
		query: request.query,
		allowedDomains: request.allowedDomains,
		blockedDomains: request.blockedDomains,
		signal,
	});
	let text = result.text || "No results found";
	if (result.sources.length > 0) {
		const links = result.sources
			.map((source) => `- ${source.title ? `${source.title}: ` : ""}${source.url ?? ""}`.trim())
			.filter((line) => line !== "-");
		if (links.length > 0) text += `\n\nLinks:\n${links.join("\n")}`;
	}
	return {
		channelId: channel.id,
		channelLabel: channelLabel(channel),
		text,
		sources: result.sources,
	};
}

function channelTimeout(channel: SearchChannelConfig): number {
	let declaredTimeout: number | undefined;
	if (channel.kind === "custom-api") declaredTimeout = findCustomProvider(channel)?.timeoutMs;
	// A plugin declares its timeout in the manifest rather than in host settings.
	else if (channel.kind === "plugin")
		declaredTimeout = findExtraSearchChannel(channel.id)?.timeoutMs;
	return (
		channel.timeoutMs ??
		declaredTimeout ??
		settings.search?.defaultTimeoutMs ??
		DEFAULT_SEARCH_TIMEOUT_MS
	);
}

async function runChannel(
	channel: SearchChannelConfig,
	request: SearchRequest,
): Promise<SearchChannelResult> {
	switch (channel.kind) {
		case "nug-mcp":
			return withSearchTimeout(
				request.signal,
				(signal) => nugMcpSearch(channel, request, signal),
				channelTimeout(channel),
			);
		case "custom-api": {
			const provider = findCustomProvider(channel);
			if (!provider) throw new Error("Custom search provider is not configured");
			return withSearchTimeout(
				request.signal,
				(signal) =>
					executeCustomSearchProvider({
						channel,
						channelLabel: channelLabel(channel),
						provider,
						request,
						signal,
					}),
				channelTimeout(channel),
			);
		}
		case "plugin":
			return withSearchTimeout(
				request.signal,
				async (signal) => {
					const result = await executeExtraSearchChannel(channel.id, request, signal);
					// The source returns the channel id it was given; keep the router's own
					// label so a stale registry entry cannot relabel the attempt record.
					return { ...result, channelId: channel.id, channelLabel: channelLabel(channel) };
				},
				channelTimeout(channel),
			);
		case "subagent":
			return searchSubagent(channel, request);
		case "native":
			return withSearchTimeout(
				request.signal,
				(signal) => nativeSideRequestSearch(channel, request, signal),
				channelTimeout(channel),
			);
	}
}

function isPotentiallyUsableFunctionChannel(channel: SearchChannelConfig): boolean {
	if (!channel.enabled) return false;
	switch (channel.kind) {
		case "nug-mcp": {
			const provider = findNugProvider(channel);
			return !!provider && !provider.disabled && !!provider.apiKey && !!provider.baseUrl;
		}
		case "custom-api": {
			const provider = findCustomProvider(channel);
			return isCustomSearchProviderUsable(provider);
		}
		case "plugin":
			// Synchronous registry read: the source already computed availability from the
			// plugin's lifecycle state and stored config.
			return findExtraSearchChannel(channel.id)?.available === true;
		case "subagent":
			return isSubagentChannelUsable(channel);
		case "native":
			// Side-request search keeps the WebSearch function tool as its entry
			// point. Whether the *current* session's provider actually opted in is
			// verified per request in executeSearch; here we only need "any
			// provider could serve this".
			return hasSideRequestNativeSearchProvider();
	}
}

export function hasUsableFunctionSearchChannel(): boolean {
	return getNormalizedSearchChannels(settings).some(isPotentiallyUsableFunctionChannel);
}

/**
 * Session-scoped variant of {@link hasUsableFunctionSearchChannel}: the native
 * channel only counts when the *requesting* session's provider can actually
 * serve the side request. Used by the agent loop to hide the WebSearch tool
 * from sessions for which every enabled channel would deterministically fail
 * (e.g. native-only channel list while the session runs on a provider without
 * the nativeSearch opt-in).
 */
export function hasUsableFunctionSearchChannelFor(provider: string): boolean {
	return getNormalizedSearchChannels(settings).some((channel) => {
		if (!channel.enabled) return false;
		if (channel.kind === "native") return usesSideRequestNativeSearch(provider);
		return isPotentiallyUsableFunctionChannel(channel);
	});
}

export function listSearchChannels(): Array<
	SearchChannelConfig & { label: string; available: boolean }
> {
	return getNormalizedSearchChannels(settings).map((channel) => ({
		...channel,
		label: channelLabel(channel),
		available: channel.kind === "native" ? true : isPotentiallyUsableFunctionChannel(channel),
	}));
}

export async function executeSearch(request: SearchRequest): Promise<SearchExecutionResult> {
	const attempts: SearchExecutionResult["attempts"] = [];
	const channels = getNormalizedSearchChannels(settings).filter(
		(channel) => channel.enabled && (!request.channelId || channel.id === request.channelId),
	);
	for (const channel of channels) {
		const label = channelLabel(channel);
		if (request.signal?.aborted) throw new Error("Aborted");
		if (channel.kind === "subagent" && !request.purpose) {
			attempts.push({
				channelId: channel.id,
				channelLabel: label,
				skipped: true,
				error: "missing purpose",
			});
			continue;
		}
		// The native channel is per-provider: skip cleanly (no warn log) when the
		// requesting session's provider hasn't opted into side-request search.
		if (
			channel.kind === "native" &&
			(!request.provider || !usesSideRequestNativeSearch(request.provider))
		) {
			attempts.push({
				channelId: channel.id,
				channelLabel: label,
				skipped: true,
				error: "provider does not support native search",
			});
			continue;
		}
		if (!isPotentiallyUsableFunctionChannel(channel)) {
			attempts.push({
				channelId: channel.id,
				channelLabel: label,
				skipped: true,
				error: "unavailable",
			});
			continue;
		}
		try {
			const result = await runChannel(channel, request);
			return {
				...result,
				text: truncateSearchOutput(result.text),
				attempts: [...attempts, { channelId: channel.id, channelLabel: label }],
			};
		} catch (err) {
			if (request.signal?.aborted || isAbortError(err)) throw err;
			const message = err instanceof Error ? err.message : String(err);
			attempts.push({ channelId: channel.id, channelLabel: label, error: message });
			logger.warn("Search channel failed, trying next channel", {
				channelId: channel.id,
				kind: channel.kind,
				error: message,
			});
		}
	}
	const details = attempts
		.map(
			(attempt) =>
				`${attempt.channelLabel}: ${attempt.error ?? (attempt.skipped ? "skipped" : "failed")}`,
		)
		.join("; ");
	throw new Error(`No usable web search channel succeeded${details ? ` (${details})` : ""}`);
}
