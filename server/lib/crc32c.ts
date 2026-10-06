/**
 * CRC-32C (Castagnoli) — matches Go's `crc32.MakeTable(crc32.Castagnoli)`.
 *
 * Used for per-chunk integrity verification in device file transfers. Both the
 * server and the Go executor compute CRC-32C over identical chunk bytes so the
 * sender can detect corruption from the receiver's ack.
 */

const POLY = 0x82f63b78; // reversed Castagnoli polynomial

let TABLE: Uint32Array | null = null;

function buildTable(): Uint32Array {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? POLY ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
}

/** Compute the CRC-32C of a byte buffer. Returns an unsigned 32-bit integer. */
export function crc32c(data: Uint8Array): number {
	if (!TABLE) TABLE = buildTable();
	const table = TABLE;
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
