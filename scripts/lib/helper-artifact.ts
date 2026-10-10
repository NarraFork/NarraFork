import { lstat, open } from "node:fs/promises";
import {
	HELPER_BINARY_MAX_BYTES,
	HELPER_MANIFEST_MAX_BYTES,
} from "../../shared/helper-distribution";

/** Inspect the bounded ZIP central directory before invoking an extractor. No ZIP64, links or paths. */
export function parseHelperArtifactZipDirectory(central: Buffer, entries: number): string[] {
	if (!Number.isInteger(entries) || entries < 1 || entries > 45 || central.length > 32 * 1024)
		throw new Error("Helper ZIP directory exceeds limit");
	let offset = 0;
	let expanded = 0;
	const names: string[] = [];
	for (let i = 0; i < entries; i++) {
		if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50)
			throw new Error("Invalid helper ZIP directory");
		const flags = central.readUInt16LE(offset + 8);
		const method = central.readUInt16LE(offset + 10);
		const compressed = central.readUInt32LE(offset + 20);
		const size = central.readUInt32LE(offset + 24);
		const nameLength = central.readUInt16LE(offset + 28);
		const extraLength = central.readUInt16LE(offset + 30);
		const commentLength = central.readUInt16LE(offset + 32);
		const attributes = central.readUInt32LE(offset + 38);
		const mode = attributes >>> 16;
		const end = offset + 46 + nameLength + extraLength + commentLength;
		if (
			end > central.length ||
			nameLength < 1 ||
			nameLength > 160 ||
			flags & 1 ||
			![0, 8].includes(method) ||
			central.readUInt16LE(offset + 34) !== 0 ||
			compressed < 1 ||
			compressed === 0xffffffff ||
			central.readUInt32LE(offset + 42) === 0xffffffff ||
			((mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000) ||
			attributes & 0x10
		)
			throw new Error("Unsafe helper ZIP member type");
		const name = central.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		if (
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(name) ||
			name.includes("..") ||
			names.includes(name)
		)
			throw new Error("Unsafe helper ZIP member name");
		const maximum =
			name.endsWith(".json") || name.endsWith(".txt")
				? HELPER_MANIFEST_MAX_BYTES
				: HELPER_BINARY_MAX_BYTES;
		if (size < 1 || size > maximum) throw new Error("Helper ZIP expanded member exceeds limit");
		expanded += size;
		if (expanded > 512 * 1024 * 1024) throw new Error("Helper ZIP expansion exceeds limit");
		names.push(name);
		offset = end;
	}
	if (offset !== central.length) throw new Error("Unexpected helper ZIP directory bytes");
	return names;
}
export async function validateHelperArtifactZip(path: string): Promise<string[]> {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.size < 22 || stat.size > 512 * 1024 * 1024)
		throw new Error("Invalid helper ZIP size/type");
	const file = await open(path, "r");
	try {
		const tail = Buffer.alloc(Math.min(stat.size, 65557));
		if ((await file.read(tail, 0, tail.length, stat.size - tail.length)).bytesRead !== tail.length)
			throw new Error("Helper ZIP changed while reading");
		let end = tail.length - 22;
		while (
			end >= 0 &&
			(tail.readUInt32LE(end) !== 0x06054b50 ||
				end + 22 + tail.readUInt16LE(end + 20) !== tail.length)
		)
			end--;
		if (end < 0) throw new Error("Missing helper ZIP end record");
		const entries = tail.readUInt16LE(end + 10);
		const bytes = tail.readUInt32LE(end + 12);
		const offset = tail.readUInt32LE(end + 16);
		if (
			tail.readUInt16LE(end + 4) !== 0 ||
			tail.readUInt16LE(end + 6) !== 0 ||
			tail.readUInt16LE(end + 8) !== entries ||
			entries > 45 ||
			bytes > 32 * 1024 ||
			offset + bytes > stat.size - tail.length + end
		)
			throw new Error("Unsupported helper ZIP layout");
		const central = Buffer.alloc(bytes);
		if ((await file.read(central, 0, bytes, offset)).bytesRead !== bytes)
			throw new Error("Helper ZIP directory truncated");
		return parseHelperArtifactZipDirectory(central, entries);
	} finally {
		await file.close();
	}
}
