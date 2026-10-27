/**
 * The outline page live session protocol: binary WebSocket frames on `/ws/narrator`.
 *
 * WHY BINARY FRAMES ON THE NARRATOR SOCKET
 * ----------------------------------------
 * The socket is already open, authenticated, re-checked on session expiry and access changes,
 * kept alive and reconnected; the read-only page subscription (PR7) lives there too. Yjs
 * updates are bytes: carrying them as base64 inside JSON costs a third more on every frame and
 * a JSON parse on both ends, so live frames are binary and only small control parts are JSON.
 * Text frames on the same socket stay JSON; a binary frame whose first byte is
 * {@link OUTLINE_LIVE_MAGIC} belongs to this protocol.
 *
 * FRAME LAYOUT
 * ------------
 *   byte 0      magic 0xB1
 *   byte 1      kind (LIVE_FRAME)
 *   varuint     handle: the page session on this socket, chosen by the client at join (1–255)
 *   varuint     n: a transaction number (client frames, reject) or the highest transaction of
 *               the recipient the server has processed (batch); 0 when unused
 *   varuint     length of the JSON head in bytes, 0 for none
 *   …           the JSON head (UTF-8)
 *   …           the body: raw bytes to the end of the frame (a Yjs update or state vector)
 *
 * A typing frame is therefore 5 bytes of framing plus the Yjs update, in both directions.
 *
 * Nothing here depends on Yjs: bodies are opaque bytes.
 */

export const OUTLINE_LIVE_MAGIC = 0xb1;

/**
 * The largest handle (a page session on one socket). Frames with a larger one do not decode, so
 * nothing past the decoder ever holds a handle a reply could not carry.
 */
export const OUTLINE_LIVE_MAX_HANDLE = 255;

export const LIVE_FRAME = {
	/** C→S: join a page. Head {@link LiveJoinHead}; body: the client's state vector on resume. */
	join: 0x01,
	/** C→S: leave. */
	leave: 0x02,
	/** C→S: text-only Yjs update. `n` = transaction number; body = update. */
	update: 0x03,
	/** C→S: structural transaction. `n`; head {@link LiveTxHead}; body = its Yjs update. */
	tx: 0x04,
	/** C→S: own selection. Head {@link LivePresenceUp}. */
	selection: 0x05,
	/** S→C: joined. Head {@link LiveJoinedHead}; body = Yjs state (reset) or diff (resume). */
	joined: 0x81,
	/** S→C: coalesced changes. `n` = ack; head {@link LiveBatchHead} or none; body = update. */
	batch: 0x82,
	/** S→C: a transaction was refused; `n` = it. Later ones from this client were dropped. */
	reject: 0x83,
	/** S→C: who is here and where their cursors are. Head {@link LivePresenceDown}. */
	presence: 0x84,
	/** S→C: the session ended for this client. Head {@link LiveClosedHead}. */
	closed: 0x85,
	/** S→C: frames were dropped (the socket fell behind): join again to resume. */
	resync: 0x86,
	/** S→C: write access changed. Head {@link LiveModeHead}. */
	mode: 0x87,
} as const;

export type LiveFrameKind = (typeof LIVE_FRAME)[keyof typeof LIVE_FRAME];

/** Limits both sides know. The server enforces them; the client stays inside them. */
export const OUTLINE_LIVE_LIMITS = {
	/** Live page sessions one socket may join. */
	sessionsPerSocket: 8,
	/** Editing participants of one page (design §7.2). */
	editorsPerPage: 20,
	/** Read-only participants of one page (the page subscriber limit, design §7.2). */
	viewersPerPage: 50,
	/** Pages in a live session across the process (design §7.2). */
	livePages: 500,
	/** Live blocks of a page that can be edited live; larger pages stay read-only. */
	maxPageBlocks: 2000,
	/** UTF-8 bytes of all block content of a page that can be edited live. */
	maxPageBytes: 4 * 1024 * 1024,
	/** Bytes of one client frame. */
	maxClientFrameBytes: 256 * 1024,
	/** Operations of one structural transaction (the write path's limit). */
	maxTxOps: 200,
	/** Bytes of the JSON head of a client frame. */
	maxHeadBytes: 64 * 1024,
	/**
	 * Bytes of the JSON head of a server frame: a snapshot's structure (about 45 bytes a block),
	 * a resume's operations, a batch with a large outside commit. Bounded by the page limits.
	 */
	maxServerHeadBytes: 8 * 1024 * 1024,
	/** Client-side: unacknowledged transactions before the editor stops taking input. */
	maxPendingTx: 2000,
	/** Client-side: unacknowledged bytes before the editor stops taking input. */
	maxPendingBytes: 4 * 1024 * 1024,
	/** Client-side: minimum milliseconds between two own presence frames. */
	presenceIntervalMs: 80,
	/** Client-side: text-only updates are batched for this long before they are sent. */
	typingBatchMs: 30,
} as const;

/** Task checkbox as the editor stores it on a block: todo, doing, done, cancelled. */
export type LiveTaskChar = " " | "/" | "x" | "-";

/**
 * A structural operation as sent and broadcast. Content is never here: a block's text lives in
 * the Yjs document (a new block's text arrives in the same frame's update).
 *   - `i`: insert, or restore when the id names a deleted block; `p` parent, `k` order key
 *   - `m`: move under `p` at `k`
 *   - `d`: delete (with its live subtree)
 *   - `k`: set the checkbox (`null` removes the task)
 */
export type LiveOp =
	| { t: "i"; id: string; p: string; k: string; task?: LiveTaskChar | null }
	| { t: "m"; id: string; p: string; k: string }
	| { t: "d"; id: string }
	| { t: "k"; id: string; task: LiveTaskChar | null };

/**
 * A live block in a structure snapshot, in depth-first order so a parent precedes its
 * children: id, index of the parent in the list (-1 for the page itself), order key, sid,
 * checkbox ("" for none).
 */
export type LiveBlockWire = [
	id: string,
	parent: number,
	orderKey: string,
	sid: string,
	task: LiveTaskChar | "",
];

/** Who made a change: a participant number, or `a` (an agent), `s` (the system), `h` (a person
 * outside the session). */
export type LiveActor = number | "a" | "s" | "h";

export interface LiveCommitWire {
	/** The session's operation sequence number of this batch. */
	o: number;
	by: LiveActor;
	/** Display name of an actor outside the session, when known. */
	name?: string;
	ops: LiveOp[];
}

export interface LiveJoinHead {
	page: string;
	/** `edit` asks for write access; a read-only person gets `view`. */
	mode: "edit" | "view";
	/** Identifies this editor instance across reconnects (8–64 characters). */
	key: string;
	/** Resume a session this instance was in: body is the client's Yjs state vector. */
	/**
	 * The session this client was in before (sent on every join after the first). Without
	 * `reset` the client asks to resume it (a state-vector diff); with `reset` it wants a
	 * snapshot. Either way the answer says which of its transactions of that session the page
	 * already has (`tx`, `dur`), so the client neither loses nor repeats them.
	 */
	resume?: { epoch: number; op: number; tx: number; reset?: boolean };
}

/** Participant: number, user id, display name, color, `e` editing or `v` viewing. */
export type LivePeerWire = [
	pno: number,
	userId: string,
	name: string,
	color: string,
	mode: "e" | "v",
];

export interface LiveJoinedHead {
	/** The session instance; a resume names it. */
	epoch: number;
	/** `reset`: drop local state and take the snapshot. `resume`: apply the diff and ops. */
	mode: "reset" | "resume";
	/** Whether this participant may edit. */
	w: boolean;
	/** The session's operation sequence number now. */
	op: number;
	/**
	 * The highest transaction of this client's previous session (`resume.epoch`) the page has
	 * applied: the client does not send or replay those again.
	 */
	tx: number;
	/** This participant's number. */
	me: number;
	/** Structure snapshot (reset, or a resume the operation log no longer covers). */
	blocks?: LiveBlockWire[];
	/** Structural batches after the client's `op` (resume). */
	ops?: LiveCommitWire[];
	peers: LivePeerWire[];
	/** Cursors of the peers now. */
	cur?: Array<[pno: number, sel: LiveSelWire | null]>;
	/**
	 * Of those, the highest already in the log or committed (so safe from a crash): the client
	 * forgets them. Ones after it up to `tx` are applied but not logged yet; the client keeps
	 * them, unsent and not replayed, until a batch acknowledges them.
	 */
	dur?: number;
}

export interface LiveTxHead {
	ops: LiveOp[];
}

export interface LiveBatchHead {
	/** Structural changes, in order. */
	c?: LiveCommitWire[];
	/**
	 * This recipient's structural transactions that became batches: transaction number,
	 * operation sequence number, and the canonical operations when they differ from what was
	 * sent (an order key moved, a delete took more blocks, an insert became a restore).
	 */
	a?: Array<[tx: number, op: number, ops?: LiveOp[]]>;
}

/**
 * A position in a block's text: the block id and a Yjs relative position as
 * `[client, clock, assoc]` of the item it sticks to, or `null` for the end of the text.
 */
export type LivePosWire = [blockId: string, rel: [number, number, number] | null];

/** A selection: in text (`a` anchor, `h` head) or a set of whole blocks (`b`). */
export type LiveSelWire = { a: LivePosWire; h: LivePosWire } | { b: string[] };

export interface LivePresenceUp {
	s: LiveSelWire | null;
}

export interface LivePresenceDown {
	/** Participants that joined or changed. */
	peers?: LivePeerWire[];
	/** Participants that left. */
	gone?: number[];
	/** Latest cursor per participant (last one wins). */
	cur?: Array<[pno: number, sel: LiveSelWire | null]>;
}

export type LiveCloseCode =
	/** The page does not exist or the person may not (or may no longer) read it. */
	| "access_denied"
	/** The outline is off, or the server is at a limit. */
	| "unavailable"
	/** The page is larger than a live session takes; show it read-only. */
	| "too_large"
	/** The session was closed (shutdown); join again later. */
	| "ended";

export interface LiveClosedHead {
	code: LiveCloseCode;
}

export type LiveRejectCode =
	/** Another change made this one impossible (a block it names is gone, a cycle, …). */
	| "conflict"
	/** The person may not write the page (any more). */
	| "read_only"
	/** The transaction is malformed or over a limit. */
	| "invalid"
	/** Writing failed on the server; the change was not saved. */
	| "failed";

export interface LiveRejectHead {
	code: LiveRejectCode;
}

export interface LiveModeHead {
	w: boolean;
}

export interface LiveFrame {
	kind: number;
	handle: number;
	n: number;
	head: unknown;
	body: Uint8Array;
}

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function varuintSize(n: number): number {
	let size = 1;
	let v = n;
	while (v >= 0x80) {
		v = Math.floor(v / 0x80);
		size++;
	}
	return size;
}

function writeVaruint(out: Uint8Array, at: number, n: number): number {
	let v = n;
	let i = at;
	while (v >= 0x80) {
		out[i++] = (v % 0x80) | 0x80;
		v = Math.floor(v / 0x80);
	}
	out[i++] = v;
	return i;
}

/** Whether a handle is one a frame can carry (0 only answers a malformed join). */
export function isLiveHandle(handle: number): boolean {
	return Number.isInteger(handle) && handle >= 0 && handle <= OUTLINE_LIVE_MAX_HANDLE;
}

/** A head serialized once, for frames that differ only in their handle. */
export function encodeLiveHead(head: unknown): Uint8Array {
	return encoder.encode(JSON.stringify(head));
}

/**
 * Encode a frame. `head` is JSON-serialized when present; `rawHead` is a head already
 * serialized with {@link encodeLiveHead}.
 */
export function encodeLiveFrame(frame: {
	kind: number;
	handle: number;
	n?: number;
	head?: unknown;
	rawHead?: Uint8Array;
	body?: Uint8Array;
}): Uint8Array {
	const n = frame.n ?? 0;
	if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid live frame number ${n}`);
	if (!isLiveHandle(frame.handle)) throw new Error(`invalid live frame handle ${frame.handle}`);
	const head =
		frame.rawHead ??
		(frame.head === undefined ? EMPTY : encoder.encode(JSON.stringify(frame.head)));
	const body = frame.body ?? EMPTY;
	const size =
		2 +
		varuintSize(frame.handle) +
		varuintSize(n) +
		varuintSize(head.length) +
		head.length +
		body.length;
	const out = new Uint8Array(size);
	out[0] = OUTLINE_LIVE_MAGIC;
	out[1] = frame.kind;
	let at = writeVaruint(out, 2, frame.handle);
	at = writeVaruint(out, at, n);
	at = writeVaruint(out, at, head.length);
	out.set(head, at);
	out.set(body, at + head.length);
	return out;
}

/** Whether bytes are a live frame (by the magic byte only). */
export function isLiveFrame(bytes: Uint8Array): boolean {
	return bytes.length >= 2 && bytes[0] === OUTLINE_LIVE_MAGIC;
}

/**
 * Decode a frame. Returns null for anything malformed: a wrong magic byte, a truncated varint,
 * a head longer than `maxHeadBytes` or not valid UTF-8 JSON. The body is a view into `bytes`.
 * The head limit defaults by direction: a server frame (kind ≥ 0x80) may carry a snapshot's
 * structure; the server decodes client frames with the client limit.
 */
export function decodeLiveFrame(bytes: Uint8Array, maxHeadBytes?: number): LiveFrame | null {
	if (!isLiveFrame(bytes)) return null;
	const limit =
		maxHeadBytes ??
		((bytes[1] as number) >= 0x80
			? OUTLINE_LIVE_LIMITS.maxServerHeadBytes
			: OUTLINE_LIVE_LIMITS.maxHeadBytes);
	let at = 2;
	const read = (): number | null => {
		let result = 0;
		let scale = 1;
		for (let i = 0; i < 8; i++) {
			if (at >= bytes.length) return null;
			const b = bytes[at++] as number;
			result += (b & 0x7f) * scale;
			if (b < 0x80) return Number.isSafeInteger(result) ? result : null;
			scale *= 0x80;
		}
		return null;
	};
	const handle = read();
	const n = read();
	const headLength = read();
	if (handle === null || n === null || headLength === null) return null;
	if (!isLiveHandle(handle)) return null;
	if (headLength > limit || at + headLength > bytes.length) return null;
	let head: unknown = null;
	if (headLength > 0) {
		try {
			head = JSON.parse(decoder.decode(bytes.subarray(at, at + headLength)));
		} catch {
			return null;
		}
	}
	return { kind: bytes[1] as number, handle, n, head, body: bytes.subarray(at + headLength) };
}

/** Task status ⇄ the checkbox character the editor keeps. */
export const LIVE_TASK_OF_STATUS = {
	todo: " ",
	doing: "/",
	done: "x",
	cancelled: "-",
} as const satisfies Record<string, LiveTaskChar>;

export const LIVE_STATUS_OF_TASK: Record<LiveTaskChar, "todo" | "doing" | "done" | "cancelled"> = {
	" ": "todo",
	"/": "doing",
	x: "done",
	"-": "cancelled",
};

export function isLiveTaskChar(value: unknown): value is LiveTaskChar {
	return value === " " || value === "/" || value === "x" || value === "-";
}
