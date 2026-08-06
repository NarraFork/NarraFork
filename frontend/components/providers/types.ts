import type { ModelOption } from "../../lib/constants";
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
	if (["claude-haiku-4.5", "claude-sonnet-4.5", "claude-opus-4.5", "claude-opus-4.6"].includes(val))
	// Legacy short names — map to full IDs
	return `openai:${val}`;
}

	switch (method?.trim().toLowerCase()) {
		case "api_key":
		case "apikey":
		case "api-key":
			return true;
		default:
			return false;
	}
}

/**
 *
 * Decision logic (in priority order):
 * 1. authMethod === "idc" or hasProfileArn or hasStartUrl → enterprise
 * 2. subscriptionTitle contains "enterprise" / "business" → enterprise
 * 3. subscriptionTitle contains "pro" / "individual" / "paid" / "builder" / "power" → paid
 * 4. subscriptionTitle contains "free" or is absent → free
 *
 * Static api_key credentials carry no OAuth profile, so they fall through to the
 * subscriptionTitle-based branches like any other non-enterprise credential.
 */
	authMethod?: string;
	hasProfileArn?: boolean;
	hasStartUrl?: boolean;
	subscriptionTitle?: string;
	if (entry.authMethod === "idc" || entry.hasProfileArn || entry.hasStartUrl) {
		return "enterprise";
	}

	const title = entry.subscriptionTitle;
	if (!title) return "free";
	const lower = title.toLowerCase();
	if (lower.includes("enterprise") || lower.includes("business")) return "enterprise";
	if (
		lower.includes("pro") ||
		lower.includes("individual") ||
		lower.includes("paid") ||
		lower.includes("builder") ||
		lower.includes("power")
	) {
		return "paid";
	}
	return "free";
}

/** Tier display config. */
export const TIER_CONFIG: Record<
	{ color: string; i18nKey: string; descKey: string }
> = {
	enterprise: {
		color: "violet",
	},
};

/**
 * Determine which models are available for each account tier.
 * - free: only a subset (haiku-class models)
 * - pro: all models
 * - enterprise: only claude-* models
 */
export function getModelAvailability(models: ModelOption[]): {
	free: ModelOption[];
	paid: ModelOption[];
	enterprise: ModelOption[];
} {
	const claudeModels = models.filter((m) => {
		return id.startsWith("claude-");
	});
	const freeModels = models.filter((m) => {
		return id.includes("haiku") || id.includes("sonnet-4");
	});
	return {
		free: freeModels,
		paid: models, // all
		enterprise: claudeModels,
	};
}
