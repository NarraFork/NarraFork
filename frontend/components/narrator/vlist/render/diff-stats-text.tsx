/**
 * diff-stats-text.tsx — the ONE `+12 -3` figure both file-tool surfaces paint: a
 * tool card's header (`RenderToolCall`) and a folded trace row (`RenderToolRun`).
 *
 * Shared rather than duplicated because the two are the SAME fact at two levels of
 * detail. A second copy would drift in the way that matters least visibly and most:
 * a different colour pair, or one surface rendering a zero the other suppresses, and
 * nothing would report the mismatch.
 *
 * HEIGHT-NEUTRAL by construction: one `nowrap` inline run at the surrounding `xs`
 * font size, inside a `flexShrink: 0` span. It shares the fixed line both callers
 * already reserve (the same lane as the status glyph and the duration next to it),
 * so no measure module reserves anything for it — asserted in
 * `measure-tool-call.test.ts` / `measure-tool-run.test.ts`.
 *
 * ⚠️ A ZERO-CHANGE result renders NOTHING. `+0 -0` is noise: it occupies the reader's
 * attention to say that a call they can already see completed did not alter any
 * lines. This makes "no data" (null) and "no change" indistinguishable ON SCREEN,
 * which is intended — but the two must stay distinct in the DATA, because persisting
 * 0 for an unknown count would have a large rewrite claim it changed nothing. See
 * `resolveFileDiffStats`.
 */

import type { CSSProperties } from "react";

/** Added / removed line totals for one file-tool call. */
export interface DiffStatsValue {
	added: number;
	removed: number;
}

/**
 * Shared text style.
 *
 * `flexShrink: 0` is what keeps the figure whole: it sits after a truncating title,
 * and a shrinkable numeric cell would be clipped to "+1…" exactly when the path is
 * long — i.e. in the rows where the reader most needs to know the size of the edit.
 * Monospace matches the neighbouring path/summary text so the digits align down a
 * column of rows.
 */
const CONTAINER_STYLE: CSSProperties = {
	flexShrink: 0,
	display: "inline-flex",
	gap: 4,
	fontSize: "var(--mantine-font-size-xs)",
	lineHeight: "var(--mantine-line-height)",
	fontFamily: "var(--mantine-font-family-monospace)",
	fontVariantNumeric: "tabular-nums",
	whiteSpace: "nowrap",
};

const ADDED_STYLE: CSSProperties = { color: "var(--mantine-color-green-5)" };
const REMOVED_STYLE: CSSProperties = { color: "var(--mantine-color-red-5)" };

/**
 * Whether a figure is worth painting at all.
 *
 * Exported so a caller can decide whether to emit surrounding chrome (a separator,
 * a gap) without reimplementing the zero rule.
 */
export function hasVisibleDiffStats(
	stats: DiffStatsValue | null | undefined,
): stats is DiffStatsValue {
	if (!stats) return false;
	return stats.added > 0 || stats.removed > 0;
}

/**
 * `+12 -3` in green / red.
 *
 * Each side is omitted when it is zero, so a pure addition reads `+240` rather than
 * `+240 -0` — the trailing zero adds a token the reader has to parse to learn
 * nothing. Both zero → nothing at all (see the module header).
 */
export function DiffStatsText({ stats }: { stats: DiffStatsValue | null | undefined }) {
	if (!hasVisibleDiffStats(stats)) return null;
	return (
		<span
			data-nf-diff-stats
			style={CONTAINER_STYLE}
			// `role="img"` with a label, not a bare `aria-label`: on a roleless <span> the
			// attribute is ignored outright, so the label would have been decoration. The
			// role also makes the two numbers ONE announcement ("+12 -3") instead of two
			// unrelated ones, and the `+`/`-` signs are what carry the added/removed
			// distinction for a reader who cannot see the green/red.
			role="img"
			// Zero sides omitted here too, matching what is drawn. Announcing `-0` for a
			// figure that visually reads `+240` describes a number the sighted reader is
			// not shown, which is the kind of divergence that makes a label untrustworthy.
			aria-label={[
				stats.added > 0 ? `+${stats.added}` : null,
				stats.removed > 0 ? `-${stats.removed}` : null,
			]
				.filter(Boolean)
				.join(" ")}
		>
			{stats.added > 0 ? (
				<span data-nf-diff-added style={ADDED_STYLE}>
					+{stats.added}
				</span>
			) : null}
			{stats.removed > 0 ? (
				<span data-nf-diff-removed style={REMOVED_STYLE}>
					-{stats.removed}
				</span>
			) : null}
		</span>
	);
}
