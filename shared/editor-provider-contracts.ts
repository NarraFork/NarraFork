/**
 * Editor provider capabilities and the frozen Phase 6-9 wire contracts.
 *
 * Capabilities describe what the provider behind ONE authorized resource can
 * actually do today. They never grant access: every operation is reauthorized
 * on the host. Phase 6-9 flags stay false until their handler and tests ship.
 *
 * The request/response types below are mirrored in
 * remote-executor/internal/rpc/editor_contracts.go and pinned by the shared
 * fixture editor-provider-contracts.golden.json (decoded strictly by Go and
 * type/enum-checked by TS). Raw read and durable write are individually negotiated;
 * watch remains unavailable until its handler and tests ship.
 */

export interface EditorProviderCapabilities {
	readonly writeUnavailableReason?:
		| "verified_helper_unavailable"
		| "durable_executor_unavailable"
		| "host_receipt_storage_unavailable";
	/** Bounded, identity-verified read of the complete current source (never truncated). */
	readonly boundedRead: boolean;
	/** Existing v1 upload/commit save. Not a durable/atomic apply. */
	readonly v1Save: boolean;
	/** Phase 6: raw-v2 streamed read. */
	readonly rawRead: boolean;
	/** Phase 7/8: private stage + chunk + seal. */
	readonly stage: boolean;
	/** Phase 8: durable atomic apply. */
	readonly durableApply: boolean;
	/** Phase 8: durable operation query. */
	readonly durableQuery: boolean;
	/** Phase 9: authorized change subscription. */
	readonly watch: boolean;
}

export const EDITOR_NO_CAPABILITIES: EditorProviderCapabilities = Object.freeze({
	boundedRead: false,
	v1Save: false,
	rawRead: false,
	stage: false,
	durableApply: false,
	durableQuery: false,
	watch: false,
});
/** Local editor-document session: authorized v1 read and v1 save. */
export const EDITOR_LOCAL_V1_CAPABILITIES: EditorProviderCapabilities = Object.freeze({
	...EDITOR_NO_CAPABILITIES,
	boundedRead: true,
	v1Save: true,
});
/** A complete bounded read through the file-reference chain, with no save path. */
export const EDITOR_BOUNDED_READ_CAPABILITIES: EditorProviderCapabilities = Object.freeze({
	...EDITOR_NO_CAPABILITIES,
	boundedRead: true,
});

// ── Shared identity ──────────────────────────────────────────────────────────

export const EDITOR_PATH_FLAVORS = ["posix", "windows"] as const;
export interface EditorResourceIdentity {
	readonly deviceId: string;
	readonly pathFlavor: (typeof EDITOR_PATH_FLAVORS)[number];
	readonly canonicalPath: string;
	/** Execution root identity (canonical root + filesystem identity), not a UI workspace. */
	readonly workspaceIdentity: string;
	readonly runtimeEpoch: string;
	readonly runtimeGeneration: number;
	readonly fencingToken: number;
}

// ── Phase 6: raw read ────────────────────────────────────────────────────────

export interface EditorRawReadPreflight {
	readonly resourceKey: string;
	readonly identity: EditorResourceIdentity;
	readonly maxBytes: number;
	readonly timeoutMs: number;
}
export interface EditorRawReadOpen {
	readonly readId: string;
	/** Changes whenever the source is replaced; every chunk must repeat it. */
	readonly sourceGeneration: string;
	readonly totalBytes: number;
	readonly rawDigest: string;
	readonly identity: EditorResourceIdentity;
}
export interface EditorRawReadChunkRequest {
	readonly readId: string;
	readonly offset: number;
	/** Credit: the most bytes the consumer can accept for this chunk. */
	readonly maxBytes: number;
	readonly timeoutMs: number;
}
export interface EditorRawReadChunk {
	readonly readId: string;
	readonly sourceGeneration: string;
	readonly offset: number;
	readonly bytes: number;
	readonly dataB64: string;
	/** True only after the provider re-verified total bytes, raw digest and identity. */
	readonly eof: boolean;
}
export interface EditorRawReadClose {
	readonly readId: string;
	readonly abort: boolean;
}

// ── Phase 7/8: stage, apply, query ───────────────────────────────────────────

export interface EditorWriteOwner {
	/** Stable source instance + authenticated owner + device; never connection generation. */
	readonly namespace: string;
	readonly resourceKey: string;
}
export interface EditorHelperCapabilities {
	readonly protocolVersion: 1;
	readonly features: readonly string[];
	readonly maxChunkBytes: number;
	readonly maxBytes: number;
	readonly runtimeEpoch: string;
}
export interface EditorStageOpen extends EditorWriteOwner {
	readonly maxBytes: number;
	readonly idleTimeoutMs: number;
}
/** Private, resource-bound handle. Requests never name a staging path. */
export interface EditorStageHandle {
	readonly stageId: string;
	readonly resourceKey: string;
	readonly expiresAt: number;
}
export interface EditorStageAppend extends EditorWriteOwner {
	readonly stageId: string;
	readonly seq: number;
	readonly offset: number;
	readonly bytes: number;
	readonly digest: string;
	readonly dataB64: string;
}
export interface EditorStageSeal extends EditorWriteOwner {
	readonly stageId: string;
	readonly totalBytes: number;
	readonly rawDigest: string;
}
export const EDITOR_STAGE_ABORT_REASONS = ["cancel", "idle_timeout", "superseded"] as const;
export interface EditorStageAbort extends EditorWriteOwner {
	readonly stageId: string;
	readonly reason: (typeof EDITOR_STAGE_ABORT_REASONS)[number];
}
export const EDITOR_METADATA_POLICIES = ["preserve", "reject"] as const;
export interface EditorApplyRequest extends EditorWriteOwner {
	readonly operationId: string;
	readonly requestDigest: string;
	readonly stageId: string;
	/** Required. null means the target must not exist. */
	readonly expectedRawHash: string | null;
	readonly identity: EditorResourceIdentity;
	readonly metadataPolicy: (typeof EDITOR_METADATA_POLICIES)[number];
}
export const EDITOR_APPLY_OUTCOMES = ["committed", "rejected", "uncertain"] as const;
export interface EditorApplyResult {
	readonly operationId: string;
	readonly outcome: (typeof EDITOR_APPLY_OUTCOMES)[number];
	/** Required. null unless the provider durably proved the written bytes. */
	readonly rawDigest: string | null;
	readonly totalBytes: number | null;
	/** Optional: omitted on committed. */
	readonly error?: { readonly code: string; readonly message: string };
}
export interface EditorQueryRequest extends EditorWriteOwner {
	/** Host has durably settled its original effect/lease; permits bounded terminal retention. */
	readonly acknowledgeTerminal?: boolean;
	readonly operationId: string;
	readonly requestDigest: string;
}
/** not_found is NOT proven_not_executed and never permits a blind re-apply. */
export const EDITOR_QUERY_OUTCOMES = [
	"committed",
	"rejected",
	"uncertain",
	"not_found",
	"proven_not_executed",
] as const;
export interface EditorQueryResult {
	readonly operationId: string;
	readonly outcome: (typeof EDITOR_QUERY_OUTCOMES)[number];
	/** Required. null when no durable result exists. */
	readonly result: EditorApplyResult | null;
}

/** Host-only bounded recovery metadata; stdio bootstrap fixes its private directory.
 * These methods are intentionally unavailable to remote WebSocket RPC clients. */
export interface EditorHostReceiptRecord {
	version: 1;
	createdAt: number;
	userId: string;
	narratorId: string;
	deviceId: string;
	operationId: string;
	hostOperationId: string;
	leaseId: string;
	effectId: string;
	saved: { hash: string; bytes: number; snapshotRevision: number; hashKind?: "raw-sha256" };
	requestDigest: string;
	namespace: string;
	resourceKey: string;
	root: string;
	identity: EditorResourceIdentity;
	rawDigest: string;
	bytes: number;
	receipt?: EditorApplyResult;
}
// Native Host store H3 (VALUE): authoritative shape; earlier RECORD proposals are not wire contracts.
export interface EditorHostReceiptPut {
	value: EditorHostReceiptRecord;
}
export interface EditorHostReceiptGet {
	operationId: string;
}
export interface EditorHostReceiptValue {
	value: EditorHostReceiptRecord | null;
}
export interface EditorHostReceiptSettle {
	operationId: string;
	receipt: EditorApplyResult;
}

// ── Phase 9: watch ───────────────────────────────────────────────────────────

export interface EditorWatchOpen {
	readonly resourceKey: string;
}
export interface EditorWatchHandle {
	readonly subscriptionId: string;
	readonly resourceKey: string;
	readonly generation: number;
}
export const EDITOR_WATCH_REASONS = [
	"content_changed",
	"metadata_changed",
	"deleted",
	"replaced",
	"generation_reset",
] as const;
/** Opaque notification: no path, no body. A subscription grants no read/write. */
export interface EditorWatchNotify {
	readonly subscriptionId: string;
	readonly seq: number;
	readonly generation: number;
	readonly reason: (typeof EDITOR_WATCH_REASONS)[number];
}
export interface EditorWatchClose {
	readonly subscriptionId: string;
}

export const EDITOR_PROVIDER_ERRORS = Object.freeze({
	identityChanged: "EDITOR_IDENTITY_CHANGED",
	runtimeChanged: "EDITOR_RUNTIME_CHANGED",
	fencingRejected: "EDITOR_FENCING_REJECTED",
	stageDigestMismatch: "EDITOR_STAGE_DIGEST_MISMATCH",
	stageSealFailed: "EDITOR_STAGE_SEAL_FAILED",
	applyRejected: "EDITOR_APPLY_REJECTED",
	notFound: "EDITOR_NOT_FOUND",
	uncertain: "EDITOR_UNCERTAIN",
	unsupported: "EDITOR_PROVIDER_UNSUPPORTED",
} as const);
