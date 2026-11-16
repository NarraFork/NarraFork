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
	type OutlineDiffEntry,
	type OutlineDiffField,
	type OutlineRestoreEntry,
	type OutlineRestoreResponse,
	type OutlineRestoreSkip,
} from "@shared/outline-restore-api";
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
	type OutlineSpaceRow,
	type OutlineStore,
	type OutlineVersionRow,
} from "../store/port";
import { readOutlineSubtreeDiff } from "../subtree-diff";
import { OutlineHistoryNotAvailableError } from "../subtree-errors";
import {
	moveOutlineBlockBack,
	type OutlineRestoreOptions,
	outlineRestoreMarker,
	previewOutlineRestore,
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
	tags: Map<string, string>;
}

function stateAt(dump: SpaceDump, seq: number): StateAt {
	const live = new Map<string, OutlineVersionRow>();
	for (const v of dump.versions) {
		if (v.fromSeq <= seq && (v.toSeq === null || seq < v.toSeq) && !v.deleted)
			live.set(v.blockId, v);
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
	return { live, tags };
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
	/** Blocks under the root then that are live now and not under it. */
	away: Set<string>;
}

/** What a comparison must list, by brute force over two states. */
function expectedDiff(before: StateAt, after: StateAt, rootId: string | null): Expected {
	const thenSet = under(before, rootId);
	const nowSet = under(after, rootId);
	const entries = new Map<string, string>();
	const away = new Set<string>();
	if (rootId !== null) {
		const fields = fieldsBetween(before, after, rootId, false);
		if (fields.length > 0) entries.set(rootId, `changed:${fields.join(",")}`);
	}
	for (const id of thenSet) {
		if (!after.live.has(id)) entries.set(id, "removed:");
		else if (nowSet.has(id)) {
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
	return { entries, thenSet, nowSet, away };
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
 *     then passes through one that moved away keeps its place; a block the restore said it
 *     left alone is exempt from what that reason covers);
 *   - nothing that was not under the root then is under it now, except what it said it kept;
 *   - blocks that moved away, and everything that was under the root at neither moment, have
 *     the very version they had.
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
				(!atPin.live.has(id) && isThere(then.live.get(id)?.parentId ?? null)));
		there.set(id, answer);
		return answer;
	};
	const isAnchored = (id: string) => isThere(then.live.get(id)?.parentId ?? null);

	for (const id of expected.thenSet) {
		if (expected.away.has(id)) {
			// Moved away: not pulled back, not touched.
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
		if (reason === "refused" || reason === "lock-kept") continue;
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
	if (rootId !== null && !skipped.has(rootId)) {
		const was = then.live.get(rootId) as OutlineVersionRow;
		const is = now.live.get(rootId) as OutlineVersionRow;
		expect(is.contentHash).toBe(was.contentHash);
		expect(sameTaskJson(is.taskJson, was.taskJson)).toBe(true);
		expect(now.tags.get(rootId) ?? "").toBe(then.tags.get(rootId) ?? "");
		// Where the root sits is not part of its subtree.
		expect(is.parentId).toBe(atPin.live.get(rootId)?.parentId as string | null);
		expect(is.orderKey).toBe(atPin.live.get(rootId)?.orderKey as string);
	}

	// Nothing foreign is left under the root without a reason: a block that moved in stays
	// only when its parent of then is deleted (or the write path refused the move), and a block
	// added since only while it holds a block that was in the tree then and cannot go back.
	const childrenNow = new Map<string, string[]>();
	for (const v of now.live.values()) {
		if (v.parentId === null) continue;
		const list = childrenNow.get(v.parentId);
		if (list) list.push(v.blockId);
		else childrenNow.set(v.parentId, [v.blockId]);
	}
	/** A block that was in the tree then and has nowhere to go back to. */
	const stuck = (id: string): boolean => {
		const parentId = then.live.get(id)?.parentId ?? null;
		return expected.thenSet.has(id)
			? !isAnchored(id)
			: skipped.get(id) === "refused" || (parentId !== null && !now.live.has(parentId));
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
		if (was) {
			if (skipped.get(id) === "refused") continue;
			expect(skipped.get(id)).toBe("parent-gone");
			expect(was.parentId !== null && !now.live.has(was.parentId)).toBe(true);
		} else {
			expect(skipped.get(id)).toBe("holds-kept");
			expect(holdsOld(id)).toBe(true);
		}
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
		expect(entry.action).toBe(
			(
				{
					added: "delete",
					removed: "restore",
					"moved-in": "move-out",
					"moved-away": "none",
					changed: "put-back",
				} as const
			)[entry.kind],
		);
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
	const restoreId = ran.calls[0]?.restoreId as string;
	checkCommits(after, ran.commits, restoreId);
	// Nothing but the restore wrote.
	expect(after.space.nextSeq - 1 - pin).toBe(ran.commits.length);

	// Confirming again applies nothing twice.
	const again = await restoreOutlineSubtree(
		{ ...WRITER, space, token: preview.token },
		{ store: ctx.store },
	);
	expect(again.done).toBe(true);
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
	const { ran } = await restoreAndCheck(ctx, space, rootId, thenSeq, {
		limits: { maxBlocksPerCommit: 6, maxCommitsPerCall: 2 },
	});
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
				previewOutlineRestore({ space: now, rootId: newId, thenSeq, store: ctx.store }),
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
				() => previewOutlineRestore({ space: now, rootId: null, thenSeq, store: ctx.store }),
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
];
