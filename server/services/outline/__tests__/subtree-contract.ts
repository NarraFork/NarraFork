/**
 * The contract of the reads that know no page (`subtree-read.ts`, `subtree-marks.ts`,
 * `subtree-history.ts`) and of what a commit says it changed (`outline:committed`'s `changes`),
 * written once and run against SQLite (`subtree-contract.test.ts`) and PostgreSQL
 * (`tests/server/services/outline/pg-outline-store.test.ts`, `PG_INTEGRATION=1`).
 *
 * The reference is never the code under test: a lazily assembled tree is compared with the
 * page read (`read.ts`) of the same blocks and with the randomized history's own model; a
 * timeline with the model's snapshots; marks with a walk of the whole tree.
 *
 * MAIN-THREAD BUDGET: every service call here goes through a store that counts the level rows
 * it hands out, and no call may take more than the 800 a read as of a seq may cost on the main
 * thread (or more than the budget it was given).
 */
import { expect } from "bun:test";
import { eventBus, type NarraForkEvent } from "@server/lib/event-bus";
import type { OutlineCommitChanges } from "@shared/outline-block-events";
import { OUTLINE_COMMIT_CHANGE_LIMITS } from "@shared/outline-block-events";
import {
	OUTLINE_SUBTREE_LIMITS,
	type OutlineTreeBlock,
	type OutlineTreeLevel,
} from "@shared/outline-subtree-api";
import { convertOutlineHistory } from "../history-convert";
import { lockOutlineTask } from "../pending";
import { loadBodies, readPageState } from "../read";
import type { OutlineSpaceRow, OutlineStore } from "../store/port";
import { OutlineHistoryNotAvailableError } from "../subtree-errors";
import { readOutlineChangedChildren, readOutlineSubtreeTimeline } from "../subtree-history";
import { readOutlineMarks } from "../subtree-marks";
import { readOutlineLevels, readOutlineSubtree } from "../subtree-read";
import { subtreeNodes } from "../tree";
import { type OutlineOp, type OutlineWriteResult, writeOutline } from "../write";
import {
	type ContractCase,
	type OutlineContractContext,
	randomizedHistory,
	type SnapshotEntry,
} from "./contract";

const NOW = "2026-10-26T00:00:00.000Z";
const ACTOR = { kind: "human" as const, id: "user-subtree-contract" };

async function personalSpace(ctx: OutlineContractContext): Promise<OutlineSpaceRow> {
	return ctx.store.ensureSpace({ kind: "personal", ownerUserId: await ctx.seedUser() }, NOW);
}

function write(
	ctx: OutlineContractContext,
	space: OutlineSpaceRow,
	ops: OutlineOp[],
	store: OutlineStore = ctx.store,
): Promise<OutlineWriteResult> {
	return writeOutline({ spaceId: space.id, ops, actor: ACTOR, responsibleUserId: null }, { store });
}

async function fresh(ctx: OutlineContractContext, space: OutlineSpaceRow) {
	return (await ctx.store.getSpace(space.id)) as OutlineSpaceRow;
}

/** A store that counts the level rows it returns, per call of a service. */
function counting(store: OutlineStore): { store: OutlineStore; take(): number } {
	let rows = 0;
	const counted = new Proxy(store, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (prop !== "listLevel" && prop !== "listLevels" && prop !== "listSubtreeAt") return value;
			return async (...args: unknown[]) => {
				const result = await (value as (...a: unknown[]) => Promise<{ rows: unknown[] }>).apply(
					target,
					args,
				);
				rows += result.rows.length;
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

interface Assembled {
	blocks: Map<string, OutlineTreeBlock>;
	/** Children by parent (`""` for the top level), in the order the reads gave them. */
	children: Map<string, string[]>;
	calls: number;
}

const keyOf = (parentId: string | null) => parentId ?? "";

/**
 * A root's whole tree, loaded the way a client does: one budgeted subtree read, then levels
 * (several parents at once from their start; one at a time from a cursor) until nothing says
 * `more` and every block with children has its level.
 */
async function assemble(
	ctx: OutlineContractContext,
	space: OutlineSpaceRow,
	rootId: string | null,
	asOf: number | undefined,
	sizes: { blocks: number; level: number; bytes?: number },
): Promise<Assembled | null> {
	const counter = counting(ctx.store);
	const first = await readOutlineSubtree({
		space,
		rootId,
		asOf,
		view: "all",
		budget: { blocks: sizes.blocks, bytes: sizes.bytes },
		store: counter.store,
	});
	expect(counter.take()).toBeLessThanOrEqual(sizes.blocks);
	if (!first) return null;
	const out: Assembled = { blocks: new Map(), children: new Map(), calls: 1 };
	const started: Array<string | null> = [];
	const continued: Array<{ parentId: string | null; cursor: string }> = [];
	const known = new Set<string>();
	const merge = (blocks: readonly OutlineTreeBlock[], levels: readonly OutlineTreeLevel[]) => {
		for (const block of blocks) {
			expect(out.blocks.has(block.id)).toBe(false);
			out.blocks.set(block.id, block);
		}
		for (const level of levels) {
			const key = keyOf(level.parentId);
			const list = out.children.get(key) ?? [];
			out.children.set(key, [...list, ...level.childIds]);
			known.add(key);
			if (!level.more) continue;
			if (level.nextCursor) continued.push({ parentId: level.parentId, cursor: level.nextCursor });
			else started.push(level.parentId);
		}
		for (const block of blocks) {
			if (block.hasChildren && !known.has(block.id)) {
				known.add(block.id);
				started.push(block.id);
			}
		}
	};
	merge(first.blocks, first.levels);
	if (first.blocks.length === 0 && first.levels.length === 0) return out;
	for (let guard = 0; started.length > 0 || continued.length > 0; guard++) {
		if (guard > 20_000) throw new Error("the lazy read does not end");
		const next = continued.shift();
		const parents = next
			? [{ parentId: next.parentId, cursor: next.cursor }]
			: started.splice(0, 7).map((parentId) => ({ parentId }));
		const read = await readOutlineLevels({
			space,
			parents,
			asOf,
			limit: sizes.level,
			bytes: sizes.bytes,
			store: counter.store,
		});
		expect(counter.take()).toBeLessThanOrEqual(sizes.level);
		expect(read.blocks.length).toBeLessThanOrEqual(sizes.level);
		out.calls++;
		// A level that got nothing this time and says `more` must still make progress later.
		merge(read.blocks, read.levels);
	}
	return out;
}

/** The comparable part of a block. */
function shape(block: {
	parentId: string | null;
	content: string;
	alias: string | null;
	tags: readonly string[];
	status: string | null;
	children: readonly string[];
}) {
	return {
		parentId: block.parentId,
		content: block.content,
		alias: block.alias,
		tags: [...block.tags].sort(),
		status: block.status,
		children: [...block.children],
	};
}

function assembledShapes(tree: Assembled): Map<string, ReturnType<typeof shape>> {
	return new Map(
		[...tree.blocks.values()].map((block) => [
			block.id,
			shape({
				parentId: block.parentId,
				content: block.content,
				alias: block.alias,
				tags: block.tags,
				status: block.task?.status ?? null,
				children: tree.children.get(block.id) ?? [],
			}),
		]),
	);
}

/** A page as the page read gives it (`read.ts`), every block with its content. */
async function pageShapes(
	ctx: OutlineContractContext,
	pageId: string,
	asOf: number | undefined,
): Promise<Map<string, ReturnType<typeof shape>> | null> {
	const state = await readPageState(pageId, { asOf, store: ctx.store });
	if (!state?.page) return null;
	expect(state.truncated).toBe(false);
	const nodes = subtreeNodes(state.page);
	await loadBodies(state, nodes, { store: ctx.store });
	return new Map(
		nodes.map((node) => [
			node.id,
			shape({
				parentId: node.parentId,
				content: node.content ?? "",
				alias: node.alias,
				tags: node.tags ?? [],
				status: node.task?.status ?? null,
				children: node.children.map((child) => child.id),
			}),
		]),
	);
}

function sorted<T>(map: Map<string, T>): Array<[string, T]> {
	return [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function refused(
	read: () => Promise<unknown>,
	reason: "not-ready" | "before-floor",
): Promise<OutlineHistoryNotAvailableError> {
	let error: unknown;
	try {
		await read();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(OutlineHistoryNotAvailableError);
	const typed = error as OutlineHistoryNotAvailableError;
	expect(typed.statusCode).toBe(409);
	expect(typed.details.reason).toBe(reason);
	expect(typed.code).toBe(
		reason === "not-ready" ? "OUTLINE_HISTORY_NOT_READY" : "OUTLINE_HISTORY_BEFORE_FLOOR",
	);
	return typed;
}

async function convert(ctx: OutlineContractContext, space: OutlineSpaceRow): Promise<void> {
	await convertOutlineHistory({
		store: {
			listSpacesPendingEdges: async () => [space],
			backfillEdges: ctx.store.backfillEdges.bind(ctx.store),
			finishEdgeBackfill: ctx.store.finishEdgeBackfill.bind(ctx.store),
		},
	});
}

/** The `outline:committed` events of one space while `run` runs. */
async function committedDuring(
	spaceId: string,
	run: () => Promise<unknown>,
): Promise<Array<Extract<NarraForkEvent, { type: "outline:committed" }>>> {
	const seen: Array<Extract<NarraForkEvent, { type: "outline:committed" }>> = [];
	const listener = (event: Extract<NarraForkEvent, { type: "outline:committed" }>) => {
		if (event.spaceId === spaceId) seen.push(event);
	};
	eventBus.on("outline:committed", listener);
	try {
		await run();
	} finally {
		eventBus.off("outline:committed", listener);
	}
	return seen;
}

const asSets = (changes: OutlineCommitChanges | undefined) => ({
	parentKeys: [...(changes?.parentKeys ?? [])].sort(),
	listParentKeys: [...(changes?.listParentKeys ?? [])].sort(),
	blockIds: [...(changes?.blockIds ?? [])].sort(),
	ancestorIds: [...(changes?.ancestorIds ?? [])].sort(),
	truncated: changes?.truncated,
});

export const OUTLINE_SUBTREE_CONTRACT: ContractCase[] = [
	{
		name: "lazy reads: a tree assembled level by level equals the page read of the same blocks, now and as of any seq",
		async run(ctx) {
			for (const seed of [11, 31337]) {
				const { space: made, snapshots } = await randomizedHistory(ctx, seed);
				const space = await fresh(ctx, made);
				const seqs = [...snapshots.keys()].sort((a, b) => a - b);
				const step = Math.max(1, Math.floor(seqs.length / 6));
				const sample: Array<number | undefined> = [
					undefined,
					...seqs.filter((_, i) => i % step === 0),
					seqs.at(-1),
				];
				for (const [round, asOf] of sample.entries()) {
					const snapshot = snapshots.get(asOf ?? (seqs.at(-1) as number)) as Map<
						string,
						SnapshotEntry
					>;
					// Small and uneven budgets, so every kind of cut happens somewhere.
					const sizes = { blocks: 3 + (round % 5), level: 2 + (round % 4) };
					const whole = await assemble(ctx, space, null, asOf, sizes);
					if (!whole) throw new Error("a space always reads");
					// Against the history's own model: the same blocks, parents, order and content.
					expect([...whole.blocks.keys()].sort()).toEqual([...snapshot.keys()].sort());
					for (const [id, entry] of snapshot) {
						const block = whole.blocks.get(id) as OutlineTreeBlock;
						expect(block.parentId).toBe(entry.parentId);
						expect(block.content).toBe(entry.content);
						expect(block.alias).toBe(entry.alias);
						expect((whole.children.get(keyOf(entry.parentId)) ?? []).indexOf(id)).toBe(entry.index);
					}
					// Against the page read: every page, block for block.
					const shapes = assembledShapes(whole);
					const pages = whole.children.get("") ?? [];
					const fromPages = new Map<string, ReturnType<typeof shape>>();
					for (const pageId of pages) {
						const page = await pageShapes(ctx, pageId, asOf);
						if (!page) throw new Error(`page ${pageId} is in the lazy tree only`);
						for (const [id, value] of page) fromPages.set(id, value);
						// And the page on its own, read lazily as a root with another budget.
						const alone = await assemble(ctx, space, pageId, asOf, {
							blocks: 2 + (round % 3),
							level: 1 + (round % 5),
						});
						if (!alone) throw new Error(`page ${pageId} does not read as a root`);
						expect(sorted(assembledShapes(alone))).toEqual(sorted(page));
					}
					expect(sorted(shapes)).toEqual(sorted(fromPages));
					// Any block as a root: its part of the page, and its ancestors as the path.
					const inner = [...snapshot].filter(([, entry]) => entry.parentId !== null).slice(0, 4);
					for (const [id] of inner) {
						const counter = counting(ctx.store);
						const read = await readOutlineSubtree({
							space,
							rootId: id,
							asOf,
							view: "all",
							store: counter.store,
						});
						expect(counter.take()).toBeLessThanOrEqual(OUTLINE_SUBTREE_LIMITS.maxBlocks);
						if (!read) throw new Error(`block ${id} does not read as a root`);
						const path: string[] = [];
						for (let at = snapshot.get(id)?.parentId; at; at = snapshot.get(at)?.parentId)
							path.unshift(at);
						expect(read.path.map((entry) => entry.id)).toEqual(path);
						expect(read.blocks[0]?.id).toBe(id);
						for (const block of read.blocks) expect(shapes.get(block.id)).toBeDefined();
						const under = new Set([id]);
						for (const block of read.blocks.slice(1))
							if (block.parentId && under.has(block.parentId)) under.add(block.id);
						expect(under.size).toBe(read.blocks.length);
					}
					// A block that was not in the tree then is not a root.
					const all = new Set([...snapshots.values()].flatMap((entries) => [...entries.keys()]));
					const gone = [...all].find((id) => !snapshot.has(id));
					if (gone)
						expect(
							await readOutlineSubtree({ space, rootId: gone, asOf, store: ctx.store }),
						).toBeNull();
				}
			}
		},
	},
	{
		name: "lazy reads: budgets hold, a cut level continues from its cursor, bytes cut a prefix",
		async run(ctx) {
			const space0 = await personalSpace(ctx);
			const made = await write(ctx, space0, [
				{ op: "insert", tempId: "p", parent: null, content: "Page" },
				...Array.from({ length: 30 }, (_, i): OutlineOp[] => [
					{ op: "insert", tempId: `c${i}`, parent: { tempId: "p" }, content: `child ${i}` },
					{
						op: "insert",
						parent: { tempId: `c${i}` },
						content: `grandchild ${i} ${"x".repeat(200)}`,
					},
				]).flat(),
			]);
			const p = made.results[0]?.blockId as string;
			const kids = made.results.filter((_, i) => i % 2 === 1).map((r) => r.blockId as string);
			const space = await fresh(ctx, space0);

			// Breadth first: the root, then its level, before any grandchild.
			const counter = counting(ctx.store);
			const read = await readOutlineSubtree({
				space,
				rootId: p,
				view: "all",
				budget: { blocks: 12 },
				store: counter.store,
			});
			expect(counter.take()).toBeLessThanOrEqual(12);
			expect(read?.blocks.map((b) => b.id)).toEqual([p, ...kids.slice(0, 11)]);
			expect(read?.truncated).toBe(true);
			const level = read?.levels.find((l) => l.parentId === p) as OutlineTreeLevel;
			expect(level.more).toBe(true);
			expect(read?.blocks[0]?.hasChildren).toBe(true);
			// The children it returned say they have children; none of their levels was loaded.
			expect(read?.blocks.slice(1).every((b) => b.hasChildren)).toBe(true);
			expect(read?.levels.filter((l) => l.parentId !== p && l.childIds.length > 0)).toEqual([]);

			// The level continues exactly after the last child, a page at a time.
			const rest: string[] = [];
			let cursor = level.nextCursor;
			while (cursor) {
				const page = await readOutlineLevels({
					space,
					parents: [{ parentId: p, cursor }],
					limit: 8,
					store: counter.store,
				});
				expect(counter.take()).toBeLessThanOrEqual(8);
				const own = page.levels[0] as OutlineTreeLevel;
				rest.push(...own.childIds);
				cursor = own.more ? own.nextCursor : null;
			}
			expect([...kids.slice(0, 11), ...rest]).toEqual(kids);

			// Several parents at once: the limit cuts one, and those after it are not started.
			const several = await readOutlineLevels({
				space,
				parents: kids.slice(0, 5).map((parentId) => ({ parentId })),
				limit: 3,
				store: counter.store,
			});
			expect(counter.take()).toBeLessThanOrEqual(3);
			expect(several.blocks).toHaveLength(3);
			expect(several.levels.map((l) => [l.childIds.length, l.more])).toEqual([
				[1, false],
				[1, false],
				[1, true],
				[0, true],
				[0, true],
			]);
			// One child of each parent (what a closed row's preview is read from).
			const previews = await readOutlineLevels({
				space,
				parents: [{ parentId: p }, { parentId: kids[0] as string }],
				perParent: 1,
				store: counter.store,
			});
			expect(counter.take()).toBe(2);
			expect(previews.levels.map((l) => [l.childIds, l.more])).toEqual([
				[[kids[0]], true],
				[[expect.any(String)], false],
			]);

			// Bytes: a prefix of the order, and the cut level says where it continues.
			const small = await readOutlineSubtree({
				space,
				rootId: kids[0] as string,
				view: "all",
				budget: { blocks: 50, bytes: 20 },
				store: ctx.store,
			});
			expect(small?.blocks.map((b) => b.id)).toEqual([kids[0]]);
			expect(small?.truncated).toBe(true);
			expect(small?.levels).toEqual([
				{ parentId: kids[0], childIds: [], more: true, nextCursor: null, processHidden: 0 },
			]);

			// Nothing asked for is answered past the hard limits.
			const huge = await readOutlineSubtree({
				space,
				rootId: null,
				view: "all",
				budget: { blocks: 1_000_000, bytes: 1e12 },
				store: counter.store,
			});
			expect(counter.take()).toBeLessThanOrEqual(OUTLINE_SUBTREE_LIMITS.maxBlocks);
			expect(huge?.blocks).toHaveLength(61);
			expect(huge?.truncated).toBe(false);
		},
	},
	{
		name: "lazy reads: commits between the pages of a level neither repeat a child nor drop one that stayed",
		async run(ctx) {
			const space0 = await personalSpace(ctx);
			const made = await write(ctx, space0, [
				{ op: "insert", tempId: "p", parent: null, content: "Page" },
				...Array.from(
					{ length: 24 },
					(_, i): OutlineOp => ({
						op: "insert",
						parent: { tempId: "p" },
						content: `child ${i}`,
					}),
				),
			]);
			const p = made.results[0]?.blockId as string;
			const kids = made.results.slice(1).map((r) => r.blockId as string);
			const seqBefore = made.commit?.seq as number;
			let space = await fresh(ctx, space0);

			const first = await readOutlineLevels({
				space,
				parents: [{ parentId: p }],
				limit: 8,
				store: ctx.store,
			});
			const level = first.levels[0] as OutlineTreeLevel;
			expect(level.childIds).toEqual(kids.slice(0, 8));
			// Between pages: one already read goes, one not read yet goes, one arrives at the
			// front, one at the end, and one not read yet moves to the front.
			const changed = await write(ctx, space, [
				{ op: "delete", block: { id: kids[2] as string } },
				{ op: "delete", block: { id: kids[12] as string } },
				{
					op: "insert",
					tempId: "front",
					parent: { id: p },
					position: { first: true },
					content: "front",
				},
				{ op: "insert", tempId: "end", parent: { id: p }, content: "end" },
				{
					op: "move",
					block: { id: kids[20] as string },
					parent: { id: p },
					position: { first: true },
				},
			]);
			const end = changed.results[3]?.blockId as string;
			space = await fresh(ctx, space);
			const seen = [...level.childIds];
			let cursor = level.nextCursor;
			while (cursor) {
				const page = await readOutlineLevels({
					space,
					parents: [{ parentId: p, cursor }],
					limit: 5,
					store: ctx.store,
				});
				const own = page.levels[0] as OutlineTreeLevel;
				seen.push(...own.childIds);
				cursor = own.more ? own.nextCursor : null;
			}
			expect(new Set(seen).size).toBe(seen.length);
			// Everything that stayed where it was is there once, in order; what arrived after the
			// cursor is there; what left before it was reached is not.
			const stayed = kids.filter((_, i) => i !== 12 && i !== 20);
			expect(seen.filter((id) => stayed.includes(id))).toEqual(stayed);
			expect(seen).toContain(end);
			expect(seen).not.toContain(kids[12]);

			// The same level as of the seq before the change: every page the old list, exactly.
			const pinned: string[] = [];
			let at: string | null | undefined;
			do {
				const page = await readOutlineLevels({
					space,
					parents: [{ parentId: p, cursor: at }],
					asOf: seqBefore,
					limit: 7,
					store: ctx.store,
				});
				const own = page.levels[0] as OutlineTreeLevel;
				pinned.push(...own.childIds);
				at = own.more ? own.nextCursor : null;
				// A commit between every two pages of the read as of a seq.
				await write(ctx, space, [{ op: "insert", parent: { id: p }, content: "later" }]);
				space = await fresh(ctx, space);
			} while (at);
			expect(pinned).toEqual(kids);
		},
	},
	{
		name: "history: before the conversion the tree now still reads and history says not ready; after it, below the floor is refused",
		async run(ctx) {
			const space0 = await personalSpace(ctx);
			const made = await write(ctx, space0, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{ op: "insert", tempId: "a", parent: { tempId: "p" }, content: "A" },
				{ op: "insert", tempId: "b", parent: { tempId: "a" }, content: "B" },
			]);
			const [p, a, b] = made.results.map((r) => r.blockId) as [string, string, string];
			await write(ctx, space0, [{ op: "update", block: { id: b }, content: "B, rewritten" }]);
			await write(ctx, space0, [{ op: "move", block: { id: b }, parent: { id: p } }]);
			let space = await fresh(ctx, space0);
			const store = ctx.store;
			const historyReads = (seq: number): Array<() => Promise<unknown>> => [
				() => readOutlineSubtree({ space, rootId: null, asOf: seq, store }),
				() => readOutlineSubtree({ space, rootId: a, asOf: seq, store }),
				() => readOutlineLevels({ space, parents: [{ parentId: p }], asOf: seq, store }),
				() => readOutlineMarks({ space, keys: [p, space.id], since: seq, store }),
				() => readOutlineChangedChildren(space, null, { after: seq, store }),
			];

			await ctx.forgetHistory(space.id);
			for (const read of historyReads(2)) await refused(read, "not-ready");
			await refused(() => readOutlineSubtreeTimeline(space, p, { store }), "not-ready");
			await refused(() => readOutlineSubtreeTimeline(space, null, { store }), "not-ready");
			// The tree as it is now reads all the same, and so do its marks.
			const now = await readOutlineSubtree({ space, rootId: null, view: "all", store });
			expect(now?.blocks.map((block) => block.id).sort()).toEqual([p, a, b].sort());
			expect(now?.current).toBe(true);
			const inner = await readOutlineSubtree({ space, rootId: a, view: "all", store });
			expect(inner?.path.map((entry) => entry.id)).toEqual([p]);
			expect(
				(await readOutlineLevels({ space, parents: [{ parentId: p }], store })).blocks.map(
					(block) => block.id,
				),
			).toEqual([a, b]);
			expect((await readOutlineMarks({ space, keys: [p], store })).marks).toHaveLength(1);

			await convert(ctx, space);
			const floor = (await store.getHistoryStates([space.id])).get(space.id)?.floorSeq as number;
			expect(floor).toBe(3);
			for (const seq of [0, floor - 1]) {
				for (const read of historyReads(seq)) {
					const error = await refused(read, "before-floor");
					expect(error.details).toEqual({ reason: "before-floor", floorSeq: floor, seq });
				}
			}
			await write(ctx, space, [{ op: "update", block: { id: b }, content: "B, after the floor" }]);
			space = await fresh(ctx, space);
			for (const read of historyReads(floor)) await read();
			const atFloor = await readOutlineSubtree({
				space,
				rootId: b,
				asOf: floor,
				view: "all",
				store,
			});
			expect(atFloor?.blocks[0]?.content).toBe("B, rewritten");
			expect(atFloor?.current).toBe(false);
			// The timeline ends at the floor: only what was written after it.
			for (const key of [p, b, null]) {
				const timeline = await readOutlineSubtreeTimeline(space, key, { store });
				expect(timeline.commits.map((commit) => commit.seq)).toEqual([floor + 1]);
				expect(timeline.nextBefore).toBeNull();
				expect(timeline.floorSeq).toBe(floor);
			}
			expect((await readOutlineSubtreeTimeline(space, a, { store })).commits).toEqual([]);
			const marks = await readOutlineMarks({ space, keys: [p, a, b], since: floor, store });
			expect(marks.marks.map((mark) => [mark.key, mark.changed])).toEqual([
				[p, { self: false, below: true }],
				[a, { self: false, below: false }],
				[b, { self: true, below: false }],
			]);
		},
	},
	{
		name: "timeline: any block's commits are those that changed it or anything under it, paged by seq, stable under new commits",
		async run(ctx) {
			const { space: made, snapshots } = await randomizedHistory(ctx, 977);
			let space = await fresh(ctx, made);
			const dump = await ctx.dump(space.id);
			const seqs = [...snapshots.keys()].sort((a, b) => a - b);
			/** Blocks that got a version at each seq. */
			const versioned = new Map<number, string[]>();
			for (const version of dump.versions) {
				const list = versioned.get(version.fromSeq);
				if (list) list.push(version.blockId);
				else versioned.set(version.fromSeq, [version.blockId]);
			}
			// A block's parent at a seq is its version's then, tombstones included: the marks walk
			// up the parent column whether or not a block on the way is deleted.
			const versionsOf = new Map<string, typeof dump.versions>();
			for (const version of dump.versions) {
				const list = versionsOf.get(version.blockId);
				if (list) list.push(version);
				else versionsOf.set(version.blockId, [version]);
			}
			const parentAt = (seq: number, id: string): string | null =>
				versionsOf.get(id)?.find((v) => v.fromSeq <= seq && (v.toSeq === null || v.toSeq > seq))
					?.parentId ?? null;
			const ancestorsAt = (seq: number, id: string): string[] => {
				const out: string[] = [];
				for (let at = parentAt(seq, id); at; at = parentAt(seq, at)) out.push(at);
				return out;
			};
			const expected = new Map<string, Set<number>>();
			const note = (id: string, seq: number) => {
				const set = expected.get(id) ?? new Set<number>();
				set.add(seq);
				expected.set(id, set);
			};
			for (const [index, seq] of seqs.entries()) {
				const before = index > 0 ? (seqs[index - 1] as number) : null;
				for (const id of versioned.get(seq) ?? []) {
					note(id, seq);
					for (const ancestor of ancestorsAt(seq, id)) note(ancestor, seq);
					if (before !== null) for (const ancestor of ancestorsAt(before, id)) note(ancestor, seq);
				}
			}
			const blocks = [...expected.keys()].sort().slice(0, 40);
			for (const [round, id] of blocks.entries()) {
				const want = [...(expected.get(id) as Set<number>)].sort((a, b) => b - a);
				const got: number[] = [];
				let before: number | undefined;
				for (let pages = 0; ; pages++) {
					const page = await readOutlineSubtreeTimeline(space, id, {
						before,
						limit: 1 + (round % 4),
						store: ctx.store,
					});
					expect(page.commits.length).toBeLessThanOrEqual(1 + (round % 4));
					got.push(...page.commits.map((commit) => commit.seq));
					if (page.nextBefore === null) break;
					before = page.nextBefore;
					if (pages === 0 && round % 5 === 0) {
						// A commit between pages is newer than the cursor: older pages do not move.
						await write(ctx, space, [{ op: "insert", parent: null, content: "meanwhile" }]);
						space = await fresh(ctx, space);
					}
				}
				expect(got).toEqual(want);
			}
			// The space's own timeline: every commit, newest first.
			const all: number[] = [];
			let before: number | undefined;
			for (;;) {
				const page = await readOutlineSubtreeTimeline(space, null, {
					before,
					limit: 7,
					store: ctx.store,
				});
				all.push(...page.commits.map((commit) => commit.seq));
				if (page.nextBefore === null) break;
				before = page.nextBefore;
			}
			expect(all).toEqual(
				Array.from({ length: space.nextSeq - 1 }, (_, i) => space.nextSeq - 1 - i),
			);
		},
	},
	{
		name: "marks: what is under any block is counted from the space's open things, and equals a walk of the tree",
		async run(ctx) {
			const space0 = await personalSpace(ctx);
			const asked = await ctx.seedUser();
			const other = await personalSpace(ctx);
			const made = await write(ctx, space0, [
				{ op: "insert", tempId: "p", parent: null, content: "Page" },
				{ op: "insert", tempId: "a", parent: { tempId: "p" }, content: "A" },
				{
					op: "insert",
					tempId: "a1",
					parent: { tempId: "a" },
					content: "a1",
					task: { status: "todo" },
				},
				{
					op: "insert",
					tempId: "a2",
					parent: { tempId: "a1" },
					content: "a2",
					task: { status: "doing" },
				},
				{
					op: "insert",
					tempId: "q",
					parent: { tempId: "a2" },
					content: "Which one?",
					ask: { to: { kind: "human", id: asked }, recommend: {} },
				},
				{ op: "insert", tempId: "b", parent: { tempId: "p" }, content: "B" },
				{
					op: "insert",
					tempId: "b1",
					parent: { tempId: "b" },
					content: "b1",
					task: { status: "done" },
				},
				{
					op: "insert",
					tempId: "b2",
					parent: { tempId: "b" },
					content: "b2",
					task: { status: "todo" },
				},
				{
					op: "insert",
					tempId: "gone",
					parent: { tempId: "b" },
					content: "gone",
					task: { status: "todo" },
				},
				{
					op: "insert",
					tempId: "top",
					parent: null,
					content: "Another",
					task: { status: "doing" },
				},
			]);
			const [p, a, a1, a2, q, b, b1, b2, gone, top] = made.results.map(
				(r) => r.blockId,
			) as string[];
			await write(ctx, space0, [{ op: "delete", block: { id: gone as string } }]);
			const elsewhere = await write(ctx, other, [
				{ op: "insert", parent: null, content: "Elsewhere", task: { status: "todo" } },
			]);
			const foreign = elsewhere.results[0]?.blockId as string;
			let space = await fresh(ctx, space0);
			const store = ctx.store;
			const read = async (keys: string[], since?: number) =>
				readOutlineMarks({ space, keys, since, store });
			const counts = (
				await read([space.id, p, a, a1, a2, q, b, b1, b2, top] as string[])
			).marks.map((mark) => [
				mark.key,
				mark.questions,
				mark.tasks.todo,
				mark.tasks.doing,
				mark.locked,
			]);
			expect(counts).toEqual([
				[space.id, 1, 2, 2, 0],
				[p, 1, 2, 1, 0],
				[a, 1, 1, 1, 0],
				// The block itself is not counted under itself.
				[a1, 1, 0, 1, 0],
				[a2, 1, 0, 0, 0],
				[q, 0, 0, 0, 0],
				[b, 0, 1, 0, 0],
				[b1, 0, 0, 0, 0],
				[b2, 0, 0, 0, 0],
				[top, 0, 0, 0, 0],
			]);
			const base = await read([p as string]);
			expect(base.atLeast).toBe(false);
			expect(base.seq).toBe(space.nextSeq - 1);
			// A deleted block, a block of another space and an id that names nothing: no marks,
			// and nothing of the other space is counted here.
			expect((await read([gone as string, foreign, "no-such-block"])).marks).toEqual([]);
			const otherSpace = await fresh(ctx, other);
			expect(
				(await readOutlineMarks({ space: otherSpace, keys: [p as string, otherSpace.id], store }))
					.marks,
			).toEqual([
				{ key: otherSpace.id, questions: 0, tasks: { todo: 1, doing: 0 }, locked: 0, pending: 0 },
			]);

			// A lock counts where its task counts.
			const locker = await ctx.seedUser();
			await lockOutlineTask({ blockId: b2 as string, userId: locker, store });
			space = await fresh(ctx, space);
			const locked = await read([p, a, b] as string[]);
			expect(locked.marks.map((mark) => mark.locked)).toEqual([1, 0, 1]);

			// Changed since a seq: the block itself, something under it, or neither.
			const since = space.nextSeq - 1;
			await write(ctx, space, [{ op: "update", block: { id: a2 as string }, content: "a2!" }]);
			space = await fresh(ctx, space);
			const changed = await read([space.id, p, a, a1, a2, q, b] as string[], since);
			expect(changed.marks.map((mark) => [mark.key, mark.changed])).toEqual([
				[space.id, { self: false, below: true }],
				[p, { self: false, below: true }],
				[a, { self: false, below: true }],
				[a1, { self: false, below: true }],
				[a2, { self: true, below: false }],
				[q, { self: false, below: false }],
				[b, { self: false, below: false }],
			]);
			// A block moved away still marks where it was, and marks where it went.
			const mid = space.nextSeq - 1;
			await write(ctx, space, [
				{ op: "move", block: { id: a2 as string }, parent: { id: b as string } },
			]);
			space = await fresh(ctx, space);
			const moved = await read([a, a1, b] as string[], mid);
			expect(moved.marks.map((mark) => [mark.key, mark.changed, mark.questions])).toEqual([
				[a, { self: false, below: true }, 0],
				[a1, { self: false, below: true }, 0],
				[b, { self: false, below: true }, 1],
			]);

			// Changed children of a parent: only what differs, with whether to look below.
			const below = await readOutlineChangedChildren(space, p as string, { after: since, store });
			expect(
				below.children.map((child) => [child.blockId, child.self, child.below]).sort(),
			).toEqual(
				[
					[a, false, true],
					[b, false, true],
				].sort(),
			);
			expect(below.upTo).toBe(space.nextSeq - 1);
			expect(
				(await readOutlineChangedChildren(space, foreign, { after: since, store })).children,
			).toEqual([]);
		},
	},
	{
		name: "marks: more open things than one read looks at makes the counts lower bounds, and says so",
		async run(ctx) {
			const space0 = await personalSpace(ctx);
			const total = OUTLINE_SUBTREE_LIMITS.markCandidates + 20;
			const head = await write(ctx, space0, [
				{ op: "insert", tempId: "p", parent: null, content: "Page" },
			]);
			const p = head.results[0]?.blockId as string;
			for (let from = 0; from < total; from += 200) {
				await write(
					ctx,
					space0,
					Array.from(
						{ length: Math.min(200, total - from) },
						(_, i): OutlineOp => ({
							op: "insert",
							parent: { id: p },
							content: `task ${from + i}`,
							task: { status: "todo" },
						}),
					),
				);
			}
			const space = await fresh(ctx, space0);
			const marks = await readOutlineMarks({ space, keys: [p], store: ctx.store });
			expect(marks.atLeast).toBe(true);
			expect(marks.marks[0]?.tasks.todo).toBe(OUTLINE_SUBTREE_LIMITS.markCandidates);
		},
	},
	{
		name: "folded reads: the budget is not spent behind closed rows, and what nobody must miss stays open",
		async run(ctx) {
			const space0 = await personalSpace(ctx);
			const asked = await ctx.seedUser();
			const made = await write(ctx, space0, [
				{ op: "insert", tempId: "p", parent: null, content: "Page" },
				{ op: "insert", tempId: "fact", parent: { tempId: "p" }, content: "A fact" },
				{ op: "insert", tempId: "f1", parent: { tempId: "fact" }, content: "under the fact" },
				{
					op: "insert",
					tempId: "done",
					parent: { tempId: "p" },
					content: "Done",
					task: { status: "done" },
				},
				{ op: "insert", tempId: "d1", parent: { tempId: "done" }, content: "result" },
				{ op: "insert", tempId: "d2", parent: { tempId: "done" }, content: "more" },
				{ op: "insert", tempId: "d3", parent: { tempId: "d1" }, content: "deep" },
				{
					op: "insert",
					tempId: "open",
					parent: { tempId: "p" },
					content: "Open",
					task: { status: "doing" },
				},
				{ op: "insert", tempId: "n", parent: { tempId: "open" }, content: "a note" },
				{ op: "insert", tempId: "n1", parent: { tempId: "n" }, content: "its detail" },
				{ op: "insert", tempId: "n2", parent: { tempId: "n" }, content: "more detail" },
				{
					op: "insert",
					tempId: "done2",
					parent: { tempId: "p" },
					content: "Done too",
					task: { status: "done" },
				},
				{ op: "insert", tempId: "w", parent: { tempId: "done2" }, content: "wrap" },
				{
					op: "insert",
					tempId: "q",
					parent: { tempId: "w" },
					content: "Still open?",
					ask: { to: { kind: "human", id: asked }, recommend: {} },
				},
			]);
			const ids = made.results.map((r) => r.blockId as string);
			const [p, fact, f1, done, d1, d2, d3, open, n, n1, n2, done2, w, q] = ids as [
				string,
				string,
				string,
				string,
				string,
				string,
				string,
				string,
				string,
				string,
				string,
				string,
				string,
				string,
			];
			const space = await fresh(ctx, space0);
			const none = { expanded: new Set<string>(), collapsed: new Set<string>() };
			const counter = counting(ctx.store);
			const read = await readOutlineSubtree({
				space,
				rootId: p,
				view: "all",
				fold: none,
				store: counter.store,
			});
			// The finished task is closed over one child; the open task shows its note, closed over
			// one detail; the finished task hiding a question stays open down to the question.
			expect(counter.take()).toBe(read?.blocks.length ? read.blocks.length - 1 : -1);
			expect(read?.blocks.map((block) => block.id).sort()).toEqual(
				[p, fact, f1, done, d1, open, n, n1, done2, w, q].sort(),
			);
			expect(read?.closed?.sort()).toEqual([done, n].sort());
			const levelOf = (id: string) => read?.levels.find((level) => level.parentId === id);
			expect(levelOf(done)).toMatchObject({ childIds: [d1], more: true });
			expect(levelOf(n)).toMatchObject({ childIds: [n1], more: true });
			// The preview child is not gone below, and says it has children.
			expect(levelOf(d1)).toBeUndefined();
			expect(read?.blocks.find((block) => block.id === d1)?.hasChildren).toBe(true);
			void d2;
			void d3;
			void n2;

			// The reader's own folding goes over the default, both ways.
			const own = await readOutlineSubtree({
				space,
				rootId: p,
				view: "all",
				fold: { expanded: new Set([done]), collapsed: new Set([fact, done2]) },
				store: ctx.store,
			});
			const shown = new Set(own?.blocks.map((block) => block.id));
			expect(shown.has(d2)).toBe(true);
			expect(shown.has(q)).toBe(false);
			expect(own?.closed).toContain(fact);
			expect(own?.closed).toContain(done2);
			// Under the task opened by the reader, its children are details: closed again.
			expect(own?.closed).toContain(d1);

			// The facts view leaves tasks out, and says how many.
			const facts = await readOutlineSubtree({ space, rootId: p, store: ctx.store });
			expect(facts?.view).toBe("facts");
			expect(facts?.blocks.map((block) => block.id)).toEqual([p, fact, f1]);
			expect(facts?.levels.find((level) => level.parentId === p)?.processHidden).toBe(3);
			// A root that is process is read whole whatever was asked.
			const task = await readOutlineSubtree({ space, rootId: open, store: ctx.store });
			expect(task?.view).toBe("all");
			expect(task?.blocks.map((block) => block.id)).toEqual([open, n, n1, n2]);
			const underTask = await readOutlineSubtree({ space, rootId: n, store: ctx.store });
			expect(underTask?.rootInTask).toBe(true);
			expect(underTask?.view).toBe("all");
		},
	},
	{
		name: "commit events: a commit names the parents whose children changed, the changed blocks and their ancestors",
		async run(ctx) {
			const space = await personalSpace(ctx);
			let ids: string[] = [];
			const created = await committedDuring(space.id, async () => {
				const made = await write(ctx, space, [
					{ op: "insert", tempId: "p", parent: null, content: "Page" },
					{ op: "insert", tempId: "a", parent: { tempId: "p" }, content: "A" },
					{ op: "insert", tempId: "b", parent: { tempId: "a" }, content: "B" },
					{ op: "insert", tempId: "x", parent: { tempId: "b" }, content: "X" },
					{ op: "insert", tempId: "c", parent: { tempId: "p" }, content: "C" },
				]);
				ids = made.results.map((r) => r.blockId as string);
			});
			const [p, a, b, x, c] = ids as [string, string, string, string, string];
			expect(created).toHaveLength(1);
			expect(asSets(created[0]?.changes)).toEqual({
				parentKeys: [space.id, p, a, b].sort(),
				listParentKeys: [space.id, p, a, b].sort(),
				blockIds: [p, a, b, x, c].sort(),
				ancestorIds: [p, a, b].sort(),
				truncated: false,
			});

			// Text only: the parent has a changed child, but its list of children did not change.
			const edited = await committedDuring(space.id, () =>
				write(ctx, space, [{ op: "update", block: { id: x }, content: "X, edited" }]),
			);
			expect(asSets(edited[0]?.changes)).toEqual({
				parentKeys: [b],
				listParentKeys: [],
				blockIds: [x],
				ancestorIds: [p, a, b].sort(),
				truncated: false,
			});

			// A move: both parents' lists changed, and the ancestors before and after are named.
			const moved = await committedDuring(space.id, () =>
				write(ctx, space, [{ op: "move", block: { id: x }, parent: { id: c } }]),
			);
			expect(asSets(moved[0]?.changes)).toEqual({
				parentKeys: [b, c].sort(),
				listParentKeys: [b, c].sort(),
				blockIds: [x],
				ancestorIds: [p, a, b, c].sort(),
				truncated: false,
			});
			// The ancestors are exactly the commit's change marks.
			const dump = await ctx.dump(space.id);
			const seq = moved[0]?.seq as number;
			expect(
				dump.marks
					.filter((mark) => mark.seq === seq)
					.map((mark) => mark.ancestorId)
					.sort(),
			).toEqual([p, a, b, c].sort());

			// A top-level block: the space's own key is the parent.
			const top = await committedDuring(space.id, () =>
				write(ctx, space, [{ op: "delete", block: { id: p } }]),
			);
			expect(top[0]?.changes?.parentKeys).toContain(space.id);
			expect(top[0]?.changes?.listParentKeys).toContain(space.id);

			// More than a list holds: cut, and said so.
			// More than a list holds (deleting a parent tombstones every block under it): cut,
			// and said so.
			const page = await write(ctx, space, [{ op: "insert", parent: null, content: "Wide" }]);
			const wideId = page.results[0]?.blockId as string;
			const total = OUTLINE_COMMIT_CHANGE_LIMITS.ids + 5;
			for (let from = 0; from < total; from += 200) {
				await write(
					ctx,
					space,
					Array.from(
						{ length: Math.min(200, total - from) },
						(_, i): OutlineOp => ({
							op: "insert",
							parent: { id: wideId },
							content: `w${from + i}`,
						}),
					),
				);
			}
			const wide = await committedDuring(space.id, () =>
				write(ctx, space, [{ op: "delete", block: { id: wideId } }]),
			);
			expect(wide[0]?.changes?.truncated).toBe(true);
			expect(wide[0]?.changes?.blockIds).toHaveLength(OUTLINE_COMMIT_CHANGE_LIMITS.ids);
			expect(wide[0]?.changes?.parentKeys.sort()).toEqual([space.id, wideId].sort());
		},
	},
];
