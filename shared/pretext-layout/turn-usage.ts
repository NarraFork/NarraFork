/**
 * turn-usage.ts — Per-turn token/cost formatting, shared by both message lists.
 *
 * The chunked renderer paints these strings directly in JSX; the exact vlist has
 * to MEASURE them first (they occupy real xs text lines above/below an assistant
 * message). Keeping one implementation here is what guarantees the two paths show
 * the same numbers — a second copy would be free to drift the moment a provider
 * adds a usage field.
 *
 * Pure: no React, no DOM, no i18n runtime. Number grouping is injected by the
 * caller (`formatNumber`) so the frontend can pass its locale-aware formatter
 * while tests stay deterministic.
 */

/** Usage payload as persisted on a message (`turnUsageJson`). */
export interface TurnUsageJson {
	prompt_tokens?: number;
	input_tokens?: number;
	output_tokens?: number;
	cached_input_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_creation_5m_tokens?: number;
	cache_creation_1h_tokens?: number;
	reasoning_tokens?: number;
	[key: string]: unknown;
}

/** Number → display string. Injected so the caller owns locale grouping. */
export type UsageNumberFormatter = (value: number) => string;

const identityFormat: UsageNumberFormatter = (value) => String(value);

function usageNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageNumberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Total prompt footprint for a turn.
 *
 * `prompt_tokens` (when a provider reports it) already includes cached reads and
 * cache writes; otherwise it is reconstructed from the parts. Returns null when
 * the payload carries no input accounting at all, which is how callers decide
 * whether to draw the leading `↑` line.
 */
export function getPromptTokenFootprint(
	turnUsageJson: TurnUsageJson | null | undefined,
): number | null {
	if (!turnUsageJson) return null;
	const promptTokens = usageNumberOrNull(turnUsageJson.prompt_tokens);
	if (promptTokens != null) return promptTokens;
	const inputTokens = usageNumberOrNull(turnUsageJson.input_tokens);
	if (inputTokens == null) return null;
	return (
		inputTokens +
		usageNumber(turnUsageJson.cached_input_tokens) +
		usageNumber(turnUsageJson.cache_creation_input_tokens)
	);
}

/**
 * The ` · `-joined parts of a turn's usage summary, or null when there is no
 * payload. Optional parts (cache hit / cache write / reasoning) appear only when
 * non-zero, so the resulting line length — and therefore the measured width — is
 * data-dependent while the LINE COUNT stays 1 (the row is clamped).
 */
export function formatTurnUsageParts(
	turnUsageJson: TurnUsageJson | null | undefined,
	formatNumber: UsageNumberFormatter = identityFormat,
): string[] | null {
	if (!turnUsageJson) return null;
	const inputTokens = usageNumber(turnUsageJson.input_tokens);
	const outputTokens = usageNumber(turnUsageJson.output_tokens);
	const promptTokens = getPromptTokenFootprint(turnUsageJson) ?? inputTokens;
	const cachedTokens = usageNumber(turnUsageJson.cached_input_tokens);
	const cacheCreationTokens = usageNumber(turnUsageJson.cache_creation_input_tokens);
	const cache5mTokens = usageNumber(turnUsageJson.cache_creation_5m_tokens);
	const cache1hTokens = usageNumber(turnUsageJson.cache_creation_1h_tokens);
	const reasoningTokens = usageNumber(turnUsageJson.reasoning_tokens);

	const parts = [
		`Σ ${formatNumber(promptTokens)} ctx`,
		`${formatNumber(inputTokens)} in`,
		`${formatNumber(outputTokens)} out`,
	];
	if (cachedTokens > 0) parts.push(`${formatNumber(cachedTokens)} cache hit`);
	if (cacheCreationTokens > 0) {
		const detail =
			cache5mTokens > 0 || cache1hTokens > 0
				? ` (${formatNumber(cache5mTokens)} 5m / ${formatNumber(cache1hTokens)} 1h)`
				: "";
		parts.push(`${formatNumber(cacheCreationTokens)} cache write${detail}`);
	}
	if (reasoningTokens > 0) parts.push(`${formatNumber(reasoningTokens)} reasoning`);
	return parts;
}

/** Cost string (`$0.1234`) when a positive cost was recorded, else null. */
export function formatTurnUsageCost(costUsd: number | null | undefined): string | null {
	return typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0
		? `$${costUsd.toFixed(4)}`
		: null;
}

/** Credits string for metered providers that report no token counts. */
export function formatMeterUsage(meterUsage: number | null | undefined): string | null {
	return typeof meterUsage === "number" && Number.isFinite(meterUsage)
		? `${meterUsage.toFixed(2)} credits`
		: null;
}

/** The message fields the usage lines are derived from. */
export interface TurnUsageSource {
	role?: string;
	turnUsageJson?: TurnUsageJson | null;
	tokensIn?: number | null;
	costUsd?: number | null;
	meterUsage?: number | null;
}

/**
 * The resolved usage lines for one message, or null when nothing should be drawn.
 *
 * Mirrors the chunked renderer's two conditions exactly:
 *  - `leading` (above the bubble): assistant + (a prompt footprint OR metered usage)
 *  - `trailing` (below the bubble): a usage summary OR metered usage with no footprint
 *
 * `trailingSecondary` is the mobile split: the chunked path shows the first three
 * parts on one line and the rest plus the cost on a second. The zero-DOM height
 * model cannot see CSS breakpoints, so the CALLER decides `mobile` and the line
 * count becomes an explicit part of the measured shape.
 */
export interface TurnUsageLines {
	/** Right-aligned line above the message body. */
	leading: string | null;
	/** Right-aligned line below the message body. */
	trailing: string | null;
	/** Second trailing line (mobile only); null when everything fits one line. */
	trailingSecondary: string | null;
}

export function resolveTurnUsageLines(
	message: TurnUsageSource,
	options: { mobile?: boolean; formatNumber?: UsageNumberFormatter } = {},
): TurnUsageLines | null {
	const formatNumber = options.formatNumber ?? identityFormat;
	const isAssistant = message.role === "assistant";
	const footprint = getPromptTokenFootprint(message.turnUsageJson) ?? message.tokensIn ?? null;
	const credits = formatMeterUsage(message.meterUsage);
	const parts = formatTurnUsageParts(message.turnUsageJson, formatNumber);
	const cost = formatTurnUsageCost(message.costUsd);

	const leading =
		isAssistant && footprint != null
			? `↑ ${formatNumber(footprint)}`
			: isAssistant && credits != null
				? credits
				: null;

	// The summary wins; credits only stand in when no footprint was reported (the
	// same precedence the chunked renderer applies).
	let trailing: string | null = null;
	let trailingSecondary: string | null = null;
	if (parts != null) {
		if (options.mobile) {
			trailing = parts.slice(0, 3).join(" · ");
			const rest = parts.slice(3);
			if (cost != null) rest.push(cost);
			trailingSecondary = rest.length > 0 ? rest.join(" · ") : null;
		} else {
			trailing = cost != null ? `${parts.join(" · ")} · ${cost}` : parts.join(" · ");
		}
	} else if (credits != null && footprint == null) {
		trailing = credits;
	}

	if (leading == null && trailing == null) return null;
	return { leading, trailing, trailingSecondary };
}
