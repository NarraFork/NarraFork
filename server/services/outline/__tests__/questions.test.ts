/**
 * Questions put to people through the `Ask` tool and the inbox (outline P2 PR 7), on the isolated
 * SQLite database: asking under the session's task in progress (who is asked, what waits),
 * answering a group at once (one `answer` commit as the person: their confirmation), telling the
 * asker (once per answer commit, as the person its turn ran for; nobody for a decision it went
 * ahead with and got; the session doing the task when the asker is archived), relaying an answer
 * given in the conversation, withdrawing, the inbox rows (questions, changes to confirm, the
 * digest) and `AskUserQuestion`'s async mode refused in an outline session.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own users,
 * projects and sessions. The delivery to sessions is replaced through its seam.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { narrators, outlineCommits, projects, users } from "../../../db/schema";
import { askUserQuestionTool } from "../../../lib/agent/tools/ask-user-question";
import { askTool, outlineEditTool, outlineReadTool } from "../../../lib/agent/tools/outline";
import type { ToolContext, ToolResult } from "../../../lib/agent/types";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { listHumanAttentionForPrincipal } from "../../human-attention-service";
import { stopEditTextWorker } from "../edit-text-runner";
import { listOutlineAttention, markOutlineDigestSeen, readOutlineDigest } from "../inbox";
import { confirmOutlinePending, lockOutlineTask } from "../pending";
import {
	answerOutlineQuestions,
	deliverOutlineAnswers,
	OutlineQuestionError,
	readQuestionsUnder,
	setOutlineAnswerDelivery,
	sweepOutlineAnswerDeliveries,
	withdrawArchivedSessionQuestions,
} from "../questions";
import { clearOutlineReads } from "../read-ledger";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensureProjectSpace } from "../spaces";
import { outlineStore } from "../store";
import { deriveOutlineTaskWaits, releaseOutlineSessionTaskClaims } from "../tasks";
import { writeOutline } from "../write";

const NOW = "2026-11-03T00:00:00.000Z";

async function user(label: string): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

async function narrator(owner: string, projectId: string, title: string): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title,
		ownerUserId: owner,
		visibility: "private",
		contextProjectId: projectId,
		taskBackend: "outline",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

function ctx(narratorId: string, userId: string): ToolContext {
	return {
		narratorId,
		cwd: "/",
		signal: new AbortController().signal,
		locale: "en",
		userId,
		requestPermission: async () => ({ behavior: "allow" }),
	} as ToolContext;
}

async function ask(c: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
	return await askTool.execute(args, c);
}

/** Deliveries the answers make, captured instead of written. */
type Delivered = {
	narratorId: string;
	content: string;
	createdBy: string | null;
	executionUserId: string | null;
};
let delivered: Delivered[] = [];

/**
 * A project of alice's with a task she wrote ("Ship the importer"), which session `a` is doing.
 * Bob is a person of the instance who is not in the project.
 */
async function world() {
	const alice = await user("alice");
	const bob = await user("bob");
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Importer",
		ownerUserId: alice,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	const a = await narrator(alice, projectId, "worker");
	const c = await narrator(alice, projectId, "other worker");
	const space = await ensureProjectSpace(projectId);
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "page", parent: null, content: "Importer" },
			{
				op: "insert",
				parent: { tempId: "page" },
				content: "Ship the importer",
				task: { status: "todo" },
			},
		],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
	const task = written.results[1] as { blockId: string; sid: string };
	// Session `a` starts the task: it holds it.
	await writeOutline({
		spaceId: space.id,
		ops: [{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } }],
		actor: { kind: "agent", id: a },
		narratorId: a,
		responsibleUserId: alice,
	});
	return { alice, bob, projectId, space, task, a, c, ca: ctx(a, alice) };
}

async function taskWaits(w: Awaited<ReturnType<typeof world>>) {
	const meta = (await outlineStore.getBlockMetas(w.space.id, { ids: [w.task.blockId] }))[0];
	return (
		await deriveOutlineTaskWaits(
			[{ id: w.task.blockId, spaceId: w.space.id, taskJson: meta?.taskJson ?? null }],
			{ store: outlineStore },
		)
	).get(w.task.blockId);
}

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateSessionReadScopes();
	clearOutlineReads();
	delivered = [];
	setOutlineAnswerDelivery({
		async deliver(narratorId, message) {
			delivered.push({ narratorId, ...message });
		},
	});
});

afterEach(() => {
	setOutlineAnswerDelivery(null);
	invalidateSessionReadScopes();
	stopEditTextWorker();
});

describe("Ask", () => {
	test("puts questions under the task in progress for its manager; the task waits; the inbox groups them", async () => {
		const w = await world();
		const result = await ask(w.ca, {
			questions: [
				{
					question: "Which export format do we read first?",
					options: ["v1", "v2"],
					recommend: 2,
					reason: "every export since March is v2",
					items: [{ question: "Keep reading v1 at all?", recommend: "yes, read-only" }],
				},
				{ question: "Fail on unknown columns?", recommend: "warn and skip them" },
			],
		});
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("Asked Q1");
		expect(result.output).toContain(`[${w.task.sid}] now waits for the answer`);
		const ids = result.metadata?.blockIds as string[];
		expect(ids).toHaveLength(3);
		const rows = await outlineStore.getQuestions(ids);
		expect(rows.map((r) => [r.state, r.toUserId, r.askerNarratorId, r.askerUserId])).toEqual(
			ids.map(() => ["open", w.alice, w.a, w.alice]),
		);
		expect((await taskWaits(w))?.people).toBe(true);

		// The agent reads the question with its choices and recommendation.
		const read = (await outlineReadTool.execute({ address: w.task.sid, view: "all" }, w.ca)).output;
		expect(read).toContain("Which export format do we read first?");
		expect(read).toMatch(/‹question for human:\S+ · 1\. v1 {2}2\. v2 · recommended: option 2/);

		// Alice's inbox: one row for the three questions under the task.
		const items = await listOutlineAttention({ userId: w.alice, isAdmin: false });
		const row = items.find((i) => i.id === `outline:q:${w.task.blockId}`);
		expect(row).toMatchObject({
			kind: "outline_decision",
			source: "outline",
			canAct: true,
			narratorId: w.a,
			summary: "Ship the importer",
			outline: { what: "questions", blockId: w.task.blockId, count: 3 },
		});
		const page = await listHumanAttentionForPrincipal({ userId: w.alice, isAdmin: false });
		expect(page.items.map((i) => i.id)).toContain(`outline:q:${w.task.blockId}`);
		expect(await listOutlineAttention({ userId: w.bob, isAdmin: false })).toEqual([]);

		const group = await readQuestionsUnder(w.task.blockId, { userId: w.alice, isAdmin: false });
		expect(group?.questions.map((q) => [q.alias, q.canAnswer, q.recommend.option])).toEqual([
			["Q1", true, 2],
			["Q2", true, null],
			["Q3", true, null],
		]);
		expect(group?.questions[1]?.parentId).toBe(ids[0]);
	});

	test("a group is answered at once, as the person's confirmation, and the asker is told once", async () => {
		const w = await world();
		const asked = await ask(w.ca, {
			questions: [
				{ question: "Format?", options: ["v1", "v2"], recommend: 2 },
				{ question: "Unknown columns?", recommend: "skip them" },
			],
		});
		const [q1, q2] = asked.metadata?.blockIds as [string, string];
		// Adopt all recommendations: one request.
		const done = await answerOutlineQuestions({
			userId: w.alice,
			answers: [
				{ blockId: q1, adopt: true },
				{ blockId: q2, adopt: true },
			],
		});
		expect(done.answered.sort()).toEqual([q1, q2].sort());
		const [commit] = await db
			.select()
			.from(outlineCommits)
			.where(eq(outlineCommits.id, done.commitId as string));
		expect(commit).toMatchObject({
			kind: "answer",
			actorKind: "human",
			actorId: w.alice,
			responsibleUserId: w.alice,
		});
		const block = await outlineStore.getBlock(q1);
		expect(block?.askJson?.answer).toMatchObject({
			option: 2,
			adopted: true,
			by: { kind: "human", id: w.alice },
		});
		expect((await taskWaits(w))?.people).toBe(false);
		// One message to the asking session, run as the person its turn ran for.
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toMatchObject({
			narratorId: w.a,
			createdBy: w.alice,
			executionUserId: w.alice,
		});
		expect(delivered[0]?.content).toContain("answered your questions");
		expect(delivered[0]?.content).toContain("option 2 (v2), your recommendation");
		expect((await outlineStore.getQuestions([q1, q2])).map((r) => r.deliveredAt)).not.toContain(
			null,
		);
		// Delivered once: delivering again finds nothing to do.
		expect((await deliverOutlineAnswers([q1, q2])).delivered).toBe(0);
		expect(delivered).toHaveLength(1);
		expect(await listOutlineAttention({ userId: w.alice, isAdmin: false })).toEqual([]);
	});

	test("only the person asked answers; a decided question is not answered again", async () => {
		const w = await world();
		const asked = await ask(w.ca, {
			questions: [{ question: "Format?", options: ["v1", "v2"], recommend: 2 }],
		});
		const [q] = asked.metadata?.blockIds as [string];
		const notYours = await answerOutlineQuestions({
			userId: w.bob,
			answers: [{ blockId: q, option: 1 }],
		}).catch((e) => e);
		expect(notYours).toBeInstanceOf(OutlineQuestionError);
		expect((notYours as OutlineQuestionError).statusCode).toBe(403);
		const badOption = await answerOutlineQuestions({
			userId: w.alice,
			answers: [{ blockId: q, option: 3 }],
		}).catch((e) => e);
		expect((badOption as OutlineQuestionError).questionCode).toBe("OUTLINE_QUESTION_INVALID");
		await answerOutlineQuestions({
			userId: w.alice,
			answers: [{ blockId: q, option: 1, text: "v1 until the migration lands" }],
		});
		const again = await answerOutlineQuestions({
			userId: w.alice,
			answers: [{ blockId: q, adopt: true }],
		}).catch((e) => e);
		expect((again as OutlineQuestionError).statusCode).toBe(409);
		expect(delivered[0]?.content).toContain('option 1 (v1): "v1 until the migration lands"');
		// `to` names a person who cannot write the space: refused.
		const toBob = await ask(w.ca, {
			questions: [{ question: "Ask Bob?", recommend: "no" }],
			to: `human:${(await db.select().from(users).where(eq(users.id, w.bob)))[0]?.username}`,
		});
		expect(toBob.isError).toBe(true);
		expect(toBob.output).toContain("cannot write this space");
	});

	test("proceed: nothing waits; answered as recommended tells nobody, otherwise wakes the asker", async () => {
		const w = await world();
		const asked = await ask(w.ca, {
			proceed: true,
			questions: [
				{ question: "Name the flag --strict?", recommend: "yes" },
				{ question: "Log skipped rows?", options: ["no", "yes"], recommend: 2 },
			],
		});
		expect(asked.output).toContain("nothing waits");
		const [q1, q2] = asked.metadata?.blockIds as [string, string];
		expect((await taskWaits(w))?.people).toBe(false);
		await answerOutlineQuestions({ userId: w.alice, answers: [{ blockId: q1, adopt: true }] });
		expect(delivered).toHaveLength(0);
		expect((await outlineStore.getQuestions([q1]))[0]?.deliveredAt).not.toBeNull();
		await answerOutlineQuestions({ userId: w.alice, answers: [{ blockId: q2, option: 1 }] });
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.content).toContain("change what you did");
	});

	test("an answer the person gave in the conversation is written down for them, without waking anyone", async () => {
		const w = await world();
		const asked = await ask(w.ca, {
			questions: [{ question: "Format?", options: ["v1", "v2"], recommend: 2 }],
		});
		const [q] = asked.metadata?.blockIds as [string];
		const relayed = await ask(w.ca, { answered: [{ question: "Q1", option: 1 }] });
		expect(relayed.isError).toBeUndefined();
		expect(relayed.output).toContain("as the person's (relayed");
		const answer = (await outlineStore.getBlock(q))?.askJson?.answer;
		expect(answer).toMatchObject({ option: 1, by: { kind: "human", id: w.alice } });
		expect(answer?.relayed?.narratorId).toBe(w.a);
		expect((await outlineStore.getQuestions([q]))[0]).toMatchObject({ state: "answered" });
		expect((await outlineStore.getQuestions([q]))[0]?.deliveredAt).not.toBeNull();
		expect(delivered).toHaveLength(0);
		expect((await taskWaits(w))?.people).toBe(false);

		// Only the turn's own person's question, asked by this session.
		const other = await ask(w.ca, { questions: [{ question: "Again?", recommend: "no" }] });
		const [q2] = other.metadata?.blockIds as [string];
		const sid2 = (await outlineStore.getBlock(q2))?.sid as string;
		const asBob = await ask(ctx(w.a, w.bob), { answered: [{ question: sid2, adopt: true }] });
		expect(asBob.isError).toBe(true);
		const fromC = await ask(ctx(w.c, w.alice), { answered: [{ question: sid2, adopt: true }] });
		expect(fromC.isError).toBe(true);
		expect(fromC.output).toContain("was not asked by this session");
	});

	test("withdraw and archive: withdrawn questions make nothing wait and leave the inbox", async () => {
		const w = await world();
		const asked = await ask(w.ca, { questions: [{ question: "Format?", recommend: "v2" }] });
		const [q] = asked.metadata?.blockIds as [string];
		const fromC = await ask(ctx(w.c, w.alice), { withdraw: ["Q1"] });
		expect(fromC.isError).toBe(true);
		const withdrawn = await ask(w.ca, { withdraw: ["Q1"] });
		expect(withdrawn.isError).toBeUndefined();
		expect((await outlineStore.getQuestions([q]))[0]?.state).toBe("withdrawn");
		expect((await taskWaits(w))?.people).toBe(false);
		expect(await listOutlineAttention({ userId: w.alice, isAdmin: false })).toEqual([]);

		// A question in the session's own space is withdrawn when the session is archived.
		const session = await outlineStore.ensureSpace({ kind: "session", narratorId: w.a }, NOW);
		const note = await writeOutline({
			spaceId: session.id,
			ops: [{ op: "insert", parent: null, content: "Scratch" }],
			actor: { kind: "agent", id: w.a },
			narratorId: w.a,
			responsibleUserId: w.alice,
		});
		const own = await ask(w.ca, {
			under: `${session.key}/${note.results[0]?.sid}`,
			questions: [{ question: "Keep notes here?", recommend: "yes" }],
		});
		expect(own.output).toContain("nothing waits for it");
		const [q2] = own.metadata?.blockIds as [string];
		expect(await withdrawArchivedSessionQuestions(w.a)).toBe(1);
		expect((await outlineStore.getQuestions([q2]))[0]?.state).toBe("withdrawn");
	});

	test("an archived asker is not woken: the session now doing the task is", async () => {
		const w = await world();
		const asked = await ask(w.ca, { questions: [{ question: "Format?", recommend: "v2" }] });
		const [q] = asked.metadata?.blockIds as [string];
		await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, w.a));
		await releaseOutlineSessionTaskClaims(w.a, "archived");
		// Session `c` takes the task over.
		await writeOutline({
			spaceId: w.space.id,
			ops: [{ op: "setTask", block: { id: w.task.blockId }, task: { status: "doing" } }],
			actor: { kind: "agent", id: w.c },
			narratorId: w.c,
			responsibleUserId: w.alice,
		});
		await answerOutlineQuestions({ userId: w.alice, answers: [{ blockId: q, adopt: true }] });
		expect(delivered.map((d) => [d.narratorId, d.executionUserId])).toEqual([[w.c, null]]);
	});

	test("an answer whose delivery failed is retried by the sweep", async () => {
		const w = await world();
		const asked = await ask(w.ca, { questions: [{ question: "Format?", recommend: "v2" }] });
		const [q] = asked.metadata?.blockIds as [string];
		await answerOutlineQuestions({
			userId: w.alice,
			answers: [{ blockId: q, adopt: true }],
			deliver: false,
			now: () => new Date("2026-11-03T00:00:00.000Z"),
		});
		expect((await outlineStore.getQuestions([q]))[0]?.deliveredAt).toBeNull();
		// Too young: left to the commit's own delivery.
		expect(
			await sweepOutlineAnswerDeliveries({ now: () => new Date("2026-11-03T00:00:30Z") }),
		).toBe(0);
		expect(
			await sweepOutlineAnswerDeliveries({ now: () => new Date("2026-11-03T00:05:00Z") }),
		).toBe(1);
		expect(delivered.map((d) => d.narratorId)).toEqual([w.a]);
	});

	test("OutlineEdit cannot make a question a task", async () => {
		const w = await world();
		const asked = await ask(w.ca, { questions: [{ question: "Format?", recommend: "v2" }] });
		const sid = (await outlineStore.getBlock((asked.metadata?.blockIds as string[])[0] as string))
			?.sid;
		const result = await outlineEditTool.execute({ edits: [{ set: sid, checkbox: " " }] }, w.ca);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("is a question");
	});

	test("AskUserQuestion's async mode is refused in an outline session, kept in a spec one", async () => {
		const w = await world();
		const input = {
			async: true,
			context: "Choosing the format while the importer is built",
			questions: [{ header: "Format?", options: [{ header: "v1" }, { header: "v2" }] }],
		};
		const refused = await askUserQuestionTool.execute(input, w.ca);
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("use Ask");
		await db.update(narrators).set({ taskBackend: "spec" }).where(eq(narrators.id, w.a));
		const spec = await askUserQuestionTool.execute(input, w.ca);
		expect(spec.output).not.toContain("use Ask");
	});
});

describe("the inbox's other outline rows", () => {
	test("a change to the locker's plan, then what the delegate confirmed for them (the digest)", async () => {
		const w = await world();
		const lead = await narrator(w.alice, w.projectId, "lead");
		const plan = await writeOutline({
			spaceId: w.space.id,
			ops: [
				{ op: "insert", tempId: "r", parent: null, content: "Plan", task: { status: "todo" } },
				{ op: "insert", parent: { tempId: "r" }, content: "Step one", task: { status: "todo" } },
				{ op: "insert", parent: { tempId: "r" }, content: "Step two", task: { status: "todo" } },
			],
			actor: { kind: "human", id: w.alice },
			responsibleUserId: w.alice,
		});
		await lockOutlineTask({
			blockId: plan.results[0]?.blockId as string,
			userId: w.alice,
			delegate: lead,
		});
		const proposed = await writeOutline({
			spaceId: w.space.id,
			ops: [
				{
					op: "update",
					block: { id: plan.results[1]?.blockId as string },
					content: "Step one, done right",
				},
			],
			actor: { kind: "agent", id: w.a },
			narratorId: w.a,
			responsibleUserId: w.alice,
		});
		const pendingId = proposed.pending?.id as string;
		const items = await listOutlineAttention({ userId: w.alice, isAdmin: false });
		expect(items.find((i) => i.id === `outline:p:${pendingId}`)).toMatchObject({
			kind: "outline_decision",
			toolName: "OutlineEdit",
			narratorId: w.a,
			outline: { what: "pending", pendingId, count: 1 },
		});
		await confirmOutlinePending({
			pendingId,
			by: { kind: "agent", narratorId: lead, responsibleUserId: w.alice },
		});
		const after = await listOutlineAttention({ userId: w.alice, isAdmin: false });
		expect(after.map((i) => i.id)).toEqual(["outline:d:digest"]);
		expect(after[0]).toMatchObject({ kind: "outline_digest", outline: { count: 1 } });
		const digest = await readOutlineDigest({ userId: w.alice, isAdmin: false });
		expect(digest.items).toHaveLength(1);
		expect(digest.items[0]).toMatchObject({ pendingId, decidedBy: { narratorId: lead } });
		expect(digest.items[0]?.commitId).not.toBeNull();
		expect(await markOutlineDigestSeen({ userId: w.alice, isAdmin: false }, [pendingId])).toBe(1);
		expect(await listOutlineAttention({ userId: w.alice, isAdmin: false })).toEqual([]);
	});

	test("outline rows page with the rest of the inbox; the detail of a row is the row", async () => {
		const w = await world();
		await ask(w.ca, { questions: [{ question: "One?", recommend: "yes" }] });
		await ask(w.ca, {
			under: "Importer",
			questions: [{ question: "Two?", recommend: "yes" }],
		});
		const first = await listHumanAttentionForPrincipal(
			{ userId: w.alice, isAdmin: false },
			{ limit: 1 },
		);
		expect(first.items).toHaveLength(1);
		expect(first.nextCursor).not.toBeNull();
		const second = await listHumanAttentionForPrincipal(
			{ userId: w.alice, isAdmin: false },
			{ limit: 1, cursor: first.nextCursor as string },
		);
		expect(second.items).toHaveLength(1);
		expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
		const { getHumanAttentionForPrincipal } = await import("../../human-attention-service");
		const detail = await getHumanAttentionForPrincipal(
			{ userId: w.alice, isAdmin: false },
			first.items[0]?.id as string,
		);
		expect(detail.item.id).toBe(first.items[0]?.id);
		settings.outline.enabled = false;
		try {
			expect(
				(await listHumanAttentionForPrincipal({ userId: w.alice, isAdmin: false })).items,
			).toEqual([]);
		} finally {
			settings.outline.enabled = true;
		}
	});
});
