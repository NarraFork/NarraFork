/**
 * The contract of what the reports read and write (汇报, outline P2 PR 11; `store/digest-port.ts`):
 * `last_commit_at` written by the commit that claims the seq and found by its index, the stamp of
 * spaces committed to before the column existed, the versions of a seq range without content,
 * versions as of a seq without content, pending changes by their confirming commit, the search
 * for the last commit before a time, and the report rows (unique per person, kind and day; heads
 * without items; unread; read marks; the latest; deletion and pruning).
 *
 * Written once and run against SQLite (`store-contract.test.ts`) and PostgreSQL
 * (`tests/server/services/outline/pg-outline-store.test.ts`, `PG_INTEGRATION=1`).
 */
import { expect } from "bun:test";
import { seqBefore } from "../digest-job";
import { confirmOutlinePending, lockOutlineTask } from "../pending";
import type { OutlineDigestRow } from "../store/digest-port";
import type { OutlineSpaceRow } from "../store/port";
import { type OutlineOp, writeOutline } from "../write";
import type { OutlineContractContext } from "./contract";

/** The digest cases need to set a space's `last_commit_at` directly (an old space, a race). */
export interface OutlineDigestContractContext extends OutlineContractContext {
	setLastCommitAt(spaceId: string, value: string | null): Promise<void>;
}

/** Far from the other contracts' times, so the spaces committed since then are this case's own. */
const BASE = Date.parse("2091-03-01T00:00:00.000Z");
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();

async function personalSpace(ctx: OutlineContractContext): Promise<OutlineSpaceRow> {
	return await ctx.store.ensureSpace(
		{ kind: "personal", ownerUserId: await ctx.seedUser() },
		at(0),
	);
}

async function write(
	ctx: OutlineContractContext,
	space: OutlineSpaceRow,
	when: string,
	ops: OutlineOp[],
	actor: { kind: "human" | "agent"; id: string } = { kind: "human", id: "u-digest" },
) {
	return await writeOutline(
		{
			spaceId: space.id,
			ops,
			actor,
			responsibleUserId: null,
			narratorId: actor.kind === "agent" ? actor.id : null,
		},
		{ store: ctx.store, now: () => new Date(when) },
	);
}

function digestRow(
	userId: string,
	key: string,
	over: Partial<OutlineDigestRow> = {},
): OutlineDigestRow {
	return {
		id: `d${Math.random().toString(36).slice(2, 12)}`,
		userId,
		kind: "daily",
		periodKey: key,
		timeZone: "UTC",
		periodStart: `${key}T00:00:00.000Z`,
		periodEnd: `${key}T23:59:59.999Z`,
		counts: {
			delegated: 0,
			knowledge: 1,
			tasks: 0,
			plans: 0,
			questions: 0,
			other: 0,
			spaces: 1,
			ownEdits: 0,
		},
		itemCount: 1,
		items: {
			v: 1,
			spaces: [],
			moreSpaces: 0,
			delegated: [],
			knowledge: [],
			tasks: [],
			plans: [],
			questions: [],
			other: [],
			more: { delegated: 0, knowledge: 0, tasks: 0, plans: 0, questions: 0, other: 0 },
		},
		ranges: { s1: [3, 9] },
		truncated: false,
		createdAt: `${key}T07:00:00.000Z`,
		seenAt: null,
		...over,
	};
}

const RANGE_CHANGE_KEYS = [
	"blockId",
	"changeFlags",
	"commitId",
	"contentHash",
	"deleted",
	"hasAsk",
	"pageId",
	"parentId",
	"seq",
	"taskJson",
];

export const OUTLINE_DIGEST_CONTRACT: Array<{
	name: string;
	run(ctx: OutlineDigestContractContext): Promise<void>;
}> = [
	{
		name: "digest: the commit that claims the seq stamps last_commit_at; the index finds it",
		async run(ctx) {
			const a = await personalSpace(ctx);
			const b = await personalSpace(ctx);
			const idle = await personalSpace(ctx);
			await write(ctx, a, at(10), [{ op: "insert", parent: null, content: "a" }]);
			await write(ctx, b, at(20), [{ op: "insert", parent: null, content: "b" }]);
			const ours = new Set([a.id, b.id, idle.id]);
			const since = async (
				when: string,
				options: { limit?: number; after?: { lastCommitAt: string; id: string } } = {},
			) =>
				(
					await ctx.store.listSpacesCommittedSince(when, {
						after: options.after ?? null,
						limit: options.limit ?? 1000,
					})
				)
					.filter((s) => ours.has(s.id))
					.map((s) => [s.id, s.lastCommitAt]);
			expect(await since(at(10))).toEqual([
				[a.id, at(10)],
				[b.id, at(20)],
			]);
			expect(await since(at(20))).toEqual([[b.id, at(20)]]);
			expect(await since(at(21))).toEqual([]);
			// The row a listing returns is a space row like any other, with the time.
			const [found] = (await ctx.store.listSpacesCommittedSince(at(20), { limit: 1000 })).filter(
				(s) => s.id === b.id,
			);
			expect(found).toMatchObject({
				id: b.id,
				key: b.key,
				kind: "personal",
				nextSeq: 2,
				lastCommitAt: at(20),
			});
			// `getSpace` does not carry it (it is the reports' bookkeeping).
			expect("lastCommitAt" in ((await ctx.store.getSpace(b.id)) as object)).toBe(false);
			// A later commit moves it; paging goes on from a cursor.
			await write(ctx, a, at(30), [{ op: "insert", parent: null, content: "a2" }]);
			expect(await since(at(10))).toEqual([
				[b.id, at(20)],
				[a.id, at(30)],
			]);
			expect(await since(at(10), { after: { lastCommitAt: at(20), id: b.id } })).toEqual([
				[a.id, at(30)],
			]);
		},
	},
	{
		name: "digest: spaces committed to before the column existed are stamped from their last commit",
		async run(ctx) {
			const old = await personalSpace(ctx);
			const raced = await personalSpace(ctx);
			const empty = await personalSpace(ctx);
			await write(ctx, old, at(40), [{ op: "insert", parent: null, content: "x" }]);
			await write(ctx, old, at(41), [{ op: "insert", parent: null, content: "y" }]);
			await write(ctx, raced, at(42), [{ op: "insert", parent: null, content: "z" }]);
			await ctx.setLastCommitAt(old.id, null);
			// Stamped meanwhile by a commit: left as it is.
			await ctx.setLastCommitAt(raced.id, at(99));
			for (let i = 0; i < 100 && (await ctx.store.stampUnstampedSpaces(2)) > 0; i++);
			expect(await ctx.store.stampUnstampedSpaces(2)).toBe(0);
			const stamped = new Map(
				(await ctx.store.listSpacesCommittedSince(at(40), { limit: 1000 })).map((s) => [
					s.id,
					s.lastCommitAt,
				]),
			);
			expect(stamped.get(old.id)).toBe(at(41));
			expect(stamped.get(raced.id)).toBe(at(99));
			// A space nobody committed to has nothing to stamp, and is never listed.
			expect(stamped.has(empty.id)).toBe(false);
		},
	},
	{
		name: "digest: the versions of a seq range come without content, bounded and ordered",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const made = await write(ctx, space, at(50), [
				{ op: "insert", tempId: "p", parent: null, content: "Page" },
				{
					op: "insert",
					tempId: "t",
					parent: { tempId: "p" },
					content: "Task",
					task: { status: "todo" },
				},
			]);
			const [page, task] = made.results.map((r) => r.blockId) as [string, string];
			await write(ctx, space, at(51), [
				{ op: "update", block: { id: page }, content: "Page, renamed" },
			]);
			await write(ctx, space, at(52), [
				{
					op: "insert",
					parent: { id: page },
					content: "Which?",
					ask: { to: { kind: "human", id: "u-digest" }, recommend: { text: "this" } },
				},
			]);
			const all = await ctx.store.listCommitRangeChanges(space.id, 0, 3, 100);
			// By seq, then block id bytewise.
			expect(all.map((r) => r.seq)).toEqual([1, 1, 2, 3]);
			expect(all.slice(0, 2).map((r) => r.blockId)).toEqual([page, task].sort());
			expect(all[2]?.blockId).toBe(page);
			for (const row of all) expect(Object.keys(row).sort()).toEqual(RANGE_CHANGE_KEYS);
			expect(all.find((r) => r.blockId === task)?.taskJson?.status).toBe("todo");
			expect(all.map((r) => r.hasAsk)).toEqual([false, false, false, true]);
			expect(all.every((r) => typeof r.contentHash === "string" && r.contentHash.length > 0)).toBe(
				true,
			);
			// `(after, to]`, and the limit.
			expect(
				(await ctx.store.listCommitRangeChanges(space.id, 1, 2, 100)).map((r) => r.seq),
			).toEqual([2]);
			expect(await ctx.store.listCommitRangeChanges(space.id, 3, 3, 100)).toEqual([]);
			expect(await ctx.store.listCommitRangeChanges(space.id, 2, 1, 100)).toEqual([]);
			expect((await ctx.store.listCommitRangeChanges(space.id, 0, 3, 2)).map((r) => r.seq)).toEqual(
				[1, 1],
			);

			// Versions as of a seq, without content; a block not made yet is left out.
			const metas = await ctx.store.listVersionMetasAt([
				{ blockId: page, seq: 1 },
				{ blockId: page, seq: 2 },
				{ blockId: page, seq: 2 },
				{ blockId: task, seq: 0 },
				{ blockId: task, seq: 3 },
			]);
			const bySeq = (seq: number) =>
				metas.filter(
					(m) => m.blockId === page && m.fromSeq <= seq && (m.toSeq === null || m.toSeq > seq),
				);
			expect(metas).toHaveLength(3);
			expect(bySeq(1).map((m) => [m.fromSeq, m.toSeq])).toEqual([[1, 2]]);
			expect(bySeq(2).map((m) => [m.fromSeq, m.toSeq])).toEqual([[2, null]]);
			expect(bySeq(1)[0]?.contentHash).not.toBe(bySeq(2)[0]?.contentHash);
			expect(metas.find((m) => m.blockId === task)?.taskJson?.status).toBe("todo");
			for (const meta of metas) expect("content" in meta).toBe(false);
		},
	},
	{
		name: "digest: a confirmed change is found by its commit, as a head",
		async run(ctx) {
			const person = await ctx.seedUser();
			const agent = await ctx.seedNarrator();
			const delegate = await ctx.seedNarrator();
			const space = await ctx.store.ensureSpace(
				{ kind: "project", projectId: await ctx.seedProject() },
				at(0),
			);
			const made = await writeOutline(
				{
					spaceId: space.id,
					ops: [
						{ op: "insert", tempId: "t", parent: null, content: "Plan", task: { status: "todo" } },
						{
							op: "insert",
							tempId: "s",
							parent: { tempId: "t" },
							content: "Step",
							task: { status: "todo" },
						},
					],
					actor: { kind: "human", id: person },
					responsibleUserId: person,
				},
				{ store: ctx.store, now: () => new Date(at(60)) },
			);
			const [root, step] = made.results.map((r) => r.blockId) as [string, string];
			await lockOutlineTask({
				blockId: root,
				userId: person,
				delegate,
				store: ctx.store,
				now: () => new Date(at(61)),
			});
			const proposed = await writeOutline(
				{
					spaceId: space.id,
					ops: [{ op: "update", block: { id: step }, content: "Step, again" }],
					actor: { kind: "agent", id: agent },
					narratorId: agent,
					responsibleUserId: person,
				},
				{ store: ctx.store, now: () => new Date(at(62)) },
			);
			await confirmOutlinePending({
				pendingId: proposed.pending?.id as string,
				by: { kind: "agent", narratorId: delegate, responsibleUserId: person },
				store: ctx.store,
				now: () => new Date(at(63)),
			});
			const [pending] = await ctx.store.getPending([proposed.pending?.id as string]);
			const found = await ctx.store.getPendingByDecisionCommits([
				pending?.decisionCommitId as string,
				"no-such-commit",
			]);
			expect(found.map((p) => [p.id, p.status, p.deciderUserId, p.decidedByJson?.id])).toEqual([
				[pending?.id, "confirmed", person, delegate],
			]);
			expect("opsJson" in (found[0] as object)).toBe(false);
			expect(await ctx.store.getPendingByDecisionCommits([])).toEqual([]);
		},
	},
	{
		name: "digest: the last commit before a time, by searching the seq index",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const times: number[] = [];
			for (let i = 0; i < 40; i++) {
				// Some commits share a time.
				const minute = 100 + Math.floor(i / 2) * 3;
				times.push(minute);
				await write(ctx, space, at(minute), [{ op: "insert", parent: null, content: `c${i}` }]);
			}
			const row = (await ctx.store.getSpace(space.id)) as OutlineSpaceRow;
			for (const minute of [0, 99, 100, 101, 103, 130, 157, 158, 200]) {
				const t = Date.parse(at(minute));
				const expected = times.filter((m) => Date.parse(at(m)) < t).length;
				expect(await seqBefore(ctx.store, row, t)).toBe(expected);
			}
			expect(await seqBefore(ctx.store, { id: space.id, nextSeq: 1 }, Date.parse(at(500)))).toBe(0);
		},
	},
	{
		name: "digest: report rows are unique per person, kind and day; lists read heads only",
		async run(ctx) {
			const u = await ctx.seedUser();
			const v = await ctx.seedUser();
			const first = digestRow(u, "2091-03-01");
			expect(await ctx.store.insertDigest(first)).toBe(true);
			expect(await ctx.store.insertDigest({ ...digestRow(u, "2091-03-01"), itemCount: 9 })).toBe(
				false,
			);
			expect((await ctx.store.getDigest(first.id))?.itemCount).toBe(1);
			expect(await ctx.store.getDigest("no-such-report")).toBeNull();
			for (const key of ["2091-03-02", "2091-03-03", "2091-03-04"])
				expect(
					await ctx.store.insertDigest(
						digestRow(
							u,
							key,
							key === "2091-03-03" ? { seenAt: `${key}T08:00:00.000Z`, itemCount: 0 } : {},
						),
					),
				).toBe(true);
			expect(await ctx.store.insertDigest(digestRow(v, "2091-03-04"))).toBe(true);
			const got = (await ctx.store.getDigest(first.id)) as OutlineDigestRow;
			expect(got).toEqual(first);

			const heads = await ctx.store.listDigestHeads(u, { kind: "daily", limit: 2 });
			expect(heads.map((h) => h.periodKey)).toEqual(["2091-03-04", "2091-03-03"]);
			for (const head of heads) {
				expect("items" in head).toBe(false);
				expect("ranges" in head).toBe(false);
			}
			expect(
				(
					await ctx.store.listDigestHeads(u, { kind: "daily", before: "2091-03-03", limit: 10 })
				).map((h) => h.periodKey),
			).toEqual(["2091-03-02", "2091-03-01"]);
			expect(await ctx.store.listDigestHeads(u, { kind: "today", limit: 10 })).toEqual([]);

			// Unread: not the one written read; marking is the person's own.
			expect((await ctx.store.listUnseenDigestHeads(u, 10)).map((h) => h.periodKey)).toEqual([
				"2091-03-04",
				"2091-03-02",
				"2091-03-01",
			]);
			expect(await ctx.store.markDigestsSeen(v, [first.id], "2091-03-05T00:00:00.000Z")).toBe(0);
			expect(await ctx.store.markDigestsSeen(u, [first.id], "2091-03-05T00:00:00.000Z")).toBe(1);
			expect(await ctx.store.markDigestsSeen(u, [first.id], "2091-03-05T00:00:00.000Z")).toBe(0);
			expect((await ctx.store.getDigest(first.id))?.seenAt).toBe("2091-03-05T00:00:00.000Z");

			// The latest, with its ranges (what the next day continues from).
			const latest = await ctx.store.getLatestDigestCursor(u, "daily");
			expect([latest?.periodKey, latest?.ranges]).toEqual(["2091-03-04", { s1: [3, 9] }]);
			expect(
				(await ctx.store.getLatestDigestCursor(u, "daily", { beforeKey: "2091-03-02" }))?.periodKey,
			).toBe("2091-03-01");
			expect(await ctx.store.getLatestDigestCursor(u, "today")).toBeNull();

			// A preview is replaced in place, and the others of the person go.
			const p1 = digestRow(u, "2091-03-05", { kind: "today", itemCount: 1 });
			await ctx.store.replaceDigest(p1);
			const p2 = digestRow(u, "2091-03-05", { kind: "today", itemCount: 4 });
			await ctx.store.replaceDigest(p2);
			const previews = await ctx.store.listDigestHeads(u, { kind: "today", limit: 10 });
			expect(previews.map((p) => [p.id, p.itemCount])).toEqual([[p2.id, 4]]);
			await ctx.store.replaceDigest(digestRow(u, "2091-03-06", { kind: "today" }));
			expect(await ctx.store.deleteDigests(u, "today", { exceptId: p2.id })).toBe(1);
			expect(await ctx.store.deleteDigests(u, "today", { atMostKey: "2091-03-05" })).toBe(1);
			expect(await ctx.store.listDigestHeads(u, { kind: "today", limit: 10 })).toEqual([]);

			// Pruning keeps the latest days.
			expect(await ctx.store.pruneDigests(u, "daily", 2)).toBe(2);
			expect(
				(await ctx.store.listDigestHeads(u, { kind: "daily", limit: 10 })).map((h) => h.periodKey),
			).toEqual(["2091-03-04", "2091-03-03"]);
			expect(await ctx.store.pruneDigests(u, "daily", 2)).toBe(0);
			expect((await ctx.store.listDigestHeads(v, { kind: "daily", limit: 10 })).length).toBe(1);
		},
	},
];
