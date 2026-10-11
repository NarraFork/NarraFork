import type { FileChangeBlobRef, FileChangeState } from "./file-change-protocol";

/** Additive feature: private durable IO, not complete workspace recovery integration. */
export const FEATURE_REMOTE_HISTORY_V1 = "history.v1";
export const FEATURE_REMOTE_HISTORY_CAPTURE_TREE_V1 = "history.capture-tree.v1";
export const FEATURE_REMOTE_HISTORY_OBJECT_STAGE_V1 = "history.object-stage.v1";
export const FEATURE_REMOTE_HISTORY_NATIVE_METADATA_V1 = "history.native-metadata.v1";
/** Exact, helper-issued Windows metadata; legacy partial evidence is never upgraded. */
export const FEATURE_REMOTE_HISTORY_NATIVE_METADATA_V2 = "history.native-metadata.v2";
/** Identity-bound original objects are isolated in a private vault on their source volume. */
export const FEATURE_REMOTE_HISTORY_VOLUME_VAULT_V1 = "history.volume-vault.v1";
export const REMOTE_HISTORY_METADATA_TIMEOUT_MS = 10_000;
export const REMOTE_HISTORY_OPERATION_TIMEOUT_MS = 120_000;

export interface RemoteHistoryBinding {
	sourceInstanceId: string;
	workspaceInstanceId: string;
	scopeId: string;
	root: string;
	rootIdentity: string;
	fence: number;
}

/** Never treat this descriptor as a ready server FileChangeBlobRef placement. */
export interface RemoteHistoryObject extends FileChangeBlobRef {
	sourceInstanceId: string;
	workspaceInstanceId: string;
	scopeId: string;
	objectId: string;
	kind: "blob" | "tree";
	/** Recorded relative origin, checked against live target policy on every object read. */
	path: string;
}

export type RemoteHistoryState =
	| { kind: "absent" }
	| {
			kind: "regular";
			object: RemoteHistoryObject;
			mode: number;
			metadata?: RemoteHistoryObject;
			/** Exact v2 metadata semantics from a verified helper record, never standalone authority. */
			nativeMetadataFingerprint?: string;
			incarnation?: string;
	  };

export interface RemoteHistoryChange {
	/** Relative, target-grammar path within this binding's root. */
	path: string;
	expected: RemoteHistoryState;
	desired: RemoteHistoryState;
	contentBase64?: string;
}

export interface RemoteHistoryEffect {
	path: string;
	before: RemoteHistoryState;
	intended: RemoteHistoryState;
	after?: RemoteHistoryState;
	outcome: "pending" | "dispatching" | "applied" | "unknown";
}

export interface RemoteHistoryReceipt {
	captureKind?: "whole_directory";
	capturePhase?: "hot" | "warm";
	captureAttempts?: {
		phase: string;
		tree?: RemoteHistoryObject;
		coverage: string;
		reason?: string;
	}[];
	entryCount?: number;
	excludedCount?: number;
	candidateBytes?: number;
	consistency?: "stable_double_scan" | "changed" | "unknown";
	policyDigest?: string;
	operationId: string;
	requestDigest: string;
	payloadDigest: string;
	binding: RemoteHistoryBinding;
	kind: "capture" | "mutate" | "restore" | "compensate";
	/** Rejected is durable proof that every effect remained pending, not successful IO. */
	state:
		| "intent"
		| "applying"
		| "settled"
		| "finalized"
		| "compensated"
		| "rejected"
		| "recovery_required";
	effects: RemoteHistoryEffect[];
	tree?: RemoteHistoryObject;
	/** Complete selected-path evidence; never implies complete workspace coverage. */
	coverage?: "complete" | "partial";
	temporalConsistency?: "concurrent_observation";
	reason?: string;
	startedAt: string;
	finishedAt?: string;
	serverCommitId?: string;
}

export interface RemoteHistoryRequest {
	/** Only narrows target PathGuard; never a grant. Bound by the caller's authorization. */
	treePolicy?: { deniedDirectories: string[]; policyDigest: string };
	capturePhase?: "hot" | "warm";
	binding: RemoteHistoryBinding;
	operationId: string;
	requestDigest: string;
	changes?: RemoteHistoryChange[];
	paths?: string[];
	originalOperationId?: string;
}

export interface RemoteHistoryObservation {
	path: string;
	state?: RemoteHistoryState;
	error?: string;
}

export interface RemoteHistoryInspection {
	binding: RemoteHistoryBinding;
	observations: RemoteHistoryObservation[];
	pending: RemoteHistoryReceipt[];
	nextCursor?: string;
}

export interface RemoteHistoryObjectRead {
	object: RemoteHistoryObject;
	contentBase64: string;
	offset: number;
	eof: boolean;
}

export interface RemoteObjectStageStatus {
	stageId: string;
	binding: RemoteHistoryBinding;
	requestDigest: string;
	object: RemoteHistoryObject;
	written: number;
	state: "pending" | "ready" | "unknown";
}

export interface RemoteHistoryOperations {
	objectStage: {
		request: {
			binding: RemoteHistoryBinding;
			operation: "begin" | "append" | "finish" | "status";
			stageId: string;
			requestDigest: string;
			object: RemoteHistoryObject;
			offset?: number;
			contentBase64?: string;
			chunkDigest?: string;
		};
		result: RemoteObjectStageStatus;
	};
	open: {
		request: { root: string; scopeId: string; fence: number };
		result: RemoteHistoryBinding;
	};
	capture: { request: RemoteHistoryRequest; result: RemoteHistoryReceipt };
	captureTree: { request: RemoteHistoryRequest; result: RemoteHistoryReceipt };
	mutate: { request: RemoteHistoryRequest; result: RemoteHistoryReceipt };
	restore: { request: RemoteHistoryRequest; result: RemoteHistoryReceipt };
	compensate: { request: RemoteHistoryRequest; result: RemoteHistoryReceipt };
	status: {
		request: { binding: RemoteHistoryBinding; operationId: string };
		result: RemoteHistoryReceipt;
	};
	finalize: {
		request: {
			binding: RemoteHistoryBinding;
			operationId: string;
			requestDigest: string;
			serverCommitId: string;
		};
		result: RemoteHistoryReceipt;
	};
	objectRead: {
		request: {
			binding: RemoteHistoryBinding;
			object: RemoteHistoryObject;
			offset: number;
			maxBytes: number;
		};
		result: RemoteHistoryObjectRead;
	};
	inspect: {
		request: { binding: RemoteHistoryBinding; paths: string[]; cursor?: string };
		result: RemoteHistoryInspection;
	};
}

export type RemoteHistoryOperation = keyof RemoteHistoryOperations;
export type RemoteHistoryRpcMethod = `history.${RemoteHistoryOperation}`;

export interface RemoteHistoryBackend {
	readonly supportsRemoteHistory?: boolean;
	readonly supportsRemoteTreeCapture?: boolean;
	readonly supportsRemoteObjectStage?: boolean;
	readonly remoteHistoryChunkBytes?: number;
	remoteHistory<K extends RemoteHistoryOperation>(
		operation: K,
		request: RemoteHistoryOperations[K]["request"],
		signal?: AbortSignal,
	): Promise<RemoteHistoryOperations[K]["result"]>;
}

/** Evidence projection only. Caller must keep the source-qualified catalog. */
export function remoteHistoryFileState(state: RemoteHistoryState): FileChangeState {
	if (state.kind === "absent") return { kind: "absent" };
	return {
		kind: "regular",
		blob: {
			algorithm: state.object.algorithm,
			digest: state.object.digest,
			sizeBytes: state.object.sizeBytes,
		},
		mode: state.mode,
	};
}
