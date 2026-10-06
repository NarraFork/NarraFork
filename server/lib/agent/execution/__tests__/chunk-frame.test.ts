import { describe, expect, test } from "bun:test";
import {
	decodeChunkFrame,
	encodeChunkFrame,
	isChunkFrame,
	TRANSFER_FRAME_MAGIC,
	TRANSFER_FRAME_TYPE_CHUNK,
} from "../rpc-types";

describe("chunk frame codec", () => {
	test("round-trips header + payload", () => {
		const payload = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
		const frame = encodeChunkFrame({ transferId: "tx_abc", chunkIndex: 42 }, payload);
		expect(frame[0]).toBe(TRANSFER_FRAME_MAGIC);
		expect(frame[1]).toBe(TRANSFER_FRAME_TYPE_CHUNK);

		const decoded = decodeChunkFrame(frame);
		expect(decoded).not.toBeNull();
		expect(decoded?.header.transferId).toBe("tx_abc");
		expect(decoded?.header.chunkIndex).toBe(42);
		expect(Array.from(decoded?.payload ?? [])).toEqual(Array.from(payload));
	});

	test("handles empty payload", () => {
		const frame = encodeChunkFrame({ transferId: "t", chunkIndex: 0 }, new Uint8Array(0));
		const decoded = decodeChunkFrame(frame);
		expect(decoded?.payload.length).toBe(0);
		expect(decoded?.header.chunkIndex).toBe(0);
	});

	test("handles large payload (1 MiB)", () => {
		const payload = new Uint8Array(1024 * 1024);
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
		const frame = encodeChunkFrame({ transferId: "big", chunkIndex: 7 }, payload);
		const decoded = decodeChunkFrame(frame);
		expect(decoded?.payload.length).toBe(payload.length);
		// Spot-check a few bytes.
		expect(decoded?.payload[0]).toBe(0);
		expect(decoded?.payload[255]).toBe(255);
		expect(decoded?.payload[1000]).toBe(1000 & 0xff);
	});

	test("isChunkFrame rejects non-frames", () => {
		expect(isChunkFrame(new Uint8Array([]))).toBe(false);
		expect(isChunkFrame(new Uint8Array([0x00, 0x01, 0, 0]))).toBe(false);
		// A JSON text frame decoded to bytes must not be mistaken for a chunk.
		const jsonBytes = new TextEncoder().encode('{"type":"rpc"}');
		expect(isChunkFrame(jsonBytes)).toBe(false);
	});

	test("decodeChunkFrame returns null on truncated header", () => {
		// magic + type + headerLen claiming 100 bytes but no header present
		const bad = new Uint8Array([TRANSFER_FRAME_MAGIC, TRANSFER_FRAME_TYPE_CHUNK, 100, 0]);
		expect(decodeChunkFrame(bad)).toBeNull();
	});

	test("payload offset survives a non-zero byteOffset backing buffer", () => {
		const payload = new Uint8Array([9, 8, 7]);
		const frame = encodeChunkFrame({ transferId: "off", chunkIndex: 1 }, payload);
		// Simulate a frame that lives inside a larger ArrayBuffer with an offset.
		const backing = new Uint8Array(frame.length + 16);
		backing.set(frame, 8);
		const view = backing.subarray(8, 8 + frame.length);
		const decoded = decodeChunkFrame(view);
		expect(decoded?.header.transferId).toBe("off");
		expect(Array.from(decoded?.payload ?? [])).toEqual([9, 8, 7]);
	});
});
