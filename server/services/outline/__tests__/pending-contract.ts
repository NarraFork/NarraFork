/**
 * The contract of locked plans and pending confirmation (design §2.2, §2.6; P2 PR 6): which
 * changes an agent's write to a locked tree holds for confirmation, the pending row they become
 * (merged per session and tree), confirming (a `confirm` commit as the proposer), rejecting and
 * withdrawing, the delegate who may confirm and the proposer who may not, unlocking withdrawing
 * what is open, waits, the "in progress" lists of the block view, and what a read shows the
 * proposer (its version) and everyone else (the original). Written once and run against SQLite
 * (`store-contract.test.ts`) and PostgreSQL (`tests/server/services/outline/pg-outline-store.test.ts`,
 * `PG_INTEGRATION=1`).
 */
import { expect } from "bun:test";
import { OutlineWriteError } from "../errors";
import { OUTLINE_PENDING_LIMITS, outlinePendingLabel } from "../model";
import {
	confirmOutlinePending,
	findTasksWaitingForConfirmation,
	lockOutlineTask,
	mergeProposal,
	OutlinePendingError,
	readPendingDiff,
	rejectOutlinePending,
	takePendingReports,
	unlockOutlineTask,
} from "../pending";
import { pendingOps } from "../pending-hold";
import { pendingOverlay } from "../pending-overlay";
import { readOutline } from "../read";
import { stripReadAnnotations } from "../render";
import { revertCommit } from "../revert";
import type { OutlinePendingHead, OutlinePendingRow, OutlineSpaceRow } from "../store/port";
import { deriveOutlineTaskWaits } from "../tasks";
import { readBlockView } from "../views";
import { OUTLINE_LOCK_SCAN, type OutlineOp, type OutlineWriteResult, writeOutline } from "../write";
import { type ContractCase, checkSpaceInvariants, type OutlineContractContext } from "./contract";

const NOW = "2026-10-26T00:00:00.000Z";

type Writer = { kind: "agent"; narratorId: string } | { kind: "human"; userId: string } | "system";

function write(
	ctx: OutlineContractContext,
	space: OutlineSpaceRow,
	writer: Writer,
	ops: OutlineOp[],
): Promise<OutlineWriteResult> {
	const actor =
		writer === "system"
			? { actor: { kind: "system" as const, id: "contract" } }
			: writer.kind === "agent"
				? {
						actor: { kind: "agent" as const, id: writer.narratorId },
						narratorId: writer.narratorId,
					}
				: { actor: { kind: "human" as const, id: writer.userId } };
	return writeOutline(
		{
			spaceId: space.id,
			ops,
			responsibleUserId: writer !== "system" && writer.kind === "human" ? writer.userId : null,
			...actor,
		},
		{ store: ctx.store },
	);
}

/**
 * A locked plan, written by a person (`locker`) and locked by them with `delegate` as the session
 * confirming on their behalf:
 *
 *   - R [ ] Ship the importer          (the lock's root)
 *     - acc  Acceptance: old exports load   (plain block of the plan)
 *     - s1 [ ] Parse the header
 *     - s2 [ ] Load the rows               (a leaf of the plan)
 *   - other  Notes outside the plan      (a page of its own)
 */
async function lockedPlan(ctx: OutlineContractContext, options: { delegate?: boolean } = {}) {
	const lockerId = await ctx.seedUser();
	const locker = { kind: "human" as const, userId: lockerId };
	const space = await ctx.store.ensureSpace({ kind: "personal", ownerUserId: lockerId }, NOW);
	const a = await ctx.seedNarrator();
	const sub = await ctx.seedNarrator({ parentId: a, rootId: a });
	const b = await ctx.seedNarrator();
	const d = await ctx.seedNarrator();
	const r = await write(ctx, space, locker, [
		{
			op: "insert",
			tempId: "r",
			parent: null,
			content: "Ship the importer",
			task: { status: "todo" },
		},
		{
			op: "insert",
			tempId: "acc",
			parent: { tempId: "r" },
			content: "Acceptance: old exports load",
		},
		{
			op: "insert",
			parent: { tempId: "r" },
			content: "Parse the header",
			task: { status: "todo" },
		},
		{ op: "insert", parent: { tempId: "r" }, content: "Load the rows", task: { status: "todo" } },
		{ op: "insert", parent: null, content: "Notes outside the plan" },
	]);
	const [root, acc, s1, s2, other] = r.results.map((x) => x.blockId) as [
		string,
		string,
		string,
		string,
		string,
	];
	await lockOutlineTask({
		blockId: root,
		userId: lockerId,
		delegate: options.delegate ? d : null,
		store: ctx.store,
	});
	return {
		space,
		locker,
		lockerId,
		ids: { root, acc, s1, s2, other },
		a: { kind: "agent" as const, narratorId: a },
		sub: { kind: "agent" as const, narratorId: sub },
		b: { kind: "agent" as const, narratorId: b },
		d: { kind: "agent" as const, narratorId: d },
		narrators: { a, sub, b, d },
	};
}

async function contentOf(ctx: OutlineContractContext, id: string): Promise<string | undefined> {
	return (await ctx.store.getBlock(id))?.content;
}

async function openPending(
	ctx: OutlineContractContext,
	pageId: string,
): Promise<OutlinePendingHead[]> {
	return await ctx.store.listOpenPendingByPage(pageId, 100);
}

async function pendingRow(ctx: OutlineContractContext, id: string): Promise<OutlinePendingRow> {
	const row = (await ctx.store.getPending([id]))[0];
	if (!row) throw new Error(`no pending row ${id}`);
	return row;
}

/** Whether the write held its operations: the indexes held, sorted. */
function held(result: OutlineWriteResult): number[] {
	return [...(result.pending?.opIndexes ?? [])].sort((x, y) => x - y);
}

async function refusedWith<T extends Error>(
	promise: Promise<unknown>,
	type: abstract new (...args: never[]) => T,
): Promise<T> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(type);
		return error as T;
	}
	throw new Error(`expected ${type.name}`);
}

const agent = (narratorId: string) => ({
	kind: "agent" as const,
	narratorId,
	responsibleUserId: null,
});

/** A read of the page as `session`'s reads show it (its own changes laid over, others' marked). */
async function readAs(
	ctx: OutlineContractContext,
	pageId: string,
	session: string,
): Promise<string> {
	const rows = await openPending(ctx, pageId);
	const labeled = <Row extends OutlinePendingHead>(row: Row) => ({
		row,
		label: outlinePendingLabel(row.id),
		decider: "the locker",
	});
	// The reader's own changes whole, laid over the blocks as they are now (as `OutlineRead`).
	const ownIds = rows.filter((r) => r.requesterSession === session).map((r) => r.id);
	const own = [];
	for (const row of ownIds.length > 0 ? await ctx.store.getPending(ownIds) : [])
		own.push({ ...labeled(row), merges: await mergeProposal(ctx.store, row) });
	const overlay = pendingOverlay({
		own,
		others: rows.filter((r) => r.requesterSession !== session).map(labeled),
		text: {
			own: (label, decider) => `pending ${label}: yours, for ${decider}`,
			ownDeleted: (label, decider, n) => `pending ${label}: you delete ${n}, for ${decider}`,
			other: (label, decider) => `pending ${label}: waits for ${decider}`,
			ownMerged: (label, decider) => `pending ${label}: yours merged, for ${decider}`,
			ownConflict: (label, decider, detail) =>
				`pending ${label}: yours in conflict (${detail}), for ${decider}`,
		},
	});
	const read = await readOutline({
		blockId: pageId,
		view: "all",
		store: ctx.store,
		overlay,
		label: (node) => `[${node.sid}]`,
	});
	return read?.markdown ?? "";
}

export const OUTLINE_PENDING_CONTRACT: ContractCase[] = [
	{
		name: "locked plan: each kind of change goes the right way (direct or held), for agents only",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, a, ids } = p;
			const expectHeld = async (ops: OutlineOp[], expected: number[], who: Writer = a) => {
				const r = await write(ctx, space, who, ops);
				expect(held(r)).toEqual(expected);
				return r;
			};
			// Adding: a plain block anywhere, and splitting a leaf, are direct; adding a step is held.
			const note = (
				await expectHeld(
					[{ op: "insert", parent: { id: ids.s1 }, content: "found: header is v2" }],
					[],
				)
			).results[0]?.blockId as string;
			const split = (
				await expectHeld(
					[
						{
							op: "insert",
							parent: { id: ids.s2 },
							content: "rows: batch 1",
							task: { status: "todo" },
						},
					],
					[],
				)
			).results[0]?.blockId as string;
			await expectHeld(
				[{ op: "insert", parent: { id: ids.root }, content: "Step 3", task: { status: "todo" } }],
				[0],
			);
			// Rewriting: the plan (a step, and a plain block of it) is held; what was added since is not.
			await expectHeld(
				[{ op: "update", block: { id: ids.s1 }, content: "Parse the header fast" }],
				[0],
			);
			await expectHeld(
				[{ op: "update", block: { id: ids.acc }, content: "Acceptance: none" }],
				[0],
			);
			await expectHeld([{ op: "update", block: { id: note }, content: "found: v2 header" }], []);
			// Checkboxes: progress is direct; cancelling a step, taking its checkbox, the root done, held.
			await expectHeld([{ op: "setTask", block: { id: ids.s1 }, task: { status: "doing" } }], []);
			await expectHeld([{ op: "setTask", block: { id: ids.s1 }, task: { status: "done" } }], []);
			await expectHeld([{ op: "setTask", block: { id: ids.s1 }, task: { status: "todo" } }], []);
			await expectHeld(
				[{ op: "setTask", block: { id: ids.s1 }, task: { assignee: "agent:w" } }],
				[],
			);
			await expectHeld(
				[{ op: "setTask", block: { id: ids.s1 }, task: { status: "cancelled" } }],
				[0],
			);
			await expectHeld([{ op: "setTask", block: { id: ids.s1 }, task: null }], [0]);
			await expectHeld(
				[{ op: "setTask", block: { id: ids.s1 }, task: { due: "2026-12-01" } }],
				[0],
			);
			await expectHeld([{ op: "setTask", block: { id: split }, task: { due: "2026-12-01" } }], []);
			await expectHeld([{ op: "setTask", block: { id: ids.root }, task: { status: "doing" } }], []);
			await expectHeld([{ op: "setTask", block: { id: ids.root }, task: { status: "done" } }], [0]);
			// Deleting and moving: what holds the plan is held; what was added since is not.
			await expectHeld(
				[
					{
						op: "move",
						block: { id: ids.s2 },
						parent: { id: ids.root },
						position: { first: true },
					},
				],
				[0],
			);
			await expectHeld([{ op: "move", block: { id: note }, parent: { id: ids.acc } }], []);
			await expectHeld([{ op: "move", block: { id: split }, parent: { id: ids.other } }], [0]);
			await expectHeld([{ op: "delete", block: { id: ids.s2 } }], [0]);
			await expectHeld([{ op: "delete", block: { id: note } }], []);
			// Outside the plan, everything is direct.
			await expectHeld(
				[{ op: "update", block: { id: ids.other }, content: "Notes, rewritten" }],
				[],
			);
			// Nothing held was written.
			expect(await contentOf(ctx, ids.s1)).toBe("Parse the header");
			expect(await contentOf(ctx, ids.acc)).toBe("Acceptance: old exports load");
			expect((await ctx.store.getBlock(ids.root))?.taskJson?.status).toBe("doing");
			expect((await ctx.store.getBlock(ids.s2))?.deleted).toBe(false);
			// All of it went into the session's one open change on the tree.
			const rows = await openPending(ctx, ids.root);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.requesterSession).toBe(p.narrators.a);
			expect(rows[0]?.rootBlockId).toBe(ids.root);
			expect(rows[0]?.deciderJson).toEqual({
				by: { kind: "human", id: p.lockerId },
				delegate: null,
			});

			// People write directly (Q2), the locker and anyone else; so does the system.
			const other = { kind: "human" as const, userId: await ctx.seedUser() };
			await expectHeld(
				[{ op: "update", block: { id: ids.s1 }, content: "Parse the header (by a person)" }],
				[],
				other,
			);
			await expectHeld(
				[{ op: "update", block: { id: ids.acc }, content: "Acceptance: loads" }],
				[],
				p.locker,
			);
			await expectHeld(
				[{ op: "update", block: { id: ids.s2 }, content: "Load the rows (system)" }],
				[],
				"system",
			);
			// An agent may not lock or unlock (Q5).
			const denied = await refusedWith(
				write(ctx, space, a, [{ op: "setTask", block: { id: ids.root }, task: { lock: null } }]),
				OutlineWriteError,
			);
			expect(denied.code).toBe("OUTLINE_LOCK_DENIED");
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "locked plan: a call splits into a commit and a pending change; held new blocks take what names them; all held writes no commit",
		async run(ctx) {
			const { space, a, ids } = await lockedPlan(ctx);
			const before = (await ctx.store.getSpace(space.id))?.nextSeq as number;
			const r = await write(ctx, space, a, [
				{ op: "insert", parent: { id: ids.s1 }, content: "progress: half done" },
				{ op: "update", block: { id: ids.s1 }, content: "Parse the header and footer" },
				{
					op: "insert",
					tempId: "t",
					parent: { id: ids.root },
					content: "Write the docs",
					task: { status: "todo" },
				},
				{ op: "insert", parent: { tempId: "t" }, content: "the README" },
				{ op: "insert", parent: { id: ids.s2 }, content: "row batches", task: { status: "todo" } },
			]);
			expect(held(r)).toEqual([1, 2, 3]);
			expect(r.commit?.seq).toBe(before);
			expect(r.results[1]?.pending).toBe(true);
			expect(r.results[0]?.pending).toBeUndefined();
			// The held new blocks have their ids and sids already, and do not exist.
			const docs = r.results[2]?.blockId as string;
			expect(await ctx.store.getBlock(docs)).toBeNull();
			const row = await pendingRow(ctx, r.pending?.id as string);
			const ops = pendingOps(row);
			expect(ops.map((op) => op.op)).toEqual(["update", "insert", "insert"]);
			expect(ops[1]).toMatchObject({
				op: "insert",
				id: docs,
				sid: r.results[2]?.sid,
				parent: { id: ids.root },
			});
			expect(ops[2]).toMatchObject({ op: "insert", parent: { id: docs } });
			expect(row.baseJson[ids.s1]).toBe((await ctx.store.getBlock(ids.s1))?.versionSeq as number);
			// Only the blocks it targets wait; the blocks it adds are listed with their parents.
			expect(row.blockIdsJson).toEqual([ids.s1]);
			expect(row.addsJson).toEqual([
				{ sid: r.results[2]?.sid as string, parentId: ids.root },
				{ sid: r.results[3]?.sid as string, parentId: docs },
			]);
			expect(row.opCount).toBe(3);
			// What the proposer said, nothing made up when it said nothing (readers show the count).
			expect(row.summary).toBe("");
			expect(r.pending).toMatchObject({
				label: outlinePendingLabel(row.id),
				rootBlockId: ids.root,
				merged: false,
			});
			// Only held operations: no commit, the space's counter as it was.
			const seq = (await ctx.store.getSpace(space.id))?.nextSeq as number;
			const only = await write(ctx, space, a, [{ op: "delete", block: { id: ids.s2 } }]);
			expect(only.commit).toBeNull();
			expect(only.pending?.merged).toBe(true);
			expect((await ctx.store.getSpace(space.id))?.nextSeq).toBe(seq);
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "pending: a session's proposals on one tree merge (subagents too), a rewrite's base the version it was written against; another session's is its own",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, a, ids } = p;
			const s1Version = (await ctx.store.getBlock(ids.s1))?.versionSeq as number;
			const first = await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s1 }, content: "v1" },
			]);
			expect((await pendingRow(ctx, first.pending?.id as string)).baseJson[ids.s1]).toBe(s1Version);
			// A person changes it meanwhile; the session rewrites it again, from the text as it is
			// now: the base moves to that version (review S-3), so confirming applies "v2" as is.
			await write(ctx, space, p.locker, [
				{ op: "update", block: { id: ids.s1 }, content: "Parse the header!" },
			]);
			const s1Now = (await ctx.store.getBlock(ids.s1))?.versionSeq as number;
			expect(s1Now).not.toBe(s1Version);
			const second = await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s1 }, content: "v2" },
			]);
			const third = await write(ctx, space, p.sub, [
				{ op: "update", block: { id: ids.acc }, content: "Acceptance: v2" },
			]);
			expect(second.pending?.id).toBe(first.pending?.id);
			expect(third.pending?.id).toBe(first.pending?.id);
			expect(third.pending?.merged).toBe(true);
			const row = await pendingRow(ctx, first.pending?.id as string);
			expect(row.rev).toBe(3);
			expect(row.baseJson[ids.s1]).toBe(s1Now);
			expect(pendingOps(row)).toEqual([
				{ op: "update", block: { id: ids.s1 }, content: "v2" },
				{ op: "update", block: { id: ids.acc }, content: "Acceptance: v2" },
			]);
			// The subagent proposed under its own narrator; its session is its root's.
			expect(row.requestedByJson.narratorId).toBe(p.narrators.sub);
			expect(row.requesterSession).toBe(p.narrators.a);
			const other = await write(ctx, space, p.b, [
				{ op: "update", block: { id: ids.s1 }, content: "b's" },
			]);
			expect(other.pending?.id).not.toBe(first.pending?.id);
			expect(await openPending(ctx, ids.root)).toHaveLength(2);
		},
	},
	{
		name: "confirm: one confirm commit as the proposer, the decider's person responsible; the row confirmed with it; what it adds is the plan",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, a, ids } = p;
			const r = await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s1 }, content: "Parse the header and footer" },
				{
					op: "insert",
					tempId: "n",
					parent: { id: ids.root },
					content: "Write the docs",
					task: { status: "todo" },
				},
			]);
			const pendingId = r.pending?.id as string;
			const added = r.results[1] as { blockId: string; sid: string };
			const done = await confirmOutlinePending({
				pendingId,
				by: { kind: "human", userId: p.lockerId },
				store: ctx.store,
			});
			const commit = await ctx.store.getCommit(done.write.commit?.id as string);
			expect(commit).toMatchObject({
				kind: "confirm",
				actorKind: "agent",
				actorId: p.narrators.a,
				narratorId: p.narrators.a,
				responsibleUserId: p.lockerId,
			});
			expect(commit?.summary).toContain(outlinePendingLabel(pendingId));
			expect(done.row).toMatchObject({
				status: "confirmed",
				decisionCommitId: commit?.id,
				decidedByJson: { kind: "human", id: p.lockerId },
			});
			expect(await contentOf(ctx, ids.s1)).toBe("Parse the header and footer");
			const block = await ctx.store.getBlock(added.blockId);
			expect(block).toMatchObject({
				sid: added.sid,
				parentId: ids.root,
				authorKind: "agent",
				authorId: p.narrators.a,
			});
			// A confirmed block is the plan: the next change to it is held again.
			const again = await write(ctx, space, p.b, [
				{ op: "update", block: { id: added.blockId }, content: "Docs" },
			]);
			expect(held(again)).toEqual([0]);
			// Decided already: no second decision.
			const twice = await refusedWith(
				confirmOutlinePending({
					pendingId,
					by: { kind: "human", userId: p.lockerId },
					store: ctx.store,
				}),
				OutlinePendingError,
			);
			expect(twice.pendingCode).toBe("OUTLINE_PENDING_DECIDED");
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "confirm after the base moved: text that does not overlap is merged; an overlap fails, writes nothing and stays open",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, a, ids } = p;
			const by = { kind: "human" as const, userId: p.lockerId };
			await write(ctx, space, p.locker, [
				{
					op: "update",
					block: { id: ids.s1 },
					content: "Parse the header, then check the version",
				},
			]);
			const r = await write(ctx, space, a, [
				{
					op: "update",
					block: { id: ids.s1 },
					content: "Parse the header, then check the version and the encoding",
				},
			]);
			// The locker edits the start meanwhile; the agent appended at the end.
			await write(ctx, space, p.locker, [
				{
					op: "update",
					block: { id: ids.s1 },
					content: "First parse the header, then check the version",
				},
			]);
			await confirmOutlinePending({ pendingId: r.pending?.id as string, by, store: ctx.store });
			expect(await contentOf(ctx, ids.s1)).toBe(
				"First parse the header, then check the version and the encoding",
			);

			const overlapping = await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s2 }, content: "Load the rows in batches" },
			]);
			await write(ctx, space, p.locker, [
				{ op: "update", block: { id: ids.s2 }, content: "Load the rows twice" },
			]);
			const seq = (await ctx.store.getSpace(space.id))?.nextSeq;
			const failed = await refusedWith(
				confirmOutlinePending({
					pendingId: overlapping.pending?.id as string,
					by,
					store: ctx.store,
				}),
				OutlinePendingError,
			);
			expect(failed.pendingCode).toBe("OUTLINE_PENDING_CONFLICT");
			expect(failed.details.length).toBeGreaterThan(0);
			expect((await ctx.store.getSpace(space.id))?.nextSeq).toBe(seq);
			expect((await pendingRow(ctx, overlapping.pending?.id as string)).status).toBe("open");
			expect(await contentOf(ctx, ids.s2)).toBe("Load the rows twice");
			// A structural change whose target is gone fails the same way.
			const move = await write(ctx, space, p.b, [{ op: "delete", block: { id: ids.acc } }]);
			await write(ctx, space, p.locker, [{ op: "delete", block: { id: ids.acc } }]);
			const gone = await refusedWith(
				confirmOutlinePending({ pendingId: move.pending?.id as string, by, store: ctx.store }),
				OutlinePendingError,
			);
			expect(gone.pendingCode).toBe("OUTLINE_PENDING_CONFLICT");
		},
	},
	{
		name: "reject and withdraw: no commit; the proposer is told once; rejecting its own change withdraws it",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, a, ids } = p;
			const r = await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s1 }, content: "nope" },
			]);
			const seq = (await ctx.store.getSpace(space.id))?.nextSeq;
			const rejected = await rejectOutlinePending({
				pendingId: r.pending?.id as string,
				by: { kind: "human", userId: p.lockerId },
				reason: "keep the header step as it is",
				store: ctx.store,
			});
			expect(rejected).toMatchObject({
				status: "rejected",
				reason: "keep the header step as it is",
				reportedAt: null,
			});
			expect((await ctx.store.getSpace(space.id))?.nextSeq).toBe(seq);
			expect(await contentOf(ctx, ids.s1)).toBe("Parse the header");
			// Told once, on the proposer's next read.
			const told = await takePendingReports(p.narrators.a, { store: ctx.store, pageId: ids.root });
			expect(told.map((row) => row.id)).toEqual([rejected.id]);
			expect(
				await takePendingReports(p.narrators.a, { store: ctx.store, pageId: ids.root }),
			).toEqual([]);
			// A new proposal is a new change; the proposer (a subagent of its session) withdraws it.
			const again = await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s1 }, content: "nope again" },
			]);
			expect(again.pending?.id).not.toBe(rejected.id);
			const withdrawn = await rejectOutlinePending({
				pendingId: again.pending?.id as string,
				by: agent(p.narrators.sub),
				store: ctx.store,
			});
			expect(withdrawn.status).toBe("withdrawn");
			expect(withdrawn.reportedAt).not.toBeNull();
			expect(await openPending(ctx, ids.root)).toEqual([]);
		},
	},
	{
		name: "delegate: the named session (and its subagents) confirms; never its own change, which goes to the locker; others may not decide",
		async run(ctx) {
			const p = await lockedPlan(ctx, { delegate: true });
			const { space, ids } = p;
			const dSub = await ctx.seedNarrator({ parentId: p.narrators.d, rootId: p.narrators.d });
			const byA = await write(ctx, space, p.a, [
				{ op: "update", block: { id: ids.s1 }, content: "a's" },
			]);
			for (const who of [p.narrators.b, p.narrators.a]) {
				const refused = await refusedWith(
					confirmOutlinePending({
						pendingId: byA.pending?.id as string,
						by: agent(who),
						store: ctx.store,
					}),
					OutlinePendingError,
				);
				expect(refused.pendingCode).toBe(
					who === p.narrators.a ? "OUTLINE_PENDING_OWN" : "OUTLINE_PENDING_NOT_DECIDER",
				);
			}
			const done = await confirmOutlinePending({
				pendingId: byA.pending?.id as string,
				by: { kind: "agent", narratorId: dSub, responsibleUserId: p.lockerId },
				store: ctx.store,
			});
			expect(done.row.decidedByJson).toEqual({ kind: "agent", id: dSub });
			expect((await ctx.store.getCommit(done.write.commit?.id as string))?.responsibleUserId).toBe(
				p.lockerId,
			);
			// The delegate's own change: the delegate cannot confirm it; the locker can.
			const byD = await write(ctx, space, p.d, [
				{ op: "update", block: { id: ids.s2 }, content: "d's" },
			]);
			expect(byD.pending?.decider).toEqual({
				by: { kind: "human", id: p.lockerId },
				delegate: p.narrators.d,
			});
			const own = await refusedWith(
				confirmOutlinePending({
					pendingId: byD.pending?.id as string,
					by: agent(dSub),
					store: ctx.store,
				}),
				OutlinePendingError,
			);
			expect(own.pendingCode).toBe("OUTLINE_PENDING_OWN");
			const notMine = await refusedWith(
				confirmOutlinePending({
					pendingId: byD.pending?.id as string,
					by: { kind: "human", userId: await ctx.seedUser() },
					store: ctx.store,
				}),
				OutlinePendingError,
			);
			expect(notMine.pendingCode).toBe("OUTLINE_PENDING_NOT_DECIDER");
			await confirmOutlinePending({
				pendingId: byD.pending?.id as string,
				by: { kind: "human", userId: p.lockerId },
				store: ctx.store,
			});
			expect(await contentOf(ctx, ids.s2)).toBe("d's");
		},
	},
	{
		name: "locks: unlocking or deleting the locked task withdraws open changes in that commit; another person's lock is refused until unlocked; a new delegate keeps them; unlocked, agents write directly",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, a, ids } = p;
			const lockSeq = (await ctx.store.getBlock(ids.root))?.taskJson?.lock?.versionSeq as number;
			const first = await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s1 }, content: "x" },
			]);
			// The same person naming a delegate: the same lock, the change stays open.
			await lockOutlineTask({
				blockId: ids.root,
				userId: p.lockerId,
				delegate: p.narrators.d,
				store: ctx.store,
			});
			const lock = (await ctx.store.getBlock(ids.root))?.taskJson?.lock;
			expect(lock).toEqual({
				by: { kind: "human", id: p.lockerId },
				delegate: p.narrators.d,
				versionSeq: lockSeq,
			});
			expect((await pendingRow(ctx, first.pending?.id as string)).status).toBe("open");
			// Unlocking withdraws it, in the unlocking commit.
			const unlocked = await unlockOutlineTask({
				blockId: ids.root,
				userId: p.lockerId,
				store: ctx.store,
			});
			const row = await pendingRow(ctx, first.pending?.id as string);
			expect(row).toMatchObject({
				status: "withdrawn",
				reason: "unlocked",
				decidedByJson: { kind: "human", id: p.lockerId },
			});
			expect(row.decidedAt).toBe(
				(await ctx.store.getCommit(unlocked.commit?.id as string))?.createdAt as string,
			);
			const direct = await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s1 }, content: "x" },
			]);
			expect(direct.pending).toBeUndefined();
			expect(await contentOf(ctx, ids.s1)).toBe("x");
			// Another person cannot take the lock over (review B-2), by the lock function or a write
			// of their own: the lock and what is open under it stay.
			await lockOutlineTask({ blockId: ids.root, userId: p.lockerId, store: ctx.store });
			const second = await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s1 }, content: "y" },
			]);
			expect(second.pending).toBeDefined();
			const other = await ctx.seedUser();
			const takeover = await refusedWith(
				lockOutlineTask({ blockId: ids.root, userId: other, store: ctx.store }),
				OutlineWriteError,
			);
			expect(takeover.code).toBe("OUTLINE_LOCK_HELD");
			const overWrite = await refusedWith(
				write(ctx, space, { kind: "human", userId: other }, [
					{
						op: "setTask",
						block: { id: ids.root },
						task: { lock: { by: { kind: "human", id: other } } },
					},
				]),
				OutlineWriteError,
			);
			expect(overWrite.code).toBe("OUTLINE_LOCK_HELD");
			// Nor unlock it without the right to (a manager of the space, an admin).
			const denied = await refusedWith(
				unlockOutlineTask({ blockId: ids.root, userId: other, store: ctx.store }),
				OutlineWriteError,
			);
			expect(denied.code).toBe("OUTLINE_LOCK_DENIED");
			expect((await ctx.store.getBlock(ids.root))?.taskJson?.lock?.by.id).toBe(p.lockerId);
			expect((await pendingRow(ctx, second.pending?.id as string)).status).toBe("open");
			// Someone who may unlock does; what was open is withdrawn; then they lock it themselves.
			await unlockOutlineTask({
				blockId: ids.root,
				userId: other,
				mayUnlockAnyone: true,
				store: ctx.store,
			});
			expect(await pendingRow(ctx, second.pending?.id as string)).toMatchObject({
				status: "withdrawn",
				reason: "unlocked",
				decidedByJson: { kind: "human", id: other },
			});
			await lockOutlineTask({ blockId: ids.root, userId: other, store: ctx.store });
			// Deleting the locked task withdraws too.
			const third = await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s1 }, content: "z" },
			]);
			expect(third.pending?.decider.by).toEqual({ kind: "human", id: other });
			await write(ctx, space, { kind: "human", userId: other }, [
				{ op: "delete", block: { id: ids.root } },
			]);
			expect(await pendingRow(ctx, third.pending?.id as string)).toMatchObject({
				status: "withdrawn",
				reason: "lock-deleted",
			});
			expect(await openPending(ctx, ids.root)).toEqual([]);
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "locks: a locked task a person moves to another page takes its open changes with it",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, a, ids } = p;
			const r = await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s1 }, content: "moved along" },
			]);
			await write(ctx, space, p.locker, [
				{ op: "move", block: { id: ids.root }, parent: { id: ids.other } },
			]);
			expect(await openPending(ctx, ids.root)).toEqual([]);
			const moved = await openPending(ctx, ids.other);
			expect(moved.map((row) => row.id)).toEqual([r.pending?.id as string]);
			expect((await pendingRow(ctx, r.pending?.id as string)).pageId).toBe(ids.other);
		},
	},
	{
		name: "nested locks: the nearest lock decides; one call changing two locked plans is refused",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, a, ids } = p;
			const inner = await ctx.seedUser();
			await lockOutlineTask({ blockId: ids.s1, userId: inner, store: ctx.store });
			const r = await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s1 }, content: "inner" },
			]);
			expect(r.pending?.rootBlockId).toBe(ids.s1);
			expect(r.pending?.decider.by).toEqual({ kind: "human", id: inner });
			const both = await refusedWith(
				write(ctx, space, a, [
					{ op: "update", block: { id: ids.s1 }, content: "inner 2" },
					{ op: "update", block: { id: ids.s2 }, content: "outer" },
				]),
				OutlineWriteError,
			);
			expect(both.code).toBe("OUTLINE_LOCKED_MANY");
		},
	},
	{
		name: "concurrency: racing proposals of one session make one open change; a confirmation racing a merge loses nothing",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, ids } = p;
			const results = await Promise.all([
				write(ctx, space, p.a, [{ op: "update", block: { id: ids.s1 }, content: "r1" }]),
				write(ctx, space, p.sub, [{ op: "update", block: { id: ids.s2 }, content: "r2" }]),
				write(ctx, space, p.a, [{ op: "update", block: { id: ids.acc }, content: "r3" }]),
				write(ctx, space, p.b, [{ op: "update", block: { id: ids.acc }, content: "b" }]),
			]);
			const mine = new Set(results.slice(0, 3).map((r) => r.pending?.id));
			expect(mine.size).toBe(1);
			const rows = await openPending(ctx, ids.root);
			expect(rows).toHaveLength(2);
			const head = rows.find((r) => r.requesterSession === p.narrators.a) as OutlinePendingHead;
			const row = await pendingRow(ctx, head.id);
			expect(
				pendingOps(row)
					.map((op) => ("block" in op && "id" in op.block ? op.block.id : ""))
					.sort(),
			).toEqual([ids.s1, ids.s2, ids.acc].sort());
			// A confirmation and a merge into the same change, at once: every proposed operation ends
			// up either committed or still open.
			const [confirmed, merged] = await Promise.allSettled([
				confirmOutlinePending({
					pendingId: row.id,
					by: { kind: "human", userId: p.lockerId },
					store: ctx.store,
				}),
				write(ctx, space, p.a, [
					{ op: "update", block: { id: ids.root }, content: "Ship the importer, v2" },
				]),
			]);
			expect(merged.status).toBe("fulfilled");
			const after = await pendingRow(ctx, row.id);
			if (confirmed.status === "fulfilled") {
				expect(after.status).toBe("confirmed");
				expect(await contentOf(ctx, ids.s1)).toBe("r1");
				const open = await openPending(ctx, ids.root);
				const rootChange = open.find((r) => r.requesterSession === p.narrators.a);
				const rootDone = (await contentOf(ctx, ids.root)) === "Ship the importer, v2";
				expect(rootDone || rootChange !== undefined).toBe(true);
			} else {
				expect(confirmed.reason).toBeInstanceOf(OutlinePendingError);
				expect(after.status).toBe("open");
				expect(pendingOps(after)).toHaveLength(4);
			}
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "waits: a task an open change touches waits for confirmation, the plan's root while its being done waits; others do not",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, a, ids } = p;
			const subjects = async () =>
				(await ctx.store.getBlockMetas(space.id, { ids: [ids.root, ids.s1, ids.s2] })).map((m) => ({
					id: m.id,
					spaceId: m.spaceId,
					taskJson: m.taskJson,
				}));
			expect(await findTasksWaitingForConfirmation(await subjects(), { store: ctx.store })).toEqual(
				new Set(),
			);
			await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s1 }, content: "s1, reworded" },
			]);
			await write(ctx, space, a, [
				{ op: "setTask", block: { id: ids.root }, task: { status: "done" } },
			]);
			const waits = await deriveOutlineTaskWaits(await subjects(), { store: ctx.store });
			expect(waits.get(ids.s1)?.confirmation).toBe(true);
			expect(waits.get(ids.root)?.confirmation).toBe(true);
			expect(waits.get(ids.s2)).toEqual({ prerequisites: [], people: false, confirmation: false });
		},
	},
	{
		name: "acceptance: before confirmation the proposer reads its own version, everyone else the original",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, a, ids } = p;
			const r = await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s1 }, content: "Parse the header (proposed)" },
				{
					op: "insert",
					parent: { id: ids.root },
					content: "Write the docs",
					task: { status: "todo" },
				},
				{ op: "delete", block: { id: ids.s2 } },
				{ op: "insert", parent: { id: ids.s1 }, content: "progress: direct" },
			]);
			const label = outlinePendingLabel(r.pending?.id as string);
			const newSid = r.results[1]?.sid as string;
			const own = await readAs(ctx, ids.root, p.narrators.a);
			const viaSub = await readAs(ctx, ids.root, p.narrators.a);
			const others = await readAs(ctx, ids.root, p.narrators.b);
			// The proposer: its text, its new step, the deleted step gone, each spot marked.
			expect(own).toContain("Parse the header (proposed)");
			expect(own).toContain(`[${newSid}] [ ] Write the docs`);
			expect(own).not.toContain("Load the rows");
			expect(own).toContain(`‹pending ${label}: yours, for the locker›`);
			expect(own).toContain(`‹pending ${label}: you delete 1, for the locker›`);
			expect(own).toContain("progress: direct");
			expect(viaSub).toBe(own);
			// Everyone else: the original, the touched blocks marked.
			expect(others).toContain("Parse the header");
			expect(others).not.toContain("(proposed)");
			expect(others).not.toContain("Write the docs");
			expect(others).toContain("Load the rows");
			expect(others).toContain(`‹pending ${label}: waits for the locker›`);
			expect(others).toContain("progress: direct");
			// Marks are notes: an edit copying the read back drops them.
			expect(stripReadAnnotations(own)).not.toContain("‹pending");
			// Confirmed, everyone reads it, unmarked.
			await confirmOutlinePending({
				pendingId: r.pending?.id as string,
				by: { kind: "human", userId: p.lockerId },
				store: ctx.store,
			});
			const after = await readAs(ctx, ids.root, p.narrators.b);
			expect(after).toContain("Parse the header (proposed)");
			expect(after).toContain(`[${newSid}] [ ] Write the docs`);
			expect(after).not.toContain("Load the rows");
			expect(after).not.toContain("‹pending");
		},
	},
	{
		name: "facts view: a block lists the open tasks under it (in progress), marked when waiting for confirmation; locks and pending ids on blocks",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, a, ids } = p;
			const page = await write(ctx, space, p.locker, [
				{ op: "insert", tempId: "f", parent: null, content: "Importer (facts)" },
				{ op: "insert", tempId: "fact", parent: { tempId: "f" }, content: "Exports are CSV" },
				{
					op: "insert",
					parent: { tempId: "fact" },
					content: "Check quoting",
					task: { status: "doing" },
				},
				{
					op: "insert",
					parent: { tempId: "fact" },
					content: "Old files",
					task: { status: "done" },
				},
				{
					op: "insert",
					parent: { tempId: "fact" },
					content: "Encoding",
					task: { status: "todo", assignee: "agent:w" },
				},
			]);
			const [pageId, fact, quoting, , encoding] = page.results.map((x) => x.blockId) as string[];
			await lockOutlineTask({ blockId: encoding as string, userId: p.lockerId, store: ctx.store });
			await write(ctx, space, a, [
				{ op: "update", block: { id: encoding as string }, content: "Encoding (UTF-8?)" },
			]);
			const view = await readBlockView({
				blockId: pageId as string,
				view: "facts",
				store: ctx.store,
			});
			const factView = view?.blocks.find((b) => b.id === fact);
			expect(factView?.openTasks).toBe(2);
			expect(factView?.inProgress).toEqual([
				{
					id: quoting,
					sid: expect.any(String),
					title: "Check quoting",
					status: "doing",
					assignee: null,
					waiting: false,
				},
				{
					id: encoding,
					sid: expect.any(String),
					title: "Encoding",
					status: "todo",
					assignee: "agent:w",
					waiting: true,
				},
			]);
			const all = await readBlockView({ blockId: pageId as string, view: "all", store: ctx.store });
			const locked = all?.blocks.find((b) => b.id === encoding);
			expect(locked?.lock).toMatchObject({
				blockId: encoding,
				by: { kind: "human", id: p.lockerId },
				delegate: null,
			});
			expect(locked?.pending).toHaveLength(1);
			const plan = await readBlockView({ blockId: ids.root, view: "all", store: ctx.store });
			expect(plan?.blocks.find((b) => b.id === ids.root)?.lock?.by.id).toBe(p.lockerId);
		},
	},
	{
		name: "locked plan: a block becoming a task in the tree adds a step (review B-1): with its checkbox at once or later, under a plain block of the plan or a new one, restored or moved in; splitting a leaf, or under a task not of the plan, is direct",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, a, ids } = p;
			const taskKids = async (id: string) =>
				(await ctx.store.listChildMetas(space.id, [id], 100)).filter(
					(m) => !m.deleted && m.taskJson,
				).length;
			const before = await taskKids(ids.root);
			// A plain block and its checkbox in one call: the new task is held (and what names it).
			const once = await write(ctx, space, a, [
				{ op: "insert", tempId: "n", parent: { id: ids.root }, content: "Step three" },
				{ op: "setTask", block: { tempId: "n" }, task: { status: "todo" } },
			]);
			expect(held(once)).toEqual([0, 1]);
			// A plain block written directly, its checkbox given in a later call: held then.
			const plain = await write(ctx, space, a, [
				{ op: "insert", parent: { id: ids.root }, content: "Step four" },
			]);
			expect(plain.pending).toBeUndefined();
			const checkbox = await write(ctx, space, a, [
				{
					op: "setTask",
					block: { id: plain.results[0]?.blockId as string },
					task: { status: "todo" },
				},
			]);
			expect(held(checkbox)).toEqual([0]);
			// Under a new plain block: the plain block is written, the task under it held.
			const phase = await write(ctx, space, a, [
				{ op: "insert", tempId: "c", parent: { id: ids.root }, content: "Phase 2" },
				{
					op: "insert",
					parent: { tempId: "c" },
					content: "Deploy to production",
					task: { status: "todo" },
				},
			]);
			expect(held(phase)).toEqual([1]);
			// Under a plain block of the plan (the acceptance criteria).
			const underAcc = await write(ctx, space, a, [
				{
					op: "insert",
					parent: { id: ids.acc },
					content: "Drop the old format",
					task: { status: "todo" },
				},
			]);
			expect(held(underAcc)).toEqual([0]);
			expect(await taskKids(ids.root)).toBe(before);
			// Only what the changes target waits: the parent of a proposed step does not (decision 20).
			expect(
				await findTasksWaitingForConfirmation(
					[{ id: ids.root, spaceId: space.id, taskJson: null }],
					{ store: ctx.store },
				),
			).toEqual(new Set());
			// Splitting a leaf of the plan is direct; so is a task under a task not of the plan (one
			// another person added after the lock).
			const split = await write(ctx, space, a, [
				{ op: "insert", parent: { id: ids.s2 }, content: "row batches", task: { status: "todo" } },
			]);
			expect(split.pending).toBeUndefined();
			const other = { kind: "human" as const, userId: await ctx.seedUser() };
			const side = (
				await write(ctx, space, other, [
					{
						op: "insert",
						parent: { id: ids.root },
						content: "Side quest",
						task: { status: "todo" },
					},
				])
			).results[0]?.blockId as string;
			const underSide = await write(ctx, space, a, [
				{ op: "insert", parent: { id: side }, content: "look into it", task: { status: "todo" } },
			]);
			expect(underSide.pending).toBeUndefined();
			// Brought back into the plan by an agent: held.
			await write(ctx, space, p.locker, [{ op: "delete", block: { id: side } }]);
			const back = await write(ctx, space, a, [{ op: "restore", block: { id: side } }]);
			expect(held(back)).toEqual([0]);
			// A task moved in from outside the tree: held.
			const outside = (
				await write(ctx, space, p.locker, [
					{
						op: "insert",
						parent: { id: ids.other },
						content: "Stray task",
						task: { status: "todo" },
					},
				])
			).results[0]?.blockId as string;
			const moved = await write(ctx, space, a, [
				{ op: "move", block: { id: outside }, parent: { id: ids.root } },
			]);
			expect(held(moved)).toEqual([0]);
			expect(await taskKids(ids.root)).toBe(before);
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "locked plan: an update that changes nothing is not a change (review S-1); taking the checkbox away then setting a field is one task change (merge)",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, a, ids } = p;
			const same = await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s1 }, content: "Parse the header" },
				{ op: "setTask", block: { id: ids.s1 }, task: { status: "doing" } },
			]);
			expect(same.pending).toBeUndefined();
			expect((await ctx.store.getBlock(ids.s1))?.taskJson?.status).toBe("doing");
			const waits = await deriveOutlineTaskWaits(
				[{ id: ids.s1, spaceId: space.id, taskJson: null }],
				{ store: ctx.store },
			);
			expect(waits.get(ids.s1)?.confirmation ?? false).toBe(false);
			// [setTask null] then [setTask {due}] merge into what was meant last: a task with a due date.
			const first = await write(ctx, space, a, [
				{ op: "setTask", block: { id: ids.s2 }, task: null },
			]);
			await write(ctx, space, a, [
				{ op: "setTask", block: { id: ids.s2 }, task: { due: "2026-12-01" } },
			]);
			const row = await pendingRow(ctx, first.pending?.id as string);
			expect(pendingOps(row)).toEqual([
				{ op: "setTask", block: { id: ids.s2 }, task: { due: "2026-12-01" } },
			]);
			expect(row.opCount).toBe(1);
		},
	},
	{
		name: "locks: a revert or a checkbox taken away by someone who may not unlock keeps the lock and its open changes (review S-4); who may, unlocks",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, a, ids } = p;
			const lockSeq = (await ctx.store.getBlock(ids.root))?.taskJson?.lock?.versionSeq as number;
			const lockCommit = (
				await ctx.store.listCommits(space.id, { limit: 1, afterSeq: lockSeq - 1 })
			)[0];
			expect(lockCommit?.seq).toBe(lockSeq);
			const proposal = await write(ctx, space, a, [
				{ op: "update", block: { id: ids.s1 }, content: "Step one, reworded" },
			]);
			const someone = await ctx.seedUser();
			const reverted = await revertCommit(
				{
					commitId: lockCommit?.id as string,
					actor: { kind: "human", id: someone },
					responsibleUserId: someone,
				},
				{ store: ctx.store },
			);
			expect(reverted.notes.map((n) => n.adjustment)).toEqual([
				{ kind: "lock-kept", blockId: ids.root },
			]);
			expect((await ctx.store.getBlock(ids.root))?.taskJson?.lock?.by.id).toBe(p.lockerId);
			expect((await pendingRow(ctx, proposal.pending?.id as string)).status).toBe("open");
			// Taking the checkbox away (the live editor's way of removing it) is refused.
			const box = await refusedWith(
				write(ctx, space, { kind: "human", userId: someone }, [
					{ op: "setTask", block: { id: ids.root }, task: null },
				]),
				OutlineWriteError,
			);
			expect(box.code).toBe("OUTLINE_LOCK_DENIED");
			const gone = await refusedWith(
				write(ctx, space, { kind: "human", userId: someone }, [
					{ op: "delete", block: { id: ids.root } },
				]),
				OutlineWriteError,
			);
			expect(gone.code).toBe("OUTLINE_LOCK_DENIED");
			expect((await pendingRow(ctx, proposal.pending?.id as string)).status).toBe("open");
			// With the right to unlock (a manager of the space, an admin), the revert unlocks.
			await revertCommit(
				{
					commitId: lockCommit?.id as string,
					actor: { kind: "human", id: someone },
					responsibleUserId: someone,
					unlockAuthority: async () => true,
				},
				{ store: ctx.store },
			);
			expect((await ctx.store.getBlock(ids.root))?.taskJson?.lock).toBeUndefined();
			expect(await pendingRow(ctx, proposal.pending?.id as string)).toMatchObject({
				status: "withdrawn",
				reason: "unlocked",
			});
			// An agent restoring a deleted locked task never brings the lock back.
			await lockOutlineTask({ blockId: ids.root, userId: p.lockerId, store: ctx.store });
			await write(ctx, space, p.locker, [{ op: "delete", block: { id: ids.root } }]);
			await write(ctx, space, a, [{ op: "restore", block: { id: ids.root } }]);
			const restored = await ctx.store.getBlock(ids.root);
			expect(restored?.deleted).toBe(false);
			expect(restored?.taskJson?.lock).toBeUndefined();
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "reports: a decision is told on its page however many open changes the session has elsewhere (review S-6)",
		async run(ctx) {
			const lockerId = await ctx.seedUser();
			const locker = { kind: "human" as const, userId: lockerId };
			const space = await ctx.store.ensureSpace({ kind: "personal", ownerUserId: lockerId }, NOW);
			const a = { kind: "agent" as const, narratorId: await ctx.seedNarrator() };
			const ops: OutlineOp[] = [{ op: "insert", tempId: "pa", parent: null, content: "Page A" }];
			for (let i = 0; i < 41; i++)
				ops.push({
					op: "insert",
					parent: { tempId: "pa" },
					content: `Plan ${i}`,
					task: { status: "todo" },
				});
			const pageA = await write(ctx, space, locker, ops);
			for (const r of pageA.results.slice(1)) {
				await lockOutlineTask({ blockId: r.blockId, userId: lockerId, store: ctx.store });
				await write(ctx, space, a, [
					{ op: "update", block: { id: r.blockId }, content: "changed" },
				]);
			}
			const rootB = (
				await write(ctx, space, locker, [
					{ op: "insert", parent: null, content: "Plan B", task: { status: "todo" } },
				])
			).results[0]?.blockId as string;
			await lockOutlineTask({ blockId: rootB, userId: lockerId, store: ctx.store });
			const proposal = await write(ctx, space, a, [
				{ op: "update", block: { id: rootB }, content: "B changed" },
			]);
			await rejectOutlinePending({
				pendingId: proposal.pending?.id as string,
				by: { kind: "human", userId: lockerId },
				reason: "no",
				store: ctx.store,
			});
			const told = await takePendingReports(a.narratorId, { store: ctx.store, pageId: rootB });
			expect(told.map((r) => r.id)).toEqual([proposal.pending?.id as string]);
			expect(await takePendingReports(a.narratorId, { store: ctx.store, pageId: rootB })).toEqual(
				[],
			);
		},
	},
	{
		name: "confirm a delete: refused while blocks were added, changed or moved under it since the proposal (review S-9); the diff says how many",
		async run(ctx) {
			const p = await lockedPlan(ctx);
			const { space, a, ids } = p;
			const proposal = await write(ctx, space, a, [{ op: "delete", block: { id: ids.s2 } }]);
			const other = { kind: "human" as const, userId: await ctx.seedUser() };
			const added = await write(ctx, space, other, [
				{ op: "insert", parent: { id: ids.s2 }, content: "Important finding by a teammate" },
			]);
			const refused = await refusedWith(
				confirmOutlinePending({
					pendingId: proposal.pending?.id as string,
					by: { kind: "human", userId: p.lockerId },
					store: ctx.store,
				}),
				OutlinePendingError,
			);
			expect(refused.pendingCode).toBe("OUTLINE_PENDING_CONFLICT");
			expect(refused.details.join("\n")).toContain("1 block");
			expect((await ctx.store.getBlock(added.results[0]?.blockId as string))?.deleted).toBe(false);
			expect((await pendingRow(ctx, proposal.pending?.id as string)).status).toBe("open");
			const diff = await readPendingDiff(await pendingRow(ctx, proposal.pending?.id as string), {
				store: ctx.store,
			});
			expect(diff.entries[0]).toMatchObject({ kind: "delete", changedUnder: 1 });
		},
	},
	{
		name: "locks: past the locks a page lists, a write outside every locked tree goes on, one inside is still held; a locked task moving takes its changes only where they fit",
		async run(ctx) {
			const lockerId = await ctx.seedUser();
			const locker = { kind: "human" as const, userId: lockerId };
			const space = await ctx.store.ensureSpace({ kind: "personal", ownerUserId: lockerId }, NOW);
			const a = { kind: "agent" as const, narratorId: await ctx.seedNarrator() };
			const b = { kind: "agent" as const, narratorId: await ctx.seedNarrator() };
			const r = await write(ctx, space, locker, [
				{ op: "insert", tempId: "p", parent: null, content: "Page" },
				{
					op: "insert",
					tempId: "t",
					parent: { tempId: "p" },
					content: "Plan",
					task: { status: "todo" },
				},
				{ op: "insert", parent: { tempId: "t" }, content: "Step", task: { status: "todo" } },
				{ op: "insert", parent: { tempId: "p" }, content: "A note" },
				{ op: "insert", tempId: "q", parent: null, content: "Other page" },
				{ op: "insert", parent: { tempId: "q" }, content: "Plan Q", task: { status: "todo" } },
			]);
			const [, plan, step, note, otherPage, planQ] = r.results.map((x) => x.blockId) as string[];
			await lockOutlineTask({ blockId: plan as string, userId: lockerId, store: ctx.store });
			await lockOutlineTask({ blockId: planQ as string, userId: lockerId, store: ctx.store });
			const scan = OUTLINE_LOCK_SCAN.perPage;
			OUTLINE_LOCK_SCAN.perPage = 0;
			try {
				const outside = await write(ctx, space, a, [
					{ op: "update", block: { id: note as string }, content: "A note, edited" },
				]);
				expect(outside.pending).toBeUndefined();
				expect(outside.commit).not.toBeNull();
				const inside = await write(ctx, space, a, [
					{ op: "update", block: { id: step as string }, content: "Step, reworded" },
				]);
				expect(held(inside)).toEqual([0]);
			} finally {
				OUTLINE_LOCK_SCAN.perPage = scan;
			}
			// The other page holds as many open changes as it may: the plan cannot move there.
			await write(ctx, space, b, [
				{ op: "update", block: { id: planQ as string }, content: "Plan Q, reworded" },
			]);
			const limits = OUTLINE_PENDING_LIMITS as { openPerPage: number };
			const open = limits.openPerPage;
			limits.openPerPage = 1;
			try {
				const full = await refusedWith(
					write(ctx, space, locker, [
						{ op: "move", block: { id: plan as string }, parent: { id: otherPage as string } },
					]),
					OutlineWriteError,
				);
				expect(full.code).toBe("OUTLINE_PENDING_FULL");
				// A new change there is refused too; the open one still takes more.
				const another = await refusedWith(
					write(ctx, space, a, [
						{ op: "update", block: { id: planQ as string }, content: "Plan Q, a's way" },
					]),
					OutlineWriteError,
				);
				expect(another.code).toBe("OUTLINE_PENDING_FULL");
				const more = await write(ctx, space, b, [
					{ op: "update", block: { id: planQ as string }, content: "Plan Q, reworded again" },
				]);
				expect(more.pending?.merged).toBe(true);
			} finally {
				limits.openPerPage = open;
			}
			const moved = await write(ctx, space, locker, [
				{ op: "move", block: { id: plan as string }, parent: { id: otherPage as string } },
			]);
			expect(moved.commit).not.toBeNull();
			expect((await openPending(ctx, otherPage as string)).length).toBe(2);
		},
	},
];
