import type { ProxyOverride } from "../../lib/proxy";

export type CustomApiProtocol =
	| "anthropic-messages"
	| "openai-responses"
	| "completions-compatible"
	| "gemini-compatible";

/** Per-provider User-Agent selection mode. */
export type UserAgentMode = "narrafork" | "claude-code" | "codex" | "custom";

/**
 * Default client identity for a custom-API protocol when the operator has not
 * chosen a User-Agent mode.
 *
 * Relay defaults follow the protocol the traffic actually speaks:
 * - OpenAI Responses（Codex 客户端契约）→ Codex
 * - Anthropic Messages（Claude Code 方言）→ Claude Code
 * - Everything else presents as NarraFork
 */
export function defaultUserAgentModeForProtocol(protocol: CustomApiProtocol): UserAgentMode {
	switch (protocol) {
		case "openai-responses":
			return "codex";
		case "anthropic-messages":
			return "claude-code";
		default:
			return "narrafork";
	}
}

export interface CustomApiProviderState {
	id: string;
	name: string;
	prefix: string;
	apiKey: string;
	baseUrl: string;
	defaultModel: string;
	protocol: CustomApiProtocol;
	geminiTransport?: "generate-content" | "interactions";
	defaultContextWindow?: number;
	defaultReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | null;
	proxy?: ProxyOverride;
	tlsRejectUnauthorized?: boolean;
	/** Anthropic official: upstream serves the server-side web_search tool. */
	nativeSearch?: boolean;
	codexAccountId: string;
	codexWebSocket?: boolean;
	codexWebSearch?: boolean;
	codexImageGeneration?: boolean;
	userAgentMode?: UserAgentMode;
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
	/** Site interface root for the `/api/user/self` credit query (independent of baseUrl). */
	quotaSiteUrl?: string;
	/** Site system access token (not the inference `sk-` key). */
	quotaAccessToken?: string;
	/** Site user id, sent as `New-Api-User`. */
	quotaUserId?: string;
	disabled?: boolean;
}

export interface OpenAIProviderState {
	id: string;
	name: string;
	prefix: string;
	apiKey: string;
	baseUrl: string;
	defaultModel: string;
	/** @deprecated Use apiMode. Preserved so legacy responsesApi=false migrates correctly. */
	responsesApi?: boolean;
	apiMode?: "responses" | "completions" | "codex";
	codexAccountId: string;
	codexWebSocket?: boolean;
	codexWebSearch?: boolean;
	codexImageGeneration?: boolean;
	userAgentMode?: UserAgentMode;
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
	proxy?: ProxyOverride;
	disabled?: boolean;
}

export interface AnthropicProviderState {
	id: string;
	name: string;
	prefix: string;
	apiKey: string;
	baseUrl: string;
	defaultModel: string;
	proxy?: ProxyOverride;
	tlsRejectUnauthorized?: boolean;
	officialApi?: boolean;
	/** Official API: upstream serves the server-side web_search tool. */
	nativeSearch?: boolean;
	userAgentMode?: UserAgentMode;
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
	disabled?: boolean;
}

/**
 * Ensure a model value has a "provider:" prefix.
 *
 * Values starting with `__` are settings sentinels (`__default__`, `__summary__`,
 * `__agg__:…`), not model IDs. Prefixing one turns "follow the default model"
 * into a provider-qualified string that no model list contains, so every Select
 * that only offers the bare sentinel renders it as an empty field.
 */
export function ensurePrefix(val: string): string {
	if (!val || val.includes(":") || val.startsWith("__")) return val;
	// Bare claude model names resolve to the Anthropic provider.
	if (["claude-haiku-4.5", "claude-sonnet-4.5", "claude-opus-4.5", "claude-opus-4.6"].includes(val))
		return `anthropic:${val}`;
	// Legacy short names — map to full IDs
	if (val === "claude-haiku") return "anthropic:claude-haiku-4.5";
	if (val === "claude-sonnet") return "anthropic:claude-sonnet-4.5";
	if (val === "claude-opus") return "anthropic:claude-opus-4.6";
	return `openai:${val}`;
}
