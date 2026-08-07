/**
 * Dependency-free ZIP reading and extraction.
 *
 * Plugin packages (`.nfplugin`/`.zip`) and knowledge packs used to be inspected
 * and unpacked by shelling out to `unzip`, which does not exist on Windows.
 * This module implements the small subset of the ZIP format those archives use
 * (store + deflate, optional ZIP64) on top of `node:zlib`, so extraction works
 * identically on every platform.
 *
 * Safety properties the callers rely on:
 *   - Metadata is read from the central directory *before* anything is written,
 *     so path traversal / symlink / size violations are rejected up front.
 *   - Every entry is streamed with hard caps on per-file bytes, total bytes and
 *     entry count; a decompression bomb aborts mid-stream instead of filling the
 *     disk.
 *   - CRC-32 and uncompressed size are verified per entry.
 *   - Symlinks and special filesystem entries are reported and never created.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib, { createInflateRaw } from "node:zlib";
import { isInsidePath } from "./platform-path";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const EOCD_MIN_SIZE = 22;
/** ZIP comments are at most 64 KiB, so the EOCD lives in the final ~64 KiB. */
const EOCD_SCAN_BYTES = 64 * 1024 + EOCD_MIN_SIZE;
const CENTRAL_ENTRY_MIN_SIZE = 46;
const LOCAL_HEADER_MIN_SIZE = 30;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8_NAME = 0x800;

const HOST_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;

/** Thrown for malformed, unsupported or unsafe archives. */
export class ZipArchiveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ZipArchiveError";
	}
}

export interface ZipReadLimits {
	/** Maximum number of central-directory entries. */
	maxEntries: number;
	/** Maximum uncompressed bytes for a single entry. */
	maxFileBytes: number;
	/** Maximum uncompressed bytes across all entries. */
	maxTotalBytes: number;
	/** Maximum central-directory size to buffer in memory. */
	maxCentralDirectoryBytes: number;
}

export interface ZipEntry {
	/** Raw entry name from the central directory, always using `/` separators. */
	name: string;
	isDirectory: boolean;
	/** True when the unix mode marks the entry as a symlink. */
	isSymlink: boolean;
	/** True when the unix mode marks the entry as neither a regular file nor a directory. */
	isSpecial: boolean;
	compressionMethod: number;
	compressedSize: number;
	uncompressedSize: number;
	crc32: number;
	localHeaderOffset: number;
	/** Unix permission bits when the archive records them, otherwise 0. */
	unixMode: number;
}

export interface ZipArchiveInfo {
	entries: ZipEntry[];
	/** Sum of uncompressed sizes across file entries. */
	totalUncompressedBytes: number;
	/** Number of non-directory entries. */
	fileCount: number;
}

export interface ExtractZipOptions {
	limits?: Partial<ZipReadLimits>;
	/** Pre-read archive info; avoids parsing the central directory twice. */
	info?: ZipArchiveInfo;
	/**
	 * Reject symlink/special entries instead of skipping them. Defaults to true —
	 * callers that unpack untrusted archives must not silently drop entries.
	 */
	rejectSymlinks?: boolean;
}

function createLimits(overrides?: Partial<ZipReadLimits>): ZipReadLimits {
	return {
		maxEntries: overrides?.maxEntries ?? DEFAULT_MAX_ENTRIES,
		maxFileBytes: overrides?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
		maxTotalBytes: overrides?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
		maxCentralDirectoryBytes:
			overrides?.maxCentralDirectoryBytes ?? DEFAULT_MAX_CENTRAL_DIRECTORY_BYTES,
	};
}

/** `zlib.crc32` exists on Bun and Node >= 20.15; fall back to a table otherwise. */
const crc32Table: number[] = (() => {
	const table: number[] = [];
	for (let i = 0; i < 256; i++) {
		let value = i;
		for (let bit = 0; bit < 8; bit++) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[i] = value >>> 0;
	}
	return table;
})();

const nativeCrc32 = (zlib as unknown as { crc32?: (data: Uint8Array, value?: number) => number })
	.crc32;

function updateCrc32(previous: number, data: Uint8Array): number {
	if (nativeCrc32) return nativeCrc32(data, previous) >>> 0;
	let crc = (previous ^ 0xffffffff) >>> 0;
	for (let i = 0; i < data.length; i++) {
		crc = (crc32Table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

type FileHandle = Awaited<ReturnType<typeof open>>;

async function readExact(
	handle: FileHandle,
	position: number,
	length: number,
	label: string,
): Promise<Buffer> {
	if (length === 0) return Buffer.alloc(0);
	const buffer = Buffer.allocUnsafe(length);
	let read = 0;
	while (read < length) {
		const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
		if (bytesRead === 0) break;
		read += bytesRead;
	}
	if (read !== length) throw new ZipArchiveError(`Archive is truncated while reading ${label}`);
	return buffer;
}

/** 64-bit little-endian read that refuses values above Number.MAX_SAFE_INTEGER. */
function readUInt64LE(buffer: Buffer, offset: number, label: string): number {
	const value = buffer.readBigUInt64LE(offset);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new ZipArchiveError(`Archive declares an unsupported ${label}`);
	}
	return Number(value);
}

interface CentralDirectoryLocation {
	offset: number;
	size: number;
	entryCount: number;
}

async function locateCentralDirectory(
	handle: FileHandle,
	archiveSize: number,
): Promise<CentralDirectoryLocation> {
	if (archiveSize < EOCD_MIN_SIZE)
		throw new ZipArchiveError("File is too small to be a ZIP archive");
	const scanLength = Math.min(archiveSize, EOCD_SCAN_BYTES);
	const scanStart = archiveSize - scanLength;
	const tail = await readExact(handle, scanStart, scanLength, "end of central directory");

	let eocdOffset = -1;
	for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i--) {
		if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
			eocdOffset = i;
			break;
		}
	}
	if (eocdOffset < 0)
		throw new ZipArchiveError("Not a ZIP archive (missing end of central directory)");

	let entryCount = tail.readUInt16LE(eocdOffset + 10);
	let size = tail.readUInt32LE(eocdOffset + 12);
	let offset = tail.readUInt32LE(eocdOffset + 16);

	const needsZip64 = entryCount === 0xffff || size === 0xffffffff || offset === 0xffffffff;
	if (needsZip64) {
		const locatorOffset = eocdOffset - 20;
		if (locatorOffset < 0 || tail.readUInt32LE(locatorOffset) !== ZIP64_LOCATOR_SIGNATURE) {
			throw new ZipArchiveError("Archive needs a ZIP64 locator but none is present");
		}
		const zip64EocdOffset = readUInt64LE(tail, locatorOffset + 8, "ZIP64 directory offset");
		const zip64 = await readExact(handle, zip64EocdOffset, 56, "ZIP64 end of central directory");
		if (zip64.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
			throw new ZipArchiveError("Archive has a malformed ZIP64 end of central directory");
		}
		entryCount = readUInt64LE(zip64, 32, "ZIP64 entry count");
		size = readUInt64LE(zip64, 40, "ZIP64 directory size");
		offset = readUInt64LE(zip64, 48, "ZIP64 directory offset");
	}

	if (offset + size > archiveSize) {
		throw new ZipArchiveError("Archive central directory extends past the end of the file");
	}
	return { offset, size, entryCount };
}

interface Zip64Extra {
	uncompressedSize?: number;
	compressedSize?: number;
	localHeaderOffset?: number;
}

function parseZip64Extra(
	extra: Buffer,
	needsUncompressed: boolean,
	needsCompressed: boolean,
	needsOffset: boolean,
): Zip64Extra {
	let cursor = 0;
	while (cursor + 4 <= extra.length) {
		const fieldId = extra.readUInt16LE(cursor);
		const fieldSize = extra.readUInt16LE(cursor + 2);
		const body = cursor + 4;
		if (body + fieldSize > extra.length) break;
		if (fieldId === 0x0001) {
			const result: Zip64Extra = {};
			let fieldCursor = body;
			if (needsUncompressed) {
				if (fieldCursor + 8 > body + fieldSize) {
					throw new ZipArchiveError("Archive has a truncated ZIP64 extra field");
				}
				result.uncompressedSize = readUInt64LE(extra, fieldCursor, "ZIP64 uncompressed size");
				fieldCursor += 8;
			}
			if (needsCompressed) {
				if (fieldCursor + 8 > body + fieldSize) {
					throw new ZipArchiveError("Archive has a truncated ZIP64 extra field");
				}
				result.compressedSize = readUInt64LE(extra, fieldCursor, "ZIP64 compressed size");
				fieldCursor += 8;
			}
			if (needsOffset) {
				if (fieldCursor + 8 > body + fieldSize) {
					throw new ZipArchiveError("Archive has a truncated ZIP64 extra field");
				}
				result.localHeaderOffset = readUInt64LE(extra, fieldCursor, "ZIP64 header offset");
			}
			return result;
		}
		cursor = body + fieldSize;
	}
	throw new ZipArchiveError("Archive is missing a required ZIP64 extra field");
}

function decodeEntryName(raw: Buffer, flags: number): string {
	// Non-UTF-8 names are legacy CP437; latin1 keeps them lossless enough for the
	// path checks below and never invents separators.
	const name = raw.toString(flags & FLAG_UTF8_NAME ? "utf8" : "latin1");
	if (name.includes("\0")) throw new ZipArchiveError("Archive entry name contains a NUL byte");
	return name;
}

/** Parse the central directory. No file data is read and nothing is written. */
export async function readZipArchive(
	archivePath: string,
	limitOverrides?: Partial<ZipReadLimits>,
): Promise<ZipArchiveInfo> {
	const limits = createLimits(limitOverrides);
	const handle = await open(archivePath, "r");
	try {
		const stats = await handle.stat();
		const location = await locateCentralDirectory(handle, stats.size);
		if (location.entryCount > limits.maxEntries) {
			throw new ZipArchiveError(`Archive contains more than ${limits.maxEntries} entries`);
		}
		if (location.size > limits.maxCentralDirectoryBytes) {
			throw new ZipArchiveError("Archive central directory is too large");
		}
		const central = await readExact(handle, location.offset, location.size, "central directory");

		const entries: ZipEntry[] = [];
		let totalUncompressedBytes = 0;
		let fileCount = 0;
		let cursor = 0;
		for (let index = 0; index < location.entryCount; index++) {
			if (cursor + CENTRAL_ENTRY_MIN_SIZE > central.length) {
				throw new ZipArchiveError("Archive central directory is truncated");
			}
			if (central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
				throw new ZipArchiveError("Archive central directory has a malformed entry header");
			}
			const versionMadeBy = central.readUInt16LE(cursor + 4);
			const flags = central.readUInt16LE(cursor + 8);
			const compressionMethod = central.readUInt16LE(cursor + 10);
			const crc = central.readUInt32LE(cursor + 16) >>> 0;
			let compressedSize = central.readUInt32LE(cursor + 20);
			let uncompressedSize = central.readUInt32LE(cursor + 24);
			const nameLength = central.readUInt16LE(cursor + 28);
			const extraLength = central.readUInt16LE(cursor + 30);
			const commentLength = central.readUInt16LE(cursor + 32);
			const externalAttributes = central.readUInt32LE(cursor + 38);
			let localHeaderOffset = central.readUInt32LE(cursor + 42);

			const nameStart = cursor + CENTRAL_ENTRY_MIN_SIZE;
			const extraStart = nameStart + nameLength;
			const commentStart = extraStart + extraLength;
			const nextCursor = commentStart + commentLength;
			if (nextCursor > central.length) {
				throw new ZipArchiveError("Archive central directory is truncated");
			}

			if (flags & FLAG_ENCRYPTED) {
				throw new ZipArchiveError("Archive contains an encrypted entry");
			}
			if (compressionMethod !== METHOD_STORE && compressionMethod !== METHOD_DEFLATE) {
				throw new ZipArchiveError(
					`Archive uses an unsupported compression method: ${compressionMethod}`,
				);
			}

			const needsUncompressed = uncompressedSize === 0xffffffff;
			const needsCompressed = compressedSize === 0xffffffff;
			const needsOffset = localHeaderOffset === 0xffffffff;
			if (needsUncompressed || needsCompressed || needsOffset) {
				const zip64 = parseZip64Extra(
					central.subarray(extraStart, commentStart),
					needsUncompressed,
					needsCompressed,
					needsOffset,
				);
				if (needsUncompressed) uncompressedSize = zip64.uncompressedSize ?? uncompressedSize;
				if (needsCompressed) compressedSize = zip64.compressedSize ?? compressedSize;
				if (needsOffset) localHeaderOffset = zip64.localHeaderOffset ?? localHeaderOffset;
			}
			if (localHeaderOffset + LOCAL_HEADER_MIN_SIZE > stats.size) {
				throw new ZipArchiveError("Archive entry points outside the file");
			}

			const name = decodeEntryName(central.subarray(nameStart, extraStart), flags);
			const unixMode = versionMadeBy >>> 8 === HOST_UNIX ? (externalAttributes >>> 16) & 0xffff : 0;
			const fileType = unixMode & S_IFMT;
			const isDirectory = name.endsWith("/") || (fileType !== 0 && fileType === S_IFDIR) || false;
			const isSymlink = fileType === S_IFLNK;
			const isSpecial =
				fileType !== 0 && fileType !== S_IFREG && fileType !== S_IFDIR && !isSymlink;

			if (!isDirectory) {
				fileCount += 1;
				if (uncompressedSize > limits.maxFileBytes) {
					throw new ZipArchiveError(
						`Archive entry exceeds the ${limits.maxFileBytes} byte file limit: ${name}`,
					);
				}
				totalUncompressedBytes += uncompressedSize;
				if (totalUncompressedBytes > limits.maxTotalBytes) {
					throw new ZipArchiveError(
						`Archive exceeds the ${limits.maxTotalBytes} byte unpacked limit`,
					);
				}
			}

			entries.push({
				name,
				isDirectory,
				isSymlink,
				isSpecial,
				compressionMethod,
				compressedSize,
				uncompressedSize,
				crc32: crc,
				localHeaderOffset,
				unixMode: unixMode & 0o7777,
			});
			cursor = nextCursor;
		}

		return { entries, totalUncompressedBytes, fileCount };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Normalize an entry name and reject the ones that could escape the destination.
 * Callers may apply stricter rules on top; this is the floor every extraction gets.
 *
 * `.` segments are DROPPED rather than rejected: `zipfile.writestr("./x")` and
 * several archiver libraries keep a `./` prefix, and those archives extract fine
 * with the `unzip` binary this module replaced. Only `..` and empty segments are
 * treated as escapes.
 */
export function normalizeZipEntryName(name: string): string {
	const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
	if (!trimmed) throw new ZipArchiveError("Archive contains an entry with an empty name");
	if (trimmed.includes("\\")) {
		throw new ZipArchiveError(`Archive entry name contains a backslash: ${trimmed}`);
	}
	if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
		throw new ZipArchiveError(`Archive entry name is absolute: ${trimmed}`);
	}
	const segments: string[] = [];
	for (const segment of trimmed.split("/")) {
		if (segment === ".") continue;
		if (!segment || segment === "..") {
			throw new ZipArchiveError(`Archive entry escapes its root: ${trimmed}`);
		}
		segments.push(segment);
	}
	// A name made only of `.` segments addresses the destination root itself.
	if (segments.length === 0) {
		throw new ZipArchiveError(`Archive entry has no usable path: ${trimmed}`);
	}
	return segments.join("/");
}

/** Counting/CRC transform that aborts as soon as a cap is exceeded. */
function createGuard(
	expectedSize: number,
	maxBytes: number,
	remainingTotal: () => number,
	onDone: (bytes: number, crc: number) => void,
): Transform {
	let bytes = 0;
	let crc = 0;
	return new Transform({
		transform(chunk, _encoding, callback) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			bytes += buffer.byteLength;
			if (bytes > expectedSize) {
				callback(new ZipArchiveError("Archive entry is larger than its declared size"));
				return;
			}
			if (bytes > maxBytes) {
				callback(new ZipArchiveError("Archive entry exceeds the file-size limit"));
				return;
			}
			if (bytes > remainingTotal()) {
				callback(new ZipArchiveError("Archive exceeds the unpacked-size limit"));
				return;
			}
			crc = updateCrc32(crc, buffer);
			callback(null, buffer);
		},
		flush(callback) {
			onDone(bytes, crc);
			callback();
		},
	});
}

async function extractEntry(
	handle: FileHandle,
	archivePath: string,
	entry: ZipEntry,
	destinationPath: string,
	limits: ZipReadLimits,
	remainingTotal: () => number,
): Promise<number> {
	const header = await readExact(
		handle,
		entry.localHeaderOffset,
		LOCAL_HEADER_MIN_SIZE,
		`local header for ${entry.name}`,
	);
	if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
		throw new ZipArchiveError(`Archive entry has a malformed local header: ${entry.name}`);
	}
	const nameLength = header.readUInt16LE(26);
	const extraLength = header.readUInt16LE(28);
	const dataStart = entry.localHeaderOffset + LOCAL_HEADER_MIN_SIZE + nameLength + extraLength;

	await mkdir(dirname(destinationPath), { recursive: true });

	if (entry.compressedSize === 0) {
		if (entry.uncompressedSize !== 0) {
			throw new ZipArchiveError(`Archive entry has inconsistent sizes: ${entry.name}`);
		}
		await Bun.write(destinationPath, "");
		return 0;
	}

	let writtenBytes = 0;
	let actualCrc = 0;
	const guard = createGuard(entry.uncompressedSize, limits.maxFileBytes, remainingTotal, (b, c) => {
		writtenBytes = b;
		actualCrc = c;
	});
	const source = createReadStream(archivePath, {
		start: dataStart,
		end: dataStart + entry.compressedSize - 1,
	});
	const sink = createWriteStream(destinationPath, { mode: 0o600, flags: "wx" });
	if (entry.compressionMethod === METHOD_DEFLATE) {
		await pipeline(source, createInflateRaw(), guard, sink);
	} else {
		await pipeline(source, guard, sink);
	}

	if (writtenBytes !== entry.uncompressedSize) {
		throw new ZipArchiveError(`Archive entry size mismatch: ${entry.name}`);
	}
	if (actualCrc !== entry.crc32) {
		throw new ZipArchiveError(`Archive entry failed its CRC check: ${entry.name}`);
	}
	// Preserve only the execute bit; never honour setuid/setgid from an archive.
	const mode = entry.unixMode & 0o111 ? 0o755 : 0o644;
	await chmod(destinationPath, mode).catch(() => undefined);
	return writtenBytes;
}

export interface ExtractZipResult {
	files: number;
	directories: number;
	totalBytes: number;
}

/**
 * Extract every entry into `destination`. Path safety, size caps and CRC checks
 * are enforced per entry; on failure the caller is expected to delete the
 * (partially written) destination directory.
 */
export async function extractZipArchive(
	archivePath: string,
	destination: string,
	options: ExtractZipOptions = {},
): Promise<ExtractZipResult> {
	const limits = createLimits(options.limits);
	const info = options.info ?? (await readZipArchive(archivePath, options.limits));
	const rejectSymlinks = options.rejectSymlinks ?? true;
	const destinationRoot = resolve(destination);

	for (const entry of info.entries) {
		if ((entry.isSymlink || entry.isSpecial) && rejectSymlinks) {
			throw new ZipArchiveError(
				`Archive contains a symlink or special filesystem entry: ${entry.name}`,
			);
		}
	}

	await mkdir(destinationRoot, { recursive: true });
	const handle = await open(archivePath, "r");
	let totalBytes = 0;
	let files = 0;
	let directories = 0;
	const remainingTotal = () => limits.maxTotalBytes - totalBytes;
	try {
		for (const entry of info.entries) {
			if (entry.isSymlink || entry.isSpecial) continue;
			const safeName = normalizeZipEntryName(entry.name);
			const target = resolve(destinationRoot, ...safeName.split("/"));
			if (!isInsidePath(destinationRoot, target)) {
				throw new ZipArchiveError(`Archive entry escapes the extraction directory: ${safeName}`);
			}
			if (entry.isDirectory) {
				await mkdir(target, { recursive: true });
				directories += 1;
				continue;
			}
			totalBytes += await extractEntry(handle, archivePath, entry, target, limits, remainingTotal);
			files += 1;
		}
	} finally {
		await handle.close().catch(() => undefined);
	}
	return { files, directories, totalBytes };
}

/** Join helper used by tests to build expected extraction paths. */
export function zipEntryPath(destination: string, name: string): string {
	return join(destination, ...name.split("/"))
		.split("/")
		.join(sep);
}
