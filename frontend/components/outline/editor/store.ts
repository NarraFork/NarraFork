/**
 * The editor's copy of a page's structure (the block model is the truth, design §6.7): id,
 * parent, sibling order key, checkbox. Text is not here: it lives in the page's Yjs document.
 *
 * Operations return their inverse, which the undo stack keeps. Ported from the editor prototype
 * (`prototypes/outline-editor/src/model/store.ts`), with content moved out to Yjs.
 */
import { compareOrderKeys, keyBetween } from "@shared/outline";
import type { LiveOp, LiveTaskChar } from "@shared/outline-live-protocol";

export interface BlockRec {
	id: string;
	/** Null for the page itself. */
	parentId: string | null;
	orderKey: string;
	task: LiveTaskChar | null;
	deleted: boolean;
	/** The block's short id in its space (empty until the server confirmed the block). */
	sid: string;
}

/**
 * A structural operation as the editor makes it: the wire operation, and for an insert the
 * new block's initial text (which goes into the Yjs document, never into the operation).
 */
export type ClientOp =
	| (Extract<LiveOp, { t: "i" }> & { content: string })
	| Exclude<LiveOp, { t: "i" }>;

/**
 * A key between two neighbours that tolerates neighbours out of order: two people inserting at
 * one place at once can leave equal keys visible until the server's canonical keys arrive. The
 * block then goes right after `a`; the server keeps siblings' keys distinct.
 */
export function keyBetweenLoose(a: string | null, b: string | null): string {
	if (a !== null && b !== null && compareOrderKeys(a, b) >= 0) return keyBetween(a, null);
	return keyBetween(a, b);
}

export function wireOp(op: ClientOp): LiveOp {
	if (op.t !== "i") return op;
	const { content: _content, ...wire } = op;
	return wire;
}

export class Store {
	readonly blocks = new Map<string, BlockRec>();
	private readonly kids = new Map<string, Set<string>>();
	private readonly sorted = new Map<string, string[]>();

	constructor(readonly pageId: string) {}

	static from(pageId: string, recs: Iterable<BlockRec>): Store {
		const s = new Store(pageId);
		for (const r of recs) s.put({ ...r });
		return s;
	}

	clone(): Store {
		return Store.from(this.pageId, this.blocks.values());
	}

	get(id: string): BlockRec | undefined {
		return this.blocks.get(id);
	}

	alive(id: string): BlockRec | undefined {
		const b = this.blocks.get(id);
		return b && !b.deleted ? b : undefined;
	}

	private link(b: BlockRec): void {
		if (b.parentId === null) return;
		let set = this.kids.get(b.parentId);
		if (!set) {
			set = new Set();
			this.kids.set(b.parentId, set);
		}
		set.add(b.id);
		this.sorted.delete(b.parentId);
	}

	private unlink(b: BlockRec): void {
		if (b.parentId === null) return;
		this.kids.get(b.parentId)?.delete(b.id);
		this.sorted.delete(b.parentId);
	}

	put(b: BlockRec): void {
		const old = this.blocks.get(b.id);
		if (old) this.unlink(old);
		this.blocks.set(b.id, b);
		this.link(b);
	}

	/** Live children in sibling order (order key, then id). */
	children(parentId: string): string[] {
		let s = this.sorted.get(parentId);
		if (s) return s;
		const ids = [...(this.kids.get(parentId) ?? [])].filter((id) => !this.blocks.get(id)?.deleted);
		ids.sort((a, b) => {
			const ka = this.blocks.get(a)?.orderKey ?? "";
			const kb = this.blocks.get(b)?.orderKey ?? "";
			return compareOrderKeys(ka, kb) || (a < b ? -1 : a > b ? 1 : 0);
		});
		s = ids;
		this.sorted.set(parentId, s);
		return s;
	}

	isAncestor(ancestor: string, id: string): boolean {
		let cur = this.blocks.get(id)?.parentId ?? null;
		let guard = 0;
		while (cur && guard++ < 10_000) {
			if (cur === ancestor) return true;
			cur = this.blocks.get(cur)?.parentId ?? null;
		}
		return false;
	}

	/** Whether a block is live and reachable from the page through live parents. */
	inPage(id: string): boolean {
		let cur: string | null = id;
		for (let guard = 0; cur && guard < 10_000; guard++) {
			const b = this.blocks.get(cur);
			if (!b || b.deleted) return false;
			if (cur === this.pageId) return true;
			cur = b.parentId;
		}
		return false;
	}

	subtree(id: string): string[] {
		const out: string[] = [];
		const walk = (x: string) => {
			out.push(x);
			for (const c of this.children(x)) walk(c);
		};
		walk(id);
		return out;
	}

	/**
	 * Apply an operation and return its inverse (null when it changed nothing). A delete takes
	 * the block only; the caller sends deletes for every block of a subtree.
	 */
	apply(op: ClientOp | LiveOp, textOf: (id: string) => string = () => ""): ClientOp | null {
		switch (op.t) {
			case "i": {
				const old = this.blocks.get(op.id);
				this.put({
					id: op.id,
					parentId: op.p,
					orderKey: op.k,
					task: op.task === undefined ? (old?.deleted ? old.task : null) : op.task,
					deleted: false,
					sid: old?.sid ?? "",
				});
				return { t: "d", id: op.id };
			}
			case "m": {
				const b = this.blocks.get(op.id);
				if (!b) return null;
				const inv: ClientOp = { t: "m", id: op.id, p: b.parentId ?? "", k: b.orderKey };
				this.put({ ...b, parentId: op.p, orderKey: op.k });
				return inv;
			}
			case "d": {
				const b = this.blocks.get(op.id);
				if (!b || b.deleted) return null;
				const inv: ClientOp = {
					t: "i",
					id: b.id,
					p: b.parentId ?? "",
					k: b.orderKey,
					task: b.task,
					content: textOf(b.id),
				};
				this.put({ ...b, deleted: true });
				return inv;
			}
			case "k": {
				const b = this.blocks.get(op.id);
				if (!b) return null;
				const inv: ClientOp = { t: "k", id: op.id, task: b.task };
				this.put({ ...b, task: op.task });
				return inv;
			}
		}
	}
}
