import { PROVIDER_PRESETS, type ProviderPreset } from "./provider-presets";

export type ProviderRegion = "china" | "international";
export type ProviderBilling = "payg" | "token-plan";
export type ProviderCluster = "sgp" | "ams";

export interface ProviderConnectionSelection {
	region: ProviderRegion;
	billing: ProviderBilling;
	cluster?: ProviderCluster;
}

export const POPULAR_PROVIDER_IDS = [
	"deepseek",
	"zhipu",
	"moonshot",
	"minimax",
	"mimo",
	"openai",
	"anthropic",
] as const;

type ConnectionFamily = "kimi" | "minimax" | "mimo" | "zhipu";
const INTERNATIONAL_ALIASES = new Set(["moonshot-global", "minimax-global", "zai"]);

export function getPopularProviderPresets(): ProviderPreset[] {
	return POPULAR_PROVIDER_IDS.flatMap((id) =>
		PROVIDER_PRESETS.filter((preset) => preset.id === id),
	);
}

export function getConnectionFamily(presetId: string): ConnectionFamily | undefined {
	switch (presetId) {
		case "moonshot":
		case "moonshot-global":
			return "kimi";
		case "minimax":
		case "minimax-global":
			return "minimax";
		case "mimo":
			return "mimo";
		case "zhipu":
		case "zai":
			return "zhipu";
		default:
			return undefined;
	}
}

export function getInitialConnectionSelection(
	presetId: string,
	language: string,
): ProviderConnectionSelection {
	return {
		region:
			!INTERNATIONAL_ALIASES.has(presetId) && language.toLowerCase().startsWith("zh")
				? "china"
				: "international",
		billing: "payg",
	};
}

function endpoints(
	messages: string,
	completions: string,
	responses?: string,
): ProviderPreset["endpoints"] {
	return {
		"anthropic-messages": messages,
		"completions-compatible": completions,
		...(responses ? { "openai-responses": responses } : {}),
	};
}

// NarraFork-authored factual URL mapping; official source URLs and evidence limits:
// licenses/extra/cherry-studio-provider-registry.txt. All Messages bases include /v1
// because NarraFork appends /messages directly (unlike SDK prefix normalization).
// These endpoints do not promise access for clients outside a provider's allowed tools.
export function resolveProviderConnection(
	preset: ProviderPreset,
	selection: ProviderConnectionSelection,
): { preset: ProviderPreset; userAgentMode?: "narrafork" } | null {
	const family = getConnectionFamily(preset.id);
	if (!family) return { preset };
	const china = selection.region === "china";
	const tokenPlan = selection.billing === "token-plan";
	let resolvedEndpoints: ProviderPreset["endpoints"];
	switch (family) {
		case "kimi": {
			if (tokenPlan) {
				const base = `https://api.kimi.${china ? "com" : "ai"}/coding/v1`;
				resolvedEndpoints = endpoints(base, base, base);
			} else {
				const host = `https://api.moonshot.${china ? "cn" : "ai"}`;
				resolvedEndpoints = endpoints(`${host}/anthropic/v1`, `${host}/v1`, `${host}/v1`);
			}
			break;
		}
		case "minimax": {
			// Subscription keys and pay-as-you-go keys differ, even with the same host.
			const host = `https://api.minimax.${china ? "cn" : "io"}`;
			resolvedEndpoints = endpoints(`${host}/anthropic/v1`, `${host}/v1`);
			break;
		}
		case "mimo": {
			if (tokenPlan && !china && !selection.cluster) return null;
			const host = tokenPlan
				? `https://token-plan-${china ? "cn" : selection.cluster}.xiaomimimo.com`
				: "https://api.xiaomimimo.com";
			// The official Codex guide verifies Responses for payg and CN Token Plan.
			// SGP/AMS have explicit A/C examples only: do not infer regional Responses.
			resolvedEndpoints = endpoints(
				`${host}/anthropic/v1`,
				`${host}/v1`,
				!tokenPlan || china ? `${host}/v1` : undefined,
			);
			break;
		}
		case "zhipu": {
			const host = china ? "https://open.bigmodel.cn" : "https://api.z.ai";
			// Ordinary Responses is documented by BigModel, not Z.ai's ordinary API docs.
			resolvedEndpoints = endpoints(
				`${host}/api/anthropic/v1`,
				`${host}/api/${tokenPlan ? "coding/" : ""}paas/v4`,
				tokenPlan || china ? `${host}/api/v1` : undefined,
			);
			break;
		}
	}
	const defaultProtocol = resolvedEndpoints["openai-responses"]
		? "openai-responses"
		: resolvedEndpoints["anthropic-messages"]
			? "anthropic-messages"
			: "completions-compatible";
	return {
		preset: { ...preset, endpoints: resolvedEndpoints, defaultProtocol },
		...(tokenPlan ? { userAgentMode: "narrafork" as const } : {}),
	};
}
