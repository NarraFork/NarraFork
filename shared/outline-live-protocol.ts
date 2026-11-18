/**
 * The outline live session protocol: binary WebSocket frames on `/ws/narrator`.
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
 *   varuint     handle: the client's session on this socket, chosen by the client at join (1–255)
 *   varuint     n: a transaction number (client frames, reject) or the highest transaction of
 *               the recipient the server has processed (batch); 0 when unused
 *   varuint     length of the JSON head in bytes, 0 for none
 *   …           the JSON head (UTF-8)
 *   …           the body: raw bytes to the end of the frame: text entries ({@link LiveTextEntry})
 *
 * TEXT IS PER BLOCK (since protocol version 2)
 * --------------------------------------------
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
 *   - `drop` (S→C; L2): the server dropped the block's document (its text is committed and
 *     nobody changed it for a while, or the session ran short of room). The payload is the
 *     block's plain text and the GENERATION its next document will have. The client forgets its
 *     document of an older generation, takes the plain text, and makes what it typed and the
 *     server had not taken into a new change on top (`live-client.ts` `dropTo`).
 *
 * DOCUMENT GENERATIONS (L2). Every end must hold every item of a document it has, so a document
 * cannot be dropped by one end alone. Each block has a generation (0 at first; set by `drop`,
 * drawn from one counter of the session so it only grows). A document is "the document of block
 * B at generation G", made by each end from the plain text it holds for B at G. `update` and
 * `vector` entries name their generation: the server skips a client's update of an older
 * generation (the client, told of the drop on the same ordered stream, sends that typing again
 * as a change of the new document) and refuses one of a generation it never announced. A
 * resuming client names the generation of every document it holds; for one that is no longer
 * the block's generation the answer is a `drop`. A generation instead of an acknowledged drop:
 * the server keeps no per-participant state per document, and a client that was away needs the
 * comparison anyway.
 *
 * A typing frame is therefore 5 bytes of framing, the block id and the Yjs update, in both
 * directions.
 *
 * A SPACE AND WHAT THE CLIENT SHOWS (since protocol version 4, pageless plan L3)
 * ----------------------------------------------------------------------------
 * A client joins a SPACE (`LiveJoinHead.space`) and names what it shows, its WATCH SET
 * ({@link LiveWatchWire}): whole subtrees (`{ s: blockId }`: the block and every live block under
 * it) and single levels (`{ l: parentId }`: the parent's live children; `{ l: null }`: the
 * space's top-level blocks). It changes the set later with `watch` frames (`add`, `remove`), each
 * answered by `watched`. The server sends the client the structure of what its watch set shows,
 * the text of every block it shows (or showed and still holds as deleted, for undoing a delete),
 * and of every change only what concerns that: a block moved from a place the client shows to one
 * it does not is a delete for it, the other way an insert (with its text). There is no page:
 * structural operations may name the top level as a parent (`p: null`) and move, delete or check
 * top-level blocks.
 *
 * A subtree watch is of its root at its place: when the root is deleted or moved (by anyone),
 * that watch is gone for everyone who has it (`watched.gone`, or `closed` `ended` for a client
 * with nothing else in its set), and the client watches again where it wants to. A level watch
 * ends only when its parent is deleted.
 *
 * Every watch is within budgets: a subtree or a level takes at most
 * {@link OUTLINE_LIVE_LIMITS.maxWatchBlocks} blocks (`too_large` past it), a space's session and
 * one person's share of it are bounded (`space_full`, `user_limit`): a watch that does not fit is
 * refused, never one already shown closed for it, and the client does not retry by itself.
 *
 * Nothing here depends on Yjs: entry payloads are opaque bytes.
 */

/**
 * The protocol's version, named by every join. A client of another version is told its session
 * is `outdated` and nothing is negotiated: the client keeps what it typed for the person (the
 * unsaved-text store), does not join again, and the page says it must be reloaded
 * (`OutlineSurface`). A client older than version 2 does not know the code: it takes it as a
 * session closed for good, keeps the typing the same way and shows that live editing is
 * unavailable.
 *
 * Version 3 (L2): text entries of kinds 3 to 5 (document generations and drops), which a
 * version 2 reader takes for a malformed body and ignores whole.
 *
 * Version 4 (L3): a join names a space and a watch set, not a page (`LiveJoinHead.space`,
 * `watch`); `watch` / `watched` frames; a structure row may name a parent outside its list
 * ({@link LiveBlockWire}); operations may name the top level (`p: null`). A client of version 3
 * or older (it names a `page`) is told `outdated`.
 */
export const OUTLINE_LIVE_PROTOCOL_VERSION = 4;

export const OUTLINE_LIVE_MAGIC = 0xb1;

/**
 * The largest handle (a client's session on one socket). Frames with a larger one do not decode, so
 * nothing past the decoder ever holds a handle a reply could not carry.
 */
export const OUTLINE_LIVE_MAX_HANDLE = 255;

export const LIVE_FRAME = {
	/** C→S: join a space. Head {@link LiveJoinHead}; body: on resume, a `vector` per document. */
	join: 0x01,
	/** C→S: leave. */
	leave: 0x02,
	/** C→S: text only. `n` = transaction number; body = `update` entries. */
	update: 0x03,
	/** C→S: structural transaction. `n`; head {@link LiveTxHead}; body = its `update` entries. */
	tx: 0x04,
	/** C→S: own selection. Head {@link LivePresenceUp}. */
	selection: 0x05,
	/** C→S: change the watch set. Head {@link LiveWatchHead}. */
	watch: 0x06,
	/** S→C: joined. Head {@link LiveJoinedHead}; body = every text (reset) or what is missing. */
	joined: 0x81,
	/** S→C: coalesced changes. `n` = ack; head {@link LiveBatchHead} or none; body = texts. */
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
	/**
	 * S→C: the answer to a `watch` frame (head {@link LiveWatchedHead}; body: the text of what the
	 * added watches show), or, unasked, watches that are gone (`gone` only, no `w`).
	 */
	watched: 0x88,
} as const;

export type LiveFrameKind = (typeof LIVE_FRAME)[keyof typeof LIVE_FRAME];

/** Limits both sides know. The server enforces them; the client stays inside them. */
export const OUTLINE_LIVE_LIMITS = {
	/** Live sessions (joins) one socket may hold. */
	sessionsPerSocket: 8,
	/** Editing participants of one space (pageless plan §一.5: per space, not per page). */
	editorsPerSpace: 50,
	/** Read-only participants of one space. */
	viewersPerSpace: 100,
	/** Distinct watches loaded in live sessions across the process. */
	liveWatches: 2000,
	/**
	 * Blocks one watch takes at most: a subtree with its root, or a level's children. A larger
	 * one is refused (`too_large`) and stays read-only (plan: a level of more than 2,000 children
	 * is read-only in place).
	 */
	maxWatchBlocks: 2000,
	/** UTF-8 bytes of all block content one watch takes at most. */
	maxWatchBytes: 4 * 1024 * 1024,
	/** Entries of one join's watch set, or of one `watch` frame's lists (the wire's bound). */
	maxWatch: 1024,
	/**
	 * Watches one participant holds at most (pageless L4). A `watch` frame is taken up to it;
	 * additions past it are refused `watch_cap` (the rest of the frame stands). Two wide views
	 * of one person (2 × 512) cannot take the process's {@link liveWatches} from other spaces.
	 */
	watchBudget: 512,
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
	 * a resume's operations, a batch with a large outside commit. Bounded by the watch limits.
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
	/** Client-side: watch changes asked for within this long go out as one frame. */
	watchBatchMs: 30,
	/**
	 * Client-side: an addition refused `too_fast` is asked again after this long, doubling each
	 * time up to `watchRetryMaxMs`, at most `watchRetries` times in a row (then it stays refused).
	 */
	watchRetryMs: 250,
	watchRetryMaxMs: 8000,
	watchRetries: 8,
	/** Agents one watch shows in its presence at most; the rest are counted (`am`, P2 PR 10b). */
	agentsPerWatch: 8,
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
 *   - `i`: insert, or restore when the id names a deleted block; `p` parent (`null`: the space's
 *     top level, since version 4), `k` order key; `q` the block is a question put to a person
 *     (`Ask`): set by the server only (a client cannot make a question, and the server ignores
 *     the field from one), added after the first protocol version
 *   - `m`: move under `p` (`null`: to the top level) at `k`
 *   - `d`: delete (with its live subtree); deleting a question withdraws it
 *   - `k`: set the checkbox (`null` removes the task); refused on a question
 * Since version 4 every operation may name a top-level block. A parent named must be one whose
 * every live child the session holds (a level or a subtree someone watches): the top level only
 * while someone watches it (`{ l: null }`).
 */
export type LiveOp =
	| { t: "i"; id: string; p: string | null; k: string; task?: LiveTaskChar | null; q?: true }
	| { t: "m"; id: string; p: string | null; k: string }
	| { t: "d"; id: string }
	| { t: "k"; id: string; task: LiveTaskChar | null };

/**
 * A live block in a structure snapshot, a parent before its children: id, parent, order key,
 * sid, checkbox ("" for none), and `1` for a question put to a person (`Ask`; absent otherwise,
 * added after the first protocol version). The parent is the index of an earlier row of the same
 * list, `-1` for the space's top level, or (since version 4) the id of a parent the list does
 * not carry: the parent of a watched subtree's root, the parent of a watched level.
 */
export type LiveBlockWire = [
	id: string,
	parent: number | string,
	orderKey: string,
	sid: string,
	task: LiveTaskChar | "",
	question?: 1,
];

/**
 * One entry of a watch set (version 4): `s` a block's whole live subtree (the block itself and
 * every live block under it, at most {@link OUTLINE_LIVE_LIMITS.maxWatchBlocks}); `l` one level,
 * a parent's live children (not the parent; `null`: the space's top-level blocks).
 */
export type LiveWatchWire = { s: string } | { l: string | null };

/** A watch entry's key: `s:<id>`, `l:<id>`, `l:` for the top level. */
export function liveWatchKey(w: LiveWatchWire): string {
	return "s" in w ? `s:${w.s}` : `l:${w.l ?? ""}`;
}

/** A watch entry well formed (an id of 1–128 characters, or the top level). */
export function isLiveWatch(value: unknown): value is LiveWatchWire {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const w = value as Record<string, unknown>;
	const id = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 128;
	const keys = Object.keys(w);
	if (keys.length !== 1) return false;
	if ("s" in w) return id(w.s);
	if ("l" in w) return w.l === null || id(w.l);
	return false;
}

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
	/** The space joined (version 4). */
	space: string;
	/**
	 * What the client shows (at least one entry, at most {@link OUTLINE_LIVE_LIMITS.maxWatch}):
	 * the whole set, also on a resume. A join is all or nothing: one entry that cannot be watched
	 * refuses it with that entry's code.
	 */
	watch: LiveWatchWire[];
	/** `edit` asks for write access; a read-only person gets `view`. */
	mode: "edit" | "view";
	/** Identifies this editor instance across reconnects (8–64 characters). */
	key: string;
	/**
	 * The session this client was in before (sent on every join after the first). Without
	 * `reset` the client asks to resume it (the body names the documents it holds); with `reset`
	 * it wants a snapshot. Either way the answer says which of its transactions of that session
	 * the space already has (`tx`, `dur`), so the client neither loses nor repeats them.
	 * `g` (L2): the highest document generation the session told this client of; the answer to a
	 * resume drops every document of a later generation the client may hold.
	 */
	resume?: { epoch: number; op: number; tx: number; reset?: boolean; g?: number };
	/**
	 * This join's number on its handle (L2): the answer (`joined`, or `closed` refusing it) says
	 * it back, so a client with two joins on their way acts on the answer to its last only.
	 */
	j?: number;
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
	/** The join this answers (`LiveJoinHead.j`). */
	j?: number;
	/** The session instance; a resume names it. */
	epoch: number;
	/** `reset`: drop local state and take the snapshot. `resume`: apply the diff and ops. */
	mode: "reset" | "resume";
	/** Whether this participant may edit. */
	w: boolean;
	/** The session's operation sequence number now. */
	op: number;
	/**
	 * The highest transaction of this client's previous session (`resume.epoch`) the space has
	 * applied: the client does not send or replay those again.
	 */
	tx: number;
	/** This participant's number. */
	me: number;
	/**
	 * Structure snapshot (reset, or a resume the operation log no longer covers): what the watch
	 * set shows, each block once.
	 */
	blocks?: LiveBlockWire[];
	/** Structural batches after the client's `op` (resume). */
	ops?: LiveCommitWire[];
	/**
	 * A snapshot (L2): the document generation of every block it lists that no text entry names
	 * a generation for (absent: 0). Blocks of another generation come with a `drop` entry.
	 */
	g?: number;
	/** Text of the client's earlier transactions that was not taken ({@link LiveLostWire}). */
	x?: LiveLostWire[];
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

/**
 * C→S `watch`: change the watch set. `w` numbers the request (the answer says it back); entries
 * to add and to remove (by {@link liveWatchKey}). Requests are answered in order.
 */
export interface LiveWatchHead {
	w: number;
	add?: LiveWatchWire[];
	remove?: LiveWatchWire[];
}

/**
 * S→C `watched`. As the answer to a `watch` (`w`): the entries now watched among those added
 * (`ok`) and those refused with why (`refused`: `too_large`, `user_limit`, `space_full`,
 * `access_denied` for a block that is not there, `unavailable`), the structure the added entries
 * show (`blocks`, as a snapshot lists it, with `g` as in {@link LiveJoinedHead}), and the
 * session's operation number it is as of (`op`); the body carries their text. Removed entries
 * are gone at once, whatever the answer. Unasked (no `w`): watches that ended (`gone`: the
 * subtree's root was deleted or moved, a level's parent deleted).
 */
export interface LiveWatchedHead {
	w?: number;
	op?: number;
	ok?: LiveWatchWire[];
	refused?: Array<[watch: LiveWatchWire, code: LiveCloseCode]>;
	gone?: LiveWatchWire[];
	blocks?: LiveBlockWire[];
	g?: number;
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
	/** Text of this recipient's transactions that was not taken ({@link LiveLostWire}). */
	x?: LiveLostWire[];
}

/**
 * A transaction of the recipient (acknowledged with or before this frame) and the blocks whose
 * text in it the session did not take: they are no longer where the recipient's watch set shows
 * them (moved elsewhere, or gone from the session) and their document is not the one the text
 * was typed in. The client keeps that text for the person (the unsaved-text store). Since L3
 * the frame carrying a notice also carries the whole text of each block it names that the
 * recipient is shown now, after the notice: a copy of it the client merged before the notice
 * arrived is replaced, never left without the session's text.
 */
export type LiveLostWire = [tx: number, blocks: string[]];

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
	/**
	 * The space or a watched block does not exist (or is deleted, or of another space), or the
	 * person may not (or may no longer) read the space.
	 */
	| "access_denied"
	/** The outline is off, or the server is at a limit. */
	| "unavailable"
	/** A watch is larger than a live session takes ({@link OUTLINE_LIVE_LIMITS.maxWatchBlocks}). */
	| "too_large"
	/** The session was closed (shutdown), or everything the client watched is gone: join again. */
	| "ended"
	/** The client speaks another protocol version: the page says to reload; no retry. */
	| "outdated"
	/**
	 * Too much of this space is open in this person's other tabs (watches only they have, past
	 * `OUTLINE_LIVE_BOUNDS.maxUserBlocks` blocks): this join or watch is refused, never another
	 * watch of theirs closed. The page says so and offers a retry; the client does not retry by
	 * itself.
	 */
	| "user_limit"
	/**
	 * The space's session holds as much as it may and everything in it is watched by someone
	 * connected: this join or watch is refused (nobody's watch is closed for it). Retried by the
	 * person only.
	 */
	| "space_full"
	/**
	 * Only in `watched.refused`: the socket sent watch frames with additions faster than the
	 * server takes them (`OUTLINE_LIVE_SOCKET_BOUNDS.watchBurst` / `watchesPerSecond`). Nothing
	 * was read; the client asks again after a while by itself.
	 */
	| "too_fast"
	/**
	 * Only in `watched.refused`: the participant's watch set is full
	 * ({@link OUTLINE_LIVE_LIMITS.watchBudget}); nothing was read. The client asks again once its
	 * set has room (it let other watches go).
	 */
	| "watch_cap";

export interface LiveClosedHead {
	code: LiveCloseCode;
	/** When it refuses a join: that join's number (`LiveJoinHead.j`). */
	j?: number;
}

export type LiveRejectCode =
	/** Another change made this one impossible (a block it names is gone, a cycle, …). */
	| "conflict"
	/** The person may not write the space (any more). */
	| "read_only"
	/** The transaction is malformed or over a limit. */
	| "invalid"
	/** Writing failed on the server; the change was not saved. */
	| "failed"
	/**
	 * A move would bring more blocks into the live session than it takes (what is under a block
	 * moved into a watched subtree: one watch's bound, the space's, the process's, or the
	 * person's share). Nothing was written; the editor says why.
	 */
	| "too_large";

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

/**
 * Kinds of text entries. `drop` (L2): the block's document, if any, is dropped; its text is the
 * plain text in the payload, and a document made for it from now on is of generation `gen`.
 */
export const LIVE_TEXT_KIND = { seed: 0, update: 1, vector: 2, drop: 3 } as const;

export type LiveTextKind = (typeof LIVE_TEXT_KIND)[keyof typeof LIVE_TEXT_KIND];

/** Wire kinds of an `update` and a `vector` of a document of a generation other than 0. */
const WIRE_UPDATE_AT = 4;
const WIRE_VECTOR_AT = 5;

/**
 * One block's text in a frame body (see the module header).
 *
 * `gen` is the generation of the block's document (L2, document eviction): 0 until the server
 * first drops the block's document, then whatever the last `drop` entry said. Every end makes a
 * block's document from the plain text it holds for it at that generation, so documents of one
 * generation are the same document; an entry of another generation never touches it. A `drop`
 * always carries its generation; `update` and `vector` carry it when it is not 0 (on the wire
 * as kinds 4 and 5, the generation before the payload); a `seed` is of generation 0.
 */
export interface LiveTextEntry {
	id: string;
	kind: LiveTextKind;
	/** See the interface comment; absent means 0. */
	gen?: number;
	data: Uint8Array;
}

/** Reads text exactly as written: malformed UTF-8 is an error, a leading U+FEFF is text. */
const exactDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A `seed` entry's payload: the block's text as UTF-8. */
export function encodeLiveSeed(text: string): Uint8Array {
	return encoder.encode(text);
}

/**
 * The text of a `seed` entry, exactly as the other end holds it (a document made from a text
 * that differs by one character, a dropped byte order mark say, is another document). Null when
 * it is not UTF-8.
 */
export function decodeLiveSeed(data: Uint8Array): string | null {
	try {
		return exactDecoder.decode(data);
	} catch {
		return null;
	}
}

/**
 * Encode text entries as a frame body:
 *   varuint  bytes of the block id      …  the id (UTF-8)
 *   byte     kind (0 seed, 1 update, 2 vector, 3 drop, 4 update of a generation, 5 vector of one)
 *   varuint  bytes of the payload       …  the payload; kinds 3, 4 and 5 start it with the
 *                                          generation as a varuint
 * repeated to the end of the body.
 */
export function encodeLiveTexts(entries: readonly LiveTextEntry[]): Uint8Array {
	if (entries.length === 0) return EMPTY;
	const ids = entries.map((e) => encoder.encode(e.id));
	/** The wire kind, and the generation when the wire carries it (-1: it does not). */
	const wire = (e: LiveTextEntry): [number, number] => {
		const gen = e.gen ?? 0;
		if (e.kind === LIVE_TEXT_KIND.drop) return [LIVE_TEXT_KIND.drop, gen];
		if (gen === 0) return [e.kind, -1];
		if (e.kind === LIVE_TEXT_KIND.update) return [WIRE_UPDATE_AT, gen];
		if (e.kind === LIVE_TEXT_KIND.vector) return [WIRE_VECTOR_AT, gen];
		// A plain text of a later generation is what a drop says.
		return [LIVE_TEXT_KIND.drop, gen];
	};
	let size = 0;
	entries.forEach((e, i) => {
		const id = ids[i] as Uint8Array;
		const [, gen] = wire(e);
		const payload = (gen < 0 ? 0 : varuintSize(gen)) + e.data.length;
		size += varuintSize(id.length) + id.length + 1 + varuintSize(payload) + payload;
	});
	const out = new Uint8Array(size);
	let at = 0;
	entries.forEach((e, i) => {
		const id = ids[i] as Uint8Array;
		const [kind, gen] = wire(e);
		at = writeVaruint(out, at, id.length);
		out.set(id, at);
		at += id.length;
		out[at++] = kind;
		at = writeVaruint(out, at, (gen < 0 ? 0 : varuintSize(gen)) + e.data.length);
		if (gen >= 0) at = writeVaruint(out, at, gen);
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
			id = exactDecoder.decode(bytes.subarray(at, at + idLength));
		} catch {
			return null;
		}
		at += idLength;
		const kind = bytes[at++] as number;
		if (!Number.isInteger(kind) || kind < 0 || kind > WIRE_VECTOR_AT) return null;
		const length = read();
		if (length === null || at + length > bytes.length) return null;
		const end = at + length;
		if (kind <= LIVE_TEXT_KIND.vector) {
			out.push({ id, kind: kind as LiveTextKind, data: bytes.subarray(at, end) });
		} else {
			const gen = read();
			if (gen === null || at > end || gen > 0x7fffffff) return null;
			// Generation 0 is written without one: a second spelling of an entry is refused.
			if (gen === 0 && kind !== LIVE_TEXT_KIND.drop) return null;
			out.push({
				id,
				kind:
					kind === WIRE_UPDATE_AT
						? LIVE_TEXT_KIND.update
						: kind === WIRE_VECTOR_AT
							? LIVE_TEXT_KIND.vector
							: LIVE_TEXT_KIND.drop,
				gen,
				data: bytes.subarray(at, end),
			});
		}
		at = end;
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
