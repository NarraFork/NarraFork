export const MD_PATTERN =
	/(?:^#{1,6}\s|(?:^|\n)[ \t]{0,3}```|\*\*|__|\*(?!\s)|_(?!\s)|\[.+?\]\(.+?\)|^>\s|^[-*+]\s|^\d+\.\s|^\|.+\||!\[)/m;

const DISPLAY_MATH_PATTERN = /(^|\n)\s*\$\$[\s\S]*?\$\$/;
const INLINE_MATH_PATTERN = /(^|[^\\$])\$[^\s$](?:[^\n$]*[^\s$])?\$/;
const PAREN_MATH_PATTERN = /\\\([\s\S]*?\\\)/;
const BRACKET_MATH_PATTERN = /\\\[[\s\S]*?\\\]/;
const TILDE_CODE_FENCE_PATTERN = /(^|\n)[ \t]{0,3}~~~/;
const INDENTED_CODE_BLOCK_PATTERN = /(^|\n)(?: {4}|\t)\S/;
const RAW_HTML_TAG_PATTERN = /<\/?[A-Za-z][^>\n]*(?:>|$)/;

export function hasMarkdownMath(text: string): boolean {
	return (
		DISPLAY_MATH_PATTERN.test(text) ||
		INLINE_MATH_PATTERN.test(text) ||
		PAREN_MATH_PATTERN.test(text) ||
		BRACKET_MATH_PATTERN.test(text)
	);
}

/**
 * Matches fenced code blocks (``` / ~~~), indented code blocks, and inline code
 * spans (`...`). Used to split text so we never rewrite math delimiters inside
 * code regions. The capturing group puts code segments at odd indices after
 * String.split().
 */
const CODE_SEGMENT_PATTERN =
	/(```[\s\S]*?```|~~~[\s\S]*?~~~|(?:^|\n)(?: {4}|\t)[^\n]*(?:\n(?: {4}|\t)[^\n]*)*|`[^`\n]*`)/g;

/**
 * Normalize LaTeX delimiters that `remark-math` does not understand.
 *
 * Many LLMs (GPT family, some Gemini variants) emit `\(...\)` for inline math
 * and `\[...\]` for display math instead of the `$...$` / `$$...$$` syntax that
 * remark-math parses. Without this conversion those formulas render as literal
 * backslash-parens. We rewrite them to dollar-delimited math while skipping
 * code blocks and inline code so real code containing `\(` is left untouched.
 */
export function normalizeMathDelimiters(text: string): string {
	if (!text.includes("\\(") && !text.includes("\\[")) return text;

	return text
		.split(CODE_SEGMENT_PATTERN)
		.map((segment, index) => {
			// Odd indices are captured code segments — leave them verbatim.
			if (index % 2 === 1) return segment;
			return segment
				.replace(/\\\[([\s\S]+?)\\\]/g, (_match, body: string) => `$$${body}$$`)
				.replace(/\\\(([\s\S]+?)\\\)/g, (_match, body: string) => `$${body}$`);
		})
		.join("");
}

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
 *  2. **Math** — needs remark-math/rehype-katex which flowtoken doesn't load.
 *
 * Fenced-code safety (incomplete ``` fences) is handled separately by the caller
 * via `hasUnclosedFence`, so it is intentionally not checked here.
 */
export function isSafeForFlowtokenTail(text: string): boolean {
	return !RAW_HTML_TAG_PATTERN.test(text) && !hasMarkdownMath(text);
}
