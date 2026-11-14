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
 *   …           the body: raw bytes to the end of the frame: text entries ({@link LiveTextEntry})
 *
 * TEXT IS PER BLOCK (protocol version 2)
 * --------------------------------------
 * Every block has a text document of its own (`shared/outline-live-text.ts`), made only when
 * someone changes the block's text. A body is a list of entries, each naming its block:
 *   - `seed`: the block's text as plain UTF-8, for a block nobody has a document for (S→C: in a
 *     snapshot, and when a write from outside the session adds a block). Both ends make the
 *     block's document from exactly this text, so documents made independently are the same one.
 *     A block with no entry at all has the empty text.
 *   - `update`: a Yjs update of that block's document (both directions; in a snapshot, the
 *     document's whole state).
 *   - `vector`: the state vector of a document the client holds (C→S, in a resuming join): the
 *     answer carries what that document lacks, and every document the client did not name whole.
 *
 * A typing frame is therefore 5 bytes of framing, the block id and the Yjs update, in both
 * directions.
 *
 * Nothing here depends on Yjs: entry payloads are opaque bytes.
 */

/**
 * The protocol's version, named by every join. A client of another version is told its session
 * is `outdated` (it reloads to get the matching code); nothing is negotiated.
 */
export const OUTLINE_LIVE_PROTOCOL_VERSION = 2;

export const OUTLINE_LIVE_MAGIC = 0xb1;

/**
 * The largest handle (a page session on one socket). Frames with a larger one do not decode, so
 * nothing past the decoder ever holds a handle a reply could not carry.
 */
export const OUTLINE_LIVE_MAX_HANDLE = 255;

export const LIVE_FRAME = {
	/** C→S: join a page. Head {@link LiveJoinHead}; body: on resume, a `vector` entry per held document. */
	join: 0x01,
	/** C→S: leave. */
	leave: 0x02,
	/** C→S: text only. `n` = transaction number; body = `update` entries. */
	update: 0x03,
	/** C→S: structural transaction. `n`; head {@link LiveTxHead}; body = its `update` entries. */
	tx: 0x04,
	/** C→S: own selection. Head {@link LivePresenceUp}. */
	selection: 0x05,
	/** S→C: joined. Head {@link LiveJoinedHead}; body = every text (reset) or what is missing (resume). */
	joined: 0x81,
	/** S→C: coalesced changes. `n` = ack; head {@link LiveBatchHead} or none; body = text entries. */
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
	/** Text entries of one client frame (a transaction's blocks, or a resume's documents). */
	maxClientTextEntries: 4096,
	/** Bytes of a block id in a text entry. */
	maxTextIdBytes: 128,
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
	/** Agents a page shows in its presence at most; the rest are counted (`am`, P2 PR 10b). */
	agentsPerPage: 8,
} as const;

/**
 * Participant numbers of agents start here (outline P2 PR 10b): the server sends agents as
 * participants of its own, apart from the people's numbers (which count up from 1).
 */
export const OUTLINE_LIVE_AGENT_PNO_BASE = 1 << 20;

/** The presence palette; a person without an avatar colour, and every agent, get one by id. */
export const LIVE_PEER_PALETTE = [
	"#d6336c",
	"#1c7ed6",
	"#2f9e44",
	"#e8590c",
	"#7048e8",
	"#0c8599",
	"#c2255c",
	"#5f3dc4",
] as const;

/** The palette colour of an id (a user's, or an agent's session id). */
export function livePeerColor(id: string): string {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
	return LIVE_PEER_PALETTE[h % LIVE_PEER_PALETTE.length] as string;
}

/** Task checkbox as the editor stores it on a block: todo, doing, done, cancelled. */
export type LiveTaskChar = " " | "/" | "x" | "-";

/**
 * A structural operation as sent and broadcast. Content is never here: a block's text lives in
 * its text document (a new block's text arrives in the same frame's body, as an update of the
 * document its creator made from the empty text).
 *   - `i`: insert, or restore when the id names a deleted block; `p` parent, `k` order key; `q`
 *     the block is a question put to a person (`Ask`): set by the server only (a client cannot
 *     make a question, and the server ignores the field from one), added after the first
 *     protocol version
 *   - `m`: move under `p` at `k`
 *   - `d`: delete (with its live subtree); deleting a question withdraws it
 *   - `k`: set the checkbox (`null` removes the task); refused on a question
 */
export type LiveOp =
	| { t: "i"; id: string; p: string; k: string; task?: LiveTaskChar | null; q?: true }
	| { t: "m"; id: string; p: string; k: string }
	| { t: "d"; id: string }
	| { t: "k"; id: string; task: LiveTaskChar | null };

/**
 * A live block in a structure snapshot, in depth-first order so a parent precedes its
 * children: id, index of the parent in the list (-1 for the page itself), order key, sid,
 * checkbox ("" for none), and `1` for a question put to a person (`Ask`; absent otherwise,
 * added after the first protocol version).
 */
export type LiveBlockWire = [
	id: string,
	parent: number,
	orderKey: string,
	sid: string,
	task: LiveTaskChar | "",
	question?: 1,
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
	/** {@link OUTLINE_LIVE_PROTOCOL_VERSION}. */
	v: number;
	page: string;
	/** `edit` asks for write access; a read-only person gets `view`. */
	mode: "edit" | "view";
	/** Identifies this editor instance across reconnects (8–64 characters). */
	key: string;
	/**
	 * The session this client was in before (sent on every join after the first). Without
	 * `reset` the client asks to resume it (the body names the documents it holds); with `reset` it wants a
	 * snapshot. Either way the answer says which of its transactions of that session the page
	 * already has (`tx`, `dur`), so the client neither loses nor repeats them.
	 */
	resume?: { epoch: number; op: number; tx: number; reset?: boolean };
}

/**
 * Participant: number, user id, display name, color, `e` editing or `v` viewing. An agent (outline
 * P2 PR 10b) adds `a`, and for a reader who may read its session: its narrator id and, for a
 * subagent, the title of the session it belongs to; its user id is empty, and so is its name for a
 * reader who may not read it ("Agent"). Added after the first protocol version: a client that
 * reads only the first five shows an agent as a person without a name, which does no harm.
 */
export type LivePeerWire = [
	pno: number,
	userId: string,
	name: string,
	color: string,
	mode: "e" | "v",
	kind?: "a",
	narratorId?: string,
	session?: string,
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
	/** Agents present beyond those listed (P2 PR 10b); absent: none. */
	am?: number;
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
	/** Agents present beyond those listed, when it changed (P2 PR 10b). */
	am?: number;
}

export type LiveCloseCode =
	/** The page does not exist or the person may not (or may no longer) read it. */
	| "access_denied"
	/** The outline is off, or the server is at a limit. */
	| "unavailable"
	/** The page is larger than a live session takes; show it read-only. */
	| "too_large"
	/** The session was closed (shutdown); join again later. */
	| "ended"
	/** The client speaks another protocol version: it must be reloaded. */
	| "outdated";

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

/**
 * Why a change to a task was refused: someone else is doing it (setting it in progress claims
 * it, `server/services/outline/write.ts`). Added after the first protocol version: a client that
 * does not know the field ignores it, and the code stays `conflict`.
 */
export interface LiveClaimedWire {
	/** `key/sid` of the task. */
	address: string;
	holder: {
		kind: "agent" | "human";
		/** The session's narrator id, or the person's user id. */
		id: string;
		/** Session title or username, when known. */
		name: string | null;
	};
}

export interface LiveRejectHead {
	code: LiveRejectCode;
	/** Present when the refusal is a task someone else is doing (with `code` `conflict`). */
	claimed?: LiveClaimedWire;
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

export const LIVE_TEXT_KIND = { seed: 0, update: 1, vector: 2 } as const;

export type LiveTextKind = (typeof LIVE_TEXT_KIND)[keyof typeof LIVE_TEXT_KIND];

/** One block's text in a frame body (see the module header). */
export interface LiveTextEntry {
	id: string;
	kind: LiveTextKind;
	data: Uint8Array;
}

/**
 * Encode text entries as a frame body:
 *   varuint  bytes of the block id      …  the id (UTF-8)
 *   byte     kind
 *   varuint  bytes of the payload       …  the payload
 * repeated to the end of the body.
 */
export function encodeLiveTexts(entries: readonly LiveTextEntry[]): Uint8Array {
	if (entries.length === 0) return EMPTY;
	const ids = entries.map((e) => encoder.encode(e.id));
	let size = 0;
	entries.forEach((e, i) => {
		const id = ids[i] as Uint8Array;
		size += varuintSize(id.length) + id.length + 1 + varuintSize(e.data.length) + e.data.length;
	});
	const out = new Uint8Array(size);
	let at = 0;
	entries.forEach((e, i) => {
		const id = ids[i] as Uint8Array;
		at = writeVaruint(out, at, id.length);
		out.set(id, at);
		at += id.length;
		out[at++] = e.kind;
		at = writeVaruint(out, at, e.data.length);
		out.set(e.data, at);
		at += e.data.length;
	});
	return out;
}

/**
 * Decode a frame body's text entries. Null for anything malformed (a truncated entry, an
 * unknown kind, an id that is empty, too long or not UTF-8) or more than `maxEntries`. Payloads
 * are views into `bytes`.
 */
export function decodeLiveTexts(
	bytes: Uint8Array,
	maxEntries = Number.POSITIVE_INFINITY,
): LiveTextEntry[] | null {
	const out: LiveTextEntry[] = [];
	let at = 0;
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
	while (at < bytes.length) {
		if (out.length >= maxEntries) return null;
		const idLength = read();
		if (
			idLength === null ||
			idLength === 0 ||
			idLength > OUTLINE_LIVE_LIMITS.maxTextIdBytes ||
			at + idLength + 1 > bytes.length
		)
			return null;
		let id: string;
		try {
			id = decoder.decode(bytes.subarray(at, at + idLength));
		} catch {
			return null;
		}
		at += idLength;
		const kind = bytes[at++] as number;
		if (kind !== 0 && kind !== 1 && kind !== 2) return null;
		const length = read();
		if (length === null || at + length > bytes.length) return null;
		out.push({ id, kind, data: bytes.subarray(at, at + length) });
		at += length;
	}
	return out;
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
