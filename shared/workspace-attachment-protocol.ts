import type { RemoteHistoryBinding } from "./remote-history-protocol";

/** Independent streaming attachment IO. It does not increase any history blob budget. */
export const FEATURE_WORKSPACE_ATTACHMENT_V1 = "workspace.attachment.v1";
export const WORKSPACE_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
export const WORKSPACE_ATTACHMENT_CHUNK_BYTES = 64 * 1024;
export const WORKSPACE_ATTACHMENT_METADATA_TIMEOUT_MS = 10_000;
export const WORKSPACE_ATTACHMENT_OPERATION_TIMEOUT_MS = 300_000;

/** Root identity and fence come from the real native/history namespace, never caller invention. */
export type WorkspaceAttachmentBinding = RemoteHistoryBinding;

export interface WorkspaceAttachmentIntent {
	binding: WorkspaceAttachmentBinding;
	operationId: string;
	requestDigest: string;
	/** Target grammar, relative to binding.root. Only one regular file is created. */
	path: string;
	sizeBytes: number;
	digest: string;
	/** The primitive must reject an existing target, including symlink/hard-link replacements. */
	expected: "absent";
	noOverwrite: true;
}

/** Created by the exclusive publisher and loaded/validated against its private durable receipt. */
export interface WorkspaceAttachmentCreationProof {
	version: 1;
	binding: WorkspaceAttachmentBinding;
	operationId: string;
	requestDigest: string;
	path: string;
	sizeBytes: number;
	digest: string;
	incarnation: string;
	nativeMetadataDigest: string;
	/** Opaque primitive-issued proof. A digest or random pathname alone is not ownership. */
	creationProof: string;
	state: "committed";
	createdAt: string;
}

export interface WorkspaceAttachmentStatus {
	binding: WorkspaceAttachmentBinding;
	operationId: string;
	requestDigest: string;
	path: string;
	writtenBytes: number;
	state: "pending" | "committed" | "conflict" | "unknown" | "cleaned";
	proof?: WorkspaceAttachmentCreationProof;
	reason?: string;
}

export interface WorkspaceAttachmentCleanup {
	binding: WorkspaceAttachmentBinding;
	operationId: string;
	requestDigest: string;
	outcome: "deleted" | "already_deleted" | "conflict" | "unknown";
	reason?: string;
}

export interface WorkspaceAttachmentOperations {
	begin: { request: WorkspaceAttachmentIntent; result: WorkspaceAttachmentStatus };
	append: {
		request: {
			binding: WorkspaceAttachmentBinding;
			operationId: string;
			requestDigest: string;
			offset: number;
			/** Base64 of exactly one bounded chunk, never the whole attachment. */
			contentBase64: string;
			chunkDigest: string;
		};
		result: WorkspaceAttachmentStatus;
	};
	commit: {
		request: { binding: WorkspaceAttachmentBinding; operationId: string; requestDigest: string };
		result: WorkspaceAttachmentStatus;
	};
	status: {
		request: { binding: WorkspaceAttachmentBinding; operationId: string; requestDigest: string };
		result: WorkspaceAttachmentStatus;
	};
	cleanup: {
		request: {
			binding: WorkspaceAttachmentBinding;
			operationId: string;
			requestDigest: string;
			/** Exact ORIGINAL creation receipt, never a refreshed observation of current bytes. */
			proof: WorkspaceAttachmentCreationProof;
		};
		result: WorkspaceAttachmentCleanup;
	};
}
export type WorkspaceAttachmentOperation = keyof WorkspaceAttachmentOperations;
export type WorkspaceAttachmentRpcMethod = `attachment.${WorkspaceAttachmentOperation}`;

export interface WorkspaceAttachmentBackend {
	readonly supportsWorkspaceAttachment?: boolean;
	workspaceAttachment<K extends WorkspaceAttachmentOperation>(
		operation: K,
		request: WorkspaceAttachmentOperations[K]["request"],
		signal?: AbortSignal,
	): Promise<WorkspaceAttachmentOperations[K]["result"]>;
}
