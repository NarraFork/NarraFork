/**
 * The contract of comparing two moments of a subtree (`subtree-diff.ts`) and of restoring a
 * subtree to an earlier one (`subtree-restore.ts`), written once and run against SQLite
 * (`store-contract.test.ts`) and PostgreSQL
 * (`tests/server/services/outline/pg-outline-store.test.ts`, `PG_INTEGRATION=1`).
 *
 * The reference is never the code under test: every expectation is computed from the space's
 * raw rows (`ctx.dump`): the version of each block valid at a seq, the tags open then, and the
 * subtree as those versions' parent links give it.
 *
 * MAIN-THREAD BUDGET: a page of a comparison or of a preview goes through a store that counts
 * the rows it hands out, and may not take more than `OUTLINE_DIFF_LIMITS.maxStoreRows`.
 */
import { expect } from "bun:test";
import {
	OUTLINE_DIFF_LIMITS,
	OUTLINE_RESTORE_LIMITS,
	type OutlineDiffEntry,
	type OutlineDiffField,
	type OutlineRestoreEntry,
	type OutlineRestoreResponse,
	type OutlineRestoreSkip,
} from "@shared/outline-restore-api";
import { setOutlineLiveBarrier } from "../live-barrier";
import { OUTLINE_LIMITS } from "../model";
import { lockOutlineTask } from "../pending";
import {
	OutlineRestoreConflictError,
	OutlineRestoreParentGoneError,
	OutlineRestoreRootError,
	OutlineRestoreTokenError,
} from "../restore-errors";
import {
	OUTLINE_HISTORY_LIMITS,
	type OutlineBlockRow,
	OutlineChangeMarksLimitError,
	type OutlineSpaceRow,
	type OutlineStore,
	type OutlineVersionRow,
} from "../store/port";
import { readOutlineSubtreeDiff } from "../subtree-diff";
import { OutlineHistoryNotAvailableError } from "../subtree-errors";
import {
	dropRefused,
	moveOutlineBlockBack,
	type OutlineRestoreOptions,
	outlineRestoreMarker,
	previewOutlineRestore,
	type RestoreBatchEntry,
	restoreOutlineSubtree,
} from "../subtree-restore";
import { sameTaskJson } from "../task-json";
import { type OutlineOp, type OutlineWriteResult, writeOutline } from "../write";
import {
	type ContractCase,
	checkChangeMarks,
	checkPlacements,
	checkSpaceInvariants,
	type OutlineContractContext,
	randomizedHistory,
	type SpaceDump,
} from "./contract";

const NOW = "2026-10-26T00:00:00.000Z";
const ACTOR = { kind: "human" as const, id: "user-restore-contract" };
const WRITER = { actor: ACTOR, responsibleUserId: null };

async function personalSpace(ctx: OutlineContractContext): Promise<OutlineSpaceRow> {
	return ctx.store.ensureSpace({ kind: "personal", ownerUserId: await ctx.seedUser() }, NOW);
}

function write(
	ctx: OutlineContractContext,
	space: OutlineSpaceRow,
	ops: OutlineOp[],
): Promise<OutlineWriteResult> {
	return writeOutline(
		{ spaceId: space.id, ops, actor: ACTOR, responsibleUserId: null },
		{ store: ctx.store },
	);
}

async function fresh(ctx: OutlineContractContext, space: OutlineSpaceRow) {
	return (await ctx.store.getSpace(space.id)) as OutlineSpaceRow;
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A store that counts every row its reads return. */
function counting(store: OutlineStore): { store: OutlineStore; take(): number } {
	let rows = 0;
	const size = (value: unknown): number => {
		if (Array.isArray(value)) return value.length;
		if (value instanceof Map) return value.size;
		if (value && typeof value === "object" && Array.isArray((value as { rows?: unknown }).rows))
			return (value as { rows: unknown[] }).rows.length;
		return value == null ? 0 : 1;
	};
	const counted = new Proxy(store, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return async (...args: unknown[]) => {
				const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
				rows += size(result);
				return result;
			};
		},
	});
	return {
		store: counted,
		take() {
			const taken = rows;
			rows = 0;
			return taken;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// The reference: a space at a seq, from its raw rows
// ─────────────────────────────────────────────────────────────────────────────

interface StateAt {
	/** Live blocks at the seq. */
	live: Map<string, OutlineVersionRow>;
	/** Tombstones valid at the seq. */
	tombs: Map<string, OutlineVersionRow>;
	tags: Map<string, string>;
	dump: SpaceDump;
	seq: number;
}

function stateAt(dump: SpaceDump, seq: number): StateAt {
	const live = new Map<string, OutlineVersionRow>();
	const tombs = new Map<string, OutlineVersionRow>();
	for (const v of dump.versions) {
		if (v.fromSeq <= seq && (v.toSeq === null || seq < v.toSeq))
			(v.deleted ? tombs : live).set(v.blockId, v);
	}
	const lists = new Map<string, string[]>();
	for (const link of dump.links) {
		if (link.kind !== "tag" || link.fromSeq > seq || (link.toSeq !== null && seq >= link.toSeq))
			continue;
		const list = lists.get(link.fromBlockId);
		if (list) list.push(link.targetRef);
		else lists.set(link.fromBlockId, [link.targetRef]);
	}
	const tags = new Map<string, string>();
	for (const [id, list] of lists) tags.set(id, list.sort().join("\n"));
	return { live, tombs, tags, dump, seq };
}

/** The blocks under `rootId` (null: every live block) in a state, the root left out. */
function under(state: StateAt, rootId: string | null): Set<string> {
	if (rootId === null) return new Set(state.live.keys());
	const memo = new Map<string, boolean>([[rootId, true]]);
	const inside = (id: string): boolean => {
		const known = memo.get(id);
		if (known !== undefined) return known;
		const parentId = state.live.get(id)?.parentId ?? null;
		const answer = parentId === null ? false : state.live.has(parentId) && inside(parentId);
		memo.set(id, answer);
		return answer;
	};
	const out = new Set<string>();
	for (const id of state.live.keys()) if (id !== rootId && inside(id)) out.add(id);
	return out;
}

function fieldsBetween(
	before: StateAt,
	after: StateAt,
	id: string,
	placement: boolean,
): OutlineDiffField[] {
	const a = before.live.get(id) as OutlineVersionRow;
	const b = after.live.get(id) as OutlineVersionRow;
	const fields: OutlineDiffField[] = [];
	if (placement) {
		if (a.parentId !== b.parentId) fields.push("parent");
		else if (a.orderKey !== b.orderKey) fields.push("order");
	}
	if (a.contentHash !== b.contentHash) fields.push("text");
	if (!sameTaskJson(a.taskJson, b.taskJson)) fields.push("task");
	if (JSON.stringify(a.askJson ?? null) !== JSON.stringify(b.askJson ?? null))
		fields.push("question");
	if (a.alias !== b.alias) fields.push("alias");
	if ((before.tags.get(id) ?? "") !== (after.tags.get(id) ?? "")) fields.push("tags");
	return fields;
}

interface Expected {
	entries: Map<string, string>;
	thenSet: Set<string>;
	nowSet: Set<string>;
	/**
	 * Blocks under the root then that are not under it now: live elsewhere, or deleted after
	 * they had left it (owner rule D58: not pulled back, not touched).
	 */
	away: Set<string>;
	/** Blocks under the root then, deleted while under it. */
	removed: Set<string>;
	/** Of `away`, the deleted ones. */
	deletedSince: Set<string>;
}

/** What a comparison must list, by brute force over two states. */
function expectedDiff(before: StateAt, after: StateAt, rootId: string | null): Expected {
	const thenSet = under(before, rootId);
	const nowSet = under(after, rootId);
	const entries = new Map<string, string>();
	const away = new Set<string>();
	const removed = new Set<string>();
	const deletedSince = new Set<string>();
	if (rootId !== null) {
		const fields = fieldsBetween(before, after, rootId, false);
		if (fields.length > 0) entries.set(rootId, `changed:${fields.join(",")}`);
	}
	// Where each block of then that is deleted at `after` sat just before it was deleted.
	const lastPlace = new Map<string, { under: boolean; parentId: string | null }>();
	for (const id of thenSet) {
		if (after.live.has(id) || !after.tombs.has(id)) continue;
		// Deleted when its last live version ended (later tombstones may follow it).
		let deletedAt = 0;
		for (const v of before.dump.versions) {
			if (v.blockId === id && !v.deleted && v.toSeq !== null && v.toSeq <= after.seq)
				deletedAt = Math.max(deletedAt, v.toSeq);
		}
		const prior = stateAt(before.dump, deletedAt - 1);
		lastPlace.set(id, {
			under: under(prior, rootId).has(id),
			parentId: prior.live.get(id)?.parentId ?? null,
		});
	}
	for (const id of thenSet) if (lastPlace.get(id)?.under) removed.add(id);
	/** Whether a block of then is there to be put back under (the walk's `then` frames). */
	const there = new Map<string | null, boolean>([[rootId, true]]);
	const isThere = (id: string | null): boolean => {
		const known = there.get(id);
		if (known !== undefined) return known;
		const answer =
			id !== null &&
			(nowSet.has(id) || (removed.has(id) && isThere(before.live.get(id)?.parentId ?? null)));
		there.set(id, answer);
		return answer;
	};
	for (const id of thenSet) {
		if (!after.live.has(id)) {
			if (removed.has(id)) {
				entries.set(id, "removed:");
				continue;
			}
			// Left the subtree, then deleted: moved away (listed unless it merely followed a block
			// that moved away), never removed.
			away.add(id);
			deletedSince.add(id);
			const parentThen = before.live.get(id)?.parentId ?? null;
			if (isThere(parentThen) || lastPlace.get(id)?.parentId !== parentThen)
				entries.set(id, "moved-away:");
		} else if (nowSet.has(id)) {
			const fields = fieldsBetween(before, after, id, true);
			if (fields.length > 0) entries.set(id, `changed:${fields.join(",")}`);
		} else {
			away.add(id);
			if (after.live.get(id)?.parentId !== before.live.get(id)?.parentId)
				entries.set(id, "moved-away:");
		}
	}
	for (const id of nowSet) {
		if (thenSet.has(id)) continue;
		// Reached from the subtree's own blocks through blocks added since only.
		let reached = true;
		let parentId = after.live.get(id)?.parentId ?? null;
		while (parentId !== null && parentId !== rootId && !thenSet.has(parentId)) {
			if (before.live.has(parentId)) {
				reached = false;
				break;
			}
			parentId = after.live.get(parentId)?.parentId ?? null;
		}
		if (reached) entries.set(id, before.live.has(id) ? "moved-in:" : "added:");
	}
	return { entries, thenSet, nowSet, away, removed, deletedSince };
}

async function wholeDiff(
	ctx: OutlineContractContext,
	space: OutlineSpaceRow,
	rootId: string | null,
	thenSeq: number,
	to: number | undefined,
	limit: number,
): Promise<{ entries: OutlineDiffEntry[]; pages: number }> {
	const counter = counting(ctx.store);
	const entries: OutlineDiffEntry[] = [];
	let cursor: string | null = null;
	let pages = 0;
	do {
		const page = await readOutlineSubtreeDiff({
			space,
			rootId,
			thenSeq,
			to,
			cursor,
			limit,
			store: counter.store,
		});
		expect(counter.take()).toBeLessThanOrEqual(OUTLINE_DIFF_LIMITS.maxStoreRows);
		expect(page.entries.length).toBeLessThanOrEqual(Math.max(limit, OUTLINE_DIFF_LIMITS.levelRows));
		entries.push(...page.entries);
		cursor = page.nextCursor;
		expect(++pages).toBeLessThan(10_000);
	} while (cursor);
	return { entries, pages };
}

function listed(entries: readonly OutlineDiffEntry[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const entry of entries) {
		// A block is listed once, whatever the paging.
		expect(out.has(entry.blockId)).toBe(false);
		out.set(entry.blockId, `${entry.kind}:${[...entry.fields].join(",")}`);
	}
	return out;
}

const sorted = (map: Map<string, string>) => [...map].sort(([a], [b]) => (a < b ? -1 : 1));

/** Roots worth comparing: blocks live at both seqs with something under them at one. */
function candidateRoots(before: StateAt, after: StateAt, rnd: () => number, max: number): string[] {
	const parents = new Set<string>();
	for (const state of [before, after])
		for (const v of state.live.values()) if (v.parentId !== null) parents.add(v.parentId);
	const both = [...parents].filter((id) => before.live.has(id) && after.live.has(id)).sort();
	const out: string[] = [];
	while (both.length > 0 && out.length < max)
		out.push(both.splice(Math.floor(rnd() * both.length), 1)[0] as string);
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Restore: run one and check it against the reference
// ─────────────────────────────────────────────────────────────────────────────

async function wholePreview(
	ctx: OutlineContractContext,
	space: OutlineSpaceRow,
	rootId: string | null,
	thenSeq: number,
): Promise<{ token: string; entries: OutlineRestoreEntry[]; skipped: OutlineRestoreSkip[] }> {
	const counter = counting(ctx.store);
	const entries: OutlineRestoreEntry[] = [];
	const skipped: OutlineRestoreSkip[] = [];
	let token: string | null = null;
	let cursor: string | null = null;
	do {
		const page = await previewOutlineRestore({
			space,
			rootId,
			thenSeq,
			token,
			cursor,
			limit: OUTLINE_DIFF_LIMITS.levelRows,
			userId: ACTOR.id,
			store: counter.store,
		});
		expect(counter.take()).toBeLessThanOrEqual(OUTLINE_DIFF_LIMITS.maxStoreRows);
		if (token) expect(page.token).toBe(token);
		token = page.token;
		entries.push(...page.entries);
		skipped.push(...page.skipped);
		cursor = page.nextCursor;
	} while (cursor);
	return { token: token as string, entries, skipped };
}

interface Ran {
	calls: OutlineRestoreResponse[];
	commits: Array<{ id: string; seq: number }>;
	skipped: Map<string, string>;
}

async function runRestore(
	ctx: OutlineContractContext,
	space: OutlineSpaceRow,
	token: string,
	options: OutlineRestoreOptions = {},
	useCursor = true,
): Promise<Ran> {
	const calls: OutlineRestoreResponse[] = [];
	const skipped = new Map<string, string>();
	let cursor: string | null = null;
	for (;;) {
		const result = await restoreOutlineSubtree(
			{ ...WRITER, space, token, cursor: useCursor ? cursor : null },
			{ store: ctx.store, ...options },
		);
		calls.push(result);
		for (const skip of result.skipped) skipped.set(skip.blockId, skip.reason);
		expect(calls.length).toBeLessThan(2000);
		if (result.done) break;
		expect(result.cursor).not.toBeNull();
		cursor = result.cursor;
	}
	return { calls, commits: calls.flatMap((call) => call.commits), skipped };
}

/** Every commit of a restore is a compensating commit carrying its id, within the limits. */
function checkCommits(dump: SpaceDump, commits: Array<{ id: string; seq: number }>, id: string) {
	const mine = new Set(commits.map((commit) => commit.id));
	for (const commit of dump.commits) {
		if (!mine.has(commit.id)) continue;
		expect(commit.kind).toBe("revert");
		expect(commit.toolCallId).toBe(outlineRestoreMarker(id));
	}
	const rows = new Map<string, number>();
	for (const v of dump.versions)
		if (mine.has(v.commitId)) rows.set(v.commitId, (rows.get(v.commitId) ?? 0) + 1);
	for (const count of rows.values())
		expect(count).toBeLessThanOrEqual(OUTLINE_LIMITS.maxRowsTouched);
	const marks = new Map<number, number>();
	const seqs = new Set(commits.map((commit) => commit.seq));
	for (const mark of dump.marks)
		if (seqs.has(mark.seq)) marks.set(mark.seq, (marks.get(mark.seq) ?? 0) + 1);
	for (const count of marks.values())
		expect(count).toBeLessThanOrEqual(OUTLINE_HISTORY_LIMITS.maxChangeMarks);
}

const openVersion = (dump: SpaceDump) =>
	new Map(dump.versions.filter((v) => v.toSeq === null).map((v) => [v.blockId, v]));

/**
 * What D58 says of a finished restore, against the raw rows before and after it:
 *   - every block under the root then that had not moved away is back: live, under its parent
 *     of then at its order key, with its text and fields (a block whose chain of parents of
 *     then passes through one that moved away keeps its place);
 *   - nothing that was not under the root then is under it now, except what it said it kept;
 *   - blocks that moved away (deleted since or not), and everything that was under the root at
 *     neither moment, have the very version they had; no block outside the root at `then` is
 *     deleted or changed, except a block that moved in, which only goes back to its place.
 * A block the restore said it left alone is exempt from what its reason covers, and every
 * reason is checked against the rows here, never taken from the restore's word.
 */
function checkRestored(
	before: SpaceDump,
	after: SpaceDump,
	rootId: string | null,
	thenSeq: number,
	pin: number,
	skipped: Map<string, string>,
): void {
	const then = stateAt(before, thenSeq);
	const atPin = stateAt(before, pin);
	const now = stateAt(after, after.space.nextSeq - 1);
	const expected = expectedDiff(then, atPin, rootId);
	const nowSet = under(now, rootId);
	const openBefore = openVersion(before);
	const openAfter = openVersion(after);

	/**
	 * Whether a block of then is there to be put back under: the root, or a block of the subtree
	 * that is still under the root, or a removed one whose own parent of then is there.
	 */
	const there = new Map<string | null, boolean>([[rootId, true]]);
	const isThere = (id: string | null): boolean => {
		const known = there.get(id);
		if (known !== undefined) return known;
		const answer =
			id !== null &&
			expected.thenSet.has(id) &&
			(expected.nowSet.has(id) ||
				(expected.removed.has(id) && isThere(then.live.get(id)?.parentId ?? null)));
		there.set(id, answer);
		return answer;
	};
	const isAnchored = (id: string) => isThere(then.live.get(id)?.parentId ?? null);
	/** `ancestor` is `id` or above it in the tree now. */
	const isAbove = (ancestor: string, id: string | null): boolean => {
		for (let at = id, depth = 0; at !== null && depth < 2000; depth++) {
			if (at === ancestor) return true;
			at = now.live.get(at)?.parentId ?? null;
		}
		return false;
	};
	const locked = (id: string) =>
		[then, atPin, now].some((state) => Boolean(state.live.get(id)?.taskJson?.lock));
	/** The independent check of a reason the restore gave for leaving a block of then alone. */
	const checkLeft = (id: string, reason: string, depth = 0): void => {
		const parentId = then.live.get(id)?.parentId ?? null;
		if (reason === "lock-kept") expect(locked(id)).toBe(true);
		else if (reason === "refused") {
			// The only refusal these histories can meet: going back would put it under itself.
			expect(parentId !== null && isAbove(id, parentId)).toBe(true);
		} else if (reason === "parent-refused") {
			expect(parentId).not.toBeNull();
			const parentReason = skipped.get(parentId as string);
			expect(["refused", "parent-refused", "lock-kept"]).toContain(parentReason as string);
			if (depth < 50) checkLeft(parentId as string, parentReason as string, depth + 1);
		} else throw new Error(`unexpected reason ${reason} for ${id}`);
	};

	for (const id of expected.thenSet) {
		if (expected.away.has(id)) {
			// Moved away, or deleted after it had: not pulled back, not touched.
			expect(openAfter.get(id)?.fromSeq).toBe(openBefore.get(id)?.fromSeq as number);
			continue;
		}
		const reason = skipped.get(id);
		const was = then.live.get(id) as OutlineVersionRow;
		const is = now.live.get(id);
		if (!isAnchored(id)) {
			// Its parent of then is not there to go back under: it stays where it was, deleted
			// or not; a live one still gets its text back.
			if (!atPin.live.has(id)) expect(is).toBeUndefined();
			else {
				expect(reason === undefined || reason === "parent-moved-away").toBe(true);
				expect(is?.contentHash).toBe(was.contentHash);
				expect(is?.parentId).toBe(atPin.live.get(id)?.parentId as string | null);
			}
			continue;
		}
		if (reason === "refused" || reason === "lock-kept" || reason === "parent-refused") {
			// (A later pass may have done it after all.)
			const done =
				is?.parentId === was.parentId &&
				is.orderKey === was.orderKey &&
				is.contentHash === was.contentHash &&
				sameTaskJson(is.taskJson, was.taskJson) &&
				(now.tags.get(id) ?? "") === (then.tags.get(id) ?? "");
			if (!done) checkLeft(id, reason);
			continue;
		}
		expect(reason === undefined || reason === "place-taken").toBe(true);
		expect(is).toBeDefined();
		if (!is) continue;
		expect(nowSet.has(id)).toBe(true);
		expect(is.parentId).toBe(was.parentId);
		// Its exact order key and its alias, unless another live block holds them now (one the
		// restore does not touch): then it sits next to that one, or goes without the alias.
		if (is.orderKey !== was.orderKey) {
			expect(reason).toBe("place-taken");
			expect(
				[...now.live.values()].some(
					(v) => v.blockId !== id && v.parentId === was.parentId && v.orderKey === was.orderKey,
				),
			).toBe(true);
		}
		if (is.alias !== was.alias) {
			expect(is.alias).toBeNull();
			expect([...now.live.values()].some((v) => v.alias === was.alias)).toBe(true);
		}
		expect(is.contentHash).toBe(was.contentHash);
		expect(is.content).toBe(was.content);
		expect(sameTaskJson(is.taskJson, was.taskJson)).toBe(true);
		expect(JSON.stringify(is.askJson ?? null)).toBe(JSON.stringify(was.askJson ?? null));
		expect(now.tags.get(id) ?? "").toBe(then.tags.get(id) ?? "");
	}
	if (rootId !== null) {
		const was = then.live.get(rootId) as OutlineVersionRow;
		const is = now.live.get(rootId) as OutlineVersionRow;
		const reason = skipped.get(rootId);
		if (reason !== undefined && reason !== "place-taken") checkLeft(rootId, reason);
		else {
			expect(is.contentHash).toBe(was.contentHash);
			expect(sameTaskJson(is.taskJson, was.taskJson)).toBe(true);
			expect(now.tags.get(rootId) ?? "").toBe(then.tags.get(rootId) ?? "");
			// Its alias of then, unless another live block holds it now.
			if (is.alias !== was.alias) {
				expect(reason).toBe("place-taken");
				expect(is.alias).toBeNull();
				expect([...now.live.values()].some((v) => v.alias === was.alias)).toBe(true);
			}
		}
		// Where the root sits is not part of its subtree.
		expect(is.parentId).toBe(atPin.live.get(rootId)?.parentId as string | null);
		expect(is.orderKey).toBe(atPin.live.get(rootId)?.orderKey as string);
	}

	// Nothing foreign is left under the root without a reason: a block that moved in stays
	// only when its parent of then is deleted (or the move would put it under itself), and a
	// block added since only while it holds a block that cannot leave.
	const childrenNow = new Map<string, string[]>();
	for (const v of now.live.values()) {
		if (v.parentId === null) continue;
		const list = childrenNow.get(v.parentId);
		if (list) list.push(v.blockId);
		else childrenNow.set(v.parentId, [v.blockId]);
	}
	/** A block that was in the tree then and cannot leave where it is now. */
	const stuck = (id: string): boolean => {
		const parentId = then.live.get(id)?.parentId ?? null;
		if (expected.thenSet.has(id)) {
			const reason = skipped.get(id);
			if (reason === "refused" || reason === "lock-kept" || reason === "parent-refused") {
				checkLeft(id, reason);
				return true;
			}
			return !isAnchored(id);
		}
		return (
			(parentId !== null && !now.live.has(parentId)) ||
			(parentId !== null && isAbove(id, parentId)) ||
			(skipped.get(id) === "lock-kept" && locked(id))
		);
	};
	const holdsOld = (id: string): boolean =>
		(childrenNow.get(id) ?? []).some((child) =>
			then.live.has(child) ? stuck(child) : holdsOld(child),
		);
	for (const id of nowSet) {
		if (expected.thenSet.has(id)) continue;
		const parentId = now.live.get(id)?.parentId ?? null;
		// Judged at the topmost foreign block: what is under it stays or goes with it.
		if (parentId !== rootId && !expected.thenSet.has(parentId as string)) continue;
		const was = then.live.get(id);
		const reason = skipped.get(id);
		if (was) {
			if (reason === "refused") {
				expect(was.parentId !== null && isAbove(id, was.parentId)).toBe(true);
				continue;
			}
			if (reason === "lock-kept") {
				expect(locked(id)).toBe(true);
				continue;
			}
			expect(reason).toBe("parent-gone");
			expect(was.parentId !== null && !now.live.has(was.parentId)).toBe(true);
		} else if (reason === "lock-kept") {
			expect(locked(id) || [...(childrenNow.get(id) ?? [])].some(locked)).toBe(true);
		} else {
			expect(reason).toBe("holds-kept");
			expect(holdsOld(id)).toBe(true);
		}
	}

	// No block that was outside the root at `then` is deleted or changed by the restore: one
	// that moved in only goes back to its parent and order key of then.
	for (const block of before.blocks) {
		const id = block.id;
		if (id === rootId || expected.thenSet.has(id) || !then.live.has(id)) continue;
		const a = openBefore.get(id) as OutlineVersionRow;
		const b = openAfter.get(id) as OutlineVersionRow;
		if (b.fromSeq === a.fromSeq) continue;
		// (A move to another page gives what is under the block versions of no content.)
		expect(b.deleted).toBe(a.deleted);
		expect(b.contentHash).toBe(a.contentHash);
		if (b.parentId !== a.parentId || b.orderKey !== a.orderKey) {
			expect(expected.entries.get(id)).toBe("moved-in:");
			expect(b.parentId).toBe((then.live.get(id) as OutlineVersionRow).parentId);
		}
		expect(sameTaskJson(b.taskJson, a.taskJson)).toBe(true);
		expect(b.alias).toBe(a.alias);
		expect(now.tags.get(id) ?? "").toBe(atPin.tags.get(id) ?? "");
	}
	// Outside the subtree of both moments nothing has a new version.
	for (const block of before.blocks) {
		if (block.id === rootId || expected.thenSet.has(block.id) || expected.nowSet.has(block.id))
			continue;
		expect(openAfter.get(block.id)?.fromSeq).toBe(openBefore.get(block.id)?.fromSeq as number);
	}
	checkSpaceInvariants(after);
	checkPlacements(after);
	checkChangeMarks(after);
}

/** Preview, restore in small calls, and check the outcome; returns what the checks used. */
async function restoreAndCheck(
	ctx: OutlineContractContext,
	spaceRow: OutlineSpaceRow,
	rootId: string | null,
	thenSeq: number,
	options: OutlineRestoreOptions = {},
	interruptAfter?: number,
): Promise<{ ran: Ran; preview: Awaited<ReturnType<typeof wholePreview>>; pin: number }> {
	const space = await fresh(ctx, spaceRow);
	const pin = space.nextSeq - 1;
	const before = await ctx.dump(space.id);
	const expected = expectedDiff(stateAt(before, thenSeq), stateAt(before, pin), rootId);
	const preview = await wholePreview(ctx, space, rootId, thenSeq);

	// The preview is the comparison, each block with what happens to it; blocks that moved
	// away are in it, listed only.
	expect(sorted(listed(preview.entries))).toEqual(sorted(expected.entries));
	for (const entry of preview.entries) {
		if (entry.kind === "added") {
			expect(["delete", "delete-unless-holds"]).toContain(entry.action);
			if (entry.skip !== undefined) {
				expect(entry.skip).toBe("holds-kept");
				expect(entry.action).toBe("delete");
			}
			continue;
		}
		expect(entry.action).toBe(
			(
				{
					removed: "restore",
					"moved-in": "move-out",
					"moved-away": "none",
					changed: "put-back",
				} as const
			)[entry.kind],
		);
		expect(entry.deletedSince === true).toBe(expected.deletedSince.has(entry.blockId));
		if (entry.kind === "moved-in") {
			const below = under(stateAt(before, pin), entry.blockId).size;
			expect(entry.carries).toBe(Math.min(below, OUTLINE_DIFF_LIMITS.carryCount));
			expect(entry.carriesMore).toBe(below > OUTLINE_DIFF_LIMITS.carryCount);
		}
	}

	let ran: Ran;
	if (interruptAfter !== undefined) {
		// A restore that dies after some commits, then is confirmed again without a cursor.
		let seen = 0;
		const died = await restoreOutlineSubtree(
			{ ...WRITER, space, token: preview.token },
			{
				store: ctx.store,
				...options,
				afterCommit: () => {
					if (++seen === interruptAfter) throw new Error("interrupted");
				},
			},
		).catch((error: unknown) => error);
		if (seen >= interruptAfter) expect((died as Error).message).toBe("interrupted");
		ran = await runRestore(ctx, space, preview.token, options, false);
		const marker = outlineRestoreMarker(ran.calls[0]?.restoreId as string);
		ran.commits = (await ctx.dump(space.id)).commits
			.filter((commit) => commit.toolCallId === marker)
			.map((commit) => ({ id: commit.id, seq: commit.seq }));
	} else {
		ran = await runRestore(ctx, space, preview.token, options);
	}
	const after = await ctx.dump(space.id);
	checkRestored(before, after, rootId, thenSeq, pin, ran.skipped);
	// What the preview said of each added block is what happened to it: deleted when it said
	// "delete", kept (and said so) when it said it holds something that stays, either one when
	// it could not know.
	const deletedNow = new Set(after.blocks.filter((block) => block.deleted).map((b) => b.id));
	for (const entry of preview.entries) {
		if (entry.kind !== "added") continue;
		const reason = ran.skipped.get(entry.blockId);
		if (entry.skip === "holds-kept") {
			expect(deletedNow.has(entry.blockId)).toBe(false);
			expect(reason).toBe("holds-kept");
		} else if (entry.action === "delete" && reason !== "lock-kept" && reason !== "refused")
			expect(deletedNow.has(entry.blockId)).toBe(true);
		else if (!deletedNow.has(entry.blockId))
			expect(["holds-kept", "lock-kept", "refused"]).toContain(reason as string);
	}
	const restoreId = ran.calls[0]?.restoreId as string;
	checkCommits(after, ran.commits, restoreId);
	// Nothing but the restore wrote.
	expect(after.space.nextSeq - 1 - pin).toBe(ran.commits.length);

	// Confirming again applies nothing twice.
	// (A walk of a large subtree may take more than one call to find that out.)
	const again = await runRestore(ctx, space, preview.token);
	expect(again.commits).toEqual([]);
	return { ran, preview, pin };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cases
// ─────────────────────────────────────────────────────────────────────────────

/** A small fixed tree: `top` with `a` (children a1, a2), `b` (child b1) and `other` beside it. */
async function fixture(ctx: OutlineContractContext) {
	const space = await personalSpace(ctx);
	const made = await write(ctx, space, [
		{ op: "insert", tempId: "top", parent: null, content: "top" },
		{ op: "insert", tempId: "a", parent: { tempId: "top" }, content: "a" },
		{ op: "insert", tempId: "a1", parent: { tempId: "a" }, content: "a1" },
		{ op: "insert", tempId: "a2", parent: { tempId: "a" }, content: "a2" },
		{ op: "insert", tempId: "b", parent: { tempId: "top" }, content: "b" },
		{ op: "insert", tempId: "b1", parent: { tempId: "b" }, content: "b1" },
		{ op: "insert", tempId: "other", parent: null, content: "other" },
		{ op: "insert", tempId: "o1", parent: { tempId: "other" }, content: "o1" },
	]);
	const [top, a, a1, a2, b, b1, other, o1] = made.results.map((r) => r.blockId) as [
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
	];
	return {
		space,
		thenSeq: (made.commit as { seq: number }).seq,
		ids: { top, a, a1, a2, b, b1, other, o1 },
	};
}

/** A random history, then a restore of the space or of one of its subtrees to a seq in it. */
export async function restoreRandomHistory(
	ctx: OutlineContractContext,
	seed: number,
	limits: OutlineRestoreOptions["limits"] = { maxBlocksPerCommit: 6, maxCommitsPerCall: 2 },
): Promise<Ran> {
	const { space: made, snapshots } = await randomizedHistory(ctx, seed);
	const space = await fresh(ctx, made);
	const dump = await ctx.dump(space.id);
	const rnd = mulberry32(seed * 104729);
	const seqs = [...snapshots.keys()].sort((x, y) => x - y);
	const thenSeq = seqs[Math.floor(seqs.length * (0.2 + rnd() * 0.5))] as number;
	const before = stateAt(dump, thenSeq);
	const after = stateAt(dump, space.nextSeq - 1);
	// The whole space for some seeds, a block with a subtree for the others.
	const rootId = seed % 3 === 0 ? null : (candidateRoots(before, after, rnd, 1)[0] ?? null);
	const { ran } = await restoreAndCheck(ctx, space, rootId, thenSeq, { limits });
	return ran;
}

const blockOf = (dump: SpaceDump, id: string) =>
	dump.blocks.find((block) => block.id === id) as OutlineBlockRow;

export const OUTLINE_RESTORE_CONTRACT: ContractCase[] = [
	{
		name: "a comparison of two seqs lists exactly what a brute-force comparison of the rows finds",
		async run(ctx) {
			let compared = 0;
			let paged = 0;
			for (const seed of [11, 12, 13, 14]) {
				const { space: made, snapshots } = await randomizedHistory(ctx, seed);
				const space = await fresh(ctx, made);
				const dump = await ctx.dump(space.id);
				const rnd = mulberry32(seed * 7919);
				const seqs = [...snapshots.keys()].sort((x, y) => x - y);
				const latest = space.nextSeq - 1;
				for (let round = 0; round < 6; round++) {
					const thenSeq = seqs[Math.floor(rnd() * seqs.length * 0.7)] as number;
					const later = seqs.filter((seq) => seq > thenSeq);
					// Against now, and against a seq in between.
					const to =
						round % 2 === 0 || later.length === 0
							? latest
							: (later[Math.floor(rnd() * later.length)] as number);
					const before = stateAt(dump, thenSeq);
					const after = stateAt(dump, to);
					for (const rootId of [null, ...candidateRoots(before, after, rnd, 4)]) {
						const expected = expectedDiff(before, after, rootId);
						const { entries, pages } = await wholeDiff(
							ctx,
							space,
							rootId,
							thenSeq,
							to === latest ? undefined : to,
							OUTLINE_DIFF_LIMITS.levelRows,
						);
						expect(sorted(listed(entries))).toEqual(sorted(expected.entries));
						for (const entry of entries) {
							// Each side is the block as the rows have it at that seq, an excerpt only.
							const was = before.live.get(entry.blockId);
							const is = after.live.get(entry.blockId);
							expect(entry.before === null).toBe(was === undefined);
							expect(entry.after === null).toBe(is === undefined);
							if (entry.before && was) {
								expect(entry.before.parentId).toBe(was.parentId);
								expect(entry.before.orderKey).toBe(was.orderKey);
								expect((was.content ?? "").startsWith(entry.before.excerpt)).toBe(true);
							}
							if (entry.after && is) expect(entry.after.orderKey).toBe(is.orderKey);
						}
						compared++;
						if (pages > 1) paged++;
					}
				}
			}
			expect(compared).toBeGreaterThan(40);
			expect(paged).toBeGreaterThan(0);
		},
	},
	{
		name: "an entry carries an excerpt, never a whole body, and a page stays within the row budget",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const long = `long ${"x".repeat(6000)}`;
			const made = await write(ctx, space, [
				{ op: "insert", tempId: "top", parent: null, content: "top" },
				...Array.from(
					{ length: 150 },
					(_, i): OutlineOp => ({
						op: "insert",
						parent: { tempId: "top" },
						content: `row ${i}`,
					}),
				),
			]);
			const thenSeq = (made.commit as { seq: number }).seq;
			const ids = made.results.map((r) => r.blockId);
			await write(
				ctx,
				space,
				ids
					.slice(1)
					.map(
						(id, i): OutlineOp => ({
							op: "update",
							block: { id },
							content: `${long} ${i}`,
						}),
					)
					.slice(0, 20),
			);
			await write(
				ctx,
				space,
				ids.slice(21).map(
					(id, i): OutlineOp => ({
						op: "update",
						block: { id },
						content: `changed ${i}`,
					}),
				),
			);
			const now = await fresh(ctx, space);
			const { entries, pages } = await wholeDiff(
				ctx,
				now,
				ids[0] as string,
				thenSeq,
				undefined,
				40,
			);
			expect(entries).toHaveLength(150);
			expect(pages).toBeGreaterThan(2);
			for (const entry of entries) {
				expect(entry.after?.excerpt.length).toBeLessThanOrEqual(OUTLINE_DIFF_LIMITS.excerptChars);
				expect(entry.fields).toEqual(["text"]);
			}
			expect(entries.filter((entry) => entry.after?.truncated)).toHaveLength(20);
			expect(JSON.stringify(entries).length).toBeLessThan(150 * 1200);
		},
	},
	{
		name: "a comparison is refused before the history floor, while the space is prepared, and for a root that was not there",
		async run(ctx) {
			const { space, thenSeq, ids } = await fixture(ctx);
			const later = await write(ctx, space, [
				{ op: "insert", parent: { id: ids.top }, content: "new" },
			]);
			const newId = later.results[0]?.blockId as string;
			const now = await fresh(ctx, space);
			await expect(
				readOutlineSubtreeDiff({ space: now, rootId: newId, thenSeq, store: ctx.store }),
			).rejects.toBeInstanceOf(OutlineRestoreRootError);
			await expect(
				previewOutlineRestore({
					space: now,
					rootId: newId,
					thenSeq,
					userId: ACTOR.id,
					store: ctx.store,
				}),
			).rejects.toBeInstanceOf(OutlineRestoreRootError);
			// A cursor of another comparison, or one nobody sealed, is refused.
			const page = await readOutlineSubtreeDiff({
				space: now,
				rootId: null,
				thenSeq: 0,
				store: ctx.store,
			});
			expect(page.nextCursor).toBeNull();
			await expect(
				readOutlineSubtreeDiff({
					space: now,
					rootId: null,
					thenSeq: 0,
					cursor: "WzFd.forged",
					store: ctx.store,
				}),
			).rejects.toBeInstanceOf(OutlineRestoreTokenError);

			await ctx.forgetHistory(space.id);
			const notReady = await readOutlineSubtreeDiff({
				space: now,
				rootId: null,
				thenSeq,
				store: ctx.store,
			}).catch((error: unknown) => error);
			expect(notReady).toBeInstanceOf(OutlineHistoryNotAvailableError);
			expect((notReady as OutlineHistoryNotAvailableError).details.reason).toBe("not-ready");
			while ((await ctx.store.backfillEdges(space.id, { afterSid: null, limit: 2000 })).nextSid);
			const floor = await ctx.store.finishEdgeBackfill(space.id);
			expect(floor).toBe(now.nextSeq - 1);
			for (const call of [
				() => readOutlineSubtreeDiff({ space: now, rootId: null, thenSeq, store: ctx.store }),
				() =>
					previewOutlineRestore({
						space: now,
						rootId: null,
						thenSeq,
						userId: ACTOR.id,
						store: ctx.store,
					}),
				() =>
					moveOutlineBlockBack(
						{ ...WRITER, space: now, blockId: ids.a1, thenSeq },
						{ store: ctx.store },
					),
			]) {
				const refused = await call().catch((error: unknown) => error);
				expect(refused).toBeInstanceOf(OutlineHistoryNotAvailableError);
				expect((refused as OutlineHistoryNotAvailableError).details).toEqual({
					reason: "before-floor",
					floorSeq: floor as number,
					seq: thenSeq,
				});
			}
		},
	},
	{
		name: "restoring a subtree puts back what was under it, deletes what was added, moves out what moved in, and lists what moved away (D58)",
		async run(ctx) {
			const { space, thenSeq, ids } = await fixture(ctx);
			const changed = await write(ctx, space, [
				{ op: "update", block: { id: ids.a1 }, content: "a1 edited", tags: ["Risk"] },
				{ op: "delete", block: { id: ids.b } },
				{
					op: "insert",
					tempId: "n",
					parent: { id: ids.top },
					content: "new",
					position: { first: true },
				},
				{ op: "insert", parent: { tempId: "n" }, content: "new child" },
				{ op: "move", block: { id: ids.o1 }, parent: { id: ids.a }, position: { first: true } },
				{ op: "move", block: { id: ids.a2 }, parent: { id: ids.other } },
				{ op: "setTask", block: { id: ids.a }, task: { status: "todo" } },
				{ op: "update", block: { id: ids.other }, content: "other edited" },
			]);
			const added = changed.results[2]?.blockId as string;
			const { ran, preview } = await restoreAndCheck(ctx, space, ids.top, thenSeq);
			const by = new Map(preview.entries.map((entry) => [entry.blockId, entry]));
			expect(by.get(ids.a2)).toMatchObject({
				kind: "moved-away",
				action: "none",
				canMoveBack: true,
			});
			expect(by.get(ids.o1)).toMatchObject({ kind: "moved-in", action: "move-out" });
			expect(by.get(added)).toMatchObject({ kind: "added", action: "delete" });
			expect(by.get(ids.b)).toMatchObject({ kind: "removed", action: "restore" });
			expect(by.get(ids.a1)?.fields).toEqual(["text", "tags"]);
			expect(ran.calls.at(-1)?.movedAway).toBe(1);

			const dump = await ctx.dump(space.id);
			// Outside the subtree: `other` keeps its edit, the block that moved away stays there,
			// the one that moved in is back where it came from.
			expect(blockOf(dump, ids.other).content).toBe("other edited");
			expect(blockOf(dump, ids.a2).parentId).toBe(ids.other);
			expect(blockOf(dump, ids.o1).parentId).toBe(ids.other);
			expect(blockOf(dump, added).deleted).toBe(true);
			expect(blockOf(dump, ids.b1).deleted).toBe(false);
			expect(blockOf(dump, ids.a).taskJson).toBeNull();

			// One click moves the block that moved away back; again does nothing.
			const now = await fresh(ctx, space);
			const back = await moveOutlineBlockBack(
				{ ...WRITER, space: now, blockId: ids.a2, thenSeq },
				{ store: ctx.store },
			);
			expect(back.commit).not.toBeNull();
			expect(back.restored).toBe(false);
			const moved = blockOf(await ctx.dump(space.id), ids.a2);
			expect(moved.parentId).toBe(ids.a);
			expect(
				(
					await moveOutlineBlockBack(
						{ ...WRITER, space: await fresh(ctx, space), blockId: ids.a2, thenSeq },
						{ store: ctx.store },
					)
				).commit,
			).toBeNull();
			// Now the subtree compares equal to what it was.
			const rest = await wholeDiff(ctx, await fresh(ctx, space), ids.top, thenSeq, undefined, 100);
			expect(rest.entries).toEqual([]);
		},
	},
	{
		name: "moving a block back: a deleted one is brought back there, a deleted parent is a typed refusal",
		async run(ctx) {
			const { space, thenSeq, ids } = await fixture(ctx);
			await write(ctx, space, [
				{ op: "move", block: { id: ids.a1 }, parent: { id: ids.other } },
				{ op: "move", block: { id: ids.b1 }, parent: { id: ids.other } },
			]);
			await write(ctx, space, [
				{ op: "delete", block: { id: ids.a1 } },
				{ op: "delete", block: { id: ids.b } },
			]);
			const now = await fresh(ctx, space);
			const back = await moveOutlineBlockBack(
				{ ...WRITER, space: now, blockId: ids.a1, thenSeq },
				{ store: ctx.store },
			);
			expect(back.restored).toBe(true);
			const dump = await ctx.dump(space.id);
			expect(blockOf(dump, ids.a1)).toMatchObject({
				deleted: false,
				parentId: ids.a,
				content: "a1",
			});
			await expect(
				moveOutlineBlockBack(
					{ ...WRITER, space: await fresh(ctx, space), blockId: ids.b1, thenSeq },
					{ store: ctx.store },
				),
			).rejects.toBeInstanceOf(OutlineRestoreParentGoneError);
			// A block that was not in the tree then has nowhere to go back to.
			const added = await write(ctx, space, [{ op: "insert", parent: null, content: "late" }]);
			await expect(
				moveOutlineBlockBack(
					{
						...WRITER,
						space: await fresh(ctx, space),
						blockId: added.results[0]?.blockId as string,
						thenSeq,
					},
					{ store: ctx.store },
				),
			).rejects.toBeInstanceOf(OutlineRestoreRootError);
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "siblings that swapped places, and a new block sitting on an old order key, go back to their exact keys",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const made = await write(ctx, space, [
				{ op: "insert", tempId: "top", parent: null, content: "top" },
				...["one", "two", "three", "four"].map(
					(content): OutlineOp => ({
						op: "insert",
						parent: { tempId: "top" },
						content,
					}),
				),
			]);
			const thenSeq = (made.commit as { seq: number }).seq;
			const [top, one, two, three, four] = made.results.map((r) => r.blockId) as string[];
			const keysThen = new Map(
				(await ctx.dump(space.id)).blocks.map((block) => [block.id, block.orderKey]),
			);
			// Reverse the level, delete one, and put new blocks where it was.
			await write(ctx, space, [
				{
					op: "move",
					block: { id: four as string },
					parent: { id: top as string },
					position: { first: true },
				},
				{
					op: "move",
					block: { id: one as string },
					parent: { id: top as string },
					position: { last: true },
				},
				{
					op: "move",
					block: { id: three as string },
					parent: { id: top as string },
					position: { after: { id: four as string } },
				},
			]);
			await write(ctx, space, [{ op: "delete", block: { id: two as string } }]);
			await write(ctx, space, [
				{
					op: "insert",
					parent: { id: top as string },
					content: "new",
					position: { orderKey: keysThen.get(two as string) as string },
				},
				{
					op: "insert",
					parent: { id: top as string },
					content: "newer",
					position: { orderKey: keysThen.get(one as string) as string },
				},
			]);
			const { ran } = await restoreAndCheck(ctx, space, top as string, thenSeq);
			expect([...ran.skipped]).toEqual([]);
			// One pass, one commit: the keys were freed inside it.
			expect(ran.commits).toHaveLength(1);
			const dump = await ctx.dump(space.id);
			for (const id of [one, two, three, four] as string[])
				expect(blockOf(dump, id).orderKey).toBe(keysThen.get(id) as string);
		},
	},
	{
		name: "a block that left a long level and came back is listed once, and a block added since that holds a stranded block is kept",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const made = await write(ctx, space, [
				{ op: "insert", tempId: "top", parent: null, content: "top" },
				{ op: "insert", tempId: "a", parent: { tempId: "top" }, content: "a" },
				{ op: "insert", tempId: "c", parent: { tempId: "a" }, content: "c" },
				{ op: "insert", tempId: "other", parent: null, content: "other" },
				...Array.from(
					{ length: 90 },
					(_, i): OutlineOp => ({
						op: "insert",
						parent: { tempId: "top" },
						content: `row ${i}`,
					}),
				),
			]);
			const thenSeq = (made.commit as { seq: number }).seq;
			const [top, a, c, other, ...rows] = made.results.map((r) => r.blockId) as string[];
			// Every row changes, so the level is several pages; one row leaves and comes back
			// (two placements under the same parent, on different pages of the read).
			await write(
				ctx,
				space,
				rows.map((id, i): OutlineOp => ({ op: "update", block: { id }, content: `edited ${i}` })),
			);
			const wanderer = rows[45] as string;
			await write(ctx, space, [
				{ op: "move", block: { id: wanderer }, parent: { id: other as string } },
			]);
			await write(ctx, space, [
				{
					op: "move",
					block: { id: wanderer },
					parent: { id: top as string },
					position: { first: true },
				},
			]);
			// `a` moves away; its child `c` is pulled out first and put under a block added since.
			const added = (
				await write(ctx, space, [
					{ op: "insert", tempId: "x", parent: { id: top as string }, content: "added" },
					{ op: "move", block: { id: c as string }, parent: { tempId: "x" } },
					{ op: "update", block: { id: c as string }, content: "c edited" },
					{ op: "move", block: { id: a as string }, parent: { id: other as string } },
				])
			).results[0]?.blockId as string;

			const now = await fresh(ctx, space);
			const { entries, pages } = await wholeDiff(ctx, now, top as string, thenSeq, undefined, 40);
			expect(pages).toBeGreaterThan(2);
			// `listed` (inside the checks below, and here) refuses a block listed twice.
			const by = listed(entries);
			expect(by.get(wanderer)).toBe("changed:order,text");
			expect(by.get(a as string)).toBe("moved-away:");
			expect(by.get(c as string)).toBe("changed:parent,text");
			expect(by.get(added)).toBe("added:");

			const { ran, preview } = await restoreAndCheck(ctx, space, top as string, thenSeq);
			expect(preview.entries.find((entry) => entry.blockId === (c as string))).toMatchObject({
				action: "put-back",
				skip: "parent-moved-away",
			});
			// `c` cannot go back under `a` (it moved away): it stays where it is, with its text
			// of then, and the added block holding it is not deleted.
			expect(ran.skipped.get(c as string)).toBe("parent-moved-away");
			expect(ran.skipped.get(added)).toBe("holds-kept");
			const dump = await ctx.dump(space.id);
			expect(blockOf(dump, c as string)).toMatchObject({
				deleted: false,
				parentId: added,
				content: "c",
			});
			expect(blockOf(dump, added).deleted).toBe(false);
			expect(blockOf(dump, a as string).parentId).toBe(other as string);
		},
	},
	{
		name: "a commit that lands while a restore is analyzing makes it look again: a conflict under the subtree, a fresh start elsewhere",
		async run(ctx) {
			for (const inside of [true, false]) {
				const { space, thenSeq, ids } = await fixture(ctx);
				await write(ctx, space, [
					{ op: "update", block: { id: ids.a1 }, content: "a1 edited" },
					{ op: "update", block: { id: ids.b1 }, content: "b1 edited" },
				]);
				const now = await fresh(ctx, space);
				const preview = await wholePreview(ctx, now, ids.top, thenSeq);
				// The other commit lands after the restore checked for conflicts, before it writes.
				let landed: number | null = null;
				const racing = new Proxy(ctx.store, {
					get(target, prop, receiver) {
						const value = Reflect.get(target, prop, receiver);
						if (prop !== "listChangedChildren") return value;
						return async (...args: unknown[]) => {
							if (landed === null) {
								landed = 0;
								const foreign = await write(ctx, space, [
									{
										op: "update",
										block: { id: inside ? ids.a2 : ids.o1 },
										content: "someone else",
									},
								]);
								landed = foreign.commit?.seq as number;
							}
							return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
						};
					},
				});
				const result = await restoreOutlineSubtree(
					{ ...WRITER, space: now, token: preview.token },
					{ store: racing },
				).catch((error: unknown) => error);
				expect(landed).not.toBeNull();
				const dump = await ctx.dump(space.id);
				if (inside) {
					expect(result).toBeInstanceOf(OutlineRestoreConflictError);
					expect((result as OutlineRestoreConflictError).details.conflictSeq).toBe(
						landed as unknown as number,
					);
					// Nothing of the restore was written over the other change.
					expect(dump.space.nextSeq - 1).toBe(landed as unknown as number);
					expect(blockOf(dump, ids.a2).content).toBe("someone else");
					expect(blockOf(dump, ids.a1).content).toBe("a1 edited");
				} else {
					expect((result as OutlineRestoreResponse).done).toBe(true);
					expect((result as OutlineRestoreResponse).commits).toHaveLength(1);
					expect(blockOf(dump, ids.a1).content).toBe("a1");
					expect(blockOf(dump, ids.b1).content).toBe("b1");
					expect(blockOf(dump, ids.o1).content).toBe("someone else");
				}
				checkSpaceInvariants(dump);
			}
		},
	},
	{
		name: "restoring random histories: the subtree reads as it did, the rest is untouched, and it is idempotent",
		async run(ctx) {
			let restored = 0;
			let commits = 0;
			for (const seed of [21, 22, 23, 24, 25, 26]) {
				const ran = await restoreRandomHistory(ctx, seed);
				restored++;
				commits += ran.commits.length;
			}
			expect(restored).toBe(6);
			expect(commits).toBeGreaterThan(6);
		},
	},
	{
		name: "a restore interrupted between batches continues when confirmed again, with or without its cursor",
		async run(ctx) {
			for (const [seed, interruptAfter] of [
				[31, 1],
				[32, 2],
				[33, 3],
			] as const) {
				const { space: made, snapshots } = await randomizedHistory(ctx, seed);
				const space = await fresh(ctx, made);
				const seqs = [...snapshots.keys()].sort((x, y) => x - y);
				const thenSeq = seqs[Math.floor(seqs.length / 3)] as number;
				const { ran } = await restoreAndCheck(
					ctx,
					space,
					null,
					thenSeq,
					{ limits: { maxBlocksPerCommit: 4, maxCommitsPerCall: 3 } },
					interruptAfter,
				);
				expect(ran.commits.length).toBeGreaterThan(interruptAfter);
			}
		},
	},
	{
		name: "a restore stops with a conflict when the subtree changed after its preview, and only then",
		async run(ctx) {
			const { space, thenSeq, ids } = await fixture(ctx);
			await write(ctx, space, [
				{ op: "update", block: { id: ids.a1 }, content: "a1 edited" },
				{ op: "update", block: { id: ids.a2 }, content: "a2 edited" },
				{ op: "update", block: { id: ids.b1 }, content: "b1 edited" },
			]);
			const now = await fresh(ctx, space);
			const first = await wholePreview(ctx, now, ids.top, thenSeq);
			// A change elsewhere in the space is no conflict; one under the subtree is.
			await write(ctx, space, [{ op: "update", block: { id: ids.o1 }, content: "o1 edited" }]);
			const partial = await restoreOutlineSubtree(
				{ ...WRITER, space: now, token: first.token },
				{ store: ctx.store, limits: { maxBlocksPerCommit: 1, maxCommitsPerCall: 1 } },
			);
			expect(partial.done).toBe(false);
			expect(partial.commits.length).toBeGreaterThan(0);
			const foreign = await write(ctx, space, [
				{ op: "insert", parent: { id: ids.b }, content: "someone else" },
			]);
			const mid = await ctx.dump(space.id);
			for (const cursor of [partial.cursor, null]) {
				const refused = await restoreOutlineSubtree(
					{ ...WRITER, space: now, token: first.token, cursor },
					{ store: ctx.store },
				).catch((error: unknown) => error);
				expect(refused).toBeInstanceOf(OutlineRestoreConflictError);
				expect((refused as OutlineRestoreConflictError).details).toMatchObject({
					previewSeq: now.nextSeq - 1,
					conflictSeq: foreign.commit?.seq as number,
				});
			}
			// Nothing was written by the refused calls.
			expect((await fresh(ctx, space)).nextSeq).toBe(mid.space.nextSeq);
			// A new preview (of the subtree as it is now) restores the rest.
			await restoreAndCheck(ctx, space, ids.top, thenSeq);
			expect(blockOf(await ctx.dump(space.id), ids.o1).content).toBe("o1 edited");

			// A token of another space, a forged one, a cursor of another restore.
			const elsewhere = await personalSpace(ctx);
			await expect(
				restoreOutlineSubtree(
					{ ...WRITER, space: elsewhere, token: first.token },
					{ store: ctx.store },
				),
			).rejects.toBeInstanceOf(OutlineRestoreTokenError);
			await expect(
				restoreOutlineSubtree(
					{ ...WRITER, space: now, token: `${first.token.slice(0, -2)}xx` },
					{ store: ctx.store },
				),
			).rejects.toBeInstanceOf(OutlineRestoreTokenError);
			const other = await wholePreview(ctx, await fresh(ctx, space), ids.top, thenSeq);
			await expect(
				restoreOutlineSubtree(
					{ ...WRITER, space: now, token: other.token, cursor: partial.cursor },
					{ store: ctx.store },
				),
			).rejects.toBeInstanceOf(OutlineRestoreTokenError);
		},
	},
	{
		name: "a restore of 3,000 changed blocks three levels down is several commits, each within the row and change-mark limits",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const top = (await write(ctx, space, [{ op: "insert", parent: null, content: "top" }]))
				.results[0]?.blockId as string;
			const groups = (
				await write(
					ctx,
					space,
					Array.from(
						{ length: 10 },
						(_, i): OutlineOp => ({
							op: "insert",
							parent: { id: top },
							content: `group ${i}`,
						}),
					),
				)
			).results.map((r) => r.blockId);
			const subgroups: string[] = [];
			for (const group of groups) {
				const made = await write(
					ctx,
					space,
					Array.from(
						{ length: 10 },
						(_, i): OutlineOp => ({
							op: "insert",
							parent: { id: group },
							content: `sub ${i}`,
						}),
					),
				);
				subgroups.push(...made.results.map((r) => r.blockId));
			}
			const leaves: string[] = [];
			for (let i = 0; i < subgroups.length; i += 5) {
				const made = await write(
					ctx,
					space,
					subgroups.slice(i, i + 5).flatMap((sub) =>
						Array.from(
							{ length: 30 },
							(_, n): OutlineOp => ({
								op: "insert",
								parent: { id: sub },
								content: `leaf ${n}`,
							}),
						),
					),
				);
				leaves.push(...made.results.map((r) => r.blockId));
			}
			expect(leaves).toHaveLength(3000);
			const thenSeq = (await fresh(ctx, space)).nextSeq - 1;
			// Every leaf changes; a subgroup is deleted, one moves to another group, blocks are added.
			for (let i = 0; i < leaves.length; i += 200) {
				await write(
					ctx,
					space,
					leaves.slice(i, i + 200).map(
						(id, n): OutlineOp => ({
							op: "update",
							block: { id },
							content: `leaf edited ${i + n}`,
						}),
					),
				);
			}
			await write(ctx, space, [
				{ op: "delete", block: { id: subgroups[3] as string } },
				{
					op: "move",
					block: { id: subgroups[17] as string },
					parent: { id: groups[5] as string },
					position: { first: true },
				},
				...Array.from(
					{ length: 50 },
					(_, i): OutlineOp => ({
						op: "insert",
						parent: { id: subgroups[40] as string },
						content: `added ${i}`,
						position: { first: true },
					}),
				),
			]);
			const started = Date.now();
			const { ran } = await restoreAndCheck(ctx, space, top, thenSeq, {
				limits: { maxCommitsPerCall: 3 },
			});
			console.log(
				`[outline restore] 3,000 changed blocks at depth 3: ${ran.commits.length} commits in ${ran.calls.length} calls, ${Date.now() - started} ms (preview, restore and checks)`,
			);
			expect([...ran.skipped]).toEqual([]);
			expect(ran.commits.length).toBeGreaterThanOrEqual(8);
			expect(ran.calls.length).toBeGreaterThan(1);
			for (const call of ran.calls) expect(call.commits.length).toBeLessThanOrEqual(4);
		},
	},
	{
		name: "a restore spread over many deep chains is split by the change-mark limit as well",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const top = (await write(ctx, space, [{ op: "insert", parent: null, content: "top" }]))
				.results[0]?.blockId as string;
			// 12 chains, each 12 deep, a leaf at the end of each.
			const leaves: string[] = [];
			for (let chain = 0; chain < 12; chain++) {
				const made = await write(
					ctx,
					space,
					Array.from(
						{ length: 13 },
						(_, depth): OutlineOp => ({
							op: "insert",
							tempId: `n${depth}`,
							parent: depth === 0 ? { id: top } : { tempId: `n${depth - 1}` },
							content: `chain ${chain} depth ${depth}`,
						}),
					),
				);
				leaves.push(made.results.at(-1)?.blockId as string);
			}
			const thenSeq = (await fresh(ctx, space)).nextSeq - 1;
			for (const id of leaves)
				await write(ctx, space, [{ op: "update", block: { id }, content: "edited" }]);
			const limit = OUTLINE_HISTORY_LIMITS.maxChangeMarks;
			OUTLINE_HISTORY_LIMITS.maxChangeMarks = 40;
			try {
				// One batch would mark 12 chains of 13 ancestors: it is cut until each part fits.
				const { ran } = await restoreAndCheck(ctx, space, top, thenSeq);
				expect([...ran.skipped]).toEqual([]);
				expect(ran.commits.length).toBeGreaterThanOrEqual(4);
				const dump = await ctx.dump(space.id);
				const seqs = new Set(ran.commits.map((commit) => commit.seq));
				const marks = new Map<number, number>();
				for (const mark of dump.marks)
					if (seqs.has(mark.seq)) marks.set(mark.seq, (marks.get(mark.seq) ?? 0) + 1);
				for (const count of marks.values()) expect(count).toBeLessThanOrEqual(40);
			} finally {
				OUTLINE_HISTORY_LIMITS.maxChangeMarks = limit;
			}
		},
	},
	{
		name: "a restore leaves someone else's lock as it is unless the writer may unlock, like a revert",
		async run(ctx) {
			const locker = await ctx.seedUser();
			const { space, thenSeq, ids } = await fixture(ctx);
			await write(ctx, space, [
				{ op: "setTask", block: { id: ids.a }, task: { status: "todo" } },
				{ op: "update", block: { id: ids.a1 }, content: "a1 edited" },
			]);
			await lockOutlineTask({ blockId: ids.a, userId: locker, store: ctx.store });
			const now = await fresh(ctx, space);
			const preview = await wholePreview(ctx, now, ids.top, thenSeq);
			// Not the locker, and no authority: the lock stays, the rest is put back.
			const kept = await restoreOutlineSubtree(
				{ ...WRITER, space: now, token: preview.token, unlockAuthority: async () => false },
				{ store: ctx.store },
			);
			expect(kept.done).toBe(true);
			expect(kept.skipped).toEqual([
				{ blockId: ids.a, sid: blockOf(await ctx.dump(space.id), ids.a).sid, reason: "lock-kept" },
			]);
			let dump = await ctx.dump(space.id);
			expect(blockOf(dump, ids.a).taskJson?.lock).toBeTruthy();
			expect(blockOf(dump, ids.a1).content).toBe("a1");
			// Someone who may unlock: the task, and its lock, go.
			const again = await wholePreview(ctx, await fresh(ctx, space), ids.top, thenSeq);
			const done = await restoreOutlineSubtree(
				{
					...WRITER,
					space: await fresh(ctx, space),
					token: again.token,
					unlockAuthority: async () => true,
				},
				{ store: ctx.store },
			);
			expect(done.skipped).toEqual([]);
			dump = await ctx.dump(space.id);
			expect(blockOf(dump, ids.a).taskJson).toBeNull();
			checkSpaceInvariants(dump);
		},
	},
	{
		name: "a move out that is refused never lets the restore delete the added block holding it, at any call boundary (B1)",
		async run(ctx) {
			for (const limits of [{ maxBlocksPerCommit: 2, maxCommitsPerCall: 1 }, {}]) {
				// At `then`: top{x}, other{m, o1}. Since: A added under top, m moved under A, a leaf
				// added under A, and `other` moved under m: moving m back would put it under itself.
				const h = await strandedHistory(ctx);
				const { ran, preview } = await restoreAndCheck(ctx, h.space, h.top, h.thenSeq, {
					limits,
				});
				const entryOf = (id: string) => preview.entries.find((entry) => entry.blockId === id);
				// What A holds may not be able to leave: the preview cannot know, and says so.
				expect(entryOf(h.added)).toMatchObject({ kind: "added", action: "delete-unless-holds" });
				expect(entryOf(h.m)).toMatchObject({ kind: "moved-in", action: "move-out", carries: 2 });
				expect(ran.skipped.get(h.m)).toBe("refused");
				expect(ran.skipped.get(h.added)).toBe("holds-kept");
				const dump = await ctx.dump(h.space.id);
				for (const id of [h.other, h.o1, h.m, h.added])
					expect(blockOf(dump, id).deleted).toBe(false);
				expect(blockOf(dump, h.leaf).deleted).toBe(true);
				expect(blockOf(dump, h.o1).content).toBe("o1 outside content");
			}
		},
	},
	{
		name: "a batch split by the change-mark limit keeps an added block whose block could not leave it (B1, halving)",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const made = await write(ctx, space, [
				{ op: "insert", tempId: "top", parent: null, content: "top" },
				{ op: "insert", tempId: "x", parent: { tempId: "top" }, content: "x" },
				{ op: "insert", tempId: "other", parent: null, content: "other" },
				{ op: "insert", tempId: "m", parent: { tempId: "other" }, content: "m" },
				{ op: "insert", tempId: "mc", parent: { tempId: "m" }, content: "under m" },
			]);
			const [top, , other, m, mc] = made.results.map((r) => r.blockId) as string[];
			const thenSeq = (made.commit as { seq: number }).seq;
			const added = (
				await write(ctx, space, [{ op: "insert", parent: { id: top as string }, content: "added" }])
			).results[0]?.blockId as string;
			await write(ctx, space, [{ op: "move", block: { id: m as string }, parent: { id: added } }]);
			await write(ctx, space, [{ op: "insert", parent: { id: added }, content: "added leaf" }]);
			const now = await fresh(ctx, space);
			const preview = await wholePreview(ctx, now, top as string, thenSeq);
			// Any commit that moves `m` is "too large", so the batch [leaf, m, added] is split until
			// m's move is alone and given up: the delete of `added`, in the other half, must not go.
			let refusedCommits = 0;
			const splitting = new Proxy(ctx.store, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (prop !== "applyCommit") return value;
					return async (plan: { closeVersionIds: string[] }) => {
						if (plan.closeVersionIds.includes(m as string)) {
							refusedCommits++;
							throw new OutlineChangeMarksLimitError(space.id);
						}
						return await (value as (p: unknown) => Promise<unknown>).apply(target, [plan]);
					};
				},
			});
			const result = await restoreOutlineSubtree(
				{ ...WRITER, space: now, token: preview.token },
				{ store: splitting },
			);
			expect(refusedCommits).toBeGreaterThanOrEqual(2);
			expect(result.done).toBe(true);
			const reasons = new Map(result.skipped.map((skip) => [skip.blockId, skip.reason]));
			expect(reasons.get(m as string)).toBe("refused");
			expect(reasons.get(added)).toBe("holds-kept");
			const dump = await ctx.dump(space.id);
			for (const id of [added, m, mc, other] as string[])
				expect(blockOf(dump, id).deleted).toBe(false);
			expect(blockOf(dump, m as string).parentId).toBe(added);
			checkSpaceInvariants(dump);
		},
	},
	{
		name: "restoring random histories with tiny batches and one commit per call never deletes or changes a block that was outside the root then",
		async run(ctx) {
			let restored = 0;
			for (const seed of [41, 42, 43, 44, 45, 46, 47, 48]) {
				await restoreRandomHistory(ctx, seed, {
					maxBlocksPerCommit: 1 + (seed % 3),
					maxCommitsPerCall: 1,
				});
				restored++;
			}
			expect(restored).toBe(8);
		},
	},
	{
		name: "a block deleted after it moved away is listed as moved away, not restored, and nobody's later work on it is touched (S1, D58)",
		async run(ctx) {
			for (const touched of [false, true]) {
				const { space, thenSeq, ids } = await fixture(ctx);
				await write(ctx, space, [{ op: "move", block: { id: ids.a1 }, parent: { id: ids.other } }]);
				await write(ctx, space, [{ op: "update", block: { id: ids.a1 }, content: "edited away" }]);
				await write(ctx, space, [{ op: "delete", block: { id: ids.a1 } }]);
				// Deleted while still under the root: restored.
				await write(ctx, space, [{ op: "delete", block: { id: ids.b1 } }]);
				const now = await fresh(ctx, space);
				const diff = await wholeDiff(ctx, now, ids.top, thenSeq, undefined, 100);
				expect(diff.entries.find((e) => e.blockId === ids.a1)).toMatchObject({
					kind: "moved-away",
					deletedSince: true,
					after: null,
				});
				const preview = await wholePreview(ctx, now, ids.top, thenSeq);
				const by = new Map(preview.entries.map((entry) => [entry.blockId, entry]));
				expect(by.get(ids.a1)).toMatchObject({
					kind: "moved-away",
					action: "none",
					deletedSince: true,
					canMoveBack: true,
				});
				expect(by.get(ids.b1)).toMatchObject({ kind: "removed", action: "restore" });
				if (touched) {
					// Someone brings it back where it last was, outside the subtree, and works on it.
					await write(ctx, space, [
						{ op: "restore", block: { id: ids.a1 }, parent: { id: ids.other } },
					]);
					await write(ctx, space, [
						{ op: "update", block: { id: ids.a1 }, content: "new work after the preview" },
					]);
				}
				const result = await restoreOutlineSubtree(
					{ ...WRITER, space: await fresh(ctx, space), token: preview.token },
					{ store: ctx.store },
				);
				expect(result.done).toBe(true);
				expect(result.movedAway).toBe(1);
				const dump = await ctx.dump(space.id);
				expect(blockOf(dump, ids.b1)).toMatchObject({ deleted: false, parentId: ids.b });
				if (touched) {
					expect(blockOf(dump, ids.a1)).toMatchObject({
						deleted: false,
						parentId: ids.other,
						content: "new work after the preview",
					});
				} else {
					expect(blockOf(dump, ids.a1).deleted).toBe(true);
					// One click brings it back where it was.
					const back = await moveOutlineBlockBack(
						{ ...WRITER, space: await fresh(ctx, space), blockId: ids.a1, thenSeq },
						{ store: ctx.store },
					);
					expect(back.restored).toBe(true);
					expect(blockOf(await ctx.dump(space.id), ids.a1)).toMatchObject({
						deleted: false,
						parentId: ids.a,
					});
				}
			}
		},
	},
	{
		name: "a page of a comparison or a preview, and a call of a restore, stay within their row budgets with tag-heavy blocks (S2)",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const tags = (prefix: string) => Array.from({ length: 30 }, (_, j) => `${prefix}${j}`);
			const top = (await write(ctx, space, [{ op: "insert", parent: null, content: "top" }]))
				.results[0]?.blockId as string;
			const kids: string[] = [];
			for (let c = 0; c < 2; c++) {
				const made = await write(
					ctx,
					space,
					Array.from(
						{ length: 20 },
						(_, i): OutlineOp => ({
							op: "insert",
							parent: { id: top },
							content: `k${c * 20 + i}`,
							tags: tags("t"),
						}),
					),
				);
				kids.push(...made.results.map((r) => r.blockId));
			}
			const thenSeq = (await fresh(ctx, space)).nextSeq - 1;
			for (let c = 0; c < kids.length; c += 10) {
				await write(
					ctx,
					space,
					kids
						.slice(c, c + 10)
						.map((id): OutlineOp => ({ op: "update", block: { id }, tags: tags("u") })),
				);
			}
			const now = await fresh(ctx, space);
			// `wholeDiff` and `wholePreview` count every row of every page against the budget.
			const diff = await wholeDiff(ctx, now, top, thenSeq, undefined, 200);
			expect(diff.entries).toHaveLength(40);
			expect(diff.pages).toBeGreaterThan(1);
			for (const entry of diff.entries) expect(entry.fields).toEqual(["tags"]);
			const preview = await wholePreview(ctx, now, top, thenSeq);
			expect(preview.entries).toHaveLength(40);
			// A restore call stops at its row budget (and always makes progress).
			const counter = counting(ctx.store);
			const maxRowsPerCall = 1200;
			let cursor: string | null = null;
			let calls = 0;
			for (;;) {
				const result = await restoreOutlineSubtree(
					{ ...WRITER, space: now, token: preview.token, cursor },
					{ store: counter.store, limits: { maxRowsPerCall, maxCommitsPerCall: 100 } },
				);
				calls++;
				// The walk's and the restore's own reads stay within the budget; the write path
				// reads what each commit it writes needs (one commit here, 40 blocks of 30 tags).
				const rows = counter.take();
				expect(rows).toBeLessThanOrEqual(
					maxRowsPerCall + OUTLINE_DIFF_LIMITS.maxStoreRows + result.changed * 70,
				);
				expect(calls).toBeLessThan(50);
				if (result.done) break;
				cursor = result.cursor;
			}
			expect(calls).toBeGreaterThan(1);
			const dump = await ctx.dump(space.id);
			const open = dump.links.filter((link) => link.kind === "tag" && link.toSeq === null);
			for (const id of kids) {
				expect(
					open
						.filter((link) => link.fromBlockId === id)
						.map((link) => link.targetRef)
						.sort(),
				).toEqual(tags("t").sort());
			}
		},
	},
	{
		name: "a cursor stays small however wide or deep the walk, and every call of a restore moves on, with or without its cursor (S3)",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const made = await write(ctx, space, [
				{ op: "insert", tempId: "top", parent: null, content: "top" },
				{ op: "insert", tempId: "g", parent: { tempId: "top" }, content: "g" },
				{ op: "insert", tempId: "s", parent: { tempId: "g" }, content: "s" },
			]);
			const [top, , s] = made.results.map((r) => r.blockId) as string[];
			const leaves: string[] = [];
			for (let i = 0; i < 5000; i += OUTLINE_LIMITS.maxOps) {
				const batch = await write(
					ctx,
					space,
					Array.from(
						{ length: OUTLINE_LIMITS.maxOps },
						(_, n): OutlineOp => ({
							op: "insert",
							parent: { id: s as string },
							content: `leaf ${i + n}`,
						}),
					),
				);
				leaves.push(...batch.results.map((r) => r.blockId));
			}
			// And a chain 300 deep under `top`.
			let parent = top as string;
			const chain: string[] = [];
			for (let depth = 0; depth < 300; depth += OUTLINE_LIMITS.maxOps) {
				const length = Math.min(OUTLINE_LIMITS.maxOps, 300 - depth);
				const batch = await write(
					ctx,
					space,
					Array.from(
						{ length },
						(_, n): OutlineOp => ({
							op: "insert",
							tempId: `c${n}`,
							parent: n === 0 ? { id: parent } : { tempId: `c${n - 1}` },
							content: `chain ${depth + n}`,
						}),
					),
				);
				chain.push(...batch.results.map((r) => r.blockId));
				parent = chain.at(-1) as string;
			}
			const thenSeq = (await fresh(ctx, space)).nextSeq - 1;
			for (let i = 0; i < leaves.length; i += OUTLINE_LIMITS.maxOps) {
				await write(
					ctx,
					space,
					leaves
						.slice(i, i + OUTLINE_LIMITS.maxOps)
						.map((id): OutlineOp => ({ op: "update", block: { id }, content: "edited" })),
				);
			}
			await write(ctx, space, [
				{ op: "update", block: { id: chain.at(-1) as string }, content: "deep edit" },
			]);
			const now = await fresh(ctx, space);
			let cursor: string | null = null;
			let pages = 0;
			let entries = 0;
			let longest = 0;
			do {
				const page: Awaited<ReturnType<typeof readOutlineSubtreeDiff>> =
					await readOutlineSubtreeDiff({
						space: now,
						rootId: top as string,
						thenSeq,
						cursor,
						limit: OUTLINE_DIFF_LIMITS.maxEntries,
						store: ctx.store,
					});
				entries += page.entries.length;
				cursor = page.nextCursor;
				longest = Math.max(longest, cursor?.length ?? 0);
				expect(++pages).toBeLessThan(1000);
			} while (cursor);
			expect(entries).toBe(5001);
			// The stack is the path: a few frames for the wide level, ~300 for the chain.
			expect(longest).toBeLessThan(40_000);

			// A restore without its cursor continues where the last call stopped; every call
			// moves on.
			const preview = await wholePreview(ctx, now, top as string, thenSeq);
			const ran = await runRestore(
				ctx,
				now,
				preview.token,
				{ limits: { maxCommitsPerCall: 2 } },
				false,
			);
			for (const call of ran.calls) {
				if (!call.done) expect(call.commits.length).toBeGreaterThan(0);
				expect(call.cursor?.length ?? 0).toBeLessThan(40_000);
			}
			expect(ran.calls.length).toBeGreaterThan(2);
			const dump = await ctx.dump(space.id);
			const contents = new Map(dump.blocks.map((block) => [block.id, block.content]));
			for (const [i, id] of leaves.entries()) expect(contents.get(id)).toBe(`leaf ${i}`);
			expect(contents.get(chain.at(-1) as string)).toBe("chain 299");
		},
	},
	{
		name: "what a refused block takes along is reported, each with its reason (S4)",
		async run() {
			const entry = (
				blockId: string,
				dependsOn: string | null,
				extra: Partial<RestoreBatchEntry> = {},
			): RestoreBatchEntry => ({
				op: { op: "move", block: { id: blockId }, parent: null, position: { last: true } },
				blockId,
				dependsOn,
				guards: [],
				...extra,
			});
			const { left, dropped, unsafe } = dropRefused(
				[
					entry("p", null, { guards: ["holder"] }),
					entry("c1", "p"),
					entry("c2", "c1"),
					entry("other", null),
					entry("holder", null, {
						op: { op: "delete", block: { id: "holder" } },
						close: true,
					}),
				],
				"p",
			);
			expect([...dropped].sort()).toEqual(["c1", "c2", "p"]);
			expect([...unsafe]).toEqual(["holder"]);
			expect(left.map((e) => e.blockId)).toEqual(["other"]);
		},
	},
	{
		name: "a preview's token is its person's and runs out; the first page waits for live edits",
		async run(ctx) {
			const { space, thenSeq, ids } = await fixture(ctx);
			await write(ctx, space, [{ op: "update", block: { id: ids.a1 }, content: "a1 edited" }]);
			// A live session holding an unsaved edit under the subtree writes it when the barrier
			// is taken: the preview is of the space after it, so the restore meets no conflict.
			let flushed = 0;
			let inside = false;
			setOutlineLiveBarrier({
				holds: () => inside,
				async run(spaceId, fn) {
					inside = true;
					try {
						if (spaceId === space.id && flushed === 0) {
							flushed = (
								await write(ctx, space, [
									{ op: "update", block: { id: ids.b1 }, content: "typed live" },
								])
							).commit?.seq as number;
						}
						return await fn();
					} finally {
						inside = false;
					}
				},
			});
			let preview: Awaited<ReturnType<typeof wholePreview>>;
			try {
				preview = await wholePreview(ctx, await fresh(ctx, space), ids.top, thenSeq);
			} finally {
				setOutlineLiveBarrier(null);
			}
			const first = await previewOutlineRestore({
				space: await fresh(ctx, space),
				rootId: ids.top,
				thenSeq,
				userId: ACTOR.id,
				token: preview.token,
				store: ctx.store,
			});
			expect(first.nowSeq).toBe(flushed);
			const someoneElse = {
				actor: { kind: "human" as const, id: "another" },
				responsibleUserId: null,
			};
			const asOther = await restoreOutlineSubtree(
				{ ...someoneElse, space: await fresh(ctx, space), token: preview.token },
				{ store: ctx.store },
			).catch((error: unknown) => error);
			expect(asOther).toBeInstanceOf(OutlineRestoreTokenError);
			expect((asOther as OutlineRestoreTokenError).details).toEqual({ reason: "person" });
			const page = await previewOutlineRestore({
				space: await fresh(ctx, space),
				rootId: ids.top,
				thenSeq,
				userId: "another",
				token: preview.token,
				store: ctx.store,
			}).catch((error: unknown) => error);
			expect(page).toBeInstanceOf(OutlineRestoreTokenError);
			const later = new Date(Date.now() + (OUTLINE_RESTORE_LIMITS.tokenMinutes + 1) * 60_000);
			const expired = await restoreOutlineSubtree(
				{ ...WRITER, space: await fresh(ctx, space), token: preview.token },
				{ store: ctx.store, now: () => later },
			).catch((error: unknown) => error);
			expect((expired as OutlineRestoreTokenError).details).toEqual({ reason: "expired" });
			const done = await restoreOutlineSubtree(
				{ ...WRITER, space: await fresh(ctx, space), token: preview.token },
				{ store: ctx.store },
			);
			expect(done.done).toBe(true);
			const dump = await ctx.dump(space.id);
			expect(blockOf(dump, ids.a1).content).toBe("a1");
			expect(blockOf(dump, ids.b1).content).toBe("b1");
		},
	},
];

/** The history of B1: an added block holding a moved-in block that cannot go back. */
async function strandedHistory(ctx: OutlineContractContext) {
	const space = await personalSpace(ctx);
	const made = await write(ctx, space, [
		{ op: "insert", tempId: "top", parent: null, content: "top" },
		{ op: "insert", tempId: "x", parent: { tempId: "top" }, content: "x" },
		{ op: "insert", tempId: "other", parent: null, content: "other" },
		{ op: "insert", tempId: "m", parent: { tempId: "other" }, content: "m" },
		{ op: "insert", tempId: "o1", parent: { tempId: "other" }, content: "o1 outside content" },
	]);
	const [top, , other, m, o1] = made.results.map((r) => r.blockId) as string[];
	const thenSeq = (made.commit as { seq: number }).seq;
	const added = (
		await write(ctx, space, [{ op: "insert", parent: { id: top as string }, content: "A added" }])
	).results[0]?.blockId as string;
	await write(ctx, space, [{ op: "move", block: { id: m as string }, parent: { id: added } }]);
	const leaf = (
		await write(ctx, space, [{ op: "insert", parent: { id: added }, content: "L added leaf" }])
	).results[0]?.blockId as string;
	await write(ctx, space, [
		{ op: "move", block: { id: other as string }, parent: { id: m as string } },
	]);
	return {
		space,
		thenSeq,
		top: top as string,
		other: other as string,
		m: m as string,
		o1: o1 as string,
		added,
		leaf,
	};
}
