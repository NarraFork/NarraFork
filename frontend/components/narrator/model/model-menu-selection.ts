import type { MenuProps } from "@mantine/core";
import {
	AGG_MODEL_PREFIX,
	buildAggModelValue,
	FOLLOW_DEFAULT_MODEL,
	FOLLOW_PARENT_MODEL,
	FOLLOW_SUMMARY_MODEL,
	type ModelAggregation,
	parseAggModelValue,
} from "../../../lib/constants";

/**
 * Provider prefix of a concrete `provider:model` value, for the small secondary
 * line under the Default/Summary rows. Those rows sit under a role header
 * ("Default" / "Summary") rather than a provider group, so the model name alone
 * does not say who serves it.
 *
 * Returns null for empty values and meta sentinels (aggregations, follow-*),
 * which have no single provider.
 */
export function modelProviderPrefix(value: string | null | undefined): string | null {
	if (!value || value.startsWith(AGG_MODEL_PREFIX)) return null;
	if (
		value === FOLLOW_DEFAULT_MODEL ||
		value === FOLLOW_SUMMARY_MODEL ||
		value === FOLLOW_PARENT_MODEL
	) {
		return null;
	}
	const idx = value.indexOf(":");
	return idx > 0 ? value.slice(0, idx) : null;
}

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
