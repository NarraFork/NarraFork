import { LIMITS, VERSION } from "./protocol";

export const SOCKET_HEADER_BYTES = 32;
export const SOCKET_MESSAGE_BYTES = 2 * 1024 * 1024;
export const SOCKET_FRAGMENT_BYTES = LIMITS.frameBytes - SOCKET_HEADER_BYTES;
export interface SocketFrame {
	streamId: number;
	messageId: number;
	sequence: number;
	opcode: 1 | 2;
	total: number;
	end: boolean;
	payload: Uint8Array;
}
export function encodeSocketFrame(frame: SocketFrame): Uint8Array<ArrayBuffer> {
	if (
		![frame.streamId, frame.messageId].every(
			(n) => Number.isInteger(n) && n > 0 && n <= 0xffffffff,
		) ||
		!Number.isInteger(frame.sequence) ||
		frame.sequence < 0 ||
		frame.sequence > 0xffffffff ||
		(frame.opcode !== 1 && frame.opcode !== 2) ||
		!Number.isInteger(frame.total) ||
		frame.total < 0 ||
		frame.total > SOCKET_MESSAGE_BYTES ||
		frame.payload.byteLength > SOCKET_FRAGMENT_BYTES ||
		frame.payload.byteLength > frame.total ||
		(!frame.end && !frame.payload.byteLength)
	)
		throw new Error("invalid_socket_frame");
	const bytes = new Uint8Array(SOCKET_HEADER_BYTES + frame.payload.byteLength);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 0x4e465753);
	view.setUint8(4, VERSION);
	view.setUint8(5, frame.opcode);
	view.setUint16(6, frame.end ? 1 : 0);
	view.setUint32(8, frame.streamId);
	view.setUint32(12, frame.messageId);
	view.setUint32(16, frame.sequence);
	view.setUint32(20, frame.total);
	view.setUint32(24, frame.payload.byteLength);
	bytes.set(frame.payload, SOCKET_HEADER_BYTES);
	return bytes;
}
export function decodeSocketFrame(input: ArrayBuffer | Uint8Array): SocketFrame {
	const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
	if (bytes.byteLength < SOCKET_HEADER_BYTES || bytes.byteLength > LIMITS.frameBytes)
		throw new Error("invalid_socket_frame");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (
		view.getUint32(0) !== 0x4e465753 ||
		view.getUint8(4) !== VERSION ||
		view.getUint16(6) > 1 ||
		view.getUint32(28) !== 0 ||
		view.getUint32(24) !== bytes.byteLength - SOCKET_HEADER_BYTES
	)
		throw new Error("invalid_socket_frame");
	const frame: SocketFrame = {
		streamId: view.getUint32(8),
		messageId: view.getUint32(12),
		sequence: view.getUint32(16),
		total: view.getUint32(20),
		opcode: view.getUint8(5) as 1 | 2,
		end: view.getUint16(6) === 1,
		payload: bytes.subarray(SOCKET_HEADER_BYTES),
	};
	if (
		!frame.streamId ||
		!frame.messageId ||
		![1, 2].includes(frame.opcode) ||
		frame.total > SOCKET_MESSAGE_BYTES ||
		frame.payload.byteLength > frame.total ||
		(!frame.end && !frame.payload.byteLength)
	)
		throw new Error("invalid_socket_frame");
	return frame;
}

/** One active message per socket; its entire bounded storage is reserved before accepting credit. */
export class SocketAssembly {
	private nextMessage = 1;
	private active?: {
		id: number;
		opcode: 1 | 2;
		sequence: number;
		offset: number;
		bytes: Uint8Array<ArrayBuffer>;
		deadline: number;
	};
	constructor(
		private readonly reserve: (n: number) => void,
		private readonly release: (n: number) => void,
		private readonly timeout = 30_000,
	) {}
	get pending(): boolean {
		return !!this.active;
	}
	accept(
		frame: SocketFrame,
		now = Date.now(),
	): { opcode: 1 | 2; data: Uint8Array<ArrayBuffer> } | undefined {
		if (!this.active) {
			if (frame.messageId !== this.nextMessage || frame.sequence !== 0)
				throw new Error("socket_sequence");
			this.reserve(frame.total);
			this.active = {
				id: frame.messageId,
				opcode: frame.opcode,
				sequence: 0,
				offset: 0,
				bytes: new Uint8Array(frame.total),
				deadline: now + this.timeout,
			};
		}
		const a = this.active;
		if (
			now >= a.deadline ||
			a.id !== frame.messageId ||
			a.opcode !== frame.opcode ||
			a.sequence !== frame.sequence ||
			frame.total !== a.bytes.byteLength ||
			a.offset + frame.payload.byteLength > a.bytes.byteLength
		)
			throw new Error("socket_sequence");
		a.bytes.set(frame.payload, a.offset);
		a.offset += frame.payload.byteLength;
		a.sequence++;
		if (frame.end !== (a.offset === a.bytes.byteLength)) throw new Error("socket_end");
		if (!frame.end) return;
		this.active = undefined;
		this.nextMessage++;
		// Caller owns the reservation until dispatch/write completes.
		return { opcode: a.opcode, data: a.bytes };
	}
	cancel(): void {
		if (this.active) this.release(this.active.bytes.byteLength);
		this.active = undefined;
	}
}
