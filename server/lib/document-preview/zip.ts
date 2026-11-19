/**
 * Minimal ZIP reader for OOXML containers (DOCX/DOCM).
 *
 * Deliberately stdlib-only: a DOCX is a ZIP whose only needed primitive is raw
 * deflate, which `node:zlib` already ships. Pulling in a zip library would add a
 * dependency tree for one format's sake.
 *
 * Bounded by construction — a package is attacker-supplied input:
 *   - entry count, per-entry uncompressed size, and total inflated bytes are capped
 *   - nothing is written to disk; entries are inflated into memory on demand
 *   - a central-directory record that disagrees with the file's actual length is refused
 *
 * Ported from `examples/plugins/doc-markdown/server/lib/zip.js` (branch
 * `experiment/doc-to-markdown`) into ESM + types, with the same limits.
 */

import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const SPANNING_SIGNATURE = 0x08074b50;
const EOCD_MIN_BYTES = 22;
const EOCD_SCAN_BYTES = 66_000;

const MAX_ENTRIES = 4096;
const MAX_UNCOMPRESSED_TOTAL = 512 * 1024 * 1024;
const MAX_ENTRY_UNCOMPRESSED = 128 * 1024 * 1024;

export interface ZipEntry {
	name: string;
	compressionMethod: number;
	compressedSize: number;
	uncompressedSize: number;
	localOffset: number;
	isDirectory: boolean;
}

export interface ZipArchive {
	/** File names in archive order, directories excluded. */
	names: string[];
	has(name: string): boolean;
	/** Uncompressed bytes of one entry, or `undefined` when it is absent. */
	read(name: string): Uint8Array | undefined;
	/** UTF-8 text of one entry, or `undefined` when it is absent. */
	text(name: string): string | undefined;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
	const scanStart = Math.max(0, buffer.length - EOCD_SCAN_BYTES);
	for (let offset = buffer.length - EOCD_MIN_BYTES; offset >= scanStart; offset -= 1) {
		if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
		// A comment of N bytes follows the fixed record; reject a signature that only
		// looks right because it sits inside trailing comment bytes.
		const commentLength = buffer.readUInt16LE(offset + 20);
		if (offset + EOCD_MIN_BYTES + commentLength === buffer.length) return offset;
	}
	return -1;
}

/** Parse the central directory. Returns entries in archive order. */
export function readCentralDirectory(buffer: Buffer): ZipEntry[] {
	const eocd = findEndOfCentralDirectory(buffer);
	if (eocd < 0) throw new Error("Not a ZIP archive: end of central directory not found");

	const entryCount = buffer.readUInt16LE(eocd + 10);
	if (entryCount > MAX_ENTRIES) {
		throw new Error(`ZIP archive declares ${entryCount} entries; the limit is ${MAX_ENTRIES}`);
	}
	let offset = buffer.readUInt32LE(eocd + 16);
	const entries: ZipEntry[] = [];

	for (let index = 0; index < entryCount; index += 1) {
		if (offset + 46 > buffer.length) throw new Error("Truncated ZIP central directory");
		if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
			throw new Error("Corrupt ZIP central directory entry");
		}
		const compressionMethod = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const uncompressedSize = buffer.readUInt32LE(offset + 24);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

		entries.push({
			name,
			compressionMethod,
			compressedSize,
			uncompressedSize,
			localOffset,
			isDirectory: name.endsWith("/"),
		});

		offset += 46 + nameLength + extraLength + commentLength;
	}

	return entries;
}

/**
 * Open a ZIP archive held in memory.
 *
 * `read(name)` inflates one entry; callers read only the parts they need, so a large
 * document never inflates in full.
 */
export function openZip(buffer: Buffer): ZipArchive {
	if (!Buffer.isBuffer(buffer)) throw new Error("openZip expects a Buffer");
	const entries = readCentralDirectory(buffer);
	const byName = new Map(entries.map((entry) => [entry.name, entry]));
	const inflated = new Map<string, Uint8Array>();
	let inflatedTotal = 0;

	const read = (name: string): Uint8Array | undefined => {
		const entry = byName.get(name);
		if (!entry) return undefined;
		const cached = inflated.get(name);
		if (cached) return cached;

		if (entry.uncompressedSize > MAX_ENTRY_UNCOMPRESSED) {
			throw new Error(`ZIP entry is too large to read: ${name}`);
		}
		if (entry.localOffset + 30 > buffer.length) throw new Error(`Truncated ZIP entry: ${name}`);
		if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
			throw new Error(`Corrupt ZIP local header: ${name}`);
		}
		const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
		const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
		const dataStart = entry.localOffset + 30 + nameLength + extraLength;
		const dataEnd = dataStart + entry.compressedSize;
		if (dataEnd > buffer.length) throw new Error(`Truncated ZIP payload: ${name}`);

		const raw = buffer.subarray(dataStart, dataEnd);
		let bytes: Uint8Array;
		if (entry.compressionMethod === 0) {
			bytes = raw;
		} else if (entry.compressionMethod === 8) {
			bytes = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_UNCOMPRESSED });
		} else {
			throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod}: ${name}`);
		}

		inflatedTotal += bytes.length;
		if (inflatedTotal > MAX_UNCOMPRESSED_TOTAL) {
			throw new Error("ZIP archive expands beyond the readable limit");
		}
		inflated.set(name, bytes);
		return bytes;
	};

	const text = (name: string): string | undefined => {
		const bytes = read(name);
		return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8");
	};

	return {
		names: entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name),
		has: (name) => byName.has(name),
		read,
		text,
	};
}

/** True when the first bytes are a ZIP header — checked before any extension is trusted. */
export function looksLikeZip(buffer: Buffer): boolean {
	if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
	const signature = buffer.readUInt32LE(0);
	return (
		signature === LOCAL_SIGNATURE ||
		signature === EOCD_SIGNATURE ||
		signature === SPANNING_SIGNATURE ||
		signature === CENTRAL_SIGNATURE
	);
}
