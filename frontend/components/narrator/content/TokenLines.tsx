/**
 * TokenLines.tsx — Paint Shiki-coloured code without touching geometry.
 *
 * Both helpers are deliberately GEOMETRY-NEUTRAL, which is what lets syntax
 * colours coexist with the zero-DOM-measure height contract:
 *   - the emitted `<span>`s keep the default `display: inline`
 *   - they set ONLY `color`, inheriting the caller's `font` and `white-space`
 *   - the character sequence is byte-identical to the plain-text fallback
 * So the browser lays out exactly the same glyph run it would without colour, and
 * the measured line count / line height stay authoritative.
 *
 * Two shapes, because the vlist has two kinds of code surface:
 *
 *   TokenText     — ONE line whose wrapping pretext already decided. The caller
 *                   owns the row box (absolute top / height / font); this only
 *                   fills it. Pair with splitTokensByVisualLines.
 *   TokenFlowText — a `white-space: pre-wrap` body the BROWSER wraps (the capped
 *                   tool-detail boxes). Shiki's physical lines are emitted as-is
 *                   with `\n` between them, so wrapping is unchanged.
 *
 * When tokens are absent (highlight pending, unknown grammar, oversized body) or
 * fail an exactness check, both render the identical plain text they did before
 * highlighting existed. Rendering the wrong characters would be far worse than
 * rendering uncoloured ones, so every path degrades to the source text.
 */

import type { ShikiToken } from "@frontend/lib/shiki-token-cache";
import { Fragment, type ReactNode } from "react";

/** One `<span>` per token, colour-only. Whitespace tokens are kept verbatim. */
function tokenSpans(tokens: readonly ShikiToken[]): ReactNode {
	return tokens.map((token, index) => (
		<span
			// biome-ignore lint/suspicious/noArrayIndexKey: tokens are a stable ordered list
			key={index}
			style={token.color ? { color: token.color } : undefined}
		>
			{token.content}
		</span>
	));
}

/** Total character count of a token run (the alignment check). */
function tokensLength(tokens: readonly ShikiToken[]): number {
	let length = 0;
	for (const token of tokens) length += token.content.length;
	return length;
}

/**
 * Colour spans for one already-wrapped line.
 *
 * `tokens` must cover exactly `text`; splitTokensByVisualLines guarantees this or
 * hands back an empty list. The length check is a second belt: a drift renders the
 * plain line instead of shifted colours.
 */
export function TokenText({
	text,
	tokens,
}: {
	/** The line's exact text (the fallback, and the alignment reference). */
	text: string;
	/** Tokens for THIS line, or null/empty to render plain text. */
	tokens?: readonly ShikiToken[] | null;
}) {
	if (!tokens || tokens.length === 0) return <>{text}</>;
	if (tokensLength(tokens) !== text.length) return <>{text}</>;
	return <>{tokenSpans(tokens)}</>;
}

/**
 * Colour spans for a browser-wrapped (`pre-wrap`) body. Physical lines are joined
 * with real `\n` text nodes, so the container wraps exactly as it does with plain
 * text — no re-slicing onto visual lines is needed or wanted here.
 *
 * The tokens come from the same string as `text`, but Shiki normalizes line
 * endings, so a CRLF body would tokenize shorter than it renders. The total-length
 * check catches that (and any other drift) and falls back to plain text.
 */
export function TokenFlowText({
	text,
	tokens,
}: {
	/** The body text (the fallback, and the alignment reference). */
	text: string;
	/** Shiki tokens grouped by physical line, or null to render plain text. */
	tokens?: ShikiToken[][] | null;
}) {
	if (!tokens || tokens.length === 0) return <>{text}</>;
	// Physical lines are rejoined with `\n`, so the expected length is the sum of
	// the token characters plus one separator per line boundary.
	let total = tokens.length - 1;
	for (const line of tokens) total += tokensLength(line);
	if (total !== text.length) return <>{text}</>;
	return (
		<>
			{tokens.map((line, lineIndex) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable ordered list
				<Fragment key={lineIndex}>
					{lineIndex > 0 ? "\n" : null}
					{tokenSpans(line)}
				</Fragment>
			))}
		</>
	);
}
