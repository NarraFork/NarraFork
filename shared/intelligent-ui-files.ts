/** Ordinary workspace files, not a second document/revision store. */
export const INTELLIGENT_UI_DIRECTORY = ".narrafork/intelligent_ui";
export const INTELLIGENT_UI_ENTRY = "App.tsx";

/** Written by the tool host; API callers cannot use a path as an authorization grant. */
export interface IntelligentUiFileReference {
	version: 1;
	toolUseId: string;
	toolCallId: string;
	deviceId: string;
	workspaceKey: string;
	cwd: string;
	directory: string;
	entry: string;
	title: string;
}

/** A transient build of the files now on disk. Never persisted as a UI revision. */
export interface IntelligentUiPreview {
	js: string;
	css: string;
	directory: string;
	entry: string;
	files: string[];
	/** Set when the build targets the project's component kit instead of the built-in runtime. */
	kit?: { hash: string };
}

export const INTELLIGENT_UI_FILE_LIMITS = Object.freeze({
	fileBytes: 512 * 1024,
	sourceBytes: 2 * 1024 * 1024,
	files: 128,
	outputBytes: 4 * 1024 * 1024,
	timeoutMs: 15_000,
});

export function readIntelligentUiFileReference(value: unknown): IntelligentUiFileReference | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const ref = value as Record<string, unknown>;
	if (ref.version !== 1) return null;
	for (const key of [
		"toolUseId",
		"toolCallId",
		"deviceId",
		"workspaceKey",
		"cwd",
		"directory",
		"entry",
		"title",
	] as const) {
		if (typeof ref[key] !== "string" || ref[key].length === 0 || ref[key].length > 4096)
			return null;
	}
	return {
		version: 1,
		toolUseId: ref.toolUseId as string,
		toolCallId: ref.toolCallId as string,
		deviceId: ref.deviceId as string,
		workspaceKey: ref.workspaceKey as string,
		cwd: ref.cwd as string,
		directory: ref.directory as string,
		entry: ref.entry as string,
		title: ref.title as string,
	};
}
