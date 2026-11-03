/**
 * Questions put to people (`Ask`, outline P2 PR 7) at their edges, each seeded from a review
 * probe: write access lost after asking, a note that disagrees with the recommendation, a
 * question changed after the person read it, session titles shown only to people who may read
 * the session, undoing a delete of an answered question, questions under questions, where `Ask`
 * puts a question by default, two calls numbering at once, answering what one cannot read, the
 * inbox after access is lost, its refresh after a revert, subagents keeping `AskUserQuestion`'s
 * async mode, and the answer message's deterministic id.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own users,
 * projects and sessions. The delivery to sessions is replaced through its seam, except where the
 * real one is read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { aclGrants, narratorMessages, narrators, projects, users } from "../../../db/schema";
import { askUserQuestionTool } from "../../../lib/agent/tools/ask-user-question";
import { askTool } from "../../../lib/agent/tools/outline";
import type { ToolContext, ToolResult } from "../../../lib/agent/types";
import { eventBus } from "../../../lib/event-bus";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { stopEditTextWorker } from "../edit-text-runner";
import { listOutlineAttention, readOutlineDigest } from "../inbox";
import { confirmOutlinePending, lockOutlineTask } from "../pending";
import {
	answerOutlineQuestions,
	deliverOutlineAnswers,
	listQuestionGroupsForUser,
	OutlineQuestionError,
	outlineAnswerMessageId,
	readQuestionsUnder,
	setOutlineAnswerDelivery,
	sweepOutlineAnswerDeliveries,
} from "../questions";
import { clearOutlineReads } from "../read-ledger";
import { revertCommit } from "../revert";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensureProjectSpace } from "../spaces";
import { outlineStore } from "../store";
import { writeOutline } from "../write";

const NOW = "2026-11-03T00:00:00.000Z";

async function user(label: string): Promise<{ id: string; username: string }> {
	const id = generateId();
	const username = `${label}-${id}`;
	await db.insert(users).values({ id, username, passwordHash: "x", role: "user", createdAt: NOW });
	return { id, username };
}

async function narrator(
	owner: string,
	projectId: string,
	title: string,
	extra: Partial<typeof narrators.$inferInsert> = {},
): Promise<string> {
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
		...extra,
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

async function grant(projectId: string, userId: string, capability: "read" | "write") {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: userId,
		capability,
		createdAt: NOW,
	});
	invalidateSessionReadScopes();
}

async function regrant(projectId: string, userId: string, capability: "read" | "write" | null) {
	const where = and(eq(aclGrants.principalId, userId), eq(aclGrants.scopeId, projectId));
	if (capability) await db.update(aclGrants).set({ capability }).where(where);
	else await db.delete(aclGrants).where(where);
	invalidateSessionReadScopes();
}

/** A message of the person starting a turn of the session, a second after `after`. */
async function said(narratorId: string, userId: string, after: string): Promise<string> {
	const id = generateId();
	await db.insert(narratorMessages).values({
		id,
		narratorId,
		role: "user",
		contentJson: [{ type: "text", text: "my answer" }],
		createdBy: userId,
		origin: "user",
		createdAt: new Date(Date.parse(after) + 1_000).toISOString(),
	});
	return id;
}

let delivered: Array<{ narratorId: string; messageId: string; content: string }> = [];

/** Alice's project with a task session `a` (hers, private, titled "Secret plan") is doing. */
async function world() {
	const alice = await user("alice");
	const bob = await user("bob");
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Importer",
		ownerUserId: alice.id,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	const a = await narrator(alice.id, projectId, "Secret plan");
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
		actor: { kind: "human", id: alice.id },
		responsibleUserId: alice.id,
	});
	const task = written.results[1] as { blockId: string; sid: string };
	await writeOutline({
		spaceId: space.id,
		ops: [{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } }],
		actor: { kind: "agent", id: a },
		narratorId: a,
		responsibleUserId: alice.id,
	});
	return { alice, bob, projectId, space, task, a, ca: ctx(a, alice.id) };
}

async function questionOf(result: ToolResult): Promise<{ id: string; createdAt: string }> {
	const id = (result.metadata?.blockIds as string[])[0] as string;
	return { id, createdAt: (await outlineStore.getQuestions([id]))[0]?.createdAt as string };
}

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateSessionReadScopes();
	clearOutlineReads();
	delivered = [];
	setOutlineAnswerDelivery({
		async deliver(narratorId, message) {
			delivered.push({ narratorId, messageId: message.messageId, content: message.content });
			return { written: true, woke: false };
		},
	});
});

afterEach(() => {
	setOutlineAnswerDelivery(null);
	invalidateSessionReadScopes();
	stopEditTextWorker();
});

describe("access", () => {
	test("a person who lost write access cannot answer, have an answer relayed, or have a question withdrawn (S1, probe P2)", async () => {
		const w = await world();
		const carol = await user("carol");
		await grant(w.projectId, carol.id, "write");
		const cs = await narrator(carol.id, w.projectId, "carol's session");
		const asked = await ask(ctx(cs, carol.id), {
			under: `${w.space.key}/${w.task.sid}`,
			to: `human:${carol.username}`,
			questions: [
				{ question: "One?", recommend: "yes" },
				{ question: "Two?", recommend: "yes" },
			],
		});
		expect(asked.isError).toBeUndefined();
		const [q1, q2] = asked.metadata?.blockIds as [string, string];
		await regrant(w.projectId, carol.id, "read");
		const direct = await answerOutlineQuestions({
			userId: carol.id,
			answers: [{ blockId: q1, adopt: true }],
		}).catch((e) => e);
		expect((direct as OutlineQuestionError).statusCode).toBe(403);
		const again = await ask(ctx(cs, carol.id), {
			under: `${w.space.key}/${w.task.sid}`,
			questions: [{ question: "Three?", recommend: "yes" }],
		});
		expect(again.isError).toBe(true);
		// Her own words after the question do not make up for the access she lost.
		await said(cs, carol.id, (await outlineStore.getQuestions([q1]))[0]?.createdAt as string);
		const relayed = await ask(ctx(cs, carol.id), { answered: [{ question: "Q1", adopt: true }] });
		expect(relayed.isError).toBe(true);
		const withdrawn = await ask(ctx(cs, carol.id), { withdraw: ["Q2"] });
		expect(withdrawn.isError).toBe(true);
		expect((await outlineStore.getQuestions([q1, q2])).map((r) => r.state)).toEqual([
			"open",
			"open",
		]);
	});

	test("missing, unreadable and not-a-question are one answer; a reader not asked is told it is not theirs (S8, probe P11)", async () => {
		const w = await world();
		const asked = await ask(w.ca, { questions: [{ question: "Secret?", recommend: "x" }] });
		const { id: q } = await questionOf(asked);
		const eve = await user("eve");
		const refused = async (userId: string, blockId: string) =>
			(await answerOutlineQuestions({ userId, answers: [{ blockId, adopt: true }] }).catch(
				(e) => e,
			)) as OutlineQuestionError;
		const open = await refused(eve.id, q);
		const missing = await refused(eve.id, generateId());
		const task = await refused(w.alice.id, w.task.blockId);
		await answerOutlineQuestions({ userId: w.alice.id, answers: [{ blockId: q, adopt: true }] });
		const decided = await refused(eve.id, q);
		for (const e of [open, missing, task, decided]) {
			expect(e).toBeInstanceOf(OutlineQuestionError);
			expect([e.statusCode, e.questionCode, e.message]).toEqual([
				404,
				"OUTLINE_QUESTION_NOT_FOUND",
				"no such question",
			]);
		}
		// Bob may read the space but was not asked: that he may know.
		await grant(w.projectId, w.bob.id, "write");
		const other = await ask(w.ca, { questions: [{ question: "Other?", recommend: "y" }] });
		const notHis = await refused(w.bob.id, (await questionOf(other)).id);
		expect([notHis.statusCode, notHis.questionCode]).toEqual([403, "OUTLINE_QUESTION_NOT_YOURS"]);
		// One question twice in a request says so (review N9), rather than "no such block".
		const otherId = (await questionOf(other)).id;
		const twice = (await answerOutlineQuestions({
			userId: w.alice.id,
			answers: [
				{ blockId: otherId, adopt: true },
				{ blockId: otherId, option: 1 },
			],
		}).catch((e) => e)) as OutlineQuestionError;
		expect([twice.statusCode, twice.message]).toEqual([
			400,
			"a question is answered twice in one request",
		]);
	});

	test("session titles are shown only to people who may read the session; the inbox drops spaces one can no longer read (B2, probe P5)", async () => {
		const w = await world();
		await grant(w.projectId, w.bob.id, "write");
		// Bob may read and write the project, not alice's private session.
		const asked = await ask(w.ca, {
			to: `human:${w.bob.username}`,
			questions: [{ question: "OK to proceed?", recommend: "yes" }],
		});
		expect(asked.isError).toBeUndefined();
		const row = (await listOutlineAttention({ userId: w.bob.id, isAdmin: false })).find((i) =>
			i.id.startsWith("outline:q:"),
		);
		expect(row).toMatchObject({ narratorId: "", narratorTitle: null });
		expect(row?.outline?.sessionHidden).toBe(true);
		const asBob = await readQuestionsUnder(w.task.blockId, { userId: w.bob.id, isAdmin: false });
		expect(asBob?.questions[0]?.askedBy).toEqual({ narratorId: null, title: null, hidden: true });
		const asAlice = await readQuestionsUnder(w.task.blockId, {
			userId: w.alice.id,
			isAdmin: false,
		});
		expect(asAlice?.questions[0]?.askedBy).toEqual({
			narratorId: w.a,
			title: "Secret plan",
			hidden: false,
		});
		const asAdmin = await readQuestionsUnder(w.task.blockId, { userId: w.bob.id, isAdmin: true });
		expect(asAdmin?.questions[0]?.askedBy.title).toBe("Secret plan");

		// Bob locks a plan with a delegate he could read then; alice's session proposes a change.
		const lead = await narrator(w.alice.id, w.projectId, "Secret lead", {
			visibility: "public",
		});
		const plan = await writeOutline({
			spaceId: w.space.id,
			ops: [
				{ op: "insert", tempId: "r", parent: null, content: "Plan", task: { status: "todo" } },
				{ op: "insert", parent: { tempId: "r" }, content: "Step", task: { status: "todo" } },
			],
			actor: { kind: "human", id: w.bob.id },
			responsibleUserId: w.bob.id,
		});
		await lockOutlineTask({
			blockId: plan.results[0]?.blockId as string,
			userId: w.bob.id,
			delegate: lead,
		});
		await db.update(narrators).set({ visibility: "private" }).where(eq(narrators.id, lead));
		const proposed = await writeOutline({
			spaceId: w.space.id,
			ops: [{ op: "update", block: { id: plan.results[1]?.blockId as string }, content: "Step!" }],
			actor: { kind: "agent", id: w.a },
			narratorId: w.a,
			responsibleUserId: w.alice.id,
		});
		const pendingId = proposed.pending?.id as string;
		const pendingRow = (await listOutlineAttention({ userId: w.bob.id, isAdmin: false })).find(
			(i) => i.id === `outline:p:${pendingId}`,
		);
		expect(pendingRow).toMatchObject({ narratorId: "", narratorTitle: null });
		expect(pendingRow?.outline?.sessionHidden).toBe(true);
		await confirmOutlinePending({
			pendingId,
			by: { kind: "agent", narratorId: lead, responsibleUserId: w.bob.id },
		});
		const digest = await readOutlineDigest({ userId: w.bob.id, isAdmin: false });
		expect(digest.items[0]?.decidedBy).toEqual({ narratorId: null, title: null, hidden: true });
		expect(digest.items[0]?.canRevert).toBe(true);
		// Read only now: the digest stays, without the revert (review N13).
		await regrant(w.projectId, w.bob.id, "read");
		expect(
			(await readOutlineDigest({ userId: w.bob.id, isAdmin: false })).items[0]?.canRevert,
		).toBe(false);
		expect(
			(await listOutlineAttention({ userId: w.bob.id, isAdmin: false })).map((i) => i.canAct),
		).toContain(false);
		// No access at all: every row of the space leaves his inbox.
		await regrant(w.projectId, w.bob.id, null);
		expect(await listOutlineAttention({ userId: w.bob.id, isAdmin: false })).toEqual([]);
		expect((await readOutlineDigest({ userId: w.bob.id, isAdmin: false })).items).toEqual([]);
	});
});

describe("answers", () => {
	test("on a decision the asker went ahead with, words with the answer are never 'as recommended' (S2, probe P3)", async () => {
		const w = await world();
		const asked = await ask(w.ca, {
			proceed: true,
			questions: [
				{ question: "Log skipped rows?", options: ["no", "yes"], recommend: 2 },
				{ question: "Name it --strict?", recommend: "yes" },
			],
		});
		const [q1, q2] = asked.metadata?.blockIds as [string, string];
		// The form's radio starts on the recommendation; the person types a note that disagrees.
		const note = 'NO: rows hold PII.\n"Stop" logging them now';
		await answerOutlineQuestions({
			userId: w.alice.id,
			answers: [
				{ blockId: q1, option: 2, text: note },
				{ blockId: q2, adopt: true, text: "but call it --exact" },
			],
		});
		const answers = (await outlineStore.getBlocks([q1, q2])).map((b) => b.askJson?.answer);
		expect(answers.map((a) => a?.adopted)).toEqual([undefined, undefined]);
		expect(delivered).toHaveLength(1);
		// The words reach the asker quoted as data, on one line (decision 10's note).
		expect(delivered[0]?.content).toContain(JSON.stringify(note));
		expect(delivered[0]?.content).not.toContain("PII.\n");
		expect(delivered[0]?.content).toContain("change what you did");
		// The bare recommendation is adopted, and tells nobody.
		const more = await ask(w.ca, {
			proceed: true,
			questions: [{ question: "Keep v1?", options: ["no", "yes"], recommend: 1 }],
		});
		const { id: q3 } = await questionOf(more);
		await answerOutlineQuestions({ userId: w.alice.id, answers: [{ blockId: q3, option: 1 }] });
		expect((await outlineStore.getBlock(q3))?.askJson?.answer?.adopted).toBe(true);
		expect(delivered).toHaveLength(1);
	});

	test("an answer names the version the person read; a question changed since is refused (S3, probe P4)", async () => {
		const w = await world();
		const asked = await ask(w.ca, {
			questions: [
				{ question: "Delete the STAGING database?", options: ["no", "yes"], recommend: 2 },
			],
		});
		const { id: q } = await questionOf(asked);
		const seen = await readQuestionsUnder(w.task.blockId, { userId: w.alice.id, isAdmin: false });
		const version = seen?.questions[0]?.versionSeq as number;
		expect(version).toBe((await outlineStore.getBlock(q))?.versionSeq as number);
		await writeOutline({
			spaceId: w.space.id,
			ops: [{ op: "update", block: { id: q }, content: "Delete the PRODUCTION database?" }],
			actor: { kind: "agent", id: w.a },
			narratorId: w.a,
			responsibleUserId: w.alice.id,
		});
		const stale = (await answerOutlineQuestions({
			userId: w.alice.id,
			answers: [{ blockId: q, option: 2, versionSeq: version }],
		}).catch((e) => e)) as OutlineQuestionError;
		expect([stale.statusCode, stale.questionCode]).toEqual([409, "OUTLINE_QUESTION_CHANGED"]);
		expect(stale.message).toContain("read it again");
		expect((await outlineStore.getBlock(q))?.askJson?.answer).toBeUndefined();
		const fresh = await readQuestionsUnder(w.task.blockId, { userId: w.alice.id, isAdmin: false });
		await answerOutlineQuestions({
			userId: w.alice.id,
			answers: [{ blockId: q, option: 1, versionSeq: fresh?.questions[0]?.versionSeq }],
		});
		expect((await outlineStore.getBlock(q))?.askJson?.answer?.option).toBe(1);
	});

	test("undoing the delete of an answered question, or a revert of a relayed answer, tells nobody again (N1, probe P6)", async () => {
		const w = await world();
		const asked = await ask(w.ca, { questions: [{ question: "Format?", recommend: "v2" }] });
		const { id: q } = await questionOf(asked);
		await answerOutlineQuestions({ userId: w.alice.id, answers: [{ blockId: q, adopt: true }] });
		expect(delivered).toHaveLength(1);
		const deleted = await writeOutline({
			spaceId: w.space.id,
			ops: [{ op: "delete", block: { id: q } }],
			actor: { kind: "human", id: w.alice.id },
			responsibleUserId: w.alice.id,
		});
		await revertCommit({
			commitId: deleted.commit?.id as string,
			actor: { kind: "human", id: w.alice.id },
			responsibleUserId: w.alice.id,
		});
		expect((await outlineStore.getQuestions([q]))[0]).toMatchObject({ state: "answered" });
		expect((await outlineStore.getQuestions([q]))[0]?.deliveredAt).not.toBeNull();
		const later = () => new Date(Date.now() + 5 * 60_000);
		expect(await sweepOutlineAnswerDeliveries({ now: later })).toBe(0);
		expect(delivered).toHaveLength(1);

		// A relayed answer reverted, then the revert reverted.
		const second = await ask(w.ca, { questions: [{ question: "Again?", recommend: "no" }] });
		const q2 = await questionOf(second);
		await said(w.a, w.alice.id, q2.createdAt);
		const relayed = await ask(w.ca, { answered: [{ question: "Q2", adopt: true }] });
		expect(relayed.isError).toBeUndefined();
		const answerCommit = (await outlineStore.getQuestions([q2.id]))[0]?.answerCommitId as string;
		const reopened = await revertCommit({
			commitId: answerCommit,
			actor: { kind: "human", id: w.alice.id },
			responsibleUserId: w.alice.id,
		});
		expect((await outlineStore.getQuestions([q2.id]))[0]?.state).toBe("open");
		await revertCommit({
			commitId: reopened.commit?.id as string,
			actor: { kind: "human", id: w.alice.id },
			responsibleUserId: w.alice.id,
		});
		expect((await outlineStore.getQuestions([q2.id]))[0]?.state).toBe("answered");
		expect(await sweepOutlineAnswerDeliveries({ now: later })).toBe(0);
		expect(delivered).toHaveLength(1);
	});
});

describe("where questions go", () => {
	test("a question two levels down is in its group's form (N2, probe P7)", async () => {
		const w = await world();
		const one = await ask(w.ca, {
			questions: [
				{ question: "Q one?", recommend: "a", items: [{ question: "detail?", recommend: "b" }] },
			],
		});
		const [, item] = one.metadata?.blockIds as [string, string];
		const two = await ask(w.ca, { questions: [{ question: "Q two?", recommend: "c" }] });
		const { id: q2 } = await questionOf(two);
		await writeOutline({
			spaceId: w.space.id,
			ops: [{ op: "move", block: { id: q2 }, parent: { id: item } }],
			actor: { kind: "agent", id: w.a },
			narratorId: w.a,
			responsibleUserId: w.alice.id,
		});
		const { groups } = await listQuestionGroupsForUser(w.alice.id);
		expect(groups.map((g) => [g.groupBlockId, g.questionIds.length])).toEqual([
			[w.task.blockId, 3],
		]);
		const form = await readQuestionsUnder(w.task.blockId, { userId: w.alice.id, isAdmin: false });
		expect(form?.questions.map((q) => q.text)).toEqual(["Q one?", "detail?", "Q two?"]);
		expect(form?.questions.every((q) => q.canAnswer)).toBe(true);
		// Its own question's form takes it too.
		const under = await readQuestionsUnder(item, { userId: w.alice.id, isAdmin: false });
		expect(under?.questions.map((q) => q.text)).toEqual(["detail?", "Q two?"]);
	});

	test("without under, Ask goes under the innermost task the session is doing, whatever its to-dos (S4, probes P8 and P10)", async () => {
		const w = await world();
		const session = await outlineStore.ensureSpace({ kind: "session", narratorId: w.a }, NOW);
		const made = await writeOutline({
			spaceId: session.id,
			ops: [
				{ op: "insert", tempId: "p", parent: null, content: "Plan" },
				...[1, 2, 3, 4, 5, 6].map((n) => ({
					op: "insert" as const,
					parent: { tempId: "p" },
					content: `Step ${n}`,
					task: { status: "todo" as const },
				})),
			],
			actor: { kind: "agent", id: w.a },
			narratorId: w.a,
			responsibleUserId: w.alice.id,
		});
		expect(made.results).toHaveLength(7);
		const first = await ask(w.ca, { questions: [{ question: "Which way?", recommend: "left" }] });
		expect(first.isError).toBeUndefined();
		expect(first.metadata?.groupBlockId).toBe(w.task.blockId);

		// The project task done; a goal and a step under it in progress: the step is innermost.
		await writeOutline({
			spaceId: w.space.id,
			ops: [{ op: "setTask", block: { id: w.task.blockId }, task: { status: "done" } }],
			actor: { kind: "agent", id: w.a },
			narratorId: w.a,
			responsibleUserId: w.alice.id,
		});
		const nested = await writeOutline({
			spaceId: session.id,
			ops: [
				{ op: "insert", tempId: "g", parent: null, content: "Goal", task: { status: "todo" } },
				{ op: "insert", parent: { tempId: "g" }, content: "Pick the DB", task: { status: "todo" } },
			],
			actor: { kind: "agent", id: w.a },
			narratorId: w.a,
			responsibleUserId: w.alice.id,
		});
		const [goal, step] = nested.results.map((r) => r.blockId) as [string, string];
		for (const id of [step, goal])
			await writeOutline({
				spaceId: session.id,
				ops: [{ op: "setTask", block: { id }, task: { status: "doing" } }],
				actor: { kind: "agent", id: w.a },
				narratorId: w.a,
				responsibleUserId: w.alice.id,
			});
		const second = await ask(w.ca, {
			questions: [{ question: "Postgres or SQLite?", options: ["pg", "sqlite"], recommend: 1 }],
		});
		expect(second.metadata?.groupBlockId).toBe(step);
	});

	test("two Ask calls at once in one space number their questions apart (S5, probe P9)", async () => {
		const w = await world();
		const results = await Promise.all(
			["First?", "Second?", "Third?"].map((question) =>
				ask(w.ca, { questions: [{ question, recommend: "a" }] }),
			),
		);
		expect(results.map((r) => r.isError)).toEqual([undefined, undefined, undefined]);
		const ids = results.map((r) => (r.metadata?.blockIds as string[])[0] as string);
		const aliases = (await outlineStore.getBlocks(ids)).map((b) => b.alias).sort();
		expect(aliases).toEqual(["Q1", "Q2", "Q3"]);
	});
});

describe("telling", () => {
	test("the inbox is told whenever a question changes, a revert or an edit included (S7)", async () => {
		const w = await world();
		const told: Array<string[] | undefined> = [];
		const listen = (event: { userIds?: string[] }) => {
			told.push(event.userIds);
		};
		eventBus.on("human_attention:changed", listen);
		try {
			const asked = await ask(w.ca, { questions: [{ question: "Format?", recommend: "v2" }] });
			const { id: q } = await questionOf(asked);
			const done = await answerOutlineQuestions({
				userId: w.alice.id,
				answers: [{ blockId: q, adopt: true }],
			});
			told.length = 0;
			// A revert of the answer reopens it: the person asked is told.
			await revertCommit({
				commitId: done.commitId as string,
				actor: { kind: "human", id: w.alice.id },
				responsibleUserId: w.alice.id,
			});
			expect(told).toEqual([[w.alice.id]]);
			// So is an edit that deletes it.
			told.length = 0;
			await writeOutline({
				spaceId: w.space.id,
				ops: [{ op: "delete", block: { id: q } }],
				actor: { kind: "agent", id: w.a },
				narratorId: w.a,
				responsibleUserId: w.alice.id,
			});
			expect(told).toEqual([[w.alice.id]]);
			// An edit that touches no question tells nobody.
			told.length = 0;
			await writeOutline({
				spaceId: w.space.id,
				ops: [{ op: "update", block: { id: w.task.blockId }, content: "Ship it" }],
				actor: { kind: "agent", id: w.a },
				narratorId: w.a,
				responsibleUserId: w.alice.id,
			});
			expect(told).toEqual([]);
		} finally {
			eventBus.off("human_attention:changed", listen);
		}
	});

	test("one delivery has one message id, so a retry finds the message it wrote (decision 9)", async () => {
		const w = await world();
		const asked = await ask(w.ca, { questions: [{ question: "Format?", recommend: "v2" }] });
		const { id: q } = await questionOf(asked);
		const done = await answerOutlineQuestions({
			userId: w.alice.id,
			answers: [{ blockId: q, adopt: true }],
			deliver: false,
		});
		const id = outlineAnswerMessageId(done.commitId as string, w.a, w.alice.id);
		expect(id).toBe(outlineAnswerMessageId(done.commitId as string, w.a, w.alice.id));
		expect(id).not.toBe(outlineAnswerMessageId(done.commitId as string, w.a, null));
		expect(id).toHaveLength(21);
		// A crash after writing the message, before marking the row: the real delivery finds it.
		await db.insert(narratorMessages).values({
			id,
			narratorId: w.a,
			role: "user",
			contentJson: [{ type: "text", text: "already told" }],
			createdBy: w.alice.id,
			createdAt: new Date().toISOString(),
		});
		setOutlineAnswerDelivery(null);
		const retried = await deliverOutlineAnswers([q]);
		expect(retried).toMatchObject({ delivered: 1, told: [w.a], woke: 0 });
		const rows = await db
			.select({ id: narratorMessages.id })
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, w.a));
		expect(rows.map((r) => r.id)).toEqual([id]);
		expect((await outlineStore.getQuestions([q]))[0]?.deliveredAt).not.toBeNull();
	});

	test("a subagent of an outline session keeps AskUserQuestion's async mode (decision 7, N7)", async () => {
		const w = await world();
		const sub = await narrator(w.alice.id, w.projectId, "explorer", {
			type: "subagent",
			aclRootNarratorId: w.a,
		});
		const input = {
			async: true,
			context: "Choosing the format while exploring",
			questions: [{ header: "Format?", options: [{ header: "v1" }, { header: "v2" }] }],
		};
		const root = await askUserQuestionTool.execute(input, w.ca);
		expect(root.output).toContain("use Ask");
		const fromSub = await askUserQuestionTool.execute(input, ctx(sub, w.alice.id));
		expect(fromSub.output).not.toContain("use Ask");
		expect(askUserQuestionTool.description).toContain("there `async: true` is refused");
	});
});
