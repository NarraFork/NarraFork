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
 * The walk is depth first over a stack of FRAMES, one per parent being looked at:
 *
 *   - `then`: the parent was under the root at `then` (or is the root) and is under it at `to`.
 *     Its children of `then` are the subtree's own; what arrived under it since is added (not
 *     in the tree at `then`), moved in (in the tree then, elsewhere), or a block of the subtree
 *     that belongs under another parent (handled where it belonged).
 *   - `away`: the parent was under the root at `then` and is not at `to` (it moved away, or is
 *     deleted under a block that did). Its children of `then` either followed it or are found
 *     to be elsewhere; nothing can be put back under it.
 *   - `added`: the parent was added since. Everything under it arrived; a restore deletes it
 *     once what must not go with it has left, so the walk tells when a frame is finished.
 *
 * Whether a block is under the root at a seq is known for free from the frame it is met in,
 * except for a block met under one parent that sits under another at the other seq: those are
 * walked up by their placements as of that seq, many at once, one bounded read per level.
 *
 * WHAT IT COSTS. One step reads one page of one parent's changed children
 * (`OUTLINE_DIFF_LIMITS.levelRows`) and, for those, their versions at both ends without
 * content, their rows, and the walks up. A caller runs steps until its row budget is spent
 * and hands the stack out as a cursor (`restore-errors.ts` seals it), so a comparison of a
 * huge subtree is many bounded reads, never one. Every read names the space.
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
import { assertHistoryReadable, type OutlineChangedChildCursor } from "./store/history-port";
import type { OutlineBlockMeta, OutlineSpaceRow, OutlineStore } from "./store/port";
import type { OutlineVersionHead } from "./store/read-port";
import { withOutlineHistory } from "./subtree-errors";
import { sameTaskJson } from "./task-json";

export type DiffFrameKind = "then" | "away" | "added";

export interface DiffFrame {
	/** Null: the top level of the space. */
	parentId: string | null;
	kind: DiffFrameKind;
	/** The next page of the parent's changed children; null before the first. */
	cursor: OutlineChangedChildCursor | null;
	/** No page of it is left to read. */
	done: boolean;
	/** `added`: something stays under the parent, so it cannot be deleted. */
	kept: boolean;
	/** Index of the frame that pushed this one; -1 for the root's. */
	up: number;
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
	/** What the comparison lists it as; null when it lists nothing for it here. */
	kind: OutlineDiffKind | null;
	/** For `changed`: what differs. */
	fields: OutlineDiffField[];
	/** Its tags at `then` and at `to`, when the walk read them. */
	thenTags?: string[];
	nowTags?: string[];
	/** It has a version of its own in the range; something under it changed in the range. */
	self: boolean;
	below: boolean;
	/** The kind of the frame the walk pushed for it, if any. */
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
	| { type: "close"; parentId: string | null; kind: DiffFrameKind; kept: boolean };

export interface DiffWalkScope {
	store: OutlineStore;
	space: OutlineSpaceRow;
	rootId: string | null;
	thenSeq: number;
	/** The newer seq, at most the space's last commit. */
	to: number;
	/**
	 * `compare`: read each block's version at `to` and tell what differs. `restore`: read only
	 * where each block sat at `to`; the caller compares `then` with the rows as they are now.
	 */
	mode: "compare" | "restore";
}

/** Levels walked up by batched placement reads before a block is walked alone. */
const MEMBER_HOPS = 4;

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

export class SubtreeDiffWalk {
	/** Rows read from the store so far. */
	rows = 0;
	private readonly memberThen = new Map<string, boolean>();
	private readonly memberNow = new Map<string, boolean>();

	constructor(
		private readonly scope: DiffWalkScope,
		readonly state: DiffWalkState,
	) {
		if (scope.rootId !== null) {
			this.memberThen.set(scope.rootId, true);
			this.memberNow.set(scope.rootId, true);
		}
	}

	get finished(): boolean {
		return this.state.rootDone && this.state.frames.length === 0;
	}

	/** A copy of the stack: where a walk can start again from. */
	snapshot(): DiffWalkState {
		return {
			rootDone: this.state.rootDone,
			frames: this.state.frames.map((frame) => ({
				...frame,
				cursor: frame.cursor ? { ...frame.cursor } : null,
			})),
		};
	}

	/** Mark the `added` frames from `frameIndex` up to the root as holding something that stays. */
	keep(frameIndex: number): void {
		for (let i = frameIndex; i >= 0; ) {
			const frame = this.state.frames[i];
			if (!frame || frame.kind !== "added") return;
			frame.kept = true;
			i = frame.up;
		}
	}

	/** The parents of the `added` frames from `frameIndex` up: the blocks a delete there takes. */
	addedAbove(frameIndex: number): string[] {
		const out: string[] = [];
		for (let i = frameIndex; i >= 0; ) {
			const frame = this.state.frames[i];
			if (!frame || frame.kind !== "added") break;
			if (frame.parentId !== null) out.push(frame.parentId);
			i = frame.up;
		}
		return out;
	}

	private get range(): { after: number; upTo: number } {
		return { after: this.scope.thenSeq, upTo: this.scope.to };
	}

	private push(parentId: string | null, kind: DiffFrameKind, up: number): void {
		this.state.frames.push({ parentId, kind, cursor: null, done: false, kept: false, up });
	}

	/** One unit of the walk: the root, one page of the top frame, or a finished frame. */
	async step(): Promise<DiffStep> {
		if (!this.state.rootDone) return await this.root();
		const index = this.state.frames.length - 1;
		const frame = this.state.frames[index];
		if (!frame) throw new Error("the outline diff walk is finished");
		if (frame.done) {
			this.state.frames.pop();
			if (frame.kept) this.keep(frame.up);
			return { type: "close", parentId: frame.parentId, kind: frame.kind, kept: frame.kept };
		}
		return await this.page(frame, index);
	}

	private async heads(
		ids: readonly string[],
		seq: number,
		chars: number,
	): Promise<Map<string, OutlineVersionHead>> {
		const rows = ids.length > 0 ? await this.scope.store.listVersionHeadsAt(ids, seq, chars) : [];
		this.rows += rows.length;
		return new Map(rows.filter((row) => !row.deleted).map((row) => [row.blockId, row]));
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

	private async root(): Promise<DiffStep> {
		const { store, space, rootId, thenSeq, to, mode } = this.scope;
		this.state.rootDone = true;
		if (rootId === null) {
			this.push(null, "then", -1);
			return { type: "root", item: null };
		}
		const chars = mode === "compare" ? OUTLINE_DIFF_LIMITS.excerptChars : 0;
		const meta = (await store.getBlockMetas(space.id, { ids: [rootId] }))[0];
		const before = (await this.heads([rootId], thenSeq, chars)).get(rootId) ?? null;
		const after = (await this.heads([rootId], to, chars)).get(rootId) ?? null;
		this.rows += 1;
		if (!meta || !before) throw new OutlineRestoreRootError({ blockId: rootId, seq: thenSeq });
		if (!after) throw new OutlineRestoreRootError({ blockId: rootId, seq: to });
		const changes = await store.findSubtreeChanges(space.id, [rootId], this.range);
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
			kind: null,
			fields: [],
			self: change?.self === true,
			below: change?.below === true,
			descend: null,
		};
		if (change?.self) {
			item.thenTags = (await this.tags([rootId], thenSeq)).get(rootId) ?? [];
			if (mode === "compare") {
				item.nowTags = (await this.tags([rootId], to)).get(rootId) ?? [];
				item.fields = contentFieldsDiffer(before, after);
				if (item.thenTags.join("\n") !== item.nowTags.join("\n")) item.fields.push("tags");
				if (item.fields.length > 0) item.kind = "changed";
			}
		}
		if (item.below) {
			this.push(rootId, "then", -1);
			item.descend = "then";
		}
		return { type: "root", item };
	}

	/**
	 * Whether each of `ids` was under the root as of `seq`, into `memo`: up the placements valid
	 * then, all of them one level per read; a chain longer than a few levels is finished with
	 * one recursive read of its own.
	 */
	private async members(
		ids: readonly string[],
		seq: number,
		memo: Map<string, boolean>,
	): Promise<void> {
		const { store, space, rootId } = this.scope;
		if (rootId === null) return;
		const parentOf = new Map<string, string>();
		let frontier = [...new Set(ids)].filter((id) => !memo.has(id));
		for (let hop = 0; frontier.length > 0 && hop < MEMBER_HOPS; hop++) {
			const rows = await store.getPlacementsAt(space.id, frontier, seq);
			this.rows += rows.length;
			const found = new Map(rows.map((row) => [row.blockId, row.parentKey]));
			const next = new Set<string>();
			for (const id of frontier) {
				const parentKey = found.get(id);
				if (parentKey === undefined || parentKey === space.id) memo.set(id, false);
				else if (parentKey === rootId) memo.set(id, true);
				else {
					parentOf.set(id, parentKey);
					next.add(parentKey);
				}
			}
			frontier = [...next].filter((id) => !memo.has(id) && !parentOf.has(id));
		}
		for (const id of frontier) {
			const chain = await store.getAncestry(space.id, id, {
				asOf: seq,
				maxDepth: OUTLINE_LIMITS.maxDepth,
			});
			this.rows += chain?.length ?? 1;
			memo.set(id, chain?.some((row) => row.id === rootId) === true);
		}
		for (const id of ids) {
			const chain: string[] = [];
			let current: string | undefined = id;
			let answer = false;
			for (let depth = 0; current !== undefined && depth <= OUTLINE_LIMITS.maxDepth; depth++) {
				const known = memo.get(current);
				if (known !== undefined) {
					answer = known;
					break;
				}
				chain.push(current);
				current = parentOf.get(current);
			}
			for (const link of chain) memo.set(link, answer);
		}
	}

	private async page(frame: DiffFrame, index: number): Promise<DiffStep> {
		const { store, space, rootId, thenSeq, to, mode } = this.scope;
		const { rows, next } = await store.listChangedChildren(space.id, frame.parentId, {
			...this.range,
			cursor: frame.cursor,
			limit: OUTLINE_DIFF_LIMITS.levelRows,
		});
		this.rows += rows.length;
		frame.cursor = next;
		if (!next) frame.done = true;

		/** Per block: whether a row of this page covers `then` / `to`, and its change flags. */
		const seen = new Map<
			string,
			{ coversThen: boolean; coversTo: boolean; self: boolean; below: boolean }
		>();
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
		const ids = [...seen.keys()];
		const result: DiffStep = {
			type: "page",
			frameIndex: index,
			parentId: frame.parentId,
			kind: frame.kind,
			items: [],
		};
		if (ids.length === 0) return result;

		const chars = mode === "compare" ? OUTLINE_DIFF_LIMITS.excerptChars : 0;
		const thenHeads = await this.heads(ids, thenSeq, chars);
		const metaRows = await store.getBlockMetas(space.id, { ids });
		this.rows += metaRows.length;
		const metas = new Map(metaRows.map((row) => [row.id, row]));
		let nowHeads = new Map<string, OutlineVersionHead>();
		const at = new Map<string, DiffPlace>();
		if (mode === "compare") {
			nowHeads = await this.heads(ids, to, chars);
			for (const [id, head] of nowHeads) at.set(id, place(head));
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
		const handled: Array<{ id: string; own: boolean }> = [];
		for (const [id, flags] of seen) {
			if (!metas.has(id)) continue;
			const own = thenHeads.get(id)?.parentId === frame.parentId && thenHeads.has(id);
			const here = at.get(id)?.parentId === frame.parentId && at.has(id);
			if (own ? flags.coversThen : here && flags.coversTo && frame.kind !== "away")
				handled.push({ id, own });
		}
		const wholeSpace = rootId === null;
		if (!wholeSpace) {
			await this.members(
				handled.filter(({ id, own }) => own && at.has(id)).map(({ id }) => id),
				to,
				this.memberNow,
			);
			await this.members(
				handled.filter(({ id, own }) => !own && thenHeads.has(id)).map(({ id }) => id),
				thenSeq,
				this.memberThen,
			);
		}

		const compared: DiffItem[] = [];
		for (const { id, own } of handled) {
			const flags = seen.get(id) as { self: boolean; below: boolean };
			// (flags are the block's over the whole range, the same on each of its rows)
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
				kind: null,
				fields: [],
				self: flags.self,
				below: flags.below,
				descend: null,
			};
			if (own) {
				if (!where) {
					item.kind = "removed";
					item.descend = frame.kind === "then" ? "then" : "away";
				} else {
					item.inNow =
						where.parentId === frame.parentId
							? frame.kind === "then"
							: wholeSpace || this.memberNow.get(id) === true;
					if (item.inNow) {
						item.descend = "then";
						compared.push(item);
					} else {
						if (where.parentId !== before?.parentId) item.kind = "moved-away";
						item.descend = "away";
					}
				}
			} else {
				item.inNow = true;
				if (before) {
					item.inThen = wholeSpace || this.memberThen.get(id) === true;
					// In the tree at `then`, elsewhere: moved in, unless it is a block of the subtree
					// that belongs under another parent (listed where it belonged).
					if (!item.inThen) item.kind = "moved-in";
				} else {
					item.kind = "added";
					item.descend = "added";
				}
			}
			if (wholeSpace) {
				this.memberThen.set(id, item.inThen);
				this.memberNow.set(id, item.inNow);
			}
			result.items.push(item);
		}

		// Tags: read for the blocks whose fields are compared or put back.
		const tagged = result.items
			.filter((item) => item.own && item.self && (item.kind === "removed" || item.inNow))
			.map((item) => item.id);
		const thenTags = await this.tags(tagged, thenSeq);
		const nowTags = mode === "compare" ? await this.tags(tagged, to) : null;
		for (const item of result.items) {
			if (thenTags.has(item.id)) item.thenTags = thenTags.get(item.id);
			if (nowTags?.has(item.id)) item.nowTags = nowTags.get(item.id);
		}
		if (mode === "compare") {
			for (const item of compared) {
				const before = item.before as OutlineVersionHead;
				const after = item.now as OutlineVersionHead;
				if (before.parentId !== after.parentId) item.fields.push("parent");
				else if (before.orderKey !== after.orderKey) item.fields.push("order");
				item.fields.push(...contentFieldsDiffer(before, after));
				if ((item.thenTags ?? []).join("\n") !== (item.nowTags ?? []).join("\n"))
					item.fields.push("tags");
				if (item.fields.length > 0) item.kind = "changed";
			}
		}

		for (const item of result.items) {
			if (!item.below) item.descend = null;
			else if (item.descend) this.push(item.id, item.descend, index);
		}
		return result;
	}
}

const FRAME_KINDS: readonly DiffFrameKind[] = ["then", "away", "added"];
const MAX_FRAMES = 20_000;

/** A walk's stack as plain JSON (sealed by the caller). */
export function encodeDiffWalkState(state: DiffWalkState): unknown[] {
	return [
		state.rootDone ? 1 : 0,
		state.frames.map((frame) => [
			frame.parentId ?? "",
			FRAME_KINDS.indexOf(frame.kind),
			(frame.done ? 1 : 0) | (frame.kept ? 2 : 0),
			frame.up,
			frame.cursor
				? [
						frame.cursor.pin,
						frame.cursor.open ? 1 : 0,
						frame.cursor.toSeq,
						frame.cursor.fromSeq,
						frame.cursor.orderKey,
						frame.cursor.blockId,
					]
				: 0,
		]),
	];
}

const isSeq = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The stack a cursor holds; throws when it is not one `encodeDiffWalkState` made. */
export function decodeDiffWalkState(value: unknown): DiffWalkState {
	const bad = () => new OutlineRestoreTokenError("cursor");
	if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[1])) throw bad();
	const list = value[1] as unknown[];
	if (list.length > MAX_FRAMES) throw bad();
	const frames = list.map((raw, i): DiffFrame => {
		if (!Array.isArray(raw) || raw.length !== 5) throw bad();
		const [parentId, kind, flags, up, cursor] = raw as unknown[];
		if (
			typeof parentId !== "string" ||
			typeof kind !== "number" ||
			FRAME_KINDS[kind] === undefined ||
			typeof flags !== "number" ||
			typeof up !== "number" ||
			!Number.isInteger(up) ||
			up < -1 ||
			up >= i
		)
			throw bad();
		let at: OutlineChangedChildCursor | null = null;
		if (cursor !== 0) {
			if (!Array.isArray(cursor) || cursor.length !== 6) throw bad();
			const [pin, open, toSeq, fromSeq, orderKey, blockId] = cursor as unknown[];
			if (
				!isSeq(pin) ||
				!isSeq(toSeq) ||
				!isSeq(fromSeq) ||
				typeof orderKey !== "string" ||
				typeof blockId !== "string"
			)
				throw bad();
			at = { pin, open: open === 1, toSeq, fromSeq, orderKey, blockId };
		}
		return {
			parentId: parentId === "" ? null : parentId,
			kind: FRAME_KINDS[kind] as DiffFrameKind,
			cursor: at,
			done: (flags & 1) !== 0,
			kept: (flags & 2) !== 0,
			up,
		};
	});
	return { rootDone: value[0] === 1, frames };
}

// ─────────────────────────────────────────────────────────────────────────────
// The comparison as a read
// ─────────────────────────────────────────────────────────────────────────────

/** Rows one step may read at most in the ordinary case: what a page keeps in reserve. */
export const DIFF_STEP_ROWS = OUTLINE_DIFF_LIMITS.levelRows * 6;

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

/** Whether a paged walk has room for one more step. */
export function diffHasRoom(walk: SubtreeDiffWalk, entries: number, limit: number): boolean {
	return (
		walk.rows + DIFF_STEP_ROWS <= OUTLINE_DIFF_LIMITS.maxStoreRows &&
		entries + OUTLINE_DIFF_LIMITS.levelRows <= limit
	);
}

/**
 * What differs under a block (`rootId` null: in the whole space) between the seq `then` and a
 * later one (`to`; the space's last commit by default), a page at a time: see
 * `shared/outline-restore-api.ts` for what each kind means. A page is what one bounded read
 * found (at most {@link OUTLINE_DIFF_LIMITS.maxStoreRows} store rows; `limit` entries, never
 * fewer than one store page of {@link OUTLINE_DIFF_LIMITS.levelRows}), in depth-first order;
 * `nextCursor` continues it, and all pages compare the same two seqs. Throws H2's history
 * errors when the space cannot answer for `then`, and `OutlineRestoreRootError` when the root
 * was not in the tree at one of the two seqs.
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
			typeof value[3] !== "number" ||
			value[3] > latest
		)
			throw new OutlineRestoreTokenError("cursor");
		to = value[3];
		state = decodeDiffWalkState(value[4]);
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
	return await withOutlineHistory(async () => {
		while (!walk.finished && diffHasRoom(walk, entries.length, limit)) {
			const step = await walk.step();
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
						encodeDiffWalkState(walk.state),
					]),
		);
	});
}
