/** File identities are device-scoped; selecting a reference never grants read permission. */
export const MAX_FILE_REFERENCE_COUNT = 16;
export const MAX_FILE_REFERENCE_PATH_CHARS = 4096;
/** Far beyond any bounded preview, while rejecting overflow/hostile position hints early. */
export const MAX_FILE_REFERENCE_POSITION = 1_000_000;
export const MAX_FILE_REFERENCE_METADATA_BYTES = 64 * 1024;
export const MAX_FILE_REFERENCE_SOURCE_BYTES = 1024 * 1024;
/** Read-only panel limits, independent of immutable reference snapshot limits. */
export const MAX_FILE_PANEL_BYTES = 1024 ** 3;
export const FILE_PANEL_PAGE_BYTES = 256 * 1024;
export const MAX_FILE_REFERENCE_TEXT_BYTES = 32 * 1024;
export const MAX_FILE_REFERENCE_TOTAL_TEXT_BYTES = 128 * 1024;
export const MAX_FILE_REFERENCE_QUERY_CHARS = 256;
export const MAX_FILE_REFERENCE_SEARCH_RESULTS = 50;
export const MAX_FILE_REFERENCE_SEARCH_BYTES = 128 * 1024;
export const FILE_REFERENCE_SEARCH_TIMEOUT_MS = 2000;
export const FILE_REFERENCE_READ_TIMEOUT_MS = 10_000;
export const FILE_REFERENCE_SEARCH_DEBOUNCE_MS = 150;
export const FILE_REFERENCE_READ_CONCURRENCY = 2;

/** One-based line/UTF-16-column coordinates, with an exclusive end. */
export interface FileSelection {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
}

export interface FileTarget {
	deviceId: string;
	path: string;
	selection?: FileSelection;
}

/** Metadata captured when one assistant text block starts, not an authorization token. */
export interface FileReferenceContext {
	deviceId: string;
	cwd: string;
}

/** One occurrence in a composer/message; two selections of the same file have different ids. */
export interface FileReference extends FileTarget {
	id: string;
	label: string;
	/** UTF-16 offsets in the user's prompt, unrelated to the target file's selection. */
	inputRange?: [start: number, end: number];
	/** Hash of the saved text shown by the editor, checked again before capturing a selection. */
	expectedHash?: string;
}

/** Only the server constructs accepted snapshots. Never accept these fields from a client. */
export interface FileReferenceSnapshot {
	type: "file_reference";
	reference: FileReference;
	snapshotText: string;
	snapshotHash: string;
	capturedAt: string;
}

/** The lightweight shape allowed in message lists and queue/WS summaries. */
export interface FileReferenceDisplay {
	type: "file_reference";
	reference: FileReference;
}

export interface FileReferenceCandidate extends FileTarget {
	name: string;
	relativePath: string;
	isDirectory: boolean;
}

export interface FileReferenceSearchResult {
	entries: FileReferenceCandidate[];
	truncated: boolean;
}

export interface FilePanelInfo {
	target: FileTarget;
	fileName: string;
	size: number;
}

export interface FilePanelPage extends FilePanelInfo {
	/** Actual UTF-8-aligned start; may precede a requested jump by up to three bytes. */
	offset: number;
	nextOffset: number | null;
	content: string;
}

export interface FileReferencePreview {
	target: FileTarget;
	content: string;
	hash: string;
	encoding: string;
	fileName: string;
}

/** Last saved-file selection published by a file panel in this narrator's scope. */
export interface FileReferenceEditorSelection {
	target: FileTarget;
	label: string;
	expectedHash: string;
	dirty: boolean;
}

export function fileReferenceDisplay(snapshot: FileReferenceDisplay): FileReferenceDisplay {
	return { type: "file_reference", reference: snapshot.reference };
}

/** Display exits must not broadcast bounded-but-large model snapshots with every user bubble. */
export function fileReferenceContentForDisplay(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	return content.map((block: unknown) => {
		if (
			!block ||
			typeof block !== "object" ||
			!("type" in block) ||
			block.type !== "file_reference"
		)
			return block;
		return {
			type: "file_reference",
			reference: "reference" in block ? block.reference : undefined,
		};
	});
}

/** Only call at HTTP/WS display exits; DB rows and model input keep their immutable snapshots. */
export function fileReferenceMessageForDisplay<T extends { contentJson?: unknown }>(
	message: T,
): Omit<T, "contentJson"> & { contentJson: unknown } {
	return { ...message, contentJson: fileReferenceContentForDisplay(message.contentJson) };
}

export function isFileReferenceSnapshot(value: unknown): value is FileReferenceSnapshot {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<FileReferenceSnapshot>;
	return (
		item.type === "file_reference" &&
		typeof item.snapshotText === "string" &&
		typeof item.snapshotHash === "string" &&
		typeof item.capturedAt === "string" &&
		!!item.reference &&
		typeof item.reference.id === "string" &&
		typeof item.reference.deviceId === "string" &&
		typeof item.reference.path === "string"
	);
}

/** Identity serialization is deliberately not a URL: device ids are case-sensitive. */
export function fileTargetKey(target: Pick<FileTarget, "deviceId" | "path">): string {
	return JSON.stringify([target.deviceId, target.path]);
}
