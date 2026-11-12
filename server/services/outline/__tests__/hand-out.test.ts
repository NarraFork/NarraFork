/**
 * Handing a task out (交出去, outline P2 PR 10c-3, design v2 §E.2): a task of a session's own space
 * goes to the team as a copy on the project's task page, and the original waits for the copy.
 *
 *   - the copy (the task, its steps and notes, the provenance), the prerequisite, the note under
 *     the original, the claim of a task in progress released;
 *   - one copy whatever is retried or raced; a second step that fails is recorded under the copy,
 *     and a later attempt finishes it without a second copy;
 *   - refusals (no project, not the owner or the session, the project not writable, a target
 *     that could not work there, finished, a plan being planned, someone else doing it) write
 *     nothing; the size bound;
 *   - an agent's `@agent:` / `@human:` on a task of its own space goes through it; its own person,
 *     itself and a name nobody has stay where they are;
 *   - the team events: a session's hand-out to another session wakes it, a person's records;
 *     the copy done by another session tells and wakes the original's session;
 *   - the digest names whoever handed it out, never "the system".
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own world.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../../db";
import { aclGrants, narrators, projects, users } from "../../../db/schema";
import { outlineEditTool, outlineReadTool } from "../../../lib/agent/tools/outline";
import type { ToolContext } from "../../../lib/agent/types";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import "../../../lib/agent/tools";
import { ValidationError } from "../../../lib/errors";
import { invalidateTaskBackend } from "../../task-source";
import { summarizeSpaceWindow } from "../digest";
import { stopEditTextWorker } from "../edit-text-runner";
import { OutlineBusyError } from "../errors";
import {
	handOutBlockId,
	handOutTask,
	isHandOutBlockId,
	OUTLINE_HAND_OUT_ACTOR,
	OUTLINE_HAND_OUT_LIMITS,
	OutlineHandOutError,
} from "../hand-out";
import { OUTLINE_TASKS_PAGE_ALIAS } from "../model";
import { addPersonTask, changePersonTask } from "../person-tasks";
import { clearOutlineReads } from "../read-ledger";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensureProjectSpace, ensureSessionSpace } from "../spaces";
import { outlineStore } from "../store";
import type { OutlineSpaceRow } from "../store/port";
import { readSessionTaskBoard } from "../task-board";
import { readOutlineTeamMessages } from "../team-events";
import { type OutlineOp, writeOutline } from "../write";

const NOW = "2026-11-12T00:00:00.000Z";

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

async function project(owner: string): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `hand-out-${id}`,
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function world() {
	const owner = await person("lead");
	const projectId = await project(owner.id);
	const main = await session(owner.id, projectId, { title: "Main" });
	const other = await session(owner.id, projectId, { title: "Other" });
	const sessionSpace = await ensureSessionSpace(main);
	return { owner, projectId, main, other, sessionSpace };
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

/**
 * A task of the session space with two steps (the second depends on the first), a note, and the
 * session doing it.
 */
async function sessionTask(space: OutlineSpaceRow, narratorId: string, owner: string) {
	const written = await asAgent(space, narratorId, owner, [
		{ op: "insert", tempId: "page", parent: null, content: "Work" },
		{
			op: "insert",
			sid: "prepDone1",
			parent: { tempId: "page" },
			content: "Prepare the fixtures",
			task: { status: "done" },
		},
		{
			op: "insert",
			tempId: "t",
			parent: { tempId: "page" },
			content: "Port the parser",
			task: { status: "doing", depends: [{ target: "prepDone1", label: null }] },
		},
		{ op: "insert", parent: { tempId: "t" }, content: "The lexer is done; the grammar is next" },
		{
			op: "insert",
			tempId: "s1",
			sid: "stepOne1",
			parent: { tempId: "t" },
			content: "Port the lexer",
			task: { status: "done" },
		},
		{
			op: "insert",
			parent: { tempId: "t" },
			content: "Port the grammar",
			task: { status: "todo", depends: [{ target: "stepOne1", label: null }] },
		},
	]);
	const task = written.results[2];
	if (!task) throw new Error("seed");
	return task;
}

const person_ = (principal: { id: string }) => ({
	kind: "person" as const,
	principal: { userId: principal.id, isAdmin: false },
});

async function lastEvent(spaceId: string) {
	const space = await outlineStore.getSpace(spaceId);
	const seq = (space?.nextSeq ?? 1) - 1;
	const [commit] = await outlineStore.getCommitsBySeqs(spaceId, [seq]);
	if (!commit) throw new Error("no commit");
	return {
		commit,
		event: {
			spaceId,
			commitId: commit.id,
			seq: commit.seq,
			actorKind: commit.actorKind as "human" | "agent" | "system",
			actorId: commit.actorId,
		},
	};
}

/** The copy's subtree: rows in document order (parents before children). */
async function subtreeRows(rootId: string) {
	const out: Array<{ id: string; parentId: string | null; content: string; task: unknown }> = [];
	const walk = async (id: string) => {
		const row = await outlineStore.getBlock(id);
		if (!row || row.deleted) return;
		out.push({ id: row.id, parentId: row.parentId, content: row.content, task: row.taskJson });
		const children = await outlineStore.listChildMetas(row.spaceId, [row.id], 500);
		const sorted = children.sort((a, b) => (a.orderKey < b.orderKey ? -1 : 1));
		for (const child of sorted) await walk(child.id);
	};
	await walk(rootId);
	return out;
}

describe("handing a task out to the team", () => {
	test("the copy, its provenance and steps, the prerequisite, the note; the claim released", async () => {
		const { owner, projectId, main, sessionSpace } = await world();
		const task = await sessionTask(sessionSpace, main, owner.id);
		const before = await outlineStore.getBlock(task.blockId);
		const out = await handOutTask({
			taskId: task.blockId,
			by: person_(owner),
			target: { kind: "team" },
			baseVersionSeq: before?.versionSeq,
		});
		expect(out.already).toBe(false);
		expect(out.omitted).toBe(0);
		expect(out.copy.id).toBe(handOutBlockId("copy", task.blockId, before?.versionSeq as number));
		expect(isHandOutBlockId(out.copy.id)).toBe(true);

		// The copy, last on the project's task page (made for it).
		const projectSpace = await ensureProjectSpace(projectId);
		expect(out.copy.spaceId).toBe(projectSpace.id);
		const [page] = await outlineStore.findAliasOwners(projectSpace.id, [OUTLINE_TASKS_PAGE_ALIAS]);
		const copy = await outlineStore.getBlock(out.copy.id);
		expect(copy?.parentId).toBe(page?.id);
		expect(copy?.content).toBe("Port the parser");
		expect(copy?.taskJson).toMatchObject({
			status: "todo",
			assignee: null,
			manager: { kind: "agent", id: main },
			claimable: true,
			// A prerequisite written bare still names the session space's task.
			depends: [{ target: `${sessionSpace.key}/prepDone1`, label: null }],
		});
		const rows = await subtreeRows(out.copy.id);
		expect(rows.map((r) => r.content)).toEqual([
			"Port the parser",
			`Handed out from [[${sessionSpace.key}/${task.sid}]]`,
			"The lexer is done; the grammar is next",
			"Port the lexer",
			"Port the grammar",
		]);
		// Steps keep their checkbox; the grammar's prerequisite names the lexer's copy.
		const lexer = rows[3] as { id: string; task: { status: string } };
		const lexerSid = (await outlineStore.getBlock(lexer.id))?.sid;
		expect(lexer.task).toMatchObject({ status: "done" });
		expect((lexer.task as { manager?: unknown }).manager).toBeUndefined();
		expect(rows[4]?.task).toMatchObject({
			status: "todo",
			depends: [{ target: `${projectSpace.key}/${lexerSid}`, label: null }],
		});
		// Written by the system for the person, carrying no session.
		const { commit } = await lastEvent(projectSpace.id);
		expect(commit).toMatchObject({
			actorKind: "system",
			actorId: OUTLINE_HAND_OUT_ACTOR,
			responsibleUserId: owner.id,
			narratorId: null,
		});

		// The original: to do, waiting for the copy, a note under it; its claim released.
		const original = await outlineStore.getBlock(task.blockId);
		expect(original?.taskJson).toMatchObject({
			status: "todo",
			depends: [
				{ target: "prepDone1", label: null },
				{ target: out.copy.address, label: null },
			],
		});
		expect(out.versionSeq).toBe(original?.versionSeq as number);
		const note = await outlineStore.getBlock(
			handOutBlockId("note", task.blockId, before?.versionSeq as number),
		);
		expect(note?.parentId).toBe(task.blockId);
		expect(note?.content).toBe(
			`Handed to the team: [[${out.copy.address}]] (this task waits for it)`,
		);
		const [claim] = await outlineStore.getTaskClaims([task.blockId]);
		expect(claim?.holderNarratorId ?? null).toBeNull();
		// The person's own commit in the session space.
		const { commit: second } = await lastEvent(sessionSpace.id);
		expect(second).toMatchObject({ actorKind: "human", actorId: owner.id });

		// The copy is a project task nobody holds: the pool.
		const [copyClaim] = await outlineStore.getTaskClaims([out.copy.id]);
		expect(copyClaim?.holderNarratorId ?? null).toBeNull();
	});

	test("a retry and a race make one copy; a hand-out of a task waiting on its open copy answers that copy", async () => {
		const { owner, main, sessionSpace } = await world();
		const task = await sessionTask(sessionSpace, main, owner.id);
		const [a, b] = await Promise.all([
			handOutTask({ taskId: task.blockId, by: person_(owner), target: { kind: "team" } }),
			handOutTask({ taskId: task.blockId, by: person_(owner), target: { kind: "team" } }),
		]);
		expect(a?.copy.id).toBe(b?.copy.id as string);
		expect([a?.already, b?.already].sort()).toEqual([false, true]);
		const again = await handOutTask({
			taskId: task.blockId,
			by: person_(owner),
			target: { kind: "team" },
		});
		expect(again).toMatchObject({ already: true, copy: { id: a?.copy.id } });
		const page = await outlineStore.getBlock(a?.copy.id as string);
		const siblings = await outlineStore.listChildMetas(
			page?.spaceId as string,
			[page?.parentId as string],
			50,
		);
		expect(siblings.filter((s) => s.taskJson)).toHaveLength(1);
		// The original holds one prerequisite and one note.
		const original = await outlineStore.getBlock(task.blockId);
		expect(original?.taskJson?.depends).toHaveLength(2);
		const notes = (await outlineStore.listChildMetas(sessionSpace.id, [task.blockId], 50)).filter(
			(m) => isHandOutBlockId(m.id),
		);
		expect(notes).toHaveLength(1);

		// The copy cancelled, the task handed out again: a new copy, without the first hand-out's
		// note under the original.
		const copyRow = await outlineStore.getBlock(a?.copy.id as string);
		await writeOutline({
			spaceId: copyRow?.spaceId as string,
			ops: [{ op: "setTask", block: { id: copyRow?.id as string }, task: { status: "cancelled" } }],
			actor: { kind: "human", id: owner.id },
			responsibleUserId: owner.id,
		});
		const second = await handOutTask({
			taskId: task.blockId,
			by: person_(owner),
			target: { kind: "team" },
		});
		expect(second.already).toBe(false);
		expect(second.copy.id).not.toBe(a?.copy.id as string);
		const copied = (await subtreeRows(second.copy.id)).map((r) => r.content);
		expect(copied.some((text) => text.startsWith("Handed to the team"))).toBe(false);
		expect(copied).toContain("The lexer is done; the grammar is next");
	});

	test("a second step that keeps failing is recorded under the copy; the next attempt finishes it without a second copy", async () => {
		const { owner, main, sessionSpace } = await world();
		const task = await sessionTask(sessionSpace, main, owner.id);
		const version = (await outlineStore.getBlock(task.blockId))?.versionSeq as number;
		let calls = 0;
		const failing = (async () => {
			calls++;
			throw new OutlineBusyError(sessionSpace.id, 1);
		}) as unknown as typeof writeOutline;
		let error: unknown = null;
		try {
			await handOutTask({
				taskId: task.blockId,
				by: person_(owner),
				target: { kind: "team" },
				writeOriginal: failing,
			});
		} catch (caught) {
			error = caught;
		}
		expect(calls).toBe(OUTLINE_HAND_OUT_LIMITS.attempts);
		expect(error).toBeInstanceOf(OutlineHandOutError);
		expect((error as OutlineHandOutError).reason).toBe("original_not_updated");
		expect((error as OutlineHandOutError).statusCode).toBe(500);
		const copyId = handOutBlockId("copy", task.blockId, version);
		const failed = await outlineStore.getBlock(handOutBlockId("failed", task.blockId, version));
		expect(failed?.parentId).toBe(copyId);
		expect(failed?.content).toContain(`[[${sessionSpace.key}/${task.sid}]]`);
		// The original is as it was.
		expect((await outlineStore.getBlock(task.blockId))?.versionSeq).toBe(version);

		const done = await handOutTask({
			taskId: task.blockId,
			by: person_(owner),
			target: { kind: "team" },
		});
		expect(done.copy.id).toBe(copyId);
		expect((await outlineStore.getBlock(task.blockId))?.taskJson?.depends).toEqual([
			{ target: "prepDone1", label: null },
			{ target: done.copy.address, label: null },
		]);
	});

	test("refusals write nothing: no project, not the owner, the project not writable, a target that could not work there, finished, planning, someone else doing it", async () => {
		const { owner, projectId, main, other, sessionSpace } = await world();
		const refusal = async (fn: () => Promise<unknown>) => {
			try {
				await fn();
			} catch (error) {
				if (error instanceof OutlineHandOutError) return error.reason;
				if (error instanceof ValidationError) return `invalid: ${error.message}`;
				throw error;
			}
			return "handed out";
		};
		const projectSpace = await ensureProjectSpace(projectId);
		const commitsBefore = projectSpace.nextSeq;

		// No project (a session outside any git repository).
		const loner = await session(owner.id, null);
		const lonerSpace = await ensureSessionSpace(loner);
		const lonerTask = await sessionTask(lonerSpace, loner, owner.id);
		expect(
			await refusal(() =>
				handOutTask({ taskId: lonerTask.blockId, by: person_(owner), target: { kind: "team" } }),
			),
		).toBe("no_project");

		const task = await sessionTask(sessionSpace, main, owner.id);
		// Someone who may write the session but does not own it; another session.
		const writer = await person("writer");
		await grant(projectId, writer.id, "write");
		expect(
			await refusal(() =>
				handOutTask({ taskId: task.blockId, by: person_(writer), target: { kind: "team" } }),
			),
		).toBe("not_owner");
		expect(
			await refusal(() =>
				handOutTask({
					taskId: task.blockId,
					by: {
						kind: "session",
						narratorId: other,
						principal: { userId: owner.id, isAdmin: false },
					},
					target: { kind: "team" },
				}),
			),
		).toBe("not_owner");

		// The session's owner may only read the project.
		const reader = await person("reader");
		await grant(projectId, reader.id, "read");
		const readersSession = await session(reader.id, projectId);
		const readersTask = await sessionTask(
			await ensureSessionSpace(readersSession),
			readersSession,
			reader.id,
		);
		expect(
			await refusal(() =>
				handOutTask({ taskId: readersTask.blockId, by: person_(reader), target: { kind: "team" } }),
			),
		).toBe("cannot_write_project");

		// A person who could not work in the project.
		expect(
			await refusal(() =>
				handOutTask({
					taskId: task.blockId,
					by: person_(owner),
					target: { kind: "person", userId: reader.id, username: reader.username },
				}),
			),
		).toBe(`invalid: No one named ${reader.username} can work on this task`);

		// A stale version.
		expect(
			await refusal(() =>
				handOutTask({
					taskId: task.blockId,
					by: person_(owner),
					target: { kind: "team" },
					baseVersionSeq: 999,
				}),
			),
		).toBe("changed");

		// Finished; a plan not approved yet.
		const finished = await asAgent(sessionSpace, main, owner.id, [
			{ op: "insert", parent: null, content: "Done already", task: { status: "done" } },
		]);
		expect(
			await refusal(() =>
				handOutTask({
					taskId: finished.results[0]?.blockId as string,
					by: person_(owner),
					target: { kind: "team" },
				}),
			),
		).toBe("finished");
		const planned = await writeOutline({
			spaceId: sessionSpace.id,
			ops: [
				{
					op: "insert",
					tempId: "p",
					parent: null,
					content: "A plan",
					task: { status: "todo", plan: { state: "planning", by: main, round: 1 } },
				},
				{ op: "insert", parent: { tempId: "p" }, content: "A step", task: { status: "todo" } },
			],
			actor: { kind: "system", id: "test" },
			responsibleUserId: owner.id,
		});
		expect(
			await refusal(() =>
				handOutTask({
					taskId: planned.results[1]?.blockId as string,
					by: person_(owner),
					target: { kind: "team" },
				}),
			),
		).toBe("planning");

		// A goal its person locked: theirs to hand out, not the session's.
		const goal = await addPersonTask({
			narratorId: main,
			userId: owner.id,
			text: "Ship the release",
			lock: true,
		});
		expect(
			await refusal(() =>
				handOutTask({
					taskId: goal.blockId,
					by: {
						kind: "session",
						narratorId: main,
						principal: { userId: owner.id, isAdmin: false },
					},
					target: { kind: "team" },
				}),
			),
		).toBe("locked");

		// A person doing it.
		const theirs = await writeOutline({
			spaceId: sessionSpace.id,
			ops: [{ op: "insert", parent: null, content: "Mine now", task: { status: "doing" } }],
			actor: { kind: "human", id: writer.id },
			responsibleUserId: writer.id,
		});
		expect(
			await refusal(() =>
				handOutTask({
					taskId: theirs.results[0]?.blockId as string,
					by: person_(owner),
					target: { kind: "team" },
				}),
			),
		).toBe("held");

		// Nothing reached the project.
		expect((await outlineStore.getSpace(projectSpace.id))?.nextSeq).toBe(commitsBefore);
		expect((await outlineStore.getBlock(task.blockId))?.taskJson?.depends).toHaveLength(1);
	});

	test("a large task: at most the limit of blocks, breadth first, the rest counted in the provenance", async () => {
		const { owner, main, sessionSpace } = await world();
		const root = await asAgent(sessionSpace, main, owner.id, [
			{ op: "insert", parent: null, content: "Big", task: { status: "todo" } },
		]);
		const rootId = root.results[0]?.blockId as string;
		// 120 notes under the task, each with one detail: 240 blocks under it.
		for (let batch = 0; batch < 3; batch++) {
			const ops: OutlineOp[] = [];
			for (let i = 0; i < 40; i++) {
				const n = batch * 40 + i;
				ops.push({ op: "insert", tempId: `n${n}`, parent: { id: rootId }, content: `Note ${n}` });
				ops.push({ op: "insert", parent: { tempId: `n${n}` }, content: `Detail ${n}` });
			}
			await asAgent(sessionSpace, main, owner.id, ops);
		}
		const out = await handOutTask({ taskId: rootId, by: person_(owner), target: { kind: "team" } });
		const rows = await subtreeRows(out.copy.id);
		expect(rows).toHaveLength(OUTLINE_HAND_OUT_LIMITS.blocks);
		// The task, every note (the first level), then details while there was room.
		const copied = OUTLINE_HAND_OUT_LIMITS.blocks - 1;
		expect(out.omitted).toBe(241 - copied);
		expect(rows.filter((r) => r.content.startsWith("Note "))).toHaveLength(120);
		expect(rows[1]?.content).toContain(`${241 - copied} more blocks under it were not copied`);
	});
});

describe("on the board", () => {
	test("「交给团队」 and give-to-someone on a session task hand it out; to the owner it stays; the board offers it to the owner only", async () => {
		const { owner, projectId, main, sessionSpace } = await world();
		const mate = await person("mate");
		await grant(projectId, mate.id, "write");
		const version = async (id: string) => (await outlineStore.getBlock(id))?.versionSeq as number;
		const team = await sessionTask(sessionSpace, main, owner.id);
		const toTeam = await changePersonTask({
			principal: { userId: owner.id, isAdmin: false },
			blockId: team.blockId,
			baseVersionSeq: await version(team.blockId),
			assign: { kind: "team" },
		});
		expect(toTeam.handedOut?.copy.address).toBeDefined();
		expect(toTeam.result).toBeNull();

		const named = await asAgent(sessionSpace, main, owner.id, [
			{ op: "insert", parent: null, content: "Review the PR", task: { status: "todo" } },
		]);
		const id = named.results[0]?.blockId as string;
		const toMate = await changePersonTask({
			principal: { userId: owner.id, isAdmin: false },
			blockId: id,
			baseVersionSeq: await version(id),
			assign: { kind: "user", username: mate.username },
		});
		expect(
			(await outlineStore.getBlock(toMate.handedOut?.copy.id as string))?.taskJson,
		).toMatchObject({
			assignee: `human:${mate.username}`,
			status: "todo",
		});
		expect(
			(await outlineStore.getBlock(toMate.handedOut?.copy.id as string))?.taskJson?.claimable,
		).toBeUndefined();
		// The original keeps its (lack of) assignee and waits.
		expect((await outlineStore.getBlock(id))?.taskJson).toMatchObject({ assignee: null });

		// To the owner: in place.
		const mine = await asAgent(sessionSpace, main, owner.id, [
			{ op: "insert", parent: null, content: "Mine", task: { status: "todo" } },
		]);
		const mineId = mine.results[0]?.blockId as string;
		const inPlace = await changePersonTask({
			principal: { userId: owner.id, isAdmin: false },
			blockId: mineId,
			baseVersionSeq: await version(mineId),
			assign: { kind: "me" },
		});
		expect(inPlace.handedOut).toBeUndefined();
		expect((await outlineStore.getBlock(mineId))?.taskJson?.assignee).toBe(
			`human:${owner.username}`,
		);

		// The team target on a project task is refused.
		await expect(
			changePersonTask({
				principal: { userId: owner.id, isAdmin: false },
				blockId: toTeam.handedOut?.copy.id as string,
				baseVersionSeq: await version(toTeam.handedOut?.copy.id as string),
				assign: { kind: "team" },
			}),
		).rejects.toThrow(/Only a session's task goes to the team/);

		// The board: the owner may hand out, someone else who may write the session may not.
		const ownerBoard = await readSessionTaskBoard({ userId: owner.id, isAdmin: false }, main);
		expect(ownerBoard.sections[0]?.handOut).toBe(true);
		const shared = await session(owner.id, projectId, {
			visibility: "project",
			writeAudience: "project",
		});
		await ensureSessionSpace(shared);
		const mateBoard = await readSessionTaskBoard({ userId: mate.id, isAdmin: false }, shared);
		expect(mateBoard.sections[0]?.canWrite).toBe(true);
		expect(mateBoard.sections[0]?.handOut).toBeUndefined();
	});
});

describe("an agent's write", () => {
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

	test("@human:someone and @agent:another on a task of its own space hand it out; its own person, itself and an unknown name stay", async () => {
		const { owner, projectId, main, other, sessionSpace } = await world();
		const mate = await person("mate");
		await grant(projectId, mate.id, "write");
		const c = ctx(main, owner.id);
		const added = await outlineEditTool.execute(
			{
				edits: [
					{
						add: "session/",
						markdown:
							"- Work\n  - [/] Port the parser\n  - [ ] Write the docs\n  - [ ] Tidy up\n  - [ ] Ask around",
					},
				],
			},
			c,
		);
		expect(added.isError).toBeFalsy();
		const [page, parser, docs, tidy, ask] = sids(added.output) as [
			string,
			string,
			string,
			string,
			string,
		];
		await outlineReadTool.execute({ address: page, view: "all" }, c);

		const handed = await outlineEditTool.execute(
			{
				edits: [
					{ set: parser, assignee: `@human:${mate.username}` },
					{ set: docs, assignee: `@agent:${other}` },
				],
			},
			c,
		);
		expect(handed.isError).toBeFalsy();
		expect(handed.output).toContain(`assigned to @human:${mate.username}`);
		expect(handed.output).toContain(`assigned to @agent:${other}`);
		expect(handed.output).toContain("now waiting for the copy");
		const rows = await outlineStore.getBlockMetas(sessionSpace.id, {
			sids: [parser, docs, tidy, ask],
		});
		const bySid = new Map(rows.map((r) => [r.sid, r]));
		// The originals: no new assignee, to do, waiting for their copies.
		expect(bySid.get(parser)?.taskJson).toMatchObject({ status: "todo", assignee: null });
		expect(bySid.get(parser)?.taskJson?.depends).toHaveLength(1);
		expect(bySid.get(docs)?.taskJson?.depends).toHaveLength(1);
		const projectSpace = await ensureProjectSpace(projectId);
		const copyOf = async (sid: string) => {
			const target = (await outlineStore.getBlockMetas(sessionSpace.id, { sids: [sid] }))[0]
				?.taskJson?.depends?.[0]?.target as string;
			return outlineStore.getBlockBySid(projectSpace.id, target.split("/")[1] as string);
		};
		expect((await copyOf(parser))?.taskJson?.assignee).toBe(`human:${mate.username}`);
		expect((await copyOf(docs))?.taskJson?.assignee).toBe(`agent:${other}`);
		// Written for the session: the other session is told, and woken (a session's act).
		const { commit, event } = await lastEvent(projectSpace.id);
		expect(commit).toMatchObject({ actorId: OUTLINE_HAND_OUT_ACTOR, narratorId: main });
		const told = await readOutlineTeamMessages(event);
		expect(told).toEqual([expect.objectContaining({ narratorId: other, wake: true })]);

		// Its own person, itself, and a name nobody has: written in place.
		await outlineReadTool.execute({ address: page, view: "all" }, c);
		const stay = await outlineEditTool.execute(
			{
				edits: [
					{ set: tidy, assignee: `@human:${owner.username}` },
					{ set: ask, assignee: "@agent:w-nobody" },
				],
			},
			c,
		);
		expect(stay.isError).toBeFalsy();
		expect(stay.output).not.toContain("handed out");
		const after = await outlineStore.getBlockMetas(sessionSpace.id, { sids: [tidy, ask] });
		expect(after.map((r) => r.taskJson?.assignee).sort()).toEqual(
			[`human:${owner.username}`, "agent:w-nobody"].sort(),
		);
		expect(after.every((r) => !r.taskJson?.depends)).toBe(true);
	});

	test("the provenance names the original only to a reader who may read the session's space", async () => {
		const { owner, projectId, main, sessionSpace } = await world();
		const mate = await person("mate");
		await grant(projectId, mate.id, "write");
		const mates = await session(mate.id, projectId, { title: "Mate's" });
		const task = await sessionTask(sessionSpace, main, owner.id);
		const out = await handOutTask({
			taskId: task.blockId,
			by: person_(owner),
			target: { kind: "team" },
		});
		const original = `${sessionSpace.key}/${task.sid}`;
		const own = await outlineReadTool.execute(
			{ address: out.copy.address, view: "all" },
			ctx(main, owner.id),
		);
		expect(own.output).toContain(`[[${original}|Port the parser]]`);
		const theirs = await outlineReadTool.execute(
			{ address: out.copy.address, view: "all" },
			ctx(mates, mate.id),
		);
		expect(theirs.isError).toBeFalsy();
		expect(theirs.output).toContain(`[[${original}]]`);
		expect(theirs.output).not.toContain(`[[${original}|`);
	});

	test("refused with a named reason when the session has no project or the target could not work there; nothing written", async () => {
		const owner = await person("lone");
		const mate = await person("mate");
		const loner = await session(owner.id, null);
		const c = ctx(loner, owner.id);
		const added = await outlineEditTool.execute(
			{ edits: [{ add: "session/", markdown: "- Work\n  - [ ] Port the parser" }] },
			c,
		);
		const [page, parser] = sids(added.output) as [string, string];
		await outlineReadTool.execute({ address: page, view: "all" }, c);
		const refused = await outlineEditTool.execute(
			{ edits: [{ set: parser, checkbox: "/", assignee: `@human:${mate.username}` }] },
			c,
		);
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("Nothing was written");
		expect(refused.output).toContain("The session belongs to no project");
		const space = await ensureSessionSpace(loner);
		expect(
			(await outlineStore.getBlockMetas(space.id, { sids: [parser] }))[0]?.taskJson,
		).toMatchObject({
			status: "todo",
			assignee: null,
		});

		const { main, other: other2, sessionSpace } = await world();
		const owner2 = (await db.query.narrators.findFirst({ where: (n, { eq }) => eq(n.id, main) }))
			?.ownerUserId as string;
		const c2 = ctx(main, owner2);
		const added2 = await outlineEditTool.execute(
			{ edits: [{ add: "session/", markdown: "- Work\n  - [ ] Port the parser" }] },
			c2,
		);
		const [page2, parser2] = sids(added2.output) as [string, string];
		await outlineReadTool.execute({ address: page2, view: "all" }, c2);
		const cannot = await outlineEditTool.execute(
			{ edits: [{ set: parser2, assignee: `@human:${mate.username}` }] },
			c2,
		);
		expect(cannot.isError).toBe(true);
		expect(cannot.output).toContain(`No one named ${mate.username} can work on this task`);
		// A goal its person locked: refused before anything is written, the person's to hand out.
		const goal = await addPersonTask({
			narratorId: main,
			userId: owner2,
			text: "Locked goal",
			lock: true,
		});
		const goalSid = (await outlineStore.getBlock(goal.blockId))?.sid as string;
		await outlineReadTool.execute({ address: goalSid, view: "all" }, c2);
		const locked = await outlineEditTool.execute(
			{ edits: [{ set: goalSid, assignee: `@agent:${other2}` }] },
			c2,
		);
		expect(locked.isError).toBe(true);
		expect(locked.output).toContain("a plan a person locked");
		expect((await outlineStore.getBlock(goal.blockId))?.taskJson?.depends).toBeUndefined();
		expect(
			(await outlineStore.getBlockMetas(sessionSpace.id, { sids: [parser2] }))[0]?.taskJson
				?.assignee,
		).toBeNull();
	});
});

describe("team events and the digest", () => {
	test("a person's hand-out to a session records without waking; the copy done by another session tells and wakes the original's session", async () => {
		const { owner, projectId, main, other, sessionSpace } = await world();
		const task = await sessionTask(sessionSpace, main, owner.id);
		const out = await changePersonTask({
			principal: { userId: owner.id, isAdmin: false },
			blockId: task.blockId,
			baseVersionSeq: (await outlineStore.getBlock(task.blockId))?.versionSeq as number,
			assign: { kind: "narrator", narratorId: other },
		});
		const copyId = out.handedOut?.copy.id as string;
		const projectSpace = await ensureProjectSpace(projectId);
		const assigned = await readOutlineTeamMessages((await lastEvent(projectSpace.id)).event);
		expect(assigned).toEqual([expect.objectContaining({ narratorId: other, wake: false })]);
		expect(assigned[0]?.content).toContain(owner.username);

		// The other session does the copy (its steps first, then the copy itself).
		const copy = await outlineStore.getBlock(copyId);
		await asAgent(projectSpace, other, owner.id, [
			{
				op: "setTask",
				block: { id: copyId },
				task: { status: "done" },
				baseVersionSeq: copy?.versionSeq,
			},
		]);
		const told = await readOutlineTeamMessages((await lastEvent(projectSpace.id)).event);
		const row = told.find((m) => m.narratorId === main);
		expect(row).toMatchObject({ wake: true });
		expect(row?.taskIds).toContain(task.blockId);
	});

	test("the digest names who handed it out, and lists no system commit for it", async () => {
		const { owner, projectId, main, sessionSpace } = await world();
		const mate = await person("mate");
		await grant(projectId, mate.id, "write");
		const byPerson = await sessionTask(sessionSpace, main, owner.id);
		await handOutTask({ taskId: byPerson.blockId, by: person_(owner), target: { kind: "team" } });
		const bySession = await asAgent(sessionSpace, main, owner.id, [
			{ op: "insert", parent: null, content: "Second", task: { status: "todo" } },
		]);
		await handOutTask({
			taskId: bySession.results[0]?.blockId as string,
			by: { kind: "session", narratorId: main, principal: { userId: owner.id, isAdmin: false } },
			target: { kind: "person", userId: mate.id, username: mate.username },
		});
		const projectSpace = (await outlineStore.getSpace(
			(
				await ensureProjectSpace(projectId)
			).id,
		)) as OutlineSpaceRow;
		const summary = await summarizeSpaceWindow(
			outlineStore,
			projectSpace,
			0,
			projectSpace.nextSeq - 1,
		);
		expect(summary.tasksCreated).toBe(4);
		const created = summary.tasks.map((t) => t.by);
		expect(created).toContainEqual({ kind: "human", id: owner.id });
		expect(created).toContainEqual({ kind: "agent", id: main });
		expect(summary.other).toEqual([]);
	});
});
