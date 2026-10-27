/**
 * Outline live session frames on `/ws/narrator` (`shared/outline-live-protocol.ts`).
 *
 * Binary frames whose first byte is the outline magic come here straight from the socket,
 * without the JSON parse every text frame of the socket goes through; everything about the
 * session itself lives in `services/outline/live/`. This module adapts a narrator socket to
 * what a session needs (identity, binary send, buffered amount) and routes frames, drains and
 * closes.
 *
 * Anonymous public-share sockets have no person behind them and never reach a session.
 */
import { decodeLiveFrame, LIVE_FRAME, OUTLINE_LIVE_LIMITS } from "@shared/outline-live-protocol";
import { logger } from "../lib/logger";
import {
	drainLiveSocket,
	handleLiveFrame,
	releaseLiveSocket,
} from "../services/outline/live/registry";
import type { LiveSocket } from "../services/outline/live/session";

export interface OutlineLiveWS {
	data: {
		userId?: string;
		userRole?: string;
		username?: string;
		avatarColor?: string | null;
		publicShare?: unknown;
	};
	sendBinary(data: Uint8Array): number;
	getBufferedAmount(): number;
}

const PALETTE = [
	"#d6336c",
	"#1c7ed6",
	"#2f9e44",
	"#e8590c",
	"#7048e8",
	"#0c8599",
	"#c2255c",
	"#5f3dc4",
];

function colorOf(userId: string): string {
	let h = 0;
	for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
	return PALETTE[h % PALETTE.length] as string;
}

class NarratorLiveSocket implements LiveSocket {
	closed = false;

	constructor(private readonly ws: OutlineLiveWS) {}

	get userId(): string {
		return this.ws.data.userId ?? "";
	}

	/** Read live: a role change re-checked by the socket layer applies at once. */
	get isAdmin(): boolean {
		return this.ws.data.userRole === "admin";
	}

	get name(): string {
		return this.ws.data.username ?? "";
	}

	get color(): string {
		return this.ws.data.avatarColor || colorOf(this.userId);
	}

	send(frame: Uint8Array): boolean {
		if (this.closed) return false;
		try {
			// -1: queued behind backpressure (fine, the session watches the buffer); 0: dropped.
			return this.ws.sendBinary(frame) !== 0;
		} catch {
			return false;
		}
	}

	bufferedAmount(): number {
		try {
			return this.ws.getBufferedAmount();
		} catch {
			return 0;
		}
	}
}

const sockets = new WeakMap<OutlineLiveWS, NarratorLiveSocket>();

function socketOf(ws: OutlineLiveWS): NarratorLiveSocket {
	let socket = sockets.get(ws);
	if (!socket) {
		socket = new NarratorLiveSocket(ws);
		sockets.set(ws, socket);
	}
	return socket;
}

let oversizeLoggedAt = 0;

/** Selection frames: small, and at most this many a second per socket (the rest dropped). */
const SELECTION_MAX_BYTES = 16 * 1024;
const SELECTIONS_PER_SECOND = 40;
const selectionBudget = new WeakMap<OutlineLiveWS, { tokens: number; at: number }>();

function takeSelectionToken(ws: OutlineLiveWS): boolean {
	const now = Date.now();
	const b = selectionBudget.get(ws) ?? { tokens: SELECTIONS_PER_SECOND, at: now };
	b.tokens = Math.min(
		SELECTIONS_PER_SECOND,
		b.tokens + ((now - b.at) / 1000) * SELECTIONS_PER_SECOND,
	);
	b.at = now;
	selectionBudget.set(ws, b);
	if (b.tokens < 1) return false;
	b.tokens -= 1;
	return true;
}

/** A binary outline live frame from a narrator socket. */
export function handleOutlineLiveBinary(ws: OutlineLiveWS, bytes: Uint8Array): void {
	if (!ws.data.userId || ws.data.publicShare) return;
	if (bytes.byteLength > OUTLINE_LIVE_LIMITS.maxClientFrameBytes) {
		// A client can send these as fast as it likes: one line a minute.
		if (Date.now() - oversizeLoggedAt > 60_000) {
			oversizeLoggedAt = Date.now();
			logger.warn("Outline live frame too large; dropped", { bytes: bytes.byteLength });
		}
		return;
	}
	// Cursor moves are last-wins: excess ones are dropped before their JSON is even read.
	if (bytes[1] === LIVE_FRAME.selection) {
		if (bytes.byteLength > SELECTION_MAX_BYTES || !takeSelectionToken(ws)) return;
	}
	const frame = decodeLiveFrame(bytes, OUTLINE_LIVE_LIMITS.maxHeadBytes);
	if (!frame || frame.kind >= 0x80) return;
	handleLiveFrame(socketOf(ws), frame);
}

/** The socket can take more: participants that fell behind are told to rejoin. */
export function drainOutlineLive(ws: OutlineLiveWS): void {
	const socket = sockets.get(ws);
	if (socket) drainLiveSocket(socket);
}

/** The socket closed. */
export function releaseOutlineLive(ws: OutlineLiveWS): void {
	const socket = sockets.get(ws);
	if (!socket) return;
	socket.closed = true;
	sockets.delete(ws);
	releaseLiveSocket(socket);
}
