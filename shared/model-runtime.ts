import type { ModelReasoning } from "./model-catalog/profile";

/** Bounded read projection; never a complete catalog card or provider configuration. */
export interface RuntimeModelSummary {
	selection: { value: string; label: string };
	state: "configured" | "observed" | "not-observed";
	concreteValue: string | null;
	resolvedProvider: string | null;
	resolvedBareModel: string | null;
	revision: string;
	settingsRevision: number;
	observedAt?: number;
	provider?: {
		id: string;
		prefix: string;
		name: string;
		quotaKind?: "nug" | "tokendance" | "provider" | "kimi" | "opencode" | "deepseek";
		generation?: number | string;
		pushedQuota?: { quotaBalance: string | null; detailedQuotaBalance: string | null };
	};
	reasoning: ModelReasoning;
	/** Distinguishes missing gateway declaration, explicit no tiers, and declared tiers. */
	effortLevels?: string[] | null;
	capabilities?: {
		channelType?: string;
		bareModel?: string;
		contextWindow?: number | null;
		maxOutputTokens?: number | null;
		nativeSearch?: boolean | null;
		inputModalities?: string[] | null;
		toolLoadingModes?: string[] | null;
	};
	provenance?: { reasoning?: string; contextWindow?: string };
}

export const MODEL_RUNTIME_MAX_BYTES = 4 * 1024;
export const SETTINGS_RUNTIME_MAX_BYTES = 8 * 1024;
