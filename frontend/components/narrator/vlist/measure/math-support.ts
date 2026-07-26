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

import { getKatexRuntime, measureGlyphWidth } from "../katex-runtime";
import type { MathSupport } from "../parse-markdown";

/** Math support for the markdown parser, or undefined until KaTeX is loaded. */
export function markdownMathSupport(): MathSupport | undefined {
	const katex = getKatexRuntime();
	if (!katex) return undefined;
	// glyphWidth covers scripts KaTeX has no metrics for (CJK); see katex-geometry.
	return { katex, glyphWidth: measureGlyphWidth };
}
