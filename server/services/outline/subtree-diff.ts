/**
 * Comparing two moments of any block's subtree (pageless outline, H3): which blocks were added,
 * removed, moved in, moved away or changed between a seq `then` and a later seq `to`. The
 * restore (`subtree-restore.ts`) is built on the same walk.
 *
 * THE WALK
 * --------
 * It never reads a subtree. From the root it asks one parent at a time for the children that
 * differ between the two seqs (`listChangedChildren`: a child arrived, left, changed, or
 * something under it changed) and goes down only into those with a change mark below them.
 * Every block with a version of its own in the range that was under the root at `then` is
 * reached this way (H1's change marks: each ancestor of a changed block, before and after, is
 * marked), and so is everything that arrived since.
 *
 * The walk is depth first over a stack of FRAMES, one per parent on the path being looked at:
 *
 *   - `then`: the parent was under the root at `then` (or is the root) and is under it at `to`,
 *     or was deleted while under it. Its children of `then` are the subtree's own; what arrived
 *     under it since is added (not in the tree at `then`), moved in (in the tree then,
 *     elsewhere), or a block of the subtree that belongs under another parent (handled where it
 *     belonged).
 *   - `away`: the parent was under the root at `then` and is not at `to` (it moved away, or was
 *     deleted after it had). Its children of `then` either followed it or are found to be
 *     elsewhere; nothing can be put back under it.
 *   - `added`: the parent was added since. Everything under it arrived; a restore deletes it
 *     once what must not go with it has left, so the walk tells when a frame is finished.
 *
 * FRAMES ARE PUSHED LAZILY. A frame keeps the cursor of the page of its parent's changed
 * children it is on, and how many blocks of that page it has handled (`pos`). A step handles
 * the blocks of the page up to the next one with something changed under it, pushes that one's
 * frame and stops; the parent's page is read again when the child's frame is finished. So the
 * stack is the path from the root, never longer than the tree is deep, and a cursor stays small
 * however wide the subtree. Every frame's read is pinned to `to` (its first cursor names it), so
 * reading a page again gives the same rows whatever was committed since: the restore's own
 * commits included.
 *
 * Whether a block is under the root at a seq is known for free from the frame it is met in,
 * except for a block met under one parent that sits under another at the other seq: those are
 * asked of the store in one statement (`listUnderRootAt`), one row per block.
 *
 * A block of the subtree that is deleted at `to` was REMOVED when it was deleted while under the
 * root (a restore brings it back). When it was deleted after it had left the subtree, it moved
 * away and was deleted since (`deletedSince`): a restore does not bring it back, it is listed
 * with the blocks that moved away (owner rule D58: what moved away is not pulled back).
 *
 * WHAT IT COSTS. Every read is charged to `rows`, and a step is given the rows it may still read
 * (`step(budget)`). It handles as many blocks as the budget surely covers (each block's fixed
 * reads, its tags when they may differ, and what the caller reads for it after), and answers
 * null when not even one fits: the caller ends its page there. Tags are read only for a block
 * whose tags may differ between the two seqs (`findTagChanges`). So a page of a comparison of a
 * huge subtree is a bounded number of rows, and many pages make the whole. Every read names the
 * space.
 */
import { ValidationError } from "@server/lib/errors";
import {
	OUTLINE_DIFF_LIMITS,
	type OutlineDiffEntry,
	type OutlineDiffField,
	type OutlineDiffKind,
	type OutlineDiffSide,
	type OutlineSubtreeDiffResponse,
} from "@shared/outline-restore-api";
import { OUTLINE_TEXT } from "./messages";
import { OUTLINE_LIMITS } from "./model";
import {
	OutlineRestoreRootError,
	OutlineRestoreTokenError,
	openOutlineValue,
	sealOutlineValue,
} from "./restore-errors";
import { outlineStore } from "./store";
import {
	assertHistoryReadable,
	type OutlineChangedChildCursor,
	type OutlineChangedChildRow,
	type OutlineUnderRootRow,
} from "./store/history-port";
import type { OutlineBlockMeta, OutlineSpaceRow, OutlineStore } from "./store/port";
import type { OutlineVersionHead } from "./store/read-port";
import { withOutlineHistory } from "./subtree-errors";
import { sameTaskJson } from "./task-json";

export type DiffFrameKind = "then" | "away" | "added";

export interface DiffFrame {
	/** Null: the top level of the space. */
	parentId: string | null;
	kind: DiffFrameKind;
	/** The page of the parent's changed children the frame is on (pinned to `to`). */
	cursor: OutlineChangedChildCursor;
	/** Blocks of that page already handled, in the page's order. */
	pos: number;
	/** No page of it is left to read. */
	done: boolean;
	/** `added`: something stays under the parent, so it cannot be deleted. */
	kept: boolean;
	/** `added`: something under the parent must leave it first; whether it can is not known. */
	maybe: boolean;
}

export interface DiffWalkState {
	/** The root itself has been looked at. */
	rootDone: boolean;
	frames: DiffFrame[];
}

export function newDiffWalkState(): DiffWalkState {
	return { rootDone: false, frames: [] };
}

/** Where a block sat at a seq. */
export interface DiffPlace {
	parentId: string | null;
	orderKey: string;
}

/** A block the walk met, with what it knows of it. */
export interface DiffItem {
	id: string;
	/** The block's row now. */
	meta: OutlineBlockMeta;
	/** Its version at `then`, when it was live then. */
	before: OutlineVersionHead | null;
	/** Where it sat at `to`; null when it was not in the tree then. */
	at: DiffPlace | null;
	/** Its version at `to`, when it was live then (a walk that compares, not one that restores). */
	now: OutlineVersionHead | null;
	/** It was a child of the frame's parent at `then`: a block of the subtree. */
	own: boolean;
	/** It was under the root at `then` / is under it at `to`. */
	inThen: boolean;
	inNow: boolean;
	/** Deleted at `to` after it had left the subtree: moved away, not removed. */
	deletedSince: boolean;
	/** What the comparison lists it as; null when it lists nothing for it here. */
	kind: OutlineDiffKind | null;
	/** For `changed`: what differs. */
	fields: OutlineDiffField[];
	/** A tag of it was put on or taken off since `then`: its tags may differ. */
	tagsMayDiffer: boolean;
	/** Its tags at `then` and at `to`, when the walk read them. */
	thenTags?: string[];
	nowTags?: string[];
	/** It has a version of its own in the range; something under it changed in the range. */
	self: boolean;
	below: boolean;
	/** The kind of the frame the walk pushes for it, if any. */
	descend: DiffFrameKind | null;
}

export type DiffStep =
	| { type: "root"; item: DiffItem | null }
	| {
			type: "page";
			frameIndex: number;
			parentId: string | null;
			kind: DiffFrameKind;
			items: DiffItem[];
	  }
	| {
			type: "close";
			parentId: string | null;
			kind: DiffFrameKind;
			kept: boolean;
			maybe: boolean;
	  };

export interface DiffWalkScope {
	store: OutlineStore;
	space: OutlineSpaceRow;
	rootId: string | null;
	thenSeq: number;
	/** The newer seq, at most the space's last commit. */
	to: number;
	/**
	 * `compare`: read each block's version at `to` and tell what differs. `restore`: read only
	 * where each block sat at `to`; the caller compares `then` with the rows as they are now
	 * (so whether tags may differ is asked up to now, not up to `to`).
	 */
	mode: "compare" | "restore";
}

/** What a caller reads for the items of a step after the walk: charged to the step's budget. */
export interface DiffLateCost {
	/** The most it reads for one item. */
	max: number;
	/** What it reads at most for this item. */
	cost(item: DiffItem, frameKind: DiffFrameKind): number;
}

/** Rows one block met on a page costs the walk at most, its tags aside. */
export const DIFF_ITEM_ROWS = 8;
/** Rows a block's tags cost at most (both seqs). */
export const DIFF_TAG_ROWS = 2 * OUTLINE_LIMITS.maxTagsPerBlock;
/** Pages of changed children a walk keeps in memory, to read a parent's page again for free. */
const PAGE_CACHE = 8;

function place(head: OutlineVersionHead): DiffPlace {
	return { parentId: head.parentId, orderKey: head.orderKey };
}

/** What differs between two live versions of a block, tags and placement aside. */
export function contentFieldsDiffer(
	a: Pick<OutlineVersionHead, "contentHash" | "taskJson" | "askJson" | "alias">,
	b: Pick<OutlineVersionHead, "contentHash" | "taskJson" | "askJson" | "alias">,
): OutlineDiffField[] {
	const fields: OutlineDiffField[] = [];
	if (a.contentHash !== b.contentHash) fields.push("text");
	if (!sameTaskJson(a.taskJson, b.taskJson)) fields.push("task");
	if (JSON.stringify(a.askJson ?? null) !== JSON.stringify(b.askJson ?? null))
		fields.push("question");
	if (a.alias !== b.alias) fields.push("alias");
	return fields;
}

/** The first page of a frame's read, pinned to `to`. */
export function startCursor(to: number): OutlineChangedChildCursor {
	return { pin: to, open: true, toSeq: 0, fromSeq: 0, orderKey: "", blockId: "" };
}

const isStart = (cursor: OutlineChangedChildCursor, to: number): boolean =>
	cursor.pin === to &&
	cursor.open &&
	cursor.toSeq === 0 &&
	cursor.fromSeq === 0 &&
	cursor.orderKey === "" &&
	cursor.blockId === "";

interface PageFlags {
	coversThen: boolean;
	coversTo: boolean;
	self: boolean;
	below: boolean;
}

export class SubtreeDiffWalk {
	/** Rows read from the store so far (callers add their own reads). */
	rows = 0;
	private readonly pages = new Map<
		string,
		{ rows: OutlineChangedChildRow[]; next: OutlineChangedChildCursor | null }
	>();

	constructor(
		private readonly scope: DiffWalkScope,
		readonly state: DiffWalkState,
	) {}

	get finished(): boolean {
		return this.state.rootDone && this.state.frames.length === 0;
	}

	/** A copy of the stack: where a walk can start again from. */
	snapshot(): DiffWalkState {
		return {
			rootDone: this.state.rootDone,
			frames: this.state.frames.map((frame) => ({ ...frame, cursor: { ...frame.cursor } })),
		};
	}

	/** Mark the `added` frames from `frameIndex` up to the first other one as holding what stays. */
	keep(frameIndex: number): void {
		for (let i = frameIndex; i >= 0; i--) {
			const frame = this.state.frames[i];
			if (!frame || frame.kind !== "added") return;
			frame.kept = true;
		}
	}

	/** Mark the `added` frames from `frameIndex` up as holding what must leave first. */
	maybe(frameIndex: number): void {
		for (let i = frameIndex; i >= 0; i--) {
			const frame = this.state.frames[i];
			if (!frame || frame.kind !== "added") return;
			frame.maybe = true;
		}
	}

	/** Mark the open `added` frames of these blocks as holding what stays. */
	keepIds(ids: ReadonlySet<string>): void {
		for (const frame of this.state.frames)
			if (frame.kind === "added" && frame.parentId !== null && ids.has(frame.parentId))
				frame.kept = true;
	}

	/** The parents of the `added` frames from `frameIndex` up: the blocks a delete there takes. */
	addedAbove(frameIndex: number): string[] {
		const out: string[] = [];
		for (let i = frameIndex; i >= 0; i--) {
			const frame = this.state.frames[i];
			if (!frame || frame.kind !== "added") break;
			if (frame.parentId !== null) out.push(frame.parentId);
		}
		return out;
	}

	private push(parentId: string | null, kind: DiffFrameKind): void {
		this.state.frames.push({
			parentId,
			kind,
			cursor: startCursor(this.scope.to),
			pos: 0,
			done: false,
			kept: false,
			maybe: false,
		});
	}

	/** The rows a step needs at least to get anywhere. */
	private need(late: DiffLateCost | undefined): number {
		return DIFF_ITEM_ROWS + DIFF_TAG_ROWS + (late?.max ?? 0);
	}

	/**
	 * One unit of the walk: the root, part of one page of the top frame, or a finished frame;
	 * at most `budget` rows read (and reserved for `late`). Null when the budget is too small
	 * for even one block: the caller ends its page and comes back with a fresh budget.
	 */
	async step(budget: number, late?: DiffLateCost): Promise<DiffStep | null> {
		if (!this.state.rootDone) {
			if (budget < this.need(late)) return null;
			return await this.root();
		}
		const index = this.state.frames.length - 1;
		const frame = this.state.frames[index];
		if (!frame) throw new Error("the outline diff walk is finished");
		if (frame.done) {
			this.state.frames.pop();
			if (frame.kept) this.keep(index - 1);
			else if (frame.maybe) this.maybe(index - 1);
			return {
				type: "close",
				parentId: frame.parentId,
				kind: frame.kind,
				kept: frame.kept,
				maybe: frame.maybe,
			};
		}
		if (budget < OUTLINE_DIFF_LIMITS.levelRows + this.need(late)) return null;
		return await this.page(frame, index, budget, late);
	}

	/** Versions at a seq, tombstones included. */
	private async heads(
		ids: readonly string[],
		seq: number,
		chars: number,
	): Promise<Map<string, OutlineVersionHead>> {
		const rows = ids.length > 0 ? await this.scope.store.listVersionHeadsAt(ids, seq, chars) : [];
		this.rows += rows.length;
		return new Map(rows.map((row) => [row.blockId, row]));
	}

	private async tags(ids: readonly string[], seq: number): Promise<Map<string, string[]>> {
		const out = new Map<string, string[]>(ids.map((id) => [id, []]));
		if (ids.length === 0) return out;
		const links = await this.scope.store.listLinksAt(
			ids,
			seq,
			["tag"],
			ids.length * OUTLINE_LIMITS.maxTagsPerBlock,
		);
		this.rows += links.length;
		for (const link of links) out.get(link.fromBlockId)?.push(link.targetRef);
		for (const list of out.values()) list.sort();
		return out;
	}

	/** Which of `ids` may have other tags now than at `then`. */
	private async tagHints(ids: readonly string[]): Promise<Set<string>> {
		if (ids.length === 0) return new Set();
		const { thenSeq, to, mode } = this.scope;
		const found = await this.scope.store.findTagChanges(ids, {
			after: thenSeq,
			upTo: mode === "compare" ? to : Number.MAX_SAFE_INTEGER,
		});
		this.rows += found.length;
		return new Set(found);
	}

	/** Where each block last sat as of its seq, and whether under the root; a row per block. */
	private async under(
		items: Array<{ blockId: string; asOf: number }>,
	): Promise<Map<string, OutlineUnderRootRow>> {
		const { store, space, rootId } = this.scope;
		if (rootId === null || items.length === 0) return new Map();
		const rows = await store.listUnderRootAt(space.id, rootId, items, OUTLINE_LIMITS.maxDepth);
		this.rows += rows.length;
		return new Map(rows.map((row) => [`${row.blockId}@${row.asOf}`, row]));
	}

	private async root(): Promise<DiffStep> {
		const { store, space, rootId, thenSeq, to, mode } = this.scope;
		this.state.rootDone = true;
		if (rootId === null) {
			this.push(null, "then");
			return { type: "root", item: null };
		}
		const chars = mode === "compare" ? OUTLINE_DIFF_LIMITS.excerptChars : 0;
		const meta = (await store.getBlockMetas(space.id, { ids: [rootId] }))[0];
		this.rows += 1;
		const before = (await this.heads([rootId], thenSeq, chars)).get(rootId);
		const after = (await this.heads([rootId], to, chars)).get(rootId);
		if (!meta || !before || before.deleted)
			throw new OutlineRestoreRootError({ blockId: rootId, seq: thenSeq });
		if (!after || after.deleted) throw new OutlineRestoreRootError({ blockId: rootId, seq: to });
		const changes = await store.findSubtreeChanges(space.id, [rootId], {
			after: thenSeq,
			upTo: to,
		});
		this.rows += changes.length;
		const change = changes[0];
		const item: DiffItem = {
			id: rootId,
			meta,
			before,
			at: place(after),
			now: mode === "compare" ? after : null,
			own: true,
			inThen: true,
			inNow: true,
			deletedSince: false,
			kind: null,
			fields: [],
			tagsMayDiffer: false,
			self: change?.self === true,
			below: change?.below === true,
			descend: null,
		};
		if (item.self) {
			item.tagsMayDiffer = (await this.tagHints([rootId])).has(rootId);
			if (item.tagsMayDiffer) {
				item.thenTags = (await this.tags([rootId], thenSeq)).get(rootId) ?? [];
				if (mode === "compare") item.nowTags = (await this.tags([rootId], to)).get(rootId) ?? [];
			}
			if (mode === "compare") {
				item.fields = contentFieldsDiffer(before, after);
				if ((item.thenTags ?? []).join("\n") !== (item.nowTags ?? []).join("\n"))
					item.fields.push("tags");
				if (item.fields.length > 0) item.kind = "changed";
			}
		}
		if (item.below) {
			this.push(rootId, "then");
			item.descend = "then";
		}
		return { type: "root", item };
	}

	/** A page of a frame's changed children: read once per walk, kept for reading it again. */
	private async readPage(
		frame: DiffFrame,
	): Promise<{ rows: OutlineChangedChildRow[]; next: OutlineChangedChildCursor | null }> {
		const key = `${frame.parentId ?? ""}|${JSON.stringify(frame.cursor)}`;
		const known = this.pages.get(key);
		if (known) return known;
		const { store, space, thenSeq, to } = this.scope;
		const page = await store.listChangedChildren(space.id, frame.parentId, {
			after: thenSeq,
			upTo: to,
			cursor: frame.cursor,
			limit: OUTLINE_DIFF_LIMITS.levelRows,
		});
		this.rows += page.rows.length;
		if (this.pages.size >= PAGE_CACHE) this.pages.clear();
		this.pages.set(key, page);
		return page;
	}

	private async page(
		frame: DiffFrame,
		index: number,
		budget: number,
		late: DiffLateCost | undefined,
	): Promise<DiffStep> {
		const { store, space, rootId, thenSeq, to, mode } = this.scope;
		const started = this.rows;
		const { rows, next } = await this.readPage(frame);
		const result: DiffStep = {
			type: "page",
			frameIndex: index,
			parentId: frame.parentId,
			kind: frame.kind,
			items: [],
		};

		// Per block, in the page's order: whether a row of this page covers `then` / `to`, and
		// its change flags (the same on each of its rows: they are over the whole range).
		const seen = new Map<string, PageFlags>();
		for (const row of rows) {
			const coversThen = row.fromSeq <= thenSeq && (row.toSeq === null || row.toSeq > thenSeq);
			const coversTo = row.fromSeq <= to && (row.toSeq === null || row.toSeq > to);
			const entry = seen.get(row.blockId);
			if (entry) {
				entry.coversThen ||= coversThen;
				entry.coversTo ||= coversTo;
			} else {
				seen.set(row.blockId, { coversThen, coversTo, self: row.self, below: row.below });
			}
		}
		const order = [...seen.keys()];
		if (frame.pos >= order.length) {
			if (next) {
				frame.cursor = next;
				frame.pos = 0;
			} else frame.done = true;
			return result;
		}

		// This step's blocks: up to the next one with something changed under it (its frame is
		// pushed, and the page is taken up again when that frame is finished), as many as the
		// budget surely covers.
		let end = frame.pos;
		while (end < order.length) {
			const below = (seen.get(order[end] as string) as PageFlags).below;
			end++;
			if (below) break;
		}
		const lateMax = late?.max ?? 0;
		const room = budget - (this.rows - started) - DIFF_TAG_ROWS - lateMax;
		const k = Math.max(1, Math.min(end - frame.pos, Math.floor(room / DIFF_ITEM_ROWS)));
		const ids = order.slice(frame.pos, frame.pos + k);

		const chars = mode === "compare" ? OUTLINE_DIFF_LIMITS.excerptChars : 0;
		const thenHeads = new Map(
			[...(await this.heads(ids, thenSeq, chars))].filter(([, head]) => !head.deleted),
		);
		const metaRows = await store.getBlockMetas(space.id, { ids });
		this.rows += metaRows.length;
		const metas = new Map(metaRows.map((row) => [row.id, row]));
		const nowHeads = new Map<string, OutlineVersionHead>();
		const at = new Map<string, DiffPlace>();
		if (mode === "compare") {
			for (const [id, head] of await this.heads(ids, to, chars)) {
				if (head.deleted) continue;
				nowHeads.set(id, head);
				at.set(id, place(head));
			}
		} else {
			const placements = await store.getPlacementsAt(space.id, ids, to);
			this.rows += placements.length;
			for (const row of placements) {
				at.set(row.blockId, {
					parentId: row.parentKey === space.id ? null : row.parentKey,
					orderKey: row.orderKey,
				});
			}
		}

		// A block with two placements under this parent (it left and came back) is two rows,
		// maybe on two pages: it is handled with the row that covers the seq it is judged at.
		const handled = new Map<string, boolean>();
		for (const id of ids) {
			const flags = seen.get(id) as PageFlags;
			if (!metas.has(id)) continue;
			const own = thenHeads.get(id)?.parentId === frame.parentId && thenHeads.has(id);
			const here = at.get(id)?.parentId === frame.parentId && at.has(id);
			if (own ? flags.coversThen : here && flags.coversTo && frame.kind !== "away")
				handled.set(id, own);
		}
		const wholeSpace = rootId === null;
		// Asked of the store: a block met under another parent than at the other seq, and a block
		// of the subtree deleted at `to` (where it was when it was deleted: under the root, or
		// after it had left it).
		const asked: Array<{ blockId: string; asOf: number }> = [];
		if (!wholeSpace) {
			for (const [id, own] of handled) {
				const where = at.get(id);
				if (own && (!where || where.parentId !== frame.parentId))
					asked.push({ blockId: id, asOf: to });
				if (!own && thenHeads.has(id)) asked.push({ blockId: id, asOf: thenSeq });
			}
		}
		const under = await this.under(asked);
		const isUnder = (id: string, seq: number) =>
			wholeSpace || under.get(`${id}@${seq}`)?.under === true;

		/** In the slice's order; null for a block judged elsewhere. */
		const items: Array<DiffItem | null> = [];
		for (const id of ids) {
			const own = handled.get(id);
			if (own === undefined) {
				items.push(null);
				continue;
			}
			const flags = seen.get(id) as PageFlags;
			const before = thenHeads.get(id) ?? null;
			const where = at.get(id) ?? null;
			const item: DiffItem = {
				id,
				meta: metas.get(id) as OutlineBlockMeta,
				before,
				at: where,
				now: nowHeads.get(id) ?? null,
				own,
				inThen: own,
				inNow: false,
				deletedSince: false,
				kind: null,
				fields: [],
				tagsMayDiffer: false,
				self: flags.self,
				below: flags.below,
				descend: null,
			};
			if (own) {
				if (!where) {
					const last = under.get(`${id}@${to}`);
					if (wholeSpace || !last || last.under) {
						item.kind = "removed";
						item.descend = frame.kind === "then" ? "then" : "away";
					} else {
						// It left the subtree, then was deleted: listed with what moved away (unless it
						// merely followed a block that moved away), never brought back here.
						item.deletedSince = true;
						if (frame.kind === "then" || last.parentKey !== (frame.parentId ?? space.id))
							item.kind = "moved-away";
						item.descend = "away";
					}
				} else {
					item.inNow = where.parentId === frame.parentId ? frame.kind === "then" : isUnder(id, to);
					if (item.inNow) item.descend = "then";
					else {
						if (where.parentId !== before?.parentId) item.kind = "moved-away";
						item.descend = "away";
					}
				}
			} else {
				item.inNow = true;
				if (before) {
					item.inThen = isUnder(id, thenSeq);
					// In the tree at `then`, elsewhere: moved in, unless it is a block of the subtree
					// that belongs under another parent (listed where it belonged).
					if (!item.inThen) item.kind = "moved-in";
				} else {
					item.kind = "added";
					item.descend = "added";
				}
			}
			items.push(item);
		}

		// Tags: of the blocks whose fields are compared or put back, only where they may differ;
		// a removed block's are read whole (it is brought back with them).
		const hinted = await this.tagHints(
			items
				.filter(
					(item): item is DiffItem =>
						item?.own === true && item.self && item.inNow && item.kind !== "removed",
				)
				.map((item) => item.id),
		);
		for (const item of items) if (item && hinted.has(item.id)) item.tagsMayDiffer = true;
		const tagRows = (item: DiffItem) =>
			item.kind === "removed"
				? OUTLINE_LIMITS.maxTagsPerBlock
				: item.tagsMayDiffer
					? (mode === "compare" ? 2 : 1) * OUTLINE_LIMITS.maxTagsPerBlock
					: 0;

		// Cut the step where the budget ends: the first block always fits.
		let spent = this.rows - started;
		let take = 0;
		for (const item of items) {
			const cost = item ? tagRows(item) + (late?.cost(item, frame.kind) ?? 0) : 0;
			if (take > 0 && spent + cost > budget) break;
			spent += cost;
			take++;
		}
		const taken = items.slice(0, take).filter((item): item is DiffItem => item !== null);
		const thenTags = await this.tags(
			taken.filter((item) => item.kind === "removed" || item.tagsMayDiffer).map((item) => item.id),
			thenSeq,
		);
		const nowTags =
			mode === "compare"
				? await this.tags(
						taken.filter((item) => item.tagsMayDiffer).map((item) => item.id),
						to,
					)
				: null;
		for (const item of taken) {
			if (thenTags.has(item.id)) item.thenTags = thenTags.get(item.id);
			if (nowTags?.has(item.id)) item.nowTags = nowTags.get(item.id);
			if (mode === "compare" && item.own && item.inNow) {
				const before = item.before as OutlineVersionHead;
				const after = item.now as OutlineVersionHead;
				if (before.parentId !== after.parentId) item.fields.push("parent");
				else if (before.orderKey !== after.orderKey) item.fields.push("order");
				item.fields.push(...contentFieldsDiffer(before, after));
				if ((item.thenTags ?? []).join("\n") !== (item.nowTags ?? []).join("\n"))
					item.fields.push("tags");
				if (item.fields.length > 0) item.kind = "changed";
			}
			if (!item.below) item.descend = null;
		}
		result.items = taken;
		frame.pos += take;
		// Only the last block of a step can have something changed under it.
		const last = taken.at(-1);
		if (last?.descend && items[take - 1] === last) this.push(last.id, last.descend);
		return result;
	}
}

const FRAME_KINDS: readonly DiffFrameKind[] = ["then", "away", "added"];
/** The stack is the path from the root: never deeper than the tree, plus the root's frame. */
const MAX_FRAMES = OUTLINE_LIMITS.maxDepth + 2;

/** A walk's stack as plain JSON (sealed by the caller); a frame's first page is `0`. */
export function encodeDiffWalkState(state: DiffWalkState, to: number): unknown[] {
	return [
		state.rootDone ? 1 : 0,
		state.frames.map((frame) => [
			frame.parentId ?? "",
			FRAME_KINDS.indexOf(frame.kind),
			(frame.done ? 1 : 0) | (frame.kept ? 2 : 0) | (frame.maybe ? 4 : 0),
			frame.pos,
			isStart(frame.cursor, to)
				? 0
				: [
						frame.cursor.open ? 1 : 0,
						frame.cursor.toSeq,
						frame.cursor.fromSeq,
						frame.cursor.orderKey,
						frame.cursor.blockId,
					],
		]),
	];
}

const isSeq = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The stack a cursor holds; throws when it is not one `encodeDiffWalkState` made for `to`. */
export function decodeDiffWalkState(value: unknown, to: number): DiffWalkState {
	const bad = () => new OutlineRestoreTokenError("cursor");
	if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[1])) throw bad();
	const list = value[1] as unknown[];
	if (list.length > MAX_FRAMES) throw bad();
	const frames = list.map((raw): DiffFrame => {
		if (!Array.isArray(raw) || raw.length !== 5) throw bad();
		const [parentId, kind, flags, pos, cursor] = raw as unknown[];
		if (
			typeof parentId !== "string" ||
			typeof kind !== "number" ||
			FRAME_KINDS[kind] === undefined ||
			typeof flags !== "number" ||
			!isSeq(pos) ||
			pos > OUTLINE_DIFF_LIMITS.levelRows
		)
			throw bad();
		let at = startCursor(to);
		if (cursor !== 0) {
			if (!Array.isArray(cursor) || cursor.length !== 5) throw bad();
			const [open, toSeq, fromSeq, orderKey, blockId] = cursor as unknown[];
			if (
				!isSeq(toSeq) ||
				!isSeq(fromSeq) ||
				typeof orderKey !== "string" ||
				typeof blockId !== "string"
			)
				throw bad();
			at = { pin: to, open: open === 1, toSeq, fromSeq, orderKey, blockId };
		}
		return {
			parentId: parentId === "" ? null : parentId,
			kind: FRAME_KINDS[kind] as DiffFrameKind,
			cursor: at,
			pos,
			done: (flags & 1) !== 0,
			kept: (flags & 2) !== 0,
			maybe: (flags & 4) !== 0,
		};
	});
	return { rootDone: value[0] === 1, frames };
}

// ─────────────────────────────────────────────────────────────────────────────
// The comparison as a read
// ─────────────────────────────────────────────────────────────────────────────

function side(head: OutlineVersionHead): OutlineDiffSide {
	return {
		parentId: head.parentId,
		orderKey: head.orderKey,
		excerpt: head.contentHead ?? "",
		truncated: head.contentChars > OUTLINE_DIFF_LIMITS.excerptChars,
		isTask: head.taskJson !== null,
		alias: head.alias,
	};
}

/** The entry a comparing walk lists for an item; null when it lists none. */
export function diffEntry(item: DiffItem): OutlineDiffEntry | null {
	if (item.kind === null) return null;
	return {
		blockId: item.id,
		sid: item.meta.sid,
		kind: item.kind,
		fields: item.fields,
		before: item.before ? side(item.before) : null,
		after: item.now ? side(item.now) : null,
		...(item.deletedSince ? { deletedSince: true } : {}),
	};
}

/** Refuse a seq the space keeps no history of (H2's 409s). */
export async function assertOutlineHistoryAt(
	store: OutlineStore,
	space: OutlineSpaceRow,
	seq: number,
): Promise<void> {
	await withOutlineHistory(async () => {
		const state = (await store.getHistoryStates([space.id])).get(space.id);
		if (state) assertHistoryReadable(space.id, state, seq);
	});
}

export function clampDiffLimit(limit: number | undefined): number {
	const wanted =
		limit === undefined || !Number.isFinite(limit)
			? OUTLINE_DIFF_LIMITS.defaultEntries
			: Math.min(OUTLINE_DIFF_LIMITS.maxEntries, Math.floor(limit));
	return Math.max(OUTLINE_DIFF_LIMITS.levelRows, wanted);
}

/** Whether a page of entries has room for one more step (a step lists at most a store page). */
export function diffHasRoom(entries: number, limit: number): boolean {
	return entries + OUTLINE_DIFF_LIMITS.levelRows <= limit;
}

/**
 * What differs under a block (`rootId` null: in the whole space) between the seq `then` and a
 * later one (`to`; the space's last commit by default), a page at a time: see
 * `shared/outline-restore-api.ts` for what each kind means. A page is what one bounded read
 * found (at most {@link OUTLINE_DIFF_LIMITS.maxStoreRows} store rows, every read counted; `limit`
 * entries, never fewer than one store page of {@link OUTLINE_DIFF_LIMITS.levelRows}), in
 * depth-first order; `nextCursor` continues it, and all pages compare the same two seqs. Throws
 * H2's history errors when the space cannot answer for `then`, and `OutlineRestoreRootError`
 * when the root was not in the tree at one of the two seqs.
 */
export async function readOutlineSubtreeDiff(input: {
	space: OutlineSpaceRow;
	rootId: string | null;
	thenSeq: number;
	to?: number;
	cursor?: string | null;
	limit?: number;
	store?: OutlineStore;
}): Promise<OutlineSubtreeDiffResponse> {
	const store = input.store ?? outlineStore;
	const { space, rootId, thenSeq } = input;
	const latest = space.nextSeq - 1;
	let to = Math.min(input.to ?? latest, latest);
	let state = newDiffWalkState();
	if (input.cursor) {
		const value = openOutlineValue("diff", input.cursor, "cursor");
		if (
			!Array.isArray(value) ||
			value.length !== 5 ||
			value[0] !== space.id ||
			value[1] !== (rootId ?? "") ||
			value[2] !== thenSeq ||
			!isSeq(value[3]) ||
			value[3] > latest
		)
			throw new OutlineRestoreTokenError("cursor");
		to = value[3];
		state = decodeDiffWalkState(value[4], to);
	}
	for (const [name, seq] of [
		["then", thenSeq],
		["to", to],
	] as const) {
		if (!Number.isSafeInteger(seq) || seq < 0)
			throw new ValidationError(OUTLINE_TEXT.errors.badSeq(name));
	}
	await assertOutlineHistoryAt(store, space, thenSeq);
	const limit = clampDiffLimit(input.limit);
	const entries: OutlineDiffEntry[] = [];
	const done = (nextCursor: string | null): OutlineSubtreeDiffResponse => ({
		spaceId: space.id,
		rootId,
		thenSeq,
		nowSeq: to,
		entries,
		nextCursor,
	});
	if (to <= thenSeq) return done(null);
	const walk = new SubtreeDiffWalk({ store, space, rootId, thenSeq, to, mode: "compare" }, state);
	// The history state read above.
	walk.rows = 1;
	return await withOutlineHistory(async () => {
		while (!walk.finished && diffHasRoom(entries.length, limit)) {
			const step = await walk.step(OUTLINE_DIFF_LIMITS.maxStoreRows - walk.rows);
			if (!step) break;
			const items = step.type === "root" ? [step.item] : step.type === "page" ? step.items : [];
			for (const item of items) {
				const entry = item ? diffEntry(item) : null;
				if (entry) entries.push(entry);
			}
		}
		return done(
			walk.finished
				? null
				: sealOutlineValue("diff", [
						space.id,
						rootId ?? "",
						thenSeq,
						to,
						encodeDiffWalkState(walk.state, to),
					]),
		);
	});
}
