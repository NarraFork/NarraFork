import { cardEffortLevels, lookupModelCard } from "@shared/model-card";
import { clampReasoningEffort, type ReasoningEffort } from "@shared/reasoning-effort";
import {
	claudeVersionAtLeast,
	GENERIC_REASONING_EFFORT_TIERS,
	modelAcceptsReasoningEffort,
	parseClaudeModel,
	type ReasoningEffortBlocklistEntry,
} from "@shared/reasoning-effort-support";
import { useCallback, useMemo } from "react";
import type { useModelCardIndex } from "../../../hooks/useModelCards";
import type { ModelOption } from "../../../lib/constants";

type ModelCardIndex = ReturnType<typeof useModelCardIndex>;

type ReasoningEffortValue = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Fallback tiers for a Codex model missing from the catalog below. Kept
 * separate from GENERIC_REASONING_EFFORT_TIERS: Codex models have no `max`
 * tier, so an unknown one must not offer it.
 */
const DEFAULT_CODEX_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
	"none",
	"low",
	"medium",
	"high",
];

/** DeepSeek only supports two effective tiers: high and max (mapped from xhigh). */
const DEEPSEEK_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
	"none",
	"high",
	"xhigh",
];

/**
 * Gemini exposes a three-tier thinking level (low/medium/high) plus "none" to
 * disable thinking. NarraFork's higher tiers (xhigh/max) collapse onto "high"
 * upstream, so they are not offered here.
 */
const GEMINI_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
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
const ANTHROPIC_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
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
const ANTHROPIC_XHIGH_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortValue[] = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const CODEX_REASONING_OPTIONS_BY_MODEL: Record<string, readonly ReasoningEffortValue[]> = {
	// GPT-6 Astra requires reasoning, so it intentionally omits `none`.
	"gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-terra": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.5": ["none", "low", "medium", "high", "xhigh"],
};

function getBareModelForReasoning(model?: string, modelOption?: ModelOption): string {
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

function getCodexReasoningEffortOptions(
	model?: string,
	modelOption?: ModelOption,
): readonly ReasoningEffortValue[] {
	const bareModel = getBareModelForReasoning(model, modelOption);
	return CODEX_REASONING_OPTIONS_BY_MODEL[bareModel] ?? DEFAULT_CODEX_REASONING_EFFORT_OPTIONS;
}

function codexModelSupportsReasoningDisabled(model?: string, modelOption?: ModelOption): boolean {
	return getBareModelForReasoning(model, modelOption) !== "gpt-6-astra";
}

function isDeepSeekModel(model?: string): boolean {
	if (!model) return false;
	return model.toLowerCase().includes("deepseek");
}

/**
 * Whether an Anthropic model has the `xhigh` tier (Opus 4.7+ / 5 series).
 * A tier question, not an access question — the parsing it relies on lives in
 * @shared/reasoning-effort-support alongside the backend's copy.
 */
function anthropicModelSupportsXhigh(model?: string): boolean {
	if (!model) return false;
	const parsed = parseClaudeModel(model);
	if (!parsed) return false;
	if (parsed.family === "fable" || parsed.family === "mythos") return true;
	if (parsed.family !== "sonnet" && parsed.family !== "opus") return false;
	return claudeVersionAtLeast(parsed, 4, 7);
}

function normalizeReasoningEffortForModel(
	model: string | undefined,
	effort: string | null | undefined,
): string {
	if (!effort) return "";
	if (isDeepSeekModel(model) && (effort === "low" || effort === "medium")) return "high";
	return effort;
}

/** Minimal settings surface this hook reads. */
interface ModelSelectionSettings {
	codexAvailable?: boolean;
	openaiProviders?: Array<{ prefix?: string; apiMode?: string }>;
	anthropicProviders?: Array<{ prefix?: string }>;
	geminiProviders?: Array<{ prefix?: string }>;
	agent?: {
		reasoningEffortBlocklist?: readonly ReasoningEffortBlocklistEntry[] | null;
		defaultReasoningEffort?: string;
	};
}

interface ReasoningEffortMutation {
	mutate: (input: { id: string; reasoningEffort: string | null }) => void;
}
interface UpdateSettingsMutation {
	mutate: (
		input: { agent: { defaultReasoningEffort: string } },
		opts?: { onSuccess?: () => void },
	) => void;
}

export interface UseModelSelectionOptions {
	narratorId: string;
	/** Effective model + its parse, resolved up front by useResolvedModel. */
	resolvedModel: string;
	resolvedBareModel: string;
	resolvedModelOption: ModelOption | undefined;
	narratorReasoningEffort: string | null | undefined;
	settingsData: ModelSelectionSettings | undefined;
	modelCardIndex: ModelCardIndex;
	reasoningEffortMutation: ReasoningEffortMutation;
	updateSettingsMutation: UpdateSettingsMutation;
}

export interface UseModelSelectionResult {
	codexCapableProviders: Set<string>;
	isCodexChannelModel: boolean;
	supportsCodexControls: boolean;
	isBuiltInCodexModel: boolean;
	supportsReasoningEffort: boolean;
	reasoningEffortOptions: readonly ReasoningEffortValue[];
	globalDefaultReasoningEffort: ReasoningEffort;
	reasoningFollowsDefault: boolean;
	displayedReasoningEffort: string;
	handleFollowDefaultReasoning: () => void;
	handleSetReasoningAsDefault: () => void;
}

/**
 * Resolves the active narrator's effective model and everything derived from it:
 * provider/bare-model parse, Codex channel/control detection, the reasoning-effort
 * tier menu (with the per-family tier tables), and the follow-default / set-as-default
 * reasoning handlers.
 *
 * Kept lifted (called from the panel): `resolvedModel` feeds the NUG quota, Kimi
 * usage and context-threshold queries and the big status-bar control-menu object,
 * so it is produced centrally here and threaded back into the panel.
 */
export function useModelSelection(options: UseModelSelectionOptions): UseModelSelectionResult {
	const {
		narratorId,
		resolvedModel,
		resolvedBareModel,
		resolvedModelOption,
		narratorReasoningEffort,
		settingsData,
		modelCardIndex,
		reasoningEffortMutation,
		updateSettingsMutation,
	} = options;

	const codexCapableProviders = useMemo(() => {
		const providers = new Set<string>();
		if (settingsData?.codexAvailable) providers.add("codex");
		for (const provider of settingsData?.openaiProviders ?? []) {
			if (provider?.prefix && (provider.apiMode ?? "responses") === "codex") {
				providers.add(provider.prefix);
			}
		}
		return providers;
	}, [settingsData]);
	const isCodexChannelModel =
		resolvedModelOption?.channelType?.toLowerCase() === "codex" ||
		resolvedBareModel.startsWith("codex:");
	const supportsCodexControls = useMemo(() => {
		const providerPrefix = resolvedModel?.split(":")[0];
		return (!!providerPrefix && codexCapableProviders.has(providerPrefix)) || isCodexChannelModel;
	}, [codexCapableProviders, isCodexChannelModel, resolvedModel]);
	const isBuiltInCodexModel = resolvedModel?.split(":")[0] === "codex";

	/**
	 * Whether to offer the reasoning-effort menu at all.
	 *
	 * Blacklist policy, mirroring the backend: effort is near-universal, so any
	 * configured model gets the menu unless it is excluded. The previous
	 * whitelist demanded a recognizable Claude/Codex/Gemini/DeepSeek id, which
	 * hid the menu for every third-party model behind a generic relay (GLM,
	 * Kimi, MiniMax, ...) even though those upstreams accept the parameter.
	 *
	 * Two exclusions, both shared with the backend via
	 * `modelAcceptsReasoningEffort`: pre-4.6 Claude, and the user's
	 * `agent.reasoningEffortBlocklist`.
	 */
	const supportsReasoningEffort = useMemo(() => {
		const providerPrefix = resolvedModel?.split(":")[0];
		if (!providerPrefix) return false;
		// Codex always has tiers, regardless of the model id.
		if (codexCapableProviders.has(providerPrefix) || isCodexChannelModel) return true;
		return modelAcceptsReasoningEffort(
			getBareModelForReasoning(resolvedModel, resolvedModelOption),
			settingsData?.agent?.reasoningEffortBlocklist,
		);
	}, [
		codexCapableProviders,
		isCodexChannelModel,
		resolvedModelOption,
		settingsData?.agent?.reasoningEffortBlocklist,
		resolvedModel,
	]);
	const reasoningEffortOptions = useMemo(() => {
		if (!resolvedModel) return GENERIC_REASONING_EFFORT_TIERS;
		const card = modelCardIndex
			? lookupModelCard(
					getBareModelForReasoning(resolvedModel, resolvedModelOption),
					modelCardIndex,
				)?.card
			: undefined;
		// Missing catalog data is not evidence that a new model lacks a tier.
		if (!card) return GENERIC_REASONING_EFFORT_TIERS;
		// DeepSeek: only two effective tiers (high / max mapped from xhigh)
		if (isDeepSeekModel(resolvedModel)) return DEEPSEEK_REASONING_EFFORT_OPTIONS;
		// Model cards: the editable replacement for the hardcoded per-model tables.
		// `none` is appended here rather than stored on the card, because on a card
		// it would become a clamp target able to silently turn a requested `low`
		// into thinking switched off.
		const cardTiers = cardEffortLevels(card);
		if (cardTiers?.length) {
			return codexModelSupportsReasoningDisabled(resolvedModel, resolvedModelOption)
				? (["none", ...cardTiers] as readonly ReasoningEffortValue[])
				: (cardTiers as readonly ReasoningEffortValue[]);
		}
		const providerPrefix = resolvedModel.split(":")[0];
		if (providerPrefix && (codexCapableProviders.has(providerPrefix) || isCodexChannelModel)) {
			return getCodexReasoningEffortOptions(resolvedModel, resolvedModelOption);
		}
		// Anthropic (official, compatible/cc relay, or NUG anthropic channel).
		// Opus 4.7+ and the 5 series add the xhigh tier; 4.6 stays on four tiers.
		const isAnthropic =
			resolvedModelOption?.channelType === "anthropic" ||
			(!!providerPrefix &&
				(settingsData?.anthropicProviders ?? []).some(
					(p: { prefix?: string }) => p.prefix === providerPrefix,
				));
		if (isAnthropic) {
			return anthropicModelSupportsXhigh(
				getBareModelForReasoning(resolvedModel, resolvedModelOption),
			)
				? ANTHROPIC_XHIGH_REASONING_EFFORT_OPTIONS
				: ANTHROPIC_REASONING_EFFORT_OPTIONS;
		}
		// Gemini (gemini-compatible): low/medium/high plus none.
		const isGemini =
			!!providerPrefix &&
			(settingsData?.geminiProviders ?? []).some(
				(p: { prefix?: string }) => p.prefix === providerPrefix,
			);
		if (isGemini) {
			return GEMINI_REASONING_EFFORT_OPTIONS;
		}
		// No declared tier table: keep all efforts available on generic relays.
		return GENERIC_REASONING_EFFORT_TIERS;
	}, [
		codexCapableProviders,
		isCodexChannelModel,
		modelCardIndex,
		resolvedModel,
		resolvedModelOption,
		settingsData?.anthropicProviders,
		settingsData?.geminiProviders,
	]);

	// The global default reasoning effort (single source of truth). Applied to
	// every model when the narrator has no explicit override.
	const globalDefaultReasoningEffort = useMemo<ReasoningEffort>(() => {
		const raw = settingsData?.agent?.defaultReasoningEffort;
		return (raw as ReasoningEffort) || "max";
	}, [settingsData?.agent?.defaultReasoningEffort]);

	// Whether the narrator is following the global default (no explicit override).
	const reasoningFollowsDefault = narratorReasoningEffort == null;

	// The effective reasoning effort to highlight in the menu. Always shows the
	// tier that will actually be used: the narrator's own override (clamped to
	// the model), or — when following default — the clamped global default.
	// Mirrors the permission/reflection menus, which show the effective value and
	// express the follow/override state only via the inline links below.
	const displayedReasoningEffort = useMemo(() => {
		const opts = reasoningEffortOptions as readonly ReasoningEffort[];
		const desired = reasoningFollowsDefault
			? globalDefaultReasoningEffort
			: (normalizeReasoningEffortForModel(
					resolvedModel,
					narratorReasoningEffort,
				) as ReasoningEffort);
		if (!desired) return "";
		return clampReasoningEffort(desired, opts);
	}, [
		resolvedModel,
		narratorReasoningEffort,
		reasoningEffortOptions,
		reasoningFollowsDefault,
		globalDefaultReasoningEffort,
	]);

	// "Follow default": clear the narrator's override so it tracks the global
	// default again.
	const handleFollowDefaultReasoning = useCallback(() => {
		reasoningEffortMutation.mutate({ id: narratorId, reasoningEffort: null });
	}, [narratorId, reasoningEffortMutation]);

	// "Set as default": promote the narrator's explicit override to the global
	// default (writing the raw desired value, NOT the per-model clamped one), then
	// reset the narrator to follow the default. Only meaningful when an override
	// exists, so the inline link is hidden while following default.
	const handleSetReasoningAsDefault = useCallback(() => {
		const desired = narratorReasoningEffort;
		if (!desired) return;
		updateSettingsMutation.mutate(
			{ agent: { defaultReasoningEffort: desired } },
			{
				onSuccess: () => {
					reasoningEffortMutation.mutate({ id: narratorId, reasoningEffort: null });
				},
			},
		);
	}, [narratorReasoningEffort, narratorId, reasoningEffortMutation, updateSettingsMutation]);

	return {
		codexCapableProviders,
		isCodexChannelModel,
		supportsCodexControls,
		isBuiltInCodexModel,
		supportsReasoningEffort,
		reasoningEffortOptions,
		globalDefaultReasoningEffort,
		reasoningFollowsDefault,
		displayedReasoningEffort,
		handleFollowDefaultReasoning,
		handleSetReasoningAsDefault,
	};
}
