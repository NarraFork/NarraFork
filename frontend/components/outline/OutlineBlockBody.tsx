import { memo } from "react";
import { ensureTypographyCssVars } from "../../lib/typography-css-vars";
import { MarkdownContent } from "../narrator/markdown/MarkdownContent";

ensureTypographyCssVars();

/** Content with nothing markdown would render differently from plain text. */
const MARKDOWN_SYNTAX = /[*_`#>[\]!|~<\\$&]|https?:|www\.|^\s*(?:\d+[.)]|[-+])\s/m;

/** Whether a block body needs the markdown renderer; most outline blocks are plain sentences. */
export function needsMarkdown(content: string): boolean {
	return MARKDOWN_SYNTAX.test(content);
}

/**
 * One block's body, read-only. Plain sentences render as text; anything with markdown syntax
 * goes through the shared markdown renderer, so a large page does not parse every row.
 *
 * Both carry `.nf-type-scope`: the conversation's typography for each role (body, headings,
 * inline code), the same values the live editor uses, so switching to history does not change
 * the text size.
 */
export const OutlineBlockBody = memo(function OutlineBlockBody({ content }: { content: string }) {
	if (!needsMarkdown(content)) return <span className="nf-type-scope">{content}</span>;
	return (
		<div className="nf-type-scope">
			<MarkdownContent text={content} />
		</div>
	);
});
