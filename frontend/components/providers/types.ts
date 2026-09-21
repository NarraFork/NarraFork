import type { ProxyOverride } from "../../lib/proxy";

export type CustomApiProtocol =
	| "anthropic-official"
	| "anthropic-compatible"
	| "codex-native"
	| "responses-compatible"
	| "completions-compatible"
	| "gemini-compatible";

/** Per-provider User-Agent selection mode. */
export type UserAgentMode = "narrafork" | "claude-code" | "codex" | "custom";

/**
 * Default client identity for a custom-API protocol when the operator has not
 * chosen a User-Agent mode.
 *
 * Relay defaults follow the protocol the traffic actually speaks:
 * - Codex 中转 → Codex
 * - Claude Code 中转（official / compatible）→ Claude Code
 * - Everything else presents as NarraFork
 */
export function defaultUserAgentModeForProtocol(protocol: CustomApiProtocol): UserAgentMode {
	switch (protocol) {
		case "codex-native":
			return "codex";
		case "anthropic-official":
		case "anthropic-compatible":
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

/** Ensure a model value has a "provider:" prefix. */
export function ensurePrefix(val: string): string {
	if (!val || val.includes(":")) return val;
	// Bare claude model names resolve to the Anthropic provider.
	if (["claude-haiku-4.5", "claude-sonnet-4.5", "claude-opus-4.5", "claude-opus-4.6"].includes(val))
		return `anthropic:${val}`;
	// Legacy short names — map to full IDs
	if (val === "claude-haiku") return "anthropic:claude-haiku-4.5";
	if (val === "claude-sonnet") return "anthropic:claude-sonnet-4.5";
	if (val === "claude-opus") return "anthropic:claude-opus-4.6";
	return `openai:${val}`;
}
