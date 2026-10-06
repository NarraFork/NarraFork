/**
 * Client-egress relay protocol constants and frame codec (nf side).
 * Mirrors internal/relay in narrafork-unified-gateway — the two sides are the
 * wire contract for each other, so the layouts must stay byte-identical.
 *
 * Frame layout (binary WebSocket messages):
 *   [1B opcode][8B stream id (BE)][4B payload length (BE)][payload]
 *
 * Text frames carry JSON control messages (hello_ack from the server).
 * Streams are always opened by the server (DIAL); this client never initiates
 * stream creation — the only thing the server can ask for is "dial host:port
 * and pump bytes", and the dial goes through the local allowlist first.
 */

export const OP_DIAL = 0x01;
export const OP_DIAL_OK = 0x02;
export const OP_DIAL_ERR = 0x03;
export const OP_DATA = 0x04;
export const OP_FIN = 0x05;
export const OP_RST = 0x06;
export const OP_WINDOW_UPDATE = 0x07;

export const FRAME_HEADER_SIZE = 13;
/** Maximum payload of a single DATA frame. */
export const MAX_DATA_PAYLOAD = 64 << 10;
/** Per-stream send window both sides start with (protocol constant). */
export const INITIAL_STREAM_WINDOW = 256 << 10;

export interface RelayFrame {
	op: number;
	streamId: bigint;
	payload: Uint8Array;
}

export function encodeFrame(
	op: number,
	streamId: bigint,
	payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
	if (payload.byteLength > MAX_DATA_PAYLOAD && op === OP_DATA) {
		throw new Error(`relay DATA frame payload too large: ${payload.byteLength}`);
	}
	const frame = new Uint8Array(FRAME_HEADER_SIZE + payload.byteLength);
	const view = new DataView(frame.buffer);
	view.setUint8(0, op);
	view.setBigUint64(1, streamId);
	view.setUint32(9, payload.byteLength);
	frame.set(payload, FRAME_HEADER_SIZE);
	return frame;
}

export function decodeFrame(raw: Uint8Array): RelayFrame {
	if (raw.byteLength < FRAME_HEADER_SIZE) {
		throw new Error(`relay frame too short: ${raw.byteLength}`);
	}
	const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	const op = view.getUint8(0);
	const streamId = view.getBigUint64(1);
	const payloadLength = view.getUint32(9);
	if (raw.byteLength - FRAME_HEADER_SIZE !== payloadLength) {
		throw new Error(
			`relay frame length mismatch: header=${payloadLength} actual=${raw.byteLength - FRAME_HEADER_SIZE}`,
		);
	}
	if (payloadLength > MAX_DATA_PAYLOAD) {
		throw new Error(`relay frame payload too large: ${payloadLength}`);
	}
	return { op, streamId, payload: raw.subarray(FRAME_HEADER_SIZE) };
}

export function encodeWindowUpdate(streamId: bigint, increment: number): Uint8Array<ArrayBuffer> {
	const payload = new Uint8Array(4);
	new DataView(payload.buffer).setUint32(0, increment);
	return encodeFrame(OP_WINDOW_UPDATE, streamId, payload);
}

export function decodeWindowUpdate(payload: Uint8Array): number {
	if (payload.byteLength !== 4) {
		throw new Error(`relay WINDOW_UPDATE payload must be 4 bytes, got ${payload.byteLength}`);
	}
	return new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);
}
