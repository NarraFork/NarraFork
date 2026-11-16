/**
 * Document IR → Markdown.
 *
 * The preview renders this with the SAME `MarkdownContent` component that renders `.md`
 * files, which is what makes a DOCX preview look like a Markdown preview without a second
 * stylesheet.
 *
 * Two deliberate simplifications against the export-oriented original in
 * `examples/plugins/doc-markdown/server/lib/markdown.js`:
 *   - no `styled` mode (run-level bold/size/color footnotes): the preview is read-only, and
 *     inline styling noise would not match the Markdown renderer's output anyway
 *   - images become `nf-doc-asset:` links instead of file paths, because the picture is a ZIP
 *     entry rather than a file the client may read
 */

import { buildDocumentAssetUrl } from "@shared/document-file-extensions";

export interface TextBlock {
	type: "heading" | "paragraph";
	text: string;
	level?: number;
}

export interface ListBlock {
	type: "list";
	ordered: boolean;
	items: Array<{ level: number; text: string }>;
}

export interface TableBlock {
	type: "table";
	rows: string[][];
	headerRow: boolean;
	merges: string[];
}

export interface ImageBlock {
	type: "image";
	/** Asset id minted by the parser (`a1`, …). */
	assetId: string;
	alt: string;
}

export interface NoteBlock {
	type: "note";
	text: string;
}

export type DocumentBlock = TextBlock | ListBlock | TableBlock | ImageBlock | NoteBlock;

export function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/**
 * Escape the characters that would otherwise start Markdown syntax, so document text renders
 * as text. Deliberately conservative: backslash/asterisk/underscore/brackets/backticks only.
 */
export function escapeInline(value: string): string {
	return value.replace(/([\\`*_[\]<>#|])/g, "\\$1");
}

function escapeCell(value: string): string {
	// A pipe would split the cell; a newline would end the row.
	return escapeInline(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderTable(block: TableBlock): string {
	if (!block.rows.length) return "";
	const columns = Math.max(...block.rows.map((row) => row.length));
	if (columns === 0) return "";

	const cellAt = (row: string[], index: number) => {
		const cell = row[index];
		// A merged-away cell keeps its slot instead of collapsing the column.
		return cell === undefined ? "" : escapeCell(cell);
	};

	const lines: string[] = [];
	const header = block.rows[0] ?? [];
	lines.push(
		`| ${Array.from({ length: columns }, (_, index) => cellAt(header, index)).join(" | ")} |`,
	);
	lines.push(`| ${Array.from({ length: columns }, () => "---").join(" | ")} |`);
	for (const row of block.rows.slice(1)) {
		lines.push(
			`| ${Array.from({ length: columns }, (_, index) => cellAt(row, index)).join(" | ")} |`,
		);
	}
	return lines.join("\n");
}

/** The `nf-doc-asset:` target carrying the document path and asset id. */
export function assetTarget(documentPath: string, assetId: string): string {
	return buildDocumentAssetUrl(documentPath, assetId);
}

export function renderBlock(block: DocumentBlock, documentPath: string): string {
	switch (block.type) {
		case "heading": {
			const level = Math.min(6, Math.max(1, block.level ?? 1));
			return `${"#".repeat(level)} ${escapeInline(collapseWhitespace(block.text))}`;
		}
		case "paragraph": {
			const text = block.text ?? "";
			if (!text.trim()) return "";
			return escapeInline(text).replace(/\\ \n/g, "  \n");
		}
		case "list":
			return block.items
				.map((item, index) => {
					const indent = "  ".repeat(Math.max(0, (item.level ?? 1) - 1));
					const marker = block.ordered ? `${index + 1}.` : "-";
					return `${indent}${marker} ${escapeInline(collapseWhitespace(item.text))}`;
				})
				.join("\n");
		case "table":
			return renderTable(block);
		case "image":
			return `![${escapeInline(block.alt)}](${assetTarget(documentPath, block.assetId)})`;
		case "note":
			return `> ${escapeInline(block.text)}`;
		default:
			return "";
	}
}

/** Render the whole document body, keeping paragraph breaks between blocks. */
export function renderMarkdown(blocks: DocumentBlock[], documentPath: string): string {
	const parts: string[] = [];
	for (const block of blocks) {
		const rendered = renderBlock(block, documentPath);
		if (rendered) parts.push(rendered);
	}
	return parts.join("\n\n");
}
