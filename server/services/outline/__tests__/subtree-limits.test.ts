/**
 * Reads by block where a space holds more than one read looks at: more than 500 open changes
 * on the blocks read, and more blocks to walk up than a marks read allows. What must hold: the
 * answer is cut where the limit says, and SAYS it was cut (`pendingTruncated`, `atLeast`,
 * `attentionAtLeast`); nothing asked for silently disappears.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`. SQLite only: the limits are the
 * services', not the stores'.
 */
import { describe, expect, test } from "bun:test";
import { OUTLINE_SUBTREE_LIMITS } from "@shared/outline-subtree-api";
import { db } from "../../../db";
import { narrators, users } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { lockOutlineTask } from "../pending";
import { outlineStore } from "../store";
import type { OutlineSpaceRow } from "../store/port";
import { readOutlineMarks } from "../subtree-marks";
import {
	OUTLINE_LIVE_SUBTREE_MAX_SKIPPED,
	readLiveSubtree,
	readOutlineLevels,
	readOutlineSubtree,
} from "../subtree-read";
import { type OutlineOp, writeOutline } from "../write";

const NOW = "2026-10-26T00:00:00.000Z";

async function seedUser() {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `limits-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

async function seedNarrator() {
	const id = generateId();
	await db.insert(narrators).values({ id, title: "limits", createdAt: NOW, updatedAt: NOW });
	return id;
}

const fresh = async (space: OutlineSpaceRow) =>
	(await outlineStore.getSpace(space.id)) as OutlineSpaceRow;

const human = (space: OutlineSpaceRow, userId: string, ops: OutlineOp[]) =>
	writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "human", id: userId },
		responsibleUserId: userId,
	});

const agent = (space: OutlineSpaceRow, narratorId: string, ops: OutlineOp[]) =>
	writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "agent", id: narratorId },
		narratorId,
		responsibleUserId: null,
	});

describe("reads by block past their limits", () => {
	test("more than 500 open changes on the blocks read: marked up to the limit, and said so", async () => {
		const userId = await seedUser();
		let space = await outlineStore.ensureSpace({ kind: "personal", ownerUserId: userId }, NOW);
		const PAGES = 6;
		const PER = 85;
		const N = PAGES * PER;
		const pages: string[] = [];
		const plans: string[] = [];
		for (let k = 0; k < PAGES; k++) {
			const ops: OutlineOp[] = [{ op: "insert", tempId: "p", parent: null, content: `Page ${k}` }];
			for (let j = 0; j < PER; j++)
				ops.push({
					op: "insert",
					parent: { tempId: "p" },
					content: `plan ${k}.${j}`,
					task: { status: "todo" },
				});
			const made = await human(space, userId, ops);
			const ids = made.results.map((r) => r.blockId) as string[];
			pages.push(ids[0] as string);
			plans.push(...ids.slice(1));
		}
		for (const id of plans) await lockOutlineTask({ blockId: id, userId, store: outlineStore });
		const narratorId = await seedNarrator();
		space = await fresh(space);
		for (const [i, id] of plans.entries()) {
			await agent(space, narratorId, [
				{ op: "update", block: { id }, content: `plan ${i} changed` },
			]);
		}
		space = await fresh(space);
		expect((await outlineStore.listOpenPendingBySpace(space.id, 1000)).length).toBe(N);

		const tree = await readOutlineSubtree({
			space,
			rootId: null,
			view: "all",
			budget: { blocks: 800 },
		});
		expect(tree?.blocks.length).toBe(N + PAGES);
		expect(tree?.pendingTruncated).toBe(true);
		expect((tree?.blocks ?? []).filter((block) => block.pending.length > 0).length).toBe(
			OUTLINE_SUBTREE_LIMITS.pendingRows,
		);
		// A read of fewer blocks is whole, and says nothing.
		const one = await readOutlineSubtree({ space, rootId: pages[0] as string, view: "all" });
		expect(one?.pendingTruncated).toBeUndefined();
		expect(one?.blocks.filter((block) => block.pending.length === 1).length).toBe(PER);
		const levels = await readOutlineLevels({
			space,
			parents: pages.map((parentId) => ({ parentId })),
			limit: 800,
		});
		expect(levels.pendingTruncated).toBe(true);
		const marks = await readOutlineMarks({ space, keys: [pages[0] as string, space.id] });
		expect(marks.atLeast).toBe(true);
		expect(marks.marks.map((mark) => mark.key)).toEqual([pages[0] as string, space.id]);
		// A folded read cannot know every row that must stay open, and says so.
		const folded = await readOutlineSubtree({
			space,
			rootId: null,
			view: "all",
			fold: { expanded: new Set(), collapsed: new Set() },
			budget: { blocks: 800 },
		});
		expect(folded?.attentionAtLeast).toBe(true);
		const plain = await readOutlineSubtree({ space, rootId: pages[0] as string, view: "all" });
		expect(plain?.attentionAtLeast).toBeUndefined();
	}, 240_000);

	test("more blocks to walk up than a marks read allows: every live key stays, as a lower bound", async () => {
		const userId = await seedUser();
		const otherUser = await seedUser();
		let space = await outlineStore.ensureSpace({ kind: "personal", ownerUserId: userId }, NOW);
		const other = await outlineStore.ensureSpace({ kind: "personal", ownerUserId: otherUser }, NOW);
		// 450 open tasks, each at the end of its own chain of ten blocks: 4,500 blocks to walk.
		const tops: string[] = [];
		const leaves: string[] = [];
		for (let from = 0; from < 450; from += 18) {
			const ops: OutlineOp[] = [];
			for (let chain = 0; chain < 18; chain++) {
				for (let depth = 0; depth < 10; depth++) {
					ops.push({
						op: "insert",
						tempId: `c${chain}d${depth}`,
						parent: depth === 0 ? null : { tempId: `c${chain}d${depth - 1}` },
						content: `chain ${from + chain} level ${depth}`,
						...(depth === 9 ? { task: { status: "todo" as const } } : {}),
					});
				}
			}
			const made = await human(space, userId, ops);
			const ids = made.results.map((r) => r.blockId as string);
			for (let chain = 0; chain < 18; chain++) {
				tops.push(ids[chain * 10] as string);
				leaves.push(ids[chain * 10 + 9] as string);
			}
		}
		const elsewhere = await human(other, otherUser, [
			{ op: "insert", parent: null, content: "Elsewhere" },
		]);
		const foreign = elsewhere.results[0]?.blockId as string;
		space = await fresh(space);
		const keys = [...tops.slice(0, 60), ...leaves.slice(0, 20), foreign, "no-such-block"];
		const marks = await readOutlineMarks({ space, keys });
		expect(marks.atLeast).toBe(true);
		// Every key that is a live block of the space is answered; the others are not.
		expect(marks.marks.map((mark) => mark.key)).toEqual(keys.slice(0, 80));
		for (const mark of marks.marks) {
			expect(mark.tasks.todo).toBeGreaterThanOrEqual(0);
			expect(mark.tasks.todo).toBeLessThanOrEqual(1);
		}
		// Whatever the cut walk leaves out, a live key is answered: here the store is made to
		// leave the first key's own row out of what it walked.
		const lost = tops[0] as string;
		const cut = new Proxy(outlineStore, {
			get(target, prop, receiver) {
				if (prop !== "listAncestryOf") return Reflect.get(target, prop, receiver);
				return async (spaceId: string, ids: readonly string[], limit: number) => {
					const found = await target.listAncestryOf(spaceId, ids, limit);
					return { rows: found.rows.filter((row) => row.id !== lost), truncated: true };
				};
			},
		});
		const partial = await readOutlineMarks({ space, keys: [lost, tops[1] as string], store: cut });
		expect(partial.atLeast).toBe(true);
		expect(partial.marks.map((mark) => mark.key)).toEqual([lost, tops[1] as string]);
		expect(partial.marks[0]?.tasks.todo).toBe(0);
		// Ids that are not live blocks of the space start no walk: asked alone with a block that
		// is, they do not use up the read.
		const few = await outlineStore.listAncestryOf(
			space.id,
			[foreign, "no-such-block", leaves[0] as string],
			10,
		);
		expect(few.truncated).toBe(false);
		expect(few.rows).toHaveLength(10);
	}, 240_000);
});

describe("a live subtree read that skips blocks", () => {
	test("skipped blocks and what is under them take none of the limit, even where they fill a level", async () => {
		const userId = await seedUser();
		const space = await outlineStore.ensureSpace({ kind: "personal", ownerUserId: userId }, NOW);
		const ops: OutlineOp[] = [{ op: "insert", tempId: "r", parent: null, content: "root" }];
		// Ten skipped blocks first, each with children, then two kept with one child each.
		for (let i = 0; i < 10; i++) {
			ops.push({ op: "insert", tempId: `s${i}`, parent: { tempId: "r" }, content: `SKIP ${i}` });
			for (let j = 0; j < 5; j++)
				ops.push({ op: "insert", parent: { tempId: `s${i}` }, content: `under skip ${i}.${j}` });
		}
		for (let i = 0; i < 2; i++) {
			ops.push({ op: "insert", tempId: `k${i}`, parent: { tempId: "r" }, content: `keep ${i}` });
			ops.push({ op: "insert", parent: { tempId: `k${i}` }, content: `keep child ${i}` });
		}
		const made = await human(space, userId, ops);
		const rootId = made.results[0]?.blockId as string;
		const content = new Map(
			ops.flatMap((op, i) =>
				op.op === "insert" ? [[made.results[i]?.blockId as string, op.content]] : [],
			),
		);
		const skippedIds = new Set(
			[...content].filter(([, text]) => text.startsWith("SKIP")).map(([id]) => id),
		);
		const skip = (row: { id: string }) => skippedIds.has(row.id);
		const texts = (read: Awaited<ReturnType<typeof readLiveSubtree>>) =>
			[...(read?.nodes.keys() ?? [])].filter((id) => id !== rootId).map((id) => content.get(id));

		// Room for exactly the four kept blocks: the skipped ten fill the first read of the level.
		const exact = await readLiveSubtree(space.id, rootId, { limit: 4, skip });
		expect(texts(exact)).toEqual(["keep 0", "keep 1", "keep child 0", "keep child 1"]);
		expect(exact?.truncated).toBe(false);
		// One less: cut, and said so.
		const cut = await readLiveSubtree(space.id, rootId, { limit: 3, skip });
		expect(texts(cut)).toEqual(["keep 0", "keep 1", "keep child 0"]);
		expect(cut?.truncated).toBe(true);
		// Without the skip the same limit reads the skipped blocks.
		const plain = await readLiveSubtree(space.id, rootId, { limit: 4 });
		expect(texts(plain)).toEqual(["SKIP 0", "SKIP 1", "SKIP 2", "SKIP 3"]);
		expect(plain?.truncated).toBe(true);
	});

	test("more skipped blocks than the cap: the read stops and says it was cut", async () => {
		const userId = await seedUser();
		const space = await outlineStore.ensureSpace({ kind: "personal", ownerUserId: userId }, NOW);
		const made = await human(space, userId, [
			{ op: "insert", tempId: "r", parent: null, content: "root" },
		]);
		const rootId = made.results[0]?.blockId as string;
		const total = OUTLINE_LIVE_SUBTREE_MAX_SKIPPED + 50;
		for (let i = 0; i < total; i += 150) {
			const ops: OutlineOp[] = [];
			for (let j = i; j < Math.min(total, i + 150); j++)
				ops.push({ op: "insert", parent: { id: rootId }, content: `SKIP ${j}` });
			await human(space, userId, ops);
		}
		const kept = await human(space, userId, [
			{ op: "insert", parent: { id: rootId }, content: "keep" },
		]);
		const keepId = kept.results[0]?.blockId as string;
		const read = await readLiveSubtree(space.id, rootId, {
			limit: 10,
			skip: (row) => row.id !== keepId,
		});
		// The kept block stands after more skipped ones than the cap: never reached.
		expect(read?.truncated).toBe(true);
		expect([...(read?.nodes.keys() ?? [])]).toEqual([rootId]);
	});
});
