import { isDocumentFilePath, isLegacyDocumentFilePath } from "@shared/document-file-extensions";
import type { FileSelection } from "@shared/file-reference";
import { filePanelBaseName } from "../panels/panel-kind";
import { detectStructuredFormat } from "./structured-parse";

export type FileViewerMode = "preview" | "node" | "raw";

/** Kept separate from the viewer so mode detection never loads rendering modules. */
export function isMarkdownPath(filePath: string): boolean {
	const base = filePanelBaseName(filePath);
	const dot = base.lastIndexOf(".");
	return dot > 0 && /^(md|markdown|mdx)$/i.test(base.slice(dot + 1));
}

/**
 * OOXML Word documents (`.docx`/`.docm`) — a ZIP the server renders read-only to Markdown.
 *
 * Kept here (not only in the preview modal) because the mode list and the render branch must
 * agree: a document has exactly one presentation, and `raw` would show a ZIP as text.
 */
export function isDocumentPath(filePath: string): boolean {
	return isDocumentFilePath(filePath);
}

/** Legacy binary Word files (OLE) — refused with a reason instead of being read as text. */
export function isLegacyDocumentPath(filePath: string): boolean {
	return isLegacyDocumentFilePath(filePath);
}

/** Legacy viewers default to rendered content. Editors use raw as their initial mode. */
export function availableModes(filePath: string, selection?: FileSelection): FileViewerMode[] {
	// Documents are read-only by definition: there is no meaningful raw view of a ZIP container,
	// and an editable text view of one is exactly the garbage this preview replaces.
	if (isDocumentPath(filePath) || isLegacyDocumentPath(filePath)) return ["preview"];
	if (selection) return ["raw"];
	if (isMarkdownPath(filePath)) return ["preview", "raw"];
	if (detectStructuredFormat(filePath)) return ["node", "raw"];
	return ["raw"];
}
