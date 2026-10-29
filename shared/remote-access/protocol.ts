import contract from "./contract.json";

export const VERSION = 1;
export const APP_VERSION = "prototype-1";
export const LIMITS = Object.freeze(contract.limits);
export const FRAME_DATA = 1;
export const FRAME_END = 2;
const MAGIC = 0x4e464443;

export interface Frame {
	kind: number;
	streamId: number;
	sequence: number;
	payload?: Uint8Array;
}

function uint32(value: number, nonzero = false): void {
	if (!Number.isInteger(value) || value < (nonzero ? 1 : 0) || value > 0xffff_ffff) {
		throw new Error("INVALID_FRAME_INTEGER");
	}
}

export function encodeFrame(frame: Frame): Uint8Array<ArrayBuffer> {
	uint32(frame.streamId, true);
	uint32(frame.sequence);
	if (frame.kind !== FRAME_DATA && frame.kind !== FRAME_END) throw new Error("INVALID_FRAME_KIND");
	const payload = frame.payload ?? new Uint8Array();
	if (payload.byteLength > LIMITS.frameBytes - LIMITS.headerBytes)
		throw new Error("FRAME_TOO_LARGE");
	if (frame.kind === FRAME_END && payload.byteLength !== 0) throw new Error("INVALID_END_FRAME");
	const bytes = new Uint8Array(LIMITS.headerBytes + payload.byteLength);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, MAGIC, false);
	view.setUint8(4, VERSION);
	view.setUint8(5, frame.kind);
	view.setUint32(8, frame.streamId, false);
	view.setUint32(12, frame.sequence, false);
	view.setUint32(16, payload.byteLength, false);
	bytes.set(payload, LIMITS.headerBytes);
	return bytes;
}

export function decodeFrame(input: Uint8Array | ArrayBuffer): Frame & { payload: Uint8Array } {
	const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
	if (bytes.byteLength < LIMITS.headerBytes || bytes.byteLength > LIMITS.frameBytes) {
		throw new Error("INVALID_FRAME_SIZE");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(0, false) !== MAGIC || view.getUint8(4) !== VERSION) {
		throw new Error("INVALID_FRAME_VERSION");
	}
	if (view.getUint16(6, false) !== 0 || view.getUint32(20, false) !== 0) {
		throw new Error("INVALID_FRAME_RESERVED");
	}
	const kind = view.getUint8(5);
	const streamId = view.getUint32(8, false);
	const sequence = view.getUint32(12, false);
	const length = view.getUint32(16, false);
	if (length !== bytes.byteLength - LIMITS.headerBytes || streamId === 0) {
		throw new Error("INVALID_FRAME_LENGTH");
	}
	if (kind !== FRAME_DATA && kind !== FRAME_END) throw new Error("INVALID_FRAME_KIND");
	if (kind === FRAME_END && length !== 0) throw new Error("INVALID_END_FRAME");
	return { kind, streamId, sequence, payload: bytes.subarray(LIMITS.headerBytes) };
}

/** Independent directional credit, so duplicates cannot increase the receive window. */
export class SendCredit {
	private available = LIMITS.windowBytes;
	get bytes(): number {
		return this.available;
	}
	consume(bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.available) {
			throw new Error("CREDIT_EXCEEDED");
		}
		this.available -= bytes;
	}
	update(bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes <= 0 || this.available + bytes > LIMITS.windowBytes) {
			throw new Error("INVALID_CREDIT");
		}
		this.available += bytes;
	}
}

export class ReceiveWindow {
	private sequence = 0;
	private available = LIMITS.windowBytes;
	private ended = false;
	accept(frame: Frame): void {
		if (this.ended || frame.sequence !== this.sequence) throw new Error("INVALID_SEQUENCE");
		const length = frame.payload?.byteLength ?? 0;
		if (length > this.available) throw new Error("CREDIT_EXCEEDED");
		if (frame.kind !== FRAME_DATA && frame.kind !== FRAME_END)
			throw new Error("INVALID_FRAME_KIND");
		if (frame.kind === FRAME_END && length !== 0) throw new Error("INVALID_END_FRAME");
		this.sequence += 1;
		this.available -= length;
		this.ended = frame.kind === FRAME_END;
	}
	consumed(bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes <= 0 || this.available + bytes > LIMITS.windowBytes) {
			throw new Error("INVALID_CREDIT");
		}
		this.available += bytes;
	}
}

export function assertDirectSdp(sdp: string): void {
	if (new TextEncoder().encode(sdp).byteLength > LIMITS.sdpBytes || sdp.includes("\0")) {
		throw new Error("INVALID_SDP_SIZE");
	}
	const candidates = sdp.split(/\r?\n/).filter((line) => line.startsWith("a=candidate:"));
	if (candidates.length > LIMITS.candidates) throw new Error("TOO_MANY_CANDIDATES");
	for (const line of candidates) {
		if (new TextEncoder().encode(line).byteLength > LIMITS.candidateBytes) {
			throw new Error("CANDIDATE_TOO_LARGE");
		}
		if (/\btyp\s+relay\b/i.test(line)) throw new Error("RELAY_FORBIDDEN");
	}
}

export function assertStunUrls(urls: readonly string[]): void {
	if (urls.length > 4) throw new Error("TOO_MANY_STUN_SERVERS");
	for (const url of urls) {
		if (!/^stuns?:[a-zA-Z0-9.\-[\]:]+(?:\?transport=(?:udp|tcp))?$/.test(url)) {
			throw new Error("TURN_FORBIDDEN");
		}
	}
}

export interface SessionTicket {
	instanceId: string;
	leaseEpoch: string;
	sessionId: string;
	clientPublicKey: string;
	offerHash: string;
	expiresAt: number;
	targetKind: "invite" | "grant";
	targetId: string;
	signature: string;
}

export function ticketFields(ticket: Omit<SessionTicket, "signature">): string[] {
	return [
		ticket.instanceId,
		ticket.leaseEpoch,
		ticket.sessionId,
		ticket.clientPublicKey,
		ticket.offerHash,
		String(ticket.expiresAt),
		ticket.targetKind,
		ticket.targetId,
	];
}
