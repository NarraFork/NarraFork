import type { FileViewerMode } from "../file-viewer/file-viewer-modes";

/**
 * Editor mode preference — the file editor's mode switch gains a "split" value
 * (editor and rendered preview side by side) on top of the viewer's own modes,
 * plus a remembered default so a user who always reads markdown rendered does
 * not have to switch every panel by hand.
 */

export type EditorMode = FileViewerMode | "split";

export const EDITOR_MODE_PREF_KEY = "narrafork_file_editor_mode";

const EDITOR_MODES: readonly EditorMode[] = ["raw", "split", "preview", "node"];

function safeStorage(storage?: Storage | null): Storage | null {
	if (storage !== undefined) return storage;
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

export function readEditorModePref(storage?: Storage | null): EditorMode {
	try {
		const value = safeStorage(storage)?.getItem(EDITOR_MODE_PREF_KEY);
		return EDITOR_MODES.includes(value as EditorMode) ? (value as EditorMode) : "raw";
	} catch {
		return "raw";
	}
}

export function writeEditorModePref(mode: EditorMode, storage?: Storage | null): void {
	try {
		safeStorage(storage)?.setItem(EDITOR_MODE_PREF_KEY, mode);
	} catch {
		// Persistence is a convenience; a read-only storage must never break editing.
	}
}

/**
 * The saved default only applies when it makes sense for THIS file: a rendered
 * mode requires the file to offer it, and split requires anything to render at
 * all. Everything else falls back to raw editing.
 */
export function resolveInitialMode(saved: EditorMode, modes: FileViewerMode[]): EditorMode {
	if (saved === "split") return modes.length > 1 ? "split" : "raw";
	if (saved === "preview" || saved === "node") return modes.includes(saved) ? saved : "raw";
	return "raw";
}

/** Split renders the file's non-raw mode beside the editor (md→preview, json→node). */
export function splitRenderMode(modes: FileViewerMode[]): Exclude<FileViewerMode, "raw"> {
	return modes.find((mode) => mode !== "raw") ?? "preview";
}

export function scrollFraction(scrollTop: number, scrollHeight: number, clientHeight: number) {
	const range = scrollHeight - clientHeight;
	return range > 0 ? scrollTop / range : 0;
}

export function fractionToScroll(fraction: number, scrollHeight: number, clientHeight: number) {
	return fraction * Math.max(0, scrollHeight - clientHeight);
}
