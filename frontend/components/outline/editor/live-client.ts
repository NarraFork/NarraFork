/**
 * One page's live session, client side (design §6.2–§6.6, ported from the editor prototype's
 * `client.ts` onto the real protocol, `shared/outline-live-protocol.ts`).
 *
 *   - Structure: confirmed (what the server acknowledged) + pending (applied optimistically,
 *     not acknowledged yet) = visible. The server orders, checks and commits each structural
 *     transaction; a refused one is dropped and the page is rebuilt from a fresh snapshot (the
 *     whole Yjs document too, so nothing of the refused change lingers), then the pending
 *     transactions the server had not applied are replayed on the new state: only the refused
 *     one is lost, and nothing the server already has is applied twice.
 *   - Text: one Yjs document; every block's `Y.Text` exists from the snapshot on (the server
 *     creates them all when the session opens; a new block's text is created by its creator in
 *     the same transaction).
 *   - Undo (design §6.6): one stack; a step is a transaction (typing in one block within a
 *     second merges); text through a `Y.UndoManager` that tracks only local changes, so only
 *     one's own edits are undone; structure through inverse operations.
 *   - Reconnect: the client resumes the same server session with its state vector and gets
 *     exactly what it lacks, then re-sends what the server had not processed. When the session
 *     is gone (the server restarted, or it closed while this client was away) it starts over
 *     from a snapshot. Every join names the session the client was in; the answer says which of
 *     its transactions the page applied (`tx`) and has safely (`dur`): those are not replayed,
 *     and applied ones not yet safe wait in {@link LiveClient.awaiting} for their
 *     acknowledgement.
 *   - Presence: who is here and where their cursors are, as Yjs relative positions; sent at
 *     most every {@link OUTLINE_LIVE_LIMITS.presenceIntervalMs}, never stored.
 *
 * No DOM: views (`view.ts`) attach through {@link ClientView}; tests drive this directly.
 */
import { type DeltaOp, type Hunk, merge3, simpleDiff } from "@shared/outline";
import {
	decodeLiveFrame,
	encodeLiveFrame,
	LIVE_FRAME,
	type LiveBatchHead,
	type LiveBlockWire,
	type LiveCloseCode,
	type LiveCommitWire,
	type LiveFrame,
	type LiveJoinedHead,
	type LiveJoinHead,
	type LiveModeHead,
	type LiveOp,
	type LivePeerWire,
	type LivePosWire,
	type LivePresenceDown,
	type LiveRejectHead,
	type LiveSelWire,
	OUTLINE_LIVE_LIMITS,
} from "@shared/outline-live-protocol";
import * as Y from "yjs";
import { type BlockRec, type ClientOp, Store, wireOp } from "./store";

/** Origin of the editor's own text changes (tracked by the undo manager). */
export const LOCAL = { origin: "local" };
/** Origin of replayed changes after a rebuild (sent, not undoable). */
export const REPLAY = { origin: "replay" };
/** Origin of everything that came from the server. */
export const REMOTE = { origin: "remote" };
/**
 * Origin of a new block's text being created (sent, not undoable). Undo removes and restores the
 * block through the structure; if the undo manager owned the text's creation, undoing it would
 * replace the text with a copy, and redoing later typing would land in the discarded one.
 */
export const CREATE = { origin: "create" };

/** What the transport offers: binary frames on the narrator socket (or a test socket). */
export interface LiveTransport {
	readonly connected: boolean;
	send(frame: Uint8Array): boolean;
	onFrame(listener: (frame: LiveFrame) => void): () => void;
	onConnectionChange(listener: (connected: boolean) => void): () => void;
	/** A handle unused on this socket (1–255), or null when the socket's limit is reached. */
	allocateHandle(): number | null;
	releaseHandle(handle: number): void;
}

export interface SelPoint {
	blockId: string;
	/** Offset in the block's editor content; -1 for a whole-block (node) selection. */
	offset: number;
}

export interface SelInfo {
	anchor: SelPoint;
	head: SelPoint;
	view: ClientView;
}

/** What a view (one ProseMirror editor over the page) receives from the client. */
export interface ClientView {
	/** A remote change to a block's text, as a Yjs delta (for mapping the local cursor). */
	noteDelta(id: string, delta: DeltaOp[]): void;
	/** A block's text changed in a way no delta describes (map change, own change elsewhere). */
	noteTextReset(id: string): void;
	/** Re-project the editor document from the client's state. */
	sync(): void;
	/** Forget cached nodes (after a rebuild). */
	resetCache(): void;
	/** Peers' cursors or block selections changed. */
	renderPresence(): void;
	restoreSelection(sel: SelInfo): void;
}

export interface BodyChange {
	id: string;
	/** The block's new markdown. */
	md: string;
	/** When given, written as these hunks (in the current text's coordinates). */
	hunks?: Hunk[];
}

export interface CommitInput {
	ops: ClientOp[];
	bodies: BodyChange[];
	kind: "typing" | "struct";
	blockId: string | null;
	selBefore: SelInfo | null;
	selAfter: SelInfo | null;
	view: ClientView | null;
}

interface PendingTx {
	n: number;
	ops: ClientOp[];
	/** The transaction's Yjs update (null until sent for a text batch being collected). */
	update: Uint8Array[];
	/** Text before and after, per block, for replay after a rebuild. */
	bodies: Map<string, { before: string; after: string }>;
	structural: boolean;
	sent: boolean;
	bytes: number;
}

interface Step {
	inverse: ClientOp[];
	usedUndoManager: boolean;
	umBefore: number;
	selBefore: SelInfo | null;
	selAfter: SelInfo | null;
	kind: string;
	blockId: string | null;
	time: number;
}

export interface Peer {
	pno: number;
	userId: string;
	name: string;
	color: string;
	editing: boolean;
	sel: LiveSelWire | null;
}

export type LiveStatus =
	/** Waiting for the server's answer to a join. */
	| "connecting"
	| "live"
	/** The socket is down; changes are kept and sent on reconnect. */
	| "offline"
	/** Too many unacknowledged changes: input is paused until the server catches up. */
	| "stalled"
	/** The session ended for this client; see `closeCode`. */
	| "closed";

export interface DeletedNotice {
	/** The block the cursor was in when someone else deleted it (or its ancestor). */
	blockId: string;
	/** The deleted subtree roots that restoring brings back, parents first. */
	restore: ClientOp[];
	by: string;
}

export type ClientEvent =
	| "status"
	| "presence"
	| "sync"
	| "deleted"
	| "rejected"
	| "readonly"
	| "closed";

let idCounter = 0;

function randomId(length: number): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let out = "";
	for (const b of bytes) out += alphabet[b % alphabet.length];
	return out;
}

function storeFromSnapshot(pageId: string, blocks: readonly LiveBlockWire[]): Store {
	const store = new Store(pageId);
	for (const [id, parent, orderKey, sid, task] of blocks) {
		store.put({
			id,
			parentId: parent < 0 ? null : (blocks[parent]?.[0] ?? null),
			orderKey,
			task: task === "" ? null : task,
			deleted: false,
			sid,
		});
	}
	return store;
}

export class LiveClient {
	doc!: Y.Doc;
	texts!: Y.Map<Y.Text>;
	um!: Y.UndoManager;
	confirmed: Store;
	visible: Store;
	pending: PendingTx[] = [];
	/**
	 * Transactions the server applied but has not logged yet (learned at a join): not sent or
	 * replayed again, and not applied to the visible structure (the server's state has them);
	 * kept until a batch acknowledges them, and replayed only if a later join says the page
	 * lost them.
	 */
	awaiting: PendingTx[] = [];
	readonly views = new Set<ClientView>();
	readonly presence = new Map<number, Peer>();
	undoStack: Step[] = [];
	redoStack: Step[] = [];
	status: LiveStatus = "connecting";
	closeCode: LiveCloseCode | null = null;
	canWrite = false;
	/** Set once the first snapshot arrived. */
	ready = false;
	deleted: DeletedNotice | null = null;
	readonly key = randomId(16);
	me = 0;
	epoch = 0;
	opSeq = 0;
	stats = {
		txSent: 0,
		framesSent: 0,
		bytesSent: 0,
		rejects: 0,
		rebuilds: 0,
		resumes: 0,
		resyncs: 0,
	};
	log: string[] = [];

	private handle: number | null = null;
	private n = 0;
	private ackedTx = 0;
	private textCache = new Map<string, string>();
	private outY: Uint8Array[] = [];
	private originView: ClientView | null = null;
	private undoing = false;
	private typingTimer: ReturnType<typeof setTimeout> | null = null;
	private presenceTimer: ReturnType<typeof setTimeout> | null = null;
	private lastPresence = "";
	private wantPresence: LiveSelWire | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private retries = 0;
	private readonly listeners = new Set<(event: ClientEvent) => void>();
	private readonly off: Array<() => void> = [];
	private disposed = false;
	/** A rebuild is under way: frames for the old document are ignored until the snapshot. */
	private resetting = false;

	constructor(
		private readonly transport: LiveTransport,
		readonly pageId: string,
		readonly mode: "edit" | "view",
	) {
		this.confirmed = new Store(pageId);
		this.visible = new Store(pageId);
		this.createDoc();
		this.off.push(transport.onFrame((frame) => this.receive(frame)));
		this.off.push(
			transport.onConnectionChange((connected) => {
				if (this.disposed) return;
				if (connected) this.join();
				else {
					this.setStatus(this.status === "closed" ? "closed" : "offline");
					for (const tx of this.pending) tx.sent = false;
				}
			}),
		);
		if (transport.connected) this.join();
		else this.setStatus("offline");
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Events
	// ─────────────────────────────────────────────────────────────────────────

	on(listener: (event: ClientEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: ClientEvent): void {
		for (const l of this.listeners) l(event);
	}

	private setStatus(status: LiveStatus): void {
		if (this.status === status) return;
		this.status = status;
		this.emit("status");
	}

	/** Nothing local waits to be sent (tests). */
	get quiet(): boolean {
		return (
			this.typingTimer === null && (this.status !== "live" || this.pending.every((tx) => tx.sent))
		);
	}

	/** Whether the editor may take input now. */
	get editable(): boolean {
		return (
			this.ready &&
			this.canWrite &&
			this.mode === "edit" &&
			this.status !== "closed" &&
			this.status !== "stalled"
		);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.flushTyping();
		for (const off of this.off.splice(0)) off();
		for (const t of [this.typingTimer, this.presenceTimer, this.retryTimer]) if (t) clearTimeout(t);
		if (this.handle !== null) {
			this.transport.send(encodeLiveFrame({ kind: LIVE_FRAME.leave, handle: this.handle }));
			this.transport.releaseHandle(this.handle);
			this.handle = null;
		}
		this.um.destroy();
		this.doc.destroy();
		this.views.clear();
		this.listeners.clear();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// The document
	// ─────────────────────────────────────────────────────────────────────────

	private createDoc(): void {
		this.doc = new Y.Doc();
		this.texts = this.doc.getMap<Y.Text>("texts");
		this.um = new Y.UndoManager(this.texts, {
			trackedOrigins: new Set([LOCAL]),
			captureTimeout: 1e12,
		});
		this.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin === REMOTE) return;
			this.outY.push(update);
		});
		this.texts.observeDeep((events, txn) => {
			const local = txn.origin === LOCAL || txn.origin === REPLAY || txn.origin === CREATE;
			for (const ev of events) {
				if (ev.target === this.texts) {
					for (const key of (ev as Y.YMapEvent<Y.Text>).keysChanged) {
						this.textCache.delete(key);
						for (const v of this.views) if (!(local && v === this.originView)) v.noteTextReset(key);
					}
					continue;
				}
				if (!(ev.target instanceof Y.Text)) continue;
				const id = (ev.target as unknown as { _item?: { parentSub?: string | null } })._item
					?.parentSub;
				if (!id) continue;
				this.textCache.delete(id);
				if (local) {
					for (const v of this.views) if (v !== this.originView) v.noteTextReset(id);
				} else {
					const delta = ev.delta as DeltaOp[];
					for (const v of this.views) v.noteDelta(id, delta);
				}
			}
		});
	}

	ytext(id: string): Y.Text | undefined {
		const t = this.texts.get(id);
		return t instanceof Y.Text ? t : undefined;
	}

	textOf(id: string): string {
		const c = this.textCache.get(id);
		if (c !== undefined) return c;
		const t = this.ytext(id);
		const s = t ? t.toString() : "";
		if (t) this.textCache.set(id, s);
		return s;
	}

	newId(): string {
		idCounter++;
		return `${randomId(14)}${idCounter.toString(36)}`;
	}

	pageOf(id: string): string {
		return this.visible.get(id) ? this.pageId : "";
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Joining
	// ─────────────────────────────────────────────────────────────────────────

	private join(): void {
		if (this.disposed) return;
		if (this.handle === null) this.handle = this.transport.allocateHandle();
		if (this.handle === null) {
			this.closeCode = "unavailable";
			this.setStatus("closed");
			this.emit("closed");
			return;
		}
		// After the first join the server always learns the session this client was in, so its
		// answer says which of the client's transactions the page has, snapshot or not.
		const known = this.epoch !== 0;
		const resume = known && this.ready && !this.resetting;
		const head: LiveJoinHead = {
			page: this.pageId,
			mode: this.mode,
			key: this.key,
			...(known
				? {
						resume: {
							epoch: this.epoch,
							op: this.opSeq,
							tx: this.ackedTx,
							...(resume ? {} : { reset: true }),
						},
					}
				: {}),
		};
		this.setStatus("connecting");
		this.sendFrame(
			encodeLiveFrame({
				kind: LIVE_FRAME.join,
				handle: this.handle,
				head,
				...(resume ? { body: Y.encodeStateVector(this.doc) } : {}),
			}),
		);
	}

	/** Start over from a snapshot (after a refusal): replays what was not acknowledged. */
	private rebuild(): void {
		this.resetting = true;
		this.stats.rebuilds++;
		if (this.typingTimer) {
			clearTimeout(this.typingTimer);
			this.typingTimer = null;
		}
		if (this.transport.connected) this.join();
	}

	private sendFrame(frame: Uint8Array): boolean {
		this.stats.framesSent++;
		this.stats.bytesSent += frame.length;
		return this.transport.send(frame);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Local changes
	// ─────────────────────────────────────────────────────────────────────────

	private writeBody(b: BodyChange, origin: unknown): { before: string; after: string } | null {
		const t = this.ytext(b.id);
		if (!t) return null;
		const cur = t.toString();
		if (cur === b.md && !b.hunks) return null;
		const hunks =
			b.hunks ??
			(() => {
				const h = simpleDiff(cur, b.md);
				return h ? [h] : [];
			})();
		if (hunks.length === 0) return null;
		this.doc.transact(() => {
			for (const h of [...hunks].sort((x, y) => y.start - x.start)) {
				if (h.end > h.start) t.delete(h.start, h.end - h.start);
				if (h.text) t.insert(h.start, h.text);
			}
		}, origin);
		this.textCache.delete(b.id);
		return { before: cur, after: t.toString() };
	}

	/** One local transaction: structure, text, an undo step, sent to the server. */
	commit(input: CommitInput): void {
		if (!this.editable) return;
		const now = performance.now();
		const last = this.undoStack[this.undoStack.length - 1];
		// Typing on from where the last keystroke left the cursor, within a second, is one step;
		// putting the cursor elsewhere first starts a new one.
		const merge =
			input.kind === "typing" &&
			last?.kind === "typing" &&
			last.blockId === input.blockId &&
			now - last.time < 1000 &&
			samePoint(last.selAfter?.head, input.selBefore?.head);
		let step: Step;
		if (merge && last) {
			step = last;
			step.time = now;
			step.selAfter = input.selAfter;
		} else {
			this.um.stopCapturing();
			step = {
				inverse: [],
				usedUndoManager: false,
				umBefore: this.um.undoStack.length,
				selBefore: input.selBefore,
				selAfter: input.selAfter,
				kind: input.kind,
				blockId: input.blockId,
				time: now,
			};
			this.undoStack.push(step);
		}
		this.originView = input.view;
		const inverses: ClientOp[] = [];
		const ops: ClientOp[] = [];
		const bodies = new Map<string, { before: string; after: string }>();
		try {
			const created = input.ops.filter((op) => op.t === "i" && !this.ytext(op.id));
			if (created.length > 0) {
				// New blocks' texts are created by their creator, in the same transaction.
				this.doc.transact(() => {
					for (const op of created) {
						if (op.t === "i") this.texts.set(op.id, new Y.Text(op.content));
					}
				}, CREATE);
			}
			for (const op of input.ops) {
				if (op.t === "d") {
					// A deleted block takes its whole live subtree, including blocks the view does
					// not show (folded, or tasks in the facts view): delete them explicitly,
					// deepest first, so undo brings every one of them back.
					for (const id of this.visible.subtree(op.id).slice(1).reverse()) {
						if (!this.visible.alive(id)) continue;
						const inv = this.visible.apply({ t: "d", id }, (x) => this.textOf(x));
						if (inv) inverses.unshift(inv);
						ops.push({ t: "d", id });
					}
				}
				const inv = this.visible.apply(op, (id) => this.textOf(id));
				if (inv) inverses.unshift(inv);
				ops.push(op);
				this.textCache.delete(op.id);
			}
			for (const b of input.bodies) {
				const change = this.writeBody(b, LOCAL);
				if (change) bodies.set(b.id, change);
			}
		} finally {
			this.originView = null;
		}
		step.inverse = [...inverses, ...step.inverse];
		if (this.um.undoStack.length > step.umBefore) step.usedUndoManager = true;
		this.redoStack = [];
		this.enqueue(ops, bodies, ops.length > 0);
		this.syncViews(input.view);
	}

	/** Queue what the last local transaction sent; text-only batches wait a moment. */
	private enqueue(
		ops: ClientOp[],
		bodies: Map<string, { before: string; after: string }>,
		structural: boolean,
	): void {
		const update = this.outY;
		this.outY = [];
		if (ops.length === 0 && update.length === 0) return;
		const bytes = update.reduce((n, u) => n + u.length, 0);
		const tail = this.pending[this.pending.length - 1];
		if (!structural && tail && !tail.structural && !tail.sent) {
			// Typing joins the batch being collected.
			tail.update.push(...update);
			tail.bytes += bytes;
			for (const [id, change] of bodies) {
				const prev = tail.bodies.get(id);
				tail.bodies.set(id, prev ? { before: prev.before, after: change.after } : change);
			}
		} else {
			if (structural) this.flushTyping();
			this.pending.push({ n: ++this.n, ops, update, bodies, structural, sent: false, bytes });
		}
		if (structural) this.sendPending();
		else if (!this.typingTimer) {
			this.typingTimer = setTimeout(() => {
				this.typingTimer = null;
				this.sendPending();
			}, OUTLINE_LIVE_LIMITS.typingBatchMs);
		}
		this.checkStall();
	}

	private flushTyping(): void {
		if (this.typingTimer) {
			clearTimeout(this.typingTimer);
			this.typingTimer = null;
		}
		this.sendPending();
	}

	/** Send every pending transaction not sent yet, in order. */
	private sendPending(): void {
		if (this.status !== "live" || this.handle === null || this.resetting) return;
		for (const tx of this.pending) {
			if (tx.sent) continue;
			const body = tx.update.length > 1 ? Y.mergeUpdates(tx.update) : tx.update[0];
			if (tx.update.length > 1 && body) tx.update = [body];
			const frame = tx.structural
				? encodeLiveFrame({
						kind: LIVE_FRAME.tx,
						handle: this.handle,
						n: tx.n,
						head: { ops: tx.ops.map(wireOp) },
						...(body ? { body } : {}),
					})
				: encodeLiveFrame({
						kind: LIVE_FRAME.update,
						handle: this.handle,
						n: tx.n,
						...(body ? { body } : {}),
					});
			if (frame.length > OUTLINE_LIVE_LIMITS.maxClientFrameBytes) {
				this.log.push(`transaction ${tx.n} too large to send (${frame.length} bytes)`);
			}
			if (!this.sendFrame(frame)) return;
			tx.sent = true;
			this.stats.txSent++;
		}
	}

	private checkStall(): void {
		const bytes = [...this.pending, ...this.awaiting].reduce((n, tx) => n + tx.bytes, 0);
		const stalled =
			this.pending.length > OUTLINE_LIVE_LIMITS.maxPendingTx ||
			bytes > OUTLINE_LIVE_LIMITS.maxPendingBytes;
		if (stalled && this.status === "live") this.setStatus("stalled");
		else if (!stalled && this.status === "stalled") this.setStatus("live");
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Undo
	// ─────────────────────────────────────────────────────────────────────────

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	undo(): boolean {
		if (!this.editable) return false;
		const step = this.undoStack.pop();
		if (!step) return false;
		this.redoStack.push(this.replay(step, "undo"));
		return true;
	}

	redo(): boolean {
		if (!this.editable) return false;
		const step = this.redoStack.pop();
		if (!step) return false;
		this.undoStack.push(this.replay(step, "redo"));
		return true;
	}

	get isUndoing(): boolean {
		return this.undoing;
	}

	/** Apply a step's inverse; returns the step that goes the other way. */
	private replay(step: Step, dir: "undo" | "redo"): Step {
		this.um.stopCapturing();
		this.undoing = true;
		const ops: ClientOp[] = [];
		const inverses: ClientOp[] = [];
		try {
			for (const op of step.inverse) {
				if (!this.validLocally(op)) {
					this.log.push(`${dir} skipped ${op.t} ${op.id}: the structure changed`);
					continue;
				}
				const inv = this.visible.apply(op, (id) => this.textOf(id));
				if (inv) inverses.unshift(inv);
				ops.push(op);
				this.textCache.delete(op.id);
			}
			if (step.usedUndoManager) {
				if (dir === "undo") this.um.undo();
				else this.um.redo();
			}
		} finally {
			this.undoing = false;
		}
		this.enqueue(ops, new Map(), ops.length > 0);
		this.syncViews(null);
		const sel = step.selBefore;
		if (sel) sel.view.restoreSelection(sel);
		return {
			inverse: inverses,
			usedUndoManager: step.usedUndoManager,
			umBefore: 0,
			selBefore: step.selAfter,
			selAfter: step.selBefore,
			kind: "struct",
			blockId: step.blockId,
			time: 0,
		};
	}

	/** Whether an operation still fits the visible structure. */
	private validLocally(op: ClientOp | LiveOp): boolean {
		const v = this.visible;
		switch (op.t) {
			case "i":
				return v.inPage(op.p) && !v.alive(op.id);
			case "m":
				return (
					v.inPage(op.id) &&
					v.inPage(op.p) &&
					op.p !== op.id &&
					!v.isAncestor(op.id, op.p) &&
					op.id !== this.pageId
				);
			case "d":
				return !!v.alive(op.id) && op.id !== this.pageId;
			case "k":
				return v.inPage(op.id);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Presence
	// ─────────────────────────────────────────────────────────────────────────

	private relOf(blockId: string, offset: number): LivePosWire {
		const t = this.ytext(blockId);
		if (!t || offset >= t.length) return [blockId, null];
		const rel = Y.relativePositionToJSON(
			Y.createRelativePositionFromTypeIndex(t, Math.max(0, offset)),
		) as { item?: { client: number; clock: number } | null; assoc?: number };
		return [blockId, rel.item ? [rel.item.client, rel.item.clock, rel.assoc ?? 0] : null];
	}

	/** A peer's position as a block and a source offset, or null when it no longer resolves. */
	resolvePos(pos: LivePosWire): { blockId: string; offset: number } | null {
		const [blockId, rel] = pos;
		const t = this.ytext(blockId);
		if (!t || !this.visible.alive(blockId)) return null;
		if (rel === null) return { blockId, offset: t.length };
		const abs = Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromJSON({ item: { client: rel[0], clock: rel[1] }, assoc: rel[2] }),
			this.doc,
		);
		if (!abs || abs.type !== t) return null;
		return { blockId, offset: abs.index };
	}

	/**
	 * Tell the others where this editor's cursor is: a range in source offsets, a set of whole
	 * blocks, or nothing. Coalesced and throttled.
	 */
	setSelection(
		sel:
			| { anchor: { blockId: string; offset: number }; head: { blockId: string; offset: number } }
			| { blocks: string[] }
			| null,
	): void {
		this.wantPresence = !sel
			? null
			: "blocks" in sel
				? { b: sel.blocks.slice(0, 500) }
				: {
						a: this.relOf(sel.anchor.blockId, sel.anchor.offset),
						h: this.relOf(sel.head.blockId, sel.head.offset),
					};
		if (this.presenceTimer) return;
		this.presenceTimer = setTimeout(() => {
			this.presenceTimer = null;
			this.sendPresence();
		}, OUTLINE_LIVE_LIMITS.presenceIntervalMs);
	}

	private sendPresence(): void {
		if (this.status !== "live" || this.handle === null) return;
		const key = JSON.stringify(this.wantPresence);
		if (key === this.lastPresence) return;
		this.lastPresence = key;
		this.sendFrame(
			encodeLiveFrame({
				kind: LIVE_FRAME.selection,
				handle: this.handle,
				head: { s: this.wantPresence },
			}),
		);
	}

	private applyPeers(peers: readonly LivePeerWire[] | undefined): void {
		for (const [pno, userId, name, color, mode] of peers ?? []) {
			if (pno === this.me) continue;
			const prior = this.presence.get(pno);
			this.presence.set(pno, {
				pno,
				userId,
				name,
				color,
				editing: mode === "e",
				sel: prior?.sel ?? null,
			});
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Receiving
	// ─────────────────────────────────────────────────────────────────────────

	private rebuildVisible(): void {
		const v = this.confirmed.clone();
		for (const tx of this.pending) for (const op of tx.ops) v.apply(op);
		this.visible = v;
		this.textCache.clear();
	}

	private applyRemoteY(update: Uint8Array): void {
		if (update.length === 0) return;
		Y.applyUpdate(this.doc, update, REMOTE);
	}

	receive(frame: LiveFrame): void {
		if (this.disposed || frame.handle !== this.handle) return;
		switch (frame.kind) {
			case LIVE_FRAME.joined:
				this.onJoined(frame.head as LiveJoinedHead, frame.body);
				break;
			case LIVE_FRAME.batch:
				if (!this.resetting) this.onBatch(frame.n, frame.head as LiveBatchHead | null, frame.body);
				break;
			case LIVE_FRAME.reject:
				if (!this.resetting) this.onReject(frame.n, (frame.head as LiveRejectHead | null)?.code);
				break;
			case LIVE_FRAME.presence:
				if (!this.resetting) this.onPresence(frame.head as LivePresenceDown);
				break;
			case LIVE_FRAME.mode:
				this.canWrite = (frame.head as LiveModeHead).w;
				this.emit(this.canWrite ? "status" : "readonly");
				this.emit("status");
				this.syncViews(null);
				break;
			case LIVE_FRAME.resync:
				this.stats.resyncs++;
				this.join();
				break;
			case LIVE_FRAME.closed:
				this.onClosed(
					((frame.head as { code?: LiveCloseCode } | null)?.code ?? "ended") as LiveCloseCode,
				);
				break;
		}
	}

	/** Raw bytes from a transport that does not decode. */
	receiveBytes(bytes: Uint8Array): void {
		const frame = decodeLiveFrame(bytes);
		if (frame) this.receive(frame);
	}

	private onJoined(head: LiveJoinedHead, body: Uint8Array): void {
		this.retries = 0;
		this.me = head.me;
		this.canWrite = head.w;
		this.presence.clear();
		this.applyPeers(head.peers);
		for (const [pno, sel] of head.cur ?? []) {
			const p = this.presence.get(pno);
			if (p) p.sel = sel;
		}
		// What the page has of this client's transactions: forget what is logged, keep what is
		// applied but not logged (unsent, not replayed), send or replay the rest.
		const all = [...this.awaiting, ...this.pending].sort((x, y) => x.n - y.n);
		const dur = head.dur ?? 0;
		const applied = Math.max(head.tx, dur);
		const kept = all.filter((tx) => tx.n > dur);
		this.awaiting = kept.filter((tx) => tx.n <= applied);
		const rest = kept.filter((tx) => tx.n > applied);
		this.ackedTx = Math.max(this.ackedTx, dur);
		if (head.mode === "resume" && this.ready && !this.resetting) {
			this.stats.resumes++;
			this.onResumed(head, body, rest);
		} else {
			this.onReset(head, body, rest);
		}
		this.epoch = head.epoch;
		this.opSeq = head.op;
		this.setStatus("live");
		this.checkStall();
		this.sendPending();
		this.lastPresence = "";
		if (this.wantPresence) this.sendPresence();
		this.emit("presence");
		for (const v of this.views) v.renderPresence();
	}

	private onReset(head: LiveJoinedHead, body: Uint8Array, rest: PendingTx[]): void {
		// Only what the page does not have is replayed onto the snapshot.
		const replay = this.ready ? rest : [];
		const first = !this.ready;
		// Everything local goes: a fresh document from the snapshot (a refused change must not
		// linger in it), then this client's unacknowledged changes are replayed on top.
		this.um.destroy();
		this.doc.destroy();
		this.createDoc();
		this.outY = [];
		this.applyRemoteY(body);
		this.confirmed = storeFromSnapshot(this.pageId, head.blocks ?? []);
		this.pending = [];
		this.visible = this.confirmed.clone();
		this.textCache.clear();
		this.undoStack = [];
		this.redoStack = [];
		this.resetting = false;
		this.ready = true;
		if (replay.length > 0) this.replayPending(replay);
		for (const v of this.views) v.resetCache();
		this.syncViews(null);
		if (!first) this.log.push(`rebuilt from a snapshot, replayed ${replay.length} transaction(s)`);
	}

	/** Re-apply transactions the server never took onto the rebuilt state, as new ones. */
	private replayPending(txs: readonly PendingTx[]): void {
		for (const tx of txs) {
			const ops: ClientOp[] = [];
			const bodies = new Map<string, { before: string; after: string }>();
			const created = new Set<string>();
			for (const op of tx.ops) {
				if (!this.validLocally(op)) continue;
				if (op.t === "i" && !this.ytext(op.id)) {
					const text = tx.bodies.get(op.id)?.after ?? op.content;
					this.doc.transact(() => this.texts.set(op.id, new Y.Text(text)), REPLAY);
					created.add(op.id);
				}
				this.visible.apply(op, (id) => this.textOf(id));
				ops.push(op);
			}
			for (const [id, { before, after }] of tx.bodies) {
				if (created.has(id)) continue;
				const t = this.ytext(id);
				if (!t || !this.visible.alive(id)) continue;
				const current = t.toString();
				const r = merge3(before, after, current, { lenient: true });
				if (!r.ok || r.result === current) continue;
				const change = this.writeBody({ id, md: r.result, hunks: r.patch }, REPLAY);
				if (change) bodies.set(id, change);
			}
			this.enqueue(ops, bodies, ops.length > 0);
		}
		this.flushTyping();
	}

	private onResumed(head: LiveJoinedHead, body: Uint8Array, rest: PendingTx[]): void {
		// What the server has not applied goes again; what it applied is in the state it sends.
		this.pending = rest;
		for (const tx of this.pending) tx.sent = false;
		if (head.blocks) this.confirmed = storeFromSnapshot(this.pageId, head.blocks);
		else for (const c of head.ops ?? []) this.applyCommit(c);
		this.applyRemoteY(body);
		this.rebuildVisible();
		this.syncViews(null);
	}

	private applyCommit(commit: LiveCommitWire, own = false): void {
		const before = own ? null : this.cursorBlocks();
		for (const op of commit.ops) this.confirmed.apply(op);
		this.opSeq = Math.max(this.opSeq, commit.o);
		if (before && commit.ops.some((op) => op.t === "d")) this.noteDeletion(before, commit);
	}

	private onBatch(ack: number, head: LiveBatchHead | null, body: Uint8Array): void {
		const commits: Array<{ o: number; apply: () => void }> = [];
		const acks = new Map((head?.a ?? []).map((a) => [a[0], a] as const));
		if (ack > 0) {
			if (this.awaiting.length > 0) this.awaiting = this.awaiting.filter((tx) => tx.n > ack);
			const done = this.pending.filter((tx) => tx.n <= ack);
			this.pending = this.pending.filter((tx) => tx.n > ack);
			this.ackedTx = Math.max(this.ackedTx, ack);
			for (const tx of done) {
				const a = acks.get(tx.n);
				if (!a) continue;
				const ops = a[2] ?? tx.ops.map(wireOp);
				commits.push({
					o: a[1],
					apply: () => this.applyCommit({ o: a[1], by: this.me, ops }, true),
				});
			}
		}
		for (const c of head?.c ?? []) commits.push({ o: c.o, apply: () => this.applyCommit(c) });
		commits.sort((a, b) => a.o - b.o);
		for (const c of commits) c.apply();
		this.rebuildVisible();
		this.applyRemoteY(body);
		this.checkStall();
		if (commits.length > 0 || body.length > 0) this.syncViews(null);
	}

	private onReject(n: number, code: string | undefined): void {
		this.stats.rejects++;
		this.log.push(`transaction ${n} refused: ${code ?? "?"}`);
		// Acknowledged ones were answered before the refusal; the refused one is dropped; the
		// server ignores the rest until this client joins again, and they are replayed then.
		this.pending = this.pending.filter((tx) => tx.n !== n);
		if (code === "read_only") {
			this.canWrite = false;
			this.pending = [];
			this.emit("readonly");
		}
		this.emit("rejected");
		this.rebuild();
	}

	private onPresence(head: LivePresenceDown): void {
		this.applyPeers(head.peers);
		for (const pno of head.gone ?? []) this.presence.delete(pno);
		for (const [pno, sel] of head.cur ?? []) {
			const p = this.presence.get(pno);
			if (p) p.sel = sel;
		}
		this.emit("presence");
		for (const v of this.views) v.renderPresence();
	}

	private onClosed(code: LiveCloseCode): void {
		this.closeCode = code;
		if (code === "ended" || code === "unavailable") {
			// The session closed (shutdown, idle, a limit): try again a little later.
			this.setStatus("offline");
			if (this.retryTimer) clearTimeout(this.retryTimer);
			const delay = Math.min(30_000, 1000 * 2 ** this.retries++);
			this.retryTimer = setTimeout(() => {
				this.retryTimer = null;
				this.resetting = true;
				if (this.transport.connected) this.join();
			}, delay);
			return;
		}
		this.setStatus("closed");
		this.emit("closed");
	}

	// ─────────────────────────────────────────────────────────────────────────
	// "Deleted by someone else"
	// ─────────────────────────────────────────────────────────────────────────

	/** Blocks a local cursor is in, for the deleted notice. Views report it through `cursor`. */
	private cursorBlocks(): string[] {
		return this.cursorBlock ? [this.cursorBlock] : [];
	}

	/** The block the local cursor is in (set by the views). */
	cursorBlock: string | null = null;

	private noteDeletion(cursor: string[], commit: LiveCommitWire): void {
		const removed = new Set(commit.ops.filter((op) => op.t === "d").map((op) => op.id));
		const hit = cursor.find((id) => removed.has(id));
		if (!hit) return;
		// Restore the topmost deleted ancestor of the cursor's block and everything deleted with it.
		let top = hit;
		for (let cur = this.confirmed.get(hit)?.parentId ?? null; cur && removed.has(cur); ) {
			top = cur;
			cur = this.confirmed.get(cur)?.parentId ?? null;
		}
		const restore: ClientOp[] = [];
		const walk = (id: string) => {
			const b = this.confirmed.get(id);
			if (!b || b.parentId === null) return;
			restore.push({
				t: "i",
				id,
				p: b.parentId,
				k: b.orderKey,
				task: b.task,
				content: this.textOf(id),
			});
			for (const [kid, rec] of this.confirmed.blocks)
				if (rec.parentId === id && removed.has(kid)) walk(kid);
		};
		walk(top);
		const peer = typeof commit.by === "number" ? this.presence.get(commit.by) : undefined;
		this.deleted = {
			blockId: hit,
			restore,
			by: peer?.name ?? (commit.by === "a" ? "agent" : ""),
		};
		this.emit("deleted");
	}

	/** Bring back what the deleted notice names (one transaction). */
	restoreDeleted(): void {
		const notice = this.deleted;
		this.deleted = null;
		this.emit("deleted");
		if (!notice || !this.editable) return;
		const ops = notice.restore.filter((op) => op.t !== "i" || !this.visible.alive(op.id));
		if (ops.length === 0 || !this.validLocally(ops[0] as ClientOp)) return;
		this.commit({
			ops,
			bodies: [],
			kind: "struct",
			blockId: null,
			selBefore: null,
			selAfter: null,
			view: null,
		});
	}

	dismissDeleted(): void {
		this.deleted = null;
		this.emit("deleted");
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Views
	// ─────────────────────────────────────────────────────────────────────────

	syncViews(except: ClientView | null): void {
		for (const v of this.views) if (v !== except) v.sync();
		this.emit("sync");
	}

	/** The page as a markdown-ish outline (tests and debugging). */
	outline(rootId = this.pageId): string {
		const lines: string[] = [];
		const walk = (id: string, depth: number) => {
			for (const c of this.visible.children(id)) {
				const b = this.visible.get(c) as BlockRec;
				const task = b.task ? `[${b.task}] ` : "";
				lines.push(
					`${"  ".repeat(depth)}- ${task}${this.textOf(c)
						.split("\n")
						.join(`\n${"  ".repeat(depth + 1)}`)}`,
				);
				walk(c, depth + 1);
			}
		};
		walk(rootId, 0);
		return lines.join("\n");
	}
}

/** Whether typing continues where it left off (unknown without a cursor: assumed so). */
function samePoint(a: SelPoint | undefined, b: SelPoint | undefined): boolean {
	return !a || !b || (a.blockId === b.blockId && a.offset === b.offset);
}
