import type { ModelCard } from "@shared/model-catalog/card";
import { type ModelReasoning, modelProfile } from "@shared/model-catalog/profile";
import type { RuntimeModelSummary } from "@shared/model-runtime";
import {
	clampReasoningEffort,
	migrateLegacyReasoningEffort,
	normalizeLegacyUltra,
	REASONING_EFFORT_VALUES,
	type ReasoningEffort,
} from "@shared/reasoning-effort";
import {
	claudeVersionAtLeast,
	GENERIC_REASONING_EFFORT_TIERS,
	isCodexReasoningRoute,
	isGpt62CodexModel,
	modelAcceptsReasoningEffort,
	parseClaudeModel,
	type ReasoningEffortBlocklistEntry,
	resolveRouteReasoning,
} from "@shared/reasoning-effort-support";
import { useCallback, useMemo } from "react";
import type { ModelOption } from "../../../lib/constants";

/**
 * Reasoning tiers a resolved catalog card declares, ascending, never `none`. A card that
 * matched nothing, or declares no tier, is not evidence about the model's tiers.
 */
export function catalogEffortTiers(card: ModelCard | null | undefined): ReasoningEffort[] | null {
	if (!card || card.matchedVia === "none") return null;
	const tiers = modelProfile(card).reasoning.levels?.filter(
		(level): level is ReasoningEffort =>
			level !== "none" && REASONING_EFFORT_VALUES.includes(level as ReasoningEffort),
	);
	return tiers?.length ? tiers : null;
}

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
	"gpt-6.1-sol": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
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

/** Minimal settings surface this hook reads. */
export interface ModelSelectionSettings {
	codexAvailable?: boolean;
	openaiProviders?: Array<{ prefix?: string; apiMode?: string }>;
	anthropicProviders?: Array<{ prefix?: string }>;
	geminiProviders?: Array<{ prefix?: string }>;
	agent?: {
		reasoningEffortBlocklist?: readonly ReasoningEffortBlocklistEntry[] | null;
		defaultReasoningEffort?: string;
		modelProtocolOverrides?: Record<string, string>;
		modelProtocols?: Record<string, string>;
	};
}

/**
 * Whether a reasoning-effort menu is offered at all, and which tiers it lists.
 * Session-independent: a composer that creates the session on send needs the same
 * answer as the status bar of a narrator that already exists.
 */
export interface ReasoningEffortSupport {
	supportsReasoningEffort: boolean;
	reasoningEffortOptions: readonly ReasoningEffortValue[];
}

/** Providers whose models always accept a thinking tier, whatever the model id. */
export function resolveCodexCapableProviders(
	settingsData: ModelSelectionSettings | undefined,
): Set<string> {
	const providers = new Set<string>();
	if (settingsData?.codexAvailable) providers.add("codex");
	for (const provider of settingsData?.openaiProviders ?? []) {
		if (provider?.prefix && (provider.apiMode ?? "responses") === "codex") {
			providers.add(provider.prefix);
		}
	}
	return providers;
}

/** Reasoning metadata from the bounded runtime projection, without reading a catalog card. */
export function runtimeReasoningEffortSupport(
	summary: RuntimeModelSummary,
): ReasoningEffortSupport {
	const declared = summary.reasoning;
	const local = summary.provenance?.reasoning?.startsWith("local-") === true;
	const levels =
		!local && Array.isArray(summary.effortLevels) ? summary.effortLevels : declared.levels;
	return reasoningMenu({ ...declared, levels }, summary.state !== "not-observed");
}

function reasoningMenu(declared: ModelReasoning, hasConcreteModel = true): ReasoningEffortSupport {
	const levels = declared.levels;
	const valid = (levels ?? []).filter((level): level is ReasoningEffort =>
		REASONING_EFFORT_VALUES.includes(level as ReasoningEffort),
	);
	const fixed = declared.mode === "fixed" || (Array.isArray(levels) && valid.length === 0);
	if (fixed) {
		// Fixed intensity can still expose an independent off switch. Clearing the
		// override uses the existing follow-default action, never a fabricated tier.
		const toggleable =
			hasConcreteModel && declared.supported !== false && declared.canDisable === true;
		return {
			supportsReasoningEffort: toggleable,
			reasoningEffortOptions: toggleable ? ["none"] : [],
		};
	}
	const supportsReasoningEffort = hasConcreteModel && declared.supported !== false;
	if (!supportsReasoningEffort) return { supportsReasoningEffort, reasoningEffortOptions: [] };
	const tiers = valid.length ? valid : GENERIC_REASONING_EFFORT_TIERS;
	const reasoningEffortOptions = REASONING_EFFORT_VALUES.filter((level) =>
		level === "none" ? declared.canDisable !== false : tiers.includes(level),
	);
	return { supportsReasoningEffort: reasoningEffortOptions.length > 0, reasoningEffortOptions };
}

/** Display-only enabled state: never send it as a reasoning-effort override. */
export function displayReasoningEffort(
	desired: string,
	options: readonly ReasoningEffort[],
): string {
	if (options.length === 1 && options[0] === "none") {
		return desired === "none" ? "none" : "enabled";
	}
	return clampReasoningEffort(desired as ReasoningEffort, options);
}

function selectionUsesCodex(
	model: string,
	bareModel: string,
	option: ModelOption | undefined,
	settingsData: ModelSelectionSettings | undefined,
	codexCapableProviders: ReadonlySet<string>,
): boolean {
	const provider = model.split(":")[0];
	return isCodexReasoningRoute(
		provider,
		codexCapableProviders.has(provider),
		option?.channelType ?? (bareModel.startsWith("codex:") ? "codex" : undefined),
		settingsData?.agent?.modelProtocolOverrides?.[model] ??
			settingsData?.agent?.modelProtocols?.[model],
	);
}

/**
 * Resolve the reasoning-effort menu for one model reference.
 *
 * Pure on purpose: {@link useModelSelection} derives a live narrator's menu from
 * it, and the dashboard composer derives a not-yet-created session's menu from
 * the same code, so the two can never disagree about a model.
 */
export function resolveReasoningEffortSupport(args: {
	resolvedModel: string;
	resolvedBareModel: string;
	resolvedModelOption: ModelOption | undefined;
	settingsData: ModelSelectionSettings | undefined;
	modelCard: ModelCard | null | undefined;
	codexCapableProviders: ReadonlySet<string>;
	modelSummary?: RuntimeModelSummary;
}): ReasoningEffortSupport {
	if (args.modelSummary) return runtimeReasoningEffortSupport(args.modelSummary);
	const {
		resolvedModel,
		resolvedBareModel,
		resolvedModelOption,
		settingsData,
		modelCard,
		codexCapableProviders,
	} = args;
	const codex = selectionUsesCodex(
		resolvedModel,
		resolvedBareModel,
		resolvedModelOption,
		settingsData,
		codexCapableProviders,
	);
	const bareModel = getBareModelForReasoning(resolvedModel, resolvedModelOption);
	const routeLevels = resolvedModelOption?.effortLevels;
	const levelsLayer = modelCard?.provenance.reasoning_effort_levels?.layer;
	if (
		Array.isArray(routeLevels) ||
		(codex && isGpt62CodexModel(bareModel)) ||
		levelsLayer?.startsWith("local-") ||
		levelsLayer === "discovered" ||
		levelsLayer === "preset-variant" ||
		(modelCard != null && modelProfile(modelCard).reasoning.mode === "fixed")
	) {
		return reasoningMenu(
			resolveRouteReasoning(modelCard ? modelProfile(modelCard).reasoning : {}, modelCard, {
				codexModel: codex ? bareModel : undefined,
				effortLevels: routeLevels,
			}),
		);
	}

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
	const supportsReasoningEffort = (() => {
		const providerPrefix = resolvedModel?.split(":")[0];
		if (!providerPrefix) return false;
		// Older Codex routes without concrete evidence retain their historical defaults.
		if (codex) return true;
		return modelAcceptsReasoningEffort(
			getBareModelForReasoning(resolvedModel, resolvedModelOption),
			settingsData?.agent?.reasoningEffortBlocklist,
		);
	})();

	const reasoningEffortOptions = ((): readonly ReasoningEffortValue[] => {
		if (!resolvedModel) return GENERIC_REASONING_EFFORT_TIERS;
		// Missing catalog data is not evidence that a new model lacks a tier.
		if (!modelCard || modelCard.matchedVia === "none") return GENERIC_REASONING_EFFORT_TIERS;
		// Catalog tiers: the editable replacement for the hardcoded per-model tables.
		// `none` is appended here rather than stored in the catalog, because there it
		// would become a clamp target able to silently turn a requested `low` into
		// thinking switched off.
		const cardTiers = catalogEffortTiers(modelCard);
		if (cardTiers?.length) {
			return modelProfile(modelCard).reasoning.canDisable !== false &&
				codexModelSupportsReasoningDisabled(resolvedModel, resolvedModelOption)
				? (["none", ...cardTiers] as readonly ReasoningEffortValue[])
				: (cardTiers as readonly ReasoningEffortValue[]);
		}
		const providerPrefix = resolvedModel.split(":")[0];
		if (codex) {
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
	})();

	return { supportsReasoningEffort, reasoningEffortOptions };
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
	/**
	 * A `__parent__` subagent's parent override. With no override of its own the
	 * child follows this tier rather than the global default.
	 */
	inheritedReasoningEffort?: string | null;
	settingsData: ModelSelectionSettings | undefined;
	/** The catalog card the effective model resolves to (server-side, provider-aware). */
	modelCard?: ModelCard | null;
	modelSummary?: RuntimeModelSummary;
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
		inheritedReasoningEffort,
		settingsData,
		modelCard,
		modelSummary,
		reasoningEffortMutation,
		updateSettingsMutation,
	} = options;

	const codexCapableProviders = useMemo(
		() => resolveCodexCapableProviders(settingsData),
		[settingsData],
	);
	const supportsCodexControls = modelSummary
		? modelSummary.capabilities?.channelType === "codex"
		: selectionUsesCodex(
				resolvedModel,
				resolvedBareModel,
				resolvedModelOption,
				settingsData,
				codexCapableProviders,
			);
	const isCodexChannelModel = supportsCodexControls;
	const isBuiltInCodexModel = resolvedModel?.split(":")[0] === "codex";

	const { supportsReasoningEffort, reasoningEffortOptions } = useMemo(
		() =>
			resolveReasoningEffortSupport({
				resolvedModel,
				resolvedBareModel,
				resolvedModelOption,
				settingsData,
				modelCard,
				modelSummary,
				codexCapableProviders,
			}),
		[
			codexCapableProviders,
			modelCard,
			modelSummary,
			resolvedBareModel,
			resolvedModel,
			resolvedModelOption,
			settingsData,
		],
	);

	// The global default reasoning effort (single source of truth). Applied to
	// every model when the narrator has no explicit override.
	const globalDefaultReasoningEffort = useMemo<ReasoningEffort>(() => {
		const raw = settingsData?.agent?.defaultReasoningEffort;
		return normalizeLegacyUltra(raw as ReasoningEffort | undefined) || "max";
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
			? ((inheritedReasoningEffort as ReasoningEffort | null | undefined) ??
				globalDefaultReasoningEffort)
			: (narratorReasoningEffort as ReasoningEffort);
		if (!desired) return "";
		const source =
			modelSummary?.provenance?.reasoning ?? modelCard?.provenance.reasoning_effort_levels?.layer;
		const legacyModel =
			!Array.isArray(resolvedModelOption?.effortLevels) &&
			(source === "preset-model" || source === "preset-variant")
				? (modelSummary?.resolvedBareModel ?? modelCard?.modelId)
				: undefined;
		return displayReasoningEffort(
			opts.length === 1 && opts[0] === "none"
				? desired
				: migrateLegacyReasoningEffort(legacyModel, normalizeLegacyUltra(desired), opts),
			opts,
		);
	}, [
		resolvedModelOption,
		modelCard,
		modelSummary,
		narratorReasoningEffort,
		reasoningEffortOptions,
		reasoningFollowsDefault,
		inheritedReasoningEffort,
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
		const desired = normalizeLegacyUltra(narratorReasoningEffort);
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
