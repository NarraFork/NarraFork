/**
 * The outline task contract: claims taken and released in the commit that changes a checkbox,
 * leases and their expiry, waiting derived at read time, continuation candidates and the
 * in-process flag. Written once and run against SQLite (`store-contract.test.ts`) and
 * PostgreSQL (`tests/server/services/outline/pg-outline-store.test.ts`, `PG_INTEGRATION=1`), with
 * the store contract's context (`contract.ts`).
 *
 * Times: each case that depends on leases works on its own clock (`now` far from the others'),
 * so the expiry job, which lists expired leases of the whole database, sees only its own.
 */
import { expect } from "bun:test";
import { OutlineTaskClaimedError } from "../errors";
import {
	OUTLINE_IN_PROCESS_TIMING,
	outlineSpacesWithInProcess,
	readInProcess,
	rebuildOutlineInProcess,
	runOutlineInProcessRebuild,
} from "../in-process";
import { keepOutlineTaskLeases, outlineLeaseKeepersOf } from "../lease-keeper";
import { OUTLINE_LIMITS, OUTLINE_TASK_LEASE } from "../model";
import { revertCommit } from "../revert";
import type { OutlineSpaceRow, OutlineStore, OutlineTaskClaimRow } from "../store/port";
import {
	deriveOutlineTaskWaits,
	expireOutlineTaskLeases,
	findContinuationCandidates,
	OUTLINE_LEASE_ACTOR,
	renewOutlineTaskLeases,
	reopenUnclaimedOutlineTasks,
	resetOutlineLeaseExpiryBackoffForTests,
	resetOutlineUnclaimedScanForTests,
} from "../tasks";
import {
	type OutlineOp,
	type OutlineWriteInput,
	type OutlineWriteResult,
	writeOutline,
} from "../write";
import {
	type ContractCase,
	checkInProcess,
	checkSpaceInvariants,
	type OutlineContractContext,
	type SpaceDump,
} from "./contract";

const NOW = "2026-10-26T00:00:00.000Z";
const MINUTE = 60_000;

type Writer =
	| { kind: "agent"; narratorId: string }
	| { kind: "human"; userId: string }
	| { kind: "system" };

function actorOf(writer: Writer): Pick<OutlineWriteInput, "actor" | "narratorId"> {
	if (writer.kind === "agent")
		return { actor: { kind: "agent", id: writer.narratorId }, narratorId: writer.narratorId };
	if (writer.kind === "human") return { actor: { kind: "human", id: writer.userId } };
	return { actor: { kind: "system", id: "contract" } };
}

function write(
	ctx: OutlineContractContext,
	space: OutlineSpaceRow,
	writer: Writer,
	ops: OutlineOp[],
	at?: Date,
	store?: OutlineStore,
): Promise<OutlineWriteResult> {
	return writeOutline(
		{ spaceId: space.id, ops, responsibleUserId: null, ...actorOf(writer) },
		{ store: store ?? ctx.store, ...(at ? { now: () => at } : {}) },
	);
}

const doing = (id: string): OutlineOp => ({
	op: "setTask",
	block: { id },
	task: { status: "doing" },
});
const status = (id: string, value: "todo" | "done" | "cancelled"): OutlineOp => ({
	op: "setTask",
	block: { id },
	task: { status: value },
});

async function claimOf(ctx: OutlineContractContext, id: string) {
	return (await ctx.store.getTaskClaims([id]))[0] ?? null;
}

async function refused(promise: Promise<unknown>): Promise<OutlineTaskClaimedError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(OutlineTaskClaimedError);
		return error as OutlineTaskClaimedError;
	}
	throw new Error("expected the write to be refused: the task is claimed");
}

const at = (base: string, minutes: number) => new Date(Date.parse(base) + minutes * MINUTE);

/** What `in_process` of every live block of a space should be, from its tree. */
function expectedInProcess(dump: SpaceDump): Map<string, boolean> {
	const byId = new Map(dump.blocks.map((b) => [b.id, b]));
	const out = new Map<string, boolean>();
	const of = (id: string): boolean => {
		const known = out.get(id);
		if (known !== undefined) return known;
		const block = byId.get(id);
		if (!block) return false;
		const value =
			dump.space.kind === "session" ||
			block.taskJson !== null ||
			(block.parentId !== null && of(block.parentId));
		out.set(id, value);
		return value;
	};
	for (const block of dump.blocks) if (!block.deleted) of(block.id);
	for (const block of dump.blocks) if (block.deleted) out.delete(block.id);
	return out;
}

/** A personal space (facts unless under a task) and a few agent sessions to write it. */
async function setup(ctx: OutlineContractContext) {
	const space = await ctx.store.ensureSpace(
		{ kind: "personal", ownerUserId: await ctx.seedUser() },
		NOW,
	);
	const n1 = await ctx.seedNarrator();
	const n2 = await ctx.seedNarrator();
	return {
		space,
		n1: { kind: "agent", narratorId: n1 } as Writer,
		n2: { kind: "agent", narratorId: n2 } as Writer,
		ids: { n1, n2 },
	};
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

export const OUTLINE_TASK_CONTRACT: ContractCase[] = [
	{
		name: "claims: setting a task in progress claims it; leaving in progress releases it",
		async run(ctx) {
			const { space, n1, n2, ids } = await setup(ctx);
			const t0 = "2030-01-01T00:00:00.000Z";
			const r = await write(
				ctx,
				space,
				n1,
				[
					{ op: "insert", tempId: "p", parent: null, content: "plan" },
					{ op: "insert", parent: { tempId: "p" }, content: "step", task: { status: "todo" } },
				],
				at(t0, 0),
			);
			const task = r.results[1]?.blockId as string;
			expect(await claimOf(ctx, task)).toBeNull();

			// To do → in progress: claimed by the session, with a lease, in the same commit.
			const started = await write(ctx, space, n1, [doing(task)], at(t0, 1));
			const seq = started.commit?.seq as number;
			expect(await claimOf(ctx, task)).toEqual({
				taskBlockId: task,
				holderNarratorId: ids.n1,
				holderUserId: null,
				epoch: 1,
				taskVersionAtClaim: seq,
				claimedAt: at(t0, 1).toISOString(),
				expiresAt: at(t0, 1 + OUTLINE_TASK_LEASE.leaseMs / MINUTE).toISOString(),
				lastHolderNarratorId: null,
				lastHolderUserId: null,
			});
			expect((await ctx.store.getBlock(task))?.versionSeq).toBe(seq);

			// Done releases it; the generation stays, and who held it last is kept.
			await write(ctx, space, n1, [status(task, "done")], at(t0, 2));
			expect(await claimOf(ctx, task)).toMatchObject({
				holderNarratorId: null,
				holderUserId: null,
				expiresAt: null,
				epoch: 1,
				lastHolderNarratorId: ids.n1,
				lastHolderUserId: null,
			});
			// Started again by another session: the next generation (no last holder while held).
			await write(ctx, space, n2, [doing(task)], at(t0, 3));
			expect(await claimOf(ctx, task)).toMatchObject({
				holderNarratorId: ids.n2,
				epoch: 2,
				lastHolderNarratorId: null,
			});
			// Back to to-do, cancelled, no longer a task, deleted: each releases.
			for (const leave of [
				status(task, "todo"),
				status(task, "cancelled"),
				{ op: "setTask", block: { id: task }, task: null } as OutlineOp,
				{ op: "delete", block: { id: task } } as OutlineOp,
			]) {
				// Started again (after "no longer a task", setting the status makes it one again).
				await write(ctx, space, n2, [doing(task)], at(t0, 4));
				expect((await claimOf(ctx, task))?.holderNarratorId).toBe(ids.n2);
				await write(ctx, space, n2, [leave], at(t0, 5));
				expect(await claimOf(ctx, task)).toMatchObject({
					holderNarratorId: null,
					holderUserId: null,
					expiresAt: null,
				});
			}

			// A task inserted in progress is claimed by its writer; a person's claim has no lease.
			const user = await ctx.seedUser();
			const person: Writer = { kind: "human", userId: user };
			const made = await write(
				ctx,
				space,
				person,
				[{ op: "insert", parent: null, content: "mine", task: { status: "doing" } }],
				at(t0, 6),
			);
			const mine = made.results[0]?.blockId as string;
			expect(await claimOf(ctx, mine)).toMatchObject({
				holderNarratorId: null,
				holderUserId: user,
				epoch: 1,
				expiresAt: null,
				taskVersionAtClaim: made.commit?.seq,
			});
			// Content split into tasks in progress claims those too.
			const split = await write(
				ctx,
				space,
				n1,
				[{ op: "insert", parent: null, content: "list\n\n- [/] sub one\n- [ ] sub two" }],
				at(t0, 7),
			);
			const [one, two] = (split.results[0]?.split ?? []).map((s) => s.blockId);
			expect((await claimOf(ctx, one as string))?.holderNarratorId).toBe(ids.n1);
			expect(await claimOf(ctx, two as string)).toBeNull();

			// A revert is its writer's too: undoing "done" puts the task back in progress, and the
			// person who reverted it is doing it.
			const finished = await write(ctx, space, person, [status(mine, "done")], at(t0, 8));
			await revertCommit(
				{
					commitId: finished.commit?.id as string,
					actor: { kind: "human", id: user },
					responsibleUserId: user,
				},
				{ store: ctx.store },
			);
			expect((await ctx.store.getBlock(mine))?.taskJson?.status).toBe("doing");
			expect(await claimOf(ctx, mine)).toMatchObject({
				holderUserId: user,
				holderNarratorId: null,
				epoch: 2,
			});
			// A system write made for no session cannot claim: the task is left to do, and the
			// result says so.
			const sys = await write(
				ctx,
				space,
				{ kind: "system" },
				[{ op: "insert", parent: null, content: "system task", task: { status: "doing" } }],
				at(t0, 9),
			);
			const sysTask = sys.results[0]?.blockId as string;
			expect((await ctx.store.getBlock(sysTask))?.taskJson?.status).toBe("todo");
			expect(sys.results[0]?.adjustments).toEqual([{ kind: "task-not-started", blockId: sysTask }]);
			expect(await claimOf(ctx, sysTask)).toBeNull();
			// A subtree deleted with tasks in progress deep under it releases them all.
			const deep = await write(
				ctx,
				space,
				n1,
				[
					{ op: "insert", tempId: "p", parent: null, content: "page" },
					{ op: "insert", tempId: "f", parent: { tempId: "p" }, content: "fact" },
					{
						op: "insert",
						tempId: "x",
						parent: { tempId: "f" },
						content: "x",
						task: { status: "doing" },
					},
					{ op: "insert", parent: { tempId: "x" }, content: "y", task: { status: "doing" } },
				],
				at(t0, 10),
			);
			const [deepPage, , x, y] = deep.results.map((r) => r.blockId) as string[];
			for (const id of [x, y])
				expect((await claimOf(ctx, id as string))?.holderNarratorId).toBe(ids.n1);
			await write(
				ctx,
				space,
				n1,
				[{ op: "delete", block: { id: deepPage as string } }],
				at(t0, 11),
			);
			for (const id of [x, y])
				expect(await claimOf(ctx, id as string)).toMatchObject({
					holderNarratorId: null,
					holderUserId: null,
					expiresAt: null,
				});
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "claims: a running claim refuses the whole transaction and names its holder",
		async run(ctx) {
			const { space, n1, n2, ids } = await setup(ctx);
			const t0 = "2031-01-01T00:00:00.000Z";
			const r = await write(
				ctx,
				space,
				n1,
				[
					{ op: "insert", parent: null, content: "a", task: { status: "todo" } },
					{ op: "insert", parent: null, content: "b", task: { status: "todo" } },
				],
				at(t0, 0),
			);
			const [a, b] = r.results.map((x) => x.blockId) as [string, string];
			await write(ctx, space, n1, [doing(a)], at(t0, 1));
			const before = (await ctx.store.getSpace(space.id))?.nextSeq;

			// Another session: refused, naming the holder; nothing of the transaction is written.
			const error = await refused(
				write(
					ctx,
					space,
					n2,
					[{ op: "insert", parent: null, content: "side effect" }, doing(a)],
					at(t0, 2),
				),
			);
			expect(error.code).toBe("OUTLINE_TASK_CLAIMED");
			expect(error.blockId).toBe(a);
			expect(error.opIndex).toBe(1);
			expect(error.holder).toEqual({
				kind: "agent",
				narratorId: ids.n1,
				expiresAt: at(t0, 11).toISOString(),
			});
			expect(error.address).toBe(`${space.key}/${(await ctx.store.getBlock(a))?.sid}`);
			expect((await ctx.store.getSpace(space.id))?.nextSeq).toBe(before);
			// A person too.
			const user = await ctx.seedUser();
			await refused(write(ctx, space, { kind: "human", userId: user }, [doing(a)], at(t0, 3)));
			// The holder setting it again changes nothing.
			expect((await write(ctx, space, n1, [doing(a)], at(t0, 4))).commit).toBeNull();
			// Other writes to the task (text, place, a child) do not claim it.
			const edit = await write(
				ctx,
				space,
				n2,
				[
					{ op: "update", block: { id: a }, content: "a, reworded" },
					{ op: "insert", parent: { id: a }, content: "a note" },
				],
				at(t0, 5),
			);
			expect(edit.commit).not.toBeNull();
			expect((await claimOf(ctx, a))?.holderNarratorId).toBe(ids.n1);

			// The lease ran out (not reopened yet): another session takes it over, next generation.
			// The task was in progress already, so the commit changes only who holds it.
			const takeover = await write(ctx, space, n2, [doing(a)], at(t0, 12));
			expect(takeover.commit).not.toBeNull();
			expect(takeover.pageIds).toEqual([]);
			expect(await claimOf(ctx, a)).toMatchObject({
				holderNarratorId: ids.n2,
				epoch: 2,
				claimedAt: at(t0, 12).toISOString(),
			});
			// Not an empty entry on the timeline: the commit says what it did.
			const handedOver = (await ctx.store.listCommits(space.id, { limit: 100 })).at(-1);
			expect(handedOver?.summary).toContain("took over");
			expect(handedOver?.summary).toContain(error.address);
			// Its own lapsed lease: renewed by setting it again, without a commit.
			const commitsBefore = (await ctx.store.getSpace(space.id))?.nextSeq;
			const again = await write(ctx, space, n2, [doing(a)], at(t0, 30));
			expect(again.commit).toBeNull();
			expect((await ctx.store.getSpace(space.id))?.nextSeq).toBe(commitsBefore);
			expect((await claimOf(ctx, a))?.expiresAt).toBe(at(t0, 40).toISOString());
			expect((await claimOf(ctx, a))?.epoch).toBe(2);

			// A person's claim never runs out.
			await write(ctx, space, { kind: "human", userId: user }, [doing(b)], at(t0, 0));
			const byPerson = await refused(write(ctx, space, n1, [doing(b)], at(t0, 100_000)));
			expect(byPerson.holder).toEqual({ kind: "human", userId: user });
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "claims: a lease renewed after the plan read it makes the takeover plan again",
		async run(ctx) {
			const { space, n1, n2, ids } = await setup(ctx);
			const t0 = "2032-01-01T00:00:00.000Z";
			const r = await write(
				ctx,
				space,
				n1,
				[{ op: "insert", parent: null, content: "t", task: { status: "doing" } }],
				at(t0, 0),
			);
			const task = r.results[0]?.blockId as string;
			// n2 plans a takeover of the expired lease; n1 renews before the commit is written.
			let renewed = false;
			const racing: OutlineStore = {
				...ctx.store,
				async applyCommit(plan) {
					if (!renewed) {
						renewed = true;
						expect(
							await renewOutlineTaskLeases(ids.n1, { store: ctx.store, now: at(t0, 15) }),
						).toBe(1);
					}
					return ctx.store.applyCommit(plan);
				},
			};
			const error = await refused(write(ctx, space, n2, [doing(task)], at(t0, 15), racing));
			expect(error.holder).toMatchObject({ kind: "agent", narratorId: ids.n1 });
			expect(await claimOf(ctx, task)).toMatchObject({
				holderNarratorId: ids.n1,
				epoch: 1,
				expiresAt: at(t0, 25).toISOString(),
			});
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "leases: renewal, expiry back to to-do with the progress kept, and a renewal racing it",
		async run(ctx) {
			const { space, n1, n2, ids } = await setup(ctx);
			const t0 = "2021-06-01T00:00:00.000Z";
			const r = await write(
				ctx,
				space,
				n1,
				[
					{ op: "insert", tempId: "t", parent: null, content: "t", task: { status: "doing" } },
					{ op: "insert", parent: { tempId: "t" }, content: "progress so far" },
					{ op: "insert", parent: null, content: "u", task: { status: "doing" } },
				],
				at(t0, 0),
			);
			const [t, progress, u] = r.results.map((x) => x.blockId) as [string, string, string];
			expect(await renewOutlineTaskLeases(ids.n1, { store: ctx.store, now: at(t0, 5) })).toBe(2);
			expect((await claimOf(ctx, t))?.expiresAt).toBe(at(t0, 15).toISOString());
			expect(await renewOutlineTaskLeases(ids.n2, { store: ctx.store, now: at(t0, 5) })).toBe(0);

			// Not expired yet: nothing happens.
			expect(await expireOutlineTaskLeases({ store: ctx.store, now: at(t0, 14) })).toEqual({
				reopened: 0,
				skipped: 0,
				failed: 0,
			});
			// A renewal lands between the job's listing and its commit: that task is left alone.
			let raced = false;
			const racing: OutlineStore = {
				...ctx.store,
				async listExpiredTaskClaims(now, limit) {
					const rows = await ctx.store.listExpiredTaskClaims(now, limit);
					if (!raced) {
						raced = true;
						// The session is alive after all: it renews both claims.
						await renewOutlineTaskLeases(ids.n1, { store: ctx.store, now: at(t0, 16) });
					}
					return rows;
				},
			};
			expect(await expireOutlineTaskLeases({ store: racing, now: at(t0, 16) })).toEqual({
				reopened: 0,
				skipped: 2,
				failed: 0,
			});
			expect((await ctx.store.getBlock(t))?.taskJson?.status).toBe("doing");

			// Run out: both reopened in one system commit; the progress stays; a last child says why.
			const result = await expireOutlineTaskLeases({ store: ctx.store, now: at(t0, 40) });
			expect(result).toEqual({ reopened: 2, skipped: 0, failed: 0 });
			for (const id of [t, u]) {
				expect((await ctx.store.getBlock(id))?.taskJson?.status).toBe("todo");
				expect(await claimOf(ctx, id)).toMatchObject({
					holderNarratorId: null,
					expiresAt: null,
					epoch: 1,
				});
			}
			const children = await ctx.store.listChildren(space.id, t, 10);
			expect(children.map((c) => c.id)[0]).toBe(progress);
			expect(children).toHaveLength(2);
			expect(children[1]?.content).toContain("lease expired");
			expect(children[1]?.content).toContain(ids.n1);
			expect(children[1]?.authorKind).toBe("system");
			const commits = await ctx.store.listCommits(space.id, { limit: 50 });
			expect(commits.at(-1)).toMatchObject({ actorKind: "system", actorId: OUTLINE_LEASE_ACTOR });
			expect(await expireOutlineTaskLeases({ store: ctx.store, now: at(t0, 41) })).toEqual({
				reopened: 0,
				skipped: 0,
				failed: 0,
			});
			// Taken again later: the next generation, so a late result of the old one is told apart.
			await write(ctx, space, n2, [doing(t)], at(t0, 50));
			expect(await claimOf(ctx, t)).toMatchObject({ holderNarratorId: ids.n2, epoch: 2 });
			checkSpaceInvariants(await ctx.dump(space.id));
			checkInProcess(await ctx.dump(space.id));
		},
	},
	{
		name: "claims: a session cannot end a task someone else is doing; a person can, and the commit says so",
		async run(ctx) {
			const { space, n1, n2, ids } = await setup(ctx);
			const t0 = "2034-01-01T00:00:00.000Z";
			const r = await write(
				ctx,
				space,
				n1,
				[
					{ op: "insert", tempId: "p", parent: null, content: "page" },
					{ op: "insert", parent: { tempId: "p" }, content: "T", task: { status: "doing" } },
				],
				at(t0, 0),
			);
			const [page, task] = r.results.map((x) => x.blockId) as [string, string];
			// n1's lease ran out; n2 took it over.
			await write(ctx, space, n2, [doing(task)], at(t0, 12));
			expect(await claimOf(ctx, task)).toMatchObject({ holderNarratorId: ids.n2, epoch: 2 });
			// n1, unaware, cannot finish it, cancel it, reopen it, untick it or delete it (or its page).
			for (const op of [
				status(task, "done"),
				status(task, "cancelled"),
				status(task, "todo"),
				{ op: "setTask", block: { id: task }, task: null } as OutlineOp,
				{ op: "delete", block: { id: task } } as OutlineOp,
				{ op: "delete", block: { id: page } } as OutlineOp,
			]) {
				const error = await refused(write(ctx, space, n1, [op], at(t0, 13)));
				expect(error.holder).toMatchObject({ kind: "agent", narratorId: ids.n2 });
				expect(error.opIndex).toBe(0);
			}
			expect((await ctx.store.getBlock(task))?.taskJson?.status).toBe("doing");
			expect(await claimOf(ctx, task)).toMatchObject({ holderNarratorId: ids.n2, epoch: 2 });
			// n2, the holder, may.
			await write(ctx, space, n2, [status(task, "todo")], at(t0, 14));
			await write(ctx, space, n2, [doing(task)], at(t0, 15));
			expect(await claimOf(ctx, task)).toMatchObject({ holderNarratorId: ids.n2, epoch: 3 });

			// A takeover landing between a session's plan to end the task and its write: planned again,
			// and refused.
			await write(ctx, space, n1, [doing(task)], at(t0, 40)); // n2's lease ran out: n1 again
			let raced = false;
			const racing: OutlineStore = {
				...ctx.store,
				async applyCommit(plan) {
					if (!raced) {
						raced = true;
						await write(ctx, space, n2, [doing(task)], at(t0, 60));
					}
					return ctx.store.applyCommit(plan);
				},
			};
			const late = await refused(write(ctx, space, n1, [status(task, "done")], at(t0, 60), racing));
			expect(late.holder).toMatchObject({ kind: "agent", narratorId: ids.n2 });
			expect(await claimOf(ctx, task)).toMatchObject({ holderNarratorId: ids.n2 });

			// A person may end it: written, the claim released, and the commit says whose work ended.
			const user = await ctx.seedUser();
			const done = await write(
				ctx,
				space,
				{ kind: "human", userId: user },
				[status(task, "done")],
				at(t0, 61),
			);
			expect(done.ended).toEqual([
				{
					blockId: task,
					address: `${space.key}/${(await ctx.store.getBlock(task))?.sid}`,
					holder: { kind: "agent", narratorId: ids.n2, expiresAt: at(t0, 70).toISOString() },
				},
			]);
			const commit = (await ctx.store.listCommits(space.id, { limit: 100 })).at(-1);
			expect(commit?.summary).toContain("ended work someone else was doing");
			expect(await claimOf(ctx, task)).toMatchObject({
				holderNarratorId: null,
				holderUserId: null,
			});
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "claims: a task back in progress through a restore or a revert is whoever did it's; a restored task keeps its fields",
		async run(ctx) {
			const { space, n1, ids } = await setup(ctx);
			const user = await ctx.seedUser();
			const person: Writer = { kind: "human", userId: user };
			const t0 = "2035-01-01T00:00:00.000Z";
			const r = await write(
				ctx,
				space,
				person,
				[
					{
						op: "insert",
						parent: null,
						content: "goal",
						task: { status: "todo", humanCreated: true, claimable: true, lock: { delegate: null } },
					},
				],
				at(t0, 0),
			);
			const task = r.results[0]?.blockId as string;
			await write(ctx, space, n1, [doing(task)], at(t0, 1));
			const before = (await ctx.store.getBlock(task))?.taskJson;
			expect(before).toMatchObject({
				status: "doing",
				humanCreated: true,
				claimable: true,
				manager: { kind: "human", id: user },
				lock: { by: { kind: "human", id: user }, delegate: null },
			});

			// Deleted, then brought back with its checkbox (as the editor's undo does): the person
			// who restored it is doing it, and nothing else of the task changed.
			await write(ctx, space, person, [{ op: "delete", block: { id: task } }], at(t0, 2));
			expect((await claimOf(ctx, task))?.holderNarratorId).toBeNull();
			const back = await write(
				ctx,
				space,
				person,
				[{ op: "restore", block: { id: task }, task: { status: "doing" } }],
				at(t0, 3),
			);
			expect((await ctx.store.getBlock(task))?.taskJson).toEqual(before);
			expect(await claimOf(ctx, task)).toMatchObject({
				holderUserId: user,
				holderNarratorId: null,
				taskVersionAtClaim: back.commit?.seq,
			});

			// The lease expiry reverted by a person: back in progress, given back to the session
			// whose lease ran out, on a new lease (it runs out again if that session stays away).
			await write(ctx, space, person, [status(task, "todo")], at(t0, 4));
			await write(ctx, space, n1, [doing(task)], at(t0, 5));
			expect(
				(await expireOutlineTaskLeases({ store: ctx.store, now: at(t0, 16) })).reopened,
			).toBeGreaterThanOrEqual(1);
			expect((await ctx.store.getBlock(task))?.taskJson?.status).toBe("todo");
			const expiry = (await ctx.store.listCommits(space.id, { limit: 100 })).at(-1);
			expect(expiry?.actorId).toBe(OUTLINE_LEASE_ACTOR);
			await revertCommit(
				{
					commitId: expiry?.id as string,
					actor: { kind: "human", id: user },
					responsibleUserId: user,
				},
				{ store: ctx.store, now: () => at(t0, 17) },
			);
			expect((await ctx.store.getBlock(task))?.taskJson?.status).toBe("doing");
			expect(await claimOf(ctx, task)).toMatchObject({
				holderUserId: null,
				holderNarratorId: ids.n1,
				expiresAt: at(t0, 27).toISOString(),
			});
			// A session restoring one gets a lease.
			await write(ctx, space, person, [{ op: "delete", block: { id: task } }], at(t0, 20));
			await write(ctx, space, n1, [{ op: "restore", block: { id: task } }], at(t0, 21));
			expect(await claimOf(ctx, task)).toMatchObject({
				holderNarratorId: ids.n1,
				expiresAt: at(t0, 31).toISOString(),
			});
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "leases: a running session keeps its tasks past the lease; only one that stopped loses them",
		async run(ctx) {
			const { space, n1, ids } = await setup(ctx);
			const t0 = "2022-03-01T00:00:00.000Z";
			const r = await write(
				ctx,
				space,
				n1,
				[{ op: "insert", parent: null, content: "long job", task: { status: "doing" } }],
				at(t0, 0),
			);
			const task = r.results[0]?.blockId as string;
			let clock = Date.parse(t0);
			const keeper = keepOutlineTaskLeases(ids.n1, {
				store: ctx.store,
				now: () => clock,
				enabled: () => true,
				intervalMs: 0,
			});
			try {
				await keeper.touch();
				// The session works for half an hour: the runtime touches the keeper at its tool
				// boundaries, every minute; it renews at most every two.
				for (let minute = 1; minute <= 30; minute++) {
					clock = Date.parse(t0) + minute * MINUTE;
					await keeper.touch();
					expect(
						(await expireOutlineTaskLeases({ store: ctx.store, now: new Date(clock) })).reopened,
					).toBe(0);
				}
				expect((await ctx.store.getBlock(task))?.taskJson?.status).toBe("doing");
				expect((await claimOf(ctx, task))?.expiresAt).toBe(at(t0, 40).toISOString());
			} finally {
				keeper.stop();
			}
			expect(outlineLeaseKeepersOf(ids.n1)).toBe(0);
			// Stopped at minute 30: the lease runs to minute 40, then the task is reopened.
			expect((await expireOutlineTaskLeases({ store: ctx.store, now: at(t0, 39) })).reopened).toBe(
				0,
			);
			expect((await expireOutlineTaskLeases({ store: ctx.store, now: at(t0, 41) })).reopened).toBe(
				1,
			);
			expect((await ctx.store.getBlock(task))?.taskJson?.status).toBe("todo");
		},
	},
	{
		name: "leases: a task that cannot be reopened does not hold up the others, and is left alone for a while",
		async run(ctx) {
			resetOutlineLeaseExpiryBackoffForTests();
			const { space, n1, n2, ids } = await setup(ctx);
			const t0 = "2023-01-01T00:00:00.000Z";
			const r = await write(
				ctx,
				space,
				n1,
				[
					{ op: "insert", tempId: "x", parent: null, content: "X", task: { status: "doing" } },
					{ op: "insert", parent: { tempId: "x" }, content: "c1" },
					{ op: "insert", parent: { tempId: "x" }, content: "c2" },
					{ op: "insert", parent: null, content: "Y", task: { status: "doing" } },
					{ op: "insert", parent: null, content: "Z", task: { status: "doing" } },
				],
				at(t0, 0),
			);
			const [x, , , y, z] = r.results.map((res) => res.blockId) as string[];
			// X cannot take the note (as if at the sibling limit); Z cannot be written at all.
			const limits = OUTLINE_LIMITS as unknown as { maxSiblings: number };
			const saved = limits.maxSiblings;
			const broken: OutlineStore = {
				...ctx.store,
				async applyCommit(plan) {
					if (plan.closeVersionIds.includes(z as string)) throw new Error("disk full for Z");
					return ctx.store.applyCommit(plan);
				},
			};
			limits.maxSiblings = 1;
			const started = Date.now();
			try {
				const first = await expireOutlineTaskLeases({ store: broken, now: at(t0, 11) });
				expect(first).toEqual({ reopened: 2, skipped: 0, failed: 1 });
				// The next run leaves Z alone instead of failing on it again.
				expect(await expireOutlineTaskLeases({ store: broken, now: at(t0, 12) })).toEqual({
					reopened: 0,
					skipped: 0,
					failed: 0,
				});
			} finally {
				limits.maxSiblings = saved;
			}
			for (const id of [x, y])
				expect((await ctx.store.getBlock(id as string))?.taskJson?.status).toBe("todo");
			expect((await ctx.store.getBlock(z as string))?.taskJson?.status).toBe("doing");
			// X was reopened without the note; Y with it. The commits are dated when written.
			expect(
				(await ctx.store.listChildren(space.id, x as string, 10)).map((b) => b.content),
			).toEqual(["c1", "c2"]);
			expect(await ctx.store.listChildren(space.id, y as string, 10)).toHaveLength(1);
			const expiries = (await ctx.store.listCommits(space.id, { limit: 100 })).filter(
				(c) => c.actorId === OUTLINE_LEASE_ACTOR,
			);
			for (const c of expiries)
				expect(Date.parse(c.createdAt)).toBeGreaterThanOrEqual(started - 1000);
			// Once the wait is over (and the cause is gone) it is reopened.
			expect(
				(await expireOutlineTaskLeases({ store: ctx.store, now: at(t0, 11 + 11) })).reopened,
			).toBe(1);
			resetOutlineLeaseExpiryBackoffForTests();

			// Renewals landing on both tries of one batch: each counted as skipped.
			const r2 = await write(
				ctx,
				space,
				n1,
				[{ op: "insert", parent: null, content: "U1", task: { status: "doing" } }],
				at(t0, 100),
			);
			await write(
				ctx,
				space,
				n2,
				[{ op: "insert", parent: null, content: "U2", task: { status: "doing" } }],
				at(t0, 100),
			);
			let calls = 0;
			const renewing: OutlineStore = {
				...ctx.store,
				async applyCommit(plan) {
					calls++;
					await renewOutlineTaskLeases(calls === 1 ? ids.n1 : ids.n2, {
						store: ctx.store,
						now: at(t0, 120),
					});
					return ctx.store.applyCommit(plan);
				},
			};
			expect(await expireOutlineTaskLeases({ store: renewing, now: at(t0, 111) })).toEqual({
				reopened: 0,
				skipped: 2,
				failed: 0,
			});
			expect((await ctx.store.getBlock(r2.results[0]?.blockId as string))?.taskJson?.status).toBe(
				"doing",
			);
		},
	},
	{
		name: "in process: a commit planned against answers the rebuild rewrote is planned again; reads check the space before and after",
		async run(ctx) {
			const { space, n1 } = await setup(ctx);
			const r = await write(ctx, space, n1, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{
					op: "insert",
					tempId: "t",
					parent: { tempId: "p" },
					content: "task",
					task: { status: "todo" },
				},
				{ op: "insert", parent: { tempId: "t" }, content: "note under the task" },
			]);
			const [, t, z] = r.results.map((x) => x.blockId) as [string, string, string];
			const epoch0 = (await ctx.store.getInProcessState([space.id])).get(space.id)?.epoch as number;
			// A rebuild that writes rows moves the epoch; one that finds nothing to write does not.
			await ctx.resetInProcess(space.id);
			// While the space is not derived, a read answers from the tree, not the stale column…
			expect(
				Object.fromEntries(await readInProcess(space.id, [t, z], { store: ctx.store })),
			).toEqual({
				[t]: true,
				[z]: true,
			});
			// …also when the rebuild finishes between its two looks at the space.
			let rebuilt = false;
			const racingRead: OutlineStore = {
				...ctx.store,
				async getInProcessState(spaceIds) {
					if (!rebuilt) {
						rebuilt = true;
						await rebuildOutlineInProcess({ store: ctx.store });
					}
					return ctx.store.getInProcessState(spaceIds);
				},
			};
			expect(
				Object.fromEntries(await readInProcess(space.id, [t, z], { store: racingRead })),
			).toEqual({
				[t]: true,
				[z]: true,
			});
			const derived = (await ctx.store.getInProcessState([space.id])).get(space.id);
			expect(derived?.ready).toBe(true);
			expect(derived?.epoch).toBeGreaterThan(epoch0);

			// A commit planned before the rebuild rewrote the answers is refused as stale and planned
			// again from the rewritten ones.
			await ctx.resetInProcess(space.id);
			let raced = false;
			let applied = 0;
			const racing: OutlineStore = {
				...ctx.store,
				async applyCommit(plan) {
					applied++;
					if (!raced) {
						raced = true;
						await rebuildOutlineInProcess({ store: ctx.store });
					}
					return ctx.store.applyCommit(plan);
				},
			};
			// A text-only commit reads no answer: a rebuild landing meanwhile does not send it round.
			const textEpoch = (await ctx.store.getInProcessState([space.id])).get(space.id)?.epoch;
			await write(
				ctx,
				space,
				n1,
				[{ op: "update", block: { id: z }, content: "note, reworded" }],
				undefined,
				racing,
			);
			expect(raced).toBe(true);
			expect(applied).toBe(1);
			expect((await ctx.store.getInProcessState([space.id])).get(space.id)?.epoch).toBeGreaterThan(
				textEpoch as number,
			);
			await ctx.resetInProcess(space.id);
			raced = false;
			applied = 0;
			await write(
				ctx,
				space,
				n1,
				[{ op: "setTask", block: { id: t }, task: null }],
				undefined,
				racing,
			);
			expect(raced).toBe(true);
			expect(applied).toBe(2);
			expect((await ctx.store.getInProcessState([space.id])).get(space.id)?.ready).toBe(true);
			checkInProcess(await ctx.dump(space.id));
			expect(
				Object.fromEntries(await readInProcess(space.id, [t, z], { store: ctx.store })),
			).toEqual({
				[t]: false,
				[z]: false,
			});

			// "Did structure change since" looks at a bounded number of commits: past it, yes.
			const seq = (await ctx.store.getSpace(space.id))?.nextSeq as number;
			for (const text of ["one", "two", "three"])
				await write(ctx, space, n1, [{ op: "update", block: { id: z }, content: text }]);
			expect(await ctx.store.hasChangesSince(space.id, seq - 1, 1 | 4 | 8 | 16 | 32 | 64, 10)).toBe(
				false,
			);
			expect(await ctx.store.hasChangesSince(space.id, seq - 1, 1 | 4 | 8 | 16 | 32 | 64, 2)).toBe(
				true,
			);
			await write(ctx, space, n1, [status(z, "todo")]);
			expect(await ctx.store.hasChangesSince(space.id, seq - 1, 32, 10)).toBe(true);
		},
	},
	{
		name: "waiting: unfinished prerequisites make a task wait; finished, cancelled, deleted, plain and unresolved ones do not",
		async run(ctx) {
			const { space, n1 } = await setup(ctx);
			const other = await ctx.store.ensureSpace(
				{ kind: "project", projectId: await ctx.seedProject() },
				NOW,
			);
			const r = await write(ctx, space, n1, [
				{ op: "insert", parent: null, content: "A", task: { status: "todo" }, alias: "StepA" },
				{ op: "insert", parent: null, content: "B", task: { status: "done" } },
				{ op: "insert", parent: null, content: "C", task: { status: "cancelled" } },
				{ op: "insert", parent: null, content: "D (a plain block)" },
				{ op: "insert", parent: null, content: "E", task: { status: "doing" } },
			]);
			const [a, b, c, d, e] = r.results;
			await write(ctx, space, n1, [{ op: "delete", block: { id: e?.blockId as string } }]);
			const dep = (target: string) => ({ target, label: null });
			const x = await write(ctx, space, n1, [
				{
					op: "insert",
					parent: null,
					content: "X",
					task: {
						status: "todo",
						depends: [
							dep(a?.address as string),
							dep(b?.address as string),
							dep(c?.address as string),
							dep(d?.address as string),
							dep(e?.address as string),
							dep("Some title nobody resolves"),
						],
					},
				},
				{
					op: "insert",
					parent: null,
					content: "Y",
					task: { status: "todo", depends: [dep(b?.address as string), dep(c?.address as string)] },
				},
				// By alias in its own space, and by `key/alias`.
				{
					op: "insert",
					parent: null,
					content: "Z",
					task: { status: "todo", depends: [dep("StepA")] },
				},
				{
					op: "insert",
					parent: null,
					content: "W",
					task: { status: "todo", depends: [dep(`${space.key}/StepA`)] },
				},
			]);
			// From another space, by address.
			const far = await write(ctx, other, n1, [
				{
					op: "insert",
					parent: null,
					content: "far",
					task: { status: "todo", depends: [dep(a?.address as string)] },
				},
			]);
			const subjects = await ctx.store.getBlocks([
				...x.results.map((res) => res.blockId),
				far.results[0]?.blockId as string,
			]);
			const waits = await deriveOutlineTaskWaits(subjects, { store: ctx.store });
			const [wx, wy, wz, ww] = x.results.map((res) => waits.get(res.blockId));
			expect(wx).toEqual({ prerequisites: [a?.blockId], people: false });
			expect(wy).toEqual({ prerequisites: [], people: false });
			expect(wz?.prerequisites).toEqual([a?.blockId]);
			expect(ww?.prerequisites).toEqual([a?.blockId]);
			expect(waits.get(far.results[0]?.blockId as string)?.prerequisites).toEqual([a?.blockId]);
			// Once A is done, nothing waits.
			await write(ctx, space, n1, [status(a?.blockId as string, "done")]);
			const after = await deriveOutlineTaskWaits(subjects, { store: ctx.store });
			for (const wait of after.values()) expect(wait).toEqual({ prerequisites: [], people: false });
		},
	},
	{
		name: "continuation candidates: the session's claims and its space's open tasks, in document order",
		async run(ctx) {
			const narrator = await ctx.seedNarrator();
			const other = await ctx.seedNarrator();
			const me: Writer = { kind: "agent", narratorId: narrator };
			const them: Writer = { kind: "agent", narratorId: other };
			const user = await ctx.seedUser();
			const session = await ctx.store.ensureSpace({ kind: "session", narratorId: narrator }, NOW);
			const project = await ctx.store.ensureSpace(
				{ kind: "project", projectId: await ctx.seedProject() },
				NOW,
			);
			const t0 = "2033-01-01T00:00:00.000Z";
			const todo = (content: string, extra: Record<string, unknown> = {}) => ({
				content,
				task: { status: "todo" as const, ...extra },
			});
			const r = await write(
				ctx,
				session,
				me,
				[
					{ op: "insert", tempId: "p2", parent: null, content: "page two" },
					{
						op: "insert",
						tempId: "p1",
						parent: null,
						position: { first: true },
						content: "page one",
					},
					{ op: "insert", tempId: "t1", parent: { tempId: "p1" }, ...todo("t1") },
					{ op: "insert", tempId: "t6", parent: { tempId: "t1" }, ...todo("t6 under t1") },
					{ op: "insert", tempId: "t3", parent: { tempId: "p1" }, ...todo("t3 waits for t1") },
					{
						op: "insert",
						tempId: "t4",
						parent: { tempId: "p1" },
						...todo("t4", { assignee: "human:ann" }),
					},
					{
						op: "insert",
						tempId: "t5",
						parent: { tempId: "p1" },
						content: "t5",
						task: { status: "done" },
					},
					{ op: "insert", tempId: "t2", parent: { tempId: "p2" }, ...todo("t2") },
					{ op: "insert", tempId: "t7", parent: { tempId: "p2" }, ...todo("t7") },
					{ op: "insert", tempId: "t8", parent: { tempId: "p2" }, ...todo("t8") },
					{ op: "insert", tempId: "t9", parent: { tempId: "p2" }, ...todo("t9") },
					{ op: "insert", parent: { tempId: "p2" }, content: "a note, not a task" },
				],
				at(t0, 0),
			);
			const id = (n: number) => r.results[n]?.blockId as string;
			const [t1, t6, t3, , , t2, t7, t8, t9] = [2, 3, 4, 5, 6, 7, 8, 9, 10].map(id) as string[];
			await write(ctx, session, me, [
				{
					op: "setTask",
					block: { id: t3 as string },
					task: { depends: [{ target: r.results[2]?.address as string, label: null }] },
				},
			]);
			await write(ctx, session, me, [doing(t2 as string)], at(t0, 1));
			// Another session is doing t7 (lease running); t8's lease ran out; a person is doing t9.
			await write(ctx, session, them, [doing(t7 as string)], at(t0, 25));
			await write(ctx, session, them, [doing(t8 as string)], at(t0, 1));
			await write(ctx, session, { kind: "human", userId: user }, [doing(t9 as string)], at(t0, 1));
			// A project task this session holds comes after the session space's.
			const p = await write(
				ctx,
				project,
				me,
				[{ op: "insert", parent: null, content: "shared", task: { status: "doing" } }],
				at(t0, 2),
			);
			const shared = p.results[0]?.blockId as string;
			// Someone else's project task is not this session's.
			await write(
				ctx,
				project,
				them,
				[{ op: "insert", parent: null, content: "theirs", task: { status: "todo" } }],
				at(t0, 2),
			);

			const found = await findContinuationCandidates({
				narratorId: narrator,
				sessionSpaceId: session.id,
				store: ctx.store,
				now: at(t0, 30),
			});
			expect(found.truncated).toBe(false);
			expect(found.candidates.map((c) => c.blockId)).toEqual([t1, t6, t2, t8, shared]);
			expect(found.candidates[2]).toMatchObject({
				status: "doing",
				address: `${session.key}/${r.results[7]?.sid}`,
				claim: { holderNarratorId: narrator, epoch: 1 },
			});
			expect(found.waiting.map((w) => [w.blockId, w.wait])).toEqual([
				[t3, { prerequisites: [t1], people: false }],
			]);
			const limited = await findContinuationCandidates({
				narratorId: narrator,
				sessionSpaceId: session.id,
				store: ctx.store,
				now: at(t0, 30),
				limit: 2,
			});
			expect(limited.candidates.map((c) => c.blockId)).toEqual([t1, t6]);
			// Without a session space: only what it holds.
			const held = await findContinuationCandidates({
				narratorId: narrator,
				sessionSpaceId: null,
				store: ctx.store,
				now: at(t0, 30),
			});
			expect(held.candidates.map((c) => c.blockId).sort()).toEqual([t2, shared].sort());
		},
	},
	{
		name: "in process: tasks, what is under them and session spaces; kept by writes, derived by the rebuild",
		async run(ctx) {
			const { space, n1 } = await setup(ctx);
			const check = async (s: OutlineSpaceRow) => {
				const dump = await ctx.dump(s.id);
				checkInProcess(dump);
				return new Map(dump.blocks.map((b) => [b.id, b.inProcess]));
			};
			const r = await write(ctx, space, n1, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{ op: "insert", tempId: "a", parent: { tempId: "p" }, content: "fact A" },
				{ op: "insert", tempId: "a1", parent: { tempId: "a" }, content: "fact A1" },
				{ op: "insert", tempId: "a2", parent: { tempId: "a1" }, content: "fact A2" },
				{
					op: "insert",
					tempId: "t",
					parent: { tempId: "p" },
					content: "task",
					task: { status: "todo" },
				},
				{ op: "insert", tempId: "n", parent: { tempId: "t" }, content: "note under the task" },
			]);
			const [p, aId, a1, a2, t, n] = r.results.map((x) => x.blockId) as string[];
			let flags = await check(space);
			expect([p, aId, a1, a2, t, n].map((x) => flags.get(x as string))).toEqual([
				false,
				false,
				false,
				false,
				true,
				true,
			]);
			// A fact becomes a task: it and everything under it are process.
			await write(ctx, space, n1, [status(aId as string, "todo")]);
			flags = await check(space);
			expect([aId, a1, a2].map((x) => flags.get(x as string))).toEqual([true, true, true]);
			// A1's subtree moves out from under it: facts again.
			await write(ctx, space, n1, [
				{ op: "move", block: { id: a1 as string }, parent: { id: p as string } },
			]);
			flags = await check(space);
			expect([a1, a2].map((x) => flags.get(x as string))).toEqual([false, false]);
			// Moved under the task: process; the task stops being one: facts again, but a task under
			// it stays process.
			await write(ctx, space, n1, [
				{ op: "move", block: { id: a1 as string }, parent: { id: t as string } },
				{ op: "setTask", block: { id: a2 as string }, task: { status: "done" } },
			]);
			await write(ctx, space, n1, [{ op: "setTask", block: { id: t as string }, task: null }]);
			flags = await check(space);
			expect([t, n, a1, a2].map((x) => flags.get(x as string))).toEqual([
				false,
				false,
				false,
				true,
			]);
			// Deleted and restored under a task.
			await write(ctx, space, n1, [
				status(t as string, "todo"),
				{ op: "delete", block: { id: n as string } },
			]);
			await write(ctx, space, n1, [{ op: "restore", block: { id: n as string } }]);
			flags = await check(space);
			expect(flags.get(n as string)).toBe(true);

			// Everything in a session space is process.
			const session = await ctx.store.ensureSpace(
				{ kind: "session", narratorId: await ctx.seedNarrator() },
				NOW,
			);
			const s = await write(ctx, session, n1, [
				{ op: "insert", tempId: "sp", parent: null, content: "session page" },
				{ op: "insert", parent: { tempId: "sp" }, content: "a note" },
			]);
			flags = await check(session);
			for (const res of s.results) expect(flags.get(res.blockId)).toBe(true);

			const loose = (
				await write(ctx, space, n1, [{ op: "insert", parent: null, content: "a loose fact" }])
			).results[0]?.blockId as string;

			// Written before the flag existed: every flag false, the spaces not derived yet.
			for (const sp of [space, session]) await ctx.resetInProcess(sp.id);
			// A stale answer above a block a commit moves is not the commit's to fix: the move is
			// written (its own answer computed from the page down), the rest left to the rebuild.
			await write(ctx, space, n1, [
				{ op: "move", block: { id: loose }, parent: { id: n as string } },
			]);
			expect((await ctx.store.getBlock(loose))?.inProcess).toBe(true);
			expect((await ctx.store.getBlock(n as string))?.inProcess).toBe(false);
			// Meanwhile reads answer from the tree, not from the stale column.
			const meanwhile = await readInProcess(space.id, [n as string, loose, p as string], {
				store: ctx.store,
			});
			expect(Object.fromEntries(meanwhile)).toEqual({
				[n as string]: true,
				[loose]: true,
				[p as string]: false,
			});

			// The rebuild derives them and marks the spaces done.
			const pending = await ctx.store.listSpacesPendingInProcess({ limit: 1000 });
			expect(pending.map((x) => x.id)).toEqual(expect.arrayContaining([space.id, session.id]));
			const rebuilt = await rebuildOutlineInProcess({ store: ctx.store });
			expect(rebuilt.left).toBe(0);
			expect(rebuilt.spaces).toBeGreaterThanOrEqual(2);
			await check(space);
			await check(session);
			const still = await ctx.store.listSpacesPendingInProcess({ limit: 1000 });
			expect(still.map((x) => x.id)).not.toContain(space.id);
			expect(still.map((x) => x.id)).not.toContain(session.id);
			// The guard: a write planned against an older counter writes nothing.
			const seq = (await ctx.store.getSpace(space.id))?.nextSeq as number;
			expect(
				await ctx.store.setInProcess(space.id, seq - 1, {
					inProcess: [p as string],
					notInProcess: [],
				}),
			).toBe(false);
			expect((await ctx.store.getBlock(p as string))?.inProcess).toBe(false);
		},
	},
	{
		name: "in process: a change past the row limit is written; the background rebuild catches up, reads use the tree meanwhile",
		async run(ctx) {
			const { space, n1 } = await setup(ctx);
			const big = await write(ctx, space, n1, [
				{ op: "insert", tempId: "p", parent: null, content: "plan" },
				{ op: "insert", parent: { tempId: "p" }, content: "big", task: { status: "todo" } },
				{ op: "insert", parent: { tempId: "p" }, content: "a fact beside it" },
			]);
			const [, bigId, beside] = big.results.map((x) => x.blockId) as [string, string, string];
			for (let made = 0; made <= OUTLINE_LIMITS.maxRowsTouched; made += OUTLINE_LIMITS.maxOps) {
				await write(
					ctx,
					space,
					n1,
					Array.from({ length: OUTLINE_LIMITS.maxOps }, (_, i) => ({
						op: "insert" as const,
						parent: { id: bigId },
						content: `row ${made + i}`,
					})),
				);
			}
			checkInProcess(await ctx.dump(space.id));
			const children = (await ctx.store.listChildren(space.id, bigId, 3000)).map((b) => b.id);
			expect(children.length).toBeGreaterThan(OUTLINE_LIMITS.maxRowsTouched);

			const saved = { ...OUTLINE_IN_PROCESS_TIMING };
			// Hold the background run back so the state in between can be looked at.
			OUTLINE_IN_PROCESS_TIMING.requestDelayMs = 3_600_000;
			try {
				// The checkbox comes off a block with more children than one commit may write: the
				// write goes through; the space is marked for the rebuild.
				const off = await write(ctx, space, n1, [
					{ op: "setTask", block: { id: bigId }, task: null },
					{ op: "update", block: { id: beside }, content: "a fact beside it, edited" },
				]);
				expect(off.commit).not.toBeNull();
				expect((await ctx.store.getBlock(bigId))?.taskJson).toBeNull();
				expect((await ctx.store.getBlock(bigId))?.inProcess).toBe(false);
				expect((await ctx.store.getBlock(beside))?.content).toBe("a fact beside it, edited");
				// The children keep the stale answer until the rebuild…
				expect((await ctx.store.getBlock(children[0] as string))?.inProcess).toBe(true);
				expect((await ctx.store.getInProcessState([space.id])).get(space.id)?.ready).toBe(false);
				expect(await outlineSpacesWithInProcess([space.id], { store: ctx.store })).toEqual(
					new Set(),
				);
				// …but a read does not use it: computed from the tree, every answer is right.
				const want = expectedInProcess(await ctx.dump(space.id));
				const read = await readInProcess(space.id, [...want.keys()], { store: ctx.store });
				expect(read.size).toBe(want.size);
				for (const [id, value] of want) expect([id, read.get(id)]).toEqual([id, value]);
				// Smaller changes go on being written as usual meanwhile.
				const t2 = await write(ctx, space, n1, [
					{ op: "insert", parent: { id: beside }, content: "small task", task: { status: "todo" } },
				]);
				expect((await ctx.store.getBlock(t2.results[0]?.blockId as string))?.inProcess).toBe(true);

				// The run the commit asked for.
				const result = await runOutlineInProcessRebuild(ctx.store);
				expect(result?.left).toBe(0);
				expect(await outlineSpacesWithInProcess([space.id], { store: ctx.store })).toEqual(
					new Set([space.id]),
				);
				checkInProcess(await ctx.dump(space.id));
				const after = await readInProcess(space.id, children.slice(0, 50), { store: ctx.store });
				expect([...after.values()].every((v) => v === false)).toBe(true);

				// A commit landing during a rebuild that changes only text does not hold it up; one
				// that changes structure makes it look again before calling the space done.
				for (const kind of ["text", "structure"] as const) {
					await ctx.resetInProcess(space.id);
					let injected = false;
					const busy: OutlineStore = {
						...ctx.store,
						async setInProcess(spaceId, expectNextSeq, values) {
							if (!injected && spaceId === space.id && values.inProcess.length > 0) {
								injected = true;
								await write(
									ctx,
									space,
									n1,
									kind === "text"
										? [
												{
													op: "update",
													block: { id: beside },
													content: `edited during the ${kind} run`,
												},
											]
										: [
												{
													op: "insert",
													parent: { id: beside },
													content: "new",
													task: { status: "todo" },
												},
											],
								);
							}
							return ctx.store.setInProcess(spaceId, expectNextSeq, values);
						},
					};
					const run = await rebuildOutlineInProcess({ store: busy });
					expect(injected).toBe(true);
					expect(run).toMatchObject({ spaces: 1, left: 0 });
					checkInProcess(await ctx.dump(space.id));
					expect((await ctx.store.getInProcessState([space.id])).get(space.id)?.ready).toBe(true);
				}
			} finally {
				Object.assign(OUTLINE_IN_PROCESS_TIMING, saved);
			}
		},
	},
	{
		name: "concurrency: sessions starting one task at once: exactly one claims it, every round",
		async run(ctx) {
			const space = await ctx.store.ensureSpace(
				{ kind: "project", projectId: await ctx.seedProject() },
				NOW,
			);
			const narrators = await Promise.all(Array.from({ length: 6 }, () => ctx.seedNarrator()));
			const users = await Promise.all(Array.from({ length: 2 }, () => ctx.seedUser()));
			const writers: Writer[] = [
				...narrators.map((narratorId) => ({ kind: "agent" as const, narratorId })),
				...users.map((userId) => ({ kind: "human" as const, userId })),
			];
			const r = await write(ctx, space, writers[0] as Writer, [
				{ op: "insert", parent: null, content: "contested", task: { status: "todo" } },
			]);
			const task = r.results[0]?.blockId as string;
			const rnd = mulberry32(7);
			let epoch = 0;
			for (let round = 0; round < 6; round++) {
				const racers = writers.filter(() => rnd() < 0.7);
				if (racers.length < 2) racers.push(...writers.slice(0, 2));
				// Every session renews its leases meanwhile (as running sessions do): a renewal locks
				// claim rows in the order a commit does, so neither waits on the other in a cycle.
				const renewals = Promise.allSettled(
					narrators.map(async (narratorId) => {
						await new Promise((resolve) => setTimeout(resolve, Math.floor(rnd() * 3)));
						return await renewOutlineTaskLeases(narratorId, { store: ctx.store });
					}),
				);
				const outcomes = await Promise.allSettled(
					racers.map(async (writer, i) => {
						await new Promise((resolve) => setTimeout(resolve, Math.floor(rnd() * 3)));
						// Some carry another operation in the same transaction.
						const ops: OutlineOp[] =
							i % 2 === 0
								? [{ op: "insert", parent: null, content: `r${round}w${i}` }, doing(task)]
								: [doing(task)];
						return await write(ctx, space, writer, ops);
					}),
				);
				for (const renewal of await renewals) expect(renewal.status).toBe("fulfilled");
				const won = outcomes
					.map((o, i) => ({ o, writer: racers[i] as Writer }))
					.filter((x) => x.o.status === "fulfilled");
				expect(won).toHaveLength(1);
				const winner = won[0]?.writer as Writer;
				for (const o of outcomes) {
					if (o.status === "rejected") {
						expect(o.reason).toBeInstanceOf(OutlineTaskClaimedError);
						const holder = (o.reason as OutlineTaskClaimedError).holder;
						expect(holder.kind === "agent" ? holder.narratorId : holder.userId).toBe(
							winner.kind === "agent"
								? winner.narratorId
								: winner.kind === "human"
									? winner.userId
									: "",
						);
					}
				}
				epoch++;
				const claim = (await claimOf(ctx, task)) as OutlineTaskClaimRow;
				expect(claim.epoch).toBe(epoch);
				expect(winner.kind === "agent" ? claim.holderNarratorId : claim.holderUserId).toBe(
					winner.kind === "agent"
						? winner.narratorId
						: winner.kind === "human"
							? winner.userId
							: "",
				);
				// Only the winner's extra operation landed.
				const pages = await ctx.store.listChildren(space.id, null, 100);
				expect(pages.filter((b) => b.content.startsWith(`r${round}w`)).length).toBeLessThanOrEqual(
					1,
				);
				// Released for the next round.
				await write(ctx, space, winner, [status(task, "todo")]);
			}
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "claims: a session and its subagents are one holder; a subagent's claims pass to its root when its run ends",
		async run(ctx) {
			const { space, n2, ids } = await setup(ctx);
			const root = await ctx.seedNarrator();
			const sub = await ctx.seedNarrator({ parentId: root, rootId: root });
			const nested = await ctx.seedNarrator({ parentId: sub, rootId: root });
			const R: Writer = { kind: "agent", narratorId: root };
			const S: Writer = { kind: "agent", narratorId: sub };
			const N: Writer = { kind: "agent", narratorId: nested };
			const t0 = "2053-01-01T00:00:00.000Z";
			const r = await write(
				ctx,
				space,
				R,
				[
					{ op: "insert", parent: null, content: "step", task: { status: "todo" } },
					{ op: "insert", parent: null, content: "plan", task: { status: "doing" } },
					{ op: "insert", parent: null, content: "nested step", task: { status: "todo" } },
				],
				at(t0, 0),
			);
			const [step, plan, deep] = r.results.map((x) => x.blockId) as [string, string, string];
			expect((await claimOf(ctx, plan))?.holderNarratorId).toBe(root);

			// The subagent starts the step and returns; the root ticks it while the lease runs.
			await write(ctx, space, S, [doing(step)], at(t0, 1));
			expect((await claimOf(ctx, step))?.holderNarratorId).toBe(sub);
			const ticked = await write(ctx, space, R, [status(step, "done")], at(t0, 3));
			expect(ticked.ended).toBeUndefined();
			expect(await claimOf(ctx, step)).toMatchObject({
				holderNarratorId: null,
				lastHolderNarratorId: sub,
			});
			// The other way round: the subagent finishes what its root is doing.
			const other = await write(ctx, space, S, [status(plan, "done")], at(t0, 4));
			expect(other.ended).toBeUndefined();
			// A nested subagent belongs to the same session.
			await write(ctx, space, S, [doing(deep)], at(t0, 5));
			await write(ctx, space, N, [status(deep, "done")], at(t0, 6));
			await write(ctx, space, N, [status(deep, "todo")], at(t0, 6));

			// Starting what its session already holds changes nothing: no commit, the holder stays.
			await write(ctx, space, R, [doing(deep)], at(t0, 7));
			const held = await claimOf(ctx, deep);
			const again = await write(ctx, space, S, [doing(deep)], at(t0, 8));
			expect(again.commit).toBeNull();
			expect(await claimOf(ctx, deep)).toEqual(held);
			// Another session is still refused, naming the subagent or the root.
			await write(ctx, space, S, [doing(step)], at(t0, 9));
			const refusal = await refused(write(ctx, space, n2, [status(step, "done")], at(t0, 10)));
			expect(refusal.holder).toMatchObject({ kind: "agent", narratorId: sub });
			await refused(write(ctx, space, n2, [doing(deep)], at(t0, 10)));

			// The subagent's run ends: what it holds passes to the root, on a new lease, same epoch.
			const before = (await claimOf(ctx, step)) as OutlineTaskClaimRow;
			const clock = at(t0, 11).getTime();
			const subRun = keepOutlineTaskLeases(sub, {
				store: ctx.store,
				now: () => clock,
				enabled: () => true,
				intervalMs: 0,
			});
			await subRun.stop();
			expect(await claimOf(ctx, step)).toMatchObject({
				holderNarratorId: root,
				epoch: before.epoch,
				expiresAt: at(t0, 21).toISOString(),
			});
			// A root's run ending moves nothing.
			const rootRun = keepOutlineTaskLeases(root, {
				store: ctx.store,
				now: () => clock,
				enabled: () => true,
				intervalMs: 0,
			});
			await rootRun.stop();
			expect((await claimOf(ctx, step))?.holderNarratorId).toBe(root);
			expect((await claimOf(ctx, deep))?.holderNarratorId).toBe(root);

			// A subagent whose lease lapsed without a hand-back (it crashed): its session starting the
			// task again holds it, on a new lease, without a commit or a new epoch.
			await write(ctx, space, S, [status(step, "todo")], at(t0, 30));
			await write(ctx, space, S, [doing(step)], at(t0, 31));
			const lapsed = (await claimOf(ctx, step)) as OutlineTaskClaimRow;
			const seq = (await ctx.store.getSpace(space.id))?.nextSeq;
			const resumed = await write(ctx, space, R, [doing(step)], at(t0, 45));
			expect(resumed.commit).toBeNull();
			expect((await ctx.store.getSpace(space.id))?.nextSeq).toBe(seq);
			expect(await claimOf(ctx, step)).toEqual({
				...lapsed,
				holderNarratorId: root,
				expiresAt: at(t0, 55).toISOString(),
			});
			expect(ids.n1).not.toBe(root);
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "claims: a session may end a task its own person is doing (recorded), but not take it over",
		async run(ctx) {
			const { space, ids } = await setup(ctx);
			const user = await ctx.seedUser();
			const stranger = await ctx.seedUser();
			const t0 = "2054-01-01T00:00:00.000Z";
			const as = (narratorId: string, responsibleUserId: string | null) => ({
				actor: { kind: "agent" as const, id: narratorId },
				narratorId,
				responsibleUserId,
			});
			const run = (who: ReturnType<typeof as>, ops: OutlineOp[], minute: number) =>
				writeOutline(
					{ spaceId: space.id, ops, ...who },
					{ store: ctx.store, now: () => at(t0, minute) },
				);
			const r = await write(
				ctx,
				space,
				{ kind: "human", userId: user },
				[
					{ op: "insert", parent: null, content: "review the PR", task: { status: "doing" } },
					{ op: "insert", tempId: "p", parent: null, content: "page" },
					{ op: "insert", parent: { tempId: "p" }, content: "deep", task: { status: "doing" } },
				],
				at(t0, 0),
			);
			const [task, page, deep] = r.results.map((x) => x.blockId) as [string, string, string];
			// Another person's session cannot end it, nor can a session acting for nobody.
			for (const who of [as(ids.n1, stranger), as(ids.n1, null)]) {
				const error = await refused(run(who, [status(task, "done")], 1));
				expect(error.holder).toEqual({ kind: "human", userId: user });
			}
			// The person's own session cannot take it over silently…
			await refused(run(as(ids.n2, user), [doing(task)], 2));
			// …but can finish it for them: written, and recorded as ending the person's work.
			const done = await run(as(ids.n2, user), [status(task, "done")], 3);
			expect(done.ended).toEqual([
				{
					blockId: task,
					address: `${space.key}/${(await ctx.store.getBlock(task))?.sid}`,
					holder: { kind: "human", userId: user },
				},
			]);
			const commit = (await ctx.store.listCommits(space.id, { limit: 100 })).at(-1);
			expect(commit?.summary).toContain("ended work someone else was doing");
			expect(await claimOf(ctx, task)).toMatchObject({
				holderUserId: null,
				lastHolderUserId: user,
			});
			// Deleting the page the person's task is on, likewise.
			const gone = await run(as(ids.n2, user), [{ op: "delete", block: { id: page } }], 4);
			expect(gone.ended?.map((e) => e.blockId)).toEqual([deep]);
			expect((await claimOf(ctx, deep))?.holderUserId).toBeNull();
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "claims: undoing the commit that ended a session's task gives it back to that session",
		async run(ctx) {
			const { space, n1, ids } = await setup(ctx);
			const user = await ctx.seedUser();
			const other = await ctx.seedUser();
			const person: Writer = { kind: "human", userId: user };
			const t0 = "2055-01-01T00:00:00.000Z";
			const undo = (commitId: string, by: string, minute: number) =>
				revertCommit(
					{ commitId, actor: { kind: "human", id: by }, responsibleUserId: by },
					{ store: ctx.store, now: () => at(t0, minute) },
				);
			const r = await write(
				ctx,
				space,
				n1,
				[
					{ op: "insert", parent: null, content: "fix login", task: { status: "doing" } },
					{ op: "insert", parent: null, content: "write docs", task: { status: "doing" } },
				],
				at(t0, 0),
			);
			const [t, u] = r.results.map((x) => x.blockId) as [string, string];

			// The session's own "done", undone by the person: the session has it again, on a lease
			// from the revert, in a new generation; it can carry on and finish it.
			const done = await write(ctx, space, n1, [status(t, "done")], at(t0, 1));
			await undo(done.commit?.id as string, user, 2);
			expect(await claimOf(ctx, t)).toMatchObject({
				holderNarratorId: ids.n1,
				holderUserId: null,
				epoch: 2,
				expiresAt: at(t0, 12).toISOString(),
				lastHolderNarratorId: null,
			});
			const found = await findContinuationCandidates({
				narratorId: ids.n1,
				sessionSpaceId: null,
				store: ctx.store,
				now: at(t0, 3),
			});
			expect(found.candidates.map((c) => c.blockId)).toContain(t);
			await write(ctx, space, n1, [status(t, "done")], at(t0, 3));

			// A person ending the session's task by mistake, then undoing it: back to the session.
			const ticked = await write(ctx, space, person, [status(u, "done")], at(t0, 4));
			expect(ticked.ended?.map((e) => e.blockId)).toEqual([u]);
			await undo(ticked.commit?.id as string, user, 5);
			expect(await claimOf(ctx, u)).toMatchObject({ holderNarratorId: ids.n1, holderUserId: null });

			// A subagent's work goes back to its session's root.
			const root = await ctx.seedNarrator();
			const sub = await ctx.seedNarrator({ parentId: root, rootId: root });
			const S: Writer = { kind: "agent", narratorId: sub };
			const s = await write(
				ctx,
				space,
				S,
				[{ op: "insert", parent: null, content: "sub step", task: { status: "doing" } }],
				at(t0, 6),
			);
			const step = s.results[0]?.blockId as string;
			const subDone = await write(ctx, space, S, [status(step, "done")], at(t0, 7));
			await undo(subDone.commit?.id as string, user, 8);
			expect((await claimOf(ctx, step))?.holderNarratorId).toBe(root);

			// A person's own task undone by someone else, and a session that no longer exists: the
			// one who undoes it is doing it.
			const p = await write(
				ctx,
				space,
				person,
				[{ op: "insert", parent: null, content: "mine", task: { status: "doing" } }],
				at(t0, 9),
			);
			const mine = p.results[0]?.blockId as string;
			const mineDone = await write(ctx, space, person, [status(mine, "done")], at(t0, 10));
			await undo(mineDone.commit?.id as string, other, 11);
			expect(await claimOf(ctx, mine)).toMatchObject({
				holderUserId: other,
				holderNarratorId: null,
			});
			const ghost: Writer = { kind: "agent", narratorId: "no-such-session" };
			const g = await write(
				ctx,
				space,
				ghost,
				[{ op: "insert", parent: null, content: "orphan", task: { status: "doing" } }],
				at(t0, 12),
			);
			const orphan = g.results[0]?.blockId as string;
			const ghostDone = await write(ctx, space, ghost, [status(orphan, "done")], at(t0, 13));
			await undo(ghostDone.commit?.id as string, user, 14);
			expect(await claimOf(ctx, orphan)).toMatchObject({
				holderUserId: user,
				holderNarratorId: null,
			});
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "leases: a session starting its lapsed task again holds it only if the expiry job has not reopened it first",
		async run(ctx) {
			const { space, n1, ids } = await setup(ctx);
			const t0 = "2056-01-01T00:00:00.000Z";
			const r = await write(
				ctx,
				space,
				n1,
				[
					{ op: "insert", parent: null, content: "lapsing", task: { status: "doing" } },
					{ op: "insert", parent: null, content: "raced", task: { status: "doing" } },
				],
				at(t0, 0),
			);
			const [quiet, raced] = r.results.map((x) => x.blockId) as [string, string];
			// Lapsed, nobody reopened it: the session starting it again renews it, without a commit.
			const before = (await claimOf(ctx, quiet)) as OutlineTaskClaimRow;
			const seq = (await ctx.store.getSpace(space.id))?.nextSeq;
			const renewed = await write(ctx, space, n1, [doing(quiet)], at(t0, 12));
			expect(renewed.commit).toBeNull();
			expect((await ctx.store.getSpace(space.id))?.nextSeq).toBe(seq);
			expect(await claimOf(ctx, quiet)).toEqual({ ...before, expiresAt: at(t0, 22).toISOString() });

			// The expiry job reopens the other one between the session's plan and its renewal: the
			// renewal is not written, the write plans again and claims the reopened task afresh.
			let expired = false;
			const racing: OutlineStore = {
				...ctx.store,
				async updateTaskClaims(writes) {
					if (!expired) {
						expired = true;
						const result = await expireOutlineTaskLeases({ store: ctx.store, now: at(t0, 13) });
						expect(result.reopened).toBeGreaterThanOrEqual(1);
					}
					return ctx.store.updateTaskClaims(writes);
				},
			};
			const again = await write(ctx, space, n1, [doing(raced)], at(t0, 13), racing);
			expect(expired).toBe(true);
			expect(again.commit).not.toBeNull();
			expect((await ctx.store.getBlock(raced))?.taskJson?.status).toBe("doing");
			expect(await claimOf(ctx, raced)).toMatchObject({
				holderNarratorId: ids.n1,
				epoch: 2,
				expiresAt: at(t0, 23).toISOString(),
			});
			// Started again in a commit that changes something else: renewed in that commit.
			await write(
				ctx,
				space,
				n1,
				[doing(quiet), { op: "update", block: { id: quiet }, content: "lapsing, renamed" }],
				at(t0, 40),
			);
			expect((await claimOf(ctx, quiet))?.expiresAt).toBe(at(t0, 50).toISOString());
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "leases: tasks in progress that nobody holds are reopened by the lease job, a bounded slice per run",
		async run(ctx) {
			const { space, n1 } = await setup(ctx);
			const t0 = "2057-01-01T00:00:00.000Z";
			const r = await write(
				ctx,
				space,
				n1,
				[
					{ op: "insert", parent: null, content: "legacy one", task: { status: "doing" } },
					{ op: "insert", parent: null, content: "legacy two", task: { status: "doing" } },
					{ op: "insert", parent: null, content: "held", task: { status: "doing" } },
				],
				at(t0, 0),
			);
			const [one, two, held] = r.results.map((x) => x.blockId) as [string, string, string];
			// Written before claims existed: in progress, no claim row.
			await ctx.forgetClaims([one, two]);
			// The job claims nothing for them, so another write claiming one in between wins.
			let claimed = false;
			const racing: OutlineStore = {
				...ctx.store,
				async listUnclaimedDoingTasks(options) {
					const found = await ctx.store.listUnclaimedDoingTasks(options);
					if (!claimed && found.tasks.some((t) => t.blockId === two)) {
						claimed = true;
						await write(ctx, space, n1, [doing(two)], at(t0, 1));
					}
					return found;
				},
			};
			resetOutlineUnclaimedScanForTests();
			let skipped = 0;
			// Small slices, as many runs as it takes to pass over every task in progress.
			for (let run = 0; run < 500; run++) {
				const result = await reopenUnclaimedOutlineTasks({
					store: racing,
					now: at(t0, 2),
					scan: 20,
				});
				skipped += result.skipped;
				if ((await ctx.store.getBlock(one))?.taskJson?.status === "todo" && claimed) break;
			}
			expect(claimed).toBe(true);
			expect(skipped).toBeGreaterThanOrEqual(1);
			expect((await ctx.store.getBlock(one))?.taskJson?.status).toBe("todo");
			const notes = await ctx.store.listChildren(space.id, one, 10);
			expect(notes.at(-1)?.content).toContain("no session or person was holding it");
			const commit = (await ctx.store.listCommits(space.id, { limit: 100 })).find(
				(c) => c.actorId === OUTLINE_LEASE_ACTOR,
			);
			expect(commit?.actorKind).toBe("system");
			// The one claimed in between and the one held all along are untouched.
			expect((await ctx.store.getBlock(two))?.taskJson?.status).toBe("doing");
			expect((await ctx.store.getBlock(held))?.taskJson?.status).toBe("doing");
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
];
