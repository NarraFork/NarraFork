import type { FileTarget } from "./file-reference";

/** Editor transfer budgets are deliberately independent of chat file-reference budgets. */
export const EDITOR_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const EDITOR_DOCUMENT_MAX_CHARS = 20 * 1024 * 1024;
export const EDITOR_TRANSFER_MAX_BYTES = 64 * 1024 * 1024;
export const EDITOR_METADATA_MAX_BYTES = 32 * 1024;
export const EDITOR_TRANSFER_CHUNK_BYTES = 64 * 1024;
export const EDITOR_IO_TIMEOUT_MS = 30_000;
export const EDITOR_UPLOAD_IDLE_MS = 10_000;
export const EDITOR_SESSION_IDLE_MS = 10 * 60_000;
export const EDITOR_USER_MAX_SESSIONS = 8;
export const EDITOR_MAX_SESSIONS = 32;
export const EDITOR_USER_TEMP_MAX_BYTES = 512 * 1024 * 1024;
export const EDITOR_TEMP_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface CreateEditorDocumentInput {
	path: string;
	deviceId?: string;
	origin: "reference" | "legacy";
}

export interface EditorDocumentDescriptor {
	docId: string;
	target: FileTarget;
	versionHandle: string;
	baseHash: string;
	encoding: string;
	eol: "LF" | "CRLF" | "CR";
	sourceBytes: number;
	utf8Bytes: number;
}

export interface CreateEditorUploadInput {
	baseHash: string | null;
	encoding: string;
	snapshotRevision: number;
}

export type EditorUploadPhase =
	| "uploading"
	| "sealed"
	| "committing"
	| "settled"
	| "cancelled"
	| "expired";
export interface EditorUploadDescriptor {
	uploadId: string;
	state: EditorUploadPhase;
	operationId?: string;
	bytes?: number;
	digest?: string;
}

export interface EditorCommitInput {
	confirmationToken?: string;
}

export interface EditorSaveResult {
	status: "saved";
	operationId: string;
	hash: string;
	bytes: number;
	snapshotRevision: number;
}

export interface EditorPendingResult {
	status: "committing";
	operationId: string;
}

export type EditorCommitResult = EditorSaveResult | EditorPendingResult;
export interface EditorOperationResult {
	status: "committing" | "saved" | "failed" | "uncertain";
	operationId: string;
	result?: EditorSaveResult;
	error?: { code: string; message: string };
}

/** Returned as bounded HTTP error data, never accompanied by full conflict text. */
export interface EditorConflictData {
	code: "STALE_WRITE";
	currentHash: string | null;
	conflictVersionHandle: string;
	encoding: string;
	size: number;
}
export interface EditorConfirmationData {
	code: "NEEDS_CONFIRMATION";
	physicalPath: string;
	confirmationToken: string;
}
