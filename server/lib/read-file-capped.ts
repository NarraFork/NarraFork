import { open, stat } from "node:fs/promises";

/**
 * Maximum bytes to read for project instructions (AGENTS.md & friends).
 *
 * Same order of magnitude as global instructions — 200 KB of UTF-8 covers even
 * very large project context files while keeping the system prompt allocation
 * bounded and avoiding multi-MB string copies on the main thread.
 */
export const MAX_PROJECT_INSTRUCTIONS_BYTES = 200_000;

/**
 * Decode a byte prefix as UTF-8 without producing U+FFFD at the boundary.
 *
 * When a read is capped at an arbitrary byte offset the final multi-byte
 * sequence may be incomplete. A naïve `TextDecoder` emits a replacement
 * character for it — visible garbage at the tail of every truncated CJK
 * document. This routine walks back over trailing continuation bytes
 * (`10xxxxxx`, at most 3) to find the lead byte, and drops the incomplete
 * sequence entirely.
 */
export function decodeUtf8Prefix(bytes: Uint8Array): string {
	let end = bytes.length;
	// Find the last lead byte, i.e. skip trailing continuation bytes.
	let lead = end - 1;
	while (lead >= 0 && (bytes[lead] & 0b1100_0000) === 0b1000_0000) lead--;
	if (lead >= 0) {
		const first = bytes[lead];
		const needed = first < 0x80 ? 1 : first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
		// An incomplete final sequence is dropped rather than decoded to U+FFFD.
		if (lead + needed > end) end = lead;
	}
	return new TextDecoder("utf-8").decode(bytes.subarray(0, end));
}

/**
 * Read at most `maxBytes` from a file without allocating beyond the cap.
 *
 * Uses a file handle with an explicit read length so the cap bounds the
 * ALLOCATION, not just what is returned. The file size is stat'd first to
 * decide whether truncation occurred, but a stat-read race (file grows
 * between the two) is resolved conservatively: `truncated` is true whenever
 * the bytes actually read fill the buffer completely, regardless of what stat
 * said.
 *
 * Returns `null` when the file does not exist (ENOENT/ENOTDIR).
 */
export async function readFileCapped(
	path: string,
	maxBytes: number,
): Promise<{ content: string; truncated: boolean } | null> {
	let fileSize: number;
	try {
		const info = await stat(path);
		if (!info.isFile()) return null;
		fileSize = info.size;
	} catch {
		return null;
	}

	const want = Math.min(Math.max(fileSize, 0), maxBytes);
	const handle = await open(path, "r");
	try {
		const buffer = new Uint8Array(want);
		const { bytesRead } = want > 0 ? await handle.read(buffer, 0, want, 0) : { bytesRead: 0 };
		return {
			content: decodeUtf8Prefix(buffer.subarray(0, bytesRead)),
			// Truncated if the file is larger than our cap. We compare against
			// fileSize rather than bytesRead because the read itself is capped.
			truncated: fileSize > maxBytes,
		};
	} finally {
		await handle.close();
	}
}
