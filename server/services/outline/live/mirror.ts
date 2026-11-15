/**
 * A space's live session's copy of the structure it has loaded: blocks by id and by parent.
 *
 * WHAT IS LOADED
 * --------------
 * The mirror is keyed by parent: a parent is LOADED when every live child it has in the blocks
 * table is here ({@link SpaceMirror.isLoaded}). Parents are loaded on demand and unloaded when
 * nobody needs them, so the mirror's size follows what participants have open, never the size of
 * the space. A top-level block whose whole subtree is loaded and that participants may join is a
 * ROOT (today's wire protocol joins a page: every parent under the page is loaded with it).
 *
 * Besides live blocks the mirror keeps the deleted ones it has seen under loaded parents (a
 * block deleted in the session, or moved to a parent that is not loaded): undoing a delete
 * brings a block back with the text it had. They go when their tree is unloaded.
 *
 * Between two lane tasks the loaded part matches the blocks table, except that a block's text
 * may be ahead in the block's text document (`dbContent` is what the database has, and the live
 * text of every block that has no document).
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
	/** Null for a top-level block. */
	parentId: string | null;
	orderKey: string;
	taskJson: OutlineTaskJson | null;
	/** A question put to a person (`Ask`): its checkbox cannot be set in the editor. */
	question?: boolean;
	deleted: boolean;
	/** The block's content as the blocks table holds it now. */
	dbContent: string;
	/**
	 * The generation of the block's text document (`shared/outline-live-protocol.ts`, "document
	 * generations"): 0 for a block of the session's first load and for one made in the session;
	 * the session's counter at the time for a block loaded later or whose document was dropped.
	 */
	gen: number;
}

export function taskCharOf(task: OutlineTaskJson | null): LiveTaskChar | null {
	return task ? LIVE_TASK_OF_STATUS[task.status] : null;
}

/** Steps a walk up the tree takes at most (deeper than any outline; a cycle guard). */
const MAX_DEPTH = 10_000;

export class SpaceMirror {
	private readonly blocks = new Map<string, MirrorBlock>();
	/** Children by parent, deleted ones included. */
	private readonly kids = new Map<string, Set<string>>();
	private readonly sorted = new Map<string, string[]>();
	private readonly roots = new Set<string>();
	private readonly loaded = new Set<string>();
	/** UTF-16 units of all `dbContent` held (a budget's measure, not exact bytes). */
	chars = 0;

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

	// ── what is loaded ────────────────────────────────────────────────────────

	/** Every live child of `parentId` is here. */
	isLoaded(parentId: string): boolean {
		return this.loaded.has(parentId);
	}

	markLoaded(parentId: string): void {
		this.loaded.add(parentId);
	}

	unmarkLoaded(parentId: string): void {
		this.loaded.delete(parentId);
	}

	get loadedParents(): number {
		return this.loaded.size;
	}

	isRoot(id: string): boolean {
		return this.roots.has(id);
	}

	markRoot(id: string): void {
		this.roots.add(id);
	}

	unmarkRoot(id: string): void {
		this.roots.delete(id);
	}

	get rootIds(): string[] {
		return [...this.roots];
	}

	// ── changing ──────────────────────────────────────────────────────────────

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
		const set = this.kids.get(b.parentId);
		if (set) {
			set.delete(b.id);
			if (set.size === 0) this.kids.delete(b.parentId);
		}
		this.sorted.delete(b.parentId);
	}

	put(b: MirrorBlock): void {
		const old = this.blocks.get(b.id);
		if (old) {
			this.unlink(old);
			this.chars -= old.dbContent.length;
		}
		this.blocks.set(b.id, b);
		this.chars += b.dbContent.length;
		this.link(b);
		// Liveness changes which children a parent lists.
		if (old && old.deleted !== b.deleted && b.parentId !== null) this.sorted.delete(b.parentId);
	}

	update(id: string, patch: Partial<Omit<MirrorBlock, "id">>): void {
		const b = this.blocks.get(id);
		if (b) this.put({ ...b, ...patch });
	}

	/** Forget one block (its children stay until they are removed themselves). */
	remove(id: string): void {
		const b = this.blocks.get(id);
		if (!b) return;
		this.unlink(b);
		this.blocks.delete(id);
		this.chars -= b.dbContent.length;
		this.sorted.delete(id);
		this.loaded.delete(id);
		this.roots.delete(id);
	}

	// ── reading ───────────────────────────────────────────────────────────────

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

	/** The block and everything under it the mirror holds, deleted blocks included. */
	subtreeAll(id: string): string[] {
		const out: string[] = [];
		const stack = [id];
		while (stack.length > 0) {
			const next = stack.pop() as string;
			out.push(next);
			for (const kid of this.kids.get(next) ?? []) stack.push(kid);
		}
		return out;
	}

	/** Whether `ancestor` is a proper ancestor of `id`. */
	isAncestor(ancestor: string, id: string): boolean {
		let cur = this.blocks.get(id)?.parentId ?? null;
		for (let guard = 0; cur && guard < MAX_DEPTH; guard++) {
			if (cur === ancestor) return true;
			cur = this.blocks.get(cur)?.parentId ?? null;
		}
		return false;
	}

	/**
	 * The top-level block above `id` (itself when it is one), whatever is deleted on the way:
	 * the tree a block belongs to, also as a deleted block people may bring back. Null when the
	 * chain leaves the mirror.
	 */
	topOf(id: string): string | null {
		let cur: string | null = id;
		for (let guard = 0; cur && guard < MAX_DEPTH; guard++) {
			const b = this.blocks.get(cur);
			if (!b) return null;
			if (b.parentId === null) return cur;
			cur = b.parentId;
		}
		return null;
	}

	/** The root whose tree a live block is in (through live parents), or null. */
	rootOf(id: string): string | null {
		let cur: string | null = id;
		for (let guard = 0; cur && guard < MAX_DEPTH; guard++) {
			const b = this.blocks.get(cur);
			if (!b || b.deleted) return null;
			if (b.parentId === null) return this.roots.has(cur) ? cur : null;
			cur = b.parentId;
		}
		return null;
	}

	/** Depth below the top-level block (which is 0). */
	depth(id: string): number {
		let d = 0;
		let cur = this.blocks.get(id)?.parentId ?? null;
		for (; cur && d < MAX_DEPTH; d++) cur = this.blocks.get(cur)?.parentId ?? null;
		return d;
	}

	/** Live blocks of a root's tree, parents first, as the join snapshot sends them. */
	snapshot(rootId: string): LiveBlockWire[] {
		const out: LiveBlockWire[] = [];
		const index = new Map<string, number>();
		for (const id of this.subtree(rootId)) {
			const b = this.blocks.get(id) as MirrorBlock;
			index.set(id, out.length);
			const row: LiveBlockWire = [
				b.id,
				b.parentId === null ? -1 : (index.get(b.parentId) ?? -1),
				b.orderKey,
				b.sid,
				taskCharOf(b.taskJson) ?? "",
			];
			if (b.question) row.push(1);
			out.push(row);
		}
		return out;
	}
}
