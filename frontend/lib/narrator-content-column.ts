/**
 * Narrator message-list content column geometry.
 *
 * Both message lists (the legacy ChunkedMessageList and the exact virtual list)
 * render their messages into a horizontally centered column. By default that
 * column simply fills the viewport; the `narrafork_narrator_centered_column`
 * preference caps it at a comfortable reading width instead.
 *
 * The constant + resolvers live here (outside `components/narrator/vlist/`) so
 * both paths share one source of truth without the OFF path statically importing
 * vlist code — see vlist-isolation.guard.test.ts.
 */

import type { CSSProperties } from "react";

/** Reading-width cap (px) applied to the content column when the option is ON. */
export const NARRATOR_CENTERED_COLUMN_MAX_WIDTH = 860;

/**
 * Horizontal gutter (px) kept on each side of the exact list's content column.
 *
 * ONE number shared by the real rows (vlist's PAGE_PADDING) and every loading
 * placeholder, so the two can never drift. It is deliberately px rather than a
 * Mantine spacing token: `resolveNarratorColumnWidth` measures in px against
 * `clientWidth`, so a rem-based gutter in the placeholder would resolve to a
 * different column width than the rows it stands in for at any non-default root
 * font size — which is exactly the mount-time width jump this constant removes.
 *
 * The legacy ChunkedMessageList keeps its own rem gutter (see
 * resolveNarratorColumnMaxWidth): that path is internally consistent and never
 * shares a placeholder with the exact list.
 */
export const NARRATOR_COLUMN_GUTTER_PX = 16;

/**
 * Width (px) of the content column drawn inside a message viewport.
 *
 * `viewportWidth` is the scroll container's client width and `padding` the
 * horizontal gutter kept on each side. When `centered` is false the column takes
 * all remaining space (the historical Chunk behaviour); when true it is capped at
 * NARRATOR_CENTERED_COLUMN_MAX_WIDTH. Never returns less than 1 so a not-yet-laid-out
 * viewport (clientWidth 0) cannot produce a zero/negative measurement width.
 */
export function resolveNarratorColumnWidth(
	viewportWidth: number,
	padding: number,
	centered: boolean,
): number {
	const available = viewportWidth - padding * 2;
	const width = centered ? Math.min(NARRATOR_CENTERED_COLUMN_MAX_WIDTH, available) : available;
	return Math.max(1, width);
}

/**
 * CSS `max-width` for a border-box content wrapper whose horizontal padding is
 * `horizontalPadding` per side, or undefined when the column should fill the
 * viewport. The padding is added back so the inner content still measures
 * NARRATOR_CENTERED_COLUMN_MAX_WIDTH. Kept as a CSS length expression so a
 * rem-based gutter (Mantine spacing) scales with the root font size.
 */
export function resolveNarratorColumnMaxWidth(
	centered: boolean,
	horizontalPadding: string,
): string | undefined {
	if (!centered) return undefined;
	return `calc(${NARRATOR_CENTERED_COLUMN_MAX_WIDTH}px + ${horizontalPadding} * 2)`;
}

/**
 * Style for a LOADING PLACEHOLDER's column container, geometrically identical to
 * the column the exact list's real rows draw into.
 *
 * THE SINGLE OWNER of the placeholder column's width. Every placeholder host (the
 * panel-level skeleton, the lazy-chunk Suspense fallback, the vlist's own
 * document-loading state) spreads this and sets no width of its own, and
 * `NarratorMessageListSkeleton` stays purely visual — so there is exactly one cap
 * in the tree and no nested double constraint.
 *
 * Same arithmetic as `resolveNarratorColumnWidth` in px, so the inner content
 * measures the same width the rows will:
 *
 *     centered ON  → min(NARRATOR_CENTERED_COLUMN_MAX_WIDTH, clientWidth - gutter*2)
 *     centered OFF → clientWidth - gutter*2
 *
 * `boxSizing: border-box` is explicit rather than inherited from a global reset:
 * the max-width adds both gutters back, and a content-box interpretation would
 * make the placeholder column two gutters wider than the rows.
 */
export function narratorColumnPlaceholderStyle(centered: boolean): CSSProperties {
	return {
		boxSizing: "border-box",
		width: "100%",
		maxWidth: centered
			? NARRATOR_CENTERED_COLUMN_MAX_WIDTH + NARRATOR_COLUMN_GUTTER_PX * 2
			: undefined,
		paddingLeft: NARRATOR_COLUMN_GUTTER_PX,
		paddingRight: NARRATOR_COLUMN_GUTTER_PX,
		paddingTop: NARRATOR_COLUMN_GUTTER_PX,
		paddingBottom: NARRATOR_COLUMN_GUTTER_PX,
		margin: "0 auto",
	};
}
