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

/** Reading-width cap (px) applied to the content column when the option is ON. */
export const NARRATOR_CENTERED_COLUMN_MAX_WIDTH = 860;

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
