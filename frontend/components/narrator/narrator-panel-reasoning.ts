/**
 * narrator-panel-reasoning.ts — which reasoning-effort tiers a model actually accepts.
 *
 * Extracted from `NarratorPanel.tsx` unchanged. Every provider spells this differently:
 * Codex varies the set BY MODEL (and only some models accept "none"), DeepSeek and
 * Gemini have their own ladders, Anthropic gains an `xhigh` tier only from a certain
 * Claude version onward. The panel needs one answer — "what may I offer for the model
 * this narrator is on" — and a wrong answer is not a crash: the menu simply offers a
 * tier the provider rejects at request time, which reads as the model ignoring the
 * setting.
 *
 * `normalizeReasoningEffortForModel` is the clamp the UI shows through: it maps a stored
 * value (possibly set while another model was selected) onto what the CURRENT model
 * supports, which is why the menu can always highlight a tier that will really be used.
 */

import {
	claudeVersionAtLeast,
	GENERIC_REASONING_EFFORT_TIERS,
	parseClaudeModel,
} from "@shared/reasoning-effort-support";
import type { ModelOption } from "../../lib/constants";

export type ReasoningEffortValue = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Unknown Codex models expose all tiers until the catalog declares constraints.
 */
export const DEFAULT_CODEX_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] =
	GENERIC_REASONING_EFFORT_TIERS;

/** DeepSeek only supports two effective tiers: high and max (mapped from xhigh). */
export const DEEPSEEK_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
	"none",
	"high",
	"xhigh",
];

/**
 * Gemini exposes a three-tier thinking level (low/medium/high) plus "none" to
 * disable thinking. NarraFork's higher tiers (xhigh/max) collapse onto "high"
 * upstream, so they are not offered here.
 */
export const GEMINI_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
	"none",
	"low",
	"medium",
	"high",
];

/**
 * Anthropic effort tiers for 4.6-era models (official API and
 * Anthropic-compatible relays). The `xhigh` tier only arrived with Opus 4.7,
 * so these models expose low/medium/high/max plus "none" to disable thinking.
 */
export const ANTHROPIC_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
	"none",
	"low",
	"medium",
	"high",
	"max",
];

/**
 * Anthropic effort tiers for models with the `xhigh` tier — Opus 4.7/4.8, the
 * 5 series (Opus 5 / Sonnet 5) and Fable/Mythos.
 */
export const ANTHROPIC_XHIGH_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export const CODEX_REASONING_OPTIONS_BY_MODEL: Record<string, readonly ReasoningEffortValue[]> = {
	// GPT-6 Astra requires reasoning, so it intentionally omits `none`.
	"gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
	"gpt-6.1-sol": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-terra": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.5": ["none", "low", "medium", "high", "xhigh"],
};

export function getBareModelForReasoning(model?: string, modelOption?: ModelOption): string {
	if (modelOption?.bareModel) return modelOption.bareModel;
	if (!model) return "";
	const modelWithoutProvider = model.includes(":") ? model.split(":").slice(1).join(":") : model;
	const channel = modelOption?.channel ?? modelWithoutProvider.split(":")[0];
	if (channel) {
		const channelPrefix = `${channel}:`;
		if (modelWithoutProvider.startsWith(channelPrefix)) {
			return modelWithoutProvider.slice(channelPrefix.length);
		}
	}
	return modelWithoutProvider.startsWith("codex:")
		? modelWithoutProvider.slice("codex:".length)
		: modelWithoutProvider;
}

export function getCodexReasoningEffortOptions(
	model?: string,
	modelOption?: ModelOption,
): readonly ReasoningEffortValue[] {
	const bareModel = getBareModelForReasoning(model, modelOption);
	return CODEX_REASONING_OPTIONS_BY_MODEL[bareModel] ?? DEFAULT_CODEX_REASONING_EFFORT_OPTIONS;
}

export function codexModelSupportsReasoningDisabled(
	model?: string,
	modelOption?: ModelOption,
): boolean {
	return getBareModelForReasoning(model, modelOption) !== "gpt-6-astra";
}

export function isDeepSeekModel(model?: string): boolean {
	if (!model) return false;
	return model.toLowerCase().includes("deepseek");
}

/**
 * Whether an Anthropic model has the `xhigh` tier (Opus 4.7+ / 5 series).
 * A tier question, not an access question — the parsing it relies on lives in
 * @shared/reasoning-effort-support alongside the backend's copy.
 */
export function anthropicModelSupportsXhigh(model?: string): boolean {
	if (!model) return false;
	const parsed = parseClaudeModel(model);
	if (!parsed) return false;
	if (parsed.family === "fable" || parsed.family === "mythos") return true;
	if (parsed.family !== "sonnet" && parsed.family !== "opus") return false;
	return claudeVersionAtLeast(parsed, 4, 7);
}

export function normalizeReasoningEffortForModel(
	model: string | undefined,
	effort: string | null | undefined,
): string {
	if (!effort) return "";
	if (isDeepSeekModel(model) && (effort === "low" || effort === "medium")) return "high";
	return effort;
}
