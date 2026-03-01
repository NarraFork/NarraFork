import type { ModelOption } from "../../lib/constants";

export interface OpenAIProviderState {
	id: string;
	name: string;
	prefix: string;
	apiKey: string;
	baseUrl: string;
	defaultModel: string;
	apiMode: "responses" | "completions" | "codex";
	codexAccountId: string;
}

export interface AnthropicProviderState {
	id: string;
	name: string;
	prefix: string;
	apiKey: string;
	baseUrl: string;
	defaultModel: string;
	maxMode: boolean;
}


/** Ensure a model value has a "provider:" prefix. */
export function ensurePrefix(val: string): string {
	if (!val || val.includes(":")) return val;
	return `openai:${val}`;
}

/**
 *
 * Decision logic (in priority order):
 * 1. authMethod === "idc" or hasProfileArn or hasStartUrl → enterprise
 * 2. subscriptionTitle contains "enterprise" / "business" → enterprise
 * 3. subscriptionTitle contains "pro" / "individual" / "paid" / "builder" / "power" → paid
 * 4. subscriptionTitle contains "free" or is absent → free
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
