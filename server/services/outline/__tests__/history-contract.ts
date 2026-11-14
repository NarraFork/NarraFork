/**
 * The history contract: placements (`outline_block_edges`), change marks
 * (`outline_subtree_changes`), the reads built on them (`store/history-port.ts`) and the
 * placement conversion, written once and run against SQLite (`store-contract.test.ts`) and
 * PostgreSQL (`tests/server/services/outline/pg-outline-store.test.ts`, `PG_INTEGRATION=1`).
 *
 * The reference is never the tables under test: a tree as of a seq is the reference model's
 * snapshot of the randomized history (`contract.ts`), which also equals the tree rebuilt from
 * version rows; "changed between two seqs" is read off the version rows.
 */
import { expect } from "bun:test";
import { OutlineWriteError } from "../errors";
import { convertOutlineHistory } from "../history-convert";
import { OUTLINE_CHANGE, type OutlineTaskJson } from "../model";
import {
	type OutlineChangedChildCursor,
	OutlineHistoryUnavailableError,
	type OutlineLevelCursor,
} from "../store/history-port";
import {
	OUTLINE_HISTORY_LIMITS,
	OUTLINE_PLACEMENT_FLAGS,
	type OutlineSpaceRow,
	type OutlineVersionRow,
} from "../store/port";
import { type OutlineOp, type OutlineWriteResult, writeOutline } from "../write";
import {
	type ContractCase,
	checkPlacements,
	checkSpaceInvariants,
	type OutlineContractContext,
	randomizedHistory,
	type SnapshotEntry,
	type SpaceDump,
} from "./contract";

const NOW = "2026-10-26T00:00:00.000Z";
const ACTOR = { kind: "human" as const, id: "user-history-contract" };

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

/** What a level row says of a block, in the reference's terms. */
interface Placed {
	parentId: string | null;
	index: number;
	task: OutlineTaskJson | null;
	alias: string | null;
	hasChildren: boolean;
}

/** The whole tree read one level at a time, `pageSize` rows a read (so cursors are used). */
async function treeByLevels(
	ctx: OutlineContractContext,
	spaceId: string,
	asOf: number | null,
	pageSize: number,
): Promise<Map<string, Placed>> {
	const out = new Map<string, Placed>();
	const queue: Array<string | null> = [null];
	for (let at = 0; at < queue.length; at++) {
		const parentId = queue[at] as string | null;
		let after: OutlineLevelCursor | null = null;
		let index = 0;
		for (;;) {
			const page = await ctx.store.listLevel(spaceId, parentId, { asOf, after, limit: pageSize });
			expect(page.rows.length).toBeLessThanOrEqual(pageSize);
			for (const row of page.rows) {
				expect(row.parentId).toBe(parentId);
				expect(out.has(row.id)).toBe(false);
				out.set(row.id, {
					parentId,
					index: index++,
					task: row.taskJson,
					alias: row.alias,
					hasChildren: row.hasChildren,
				});
				if (row.hasChildren) queue.push(row.id);
			}
			if (!page.next) break;
			after = page.next;
		}
	}
	return out;
}

function placedOf(snapshot: ReadonlyMap<string, SnapshotEntry>): Map<string, Placed> {
	const parents = new Set<string>();
	for (const entry of snapshot.values()) if (entry.parentId !== null) parents.add(entry.parentId);
	const out = new Map<string, Placed>();
	for (const [id, entry] of snapshot) {
		out.set(id, {
			parentId: entry.parentId,
			index: entry.index,
			task: entry.task,
			alias: entry.alias,
			hasChildren: parents.has(id),
		});
	}
	return out;
}

const sorted = <T>(map: ReadonlyMap<string, T>): Array<[string, T]> =>
	[...map].sort((a, b) => (a[0] < b[0] ? -1 : 1));

function versionsByBlock(dump: SpaceDump): Map<string, OutlineVersionRow[]> {
	const out = new Map<string, OutlineVersionRow[]>();
	for (const v of dump.versions) {
		const list = out.get(v.blockId);
		if (list) list.push(v);
		else out.set(v.blockId, [v]);
	}
	return out;
}

/** The blocks under `root` in a snapshot (root left out), with their entries. */
function subtreeOf(
	snapshot: ReadonlyMap<string, SnapshotEntry>,
	root: string,
): Array<[string, SnapshotEntry]> {
	const kids = new Map<string, string[]>();
	for (const [id, entry] of snapshot) {
		if (entry.parentId === null) continue;
		const list = kids.get(entry.parentId);
		if (list) list.push(id);
		else kids.set(entry.parentId, [id]);
	}
	const out: Array<[string, SnapshotEntry]> = [];
	const queue = [root];
	for (let at = 0; at < queue.length; at++) {
		for (const id of kids.get(queue[at] as string) ?? []) {
			out.push([id, snapshot.get(id) as SnapshotEntry]);
			queue.push(id);
		}
	}
	return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Evenly spread picks of a list, at most `n`. */
function spread<T>(items: readonly T[], n: number): T[] {
	if (items.length <= n) return [...items];
	return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)] as T);
}

/** Pairs of seqs to compare: neighbours and far apart. */
function seqPairs(seqs: readonly number[], n: number): Array<[number, number]> {
	const pairs: Array<[number, number]> = [];
	for (let i = 0; i + 1 < seqs.length; i++) pairs.push([seqs[i] as number, seqs[i + 1] as number]);
	for (let i = 0; i + 5 < seqs.length; i += 3)
		pairs.push([seqs[i] as number, seqs[i + 5] as number]);
	if (seqs.length > 1) pairs.push([seqs[0] as number, seqs.at(-1) as number]);
	return spread(pairs, n);
}

export const OUTLINE_HISTORY_CONTRACT: ContractCase[] = [
	{
		name: "placements: every level, subtree and walk up as of any seq equals the tree rebuilt from versions",
		async run(ctx) {
			const { space, snapshots } = await randomizedHistory(ctx, 20261114);
			const seqs = [...snapshots.keys()].sort((a, b) => a - b);
			expect(seqs.length).toBeGreaterThan(5);
			// The store's literal is the model's four placement changes.
			expect(OUTLINE_PLACEMENT_FLAGS).toBe(
				OUTLINE_CHANGE.CREATE |
					OUTLINE_CHANGE.MOVE |
					OUTLINE_CHANGE.DELETE |
					OUTLINE_CHANGE.RESTORE,
			);
			expect((await ctx.store.getHistoryStates([space.id])).get(space.id)).toEqual({
				floorSeq: 0,
				edgesReady: true,
			});
			for (const seq of spread(seqs, 24)) {
				const want = placedOf(snapshots.get(seq) as Map<string, SnapshotEntry>);
				// One level at a time, two rows a read.
				expect(sorted(await treeByLevels(ctx, space.id, seq, 2))).toEqual(sorted(want));

				// The whole space in one breadth-first read: the same blocks under the same parents,
				// no level started before the one above it is done.
				const all = await ctx.store.listSubtreeAt(space.id, null, { asOf: seq, limit: 10_000 });
				expect(all.truncated).toBe(false);
				expect(all.rows.map((r) => [r.id, r.parentId, r.hasChildren]).sort()).toEqual(
					sorted(want).map(([id, p]) => [id, p.parentId, p.hasChildren]),
				);
				const depth = new Map<string, number>();
				let deepest = 0;
				for (const row of all.rows) {
					const d = row.parentId === null ? 0 : (depth.get(row.parentId) as number) + 1;
					expect(d).toBeGreaterThanOrEqual(deepest);
					deepest = d;
					depth.set(row.id, d);
				}
				// Cut short: exactly the limit, every row's parent among the rows before it.
				if (all.rows.length > 3) {
					const cut = await ctx.store.listSubtreeAt(space.id, null, { asOf: seq, limit: 3 });
					expect(cut.truncated).toBe(true);
					expect(cut.rows).toHaveLength(3);
					const seen = new Set<string>();
					for (const row of cut.rows) {
						expect(row.parentId === null || seen.has(row.parentId)).toBe(true);
						seen.add(row.id);
					}
				}

				// The subtree of one block, and several levels in one read.
				const some = spread([...want.keys()].sort(), 4);
				for (const root of some) {
					const sub = await ctx.store.listSubtreeAt(space.id, root, { asOf: seq, limit: 10_000 });
					expect(sub.rows.map((r) => r.id).sort()).toEqual(
						subtreeOf(snapshots.get(seq) as Map<string, SnapshotEntry>, root).map(([id]) => id),
					);
				}
				const levels = await ctx.store.listLevels(space.id, [null, ...some], {
					asOf: seq,
					limit: 10_000,
				});
				expect(levels.truncated).toBe(false);
				const wantKids = (parent: string | null) =>
					sorted(want)
						.filter(([, p]) => p.parentId === parent)
						.sort((a, b) => a[1].index - b[1].index)
						.map(([id]) => id);
				for (const parent of [null, ...some]) {
					expect(levels.rows.filter((r) => r.parentId === parent).map((r) => r.id)).toEqual(
						wantKids(parent),
					);
				}
				// Parents come in the order asked, wherever the top level stands among them.
				const asked = [...some.slice(0, 2), null, ...some.slice(2)];
				const mixed = await ctx.store.listLevels(space.id, asked, { asOf: seq, limit: 10_000 });
				expect(mixed.rows.map((r) => r.id)).toEqual(asked.flatMap((parent) => wantKids(parent)));
				const mixedNow = await ctx.store.listLevels(space.id, asked, {
					asOf: null,
					limit: 10_000,
				});
				expect(
					mixedNow.rows.map((r) => r.parentId).filter((parent, i, all) => parent !== all[i - 1]),
				).toEqual(asked.filter((parent) => mixedNow.rows.some((r) => r.parentId === parent)));
				// Rows of one parent come together.
				const order = levels.rows.map((r) => r.parentId);
				expect(order.filter((p, i) => i === 0 || p !== order[i - 1]).length).toBe(
					new Set(order).size,
				);

				// Walking up from a block reaches the space through the parents it had then.
				for (const start of some) {
					let current: string | null = start;
					for (let guard = 0; current !== null; guard++) {
						expect(guard).toBeLessThan(1000);
						const [placement] = await ctx.store.getPlacementsAt(space.id, [current], seq);
						const parent: string | null = (want.get(current) as Placed).parentId;
						expect(placement?.parentKey).toBe(parent ?? space.id);
						current = parent;
					}
				}
			}

			// Now: the blocks' own index gives the same tree as the placements at the last seq.
			const last = seqs.at(-1) as number;
			const now = await treeByLevels(ctx, space.id, null, 3);
			expect(sorted(now)).toEqual(
				sorted(placedOf(snapshots.get(last) as Map<string, SnapshotEntry>)),
			);
			expect(sorted(await treeByLevels(ctx, space.id, last, 3))).toEqual(sorted(now));
			const nowAll = await ctx.store.listSubtreeAt(space.id, null, { asOf: null, limit: 10_000 });
			expect(nowAll.rows.map((r) => [r.id, r.parentId]).sort()).toEqual(
				sorted(now).map(([id, p]) => [id, p.parentId]),
			);
			// A deleted block has no placement now, and had none once it was deleted.
			const dump = await ctx.dump(space.id);
			expect(checkPlacements(dump)).toBe("all");
			const gone = dump.blocks.filter((b) => b.deleted).map((b) => b.id);
			expect(await ctx.store.getPlacementsAt(space.id, gone, null)).toEqual([]);
			// Another space's parent has no children here.
			const other = await personalSpace(ctx);
			const top = [...now].find(([, p]) => p.parentId === null && p.hasChildren)?.[0];
			if (top) {
				for (const asOf of [null, last]) {
					expect((await ctx.store.listLevel(other.id, top, { asOf, limit: 10 })).rows).toEqual([]);
					expect((await ctx.store.listSubtreeAt(other.id, top, { asOf, limit: 10 })).rows).toEqual(
						[],
					);
				}
			}
		},
	},
	{
		name: "change marks: a block with no version and no mark between two seqs has the same subtree at both",
		async run(ctx) {
			const { space, snapshots } = await randomizedHistory(ctx, 7741);
			const dump = await ctx.dump(space.id);
			const versions = versionsByBlock(dump);
			const seqs = [...snapshots.keys()].sort((a, b) => a - b);
			let unchanged = 0;
			let changed = 0;
			for (const [s1, s2] of seqPairs(seqs, 40)) {
				const a = snapshots.get(s1) as Map<string, SnapshotEntry>;
				const b = snapshots.get(s2) as Map<string, SnapshotEntry>;
				const both = [...a.keys()].filter((id) => b.has(id));
				const found = new Map(
					(await ctx.store.findSubtreeChanges(space.id, both, { after: s1, upTo: s2 })).map((c) => [
						c.blockId,
						c,
					]),
				);
				for (const id of both) {
					const self = (versions.get(id) ?? []).some((v) => v.fromSeq > s1 && v.fromSeq <= s2);
					const below = dump.marks.some((m) => m.ancestorId === id && m.seq > s1 && m.seq <= s2);
					expect({ id, s1, s2, ...(found.get(id) ?? { self: false, below: false }) }).toEqual({
						id,
						s1,
						s2,
						...(found.has(id) ? { blockId: id } : {}),
						self,
						below,
					});
					if (self || below) {
						changed++;
						continue;
					}
					unchanged++;
					// Neither: the block's own state and everything under it are the same.
					const { index: _i1, ...own1 } = a.get(id) as SnapshotEntry;
					const { index: _i2, ...own2 } = b.get(id) as SnapshotEntry;
					expect(own2).toEqual(own1);
					expect(subtreeOf(b, id)).toEqual(subtreeOf(a, id));
				}
			}
			expect(unchanged).toBeGreaterThan(0);
			expect(changed).toBeGreaterThan(0);

			// A block's timeline is its marks, newest first, paged by `before`.
			const marked = [...new Set(dump.marks.map((m) => m.ancestorId))].sort().slice(0, 6);
			expect(marked.length).toBeGreaterThan(0);
			for (const id of marked) {
				const want = dump.marks
					.filter((m) => m.ancestorId === id)
					.map((m) => m.seq)
					.sort((x, y) => y - x);
				const got: number[] = [];
				let before: number | null = null;
				for (;;) {
					const page = await ctx.store.listSubtreeChangeSeqs(space.id, id, { before, limit: 2 });
					got.push(...page);
					if (page.length < 2) break;
					before = page.at(-1) as number;
				}
				expect(got).toEqual(want);
				const floor = want.at(-1) as number;
				expect(
					await ctx.store.listSubtreeChangeSeqs(space.id, id, { after: floor, limit: 100 }),
				).toEqual(want.slice(0, -1));
			}
		},
	},
	{
		name: "compare: walking down the changed children finds exactly the blocks that got a version between two seqs",
		async run(ctx) {
			const { space, snapshots } = await randomizedHistory(ctx, 990217);
			const dump = await ctx.dump(space.id);
			const versions = versionsByBlock(dump);
			const seqs = [...snapshots.keys()].sort((a, b) => a - b);
			let visited = 0;
			let skipped = 0;
			for (const [s1, s2] of seqPairs(seqs, 30)) {
				const reported = new Set<string>();
				const queue: Array<string | null> = [null];
				const walked = new Set<string | null>([null]);
				for (let at = 0; at < queue.length; at++) {
					const parentId = queue[at] as string | null;
					let cursor: OutlineChangedChildCursor | null = null;
					for (;;) {
						const page = await ctx.store.listChangedChildren(space.id, parentId, {
							after: s1,
							upTo: s2,
							cursor,
							limit: 2,
						});
						for (const row of page.rows) {
							const arrived = row.fromSeq > s1;
							const left = row.toSeq !== null && row.toSeq <= s2;
							expect(row.self || row.below || arrived || left).toBe(true);
							if (row.self) reported.add(row.blockId);
							if (row.below && !walked.has(row.blockId)) {
								walked.add(row.blockId);
								queue.push(row.blockId);
							}
						}
						if (!page.next) break;
						cursor = page.next;
					}
				}
				// Every block with a version in the range that was in the tree at some point of it.
				const want: string[] = [];
				for (const [id, list] of versions) {
					if (!list.some((v) => v.fromSeq > s1 && v.fromSeq <= s2)) continue;
					const inTree = list.some(
						(v) => !v.deleted && v.fromSeq <= s2 && (v.toSeq === null || v.toSeq > s1),
					);
					if (inTree) want.push(id);
				}
				expect([...reported].sort()).toEqual(want.sort());
				visited += walked.size;
				// What the walk never opened: blocks live at both ends with nothing changed below.
				const a = snapshots.get(s1) as Map<string, SnapshotEntry>;
				const b = snapshots.get(s2) as Map<string, SnapshotEntry>;
				skipped += [...a.keys()].filter((id) => b.has(id) && !walked.has(id)).length;
			}
			expect(visited).toBeGreaterThan(0);
			expect(skipped).toBeGreaterThan(0);
			// An empty range, and a parent of another space, have no changed children.
			const last = seqs.at(-1) as number;
			expect(
				(await ctx.store.listChangedChildren(space.id, null, { after: last, upTo: last, limit: 5 }))
					.rows,
			).toEqual([]);
			const other = await personalSpace(ctx);
			const top = dump.blocks.find((b) => b.parentId === null)?.id as string;
			expect(
				(await ctx.store.listChangedChildren(other.id, top, { after: 0, upTo: last, limit: 5 }))
					.rows,
			).toEqual([]);
		},
	},
	{
		name: "placements: a move writes two placement rows whatever the subtree's size; text changes write none",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const made = await write(ctx, space, [
				{ op: "insert", tempId: "p1", parent: null, content: "page one" },
				{ op: "insert", tempId: "a", parent: { tempId: "p1" }, content: "A" },
				{ op: "insert", tempId: "b", parent: { tempId: "p1" }, content: "B" },
				{ op: "insert", tempId: "p2", parent: null, content: "page two" },
				{ op: "insert", tempId: "c", parent: { tempId: "p2" }, content: "C" },
			]);
			const [p1, a, b, p2, c] = made.results.map((r) => r.blockId) as [
				string,
				string,
				string,
				string,
				string,
			];
			// 600 blocks under A, three levels deep.
			const SIZE = 600;
			const groups: string[] = [];
			for (let g = 0; g < 3; g++) {
				const res = await write(
					ctx,
					space,
					Array.from({ length: 200 }, (_, i) => ({
						op: "insert" as const,
						tempId: `g${g}-${i}`,
						parent: i === 0 ? { id: a } : { tempId: `g${g}-${i < 20 ? 0 : (i % 19) + 1}` },
						content: `block ${g} ${i}`,
					})),
				);
				groups.push(res.results[0]?.blockId as string);
			}
			const edgesOf = async () => {
				const dump = await ctx.dump(space.id);
				return { dump, open: dump.edges.filter((e) => e.toSeq === null), all: dump.edges };
			};
			const start = await edgesOf();
			expect(start.open).toHaveLength(SIZE + 5);
			expect(start.all).toHaveLength(SIZE + 5);
			const marksAt = (dump: SpaceDump, seq: number) =>
				dump.marks
					.filter((m) => m.seq === seq)
					.map((m) => m.ancestorId)
					.sort();

			// Within its page: one version, one placement closed, one opened, marks on the two chains.
			const within = await write(ctx, space, [{ op: "move", block: { id: a }, parent: { id: b } }]);
			const seq1 = within.commit?.seq as number;
			const afterWithin = await edgesOf();
			expect(afterWithin.dump.versions).toHaveLength(start.dump.versions.length + 1);
			expect(afterWithin.all).toHaveLength(start.all.length + 1);
			expect(afterWithin.open).toHaveLength(SIZE + 5);
			expect(afterWithin.all.filter((e) => e.fromSeq === seq1 || e.toSeq === seq1)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ blockId: a, parentKey: p1, toSeq: seq1 }),
					expect.objectContaining({ blockId: a, parentKey: b, fromSeq: seq1, toSeq: null }),
				]),
			);
			expect(afterWithin.all.filter((e) => e.fromSeq === seq1 || e.toSeq === seq1)).toHaveLength(2);
			expect(marksAt(afterWithin.dump, seq1)).toEqual([b, p1].sort());

			// To another page: today every descendant still gets a version for its page, but the
			// placements written are the same two rows.
			const across = await write(ctx, space, [{ op: "move", block: { id: a }, parent: { id: c } }]);
			const seq2 = across.commit?.seq as number;
			const afterAcross = await edgesOf();
			expect(afterAcross.dump.versions).toHaveLength(afterWithin.dump.versions.length + SIZE + 1);
			expect(afterAcross.all.filter((e) => e.fromSeq === seq2 || e.toSeq === seq2)).toHaveLength(2);
			expect(afterAcross.open).toHaveLength(SIZE + 5);

			// A reorder among siblings is a placement of its own.
			const reorder = await write(ctx, space, [
				{
					op: "move",
					block: { id: groups[2] as string },
					parent: { id: a },
					position: { first: true },
				},
			]);
			const seq3 = reorder.commit?.seq as number;
			const afterReorder = await edgesOf();
			expect(afterReorder.all.filter((e) => e.fromSeq === seq3 || e.toSeq === seq3)).toHaveLength(
				2,
			);
			expect(marksAt(afterReorder.dump, seq3)).toEqual([a, c, p2].sort());

			// Text, a checkbox, an alias and tags: marks on the ancestors, no placement.
			const text = await write(ctx, space, [
				{ op: "update", block: { id: groups[0] as string }, content: "rewritten", alias: "G0" },
				{ op: "setTask", block: { id: groups[1] as string }, task: { status: "todo" } },
				{ op: "update", block: { id: groups[1] as string }, tags: ["Design"] },
			]);
			const seq4 = text.commit?.seq as number;
			const afterText = await edgesOf();
			expect(afterText.all).toHaveLength(afterReorder.all.length);
			expect(afterText.all.filter((e) => e.fromSeq === seq4 || e.toSeq === seq4)).toEqual([]);
			expect(marksAt(afterText.dump, seq4)).toEqual([a, c, p2].sort());
			// A top-level block's own change marks nothing: the space is not an ancestor.
			const topText = await write(ctx, space, [
				{ op: "update", block: { id: p1 }, content: "page one, renamed" },
			]);
			expect(marksAt(await ctx.dump(space.id), topText.commit?.seq as number)).toEqual([]);

			// Deleting closes every placement of the subtree; restoring the root opens one.
			const del = await write(ctx, space, [{ op: "delete", block: { id: a } }]);
			const seq5 = del.commit?.seq as number;
			const afterDelete = await edgesOf();
			expect(afterDelete.open).toHaveLength(5 - 1);
			expect(afterDelete.all.filter((e) => e.toSeq === seq5)).toHaveLength(SIZE + 1);
			expect(await ctx.store.getPlacementsAt(space.id, [a, groups[0] as string], null)).toEqual([]);
			expect((await ctx.store.getPlacementsAt(space.id, [a], seq5 - 1))[0]?.parentKey).toBe(c);
			const back = await write(ctx, space, [
				{ op: "restore", block: { id: a }, parent: null, position: { last: true } },
			]);
			const seq6 = back.commit?.seq as number;
			const afterRestore = await edgesOf();
			expect(afterRestore.all.filter((e) => e.fromSeq === seq6)).toEqual([
				expect.objectContaining({ blockId: a, parentKey: space.id, toSeq: null }),
			]);
			checkSpaceInvariants(afterRestore.dump);

			// As of the seq before the delete, the subtree is all there, read to a budget.
			const then = await ctx.store.listSubtreeAt(space.id, a, { asOf: seq5 - 1, limit: 250 });
			expect(then.truncated).toBe(true);
			expect(then.rows).toHaveLength(250);
			const whole = await ctx.store.listSubtreeAt(space.id, a, { asOf: seq5 - 1, limit: 5000 });
			expect(whole.rows).toHaveLength(SIZE);
			expect((await ctx.store.listSubtreeAt(space.id, a, { asOf: seq5, limit: 10 })).rows).toEqual(
				[],
			);
		},
	},
	{
		name: "conversion: a space written before placements gets one per live block and its floor, safely among commits",
		async run(ctx) {
			const { space } = await randomizedHistory(ctx, 5150);
			// Enough live blocks for several batches, some deleted ones, a few levels.
			const seeded = await write(ctx, space, [
				{ op: "insert", tempId: "root", parent: null, content: "conversion root" },
				...Array.from({ length: 40 }, (_, i) => ({
					op: "insert" as const,
					tempId: `k${i}`,
					parent: i < 8 ? { tempId: "root" } : { tempId: `k${i % 8}` },
					content: `kept ${i}`,
				})),
			]);
			const ids = seeded.results.map((r) => r.blockId);
			await write(ctx, space, [{ op: "delete", block: { id: ids[3] as string } }]);
			await ctx.forgetHistory(space.id);
			expect((await ctx.store.getHistoryStates([space.id])).get(space.id)).toEqual({
				floorSeq: 0,
				edgesReady: false,
			});
			const bare = await ctx.dump(space.id);
			expect(bare.edges).toEqual([]);
			expect(checkPlacements(bare)).toBe("not-ready");

			// Commits land between batches: a move, a delete, a restore, an insert, a text change.
			// (`ids` is the root, then k0…k39: k39 under k7, k38 a leaf under k6, k2 deleted above.)
			const live = (await ctx.dump(space.id)).blocks.filter((b) => !b.deleted);
			let batches = 0;
			const interleave = [
				() => write(ctx, space, [{ op: "move", block: { id: ids[40] as string }, parent: null }]),
				() => write(ctx, space, [{ op: "delete", block: { id: ids[39] as string } }]),
				() =>
					write(ctx, space, [
						{
							op: "restore",
							block: { id: ids[3] as string },
							parent: null,
							position: { last: true },
						},
						{ op: "insert", parent: { id: ids[0] as string }, content: "born during conversion" },
						{ op: "update", block: { id: ids[1] as string }, content: "edited meanwhile" },
					]),
			];
			const result = await convertOutlineHistory({
				store: {
					listSpacesPendingEdges: async () => [space],
					backfillEdges: async (spaceId, options) => {
						// A commit between two batches (the previous batch's transaction is over).
						const next = interleave[batches++];
						if (next) await next();
						return ctx.store.backfillEdges(spaceId, options);
					},
					finishEdgeBackfill: (spaceId) => ctx.store.finishEdgeBackfill(spaceId),
				},
				rows: 7,
			});
			expect(batches).toBeGreaterThan(interleave.length);
			expect(result).toMatchObject({ spaces: 1, left: 0, backup: null });
			expect(result.blocks).toBeGreaterThanOrEqual(live.length);

			const after = await ctx.dump(space.id);
			expect(after.history).toEqual({ floorSeq: after.space.nextSeq - 1, edgesReady: true });
			expect(checkPlacements(after)).toBe("from-floor");
			// What the conversion placed holds since before the history; what a commit placed
			// during it starts at that commit. Nobody is placed twice.
			expect(after.edges.filter((e) => e.toSeq === null)).toHaveLength(
				after.blocks.filter((b) => !b.deleted).length,
			);
			expect(after.edges.some((e) => e.fromSeq === 0)).toBe(true);
			expect(after.edges.some((e) => e.fromSeq > 0 && e.toSeq === null)).toBe(true);
			// The tree by placement at the floor is the tree now.
			const floor = after.history.floorSeq;
			expect(sorted(await treeByLevels(ctx, space.id, floor, 5))).toEqual(
				sorted(await treeByLevels(ctx, space.id, null, 5)),
			);

			// Running it again does nothing: the space is not listed, a batch writes no row, the
			// floor stays.
			expect(
				(await ctx.store.listSpacesPendingEdges({ limit: 1000 })).map((s) => s.id),
			).not.toContain(space.id);
			let cursor: string | null = null;
			for (;;) {
				const batch = await ctx.store.backfillEdges(space.id, { afterSid: cursor, limit: 11 });
				expect(batch.inserted).toBe(0);
				if (batch.nextSid === null) break;
				cursor = batch.nextSid;
			}
			expect(await ctx.store.finishEdgeBackfill(space.id)).toBeNull();
			// Commits that landed during the conversion left marks at or below the floor; a
			// timeline starts above it.
			expect(after.marks.some((m) => m.ancestorId === ids[0] && m.seq <= floor)).toBe(true);
			expect(
				await ctx.store.listSubtreeChangeSeqs(space.id, ids[0] as string, { limit: 100 }),
			).toEqual([]);
			const under = await write(ctx, space, [
				{ op: "insert", parent: { id: ids[0] as string }, content: "under the root, later" },
			]);
			expect(
				await ctx.store.listSubtreeChangeSeqs(space.id, ids[0] as string, { limit: 100 }),
			).toEqual([under.commit?.seq as number]);
			expect(
				await ctx.store.listSubtreeChangeSeqs(space.id, ids[0] as string, { after: 0, limit: 100 }),
			).toEqual([under.commit?.seq as number]);
			await write(ctx, space, [{ op: "insert", parent: null, content: "after the conversion" }]);
			const later = await ctx.dump(space.id);
			expect(later.history.floorSeq).toBe(floor);
			expect(later.edges.filter((e) => e.fromSeq === 0)).toEqual(
				after.edges.filter((e) => e.fromSeq === 0),
			);
			expect(checkPlacements(later)).toBe("from-floor");
			// History from the floor on reads by placement like any other.
			expect(sorted(await treeByLevels(ctx, space.id, later.space.nextSeq - 1, 5))).toEqual(
				sorted(await treeByLevels(ctx, space.id, null, 5)),
			);
			const levelsAtFloor = await treeByLevels(ctx, space.id, floor, 5);
			expect(levelsAtFloor.size).toBe(later.blocks.filter((b) => !b.deleted).length - 2);

			// A space that is waiting is listed (by id, paged) until it is done.
			const waiting = await personalSpace(ctx);
			await write(ctx, waiting, [{ op: "insert", parent: null, content: "old" }]);
			await ctx.forgetHistory(waiting.id);
			const listed: string[] = [];
			let afterId: string | null = null;
			for (;;) {
				const page: OutlineSpaceRow[] = await ctx.store.listSpacesPendingEdges({
					after: afterId,
					limit: 2,
				});
				listed.push(...page.map((s) => s.id));
				if (page.length < 2) break;
				afterId = page.at(-1)?.id as string;
			}
			expect(listed).toContain(waiting.id);
			expect(listed).toEqual([...listed].sort());
			// A stopped run leaves the space waiting, with what it placed so far.
			const stop = new AbortController();
			const partial = await convertOutlineHistory({
				store: {
					listSpacesPendingEdges: async () => [waiting],
					backfillEdges: ctx.store.backfillEdges.bind(ctx.store),
					finishEdgeBackfill: ctx.store.finishEdgeBackfill.bind(ctx.store),
				},
				rows: 1,
				signal: stop.signal,
				onBatch: () => stop.abort(),
			});
			expect(partial).toMatchObject({ spaces: 0, left: 1 });
			expect((await ctx.store.getHistoryStates([waiting.id])).get(waiting.id)?.edgesReady).toBe(
				false,
			);
			// A copy that cannot be made stops the run before any space is touched.
			await expect(
				convertOutlineHistory({
					store: {
						listSpacesPendingEdges: async () => [waiting],
						backfillEdges: async () => {
							throw new Error("a batch ran without the copy");
						},
						finishEdgeBackfill: async () => {
							throw new Error("a space was finished without the copy");
						},
					},
					backup: async () => {
						throw new Error("no room for the copy");
					},
				}),
			).rejects.toThrow("no room for the copy");
			const done = await convertOutlineHistory({
				store: {
					listSpacesPendingEdges: async () => [waiting],
					backfillEdges: ctx.store.backfillEdges.bind(ctx.store),
					finishEdgeBackfill: ctx.store.finishEdgeBackfill.bind(ctx.store),
				},
				backup: async () => "/somewhere/outline-before-pageless.db",
			});
			expect(done).toMatchObject({
				spaces: 1,
				left: 0,
				backup: "/somewhere/outline-before-pageless.db",
			});
			expect(checkPlacements(await ctx.dump(waiting.id))).toBe("from-floor");
		},
	},
	{
		name: "compare: commits landing between pages neither repeat a changed child nor drop one",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const made = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "parent" },
				...Array.from({ length: 12 }, (_, i) => ({
					op: "insert" as const,
					parent: { tempId: "p" },
					content: `child ${i}`,
				})),
				// Two that had left before the range starts mattering to the first part.
				{ op: "insert", tempId: "gone", parent: { tempId: "p" }, content: "leaves early" },
			]);
			const [p, ...rest] = made.results.map((r) => r.blockId) as [string, ...string[]];
			const kids = rest.slice(0, 12);
			const gone = rest[12] as string;
			await write(
				ctx,
				space,
				kids.map((id, i) => ({
					op: "update" as const,
					block: { id },
					content: `child ${i}, edited`,
				})),
			);
			await write(ctx, space, [{ op: "delete", block: { id: gone } }]);
			const range = { after: 1, upTo: 3 };
			const want = [...kids, gone].sort();

			const first = await ctx.store.listChangedChildren(space.id, p, { ...range, limit: 5 });
			expect(first.rows).toHaveLength(5);
			expect(first.next).not.toBeNull();
			const seen = first.rows.map((r) => r.blockId);
			const unseen = kids.filter((id) => !seen.includes(id));
			// Meanwhile: a child already returned leaves, two not yet returned leave (moved,
			// deleted), one is reordered, and a new one arrives.
			await write(ctx, space, [
				{ op: "move", block: { id: seen[0] as string }, parent: null },
				{ op: "move", block: { id: unseen[0] as string }, parent: null },
			]);
			await write(ctx, space, [
				{ op: "delete", block: { id: unseen[1] as string } },
				{
					op: "move",
					block: { id: unseen[2] as string },
					parent: { id: p },
					position: { first: true },
				},
				{ op: "insert", parent: { id: p }, content: "arrived after the first page" },
			]);
			const rows = [...first.rows];
			let cursor = first.next;
			for (let guard = 0; cursor !== null; guard++) {
				expect(guard).toBeLessThan(20);
				const page = await ctx.store.listChangedChildren(space.id, p, {
					...range,
					cursor,
					limit: 2,
				});
				rows.push(...page.rows);
				cursor = page.next;
			}
			// Each placement once, every child of the range, nothing that came after the first page.
			const keys = rows.map((r) => `${r.blockId}:${r.fromSeq}`);
			expect(new Set(keys).size).toBe(keys.length);
			expect(rows.map((r) => r.blockId).sort()).toEqual(want);
			// A read started now, of the same range, finds the same children.
			const again: string[] = [];
			let next: OutlineChangedChildCursor | null = null;
			do {
				const page = await ctx.store.listChangedChildren(space.id, p, {
					...range,
					cursor: next,
					limit: 4,
				});
				again.push(...page.rows.map((r) => r.blockId));
				next = page.next;
			} while (next !== null);
			expect(again.sort()).toEqual(want);
			// A page of nothing is not a page.
			for (const limit of [0, -1, 0.5]) {
				await expect(
					ctx.store.listChangedChildren(space.id, p, { ...range, limit }),
				).rejects.toThrow(RangeError);
			}
		},
	},
	{
		name: "refusals: a read below the floor, or of a space whose placements are not built, is refused; every read stays in its space",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const made = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{ op: "insert", tempId: "a", parent: { tempId: "p" }, content: "A" },
				{ op: "insert", tempId: "b", parent: { tempId: "a" }, content: "B" },
			]);
			const [p, a, b] = made.results.map((r) => r.blockId) as [string, string, string];
			await write(ctx, space, [{ op: "update", block: { id: b }, content: "B, rewritten" }]);
			await write(ctx, space, [{ op: "move", block: { id: b }, parent: { id: p } }]);
			const refused = async (
				read: () => Promise<unknown>,
				reason: "not-ready" | "before-floor",
			): Promise<void> => {
				let error: unknown;
				try {
					await read();
				} catch (caught) {
					error = caught;
				}
				expect(error).toBeInstanceOf(OutlineHistoryUnavailableError);
				expect((error as OutlineHistoryUnavailableError).reason).toBe(reason);
				expect((error as OutlineHistoryUnavailableError).spaceId).toBe(space.id);
			};
			/** Every read that looks at placements or marks, looking back to `seq`. */
			const reads = (seq: number): Array<() => Promise<unknown>> => [
				() => ctx.store.listLevel(space.id, null, { asOf: seq, limit: 5 }),
				() => ctx.store.listLevel(space.id, p, { asOf: seq, limit: 5 }),
				() => ctx.store.listLevels(space.id, [null, p], { asOf: seq, limit: 5 }),
				() => ctx.store.listSubtreeAt(space.id, null, { asOf: seq, limit: 5 }),
				() => ctx.store.getPlacementsAt(space.id, [a], seq),
				() => ctx.store.findSubtreeChanges(space.id, [p, a], { after: seq, upTo: seq + 1 }),
				() =>
					ctx.store.listChangedChildren(space.id, null, { after: seq, upTo: seq + 1, limit: 5 }),
			];

			// Before the conversion: nothing by placement is answered, at any seq; the tree now is.
			await ctx.forgetHistory(space.id);
			for (const read of reads(3)) await refused(read, "not-ready");
			await refused(() => ctx.store.getPlacementsAt(space.id, [a], null), "not-ready");
			await refused(() => ctx.store.listSubtreeChangeSeqs(space.id, p, { limit: 5 }), "not-ready");
			expect(
				(await ctx.store.listLevel(space.id, null, { asOf: null, limit: 5 })).rows.map((r) => r.id),
			).toEqual([p]);
			expect(
				(await ctx.store.listSubtreeAt(space.id, null, { asOf: null, limit: 5 })).rows,
			).toHaveLength(3);

			// After it: the floor is readable, anything below it is refused, never answered.
			await convertOutlineHistory({
				store: {
					listSpacesPendingEdges: async () => [space],
					backfillEdges: ctx.store.backfillEdges.bind(ctx.store),
					finishEdgeBackfill: ctx.store.finishEdgeBackfill.bind(ctx.store),
				},
			});
			const floor = (await ctx.store.getHistoryStates([space.id])).get(space.id)
				?.floorSeq as number;
			expect(floor).toBe(3);
			for (const seq of [0, 1, floor - 1]) {
				for (const read of reads(seq)) await refused(read, "before-floor");
			}
			await write(ctx, space, [{ op: "update", block: { id: b }, content: "B, after the floor" }]);
			for (const read of reads(floor)) await read();
			expect(
				(await ctx.store.listLevel(space.id, p, { asOf: floor, limit: 5 })).rows
					.map((r) => r.id)
					.sort(),
			).toEqual([a, b].sort());
			expect(
				await ctx.store.findSubtreeChanges(space.id, [p, a, b], { after: floor, upTo: floor + 1 }),
			).toEqual(
				expect.arrayContaining([
					{ blockId: p, self: false, below: true },
					{ blockId: b, self: true, below: false },
				]),
			);
			// The timeline simply ends at the floor: there are no marks before it.
			expect(await ctx.store.listSubtreeChangeSeqs(space.id, p, { limit: 10 })).toEqual([
				floor + 1,
			]);

			// Another space sees none of these blocks through any read that names blocks.
			const other = await personalSpace(ctx);
			await write(ctx, other, [{ op: "insert", parent: null, content: "elsewhere" }]);
			expect(await ctx.store.getPlacementsAt(other.id, [a, b], null)).toEqual([]);
			expect(await ctx.store.getPlacementsAt(other.id, [a, b], 1)).toEqual([]);
			expect(await ctx.store.findSubtreeChanges(other.id, [p, b], { after: 0, upTo: 99 })).toEqual(
				[],
			);
			expect(await ctx.store.listSubtreeChangeSeqs(other.id, p, { limit: 10 })).toEqual([]);
			// A space that does not exist has nothing, and is not an error.
			expect(await ctx.store.listLevel("no-such-space", null, { asOf: 1, limit: 5 })).toEqual({
				rows: [],
				next: null,
			});
		},
	},
	{
		name: "limits: a commit that would mark more ancestors than allowed is refused whole",
		async run(ctx) {
			const space = await personalSpace(ctx);
			// Three chains, four deep.
			const chains: string[][] = [];
			for (let n = 0; n < 3; n++) {
				const res = await write(
					ctx,
					space,
					Array.from({ length: 5 }, (_, i) => ({
						op: "insert" as const,
						tempId: `c${i}`,
						parent: i === 0 ? null : { tempId: `c${i - 1}` },
						content: `chain ${n} level ${i}`,
					})),
				);
				chains.push(res.results.map((r) => r.blockId));
			}
			const before = await ctx.dump(space.id);
			const allowed = OUTLINE_HISTORY_LIMITS.maxChangeMarks;
			OUTLINE_HISTORY_LIMITS.maxChangeMarks = 8;
			try {
				// Two leaves: 8 ancestors, written. Three: 12, refused.
				await write(
					ctx,
					space,
					chains.slice(0, 2).map((chain) => ({
						op: "update" as const,
						block: { id: chain[4] as string },
						content: "fits",
					})),
				);
				const mid = await ctx.dump(space.id);
				expect(mid.space.nextSeq).toBe(before.space.nextSeq + 1);
				let refused: unknown;
				try {
					await write(
						ctx,
						space,
						chains.map((chain) => ({
							op: "update" as const,
							block: { id: chain[4] as string },
							content: "too many chains",
						})),
					);
				} catch (error) {
					refused = error;
				}
				expect(refused).toBeInstanceOf(OutlineWriteError);
				expect((refused as OutlineWriteError).code).toBe("OUTLINE_TOO_MANY_ROWS");
				// Also when the second half (the tree after the commit) passes the limit: three
				// new leaves, each under a chain of five.
				let refusedInsert: unknown;
				try {
					await write(
						ctx,
						space,
						chains.map((chain) => ({
							op: "insert" as const,
							parent: { id: chain[4] as string },
							content: "one more level",
						})),
					);
				} catch (error) {
					refusedInsert = error;
				}
				expect((refusedInsert as OutlineWriteError | undefined)?.code).toBe(
					"OUTLINE_TOO_MANY_ROWS",
				);
				const after = await ctx.dump(space.id);
				expect(after.space.nextSeq).toBe(mid.space.nextSeq);
				expect(after.versions).toHaveLength(mid.versions.length);
				expect(after.marks).toHaveLength(mid.marks.length);
				expect(after.edges).toEqual(mid.edges);
				expect(after.blocks.length).toBe(mid.blocks.length);
			} finally {
				OUTLINE_HISTORY_LIMITS.maxChangeMarks = allowed;
			}
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
];
