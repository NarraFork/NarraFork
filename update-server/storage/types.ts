/**
 * Storage backend interface.
 * Abstracts file storage to allow future S3 implementation.
 */

export interface StorageBackend {
	/** Save a file (Buffer or stream). */
	saveFile(path: string, data: Buffer | ReadableStream): Promise<void>;

	/** Read entire file into memory. Returns null if not found. */
	getFile(path: string): Promise<Buffer | null>;

	/** Get a readable stream for a file. Returns null if not found. */
	getFileStream(path: string): Promise<ReadableStream | null>;

	/** Get file size in bytes. Returns null if not found. */
	getFileSize(path: string): Promise<number | null>;

	/** Delete a single file. No-op if not found. */
	deleteFile(path: string): Promise<void>;

	/** Recursively delete a directory. No-op if not found. */
	deleteDirectory(path: string): Promise<void>;

	/** List files under a prefix (relative paths). */
	listFiles(prefix: string): Promise<string[]>;

	/** Check if a file exists. */
	fileExists(path: string): Promise<boolean>;

	/** Stream a slice of a file for Range requests. Returns null if not found. */
	getFileSliceStream(path: string, start: number, end: number): Promise<ReadableStream | null>;
}
