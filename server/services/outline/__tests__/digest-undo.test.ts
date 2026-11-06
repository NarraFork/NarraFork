/**
 * Taking back a decision made in a person's name (汇报 Q5, `POST /api/outline/digests/undo`): the
 * three kinds a report lists under 代你做的 (a delegate's confirmation, the plan review's draft
 * approval, a relayed answer), each undone by reverting its commit through the outline's revert.
 *
 * What must hold:
 *   - only the person the decision was made for may undo it: anyone else who can read the space
 *     gets 403 (`…_NOT_YOURS`), anyone who cannot gets 404 (as for an unknown commit);
 *   - an ordinary commit is not a decision made in anyone's name (403 `…_NOT_YOURS`);
 *   - the person needs write access to the space (403 `…_READ_ONLY` without);
 *   - a decision already undone, or changed since so that reverting would not take it back, is
 *     refused (409) and nothing is written;
 *   - undoing puts the decision back: the plan is being planned again, the question is open
 *     again, the confirmed change is taken back.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { OutlineDigestUndoResponse } from "@shared/outline-digest";
import { Hono } from "hono";
import { db } from "../../../db";
import { aclGrants, narrators, projects, users } from "../../../db/schema";
import { AppError } from "../../../lib/errors";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { outlineRoutes } from "../../../routes/outline";
import {
	classifyDelegatedCommit,
	OutlineDigestUndoError,
	undoOutlineDelegatedDecision,
} from "../digest-view";
import type { OutlineAskJson } from "../model";
import { confirmOutlinePending, lockOutlineTask } from "../pending";
import { decideOutlinePlan, ensurePlanRoot, OUTLINE_PLAN_REVIEW_ACTOR } from "../plans";
import { outlineStore } from "../store";
import type { OutlineCommitRow, OutlineSpaceRow } from "../store/port";
import { type OutlineOp, writeOutline } from "../write";

const NOW = "2026-11-05T00:00:00.000Z";
const store = outlineStore;

function appAs(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) =>
		error instanceof AppError
			? new Response(JSON.stringify({ code: error.code }), { status: error.statusCode })
			: new Response(String(error), { status: 500 }),
	);
	app.route("/outline", outlineRoutes);
	return app;
}

async function undo(userId: string, commitId: string) {
	const res = await appAs(userId).request("http://localhost/outline/digests/undo", {
		method: "POST",
		body: JSON.stringify({ commitId }),
		headers: { "content-type": "application/json" },
	});
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// plain text
	}
	return { status: res.status, body: body as OutlineDigestUndoResponse & { code?: string } };
}

async function user(label: string) {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${id.slice(0, 6)}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	return id;
}

async function narrator(ownerUserId: string) {
	const id = generateId();
	await db
		.insert(narrators)
		.values({ id, title: "s", ownerUserId, createdAt: NOW, updatedAt: NOW });
	return id;
}

async function grant(
	scopeType: "project" | "narrator",
	scopeId: string,
	userId: string,
	capability: "read" | "write" | "manage",
) {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType,
		scopeId,
		principalType: "user",
		principalId: userId,
		capability,
		createdAt: NOW,
	});
}

async function write(
	space: OutlineSpaceRow,
	actor: { kind: "human" | "agent"; id: string },
	responsibleUserId: string,
	ops: OutlineOp[],
	extra: Partial<Parameters<typeof writeOutline>[1]> = {},
) {
	return await writeOutline(
		{
			spaceId: space.id,
			ops,
			actor,
			responsibleUserId,
			narratorId: actor.kind === "agent" ? actor.id : null,
		},
		{ store, now: () => new Date(NOW), ...extra },
	);
}

function ask(to: string): OutlineAskJson {
	return { to: { kind: "human", id: to }, options: ["A", "B"], recommend: { option: 1 } };
}

let alice: string;
let bob: string;
let carol: string;
let projectSpace: OutlineSpaceRow;
let projectId: string;
let agent: string;

beforeEach(async () => {
	settings.outline.enabled = true;
	alice = await user("alice");
	bob = await user("bob");
	carol = await user("carol");
	agent = await narrator(alice);
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Undo",
		ownerUserId: alice,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	await grant("project", projectId, bob, "write");
	projectSpace = await store.ensureSpace({ kind: "project", projectId }, NOW);
});

async function relayedAnswer(person: string) {
	const asked = await write(
		projectSpace,
		{ kind: "agent", id: agent },
		person,
		[{ op: "insert", parent: null, content: "Which one?", ask: ask(person) }],
		{ question: { askerNarratorId: agent, askerUserId: person, askerToolCallId: "c" } },
	);
	const q = asked.results[0]?.blockId as string;
	const answered = await write(
		projectSpace,
		{ kind: "agent", id: agent },
		person,
		[
			{
				op: "update",
				block: { id: q },
				ask: {
					...ask(person),
					answer: {
						option: 1,
						adopted: true,
						by: { kind: "human", id: person },
						at: NOW,
						relayed: { narratorId: agent, messageId: null },
					},
				},
			},
		],
		{
			kind: "answer",
			question: {
				askerNarratorId: null,
				askerUserId: null,
				askerToolCallId: null,
				delivered: true,
			},
		},
	);
	return { question: q, commit: answered.commit as { id: string; seq: number } };
}

describe("undoing a decision made in the person's name", () => {
	test("a relayed answer: only its person, with write access; the question opens again", async () => {
		const { question, commit } = await relayedAnswer(alice);
		const row = (await store.getCommit(commit.id)) as OutlineCommitRow;
		expect(await classifyDelegatedCommit(store, row)).toEqual({
			kind: "relayed_answer",
			person: alice,
			blockIds: [question],
			round: null,
		});
		const notHis = await undo(bob, commit.id);
		expect([notHis.status, notHis.body.code]).toEqual([403, "OUTLINE_DIGEST_UNDO_NOT_YOURS"]);
		expect((await undo(carol, commit.id)).status).toBe(404);
		expect((await undo(alice, "no-such-commit")).status).toBe(404);
		const done = await undo(alice, commit.id);
		expect(done.status).toBe(200);
		expect(done.body.kind).toBe("relayed_answer");
		expect(done.body.commit).not.toBeNull();
		const [q] = await store.getQuestions([question]);
		expect(q?.state).toBe("open");
		expect((await store.getBlock(question))?.askJson?.answer).toBeUndefined();
		// Undone already: refused, nothing written.
		const seq = (await store.getSpace(projectSpace.id))?.nextSeq;
		const again = await undo(alice, commit.id);
		expect([again.status, again.body.code]).toEqual([409, "OUTLINE_DIGEST_UNDO_GONE"]);
		expect((await store.getSpace(projectSpace.id))?.nextSeq).toBe(seq as number);
	});

	test("changed between the check and the revert, so nothing is put back: 409, nothing written", async () => {
		const { commit } = await relayedAnswer(alice);
		// The check sees the commit's versions; the revert, a moment later, finds nothing to put
		// back (as when a write lands in between).
		let reads = 0;
		const raced = {
			...store,
			listCommitVersions: (commitId: string, limit: number) =>
				reads++ === 0 ? store.listCommitVersions(commitId, limit) : Promise.resolve([]),
		};
		const seq = (await store.getSpace(projectSpace.id))?.nextSeq;
		await expect(
			undoOutlineDelegatedDecision({ userId: alice, isAdmin: false }, commit.id, { store: raced }),
		).rejects.toBeInstanceOf(OutlineDigestUndoError);
		expect(reads).toBe(2);
		expect((await store.getSpace(projectSpace.id))?.nextSeq).toBe(seq as number);
	});

	test("the person needs write access to the space", async () => {
		// Bob only reads now; the answer relayed in his name is his, but he cannot write there.
		const reader = await user("reader");
		await grant("project", projectId, reader, "read");
		const { commit } = await relayedAnswer(reader);
		const readOnly = await undo(reader, commit.id);
		expect([readOnly.status, readOnly.body.code]).toEqual([403, "OUTLINE_DIGEST_UNDO_READ_ONLY"]);
		const notHers = await undo(alice, commit.id);
		expect([notHers.status, notHers.body.code]).toEqual([403, "OUTLINE_DIGEST_UNDO_NOT_YOURS"]);
	});

	test("an ordinary commit is no decision made in anyone's name", async () => {
		const edit = await write(projectSpace, { kind: "human", id: alice }, alice, [
			{ op: "insert", parent: null, content: "Just an edit" },
		]);
		expect(
			await classifyDelegatedCommit(
				store,
				(await store.getCommit(edit.commit?.id as string)) as OutlineCommitRow,
			),
		).toBeNull();
		const ordinary = await undo(alice, edit.commit?.id as string);
		expect([ordinary.status, ordinary.body.code]).toEqual([403, "OUTLINE_DIGEST_UNDO_NOT_YOURS"]);
	});

	test("the plan review's draft approval: the plan is being planned again; not once changed since", async () => {
		const session = await narrator(alice);
		// Bob may write alice's session, but the approval was made in alice's name.
		await grant("narrator", session, bob, "write");
		const plan = async (title: string) => {
			const root = await ensurePlanRoot({ session, userId: alice, title, locale: "en", store });
			const decided = await decideOutlinePlan({
				session,
				rootId: root.root.blockId,
				round: 1,
				action: "draft",
				decider: {
					kind: "system",
					id: OUTLINE_PLAN_REVIEW_ACTOR,
					responsibleUserId: alice,
					approvedBy: { kind: "system", id: OUTLINE_PLAN_REVIEW_ACTOR },
				},
				locale: "en",
				store,
			});
			return { root: root.root.blockId, commit: decided.result?.commit?.id as string };
		};
		const first = await plan("First plan");
		expect(
			(
				await classifyDelegatedCommit(
					store,
					(await store.getCommit(first.commit)) as OutlineCommitRow,
				)
			)?.kind,
		).toBe("plan_review_approval");
		expect((await undo(bob, first.commit)).status).toBe(403);
		expect((await undo(carol, first.commit)).status).toBe(404);
		expect((await undo(alice, first.commit)).status).toBe(200);
		expect((await store.getBlock(first.root))?.taskJson?.plan?.state).toBe("planning");
		// A second plan the session then starts on: the root changed after the approval, so
		// reverting it would leave the plan approved. Refused, nothing written.
		const second = await plan("Second plan");
		const space = (await store.getSpace(
			(
				await store.getBlock(second.root)
			)?.spaceId as string,
		)) as OutlineSpaceRow;
		await write(space, { kind: "agent", id: session }, alice, [
			{ op: "setTask", block: { id: second.root }, task: { status: "doing" } },
		]);
		const seq = (await store.getSpace(space.id))?.nextSeq;
		const refused = await undo(alice, second.commit);
		expect([refused.status, refused.body.code]).toEqual([409, "OUTLINE_DIGEST_UNDO_GONE"]);
		expect((await store.getSpace(space.id))?.nextSeq).toBe(seq as number);
		expect((await store.getBlock(second.root))?.taskJson?.plan?.state).toBe("approved");
	});

	test("a delegate's confirmation: the locker undoes it, the change goes back", async () => {
		const delegate = await narrator(alice);
		const made = await write(projectSpace, { kind: "human", id: alice }, alice, [
			{ op: "insert", tempId: "t", parent: null, content: "Locked plan", task: { status: "todo" } },
			{
				op: "insert",
				tempId: "s",
				parent: { tempId: "t" },
				content: "Step",
				task: { status: "todo" },
			},
		]);
		const [root, step] = made.results.map((r) => r.blockId) as [string, string];
		await lockOutlineTask({
			blockId: root,
			userId: alice,
			delegate,
			store,
			now: () => new Date(NOW),
		});
		const proposed = await write(projectSpace, { kind: "agent", id: agent }, alice, [
			{ op: "update", block: { id: step }, content: "Step, rewritten" },
		]);
		await confirmOutlinePending({
			pendingId: proposed.pending?.id as string,
			by: { kind: "agent", narratorId: delegate, responsibleUserId: alice },
			store,
			now: () => new Date(NOW),
		});
		const [pending] = await store.getPending([proposed.pending?.id as string]);
		const commitId = pending?.decisionCommitId as string;
		expect(
			(await classifyDelegatedCommit(store, (await store.getCommit(commitId)) as OutlineCommitRow))
				?.kind,
		).toBe("confirmation");
		expect((await undo(bob, commitId)).status).toBe(403);
		expect(pending?.digestSeenAt).toBeNull();
		const done = await undo(alice, commitId);
		expect(done.status).toBe(200);
		expect((await store.getBlock(step))?.content).toBe("Step");
		// Taken back, so seen: it leaves the confirmations still to acknowledge.
		expect((await store.getPending([pending?.id as string]))[0]?.digestSeenAt).not.toBeNull();
		expect((await undo(alice, commitId)).status).toBe(409);
	});
});
