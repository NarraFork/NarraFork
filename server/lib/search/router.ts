import { logger } from "../logger";
import { resolveEffectiveModel, resolveProvider, settings } from "../settings";
import type {
	CustomSearchProviderConfig,
	NarraForkSettings,
	NUGProviderConfig,
	SearchChannelConfig,
} from "../settings/types";
import { executeCustomSearchProvider, isCustomSearchProviderUsable } from "./adapters/index";
import { supportsNativeSearch } from "./native";
import {
	DEFAULT_SEARCH_MAX_OUTPUT_CHARS,
	DEFAULT_SEARCH_TIMEOUT_MS,
	getNormalizedSearchChannels,
	SEARCH_NATIVE_CHANNEL_ID,
} from "./settings";
import { isAbortError, withSearchTimeout } from "./timeout";
import type { SearchChannelResult, SearchExecutionResult, SearchRequest } from "./types";

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

	channel: SearchChannelConfig,
	request: SearchRequest,
	signal: AbortSignal,
): Promise<SearchChannelResult> {
	const parsed = textFromMcpResponse(response);
	return { channelId: channel.id, channelLabel: channelLabel(channel), text: parsed.text };
}

function isSubagentChannelUsable(channel: SearchChannelConfig): boolean {
	if (!channel.model) return false;
	const model = resolveEffectiveModel(channel.model);
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
	});
	return { channelId: channel.id, channelLabel: channelLabel(channel), text };
}

function channelTimeout(channel: SearchChannelConfig): number {
	const providerTimeout =
		channel.kind === "custom-api" ? findCustomProvider(channel)?.timeoutMs : undefined;
	return (
		channel.timeoutMs ??
		providerTimeout ??
		settings.search?.defaultTimeoutMs ??
		DEFAULT_SEARCH_TIMEOUT_MS
	);
}

async function runChannel(
	channel: SearchChannelConfig,
	request: SearchRequest,
): Promise<SearchChannelResult> {
	switch (channel.kind) {
			return withSearchTimeout(
				request.signal,
				channelTimeout(channel),
			);
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
		case "subagent":
			return searchSubagent(channel, request);
		case "native":
			throw new Error("Native search is handled by the model provider, not by WebSearch");
	}
}

function isPotentiallyUsableFunctionChannel(channel: SearchChannelConfig): boolean {
	if (!channel.enabled || channel.id === SEARCH_NATIVE_CHANNEL_ID) return false;
	switch (channel.kind) {
		case "nug-mcp": {
			const provider = findNugProvider(channel);
			return !!provider && !provider.disabled && !!provider.apiKey && !!provider.baseUrl;
		}
		case "custom-api": {
			const provider = findCustomProvider(channel);
			return isCustomSearchProviderUsable(provider);
		}
		case "subagent":
			return isSubagentChannelUsable(channel);
		case "native":
			return false;
	}
}

export function hasUsableFunctionSearchChannel(): boolean {
	return getNormalizedSearchChannels(settings).some(isPotentiallyUsableFunctionChannel);
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
		(channel) =>
			channel.enabled &&
			channel.id !== SEARCH_NATIVE_CHANNEL_ID &&
			(!request.channelId || channel.id === request.channelId),
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
