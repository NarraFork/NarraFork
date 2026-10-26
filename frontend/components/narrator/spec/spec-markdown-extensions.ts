import type { AnyExtension, JSONContent, MarkdownRendererHelpers } from "@tiptap/core";
import { renderTableToMarkdown, Table, TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

/**
 * Escape every cell-delimiting pipe in one already-rendered table cell.
 *
 * GFM splits a row into cells before any inline parsing, so a bare `|` ends the cell even
 * inside a code span or a link. A pipe preceded by an odd number of backslashes is already
 * escaped; every other one gets a backslash. Literal backslashes in text arrive here already
 * doubled by the markdown serializer, so they never swallow the escape we add.
 */
export function escapeTableCellPipes(cell: string): string {
	let out = "";
	let backslashes = 0;
	for (const ch of cell) {
		if (ch === "|" && backslashes % 2 === 0) out += "\\";
		out += ch;
		backslashes = ch === "\\" ? backslashes + 1 : 0;
	}
	return out;
}

/**
 * `@tiptap/extension-table@3.27.1` writes cell text back without escaping pipes, so
 * `| a \| b |` comes back as `| a | b |` (one more column) and the table changes on every
 * save. The upstream renderer only calls `renderChildren` for cell contents, so wrapping that
 * helper escapes exactly the cell text. Several paragraphs in one cell (Enter pressed inside a
 * cell) are joined with a space: the upstream default joins them with U+001F, which would end up
 * as a control character in the file.
 */
export function renderSpecTableMarkdown(node: JSONContent, h: MarkdownRendererHelpers): string {
	const helpers: MarkdownRendererHelpers = {
		...h,
		renderChildren: (nodes, separator) => escapeTableCellPipes(h.renderChildren(nodes, separator)),
	};
	return renderTableToMarkdown(node, helpers, { cellLineSeparator: " " });
}

const SpecTable = Table.extend({
	renderMarkdown: (node, h) => renderSpecTableMarkdown(node, h),
});

/**
 * Extensions of the spec WYSIWYG editor. Shared by the React editor and the headless tests so
 * both serialize exactly the same way. Tables need TableKit: without it the markdown parser
 * drops every table token on load and the next save deletes the table from the file.
 */
export function createSpecMarkdownExtensions(): AnyExtension[] {
	return [
		// StarterKit already bundles the Link extension in Tiptap v3; adding a separate Link
		// caused a duplicate-extension conflict that broke the command manager. Configure link
		// options through StarterKit instead.
		StarterKit.configure({ link: { openOnClick: false } }),
		Markdown.configure({ indentation: { style: "space", size: 2 } }),
		TableKit.configure({ table: false }),
		SpecTable.configure({ resizable: false }),
	];
}
