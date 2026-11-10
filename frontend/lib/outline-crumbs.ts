/**
 * Which ancestors the outline's breadcrumbs show (`OutlineBreadcrumbs`): the bar is one line,
 * always, so a deep path keeps its two ends and folds the middle into one "…" entry that lists
 * what it stands for. Which ends are kept is a count, not a measurement: each kept crumb then
 * truncates by CSS inside the width there is.
 */

/** Ancestors shown in full on either side of the fold. */
export const CRUMB_ENDS = { head: 1, tail: 1 } as const;

export interface CrumbPlan<T> {
	/** Shown first: the page (the outermost ancestors). */
	head: T[];
	/** Folded into the "…" entry, outermost first; empty when everything fits the count. */
	hidden: T[];
	/** Shown last: the nearest ancestors of what is focused. */
	tail: T[];
}

/**
 * Split a path of ancestors (outermost first) into what is shown and what is folded. Nothing is
 * folded unless at least two ancestors would hide: a "…" that stands for one crumb saves nothing.
 */
export function planCrumbs<T>(
	ancestors: readonly T[],
	ends: { head: number; tail: number } = CRUMB_ENDS,
): CrumbPlan<T> {
	const head = Math.max(0, ends.head);
	const tail = Math.max(0, ends.tail);
	if (ancestors.length - head - tail < 2) return { head: [...ancestors], hidden: [], tail: [] };
	return {
		head: ancestors.slice(0, head),
		hidden: ancestors.slice(head, ancestors.length - tail),
		tail: ancestors.slice(ancestors.length - tail),
	};
}
