import { memo } from "react";
import { MarkdownContent } from "../narrator/markdown/MarkdownContent";

/** Content with nothing markdown would render differently from plain text. */
const MARKDOWN_SYNTAX = /[*_`#>[\]!|~<\\$&]|https?:|www\.|^\s*(?:\d+[.)]|[-+])\s/m;

/** Whether a block body needs the markdown renderer; most outline blocks are plain sentences. */
export function needsMarkdown(content: string): boolean {
	return MARKDOWN_SYNTAX.test(content);
}

/**
 * One block's body, read-only. Plain sentences render as text; anything with markdown syntax
 * goes through the shared markdown renderer, so a large page does not parse every row.
 */
export const OutlineBlockBody = memo(function OutlineBlockBody({ content }: { content: string }) {
	if (!needsMarkdown(content)) return <span>{content}</span>;
	return <MarkdownContent text={content} />;
});
