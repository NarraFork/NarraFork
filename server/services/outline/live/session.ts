/**
 * One page's live editing session (design §6.2–§6.6, plan §8, D33).
 *
 * WHAT IT HOLDS
 * -------------
 *   - a Yjs document with one `Y.Text` per block of the page, created from the blocks' content
 *     when the session opens (all of them at once: a text created lazily lets keystrokes race its
 *     creation, and redo then reverses typed text, as the prototype found);
 *   - a mirror of the page's structure (`mirror.ts`), equal to the blocks table between tasks;
 *   - the participants: people editing (write access) or viewing (read access) the page.
 *
 * HOW CHANGES FLOW
 * ----------------
 *   - Text: a participant's Yjs update is applied at once and broadcast to the others within
 *     {@link OUTLINE_LIVE_TIMING.broadcastMs}, merged with everything else of that window
 *     (`Y.mergeUpdates`), never echoed to its sender (who gets the transaction number back
 *     instead). Changed blocks are committed as the editor's own human commits a little later
 *     (after {@link OUTLINE_LIVE_TIMING.flushIdleMs} of quiet, at most
 *     {@link OUTLINE_LIVE_TIMING.flushMaxMs} after the first change), normalized off the main
 *     thread when large (`normalize.ts`).
 *   - Structure: a structural transaction (insert, move, delete, checkbox, plus the Yjs update
 *     of the same keystroke) is checked against the mirror, written as one commit through
 *     `writeOutline`, then broadcast in canonical form. A refused transaction is rolled back
 *     (its Yjs part included) and every later frame of that participant is dropped until it
 *     joins again; the client rebuilds its document and replays its own later changes.
 *   - Writes from outside (agents, reverts) reach the session through the barrier
 *     (`live-barrier.ts`): unflushed text is committed first, then the outside commit is read
 *     back (its block versions) and pushed in as a remote change, merged into the live text.
 *   - Every Yjs update is also appended to `outline_live_updates` within
 *     {@link OUTLINE_LIVE_TIMING.persistMs} (a snapshot first, increments after, compacted once
 *     the increments outweigh a snapshot). A participant's transactions are acknowledged only
 *     once the log (or the page) has them: after a crash, what was acknowledged is replayed
 *     from the log (a startup job, or the next join), and what was not is still held by its
 *     client, which replays it into the next session. Every join after a client's first names
 *     the session it was in, and the answer says which of its transactions the page applied
 *     (`tx`) and which of those are safe in the log or committed (`dur`): the client forgets
 *     the latter, keeps the rest of what was applied unsent until acknowledged, and replays
 *     only what the page does not have, so nothing is applied twice (also across a refusal,
 *     a restart or days offline: an ended session's positions stay in the log, `registry.ts`).
 *     Before the session commits text it logs what it is about to write (an intent), so a
 *     crash between the commit and the next append does not merge committed text with itself.
 *   - Failures: a commit that fails part way keeps what was written (the session takes it as
 *     the page now is); text that cannot be normalized or written is committed as code blocks,
 *     and given up on (kept live and in the log) when even that fails a few times; a log that
 *     cannot be committed is taken over by the next session of the page. A frame that cannot
 *     be encoded drops only its recipient.
 *
 * Every method that touches the document or the database runs in the space's lane.
 */
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { compareOrderKeys, keyBetween, merge3 } from "@shared/outline";
import {
	encodeLiveFrame,
	encodeLiveHead,
	isLiveTaskChar,
	LIVE_FRAME,
	LIVE_STATUS_OF_TASK,
	type LiveActor,
	type LiveBatchHead,
	type LiveClaimedWire,
	type LiveCloseCode,
	type LiveCommitWire,
	type LiveJoinedHead,
	type LiveJoinHead,
	type LiveOp,
	type LivePeerWire,
	type LivePresenceDown,
	type LiveRejectCode,
	type LiveRejectHead,
	type LiveSelWire,
	type LiveTaskChar,
	OUTLINE_LIVE_LIMITS,
} from "@shared/outline-live-protocol";
import * as Y from "yjs";
import { readDisplayNames } from "../access-reads";
import { OutlineEditTextError } from "../edit-text-runner";
import {
	OutlineBusyError,
	OutlineConflictError,
	OutlineTaskClaimedError,
	OutlineWriteError,
} from "../errors";
import { OUTLINE_LIMITS, type OutlineTaskJson } from "../model";
import { outlineStore } from "../store";
import type { OutlineVersionRow } from "../store/port";
import {
	type OutlineCanonicalContent,
	type OutlineOp,
	type OutlineWriteResult,
	writeOutline,
} from "../write";
import { asOwnLiveWrite } from "./lane";
import { type MirrorBlock, PageMirror, taskCharOf } from "./mirror";
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
	| "narrowBudgetMs",
	number
> = {
	/** Changes are coalesced and broadcast this often (design §7.2). */
	broadcastMs: 50,
	/** Cursors are coalesced (last one wins) and broadcast this often. */
	presenceMs: 100,
	/** Yjs updates reach `outline_live_updates` at most this long after they arrive. */
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
};

/** Bounds of a session. Mutable only so tests can shrink them. */
export const OUTLINE_LIVE_BOUNDS = {
	/**
	 * Bytes of updates a session's document may take in (from its open) before the session is
	 * restarted with a fresh document: Yjs keeps deleted items, and a writer could otherwise grow
	 * it without bound. Participants rejoin at once.
	 */
	maxDocBytes: 16 * 1024 * 1024,
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
	/** Structural batches kept for resuming clients. */
	opLog: 256,
	/**
	 * Client keys whose last processed transaction is remembered. Only keys with no participant
	 * whose transactions were all acknowledged to their client are dropped to keep to this (a
	 * client coming back without its key would replay what the page has). Kept keys are the
	 * participants (at most `editorsPerPage` + `viewersPerPage`) and clients that left before
	 * their last acknowledgement, which can pile up on a busy page: past `clientKeysHard` the
	 * oldest of those goes anyway.
	 */
	clientKeys: 128,
	clientKeysHard: 1024,
	/** Blocks one block selection may name in presence. */
	presenceBlocks: 200,
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
	) {}

	get userId(): string {
		return this.socket.userId;
	}

	peer(): LivePeerWire {
		return [this.pno, this.userId, this.socket.name, this.socket.color, this.canWrite ? "e" : "v"];
	}
}

interface WindowUpdate {
	from: number;
	update: Uint8Array;
}

interface PendingRow {
	actorKind: "human" | "system";
	actorId: string;
	update: Uint8Array;
}

export interface CommittedEvent {
	spaceId: string;
	commitId: string;
	seq: number;
	pageIds: string[];
	actorKind: "human" | "agent" | "system";
	actorId: string;
}

type Refusal = { refused: LiveCloseCode };

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

export class LivePage {
	readonly doc = new Y.Doc();
	readonly texts: Y.Map<Y.Text>;
	readonly mirror: PageMirror;
	readonly epoch = newEpoch();
	readonly participants = new Map<number, Participant>();
	private nextPno = 1;
	/** Per client key: the highest transaction processed (least recently used first). */
	private readonly keys = new Map<string, number>();
	/** Per client key: the highest transaction acknowledged to its client. */
	private readonly keyAcked = new Map<string, number>();
	private opSeq = 0;
	private readonly opLog: LiveCommitWire[] = [];
	closed = false;
	/** Set at close: everything was committed and the log dropped. */
	closedClean = false;
	private closing: Promise<void> | null = null;

	// Broadcast window.
	private windowUpdates: WindowUpdate[] = [];
	private windowCommits: LiveCommitWire[] = [];
	private readonly windowAcks = new Map<number, Array<[number, number, LiveOp[]?]>>();
	private broadcastTimer: ReturnType<typeof setTimeout> | null = null;

	// Presence.
	private readonly presencePeers = new Set<number>();
	private readonly presenceGone = new Set<number>();
	private readonly presenceCursors = new Set<number>();
	/** Recipients that skipped presence under backpressure and need the full picture. */
	private readonly presenceBehind = new Set<number>();
	private presenceTimer: ReturnType<typeof setTimeout> | null = null;

	// Text not committed yet: block id → who changed it last (null: not a person).
	private readonly dirty = new Map<string, string | null>();
	private firstDirtyAt = 0;
	private lastDirtyAt = 0;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	/** Blocks whose text changed in the update being applied (for structural transactions). */
	private touched: Set<string> | null = null;
	/** Live blocks a participant's update left without a text, repaired after it. */
	private readonly broken = new Set<string>();

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
	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	private persistChain: Promise<void> = Promise.resolve();
	private logSeq = 0;
	private snapshotWritten = false;
	private rowsSinceCompact = 0;
	/** Base64 bytes of the increments appended since the last snapshot. */
	private bytesSinceCompact = 0;
	/** Base64 bytes of the last snapshot row. */
	private snapshotBytes = 0;
	/** Bytes of updates the document took in since the session opened (see `maxDocBytes`). */
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

	private idleTimer: ReturnType<typeof setTimeout> | null = null;

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
	};

	private constructor(
		readonly pageId: string,
		readonly spaceId: string,
		private readonly schedule: (task: () => Promise<void>) => void,
		private readonly onEnd: (page: LivePage, code: LiveCloseCode, idle: boolean) => void,
	) {
		this.texts = this.doc.getMap<Y.Text>("texts");
		this.mirror = new PageMirror(pageId);
	}

	/**
	 * Open a session: read the page (it must be small enough) and build the document. Runs in
	 * the space's lane. `schedule` queues a task on that lane; `onEnd` asks for the session to be
	 * closed (idle: the last participant left and the idle period passed; or the page went, or
	 * the document grew past its bound).
	 */
	static async open(
		pageId: string,
		spaceId: string,
		schedule: (task: () => Promise<void>) => void,
		onEnd: (page: LivePage, code: LiveCloseCode, idle: boolean) => void,
	): Promise<LivePage | Refusal> {
		const { blocks, truncated } = await outlineStore.listPageBlocks(
			pageId,
			OUTLINE_LIVE_LIMITS.maxPageBlocks,
		);
		if (truncated) return { refused: "too_large" };
		const page = blocks.find((b) => b.id === pageId);
		if (!page || page.parentId !== null || page.spaceId !== spaceId)
			return { refused: "access_denied" };
		let bytes = 0;
		for (const b of blocks) bytes += bytesOf(b.content);
		if (bytes > OUTLINE_LIVE_LIMITS.maxPageBytes) return { refused: "too_large" };
		const session = new LivePage(pageId, spaceId, schedule, onEnd);
		for (const b of blocks) {
			session.mirror.put({
				id: b.id,
				sid: b.sid,
				parentId: b.parentId,
				orderKey: b.orderKey,
				taskJson: b.taskJson,
				deleted: false,
				dbContent: b.content,
			});
		}
		const ids = blocks.map((b) => b.id).sort();
		session.doc.transact(() => {
			for (const id of ids) {
				session.texts.set(id, new Y.Text(session.mirror.get(id)?.dbContent ?? ""));
			}
		}, SERVER_ORIGIN);
		// The initial texts are what the database holds: nothing to persist or broadcast yet.
		session.windowUpdates = [];
		session.pendingRows = [];
		session.docBytes = bytes + 64 * blocks.length;
		session.watch();
		return session;
	}

	private watch(): void {
		this.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (this.closed) return;
			this.docBytes += update.length;
			if (this.docBytes > OUTLINE_LIVE_BOUNDS.maxDocBytes && !this.restartRequested) {
				// Everything is committed and the participants rejoin a fresh session.
				this.restartRequested = true;
				logger.warn("Outline live document grew past its bound; restarting the session", {
					pageId: this.pageId,
					bytes: this.docBytes,
				});
				this.onEnd(this, "ended", false);
			}
			const from = origin instanceof Participant ? origin.pno : 0;
			this.windowUpdates.push({ from, update });
			this.scheduleBroadcast();
			this.pendingRows.push(
				origin instanceof Participant
					? { actorKind: "human", actorId: origin.userId, update }
					: { actorKind: "system", actorId: LIVE_LOG_ACTOR, update },
			);
			this.schedulePersist();
		});
		this.texts.observeDeep((events, txn) => {
			const person = txn.origin instanceof Participant ? txn.origin : null;
			for (const ev of events) {
				if (ev.target === this.texts) {
					// Only structural transactions create texts; anything else touching the map
					// leaves a live block without its text, which is repaired from the database.
					for (const key of (ev as Y.YMapEvent<Y.Text>).keysChanged) {
						if (!person) continue;
						const t = this.texts.get(key);
						if (!(t instanceof Y.Text) && this.mirror.alive(key)) this.broken.add(key);
						this.touched?.add(key);
					}
					continue;
				}
				if (!(ev.target instanceof Y.Text)) continue;
				const id = (ev.target as unknown as { _item?: { parentSub?: string | null } })._item
					?.parentSub;
				if (!id) continue;
				this.touched?.add(id);
				if (person) this.markDirty(id, person.userId);
			}
		});
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Reading
	// ─────────────────────────────────────────────────────────────────────────

	private ytext(id: string): Y.Text | null {
		const t = this.texts.get(id);
		return t instanceof Y.Text ? t : null;
	}

	/** A block's live text (its database content when it has no text in the session). */
	textOf(id: string): string {
		return this.ytext(id)?.toString() ?? this.mirror.get(id)?.dbContent ?? "";
	}

	get editors(): number {
		let n = 0;
		for (const p of this.participants.values()) if (p.canWrite) n++;
		return n;
	}

	get viewers(): number {
		return this.participants.size - this.editors;
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
		for (const timer of [
			this.broadcastTimer,
			this.presenceTimer,
			this.flushTimer,
			this.persistTimer,
			this.idleTimer,
		]) {
			if (timer) clearTimeout(timer);
		}
		this.participants.clear();
		this.doc.destroy();
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
			const t = this.ytext(c.id);
			if (!t || !this.mirror.alive(c.id)) continue;
			const current = t.toString();
			if (current === c.text) continue;
			this.mergeText(c.id, current, c.text);
			this.markDirty(c.id, c.actor);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Participants
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Add a participant and answer its join: a snapshot (reset), or the difference to what it
	 * has when it resumes this same session. `dur`: of the client's previous session (gone), the
	 * transactions already in the page (a reset tells the client not to replay them).
	 *
	 * The participant is added only once its answer is encoded and queued: a join that cannot be
	 * answered leaves nothing behind.
	 */
	join(
		socket: LiveSocket,
		handle: number,
		head: LiveJoinHead,
		stateVector: Uint8Array,
		canWrite: boolean,
		dur?: number,
	): Participant | Refusal {
		if (this.closed || this.restartRequested) return { refused: "ended" };
		if (
			canWrite
				? this.editors >= OUTLINE_LIVE_LIMITS.editorsPerPage
				: this.viewers >= OUTLINE_LIVE_LIMITS.viewersPerPage
		)
			return { refused: "unavailable" };
		// A socket that has not taken what it was sent gets no snapshot on top of it.
		if (socketBuffered(socket) > OUTLINE_LIVE_BOUNDS.lagBytes) return { refused: "unavailable" };
		const p = new Participant(
			this.nextPno,
			socket,
			handle,
			head.key,
			head.mode === "edit",
			canWrite,
		);
		const resume = head.resume;
		let joined: LiveJoinedHead;
		let body: Uint8Array;
		const base = {
			epoch: this.epoch,
			w: canWrite,
			op: this.opSeq,
			me: p.pno,
			peers: [...this.participants.values()].map((x) => x.peer()),
			cur: [...this.participants.values()]
				.filter((x) => x.sel !== null)
				.map((x) => [x.pno, x.sel] as [number, LiveSelWire | null]),
		};
		// Which of the client's transactions of its previous session the page has: this session's
		// own bookkeeping when it is that session (a resume, or a snapshot after a refusal), else
		// what the registry knows of the ended one (`dur`).
		const sameSession = resume !== undefined && resume.epoch === this.epoch;
		const processed = sameSession ? (this.keys.get(head.key) ?? 0) : (dur ?? 0);
		const durable = sameSession
			? Math.min(processed, this.keyDurable.get(head.key) ?? 0)
			: (dur ?? 0);
		let diff: Uint8Array | null = null;
		if (sameSession && !resume.reset && stateVector.length > 0) {
			try {
				diff = Y.encodeStateAsUpdate(this.doc, stateVector);
			} catch {
				diff = null;
			}
		}
		if (resume && diff) {
			const covered =
				resume.op === this.opSeq ||
				(this.opLog.length > 0 && (this.opLog[0] as LiveCommitWire).o <= resume.op + 1);
			joined = {
				...base,
				mode: "resume",
				tx: processed,
				// Processed but not in the log yet: the client keeps those until acknowledged.
				dur: durable,
				...(covered
					? { ops: this.opLog.filter((c) => c.o > resume.op) }
					: { blocks: this.mirror.snapshot() }),
			};
			body = diff;
		} else {
			joined = {
				...base,
				mode: "reset",
				tx: processed,
				dur: durable,
				blocks: this.mirror.snapshot(),
			};
			body = Y.encodeStateAsUpdate(this.doc);
		}
		let frame: Uint8Array;
		try {
			frame = encodeLiveFrame({ kind: LIVE_FRAME.joined, handle, head: joined, body });
		} catch (error) {
			logger.warn("Outline live join could not be answered", {
				pageId: this.pageId,
				error: String(error),
			});
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
		if (!this.sendTo(p, frame, "control")) return { refused: "unavailable" };
		this.nextPno++;
		this.participants.set(p.pno, p);
		this.cancelIdle();
		this.presencePeers.add(p.pno);
		this.schedulePresence();
		return p;
	}

	leave(p: Participant): void {
		if (this.participants.get(p.pno) !== p) return;
		this.participants.delete(p.pno);
		this.windowAcks.delete(p.pno);
		this.presencePeers.delete(p.pno);
		this.presenceCursors.delete(p.pno);
		this.presenceBehind.delete(p.pno);
		this.presenceGone.add(p.pno);
		this.schedulePresence();
		if (this.participants.size === 0) this.armIdle();
	}

	/**
	 * Change a participant's write access (an access change re-checked it). A viewer becomes an
	 * editor only while the page has room for one more.
	 */
	setWrite(p: Participant, canWrite: boolean): void {
		if (p.canWrite === canWrite || this.participants.get(p.pno) !== p) return;
		if (canWrite && this.editors >= OUTLINE_LIVE_LIMITS.editorsPerPage) return;
		p.canWrite = canWrite;
		this.deliver(p, "control", () =>
			encodeLiveFrame({ kind: LIVE_FRAME.mode, handle: p.handle, head: { w: canWrite } }),
		);
		this.presencePeers.add(p.pno);
		this.schedulePresence();
	}

	/** Tell a participant the session ended for it (it is removed). */
	dismiss(p: Participant, code: LiveCloseCode): void {
		this.deliver(p, "control", () =>
			encodeLiveFrame({ kind: LIVE_FRAME.closed, handle: p.handle, head: { code } }),
		);
		this.leave(p);
	}

	private cancelIdle(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}

	private armIdle(): void {
		this.cancelIdle();
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			if (this.participants.size === 0 && !this.closed) this.onEnd(this, "ended", true);
		}, OUTLINE_LIVE_TIMING.idleCloseMs);
		this.idleTimer.unref?.();
	}

	/**
	 * Called when a participant's socket drained: one that fell behind is told to rejoin, and
	 * gets exactly what it lacks from its state vector; one that skipped presence gets the whole
	 * picture. Its own frames are still taken meanwhile.
	 */
	onDrain(p: Participant): void {
		if (this.participants.get(p.pno) !== p) return;
		if (this.presenceBehind.has(p.pno)) this.schedulePresence();
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
	private deliver(
		p: Participant,
		kind: "data" | "presence" | "control",
		build: () => Uint8Array,
	): boolean {
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
		if (Date.now() - this.brokenLogged > 60_000) {
			this.brokenLogged = Date.now();
			logger.warn("Outline live frame failed; participant dropped", {
				pageId: this.pageId,
				error: String(error),
			});
		}
		this.leave(p);
	}

	private scheduleBroadcast(): void {
		if (this.broadcastTimer || this.closed) return;
		this.broadcastTimer = setTimeout(() => {
			this.broadcastTimer = null;
			this.flushBroadcast();
		}, OUTLINE_LIVE_TIMING.broadcastMs);
		this.broadcastTimer.unref?.();
	}

	/**
	 * Send everyone what the window collected for them (see the module header). A participant's
	 * transactions are acknowledged once they are in the log (`durableTx`), so an acknowledged
	 * change survives a crash; the client keeps the others and replays them if it must.
	 */
	flushBroadcast(): void {
		if (this.broadcastTimer) {
			clearTimeout(this.broadcastTimer);
			this.broadcastTimer = null;
		}
		const updates = this.windowUpdates;
		const commits = this.windowCommits;
		this.windowUpdates = [];
		this.windowCommits = [];
		const t0 = performance.now();
		const merged = new Map<string, Uint8Array>();
		const mergedFor = (pno: number, start: number): Uint8Array | null => {
			const share = updates.slice(start).filter((u) => u.from !== pno);
			if (share.length === 0) return null;
			if (share.length === 1) return (share[0] as WindowUpdate).update;
			// Recipients that sent nothing in the window share one merge.
			const key = start === 0 && share.length === updates.length ? "all" : `${pno}`;
			let out = merged.get(key);
			if (!out) {
				out = Y.mergeUpdates(share.map((u) => u.update));
				merged.set(key, out);
			}
			return out;
		};
		for (const p of [...this.participants.values()]) {
			const start = p.windowStart;
			const commitStart = p.commitStart;
			p.windowStart = 0;
			p.commitStart = 0;
			// A participant that fell behind rejoins and gets everything from its state vector.
			if (p.lagging) continue;
			const others = [
				...p.heldCommits,
				...commits.slice(commitStart).filter((c) => c.by !== p.pno),
			];
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
				p.heldCommits = [];
				p.lagging = true;
				p.resyncSent = true;
				this.stats.resyncs++;
				try {
					p.socket.send(encodeLiveFrame({ kind: LIVE_FRAME.resync, handle: p.handle }));
				} catch (error) {
					this.dropBroken(p, error);
				}
				continue;
			}
			const body = mergedFor(p.pno, start);
			if (!body && own.length === 0 && ack === 0) continue;
			const head: LiveBatchHead = {};
			if (own.length > 0) head.c = own;
			if (acks && acks.length > 0) head.a = acks;
			const sent = this.deliver(p, "data", () =>
				encodeLiveFrame({
					kind: LIVE_FRAME.batch,
					handle: p.handle,
					n: ack,
					...(head.c || head.a ? { head } : {}),
					...(body ? { body } : {}),
				}),
			);
			if (sent && ack > 0) {
				p.ackedTx = ack;
				if (ack > (this.keyAcked.get(p.key) ?? 0)) this.keyAcked.set(p.key, ack);
				const rest = waiting?.filter((a) => a[0] > ack) ?? [];
				if (rest.length > 0) this.windowAcks.set(p.pno, rest);
				else this.windowAcks.delete(p.pno);
			}
		}
		this.stats.mergeMs += performance.now() - t0;
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

	private schedulePresence(): void {
		if (this.presenceTimer || this.closed) return;
		this.presenceTimer = setTimeout(() => {
			this.presenceTimer = null;
			this.flushPresence();
		}, OUTLINE_LIVE_TIMING.presenceMs);
		this.presenceTimer.unref?.();
	}

	/**
	 * Send who changed and moved. Two heads at most are serialized per round, whatever the number
	 * of recipients (a client ignores its own entries): the changes, and the whole picture for
	 * recipients that skipped earlier rounds. Recipients that cannot take presence now are not
	 * encoded for; they get the whole picture when their socket drains, and one that fell behind
	 * gets it with its rejoin.
	 */
	private flushPresence(): void {
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
		let delta: Uint8Array | null | undefined;
		let full: Uint8Array | null | undefined;
		const deltaHead = (): Uint8Array | null => {
			if (delta !== undefined) return delta;
			const head: LivePresenceDown = {};
			if (peers.length) head.peers = peers.map((p) => p.peer());
			if (gone.length) head.gone = gone;
			if (cursors.length) head.cur = cursors.map((p) => [p.pno, p.sel]);
			delta = head.peers || head.gone || head.cur ? encodeLiveHead(head) : null;
			return delta;
		};
		const fullHead = (): Uint8Array | null => {
			if (full !== undefined) return full;
			const all = [...this.participants.values()];
			const head: LivePresenceDown = { peers: all.map((p) => p.peer()) };
			const cur = all.filter((p) => p.sel !== null);
			if (cur.length) head.cur = cur.map((p) => [p.pno, p.sel]);
			full = encodeLiveHead(head);
			return full;
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
			const raw = behind ? fullHead() : deltaHead();
			if (!raw) continue;
			const sent = this.deliver(r, "presence", () =>
				encodeLiveFrame({ kind: LIVE_FRAME.presence, handle: r.handle, rawHead: raw }),
			);
			if (sent) this.presenceBehind.delete(r.pno);
			else this.presenceBehind.add(r.pno);
		}
	}

	/** A selection as presence carries it: positions, or live blocks of this page (bounded). */
	private validSelection(sel: unknown): LiveSelWire | null {
		if (!sel || typeof sel !== "object") return null;
		const s = sel as Record<string, unknown>;
		if (Array.isArray(s.b)) {
			const ids: string[] = [];
			for (const x of s.b as unknown[]) {
				if (ids.length >= OUTLINE_LIVE_BOUNDS.presenceBlocks) break;
				if (typeof x === "string" && x.length <= 64 && this.mirror.alive(x)) ids.push(x);
			}
			return { b: ids };
		}
		if (validPos(s.a) && validPos(s.h)) return { a: s.a as never, h: s.h as never };
		return null;
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

	/** Apply a participant's update, reporting whether it integrated cleanly. */
	private applyUpdate(p: Participant, update: Uint8Array): boolean {
		const store = this.doc.store as unknown as {
			pendingStructs: unknown;
			pendingDs: unknown;
		};
		const t0 = performance.now();
		try {
			Y.applyUpdate(this.doc, update, p);
		} catch {
			return false;
		} finally {
			this.stats.applyMs += performance.now() - t0;
		}
		this.stats.updatesIn++;
		this.stats.updateBytesIn += update.length;
		if (store.pendingStructs || store.pendingDs) {
			// The update depends on changes this session never had (a client out of step): it
			// would sit in the document forever. Drop it and have the client rebuild.
			store.pendingStructs = null;
			store.pendingDs = null;
			return false;
		}
		this.repairBroken();
		return true;
	}

	/** Live blocks whose text a participant's update removed get it back from the database. */
	private repairBroken(): void {
		if (this.broken.size === 0) return;
		const ids = [...this.broken];
		this.broken.clear();
		this.doc.transact(() => {
			for (const id of ids) {
				const b = this.mirror.alive(id);
				if (b && !(this.texts.get(id) instanceof Y.Text))
					this.texts.set(id, new Y.Text(b.dbContent));
			}
		}, SERVER_ORIGIN);
	}

	/** A text-only update (`update` frame). */
	handleUpdate(p: Participant, n: number, update: Uint8Array): void {
		if (this.participants.get(p.pno) !== p || p.blocked || this.closed) return;
		if (n <= p.lastTx) return;
		if (!p.canWrite) {
			this.reject(p, n, "read_only");
			return;
		}
		if (!this.applyUpdate(p, update)) {
			this.reject(p, n, "invalid");
			return;
		}
		this.processed(p, n);
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
				pageId: this.pageId,
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
		const now = Date.now();
		if (this.firstDirtyAt === 0) this.firstDirtyAt = now;
		this.lastDirtyAt = now;
		this.scheduleFlush();
	}

	private scheduleFlush(delayMs?: number): void {
		if (this.closed) return;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		const due =
			delayMs !== undefined
				? Date.now() + delayMs
				: Math.min(
						this.lastDirtyAt + OUTLINE_LIVE_TIMING.flushIdleMs,
						this.firstDirtyAt + OUTLINE_LIVE_TIMING.flushMaxMs,
					);
		this.flushTimer = setTimeout(
			() => {
				this.flushTimer = null;
				this.schedule(async () => {
					await this.flushContent();
				});
			},
			Math.max(0, due - Date.now()),
		);
		this.flushTimer.unref?.();
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
				await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
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
		const target = this.ytext(lastId) ?? this.ytext(plan.id);
		if (!target) return;
		const id = this.ytext(lastId) ? lastId : plan.id;
		const rest = plan.rest;
		this.doc.transact(() => target.insert(target.length, `\n${rest}`), SERVER_ORIGIN);
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
					pageIds: r.pageIds,
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
							},
							{ canonical: canonical.slice(a, b) },
						),
					),
				);
			} catch (error) {
				logger.warn("Outline live commit failed", {
					pageId: this.pageId,
					error: String(error),
					code: (error as { code?: string }).code,
				});
				throw new LiveChunkError(error, out, a);
			}
		}
		return out;
	}

	/** Record what the database holds for a block now (logged for replay, see `persistStep`). */
	private setDbContent(id: string, content: string): void {
		const b = this.mirror.get(id);
		if (!b || b.dbContent === content) return;
		this.mirror.update(id, { dbContent: content });
		this.syncPending.set(id, content);
		this.schedulePersist();
	}

	/** Bring a block's live text from `from` to `to`, keeping changes made since `from`. */
	private mergeText(id: string, from: string, to: string): void {
		const t = this.ytext(id);
		if (!t) return;
		const current = t.toString();
		const r = merge3(from, to, current, { lenient: true });
		if (!r.ok || r.result === current) return;
		this.doc.transact(() => {
			// Last first, so earlier offsets hold; hunks at one offset in reverse too (an insertion
			// before a deletion there must be applied after it), as `applyHunks` reads them.
			for (const h of [...r.patch].sort((a, b) => a.start - b.start).reverse()) {
				if (h.end > h.start) t.delete(h.start, h.end - h.start);
				if (h.text) t.insert(h.start, h.text);
			}
		}, SERVER_ORIGIN);
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
			clearTimeout(this.flushTimer);
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
		const deadline = Date.now() + OUTLINE_LIVE_TIMING.narrowBudgetMs;
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
				pageId: this.pageId,
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
				if (tried > 0 && Date.now() >= deadline) {
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
						pageId: this.pageId,
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
			this.firstDirtyAt = Date.now();
			this.scheduleFlush(OUTLINE_LIVE_TIMING.flushRetryMs);
		}
		return ok;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Structural transactions
	// ─────────────────────────────────────────────────────────────────────────

	/** A structural transaction (`tx` frame): check, apply, commit, broadcast or refuse. */
	async handleTx(p: Participant, n: number, rawHead: unknown, update: Uint8Array): Promise<void> {
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

		// The update goes in first (it creates the new blocks' texts) and is undone when the
		// commit fails, so a refused transaction leaves the session as it was. Its log rows are
		// held back until the commit is in: the log never holds a change the page refused.
		// The log's snapshot must not contain a change that may yet be refused: written first.
		if (!this.snapshotWritten) {
			this.snapshotWanted = true;
			if (!(await this.persistNow())) {
				this.reject(p, n, "failed");
				return;
			}
		}
		const undo = new Y.UndoManager(this.texts, {
			trackedOrigins: new Set([p]),
			captureTimeout: 0,
		});
		const mark = this.pendingRows.length;
		let held: PendingRow[] = [];
		const intents = new Map<string, string>();
		const refuse = (
			code: LiveRejectCode,
			committed: readonly OutlineWriteResult[] = [],
			claimed?: LiveClaimedWire,
		) => {
			const before = this.pendingRows.length;
			undo.undo();
			undo.destroy();
			// Neither the refused update nor its undo goes to the log.
			this.pendingRows.splice(before);
			held = [];
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
				const integrated = update.length === 0 || this.applyUpdate(p, update);
				touched = this.touched;
				held = this.pendingRows.splice(mark);
				if (!integrated) {
					refuse("invalid");
					return;
				}
			} finally {
				this.touched = null;
			}
			const inserted = new Map<string, Extract<LiveOp, { t: "i" }>>();
			for (const op of plan.ops) if (op.t === "i") inserted.set(op.id, op);
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
			undo.destroy();
			this.stats.txCommitted++;
			// The texts this commit wrote are settled, whoever typed them.
			for (const c of contents) this.dirty.delete(c.id);

			// The mirror follows what was written; the broadcast carries the canonical form.
			const written = results.flatMap((r) => r.results);
			const canonicalOps: LiveOp[] = [];
			for (const op of plan.ops) {
				const at = opOf.get(op);
				const r = at === undefined ? undefined : written[at];
				const moved = r?.adjustments?.find((x) => x.kind === "order-key-moved");
				const key =
					moved?.kind === "order-key-moved" ? moved.got : op.t === "i" || op.t === "m" ? op.k : "";
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
						this.mirror.put({
							id: op.id,
							sid: r?.sid ?? prior?.sid ?? "",
							parentId: op.p,
							orderKey: key,
							taskJson,
							deleted: false,
							dbContent: prior?.dbContent ?? "",
						});
						canonicalOps.push({ ...op, k: key });
						break;
					}
					case "m":
						this.mirror.update(op.id, { parentId: op.p, orderKey: key });
						canonicalOps.push({ ...op, k: key });
						break;
					case "d":
						for (const id of this.mirror.subtree(op.id)) {
							this.mirror.update(id, { deleted: true });
							canonicalOps.push({ t: "d", id });
						}
						break;
					case "k": {
						const b = this.mirror.get(op.id);
						this.mirror.update(op.id, {
							taskJson: op.task
								? { ...(b?.taskJson ?? { assignee: null }), status: LIVE_STATUS_OF_TASK[op.task] }
								: null,
						});
						canonicalOps.push(op);
						break;
					}
				}
			}
			this.settleContents(contents);
			this.processed(p, n);
			if (canonicalOps.length > 0) {
				const commit: LiveCommitWire = { o: ++this.opSeq, by: p.pno, ops: canonicalOps };
				this.recordCommit(commit);
				const acks = this.windowAcks.get(p.pno) ?? [];
				acks.push(sameOps(canonicalOps, ops) ? [n, commit.o] : [n, commit.o, canonicalOps]);
				this.windowAcks.set(p.pno, acks);
			}
			if (contents.some(reshapes)) await this.applyOwnResults(results);
			// In the log now: acknowledged with the next broadcast.
			await this.persistNow();
			this.scheduleBroadcast();
		} finally {
			this.holding--;
		}
	}

	private recordCommit(commit: LiveCommitWire): void {
		this.windowCommits.push(commit);
		this.opLog.push(commit);
		while (this.opLog.length > OUTLINE_LIVE_BOUNDS.opLog) this.opLog.shift();
		this.scheduleBroadcast();
	}

	/**
	 * Check a transaction against the mirror, as if applied in order. Returns the operations to
	 * write (deletes of blocks inside a block deleted by the same transaction dropped) and the
	 * blocks it deletes, or null when it does not fit the current structure.
	 */
	private planTx(ops: LiveOp[]): { ops: LiveOp[]; deleted: string[] } | null {
		const overlay = new Map<string, { parentId: string | null; deleted: boolean }>();
		const parentOf = (id: string): string | null | undefined =>
			overlay.has(id) ? overlay.get(id)?.parentId : this.mirror.get(id)?.parentId;
		const known = (id: string): boolean => overlay.has(id) || this.mirror.get(id) !== undefined;
		const alive = (id: string): boolean => {
			let cur: string | null | undefined = id;
			for (let guard = 0; cur && guard < 10_000; guard++) {
				const deleted = overlay.has(cur)
					? overlay.get(cur)?.deleted
					: this.mirror.get(cur)?.deleted;
				if (deleted !== false) return false;
				if (cur === this.pageId) return true;
				cur = parentOf(cur);
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
					if (!CLIENT_ID_RE.test(op.id) || !alive(op.p)) return null;
					if (known(op.id) && alive(op.id)) return null;
					overlay.set(op.id, { parentId: op.p, deleted: false });
					out.push(op);
					break;
				}
				case "m": {
					if (op.id === this.pageId || !alive(op.id) || !alive(op.p)) return null;
					if (isWithin(op.p, op.id)) return null;
					overlay.set(op.id, { parentId: op.p, deleted: false });
					out.push(op);
					break;
				}
				case "d": {
					if (op.id === this.pageId) return null;
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
					if (!alive(op.id) || op.id === this.pageId) return null;
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
							parent: { id: op.p },
							position: { orderKey: op.k },
							content: first.content,
							...(op.task !== undefined ? { task } : {}),
						});
					} else {
						out.push({
							op: "insert",
							id: op.id,
							parent: { id: op.p },
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
						parent: { id: op.p },
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
	 * the block versions each commit wrote under the pages it touched, update the mirror,
	 * merge changed content into the live texts, and broadcast the structural part.
	 */
	async applyCommits(commits: readonly CommittedEvent[]): Promise<void> {
		for (const commit of commits) {
			if (this.closed || !commit.pageIds.includes(this.pageId)) continue;
			const versions: OutlineVersionRow[] = [];
			for (const pageId of commit.pageIds) {
				const rows = await outlineStore.listPageVersions(pageId, {
					afterSeq: commit.seq - 1,
					limit: OUTLINE_LIMITS.maxRowsTouched + 1,
				});
				for (const v of rows) if (v.fromSeq === commit.seq) versions.push(v);
			}
			await this.applyVersions(versions, actorOf(commit));
		}
	}

	private async applyVersions(versions: OutlineVersionRow[], by: LiveActor): Promise<void> {
		const self = versions.find((v) => v.blockId === this.pageId);
		if (self && (self.deleted || self.parentId !== null)) {
			// The page itself was deleted or moved under another page: this session has nothing
			// left to edit. Its participants are told it ended (a rejoin finds the page gone).
			if (!this.restartRequested) {
				this.restartRequested = true;
				this.onEnd(this, "ended", false);
			}
			return;
		}
		const inserts: LiveOp[] = [];
		const moves: LiveOp[] = [];
		const tasks: LiveOp[] = [];
		const deletes: LiveOp[] = [];
		const created: OutlineVersionRow[] = [];
		for (const v of versions) {
			const m = this.mirror.get(v.blockId);
			const inPage = !v.deleted && v.pageId === this.pageId;
			if (inPage && (!m || m.deleted)) {
				created.push(v);
				continue;
			}
			if (!m || m.deleted) continue;
			if (!inPage) {
				this.mirror.update(v.blockId, { deleted: true });
				deletes.push({ t: "d", id: v.blockId });
				continue;
			}
			if (m.parentId !== v.parentId || m.orderKey !== v.orderKey) {
				this.mirror.update(v.blockId, { parentId: v.parentId, orderKey: v.orderKey });
				if (v.parentId !== null)
					moves.push({ t: "m", id: v.blockId, p: v.parentId, k: v.orderKey });
			}
			const task = taskCharOf(v.taskJson);
			if (task !== taskCharOf(m.taskJson)) tasks.push({ t: "k", id: v.blockId, task });
			if (JSON.stringify(v.taskJson) !== JSON.stringify(m.taskJson))
				this.mirror.update(v.blockId, { taskJson: v.taskJson });
			if (v.content !== null && v.content !== m.dbContent) {
				this.mergeText(v.blockId, m.dbContent, v.content);
				this.setDbContent(v.blockId, v.content);
			}
		}
		if (created.length > 0) {
			const sids = new Map(
				(
					await outlineStore.getBlockMetas(this.spaceId, { ids: created.map((v) => v.blockId) })
				).map((m) => [m.id, m.sid]),
			);
			this.doc.transact(() => {
				for (const v of created) {
					const prior = this.mirror.get(v.blockId);
					const content = v.content ?? "";
					this.mirror.put({
						id: v.blockId,
						sid: sids.get(v.blockId) ?? prior?.sid ?? "",
						parentId: v.parentId,
						orderKey: v.orderKey,
						taskJson: v.taskJson,
						deleted: false,
						dbContent: content,
					});
					this.syncPending.set(v.blockId, content);
					const t = this.ytext(v.blockId);
					if (!t) this.texts.set(v.blockId, new Y.Text(content));
					else if (t.toString() !== content) {
						t.delete(0, t.length);
						t.insert(0, content);
					}
				}
			}, SERVER_ORIGIN);
			// Parents before children.
			const ordered = [...created].sort(
				(a, b) =>
					this.mirror.depth(a.blockId) - this.mirror.depth(b.blockId) ||
					compareOrderKeys(a.orderKey, b.orderKey),
			);
			for (const v of ordered) {
				if (v.parentId === null) continue;
				const task = taskCharOf(v.taskJson);
				inserts.push({
					t: "i",
					id: v.blockId,
					p: v.parentId,
					k: v.orderKey,
					...(task ? { task } : {}),
				});
			}
		}
		// Blocks still in the page whose parent went: they went with it.
		const ops = [...inserts, ...moves, ...tasks, ...deletes];
		if (ops.length > 0) this.recordCommit({ o: ++this.opSeq, by, ops });
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Persistence
	// ─────────────────────────────────────────────────────────────────────────

	private schedulePersist(): void {
		if (this.persistTimer || this.closed) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			void this.persistNow();
		}, OUTLINE_LIVE_TIMING.persistMs);
		this.persistTimer.unref?.();
	}

	/**
	 * Append what arrived since the last append (a snapshot the first time). Resolves to whether
	 * everything up to the call is in the log.
	 */
	persistNow(): Promise<boolean> {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
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
					pageId: this.pageId,
					error: String(error),
				});
				return false;
			},
		);
	}

	/**
	 * One append. The log of an epoch is: a snapshot of the document, then increments, and
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
			this.keysPending.size === 0
		)
			return;
		this.pendingRows = [];
		const now = new Date().toISOString();
		const row = (data: Uint8Array, actorKind: "human" | "system", actorId: string) => ({
			pageBlockId: this.pageId,
			epoch: this.epoch,
			seq: this.logSeq++,
			updateB64: Buffer.from(data).toString("base64"),
			actorKind,
			actorId,
			createdAt: now,
		});
		const rows = [];
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
		let snapshot = false;
		if (!this.snapshotWritten) {
			// The whole document first: later increments build on the items it holds. Blocks
			// whose text is already ahead of the database get their database content synced.
			rows.push(row(Y.encodeStateAsUpdate(this.doc), "system", LIVE_LOG_ACTOR));
			snapshot = true;
			for (const b of this.mirror.all()) {
				if (!b.deleted && this.textOf(b.id) !== b.dbContent && !sync.has(b.id))
					sync.set(b.id, b.dbContent);
			}
		} else {
			const byActor = new Map<string, PendingRow[]>();
			for (const r of pending) {
				const key = `${r.actorKind}\u0000${r.actorId}`;
				const list = byActor.get(key);
				if (list) list.push(r);
				else byActor.set(key, [r]);
			}
			for (const list of byActor.values()) {
				const first = list[0] as PendingRow;
				rows.push(
					row(
						list.length === 1 ? first.update : Y.mergeUpdates(list.map((r) => r.update)),
						first.actorKind,
						first.actorId,
					),
				);
			}
		}
		if (sync.size > 0 || intents.size > 0 || cancels.size > 0 || keys.size > 0)
			rows.push(row(encodeSyncRow(sync, intents, cancels, keys), "system", LIVE_SYNC_ACTOR));
		try {
			await outlineStore.appendLiveUpdates(rows);
		} catch (error) {
			// Kept for the next attempt (the seq numbers drawn stay unused).
			this.pendingRows = [...pending, ...this.pendingRows];
			for (const key of keys.keys()) this.keysPending.add(key);
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
	private async compact(
		row: (
			data: Uint8Array,
			actorKind: "human" | "system",
			actorId: string,
		) => {
			pageBlockId: string;
			epoch: number;
			seq: number;
			updateB64: string;
			actorKind: "human" | "system";
			actorId: string;
			createdAt: string;
		},
	): Promise<void> {
		const ahead = new Map<string, string>();
		for (const b of this.mirror.all()) {
			if (!b.deleted && this.textOf(b.id) !== b.dbContent) ahead.set(b.id, b.dbContent);
		}
		// Updates waiting for the next append are in this snapshot: they need no row of their own
		// (unless the compaction fails). Ones arriving while it is written are not.
		const covered = this.pendingRows;
		this.pendingRows = [];
		const compacted = [row(Y.encodeStateAsUpdate(this.doc), "system", LIVE_LOG_ACTOR)];
		if (ahead.size > 0 || this.openIntents.size > 0 || this.keyDurable.size > 0) {
			compacted.push(
				row(
					encodeSyncRow(ahead, this.openIntents, new Set(), this.keyDurable),
					"system",
					LIVE_SYNC_ACTOR,
				),
			);
		}
		try {
			await outlineStore.replaceLiveUpdates(this.pageId, this.epoch, compacted);
		} catch (error) {
			this.pendingRows = [...covered, ...this.pendingRows];
			throw error;
		}
		this.snapshotBytes = (compacted[0] as { updateB64: string }).updateB64.length;
		this.rowsSinceCompact = compacted.length;
		this.bytesSinceCompact = 0;
		this.stats.compactions++;
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
		for (const timer of [
			this.broadcastTimer,
			this.presenceTimer,
			this.flushTimer,
			this.persistTimer,
			this.idleTimer,
		]) {
			if (timer) clearTimeout(timer);
		}
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
		if (this.closedClean) {
			try {
				await outlineStore.deleteLiveUpdates(this.pageId, this.epoch);
			} catch (error) {
				logger.warn("Outline live log could not be dropped", {
					pageId: this.pageId,
					error: String(error),
				});
			}
		} else {
			logger.warn("Outline live session closed with uncommitted text; the log is kept for replay", {
				pageId: this.pageId,
				epoch: this.epoch,
			});
		}
		this.doc.destroy();
	}
}

function encodeSyncRow(
	contents: ReadonlyMap<string, string>,
	intents: ReadonlyMap<string, string>,
	cancels: ReadonlySet<string>,
	keys: ReadonlyMap<string, number>,
): Uint8Array {
	return utf8.encode(
		JSON.stringify({
			...(contents.size > 0 ? { b: Object.fromEntries(contents) } : {}),
			...(intents.size > 0 ? { i: Object.fromEntries(intents) } : {}),
			...(cancels.size > 0 ? { x: [...cancels] } : {}),
			...(keys.size > 0 ? { k: Object.fromEntries(keys) } : {}),
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
	for (const item of list as Array<Record<string, unknown>>) {
		if (!item || typeof item !== "object" || !str(item.id)) return null;
		const id = item.id as string;
		switch (item.t) {
			case "i":
				if (!str(item.p) || !str(item.k)) return null;
				if (item.task !== undefined && item.task !== null && !isLiveTaskChar(item.task))
					return null;
				if (!isKey(item.k as string)) return null;
				out.push({
					t: "i",
					id,
					p: item.p as string,
					k: item.k as string,
					...(item.task !== undefined ? { task: item.task as LiveTaskChar | null } : {}),
				});
				break;
			case "m":
				if (!str(item.p) || !str(item.k) || !isKey(item.k as string)) return null;
				out.push({ t: "m", id, p: item.p as string, k: item.k as string });
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
 * is refused).
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
			].includes(error.code))
	);
}
