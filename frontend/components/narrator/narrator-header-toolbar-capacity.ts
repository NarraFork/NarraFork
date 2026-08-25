/**
 * How many tool entries the narrator header row can show inline.
 *
 * The header used to render EVERY surfaced entry on desktop and let the title
 * absorb the shortfall (`visibleLimit: null`). With a dozen entries that meant
 * the title compressed without a floor — down to two or three characters — while
 * the icon row kept its full width. Suppressing the title entirely inside a
 * graph node (`hostOwnsTitle`) was a workaround for exactly this, not a fix.
 *
 * Two rules are inherited from `NarratorStatusToolbar`, which already solved the
 * same class of problem for the status row. Both were learned the hard way:
 *
 *  1. The budget must NOT come from the toolbar's own width. If it did,
 *     collapsing one entry would shrink the row, shrink the budget, and cascade
 *     until a single button was left. The budget comes from the header ROW,
 *     whose width is independent of the decision.
 *  2. Restoring an entry needs a hysteresis margin. Sub-pixel measurements,
 *     scrollbars appearing and font swaps all flip the decision back and forth
 *     around an exact threshold.
 *
 * A third rule is specific to this row: item widths are CONSTANTS, not
 * measurements. Every registry entry renders as an `ActionIcon size="sm"` (an
 * `Indicator` wrapper does not change the inline size), so measuring them would
 * only reintroduce "how many are currently inline" as an input and break the
 * fixed point. A guard test keeps the `size="sm"` premise honest.
 */

/** Rendered box of `ActionIcon size="sm"` (--ai-size-sm = 1.375rem). */
export const HEADER_TOOLBAR_ITEM_WIDTH_PX = 22;

/**
 * `Group gap="xs"` (--mantine-spacing-xs = 0.625rem). Only a fallback: the real
 * gap is read from the computed `column-gap` when available, since a theme may
 * scale spacing.
 */
export const HEADER_TOOLBAR_GAP_PX = 10;

/**
 * Width the title keeps for itself before any entry collapses. Roughly ten CJK
 * characters plus an ellipsis — enough to tell two narrators apart, which is the
 * whole job of the title.
 *
 * Deliberately larger than the status row's `NARRATOR_STATUS_RESERVED_TEXT_WIDTH_PX`
 * (96): that reserve holds short status words, this one holds a free-form,
 * model-generated title.
 */
export const HEADER_TITLE_MIN_WIDTH_PX = 140;

/** Extra width required before a collapsed entry returns to the row. */
const RESTORE_HYSTERESIS_PX = 12;

/** Marks the title slot, whose width is budgeted by policy, not measured. */
export const HEADER_TITLE_SLOT_ATTR = "data-header-title-slot";

/**
 * Marks a trailing control that is always present regardless of the capacity
 * decision (overflow trigger, close button, debug entry). Such a control is safe
 * to MEASURE precisely because its presence does not depend on the result.
 */
export const HEADER_TOOLBAR_FIXED_ATTR = "data-header-toolbar-fixed";

export interface ResolveHeaderToolbarCapacityOptions {
	/** Width available to the collapsible entries, from {@link resolveHeaderToolbarBudget}. */
	budgetWidth: number;
	/** Number of candidate entries. */
	itemCount: number;
	itemWidth?: number;
	gap?: number;
	/** Current decision, used to apply restore hysteresis. */
	previousCapacity?: number | null;
	restoreHysteresis?: number;
}

/**
 * Largest entry count that fits the budget.
 *
 * Scans candidate layouts from "keep everything" downwards and takes the first
 * that fits, so the answer is a pure function of the budget: the same width
 * always yields the same capacity, and widening restores entries deterministically.
 */
export function resolveHeaderToolbarCapacity({
	budgetWidth,
	itemCount,
	itemWidth = HEADER_TOOLBAR_ITEM_WIDTH_PX,
	gap = HEADER_TOOLBAR_GAP_PX,
	previousCapacity,
	restoreHysteresis = RESTORE_HYSTERESIS_PX,
}: ResolveHeaderToolbarCapacityOptions): number {
	if (itemCount <= 0) return 0;
	if (!Number.isFinite(budgetWidth) || budgetWidth <= 0) return 0;

	for (let keep = itemCount; keep > 0; keep--) {
		const need = keep * itemWidth + (keep - 1) * gap;
		// Growing the row must clear the requirement by the margin; shrinking only
		// needs to fit, so a genuinely too-narrow row collapses immediately.
		const margin = previousCapacity != null && keep > previousCapacity ? restoreHysteresis : 0;
		if (need + margin <= budgetWidth) return keep;
	}

	return 0;
}

function computedStyleOf(element: Element): CSSStyleDeclaration | null {
	if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return null;
	try {
		return window.getComputedStyle(element);
	} catch {
		return null;
	}
}

function paddingInlineOf(element: Element): number {
	const styles = computedStyleOf(element);
	return (
		(Number.parseFloat(styles?.paddingLeft ?? "") || 0) +
		(Number.parseFloat(styles?.paddingRight ?? "") || 0)
	);
}

function inlineGapOf(element: Element, fallback: number): number {
	const styles = computedStyleOf(element);
	const gap = Number.parseFloat(styles?.columnGap ?? "");
	return Number.isFinite(gap) ? gap : fallback;
}

function widthOf(element: Element): number {
	const el = element as HTMLElement;
	if (typeof el.getBoundingClientRect !== "function") return 0;
	return el.getBoundingClientRect().width;
}

/** Minimal shape needed to decide collapse order; satisfied by NarratorToolbarItemDef. */
export interface HeaderToolbarCandidate {
	id: string;
	/** A control that opens its own menu and cannot be activated from the overflow list. */
	selfContained?: boolean;
}

export interface HeaderToolbarSelection<T> {
	/** Entries to render inline, in layout order. */
	visible: T[];
	/** Entries not on the row, in layout order. */
	hidden: T[];
}

/**
 * Choose which entries stay on the row for a given capacity.
 *
 * Collapsing walks backwards through the layout order — the reader put the tools
 * they reach for most at the front — with ONE exception: a self-contained control
 * (device picker, detail level, plugin picker) is dropped last.
 *
 * That exception is not cosmetic. Those controls open their own menu from the
 * header; the overflow list can only show them as a labelled row with a
 * "header only" hint, because Mantine v7 has no submenu and nesting a Menu inside
 * a dropdown is unreliable (see CompactMenuSub). They also sit at the END of the
 * default order, so without this rule the first thing a narrow desktop row would
 * collapse is the handful of entries that then become unreachable altogether.
 *
 * A reader may still tuck them away explicitly — there the hint is the truth
 * ("this one only works from the header"), and dragging it back restores it.
 */
export function selectHeaderToolbarEntries<T extends HeaderToolbarCandidate>(
	defs: readonly T[],
	capacity: number | null,
): HeaderToolbarSelection<T> {
	if (capacity == null || capacity >= defs.length) return { visible: [...defs], hidden: [] };

	const keep = Math.max(0, capacity);
	const dropCount = defs.length - keep;
	const dropOrder = [
		// Activatable entries, last in layout order first.
		...defs.filter((def) => def.selfContained !== true).reverse(),
		// Then the ones with no overflow fallback, also last-first.
		...defs.filter((def) => def.selfContained === true).reverse(),
	];
	const dropped = new Set(dropOrder.slice(0, dropCount).map((def) => def.id));

	return {
		visible: defs.filter((def) => !dropped.has(def.id)),
		hidden: defs.filter((def) => dropped.has(def.id)),
	};
}

export interface ResolveHeaderToolbarBudgetOptions {
	/** The header row. Its width does not depend on the decision, so it is the budget source. */
	row: HTMLElement;
	/** Container of the collapsible entries plus the fixed trailing controls. */
	toolbar: HTMLElement;
	/** Leading group (navigation button, title slot, connection badge). */
	leading: HTMLElement;
	/**
	 * Width reserved for the title slot. Pass 0 when the host draws the title
	 * itself (`hostOwnsTitle`), so the entries may claim that space.
	 */
	titleSlotMinWidth: number;
	gap?: number;
}

/**
 * Width the collapsible entries may occupy.
 *
 * Everything subtracted here is independent of how many entries are currently
 * inline: the row's own content box, the leading controls (measured, except the
 * title slot which is budgeted by policy because it grows to fill) and the fixed
 * trailing controls (measured — they are always rendered).
 */
export function resolveHeaderToolbarBudget({
	row,
	toolbar,
	leading,
	titleSlotMinWidth,
	gap = HEADER_TOOLBAR_GAP_PX,
}: ResolveHeaderToolbarBudgetOptions): number {
	const rowWidth = widthOf(row);
	if (rowWidth <= 0) return 0;

	const rowGap = inlineGapOf(row, gap);
	// The row lays out leading + toolbar, so one gap sits between them.
	let budget = rowWidth - paddingInlineOf(row) - rowGap;

	const leadingGap = inlineGapOf(leading, gap);
	const leadingChildren = [...leading.children];
	for (const child of leadingChildren) {
		// A slot that grows to fill would report a width derived from whatever the
		// toolbar left over, so it must be budgeted by policy, never measured.
		budget -= child.hasAttribute(HEADER_TITLE_SLOT_ATTR) ? titleSlotMinWidth : widthOf(child);
	}
	budget -= Math.max(0, leadingChildren.length - 1) * leadingGap;
	budget -= paddingInlineOf(leading);

	const toolbarGap = inlineGapOf(toolbar, gap);
	for (const child of toolbar.children) {
		if (!child.hasAttribute(HEADER_TOOLBAR_FIXED_ATTR)) continue;
		// Each fixed control also consumes the gap that precedes it.
		budget -= widthOf(child) + toolbarGap;
	}
	budget -= paddingInlineOf(toolbar);

	return Math.max(0, budget);
}
