import type { MenuProps } from "@mantine/core";
import {
	buildAggModelValue,
	FOLLOW_DEFAULT_MODEL,
	FOLLOW_PARENT_MODEL,
	FOLLOW_SUMMARY_MODEL,
	type ModelAggregation,
	type ModelOption,
	parseAggModelValue,
} from "../../../lib/constants";

/**
 * Provider prefix of a concrete `provider:model` value, for the small secondary
 * line under the Default/Summary rows. Those rows sit under a role header
 * ("Default" / "Summary") rather than a provider group, so the model name alone
 * does not say who serves it. Lives with the shared model search rules, which
 * match those rows by the same prefix.
 */
export { modelProviderPrefix } from "../../../lib/model-search";

/**
 * Whether a model-menu entry may be written into the instance-wide default or
 * summary model slots. Meta sentinels are excluded: assigning "follow default"
 * as the default model (or "follow summary" as either slot) creates a circular
 * definition the resolver cannot break. "Follow parent" is subagent-only and
 * has no meaning in an instance-wide slot.
 *
 * Concretely selectable models and aggregation roots are allowed; indented
 * aggregation members are not menu entries with their own roles — selecting one
 * pins that member on the narrator session instead.
 */
export function canAssignGlobalModelRole(value: string | null | undefined): boolean {
	if (!value) return false;
	return (
		value !== FOLLOW_DEFAULT_MODEL &&
		value !== FOLLOW_SUMMARY_MODEL &&
		value !== FOLLOW_PARENT_MODEL
	);
}

export function modelMenuSelection(
	currentModel: string | null | undefined,
	aggregations: ModelAggregation[],
) {
	const value = currentModel || FOLLOW_DEFAULT_MODEL;
	const parsed = parseAggModelValue(value);
	const aggregation = parsed ? aggregations.find((item) => item.id === parsed.aggId) : undefined;
	const members = aggregation?.models ?? [];
	const baseValue = parsed ? buildAggModelValue(parsed.aggId) : value;
	return {
		value,
		baseValue,
		members,
		// A removed pinned member still leaves its aggregation visible.
		targetValue: parsed?.pinnedModel && !members.includes(parsed.pinnedModel) ? baseValue : value,
	};
}

/**
 * Role groups that stay pinned above the provider groups, in this exact order.
 * Default and Summary are the current selection; Auto (`auto:<model>`) and
 * Aggregations are virtual catalogs rather than providers. All four titles are
 * translated, so leaving any of them in the alphabetical pass would move that
 * group when the UI language changes.
 */
const FIXED_MODEL_GROUP_ORDER: readonly string[] = [
	"__default__",
	"__summary__",
	"__auto__",
	"__agg__",
];

/** Group key prefix for auto models of one vendor family (`__auto__:claude`). */
export const AUTO_FAMILY_GROUP_PREFIX = "__auto__:";

/** How the catalog's family ids are written for people; others are title-cased. */
const FAMILY_LABELS: Record<string, string> = {
	gpt: "GPT",
	claude: "Claude",
	gemini: "Gemini",
	glm: "GLM",
	grok: "Grok",
	deepseek: "DeepSeek",
	kimi: "Kimi",
	minimax: "MiniMax",
	cursor: "Cursor",
};

export function familyLabel(family: string): string {
	return FAMILY_LABELS[family] ?? `${family.charAt(0).toUpperCase()}${family.slice(1)}`;
}

/**
 * Order model-menu groups: the fixed role groups first (in
 * FIXED_MODEL_GROUP_ORDER order), then every remaining group alphabetically by
 * its display label.
 *
 * Labels rather than raw provider prefixes are compared, because the list the
 * user reads is the label column: sorting by prefix would put "xiaomi" before
 * "Xiaomi" and scatter gateway ids that do not match their brand name.
 */
export function orderModelGroupEntries<T>(
	entries: ReadonlyArray<readonly [string, T]>,
	labelOf: (provider: string) => string,
): Array<readonly [string, T]> {
	// Vendor groups of auto models (`__auto__:<family>`) take the `__auto__` slot.
	const fixedRank = (provider: string) =>
		FIXED_MODEL_GROUP_ORDER.indexOf(
			provider.startsWith(AUTO_FAMILY_GROUP_PREFIX) ? "__auto__" : provider,
		);
	return [...entries].sort(([a], [b]) => {
		const rankA = fixedRank(a);
		const rankB = fixedRank(b);
		if (rankA !== -1 || rankB !== -1) {
			if (rankA === -1) return 1;
			if (rankB === -1) return -1;
			if (rankA !== rankB) return rankA - rankB;
			// Two vendor groups: by label, with "other models" (no family) last.
			const otherA = a === AUTO_FAMILY_GROUP_PREFIX;
			const otherB = b === AUTO_FAMILY_GROUP_PREFIX;
			if (otherA !== otherB) return otherA ? 1 : -1;
			return labelOf(a).localeCompare(labelOf(b));
		}
		return labelOf(a).localeCompare(labelOf(b));
	});
}

/** Never shrink the dropdown below this, even if the visible area is tiny. */
const MODEL_MENU_MIN_HEIGHT_PX = 96;
/** Upper bound matching the historical fixed cap on large screens. */
const MODEL_MENU_MAX_HEIGHT = "60vh";

/**
 * Clamp a model dropdown's height to the space the viewport actually has.
 *
 * A fixed `60vh` cap is measured against the layout viewport, which the mobile
 * virtual keyboard does not shrink. Once the search field is focused the
 * keyboard covers the lower part of the dropdown, and because the search field
 * is a sticky footer it is the first thing to disappear — the user is typing
 * into an input they can no longer see. floating-ui's `size` middleware reads
 * the visual viewport, so `availableHeight` already excludes the keyboard, and
 * the sticky footer stays on screen at the bottom of the clamped dropdown.
 */
export function applyModelMenuMaxHeight(floating: HTMLElement, availableHeight: number) {
	const available = Math.max(MODEL_MENU_MIN_HEIGHT_PX, Math.floor(availableHeight));
	floating.style.maxHeight = `min(${MODEL_MENU_MAX_HEIGHT}, ${available}px)`;
}

/**
 * Props shared by every model dropdown `<Menu>`.
 *
 * `preventPositionChangeWhenVisible: false` lets the dropdown flip sides while
 * open: when the keyboard appears the side it opened on may no longer have room,
 * and a placement locked at open time would leave it squeezed under the keyboard
 * even though the other side of the trigger is free.
 */
export const MODEL_MENU_POSITIONING = {
	preventPositionChangeWhenVisible: false,
	middlewares: {
		flip: true,
		shift: true,
		size: {
			padding: 8,
			apply({ elements, availableHeight }) {
				applyModelMenuMaxHeight(elements.floating, availableHeight);
			},
		},
	},
} satisfies Pick<MenuProps, "preventPositionChangeWhenVisible" | "middlewares">;

/**
 * Touch devices open the virtual keyboard on focus, which on Android happens even
 * for the programmatic focus that follows a tap. Auto-focusing the search field
 * there would pop the keyboard over the list the user opened the menu to browse.
 */
export function shouldAutoFocusModelFilter(targetWindow: Window = window): boolean {
	return targetWindow.matchMedia?.("(hover: none), (pointer: coarse)").matches !== true;
}

/** Scroll only the dropdown, leaving the page and message list untouched. */
export function centerModelMenuSelection(
	container: HTMLElement,
	item: HTMLElement,
	footerHeight: number,
) {
	const viewport = container.getBoundingClientRect();
	const row = item.getBoundingClientRect();
	const visibleHeight = Math.max(0, container.clientHeight - footerHeight);
	container.scrollTop = Math.max(
		0,
		Math.min(
			container.scrollHeight - container.clientHeight,
			container.scrollTop +
				row.top -
				viewport.top -
				container.clientTop -
				(visibleHeight - row.height) / 2,
		),
	);
}

/**
 * Reference price of an `auto:` source, as "$X / 1M tokens" text (input + output per million).
 * Null when the catalog has no price for it; such a source is never shown as free.
 */
export function formatReferencePrice(perMillion: number | undefined): string | null {
	if (perMillion === undefined || !Number.isFinite(perMillion) || perMillion < 0) return null;
	const digits = perMillion >= 10 ? 0 : perMillion >= 1 ? 1 : 2;
	return `$${perMillion.toFixed(digits)}`;
}

/**
 * Why "auto" uses its current source, in the order routing ranks them: unavailable sources go
 * last, subscriptions come first, then the lowest reference price.
 */
export function autoChoiceReason(
	sources: ReadonlyArray<{
		provider: string;
		available: boolean;
		subscription: boolean;
		referencePrice?: number;
	}>,
	providerLabels: Record<string, string>,
	t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
	const choice = sources.find((source) => source.available) ?? sources[0];
	if (!choice) return null;
	const provider = providerLabels[choice.provider] ?? choice.provider;
	if (!choice.available) return t("autoReasonNoneAvailable", { provider });
	if (choice.subscription) return t("autoReasonSubscription", { provider });
	// "Cheapest" only when it was compared on price with another pay-per-use source.
	const priced = sources.filter(
		(source) => source.available && !source.subscription && source.referencePrice !== undefined,
	);
	return t(
		choice.referencePrice !== undefined && priced.length > 1
			? "autoReasonCheapest"
			: "autoReasonFirst",
		{ provider },
	);
}

/**
 * Group the picker's options: auto models by vendor family, everything else by service.
 *
 * Every service keeps all of its models, including those an auto row also lists as a
 * source. The two never share one list: the model view shows only auto rows (through
 * ModelSourceBrowser) and the provider view shows only service groups, so dropping a
 * covered model from its service would remove it from the provider view altogether, and
 * a service whose every model is in the catalog would vanish from the picker.
 */
export function groupModelOptions(options: readonly ModelOption[]): Map<string, ModelOption[]> {
	const groups = new Map<string, ModelOption[]>();
	const push = (key: string, option: ModelOption) => {
		const list = groups.get(key);
		if (list) list.push(option);
		else groups.set(key, [option]);
	};
	for (const option of options) {
		if (option.autoSources) {
			push(`${AUTO_FAMILY_GROUP_PREFIX}${option.family ?? ""}`, option);
			continue;
		}
		push(option.provider ?? "unknown", option);
	}
	return groups;
}
