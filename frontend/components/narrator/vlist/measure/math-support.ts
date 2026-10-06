/**
 * math-support.ts — Bridge from the lazily-loaded KaTeX runtime to the parser.
 *
 * The prepared/measure layers are synchronous, so they cannot await KaTeX. This
 * helper hands them whatever is available right now: a runtime handle once the
 * document coordinator has loaded it, or `undefined` before that (formulas then
 * measure as literal text and the layout is rebuilt when the runtime revision
 * bumps — see katex-runtime.getKatexRevision).
 *
 * Kept in its own module so every measure function shares one implementation.
 */

import type { PreparedBlock } from "@shared/pretext-layout/prepared-block";
import { getPreparedMarkdownBlocks } from "@shared/pretext-layout/prepared-markdown-cache";
import {
	getKatexRevision,
	getKatexRuntime,
	measureGlyphVertical,
	measureGlyphWidth,
} from "../katex-runtime";
import type { MathSupport } from "../parse-markdown";

/** Math support for the markdown parser, or undefined until KaTeX is loaded. */
export function markdownMathSupport(): MathSupport | undefined {
	const katex = getKatexRuntime();
	if (!katex) return undefined;
	// Both resolvers cover scripts KaTeX has no metrics for (CJK): `glyphWidth` fixes
	// the advance, `glyphVertical` fixes the ascent/descent (KaTeX substitutes capital
	// "M", which has no descender, so CJK formulas rendered clipped). See katex-geometry.
	return { katex, glyphWidth: measureGlyphWidth, glyphVertical: measureGlyphVertical };
}

/**
 * Parsed + prepared blocks for a markdown body, memoised ACROSS WIDTHS.
 *
 * This is the entry point every measure function should use instead of calling
 * `parseMarkdownToPreparedBlocks` directly. The parse is ~94% of a markdown
 * measure and depends only on the text, so keying it by width (as the measure
 * cache does) re-ran it on every panel resize — see prepared-markdown-cache.
 *
 * The returned array is SHARED: treat it as immutable. A consumer needing a
 * different `marginTop` must re-wrap the block in a copy.
 */
export function preparedMarkdownBlocks(markdown: string): PreparedBlock[] {
	// The KaTeX revision joins the key so bodies prepared before the runtime landed
	// (formulas as literal text) are not served once it can measure them.
	return getPreparedMarkdownBlocks(markdown, markdownMathSupport(), getKatexRevision());
}
