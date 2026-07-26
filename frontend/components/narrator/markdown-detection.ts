/**
 * Math delimiter detection/normalization now lives in the shared pretext core so
 * the react-markdown path and the pretext vlist path agree on what counts as
 * math. Re-exported here to keep existing import sites working.
 */
export {
	hasMarkdownMath,
	hasUnclosedMath,
	normalizeMathDelimiters,
} from "@shared/pretext-layout/math-delimiters";

import { hasMarkdownMath } from "@shared/pretext-layout/math-delimiters";

export const MD_PATTERN =
	/(?:^#{1,6}\s|(?:^|\n)[ \t]{0,3}```|\*\*|__|\*(?!\s)|_(?!\s)|\[.+?\]\(.+?\)|^>\s|^[-*+]\s|^\d+\.\s|^\|.+\||!\[)/m;

const TILDE_CODE_FENCE_PATTERN = /(^|\n)[ \t]{0,3}~~~/;
const INDENTED_CODE_BLOCK_PATTERN = /(^|\n)(?: {4}|\t)\S/;
const RAW_HTML_TAG_PATTERN = /<\/?[A-Za-z][^>\n]*(?:>|$)/;

export function isSafeForFlowtokenAnimation(text: string): boolean {
	// flowtoken bundles a react-syntax-highlighter code renderer that assumes
	// `rows` is always an array (`rows.map(...)`). Streaming/partial Markdown can
	// violate that assumption, so only route plain text through flowtoken and let
	// our local react-markdown renderer handle real Markdown constructs.
	return (
		!MD_PATTERN.test(text) &&
		!hasMarkdownMath(text) &&
		!TILDE_CODE_FENCE_PATTERN.test(text) &&
		!INDENTED_CODE_BLOCK_PATTERN.test(text) &&
		!RAW_HTML_TAG_PATTERN.test(text)
	);
}

/**
 * Relaxed safety check for the *active tail* of a split streaming message.
 *
 * Unlike `isSafeForFlowtokenAnimation` (which rejects ALL markdown so only plain
 * text animates), the tail path is allowed to contain ordinary markdown
 * (headings, bold, lists, inline code, links…): NarraFork overrides flowtoken's
 * `code`/`pre` components with its own renderers, so flowtoken's crash-prone
 * `react-syntax-highlighter` is never invoked. We still block two things:
 *
 *  1. **Raw HTML tags** — flowtoken hard-codes `rehype-raw`, which renders raw
 *     HTML into real DOM. Animating AI-authored HTML would be a content-injection
 *     surface, so HTML content must stay on the safe (rehype-raw-free) static path.
 *
 * Math is NOT blocked here: the caller now passes remark-math/rehype-katex to the
 * animated tail like every other renderer. Only a *half-written* formula is unsafe,
 * and that is checked per frame via `hasUnclosedMath` alongside `hasUnclosedFence`
 * (both are the caller's responsibility, so neither is checked here).
 */
export function isSafeForFlowtokenTail(text: string): boolean {
	return !RAW_HTML_TAG_PATTERN.test(text);
}
