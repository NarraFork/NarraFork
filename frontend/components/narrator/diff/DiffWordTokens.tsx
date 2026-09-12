/**
 * DiffWordTokens.tsx — Word-level diff tints WITH syntax colours.
 *
 * Both diff renderers used to choose one or the other:
 *
 *     line.wordChanges ? <word tints> : tokens ? <syntax colours> : <plain>
 *
 * which meant the only rows carrying `wordChanges` — modified lines, the rows a
 * reader looks at first — were the only rows rendered without syntax colouring.
 * A word chunk and a Shiki token are two partitions of the SAME text, so they
 * intersect rather than compete; `sliceTokensByWordChanges` computes that
 * intersection and this component paints it.
 *
 * WHY IT LIVES OUTSIDE vlist/
 *
 * `vlist-isolation.guard.test.ts` forbids any file outside `vlist/` from
 * statically importing from `vlist/`, so `DiffView` cannot reuse `TokenLines.tsx`.
 * Placing the shared piece here lets BOTH paths use it: `DiffView` imports it
 * directly, and `RenderToolCall` (inside vlist) imports it inward, which the
 * guard does not scan.
 *
 * GEOMETRY-NEUTRAL, same contract as TokenLines: the emitted spans set only
 * `color` / `background` / `borderRadius`, never display, font or white-space, and
 * the character sequence is byte-identical to the plain text. So the browser lays
 * out the same glyph run and any measured line geometry stays authoritative.
 */

import type { DiffWordChange } from "@shared/pretext-layout/diff-core";
import {
	type DiffHighlightToken,
	sliceTokensByWordChanges,
} from "@shared/pretext-layout/diff-word-tokens";
import type { CSSProperties, ReactNode } from "react";

/** Background styles for changed chunks. `undefined` leaves a chunk untinted. */
export interface DiffWordStyles {
	removedWord: CSSProperties;
	addedWord: CSSProperties;
}

function tintFor(chunk: DiffWordChange, styles: DiffWordStyles): CSSProperties | undefined {
	if (chunk.removed) return styles.removedWord;
	if (chunk.added) return styles.addedWord;
	return undefined;
}

/**
 * One diff row's inline content: chunk tint outside, token colour inside.
 *
 * Falls back to untinted-but-correct text at every step, because rendering the
 * wrong characters is far worse than rendering uncoloured ones:
 *   - tokens absent or misaligned → plain chunks with tints only (previous
 *     behaviour, so this is never a regression)
 */
export function DiffWordTokens({
	wordChanges,
	tokens,
	styles,
}: {
	wordChanges: readonly DiffWordChange[];
	/** Tokens for THIS row, or null/undefined when highlighting is unavailable. */
	tokens?: readonly DiffHighlightToken[] | null;
	styles: DiffWordStyles;
}): ReactNode {
	const sliced = sliceTokensByWordChanges(tokens, wordChanges);

	if (!sliced) {
		// Tint-only: exactly what both renderers did before this component existed.
		return (
			<>
				{wordChanges.map((chunk, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: word chunks have no stable id
					<span key={i} style={tintFor(chunk, styles)}>
						{chunk.value}
					</span>
				))}
			</>
		);
	}

	return (
		<>
			{sliced.map((entry, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: word chunks have no stable id
				<span key={i} style={tintFor(entry.chunk, styles)}>
					{entry.tokens.map((token, j) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: tokens are a stable ordered list
							key={j}
							style={token.color ? { color: token.color } : undefined}
						>
							{token.content}
						</span>
					))}
				</span>
			))}
		</>
	);
}
