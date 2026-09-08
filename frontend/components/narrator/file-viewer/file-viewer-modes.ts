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

/** Legacy viewers default to rendered content. Editors use raw as their initial mode. */
export function availableModes(filePath: string, selection?: FileSelection): FileViewerMode[] {
	if (selection) return ["raw"];
	if (isMarkdownPath(filePath)) return ["preview", "raw"];
	if (detectStructuredFormat(filePath)) return ["node", "raw"];
	return ["raw"];
}
