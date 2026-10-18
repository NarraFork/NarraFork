import type { EditorProviderCapabilities } from "./editor-provider-contracts";
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
/** Idle sessions retain metadata only; active IO and temporary bytes have separate budgets. */
export const EDITOR_USER_MAX_SESSIONS = 4096;
export const EDITOR_MAX_SESSIONS = 16384;
export const EDITOR_MAX_UPLOADS_PER_SESSION = 32;
export const EDITOR_MAX_OPERATIONS = 1024;
export const EDITOR_USER_MAX_OPERATIONS = 128;
export const EDITOR_USER_TEMP_MAX_BYTES = 512 * 1024 * 1024;
export const EDITOR_TEMP_MAX_BYTES = 2 * 1024 * 1024 * 1024;

interface EditorDocumentInput {
	path: string;
	deviceId?: string;
	origin: "reference" | "legacy";
}
/** Explicit protocol negotiation: omission still preserves old clients' v1 semantics. */
export type CreateEditorDocumentInput = EditorDocumentInput &
	({ protocol?: "text-v1" } | { protocol: "raw-v2"; encodingHint?: EditorRawEncoding });
export type EditorReadMode = "raw-v2" | "text-v1" | "bounded-preview";
export type EditorRawEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gbk" | "gb18030";
export type EditorBom = "none" | "utf8" | "utf16le" | "utf16be";
export interface EditorRawMetadata {
	protocol: "raw-v2";
	hashKind: "raw-sha256";
	baseHash: string;
	textDigest: string;
	encoding: EditorRawEncoding;
	bom: EditorBom;
	sourceBytes: number;
	utf8Bytes: number;
	textLength: number;
	lineCount: number;
	maxLineLength: number;
	eolCounts: { LF: number; CRLF: number; CR: number };
	preferredEol: "LF" | "CRLF" | "CR";
	eol: "LF" | "CRLF" | "CR";
	formatVersion: 1;
}
export const EDITOR_RAW_WINDOW_BYTES = 256 * 1024;
export const EDITOR_RAW_MAX_STREAMS = 8;

export type EditorRecoveryScopeInput = Pick<CreateEditorDocumentInput, "deviceId" | "origin">;
/** Server-derived original-owner namespace; it grants no file read/write or model sharing. */
export interface EditorRecoveryScope {
	recoveryKey: string;
}

export type EditorDocumentDescriptor = EditorV1DocumentDescriptor | EditorRawDocumentDescriptor;
export interface EditorRawDocumentDescriptor
	extends Omit<EditorV1DocumentDescriptor, "protocol" | "hashKind" | "encoding">,
		EditorRawMetadata {}
export interface EditorV1DocumentDescriptor {
	protocol?: "text-v1";
	hashKind?: "decoded-sha256";
	docId: string;
	/** Opaque, server-authorized identity; absent on older v1 servers (no sharing). */
	resourceKey?: string;
	/** Same verified permission/root scope across runtime-only reconnects. Never a capability. */
	stableResourceKey?: string;
	/** Opaque verified principal/narrator/device/origin scope; discovery only, never model sharing. */
	recoveryKey?: string;
	target: FileTarget;
	versionHandle: string;
	baseHash: string;
	encoding: string;
	eol: "LF" | "CRLF" | "CR";
	sourceBytes: number;
	utf8Bytes: number;
	/**
	 * Capabilities the provider has already verified for this authorized
	 * resource. Omitted by older v1 servers; UI code that reads it must keep
	 * its original heuristic as a fallback. See
	 * shared/editor-provider-contracts.ts for Phase 6-9 semantics.
	 */
	capabilities?: EditorProviderCapabilities;
}

export interface CreateEditorUploadInput {
	baseHash: string | null;
	encoding: string;
	snapshotRevision: number;
	protocol?: "raw-v2";
	hashKind?: "raw-sha256";
	bom?: EditorBom;
}
export interface EditorRawSeal {
	protocol: "raw-v2";
	hashKind: "raw-sha256";
	bytes: number;
	rawDigest: string;
	textDigest: string;
	formatDigest: string;
	textLength: number;
	newlines: number;
}
export interface EditorUploadChunkInput {
	seq: number;
	offset: number;
	bytes: number;
	digest: string;
}
export const EDITOR_UPLOAD_CHUNK_BYTES = 256 * 1024;

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
	/** Local checkpoint provenance only; never grants file access. */
	draftWriterId?: string;
	draftModelLifetime?: string;
}
export interface EditorDraftAnchorOperation {
	operationId?: string;
	snapshotRevision: number;
}
export interface CreateEditorDraftAnchorInput extends EditorRecoveryScopeInput {
	writerId: string;
	resourceKey: string;
	revision: number;
	modelLifetime: string;
	operation?: EditorDraftAnchorOperation;
}
export interface EditorDraftAnchorDescriptor {
	anchorId: string;
	checkpointGeneration: string;
	recoveryKey: string;
	resourceKey: string;
	writerId: string;
	revision: number;
	modelLifetime: string;
	status: "no-dispatch" | "query-first";
	operation?: EditorDraftAnchorOperation;
	retired: boolean;
	expiresAt: number;
}

export interface EditorSaveResult {
	hashKind?: "raw-sha256";
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

/**
 * Bounded identity probe for an authorized editor document's disk source.
 *
 * Does not open a new session, does not read file bytes to the client, and never
 * modifies the saved baseline. `baseHash` uses the same v1 hashing domain as
 * {@link EditorDocumentDescriptor.baseHash} so a client can compare without
 * re-reading the document.
 */
export type EditorDiskState =
	| ({ exists: true } & EditorRawMetadata)
	| { exists: false; protocol?: "raw-v2"; hashKind?: "raw-sha256" }
	| {
			exists: true;
			baseHash: string;
			encoding: string;
			eol: "LF" | "CRLF" | "CR";
			sourceBytes: number;
			utf8Bytes: number;
	  };
