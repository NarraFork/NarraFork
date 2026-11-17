/**
 * An in-process network for live session tests: the editor's real client engine
 * (`frontend/components/outline/editor/live-client.ts`) talks to the real registry through
 * encoded frames, delivered asynchronously in order per link. A link can be held (frames queue),
 * disconnected and reconnected (a new socket, as a browser reconnect makes), and can pretend its
 * socket buffers bytes (backpressure).
 */
import {
	LiveClient,
	type LiveClientOptions,
	type LiveTransport,
} from "@frontend/components/outline/editor/live-client";
import type { BlockRec, ClientOp } from "@frontend/components/outline/editor/store";
import {
	type LiveClock,
	type LiveTimer,
	liveTimeout,
	setLiveClockForTests,
} from "@shared/outline-live-clock";
import {
	decodeLiveFrame,
	type LiveFrame,
	type LiveJoinHead,
	OUTLINE_LIVE_PROTOCOL_VERSION,
} from "@shared/outline-live-protocol";
import { sqlite } from "../../../../db";
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
	liveTimeout(() => {
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

	/** Frames to the client queue (the server's answers are late); the client's still go. */
	downHeld = false;

	holdDown(on: boolean): void {
		this.downHeld = on;
		if (!on) this.pump();
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
		while (!this.downHeld && this.down.length > 0) {
			const frame = this.down.shift() as Uint8Array;
			later(() => {
				// A frame of a connection that went is never delivered, also not onto a new one
				// opened in the meantime (as the browser transport drops a closed socket's frames).
				if (!this.connected || this.socket !== socket) return;
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
		this.downHeld = false;
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

/** The space a block is in, read at once (the editor knows it; a test names the block only). */
export function spaceOfBlock(blockId: string): string {
	const row = sqlite
		.query("SELECT space_id AS s FROM outline_blocks WHERE id = ?")
		.get(blockId) as {
		s: string;
	} | null;
	return row?.s ?? "";
}

/** A join head of this protocol version for a raw client watching a block's subtree. */
export function joinHead(rootId: string, mode: "edit" | "view", key: string): LiveJoinHead {
	return {
		v: OUTLINE_LIVE_PROTOCOL_VERSION,
		space: spaceOfBlock(rootId),
		watch: [{ s: rootId }],
		mode,
		key,
	};
}

/**
 * An editor client without a view: commits go through the engine's own API. It joins the
 * root's space and watches the root's subtree, as the editor does, unless told otherwise.
 */
export function client(
	link: TestLink,
	pageId: string,
	mode: "edit" | "view" = "edit",
	options: LiveClientOptions = {},
): LiveClient {
	const c = new LiveClient(link, pageId, mode, {
		...options,
		space: options.space ?? spaceOfBlock(pageId),
	});
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

interface FakeTimer {
	at: number;
	seq: number;
	fn: () => void;
	cancelled: boolean;
}

/**
 * A clock the test advances itself (`shared/outline-live-clock.ts`): every timer of the live
 * engine, of the clients and of this harness's network fires in the order of its due time, and
 * only when the test advances past it. Between timers, `flush` lets what is already running
 * finish (promises and the store's work: no timer, no waiting for time).
 */
export class FakeLiveClock implements LiveClock {
	t: number;
	private seq = 0;
	private readonly timers: FakeTimer[] = [];
	/** Timers fired so far (diagnostics). */
	fired = 0;

	constructor(start = Date.parse("2026-11-16T00:00:00.000Z")) {
		this.t = start;
	}

	now(): number {
		return this.t;
	}

	setTimeout(fn: () => void, ms: number): LiveTimer {
		const timer: FakeTimer = {
			at: this.t + Math.max(0, ms),
			seq: this.seq++,
			fn,
			cancelled: false,
		};
		this.timers.push(timer);
		return timer as unknown as LiveTimer;
	}

	clearTimeout(timer: LiveTimer): void {
		(timer as unknown as FakeTimer).cancelled = true;
	}

	yield(): Promise<void> {
		return Promise.resolve();
	}

	install(): this {
		setLiveClockForTests(this);
		return this;
	}

	uninstall(): void {
		setLiveClockForTests(null);
	}

	/** Let everything already started run to its next timer (promise chains, the store). */
	async flush(): Promise<void> {
		for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
	}

	private next(until: number): FakeTimer | null {
		let best: FakeTimer | null = null;
		for (let i = this.timers.length - 1; i >= 0; i--) {
			const t = this.timers[i] as FakeTimer;
			if (t.cancelled) {
				this.timers.splice(i, 1);
				continue;
			}
			if (t.at > until) continue;
			if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t;
		}
		return best;
	}

	/** Advance by `ms`, firing every timer due on the way in order (and what they start). */
	async advance(ms: number): Promise<void> {
		const until = this.t + ms;
		await this.flush();
		for (;;) {
			const t = this.next(until);
			if (!t) break;
			this.timers.splice(this.timers.indexOf(t), 1);
			if (t.at > this.t) this.t = t.at;
			this.fired++;
			t.fn();
			await this.flush();
		}
		this.t = until;
		await this.flush();
	}

	/** Advance in steps of `step` until `predicate` holds; throws past `maxMs` of clock time. */
	async until(
		predicate: () => boolean,
		maxMs = 30_000,
		what = "condition",
		step = 5,
	): Promise<void> {
		const end = this.t + maxMs;
		await this.flush();
		while (!predicate()) {
			if (this.t >= end) throw new Error(`clock passed ${maxMs} ms waiting for ${what}`);
			await this.advance(step);
		}
	}

	/** Advance until nothing is in flight or due within `quietMs` (the network and the engine). */
	async settle(quietMs = 100, maxMs = 30_000): Promise<void> {
		const end = this.t + maxMs;
		let quietSince = this.t;
		for (;;) {
			await this.advance(5);
			const busy = inFlight > 0 || !outlineLiveQuiet() || [...watched].some((c) => !c.quiet);
			if (busy) quietSince = this.t;
			else if (this.t - quietSince >= quietMs) return;
			if (this.t > end) throw new Error("live network did not settle on the fake clock");
		}
	}
}
