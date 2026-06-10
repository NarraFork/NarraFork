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
