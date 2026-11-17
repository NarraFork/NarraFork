/**
 * A space's live session's copy of the structure it has loaded: blocks by id and by parent (the
 * top-level blocks under {@link TOP_KEY}).
 *
 * WHAT IS LOADED
 * --------------
 * What participants watch (`session.ts` `LiveView`): whole subtrees and single levels. A parent
 * is LOADED when every live child it has in the blocks table is here: a parent inside a watched
 * subtree, or a watched level's parent (the top level included). Which parents are loaded is the
 * session's to say (it knows the watches); the mirror only holds blocks. Watches are loaded on
 * demand and unloaded when nobody needs them, so the mirror's size follows what participants
 * show, never the size of the space. The parent of a watched subtree's root and of a watched
 * level need not be here.
 *
 * Besides live blocks the mirror keeps the deleted ones it has seen in a watched area (a block
 * deleted in the session, or moved to a parent that is not loaded): undoing a delete brings a
 * block back with the text it had. They go when no watch covers them any more.
 *
 * Between two lane tasks the loaded part matches the blocks table, except that a block's text
 * may be ahead in the block's text document (`dbContent` is what the database has, and the live
 * text of every block that has no document).
 */
import { compareOrderKeys } from "@shared/outline";
import { LIVE_TASK_OF_STATUS, type LiveTaskChar } from "@shared/outline-live-protocol";
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
	/**
	 * The watches whose participants hold the block's text: they were sent it whole (in a
	 * snapshot, or when the block came into what they watch) and get every update and drop of it
	 * since. Empty: nobody. Text is routed by it (to every participant with one of these watches),
	 * and a watch is added only at the one place a watch is sent a block's text whole
	 * (`LiveSpace.tell`), so no path can show a block without its text. A watch is taken off when
	 * the block leaves what it covers (moved away, or a deleted block carried away under its moved
	 * parent); a block deleted where a watch covers it stays held (undoing the delete).
	 */
	held: readonly HeldBy[];
}

/** What holds a block's text: a watch of the session (`session.ts` `LiveView`). */
export interface HeldBy {
	readonly key: string;
}

/** Nobody holds the text. */
export const HELD_BY_NOBODY: readonly HeldBy[] = Object.freeze([]);

/** The parent key of the top-level blocks (block ids are never empty). */
export const TOP_KEY = "";

/** A parent's key in the mirror: its id, or {@link TOP_KEY} for the top level. */
export function parentKeyOf(parentId: string | null): string {
	return parentId ?? TOP_KEY;
}

export function taskCharOf(task: OutlineTaskJson | null): LiveTaskChar | null {
	return task ? LIVE_TASK_OF_STATUS[task.status] : null;
}

/** Steps a walk up the tree takes at most (deeper than any outline; a cycle guard). */
const MAX_DEPTH = 10_000;

export class SpaceMirror {
	private readonly blocks = new Map<string, MirrorBlock>();
	/** Children by parent key ({@link parentKeyOf}), deleted ones included. */
	private readonly kids = new Map<string, Set<string>>();
	private readonly sorted = new Map<string, string[]>();
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

	// ── changing ──────────────────────────────────────────────────────────────

	private link(b: MirrorBlock): void {
		const key = parentKeyOf(b.parentId);
		let set = this.kids.get(key);
		if (!set) {
			set = new Set();
			this.kids.set(key, set);
		}
		set.add(b.id);
		this.sorted.delete(key);
	}

	private unlink(b: MirrorBlock): void {
		const key = parentKeyOf(b.parentId);
		const set = this.kids.get(key);
		if (set) {
			set.delete(b.id);
			if (set.size === 0) this.kids.delete(key);
		}
		this.sorted.delete(key);
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
		if (old && old.deleted !== b.deleted) this.sorted.delete(parentKeyOf(b.parentId));
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
	}

	// ── reading ───────────────────────────────────────────────────────────────

	/** Live children in sibling order (order key, then id); `null`: the top-level blocks held. */
	children(parentId: string | null): string[] {
		const key = parentKeyOf(parentId);
		let list = this.sorted.get(key);
		if (list) return list;
		list = [...(this.kids.get(key) ?? [])].filter((id) => !this.blocks.get(id)?.deleted);
		list.sort((a, b) => {
			const ka = this.blocks.get(a)?.orderKey ?? "";
			const kb = this.blocks.get(b)?.orderKey ?? "";
			return compareOrderKeys(ka, kb) || (a < b ? -1 : a > b ? 1 : 0);
		});
		this.sorted.set(key, list);
		return list;
	}

	/** Every child the mirror holds of a parent (`null`: the top level), deleted ones included. */
	childrenAll(parentId: string | null): string[] {
		return [...(this.kids.get(parentKeyOf(parentId)) ?? [])];
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

	/** How many blocks `subtree` would list (no order, no list made). */
	subtreeSize(id: string): number {
		let n = 0;
		const stack = [id];
		while (stack.length > 0) {
			const next = stack.pop() as string;
			n++;
			for (const kid of this.kids.get(next) ?? [])
				if (!this.blocks.get(kid)?.deleted) stack.push(kid);
		}
		return n;
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

	/** Every block the mirror holds whose parent the mirror does not hold (diagnostics). */
	get roots(): string[] {
		const out: string[] = [];
		for (const b of this.blocks.values())
			if (b.parentId === null || !this.blocks.has(b.parentId)) out.push(b.id);
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

	/** Steps up to the highest block the mirror holds above `id` (0: none above it). */
	depth(id: string): number {
		let d = 0;
		let cur = this.blocks.get(id)?.parentId ?? null;
		for (; cur && d < MAX_DEPTH; d++) cur = this.blocks.get(cur)?.parentId ?? null;
		return d;
	}
}
