import { closeSync, openSync, readSync } from "node:fs";

export type WindowsPeArch = "x64" | "arm64";
const MACHINES = { x64: 0x8664, arm64: 0xaa64 } as const;
const MAX_PE_HEADER_OFFSET = 1024 * 1024;

/** Validate the PE signature and COFF machine without executing the binary. */
export function matchesWindowsPeArch(bytes: Uint8Array, arch: WindowsPeArch): boolean {
	if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const offset = view.getUint32(0x3c, true);
	return (
		offset >= 64 &&
		offset <= MAX_PE_HEADER_OFFSET &&
		offset + 6 <= bytes.length &&
		view.getUint32(offset, true) === 0x00004550 &&
		view.getUint16(offset + 4, true) === MACHINES[arch]
	);
}

/** Read only the DOS header and six PE bytes, even for a large executable. */
export function isWindowsPeFile(path: string, arch: WindowsPeArch): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const dos = Buffer.alloc(64);
		if (readSync(fd, dos, 0, dos.length, 0) !== dos.length) return false;
		if (dos[0] !== 0x4d || dos[1] !== 0x5a) return false;
		const offset = dos.readUInt32LE(0x3c);
		if (offset < 64 || offset > MAX_PE_HEADER_OFFSET) return false;
		const pe = Buffer.alloc(6);
		return (
			readSync(fd, pe, 0, pe.length, offset) === pe.length &&
			pe.readUInt32LE(0) === 0x00004550 &&
			pe.readUInt16LE(4) === MACHINES[arch]
		);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
