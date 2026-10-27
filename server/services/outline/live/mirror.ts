/**
 * A live session's copy of its page's structure: the page block and its live descendants (and
 * the deleted ones it has seen), with what the database holds for each.
 *
 * Between two lane tasks it matches the blocks table for the page, except that a block's text
 * may be ahead in the session's Yjs document (`dbContent` is what the database has).
 */
import { compareOrderKeys } from "@shared/outline";
import {
	LIVE_TASK_OF_STATUS,
	type LiveBlockWire,
	type LiveTaskChar,
} from "@shared/outline-live-protocol";
import type { OutlineTaskJson } from "../model";

export interface MirrorBlock {
	id: string;
	sid: string;
	/** Null for the page itself. */
	parentId: string | null;
	orderKey: string;
	taskJson: OutlineTaskJson | null;
	deleted: boolean;
	/** The block's content as the blocks table holds it now. */
	dbContent: string;
}

export function taskCharOf(task: OutlineTaskJson | null): LiveTaskChar | null {
	return task ? LIVE_TASK_OF_STATUS[task.status] : null;
}

export class PageMirror {
	private readonly blocks = new Map<string, MirrorBlock>();
	private readonly kids = new Map<string, Set<string>>();
	private readonly sorted = new Map<string, string[]>();

	constructor(readonly pageId: string) {}

	get size(): number {
		return this.blocks.size;
	}

	get(id: string): MirrorBlock | undefined {
		return this.blocks.get(id);
	}

	alive(id: string): MirrorBlock | undefined {
		const b = this.blocks.get(id);
		return b && !b.deleted ? b : undefined;
	}

	*all(): IterableIterator<MirrorBlock> {
		yield* this.blocks.values();
	}

	private link(b: MirrorBlock): void {
		if (b.parentId === null) return;
		let set = this.kids.get(b.parentId);
		if (!set) {
			set = new Set();
			this.kids.set(b.parentId, set);
		}
		set.add(b.id);
		this.sorted.delete(b.parentId);
	}

	private unlink(b: MirrorBlock): void {
		if (b.parentId === null) return;
		this.kids.get(b.parentId)?.delete(b.id);
		this.sorted.delete(b.parentId);
	}

	put(b: MirrorBlock): void {
		const old = this.blocks.get(b.id);
		if (old) this.unlink(old);
		this.blocks.set(b.id, b);
		this.link(b);
		// Liveness changes which children a parent lists.
		if (old && old.deleted !== b.deleted && b.parentId !== null) this.sorted.delete(b.parentId);
	}

	update(id: string, patch: Partial<Omit<MirrorBlock, "id">>): void {
		const b = this.blocks.get(id);
		if (b) this.put({ ...b, ...patch });
	}

	/** Live children in sibling order (order key, then id). */
	children(parentId: string): string[] {
		let list = this.sorted.get(parentId);
		if (list) return list;
		list = [...(this.kids.get(parentId) ?? [])].filter((id) => !this.blocks.get(id)?.deleted);
		list.sort((a, b) => {
			const ka = this.blocks.get(a)?.orderKey ?? "";
			const kb = this.blocks.get(b)?.orderKey ?? "";
			return compareOrderKeys(ka, kb) || (a < b ? -1 : a > b ? 1 : 0);
		});
		this.sorted.set(parentId, list);
		return list;
	}

	/** The block and its live descendants, parents first. */
	subtree(id: string): string[] {
		const out: string[] = [];
		const stack = [id];
		while (stack.length > 0) {
			const next = stack.pop() as string;
			out.push(next);
			const kids = this.children(next);
			for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as string);
		}
		return out;
	}

	/** Whether `ancestor` is a proper ancestor of `id`. */
	isAncestor(ancestor: string, id: string): boolean {
		let cur = this.blocks.get(id)?.parentId ?? null;
		for (let guard = 0; cur && guard < 10_000; guard++) {
			if (cur === ancestor) return true;
			cur = this.blocks.get(cur)?.parentId ?? null;
		}
		return false;
	}

	/** Whether a live block is reachable from the page through live parents. */
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

	/** Depth below the page (the page is 0). */
	depth(id: string): number {
		let d = 0;
		let cur = this.blocks.get(id)?.parentId ?? null;
		for (; cur && d < 10_000; d++) cur = this.blocks.get(cur)?.parentId ?? null;
		return d;
	}

	/** Live blocks of the page, parents first, as the join snapshot sends them. */
	snapshot(): LiveBlockWire[] {
		const out: LiveBlockWire[] = [];
		const index = new Map<string, number>();
		for (const id of this.subtree(this.pageId)) {
			const b = this.blocks.get(id) as MirrorBlock;
			index.set(id, out.length);
			out.push([
				b.id,
				b.parentId === null ? -1 : (index.get(b.parentId) ?? -1),
				b.orderKey,
				b.sid,
				taskCharOf(b.taskJson) ?? "",
			]);
		}
		return out;
	}
}
