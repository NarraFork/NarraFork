/**
 * Handing a task on (转交, outline P2 PR 10a, design §E.1): an agent's write that gives a task in
 * progress to another session or a person ends the work in the same commit, so the new executor
 * claims it with the next generation and a result of the previous one is told as late; what is
 * not a hand-over; what is refused by the rules that were there (someone else doing it, a session
 * that could not work there); what a locked or person-created task allows; and who the board
 * offers and accepts.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { foldHandle } from "../../../../shared/narrator-handle";
import { db } from "../../../db";
import { aclGrants, narrators, projects, users } from "../../../db/schema";
import { outlineEditTool, outlineReadTool } from "../../../lib/agent/tools/outline";
import type { ToolContext } from "../../../lib/agent/types";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import "../../../lib/agent/tools";
import { invalidateTaskBackend } from "../../task-source";
import { checkAgentAssignees, resolveAgentAssignee } from "../assignee";
import { classifyDelegatedResult } from "../delegation";
import { stopEditTextWorker } from "../edit-text-runner";
import { OutlineTaskClaimedError } from "../errors";
import { changePersonTask } from "../person-tasks";
import { clearOutlineReads } from "../read-ledger";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensureProjectSpace } from "../spaces";
import { outlineStore } from "../store";
import type { OutlineSpaceRow } from "../store/port";
import {
	listTransferSessions,
	OUTLINE_TRANSFER_LIMITS,
	startSessionOnTransferredTask,
} from "../transfer";
import { type OutlineOp, type OutlineWriteResult, writeOutline } from "../write";

const NOW = "2026-11-10T00:00:00.000Z";

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
	invalidateSessionReadScopes();
	clearOutlineReads();
});

afterEach(() => {
	stopEditTextWorker();
});

async function person(name = "pat"): Promise<{ id: string; username: string }> {
	const id = generateId();
	const username = `${name}${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
	await db.insert(users).values({ id, username, passwordHash: "x", role: "user", createdAt: NOW });
	return { id, username };
}

async function session(
	owner: string,
	projectId: string | null,
	extra: Partial<typeof narrators.$inferInsert> = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: "Session",
		ownerUserId: owner,
		taskBackend: "outline",
		visibility: "private",
		contextProjectId: projectId,
		status: "idle",
		createdAt: NOW,
		updatedAt: NOW,
		...extra,
	});
	return id;
}

async function world() {
	const owner = await person("lead");
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: `transfer-${projectId}`,
		ownerUserId: owner.id,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	const space = await ensureProjectSpace(projectId);
	const first = await session(owner.id, projectId, { title: "First" });
	const second = await session(owner.id, projectId, { title: "Second" });
	return { owner, projectId, space, first, second };
}

function asAgent(space: OutlineSpaceRow, narratorId: string, owner: string, ops: OutlineOp[]) {
	return writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "agent", id: narratorId },
		narratorId,
		responsibleUserId: owner,
	});
}

/** A task `narratorId` is doing (its claim, generation 1), on a new page. */
async function doing(space: OutlineSpaceRow, narratorId: string, owner: string, title = "Fix it") {
	const written = await asAgent(space, narratorId, owner, [
		{ op: "insert", tempId: "page", parent: null, content: "Work" },
		{ op: "insert", parent: { tempId: "page" }, content: title, task: { status: "doing" } },
	]);
	const task = written.results[1];
	if (!task) throw new Error("seed");
	return task;
}

const claimOf = async (blockId: string) => (await outlineStore.getTaskClaims([blockId]))[0] ?? null;
const taskOf = async (blockId: string) => (await outlineStore.getBlock(blockId))?.taskJson ?? null;
const adjustments = (result: OutlineWriteResult) =>
	result.results.flatMap((r) => r.adjustments ?? []).map((a) => a.kind);

describe("an agent hands a task in progress on", () => {
	test("to another session: back to to-do and released in the same commit; the new executor claims the next generation, and the old holder's result is late", async () => {
		const { owner, space, first, second } = await world();
		const task = await doing(space, first, owner.id);
		expect(await claimOf(task.blockId)).toMatchObject({ holderNarratorId: first, epoch: 1 });

		const handed = await asAgent(space, first, owner.id, [
			{ op: "setTask", block: { id: task.blockId }, task: { assignee: `agent:${second}` } },
		]);
		expect(adjustments(handed)).toEqual(["handed-over"]);
		expect(await taskOf(task.blockId)).toMatchObject({
			status: "todo",
			assignee: `agent:${second}`,
		});
		// Released, the generation kept: nobody holds it between the two.
		const released = await claimOf(task.blockId);
		expect(released).toMatchObject({
			holderNarratorId: null,
			holderUserId: null,
			epoch: 1,
			lastHolderNarratorId: first,
		});
		// A result the previous holder's subagent (sent with generation 1) hands in now: late.
		const facts = {
			epoch: 1,
			subagentId: "sub-of-first",
			inSession: (id: string) => id === first || id === "sub-of-first",
			delegatorNarratorId: first,
		};
		expect(
			classifyDelegatedResult({
				...facts,
				task: await outlineStore.getBlock(task.blockId),
				claim: released,
			}),
		).toEqual({ kind: "late", reason: "reopened" });

		// The new executor starts it: its claim, the next generation.
		await asAgent(space, second, owner.id, [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } },
		]);
		const taken = await claimOf(task.blockId);
		expect(taken).toMatchObject({ holderNarratorId: second, epoch: 2 });
		expect(
			classifyDelegatedResult({
				...facts,
				task: await outlineStore.getBlock(task.blockId),
				claim: taken,
			}),
		).toMatchObject({ kind: "late", reason: "taken_over", epoch: 2 });
	});

	test("to a person, and by a session's handle: handed on alike", async () => {
		const { owner, projectId, space, first } = await world();
		const handle = `Rev${generateId()
			.replace(/[^A-Za-z0-9]/g, "")
			.slice(0, 8)}`;
		const named = await session(owner.id, projectId, {
			title: "Reviewer",
			handle,
			handleFold: foldHandle(handle),
		});
		const toPerson = await doing(space, first, owner.id, "For a person");
		const a = await asAgent(space, first, owner.id, [
			{ op: "setTask", block: { id: toPerson.blockId }, task: { assignee: "human:pat" } },
		]);
		expect(adjustments(a)).toEqual(["handed-over"]);
		expect((await taskOf(toPerson.blockId))?.status).toBe("todo");
		const toNamed = await doing(space, first, owner.id, "For the reviewer");
		const b = await asAgent(space, first, owner.id, [
			{ op: "setTask", block: { id: toNamed.blockId }, task: { assignee: `agent:${handle}` } },
		]);
		expect(adjustments(b)).toEqual(["handed-over"]);
		expect((await claimOf(toNamed.blockId))?.holderNarratorId).toBeNull();
		expect(await resolveAgentAssignee(`agent:${handle.toLowerCase()}`)).toMatchObject({
			narratorId: named,
		});
	});

	test("not a hand-over: naming itself, its own subagent, a label no session has, clearing the assignee, a task that is not in progress", async () => {
		const { owner, projectId, space, first, second } = await world();
		const sub = await session(owner.id, projectId, {
			type: "subagent",
			parentNarratorId: first,
			aclRootNarratorId: first,
		});
		for (const assignee of [`agent:${first}`, `agent:${sub}`, "agent:w-auth", null]) {
			const task = await doing(space, first, owner.id, `Keep ${assignee}`);
			const written = await asAgent(space, first, owner.id, [
				{ op: "setTask", block: { id: task.blockId }, task: { assignee } },
			]);
			expect(adjustments(written)).toEqual([]);
			expect((await taskOf(task.blockId))?.status).toBe("doing");
			expect(await claimOf(task.blockId)).toMatchObject({ holderNarratorId: first, epoch: 1 });
		}
		// A to-do given an assignee: nothing to end, no claim touched.
		const todo = await asAgent(space, first, owner.id, [
			{ op: "insert", parent: null, content: "Later", task: { status: "todo" } },
		]);
		const id = todo.results[0]?.blockId as string;
		const assigned = await asAgent(space, first, owner.id, [
			{ op: "setTask", block: { id }, task: { assignee: `agent:${second}` } },
		]);
		expect(adjustments(assigned)).toEqual([]);
		expect(await claimOf(id)).toBeNull();
		// A person's edit of the same kind is written as it is (the board hands on for people).
		const mine = await doing(space, first, owner.id, "A person edits");
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: mine.blockId }, task: { assignee: `agent:${second}` } }],
			actor: { kind: "human", id: owner.id },
			responsibleUserId: owner.id,
		});
		expect((await taskOf(mine.blockId))?.status).toBe("doing");
	});

	test("a task another session is doing cannot be handed to a third: refused, naming who does it; once its lease ran out it can", async () => {
		const { owner, projectId, space, first, second } = await world();
		const third = await session(owner.id, projectId, { title: "Third" });
		const task = await doing(space, first, owner.id);
		const attempt = asAgent(space, second, owner.id, [
			{ op: "setTask", block: { id: task.blockId }, task: { assignee: `agent:${third}` } },
		]);
		await expect(attempt).rejects.toBeInstanceOf(OutlineTaskClaimedError);
		await expect(attempt).rejects.toMatchObject({
			holder: { kind: "agent", narratorId: first },
		});
		expect(await taskOf(task.blockId)).toMatchObject({ status: "doing", assignee: null });
		// Handing it to whoever is doing it changes no hands.
		const same = await asAgent(space, second, owner.id, [
			{ op: "setTask", block: { id: task.blockId }, task: { assignee: `agent:${first}` } },
		]);
		expect(adjustments(same)).toEqual([]);
		expect(await claimOf(task.blockId)).toMatchObject({ holderNarratorId: first, epoch: 1 });
		// The lease lapsed (nobody is doing it any more). A session that names itself is taking the
		// task over, not handing it on: it stays in progress, now its own.
		const later = new Date(Date.now() + 2 * 60 * 60_000);
		const other = await doing(space, first, owner.id, "Taken over");
		const taken = await writeOutline(
			{
				spaceId: space.id,
				ops: [
					{
						op: "setTask",
						block: { id: other.blockId },
						task: { status: "doing", assignee: `agent:${second}` },
					},
				],
				actor: { kind: "agent", id: second },
				narratorId: second,
				responsibleUserId: owner.id,
			},
			{ now: () => later },
		);
		expect(adjustments(taken)).toEqual([]);
		expect((await taskOf(other.blockId))?.status).toBe("doing");
		expect(await claimOf(other.blockId)).toMatchObject({ holderNarratorId: second, epoch: 2 });
		// Handed to a third: the hand-over goes through.
		const handed = await writeOutline(
			{
				spaceId: space.id,
				ops: [{ op: "setTask", block: { id: task.blockId }, task: { assignee: `agent:${third}` } }],
				actor: { kind: "agent", id: second },
				narratorId: second,
				responsibleUserId: owner.id,
			},
			{ now: () => later },
		);
		expect(adjustments(handed)).toEqual(["handed-over"]);
		expect((await taskOf(task.blockId))?.status).toBe("todo");
	});

	test("a locked, person-created task: the assignee is not the plan, so the hand-over is written directly and nothing waits for confirmation", async () => {
		const { owner, space, first, second } = await world();
		const created = await writeOutline({
			spaceId: space.id,
			ops: [
				{
					op: "insert",
					parent: null,
					content: "The goal",
					task: {
						status: "todo",
						humanCreated: true,
						manager: { kind: "human", id: owner.id },
						lock: { delegate: null },
					},
				},
			],
			actor: { kind: "human", id: owner.id },
			responsibleUserId: owner.id,
		});
		const id = created.results[0]?.blockId as string;
		await asAgent(space, first, owner.id, [
			{ op: "setTask", block: { id }, task: { status: "doing" } },
		]);
		const handed = await asAgent(space, first, owner.id, [
			{ op: "setTask", block: { id }, task: { assignee: `agent:${second}` } },
		]);
		expect(handed.pending).toBeUndefined();
		expect(adjustments(handed)).toEqual(["handed-over"]);
		const task = await taskOf(id);
		expect(task).toMatchObject({ status: "todo", assignee: `agent:${second}`, humanCreated: true });
		// The lock stays: only people lock and unlock.
		expect(task?.lock).toBeTruthy();
		// What the lock does hold back is unchanged: ending the goal still waits for its person.
		await asAgent(space, second, owner.id, [
			{ op: "setTask", block: { id }, task: { status: "doing" } },
		]);
		const done = await asAgent(space, second, owner.id, [
			{ op: "setTask", block: { id }, task: { status: "done" } },
		]);
		expect(done.pending).toBeDefined();
		expect((await taskOf(id))?.status).toBe("doing");
	});
});

describe("OutlineEdit", () => {
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
	const sids = (output: string) =>
		[...output.matchAll(/^\s*- \[([A-Za-z0-9/]+)\]/gm)].map((m) => m[1] as string);

	test("says the task went back to to-do; a name no session has is written as a name and said so; a session that cannot work there refuses the write", async () => {
		const { owner, space, first, second } = await world();
		const c = ctx(first, owner.id);
		const added = await outlineEditTool.execute(
			{
				edits: [{ add: "/", markdown: "- Work\n  - [/] Port the parser\n  - [ ] Write the docs" }],
			},
			c,
		);
		const [page, parser, docs] = sids(added.output) as [string, string, string];
		await outlineReadTool.execute({ address: page, view: "all" }, c);
		const handed = await outlineEditTool.execute(
			{ edits: [{ set: parser, assignee: `@agent:${second}` }] },
			c,
		);
		expect(handed.isError).toBeFalsy();
		expect(handed.output).toContain("was in progress and got a new assignee: it is back to to-do");
		const rows = await outlineStore.getBlockMetas(space.id, { sids: [parser, docs] });
		const parserRow = rows.find((r) => r.sid === parser);
		expect(parserRow?.taskJson).toMatchObject({ status: "todo", assignee: `agent:${second}` });

		const label = await outlineEditTool.execute(
			{ edits: [{ set: docs, assignee: "@agent:w-docs" }] },
			c,
		);
		expect(label.isError).toBeFalsy();
		expect(label.output).toContain('no session has the id or handle "w-docs"');
		expect(label.output).toContain("still in progress and still yours");
		// Writing the same label again assigns nothing, and says nothing.
		await outlineReadTool.execute({ address: page, view: "all" }, c);
		const again = await outlineEditTool.execute(
			{ edits: [{ set: docs, checkbox: "/", assignee: "@agent:w-docs" }] },
			c,
		);
		expect(again.output).not.toContain("no session has the id or handle");

		// A session whose person may not write this project.
		const stranger = await person("stranger");
		const outsider = await session(stranger.id, null, { title: "Outsider" });
		await outlineReadTool.execute({ address: page, view: "all" }, c);
		const refused = await outlineEditTool.execute(
			{ edits: [{ set: docs, assignee: `@agent:${outsider}` }] },
			c,
		);
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("cannot work in this space");
		expect(
			(await outlineStore.getBlockMetas(space.id, { sids: [docs] }))[0]?.taskJson?.assignee,
		).toBe("agent:w-docs");
	});
});

describe("who a task may be handed to", () => {
	test("checkAgentAssignees: sessions that can work there, names nobody has, sessions that cannot", async () => {
		const { owner, projectId, space, first, second } = await world();
		const archived = await session(owner.id, projectId, { status: "archived" });
		const stranger = await person("stranger");
		const outsider = await session(stranger.id, null);
		const checked = await checkAgentAssignees(
			[
				`agent:${second}`,
				"agent:nobody",
				`agent:${archived}`,
				`agent:${outsider}`,
				"human:pat",
				null,
			],
			space,
		);
		expect([...checked.sessions]).toEqual([[`agent:${second}`, second]]);
		expect(checked.unknown).toEqual(["nobody"]);
		expect(checked.refused.sort()).toEqual([archived, outsider].sort());
		expect(first).not.toBe(second);
	});

	test("the board offers the project's outline sessions the person may read that could do the task, named ones first; and accepts only those", async () => {
		const { owner, projectId, space, first, second } = await world();
		const handle = `Ops${generateId()
			.replace(/[^A-Za-z0-9]/g, "")
			.slice(0, 8)}`;
		const named = await session(owner.id, projectId, {
			title: "Ops",
			handle,
			handleFold: foldHandle(handle),
		});
		await session(owner.id, projectId, { title: "Spec", taskBackend: "spec" });
		await session(owner.id, projectId, { title: "Gone", status: "archived" });
		await session(owner.id, projectId, {
			type: "subagent",
			parentNarratorId: first,
			aclRootNarratorId: first,
		});
		// Someone else's private session in the project: the owner of the task cannot read it.
		const other = await person("other");
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId: other.id,
			capability: "write",
			createdAt: NOW,
		});
		const hidden = await session(other.id, projectId, { title: "Hidden" });
		const principal = { userId: owner.id, isAdmin: false };
		const offered = await listTransferSessions(principal, space);
		expect(offered.truncated).toBe(false);
		expect(offered.sessions[0]).toEqual({
			narratorId: named,
			title: "Ops",
			handle,
			canStart: true,
		});
		expect(offered.sessions.map((s) => s.narratorId).sort()).toEqual([first, second, named].sort());
		expect(offered.sessions.some((s) => s.narratorId === hidden)).toBe(false);

		// A person hands a task a session is doing to another: to-do, released, written by id.
		const task = await doing(space, first, owner.id);
		const block = await outlineStore.getBlock(task.blockId);
		const { result } = await changePersonTask({
			principal,
			blockId: task.blockId,
			baseVersionSeq: block?.versionSeq as number,
			assign: { kind: "narrator", narratorId: second },
		});
		expect(result?.commit).toBeTruthy();
		expect(await taskOf(task.blockId)).toMatchObject({
			status: "todo",
			assignee: `agent:${second}`,
		});
		expect(await claimOf(task.blockId)).toMatchObject({ holderNarratorId: null, epoch: 1 });
		// Handed to the session that is doing it: it keeps doing it.
		const kept = await doing(space, first, owner.id, "Keep going");
		await changePersonTask({
			principal,
			blockId: kept.blockId,
			baseVersionSeq: (await outlineStore.getBlock(kept.blockId))?.versionSeq as number,
			assign: { kind: "narrator", narratorId: first },
		});
		expect(await taskOf(kept.blockId)).toMatchObject({
			status: "doing",
			assignee: `agent:${first}`,
		});
		expect(await claimOf(kept.blockId)).toMatchObject({ holderNarratorId: first, epoch: 1 });
		// Only a session the picker would list is accepted: not one that could not do it, an
		// unknown id, a session of another project, or one keeping its tasks in Dynamic Spec.
		const stranger = await person("stranger");
		const outsider = await session(stranger.id, null);
		const otherProject = generateId();
		await db.insert(projects).values({
			id: otherProject,
			name: `elsewhere-${otherProject}`,
			ownerUserId: owner.id,
			visibility: "private",
			createdAt: NOW,
			updatedAt: NOW,
		});
		const elsewhere = await session(owner.id, otherProject, { title: "Elsewhere" });
		const spec = await session(owner.id, projectId, { title: "Spec too", taskBackend: "spec" });
		for (const narratorId of [outsider, "no-such-session", elsewhere, spec]) {
			await expect(
				changePersonTask({
					principal,
					blockId: kept.blockId,
					baseVersionSeq: (await outlineStore.getBlock(kept.blockId))?.versionSeq as number,
					assign: { kind: "narrator", narratorId },
				}),
			).rejects.toThrow("This session cannot work on this task");
		}
	});
});

describe("the picker", () => {
	test("sessions that could not do the task do not use up the list: those that could are found past them, and `truncated` counts only those", async () => {
		const { owner, projectId, space, first, second } = await world();
		// More sessions of the project than one page that could NOT take the task (their person
		// may not write the project), named so they sort first.
		const stranger = await person("stranger");
		const many = OUTLINE_TRANSFER_LIMITS.page + 5;
		for (let i = 0; i < many; i++) {
			const handle = `Zz${i}x${generateId()
				.replace(/[^A-Za-z0-9]/g, "")
				.slice(0, 8)}`;
			await session(stranger.id, projectId, { handle, handleFold: foldHandle(handle) });
		}
		// An admin reads them all, so only "could it do the task" leaves them out.
		const offered = await listTransferSessions({ userId: owner.id, isAdmin: true }, space);
		expect(offered.sessions.map((s) => s.narratorId).sort()).toEqual([first, second].sort());
		expect(offered.truncated).toBe(false);
	});

	test("「转交并开始」 is offered only where the person may write the session", async () => {
		const { owner, projectId, space, first } = await world();
		const other = await person("other");
		const theirs = await session(other.id, projectId, { title: "Theirs" });
		for (const [scopeType, scopeId, principalId, capability] of [
			["project", projectId, other.id, "write"],
			["narrator", theirs, owner.id, "read"],
		] as const)
			await db.insert(aclGrants).values({
				id: generateId(),
				scopeType,
				scopeId,
				principalType: "user",
				principalId,
				capability,
				createdAt: NOW,
			});
		const offered = await listTransferSessions({ userId: owner.id, isAdmin: false }, space);
		const by = new Map(offered.sessions.map((s) => [s.narratorId, s.canStart]));
		expect(by.get(first)).toBe(true);
		expect(by.get(theirs)).toBe(false);
	});
});

describe("转交并开始, when the start declines or the task is held", () => {
	/** A session layer whose start declines after the blocker let it through. */
	const declining = {
		outlineSessionStartBlocker: async () => undefined,
		startSpecContinuationIfPossible: async () => ({ started: false }),
	};

	test("a claim the start made is given back: the task is to do again, nobody holds it", async () => {
		const { owner, space, second } = await world();
		const written = await writeOutline({
			spaceId: space.id,
			ops: [
				{
					op: "insert",
					parent: null,
					content: "Start me",
					task: { status: "todo", assignee: `agent:${second}` },
				},
			],
			actor: { kind: "human", id: owner.id },
			responsibleUserId: owner.id,
		});
		const id = written.results[0]?.blockId as string;
		const out = await startSessionOnTransferredTask({
			narratorId: second,
			userId: owner.id,
			blockId: id,
			session: declining,
		});
		expect(out).toEqual({ started: false, notStarted: "not_started" });
		expect((await taskOf(id))?.status).toBe("todo");
		// Claimed for the start (generation 1), then released.
		expect(await claimOf(id)).toMatchObject({
			holderNarratorId: null,
			epoch: 1,
			lastHolderNarratorId: second,
		});
	});

	test("a claim the session held before the click stays its own", async () => {
		const { owner, space, second } = await world();
		const task = await doing(space, second, owner.id, "Already mine");
		const out = await startSessionOnTransferredTask({
			narratorId: second,
			userId: owner.id,
			blockId: task.blockId,
			session: declining,
		});
		expect(out).toEqual({ started: false, notStarted: "not_started" });
		expect((await taskOf(task.blockId))?.status).toBe("doing");
		expect(await claimOf(task.blockId)).toMatchObject({ holderNarratorId: second, epoch: 1 });
	});

	test("a task someone else is doing is not started on, and their claim is left alone", async () => {
		const { owner, space, first, second } = await world();
		const task = await doing(space, first, owner.id, "Theirs");
		let asked = 0;
		const out = await startSessionOnTransferredTask({
			narratorId: second,
			userId: owner.id,
			blockId: task.blockId,
			session: {
				outlineSessionStartBlocker: async () => undefined,
				startSpecContinuationIfPossible: async () => {
					asked++;
					return { started: true };
				},
			},
		});
		expect(out).toEqual({ started: false, notStarted: "not_started" });
		expect(asked).toBe(0);
		expect((await taskOf(task.blockId))?.status).toBe("doing");
		expect(await claimOf(task.blockId)).toMatchObject({ holderNarratorId: first, epoch: 1 });
	});
});
