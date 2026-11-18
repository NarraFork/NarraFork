/**
 * One space's live editing session (design §6.2–§6.6, plan §8, D33; one per space since the
 * pageless plan's L2, joined by space with watch sets since L3).
 *
 * WHAT IT HOLDS
 * -------------
 *   - a mirror of the part of the space people show (`mirror.ts`): blocks by parent; what a
 *     participant shows is its WATCH SET (`shared/outline-live-protocol.ts`): whole subtrees and
 *     single levels, each a {@link LiveView} shared by everyone who watches it, loaded on its
 *     first watcher and unloaded when nobody has watched it for a while, so the session's size
 *     follows what is shown ({@link OUTLINE_LIVE_BOUNDS.maxLoadedBlocks}); equal to the blocks
 *     table between tasks;
 *   - the text of every loaded block: a plain string (what the database holds) until someone
 *     changes it, then a Yjs document of that block alone (`shared/outline-live-text.ts`: made
 *     from the plain text the same way on every end, so nothing races its creation). A document
 *     belongs to its block wherever the block is moved. It is kept, also when the change that
 *     made it was refused (every end must hold every item of a document it has), until every
 *     end drops it together (`sweepDocs`: generations);
 *   - the participants, each with its watch set: a participant is sent what its watches show
 *     and nothing else. One lane, one sequence of structural batches, one log per space.
 *     Participants with the same watch set share an {@link Audience}: structure is routed (and
 *     kept for resuming clients) per audience.
 *
 * HOW CHANGES FLOW
 * ----------------
 *   - Text: a participant's updates (one per block it changed) are applied at once and
 *     broadcast to the others holding the block's text (`MirrorBlock.held`: its watches) within
 *     {@link OUTLINE_LIVE_TIMING.broadcastMs},
 *     merged per block with everything else of that window (`Y.mergeUpdates`), never echoed to
 *     their sender (who gets the transaction number back instead). Changed blocks are committed
 *     as the editor's own human commits a little later (after
 *     {@link OUTLINE_LIVE_TIMING.flushIdleMs} of quiet, at most
 *     {@link OUTLINE_LIVE_TIMING.flushMaxMs} after the first change), normalized off the main
 *     thread when large (`normalize.ts`).
 *   - Structure: a structural transaction (insert, move, delete, checkbox, plus the text
 *     updates of the same keystroke) is checked against the mirror, written as one commit
 *     through `writeOutline`, then broadcast in canonical form. Its blocks and parents may be
 *     anywhere loaded in the space, the top level included (`p: null` while someone watches it):
 *     there is no page. Each audience is sent what the batch changed in what it shows (`route`:
 *     before and after, block by block): a block moved out of what it shows is a delete for it,
 *     one moved in an insert (with its text). A refused transaction is rolled back (its text part by
 *     undoing it in each block's document) and every later frame of that participant is dropped
 *     until it joins again; the client rebuilds its documents and replays its own later changes.
 *   - Writes from outside (agents, reverts) reach the session through the barrier
 *     (`live-barrier.ts`): unflushed text is committed first, then the outside commit is read
 *     back (its block versions, by commit; skipped when its changed parents and blocks
 *     (`changes`) touch nothing loaded) and pushed in as a remote change, merged into the live
 *     text, routed like a participant's batch. A block a commit moves between two loaded places
 *     keeps its document.
 *   - Every text update is also appended to `outline_live_log` within
 *     {@link OUTLINE_LIVE_TIMING.persistMs} (a snapshot of every document first, increments
 *     after, each block's seed text before its first update, a dropped document's drop before
 *     anything later of its block, compacted once the increments outweigh a snapshot; the row
 *     format is {@link encodeLogTexts}). A participant's transactions are acknowledged only once
 *     the log (or the space) has them: after a crash, what was acknowledged is replayed from the
 *     log (a startup job, or the next join), and what was not is still held by its client, which
 *     replays it into the next session. Every join after a client's first names the session it
 *     was in, and the answer says which of its transactions the space applied (`tx`) and which
 *     of those are safe in the log or committed (`dur`): the client forgets the latter, keeps
 *     the rest of what was applied unsent until acknowledged, and replays only what the space
 *     does not have, so nothing is applied twice (also across a refusal, a restart or days
 *     offline: an ended session's positions stay in the log, `registry.ts`). Before the session
 *     commits text it logs what it is about to write (an intent), so a crash between the commit
 *     and the next append does not merge committed text with itself.
 *   - Failures: a commit that fails part way keeps what was written (the session takes it as
 *     the space now is); text that cannot be normalized or written is committed as code blocks,
 *     and given up on (kept live and in the log) when even that fails a few times; a log that
 *     cannot be committed is taken over by the next session of the space. A frame that cannot
 *     be encoded drops only its recipient.
 *
 * BOUNDS
 * ------
 * Loaded blocks and their content per space ({@link OUTLINE_LIVE_BOUNDS}; watches nobody has go
 * first, then the join or watch is refused), one person's share of a space, loaded blocks across
 * the process (`registry.ts`), documents
 * (dropped when idle or when there are many; a hard bound as the last resort), a participant's
 * queued frames and buffered bytes. Loading a watch is a few bounded reads (a subtree level by
 * level, at most {@link OUTLINE_LIVE_LIMITS.maxWatchBlocks} blocks), unloading one is in
 * memory, both {@link OUTLINE_LIVE_BOUNDS.loadStep} blocks at a time, yielding in between.
 *
 * Every method that touches the documents or the database runs in the space's lane.
 */
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { compareOrderKeys, keyBetween, merge3 } from "@shared/outline";
import type { OutlineCommitChanges } from "@shared/outline-block-events";
import {
	cancelLiveTimer,
	type LiveTimer,
	liveNow,
	liveSleep,
	liveTimeout,
	liveYield,
} from "@shared/outline-live-clock";
import {
	decodeLiveTexts,
	encodeLiveFrame,
	encodeLiveHead,
	encodeLiveSeed,
	encodeLiveTexts,
	isLiveTaskChar,
	isLiveWatch,
	LIVE_FRAME,
	LIVE_STATUS_OF_TASK,
	LIVE_TEXT_KIND,
	type LiveActor,
	type LiveBatchHead,
	type LiveBlockWire,
	type LiveClaimedWire,
	type LiveCloseCode,
	type LiveCommitWire,
	type LiveJoinedHead,
	type LiveJoinHead,
	type LiveLostWire,
	type LiveOp,
	type LivePeerWire,
	type LivePresenceDown,
	type LiveRejectCode,
	type LiveRejectHead,
	type LiveSelWire,
	type LiveTaskChar,
	type LiveTextEntry,
	type LiveWatchedHead,
	type LiveWatchHead,
	type LiveWatchWire,
	livePeerColor,
	liveWatchKey,
	OUTLINE_LIVE_AGENT_PNO_BASE,
	OUTLINE_LIVE_LIMITS,
} from "@shared/outline-live-protocol";
import {
	dropPendingStructs,
	hasPendingStructs,
	type LiveTextDoc,
	mergeTextUpdates,
	seededTextDoc,
} from "@shared/outline-live-text";
import * as Y from "yjs";
import { canManageSpace } from "../access";
import { readDisplayNames } from "../access-reads";
import { OutlineEditTextError } from "../edit-text-runner";
import {
	OutlineBusyError,
	OutlineConflictError,
	OutlineTaskClaimedError,
	OutlineWriteError,
} from "../errors";
import { OUTLINE_CHANGE, OUTLINE_LIMITS, type OutlineTaskJson } from "../model";
import { outlineStore } from "../store";
import type { OutlineBlockRow, OutlineLiveLogRow, OutlineVersionRow } from "../store/port";
import {
	type OutlineCanonicalContent,
	type OutlineOp,
	type OutlineWriteResult,
	writeOutline,
} from "../write";
import {
	type LiveAgentWrite,
	OUTLINE_LIVE_AGENT_BOUNDS,
	readLiveAgentReaders,
	readLiveAgents,
} from "./agent-presence";
import { asOwnLiveWrite } from "./lane";
import {
	HELD_BY_NOBODY,
	type HeldBy,
	type MirrorBlock,
	parentKeyOf,
	SpaceMirror,
	taskCharOf,
} from "./mirror";
import { type LiveNormalized, normalizeLiveTexts } from "./normalize";
import type { RecoveredChange } from "./replay";

/** Timings of a session. Mutable only so tests can shorten them. */
export const OUTLINE_LIVE_TIMING: Record<
	| "broadcastMs"
	| "presenceMs"
	| "persistMs"
	| "flushIdleMs"
	| "flushMaxMs"
	| "idleCloseMs"
	| "flushRetryMs"
	| "narrowBudgetMs"
	| "agentsMs"
	| "sweepMs"
	| "docIdleMs",
	number
> = {
	/** Changes are coalesced and broadcast this often (design §7.2). */
	broadcastMs: 50,
	/** Cursors are coalesced (last one wins) and broadcast this often. */
	presenceMs: 100,
	/** Yjs updates reach `outline_live_log` at most this long after they arrive. */
	persistMs: 500,
	/** Changed text is committed after this much quiet… */
	flushIdleMs: 2_000,
	/** …and at most this long after the first change. */
	flushMaxMs: 10_000,
	/** A session nobody is in closes after this long (design §6.3, §7.2). */
	idleCloseMs: 60_000,
	/** Retry delay after a failed commit of live text. */
	flushRetryMs: 5_000,
	/** Time one flush may spend narrowing a permanent failure down block by block. */
	narrowBudgetMs: 15_000,
	/** The agents of a page are worked out again at most this often (P2 PR 10b). */
	agentsMs: 1_000,
	/** Documents nobody needs any more are looked for this often (`LiveSpace.sweepDocs`). */
	sweepMs: 30_000,
	/**
	 * A block's document is dropped once its text is committed and nothing changed it for this
	 * long (every end drops it together; the block's text undo history goes with it).
	 */
	docIdleMs: 5 * 60_000,
};

/** Bounds of a session. Mutable only so tests can shrink them. */
export const OUTLINE_LIVE_BOUNDS = {
	/**
	 * Bytes of updates a session's documents may take in (from its open, the page's text
	 * included) before the session is restarted with fresh ones: Yjs keeps deleted items, and a
	 * writer could otherwise grow them without bound. Participants rejoin at once.
	 */
	maxDocBytes: 16 * 1024 * 1024,
	/**
	 * What one text document is charged against {@link maxDocBytes} when it is made, whatever
	 * its text: a document of a block costs about 4.1 KB of heap here (measured: 2,000 documents
	 * with their handlers, 1 to 43 characters each), and a client holds one more with an undo
	 * manager (about 2.9 KB more). So a session holds at most `maxDocBytes / docCostBytes`
	 * documents (4,096), deleted blocks' included, before it starts afresh.
	 */
	docCostBytes: 4096,
	/**
	 * Documents a session holds before it drops the least recently changed committed ones without
	 * waiting for {@link OUTLINE_LIVE_TIMING.docIdleMs}. Well under the hard bound above, which
	 * is the last resort (reached only when that many documents are all uncommitted or parked).
	 */
	softDocs: 2048,
	/** Documents one sweep drops at most (one lane task; the rest wait for the next). */
	evictPerSweep: 256,
	/**
	 * Blocks (deleted ones it remembers included) and UTF-16 units of content one space's session
	 * holds in its mirror at most. A join or watch that would pass them first unloads the watches
	 * nobody has, and is refused (`space_full`) when that is not enough.
	 */
	maxLoadedBlocks: 20_000,
	maxLoadedChars: 32 * 1024 * 1024,
	/** Blocks whose leaving the session is remembered ({@link LiveSpace} `recentlyGone`). */
	goneBlocks: 5000,
	/**
	 * Blocks one person's watches may hold in a space's mirror, so one person with many tabs
	 * cannot take the whole of {@link maxLoadedBlocks}. Past it, a join or watch that would load
	 * another watch is refused (`user_limit`); no open watch of theirs is closed for it. Its
	 * limits: it is per account (the same person on two devices counts once, two people on one
	 * account too); it counts the blocks of the watches only that person has (a watch someone
	 * else has too is nobody's share; overlapping watches are counted each, so it errs on the
	 * safe side), watches already loaded cost nothing to take, and a person's first watch is
	 * never refused by it (the space's own bound still applies).
	 */
	maxUserBlocks: 8000,
	/**
	 * Watches past a person's budget (`OUTLINE_LIVE_LIMITS.watchBudget`) their joins may still
	 * hold (each keeps its root: `JOIN_KEEPS`). Past budget + slack a join is refused
	 * `watch_cap` outright.
	 */
	watchSlack: 64,
	/** Live participants (joins) one person may hold in the process; past it, `user_limit`. */
	participantsPerUser: 32,
	/** Blocks put into or taken out of the mirror between two yields to the event loop. */
	loadStep: 500,
	/** Failed commits of a block as code after which it is no longer retried (until edited). */
	maxCommitFailures: 3,
	/** A socket buffering more than this gets no more frames until it drains and rejoins. */
	lagBytes: 1024 * 1024,
	/** …and is told to rejoin once it is below this. */
	resumeBytes: 256 * 1024,
	/** Presence frames are skipped (kept for later) while a socket buffers more than this. */
	presenceDropBytes: 64 * 1024,
	/** Log rows or bytes of one epoch after which it is compacted into one snapshot row. */
	compactRows: 400,
	compactBytes: 1024 * 1024,
	/** Structural batches kept for resuming clients (each audience's share counts once). */
	opLog: 256,
	/**
	 * Audiences (distinct watch sets) a session keeps; past it the least recently used one nobody
	 * is in goes (a client resuming it gets a snapshot).
	 */
	audiences: 256,
	/**
	 * Client keys whose last processed transaction is remembered. Only keys with no participant
	 * whose transactions were all acknowledged to their client are dropped to keep to this (a
	 * client coming back without its key would replay what the space has). Kept keys are the
	 * participants (at most `editorsPerSpace` + `viewersPerSpace`) and clients that left before
	 * their last acknowledgement, which can pile up on a busy space: past `clientKeysHard` the
	 * oldest of those goes anyway.
	 */
	clientKeys: 128,
	clientKeysHard: 1024,
	/** Blocks one block selection may name in presence. */
	presenceBlocks: 200,
	/**
	 * Notices of text not taken kept per client key until its client shows it got them (a
	 * join). Past it the oldest go, with a warning.
	 */
	lostPerKey: 1024,
	/**
	 * Watch notices one participant may have waiting (`Participant.notices`: they wait while its
	 * own changes are not acknowledged, e.g. the log is not taking writes). Past it the
	 * participant rejoins and gets everything (the join names its whole set).
	 */
	notices: 64,
};

const SERVER_ORIGIN = { live: "server" } as const;
/** `actor_id` of the session's own log rows (snapshots, merges from outside). */
export const LIVE_LOG_ACTOR = "outline-live";
/** `actor_id` of sync rows: JSON `{ b: { blockId: content } }`, not a Yjs update. */
export const LIVE_SYNC_ACTOR = "outline-live-sync";
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const utf8 = new TextEncoder();

/** What a session needs of a socket. The WebSocket adapter provides it. */
export interface LiveSocket {
	/** Set once the socket closed. */
	readonly closed?: boolean;
	readonly userId: string;
	readonly isAdmin: boolean;
	readonly name: string;
	readonly color: string;
	/** `false` when the frame could not be queued (the socket is gone). */
	send(frame: Uint8Array): boolean;
	bufferedAmount(): number;
}

export class Participant {
	/** Highest transaction processed. */
	lastTx = 0;
	/** Highest transaction whose changes are in the log (or committed): acknowledged up to here. */
	durableTx = 0;
	/** Highest transaction acknowledged to the client. */
	ackedTx = 0;
	/** Bytes of this participant's frames waiting in the lane (see the registry's budget). */
	queuedBytes = 0;
	/** The last selection frame, checked when presence is next sent (last one wins). */
	rawSel: unknown = undefined;
	/**
	 * Others' structural changes ordered after one of this participant's own that is not
	 * acknowledged yet: held so the client applies them in order.
	 */
	heldCommits: LiveCommitWire[] = [];
	/**
	 * `watched` frames without structure of their own (an end, the answer to a removal or to a
	 * refused addition), each as of an operation number: sent once everything cut for this
	 * participant up to it went out (`LiveSpace.notify`), so its client never drops blocks that
	 * a change on its way still names.
	 */
	notices: Array<{ o: number; head: LiveWatchedHead }> = [];
	/** Set after a refusal: frames are dropped until the client joins again. */
	blocked = false;
	/** Frames were held back because the socket fell behind; it is told to rejoin when it drains. */
	lagging = false;
	/** The rejoin request went out; nothing more is sent until it joins again. */
	resyncSent = false;
	sel: LiveSelWire | null = null;
	/** Where this participant's share of the current broadcast window starts. */
	windowStart = 0;
	commitStart = 0;

	constructor(
		readonly pno: number,
		readonly socket: LiveSocket,
		readonly handle: number,
		readonly key: string,
		readonly wantsEdit: boolean,
		public canWrite: boolean,
		/** Its watch set: what it is shown (each entry once). */
		public views: LiveView[],
		/** Everyone with the same watch set: what structure is routed by. */
		public audience: Audience,
	) {}

	/** Whether one of its watches holds a block's text (`MirrorBlock.held`). */
	holds(held: readonly HeldBy[]): boolean {
		for (const h of held) if (this.views.includes(h as LiveView)) return true;
		return false;
	}

	get userId(): string {
		return this.socket.userId;
	}

	peer(): LivePeerWire {
		return [this.pno, this.userId, this.socket.name, this.socket.color, this.canWrite ? "e" : "v"];
	}
}

/**
 * Participants with the same watch set (in any order): a structural batch is cut once per
 * audience (`LiveSpace.route`), and what each audience was sent is kept for resuming clients
 * (`opLog`). An audience lasts while every watch of it is loaded, also with nobody in it (a client
 * coming back resumes it), up to {@link OUTLINE_LIVE_BOUNDS.audiences}.
 */
export interface Audience {
	readonly key: string;
	readonly views: readonly LiveView[];
	/** The session's operation number when it was made: older resumes get a snapshot. */
	readonly madeAtOp: number;
	/** When a participant last took it (the least recently used goes first). */
	usedAt: number;
}

/**
 * An agent in a watch's presence (outline P2 PR 10b, `agent-presence.ts`): sent by the server,
 * never a participant (no socket, not counted against the space's limits).
 */
interface AgentPeer {
	pno: number;
	narratorId: string;
	title: string;
	/** For a subagent: its session's title. */
	session: string | null;
	color: string;
	sel: LiveSelWire;
}

/**
 * One block's text change of the broadcast window: who made it (0: not a participant). Who gets
 * it is decided when the window goes out: everyone (but its maker) then holding the block's text.
 */
interface WindowUpdate extends LiveTextEntry {
	from: number;
	/** Only for the watchers of this watch (a block's text sent whole to a watch, `tell`). */
	only?: LiveView;
}

/**
 * What a structural batch did to one block, before it is cut to each audience (`route`): which
 * watches showed the block before the batch and show it after, and what changed of it.
 */
interface BlockChange {
	id: string;
	before: readonly LiveView[];
	after: readonly LiveView[];
	/** Its parent or order key changed. */
	moved: boolean;
	/** Its checkbox changed. */
	task: boolean;
}

/** One audience's share of a structural batch. */
interface ScopedCommit {
	audience: string;
	wire: LiveCommitWire;
}

/** One block's text change waiting for the log. */
interface PendingRow extends LiveTextEntry {
	actorKind: "human" | "system";
	actorId: string;
}

export interface CommittedEvent {
	spaceId: string;
	commitId: string;
	seq: number;
	/**
	 * What the commit changed, by parent and block (H2); absent or `truncated`: unknown, read
	 * the commit whatever it touched.
	 */
	changes?: OutlineCommitChanges;
	actorKind: "human" | "agent" | "system";
	actorId: string;
	/** The session the commit was written for (agent presence, `agent-presence.ts`). */
	narratorId?: string | null;
}

type Refusal = { refused: LiveCloseCode; read?: number };

/**
 * The watches one join or `watch` frame takes, as it goes: whose they are (their share counts
 * them before anyone is in them), and the rows its reads may still take (a frame of many
 * refused watches reads at most this many in all).
 */
interface WatchTaking {
	userId: string;
	views: LiveView[];
	rowsLeft: number;
	/**
	 * Refusal when this join's or frame's reads are spent (not the person's share): a `watch`
	 * frame says `too_fast` (the client asks again in a later frame); a join `user_limit`.
	 */
	spentCode?: LiveCloseCode;
}

/**
 * A person's watch budget across the process (`OUTLINE_LIVE_LIMITS.watchBudget`): what they hold
 * and what loads under way have reserved, by every participant of theirs but the one of client
 * key `exceptKey` (a client joining again replaces its earlier participant).
 */
export interface LivePeople {
	watches(userId: string, exceptKey?: string): number;
	participants(userId: string, exceptKey?: string): number;
	/** Hold `n` of the person's budget while a join or frame loads; returns the release. */
	reserve(userId: string, n: number): () => void;
}

/** {@link LivePeople} over some participants (one session alone, or the registry's all). */
export function localPeople(all: () => Iterable<Participant>): LivePeople {
	const reserved = new Map<string, number>();
	return {
		watches(userId, exceptKey) {
			let n = reserved.get(userId) ?? 0;
			for (const q of all()) if (q.userId === userId && q.key !== exceptKey) n += q.views.length;
			return n;
		},
		participants(userId, exceptKey) {
			let n = 0;
			for (const q of all()) if (q.userId === userId && q.key !== exceptKey) n++;
			return n;
		},
		reserve(userId, n) {
			reserved.set(userId, (reserved.get(userId) ?? 0) + n);
			let done = false;
			return () => {
				if (done) return;
				done = true;
				const left = (reserved.get(userId) ?? 0) - n;
				if (left > 0) reserved.set(userId, left);
				else reserved.delete(userId);
			};
		},
	};
}

/**
 * Entries a join keeps whatever the person's watch budget says: its root (the client names it
 * first). Past the budget, a join holds at most this many.
 */
const JOIN_KEEPS = 4;

/** Rows one join or `watch` frame may read in all: one share and one more watch. */
function frameReads(): number {
	return OUTLINE_LIVE_BOUNDS.maxUserBlocks + OUTLINE_LIVE_LIMITS.maxWatchBlocks;
}

function bytesOf(text: string): number {
	return utf8.encode(text).length;
}

function sameOps(a: readonly LiveOp[], b: readonly LiveOp[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Random positive int31: a session instance a resuming client must name. */
function newEpoch(): number {
	const a = new Uint32Array(1);
	crypto.getRandomValues(a);
	return ((a[0] as number) % 0x7ffffffe) + 1;
}

/**
 * One watch of a space's session ({@link LiveWatchWire}): a block's whole live subtree, or one
 * level (a parent's live children, the top level included). It is loaded in the session's mirror
 * on its first watcher and holds who watches it (participants with it in their watch set), their
 * presence, and the agents working in what it shows. Participants with overlapping watches share
 * the blocks; a block's text is held by watches (`MirrorBlock.held`).
 *
 * Tests and diagnostics reach a subtree's watch through it (`liveSessionOf(rootId)`).
 */
export class LiveView implements HeldBy {
	readonly participants = new Map<number, Participant>();
	/** The session's operation number when it was loaded: older resumes get a snapshot. */
	loadedAtOp = 0;
	/** Set once it is being taken out of the session. */
	gone = false;
	/**
	 * The generation the blocks it loaded were given: a snapshot names it once
	 * (`LiveJoinedHead.g`) and sends a generation only with the blocks that have another.
	 */
	baseGen = 0;
	/** Blocks it showed when it was loaded (diagnostics; the share counts `shownCount`). */
	blocks = 0;
	/** When someone last joined it (a person's least recently joined watch goes first). */
	joinedAt = 0;
	readonly key: string;

	constructor(
		readonly space: LiveSpace,
		readonly watch: LiveWatchWire,
	) {
		this.key = liveWatchKey(watch);
	}

	/** A subtree (`s`) or a level (`l`). */
	get kind(): "s" | "l" {
		return "s" in this.watch ? "s" : "l";
	}

	/** The subtree's root, or the level's parent (`null`: the top level). */
	get parentOrRoot(): string | null {
		return "s" in this.watch ? this.watch.s : this.watch.l;
	}

	/** The subtree's root, or the level's parent ("" for the top level). */
	get rootId(): string {
		return this.parentOrRoot ?? "";
	}

	/** Live blocks it shows, parents first (a subtree's root first; a level in sibling order). */
	shownIds(): string[] {
		const m = this.space.mirror;
		if ("s" in this.watch) return m.alive(this.watch.s) ? m.subtree(this.watch.s) : [];
		return [...m.children(this.watch.l)];
	}

	/**
	 * How many live blocks it shows now (a person's share counts this: blocks moved in or out,
	 * inserted, deleted or restored since it loaded count as they are).
	 */
	shownCount(): number {
		const m = this.space.mirror;
		if ("s" in this.watch) return m.alive(this.watch.s) ? m.subtreeSize(this.watch.s) : 0;
		return m.children(this.watch.l).length;
	}

	/** Every block it covers, deleted ones included (what unloading it may take out). */
	coveredIds(): string[] {
		const m = this.space.mirror;
		if ("s" in this.watch) return m.get(this.watch.s) ? m.subtreeAll(this.watch.s) : [];
		const kids = m.childrenAll(this.watch.l);
		return this.watch.l !== null && m.get(this.watch.l) ? [this.watch.l, ...kids] : kids;
	}

	get spaceId(): string {
		return this.space.spaceId;
	}

	get epoch(): number {
		return this.space.epoch;
	}

	get closed(): boolean {
		return this.space.closed || this.gone;
	}

	get stats(): LiveSpace["stats"] {
		return this.space.stats;
	}

	get mirror(): SpaceMirror {
		return this.space.mirror;
	}

	textOf(id: string): string {
		return this.space.textOf(id);
	}

	textState(id: string): { state: Uint8Array; stuck: boolean } | null {
		return this.space.textState(id);
	}

	/** Documents of the blocks whose text this watch holds (deleted ones included). */
	get textDocIds(): string[] {
		return this.space.textDocIdsOf(this);
	}

	get textDocs(): number {
		return this.textDocIds.length;
	}

	/** Whether any text of what this watch covers is waiting to be committed. */
	get hasUnflushed(): boolean {
		return this.space.hasUnflushedIn(this);
	}

	flushContent(): Promise<boolean> {
		return this.space.flushContent();
	}

	persistNow(): Promise<boolean> {
		return this.space.persistNow();
	}

	/** A text frame of one of its participants (tests drive the session directly). */
	handleUpdate(p: Participant, n: number, body: Uint8Array): void {
		this.space.handleUpdate(p, n, body);
	}

	handleTx(p: Participant, n: number, rawHead: unknown, body: Uint8Array): Promise<void> {
		return this.space.handleTx(p, n, rawHead, body);
	}

	/** The session's record of client keys (tests look at its bound). */
	get keys(): ReadonlyMap<string, number> {
		return this.space.clientKeys;
	}

	/** Stop every timer of the watch (it left the session, or the session ended). */
	stop(): void {
		this.gone = true;
		for (const timer of [this.presenceTimer, this.idleTimer, this.agentTimer, this.agentExpiry])
			if (timer) cancelLiveTimer(timer);
		this.presenceTimer = null;
		this.idleTimer = null;
		this.agentTimer = null;
		this.agentExpiry = null;
	}

	// Presence.
	readonly presencePeers = new Set<number>();
	readonly presenceGone = new Set<number>();
	readonly presenceCursors = new Set<number>();
	/** Recipients that skipped presence under backpressure and need the full picture. */
	readonly presenceBehind = new Set<number>();
	presenceTimer: LiveTimer | null = null;

	// Agents (outline P2 PR 10b): sessions running with a cursor in what this watch shows.
	/** By narrator id, in the order shown. */
	readonly agents = new Map<string, AgentPeer>();
	/** Agents present beyond those shown. */
	agentsMore = 0;
	/** An agent keeps its participant number for the session's life. */
	readonly agentPnos = new Map<string, number>();
	/** Agents' numbers count up from the base and are never given twice in a session. */
	nextAgentPno = OUTLINE_LIVE_AGENT_PNO_BASE;
	readonly agentPeersChanged = new Set<number>();
	readonly agentGone = new Set<number>();
	readonly agentCursors = new Set<number>();
	agentsMoreChanged = false;
	/** Blocks of this watch agents wrote lately, by narrator. */
	readonly agentWrites = new Map<string, LiveAgentWrite>();
	/** Who may read which agent's session: user id → narrator id → verdict. */
	readonly agentReaders = new Map<string, Map<string, boolean>>();
	agentReadersStale = false;
	/** Narrators whose run starting or ending may change this watch's agents. */
	agentInterest: ReadonlySet<string> = new Set();
	agentTimer: LiveTimer | null = null;
	agentExpiry: LiveTimer | null = null;
	agentRunning = false;
	agentDirty = false;
	agentLastAt = 0;

	idleTimer: LiveTimer | null = null;

	get editors(): number {
		let n = 0;
		for (const p of this.participants.values()) if (p.canWrite) n++;
		return n;
	}

	get viewers(): number {
		return this.participants.size - this.editors;
	}

	cancelIdle(): void {
		if (this.idleTimer) {
			cancelLiveTimer(this.idleTimer);
			this.idleTimer = null;
		}
	}

	/** When the last participant left (the least recently left watch is unloaded first). */
	idleSince = 0;

	armIdle(): void {
		this.cancelIdle();
		this.idleSince = liveNow();
		this.idleTimer = liveTimeout(() => {
			this.idleTimer = null;
			if (this.participants.size === 0 && !this.space.closed) this.space.viewIdle(this);
		}, OUTLINE_LIVE_TIMING.idleCloseMs);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Presence (ephemeral: never persisted, coalesced last-wins, dropped first)
	// ─────────────────────────────────────────────────────────────────────────

	/** A selection frame: kept as sent, checked when presence goes out (last one wins). */
	setSelection(p: Participant, sel: unknown): void {
		if (this.participants.get(p.pno) !== p) return;
		p.rawSel = sel;
		this.presenceCursors.add(p.pno);
		this.schedulePresence();
	}

	schedulePresence(): void {
		if (this.presenceTimer || this.space.closed) return;
		this.presenceTimer = liveTimeout(() => {
			this.presenceTimer = null;
			this.flushPresence();
		}, OUTLINE_LIVE_TIMING.presenceMs);
	}

	/**
	 * Send who changed and moved. Two heads at most are serialized per round, whatever the number
	 * of recipients (a client ignores its own entries): the changes, and the whole picture for
	 * recipients that skipped earlier rounds. Recipients that cannot take presence now are not
	 * encoded for; they get the whole picture when their socket drains, and one that fell behind
	 * gets it with its rejoin.
	 */
	flushPresence(): void {
		const cursors: Participant[] = [];
		for (const n of this.presenceCursors) {
			const p = this.participants.get(n);
			if (!p) continue;
			if (p.rawSel !== undefined) {
				p.sel = this.validSelection(p.rawSel);
				p.rawSel = undefined;
			}
			cursors.push(p);
		}
		const peers = [...this.presencePeers]
			.map((n) => this.participants.get(n))
			.filter((p): p is Participant => !!p);
		const gone = [...this.presenceGone];
		this.presencePeers.clear();
		this.presenceGone.clear();
		this.presenceCursors.clear();
		// Agents (P2 PR 10b): who changed, left or moved, and the count past the limit.
		const shown = [...this.agents.values()];
		const byPno = new Map(shown.map((a) => [a.pno, a]));
		const agentPeers = [...this.agentPeersChanged].flatMap((n) => byPno.get(n) ?? []);
		const agentGone = [...this.agentGone];
		const agentCur = [...this.agentCursors].flatMap((n) => byPno.get(n) ?? []);
		const moreChanged = this.agentsMoreChanged;
		this.agentPeersChanged.clear();
		this.agentGone.clear();
		this.agentCursors.clear();
		this.agentsMoreChanged = false;
		// Heads differ only in which agents a recipient may name: one head per (kind, verdicts).
		const heads = new Map<string, Uint8Array | null>();
		const headFor = (r: Participant, full: boolean): Uint8Array | null => {
			const verdicts = shown.map((a) => (this.mayName(r.userId, a) ? "1" : "0")).join("");
			const key = `${full ? "f" : "d"}${verdicts}`;
			if (heads.has(key)) return heads.get(key) ?? null;
			const head: LivePresenceDown = {};
			if (full) {
				const all = [...this.participants.values()];
				head.peers = [
					...all.map((p) => p.peer()),
					...shown.map((a) => this.agentWire(a, r.userId)),
				];
				const cur: Array<[number, LiveSelWire | null]> = [
					...all.filter((p) => p.sel !== null).map((p) => [p.pno, p.sel] as [number, LiveSelWire]),
					...shown.map((a) => [a.pno, a.sel] as [number, LiveSelWire]),
				];
				if (cur.length) head.cur = cur;
				// A recipient that skipped rounds may still show agents that left meanwhile, and an
				// old count: every agent this page numbered and no longer shows is gone.
				if (this.agentPnos.size > 0) {
					const showing = new Set(shown.map((a) => a.pno));
					const left = [...this.agentPnos.values()]
						.filter((pno) => !showing.has(pno))
						.slice(-OUTLINE_LIVE_AGENT_BOUNDS.narrators);
					if (left.length) head.gone = left;
					head.am = this.agentsMore;
				}
			} else {
				const changed = [
					...peers.map((p) => p.peer()),
					...agentPeers.map((a) => this.agentWire(a, r.userId)),
				];
				if (changed.length) head.peers = changed;
				if (gone.length || agentGone.length) head.gone = [...gone, ...agentGone];
				const cur: Array<[number, LiveSelWire | null]> = [
					...cursors.map((p) => [p.pno, p.sel] as [number, LiveSelWire | null]),
					...agentCur.map((a) => [a.pno, a.sel] as [number, LiveSelWire]),
				];
				if (cur.length) head.cur = cur;
				if (moreChanged) head.am = this.agentsMore;
			}
			const raw =
				head.peers || head.gone || head.cur || head.am !== undefined ? encodeLiveHead(head) : null;
			heads.set(key, raw);
			return raw;
		};
		for (const r of [...this.participants.values()]) {
			if (r.lagging) {
				this.presenceBehind.delete(r.pno);
				continue;
			}
			const behind = this.presenceBehind.has(r.pno);
			if (socketBuffered(r.socket) > OUTLINE_LIVE_BOUNDS.presenceDropBytes) {
				// Picked up again when the socket drains (`onDrain`).
				this.presenceBehind.add(r.pno);
				continue;
			}
			const raw = headFor(r, behind);
			if (!raw) continue;
			const sent = this.space.deliver(r, "presence", () =>
				encodeLiveFrame({ kind: LIVE_FRAME.presence, handle: r.handle, rawHead: raw }),
			);
			if (sent) this.presenceBehind.delete(r.pno);
			else this.presenceBehind.add(r.pno);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Agents (outline P2 PR 10b, `agent-presence.ts`)
	// ─────────────────────────────────────────────────────────────────────────

	/** Whether the person may see the agent's name (its session is one they may read). */
	mayName(userId: string, agent: AgentPeer): boolean {
		return this.agentReaders.get(userId)?.get(agent.narratorId) === true;
	}

	/** An agent as one person sees it: named, with its session, or just "Agent". */
	agentWire(agent: AgentPeer, userId: string): LivePeerWire {
		if (!this.mayName(userId, agent)) return [agent.pno, "", "", agent.color, "e", "a"];
		return agent.session
			? [agent.pno, "", agent.title, agent.color, "e", "a", agent.narratorId, agent.session]
			: [agent.pno, "", agent.title, agent.color, "e", "a", agent.narratorId];
	}

	/** Agents shown now (tests and diagnostics). */
	get agentsShown(): Array<{ narratorId: string; blocks: string[] }> {
		return [...this.agents.values()].map((a) => ({
			narratorId: a.narratorId,
			blocks: "b" in a.sel ? [...a.sel.b] : [],
		}));
	}

	/**
	 * Work the watch's agents out again soon: at most once every
	 * {@link OUTLINE_LIVE_TIMING.agentsMs}, one at a time (a request meanwhile runs once after).
	 */
	requestAgents(): void {
		if (this.space.closed) return;
		if (this.agentRunning) {
			this.agentDirty = true;
			return;
		}
		if (this.agentTimer) return;
		const wait = Math.max(0, this.agentLastAt + OUTLINE_LIVE_TIMING.agentsMs - liveNow());
		this.agentTimer = liveTimeout(() => {
			this.agentTimer = null;
			void this.runAgents();
		}, wait);
	}

	/** Access changed somewhere: who may name which agent is asked again. */
	agentAccessChanged(): void {
		// Nobody shown: forget every verdict, so an agent that shows later (or a person joining
		// then) is judged afresh rather than from before the change.
		if (this.agents.size === 0) {
			this.agentReaders.clear();
			return;
		}
		this.agentReadersStale = true;
		this.requestAgents();
	}

	async runAgents(): Promise<void> {
		if (this.space.closed) return;
		this.agentRunning = true;
		this.agentLastAt = liveNow();
		try {
			await this.refreshAgents();
		} catch (error) {
			logger.warn("Outline live agents could not be worked out", {
				watch: this.key,
				error: String(error),
			});
		} finally {
			this.agentRunning = false;
			if (this.agentDirty) {
				this.agentDirty = false;
				this.requestAgents();
			}
		}
	}

	/** Note the blocks it shows an agent's commit wrote (the last few), for its cursor. */
	noteAgentWrite(narratorId: string, versions: readonly OutlineVersionRow[]): void {
		const blocks = versions
			.filter(
				(v) =>
					!v.deleted &&
					v.blockId !== this.parentOrRoot &&
					this.space.showingViews(v.blockId).includes(this),
			)
			.map((v) => v.blockId)
			.slice(-OUTLINE_LIVE_AGENT_BOUNDS.writtenBlocks);
		if (blocks.length === 0) return;
		this.agentWrites.delete(narratorId);
		this.agentWrites.set(narratorId, { blocks, at: liveNow() });
		while (this.agentWrites.size > OUTLINE_LIVE_AGENT_BOUNDS.narrators) {
			const oldest = this.agentWrites.keys().next().value;
			if (oldest === undefined) break;
			this.agentWrites.delete(oldest);
		}
	}

	/**
	 * Learn who of these people may name these agents. Everyone whose verdict changed (may now, or
	 * may no longer) gets the whole picture again; a verdict learnt for the first time that says
	 * "may not" changes nothing (an unnamed agent is what they were sent).
	 */
	async learnAgentReaders(
		people: readonly Participant[],
		narratorIds: readonly string[],
	): Promise<void> {
		const persons = people.map((p) => ({ userId: p.userId, isAdmin: p.socket.isAdmin }));
		const changed = new Set<string>();
		for (const narratorId of narratorIds) {
			const readers = await readLiveAgentReaders(narratorId, persons).catch(
				() => new Set<string>(),
			);
			for (const person of persons) {
				let verdicts = this.agentReaders.get(person.userId);
				if (!verdicts) {
					verdicts = new Map();
					this.agentReaders.set(person.userId, verdicts);
				}
				const may = readers.has(person.userId);
				const prior = verdicts.get(narratorId);
				if (may ? prior !== true : prior === true) changed.add(person.userId);
				verdicts.set(narratorId, may);
			}
		}
		if (this.space.closed || changed.size === 0) return;
		for (const p of this.participants.values())
			if (changed.has(p.userId)) this.presenceBehind.add(p.pno);
		this.schedulePresence();
	}

	agentPnoOf(narratorId: string): number {
		let pno = this.agentPnos.get(narratorId);
		if (pno === undefined) {
			pno = this.nextAgentPno++;
			this.agentPnos.set(narratorId, pno);
			// Forget the oldest numbers of agents not shown; a number is never handed out again.
			if (this.agentPnos.size > 4096) {
				const shown = new Set([...this.agents.keys()]);
				for (const id of this.agentPnos.keys()) {
					if (this.agentPnos.size <= 2048) break;
					if (!shown.has(id) && id !== narratorId) this.agentPnos.delete(id);
				}
			}
		}
		return pno;
	}

	async refreshAgents(): Promise<void> {
		const now = liveNow();
		for (const [id, w] of this.agentWrites)
			if (now - w.at >= OUTLINE_LIVE_AGENT_BOUNDS.writeMs) this.agentWrites.delete(id);
		const doing: string[] = [];
		for (const id of this.shownIds())
			if (this.space.mirror.get(id)?.taskJson?.status === "doing") doing.push(id);
		const read = await readLiveAgents({ doing, writes: this.agentWrites, now });
		if (this.space.closed) return;
		this.agentInterest = read.interest;
		const next = read.agents.flatMap((a) => {
			const ids = a.blocks
				.filter((id) => this.space.mirror.alive(id))
				.slice(0, OUTLINE_LIVE_BOUNDS.presenceBlocks);
			return ids.length > 0 ? [{ ...a, blocks: ids }] : [];
		});
		// Names for everyone in, before an agent shows: a new agent, or all of them after an
		// access change.
		const people = [...this.participants.values()];
		if (this.agentReadersStale) {
			// Asked again with the verdicts as they were, so whoever gained or lost a name is told
			// (`learnAgentReaders`); the verdicts of people not here are dropped, to be asked when
			// they come back.
			this.agentReadersStale = false;
			const here = new Set(people.map((p) => p.userId));
			for (const userId of [...this.agentReaders.keys()])
				if (!here.has(userId)) this.agentReaders.delete(userId);
			if (people.length > 0)
				await this.learnAgentReaders(
					people,
					next.map((a) => a.narratorId),
				);
		} else {
			const fresh = next.filter((a) => !this.agents.has(a.narratorId)).map((a) => a.narratorId);
			if (fresh.length > 0 && people.length > 0) await this.learnAgentReaders(people, fresh);
		}
		if (this.space.closed) return;
		let changed = false;
		const wanted = new Set(next.map((a) => a.narratorId));
		for (const [id, peer] of this.agents) {
			if (wanted.has(id)) continue;
			this.agents.delete(id);
			this.agentGone.add(peer.pno);
			this.agentPeersChanged.delete(peer.pno);
			this.agentCursors.delete(peer.pno);
			changed = true;
		}
		for (const a of next) {
			const sel: LiveSelWire = { b: a.blocks };
			const prior = this.agents.get(a.narratorId);
			if (!prior) {
				const pno = this.agentPnoOf(a.narratorId);
				this.agents.set(a.narratorId, {
					pno,
					narratorId: a.narratorId,
					title: a.title,
					session: a.session,
					color: livePeerColor(a.narratorId),
					sel,
				});
				this.agentGone.delete(pno);
				this.agentPeersChanged.add(pno);
				this.agentCursors.add(pno);
				changed = true;
				continue;
			}
			if (prior.title !== a.title || prior.session !== a.session) {
				prior.title = a.title;
				prior.session = a.session;
				this.agentPeersChanged.add(prior.pno);
				changed = true;
			}
			if (JSON.stringify(prior.sel) !== JSON.stringify(sel)) {
				prior.sel = sel;
				this.agentCursors.add(prior.pno);
				changed = true;
			}
		}
		if (read.more !== this.agentsMore) {
			this.agentsMore = read.more;
			this.agentsMoreChanged = true;
			changed = true;
		}
		if (
			this.agentReaders.size >
			4 * (OUTLINE_LIVE_LIMITS.editorsPerSpace + OUTLINE_LIVE_LIMITS.viewersPerSpace)
		) {
			const here = new Set(people.map((p) => p.userId));
			for (const userId of [...this.agentReaders.keys()])
				if (!here.has(userId)) this.agentReaders.delete(userId);
		}
		if (changed) this.schedulePresence();
		// A cursor on a block just written lasts its while: look again when the first one ends.
		if (this.agentExpiry) cancelLiveTimer(this.agentExpiry);
		this.agentExpiry = null;
		let first = Number.POSITIVE_INFINITY;
		for (const w of this.agentWrites.values()) first = Math.min(first, w.at);
		if (Number.isFinite(first)) {
			this.agentExpiry = liveTimeout(
				() => {
					this.agentExpiry = null;
					this.requestAgents();
				},
				Math.max(0, first + OUTLINE_LIVE_AGENT_BOUNDS.writeMs - liveNow()),
			);
		}
	}

	/** A selection as presence carries it: positions, or live blocks (bounded). */
	validSelection(sel: unknown): LiveSelWire | null {
		if (!sel || typeof sel !== "object") return null;
		const s = sel as Record<string, unknown>;
		if (Array.isArray(s.b)) {
			const ids: string[] = [];
			for (const x of s.b as unknown[]) {
				if (ids.length >= OUTLINE_LIVE_BOUNDS.presenceBlocks) break;
				if (typeof x === "string" && x.length <= 64 && this.space.mirror.alive(x)) ids.push(x);
			}
			return { b: ids };
		}
		if (validPos(s.a) && validPos(s.h)) return { a: s.a as never, h: s.h as never };
		return null;
	}
}

export class LiveSpace {
	/** The documents of blocks whose text someone changed in this session, by block id. */
	private readonly docs = new Map<string, LiveTextDoc>();
	/**
	 * Blocks a write from outside added, by the operation number of the batch that added them: a
	 * resuming client that had not seen that batch is sent their seed text.
	 */
	private readonly seededAt = new Map<string, number>();
	readonly mirror = new SpaceMirror();
	readonly epoch = newEpoch();
	/** Everyone in the session, whatever they watch. */
	readonly participants = new Map<number, Participant>();
	/** The watches loaded, by key ({@link liveWatchKey}): each with its watchers. */
	readonly scopes = new Map<string, LiveView>();
	/** Loaded subtree watches by their root. */
	private readonly subtreeViews = new Map<string, LiveView>();
	/** Loaded level watches by their parent's key ({@link parentKeyOf}). */
	private readonly levelViews = new Map<string, LiveView>();
	/** Audiences by key (the sorted keys of their watches). */
	private readonly audiences = new Map<string, Audience>();
	/** The session's document generation counter (`MirrorBlock.gen`): it only grows. */
	private era = 0;
	/** When each document last took an update (eviction picks the idle ones). */
	private readonly docTouched = new Map<string, number>();
	/** Bytes each document is charged against the bound. */
	private readonly docCharged = new Map<string, number>();
	/**
	 * Documents of blocks the mirror never had (a refused insert): the watches of who made them,
	 * whose watchers are sent its updates.
	 */
	private readonly orphanHeld = new Map<string, readonly HeldBy[]>();
	/** Per audience: the highest operation number of its share no longer in `opLog`. */
	private readonly opDropped = new Map<string, number>();
	private sweepTimer: LiveTimer | null = null;
	/**
	 * Blocks that left the session lately (their tree was unloaded): typing still on its way
	 * into one is told back as not taken, not refused as text of a block that never was.
	 */
	private readonly recentlyGone = new Map<string, number>();
	/**
	 * Per client key: text of its transactions that was not taken, kept until its client shows
	 * it was told (a join names the last acknowledgement the client got; what was not taken of a
	 * transaction goes out with that transaction's acknowledgement). A frame sent is not a frame
	 * received.
	 */
	private readonly keyLost = new Map<string, LiveLostWire[]>();
	/** Client keys whose {@link keyLost} changed since the last log row about them. */
	private readonly lostPending = new Set<string>();
	/** Entries of {@link keyLost} already sent, by participant number (not sent twice to one). */
	private readonly lostSent = new Map<number, number>();
	/** Watches being loaded (a join waits for the one already under way). */
	private readonly loading = new Map<string, Promise<LiveView | Refusal>>();
	private nextPno = 1;
	/** Per client key: the highest transaction processed (least recently used first). */
	private readonly keys = new Map<string, number>();
	/** Per client key: the highest transaction acknowledged to its client. */
	private readonly keyAcked = new Map<string, number>();
	private opSeq = 0;
	private readonly opLog: ScopedCommit[] = [];
	closed = false;
	/** Set at close: everything was committed and the log dropped. */
	closedClean = false;
	private closing: Promise<void> | null = null;

	// Broadcast window.
	private windowUpdates: WindowUpdate[] = [];
	private windowCommits: ScopedCommit[] = [];
	private readonly windowAcks = new Map<number, Array<[number, number, LiveOp[]?]>>();
	private broadcastTimer: LiveTimer | null = null;

	// Text not committed yet: block id → who changed it last (null: not a person).
	private readonly dirty = new Map<string, string | null>();
	private firstDirtyAt = 0;
	private lastDirtyAt = 0;
	private flushTimer: LiveTimer | null = null;
	/** Blocks whose text changed in the update being applied (for structural transactions). */
	private touched: Set<string> | null = null;

	// Persistence.
	private pendingRows: PendingRow[] = [];
	/** Blocks whose database content changed since the last sync row (see `persistStep`). */
	private readonly syncPending = new Map<string, string>();
	/** Commits about to be written: block → the content it will have (see `persistStep`). */
	private readonly intentPending = new Map<string, string>();
	/** Intents written to the log and not resolved by a sync row or a cancel yet. */
	private readonly openIntents = new Map<string, string>();
	/** Intents whose commit did not happen. */
	private readonly cancelPending = new Set<string>();
	/** Per client key: the highest transaction known to be in the log (or committed). */
	private readonly keyDurable = new Map<string, number>();
	/** Client keys whose durable transaction advanced since the last log row about them. */
	private readonly keysPending = new Set<string>();
	private persistTimer: LiveTimer | null = null;
	private persistChain: Promise<void> = Promise.resolve();
	private logSeq = 0;
	private snapshotWritten = false;
	private rowsSinceCompact = 0;
	/** Base64 bytes of the increments appended since the last snapshot. */
	private bytesSinceCompact = 0;
	/** Base64 bytes of the last snapshot row. */
	private snapshotBytes = 0;
	/** Bytes charged since the session opened: updates taken in, documents made (`charge`). */
	private docBytes = 0;
	private restartRequested = false;
	/** Structural transactions whose change is applied but held back from the log. */
	private holding = 0;
	/** The snapshot row is wanted now, even with nothing else to log. */
	private snapshotWanted = false;
	/** Blocks whose text could not be normalized or written: committed as a code block next. */
	private readonly stuck = new Set<string>();
	/** Failed commits per block, since its last successful one. */
	private readonly failures = new Map<string, number>();
	/** Blocks whose text cannot be committed even as code: kept live and in the log only. */
	private readonly parked = new Set<string>();

	/** Measurements for diagnostics and the PR's numbers. */
	readonly stats = {
		updatesIn: 0,
		updateBytesIn: 0,
		applyMs: 0,
		framesOut: 0,
		bytesOut: 0,
		mergeMs: 0,
		txCommitted: 0,
		txRejected: 0,
		flushCommits: 0,
		rowsWritten: 0,
		rowBytes: 0,
		compactions: 0,
		resyncs: 0,
		docsEvicted: 0,
		treesLoaded: 0,
		treesUnloaded: 0,
		loadMs: 0,
	};

	/**
	 * `schedule` queues a task on the space's lane; `onEnd` asks for the session to be closed
	 * (idle: nobody is in it and no page is loaded; or its documents grew past their hard bound).
	 */
	constructor(
		readonly spaceId: string,
		private readonly schedule: (task: () => Promise<void>) => void,
		private readonly onEnd: (space: LiveSpace, code: LiveCloseCode, idle: boolean) => void,
		/** Blocks the process may still load (the registry's bound across all sessions). */
		private readonly room: () => number = () => Number.POSITIVE_INFINITY,
		/** Watches the process may still load (`OUTLINE_LIVE_LIMITS.liveWatches`). */
		private readonly watchRoom: () => number = () => Number.POSITIVE_INFINITY,
		/**
		 * A person's watches and participants in every session of the process (all sockets, all
		 * spaces): the budget `OUTLINE_LIVE_LIMITS.watchBudget` is the person's (the registry
		 * counts, `LivePeople`). Alone (tests), this session's.
		 */
		private readonly people: LivePeople = localPeople(() => this.participants.values()),
	) {}

	// ─────────────────────────────────────────────────────────────────────────
	// Loading and unloading
	// ─────────────────────────────────────────────────────────────────────────

	/** Per client key: the highest transaction processed (diagnostics and tests). */
	get clientKeys(): ReadonlyMap<string, number> {
		return this.keys;
	}

	/** Blocks the mirror holds (budgets, diagnostics). */
	get loadedBlocks(): number {
		return this.mirror.size;
	}

	// ── what is watched ──────────────────────────────────────────────────────

	/**
	 * The watches showing a live block now: a subtree whose root is the block or above it through
	 * live blocks only, and the level of its parent. Empty for a deleted block. Walks up the
	 * mirror once.
	 */
	showingViews(id: string): LiveView[] {
		const b = this.mirror.get(id);
		if (!b || b.deleted) return [];
		const out: LiveView[] = [];
		const level = this.levelViews.get(parentKeyOf(b.parentId));
		if (level) out.push(level);
		let cur: MirrorBlock = b;
		for (let guard = 0; guard < 10_000; guard++) {
			const sub = this.subtreeViews.get(cur.id);
			if (sub) out.push(sub);
			if (cur.parentId === null) break;
			const parent = this.mirror.get(cur.parentId);
			if (!parent || parent.deleted) break;
			cur = parent;
		}
		return out;
	}

	/**
	 * The watches covering a block, deleted or not: a subtree whose root is the block or above it
	 * (through deleted blocks too), the level of its parent, and the level it is the parent of
	 * (which needs it as its anchor). What keeps a block in the mirror.
	 */
	coveringViews(id: string): LiveView[] {
		const b = this.mirror.get(id);
		if (!b) return [];
		const out: LiveView[] = [];
		const level = this.levelViews.get(parentKeyOf(b.parentId));
		if (level) out.push(level);
		const below = this.levelViews.get(id);
		if (below) out.push(below);
		let cur: MirrorBlock | undefined = b;
		for (let guard = 0; cur && guard < 10_000; guard++) {
			const sub = this.subtreeViews.get(cur.id);
			if (sub) out.push(sub);
			if (cur.parentId === null) break;
			cur = this.mirror.get(cur.parentId);
		}
		return out;
	}

	/** Inside a loaded subtree (the block itself a watched root, or below one, deleted or not). */
	private underSubtree(id: string): boolean {
		let cur: string | null = id;
		for (let guard = 0; cur !== null && guard < 10_000; guard++) {
			if (this.subtreeViews.has(cur)) return true;
			cur = this.mirror.get(cur)?.parentId ?? null;
		}
		return false;
	}

	/**
	 * Every live child of the parent (`null`: the top level) is in the mirror: a watched level, or
	 * a parent inside a watched subtree. Only under such a parent may a block be put.
	 */
	isLoaded(parentId: string | null): boolean {
		if (this.levelViews.has(parentKeyOf(parentId))) return true;
		return (
			parentId !== null && this.mirror.get(parentId) !== undefined && this.underSubtree(parentId)
		);
	}

	/** A block a watch stands on (a subtree's root, a level's parent): its parent need not be here. */
	private isAnchor(id: string): boolean {
		return this.subtreeViews.has(id) || this.levelViews.has(id);
	}

	/** The watches holding a block's text (`MirrorBlock.held`; a refused insert's maker's). */
	private heldOf(id: string): readonly HeldBy[] {
		return this.mirror.get(id)?.held ?? this.orphanHeld.get(id) ?? HELD_BY_NOBODY;
	}

	/** A watch now holds a block's text (its watchers were sent it whole). */
	private holdAlso(id: string, view: LiveView): void {
		const b = this.mirror.get(id);
		if (!b || b.held.includes(view)) return;
		this.mirror.update(id, { held: [...b.held, view] });
	}

	/** A watch no longer holds a block's text (the block left what it covers). */
	private holdNoMore(id: string, view: HeldBy): void {
		const b = this.mirror.get(id);
		if (!b?.held.includes(view)) return;
		const rest = b.held.filter((h) => h !== view);
		this.mirror.update(id, { held: rest.length > 0 ? rest : HELD_BY_NOBODY });
	}

	/** The audience of a watch set: shared by everyone watching exactly that, made on first use. */
	private audienceOf(views: readonly LiveView[]): Audience {
		const sorted = [...views].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		const key = sorted.map((v) => v.key).join("|");
		const existing = this.audiences.get(key);
		if (existing) {
			existing.usedAt = liveNow();
			return existing;
		}
		const made: Audience = { key, views: sorted, madeAtOp: ++this.opSeq, usedAt: liveNow() };
		this.audiences.set(key, made);
		if (this.audiences.size > OUTLINE_LIVE_BOUNDS.audiences) {
			// The least recently used with nobody in it goes: a client resuming it gets a snapshot.
			const used = new Set<string>();
			for (const p of this.participants.values()) used.add(p.audience.key);
			const idle = [...this.audiences.values()]
				.filter((a) => a !== made && !used.has(a.key))
				.sort((a, b) => a.usedAt - b.usedAt);
			for (const a of idle) {
				if (this.audiences.size <= OUTLINE_LIVE_BOUNDS.audiences) break;
				this.dropAudience(a);
			}
		}
		return made;
	}

	private dropAudience(a: Audience): void {
		this.audiences.delete(a.key);
		this.opDropped.delete(a.key);
	}

	// ── loading and unloading ─────────────────────────────────────────────────

	/** Put one row of the blocks table into the mirror, held by the watch that loads it. */
	private putRow(
		view: LiveView,
		b: {
			id: string;
			sid: string;
			parentId: string | null;
			orderKey: string;
			taskJson: OutlineTaskJson | null;
			askJson: unknown;
			content: string;
		},
		anchor = false,
	): void {
		const prior = this.mirror.get(b.id);
		if (prior && !prior.deleted) {
			// Another watch has it: as the table holds it (the session is the only writer between
			// two tasks). Its text is this watch's too: the watch's first snapshot sends it.
			if (!anchor) this.holdAlso(b.id, view);
			return;
		}
		let gen = this.era;
		if (prior) {
			// A deleted block another watch remembers (it was moved here while this was not
			// loaded): the same text and no document means the same lineage, anything else a new
			// generation (whoever still holds the old one is told when the block reaches them).
			if (!this.docs.has(b.id) && prior.dbContent === b.content) gen = prior.gen;
			else {
				this.destroyDoc(b.id);
				gen = ++this.era;
			}
		}
		this.mirror.put({
			id: b.id,
			sid: b.sid,
			parentId: b.parentId,
			orderKey: b.orderKey,
			taskJson: b.taskJson,
			question: b.askJson !== null,
			deleted: false,
			dbContent: b.content,
			gen,
			// The watch's first snapshot sends it. A level's parent is not shown by the level.
			held: anchor ? (prior?.held ?? HELD_BY_NOBODY) : [view],
		});
	}

	/**
	 * A watch, loading it when it is not here. One per key, shared by everyone watching it; a
	 * second watcher waits for the load under way. Runs in the lane.
	 */
	async ensureView(watch: LiveWatchWire, taking?: WatchTaking): Promise<LiveView | Refusal> {
		const key = liveWatchKey(watch);
		const existing = this.scopes.get(key);
		if (existing && !existing.gone) return existing;
		const underWay = this.loading.get(key);
		if (underWay) return await underWay;
		// The process's bound on watches: what nobody here has goes first.
		if (this.watchRoom() <= 0) {
			for (const v of this.idleViews(taking)) {
				if (this.watchRoom() > 0) break;
				await this.unloadView(v);
			}
			if (this.watchRoom() <= 0) return { refused: "unavailable" };
		}
		const load = this.loadView(watch, taking);
		this.loading.set(key, load);
		try {
			return await load;
		} finally {
			this.loading.delete(key);
		}
	}

	/** Watches loaded or being loaded (the registry's bound across all sessions). */
	get watchesHeld(): number {
		return this.scopes.size + this.loading.size;
	}

	/** Watches nobody has, least recently left first (what goes to make room). */
	private idleViews(taking?: WatchTaking): LiveView[] {
		return [...this.scopes.values()]
			.filter((v) => v.participants.size === 0 && !v.gone && !taking?.views.includes(v))
			.sort((a, b) => a.idleSince - b.idleSince);
	}

	/**
	 * What a watch needs from the blocks table: a subtree's root and every live block under it
	 * (read a level at a time, at most {@link OUTLINE_LIVE_LIMITS.maxWatchBlocks}), or a level's
	 * parent (its anchor) and live children. Nothing is read of what the mirror holds whole
	 * already (inside a loaded subtree). `access_denied`: the block is not a live block of this
	 * space; `too_large`: over the bound.
	 */
	private async readWatch(
		watch: LiveWatchWire,
		/** Rows it may read at most below the bound: past it, `cap.code` (a share, a frame's reads). */
		cap: { rows: number; code: LiveCloseCode },
	): Promise<{ rows: OutlineBlockRow[]; anchor: OutlineBlockRow | null; read: number } | Refusal> {
		const bound = OUTLINE_LIVE_LIMITS.maxWatchBlocks;
		const max = Math.min(bound, cap.rows);
		const past = max < bound ? cap.code : "too_large";
		const usable = (row: OutlineBlockRow | null): row is OutlineBlockRow =>
			row !== null && !row.deleted && row.spaceId === this.spaceId;
		if ("s" in watch) {
			if (this.mirror.alive(watch.s) && this.underSubtree(watch.s))
				return { rows: [], anchor: null, read: 0 };
			const root = await outlineStore.getBlock(watch.s);
			if (!usable(root)) return { refused: "access_denied" };
			// A level at a time, whole rows (nothing is written meanwhile: the lane), stopping one
			// past the bound.
			const rows: OutlineBlockRow[] = [root];
			let frontier = [root.id];
			while (frontier.length > 0) {
				const room = max - rows.length;
				if (room < 0) return { refused: past, read: rows.length };
				const level = await outlineStore.listChildBlocks(this.spaceId, frontier, room + 1);
				if (level.length > room) return { refused: past, read: rows.length + level.length };
				for (const b of level) rows.push(b);
				frontier = level.map((b) => b.id);
				if (frontier.length > 0) await yieldToLoop();
			}
			return { rows, anchor: null, read: rows.length };
		}
		const parentId = watch.l;
		let anchor: OutlineBlockRow | null = null;
		if (parentId !== null) {
			const inside = this.mirror.alive(parentId) && this.underSubtree(parentId);
			if (inside) return { rows: [], anchor: null, read: 0 };
			anchor = await outlineStore.getBlock(parentId);
			if (!usable(anchor)) return { refused: "access_denied" };
		}
		const kids = await outlineStore.listChildren(this.spaceId, parentId, max + 1);
		if (kids.length > max) return { refused: past, read: kids.length };
		return { rows: kids, anchor, read: kids.length + (anchor ? 1 : 0) };
	}

	private async loadView(watch: LiveWatchWire, taking?: WatchTaking): Promise<LiveView | Refusal> {
		const t0 = performance.now();
		const userId = taking?.userId;
		// One person's share (see below), and what this join or frame may still read: the read
		// stops one past whichever is smaller (a share already used up reads nothing).
		const own = userId !== undefined ? this.ownBlocks(userId, taking) : 0;
		const shareLeft = own > 0 ? OUTLINE_LIVE_BOUNDS.maxUserBlocks - own : Number.POSITIVE_INFINITY;
		if (shareLeft <= 0) return { refused: "user_limit" };
		const spent = taking?.spentCode ?? "user_limit";
		if (taking && taking.rowsLeft <= 0) return { refused: spent };
		// A mirror full of what people are connected to: nothing to read for.
		if (
			(this.mirror.size >= OUTLINE_LIVE_BOUNDS.maxLoadedBlocks ||
				this.mirror.chars >= OUTLINE_LIVE_BOUNDS.maxLoadedChars) &&
			this.idleViews(taking).length === 0
		)
			return { refused: "space_full" };
		const rowsLeft = taking?.rowsLeft ?? Number.POSITIVE_INFINITY;
		const read = await this.readWatch(watch, {
			rows: Math.min(shareLeft, rowsLeft),
			// Past the share: `user_limit`; past what this frame may still read: its own code.
			code: rowsLeft < shareLeft ? spent : "user_limit",
		});
		if (taking) taking.rowsLeft -= read.read ?? 0;
		if ("refused" in read) return { refused: read.refused };
		const { rows, anchor } = read;
		let bytes = 0;
		for (const b of rows) bytes += bytesOf(b.content);
		if (bytes > OUTLINE_LIVE_LIMITS.maxWatchBytes) return { refused: "too_large" };
		if (this.closed) return { refused: "ended" };
		const view = new LiveView(this, watch);
		// What the mirror does not hold yet (another watch may hold some of it).
		const need = () => {
			let blocks = 0;
			let chars = 0;
			for (const b of anchor ? [anchor, ...rows] : rows) {
				if (this.mirror.alive(b.id)) continue;
				blocks++;
				chars += b.content.length;
			}
			return { blocks, chars };
		};
		// What it shows: what it read, or (all here already) what the mirror shows of it. Inside a
		// loaded subtree too it is bounded: it may be all that is left of it later.
		const size = rows.length > 0 || anchor ? rows.length : this.shownBy(watch).length;
		if (rows.length === 0 && !anchor) {
			if (size > OUTLINE_LIVE_LIMITS.maxWatchBlocks) return { refused: "too_large" };
			let shownBytes = 0;
			for (const id of this.shownBy(watch)) shownBytes += bytesOf(this.textOf(id));
			if (shownBytes > OUTLINE_LIVE_LIMITS.maxWatchBytes) return { refused: "too_large" };
		}
		// Room first: watches nobody has go, least recently left first. A watch someone is
		// connected to is never closed to make room for another: that would only move the
		// shortage to it (its tab would come back and close the next one, round and round).
		const overSpace = () => {
			const n = need();
			return (
				this.mirror.size + n.blocks > OUTLINE_LIVE_BOUNDS.maxLoadedBlocks ||
				this.mirror.chars + n.chars > OUTLINE_LIVE_BOUNDS.maxLoadedChars
			);
		};
		const over = () => overSpace() || need().blocks > this.room();
		if (over()) {
			for (const v of this.idleViews(taking)) {
				if (!over()) break;
				await this.unloadView(v);
			}
		}
		if (this.closed) return { refused: "ended" };
		// One person's tabs do not take the whole space: past their share, their new watch is
		// refused (they close one of their own and retry), never one of their open ones closed.
		if (userId !== undefined) {
			const ownNow = this.ownBlocks(userId, taking);
			if (ownNow > 0 && ownNow + size > OUTLINE_LIVE_BOUNDS.maxUserBlocks)
				return { refused: "user_limit" };
		}
		if (overSpace()) return { refused: "space_full" };
		if (over()) return { refused: "unavailable" };
		const base = this.era;
		if (anchor) this.putRow(view, anchor, true);
		const step = OUTLINE_LIVE_BOUNDS.loadStep;
		for (let at = 0; at < rows.length; at += step) {
			if (at > 0) await yieldToLoop();
			if (this.closed) return { refused: "ended" };
			for (const b of rows.slice(at, at + step)) this.putRow(view, b);
		}
		// Shown already by another watch (read nothing): its text is this watch's too.
		if (rows.length === 0) for (const id of this.shownBy(watch)) this.holdAlso(id, view);
		this.scopes.set(view.key, view);
		if ("s" in watch) this.subtreeViews.set(watch.s, view);
		else this.levelViews.set(parentKeyOf(watch.l), view);
		view.baseGen = base;
		view.blocks = size;
		// A number of its own: a client that last saw an earlier one was here before this load.
		view.loadedAtOp = ++this.opSeq;
		this.stats.treesLoaded++;
		this.stats.loadMs += performance.now() - t0;
		return view;
	}

	/**
	 * Of a transaction's moves: the blocks it brings into a watched subtree from where no subtree
	 * held them (only levels, so the mirror may lack what is under them), through blocks it does
	 * not delete.
	 */
	private movedIntoSubtrees(ops: readonly LiveOp[]): Array<{ id: string; into: LiveView[] }> {
		const finalParent = new Map<string, string | null>();
		const deleting = new Set<string>();
		for (const op of ops) {
			if (op.t === "i" || op.t === "m") finalParent.set(op.id, op.p);
			else if (op.t === "d") deleting.add(op.id);
		}
		const parentOf = (id: string): string | null =>
			finalParent.has(id) ? (finalParent.get(id) ?? null) : (this.mirror.get(id)?.parentId ?? null);
		const out: Array<{ id: string; into: LiveView[] }> = [];
		for (const op of ops) {
			if (op.t !== "m" || out.some((x) => x.id === op.id) || this.underSubtree(op.id)) continue;
			let into: LiveView[] = [];
			let cur = parentOf(op.id);
			for (let guard = 0; cur !== null && guard < 10_000; guard++) {
				if (deleting.has(cur)) {
					into = [];
					break;
				}
				const sub = this.subtreeViews.get(cur);
				if (sub) into.push(sub);
				cur = parentOf(cur);
			}
			if (into.length > 0) out.push({ id: op.id, into });
		}
		return out;
	}

	/**
	 * Whether a transaction deletes a block with a live child it does not delete or move away
	 * too (a join moves the children along). The mirror
	 * says for a block whose children it holds whole (`isLoaded`); otherwise one indexed, bounded
	 * read of its children (as many as the transaction deletes of them, and one more).
	 */
	private async deletesLeaveChildren(ops: readonly LiveOp[]): Promise<boolean> {
		const deleted = new Set<string>();
		// Children the transaction takes out from under a deleted block (a join moves them).
		const goes = new Set<string>();
		for (const op of ops) {
			if (op.t === "d") deleted.add(op.id);
			else if (op.t === "m") goes.add(op.id);
		}
		if (deleted.size === 0) return false;
		for (const id of deleted) goes.add(id);
		for (const id of deleted) {
			const known = this.mirror.children(id);
			if (known.some((k) => !goes.has(k))) return true;
			if (this.isLoaded(id)) continue;
			const rows = await outlineStore.listChildBlocks(this.spaceId, [id], known.length + 1);
			if (rows.some((r) => !goes.has(r.id))) return true;
		}
		return false;
	}

	/**
	 * What the mirror lacks under blocks brought into a watched subtree from where only levels
	 * (or nothing) showed them: a subtree holds every live block under its root, so their live
	 * descendants it does not hold are read, a level at a time (whole rows), parents first.
	 * `too_large` past the bound of one watch. The blocks under them are not touched by the
	 * batch that brings them (the session never held them), so this may run before or after it.
	 */
	private async readUnder(roots: readonly string[]): Promise<OutlineBlockRow[] | "too_large"> {
		const max = OUTLINE_LIVE_LIMITS.maxWatchBlocks;
		const seen = new Set<string>();
		let frontier: string[] = [];
		for (const r of roots)
			for (const id of this.mirror.alive(r) ? this.mirror.subtree(r) : [])
				if (!seen.has(id)) {
					seen.add(id);
					// A watched level's children are all here already.
					if (!this.levelViews.has(id)) frontier.push(id);
				}
		const out: OutlineBlockRow[] = [];
		let bytes = 0;
		while (frontier.length > 0) {
			let known = 0;
			for (const id of frontier) known += this.mirror.children(id).length;
			const room = max - out.length;
			const level = await outlineStore.listChildBlocks(this.spaceId, frontier, room + known + 1);
			const fresh = level.filter((b) => !seen.has(b.id) && !this.mirror.alive(b.id));
			if (fresh.length > room) return "too_large";
			for (const b of fresh) {
				seen.add(b.id);
				out.push(b);
				bytes += bytesOf(b.content);
			}
			if (bytes > OUTLINE_LIVE_LIMITS.maxWatchBytes) return "too_large";
			frontier = fresh.map((b) => b.id);
			if (frontier.length > 0) await yieldToLoop();
		}
		return out;
	}

	/**
	 * Whether blocks read under a block brought into a subtree fit what the session may hold
	 * with what the mirror holds now (an outside commit's own new blocks included): the space's
	 * bound, the process's, and (a person's move) their share when every watch the blocks go into
	 * is theirs alone.
	 */
	private fillFits(
		rows: readonly OutlineBlockRow[],
		into: readonly LiveView[],
		userId?: string,
	): boolean {
		let chars = 0;
		for (const b of rows) chars += b.content.length;
		if (
			this.mirror.size + rows.length > OUTLINE_LIVE_BOUNDS.maxLoadedBlocks ||
			this.mirror.chars + chars > OUTLINE_LIVE_BOUNDS.maxLoadedChars ||
			rows.length > this.room()
		)
			return false;
		if (userId === undefined) return true;
		const alone = into.every((v) => {
			for (const q of v.participants.values()) if (q.userId !== userId) return false;
			return true;
		});
		return !alone || this.ownBlocks(userId) + rows.length <= OUTLINE_LIVE_BOUNDS.maxUserBlocks;
	}

	/**
	 * Put rows read under a block brought into a subtree into the mirror, held by nobody yet:
	 * `route` sends them (with their text, `tell`) to every watch now showing them. A deleted
	 * block remembered here keeps its lineage only with the same text and no document.
	 */
	private putUnder(rows: readonly OutlineBlockRow[]): string[] {
		const ids: string[] = [];
		for (const b of rows) {
			const prior = this.mirror.get(b.id);
			if (prior && !prior.deleted) continue;
			let gen = this.era;
			let held: readonly HeldBy[] = HELD_BY_NOBODY;
			if (prior) {
				if (!this.docs.has(b.id) && prior.dbContent === b.content) {
					gen = prior.gen;
					held = prior.held;
				} else {
					this.destroyDoc(b.id);
					gen = ++this.era;
				}
			}
			this.mirror.put({
				id: b.id,
				sid: b.sid,
				parentId: b.parentId,
				orderKey: b.orderKey,
				taskJson: b.taskJson,
				question: b.askJson !== null,
				deleted: false,
				dbContent: b.content,
				gen,
				held,
			});
			ids.push(b.id);
		}
		return ids;
	}

	/**
	 * Blocks of one person's share, as the mirror shows them now: of the watches only they are in, and of the watches the join
	 * or frame under way takes that nobody is in yet (each overlapping one counted: errs on the
	 * safe side).
	 */
	private ownBlocks(userId: string, taking?: WatchTaking): number {
		let own = 0;
		for (const v of this.scopes.values()) {
			if (v.gone || v.participants.size === 0) continue;
			let alone = true;
			for (const p of v.participants.values()) if (p.userId !== userId) alone = false;
			if (alone) own += v.shownCount();
		}
		for (const v of taking?.views ?? [])
			if (!v.gone && v.participants.size === 0) own += v.shownCount();
		return own;
	}

	/** Live blocks a watch would show, from the mirror (before it is registered). */
	private shownBy(watch: LiveWatchWire): string[] {
		if ("s" in watch) return this.mirror.alive(watch.s) ? this.mirror.subtree(watch.s) : [];
		return [...this.mirror.children(watch.l)];
	}

	/** Commit and log what is pending of `ids`; false when some text of them cannot be committed. */
	private async settleForUnload(ids: readonly string[]): Promise<boolean> {
		if (ids.some((id) => this.parked.has(id) || this.stuck.has(id))) return false;
		if (ids.some((id) => this.dirty.has(id))) {
			await this.flushContent();
			if (ids.some((id) => this.dirty.has(id) || this.parked.has(id))) return false;
		}
		return (await this.persistNow()) && this.holding === 0;
	}

	/** Take blocks out of the mirror with everything the session holds of them. */
	private async removeBlocks(ids: readonly string[]): Promise<void> {
		const step = OUTLINE_LIVE_BOUNDS.loadStep;
		for (let at = 0; at < ids.length; at += step) {
			if (at > 0) await yieldToLoop();
			for (const id of ids.slice(at, at + step)) this.forget(id);
		}
		// Whoever comes back with a document of one of these holds an older generation.
		this.era++;
		this.schedulePersist();
	}

	private forget(id: string): void {
		this.recentlyGone.delete(id);
		this.recentlyGone.set(id, liveNow());
		if (this.recentlyGone.size > OUTLINE_LIVE_BOUNDS.goneBlocks) {
			const oldest = this.recentlyGone.keys().next().value;
			if (oldest !== undefined) this.recentlyGone.delete(oldest);
		}
		this.destroyDoc(id);
		this.dirty.delete(id);
		this.stuck.delete(id);
		this.failures.delete(id);
		this.parked.delete(id);
		this.seededAt.delete(id);
		this.mirror.remove(id);
	}

	/** Drop a block's document on this end only (the block leaves the session, or a new lineage). */
	private destroyDoc(id: string): void {
		const t = this.docs.get(id);
		if (!t) return;
		t.doc.destroy();
		this.docs.delete(id);
		this.docBytes -= this.docCharged.get(id) ?? 0;
		this.docCharged.delete(id);
		this.docTouched.delete(id);
		this.orphanHeld.delete(id);
		// The log forgets it too: a replay must not take its text for uncommitted. Rows of the
		// document not appended yet go (nothing may follow the drop of the document they are
		// of); what was appended before stays before it.
		if (this.pendingRows.some((r) => r.id === id))
			this.pendingRows = this.pendingRows.filter((r) => r.id !== id);
		this.schedulePersist();
		this.pendingRows.push({
			actorKind: "system",
			actorId: LIVE_LOG_ACTOR,
			id,
			kind: LIVE_TEXT_KIND.drop,
			data: EMPTY_TEXT,
		});
	}

	/** Blocks a watch covers that no other watch covers: what goes with it. */
	private leavingWith(view: LiveView): string[] {
		return view.coveredIds().filter((id) => !this.coveringViews(id).some((v) => v !== view));
	}

	/** Take a watch off the session's books (its blocks are the caller's). */
	private dropView(view: LiveView): void {
		const covered = view.coveredIds();
		if (this.scopes.get(view.key) === view) this.scopes.delete(view.key);
		const root = view.parentOrRoot;
		if (view.kind === "s") {
			if (root !== null && this.subtreeViews.get(root) === view) this.subtreeViews.delete(root);
		} else if (this.levelViews.get(parentKeyOf(root)) === view)
			this.levelViews.delete(parentKeyOf(root));
		for (const a of [...this.audiences.values()]) if (a.views.includes(view)) this.dropAudience(a);
		for (const id of covered) this.holdNoMore(id, view);
	}

	/**
	 * Take a watch nobody has out of the session: the text of what goes with it is committed, its
	 * documents dropped, its blocks forgotten (what another watch covers stays). False when someone
	 * took it meanwhile or its text cannot be committed now (it stays, and is tried again). In
	 * the lane.
	 */
	async unloadView(view: LiveView): Promise<boolean> {
		if (view.gone || this.scopes.get(view.key) !== view) return true;
		if (view.participants.size > 0 || this.closed) return false;
		if (!(await this.settleForUnload(this.leavingWith(view)))) return false;
		if (view.participants.size > 0 || this.closed) return false;
		view.stop();
		const leaving = this.leavingWith(view);
		this.dropView(view);
		await this.removeBlocks(leaving);
		this.stats.treesUnloaded++;
		return true;
	}

	/** A watch's idle period passed with nobody in it (`LiveView.armIdle`). */
	viewIdle(view: LiveView): void {
		if (this.closed) return;
		// The last watch of a session nobody is in: the session ends, committing everything (and
		// keeping its log when it cannot).
		if (this.participants.size === 0 && this.scopes.size <= 1) {
			this.onEnd(this, "ended", true);
			return;
		}
		this.schedule(async () => {
			if (view.participants.size > 0 || view.gone || this.closed) return;
			if (!(await this.unloadView(view))) view.armIdle();
			else if (this.scopes.size === 0 && this.participants.size === 0)
				this.onEnd(this, "ended", true);
		});
	}

	/**
	 * A watch ended: a subtree's root was deleted or moved, a level's parent deleted. Its watchers
	 * are told (`watched.gone`; a participant with nothing else watched is ended, `closed`
	 * `ended`); a rejoin or a new watch finds the block where it is now. What another watch covers
	 * stays; the rest goes (its text was committed before the change that ended it).
	 */
	private endView(view: LiveView): void {
		if (view.gone) return;
		for (const p of [...view.participants.values()]) {
			if (p.views.length <= 1) this.dismiss(p, "ended");
			else this.unwatch(p, [view], true);
		}
		view.stop();
		const leaving = this.leavingWith(view);
		this.dropView(view);
		for (const id of leaving) this.forget(id);
		if (leaving.length > 0) {
			this.era++;
			this.schedulePersist();
		}
		if (this.scopes.size === 0 && this.participants.size === 0) this.onEnd(this, "ended", true);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Text
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * A block's document, made on first use from the text the database holds for it (the empty
	 * text for a block the page does not have yet: a block a transaction is about to insert).
	 * Every end makes it from that same text (`shared/outline-live-text.ts`); the log learns the
	 * text before the document's first update.
	 */
	private textDoc(id: string): LiveTextDoc {
		const existing = this.docs.get(id);
		if (existing) return existing;
		const seed = this.mirror.get(id)?.dbContent ?? "";
		const made = seededTextDoc(seed);
		this.docs.set(id, made);
		// A document is kept until every end drops it (`sweepDocs`), also when its block is
		// deleted: each one counts against the session's bound.
		this.charge(id, OUTLINE_LIVE_BOUNDS.docCostBytes);
		this.docTouched.set(id, liveNow());
		this.scheduleSweep();
		if (seed.length > 0)
			this.pendingRows.push({
				actorKind: "system",
				actorId: LIVE_LOG_ACTOR,
				id,
				kind: LIVE_TEXT_KIND.seed,
				data: encodeLiveSeed(seed),
			});
		made.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (this.closed) return;
			this.charge(id, update.length);
			this.docTouched.set(id, liveNow());
			const from = origin instanceof Participant ? origin.pno : 0;
			const gen = this.mirror.get(id)?.gen ?? 0;
			this.windowUpdates.push({
				from,
				id,
				kind: LIVE_TEXT_KIND.update,
				...(gen !== 0 ? { gen } : {}),
				data: update,
			});
			this.scheduleBroadcast();
			this.pendingRows.push({
				...(origin instanceof Participant
					? { actorKind: "human" as const, actorId: origin.userId }
					: { actorKind: "system" as const, actorId: LIVE_LOG_ACTOR }),
				id,
				kind: LIVE_TEXT_KIND.update,
				data: update,
			});
			this.schedulePersist();
		});
		made.text.observe((_event, txn) => {
			this.touched?.add(id);
			if (txn.origin instanceof Participant) this.markDirty(id, txn.origin.userId);
		});
		return made;
	}

	/**
	 * Count a document's bytes against the session's hard bound
	 * ({@link OUTLINE_LIVE_BOUNDS.maxDocBytes}). Documents are dropped long before it
	 * (`sweepDocs`), so it is reached only when that many are all uncommitted; then the session
	 * ends: everything is committed, the participants rejoin a fresh one with no document.
	 */
	private charge(id: string, bytes: number): void {
		this.docBytes += bytes;
		this.docCharged.set(id, (this.docCharged.get(id) ?? 0) + bytes);
		if (this.docBytes <= OUTLINE_LIVE_BOUNDS.maxDocBytes || this.restartRequested) return;
		this.restartRequested = true;
		logger.warn("Outline live documents grew past their bound; restarting the session", {
			spaceId: this.spaceId,
			bytes: this.docBytes,
			documents: this.docs.size,
		});
		this.onEnd(this, "ended", false);
	}

	/** Whether the session holds a text for the block (a document, or the page's block). */
	private hasText(id: string): boolean {
		return this.docs.has(id) || this.mirror.get(id) !== undefined;
	}

	/** Change a block's text as the session itself (never a participant). */
	private editText(id: string, edit: (text: Y.Text) => void): void {
		const t = this.textDoc(id);
		t.doc.transact(() => edit(t.text), SERVER_ORIGIN);
	}

	/** Documents made so far (diagnostics and measurements). */
	get textDocs(): number {
		return this.docs.size;
	}

	/** Blocks that have a document (diagnostics and tests). */
	get textDocIds(): string[] {
		return [...this.docs.keys()];
	}

	/** Blocks whose text one watch holds that have a document. */
	textDocIdsOf(view: LiveView): string[] {
		return [...this.docs.keys()].filter((id) => this.heldOf(id).includes(view));
	}

	/** A block's document generation (diagnostics and tests). */
	genOf(id: string): number {
		return this.mirror.get(id)?.gen ?? 0;
	}

	/** Whether any text of what one watch covers is waiting to be committed. */
	hasUnflushedIn(view: LiveView): boolean {
		for (const id of this.dirty.keys()) if (this.coveringViews(id).includes(view)) return true;
		return false;
	}

	/**
	 * A block's document as diagnostics and tests compare it across ends: its whole state, and
	 * whether an update that names items it lacks is stuck in it. Null without a document.
	 */
	textState(id: string): { state: Uint8Array; stuck: boolean } | null {
		const t = this.docs.get(id);
		return t ? { state: Y.encodeStateAsUpdate(t.doc), stuck: hasPendingStructs(t.doc) } : null;
	}

	/**
	 * A block's text whole, as an entry: its document's state, or its plain text (as a `drop`
	 * when its generation is not 0, so the other end learns the generation). Null for the empty
	 * text of generation 0, which needs no entry.
	 */
	private wholeText(id: string): LiveTextEntry | null {
		const b = this.mirror.get(id);
		const gen = b?.gen ?? 0;
		const t = this.docs.get(id);
		if (t)
			return {
				id,
				kind: LIVE_TEXT_KIND.update,
				...(gen !== 0 ? { gen } : {}),
				data: Y.encodeStateAsUpdate(t.doc),
			};
		const text = b?.dbContent ?? "";
		if (gen !== 0) return { id, kind: LIVE_TEXT_KIND.drop, gen, data: encodeLiveSeed(text) };
		return text.length > 0 ? { id, kind: LIVE_TEXT_KIND.seed, data: encodeLiveSeed(text) } : null;
	}

	/**
	 * Every text a watch set holds, as a snapshot carries it: each document's whole state, and the
	 * plain text of every other block they hold (deleted ones too: undoing a delete brings a block
	 * back with the text it had). `except`: watches whose text the recipient has already (a watch
	 * added to a set): what they hold is left out.
	 */
	private allTexts(
		views: readonly LiveView[],
		base: number,
		except: readonly LiveView[] = [],
	): LiveTextEntry[] {
		const out: LiveTextEntry[] = [];
		const seen = new Set<string>();
		const mine = (held: readonly HeldBy[]) =>
			held.some((h) => views.includes(h as LiveView)) &&
			!held.some((h) => except.includes(h as LiveView));
		// A block of the generation the snapshot names (`base`) needs none said: a plain seed
		// text, or nothing when it is empty. Any other generation is said with the block.
		const plain = (id: string, gen: number, text: string) => {
			if (gen !== base)
				out.push({ id, kind: LIVE_TEXT_KIND.drop, gen, data: encodeLiveSeed(text) });
			else if (text.length > 0)
				out.push({ id, kind: LIVE_TEXT_KIND.seed, data: encodeLiveSeed(text) });
		};
		for (const [id, t] of this.docs) {
			if (!mine(this.heldOf(id))) continue;
			seen.add(id);
			const gen = this.mirror.get(id)?.gen ?? 0;
			// A document of generation 0 in a snapshot of another: said by a drop to 0 before it.
			if (gen === 0 && base !== 0)
				out.push({ id, kind: LIVE_TEXT_KIND.drop, gen: 0, data: EMPTY_TEXT });
			out.push({
				id,
				kind: LIVE_TEXT_KIND.update,
				...(gen !== 0 ? { gen } : {}),
				data: Y.encodeStateAsUpdate(t.doc),
			});
		}
		// By who holds the text, not by where the block is: a deleted block these watchers were
		// shown may sit under a block that has since gone elsewhere, and one they were never shown
		// may sit in what they watch.
		for (const b of this.mirror.all())
			if (!seen.has(b.id) && mine(b.held)) plain(b.id, b.gen, b.dbContent);
		return out;
	}

	/**
	 * What a resuming client lacks of what its watch set holds: of each document it named (at the
	 * block's generation), the difference to its state vector; every other document whole; the
	 * text of blocks that came into what it watches after the last batch it saw; and a `drop` for
	 * every block whose document was dropped since (`g`: the highest generation it was told of).
	 * Null when a vector cannot be read.
	 */
	private missingTexts(
		views: readonly LiveView[],
		vectors: readonly LiveTextEntry[],
		op: number,
		g: number,
	): LiveTextEntry[] | null {
		const mine = (held: readonly HeldBy[]) => held.some((h) => views.includes(h as LiveView));
		const named = new Map<string, LiveTextEntry>();
		for (const v of vectors) if (v.kind === LIVE_TEXT_KIND.vector) named.set(v.id, v);
		const out: LiveTextEntry[] = [];
		const sent = new Set<string>();
		for (const [id, at] of this.seededAt) {
			if (at <= op || this.docs.has(id) || !mine(this.heldOf(id))) continue;
			sent.add(id);
			const e = this.wholeText(id);
			if (e) out.push(e);
		}
		try {
			for (const [id, t] of this.docs) {
				if (!mine(this.heldOf(id))) continue;
				sent.add(id);
				const gen = this.mirror.get(id)?.gen ?? 0;
				const vector = named.get(id);
				const same = vector !== undefined && (vector.gen ?? 0) === gen;
				const data = same
					? Y.encodeStateAsUpdate(t.doc, vector.data)
					: Y.encodeStateAsUpdate(t.doc);
				// An update of no structs and no deletions is two zero bytes. A document of another
				// generation than the client's (one it names, or one made since the last
				// generation it heard of) goes whole whatever it holds: the client drops its own
				// and learns the generation.
				if (data.length > 2 || (!same && (vector !== undefined || gen > g)))
					out.push({ id, kind: LIVE_TEXT_KIND.update, ...(gen !== 0 ? { gen } : {}), data });
			}
		} catch {
			return null;
		}
		// Every block these watches hold, wherever it is now (see `allTexts`).
		for (const b of this.mirror.all()) {
			const id = b.id;
			if (sent.has(id) || !mine(b.held)) continue;
			const vector = named.get(id);
			if (b.gen > g || (vector !== undefined && (vector.gen ?? 0) !== b.gen))
				out.push({
					id,
					kind: LIVE_TEXT_KIND.drop,
					gen: b.gen,
					data: encodeLiveSeed(b.dbContent),
				});
		}
		return out;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Reading
	// ─────────────────────────────────────────────────────────────────────────

	/** A block's live text (its database content while nobody changed it in the session). */
	textOf(id: string): string {
		return this.docs.get(id)?.text.toString() ?? this.mirror.get(id)?.dbContent ?? "";
	}

	/** Nothing waits to be broadcast (tests). */
	get quiet(): boolean {
		return (
			this.broadcastTimer === null &&
			this.windowUpdates.length === 0 &&
			this.windowCommits.length === 0
		);
	}

	/**
	 * Stop without committing or closing anything, as if the process had died here (tests of
	 * the replay). The log rows stay.
	 */
	abandon(): void {
		this.closed = true;
		for (const timer of [this.broadcastTimer, this.flushTimer, this.persistTimer, this.sweepTimer])
			if (timer) cancelLiveTimer(timer);
		for (const view of this.scopes.values()) view.stop();
		this.participants.clear();
		for (const view of this.scopes.values()) view.participants.clear();
		this.scopes.clear();
		this.destroyDocs();
	}

	private destroyDocs(): void {
		for (const t of this.docs.values()) t.doc.destroy();
		this.docs.clear();
	}

	/** Whether any text is waiting to be committed. */
	get hasUnflushed(): boolean {
		return this.dirty.size > 0;
	}

	/**
	 * Take over text an earlier session of this page left that could not be committed (its log
	 * is replayed into this one): the blocks get it as live text, to be committed by this
	 * session like anything typed. In the lane, right after opening.
	 */
	adoptRecovered(changes: readonly RecoveredChange[]): void {
		for (const c of changes) {
			if (!this.mirror.alive(c.id)) continue;
			const current = this.textOf(c.id);
			if (current === c.text) continue;
			this.mergeText(c.id, current, c.text);
			this.markDirty(c.id, c.actor);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Participants
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Structure rows of what a watch set shows ({@link LiveBlockWire}): each block once, a parent
	 * before its children; a parent the list does not carry is named by id (or `-1`, the top
	 * level).
	 */
	private snapshotOf(
		views: readonly LiveView[],
		except: readonly LiveView[] = [],
	): LiveBlockWire[] {
		const out: LiveBlockWire[] = [];
		const index = new Map<string, number>();
		const known = new Set<string>();
		for (const view of except) for (const id of view.shownIds()) known.add(id);
		for (const view of views) {
			for (const id of view.shownIds()) {
				if (index.has(id) || known.has(id)) continue;
				const b = this.mirror.get(id) as MirrorBlock;
				index.set(id, out.length);
				const parent: number | string =
					b.parentId === null ? -1 : (index.get(b.parentId) ?? b.parentId);
				const row: LiveBlockWire = [b.id, parent, b.orderKey, b.sid, taskCharOf(b.taskJson) ?? ""];
				if (b.question) row.push(1);
				out.push(row);
			}
		}
		return out;
	}

	/**
	 * A block's text whole whatever it is (the empty text of generation 0 too, as a `drop`): what
	 * replaces a copy the recipient may hold of it.
	 */
	private wholeTextAlways(id: string): LiveTextEntry {
		const e = this.wholeText(id);
		return e ?? { id, kind: LIVE_TEXT_KIND.drop, gen: 0, data: EMPTY_TEXT };
	}

	/**
	 * The text of blocks named by notices of text not taken that the recipient's watches hold now
	 * (L3): sent after the notice, so a copy the client merged before the notice came (the block
	 * came back to it meanwhile) is replaced by the session's text, never left without it.
	 */
	private lostWholes(p: Participant, lost: readonly LiveLostWire[]): LiveTextEntry[] {
		const out: LiveTextEntry[] = [];
		const seen = new Set<string>();
		for (const [, ids] of lost)
			for (const id of ids) {
				if (seen.has(id)) continue;
				seen.add(id);
				if (this.mirror.get(id) && p.holds(this.heldOf(id))) out.push(this.wholeTextAlways(id));
			}
		return out;
	}

	/** Who is here and where, as the watches of a set show it to one person (each once). */
	private presenceOf(views: readonly LiveView[], userId: string) {
		const peers: LivePeerWire[] = [];
		const cur: Array<[number, LiveSelWire | null]> = [];
		const seen = new Set<number>();
		let am = 0;
		for (const view of views) {
			for (const x of view.participants.values()) {
				if (seen.has(x.pno)) continue;
				seen.add(x.pno);
				peers.push(x.peer());
				if (x.sel !== null) cur.push([x.pno, x.sel]);
			}
			for (const a of view.agents.values()) {
				if (seen.has(a.pno)) continue;
				seen.add(a.pno);
				peers.push(view.agentWire(a, userId));
				cur.push([a.pno, a.sel]);
			}
			am = Math.max(am, view.agentsMore);
		}
		return { peers, cur, am };
	}

	/** Participants who may edit, across the space. */
	get editors(): number {
		let n = 0;
		for (const p of this.participants.values()) if (p.canWrite) n++;
		return n;
	}

	/** Put a participant in a watch: its presence and agents (it is in the watch's book). */
	private enter(p: Participant, view: LiveView): void {
		view.joinedAt = liveNow();
		view.participants.set(p.pno, p);
		view.cancelIdle();
		view.presencePeers.add(p.pno);
		view.schedulePresence();
		// The first person in: who else is working here. Later ones: whose names they may see.
		if (view.participants.size === 1 && view.agents.size === 0) view.requestAgents();
		else if (view.agents.size > 0) void view.learnAgentReaders([p], [...view.agents.keys()]);
	}

	/** Take a participant out of a watch (it may stay in the session with others). */
	private exit(p: Participant, view: LiveView): void {
		if (view.participants.get(p.pno) !== p) return;
		view.participants.delete(p.pno);
		view.presencePeers.delete(p.pno);
		view.presenceCursors.delete(p.pno);
		view.presenceBehind.delete(p.pno);
		view.presenceGone.add(p.pno);
		view.schedulePresence();
		if (view.participants.size === 0 && !view.gone) view.armIdle();
	}

	/**
	 * Add a participant to the space with its watch set (loading what is not loaded: every watch
	 * or none) and answer its join: a snapshot (reset), or the difference to what it has when it
	 * resumes this same session with the same watch set. `dur`: of the client's previous session
	 * (gone), the transactions already in the space (a reset tells the client not to replay them).
	 *
	 * The participant is added only once its answer is encoded and queued: a join that cannot be
	 * answered leaves nothing behind.
	 */
	async join(
		socket: LiveSocket,
		handle: number,
		head: LiveJoinHead,
		/** On a resume: a `vector` entry for every document the client holds. */
		held: Uint8Array,
		canWrite: boolean,
		dur?: number,
		/** Of the client's previous session (gone): what it was never told was not taken. */
		lostBefore?: readonly LiveLostWire[],
	): Promise<Participant | Refusal> {
		if (this.closed || this.restartRequested) return { refused: "ended" };
		// An earlier participant of the same client (a connection that never closed): replaced,
		// and not counted against the person.
		for (const q of [...this.participants.values()]) if (q.key === head.key) this.leave(q);
		const userId = socket.userId;
		if (this.people.participants(userId, head.key) >= OUTLINE_LIVE_BOUNDS.participantsPerUser)
			return { refused: "user_limit" };
		// The person's watch budget: past it a join keeps its first entries (its root), within a
		// small slack; past the slack it is refused.
		const budget = OUTLINE_LIVE_LIMITS.watchBudget;
		const ceiling = budget + OUTLINE_LIVE_BOUNDS.watchSlack;
		const others = this.people.watches(userId, head.key);
		if (others >= ceiling) return { refused: "watch_cap" };
		const room = Math.min(ceiling - others, Math.max(JOIN_KEEPS, budget - others));
		const release = this.people.reserve(userId, Math.min(room, head.watch.length));
		try {
			return await this.joinWithin(socket, handle, head, held, canWrite, room, dur, lostBefore);
		} finally {
			release();
		}
	}

	private async joinWithin(
		socket: LiveSocket,
		handle: number,
		head: LiveJoinHead,
		held: Uint8Array,
		canWrite: boolean,
		/** Entries of `head.watch` it may take (the person's budget); the rest `watch_cap`. */
		room: number,
		dur?: number,
		lostBefore?: readonly LiveLostWire[],
	): Promise<Participant | Refusal> {
		if (this.closed || this.restartRequested) return { refused: "ended" };
		// People are numbered below the agents' numbers: a session that has seen that many joins
		// starts afresh (everyone rejoins a new one), as one whose documents grew too large does.
		if (this.nextPno >= OUTLINE_LIVE_AGENT_PNO_BASE) {
			this.restartRequested = true;
			this.onEnd(this, "ended", false);
			return { refused: "ended" };
		}
		// A socket that has not taken what it was sent gets no snapshot on top of it.
		if (socketBuffered(socket) > OUTLINE_LIVE_BOUNDS.lagBytes) return { refused: "unavailable" };
		const views: LiveView[] = [];
		const idleUnless = () => {
			for (const v of views) if (v.participants.size === 0 && !v.gone) v.armIdle();
		};
		const taking: WatchTaking = { userId: socket.userId, views, rowsLeft: frameReads() };
		const capped: Array<[LiveWatchWire, LiveCloseCode]> = head.watch
			.slice(room)
			.map((w) => [w, "watch_cap"]);
		for (const w of head.watch.slice(0, room)) {
			const v = await this.ensureView(w, taking);
			if ("refused" in v) {
				idleUnless();
				return v;
			}
			if (!views.includes(v)) views.push(v);
		}
		if (this.closed || this.restartRequested) return { refused: "ended" };
		if (
			canWrite
				? this.editors >= OUTLINE_LIVE_LIMITS.editorsPerSpace
				: this.participants.size - this.editors >= OUTLINE_LIVE_LIMITS.viewersPerSpace
		) {
			idleUnless();
			return { refused: "unavailable" };
		}
		const audience = this.audienceOf(views);
		const p = new Participant(
			this.nextPno,
			socket,
			handle,
			head.key,
			head.mode === "edit",
			canWrite,
			views,
			audience,
		);
		const resume = head.resume;
		let joined: LiveJoinedHead;
		let body: Uint8Array;
		const presence = this.presenceOf(views, socket.userId);
		const base = {
			...(head.j !== undefined ? { j: head.j } : {}),
			epoch: this.epoch,
			w: canWrite,
			op: this.opSeq,
			me: p.pno,
			// Agents are named once this person's verdicts are known (`learnAgentReaders`).
			peers: presence.peers,
			cur: presence.cur,
			...(presence.am > 0 ? { am: presence.am } : {}),
			...(capped.length > 0 ? { refused: capped } : {}),
		};
		// Which of the client's transactions of its previous session the space has: this session's
		// own bookkeeping when it is that session (a resume, or a snapshot after a refusal), else
		// what the registry knows of the ended one (`dur`).
		const sameSession = resume !== undefined && resume.epoch === this.epoch;
		const processed = sameSession ? (this.keys.get(head.key) ?? 0) : (dur ?? 0);
		const durable = sameSession
			? Math.min(processed, this.keyDurable.get(head.key) ?? 0)
			: (dur ?? 0);
		let diff: LiveTextEntry[] | null = null;
		// A watch loaded again since the client left (or a watch set nobody had since) starts
		// afresh for it: what the session remembered of its deleted blocks and documents went with
		// the unload, and what it was sent of changes since is not kept.
		if (
			sameSession &&
			!resume.reset &&
			audience.madeAtOp <= resume.op &&
			views.every((v) => v.loadedAtOp <= resume.op)
		) {
			const vectors = decodeLiveTexts(held, OUTLINE_LIVE_LIMITS.maxClientTextEntries);
			diff = vectors ? this.missingTexts(views, vectors, resume.op, resume.g ?? 0) : null;
		}
		// Text of its earlier transactions that was not taken, which it was not told of yet.
		// What the client was acknowledged it was also told of; the rest it is told now.
		if (sameSession) this.toldLost(head.key, resume.tx);
		// Of an ended session: what the client was not acknowledged yet (a notice goes out with
		// the acknowledgement of its transaction, so one acknowledged was received).
		const before = sameSession ? [] : (lostBefore ?? []).filter((l) => l[0] > (resume?.tx ?? 0));
		const lost = sameSession
			? (this.keyLost.get(head.key) ?? []).filter((l) => l[0] <= processed)
			: before;
		if (resume && diff) {
			// Every batch of this audience after the client's last is still in the log of batches.
			const covered = (this.opDropped.get(audience.key) ?? 0) <= resume.op;
			joined = {
				...base,
				mode: "resume",
				tx: processed,
				// Processed but not in the log yet: the client keeps those until acknowledged.
				dur: durable,
				...(covered
					? {
							ops: this.opLog
								.filter((c) => c.audience === audience.key && c.wire.o > resume.op)
								.map((c) => c.wire),
						}
					: { blocks: this.snapshotOf(views) }),
			};
			// After a notice the blocks it names come whole (`lostWholes`), not as a difference to
			// a copy the client is about to put aside.
			const wholes = this.lostWholes(p, lost);
			const replaced = new Set(wholes.map((e) => e.id));
			body = encodeLiveTexts([...diff.filter((e) => !replaced.has(e.id)), ...wholes]);
		} else {
			const gen = views[0]?.baseGen ?? 0;
			joined = {
				...base,
				mode: "reset",
				tx: processed,
				dur: durable,
				blocks: this.snapshotOf(views),
				...(gen !== 0 ? { g: gen } : {}),
			};
			body = encodeLiveTexts(this.allTexts(views, gen));
		}
		if (lost.length > 0) joined.x = lost;
		let frame: Uint8Array;
		try {
			frame = encodeLiveFrame({ kind: LIVE_FRAME.joined, handle, head: joined, body });
		} catch (error) {
			logger.warn("Outline live join could not be answered", {
				spaceId: this.spaceId,
				error: String(error),
			});
			idleUnless();
			return { refused: "unavailable" };
		}
		// In this same session the participant goes on from where its client was: what is
		// applied is not taken again, and is acknowledged once logged. A client of an ended
		// session numbers on from its old transactions, which this session never saw.
		p.lastTx = sameSession ? processed : 0;
		p.durableTx = sameSession ? durable : 0;
		p.ackedTx = p.durableTx;
		if (sameSession && durable > (this.keyAcked.get(head.key) ?? 0))
			this.keyAcked.set(head.key, durable);
		p.windowStart = this.windowUpdates.length;
		p.commitStart = this.windowCommits.length;
		if (!this.sendTo(p, frame, "control")) {
			idleUnless();
			return { refused: "unavailable" };
		}
		if (lost.length > 0) this.lostSent.set(p.pno, processed);
		// Sent is not received: kept until the client's next join shows it got them.
		this.adoptLost(head.key, before);
		this.nextPno++;
		this.participants.set(p.pno, p);
		for (const view of views) this.enter(p, view);
		return p;
	}

	leave(p: Participant): void {
		if (this.participants.get(p.pno) !== p) return;
		this.participants.delete(p.pno);
		this.windowAcks.delete(p.pno);
		this.lostSent.delete(p.pno);
		for (const view of p.views) this.exit(p, view);
	}

	/**
	 * Take watches out of a participant's set: it is sent nothing more of them (an audience of
	 * what is left). `gone`: they ended (`endView`), and it is told so.
	 */
	private unwatch(p: Participant, views: readonly LiveView[], gone: boolean): void {
		this.narrow(p, views);
		if (gone) this.notify(p, { gone: views.map((v) => v.watch) });
	}

	/**
	 * Take watches out of a participant's set. What the window holds for it was cut for its old
	 * set (the batch that ended a watch among it: the client must get that move before it drops
	 * what the watch showed): sent first. From then on it is sent what its new set shows.
	 */
	private narrow(p: Participant, views: readonly LiveView[]): void {
		if (views.length === 0) return;
		this.flushBroadcast();
		const left = p.views.filter((v) => !views.includes(v));
		for (const view of views) this.exit(p, view);
		p.views = left;
		p.audience = this.audienceOf(left);
	}

	/**
	 * Send a participant a `watched` frame without structure of its own, as of the session's
	 * operation number now: at once, or once everything cut for it up to here went out (others'
	 * changes held behind one of its own not acknowledged yet, its own changes not acknowledged
	 * yet; `flushBroadcast` sends it then). The client drops what its watches no longer show when
	 * this arrives, so nothing on its way may still name those blocks.
	 */
	private notify(p: Participant, head: LiveWatchedHead): void {
		if (p.lagging) return;
		p.notices.push({ o: this.opSeq, head });
		// Waiting past their bound: it rejoins (its join names its whole set) and gets everything.
		if (p.notices.length > OUTLINE_LIVE_BOUNDS.notices) {
			this.rejoinWhole(p);
			return;
		}
		this.releaseNotices(p);
	}

	/**
	 * What is held for a participant grew past its bound: it is told to rejoin, and nothing more
	 * is sent to it until it has (its frames are still taken meanwhile).
	 */
	private rejoinWhole(p: Participant): void {
		p.heldCommits = [];
		p.notices = [];
		p.lagging = true;
		p.resyncSent = true;
		this.stats.resyncs++;
		try {
			p.socket.send(encodeLiveFrame({ kind: LIVE_FRAME.resync, handle: p.handle }));
		} catch (error) {
			this.dropBroken(p, error);
		}
	}

	/** Whether something cut for a participant up to operation `o` has not gone out yet. */
	private owesUpTo(p: Participant, o: number): boolean {
		if (p.heldCommits.some((c) => c.o <= o)) return true;
		return (this.windowAcks.get(p.pno) ?? []).some((a) => a[1] <= o);
	}

	private releaseNotices(p: Participant): void {
		while (p.notices.length > 0) {
			const next = p.notices[0] as { o: number; head: LiveWatchedHead };
			if (this.owesUpTo(p, next.o)) return;
			p.notices.shift();
			this.deliver(p, "control", () =>
				encodeLiveFrame({ kind: LIVE_FRAME.watched, handle: p.handle, head: next.head }),
			);
		}
	}

	/**
	 * A `watch` frame: change a participant's watch set. Removals take effect at once; each
	 * addition is loaded (or refused: `too_large`, `user_limit`, `space_full`, `access_denied`,
	 * `unavailable`; never one of anyone's open watches closed for it). The answer, as of the
	 * session's operation number now, carries the structure and text of what the additions show
	 * that its set did not show already. Before it, everything of this participant is logged and
	 * acknowledged and every batch of its old set sent, so the client's structure is the
	 * session's when it adds the answer to it. In the lane.
	 */
	async handleWatch(
		p: Participant,
		rawHead: unknown,
		/** Additions are refused with this before anything is read (the socket's rate, the process's bound). */
		refuseAdding?: LiveCloseCode,
	): Promise<void> {
		if (this.participants.get(p.pno) !== p || p.blocked || this.closed) return;
		const head = rawHead as Partial<LiveWatchHead> | null;
		const list = (v: unknown): LiveWatchWire[] | null =>
			v === undefined
				? []
				: Array.isArray(v) && v.every(isLiveWatch)
					? (v as LiveWatchWire[])
					: null;
		const add = list(head?.add);
		const remove = list(head?.remove);
		const w = head?.w;
		if (!Number.isSafeInteger(w) || (w as number) < 0 || !add || !remove) {
			this.forceResync(p);
			return;
		}
		const removing = new Set(remove.map(liveWatchKey));
		const kept = p.views.filter((v) => !removing.has(v.key));
		const keys = new Set(kept.map((v) => v.key));
		const adding = add.filter((x) => {
			const key = liveWatchKey(x);
			if (keys.has(key)) return false;
			keys.add(key);
			return true;
		});
		// Removals take effect at once, whatever becomes of the additions: the client dropped
		// them from its set when it sent this (it keeps their blocks until the answer, which
		// comes after everything cut for its old set).
		this.narrow(
			p,
			p.views.filter((v) => !kept.includes(v)),
		);
		// The person's budget (all their sessions in the process): taken up to it, the rest
		// refused `watch_cap` (read nothing).
		const others = this.people.watches(p.userId, p.key);
		const capped: Array<[LiveWatchWire, LiveCloseCode]> = adding
			.splice(Math.max(0, OUTLINE_LIVE_LIMITS.watchBudget - others - kept.length))
			.map((x) => [x, "watch_cap"]);
		// Held while it loads (another space's frame of the same person counts it meanwhile).
		const release = this.people.reserve(p.userId, adding.length);
		try {
			await this.takeWatches(p, w as number, kept, adding, capped, refuseAdding);
		} finally {
			release();
		}
	}

	/** The rest of {@link handleWatch}: the additions taken (or refused), and the answer. */
	private async takeWatches(
		p: Participant,
		w: number,
		kept: readonly LiveView[],
		adding: LiveWatchWire[],
		capped: Array<[LiveWatchWire, LiveCloseCode]>,
		refuseAdding?: LiveCloseCode,
	): Promise<void> {
		const answerRefusing = (code: LiveCloseCode) =>
			this.notify(p, {
				w: w as number,
				op: this.opSeq,
				...(adding.length > 0 || capped.length > 0
					? {
							refused: [...adding.map((x): [LiveWatchWire, LiveCloseCode] => [x, code]), ...capped],
						}
					: {}),
			});
		if (adding.length === 0) {
			answerRefusing("unavailable");
			return;
		}
		if (refuseAdding) {
			answerRefusing(refuseAdding);
			return;
		}
		// Everything it sent is in the log and acknowledged, and every batch of its old set out:
		// its structure is the session's as of now (nothing held back for it any more).
		if (!(await this.persistNow())) {
			if (this.participants.get(p.pno) === p && !this.closed) answerRefusing("unavailable");
			return;
		}
		if (this.participants.get(p.pno) !== p || this.closed) return;
		const added: LiveView[] = [];
		const ok: LiveWatchWire[] = [];
		const refused: Array<[LiveWatchWire, LiveCloseCode]> = [...capped];
		const taking: WatchTaking = {
			userId: p.userId,
			views: added,
			rowsLeft: frameReads(),
			spentCode: "too_fast",
		};
		const idleUnless = () => {
			for (const view of added) if (view.participants.size === 0 && !view.gone) view.armIdle();
		};
		// Past a share or a bound, what follows is refused without being read.
		let stop: LiveCloseCode | null = null;
		for (const x of adding) {
			if (stop) {
				refused.push([x, stop]);
				continue;
			}
			const v = await this.ensureView(x, taking);
			if (this.participants.get(p.pno) !== p || this.closed) {
				idleUnless();
				return;
			}
			if ("refused" in v) {
				refused.push([x, v.refused]);
				if (v.refused !== "too_large" && v.refused !== "access_denied") stop = v.refused;
			} else if (!kept.includes(v) && !added.includes(v)) {
				added.push(v);
				ok.push(x);
			}
		}
		// A view loaded for it may have ended meanwhile (a commit of another lane task cannot
		// run here, but an unload for another's room can).
		for (let i = added.length - 1; i >= 0; i--)
			if ((added[i] as LiveView).gone) {
				refused.push([ok[i] as LiveWatchWire, "unavailable"]);
				added.splice(i, 1);
				ok.splice(i, 1);
			}
		this.flushBroadcast();
		// The answer's structure is as of now: nothing cut for its old set may come after it.
		if (p.notices.length > 0 || this.owesUpTo(p, this.opSeq)) {
			idleUnless();
			for (const x of ok) refused.push([x, "unavailable"]);
			this.notify(p, { w: w as number, op: this.opSeq, refused });
			return;
		}
		const gen = added[0]?.baseGen ?? 0;
		const blocks = this.snapshotOf(added, p.views);
		const body = encodeLiveTexts(this.allTexts(added, gen, p.views));
		p.views = [...p.views, ...added];
		p.audience = this.audienceOf(p.views);
		p.windowStart = this.windowUpdates.length;
		p.commitStart = this.windowCommits.length;
		this.deliver(p, "control", () =>
			encodeLiveFrame({
				kind: LIVE_FRAME.watched,
				handle: p.handle,
				head: {
					w: w as number,
					op: this.opSeq,
					...(ok.length > 0 ? { ok } : {}),
					...(refused.length > 0 ? { refused } : {}),
					...(blocks.length > 0 ? { blocks } : {}),
					...(gen !== 0 ? { g: gen } : {}),
				} satisfies LiveWatchedHead,
				...(body.length > 0 ? { body } : {}),
			}),
		);
		for (const view of added) this.enter(p, view);
	}

	/**
	 * Change a participant's write access (an access change re-checked it). A viewer becomes an
	 * editor only while the space has room for one more.
	 */
	setWrite(p: Participant, canWrite: boolean): void {
		if (p.canWrite === canWrite || this.participants.get(p.pno) !== p) return;
		if (canWrite && this.editors >= OUTLINE_LIVE_LIMITS.editorsPerSpace) return;
		p.canWrite = canWrite;
		this.deliver(p, "control", () =>
			encodeLiveFrame({ kind: LIVE_FRAME.mode, handle: p.handle, head: { w: canWrite } }),
		);
		for (const view of p.views) {
			view.presencePeers.add(p.pno);
			view.schedulePresence();
		}
	}

	/** A participant's selection (presence) goes to everyone sharing a watch with it. */
	setSelection(p: Participant, sel: unknown): void {
		for (const view of p.views) view.setSelection(p, sel);
	}

	/** Tell a participant the session ended for it (it is removed). */
	dismiss(p: Participant, code: LiveCloseCode): void {
		this.deliver(p, "control", () =>
			encodeLiveFrame({ kind: LIVE_FRAME.closed, handle: p.handle, head: { code } }),
		);
		this.leave(p);
	}

	/**
	 * Have a participant join again (a resume: it keeps its undo history) and take nothing of
	 * its frames until it has: it sent text of a document generation the session has dropped.
	 * The answer to its join names the drop, and the client makes that text again on the new
	 * document; the frame, never processed, comes again with it.
	 */
	private forceResync(p: Participant): void {
		// Nothing more of it is taken until it has joined again, whether or not it was already
		// asked to (its next frame must not be processed over the one left out here).
		p.blocked = true;
		if (p.resyncSent) return;
		p.lagging = true;
		p.resyncSent = true;
		this.stats.resyncs++;
		try {
			p.socket.send(encodeLiveFrame({ kind: LIVE_FRAME.resync, handle: p.handle }));
		} catch (error) {
			this.dropBroken(p, error);
		}
	}

	/**
	 * Called when a participant's socket drained: one that fell behind is told to rejoin, and
	 * gets exactly what it lacks from its state vector; one that skipped presence gets the whole
	 * picture. Its own frames are still taken meanwhile.
	 */
	onDrain(p: Participant): void {
		if (this.participants.get(p.pno) !== p) return;
		for (const view of p.views) if (view.presenceBehind.has(p.pno)) view.schedulePresence();
		if (!p.lagging || p.resyncSent) return;
		if (socketBuffered(p.socket) > OUTLINE_LIVE_BOUNDS.resumeBytes) return;
		p.resyncSent = true;
		this.stats.resyncs++;
		try {
			p.socket.send(encodeLiveFrame({ kind: LIVE_FRAME.resync, handle: p.handle }));
		} catch (error) {
			this.dropBroken(p, error);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Sending
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Send one frame. `presence` frames are skipped under mild backpressure (kept to be sent
	 * later); any frame is held back from a socket buffering past {@link OUTLINE_LIVE_BOUNDS.
	 * lagBytes}, which is then told to rejoin once it drains: dropping a text update silently
	 * would leave that client diverged. Never throws.
	 */
	private sendTo(
		p: Participant,
		frame: Uint8Array,
		kind: "data" | "presence" | "control",
	): boolean {
		if (p.lagging) return false;
		const buffered = socketBuffered(p.socket);
		if (kind === "presence" && buffered > OUTLINE_LIVE_BOUNDS.presenceDropBytes) return false;
		if (kind === "data" && buffered > OUTLINE_LIVE_BOUNDS.lagBytes) {
			p.lagging = true;
			return false;
		}
		let sent: boolean;
		try {
			sent = p.socket.send(frame);
		} catch {
			sent = false;
		}
		if (!sent) {
			p.lagging = true;
			return false;
		}
		this.stats.framesOut++;
		this.stats.bytesOut += frame.length;
		return true;
	}

	/**
	 * Encode and send one frame to one participant. A frame that cannot be encoded is a bug of
	 * this session, not of the others: the participant is dropped and everyone else carries on.
	 */
	deliver(p: Participant, kind: "data" | "presence" | "control", build: () => Uint8Array): boolean {
		if (p.lagging) return false;
		let frame: Uint8Array;
		try {
			frame = build();
		} catch (error) {
			this.dropBroken(p, error);
			return false;
		}
		return this.sendTo(p, frame, kind);
	}

	private brokenLogged = 0;

	private dropBroken(p: Participant, error: unknown): void {
		if (liveNow() - this.brokenLogged > 60_000) {
			this.brokenLogged = liveNow();
			logger.warn("Outline live frame failed; participant dropped", {
				spaceId: this.spaceId,
				error: String(error),
			});
		}
		this.leave(p);
	}

	private scheduleBroadcast(): void {
		if (this.broadcastTimer || this.closed) return;
		this.broadcastTimer = liveTimeout(() => {
			this.broadcastTimer = null;
			this.flushBroadcast();
		}, OUTLINE_LIVE_TIMING.broadcastMs);
	}

	/**
	 * Send everyone what the window collected for them (see the module header). A participant's
	 * transactions are acknowledged once they are in the log (`durableTx`), so an acknowledged
	 * change survives a crash; the client keeps the others and replays them if it must.
	 */
	flushBroadcast(): void {
		if (this.broadcastTimer) {
			cancelLiveTimer(this.broadcastTimer);
			this.broadcastTimer = null;
		}
		const updates = this.windowUpdates;
		const commits = this.windowCommits;
		this.windowUpdates = [];
		this.windowCommits = [];
		const t0 = performance.now();
		const merged = new Map<string, Uint8Array>();
		// Who holds a block's text decides who gets its updates, as it stands now: a watch that
		// took the block meanwhile was sent its text whole (`tell`, later in the window), one that
		// lost it is told no more of it.
		const heldNow = new Map<string, readonly HeldBy[]>();
		const holdersOf = (id: string) => {
			let held = heldNow.get(id);
			if (!held) {
				held = this.heldOf(id);
				heldNow.set(id, held);
			}
			return held;
		};
		const mergedFor = (p: Participant, start: number): Uint8Array | null => {
			const pno = p.pno;
			let own = false;
			const share: WindowUpdate[] = [];
			for (let i = start; i < updates.length; i++) {
				const u = updates[i] as WindowUpdate;
				if (u.only ? !p.views.includes(u.only) : !p.holds(holdersOf(u.id))) continue;
				if (u.from === pno) own = true;
				else share.push(u);
			}
			if (share.length === 0) return null;
			// Recipients with one watch set that sent nothing in the window share one merge.
			const key = start === 0 && !own ? `all ${p.audience.key}` : `${pno}`;
			let out = merged.get(key);
			if (!out) {
				out = encodeLiveTexts(mergeTexts(share));
				merged.set(key, out);
			}
			return out;
		};
		for (const p of [...this.participants.values()]) {
			const start = p.windowStart;
			const commitStart = p.commitStart;
			p.windowStart = 0;
			p.commitStart = 0;
			// A participant that fell behind rejoins and gets everything it lacks.
			if (p.lagging) continue;
			const others = [...p.heldCommits];
			for (let i = commitStart; i < commits.length; i++) {
				const c = commits[i] as ScopedCommit;
				if (c.audience === p.audience.key && c.wire.by !== p.pno) others.push(c.wire);
			}
			const ackable = Math.min(p.lastTx, p.durableTx);
			const ack = ackable > p.ackedTx ? ackable : 0;
			const waiting = this.windowAcks.get(p.pno);
			const acks = ack > 0 ? waiting?.filter((a) => a[0] <= ack) : undefined;
			// The client applies structure in operation order: others' changes after its own
			// first unacknowledged one wait for that acknowledgement.
			let first = Number.POSITIVE_INFINITY;
			for (const a of waiting ?? []) if (a[0] > ack && a[1] < first) first = a[1];
			const own = others.filter((c) => c.o < first);
			p.heldCommits = others.filter((c) => c.o >= first);
			if (p.heldCommits.length > OUTLINE_LIVE_BOUNDS.opLog) {
				// Held too long (the log is not taking writes): it rejoins and gets everything.
				this.rejoinWhole(p);
				continue;
			}
			const upTo = Math.max(ack, p.ackedTx);
			const sentTo = this.lostSent.get(p.pno) ?? 0;
			const lost = (this.keyLost.get(p.key) ?? []).filter((l) => l[0] <= upTo && l[0] > sentTo);
			// The blocks a notice names come whole first (`lostWholes`): applied after the notice.
			const shared = mergedFor(p, start);
			const wholes = lost.length > 0 ? this.lostWholes(p, lost) : [];
			const body =
				wholes.length > 0
					? concatBytes(encodeLiveTexts(wholes), shared ?? new Uint8Array(0))
					: shared;
			if (!body && own.length === 0 && ack === 0 && lost.length === 0) continue;
			const head: LiveBatchHead = {};
			if (own.length > 0) head.c = own;
			if (acks && acks.length > 0) head.a = acks;
			if (lost.length > 0) head.x = lost;
			const sent = this.deliver(p, "data", () =>
				encodeLiveFrame({
					kind: LIVE_FRAME.batch,
					handle: p.handle,
					n: ack,
					...(head.c || head.a || head.x ? { head } : {}),
					...(body ? { body } : {}),
				}),
			);
			if (sent && lost.length > 0) this.lostSent.set(p.pno, upTo);
			if (sent && ack > 0) {
				p.ackedTx = ack;
				if (ack > (this.keyAcked.get(p.key) ?? 0)) this.keyAcked.set(p.key, ack);
				const rest = waiting?.filter((a) => a[0] > ack) ?? [];
				if (rest.length > 0) this.windowAcks.set(p.pno, rest);
				else this.windowAcks.delete(p.pno);
			}
		}
		// Watch notices whose turn came (after the changes cut before them, sent above).
		for (const p of this.participants.values())
			if (p.notices.length > 0 && !p.lagging) this.releaseNotices(p);
		this.stats.mergeMs += performance.now() - t0;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Text updates
	// ─────────────────────────────────────────────────────────────────────────

	private reject(p: Participant, n: number, code: LiveRejectCode, claimed?: LiveClaimedWire): void {
		this.stats.txRejected++;
		p.blocked = true;
		// Everything up to the refused frame is acknowledged first, in order.
		this.flushBroadcast();
		const head: LiveRejectHead = claimed ? { code, claimed } : { code };
		this.deliver(p, "control", () =>
			encodeLiveFrame({ kind: LIVE_FRAME.reject, handle: p.handle, n, head }),
		);
	}

	/**
	 * A frame from a participant that may not write, or that was refused and has not rejoined:
	 * answered without queueing it (the registry calls this instead of queueing the frame).
	 */
	refuseFrame(p: Participant, n: number): void {
		if (this.participants.get(p.pno) !== p || p.blocked || this.closed) return;
		if (n <= p.lastTx) return;
		this.reject(p, n, "read_only");
	}

	/**
	 * The text entries of a participant's frame: updates only, one a block, each of a block the
	 * session knows, deleted or not (typing may cross its block's deletion, and refusing it
	 * would take the whole frame and the typist's undo history with it), or (a structural
	 * transaction) of one the transaction inserts. Null otherwise: a block the session never had
	 * gets no document. `"stale"`: an entry is of a document generation the session has dropped
	 * (`forceResync`); one of a generation it never announced is refused like any malformed one.
	 */
	private parseTexts(
		p: Participant,
		body: Uint8Array,
		inserted?: ReadonlySet<string>,
	): { entries: LiveTextEntry[]; lost: string[] } | "stale" | null {
		const entries = decodeLiveTexts(body, OUTLINE_LIVE_LIMITS.maxClientTextEntries);
		if (!entries) return null;
		const seen = new Set<string>();
		const out: LiveTextEntry[] = [];
		const lost: string[] = [];
		let stale = false;
		for (const e of entries) {
			if (e.kind !== LIVE_TEXT_KIND.update || seen.has(e.id)) return null;
			seen.add(e.id);
			if (!this.hasText(e.id) && !inserted?.has(e.id)) {
				// A block that left the session with its tree a moment ago: not taken, and said so.
				if (!this.recentlyGone.has(e.id)) return null;
				lost.push(e.id);
				continue;
			}
			const known = this.mirror.get(e.id);
			const gen = known?.gen ?? 0;
			if ((e.gen ?? 0) > gen) return null;
			const mine = p.holds(this.heldOf(e.id));
			// A deleted block whose text another watch holds (or nobody): the session does not
			// follow it for this participant. (A block that went where nobody watches was also
			// given a new generation then: whoever is shown it again gets a later one, and their
			// copy, with the typing not taken, is replaced; `LiveClient.keepLost` relies on it.)
			if (known?.deleted && !mine) lost.push(e.id);
			else if ((e.gen ?? 0) === gen) out.push(e);
			// Of a block whose text one of the participant's watches holds: it is told of the drop
			// (a join names it). Of a block that left what it watches (it holds it as deleted, and
			// is told nothing more of it) and whose document is another by now: typing that
			// crossed the block's leaving cannot be put into that document; the client is told it
			// was not taken and keeps it for the person.
			else if (mine) stale = true;
			else lost.push(e.id);
		}
		return stale ? "stale" : { entries: out, lost };
	}

	/** Text of a processed transaction that was not taken: told with its acknowledgement. */
	private noteLost(p: Participant, n: number, blocks: readonly string[]): void {
		if (blocks.length === 0) return;
		const list = this.keyLost.get(p.key) ?? [];
		list.push([n, [...blocks]]);
		if (list.length > OUTLINE_LIVE_BOUNDS.lostPerKey) {
			// Never silently: a client this far behind on its notices has lost touch with its
			// typing long ago (it is told at its next join; an entry is a few block ids).
			const gone = list.splice(0, list.length - OUTLINE_LIVE_BOUNDS.lostPerKey);
			logger.warn("Outline live: notices of text not taken dropped for a client", {
				spaceId: this.spaceId,
				dropped: gone.length,
				oldestTx: gone[0]?.[0],
			});
		}
		this.keyLost.set(p.key, list);
		// In the log with the transaction's position (`persistStep`), before it is acknowledged.
		this.lostPending.add(p.key);
		this.schedulePersist();
		this.scheduleBroadcast();
	}

	/** What clients were not told yet was not taken (kept past the session's end, `registry.ts`). */
	get lostUntold(): Map<string, LiveLostWire[]> {
		return new Map(this.keyLost);
	}

	/** The client of `key` was told what was not taken of its transactions up to `upTo`. */
	private toldLost(key: string, upTo: number): void {
		const had = this.keyLost.get(key);
		if (!had) return;
		const rest = had.filter((l) => l[0] > upTo);
		if (rest.length === had.length) return;
		if (rest.length > 0) this.keyLost.set(key, rest);
		else this.keyLost.delete(key);
		this.lostPending.add(key);
		this.schedulePersist();
	}

	/**
	 * Notices of an ended session of this client's (`lostBefore`) are this session's to deliver
	 * now: kept, logged and sent again until the client shows it got them (a later join).
	 */
	private adoptLost(key: string, lost: readonly LiveLostWire[]): void {
		if (lost.length === 0) return;
		const list = [...(this.keyLost.get(key) ?? [])];
		for (const l of lost) if (!list.some((x) => x[0] === l[0])) list.push(l);
		list.sort((a, b) => a[0] - b[0]);
		this.keyLost.set(key, list);
		this.lostPending.add(key);
		this.schedulePersist();
	}

	/**
	 * Apply a participant's text updates, reporting whether all integrated cleanly. `undos`
	 * collects what takes each one back (a structural transaction that may yet be refused).
	 */
	private applyTexts(
		p: Participant,
		entries: readonly LiveTextEntry[],
		undos?: Y.UndoManager[],
		/** Of blocks a transaction inserts: the watches that will show them. */
		showers?: ReadonlyMap<string, readonly LiveView[]>,
	): boolean {
		const t0 = performance.now();
		try {
			for (const e of entries) {
				// A block the mirror never had (this transaction inserts it, and may be refused):
				// its updates go to the watchers of where it is put (its maker's text is its own).
				if (!this.docs.has(e.id) && !this.mirror.get(e.id))
					this.orphanHeld.set(e.id, showers?.get(e.id) ?? p.views);
				const t = this.textDoc(e.id);
				if (undos)
					undos.push(
						new Y.UndoManager(t.text, { trackedOrigins: new Set([p]), captureTimeout: 0 }),
					);
				try {
					Y.applyUpdate(t.doc, e.data, p);
				} catch {
					return false;
				}
				this.stats.updatesIn++;
				this.stats.updateBytesIn += e.data.length;
				if (hasPendingStructs(t.doc)) {
					// The update depends on changes this session never had (a client out of step):
					// it would sit in the document forever. Drop it and have the client rebuild.
					dropPendingStructs(t.doc);
					return false;
				}
			}
		} finally {
			this.stats.applyMs += performance.now() - t0;
		}
		return true;
	}

	/** Text only (`update` frame). */
	handleUpdate(p: Participant, n: number, body: Uint8Array): void {
		if (this.participants.get(p.pno) !== p || p.blocked || this.closed) return;
		if (n <= p.lastTx) return;
		if (!p.canWrite) {
			this.reject(p, n, "read_only");
			return;
		}
		const parsed = this.parseTexts(p, body);
		if (parsed === "stale") {
			this.forceResync(p);
			return;
		}
		// Updates before one that does not integrate stay: the client rebuilds from a snapshot
		// that has them and merges what it typed onto it by text.
		if (!parsed || !this.applyTexts(p, parsed.entries)) {
			this.reject(p, n, "invalid");
			return;
		}
		this.processed(p, n);
		this.noteLost(p, n, parsed.lost);
	}

	private processed(p: Participant, n: number): void {
		p.lastTx = n;
		const added = !this.keys.has(p.key);
		this.keys.delete(p.key);
		this.keys.set(p.key, n);
		this.keysPending.add(p.key);
		if (added && this.keys.size > OUTLINE_LIVE_BOUNDS.clientKeys) this.dropKeys();
		// Acknowledged once the log has it (`persistStep`).
		this.schedulePersist();
	}

	/** Keep the remembered client keys to their bound ({@link OUTLINE_LIVE_BOUNDS.clientKeys}). */
	private dropKeys(): void {
		const present = new Set<string>();
		for (const p of this.participants.values()) present.add(p.key);
		const drop = (key: string) => {
			this.keys.delete(key);
			this.keyAcked.delete(key);
			this.keyDurable.delete(key);
			this.keysPending.delete(key);
		};
		// Least recently used first: absent keys whose client has everything acknowledged.
		for (const [key, tx] of this.keys) {
			if (this.keys.size <= OUTLINE_LIVE_BOUNDS.clientKeys) return;
			if (!present.has(key) && (this.keyAcked.get(key) ?? 0) >= tx) drop(key);
		}
		let forced = 0;
		for (const key of this.keys.keys()) {
			if (this.keys.size <= OUTLINE_LIVE_BOUNDS.clientKeysHard) break;
			if (present.has(key)) continue;
			drop(key);
			forced++;
		}
		if (forced > 0)
			logger.warn("Outline live session dropped unacknowledged client keys", {
				spaceId: this.spaceId,
				count: forced,
			});
	}

	/**
	 * Of each client key, the highest transaction already in the page or the log: what a client
	 * of this session need not replay once the session is gone. `committed`: everything
	 * processed was committed (a clean close).
	 */
	durableKeys(committed: boolean): Map<string, number> {
		return new Map(committed ? this.keys : this.keyDurable);
	}

	private markDirty(id: string, userId: string | null): void {
		// Edited again: worth another try.
		if (this.parked.delete(id)) this.failures.delete(id);
		this.dirty.set(id, userId);
		const now = liveNow();
		if (this.firstDirtyAt === 0) this.firstDirtyAt = now;
		this.lastDirtyAt = now;
		this.scheduleFlush();
	}

	private scheduleFlush(delayMs?: number): void {
		if (this.closed) return;
		if (this.flushTimer) cancelLiveTimer(this.flushTimer);
		const due =
			delayMs !== undefined
				? liveNow() + delayMs
				: Math.min(
						this.lastDirtyAt + OUTLINE_LIVE_TIMING.flushIdleMs,
						this.firstDirtyAt + OUTLINE_LIVE_TIMING.flushMaxMs,
					);
		this.flushTimer = liveTimeout(
			() => {
				this.flushTimer = null;
				this.schedule(async () => {
					await this.flushContent();
				});
			},
			Math.max(0, due - liveNow()),
		);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Committing text
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * The live texts of `ids`, cut to the per-block size limit and normalized (off the main
	 * thread when large). Part 0 is the block's own content; further parts become blocks after
	 * it. A block whose text could not be normalized or written before (`stuck`) is committed as
	 * code blocks, which normalization takes as they are.
	 *
	 * With `fit`, each plan is cut to what one write transaction takes; the cut-off text is kept
	 * in the session (`rest`) and committed by a later flush, so no plan spans two transactions.
	 */
	private async planContents(ids: readonly string[], fit = false): Promise<ContentPlan[]> {
		const cut = ids.map((id) => {
			const text = this.textOf(id);
			const fallback = this.stuck.has(id);
			return { id, text, fallback, parts: fallback ? codeParts(text) : fitBody(text) };
		});
		let normalized: LiveNormalized[] | null = null;
		for (let attempt = 0; ; attempt++) {
			try {
				normalized = await OUTLINE_LIVE_HOOKS.normalize(cut.flatMap((c) => c.parts));
				break;
			} catch (error) {
				// The worker's queue is full: wait a little, a few times.
				if (!isBusyText(error) || attempt >= 2) throw error;
				await liveSleep(100 * (attempt + 1));
			}
		}
		let at = 0;
		return cut.map((c) => {
			const parts = (normalized as LiveNormalized[]).slice(at, at + c.parts.length);
			at += c.parts.length;
			const plan: ContentPlan = { id: c.id, text: c.text, parts };
			if (fit) fitPlan(plan, c.parts);
			return plan;
		});
	}

	/**
	 * Commit the texts of `ids` as `userId`'s commit(s). Plans are written whole, one or more to
	 * a transaction; when a transaction fails, the plans written before it are settled (`done`)
	 * and the rest stay to be committed again. `permanent`: the failure will not go away by
	 * retrying (normalization timed out, the write path refused the content).
	 */
	private async commitTexts(
		ids: string[],
		userId: string | null,
	): Promise<{ ok: boolean; permanent: boolean; done: Set<string> }> {
		const done = new Set<string>();
		const live = ids.filter((id) => this.mirror.alive(id));
		if (live.length === 0) return { ok: true, permanent: false, done };
		let plans: ContentPlan[];
		try {
			plans = await this.planContents(live, true);
		} catch (error) {
			logger.warn("Outline live text could not be normalized", { error: String(error) });
			return { ok: false, permanent: isPermanent(error), done };
		}
		const unwritable = plans.filter((plan) => plan.unwritable);
		if (unwritable.length > 0) {
			// Even its own content and what it splits off do not fit a transaction.
			for (const plan of unwritable) this.stuck.add(plan.id);
			return { ok: false, permanent: true, done };
		}
		const ops: OutlineOp[] = [];
		const canonical: Array<OutlineCanonicalContent | undefined> = [];
		const groups: Array<[number, number]> = [];
		const partIds = new Map<string, string[]>();
		const intents = new Map<string, string>();
		for (const plan of plans) {
			const b = this.mirror.get(plan.id) as MirrorBlock;
			const start = ops.length;
			partIds.set(plan.id, contentOps(plan, b.dbContent, b.parentId, ops, canonical));
			groups.push([start, ops.length]);
			if (ops.length > start) intents.set(plan.id, (plan.parts[0] as LiveNormalized).content);
		}
		if (ops.length === 0) {
			this.settleContents(plans);
			for (const plan of plans) done.add(plan.id);
			// What was typed and taken back is in the log before anything is done on its account.
			await this.persistNow();
			return { ok: true, permanent: false, done };
		}
		// The log learns what is about to be committed first: a crash right after the commit
		// must not merge the committed text with itself on replay.
		if (!(await this.logIntents(intents))) return { ok: false, permanent: false, done };
		const actor = userId
			? { kind: "human" as const, id: userId }
			: { kind: "system" as const, id: "outline-live" };
		let results: OutlineWriteResult[];
		let failure: unknown = null;
		let writtenOps = ops.length;
		try {
			results = await this.writeChunks(ops, canonical, actor, userId, "live edit", groups);
		} catch (error) {
			failure = error instanceof LiveChunkError ? error.cause : error;
			results = error instanceof LiveChunkError ? error.committed : [];
			writtenOps = error instanceof LiveChunkError ? error.committedOps : 0;
		}
		const settled = plans.filter((_, i) => (groups[i] as [number, number])[1] <= writtenOps);
		this.stats.flushCommits += results.filter((r) => r.commit).length;
		this.settleContents(settled);
		if (settled.some(reshapes)) await this.applyOwnResults(results);
		for (const plan of settled) {
			done.add(plan.id);
			if (!plan.rest) this.stuck.delete(plan.id);
			this.carryRest(plan, partIds.get(plan.id) ?? [], userId);
		}
		this.cancelIntents(plans.filter((plan) => !done.has(plan.id)).map((plan) => plan.id));
		// What was committed is the base a replay merges from: logged at once.
		await this.persistNow();
		if (failure) return { ok: false, permanent: isPermanent(failure), done };
		return { ok: true, permanent: false, done };
	}

	/**
	 * Text a plan left for later (`fitPlan`) goes on after the last part it committed, and is
	 * committed by the next flush.
	 */
	private carryRest(plan: ContentPlan, partIds: readonly string[], userId: string | null): void {
		if (!plan.rest) return;
		const lastId = partIds[partIds.length - 1] ?? plan.id;
		const id = this.mirror.get(lastId) ? lastId : plan.id;
		if (!this.hasText(id)) return;
		const rest = plan.rest;
		this.editText(id, (text) => text.insert(text.length, `\n${rest}`));
		this.markDirty(id, userId);
	}

	/**
	 * After committing contents: the mirror holds them, the live texts follow normalization, and
	 * the log records what the database holds (resolving the commit's intents).
	 */
	private settleContents(plans: readonly ContentPlan[]): void {
		for (const plan of plans) {
			const first = plan.parts[0] as LiveNormalized;
			this.setDbContent(plan.id, first.content);
			this.syncPending.set(plan.id, first.content);
			// What was committed differs from the session's text (normalized, or cut at the size
			// limit): bring the text to it, keeping anything typed since.
			if (first.content !== plan.text) this.mergeText(plan.id, plan.text, first.content);
		}
		if (plans.length > 0) this.schedulePersist();
	}

	/** Own commits that created blocks the session did not ask for (split content). */
	private async applyOwnResults(results: readonly OutlineWriteResult[]): Promise<void> {
		for (const r of results) {
			if (!r.commit) continue;
			await this.applyCommits([
				{
					spaceId: this.spaceId,
					commitId: r.commit.id,
					seq: r.commit.seq,
					actorKind: "system",
					actorId: "outline-live",
				},
			]);
		}
	}

	/**
	 * Write operations as one or more commits (the write path's per-transaction limits), as the
	 * session's own writes. `groups` are op ranges kept in one transaction (one plan's
	 * operations); a group larger than a transaction is written over several. Throws
	 * {@link LiveChunkError}: the transactions before the failing one stay committed.
	 */
	private async writeChunks(
		ops: OutlineOp[],
		canonical: Array<OutlineCanonicalContent | undefined>,
		actor: { kind: "human" | "system"; id: string },
		responsible: string | null,
		summary: string,
		groups?: ReadonlyArray<readonly [number, number]>,
		unlockAuthority?: () => Promise<boolean>,
	): Promise<OutlineWriteResult[]> {
		const chunks = planChunks(ops, groups);
		const out: OutlineWriteResult[] = [];
		for (const [a, b] of chunks) {
			try {
				out.push(
					await asOwnLiveWrite(() =>
						OUTLINE_LIVE_HOOKS.write(
							{
								spaceId: this.spaceId,
								ops: ops.slice(a, b),
								actor,
								responsibleUserId: responsible,
								...(summary ? { summary } : {}),
								...(unlockAuthority ? { unlockAuthority } : {}),
							},
							{ canonical: canonical.slice(a, b) },
						),
					),
				);
			} catch (error) {
				logger.warn("Outline live commit failed", {
					spaceId: this.spaceId,
					error: String(error),
					code: (error as { code?: string }).code,
				});
				throw new LiveChunkError(error, out, a);
			}
		}
		return out;
	}

	/** Whether the participant may take away someone else's lock: a manager of the space. */
	private async mayUnlockAnyone(p: Participant): Promise<boolean> {
		const space = await outlineStore.getSpace(this.spaceId);
		return space
			? await canManageSpace({ userId: p.userId, isAdmin: p.socket.isAdmin }, space)
			: false;
	}

	/** Record what the database holds for a block now (logged for replay, see `persistStep`). */
	private setDbContent(id: string, content: string): void {
		const b = this.mirror.get(id);
		if (!b || b.dbContent === content) return;
		// A block's seed text never changes: its document is made from what the database held
		// (and every client was told) before this.
		this.textDoc(id);
		this.mirror.update(id, { dbContent: content });
		this.syncPending.set(id, content);
		this.schedulePersist();
	}

	/** Bring a block's live text from `from` to `to`, keeping changes made since `from`. */
	private mergeText(id: string, from: string, to: string): void {
		if (!this.hasText(id)) return;
		const current = this.textOf(id);
		const r = merge3(from, to, current, { lenient: true });
		if (!r.ok || r.result === current) return;
		this.editText(id, (t) => {
			// Last first, so earlier offsets hold; hunks at one offset in reverse too (an insertion
			// before a deletion there must be applied after it), as `applyHunks` reads them.
			for (const h of [...r.patch].sort((a, b) => a.start - b.start).reverse()) {
				if (h.end > h.start) t.delete(h.start, h.end - h.start);
				if (h.text) t.insert(h.start, h.text);
			}
		});
	}

	/**
	 * Commit every text not committed yet (each person's blocks as their own commit). Runs in
	 * the lane: on the timer, before a write from outside, and when the session closes. Returns
	 * false when some text is still uncommitted.
	 *
	 * A failure that retrying will not cure (normalization timed out on pathological text, the
	 * write path refused it) is narrowed down block by block; a block that fails on its own is
	 * committed as code blocks instead (its text kept as typed), so no text stays uncommitted
	 * forever and no page is locked out.
	 */
	async flushContent(): Promise<boolean> {
		if (this.flushTimer) {
			cancelLiveTimer(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.dirty.size === 0) return true;
		const byUser = new Map<string | null, string[]>();
		for (const [id, user] of this.dirty) {
			const list = byUser.get(user);
			if (list) list.push(id);
			else byUser.set(user, [id]);
		}
		this.dirty.clear();
		this.firstDirtyAt = 0;
		let ok = true;
		const redirty = (ids: readonly string[], user: string | null) => {
			for (const id of ids) if (!this.dirty.has(id)) this.dirty.set(id, user);
		};
		// Narrowing down a permanent failure costs a normalization (up to its timeout) per block:
		// past this budget the blocks not tried alone wait, as they are, for the next flush (at
		// least one is tried per flush, so it gets through them). Those that failed alone go as
		// code from now on, so the next batch does not fail on them again.
		const deadline = liveNow() + OUTLINE_LIVE_TIMING.narrowBudgetMs;
		let tried = 0;
		const giveUp = (id: string, user: string | null) => {
			const n = (this.failures.get(id) ?? 0) + 1;
			this.failures.set(id, n);
			if (n < OUTLINE_LIVE_BOUNDS.maxCommitFailures) {
				ok = false;
				redirty([id], user);
				return;
			}
			// Even as code it does not go in: stop retrying (and stop holding writes from outside
			// back). The text stays live and in the log, which this session keeps at its close;
			// a later edit of the block tries again.
			this.parked.add(id);
			logger.warn("Outline live text cannot be committed; kept in the log", {
				spaceId: this.spaceId,
				blockId: id,
			});
		};
		for (const [user, ids] of byUser) {
			const stuckBefore = new Set(this.stuck);
			const r = await this.commitTexts(ids, user);
			if (r.ok) {
				for (const id of ids) this.failures.delete(id);
				continue;
			}
			const failed = ids.filter((id) => !r.done.has(id));
			for (const id of r.done) this.failures.delete(id);
			if (!r.permanent) {
				ok = false;
				redirty(failed, user);
				continue;
			}
			for (const id of failed) {
				if (tried > 0 && liveNow() >= deadline) {
					// Not tried alone: nothing known against it, so it is neither counted nor fenced.
					ok = false;
					redirty([id], user);
					continue;
				}
				tried++;
				let one = failed.length > 1 ? await this.commitTexts([id], user) : r;
				if (!one.ok && one.permanent && !stuckBefore.has(id)) {
					this.stuck.add(id);
					logger.warn("Outline live text could not be committed; committing it as code", {
						spaceId: this.spaceId,
						blockId: id,
					});
					one = await this.commitTexts([id], user);
				}
				if (one.ok) this.failures.delete(id);
				else if (one.permanent && this.stuck.has(id)) giveUp(id, user);
				else {
					ok = false;
					redirty([id], user);
				}
			}
		}
		if (!ok) {
			this.firstDirtyAt = liveNow();
			this.scheduleFlush(OUTLINE_LIVE_TIMING.flushRetryMs);
		}
		return ok;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Structural transactions
	// ─────────────────────────────────────────────────────────────────────────

	/** A structural transaction (`tx` frame): check, apply, commit, broadcast or refuse. */
	async handleTx(p: Participant, n: number, rawHead: unknown, body: Uint8Array): Promise<void> {
		if (this.participants.get(p.pno) !== p || p.blocked || this.closed) return;
		if (n <= p.lastTx) return;
		if (!p.canWrite) {
			this.reject(p, n, "read_only");
			return;
		}
		const ops = parseOps(rawHead);
		if (!ops) {
			this.reject(p, n, "invalid");
			return;
		}
		const plan = this.planTx(ops);
		if (!plan) {
			this.reject(p, n, "conflict");
			return;
		}
		// A deleted block takes everything under it: never something this transaction does not
		// delete too (someone added under it meanwhile, or the person did not have all of it).
		const keeps = await this.deletesLeaveChildren(plan.ops);
		if (this.participants.get(p.pno) !== p || p.blocked || this.closed) return;
		if (keeps) {
			this.reject(p, n, "children_changed");
			return;
		}
		// Blocks moved into a watched subtree bring what is under them (read before the write:
		// the transaction cannot touch what the session does not hold).
		let under: OutlineBlockRow[] = [];
		const into = this.movedIntoSubtrees(plan.ops);
		if (into.length > 0) {
			const read = await this.readUnder(into.map((x) => x.id));
			if (this.participants.get(p.pno) !== p || p.blocked || this.closed) return;
			const dest = into.flatMap((x) => x.into);
			if (read === "too_large" || (read.length > 0 && !this.fillFits(read, dest, p.userId))) {
				this.reject(p, n, "too_large");
				return;
			}
			under = read;
		}
		const inserted = new Map<string, Extract<LiveOp, { t: "i" }>>();
		for (const op of plan.ops) if (op.t === "i") inserted.set(op.id, op);
		const parsed = this.parseTexts(p, body, new Set(inserted.keys()));
		if (parsed === "stale") {
			this.forceResync(p);
			return;
		}
		if (!parsed) {
			this.reject(p, n, "invalid");
			return;
		}
		const entries = parsed.entries;
		// Text of blocks this transaction deletes is committed first, so their history keeps it.
		// If that fails the transaction is refused: the text stays uncommitted (and marked).
		const doomed = plan.deleted.filter((id) => this.dirty.has(id));
		if (doomed.length > 0) {
			const byUser = new Map<string | null, string[]>();
			for (const id of doomed) {
				const user = this.dirty.get(id) ?? null;
				this.dirty.delete(id);
				byUser.set(user, [...(byUser.get(user) ?? []), id]);
			}
			let failed = false;
			for (const [user, ids] of byUser) {
				const r = await this.commitTexts(ids, user);
				if (r.ok) continue;
				failed = true;
				for (const id of ids) if (!r.done.has(id) && !this.dirty.has(id)) this.markDirty(id, user);
			}
			if (failed) {
				this.reject(p, n, "failed");
				return;
			}
		}

		// The text goes in first (it holds the new blocks' texts) and is undone when the commit
		// fails, so a refused transaction leaves every text as it was. Its log rows are held back
		// until the commit is in or its undo is with them: the log never holds only the change of
		// a transaction the page refused.
		// The log's snapshot must not contain a change that may yet be refused: written first.
		if (!this.snapshotWritten) {
			this.snapshotWanted = true;
			if (!(await this.persistNow())) {
				this.reject(p, n, "failed");
				return;
			}
		}
		const undos: Y.UndoManager[] = [];
		const dropUndos = () => {
			for (const u of undos.splice(0)) u.destroy();
		};
		const mark = this.pendingRows.length;
		let held: PendingRow[] = [];
		const intents = new Map<string, string>();
		const refuse = (
			code: LiveRejectCode,
			committed: readonly OutlineWriteResult[] = [],
			claimed?: LiveClaimedWire,
		) => {
			for (const u of undos) u.undo();
			dropUndos();
			// The refused change and its undo reach the log together (one append): the documents
			// keep the items of both, and later updates may name them.
			this.pendingRows = [...held, ...this.pendingRows];
			held = [];
			this.schedulePersist();
			this.cancelIntents(intents.keys());
			this.reject(p, n, code, claimed);
			return committed;
		};
		// While the transaction's change is held back, no snapshot of the document (a
		// compaction) may be written: it would carry the change into the log.
		this.holding++;
		try {
			this.touched = new Set();
			let touched: Set<string>;
			try {
				const integrated = this.applyTexts(p, entries, undos, this.showersOf(plan.ops));
				touched = this.touched;
				held = this.pendingRows.splice(mark);
				if (!integrated) {
					refuse("invalid");
					return;
				}
			} finally {
				this.touched = null;
			}
			const deleted = new Set(plan.deleted);
			const updated = [...touched].filter(
				(id) => !inserted.has(id) && !deleted.has(id) && this.mirror.alive(id),
			);
			let contents: ContentPlan[];
			try {
				contents = await this.planContents([...inserted.keys(), ...updated]);
			} catch {
				refuse("failed");
				return;
			}
			const byId = new Map(contents.map((c) => [c.id, c]));
			const { ops: writeOps, canonical, opOf } = this.writeOpsOf(plan.ops, byId, inserted);
			for (const c of contents) {
				const b = this.mirror.get(c.id);
				const first = c.parts[0] as LiveNormalized;
				if (b && first.content !== b.dbContent) intents.set(c.id, first.content);
			}
			let results: OutlineWriteResult[] = [];
			if (writeOps.length > 0) {
				if (!(await this.logIntents(intents))) {
					refuse("failed");
					return;
				}
				try {
					results = await this.writeChunks(
						writeOps,
						canonical,
						{ kind: "human", id: p.userId },
						p.userId,
						"",
						undefined,
						// Taking a lock away (the locked task's checkbox, the task itself) needs the
						// right to unlock: the locker, a manager of the space, an admin (review S-4).
						async () => await this.mayUnlockAnyone(p),
					);
				} catch (error) {
					const cause = error instanceof LiveChunkError ? error.cause : error;
					// A task someone else is doing: the refusal says who, for the editor to show.
					const claimed =
						cause instanceof OutlineTaskClaimedError ? await claimedWire(cause) : undefined;
					const committed = refuse(
						isConflict(cause) ? "conflict" : "failed",
						error instanceof LiveChunkError ? error.committed : [],
						claimed,
					);
					// Part of it was written (a large paste over several transactions): the session
					// takes what the page now holds, as it would a write from outside.
					if (committed.length > 0) await this.applyOwnResults(committed);
					await this.persistNow();
					return;
				}
			}
			// The update and what follows from it reach the log in order.
			this.pendingRows = [...held, ...this.pendingRows];
			held = [];
			dropUndos();
			this.stats.txCommitted++;
			// The texts this commit wrote are settled, whoever typed them.
			for (const c of contents) this.dirty.delete(c.id);

			// The mirror follows what was written; each audience is sent, in canonical form, what
			// the transaction changed in what it shows.
			const written = results.flatMap((r) => r.results);
			const touchedIds = this.touchOrder(plan.ops);
			const before = this.showingOfAll(touchedIds);
			const movedIds = new Set<string>();
			const taskIds = new Set<string>();
			const ended = new Set<LiveView>();
			for (const op of plan.ops) {
				const at = opOf.get(op);
				const r = at === undefined ? undefined : written[at];
				const adjusted = r?.adjustments?.find((x) => x.kind === "order-key-moved");
				const key =
					adjusted?.kind === "order-key-moved"
						? adjusted.got
						: op.t === "i" || op.t === "m"
							? op.k
							: "";
				switch (op.t) {
					case "i": {
						const prior = this.mirror.get(op.id);
						const taskJson: OutlineTaskJson | null =
							op.task === undefined
								? prior?.deleted
									? prior.taskJson
									: null
								: op.task
									? { status: LIVE_STATUS_OF_TASK[op.task], assignee: null }
									: null;
						// A restored question is still one (review S9: undoing its delete brings the
						// question back, and its checkbox stays refused). A client cannot make one.
						const question = prior?.question === true;
						this.mirror.put({
							id: op.id,
							sid: r?.sid ?? prior?.sid ?? "",
							parentId: op.p,
							orderKey: key,
							taskJson,
							question,
							deleted: false,
							dbContent: prior?.dbContent ?? "",
							gen: prior?.gen ?? 0,
							// A new block's text is with its maker's watches; `route` sends it to
							// other watches if that is where the block is.
							held: prior?.held ?? this.orphanHeld.get(op.id) ?? HELD_BY_NOBODY,
						});
						this.orphanHeld.delete(op.id);
						break;
					}
					case "m": {
						const b = this.mirror.get(op.id);
						// A watched subtree whose root moves ends (its watchers watch it again).
						if (b && b.parentId !== op.p) {
							const view = this.subtreeViews.get(op.id);
							if (view) ended.add(view);
						}
						this.mirror.update(op.id, { parentId: op.p, orderKey: key });
						movedIds.add(op.id);
						break;
					}
					case "d": {
						const gone = this.mirror.subtree(op.id);
						for (const id of gone) {
							this.mirror.update(id, { deleted: true });
							const sub = this.subtreeViews.get(id);
							if (sub) ended.add(sub);
							const level = this.levelViews.get(id);
							if (level) ended.add(level);
						}
						break;
					}
					case "k": {
						const b = this.mirror.get(op.id);
						this.mirror.update(op.id, {
							taskJson: op.task
								? { ...(b?.taskJson ?? { assignee: null }), status: LIVE_STATUS_OF_TASK[op.task] }
								: null,
						});
						taskIds.add(op.id);
						break;
					}
				}
			}
			const filled = this.putUnder(under);
			this.settleContents(contents);
			this.processed(p, n);
			this.noteLost(p, n, parsed.lost);
			const changes = this.changesOf([...touchedIds, ...filled], before, movedIds, taskIds);
			this.carried(movedIds);
			if (changes.length > 0) {
				const o = ++this.opSeq;
				const routed = this.route(changes, o, p.pno);
				for (const [audience, list] of routed)
					this.recordCommit(audience, { o, by: p.pno, ops: list });
				// What the transaction came to in what its author shows (nothing, when it only
				// changed what others watch).
				const own = routed.get(p.audience) ?? [];
				const acks = this.windowAcks.get(p.pno) ?? [];
				acks.push(sameOps(own, ops) ? [n, o] : [n, o, own]);
				this.windowAcks.set(p.pno, acks);
			}
			for (const view of ended) this.endView(view);
			if (contents.some(reshapes)) await this.applyOwnResults(results);
			// In the log now: acknowledged with the next broadcast.
			await this.persistNow();
			this.scheduleBroadcast();
		} finally {
			// Left here only by something unexpected thrown above: the text is taken back, and
			// the rows held back (a new document's seed among them) still reach the log.
			for (const u of undos) u.undo();
			dropUndos();
			if (held.length > 0) {
				this.pendingRows = [...held, ...this.pendingRows];
				this.schedulePersist();
			}
			this.holding--;
		}
	}

	/**
	 * The one place a watch's watchers are shown a block (every insert an audience is sent passes
	 * here): unless the watch holds its text already, its watchers are sent it whole and it holds
	 * it from now on, and a client resuming from before batch `o` is sent it too. Whatever path
	 * brought the block there (made, restored, moved in from elsewhere, alone or under its parent,
	 * read from the database), its text cannot be missing or stale for them.
	 */
	private tell(id: string, view: LiveView, o: number): void {
		const b = this.mirror.get(id);
		if (!b || b.held.includes(view)) return;
		this.holdAlso(id, view);
		this.seededAt.set(id, o);
		const e = this.wholeText(id);
		if (!e) return;
		this.windowUpdates.push({ from: 0, only: view, ...e });
		this.scheduleBroadcast();
	}

	/**
	 * The blocks a list of operations touches, in the order it touches them (each once): an
	 * inserted or checked block, a moved block with its live subtree, every live block a delete
	 * takes. Read before the operations are applied.
	 */
	private touchOrder(ops: readonly LiveOp[]): string[] {
		const out: string[] = [];
		const seen = new Set<string>();
		const add = (id: string) => {
			if (seen.has(id)) return;
			seen.add(id);
			out.push(id);
		};
		for (const op of ops) {
			if (op.t === "i" || op.t === "k") add(op.id);
			else if (this.mirror.alive(op.id)) for (const id of this.mirror.subtree(op.id)) add(id);
			else add(op.id);
		}
		return out;
	}

	/**
	 * Of each block a list of operations inserts: the watches that will show it (the level of its
	 * parent, the subtrees showing its parent; a parent inserted before it by the same list counts
	 * as it will be).
	 */
	private showersOf(ops: readonly LiveOp[]): Map<string, LiveView[]> {
		const out = new Map<string, LiveView[]>();
		for (const op of ops) {
			if (op.t !== "i" || this.mirror.get(op.id)) continue;
			const views: LiveView[] = [];
			const level = this.levelViews.get(parentKeyOf(op.p));
			if (level) views.push(level);
			if (op.p !== null)
				for (const v of out.get(op.p) ?? this.showingViews(op.p)) if (v.kind === "s") views.push(v);
			out.set(op.id, views);
		}
		return out;
	}

	/** The watches showing each block, now. */
	private showingOfAll(ids: readonly string[]): Map<string, readonly LiveView[]> {
		const out = new Map<string, readonly LiveView[]>();
		for (const id of ids) out.set(id, this.showingViews(id));
		return out;
	}

	/**
	 * What a batch did to each block it touched, block by block, in the order touched: shown by
	 * which watches before and after, moved, checked. A watch that no longer covers a live block
	 * that left it stops holding its text (a deleted block it covers it keeps: undoing a delete).
	 */
	private changesOf(
		ids: readonly string[],
		before: ReadonlyMap<string, readonly LiveView[]>,
		moved: ReadonlySet<string>,
		tasks: ReadonlySet<string>,
	): BlockChange[] {
		const out: BlockChange[] = [];
		for (const id of ids) {
			const was = before.get(id) ?? [];
			const now = this.showingViews(id);
			const isMoved = moved.has(id);
			const isTask = tasks.has(id);
			if (was.length === 0 && now.length === 0) continue;
			if (!isMoved && !isTask && was.length === now.length && was.every((v) => now.includes(v)))
				continue;
			for (const v of was) {
				if (now.includes(v)) continue;
				if (!this.coveringViews(id).includes(v)) this.holdNoMore(id, v);
			}
			out.push({ id, before: was, after: now, moved: isMoved, task: isTask });
		}
		return out;
	}

	/**
	 * Deleted blocks that went along with moved blocks: a watch that no longer covers one is told
	 * nothing more of it (nobody holds its text until it is brought back somewhere).
	 */
	private carried(moved: Iterable<string>): void {
		for (const x of moved)
			for (const id of this.mirror.subtreeAll(x)) {
				const b = this.mirror.get(id);
				if (!b?.deleted || b.held.length === 0) continue;
				const covering = this.coveringViews(id);
				for (const v of b.held) if (!covering.includes(v as LiveView)) this.holdNoMore(id, v);
			}
	}

	/**
	 * Cut a batch of structural changes (already in the mirror) to each audience: for each block,
	 * what the audience's watches showed of it before and show after. Shown before and after: a
	 * move (when it moved) and its checkbox (when it changed); only after: an insert (its text is
	 * sent whole to every watch that did not hold it, `tell`); only before: a delete. Inserts go
	 * first (parents first), then moves, checkboxes, deletes. Audiences shown nothing of it get
	 * nothing. `by`: a participant's batch (a person's checkbox or delete may end a task an
	 * agent's cursor is on).
	 */
	private route(
		changes: readonly BlockChange[],
		o: number,
		by: LiveActor,
	): Map<Audience, LiveOp[]> {
		const touched = new Set<LiveView>();
		const agentsAsk = new Set<LiveView>();
		for (const c of changes) {
			for (const v of c.after) if (!c.before.includes(v)) this.tell(c.id, v, o);
			for (const v of c.before) touched.add(v);
			for (const v of c.after) touched.add(v);
			if (typeof by === "number" && (c.task || c.after.length < c.before.length))
				for (const v of c.before) if (v.agents.size > 0) agentsAsk.add(v);
		}
		for (const v of agentsAsk) v.requestAgents();
		const out = new Map<Audience, LiveOp[]>();
		for (const a of this.audiences.values()) {
			if (!a.views.some((v) => touched.has(v))) continue;
			const inserts: LiveOp[] = [];
			const moves: LiveOp[] = [];
			const tasks: LiveOp[] = [];
			const deletes: LiveOp[] = [];
			for (const c of changes) {
				const was = c.before.some((v) => a.views.includes(v));
				const now = c.after.some((v) => a.views.includes(v));
				const b = this.mirror.get(c.id);
				if (!b) {
					if (was) deletes.push({ t: "d", id: c.id });
					continue;
				}
				if (was && now) {
					if (c.moved) moves.push({ t: "m", id: c.id, p: b.parentId, k: b.orderKey });
					if (c.task) tasks.push({ t: "k", id: c.id, task: taskCharOf(b.taskJson) });
				} else if (now) {
					inserts.push({
						t: "i",
						id: c.id,
						p: b.parentId,
						k: b.orderKey,
						task: taskCharOf(b.taskJson),
						...(b.question ? { q: true as const } : {}),
					});
				} else if (was) deletes.push({ t: "d", id: c.id });
			}
			const ops = [...inserts, ...moves, ...tasks, ...deletes];
			if (ops.length > 0) out.set(a, ops);
		}
		return out;
	}

	private recordCommit(audience: Audience, commit: LiveCommitWire): void {
		this.windowCommits.push({ audience: audience.key, wire: commit });
		this.opLog.push({ audience: audience.key, wire: commit });
		while (this.opLog.length > OUTLINE_LIVE_BOUNDS.opLog) {
			const gone = this.opLog.shift() as ScopedCommit;
			this.opDropped.set(gone.audience, gone.wire.o);
		}
		this.scheduleBroadcast();
	}

	/**
	 * Check a transaction against the mirror, as if applied in order. Returns the operations to
	 * write (deletes of blocks inside a block deleted by the same transaction dropped) and the
	 * blocks it deletes, or null when it does not fit the current structure. A block may be put
	 * only under a parent whose every live child the session holds (`isLoaded`; the top level
	 * while someone watches it). Top-level blocks are blocks like any other.
	 */
	private planTx(ops: LiveOp[]): { ops: LiveOp[]; deleted: string[] } | null {
		const overlay = new Map<string, { parentId: string | null; deleted: boolean }>();
		const parentOf = (id: string): string | null | undefined =>
			overlay.has(id) ? overlay.get(id)?.parentId : this.mirror.get(id)?.parentId;
		const known = (id: string): boolean => overlay.has(id) || this.mirror.get(id) !== undefined;
		/** Every live child of the parent is here: a block may be put under it. */
		const open = (id: string | null): boolean =>
			id === null ? this.isLoaded(null) : overlay.has(id) || this.isLoaded(id);
		const alive = (id: string): boolean => {
			let cur: string | null | undefined = id;
			for (let guard = 0; cur && guard < 10_000; guard++) {
				const deleted = overlay.has(cur)
					? overlay.get(cur)?.deleted
					: this.mirror.get(cur)?.deleted;
				if (deleted !== false) return false;
				// Up to a block a watch stands on, or the top level: what is loaded is live there.
				if (!overlay.has(cur) && this.isAnchor(cur)) return true;
				const parent = parentOf(cur);
				if (parent === null) return true;
				cur = parent;
			}
			return false;
		};
		const isWithin = (candidate: string, root: string): boolean => {
			let cur: string | null | undefined = candidate;
			for (let guard = 0; cur && guard < 10_000; guard++) {
				if (cur === root) return true;
				cur = parentOf(cur);
			}
			return false;
		};
		const out: LiveOp[] = [];
		const deleted: string[] = [];
		for (const op of ops) {
			switch (op.t) {
				case "i": {
					if (!CLIENT_ID_RE.test(op.id) || (op.p !== null && !alive(op.p)) || !open(op.p))
						return null;
					if (known(op.id) && alive(op.id)) return null;
					overlay.set(op.id, { parentId: op.p, deleted: false });
					out.push(op);
					break;
				}
				case "m": {
					if (!alive(op.id) || (op.p !== null && !alive(op.p)) || !open(op.p)) return null;
					if (op.p !== null && isWithin(op.p, op.id)) return null;
					overlay.set(op.id, { parentId: op.p, deleted: false });
					out.push(op);
					break;
				}
				case "d": {
					if (!known(op.id)) return null;
					// Inside a block this transaction already deleted: gone with it.
					if (!alive(op.id)) {
						if (deleted.some((d) => isWithin(op.id, d))) break;
						return null;
					}
					overlay.set(op.id, { parentId: parentOf(op.id) ?? null, deleted: true });
					deleted.push(op.id);
					out.push(op);
					break;
				}
				case "k": {
					// A question is not a task: its checkbox is refused (it is answered in the inbox).
					if (!alive(op.id) || this.mirror.get(op.id)?.question) return null;
					out.push(op);
					break;
				}
			}
		}
		// Every block a delete takes, for the text committed beforehand.
		const all = new Set<string>();
		for (const d of deleted) {
			if (this.mirror.get(d)) for (const id of this.mirror.subtree(d)) all.add(id);
			else all.add(d);
		}
		return { ops: out, deleted: [...all] };
	}

	/** The write path's operations for a checked transaction, and where each of its ops went. */
	private writeOpsOf(
		ops: readonly LiveOp[],
		contents: ReadonlyMap<string, ContentPlan>,
		inserted: ReadonlyMap<string, Extract<LiveOp, { t: "i" }>>,
	): {
		ops: OutlineOp[];
		canonical: Array<OutlineCanonicalContent | undefined>;
		opOf: Map<LiveOp, number>;
	} {
		const out: OutlineOp[] = [];
		const canonical: Array<OutlineCanonicalContent | undefined> = [];
		const opOf = new Map<LiveOp, number>();
		for (const op of ops) {
			opOf.set(op, out.length);
			switch (op.t) {
				case "i": {
					const first = contents.get(op.id)?.parts[0] as LiveNormalized;
					const task = op.task ? { status: LIVE_STATUS_OF_TASK[op.task] } : null;
					if (this.mirror.get(op.id)?.deleted) {
						out.push({
							op: "restore",
							block: { id: op.id },
							parent: op.p === null ? null : { id: op.p },
							position: { orderKey: op.k },
							content: first.content,
							...(op.task !== undefined ? { task } : {}),
						});
					} else {
						out.push({
							op: "insert",
							id: op.id,
							parent: op.p === null ? null : { id: op.p },
							position: { orderKey: op.k },
							content: first.content,
							task,
						});
					}
					canonical.push({ content: first.content, links: first.links });
					break;
				}
				case "m":
					out.push({
						op: "move",
						block: { id: op.id },
						parent: op.p === null ? null : { id: op.p },
						position: { orderKey: op.k },
					});
					canonical.push(undefined);
					break;
				case "d":
					out.push({ op: "delete", block: { id: op.id } });
					canonical.push(undefined);
					break;
				case "k":
					out.push({
						op: "setTask",
						block: { id: op.id },
						task: op.task ? { status: LIVE_STATUS_OF_TASK[op.task] } : null,
					});
					canonical.push(undefined);
					break;
			}
		}
		// Text the same keystroke changed in existing blocks (the first half of a split block),
		// split-off structure and parts past the size limit.
		for (const plan of contents.values()) {
			const insert = inserted.get(plan.id);
			if (insert) contentOps(plan, null, insert.p, out, canonical);
			else {
				const b = this.mirror.get(plan.id) as MirrorBlock;
				contentOps(plan, b.dbContent, b.parentId, out, canonical);
			}
		}
		return { ops: out, canonical, opOf };
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Commits from outside the session
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Push commits made outside the session (an agent's, a revert, split blocks) into it: read
	 * the block versions each commit opened (by commit, one indexed read), update the mirror,
	 * merge changed content into the live texts, and route the structural part by watch. A commit
	 * whose changed parents and blocks (`changes`, H2) touch nothing loaded is not read.
	 */
	async applyCommits(commits: readonly CommittedEvent[]): Promise<void> {
		for (const commit of commits) {
			if (this.closed) return;
			if (!this.concerns(commit)) continue;
			const versions = await outlineStore.listCommitVersions(
				commit.commitId,
				OUTLINE_LIMITS.maxRowsTouched + 1,
			);
			const touched = await this.applyVersions(versions, actorOf(commit));
			// An agent wrote here (or the system for one): its cursor is on what it wrote. Any other
			// commit that changed tasks may have ended or handed over one an agent holds.
			// A person's commit made for a session (a plan locked for it) is the person's, not the
			// session's work here.
			for (const view of touched) {
				if (view.gone) continue;
				if (commit.narratorId && commit.actorKind !== "human") {
					view.noteAgentWrite(commit.narratorId, versions);
					view.requestAgents();
				} else if (
					view.agents.size > 0 &&
					versions.some((v) => v.deleted || v.changeFlags & OUTLINE_CHANGE.TASK)
				)
					view.requestAgents();
			}
		}
	}

	/**
	 * Whether a commit can touch what the session holds: a block it changed is in the mirror, or a
	 * parent whose children it changed is loaded (the space's id: the top level). Without
	 * `changes`, or when they were cut short, it may.
	 */
	private concerns(commit: CommittedEvent): boolean {
		const c = commit.changes;
		if (!c || c.truncated) return this.scopes.size > 0;
		for (const id of c.blockIds) if (this.mirror.get(id)) return true;
		for (const key of c.parentKeys)
			if (this.isLoaded(key === this.spaceId ? null : key)) return true;
		return false;
	}

	/**
	 * Take the block versions one commit opened into the mirror and tell each audience what
	 * changed in what it shows. Where a block is after the commit decides: under a parent a watch
	 * covers (a loaded level, a subtree), or not (deleted, or moved where nobody watches: the
	 * same to the people here; its text is committed, the write waited for that). Returns the
	 * watches the commit touched.
	 */
	private async applyVersions(
		versions: OutlineVersionRow[],
		by: LiveActor,
	): Promise<Set<LiveView>> {
		const next = new Map<string, OutlineVersionRow>();
		for (const v of versions) next.set(v.blockId, v);
		// Watches the commit ends: a subtree whose root it deletes or moves, a level whose parent
		// it deletes.
		const ended = new Set<LiveView>();
		for (const v of versions) {
			const m = this.mirror.get(v.blockId);
			const sub = this.subtreeViews.get(v.blockId);
			if (sub && (v.deleted || (m !== undefined && m.parentId !== v.parentId))) ended.add(sub);
			const level = this.levelViews.get(v.blockId);
			if (level && v.deleted) ended.add(level);
		}
		const lasting = (v: LiveView | undefined) => v !== undefined && !ended.has(v);
		// Blocks no subtree held before the commit: what is under them may be missing here.
		const wasUnder = new Map<string, boolean>();
		for (const v of versions)
			if (this.mirror.get(v.blockId)) wasUnder.set(v.blockId, this.underSubtree(v.blockId));
		const parentAfter = (id: string): string | null | undefined =>
			next.has(id) ? (next.get(id) as OutlineVersionRow).parentId : this.mirror.get(id)?.parentId;
		/** Covered by a watch that lasts, with the commit's parents. */
		const inArea = (id: string): boolean => {
			if (lasting(this.levelViews.get(id))) return true;
			let cur: string | null | undefined = id;
			for (let guard = 0; cur && guard < 10_000; guard++) {
				if (lasting(this.subtreeViews.get(cur))) return true;
				const parent = parentAfter(cur);
				if (parent === undefined) return false;
				if (lasting(this.levelViews.get(parentKeyOf(parent)))) return true;
				cur = parent;
			}
			return false;
		};
		// What was shown before: the commit's blocks the mirror holds, each with its live subtree
		// (what moves or goes with it), parents first.
		const held = versions
			.filter((v) => this.mirror.get(v.blockId) !== undefined)
			.sort((a, b) => this.mirror.depth(a.blockId) - this.mirror.depth(b.blockId));
		const order: string[] = [];
		const seen = new Set<string>();
		for (const v of held)
			for (const id of this.mirror.alive(v.blockId) ? this.mirror.subtree(v.blockId) : [v.blockId])
				if (!seen.has(id)) {
					seen.add(id);
					order.push(id);
				}
		const before = this.showingOfAll(order);
		const moved = new Set<string>();
		const tasks = new Set<string>();
		const leaving: string[] = [];
		const created: OutlineVersionRow[] = [];
		for (const v of versions) {
			const m = this.mirror.get(v.blockId);
			const stays = !v.deleted && inArea(v.blockId);
			if (!m || m.deleted) {
				if (stays) created.push(v);
				continue;
			}
			if (v.deleted) {
				// Its live subtree goes with it (the write path writes a tombstone of each today).
				for (const id of this.mirror.subtree(v.blockId)) this.mirror.update(id, { deleted: true });
				continue;
			}
			if (m.parentId !== v.parentId || m.orderKey !== v.orderKey) {
				this.mirror.update(v.blockId, { parentId: v.parentId, orderKey: v.orderKey });
				moved.add(v.blockId);
			}
			if (!stays) {
				leaving.push(v.blockId);
				continue;
			}
			if (taskCharOf(v.taskJson) !== taskCharOf(m.taskJson)) tasks.add(v.blockId);
			if (JSON.stringify(v.taskJson) !== JSON.stringify(m.taskJson))
				this.mirror.update(v.blockId, { taskJson: v.taskJson });
			if ((v.askJson !== null) !== (m.question === true))
				this.mirror.update(v.blockId, { question: v.askJson !== null });
			if (v.content !== null && v.content !== m.dbContent) {
				this.mergeText(v.blockId, m.dbContent, v.content);
				this.setDbContent(v.blockId, v.content);
			}
		}
		// Moved where no lasting watch covers it: it lives on there, and nobody here holds its text
		// any more (typing still on its way into it is told back as not taken, `parseTexts`). Its
		// document ends here too (its text is committed: the write waited for that): what a client
		// still types into its copy is not taken, so that copy is no longer the block's document,
		// and whoever is shown the block again is given a later generation of it. What a watch of
		// its own covers stays (a subtree watched inside it).
		for (const x of leaving)
			for (const id of this.mirror.subtreeAll(x)) {
				const b = this.mirror.get(id);
				if (!b || this.coveringViews(id).some((v) => !ended.has(v))) continue;
				if (b.deleted && b.held.length === 0) continue;
				this.destroyDoc(id);
				this.mirror.update(id, { deleted: true, held: HELD_BY_NOBODY, gen: ++this.era });
			}
		const fresh: string[] = [];
		if (created.length > 0) {
			const sids = new Map(
				(
					await outlineStore.getBlockMetas(this.spaceId, { ids: created.map((v) => v.blockId) })
				).map((m) => [m.id, m.sid]),
			);
			// Parents before children (as the commit leaves them).
			const depthAfter = (id: string) => {
				let d = 0;
				for (let cur = parentAfter(id); cur && d < 10_000; cur = parentAfter(cur)) d++;
				return d;
			};
			const ordered = [...created].sort(
				(a, b) =>
					depthAfter(a.blockId) - depthAfter(b.blockId) || compareOrderKeys(a.orderKey, b.orderKey),
			);
			for (const v of ordered) {
				const prior = this.mirror.get(v.blockId);
				const content = v.content ?? "";
				// A block the session has a text for (deleted here and now restored, or left by a
				// refused insert) keeps its document, or gets one from the text everyone holds for
				// it, and takes the content as a change; a new one is plain text, told to everyone.
				const known = this.hasText(v.blockId);
				if (known && this.textOf(v.blockId) !== content) {
					this.editText(v.blockId, (t) => {
						t.delete(0, t.length);
						t.insert(0, content);
					});
				}
				this.mirror.put({
					id: v.blockId,
					sid: sids.get(v.blockId) ?? prior?.sid ?? "",
					parentId: v.parentId,
					orderKey: v.orderKey,
					taskJson: v.taskJson,
					question: v.askJson !== null,
					deleted: false,
					dbContent: content,
					// A block new to the session is of the generation the session is at: its text
					// always goes out with it then (`wholeText`).
					gen: prior?.gen ?? this.era,
					// Whoever held it before still does; `route` sends its text to the watches it
					// is in now when they are not the ones (`tell`).
					held: prior?.held ?? this.orphanHeld.get(v.blockId) ?? HELD_BY_NOBODY,
				});
				this.orphanHeld.delete(v.blockId);
				this.syncPending.set(v.blockId, content);
				if (!seen.has(v.blockId)) {
					seen.add(v.blockId);
					fresh.push(v.blockId);
				}
			}
		}
		// Blocks it brought into a lasting subtree from where no subtree held them bring what is
		// under them (a move within one page writes no version of the blocks under the moved one).
		const intoSubtree = (id: string): LiveView[] => {
			const out: LiveView[] = [];
			let cur = this.mirror.get(id)?.parentId ?? null;
			for (let guard = 0; cur !== null && guard < 10_000; guard++) {
				const sub = this.subtreeViews.get(cur);
				if (lasting(sub)) out.push(sub as LiveView);
				cur = this.mirror.get(cur)?.parentId ?? null;
			}
			return out;
		};
		const roots: string[] = [];
		for (const id of [...moved, ...fresh]) {
			if (wasUnder.get(id) === true || !this.mirror.alive(id) || roots.includes(id)) continue;
			if (intoSubtree(id).length > 0) roots.push(id);
		}
		let filled: string[] = [];
		if (roots.length > 0) {
			const read = await this.readUnder(roots);
			// More than one watch takes, or than the space or the process holds: the subtrees it
			// went into end (their watchers watch again and are told why).
			const into = roots.flatMap(intoSubtree);
			if (read === "too_large" || !this.fillFits(read, into)) for (const v of into) ended.add(v);
			else filled = this.putUnder(read);
		}
		const changes = this.changesOf([...fresh, ...order, ...filled], before, moved, tasks);
		this.carried([...moved]);
		const touched = new Set<LiveView>();
		for (const c of changes) for (const v of [...c.before, ...c.after]) touched.add(v);
		for (const v of versions) for (const view of this.showingViews(v.blockId)) touched.add(view);
		if (changes.length > 0) {
			const o = ++this.opSeq;
			for (const [audience, ops] of this.route(changes, o, by))
				this.recordCommit(audience, { o, by, ops });
		}
		for (const view of ended) this.endView(view);
		return touched;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Persistence
	// ─────────────────────────────────────────────────────────────────────────

	private schedulePersist(): void {
		if (this.persistTimer || this.closed) return;
		this.persistTimer = liveTimeout(() => {
			this.persistTimer = null;
			void this.persistNow();
		}, OUTLINE_LIVE_TIMING.persistMs);
	}

	/**
	 * Append what arrived since the last append (a snapshot the first time). Resolves to whether
	 * everything up to the call is in the log.
	 */
	persistNow(): Promise<boolean> {
		if (this.persistTimer) {
			cancelLiveTimer(this.persistTimer);
			this.persistTimer = null;
		}
		const step = this.persistChain.then(() => this.persistStep());
		this.persistChain = step.then(
			() => {},
			() => {},
		);
		return step.then(
			() => true,
			(error) => {
				logger.warn("Outline live log append failed", {
					spaceId: this.spaceId,
					error: String(error),
				});
				return false;
			},
		);
	}

	/**
	 * One append. The log of an epoch is: a snapshot of every text document, then increments
	 * (per actor, each block's updates merged; the seed texts of documents made since the last
	 * append in a row of their own before them), all in the format of {@link encodeLogTexts}, and
	 * "sync" rows (JSON, see `encodeSyncRow`): what the database held for blocks whose content it
	 * changed (`b`, a commit of typed text, a write from outside), commits about to be written
	 * (`i`, the content they will give a block) and intents whose commit did not happen (`x`),
	 * and per client key the highest transaction in the log (`k`). Replay merges three ways: from
	 * the last synced content, to the final text, onto what the database holds then, so a write
	 * from outside the session had not logged yet is kept, not overwritten; a block whose last
	 * intent is unresolved and whose database content equals it was committed (`replay.ts`).
	 *
	 * After an append the transactions it covers are acknowledged to their clients.
	 */
	private async persistStep(): Promise<void> {
		const pending = this.pendingRows;
		if (
			!(this.snapshotWanted && !this.snapshotWritten) &&
			pending.length === 0 &&
			this.syncPending.size === 0 &&
			this.intentPending.size === 0 &&
			this.cancelPending.size === 0 &&
			this.keysPending.size === 0 &&
			this.lostPending.size === 0
		)
			return;
		this.pendingRows = [];
		const now = new Date().toISOString();
		const row: LogRowMaker = (data, actorKind, actorId) => ({
			spaceId: this.spaceId,
			epoch: this.epoch,
			seq: this.logSeq++,
			updateB64: Buffer.from(data).toString("base64"),
			actorKind,
			actorId,
			createdAt: now,
		});
		const textRow = (
			entries: readonly LiveTextEntry[],
			actorKind: "human" | "system",
			actorId: string,
		) => row(encodeLogTexts(entries), actorKind, actorId);
		const rows: OutlineLiveLogRow[] = [];
		const sync = new Map(this.syncPending);
		const intents = new Map(this.intentPending);
		const cancels = new Set(this.cancelPending);
		// Every transaction processed so far has its update in `pending` (or the snapshot).
		const keys = new Map<string, number>();
		for (const key of this.keysPending) {
			const tx = this.keys.get(key);
			if (tx !== undefined) keys.set(key, tx);
		}
		this.keysPending.clear();
		// What was not taken of those transactions goes in the same row as how far they reached:
		// a client told after a crash that a transaction is in the space is told this too.
		const lost = new Map<string, LiveLostWire[]>();
		for (const key of this.lostPending) lost.set(key, [...(this.keyLost.get(key) ?? [])]);
		this.lostPending.clear();
		let snapshot = false;
		if (!this.snapshotWritten) {
			// Every document whole first: later increments build on the items they hold. Blocks
			// whose text is already ahead of the database get their database content synced.
			rows.push(row(this.logSnapshot(), "system", LIVE_LOG_ACTOR));
			snapshot = true;
			for (const b of this.mirror.all()) {
				if (!b.deleted && this.textOf(b.id) !== b.dbContent && !sync.has(b.id))
					sync.set(b.id, b.dbContent);
			}
		} else {
			// A block's rows keep the order they came in: a drop of its document cuts the rows
			// into stretches, and nothing of a stretch is written across it. Within a stretch,
			// seed texts first, whoever's update made the document (an update needs its seed),
			// then each actor's updates, a block's merged into one.
			let stretch: PendingRow[] = [];
			let drops: PendingRow[] = [];
			const endStretch = () => {
				if (stretch.length === 0) return;
				const seeds = stretch.filter((r) => r.kind === LIVE_TEXT_KIND.seed);
				if (seeds.length > 0) rows.push(textRow(seeds, "system", LIVE_LOG_ACTOR));
				const byActor = new Map<string, PendingRow[]>();
				for (const r of stretch) {
					if (r.kind === LIVE_TEXT_KIND.seed) continue;
					const key = `${r.actorKind}\u0000${r.actorId}`;
					const list = byActor.get(key);
					if (list) list.push(r);
					else byActor.set(key, [r]);
				}
				for (const list of byActor.values()) {
					const first = list[0] as PendingRow;
					rows.push(textRow(mergeTexts(list), first.actorKind, first.actorId));
				}
				stretch = [];
			};
			const endDrops = () => {
				if (drops.length > 0) rows.push(textRow(drops, "system", LIVE_LOG_ACTOR));
				drops = [];
			};
			for (const r of pending) {
				if (r.kind === LIVE_TEXT_KIND.drop) {
					endStretch();
					drops.push(r);
				} else {
					endDrops();
					stretch.push(r);
				}
			}
			endStretch();
			endDrops();
		}
		if (sync.size > 0 || intents.size > 0 || cancels.size > 0 || keys.size > 0 || lost.size > 0)
			rows.push(row(encodeSyncRow(sync, intents, cancels, keys, lost), "system", LIVE_SYNC_ACTOR));
		try {
			await outlineStore.appendLiveLog(rows);
		} catch (error) {
			// Kept for the next attempt (the seq numbers drawn stay unused).
			this.pendingRows = [...pending, ...this.pendingRows];
			for (const key of keys.keys()) this.keysPending.add(key);
			for (const key of lost.keys()) this.lostPending.add(key);
			this.schedulePersist();
			throw error;
		}
		// As replay reads a row: its sync and cancels are older than its intents.
		for (const [id, content] of sync) {
			if (this.syncPending.get(id) === content) this.syncPending.delete(id);
			this.openIntents.delete(id);
		}
		for (const id of cancels) {
			this.cancelPending.delete(id);
			this.openIntents.delete(id);
		}
		for (const [id, content] of intents) {
			if (this.intentPending.get(id) === content) this.intentPending.delete(id);
			this.openIntents.set(id, content);
		}
		this.markDurable(keys);
		this.snapshotWritten = true;
		const bytes = rows.reduce((n, r) => n + r.updateB64.length, 0);
		this.stats.rowsWritten += rows.length;
		this.stats.rowBytes += bytes;
		if (snapshot) {
			this.snapshotBytes = (rows[0] as { updateB64: string }).updateB64.length;
			this.rowsSinceCompact = rows.length;
			this.bytesSinceCompact = 0;
		} else {
			this.rowsSinceCompact += rows.length;
			this.bytesSinceCompact += bytes;
		}
		// Compact once the increments outweigh a fresh snapshot (and the bound): a large page
		// is not rewritten on every append.
		if (
			this.holding === 0 &&
			(this.rowsSinceCompact > OUTLINE_LIVE_BOUNDS.compactRows ||
				this.bytesSinceCompact > Math.max(OUTLINE_LIVE_BOUNDS.compactBytes, this.snapshotBytes))
		)
			await this.compact(row);
	}

	/** Replace an epoch's rows with one snapshot and one sync row of what is still open. */
	private async compact(row: LogRowMaker): Promise<void> {
		const ahead = new Map<string, string>();
		for (const b of this.mirror.all()) {
			if (!b.deleted && this.textOf(b.id) !== b.dbContent) ahead.set(b.id, b.dbContent);
		}
		// Updates waiting for the next append are in this snapshot: they need no row of their own
		// (unless the compaction fails). Ones arriving while it is written are not.
		const covered = this.pendingRows;
		this.pendingRows = [];
		const compacted = [row(this.logSnapshot(), "system", LIVE_LOG_ACTOR)];
		if (
			ahead.size > 0 ||
			this.openIntents.size > 0 ||
			this.keyDurable.size > 0 ||
			this.keyLost.size > 0
		) {
			compacted.push(
				row(
					encodeSyncRow(ahead, this.openIntents, new Set(), this.keyDurable, this.keyLost),
					"system",
					LIVE_SYNC_ACTOR,
				),
			);
		}
		try {
			await outlineStore.replaceLiveLog(this.spaceId, this.epoch, compacted);
		} catch (error) {
			this.pendingRows = [...covered, ...this.pendingRows];
			throw error;
		}
		this.snapshotBytes = (compacted[0] as { updateB64: string }).updateB64.length;
		this.rowsSinceCompact = compacted.length;
		this.bytesSinceCompact = 0;
		this.stats.compactions++;
	}

	/** Every document whole, as the first row of an epoch's log holds them. */
	private logSnapshot(): Uint8Array {
		const entries: LiveTextEntry[] = [];
		for (const [id, t] of this.docs)
			entries.push({ id, kind: LIVE_TEXT_KIND.update, data: Y.encodeStateAsUpdate(t.doc) });
		return encodeLogTexts(entries);
	}

	/** Transactions now in the log are acknowledged to their clients. */
	private markDurable(keys: ReadonlyMap<string, number>): void {
		if (keys.size === 0) return;
		for (const [key, tx] of keys) {
			// A key dropped meanwhile (`dropKeys`) stays dropped.
			if (this.keys.has(key) && (this.keyDurable.get(key) ?? 0) < tx) this.keyDurable.set(key, tx);
		}
		let advanced = false;
		for (const p of this.participants.values()) {
			const tx = keys.get(p.key);
			if (tx !== undefined && tx > p.durableTx) {
				p.durableTx = tx;
				advanced = true;
			}
		}
		if (advanced) this.scheduleBroadcast();
	}

	/**
	 * Write the commits about to happen into the log (with everything pending before them):
	 * block → the content the commit gives it. False when the log could not take them (the
	 * commit is not attempted then).
	 */
	private async logIntents(intents: ReadonlyMap<string, string>): Promise<boolean> {
		if (intents.size === 0) return true;
		for (const [id, content] of intents) this.intentPending.set(id, content);
		const ok = await this.persistNow();
		if (!ok) for (const id of intents.keys()) this.intentPending.delete(id);
		return ok;
	}

	/** Intents whose commit did not happen (logged with the next append). */
	private cancelIntents(ids: Iterable<string>): void {
		for (const id of ids) {
			this.intentPending.delete(id);
			if (this.openIntents.has(id)) this.cancelPending.add(id);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Dropping documents
	// ─────────────────────────────────────────────────────────────────────────
	//
	// Every end must hold every item of a document it has, so a document is dropped by all ends
	// together: the session drops its own, gives the block a new generation, and tells the page's
	// people (`drop`, with the block's text). See "document generations" in
	// `shared/outline-live-protocol.ts` for what the other ends do and why no end keeps a stale
	// document. A document can go once nothing of it is uncommitted or unlogged: its text is then
	// exactly what the blocks table holds (for a deleted block: what its document says, which is
	// kept as the block's plain text).

	private scheduleSweep(): void {
		if (this.sweepTimer || this.closed) return;
		this.sweepTimer = liveTimeout(() => {
			this.sweepTimer = null;
			this.schedule(async () => {
				await this.sweepDocs();
			});
		}, OUTLINE_LIVE_TIMING.sweepMs);
	}

	/** Whether a block's document can be dropped now. */
	private evictable(id: string): boolean {
		const t = this.docs.get(id);
		if (!t || this.dirty.has(id) || this.stuck.has(id) || this.parked.has(id)) return false;
		if (this.intentPending.has(id) || this.openIntents.has(id) || this.syncPending.has(id))
			return false;
		if (hasPendingStructs(t.doc)) return false;
		const b = this.mirror.get(id);
		return !b || b.deleted || t.text.toString() === b.dbContent;
	}

	/**
	 * Drop the documents nobody needs: idle for {@link OUTLINE_LIVE_TIMING.docIdleMs}, or the
	 * least recently changed ones while the session holds more than
	 * {@link OUTLINE_LIVE_BOUNDS.softDocs}; at most {@link OUTLINE_LIVE_BOUNDS.evictPerSweep} a
	 * call. In the lane. Returns how many went.
	 */
	async sweepDocs(): Promise<number> {
		if (this.sweepTimer) {
			cancelLiveTimer(this.sweepTimer);
			this.sweepTimer = null;
		}
		if (this.closed || this.docs.size === 0) return 0;
		if (this.holding > 0) {
			this.scheduleSweep();
			return 0;
		}
		const now = liveNow();
		const over = this.docs.size - OUTLINE_LIVE_BOUNDS.softDocs;
		const idle: Array<[number, string]> = [];
		for (const id of this.docs.keys()) {
			const age = now - (this.docTouched.get(id) ?? 0);
			if (age >= OUTLINE_LIVE_TIMING.docIdleMs || over > 0) idle.push([age, id]);
		}
		idle.sort((a, b) => b[0] - a[0]);
		const want = idle.filter(([age], i) => age >= OUTLINE_LIVE_TIMING.docIdleMs || i < over);
		let dropped = 0;
		if (want.length > 0) {
			// Everything these documents took is in the log and acknowledged before they go, and
			// the drop goes out before anything else is taken in: a client that still has a change
			// of one unacknowledged when the drop reaches it knows the session never took it.
			if (await this.persistNow()) {
				this.flushBroadcast();
				for (const [, id] of want) {
					if (dropped >= OUTLINE_LIVE_BOUNDS.evictPerSweep) break;
					if (!this.evictable(id) || this.closed) continue;
					this.evict(id);
					dropped++;
				}
				if (dropped > 0) {
					this.flushBroadcast();
					await this.persistNow();
				}
			}
		}
		if (this.docs.size > 0) this.scheduleSweep();
		return dropped;
	}

	private evict(id: string): void {
		const t = this.docs.get(id) as LiveTextDoc;
		const b = this.mirror.get(id);
		const text = t.text.toString();
		// The block is told apart from `destroyDoc`'s log row below: the same row, written once.
		this.destroyDoc(id);
		this.stats.docsEvicted++;
		if (!b) return;
		const gen = ++this.era;
		this.mirror.update(id, { gen, ...(b.deleted ? { dbContent: text } : {}) });
		this.windowUpdates.push({
			from: 0,
			id,
			kind: LIVE_TEXT_KIND.drop,
			gen,
			data: encodeLiveSeed(text),
		});
		this.scheduleBroadcast();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Closing
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Commit everything, drop the log once nothing is left uncommitted, end the participants'
	 * session with `code`. Runs in the lane. Idempotent.
	 */
	close(code: LiveCloseCode = "ended"): Promise<void> {
		this.closing ??= this.doClose(code);
		return this.closing;
	}

	private async doClose(code: LiveCloseCode): Promise<void> {
		// What arrived is logged first (a shutdown may not get further), then acknowledged, then
		// committed.
		await this.persistNow();
		this.flushBroadcast();
		const committed = await this.flushContent();
		await this.persistNow();
		this.flushBroadcast();
		this.closed = true;
		this.closedClean = committed && this.dirty.size === 0 && this.parked.size === 0;
		for (const timer of [this.broadcastTimer, this.flushTimer, this.persistTimer, this.sweepTimer])
			if (timer) cancelLiveTimer(timer);
		for (const view of this.scopes.values()) view.stop();
		for (const p of [...this.participants.values()]) {
			try {
				p.socket.send(
					encodeLiveFrame({ kind: LIVE_FRAME.closed, handle: p.handle, head: { code } }),
				);
			} catch {
				// The socket is gone; nothing to tell.
			}
		}
		this.participants.clear();
		for (const view of this.scopes.values()) view.participants.clear();
		this.scopes.clear();
		if (this.closedClean) {
			try {
				await outlineStore.deleteLiveLog(this.spaceId, this.epoch);
			} catch (error) {
				logger.warn("Outline live log could not be dropped", {
					spaceId: this.spaceId,
					error: String(error),
				});
			}
		} else {
			logger.warn("Outline live session closed with uncommitted text; the log is kept for replay", {
				spaceId: this.spaceId,
				epoch: this.epoch,
			});
		}
		this.destroyDocs();
	}
}

/**
 * Text entries with each block's updates merged into one, a block's seed before them, blocks in
 * the order they first appear.
 */
function mergeTexts(entries: readonly LiveTextEntry[]): LiveTextEntry[] {
	if (entries.length === 1) return [entries[0] as LiveTextEntry];
	// In the order they came, a block's consecutive updates (of one generation) merged into one.
	// A plain text (a seed, or what a dropped document left) ends the run of its block: what
	// comes after it is of another document and is never merged across it or put before it.
	const out: Array<LiveTextEntry | { id: string; gen: number; run: Uint8Array[] }> = [];
	const open = new Map<string, { id: string; gen: number; run: Uint8Array[] }>();
	for (const e of entries) {
		if (e.kind !== LIVE_TEXT_KIND.update) {
			open.delete(e.id);
			out.push(e);
			continue;
		}
		const gen = e.gen ?? 0;
		const run = open.get(e.id);
		if (run && run.gen === gen) run.run.push(e.data);
		else {
			const made = { id: e.id, gen, run: [e.data] };
			open.set(e.id, made);
			out.push(made);
		}
	}
	return out.map((e) =>
		"run" in e
			? {
					id: e.id,
					kind: LIVE_TEXT_KIND.update,
					...(e.gen !== 0 ? { gen: e.gen } : {}),
					data: e.run.length === 1 ? (e.run[0] as Uint8Array) : mergeTextUpdates(e.run),
				}
			: {
					id: e.id,
					kind: e.kind,
					...(e.gen !== undefined ? { gen: e.gen } : {}),
					data: e.data,
				},
	);
}

/** The payload of a log row that only says "this block's document is gone". */
const EMPTY_TEXT = new Uint8Array(0);

type LogRowMaker = (
	data: Uint8Array,
	actorKind: "human" | "system",
	actorId: string,
) => OutlineLiveLogRow;

/** Let timers and I/O run between two steps of a long lane task. */
function yieldToLoop(): Promise<void> {
	return liveYield();
}

/**
 * The first bytes of a text row of the log. A row written before text was per block (one Yjs
 * update of a whole page) never starts with them: its epoch's first row was a snapshot of a
 * document with at least the page's text, whose first byte is a client count of 1 or more.
 */
const LOG_TEXT_TAG = [0x00, 0xb2] as const;

/**
 * A text row of the log: {@link LOG_TEXT_TAG}, then text entries as a frame body carries them
 * (`encodeLiveTexts`): `seed` (the plain text a document was made from) and `update`.
 */
export function encodeLogTexts(entries: readonly LiveTextEntry[]): Uint8Array {
	const body = encodeLiveTexts(entries);
	const out = new Uint8Array(LOG_TEXT_TAG.length + body.length);
	out.set(LOG_TEXT_TAG, 0);
	out.set(body, LOG_TEXT_TAG.length);
	return out;
}

/** The entries of a text row; null for anything else (a row of the format before this one). */
export function decodeLogTexts(row: Uint8Array): LiveTextEntry[] | null {
	if (row.length < LOG_TEXT_TAG.length) return null;
	if (row[0] !== LOG_TEXT_TAG[0] || row[1] !== LOG_TEXT_TAG[1]) return null;
	const entries = decodeLiveTexts(row.subarray(LOG_TEXT_TAG.length));
	if (!entries || entries.some((e) => e.kind === LIVE_TEXT_KIND.vector)) return null;
	return entries;
}

function encodeSyncRow(
	contents: ReadonlyMap<string, string>,
	intents: ReadonlyMap<string, string>,
	cancels: ReadonlySet<string>,
	keys: ReadonlyMap<string, number>,
	/** Per client key: what of its transactions was not taken and it was not told yet (whole). */
	lost: ReadonlyMap<string, readonly LiveLostWire[]> = new Map(),
): Uint8Array {
	return utf8.encode(
		JSON.stringify({
			...(contents.size > 0 ? { b: Object.fromEntries(contents) } : {}),
			...(intents.size > 0 ? { i: Object.fromEntries(intents) } : {}),
			...(cancels.size > 0 ? { x: [...cancels] } : {}),
			...(keys.size > 0 ? { k: Object.fromEntries(keys) } : {}),
			...(lost.size > 0 ? { l: Object.fromEntries(lost) } : {}),
		}),
	);
}

function actorOf(commit: CommittedEvent): LiveActor {
	switch (commit.actorKind) {
		case "agent":
			return "a";
		case "human":
			return "h";
		default:
			return "s";
	}
}

/** A block's live text prepared for a commit (see `planContents`). */
export interface ContentPlan {
	id: string;
	/** The live text when planned. */
	text: string;
	/** Normalized parts: the block's own content, then blocks to add after it. */
	parts: LiveNormalized[];
	/** Text left for a later commit: it did not fit one transaction with the parts before it. */
	rest?: string;
	/** Even the block's own content and what it splits off do not fit one transaction. */
	unwritable?: boolean;
}

/**
 * What a session calls to normalize and to write. Replaceable only by tests (to make a
 * normalization time out, or a later write transaction fail).
 */
export const OUTLINE_LIVE_HOOKS = {
	normalize: normalizeLiveTexts,
	write: writeOutline,
};

/** A write over several transactions failed at one; the ones before it are committed. */
export class LiveChunkError extends Error {
	constructor(
		readonly cause: unknown,
		readonly committed: OutlineWriteResult[],
		/** Operations committed (a prefix of the operations given). */
		readonly committedOps: number,
	) {
		super(String(cause));
		this.name = "LiveChunkError";
	}
}

function isBusyText(error: unknown): boolean {
	return error instanceof OutlineEditTextError && error.code === "OUTLINE_TEXT_BUSY";
}

/** A failure retrying will not cure: the text times out or breaks normalization, or the write
 * path refuses it (not a conflict, not busy). */
function isPermanent(error: unknown): boolean {
	if (error instanceof OutlineEditTextError) return error.code !== "OUTLINE_TEXT_BUSY";
	if (error instanceof OutlineWriteError) return !isConflict(error);
	return false;
}

/** Operations and bytes the content of one part writes, its split-off blocks included. */
function partCost(part: LiveNormalized): { ops: number; bytes: number } {
	let ops = 1;
	let bytes = bytesOf(part.content);
	const walk = (nodes: LiveNormalized["split"]) => {
		for (const n of nodes) {
			ops++;
			bytes += bytesOf(n.content);
			walk(n.children);
		}
	};
	walk(part.split);
	return { ops, bytes };
}

/**
 * Cut a plan to what one transaction takes: the block's own part always, then the following
 * parts while they fit; the raw text of the parts left out becomes `rest`.
 */
function fitPlan(plan: ContentPlan, raw: readonly string[]): void {
	let ops = 0;
	let bytes = 0;
	let keep = 0;
	for (const part of plan.parts) {
		const cost = partCost(part);
		if (
			ops + cost.ops > OUTLINE_LIMITS.maxOps ||
			bytes + cost.bytes > OUTLINE_LIMITS.maxTransactionBodyBytes
		)
			break;
		ops += cost.ops;
		bytes += cost.bytes;
		keep++;
	}
	if (keep === 0) {
		plan.unwritable = true;
		return;
	}
	if (keep < plan.parts.length) {
		plan.rest = raw.slice(keep).join("\n");
		plan.parts = plan.parts.slice(0, keep);
	}
}

/** Text kept as typed in code blocks, cut to the per-block size limit. */
function codeParts(text: string): string[] {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const fence = "`".repeat(Math.max(3, longest + 1));
	return fitBody(text, OUTLINE_LIMITS.maxBodyBytes - 2 * fence.length - 8).map(
		(part) => `${fence}\n${part}\n${fence}`,
	);
}

/**
 * Transactions for operations: `groups` (op ranges) stay in one transaction when they fit; a
 * group larger than a transaction goes over several (blocks are named by id). Without groups
 * every operation is its own unit.
 */
export function planChunks(
	ops: readonly OutlineOp[],
	groups?: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
	const sizeOf = (op: OutlineOp) =>
		"content" in op && typeof op.content === "string" ? bytesOf(op.content) : 0;
	const units: Array<[number, number]> = groups
		? groups.filter(([a, b]) => b > a).map(([a, b]) => [a, b])
		: ops.map((_, i) => [i, i + 1]);
	const chunks: Array<[number, number]> = [];
	let start = -1;
	let end = -1;
	let count = 0;
	let bytes = 0;
	const close = () => {
		if (start >= 0 && end > start) chunks.push([start, end]);
		start = -1;
		end = -1;
		count = 0;
		bytes = 0;
	};
	for (const [a, b] of units) {
		let unitBytes = 0;
		for (let i = a; i < b; i++) unitBytes += sizeOf(ops[i] as OutlineOp);
		const fits =
			count + (b - a) <= OUTLINE_LIMITS.maxOps &&
			bytes + unitBytes <= OUTLINE_LIMITS.maxTransactionBodyBytes;
		if (start >= 0 && !fits) close();
		if (b - a <= OUTLINE_LIMITS.maxOps && unitBytes <= OUTLINE_LIMITS.maxTransactionBodyBytes) {
			if (start < 0) start = a;
			end = b;
			count += b - a;
			bytes += unitBytes;
			continue;
		}
		// A unit larger than a transaction: its operations one transaction-full at a time
		// (blocks are named by id, so they need not share one).
		for (let i = a; i < b; i++) {
			const size = sizeOf(ops[i] as OutlineOp);
			if (
				start >= 0 &&
				(count + 1 > OUTLINE_LIMITS.maxOps || bytes + size > OUTLINE_LIMITS.maxTransactionBodyBytes)
			)
				close();
			if (start < 0) start = i;
			end = i + 1;
			count++;
			bytes += size;
		}
		close();
	}
	close();
	return chunks;
}

/** Whether committing a plan adds blocks (split structure, or parts past the size limit). */
function reshapes(plan: ContentPlan): boolean {
	return plan.parts.length > 1 || plan.parts.some((part) => part.split.length > 0);
}

/**
 * Operations committing a content plan: the block's content (when `dbContent` is given and it
 * changed; an insert carries it already), its split-off children, and further parts as blocks
 * right after it under `parentId`. Every new block gets its id here and is named by it, so the
 * operations may go over several transactions. Returns the ids of the further parts.
 */
export function contentOps(
	plan: ContentPlan,
	dbContent: string | null,
	parentId: string | null,
	ops: OutlineOp[],
	canonical: Array<OutlineCanonicalContent | undefined>,
): string[] {
	const [first, ...rest] = plan.parts as [LiveNormalized, ...LiveNormalized[]];
	if (dbContent !== null && first.content !== dbContent) {
		ops.push({ op: "update", block: { id: plan.id }, content: first.content });
		canonical.push({ content: first.content, links: first.links });
	}
	addSplit(ops, canonical, plan.id, first.split);
	const ids: string[] = [];
	let after = plan.id;
	for (const part of rest) {
		const id = generateId();
		ops.push({
			op: "insert",
			id,
			parent: parentId === null ? null : { id: parentId },
			position: { after: { id: after } },
			content: part.content,
		});
		canonical.push({ content: part.content, links: part.links });
		addSplit(ops, canonical, id, part.split);
		ids.push(id);
		after = id;
	}
	return ids;
}

/** Split-off blocks of normalized content become its first children. */
function addSplit(
	ops: OutlineOp[],
	canonical: Array<OutlineCanonicalContent | undefined>,
	parent: string,
	split: LiveNormalized["split"],
): void {
	let previous: string | null = null;
	for (const node of split) {
		const id = generateId();
		ops.push({
			op: "insert",
			id,
			parent: { id: parent },
			position: previous ? { after: { id: previous } } : { first: true },
			content: node.content,
			task: node.task ? { status: node.task } : null,
		});
		canonical.push({ content: node.content, links: node.links });
		addSplit(ops, canonical, id, node.children);
		previous = id;
	}
}

/**
 * A text over the per-block limit, cut into parts that fit (at line breaks where possible): the
 * first stays in the block, the rest become blocks after it. Never drops text.
 */
export function fitBody(text: string, limit: number = OUTLINE_LIMITS.maxBodyBytes): string[] {
	if (bytesOf(text) <= limit) return [text];
	const parts: string[] = [];
	let rest = text;
	while (bytesOf(rest) > limit) {
		// Largest prefix under the limit, by halving the character count.
		let lo = 1;
		let hi = rest.length;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (bytesOf(rest.slice(0, mid)) <= limit) lo = mid;
			else hi = mid - 1;
		}
		let cut = lo;
		const nl = rest.lastIndexOf("\n", cut);
		if (nl > cut / 2) cut = nl;
		// Never split a surrogate pair.
		const code = rest.charCodeAt(cut - 1);
		if (code >= 0xd800 && code <= 0xdbff) cut--;
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	parts.push(rest);
	return parts;
}

function parseOps(raw: unknown): LiveOp[] | null {
	const list = (raw as { ops?: unknown } | null)?.ops;
	if (!Array.isArray(list) || list.length === 0 || list.length > OUTLINE_LIVE_LIMITS.maxTxOps)
		return null;
	const out: LiveOp[] = [];
	const str = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 128;
	/** A parent: a block, or `null` for the top level (protocol version 4). */
	const parent = (v: unknown) => v === null || str(v);
	for (const item of list as Array<Record<string, unknown>>) {
		if (!item || typeof item !== "object" || !str(item.id)) return null;
		const id = item.id as string;
		switch (item.t) {
			case "i":
				if (!parent(item.p) || !str(item.k)) return null;
				if (item.task !== undefined && item.task !== null && !isLiveTaskChar(item.task))
					return null;
				if (!isKey(item.k as string)) return null;
				out.push({
					t: "i",
					id,
					p: item.p as string | null,
					k: item.k as string,
					...(item.task !== undefined ? { task: item.task as LiveTaskChar | null } : {}),
				});
				break;
			case "m":
				if (!parent(item.p) || !str(item.k) || !isKey(item.k as string)) return null;
				out.push({ t: "m", id, p: item.p as string | null, k: item.k as string });
				break;
			case "d":
				out.push({ t: "d", id });
				break;
			case "k":
				if (item.task !== null && !isLiveTaskChar(item.task)) return null;
				out.push({ t: "k", id, task: item.task as LiveTaskChar | null });
				break;
			default:
				return null;
		}
	}
	return out;
}

function isKey(k: string): boolean {
	try {
		keyBetween(k, null);
		return true;
	} catch {
		return false;
	}
}

function validPos(pos: unknown): boolean {
	if (!Array.isArray(pos) || pos.length !== 2 || typeof pos[0] !== "string" || pos[0].length > 128)
		return false;
	const rel = pos[1];
	return (
		rel === null ||
		(Array.isArray(rel) && rel.length === 3 && rel.every((x) => Number.isSafeInteger(x)))
	);
}

/** A socket's buffered bytes (0 when it cannot tell). */
function socketBuffered(socket: LiveSocket): number {
	try {
		return socket.bufferedAmount();
	} catch {
		return 0;
	}
}

/** Who is doing the task a refused change touched, as the reject frame carries it. */
async function claimedWire(error: OutlineTaskClaimedError): Promise<LiveClaimedWire> {
	const holder = error.holder;
	const id = holder.kind === "agent" ? holder.narratorId : holder.userId;
	let name: string | null = null;
	try {
		const names = await readDisplayNames(
			holder.kind === "agent" ? { narratorIds: [id] } : { userIds: [id] },
		);
		name = (holder.kind === "agent" ? names.narrators.get(id) : names.users.get(id)) ?? null;
	} catch {
		// The id alone still says who.
	}
	return { address: error.address, holder: { kind: holder.kind, id, name } };
}

/**
 * Errors of the write path that mean "the structure moved under this transaction", or someone
 * else got there first (a task another session or person is doing: setting it to in progress
 * is refused), or the state of others' work stands in the way (a lock only its locker, a
 * manager or an admin may change; a page full of changes waiting for confirmation).
 */
export function isConflict(error: unknown): boolean {
	return (
		error instanceof OutlineConflictError ||
		error instanceof OutlineBusyError ||
		(error instanceof OutlineWriteError &&
			[
				"OUTLINE_BLOCK_NOT_FOUND",
				"OUTLINE_BLOCK_DELETED",
				"OUTLINE_CYCLE",
				"OUTLINE_ID_TAKEN",
				"OUTLINE_TASK_CLAIMED",
				"OUTLINE_LOCK_DENIED",
				"OUTLINE_LOCK_HELD",
				// A locked task moving to a page with as many open changes as it may hold.
				"OUTLINE_PENDING_FULL",
			].includes(error.code))
	);
}

/** Two byte arrays one after the other (text entries are self-delimiting). */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (b.length === 0) return a;
	if (a.length === 0) return b;
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}
