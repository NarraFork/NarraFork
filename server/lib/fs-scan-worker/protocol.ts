/** Lightweight directory-scan contract. The server client must not import the walk implementation. */

/** Entry budget shared by all roots in one measurement call. */
export const DIR_SCAN_MAX_ENTRIES = 2_000_000;

/** Maximum directory nesting depth for a measured root. */
export const DIR_SCAN_MAX_DEPTH = 64;

export interface DirectoryTreeMeasurement {
	sizeBytes: number;
	entriesScanned: number;
	truncated: boolean;
}

export class DirectoryMeasureAbortedError extends Error {
	constructor() {
		super("directory measure aborted");
		this.name = "DirectoryMeasureAbortedError";
	}
}

export interface MeasureDirectoryTreesOptions {
	maxEntries?: number;
	maxDepth?: number;
	signal?: AbortSignal;
	onProgress?: (progress: { entriesScanned: number; sizeBytes: number }) => void;
}
