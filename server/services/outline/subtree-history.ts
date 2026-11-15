/**
 * History of any block, without pages (pageless outline, H2): its timeline (the commits that
 * changed it or anything that was under it), and the children of a parent that differ between
 * two seqs (what comparing two moments walks down with, and what "what changed here since I
 * looked" lists). Both are reads of the change marks and placements of `store/history-port.ts`,
 * refused with `OutlineHistoryNotAvailableError` when the space cannot answer them.
 *
 * Nothing here decides access; callers check `access.ts` and that a block belongs to the
 * space. Every store read names the space.
 */
import { ValidationError } from "@server/lib/errors";
import {
	OUTLINE_SUBTREE_LIMITS,
	type OutlineChangedChildrenResponse,
	type OutlineSubtreeTimelineResponse,
} from "@shared/outline-subtree-api";
import { OUTLINE_TEXT } from "./messages";
import { outlineStore } from "./store";
import { assertHistoryReadable, type OutlineChangedChildCursor } from "./store/history-port";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";
import { withOutlineHistory } from "./subtree-errors";
import { summarizeCommits } from "./views";

function clamp(value: number | undefined, fallback: number, max: number): number {
	return value === undefined || !Number.isFinite(value)
		? fallback
		: Math.max(1, Math.min(max, Math.floor(value)));
}

/**
 * The commits that changed a block or anything that was under it, newest first, `limit` at a
 * time (`before` is exclusive); for `blockId` null, the commits of the space. Only commits
 * above the space's history floor: the list ends there.
 *
 * A block's timeline is two bounded range reads merged: the change marks under it (one row per
 * commit that changed anything below) and its own versions. Each is read newest first to one
 * past the limit, so the merged page is exact and a later page costs what a first one does;
 * commits that land between pages are newer than `before` and never shift a page.
 */
export async function readOutlineSubtreeTimeline(
	space: OutlineSpaceRow,
	blockId: string | null,
	options: { before?: number; limit?: number; store?: OutlineStore } = {},
): Promise<OutlineSubtreeTimelineResponse> {
	const store = options.store ?? outlineStore;
	const limit = clamp(
		options.limit,
		OUTLINE_SUBTREE_LIMITS.defaultTimeline,
		OUTLINE_SUBTREE_LIMITS.maxTimeline,
	);
	const before = Math.min(options.before ?? space.nextSeq, space.nextSeq);
	if (!Number.isSafeInteger(before) || before < 0)
		throw new ValidationError(OUTLINE_TEXT.errors.badSeq("before"));
	return withOutlineHistory(async () => {
		const state = (await store.getHistoryStates([space.id])).get(space.id);
		const floorSeq = state?.floorSeq ?? 0;
		if (state) assertHistoryReadable(space.id, state, null);
		let seqs: number[];
		if (blockId === null) {
			// Every seq of a space is one commit.
			seqs = [];
			for (let seq = before - 1; seq > floorSeq && seqs.length <= limit; seq--) seqs.push(seq);
		} else {
			const below = await store.listSubtreeChangeSeqs(space.id, blockId, {
				before,
				limit: limit + 1,
			});
			const own = await store.listBlockHistory(blockId, { before, limit: limit + 1 });
			seqs = [
				...new Set([...below, ...own.map((row) => row.fromSeq).filter((seq) => seq > floorSeq)]),
			].sort((a, b) => b - a);
		}
		const page = seqs.slice(0, limit);
		const commits = await store.getCommitsBySeqs(space.id, page);
		commits.sort((a, b) => b.seq - a.seq);
		return {
			commits: await summarizeCommits(commits),
			nextBefore: seqs.length > limit ? (page.at(-1) ?? null) : null,
			floorSeq,
		};
	});
}

const CURSOR_TEXT = /^[\x20-\x7e]{0,512}$/;

function encodeChangedCursor(cursor: OutlineChangedChildCursor): string {
	return Buffer.from(
		JSON.stringify([
			cursor.pin,
			cursor.open ? 1 : 0,
			cursor.toSeq,
			cursor.fromSeq,
			cursor.orderKey,
			cursor.blockId,
		]),
		"utf8",
	).toString("base64url");
}

function decodeChangedCursor(cursor: string): OutlineChangedChildCursor {
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (Array.isArray(value) && value.length === 6) {
			const [pin, open, toSeq, fromSeq, orderKey, blockId] = value as unknown[];
			if (
				[pin, toSeq, fromSeq].every((n) => typeof n === "number" && Number.isSafeInteger(n)) &&
				(pin as number) >= 0 &&
				(toSeq as number) >= 0 &&
				(fromSeq as number) >= 0 &&
				(open === 0 || open === 1) &&
				typeof orderKey === "string" &&
				typeof blockId === "string" &&
				CURSOR_TEXT.test(orderKey) &&
				CURSOR_TEXT.test(blockId)
			) {
				return {
					pin: pin as number,
					open: open === 1,
					toSeq: toSeq as number,
					fromSeq: fromSeq as number,
					orderKey,
					blockId,
				};
			}
		}
	} catch {
		// Fall through to the validation error.
	}
	throw new ValidationError("Invalid cursor");
}

/**
 * The children a parent (`null`: the top level) had during `(after, upTo]` that differ between
 * its two ends, a page at a time, in no order to rely on. Only a child with `below` set needs
 * its own level looked at. All pages of one read see the space as it stood at the first (the
 * cursor carries that seq), so commits landing between pages neither repeat a child nor drop
 * one. `upTo` defaults to, and is capped at, the space's last commit.
 */
export async function readOutlineChangedChildren(
	space: OutlineSpaceRow,
	parentId: string | null,
	options: {
		after: number;
		upTo?: number;
		cursor?: string | null;
		limit?: number;
		store?: OutlineStore;
	},
): Promise<OutlineChangedChildrenResponse> {
	const store = options.store ?? outlineStore;
	const limit = clamp(
		options.limit,
		OUTLINE_SUBTREE_LIMITS.defaultChanged,
		OUTLINE_SUBTREE_LIMITS.maxChanged,
	);
	const cursor = options.cursor ? decodeChangedCursor(options.cursor) : null;
	const latest = cursor ? Math.min(cursor.pin, space.nextSeq - 1) : space.nextSeq - 1;
	const upTo = Math.min(options.upTo ?? latest, latest);
	for (const [name, seq] of [
		["after", options.after],
		["upTo", upTo],
	] as const) {
		if (!Number.isSafeInteger(seq) || seq < 0)
			throw new ValidationError(OUTLINE_TEXT.errors.badSeq(name));
	}
	return withOutlineHistory(async () => {
		const { rows, next } = await store.listChangedChildren(space.id, parentId, {
			after: options.after,
			upTo,
			cursor,
			limit,
		});
		return {
			spaceId: space.id,
			parentId,
			after: options.after,
			upTo,
			children: rows.map((row) => ({
				blockId: row.blockId,
				fromSeq: row.fromSeq,
				toSeq: row.toSeq,
				orderKey: row.orderKey,
				self: row.self,
				below: row.below,
			})),
			nextCursor: next ? encodeChangedCursor(next) : null,
		};
	});
}
