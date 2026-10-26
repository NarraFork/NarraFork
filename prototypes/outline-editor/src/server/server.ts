/**
 * 内存里的「服务端」（§6.2–§6.5）：
 * - 块存储是真相；每个提交记一条日志。
 * - 按页一个 Y.Doc（实时会话），每个被编辑的块一个 Y.Text（存 markdown 源文本）；
 *   已有块的 Y.Text 在第一次被编辑时由服务端用 content 初始化，新建块由创建方初始化。
 * - 大纲事务：结构操作 + 正文更新，作为一条消息发来，由服务端排序、校验（成环、同页）、
 *   必要时重排排序键，写成提交，再广播。
 * - agent：按「读取时的快照」三方合并正文；结构按读取时的版本检查。
 */
import * as Y from "yjs";
import { normalizeBlock } from "../dialect/index";
import { serializeBody } from "../dialect/serialize";
import type { OutlineNode, TaskState } from "../dialect/types";
import type { Hunk } from "../model/diff";
import { merge3 } from "../model/merge3";
import { keyBetween } from "../model/orderkey";
import { type BlockRec, type Op, Store } from "../model/store";
import type { Msg, Net } from "../net";

export const SERVER_ORIGIN = "server";
export const AGENT_ORIGIN = "agent";

interface PageSession {
	doc: Y.Doc;
	texts: Y.Map<Y.Text>;
	clients: Set<string>;
	buffer: Uint8Array[];
}

export interface Commit {
	seq: number;
	actor: string;
	kind: "edit" | "agent" | "undo";
	ops: Op[];
	pages: string[];
	textBlocks: string[];
	at: number;
}

export interface AgentEdit {
	t: "text" | "insert" | "move" | "delete";
	id?: string;
	parentId?: string;
	after?: string | null;
	content?: string;
}

export interface AgentResult {
	applied: Array<{ t: string; id: string; merged?: boolean }>;
	rejected: Array<{ t: string; id?: string; reason: string; current?: string }>;
	notes: string[];
}

let idCounter = 0;
export function newId(prefix = "b"): string {
	idCounter++;
	const rnd = Math.random().toString(36).slice(2, 8);
	return `${prefix}${idCounter.toString(36)}${rnd}`;
}

export class Server {
	store = new Store();
	seq = 0;
	commits: Commit[] = [];
	pages = new Map<string, PageSession>();
	clients = new Map<string, { user: string }>();
	/** agent 会话 → 读取时的快照（有界缓存，作为三方合并的基线） */
	agentReads = new Map<string, Map<string, { text: string; version: number }>>();
	agentCacheLimit = 5000;
	log: string[] = [];

	constructor(private net: Net) {
		net.attachServer((from, m) => this.receive(from, m));
	}

	connect(clientId: string, user: string) {
		this.clients.set(clientId, { user });
	}

	// ---------- 页实时会话 ----------

	session(pageId: string): PageSession {
		let s = this.pages.get(pageId);
		if (!s) {
			const doc = new Y.Doc();
			const texts = doc.getMap<Y.Text>("texts");
			s = { doc, texts, clients: new Set(), buffer: [] };
			const sess = s;
			doc.on("update", (u: Uint8Array) => sess.buffer.push(u));
			texts.observeDeep((events) => {
				for (const ev of events) {
					if (ev.target instanceof Y.Text) {
						const id = (ev.target as unknown as { _item: { parentSub: string } })._item?.parentSub;
						const b = id ? this.store.get(id) : undefined;
						if (b) this.store.put({ ...b, content: ev.target.toString(), version: b.version + 1 });
					}
				}
			});
			this.pages.set(pageId, s);
		}
		return s;
	}

	/** 已有块第一次被编辑：由服务端用 content 初始化 Y.Text（任何一方都不能重复初始化）。 */
	ensureText(id: string): Y.Text | null {
		const b = this.store.get(id);
		if (!b) return null;
		const s = this.session(b.pageId);
		let t = s.texts.get(id);
		if (!t) {
			const nt = new Y.Text();
			s.doc.transact(() => {
				s.texts.set(id, nt);
				nt.insert(0, b.content);
			}, SERVER_ORIGIN);
			t = nt;
		}
		return t;
	}

	textOf(id: string): string {
		const b = this.store.get(id);
		if (!b) return "";
		const t = this.pages.get(b.pageId)?.texts.get(id);
		return t ? t.toString() : b.content;
	}

	private takeUpdates(pageIds: Iterable<string>): Record<string, Uint8Array> {
		const out: Record<string, Uint8Array> = {};
		for (const p of pageIds) {
			const s = this.pages.get(p);
			if (s?.buffer.length) {
				out[p] = Y.mergeUpdates(s.buffer);
				s.buffer = [];
			}
		}
		return out;
	}

	private send(to: string, m: Msg) {
		this.net.sendToClient(to, m);
	}

	private broadcast(pageIds: Iterable<string>, m: Msg, except?: string) {
		const targets = new Set<string>();
		for (const p of pageIds) for (const c of this.pages.get(p)?.clients ?? []) targets.add(c);
		for (const c of targets) if (c !== except) this.send(c, m);
	}

	pageBlocks(pageId: string): BlockRec[] {
		const out: BlockRec[] = [];
		for (const b of this.store.blocks.values()) if (b.pageId === pageId) out.push({ ...b });
		return out;
	}

	receive(from: string, m: Msg) {
		switch (m.t) {
			case "join": {
				const pageId = m.pageId as string;
				const s = this.session(pageId);
				s.clients.add(from);
				// 先把缓冲里的更新发给已在场的人，再给新人完整状态
				const pending = this.takeUpdates([pageId]);
				if (pending[pageId])
					this.broadcast(
						[pageId],
						{ t: "tx", seq: this.seq, ops: [], y: pending, from: "server" },
						from,
					);
				this.send(from, {
					t: "joined",
					pageId,
					seq: this.seq,
					blocks: this.pageBlocks(pageId),
					y: Y.encodeStateAsUpdate(s.doc),
				});
				break;
			}
			case "open": {
				const id = m.id as string;
				const b = this.store.alive(id);
				if (!b) return;
				const s = this.session(b.pageId);
				if (s.texts.get(id)) return;
				this.ensureText(id);
				const y = this.takeUpdates([b.pageId]);
				this.broadcast([b.pageId], { t: "tx", seq: this.seq, ops: [], y, from: "server" });
				break;
			}
			case "tx":
				this.handleTx(from, m);
				break;
			case "presence":
				this.broadcast([m.pageId as string], m, from);
				break;
		}
	}

	// ---------- 大纲事务 ----------

	private validate(store: Store, op: Op): string | null {
		switch (op.t) {
			case "insert": {
				const parent = store.alive(op.parentId);
				if (!parent) return `父块 ${op.parentId} 不存在`;
				const pid = parent.parentId === null ? parent.id : parent.pageId;
				if (pid !== op.pageId) return "不能跨页插入";
				const old = store.get(op.id);
				if (old && !old.deleted) return `块 ${op.id} 已存在`;
				if (old && old.pageId !== op.pageId) return "不能跨页恢复";
				return null;
			}
			case "move": {
				const b = store.alive(op.id);
				if (!b) return `块 ${op.id} 不存在或已删除`;
				const parent = store.alive(op.parentId);
				if (!parent) return `父块 ${op.parentId} 不存在`;
				const pid = parent.parentId === null ? parent.id : parent.pageId;
				if (pid !== b.pageId) return "块不跨页移动";
				if (op.parentId === op.id || store.isAncestor(op.id, op.parentId)) return "移动会成环";
				return null;
			}
			case "delete":
			case "task":
				return store.get(op.id) ? null : `块 ${op.id} 不存在`;
			case "text":
				return store.alive(op.id) ? null : `块 ${op.id} 不存在`;
		}
	}

	/** 同级排序键冲突时由服务端重新生成。 */
	private fixKey(store: Store, op: Extract<Op, { t: "insert" | "move" }>): Op {
		const sibs = store.children(op.parentId).filter((x) => x !== op.id);
		const keys = sibs.map((x) => store.get(x)?.orderKey ?? "");
		if (!keys.includes(op.orderKey)) return op;
		const sorted = [...new Set(keys)].sort();
		const i = sorted.indexOf(op.orderKey);
		const next = sorted[i + 1] ?? null;
		return { ...op, orderKey: keyBetween(op.orderKey, next) };
	}

	handleTx(from: string, m: Msg) {
		const txId = m.txId as string;
		const ops = (m.ops as Op[]) ?? [];
		const y = (m.y as Record<string, Uint8Array>) ?? {};
		const scratch = this.store.clone();
		const canonical: Op[] = [];
		const pages = new Set<string>(Object.keys(y));
		const textOps: Array<Extract<Op, { t: "text" }>> = [];
		for (const op0 of ops) {
			let op = op0;
			const err = this.validate(scratch, op);
			if (err) {
				this.log.push(`拒绝 ${from} ${txId}: ${err}`);
				this.send(from, { t: "reject", txId, reason: err });
				return;
			}
			if (op.t === "insert" || op.t === "move") op = this.fixKey(scratch, op);
			if (op.t === "text") {
				textOps.push(op);
				canonical.push(op);
				pages.add(scratch.get(op.id)?.pageId ?? "");
				continue;
			}
			scratch.apply(op);
			canonical.push(op);
			const b = scratch.get(op.id);
			if (b) pages.add(b.pageId);
		}
		// 删除的块下面还活着的子块（别人并发加进来的）一起删掉
		for (const op of canonical) {
			if (op.t !== "delete") continue;
			for (const kid of scratch.children(op.id)) {
				for (const d of scratch.subtree(kid)) {
					scratch.apply({ t: "delete", id: d });
					canonical.push({ t: "delete", id: d });
				}
			}
		}
		// 正文：没有 Y.Text 的块，服务端初始化后按 base 三方合并
		const merges: Array<{ id: string; patch: Hunk[] }> = [];
		for (const op of textOps) {
			const t = this.ensureText(op.id);
			if (!t) continue;
			// 人的按键不拒绝（宽松合并）；见 RESULTS.md「首次编辑的竞争窗口」
			const r = merge3(op.base, op.next, t.toString(), { lenient: true });
			if (!r.ok) {
				this.log.push(`拒绝 ${from} ${txId}: 块 ${op.id} 正文冲突`);
				this.send(from, { t: "reject", txId, reason: `块 ${op.id} 正文冲突` });
				return;
			}
			merges.push({ id: op.id, patch: r.patch });
		}
		// 校验通过：原子地写入
		this.store = scratch;
		for (const p of pages) if (p) this.session(p);
		for (const [pageId, u] of Object.entries(y)) Y.applyUpdate(this.session(pageId).doc, u, from);
		for (const mg of merges) this.applyPatch(mg.id, mg.patch, from);
		// 新建块的 content 以 Y.Text 为准
		for (const op of canonical) {
			if (op.t === "insert") {
				const b = this.store.get(op.id);
				const t = b ? this.pages.get(b.pageId)?.texts.get(op.id) : undefined;
				if (b && t) this.store.put({ ...b, content: t.toString() });
			}
		}
		this.seq++;
		const textBlocks = new Set<string>(textOps.map((o) => o.id));
		this.commits.push({
			seq: this.seq,
			actor: this.clients.get(from)?.user ?? from,
			kind: m.undo ? "undo" : "edit",
			ops: canonical,
			pages: [...pages].filter(Boolean),
			textBlocks: [...textBlocks],
			at: Date.now(),
		});
		const yOut = this.takeUpdates(pages);
		this.send(from, { t: "ack", txId, seq: this.seq, ops: canonical, y: yOut });
		this.broadcast(pages, { t: "tx", seq: this.seq, ops: canonical, y: yOut, from }, from);
	}

	private applyPatch(id: string, patch: Hunk[], origin: string) {
		const t = this.ensureText(id);
		if (!t) return;
		const b = this.store.get(id);
		if (!b) return;
		const s = this.session(b.pageId);
		s.doc.transact(() => {
			for (const h of [...patch].sort((a, c) => c.start - a.start)) {
				if (h.end > h.start) t.delete(h.start, h.end - h.start);
				if (h.text) t.insert(h.start, h.text);
			}
		}, origin);
	}

	// ---------- agent（§6.5） ----------

	/** agent 读取一页：返回快照，并按会话缓存读到的正文作为合并基线。 */
	agentRead(
		agent: string,
		pageId: string,
	): { outline: string; blocks: Array<BlockRec & { depth: number }> } {
		let cache = this.agentReads.get(agent);
		if (!cache) {
			cache = new Map();
			this.agentReads.set(agent, cache);
		}
		const out: Array<BlockRec & { depth: number }> = [];
		const lines: string[] = [];
		const walk = (id: string, depth: number) => {
			for (const c of this.store.children(id)) {
				const b = this.store.get(c);
				if (!b) continue;
				const text = this.textOf(c);
				out.push({ ...b, content: text, depth });
				cache?.set(c, { text, version: b.version });
				lines.push(
					`${"  ".repeat(depth)}- ${text.split("\n").join(`\n${"  ".repeat(depth + 1)}`)} <!-- ${c} -->`,
				);
				walk(c, depth + 1);
			}
		};
		walk(pageId, 0);
		while (cache.size > this.agentCacheLimit) {
			const first = cache.keys().next().value;
			if (first === undefined) break;
			cache.delete(first);
		}
		return { outline: lines.join("\n"), blocks: out };
	}

	agentForget(agent: string) {
		this.agentReads.delete(agent);
	}

	agentWrite(agent: string, pageId: string, edits: AgentEdit[]): AgentResult {
		const cache = this.agentReads.get(agent) ?? new Map();
		const res: AgentResult = { applied: [], rejected: [], notes: [] };
		const ops: Op[] = [];
		const pagesTouched = new Set<string>([pageId]);
		const live = this.pages.has(pageId);
		for (const e of edits) {
			if (e.t === "text" && e.id) {
				const b = this.store.alive(e.id);
				if (!b) {
					res.rejected.push({ t: e.t, id: e.id, reason: "块不存在或已删除" });
					continue;
				}
				const norm = normalizeBlock(e.content ?? "");
				const read = cache.get(e.id);
				const current = this.textOf(e.id);
				if (!read) {
					// 缓存失效：退化为「读取之后有任何变化就拒绝」——这里没有读取记录，直接拒绝
					res.rejected.push({ t: e.t, id: e.id, reason: "没有读取记录，无法合并", current });
					continue;
				}
				const r = merge3(read.text, norm.content, current);
				if (!r.ok) {
					res.rejected.push({ t: e.t, id: e.id, reason: "和读取之后别人的修改重叠", current });
					continue;
				}
				if (live) {
					this.applyPatch(e.id, r.patch, AGENT_ORIGIN);
				} else {
					this.store.put({ ...b, content: r.result, version: b.version + 1 });
				}
				cache.set(e.id, { text: r.result, version: this.store.get(e.id)?.version ?? 0 });
				res.applied.push({ t: "text", id: e.id, merged: current !== read.text });
				if (norm.children.length) {
					const kids = this.insertNodes(e.id, b.pageId, null, norm.children, ops);
					res.notes.push(`块 ${e.id}：${norm.notes.join("；")}，拆出 ${kids.length} 个子块`);
				}
				continue;
			}
			if (e.t === "insert" && e.parentId) {
				const parent = this.store.alive(e.parentId);
				if (!parent) {
					res.rejected.push({ t: e.t, reason: "父块不存在" });
					continue;
				}
				const norm = normalizeBlock(e.content ?? "");
				const node: OutlineNode = {
					body: { type: "paragraph", content: [] },
					task: null,
					children: norm.children,
				};
				const ids = this.insertNodes(
					e.parentId,
					parent.parentId === null ? parent.id : parent.pageId,
					e.after ?? null,
					[node],
					ops,
					norm.content,
				);
				res.applied.push({ t: "insert", id: ids[0] });
				if (norm.notes.length) res.notes.push(`新块 ${ids[0]}：${norm.notes.join("；")}`);
				continue;
			}
			if ((e.t === "move" || e.t === "delete") && e.id) {
				const b = this.store.alive(e.id);
				const read = cache.get(e.id);
				if (!b || !read || read.version !== b.version) {
					res.rejected.push({
						t: e.t,
						id: e.id,
						reason: "块在读取之后变了（结构按读取时的版本检查）",
					});
					continue;
				}
				if (e.t === "delete") {
					for (const d of this.store.subtree(e.id).reverse()) {
						const op: Op = { t: "delete", id: d };
						this.store.apply(op);
						ops.push(op);
					}
				} else {
					const parentId = e.parentId ?? b.parentId ?? pageId;
					if (parentId === e.id || this.store.isAncestor(e.id, parentId)) {
						res.rejected.push({ t: e.t, id: e.id, reason: "移动会成环" });
						continue;
					}
					const sibs = this.store.children(parentId).filter((x) => x !== e.id);
					const idx = e.after ? sibs.indexOf(e.after) + 1 : 0;
					const prev = idx > 0 ? (this.store.get(sibs[idx - 1])?.orderKey ?? null) : null;
					const next = idx < sibs.length ? (this.store.get(sibs[idx])?.orderKey ?? null) : null;
					const op: Op = { t: "move", id: e.id, parentId, orderKey: keyBetween(prev, next) };
					this.store.apply(op);
					ops.push(op);
				}
				res.applied.push({ t: e.t, id: e.id });
			}
		}
		// 广播：结构操作 + 正文的 Y 更新（agent 作为一个参与者写进 Y.Doc）
		this.seq++;
		this.commits.push({
			seq: this.seq,
			actor: `agent:${agent}`,
			kind: "agent",
			ops,
			pages: [...pagesTouched],
			textBlocks: res.applied.filter((a) => a.t === "text").map((a) => a.id),
			at: Date.now(),
		});
		const y = this.takeUpdates(pagesTouched);
		this.broadcast(pagesTouched, { t: "tx", seq: this.seq, ops, y, from: `agent:${agent}` });
		return res;
	}

	private insertNodes(
		parentId: string,
		pageId: string,
		after: string | null,
		nodes: OutlineNode[],
		ops: Op[],
		firstContent?: string,
	): string[] {
		const ids: string[] = [];
		const sibs = this.store.children(parentId);
		let idx = after ? sibs.indexOf(after) + 1 : sibs.length;
		if (idx < 0) idx = sibs.length;
		let prev = idx > 0 ? (this.store.get(sibs[idx - 1])?.orderKey ?? null) : null;
		const next = idx < sibs.length ? (this.store.get(sibs[idx])?.orderKey ?? null) : null;
		nodes.forEach((n, i) => {
			const id = newId("a");
			const key = keyBetween(prev, next);
			prev = key;
			const content = i === 0 && firstContent !== undefined ? firstContent : serializeBody(n.body);
			const op: Op = {
				t: "insert",
				id,
				pageId,
				parentId,
				orderKey: key,
				content,
				task: n.task as TaskState | null,
			};
			this.store.apply(op);
			ops.push(op);
			ids.push(id);
			if (n.children.length) this.insertNodes(id, pageId, null, n.children, ops);
		});
		return ids;
	}

	// ---------- 调试 ----------

	outlineOf(pageId: string): string {
		const lines: string[] = [];
		const walk = (id: string, depth: number) => {
			for (const c of this.store.children(id)) {
				const b = this.store.get(c);
				const task = b?.task ? `[${b.task}] ` : "";
				lines.push(
					`${"  ".repeat(depth)}- ${task}${this.textOf(c)
						.split("\n")
						.join(`\n${"  ".repeat(depth + 1)}`)}`,
				);
				walk(c, depth + 1);
			}
		};
		walk(pageId, 0);
		return lines.join("\n");
	}
}
