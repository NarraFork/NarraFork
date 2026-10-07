/** Target archive IO only; publication and actor/device/source authorization stay in TS. */
export const FEATURE_SHARE_ARCHIVE_V1 = "share.archive.v1";
export const SHARE_ARCHIVE_METADATA_TIMEOUT_MS = 10_000;
export const SHARE_ARCHIVE_OPERATION_TIMEOUT_MS = 120_000;

export interface ShareArchiveLimits {
	maxEntries?: number;
	maxExpandedBytes?: number;
	maxArchiveBytes?: number;
	maxBytes?: number;
	timeoutMs?: number;
}

export interface ShareArchiveRequest extends ShareArchiveLimits {
	operation: "inspect" | "prepare" | "readChunk" | "release";
	operationId: string;
	paths?: string[];
	manifestHash?: string;
	artifactId?: string;
	offset?: number;
	/** readChunk only; source cap 1 MiB, with EOF and exact offset verification. */
	maxChunkBytes?: number;
	format?: "raw" | "gz" | "tar.gz" | "zip";
}

export interface ShareArchiveEntry {
	path: string;
	sizeBytes: number;
	isDirectory: boolean;
	isSymlink?: boolean;
	mode?: number;
	modifiedAt?: string;
}

export interface ShareArchiveResult {
	operationId: string;
	manifestHash?: string;
	entries?: ShareArchiveEntry[];
	entryCount?: number;
	expandedBytes?: number;
	truncated?: boolean;
	artifactId?: string;
	archiveSizeBytes?: number;
	archiveDigest?: string;
	format?: "raw" | "gz" | "tar.gz" | "zip";
	sourceBaseName?: string;
	filename?: string;
	originalName?: string;
	isDirectory?: boolean;
	/** Chunk is scoped to the prepared opaque artifact, never an arbitrary path. */
	contentBase64?: string;
	offset?: number;
	eof?: boolean;
	released?: boolean;
	reason?: string;
}
