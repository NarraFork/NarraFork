/**
 * Blockmap generation and parsing for delta updates.
 * Compatible with electron-builder blockmap format.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { basename } from "node:path";
import { createGunzip, createGzip } from "node:zlib";

/** Default block size: 64KB (same as electron-builder) */
export const DEFAULT_BLOCK_SIZE = 64 * 1024;

export interface BlockmapFile {
	/** File name */
	name: string;
	/** Offset within archive (0 for single file) */
	offset: number;
	/** SHA256 checksum of each block (base64 encoded) */
	checksums: string[];
	/** Size of each block in bytes */
	sizes: number[];
}

export interface Blockmap {
	version: "2";
	files: BlockmapFile[];
}

export interface BlockmapGenerateResult {
	blockmap: Blockmap;
	/** SHA512 hash of the entire file (base64 encoded) */
	sha512: string;
	/** Total file size in bytes */
	fileSize: number;
}

/**
 * Generate a blockmap for a file.
 * Reads the file in chunks and computes SHA256 for each block.
 */
export async function generateBlockmap(
	filePath: string,
	blockSize = DEFAULT_BLOCK_SIZE,
): Promise<BlockmapGenerateResult> {
	const fileSize = statSync(filePath).size;
	const checksums: string[] = [];
	const sizes: number[] = [];

	// SHA512 for the entire file
	const sha512Hash = createHash("sha512");

	return new Promise((resolve, reject) => {
		const stream = createReadStream(filePath, { highWaterMark: blockSize });
		let currentBlock = Buffer.alloc(0);

		stream.on("data", (chunk: Buffer) => {
			sha512Hash.update(chunk);

			// Accumulate data into current block
			currentBlock = Buffer.concat([currentBlock, chunk]);

			// Process complete blocks
			while (currentBlock.length >= blockSize) {
				const block = currentBlock.subarray(0, blockSize);
				const hash = createHash("sha256").update(block).digest("base64");
				checksums.push(hash);
				sizes.push(blockSize);
				currentBlock = currentBlock.subarray(blockSize);
			}
		});

		stream.on("end", () => {
			// Process remaining data as final block
			if (currentBlock.length > 0) {
				const hash = createHash("sha256").update(currentBlock).digest("base64");
				checksums.push(hash);
				sizes.push(currentBlock.length);
			}

			const blockmap: Blockmap = {
				version: "2",
				files: [
					{
						name: basename(filePath),
						offset: 0,
						checksums,
						sizes,
					},
				],
			};

			resolve({
				blockmap,
				sha512: sha512Hash.digest("base64"),
				fileSize,
			});
		});

		stream.on("error", reject);
	});
}

/**
 * Write blockmap to a gzip-compressed file.
 */
export async function writeBlockmapFile(blockmap: Blockmap, outputPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const json = JSON.stringify(blockmap);
		const gzip = createGzip({ level: 9 });
		const output = createWriteStream(outputPath);

		output.on("finish", resolve);
		output.on("error", reject);
		gzip.on("error", reject);

		gzip.pipe(output);
		gzip.end(json);
	});
}

/**
 * Read and parse a gzip-compressed blockmap file.
 */
export async function readBlockmapFile(filePath: string): Promise<Blockmap> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const gunzip = createGunzip();
		const input = createReadStream(filePath);

		gunzip.on("data", (chunk: Buffer) => chunks.push(chunk));
		gunzip.on("end", () => {
			try {
				const json = Buffer.concat(chunks).toString("utf-8");
				const blockmap = JSON.parse(json) as Blockmap;
				resolve(blockmap);
			} catch (err) {
				reject(err);
			}
		});
		gunzip.on("error", reject);
		input.on("error", reject);

		input.pipe(gunzip);
	});
}

/**
 * Parse blockmap from a Buffer (gzip compressed).
 */
export async function parseBlockmapBuffer(buffer: Buffer): Promise<Blockmap> {
	return new Promise((resolve, reject) => {
		const gunzip = createGunzip();
		const chunks: Buffer[] = [];

		gunzip.on("data", (chunk: Buffer) => chunks.push(chunk));
		gunzip.on("end", () => {
			try {
				const json = Buffer.concat(chunks).toString("utf-8");
				const blockmap = JSON.parse(json) as Blockmap;
				resolve(blockmap);
			} catch (err) {
				reject(err);
			}
		});
		gunzip.on("error", reject);

		gunzip.end(buffer);
	});
}

export interface DiffBlock {
	/** Block index */
	index: number;
	/** Byte offset in file */
	offset: number;
	/** Block size */
	size: number;
}

/**
 * Calculate which blocks differ between old and new blockmaps.
 * Returns the list of blocks that need to be downloaded.
 */
export function calculateDiff(oldBlockmap: Blockmap, newBlockmap: Blockmap): DiffBlock[] {
	const oldFile = oldBlockmap.files[0];
	const newFile = newBlockmap.files[0];

	if (!oldFile || !newFile) {
		throw new Error("Invalid blockmap: no files");
	}

	const diff: DiffBlock[] = [];
	let offset = 0;

	for (let i = 0; i < newFile.checksums.length; i++) {
		const newChecksum = newFile.checksums[i];
		const newSize = newFile.sizes[i];
		const oldChecksum = oldFile.checksums[i];

		// Block differs if checksum doesn't match or doesn't exist in old
		if (newChecksum !== oldChecksum) {
			diff.push({
				index: i,
				offset,
				size: newSize,
			});
		}

		offset += newSize;
	}

	return diff;
}

/**
 * Convert diff blocks to HTTP Range header value.
 * Merges adjacent blocks into ranges for efficiency.
 */
export function diffToRangeHeader(diff: DiffBlock[]): string {
	if (diff.length === 0) return "";

	// Sort by offset
	const sorted = [...diff].sort((a, b) => a.offset - b.offset);

	// Merge adjacent ranges
	const ranges: Array<{ start: number; end: number }> = [];
	let current = { start: sorted[0].offset, end: sorted[0].offset + sorted[0].size - 1 };

	for (let i = 1; i < sorted.length; i++) {
		const block = sorted[i];
		if (block.offset === current.end + 1) {
			// Adjacent, extend current range
			current.end = block.offset + block.size - 1;
		} else {
			// Gap, start new range
			ranges.push(current);
			current = { start: block.offset, end: block.offset + block.size - 1 };
		}
	}
	ranges.push(current);

	return `bytes=${ranges.map((r) => `${r.start}-${r.end}`).join(", ")}`;
}

/**
 * Calculate total bytes to download from diff.
 */
export function calculateDiffSize(diff: DiffBlock[]): number {
	return diff.reduce((sum, block) => sum + block.size, 0);
}

/**
 * Calculate total file size from blockmap.
 */
export function calculateTotalSize(blockmap: Blockmap): number {
	const file = blockmap.files[0];
	if (!file) return 0;
	return file.sizes.reduce((sum, size) => sum + size, 0);
}
