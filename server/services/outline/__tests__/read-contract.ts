/**
 * The outline read contract: as-of reads, rendering through the store, search, timelines,
 * resolution, backlinks and reverts. Written once and run against SQLite
 * (`read-contract.test.ts`) and PostgreSQL (`tests/server/services/outline/pg-outline-store.test.ts`,
 * with `PG_INTEGRATION=1`), with the same context as the store contract (`contract.ts`).
 */
import { expect } from "bun:test";
import { parseMarkdownOutline } from "@shared/outline";
import { OUTLINE_TEXT } from "../messages";
import { OUTLINE_CHANGE, OUTLINE_LIMITS } from "../model";
import {
	commitSeqAt,
	loadBodies,
	readOutline,
	readPageState,
	readPageTimeline,
	readSubtree,
} from "../read";
import { renderOutline, stripReadAnnotations } from "../render";
import { listBacklinks, resolveAddress } from "../resolve";
import { revertCommit } from "../revert";
import { searchOutline } from "../search";
import type { OutlineSpaceRow, OutlineVersionRow } from "../store/port";
import { OUTLINE_PAGE_HEAD_CHARS } from "../store/read-port";
import { type OutlineNode, subtreeNodes } from "../tree";
import type { OutlineOp, OutlineWriteInput, OutlineWriteResult } from "../write";
import { writeOutline } from "../write";
import {
	type ContractCase,
	checkChangeFlags,
	checkSpaceInvariants,
	linkSet,
	type OutlineContractContext,
	randomizedHistory,
	type SnapshotEntry,
	type SpaceDump,
	treeAt,
} from "./contract";

const NOW = "2026-10-26T00:00:00.000Z";
const ACTOR = { kind: "human" as const, id: "user-read-contract" };

async function personalSpace(ctx: OutlineContractContext): Promise<OutlineSpaceRow> {
	return ctx.store.ensureSpace({ kind: "personal", ownerUserId: await ctx.seedUser() }, NOW);
}

function write(
	ctx: OutlineContractContext,
	space: OutlineSpaceRow,
	ops: OutlineOp[],
	extra: Partial<OutlineWriteInput> = {},
): Promise<OutlineWriteResult> {
	return writeOutline(
		{ spaceId: space.id, ops, actor: ACTOR, responsibleUserId: null, ...extra },
		{ store: ctx.store },
	);
}

function revert(ctx: OutlineContractContext, commitId: string) {
	return revertCommit({ commitId, actor: ACTOR, responsibleUserId: null }, { store: ctx.store });
}

/** The id of the first result of a write. */
const a0 = (result: OutlineWriteResult) => result.results[0]?.blockId as string;

/** The id of the second result of a write. */
const a = (result: OutlineWriteResult) => result.results[1]?.blockId as string;

/** Ids of the results of a write, by position. */
function ids(result: OutlineWriteResult): string[] {
	return result.results.map((r) => r.blockId);
}

const tagLines = (links: string) =>
	links
		.split("\n")
		.filter((line) => line.startsWith("tag\u0000"))
		.join("\n");

/**
 * Every page of `expected` read as of `seq` equals it: parents, sibling order, page, content,
 * task, alias and tags; pages not in it do not exist then; subtree reads agree with page reads.
 */
async function expectReadsAt(
	ctx: OutlineContractContext,
	seq: number,
	expected: Map<string, SnapshotEntry>,
	allPages: Iterable<string>,
): Promise<void> {
	const pages = new Set([...expected.values()].map((e) => e.pageId));
	for (const pageId of new Set([...pages, ...allPages])) {
		const state = await readPageState(pageId, { asOf: seq, store: ctx.store });
		if (!pages.has(pageId)) {
			expect(state).toBeNull();
			continue;
		}
		if (!state) throw new Error(`page ${pageId} missing at seq ${seq}`);
		expect(state.seq).toBe(seq);
		expect(state.truncated).toBe(false);
		const nodes = [...state.nodes.values()];
		await loadBodies(state, nodes, { store: ctx.store });
		const want = [...expected].filter(([, e]) => e.pageId === pageId);
		expect(nodes.length).toBe(want.length);
		for (const [id, entry] of want) {
			const node = state.nodes.get(id);
			if (!node) throw new Error(`block ${id} missing from page ${pageId} at seq ${seq}`);
			expect({
				parentId: node.parentId,
				index: node.parent ? node.parent.children.indexOf(node) : entry.index,
				content: node.content,
				task: node.task,
				alias: node.alias,
				tags: linkSet((node.tags ?? []).map((t) => ({ kind: "tag", ...tagTarget(t) }))),
			}).toEqual({
				parentId: entry.parentId,
				index: entry.index,
				content: entry.content,
				task: entry.task,
				alias: entry.alias,
				tags: tagLines(entry.links),
			});
		}
		// Rendering is deterministic and parses back to the same tree.
		const page = state.page as OutlineNode;
		const all = { view: "all" as const, budget: { blocks: 2000, bytes: 256 * 1024 } };
		const rendered = renderOutline(page, all);
		expect(renderOutline(page, all).markdown).toBe(rendered.markdown);
		expect(rendered.hiddenByBudget).toBe(0);
		const parsed = parseMarkdownOutline(stripReadAnnotations(rendered.markdown)).items;
		const contents = (items: typeof parsed): string[] =>
			items.flatMap((item) => [item.content, ...contents(item.children)]);
		const depthFirst = (node: OutlineNode): string[] => [
			node.content ?? "",
			...node.children.flatMap(depthFirst),
		];
		expect(contents(parsed)).toEqual(depthFirst(page));
		// A subtree read sees the same subtree.
		const some = want[Math.floor(want.length / 2)]?.[0] as string;
		const sub = await readSubtree(some, { asOf: seq, store: ctx.store });
		expect(sub?.root.id).toBe(some);
		expect(subtreeNodes(sub?.root as OutlineNode).length).toBe(
			subtreeNodes(state.nodes.get(some) as OutlineNode).length,
		);
	}
}

function tagTarget(target: string) {
	return /^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_-]*$/.test(target)
		? { targetKind: "block", targetRef: target }
		: { targetKind: "text", targetRef: target };
}

/** The snapshots of a space rebuilt from its rows, for every commit seq. */
function snapshotsOf(dump: SpaceDump): Map<number, Map<string, SnapshotEntry>> {
	return new Map(dump.commits.map((c) => [c.seq, treeAt(dump, c.seq)]));
}

/**
 * After reverting commit `seq`: every block the commit touched is either reported skipped or
 * back to its version before the commit in what the commit changed (an alias reported dropped
 * aside); skips for later changes are real.
 */
function checkRevert(
	before: SpaceDump,
	after: SpaceDump,
	seq: number,
	result: Awaited<ReturnType<typeof revertCommit>>,
): void {
	const skipped = new Map(result.skipped.map((s) => [s.blockId, s.reason]));
	const dropped = new Set(
		result.notes.filter((n) => n.adjustment.kind === "alias-dropped").map((n) => n.blockId),
	);
	const versionsOf = (dump: SpaceDump, id: string) =>
		dump.versions.filter((v) => v.blockId === id).sort((a, b) => a.fromSeq - b.fromSeq);
	const blockAfter = new Map(after.blocks.map((b) => [b.id, b]));
	const written = before.versions.filter((v) => v.fromSeq === seq);
	for (const version of written) {
		if ((version.changeFlags & ~OUTLINE_CHANGE.PAGE) === 0) continue;
		const history = versionsOf(before, version.blockId);
		const prev = history.find((v) => v.toSeq === seq) ?? null;
		const laterChange = history.some(
			(v) => v.fromSeq > seq && v.changeFlags !== OUTLINE_CHANGE.PAGE,
		);
		const reason = skipped.get(version.blockId);
		if (laterChange) {
			expect(reason).toBe("changed-later");
			continue;
		}
		expect(reason === "changed-later").toBe(false);
		if (reason !== undefined) continue;
		const now = blockAfter.get(version.blockId);
		if (!now) throw new Error(`block ${version.blockId} vanished`);
		const wasLive = prev !== null && !prev.deleted;
		if (!wasLive) {
			if (!version.deleted) expect(now.deleted).toBe(true);
			continue;
		}
		const p = prev as OutlineVersionRow;
		expect(now.deleted).toBe(false);
		expect(now.parentId).toBe(p.parentId);
		expect(now.contentHash).toBe(p.contentHash);
		expect(now.taskJson).toEqual(p.taskJson);
		if (!dropped.has(version.blockId)) expect(now.alias).toBe(p.alias);
	}
}

export const OUTLINE_READ_CONTRACT: ContractCase[] = [
	{
		name: "aliases: a byte-order range of the live aliases of one space",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const other = await personalSpace(ctx);
			const aliases = ["Q1", "Q10", "Q2", "Qa", "Q", "R1", "q5", "Q9z", "问1", "问12"];
			await write(
				ctx,
				space,
				aliases.map((alias) => ({ op: "insert" as const, parent: null, content: alias, alias })),
			);
			await write(ctx, other, [{ op: "insert", parent: null, content: "x", alias: "Q3" }]);
			const deleted = await write(ctx, space, [
				{ op: "insert", parent: null, content: "gone", alias: "Q4" },
			]);
			await write(ctx, space, [{ op: "delete", block: { id: a0(deleted) } }]);
			const range = (prefix: string, limit = 50) =>
				ctx.store.listAliasRange(space.id, { from: `${prefix}0`, to: `${prefix}:` }, limit);
			expect(await range("Q")).toEqual(["Q1", "Q10", "Q2", "Q9z"]);
			expect(await range("Q", 2)).toEqual(["Q1", "Q10"]);
			expect(await range("问")).toEqual(["问1", "问12"]);
			expect(await range("R")).toEqual(["R1"]);
			expect(await range("Z")).toEqual([]);
		},
	},
	{
		name: "as-of reads: every seq of random histories reads as the model",
		async run(ctx) {
			for (const seed of [11, 12, 13]) {
				const { snapshots } = await randomizedHistory(ctx, seed);
				const allPages = new Set<string>();
				for (const snapshot of snapshots.values()) {
					for (const entry of snapshot.values()) allPages.add(entry.pageId);
				}
				for (const [seq, snapshot] of snapshots) {
					await expectReadsAt(ctx, seq, snapshot, allPages);
				}
			}
		},
	},
	{
		name: "reads: current and as-of, pages and subtrees, moves, deletes, paths, times",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r1 = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "# Plan" },
				{ op: "insert", tempId: "a", parent: { tempId: "p" }, content: "Section **A**" },
				{ op: "insert", tempId: "a1", parent: { tempId: "a" }, content: "detail one" },
				{ op: "insert", tempId: "b", parent: { tempId: "p" }, content: "Section B", alias: "SB" },
				{ op: "insert", tempId: "q", parent: null, content: "Other page" },
			]);
			const [p, a, a1, b, q] = ids(r1) as [string, string, string, string, string];
			await write(ctx, space, [{ op: "update", block: { id: a1 }, content: "detail one, edited" }]);
			await write(ctx, space, [{ op: "move", block: { id: a }, parent: { id: q } }]);
			await write(ctx, space, [{ op: "delete", block: { id: b } }]);
			const s3 = 3;

			const current = await readOutline({ blockId: p, store: ctx.store });
			expect(current?.markdown).toBe("- # Plan");
			expect(current?.seq).toBe(4);
			expect(current?.current).toBe(true);
			const at1 = await readOutline({ blockId: p, asOf: 1, store: ctx.store });
			expect(at1?.markdown).toBe(
				[
					"- # Plan",
					"  - Section **A**",
					"    - detail one",
					"  - Section B",
					"    alias:: SB",
				].join("\n"),
			);
			expect(at1?.current).toBe(false);
			const at2 = await readOutline({ blockId: p, asOf: 2, store: ctx.store });
			expect(at2?.markdown).toContain("detail one, edited");
			// The moved section is on the other page from seq 3 on.
			const onQ = await readOutline({ blockId: q, asOf: s3, store: ctx.store });
			expect(onQ?.markdown).toBe(
				["- Other page", "  - Section **A**", "    - detail one, edited"].join("\n"),
			);
			const focus = await readOutline({ blockId: a1, store: ctx.store });
			expect(focus?.pageId).toBe(q);
			expect(focus?.path.map((x) => x.title)).toEqual(["Other page", "Section A"]);
			const focusAt1 = await readOutline({ blockId: a1, asOf: 1, store: ctx.store });
			expect(focusAt1?.pageId).toBe(p);
			expect(focusAt1?.path.map((x) => x.title)).toEqual(["Plan", "Section A"]);
			expect(focusAt1?.markdown).toBe("- detail one");

			// Deleted now, readable as of before; not there before it was written.
			expect(await readOutline({ blockId: b, store: ctx.store })).toBeNull();
			expect((await readOutline({ blockId: b, asOf: 3, store: ctx.store }))?.rootId).toBe(b);
			expect(await readOutline({ blockId: p, asOf: 0, store: ctx.store })).toBeNull();
			expect(await readOutline({ blockId: "missing-block", store: ctx.store })).toBeNull();
			// A block that is not a page is not read as one.
			expect(await readPageState(a1, { store: ctx.store })).toBeNull();
			// A seq past the last commit reads the last state.
			expect((await readOutline({ blockId: p, asOf: 99, store: ctx.store }))?.seq).toBe(4);
			await expect(readOutline({ blockId: p, asOf: -1, store: ctx.store })).rejects.toThrow();

			// Times map to the last commit made by then.
			expect(await commitSeqAt(space.id, "2000-01-01T00:00:00Z", { store: ctx.store })).toBe(0);
			expect(await commitSeqAt(space.id, new Date(Date.now() + 60_000), { store: ctx.store })).toBe(
				4,
			);
			const commits = await ctx.store.listCommits(space.id, { limit: 10 });
			expect(
				await commitSeqAt(space.id, commits[1]?.createdAt as string, { store: ctx.store }),
			).toBeGreaterThanOrEqual(2);
		},
	},
	{
		name: "reads: facts view, task reads and budgets through the store",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "auth module" },
				{ op: "insert", parent: { tempId: "p" }, content: "token refresh has a race" },
				{
					op: "insert",
					tempId: "t",
					parent: { tempId: "p" },
					content: "fix the refresh logic",
					task: { status: "doing", assignee: "agent:w-auth", due: "2026-11-01" },
					tags: ["Design"],
				},
				{ op: "insert", parent: { tempId: "t" }, content: "plan: reject older versions" },
				{ op: "insert", parent: { tempId: "p" }, content: "刷新令牌只存在服务端" },
			]);
			const [p, , t] = ids(r) as [string, string, string];
			const facts = await readOutline({ blockId: p, store: ctx.store });
			expect(facts?.markdown).toBe(
				[
					"- auth module",
					"  - token refresh has a race",
					"  - 刷新令牌只存在服务端",
					OUTLINE_TEXT.factsOnly(2),
				].join("\n"),
			);
			expect(facts?.hiddenByView).toBe(2);
			expect(facts?.truncated).toBe(false);
			const all = await readOutline({ blockId: p, view: "all", store: ctx.store });
			expect(all?.markdown).toContain(
				[
					"  - [/] fix the refresh logic @agent:w-auth",
					"    due:: 2026-11-01",
					"    tags:: [[Design]]",
					"    - plan: reject older versions",
				].join("\n"),
			);
			const task = await readOutline({ blockId: t, store: ctx.store });
			expect(task?.view).toBe("all");
			expect(task?.markdown.split("\n")).toHaveLength(4);
			const small = await readOutline({ blockId: p, budget: { blocks: 2 }, store: ctx.store });
			expect(small?.truncated).toBe(true);
			expect(small?.markdown).toBe(
				[
					"- auth module",
					"  - token refresh has a race",
					`  ${OUTLINE_TEXT.more(1)}`,
					OUTLINE_TEXT.factsOnly(2),
				].join("\n"),
			);
			// Labels are the caller's.
			const labelled = await readOutline({
				blockId: p,
				label: (node) => `${space.key}/${node.sid}`,
				store: ctx.store,
			});
			expect(labelled?.markdown.startsWith(`- ${space.key}/`)).toBe(true);
		},
	},
	{
		name: "search: readable spaces only, live blocks, facts first, snippets, short queries",
		async run(ctx) {
			const tag = `q${Math.random().toString(36).slice(2, 8)}`;
			const space = await personalSpace(ctx);
			const other = await personalSpace(ctx);
			const session = await ctx.store.ensureSpace(
				{ kind: "session", narratorId: await ctx.seedNarrator() },
				NOW,
			);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: `Garden ${tag}` },
				{ op: "insert", tempId: "s", parent: { tempId: "p" }, content: "Section" },
				{
					op: "insert",
					tempId: "t",
					parent: { tempId: "s" },
					content: `plant ${tag} tulips`,
					task: { status: "todo" },
				},
				{ op: "insert", parent: { tempId: "s" }, content: `plant ${tag} tulips` },
				{
					op: "insert",
					parent: { tempId: "s" },
					content: `${"long text ".repeat(40)}then plant ${tag} roses ${"more ".repeat(40)}`,
				},
				{ op: "insert", tempId: "gone", parent: { tempId: "p" }, content: `deleted ${tag}` },
				{ op: "insert", parent: { tempId: "p" }, content: `设计 ${tag}`, alias: `Z${tag}` },
			]);
			const [page, , taskId, fact] = ids(r) as [string, string, string, string];
			await write(ctx, space, [{ op: "delete", block: { id: r.results[5]?.blockId as string } }]);
			await write(ctx, other, [{ op: "insert", parent: null, content: `plant ${tag} tulips` }]);
			await write(ctx, session, [{ op: "insert", parent: null, content: `plant ${tag} tulips` }]);

			const hits = await searchOutline({
				query: `plant ${tag} tulips`,
				spaceIds: [space.id, session.id],
				contextSpaceId: space.id,
				store: ctx.store,
			});
			// Equally good matches: the fact first, then the task and the session note (process).
			expect(hits.map((h) => h.blockId).slice(0, 1)).toEqual([fact]);
			expect(hits.slice(1, 3).every((h) => h.process)).toBe(true);
			expect(hits.find((h) => h.blockId === taskId)?.task?.blockId).toBe(taskId);
			expect(hits.some((h) => h.spaceId === other.id)).toBe(false);
			const factHit = hits[0];
			expect(factHit?.path).toEqual([`Garden ${tag}`, "Section"]);
			expect(factHit?.address).toBe(`${space.key}/${factHit?.sid}`);
			expect(factHit?.title).toBe(`plant ${tag} tulips`);
			expect(factHit?.process).toBe(false);
			// From the session space, its own notes are not process.
			const fromSession = await searchOutline({
				query: `plant ${tag} tulips`,
				spaceIds: [session.id],
				contextSpaceId: session.id,
				store: ctx.store,
			});
			expect(fromSession.map((h) => h.process)).toEqual([false]);

			// Snippets are cut around the match.
			const roses = await searchOutline({
				query: `${tag} roses`,
				spaceIds: [space.id],
				store: ctx.store,
			});
			expect(roses).toHaveLength(1);
			expect(roses[0]?.snippet).toContain(`${tag} roses`);
			expect(roses[0]?.snippet.startsWith("…")).toBe(true);
			// Deleted blocks are not found.
			expect(
				await searchOutline({ query: `deleted ${tag}`, spaceIds: [space.id], store: ctx.store }),
			).toEqual([]);
			// A short query (two Han characters, no trigram) takes the substring path.
			const short = await searchOutline({ query: "设计", spaceIds: [space.id], store: ctx.store });
			expect(short.map((h) => h.title)).toContain(`设计 ${tag}`);
			// An alias matches exactly, first.
			const alias = await searchOutline({
				query: `Z${tag}`,
				spaceIds: [space.id],
				store: ctx.store,
			});
			expect(alias[0]?.alias).toBe(`Z${tag}`);
			// A page title equal to the query ranks before blocks that only contain it.
			const title = await searchOutline({
				query: `Garden ${tag}`,
				spaceIds: [space.id],
				store: ctx.store,
			});
			expect(title[0]?.blockId).toBe(page);
			expect(await searchOutline({ query: "  ", spaceIds: [space.id], store: ctx.store })).toEqual(
				[],
			);
			expect(await searchOutline({ query: tag, spaceIds: [], store: ctx.store })).toEqual([]);

			// At most 50 results.
			const many = await personalSpace(ctx);
			for (let i = 0; i < 60; i += 30) {
				await write(
					ctx,
					many,
					Array.from({ length: 30 }, (_, k) => ({
						op: "insert" as const,
						parent: null,
						content: `bulk ${tag} item ${i + k}`,
					})),
				);
			}
			const capped = await searchOutline({
				query: `bulk ${tag}`,
				spaceIds: [many.id],
				limit: 500,
				store: ctx.store,
			});
			expect(capped).toHaveLength(50);
			expect(
				await searchOutline({ query: `bulk ${tag}`, spaceIds: [many.id], store: ctx.store }),
			).toHaveLength(20);
		},
	},
	{
		name: "timeline: newest first, cursor pages, moves off the page, other pages left out",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "page P" },
				{ op: "insert", tempId: "x", parent: { tempId: "p" }, content: "x" },
				{ op: "insert", tempId: "q", parent: null, content: "page Q" },
			]);
			const [p, x, q] = ids(r) as [string, string, string];
			const seqs: number[] = [1];
			for (let i = 0; i < 4; i++) {
				const w = await write(ctx, space, [{ op: "update", block: { id: x }, content: `x${i}` }]);
				seqs.push(w.commit?.seq as number);
				await write(ctx, space, [{ op: "update", block: { id: q }, content: `page Q ${i}` }]);
			}
			const moved = await write(ctx, space, [{ op: "move", block: { id: x }, parent: { id: q } }]);
			seqs.push(moved.commit?.seq as number);
			await write(ctx, space, [{ op: "update", block: { id: x }, content: "x on Q" }]);
			const newestFirst = [...seqs].reverse();

			const all = await readPageTimeline(p, { limit: 200, store: ctx.store });
			expect(all?.commits.map((c) => c.seq)).toEqual(newestFirst);
			expect(all?.nextBefore).toBeNull();
			const pages: number[][] = [];
			let before: number | undefined;
			for (let i = 0; i < 10; i++) {
				const page = await readPageTimeline(p, { limit: 2, before, store: ctx.store });
				pages.push(page?.commits.map((c) => c.seq) ?? []);
				if (page?.nextBefore === null) break;
				before = page?.nextBefore;
			}
			expect(pages.flat()).toEqual(newestFirst);
			expect(pages.every((page) => page.length <= 2)).toBe(true);
			// The other page's timeline has the move (blocks arrived) and its own edits.
			const onQ = await readPageTimeline(q, { limit: 200, store: ctx.store });
			expect(onQ?.commits.map((c) => c.seq)).toContain(moved.commit?.seq);
			expect(onQ?.commits.map((c) => c.seq)).not.toContain(seqs[1]);
			expect(await readPageTimeline("missing-page", { store: ctx.store })).toBeNull();
		},
	},
	{
		name: "page lists and block history: sibling order, cursors, heads, newest first",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const long = `Long page ${"x".repeat(OUTLINE_PAGE_HEAD_CHARS * 2)}`;
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "a", parent: null, content: "page A" },
				{ op: "insert", tempId: "b", parent: null, content: long },
				{
					op: "insert",
					tempId: "c",
					parent: null,
					content: "page C",
					task: { status: "todo" },
					alias: "page-c",
				},
				{ op: "insert", tempId: "x", parent: { tempId: "a" }, content: "not a page" },
			]);
			const [a, b, c, x] = ids(r) as [string, string, string, string];
			const d = ids(await write(ctx, space, [{ op: "insert", parent: null, content: "page D" }]));
			await write(ctx, space, [{ op: "delete", block: { id: d[0] as string } }]);

			const all = await ctx.store.listSpacePages(space.id, { limit: 50 });
			expect(all.map((p) => p.id)).toEqual([a, b, c]);
			expect(all[1]?.contentHead.length).toBe(OUTLINE_PAGE_HEAD_CHARS);
			expect(all[1]?.contentHead.startsWith("Long page x")).toBe(true);
			expect(all[2]).toMatchObject({ alias: "page-c", isTask: true, contentHead: "page C" });
			expect(all[0]?.isTask).toBe(false);
			const paged: string[] = [];
			let after: { orderKey: string; id: string } | null = null;
			for (let i = 0; i < 5; i++) {
				const page = await ctx.store.listSpacePages(space.id, { after, limit: 2 });
				paged.push(...page.map((p) => p.id));
				const last = page.at(-1);
				if (page.length < 2 || !last) break;
				after = { orderKey: last.orderKey, id: last.id };
			}
			expect(paged).toEqual([a, b, c]);
			expect(paged).not.toContain(x);

			const seqs = [r.commit?.seq as number];
			for (let i = 0; i < 3; i++) {
				const w = await write(ctx, space, [{ op: "update", block: { id: x }, content: `v${i}` }]);
				seqs.push(w.commit?.seq as number);
			}
			const moved = await write(ctx, space, [{ op: "move", block: { id: x }, parent: { id: c } }]);
			seqs.push(moved.commit?.seq as number);
			const history = await ctx.store.listBlockHistory(x, { limit: 10 });
			expect(history.map((h) => h.fromSeq)).toEqual([...seqs].reverse());
			expect(history[0]).toMatchObject({ pageId: c, toSeq: null, deleted: false });
			expect((history[0]?.changeFlags ?? 0) & OUTLINE_CHANGE.PAGE).toBeTruthy();
			expect((history.at(-1)?.changeFlags ?? 0) & OUTLINE_CHANGE.CREATE).toBeTruthy();
			expect(history.at(-1)?.commitId).toBe(r.commit?.id as string);
			const older = await ctx.store.listBlockHistory(x, { before: history[1]?.fromSeq, limit: 2 });
			expect(older.map((h) => h.fromSeq)).toEqual(history.slice(2, 4).map((h) => h.fromSeq));
			expect(await ctx.store.listBlockHistory("missing-block", { limit: 5 })).toEqual([]);
		},
	},
	{
		name: "resolve: addresses, aliases and titles in order, ambiguity, unreadable spaces",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const other = await personalSpace(ctx);
			const hidden = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "Roadmap" },
				{
					op: "insert",
					tempId: "q",
					parent: { tempId: "p" },
					content: "Q17 details",
					alias: "Q17",
				},
				{ op: "insert", parent: { tempId: "p" }, content: "Roadmap" },
				{ op: "insert", parent: null, content: "Twin" },
				{ op: "insert", parent: null, content: "Twin" },
				{ op: "insert", tempId: "d", parent: { tempId: "p" }, content: "doomed" },
			]);
			const [roadmap, q17, inner] = ids(r) as [string, string, string];
			const doomed = r.results[5] as OutlineWriteResult["results"][number];
			await write(ctx, space, [{ op: "delete", block: { id: doomed.blockId } }]);
			const o = await write(ctx, other, [
				{ op: "insert", parent: null, content: "Elsewhere", alias: "Q17" },
				{ op: "insert", parent: null, content: "Unique other" },
			]);
			await write(ctx, hidden, [{ op: "insert", parent: null, content: "Secret", alias: "S1" }]);
			const ctxt = { spaceId: space.id, readableSpaceIds: [space.id, other.id], store: ctx.store };
			const found = async (ref: string) => {
				const res = await resolveAddress(ref, ctxt);
				return res.status === "found" ? [res.block.id, res.via] : [res.status];
			};
			const q = r.results[1] as OutlineWriteResult["results"][number];
			expect(await found(q.address)).toEqual([q17, "address"]);
			expect(await found(`${space.key}/Q17`)).toEqual([q17, "alias"]);
			expect(await found(`${other.key}/Q17`)).toEqual([o.results[0]?.blockId, "alias"]);
			// Bare names: the context space first.
			expect(await found(q.sid)).toEqual([q17, "sid"]);
			expect(await found("Q17")).toEqual([q17, "alias"]);
			// A title: pages before blocks; several pages are ambiguous.
			expect(await found("Roadmap")).toEqual([roadmap, "title"]);
			expect(await found("roadmap")).toEqual([roadmap, "title"]);
			const twins = await resolveAddress("Twin", ctxt);
			expect(twins.status).toBe("ambiguous");
			expect(twins.status === "ambiguous" ? twins.candidates.length : 0).toBe(2);
			// Other readable spaces when the context space has nothing.
			expect(await found("Unique other")).toEqual([o.results[1]?.blockId, "title"]);
			// Several readable spaces have the alias but the context space does not.
			const fromElsewhere = await resolveAddress("Q17", {
				spaceId: null,
				readableSpaceIds: [space.id, other.id],
				store: ctx.store,
			});
			expect(fromElsewhere.status).toBe("ambiguous");
			// A deleted block is found by its address (for time travel and restores), flagged.
			const gone = await resolveAddress(doomed.address, ctxt);
			expect(gone.status === "found" && gone.block.deleted).toBe(true);
			// An unreadable space is not looked at.
			expect(await found("S1")).toEqual(["not_found"]);
			expect(await found(`${hidden.key}/S1`)).toEqual(["not_found"]);
			expect(await found("no such thing")).toEqual(["not_found"]);
			expect(await found("")).toEqual(["not_found"]);
			expect(inner).not.toBe(roadmap);
		},
	},
	{
		name: "backlinks: addresses, key/alias, aliases and titles that resolve here, readable only",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const other = await personalSpace(ctx);
			const hidden = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "t", parent: null, content: "Target page", alias: "TP" },
				{ op: "insert", parent: null, content: "Target page" },
			]);
			const target = r.results[0] as OutlineWriteResult["results"][number];
			const twin = r.results[1]?.blockId as string;
			const links = await write(ctx, space, [
				{ op: "insert", parent: null, content: `see [[${target.address}]]` },
				{ op: "insert", parent: null, content: `![[${space.key}/TP]]` },
				{ op: "insert", parent: null, content: "about [[TP]]" },
				{
					op: "insert",
					parent: null,
					content: "dep",
					task: { status: "todo", depends: [{ target: "TP", label: null }] },
				},
				{ op: "insert", parent: null, content: "tagged", tags: [target.address] },
				{ op: "insert", tempId: "closed", parent: null, content: `old [[${target.address}]]` },
			]);
			await write(ctx, space, [
				{
					op: "update",
					block: { id: links.results[5]?.blockId as string },
					content: "no link now",
				},
			]);
			await write(ctx, other, [
				{ op: "insert", parent: null, content: `from other [[${target.address}]]` },
				// A bare alias in another space means that space's TP: not a backlink.
				{ op: "insert", parent: null, content: "[[TP]] there" },
			]);
			await write(ctx, hidden, [{ op: "insert", parent: null, content: `[[${target.address}]]` }]);
			const result = await listBacklinks(target.blockId, {
				readableSpaceIds: [space.id, other.id],
				store: ctx.store,
			});
			const kinds = result?.links.map((l) => `${l.kind} ${l.title}`).sort();
			expect(kinds).toEqual(
				[
					"depends dep",
					`embed ${space.key}/TP`,
					"link about TP",
					`link from other ${target.address}`,
					`link see ${target.address}`,
					"tag tagged",
				].sort(),
			);
			expect(result?.truncated).toBe(false);
			const limited = await listBacklinks(target.blockId, {
				readableSpaceIds: [space.id, other.id],
				limit: 2,
				store: ctx.store,
			});
			expect(limited?.links).toHaveLength(2);
			expect(limited?.truncated).toBe(true);
			// The title is ambiguous (two pages): text links by title resolve nowhere.
			await write(ctx, space, [{ op: "insert", parent: null, content: "on [[Target page]]" }]);
			const again = await listBacklinks(target.blockId, {
				readableSpaceIds: [space.id],
				store: ctx.store,
			});
			expect(again?.links.some((l) => l.targetRef === "Target page")).toBe(false);
			await write(ctx, space, [{ op: "delete", block: { id: twin } }]);
			const unique = await listBacklinks(target.blockId, {
				readableSpaceIds: [space.id],
				store: ctx.store,
			});
			expect(unique?.links.some((l) => l.targetRef === "Target page")).toBe(true);
			expect(
				await listBacklinks(target.blockId, { readableSpaceIds: [other.id], store: ctx.store }),
			).toBeNull();
		},
	},
	{
		name: "revert: a compensating commit undoes inserts, edits, moves, tasks, aliases and tags",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r1 = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{
					op: "insert",
					tempId: "a",
					parent: { tempId: "p" },
					content: "A [[Topic]]",
					alias: "AA",
					tags: ["T1"],
				},
				{ op: "insert", tempId: "b", parent: { tempId: "p" }, content: "B" },
				{ op: "insert", tempId: "q", parent: null, content: "page two" },
			]);
			const [p, a, b, q] = ids(r1) as [string, string, string, string];
			const before = treeAt(await ctx.dump(space.id), 1);
			const c = await write(ctx, space, [
				{
					op: "update",
					block: { id: a },
					content: "A changed [[Other]]",
					alias: "AB",
					tags: ["T2"],
				},
				{ op: "move", block: { id: b }, parent: { id: q } },
				{ op: "setTask", block: { id: a }, task: { status: "doing" } },
				{ op: "insert", parent: { id: p }, content: "new child" },
				{ op: "insert", parent: null, content: "Intro\n\n- split one\n- split two" },
			]);
			const result = await revert(ctx, c.commit?.id as string);
			expect(result.skipped).toEqual([]);
			expect(result.notes).toEqual([]);
			expect(result.commit?.seq).toBe(3);
			expect(result.reverted).toEqual({ id: c.commit?.id as string, seq: 2 });
			const dump = await ctx.dump(space.id);
			expect(treeAt(dump, 3)).toEqual(before);
			expect(dump.commits.at(-1)?.kind).toBe("revert");
			expect(dump.commits.at(-1)?.summary).toBe(
				OUTLINE_TEXT.revertSummary(2, dump.commits[1]?.summary as string),
			);
			checkSpaceInvariants(dump);
			checkChangeFlags(dump);
			// Reverting the revert brings the commit back.
			const again = await revert(ctx, result.commit?.id as string);
			expect(again.skipped).toEqual([]);
			const dump2 = await ctx.dump(space.id);
			expect(treeAt(dump2, 4)).toEqual(treeAt(dump2, 2));
			checkSpaceInvariants(dump2);
			checkChangeFlags(dump2);
			expect(b).not.toBe(a);
		},
	},
	{
		name: "revert: restores a deleted subtree; a taken alias is dropped, a taken key moves",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{
					op: "insert",
					tempId: "x",
					parent: { tempId: "p" },
					position: { orderKey: "a5" },
					content: "X",
					alias: "Keep",
					tags: ["T"],
				},
				{
					op: "insert",
					tempId: "x1",
					parent: { tempId: "x" },
					content: "X1 [[Topic]]",
					alias: "Lost",
				},
				{
					op: "insert",
					tempId: "x2",
					parent: { tempId: "x" },
					content: "X2",
					task: { status: "todo", depends: [{ target: "Topic", label: null }] },
				},
				{
					op: "insert",
					tempId: "y",
					parent: { tempId: "p" },
					position: { orderKey: "a7" },
					content: "Y",
				},
			]);
			const [p, x, x1, x2] = ids(r) as [string, string, string, string];
			const del = await write(ctx, space, [{ op: "delete", block: { id: x } }]);
			// Meanwhile: another block takes X1's alias and X's old order key.
			const taker = await write(ctx, space, [
				{
					op: "insert",
					parent: { id: p },
					position: { orderKey: "a5" },
					content: "squatter",
					alias: "Lost",
				},
			]);
			const result = await revert(ctx, del.commit?.id as string);
			expect(result.skipped).toEqual([]);
			expect(result.changed.map((c) => c.blockId).sort()).toEqual([x, x1, x2].sort());
			const notes = result.notes.map((n) => [n.blockId, n.adjustment.kind]).sort();
			expect(notes).toEqual(
				[
					[x, "order-key-moved"],
					[x1, "alias-dropped"],
				].sort(),
			);
			const dropped = result.notes.find((n) => n.adjustment.kind === "alias-dropped");
			expect(dropped?.message).toBe(
				OUTLINE_TEXT.aliasDropped("Lost", taker.results[0]?.address as string),
			);
			const dump = await ctx.dump(space.id);
			checkSpaceInvariants(dump);
			checkChangeFlags(dump);
			const rows = new Map(dump.blocks.map((b) => [b.id, b]));
			expect(rows.get(x)).toMatchObject({ deleted: false, parentId: p, pageId: p, alias: "Keep" });
			expect(rows.get(x1)).toMatchObject({ deleted: false, parentId: x, alias: null });
			expect(rows.get(x2)?.taskJson).toEqual({
				status: "todo",
				assignee: null,
				depends: [{ target: "Topic", label: null }],
			});
			const children = await ctx.store.listChildren(space.id, p, 10);
			expect(children.map((c) => c.content)).toEqual(["squatter", "X", "Y"]);
			const restoredVersion = (await ctx.store.listBlockVersions(x, 10)).at(-1);
			expect((restoredVersion?.changeFlags ?? 0) & OUTLINE_CHANGE.RESTORE).toBe(
				OUTLINE_CHANGE.RESTORE,
			);
			const open = (await ctx.store.listOpenLinks([x, x1, x2], 20))
				.map((l) => `${l.kind} ${l.targetRef}`)
				.sort();
			expect(open).toEqual(["depends Topic", "link Topic", "tag T"]);

			// A restored page recomputes its page id; a restore op on a live block is refused.
			const pageDelete = await write(ctx, space, [{ op: "delete", block: { id: p } }]);
			await write(ctx, space, [{ op: "insert", parent: null, content: "unrelated" }]);
			const back = await revert(ctx, pageDelete.commit?.id as string);
			expect(back.skipped).toEqual([]);
			expect((await ctx.store.getBlock(x1))?.pageId).toBe(p);
			await expect(write(ctx, space, [{ op: "restore", block: { id: x } }])).rejects.toMatchObject({
				code: "OUTLINE_INVALID_OP",
			});
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "restore op: a deleted block comes back as it was, or where it is told to go",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{ op: "insert", tempId: "a", parent: { tempId: "p" }, content: "A" },
				{
					op: "insert",
					tempId: "x",
					parent: { tempId: "p" },
					content: "X [[Topic]]",
					alias: "XA",
					tags: ["T"],
					task: { status: "todo", assignee: "agent:w" },
				},
				{ op: "insert", tempId: "x1", parent: { tempId: "x" }, content: "X1" },
				{ op: "insert", tempId: "b", parent: { tempId: "p" }, content: "B" },
				{ op: "insert", tempId: "q", parent: null, content: "page two" },
			]);
			const [p, , x, x1, , q] = ids(r) as string[];
			const before = await ctx.store.getBlock(x as string);
			await write(ctx, space, [{ op: "delete", block: { id: x as string } }]);
			const back = await write(ctx, space, [{ op: "restore", block: { id: x as string } }]);
			expect(back.results[0]?.adjustments).toBeUndefined();
			const row = await ctx.store.getBlock(x as string);
			expect(row).toMatchObject({
				deleted: false,
				parentId: p,
				orderKey: before?.orderKey,
				alias: "XA",
				taskJson: { status: "todo", assignee: "agent:w" },
			});
			expect(
				(await ctx.store.listChildren(space.id, p as string, 10)).map((c) => c.content),
			).toEqual(["A", "X [[Topic]]", "B"]);
			// Its children stay deleted until restored themselves.
			expect((await ctx.store.getBlock(x1 as string))?.deleted).toBe(true);
			const open = (await ctx.store.listOpenLinks([x as string], 10))
				.map((l) => `${l.kind} ${l.targetRef}`)
				.sort();
			expect(open).toEqual(["link Topic", "tag T"]);
			expect((await ctx.store.listBlockVersions(x as string, 10)).at(-1)?.changeFlags).toBe(
				OUTLINE_CHANGE.RESTORE | OUTLINE_CHANGE.PROPS,
			);

			// Elsewhere, as a page or under another page: the page follows.
			await write(ctx, space, [{ op: "delete", block: { id: x as string } }]);
			const moved = await write(ctx, space, [
				{
					op: "restore",
					block: { id: x as string },
					parent: { id: q as string },
					content: "X again",
				},
				{ op: "restore", block: { id: x1 as string }, alias: "XA" },
			]);
			expect(moved.results[1]?.adjustments).toEqual([
				{ kind: "alias-dropped", alias: "XA", heldBy: x as string },
			]);
			expect(await ctx.store.getBlock(x1 as string)).toMatchObject({
				deleted: false,
				parentId: x,
				pageId: q,
				alias: null,
			});
			expect((await ctx.store.getBlock(x as string))?.content).toBe("X again");
			await expect(
				write(ctx, space, [{ op: "restore", block: { id: a(r) } }]),
			).rejects.toMatchObject({ code: "OUTLINE_INVALID_OP" });
			checkSpaceInvariants(await ctx.dump(space.id));
			checkChangeFlags(await ctx.dump(space.id));
		},
	},
	{
		name: "revert: skips blocks changed later, gone parents, later children and cycles",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{ op: "insert", tempId: "a", parent: { tempId: "p" }, content: "A" },
				{ op: "insert", tempId: "b", parent: { tempId: "p" }, content: "B" },
				{ op: "insert", tempId: "m", parent: { tempId: "p" }, content: "M" },
				{ op: "insert", tempId: "n", parent: { tempId: "m" }, content: "N" },
			]);
			const [p, a, b, m, n] = ids(r) as [string, string, string, string, string];
			// Changed later: the later edit wins, the other block still goes back.
			const edit = await write(ctx, space, [
				{ op: "update", block: { id: a }, content: "A2" },
				{ op: "update", block: { id: b }, content: "B2" },
			]);
			await write(ctx, space, [{ op: "update", block: { id: a }, content: "A3" }]);
			const r1 = await revert(ctx, edit.commit?.id as string);
			expect(r1.skipped.map((s) => [s.blockId, s.reason])).toEqual([[a, "changed-later"]]);
			expect(r1.skipped[0]?.message).toBe(OUTLINE_TEXT.revertSkipped["changed-later"]);
			expect((await ctx.store.getBlock(a))?.content).toBe("A3");
			expect((await ctx.store.getBlock(b))?.content).toBe("B");

			// Later children: a block created by the commit keeps children added since.
			const made = await write(ctx, space, [
				{ op: "insert", tempId: "c", parent: { id: p }, content: "C" },
				{ op: "insert", tempId: "c1", parent: { tempId: "c" }, content: "C1" },
				{ op: "insert", parent: { id: p }, content: "D" },
			]);
			const [c, c1, d] = ids(made) as [string, string, string];
			await write(ctx, space, [{ op: "insert", parent: { id: c1 }, content: "added later" }]);
			const r2 = await revert(ctx, made.commit?.id as string);
			expect(r2.skipped.map((s) => [s.blockId, s.reason]).sort()).toEqual(
				[
					[c, "later-children"],
					[c1, "later-children"],
				].sort(),
			);
			expect((await ctx.store.getBlock(d))?.deleted).toBe(true);
			expect((await ctx.store.getBlock(c))?.deleted).toBe(false);

			// Parent gone: a block moved away goes back only if its old parent is still there.
			const moved = await write(ctx, space, [{ op: "move", block: { id: n }, parent: { id: p } }]);
			await write(ctx, space, [{ op: "delete", block: { id: m } }]);
			const r3 = await revert(ctx, moved.commit?.id as string);
			expect(r3.skipped.map((s) => [s.blockId, s.reason])).toEqual([[n, "parent-gone"]]);
			expect(r3.commit).toBeNull();

			// Cycle: later moves put the old parent under the block itself.
			const s = await write(ctx, space, [
				{ op: "insert", tempId: "x", parent: { id: p }, content: "X" },
				{ op: "insert", tempId: "y", parent: { tempId: "x" }, content: "Y" },
			]);
			const [x, y] = ids(s) as [string, string];
			const out = await write(ctx, space, [{ op: "move", block: { id: y }, parent: { id: p } }]);
			await write(ctx, space, [{ op: "move", block: { id: x }, parent: { id: y } }]);
			const r4 = await revert(ctx, out.commit?.id as string);
			expect(r4.skipped.map((k) => [k.blockId, k.reason])).toEqual([[y, "cycle"]]);
			checkSpaceInvariants(await ctx.dump(space.id));
			checkChangeFlags(await ctx.dump(space.id));
		},
	},
	{
		name: "revert: random commits of random histories keep the invariants and go back exactly",
		async run(ctx) {
			for (const seed of [21, 22]) {
				const { space, snapshots } = await randomizedHistory(ctx, seed);
				const last = Math.max(...snapshots.keys());
				const commits = await ctx.store.listCommits(space.id, { limit: 1000 });
				// The last commit goes back to the state just before it, exactly.
				const lastCommit = commits.find((c) => c.seq === last);
				const back = await revert(ctx, lastCommit?.id as string);
				expect(back.skipped).toEqual([]);
				let dump = await ctx.dump(space.id);
				expect(treeAt(dump, last + 1)).toEqual(snapshots.get(last - 1) ?? new Map());
				checkSpaceInvariants(dump);
				checkChangeFlags(dump);
				// Random earlier commits: each block goes back or is skipped for a stated reason.
				let state = seed;
				const next = () => {
					state = (state * 1103515245 + 12345) % 2147483648;
					return state;
				};
				for (let k = 0; k < 8; k++) {
					const target = commits[next() % commits.length];
					if (!target) continue;
					const before = dump;
					const result = await revert(ctx, target.id);
					dump = await ctx.dump(space.id);
					checkSpaceInvariants(dump);
					checkChangeFlags(dump);
					checkRevert(before, dump, target.seq, result);
				}
				// Every seq, reverts included, reads as the rows say.
				const truth = snapshotsOf(dump);
				const allPages = new Set<string>();
				for (const snapshot of truth.values()) {
					for (const entry of snapshot.values()) allPages.add(entry.pageId);
				}
				const seqs = [...truth.keys()].filter((s) => s > last - 3);
				for (const seq of seqs)
					await expectReadsAt(ctx, seq, truth.get(seq) as Map<string, SnapshotEntry>, allPages);
				expect(dump.blocks.length).toBeLessThan(OUTLINE_LIMITS.maxPageBlocks);
			}
		},
	},
];
