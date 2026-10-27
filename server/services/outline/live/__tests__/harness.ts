/**
 * An in-process network for live session tests: the editor's real client engine
 * (`frontend/components/outline/editor/live-client.ts`) talks to the real registry through
 * encoded frames, delivered asynchronously in order per link. A link can be held (frames queue),
 * disconnected and reconnected (a new socket, as a browser reconnect makes), and can pretend its
 * socket buffers bytes (backpressure).
 */
import { LiveClient, type LiveTransport } from "@frontend/components/outline/editor/live-client";
import type { BlockRec, ClientOp } from "@frontend/components/outline/editor/store";
import { decodeLiveFrame, type LiveFrame } from "@shared/outline-live-protocol";
import {
	drainLiveSocket,
	handleLiveFrame,
	outlineLiveQuiet,
	outlineLiveStats,
	releaseLiveSocket,
} from "../registry";
import type { LiveSocket } from "../session";

export class TestSocket implements LiveSocket {
	closed = false;
	buffered = 0;
	readonly sent: LiveFrame[] = [];
	bytes = 0;

	constructor(
		readonly userId: string,
		readonly name: string,
		private readonly deliver: (frame: Uint8Array) => void,
		readonly isAdmin = false,
	) {}

	readonly color = "#1c7ed6";

	send(frame: Uint8Array): boolean {
		if (this.closed) return false;
		this.bytes += frame.length;
		const decoded = decodeLiveFrame(frame);
		if (decoded) this.sent.push(decoded);
		this.deliver(frame.slice());
		return true;
	}

	bufferedAmount(): number {
		return this.buffered;
	}
}

let inFlight = 0;

function later(fn: () => void): void {
	inFlight++;
	setTimeout(() => {
		try {
			fn();
		} finally {
			inFlight--;
		}
	}, 0);
}

export class TestLink implements LiveTransport {
	socket: TestSocket;
	connected = true;
	held = false;
	private readonly up: Uint8Array[] = [];
	private readonly down: Uint8Array[] = [];
	private readonly frameListeners = new Set<(frame: LiveFrame) => void>();
	private readonly connListeners = new Set<(connected: boolean) => void>();
	private handles = new Set<number>();
	framesUp = 0;
	bytesUp = 0;
	framesDown = 0;
	bytesDown = 0;

	constructor(
		readonly userId: string,
		readonly name: string,
	) {
		this.socket = this.newSocket();
	}

	private newSocket(): TestSocket {
		const socket = new TestSocket(this.userId, this.name, (frame) => {
			this.down.push(frame);
			this.pump();
		});
		return socket;
	}

	send(frame: Uint8Array): boolean {
		if (!this.connected) return false;
		this.framesUp++;
		this.bytesUp += frame.length;
		this.up.push(frame.slice());
		this.pump();
		return true;
	}

	onFrame(listener: (frame: LiveFrame) => void): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	onConnectionChange(listener: (connected: boolean) => void): () => void {
		this.connListeners.add(listener);
		return () => this.connListeners.delete(listener);
	}

	allocateHandle(): number | null {
		for (let h = 1; h < 256; h++) {
			if (!this.handles.has(h)) {
				this.handles.add(h);
				return h;
			}
		}
		return null;
	}

	releaseHandle(handle: number): void {
		this.handles.delete(handle);
	}

	hold(on: boolean): void {
		this.held = on;
		if (!on) this.pump();
	}

	private pump(): void {
		if (this.held) return;
		const socket = this.socket;
		while (this.up.length > 0) {
			const frame = this.up.shift() as Uint8Array;
			later(() => {
				if (socket.closed) return;
				const decoded = decodeLiveFrame(frame);
				if (decoded) handleLiveFrame(socket, decoded);
			});
		}
		while (this.down.length > 0) {
			const frame = this.down.shift() as Uint8Array;
			later(() => {
				if (!this.connected) return;
				this.framesDown++;
				this.bytesDown += frame.length;
				const decoded = decodeLiveFrame(frame);
				if (decoded) for (const l of this.frameListeners) l(decoded);
			});
		}
	}

	/** Drop the connection: the server sees the socket close; queued frames are lost. */
	disconnect(): void {
		this.connected = false;
		this.up.length = 0;
		this.down.length = 0;
		this.socket.closed = true;
		releaseLiveSocket(this.socket);
		for (const l of this.connListeners) l(false);
	}

	/** A new socket, as a browser reconnect opens. */
	reconnect(): void {
		this.socket = this.newSocket();
		this.connected = true;
		this.handles = new Set();
		for (const l of this.connListeners) l(true);
	}

	/** Pretend the socket buffers this many bytes (backpressure); 0 drains it. */
	setBuffered(bytes: number): void {
		this.socket.buffered = bytes;
		if (bytes === 0) drainLiveSocket(this.socket);
	}
}

const watched = new Set<LiveClient>();

/**
 * Wait until nothing is in flight: no frame on any link, no lane task, no broadcast waiting, no
 * client batch waiting, for `quietMs` in a row.
 */
export async function settle(quietMs = 20, timeoutMs = 5000): Promise<void> {
	const end = Date.now() + timeoutMs;
	let quietSince = Date.now();
	let last = -1;
	for (;;) {
		await new Promise((r) => setTimeout(r, 5));
		const stats = outlineLiveStats();
		const busy = inFlight > 0 || !outlineLiveQuiet() || [...watched].some((c) => !c.quiet);
		const signature = stats.participants;
		if (busy || signature !== last) {
			last = signature;
			quietSince = Date.now();
		} else if (Date.now() - quietSince >= quietMs) return;
		if (Date.now() > end) throw new Error("live network did not settle");
	}
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000, what = "condition") {
	const end = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** An editor client without a view: commits go through the engine's own API. */
export function client(link: TestLink, pageId: string, mode: "edit" | "view" = "edit"): LiveClient {
	const c = new LiveClient(link, pageId, mode);
	watched.add(c);
	return c;
}

export function forget(c: LiveClient): void {
	watched.delete(c);
}

/** Type `text` at the end (or at `offset`) of a block, one keystroke per commit. */
export function type(c: LiveClient, blockId: string, text: string, offset?: number): void {
	let at = offset ?? c.textOf(blockId).length;
	for (const ch of text) {
		const cur = c.textOf(blockId);
		c.commit({
			ops: [],
			bodies: [{ id: blockId, md: cur.slice(0, at) + ch + cur.slice(at) }],
			kind: "typing",
			blockId,
			selBefore: null,
			selAfter: null,
			view: null,
		});
		at += ch.length;
	}
}

/** A structural transaction through the engine. */
export function struct(
	c: LiveClient,
	ops: ClientOp[],
	bodies: Array<{ id: string; md: string }> = [],
) {
	c.commit({
		ops,
		bodies,
		kind: "struct",
		blockId: null,
		selBefore: null,
		selAfter: null,
		view: null,
	});
}

/** The children of a block in the client's visible structure. */
export function kids(c: LiveClient, id: string): BlockRec[] {
	return c.visible.children(id).map((k) => c.visible.get(k) as BlockRec);
}
