/**
 * The contract of questions put to people (`Ask`, P2 PR 7): a question's `ask_json` is versioned
 * with its block and its routing row (`outline_questions`) follows it in the same commit (asked,
 * answered, reverted, deleted, restored); a block is a question or a task, never both; open
 * questions make their nearest task wait for people (not when the asker went ahead); a person's
 * inbox groups their questions by the block they are under; answered rows wait for delivery; and
 * the digest of what an agent confirmed on a locker's behalf. Written once and run against SQLite
 * (`store-contract.test.ts`) and PostgreSQL (`tests/server/services/outline/pg-outline-store.test.ts`,
 * `PG_INTEGRATION=1`). Store and write path only: the access checks of the services are tested
 * on SQLite (`questions.test.ts`).
 */
import { expect } from "bun:test";
import { OutlineWriteError } from "../errors";
import type { OutlineAskJson } from "../model";
import { confirmOutlinePending, lockOutlineTask } from "../pending";
import { listQuestionGroupsForUser, questionWaits } from "../questions";
import { revertCommit } from "../revert";
import type { OutlineSpaceRow } from "../store/port";
import { deriveOutlineTaskWaits } from "../tasks";
import { type OutlineOp, type OutlineWriteResult, writeOutline } from "../write";
import { type ContractCase, checkSpaceInvariants, type OutlineContractContext } from "./contract";

const NOW = "2026-11-03T00:00:00.000Z";

function ask(to: string, extra: Partial<OutlineAskJson> = {}): OutlineAskJson {
	return {
		to: { kind: "human", id: to },
		options: ["Keep the old format", "Switch to v2"],
		recommend: { option: 2, reason: "v2 is what the importer reads" },
		...extra,
	};
}

async function personWrites(
	ctx: OutlineContractContext,
	space: OutlineSpaceRow,
	userId: string,
	ops: OutlineOp[],
	kind?: "answer",
): Promise<OutlineWriteResult> {
	return writeOutline(
		{ spaceId: space.id, ops, actor: { kind: "human", id: userId }, responsibleUserId: userId },
		{ store: ctx.store, now: () => new Date(NOW), ...(kind ? { kind } : {}) },
	);
}

async function agentAsks(
	ctx: OutlineContractContext,
	space: OutlineSpaceRow,
	narratorId: string,
	userId: string,
	ops: OutlineOp[],
): Promise<OutlineWriteResult> {
	return writeOutline(
		{
			spaceId: space.id,
			ops,
			actor: { kind: "agent", id: narratorId },
			narratorId,
			responsibleUserId: userId,
		},
		{
			store: ctx.store,
			now: () => new Date(NOW),
			question: { askerNarratorId: narratorId, askerUserId: userId, askerToolCallId: "call-1" },
		},
	);
}

/** A project space with a task `T` (written by `person`) and a fact page `F`. */
async function setup(ctx: OutlineContractContext) {
	const person = await ctx.seedUser();
	const other = await ctx.seedUser();
	const narratorId = await ctx.seedNarrator();
	const space = await ctx.store.ensureSpace(
		{ kind: "project", projectId: await ctx.seedProject() },
		NOW,
	);
	const made = await personWrites(ctx, space, person, [
		{ op: "insert", tempId: "page", parent: null, content: "Importer" },
		{
			op: "insert",
			tempId: "task",
			parent: { tempId: "page" },
			content: "Ship the importer",
			task: { status: "doing" },
		},
		{ op: "insert", tempId: "fact", parent: null, content: "Formats we read" },
	]);
	const [page, task, fact] = made.results.map((r) => r.blockId) as [string, string, string];
	return { person, other, narratorId, space, page, task, fact };
}

export const OUTLINE_QUESTION_CONTRACT: ContractCase[] = [
	{
		name: "question: ask_json is versioned and its routing row follows it (answer, revert, delete)",
		async run(ctx) {
			const s = await setup(ctx);
			const asked = await agentAsks(ctx, s.space, s.narratorId, s.person, [
				{ op: "insert", parent: { id: s.task }, content: "Which format?", ask: ask(s.person) },
			]);
			const q = asked.results[0]?.blockId as string;
			let [row] = await ctx.store.getQuestions([q]);
			expect(row).toMatchObject({
				blockId: q,
				spaceId: s.space.id,
				state: "open",
				proceed: false,
				toUserId: s.person,
				askerNarratorId: s.narratorId,
				askerUserId: s.person,
				askerToolCallId: "call-1",
				answeredAt: null,
				answerCommitId: null,
				deliveredAt: null,
			});
			// A question is process: in the in-process cache, and its task waits for people.
			const block = await ctx.store.getBlock(q);
			expect(block?.askJson).toEqual(ask(s.person));
			expect(block?.inProcess).toBe(true);
			const taskMeta = (await ctx.store.getBlockMetas(s.space.id, { ids: [s.task] }))[0];
			const subject = { id: s.task, spaceId: s.space.id, taskJson: taskMeta?.taskJson ?? null };
			expect([...(await questionWaits([subject], { store: ctx.store }))]).toEqual([s.task]);
			expect(
				(await deriveOutlineTaskWaits([subject], { store: ctx.store })).get(s.task)?.people,
			).toBe(true);
			expect(
				(await ctx.store.listOpenQuestionsBySpaces([s.space.id, "no-such-space"], 10)).map(
					(r) => r.blockId,
				),
			).toEqual([q]);
			expect(
				(await ctx.store.listOpenQuestionsByAsker(s.narratorId, 10)).map((r) => r.blockId),
			).toEqual([q]);

			// The person answers: one `answer` commit; the row is answered, not yet delivered.
			const answer = {
				option: 2,
				adopted: true as const,
				by: { kind: "human" as const, id: s.person },
				at: NOW,
			};
			const answered = await personWrites(
				ctx,
				s.space,
				s.person,
				[{ op: "update", block: { id: q }, ask: { ...ask(s.person), answer } }],
				"answer",
			);
			[row] = await ctx.store.getQuestions([q]);
			expect(row).toMatchObject({
				state: "answered",
				answeredAt: NOW,
				answerCommitId: answered.commit?.id,
				deliveredAt: null,
				askerNarratorId: s.narratorId,
			});
			let dump = await ctx.dump(s.space.id);
			expect(dump.commits.find((c) => c.id === answered.commit?.id)?.kind).toBe("answer");
			checkSpaceInvariants(dump);
			expect(await questionWaits([subject], { store: ctx.store })).toEqual(new Set());
			expect((await ctx.store.listUndeliveredAnswers(10)).map((r) => r.blockId)).toContain(q);
			expect(await ctx.store.markQuestionsDelivered([q], NOW)).toBe(1);
			expect(await ctx.store.markQuestionsDelivered([q], NOW)).toBe(0);
			expect((await ctx.store.listUndeliveredAnswers(10)).map((r) => r.blockId)).not.toContain(q);

			// Reverting the answer reopens the question; the task waits again. The row keeps its last
			// answer's commit and delivery (review N1).
			const reopened = await revertCommit(
				{
					commitId: answered.commit?.id as string,
					actor: { kind: "human", id: s.person },
					responsibleUserId: s.person,
				},
				{ store: ctx.store },
			);
			[row] = await ctx.store.getQuestions([q]);
			expect(row).toMatchObject({
				state: "open",
				answeredAt: NOW,
				answerCommitId: answered.commit?.id,
				deliveredAt: NOW,
			});
			expect((await ctx.store.getBlock(q))?.askJson?.answer).toBeUndefined();
			expect([...(await questionWaits([subject], { store: ctx.store }))]).toEqual([s.task]);

			// Reverting the revert brings the same answer back: no new answer, nothing to deliver.
			await revertCommit(
				{
					commitId: reopened.commit?.id as string,
					actor: { kind: "human", id: s.person },
					responsibleUserId: s.person,
				},
				{ store: ctx.store },
			);
			[row] = await ctx.store.getQuestions([q]);
			expect(row).toMatchObject({
				state: "answered",
				answerCommitId: answered.commit?.id,
				deliveredAt: NOW,
			});
			expect((await ctx.store.listUndeliveredAnswers(10)).map((r) => r.blockId)).not.toContain(q);

			// Deleting the block withdraws it; bringing it back is the same answered question, still
			// delivered (undoing a delete tells the asker nothing again).
			const deleted = await personWrites(ctx, s.space, s.person, [
				{ op: "delete", block: { id: q } },
			]);
			[row] = await ctx.store.getQuestions([q]);
			expect(row?.state).toBe("withdrawn");
			expect(await ctx.store.listOpenQuestionsForUser(s.person, 10)).toEqual([]);
			await revertCommit(
				{
					commitId: deleted.commit?.id as string,
					actor: { kind: "human", id: s.person },
					responsibleUserId: s.person,
				},
				{ store: ctx.store },
			);
			[row] = await ctx.store.getQuestions([q]);
			expect(row).toMatchObject({
				state: "answered",
				askerNarratorId: s.narratorId,
				answerCommitId: answered.commit?.id,
				deliveredAt: NOW,
			});
			expect((await ctx.store.listUndeliveredAnswers(10)).map((r) => r.blockId)).not.toContain(q);
			dump = await ctx.dump(s.space.id);
			checkSpaceInvariants(dump);
			// The history holds every state of the question.
			const versions = dump.versions
				.filter((v) => v.blockId === q)
				.sort((a, b) => a.fromSeq - b.fromSeq);
			expect(
				versions.map((v) => (v.deleted ? "gone" : v.askJson?.answer ? "answered" : "open")),
			).toEqual(["open", "answered", "open", "answered", "gone", "answered"]);
		},
	},
	{
		name: "question: a block is a question or a task, never both; proceed makes nothing wait",
		async run(ctx) {
			const s = await setup(ctx);
			const asked = await agentAsks(ctx, s.space, s.narratorId, s.person, [
				{ op: "insert", parent: { id: s.task }, content: "Which format?", ask: ask(s.person) },
				{
					op: "insert",
					parent: { id: s.task },
					content: "Name the flag?",
					ask: ask(s.person, { proceed: true }),
				},
			]);
			const [q, went] = asked.results.map((r) => r.blockId) as [string, string];
			for (const ops of [
				[{ op: "setTask", block: { id: q }, task: { status: "todo" } }],
				[
					{
						op: "insert",
						parent: { id: s.task },
						content: "Both",
						task: { status: "todo" },
						ask: ask(s.person),
					},
				],
				[{ op: "update", block: { id: s.task }, ask: ask(s.person) }],
			] as OutlineOp[][]) {
				const error = await personWrites(ctx, s.space, s.person, ops).catch((e) => e);
				expect(error).toBeInstanceOf(OutlineWriteError);
				expect((error as OutlineWriteError).message).toContain("is a question");
			}
			const [goneAhead] = await ctx.store.getQuestions([went]);
			expect(goneAhead?.proceed).toBe(true);
			// Withdraw the one that waits: then the task waits for nothing.
			const block = await ctx.store.getBlock(q);
			await agentAsks(ctx, s.space, s.narratorId, s.person, [
				{
					op: "update",
					block: { id: q },
					ask: {
						...(block?.askJson as OutlineAskJson),
						withdrawn: { by: { kind: "agent", id: s.narratorId }, at: NOW },
					},
				},
			]);
			expect((await ctx.store.getQuestions([q]))[0]?.state).toBe("withdrawn");
			const meta = (await ctx.store.getBlockMetas(s.space.id, { ids: [s.task] }))[0];
			expect(
				await questionWaits(
					[{ id: s.task, spaceId: s.space.id, taskJson: meta?.taskJson ?? null }],
					{
						store: ctx.store,
					},
				),
			).toEqual(new Set());
			checkSpaceInvariants(await ctx.dump(s.space.id));
		},
	},
	{
		name: "question: a person's inbox groups their questions by the block they are under",
		async run(ctx) {
			const s = await setup(ctx);
			const asked = await agentAsks(ctx, s.space, s.narratorId, s.person, [
				{
					op: "insert",
					tempId: "q1",
					parent: { id: s.task },
					content: "Q one",
					ask: ask(s.person),
				},
				{ op: "insert", parent: { tempId: "q1" }, content: "Q one, detail", ask: ask(s.person) },
				{ op: "insert", parent: { id: s.task }, content: "Q two", ask: ask(s.person) },
				{ op: "insert", parent: { id: s.task }, content: "Q other's", ask: ask(s.other) },
				{ op: "insert", parent: null, content: "Q at the top", ask: ask(s.person) },
				{ op: "insert", parent: { id: s.fact }, content: "Q on a fact", ask: ask(s.person) },
			]);
			const [q1, q1a, q2, q3, top, onFact] = asked.results.map((r) => r.blockId) as string[];
			// A question two levels down (moved under a sub-question) goes with the topmost one's
			// group, the block that one is under (review N2).
			const deep = await agentAsks(ctx, s.space, s.narratorId, s.person, [
				{ op: "insert", parent: { id: q1a as string }, content: "Q deeper", ask: ask(s.person) },
			]);
			const q1b = deep.results[0]?.blockId as string;
			// Open questions of many spaces in one read, at most so many of each, oldest first.
			const elsewhere = await ctx.store.ensureSpace(
				{ kind: "session", narratorId: s.narratorId },
				NOW,
			);
			const third = await ctx.seedUser();
			const there = await agentAsks(ctx, elsewhere, s.narratorId, s.person, [
				{ op: "insert", parent: null, content: "Q elsewhere", ask: ask(third) },
			]);
			const capped = await ctx.store.listOpenQuestionsBySpaces([s.space.id, elsewhere.id], 2);
			const here = [q1, q1a, q2, q3, top, onFact, q1b].sort() as string[];
			const bySpaceThenId = (a: string[], b: string[]) =>
				(a[0] as string) < (b[0] as string) ? -1 : (a[0] as string) > (b[0] as string) ? 1 : 0;
			expect(capped.map((r) => [r.spaceId, r.blockId])).toEqual(
				[
					[s.space.id, here[0] as string],
					[s.space.id, here[1] as string],
					[elsewhere.id, there.results[0]?.blockId as string],
				].sort(bySpaceThenId),
			);
			// A page's own open questions, newest first, whatever else the space has open: every
			// level under the page, not the other pages', the other spaces', deleted or answered ones.
			const onPage = [q1, q1a, q2, q3, q1b] as string[];
			const pageRead = await ctx.store.listOpenQuestionBlocksOnPage(s.space.id, s.page, 50);
			expect([...pageRead].sort()).toEqual([...onPage].sort());
			expect(await ctx.store.listOpenQuestionBlocksOnPage(s.space.id, s.fact, 50)).toEqual([
				onFact as string,
			]);
			expect(await ctx.store.listOpenQuestionBlocksOnPage(s.space.id, top as string, 50)).toEqual([
				top as string,
			]);
			expect((await ctx.store.listOpenQuestionBlocksOnPage(s.space.id, s.page, 2)).length).toBe(2);
			expect(await ctx.store.listOpenQuestionBlocksOnPage(elsewhere.id, s.page, 50)).toEqual([]);
			expect(await ctx.store.listOpenQuestionBlocksOnPage(s.space.id, "no-such-page", 50)).toEqual(
				[],
			);
			const { groups, truncated } = await listQuestionGroupsForUser(s.person, { store: ctx.store });
			expect(truncated).toBe(false);
			const byGroup = new Map(groups.map((g) => [g.groupBlockId, g]));
			expect(byGroup.get(s.task)?.questionIds.sort()).toEqual([q1, q1a, q1b, q2].sort());
			expect(byGroup.get(s.task)?.title).toBe("Ship the importer");
			// Titles come from bounded prefixes of the content, never whole bodies (review S10).
			expect(await ctx.store.getContentHeads([s.task, top as string, "nope"], 4)).toEqual(
				new Map([
					[s.task, "Ship"],
					[top as string, "Q at"],
				]),
			);
			expect(byGroup.get(s.task)?.askers).toEqual([s.narratorId]);
			expect(byGroup.get(top as string)?.questionIds).toEqual([top]);
			expect(byGroup.get(s.fact)?.questionIds).toEqual([onFact]);
			expect(groups).toHaveLength(3);
			const others = await listQuestionGroupsForUser(s.other, { store: ctx.store });
			expect(others.groups.map((g) => [g.groupBlockId, g.questionIds])).toEqual([[s.task, [q3]]]);

			// Answering the group at once: one commit, every row answered.
			const ids = [q1, q1a, q1b, q2] as string[];
			const blocks = await ctx.store.getBlocks(ids);
			const result = await personWrites(
				ctx,
				s.space,
				s.person,
				blocks.map((b) => ({
					op: "update" as const,
					block: { id: b.id },
					baseVersionSeq: b.versionSeq,
					ask: {
						...(b.askJson as OutlineAskJson),
						answer: { option: 2, adopted: true, by: { kind: "human", id: s.person }, at: NOW },
					},
				})),
				"answer",
			);
			const rows = await ctx.store.getQuestions(ids);
			expect(rows.map((r) => r.state)).toEqual(["answered", "answered", "answered", "answered"]);
			expect(new Set(rows.map((r) => r.answerCommitId))).toEqual(
				new Set([result.commit?.id ?? null]),
			);
			expect(
				(await listQuestionGroupsForUser(s.person, { store: ctx.store })).groups.map(
					(g) => g.groupBlockId,
				),
			).not.toContain(s.task);
			// Answered ones are no longer the page's open questions; a deleted one goes too.
			expect(await ctx.store.listOpenQuestionBlocksOnPage(s.space.id, s.page, 50)).toEqual([
				q3 as string,
			]);
			await personWrites(ctx, s.space, s.person, [{ op: "delete", block: { id: q3 as string } }]);
			expect(await ctx.store.listOpenQuestionBlocksOnPage(s.space.id, s.page, 50)).toEqual([]);
			checkSpaceInvariants(await ctx.dump(s.space.id));
		},
	},
	{
		name: "digest: a confirmation an agent made on the locker's behalf, until acknowledged",
		async run(ctx) {
			const s = await setup(ctx);
			const delegate = await ctx.seedNarrator();
			const step = await personWrites(ctx, s.space, s.person, [
				{
					op: "insert",
					parent: { id: s.task },
					content: "Parse the header",
					task: { status: "todo" },
				},
				{
					op: "insert",
					parent: { id: s.task },
					content: "Load the rows",
					task: { status: "todo" },
				},
			]);
			await lockOutlineTask({
				blockId: s.task,
				userId: s.person,
				delegate,
				store: ctx.store,
				now: () => new Date(NOW),
			});
			// Another session rewrites a step of the locked plan: held for the locker.
			const proposed = await writeOutline(
				{
					spaceId: s.space.id,
					ops: [
						{
							op: "update",
							block: { id: step.results[0]?.blockId as string },
							content: "Parse it",
						},
					],
					actor: { kind: "agent", id: s.narratorId },
					narratorId: s.narratorId,
					responsibleUserId: s.person,
				},
				{ store: ctx.store, now: () => new Date(NOW) },
			);
			const pendingId = proposed.pending?.id as string;
			expect((await ctx.store.listOpenPendingForDecider(s.person, 10)).map((p) => p.id)).toEqual([
				pendingId,
			]);
			expect(await ctx.store.listUnseenDelegateConfirmations(s.person, 10)).toEqual([]);
			// The delegate confirms on the locker's behalf: it is in the locker's digest.
			await confirmOutlinePending({
				pendingId,
				by: { kind: "agent", narratorId: delegate, responsibleUserId: s.person },
				store: ctx.store,
				now: () => new Date(NOW),
			});
			expect(await ctx.store.listOpenPendingForDecider(s.person, 10)).toEqual([]);
			const digest = await ctx.store.listUnseenDelegateConfirmations(s.person, 10);
			expect(digest.map((p) => [p.id, p.status, p.decidedByJson?.id, p.digestSeenAt])).toEqual([
				[pendingId, "confirmed", delegate, null],
			]);
			expect(digest[0]?.decisionCommitId).not.toBeNull();
			expect(await ctx.store.listUnseenDelegateConfirmations(s.other, 10)).toEqual([]);
			expect(await ctx.store.markDelegateConfirmationsSeen(s.other, [pendingId], NOW)).toBe(0);
			expect(await ctx.store.markDelegateConfirmationsSeen(s.person, [pendingId], NOW)).toBe(1);
			expect(await ctx.store.listUnseenDelegateConfirmations(s.person, 10)).toEqual([]);
		},
	},
];
