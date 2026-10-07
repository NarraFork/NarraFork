import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { localObjectIdentity } from "./file-change-local-io";

const MAX_METADATA_BYTES = 512 * 1024;
const MAX_XATTR_NAMES = 256;
const MAX_NAME_BYTES = 64 * 1024;

/** Linux descriptor metadata, including complete POSIX ACL/xattr values. Only called in a worker. */
const native =
	process.platform === "linux"
		? dlopen("libc.so.6", {
				flistxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
				fgetxattr: {
					args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64],
					returns: FFIType.i64,
				},
				flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
				renameat2: {
					args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
					returns: FFIType.i32,
				},
				__errno_location: { args: [], returns: FFIType.ptr },
			})
		: null;

export function localAttachmentNativeSupported(): boolean {
	return native !== null;
}
function errno(): number {
	if (!native)
		throw new Error("Complete native attachment metadata is unsupported on this platform");
	const address = native.symbols.__errno_location();
	if (!address) throw new Error("Native attachment errno is unavailable");
	return new DataView(toArrayBuffer(address, 0, 4)).getInt32(0, true);
}
function checkedLength(value: number | bigint, cap: number): number {
	const size = Number(value);
	if (!Number.isSafeInteger(size) || size < 0 || size > cap)
		throw new Error(
			`Complete native attachment metadata is unavailable or exceeds its bound (errno=${errno()})`,
		);
	return size;
}
export function nativeAttachmentMetadata(file: FileHandle, stat: BigIntStats): string {
	if (!native)
		throw new Error(
			`Complete native attachment metadata is unsupported on ${process.platform}; file retained`,
		);
	if (!stat.isFile() || stat.nlink !== 1n)
		throw new Error("Native attachment requires a single-link regular file");
	const namesSize = checkedLength(native.symbols.flistxattr(file.fd, null, 0), MAX_NAME_BYTES);
	const names = Buffer.alloc(Math.max(1, namesSize));
	const actual = checkedLength(
		native.symbols.flistxattr(file.fd, ptr(names), namesSize),
		namesSize,
	);
	const encodedNames = names.subarray(0, actual);
	const decodedNames = encodedNames.toString("utf8");
	if (actual !== namesSize || !Buffer.from(decodedNames, "utf8").equals(encodedNames))
		throw new Error(
			"Native attachment attribute names are changing or cannot be represented exactly",
		);
	const rawNames = decodedNames.split("\0").filter(Boolean).sort();
	if (new Set(rawNames).size !== rawNames.length)
		throw new Error("Native attachment attribute names are ambiguous");
	if (rawNames.length > MAX_XATTR_NAMES)
		throw new Error("Native attachment xattr count budget exceeded");
	const attrs: Record<string, string> = {};
	let bytes = actual;
	for (const name of rawNames) {
		const encoded = Buffer.from(`${name}\0`);
		const size = checkedLength(
			native.symbols.fgetxattr(file.fd, ptr(encoded), null, 0),
			MAX_METADATA_BYTES - bytes,
		);
		const data = Buffer.alloc(Math.max(1, size));
		const read = checkedLength(
			native.symbols.fgetxattr(file.fd, ptr(encoded), ptr(data), size),
			size,
		);
		if (read !== size) throw new Error("Native attachment metadata changed during capture");
		bytes += read;
		attrs[name] = data.subarray(0, read).toString("base64");
	}
	return JSON.stringify({
		version: 1,
		platform: "linux",
		uid: stat.uid.toString(),
		gid: stat.gid.toString(),
		mode: Number(stat.mode & 0o7777n),
		attrs,
	});
}
export function attachmentMetadataDigest(metadata: string): string {
	return createHash("sha256").update(metadata).digest("hex");
}
export function quarantineLocalAttachmentNoReplace(source: string, destination: string): void {
	if (!native) throw new Error("Native conditional attachment detach is unsupported");
	const from = Buffer.from(`${source}\0`);
	const to = Buffer.from(`${destination}\0`);
	if (native.symbols.renameat2(-100, ptr(from), -100, ptr(to), 1) !== 0)
		throw new Error(
			`Native no-overwrite attachment quarantine failed (errno=${errno()}); target retained`,
		);
}
export function attachmentObjectIdentity(stat: BigIntStats): string {
	return localObjectIdentity(stat);
}
export function attachmentSameStamp(a: BigIntStats, b: BigIntStats): boolean {
	return (
		attachmentObjectIdentity(a) === attachmentObjectIdentity(b) &&
		a.nlink === b.nlink &&
		a.size === b.size &&
		a.mode === b.mode &&
		a.uid === b.uid &&
		a.gid === b.gid &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs
	);
}

/** Cross-provider private publisher lock. Nonblocking retries preserve the worker event loop. */
export async function acquireLocalAttachmentMutation(
	file: FileHandle,
	check: () => void,
): Promise<() => void> {
	if (!native) throw new Error("Native local attachment mutation lock is unsupported");
	while (true) {
		check();
		if (native.symbols.flock(file.fd, 2 | 4) === 0) break;
		const code = errno();
		if (code !== 11 && code !== 4) throw new Error(`Native attachment lock failed (errno=${code})`);
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (native.symbols.flock(file.fd, 8) !== 0) throw new Error("Native attachment unlock failed");
	};
}
