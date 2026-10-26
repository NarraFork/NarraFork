/**
 * 客户端副本：一个用户一个。
 * - 结构：confirmed（服务端已确认到某个 seq 的状态）+ pending（已乐观应用、待确认的本地事务）= visible。
 * - 正文：每页一个 Y.Doc 副本，块的 Y.Text 存 markdown 源文本。
 * - 撤销（§6.6）：每个用户一个栈，一个大纲事务一步（连续输入合并）；正文用 Y.UndoManager，
 *   只撤销自己的；结构用逆操作。经嵌入/拼接视图编辑别的页，也记在同一个栈里。
 */
import * as Y from "yjs";
import { applyHunks, type DeltaOp, type Hunk, simpleDiff } from "../model/diff";
import { merge3 } from "../model/merge3";
import { type BlockRec, type Op, Store } from "../model/store";
import type { Msg, Net } from "../net";
import type { OutlineView } from "./view";

export const LOCAL = { origin: "local" };
/** 撤销 / 重做中手工计算的正文逆操作（没有 Y.Text 时发的 text 操作的逆）：不进 UndoManager。 */
export const MANUAL = { origin: "manual" };
export const REMOTE = "remote";

export interface PageState {
	doc: Y.Doc;
	texts: Y.Map<Y.Text>;
	um: Y.UndoManager;
	joined: boolean;
	waiters: Array<() => void>;
}

export interface SelPoint {
	blockId: string;
	offset: number;
}

export interface SelInfo {
	anchor: SelPoint;
	head: SelPoint;
	view: OutlineView;
}

interface Step {
	inverse: Op[];
	umPages: Set<string>;
	selBefore: SelInfo | null;
	selAfter: SelInfo | null;
	kind: string;
	blockId: string | null;
	time: number;
	umLen: Map<string, number>;
}

export interface BodyChange {
	id: string;
	md: string;
	/** 指定补丁（当前 Y.Text 坐标）时按补丁写，否则按前后缀 diff。 */
	hunks?: Hunk[];
}

export interface CommitInput {
	ops: Op[];
	bodies: BodyChange[];
	kind: "typing" | "struct";
	blockId: string | null;
	selBefore: SelInfo | null;
	selAfter: SelInfo | null;
	view: OutlineView | null;
}

let seqId = 0;

export class Client {
	confirmed = new Store();
	visible = new Store();
	pending: Array<{ txId: string; ops: Op[] }> = [];
	pages = new Map<string, PageState>();
	views = new Set<OutlineView>();
	undoStack: Step[] = [];
	redoStack: Step[] = [];
	originView: OutlineView | null = null;
	presence = new Map<
		string,
		{ user: string; color: string; pageId: string; blockId: string; offset: number }
	>();
	stats = { txSent: 0, rejects: 0, resyncs: 0, remoteTx: 0, deferredSyncs: 0 };
	log: string[] = [];
	private outY = new Map<string, Uint8Array[]>();
	/** 还没被确认的 text 操作（Y.Text 建好之前的输入）：确认之前一直用乐观内容，后续输入也继续走 text 操作。 */
	pendingText = new Map<string, number>();
	private textCache = new Map<string, string>();
	private openRequested = new Set<string>();
	private resyncing = new Set<string>();
	private txCounter = 0;
	private undoing = false;
	onChange: (() => void) | null = null;

	constructor(
		public id: string,
		public user: string,
		public color: string,
		private net: Net,
	) {
		net.attachClient(id, (m) => this.receive(m));
	}

	newId(): string {
		seqId++;
		return `${this.id.toLowerCase()}${seqId.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	}

	// ---------- 页与正文 ----------

	page(pageId: string): PageState {
		let p = this.pages.get(pageId);
		if (!p) p = this.createPage(pageId);
		return p;
	}

	private createPage(pageId: string): PageState {
		const doc = new Y.Doc();
		const texts = doc.getMap<Y.Text>("texts");
		const um = new Y.UndoManager(texts, {
			trackedOrigins: new Set([LOCAL]),
			captureTimeout: 1e12,
		});
		const p: PageState = { doc, texts, um, joined: false, waiters: [] };
		doc.on("update", (u: Uint8Array, origin: unknown) => {
			if (origin === REMOTE) return;
			let arr = this.outY.get(pageId);
			if (!arr) {
				arr = [];
				this.outY.set(pageId, arr);
			}
			arr.push(u);
		});
		texts.observeDeep((events, txn) => {
			const local = txn.origin === LOCAL;
			for (const ev of events) {
				if (ev.target === texts) {
					for (const key of (ev as Y.YMapEvent<Y.Text>).keysChanged) {
						this.textCache.delete(key);
						for (const v of this.views) if (!(local && v === this.originView)) v.noteTextReset(key);
					}
				} else if (ev.target instanceof Y.Text) {
					const id = (ev.target as unknown as { _item: { parentSub: string } })._item?.parentSub;
					if (!id) continue;
					this.textCache.delete(id);
					if (local) {
						for (const v of this.views) if (v !== this.originView) v.noteTextReset(id);
					} else if ((this.pendingText.get(id) ?? 0) > 0) {
						// 编辑器显示的是乐观内容，Y.Text 的 delta 对不上：确认后按 diff 映射光标
						for (const v of this.views) v.noteTextReset(id);
					} else {
						const delta = ev.delta as DeltaOp[];
						for (const v of this.views) v.noteDelta(id, delta);
					}
				}
			}
		});
		this.pages.set(pageId, p);
		return p;
	}

	joinPage(pageId: string): Promise<void> {
		const p = this.page(pageId);
		if (p.joined) return Promise.resolve();
		const wait = new Promise<void>((r) => p.waiters.push(r));
		if (p.waiters.length === 1) this.net.sendToServer(this.id, { t: "join", pageId });
		return wait;
	}

	pageOf(id: string): string {
		const b = this.visible.get(id);
		if (!b) return "";
		return b.parentId === null ? b.id : b.pageId;
	}

	ytext(id: string): Y.Text | undefined {
		const b = this.visible.get(id);
		if (!b) return undefined;
		return this.pages.get(b.pageId)?.texts.get(id);
	}

	textOf(id: string): string {
		if ((this.pendingText.get(id) ?? 0) > 0) return this.visible.get(id)?.content ?? "";
		const c = this.textCache.get(id);
		if (c !== undefined) return c;
		const t = this.ytext(id);
		const s = t ? t.toString() : (this.visible.get(id)?.content ?? "");
		if (t) this.textCache.set(id, s);
		return s;
	}

	/** 光标进入一个块：请服务端为它建 Y.Text（已有块只能由服务端初始化）。 */
	openBlock(id: string) {
		if (this.ytext(id) || this.openRequested.has(id)) return;
		const b = this.visible.get(id);
		if (!b || b.parentId === null) return;
		this.openRequested.add(id);
		this.net.sendToServer(this.id, { t: "open", id });
	}

	sendPresence(pageId: string, blockId: string, offset: number) {
		this.net.sendToServer(this.id, {
			t: "presence",
			pageId,
			clientId: this.id,
			user: this.user,
			color: this.color,
			blockId,
			offset,
		});
	}

	// ---------- 本地事务 ----------

	private stopCapturing() {
		for (const p of this.pages.values()) p.um.stopCapturing();
	}

	private umLengths(): Map<string, number> {
		const m = new Map<string, number>();
		for (const [k, p] of this.pages) m.set(k, p.um.undoStack.length);
		return m;
	}

	/** 写一段正文：有 Y.Text 写差异；没有就发 text 操作，由服务端初始化后三方合并。 */
	private writeBody(b: BodyChange, origin: unknown, ops: Op[], inverses: Op[]) {
		const t = (this.pendingText.get(b.id) ?? 0) > 0 ? undefined : this.ytext(b.id);
		if (t) {
			const cur = t.toString();
			if (cur === b.md && !b.hunks) return;
			const pageId = this.visible.get(b.id)?.pageId ?? "";
			const doc = this.page(pageId).doc;
			doc.transact(() => {
				const hunks =
					b.hunks ??
					(() => {
						const h = simpleDiff(cur, b.md);
						return h ? [h] : [];
					})();
				for (const h of [...hunks].sort((x, y) => y.start - x.start)) {
					if (h.end > h.start) t.delete(h.start, h.end - h.start);
					if (h.text) t.insert(h.start, h.text);
				}
			}, origin);
			return;
		}
		const base = this.visible.get(b.id)?.content ?? "";
		if (base === b.md) return;
		const op: Op = { t: "text", id: b.id, base, next: b.md };
		this.pendingText.set(b.id, (this.pendingText.get(b.id) ?? 0) + 1);
		const inv = this.visible.apply(op);
		if (inv) inverses.unshift(inv);
		ops.push(op);
		this.textCache.delete(b.id);
	}

	commit(input: CommitInput) {
		const now = performance.now();
		const last = this.undoStack[this.undoStack.length - 1];
		const merge =
			input.kind === "typing" &&
			last?.kind === "typing" &&
			last.blockId === input.blockId &&
			now - last.time < 1000;
		let step: Step;
		if (merge && last) {
			step = last;
			step.time = now;
			step.selAfter = input.selAfter;
		} else {
			this.stopCapturing();
			step = {
				inverse: [],
				umPages: new Set(),
				selBefore: input.selBefore,
				selAfter: input.selAfter,
				kind: input.kind,
				blockId: input.blockId,
				time: now,
				umLen: this.umLengths(),
			};
			this.undoStack.push(step);
		}
		this.originView = input.view;
		const ops: Op[] = [];
		const inverses: Op[] = [];
		try {
			for (const op of input.ops) {
				if (op.t === "insert") {
					// 新建的块由创建方初始化 Y.Text（恢复已删的块时，Y.Text 还在，不重复初始化）
					const pageState = this.page(op.pageId);
					if (!pageState.texts.get(op.id)) {
						pageState.doc.transact(() => {
							pageState.texts.set(op.id, new Y.Text(op.content));
						}, LOCAL);
					}
				}
				const inv = this.visible.apply(op, (id) => this.textOf(id));
				if (inv) inverses.unshift(inv);
				ops.push(op);
				this.textCache.delete(op.id);
			}
			for (const b of input.bodies) this.writeBody(b, LOCAL, ops, inverses);
		} finally {
			this.originView = null;
		}
		step.inverse = [...inverses, ...step.inverse];
		for (const [k, p] of this.pages) {
			if (p.um.undoStack.length > (step.umLen.get(k) ?? 0)) step.umPages.add(k);
		}
		this.redoStack = [];
		this.flush(ops);
		this.syncViews(input.view);
	}

	private flush(ops: Op[], extra: Record<string, unknown> = {}) {
		const y: Record<string, Uint8Array> = {};
		for (const [pageId, arr] of this.outY) if (arr.length) y[pageId] = Y.mergeUpdates(arr);
		this.outY.clear();
		if (!ops.length && !Object.keys(y).length) return;
		const txId = `${this.id}-${++this.txCounter}`;
		this.pending.push({ txId, ops });
		this.stats.txSent++;
		this.net.sendToServer(this.id, { t: "tx", txId, ops, y, ...extra });
	}

	// ---------- 撤销 ----------

	canUndo() {
		return this.undoStack.length > 0;
	}

	undo(): boolean {
		const step = this.undoStack.pop();
		if (!step) return false;
		this.redoStack.push(this.replay(step, "undo"));
		return true;
	}

	redo(): boolean {
		const step = this.redoStack.pop();
		if (!step) return false;
		this.undoStack.push(this.replay(step, "redo"));
		return true;
	}

	/** 应用一步的逆操作，返回反方向的一步。 */
	private replay(step: Step, dir: "undo" | "redo"): Step {
		this.stopCapturing();
		this.undoing = true;
		const ops: Op[] = [];
		const inverses: Op[] = [];
		try {
			for (const op of step.inverse) {
				if (op.t === "text") {
					const t = this.ytext(op.id);
					if (t) {
						// 正文逆操作碰到已经建好的 Y.Text：三方合并，只撤自己的那部分
						const cur = t.toString();
						const r = merge3(op.base, op.next, cur);
						if (r.ok) {
							this.writeBody({ id: op.id, md: r.result, hunks: r.patch }, MANUAL, ops, inverses);
							inverses.unshift({ t: "text", id: op.id, base: op.next, next: op.base });
						} else this.log.push(`撤销跳过块 ${op.id}：和别人的修改重叠`);
						continue;
					}
				}
				if (op.t === "insert" && !this.visible.alive(op.parentId)) {
					this.log.push(`撤销：父块 ${op.parentId} 已不在，跳过恢复 ${op.id}`);
					continue;
				}
				if (op.t === "move" && (!this.visible.alive(op.id) || !this.visible.alive(op.parentId)))
					continue;
				const inv = this.visible.apply(op, (id) => this.textOf(id));
				if (inv) inverses.unshift(inv);
				ops.push(op);
				this.textCache.delete(op.id);
			}
			for (const pageId of step.umPages) {
				const um = this.pages.get(pageId)?.um;
				if (!um) continue;
				if (dir === "undo") um.undo();
				else um.redo();
			}
		} finally {
			this.undoing = false;
		}
		this.flush(ops, { undo: true });
		this.syncViews(null);
		const sel = step.selBefore;
		if (sel) sel.view.restoreSelection(sel);
		return {
			inverse: inverses,
			umPages: step.umPages,
			selBefore: step.selAfter,
			selAfter: step.selBefore,
			kind: "struct",
			blockId: step.blockId,
			time: 0,
			umLen: new Map(),
		};
	}

	// ---------- 收消息 ----------

	private rebuildVisible() {
		const v = this.confirmed.clone();
		for (const p of this.pending) for (const op of p.ops) v.apply(op);
		this.visible = v;
		this.textCache.clear();
	}

	receive(m: Msg) {
		switch (m.t) {
			case "joined": {
				const pageId = m.pageId as string;
				const resync = this.resyncing.has(pageId);
				this.resyncing.delete(pageId);
				const waiters = this.page(pageId).waiters;
				if (resync) this.resetPage(pageId);
				for (const b of m.blocks as BlockRec[]) this.confirmed.put(b);
				const p = this.page(pageId);
				Y.applyUpdate(p.doc, m.y as Uint8Array, REMOTE);
				p.joined = true;
				this.rebuildVisible();
				const w = resync ? waiters : p.waiters;
				p.waiters = [];
				for (const f of w) f();
				this.syncViews(null, resync);
				break;
			}
			case "tx": {
				this.stats.remoteTx++;
				const ops = m.ops as Op[];
				for (const op of ops) this.confirmed.apply(op);
				if (this.pending.length) this.rebuildVisible();
				else for (const op of ops) this.visible.apply(op);
				for (const op of ops) this.textCache.delete(op.id);
				this.applyY(m.y as Record<string, Uint8Array>);
				this.syncViews(null);
				break;
			}
			case "ack": {
				const p = this.pending.shift();
				const ops = m.ops as Op[];
				for (const op of p?.ops ?? []) {
					if (op.t !== "text") continue;
					const n = (this.pendingText.get(op.id) ?? 1) - 1;
					if (n > 0) this.pendingText.set(op.id, n);
					else this.pendingText.delete(op.id);
					this.textCache.delete(op.id);
					for (const v of this.views) v.noteTextReset(op.id);
				}
				for (const op of ops) this.confirmed.apply(op);
				const same = p && JSON.stringify(p.ops) === JSON.stringify(ops);
				if (!same) this.rebuildVisible();
				this.applyY(m.y as Record<string, Uint8Array>);
				if (!same || Object.keys(m.y as object).length) this.syncViews(null);
				break;
			}
			case "reject": {
				this.stats.rejects++;
				this.log.push(`事务被拒绝：${m.reason}`);
				const pagesToSync = new Set<string>();
				for (const p of this.pending) for (const op of p.ops) pagesToSync.add(this.pageOf(op.id));
				this.pending = [];
				this.pendingText.clear();
				this.rebuildVisible();
				for (const pid of pagesToSync) if (pid) this.resync(pid);
				this.syncViews(null);
				break;
			}
			case "presence": {
				this.presence.set(m.clientId as string, {
					user: m.user as string,
					color: m.color as string,
					pageId: m.pageId as string,
					blockId: m.blockId as string,
					offset: m.offset as number,
				});
				for (const v of this.views) v.renderPresence();
				break;
			}
		}
		this.onChange?.();
	}

	private applyY(y: Record<string, Uint8Array>) {
		for (const [pageId, u] of Object.entries(y ?? {})) {
			Y.applyUpdate(this.page(pageId).doc, u, REMOTE);
		}
	}

	/** 被拒绝：丢弃这一页的本地状态，重新同步（§6.4）。 */
	private resync(pageId: string) {
		const p = this.pages.get(pageId);
		if (!p || this.resyncing.has(pageId)) return;
		this.resyncing.add(pageId);
		this.stats.resyncs++;
		this.net.sendToServer(this.id, { t: "join", pageId });
	}

	private resetPage(pageId: string) {
		const old = this.pages.get(pageId);
		old?.um.destroy();
		old?.doc.destroy();
		this.pages.delete(pageId);
		for (const [id, b] of [...this.confirmed.blocks])
			if (b.pageId === pageId || id === pageId) this.confirmed.blocks.delete(id);
		this.confirmed = Store.from(this.confirmed.blocks.values());
		this.undoStack = this.undoStack.filter((s) => !s.umPages.has(pageId));
		this.redoStack = [];
		this.textCache.clear();
		this.openRequested.clear();
		this.createPage(pageId);
	}

	syncViews(except: OutlineView | null, full = false) {
		for (const v of this.views) {
			if (v === except) continue;
			if (full) v.resetCache();
			v.sync();
		}
	}

	// ---------- 调试 / 测试 ----------

	outlineOf(rootId: string): string {
		const lines: string[] = [];
		const walk = (id: string, depth: number) => {
			for (const c of this.visible.children(id)) {
				const b = this.visible.get(c);
				const task = b?.task ? `[${b.task}] ` : "";
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

	get isUndoing() {
		return this.undoing;
	}

	applyHunksForTest(s: string, h: Hunk[]) {
		return applyHunks(s, h);
	}
}
