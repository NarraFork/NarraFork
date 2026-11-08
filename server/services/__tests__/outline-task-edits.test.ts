/**
 * People's changes to a session's outline tasks reach the session (outline P2 PR 5, owner Q4 B):
 * structural changes from any interface (the board, the live editor: both are a person's commits),
 * not text edits; never as a person's message (review round 1, B1): a system notice that names who
 * changed what, kept apart per person (S1), merged per session; written for the next turn while
 * the session is idle, taken at the run's next tool boundary while it works. A person rejecting a
 * goal's completion is told the same way (S3). The behavior page's checkboxes are rules, not
 * tasks (S7). The session's board is told to read again on structural changes only (S5).
 *
 * The session runtime is a stand-in (a working loop cannot be started here); the outline writes,
 * the injection rows, the queue and the task backend are the real ones, on the isolated database
 * from `tests/preload.ts`.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";

let working = false;
const realSession = { ...(await import("../narrator-session")) };
mock.module("../narrator-session", () => ({
	...realSession,
	isLoopRunning: () => working,
}));

const broadcasts: Array<{ target: string; type: unknown }> = [];
const realWs = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	...realWs,
	broadcastToNarrator: (target: string, message: Record<string, unknown>) => {
		broadcasts.push({ target, type: message.type });
	},
}));

const { db } = await import("../../db");
const { aclGrants, narratorMessageRefs, narratorMessages, narrators, projects, users } =
	await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { settings } = await import("../../lib/settings");
const { canReadSpace, canWriteSpace } = await import("../outline/access");
const { ensureProjectSpace, ensureSessionSpace } = await import("../outline/spaces");
const { OUTLINE_BEHAVIOR_ALIAS } = await import("../outline/model");
const { writeOutline } = await import("../outline/write");
const { lockOutlineTask } = await import("../outline/pending");
const { getBufferedMessagesAsync } = await import("../narrator-buffer");
const { invalidateTaskBackend } = await import("../task-source");
const {
	flushOutlineTaskEdits,
	OUTLINE_TASK_EDIT_LIMITS,
	OUTLINE_TASK_EDIT_TIMING,
	resetOutlineTaskEditsForTests,
	settleOutlineTaskEditsForTests,
	takeOutlineTaskEditNotice,
} = await import("../outline-task-edits");

const NOW = "2026-11-03T00:00:00.000Z";

afterAll(() => {
	mock.restore();
});

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
	resetOutlineTaskEditsForTests();
	broadcasts.length = 0;
	working = false;
});

const usernames = new Map<string, string>();

async function person(prefix = "edits"): Promise<string> {
	const id = generateId();
	const username = `${prefix}${id.replace(/[^A-Za-z0-9]/g, "")}`;
	await db.insert(users).values({
		id,
		username,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	usernames.set(id, username);
	return id;
}

async function session(owner: string, backend: "spec" | "outline" = "outline"): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		ownerUserId: owner,
		taskBackend: backend,
		visibility: "private",
		status: "idle",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

/** The notices the session was left (injection rows of this producer). */
async function notes(
	narratorId: string,
): Promise<Array<{ role: string; createdBy: string | null; text: string }>> {
	const rows = await db
		.select({
			json: narratorMessages.contentJson,
			role: narratorMessages.role,
			createdBy: narratorMessages.createdBy,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId));
	return rows.flatMap((row) =>
		((row.json ?? []) as Array<Record<string, unknown>>)
			.filter((b) => b.type === "system_injection" && b.source === "outline_task_edit")
			.map((b) => ({ role: row.role, createdBy: row.createdBy, text: String(b.modelText) })),
	);
}

async function seed(narratorId: string, owner: string) {
	const space = await ensureSessionSpace(narratorId);
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Plan" },
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "Write the docs",
				task: { status: "todo" },
			},
			{ op: "insert", parent: { tempId: "p" }, content: "Tag the build", task: { status: "todo" } },
		],
		actor: { kind: "agent", id: narratorId },
		narratorId,
		responsibleUserId: owner,
	});
	await settleOutlineTaskEditsForTests();
	await Bun.sleep(OUTLINE_TASK_EDIT_TIMING.boardMs + 30);
	broadcasts.length = 0;
	return {
		space,
		page: written.results[0] as { blockId: string; sid: string },
		docs: written.results[1] as { blockId: string; sid: string },
		tag: written.results[2] as { blockId: string; sid: string },
	};
}

const byPerson = (userId: string) => ({
	actor: { kind: "human" as const, id: userId },
	responsibleUserId: userId,
});

async function boardRefreshes(narratorId: string): Promise<number> {
	await Bun.sleep(OUTLINE_TASK_EDIT_TIMING.boardMs + 50);
	return broadcasts.filter((b) => b.target === narratorId && b.type === "outline_tasks_changed")
		.length;
}

describe("a person's changes to a session's tasks", () => {
	test("idle: one system notice the next turn reads, naming the person and each task's address; no wake", async () => {
		const owner = await person();
		const id = await session(owner);
		const { space, docs, tag } = await seed(id, owner);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: docs.blockId }, task: { status: "done" } }],
			...byPerson(owner),
		});
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: tag.blockId }, task: { assignee: "human:pat" } }],
			...byPerson(owner),
		});
		await settleOutlineTaskEditsForTests();
		const [note, ...rest] = await notes(id);
		expect(rest).toEqual([]);
		// The system's, never the person's: not a user row, no creator.
		expect(note).toMatchObject({ role: "sys", createdBy: null });
		expect(note?.text).toStartWith(
			"System notice (not the user speaking): people changed tasks of this session in the interface.",
		);
		expect(note?.text).toContain(`${usernames.get(owner)}:\n`);
		expect(note?.text).toContain(`\`${space.key}/${docs.sid}\` Write the docs: set to done`);
		expect(note?.text).toContain(`\`${space.key}/${tag.sid}\` Tag the build: handed to @human:pat`);
		expect(await getBufferedMessagesAsync(id)).toEqual([]);
		// The board reads again.
		expect(await boardRefreshes(id)).toBeGreaterThan(0);
	});

	test("text edits are neither told nor refresh the board; a task reopened and a task added are told", async () => {
		const owner = await person();
		const id = await session(owner);
		const { space, docs, page } = await seed(id, owner);
		await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "update", block: { id: docs.blockId }, content: "Write the user docs" },
				{ op: "insert", parent: { id: page.blockId }, content: "A plain note" },
			],
			...byPerson(owner),
		});
		await settleOutlineTaskEditsForTests();
		expect(await notes(id)).toEqual([]);
		expect(await boardRefreshes(id)).toBe(0);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: docs.blockId }, task: { status: "done" } }],
			...byPerson(owner),
		});
		await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "setTask", block: { id: docs.blockId }, task: { status: "todo" } },
				{ op: "insert", parent: null, content: "Check the links", task: { status: "todo" } },
			],
			...byPerson(owner),
		});
		await settleOutlineTaskEditsForTests();
		const [note, ...rest] = await notes(id);
		expect(rest).toEqual([]);
		// Done then back to to-do within one notice: what the person did last.
		expect(note?.text).toContain("Write the user docs: reopened (back to to do)");
		expect(note?.text).toContain("Check the links: added");
	});

	test("working: nothing is written or queued; the run takes one notice at its next tool boundary", async () => {
		const owner = await person();
		const id = await session(owner);
		const { space, docs, tag } = await seed(id, owner);
		working = true;
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: docs.blockId }, task: { status: "cancelled" } }],
			...byPerson(owner),
		});
		await flushOutlineTaskEdits(id);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "delete", block: { id: tag.blockId } }],
			...byPerson(owner),
		});
		await flushOutlineTaskEdits(id);
		expect(await notes(id)).toEqual([]);
		expect(await getBufferedMessagesAsync(id)).toEqual([]);
		// One notice, listing both, in the run's language.
		const taken = await takeOutlineTaskEditNotice(id, "zh-CN");
		expect(taken?.content).toStartWith("系统通知（不是用户发言）");
		expect(taken?.content).toContain("Write the docs：改成取消");
		expect(taken?.content).toContain("Tag the build：删除");
		// The reader's copy of the same changes, structured: each task by address and title, who
		// changed it and what changed (the transcript draws links and status chips from it).
		expect(taken?.body).toEqual({
			kind: "outlineTasks",
			variant: "edited",
			items: [
				{
					address: `${space.key}/${docs.sid}`,
					title: "Write the docs",
					by: expect.any(String),
					changes: [{ kind: "status", from: "todo", to: "cancelled" }],
				},
				{
					address: `${space.key}/${tag.sid}`,
					title: "Tag the build",
					by: expect.any(String),
					changes: [{ kind: "deleted" }],
				},
			],
		});
		// Taken once.
		expect(await takeOutlineTaskEditNotice(id, "en")).toBeNull();
	});

	test("working: the run's tool-boundary drain delivers it as a system row and folds it into the turn", async () => {
		const owner = await person();
		const id = await session(owner);
		const { space, docs } = await seed(id, owner);
		working = true;
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: docs.blockId }, task: { status: "done" } }],
			...byPerson(owner),
		});
		await flushOutlineTaskEdits(id);
		const drained = await realSession.drainInjectionsIntoHistory(
			{ narratorId: id } as Parameters<typeof realSession.drainInjectionsIntoHistory>[0],
			"en",
		);
		expect(drained.text).toContain("Write the docs: set to done");
		const [note, ...rest] = await notes(id);
		expect(rest).toEqual([]);
		expect(note).toMatchObject({ role: "sys", createdBy: null });
		expect(drained.parts.at(-1)?.messageId).toBeString();
		// A subagent's drain does not take its session's notice.
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: docs.blockId }, task: { status: "todo" } }],
			...byPerson(owner),
		});
		await flushOutlineTaskEdits(id);
		const sub = await realSession.drainInjectionsIntoHistory(
			{ narratorId: id } as Parameters<typeof realSession.drainInjectionsIntoHistory>[0],
			"en",
			{ parentNarratorId: id, parentToolUseId: "toolu_x" },
		);
		expect(sub.text).not.toContain("Write the docs");
		expect(await takeOutlineTaskEditNotice(id, "en")).not.toBeNull();
	});

	test("working, then the run ends before a tool boundary: the notice is written for the next turn", async () => {
		const owner = await person();
		const id = await session(owner);
		const { space, docs } = await seed(id, owner);
		working = true;
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: docs.blockId }, task: { status: "done" } }],
			...byPerson(owner),
		});
		await flushOutlineTaskEdits(id);
		expect(await notes(id)).toEqual([]);
		working = false;
		await flushOutlineTaskEdits(id);
		const [note] = await notes(id);
		expect(note).toMatchObject({ role: "sys", createdBy: null });
		expect(note?.text).toContain("Write the docs: set to done");
		expect(await takeOutlineTaskEditNotice(id, "en")).toBeNull();
	});

	test("two people's changes: one notice per session, each person's lines under their own name", async () => {
		const owner = await person("own");
		const carol = await person("carol");
		const id = await session(owner);
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "narrator",
			scopeId: id,
			principalType: "user",
			principalId: carol,
			capability: "write",
			createdAt: NOW,
		});
		const { space, docs, tag } = await seed(id, owner);
		working = true;
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: docs.blockId }, task: { status: "cancelled" } }],
			...byPerson(owner),
		});
		await flushOutlineTaskEdits(id);
		await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "setTask", block: { id: tag.blockId }, task: { status: "cancelled" } },
				{ op: "setTask", block: { id: docs.blockId }, task: { status: "todo" } },
			],
			...byPerson(carol),
		});
		await flushOutlineTaskEdits(id);
		const taken = await takeOutlineTaskEditNotice(id, "en");
		const text = taken?.content ?? "";
		const ownerAt = text.indexOf(`${usernames.get(owner)}:\n`);
		const carolAt = text.indexOf(`${usernames.get(carol)}:\n`);
		expect(ownerAt).toBeGreaterThan(0);
		expect(carolAt).toBeGreaterThan(ownerAt);
		const ownerPart = text.slice(ownerAt, carolAt);
		const carolPart = text.slice(carolAt);
		expect(ownerPart).toContain("Write the docs: set to cancelled");
		expect(ownerPart).not.toContain("Tag the build");
		// Carol's reopening of the owner's cancelled task is hers, not merged into the owner's line.
		expect(carolPart).toContain("Tag the build: set to cancelled");
		expect(carolPart).toContain("Write the docs: reopened (back to to do)");
	});

	test("a project writer who cannot read the session: a system notice, never a message of theirs", async () => {
		const alice = await person("alice");
		const bob = await person("bob");
		const id = await session(alice);
		const projectId = generateId();
		await db.insert(projects).values({
			id: projectId,
			name: `p-${projectId}`,
			ownerUserId: alice,
			visibility: "private",
			createdAt: NOW,
			updatedAt: NOW,
		});
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId: bob,
			capability: "write",
			createdAt: NOW,
		});
		const projectSpace = await ensureProjectSpace(projectId);
		const sessionSpace = await ensureSessionSpace(id);
		expect(await canReadSpace({ userId: bob, isAdmin: false }, sessionSpace)).toBe(false);
		expect(await canWriteSpace({ userId: bob, isAdmin: false }, projectSpace)).toBe(true);
		// Alice's session takes up a project task.
		const written = await writeOutline({
			spaceId: projectSpace.id,
			ops: [{ op: "insert", parent: null, content: "Team task", task: { status: "doing" } }],
			actor: { kind: "agent", id },
			narratorId: id,
			responsibleUserId: alice,
		});
		await settleOutlineTaskEditsForTests();
		const taskId = written.results[0]?.blockId as string;
		await writeOutline({
			spaceId: projectSpace.id,
			ops: [{ op: "setTask", block: { id: taskId }, task: { status: "todo" } }],
			...byPerson(bob),
		});
		await settleOutlineTaskEditsForTests();
		const told = await notes(id);
		expect(told).toHaveLength(1);
		expect(told[0]).toMatchObject({ role: "sys", createdBy: null });
		expect(told[0]?.text).toContain(`${usernames.get(bob)}:\n`);
		expect(told[0]?.text).toContain("Team task: set to to do");
		// The session holding it reads its board again (its "claimed elsewhere" section).
		expect(await boardRefreshes(id)).toBeGreaterThan(0);

		// While Alice's session works: nothing queued as Bob, the run takes a system notice.
		working = true;
		await writeOutline({
			spaceId: projectSpace.id,
			ops: [{ op: "setTask", block: { id: taskId }, task: { status: "cancelled" } }],
			...byPerson(bob),
		});
		await flushOutlineTaskEdits(id);
		expect(await getBufferedMessagesAsync(id)).toEqual([]);
		const taken = await takeOutlineTaskEditNotice(id, "en");
		expect(taken?.content).toContain(`${usernames.get(bob)}:\n`);
		expect(taken?.content).toContain("Team task: set to cancelled");
		const rows = await db
			.select({ role: narratorMessages.role, createdBy: narratorMessages.createdBy })
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
			.where(eq(narratorMessageRefs.narratorId, id));
		expect(rows.filter((row) => row.createdBy === bob)).toEqual([]);
		expect(rows.filter((row) => row.role === "user")).toEqual([]);
	});

	test("checkboxes on the behavior page are rules: neither told nor refresh the board", async () => {
		const owner = await person();
		const id = await session(owner);
		const { space } = await seed(id, owner);
		const written = await writeOutline({
			spaceId: space.id,
			ops: [
				{
					op: "insert",
					tempId: "b",
					parent: null,
					content: "Behavior",
					alias: OUTLINE_BEHAVIOR_ALIAS,
				},
				{
					op: "insert",
					parent: { tempId: "b" },
					content: "Never push to main",
					task: { status: "todo" },
				},
			],
			...byPerson(owner),
		});
		await writeOutline({
			spaceId: space.id,
			ops: [
				{
					op: "setTask",
					block: { id: written.results[1]?.blockId as string },
					task: { status: "done" },
				},
			],
			...byPerson(owner),
		});
		await settleOutlineTaskEditsForTests();
		expect(await notes(id)).toEqual([]);
		expect(await boardRefreshes(id)).toBe(0);
	});

	test("the agent's own changes, and a spec session's, are not told", async () => {
		const owner = await person();
		const id = await session(owner);
		const { space, docs } = await seed(id, owner);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: docs.blockId }, task: { status: "done" } }],
			actor: { kind: "agent", id },
			narratorId: id,
			responsibleUserId: owner,
		});
		await settleOutlineTaskEditsForTests();
		expect(await notes(id)).toEqual([]);
		// Its board reads again all the same.
		expect(await boardRefreshes(id)).toBeGreaterThan(0);

		const spec = await session(owner, "spec");
		const specSpace = await ensureSessionSpace(spec);
		await writeOutline({
			spaceId: specSpace.id,
			ops: [{ op: "insert", parent: null, content: "A box", task: { status: "todo" } }],
			...byPerson(owner),
		});
		await settleOutlineTaskEditsForTests();
		expect(await notes(spec)).toEqual([]);
	});

	test("past the waiting cap the oldest changes go, and the notice still counts them", async () => {
		const owner = await person();
		const id = await session(owner);
		const space = await ensureSessionSpace(id);
		const limits = OUTLINE_TASK_EDIT_LIMITS as { queuedPerSession: number };
		const cap = limits.queuedPerSession;
		limits.queuedPerSession = 3;
		try {
			working = true;
			for (let i = 0; i < 5; i++) {
				await writeOutline({
					spaceId: space.id,
					ops: [{ op: "insert", parent: null, content: `Task ${i}`, task: { status: "todo" } }],
					...byPerson(owner),
				});
				await flushOutlineTaskEdits(id);
			}
			const taken = await takeOutlineTaskEditNotice(id, "en");
			// Three listed (the newest), two let go and counted.
			expect(taken?.content).toContain("Task 4: added");
			expect(taken?.content).not.toContain("Task 0: added");
			expect(taken?.content).toContain("2 more changes not listed.");
		} finally {
			limits.queuedPerSession = cap;
		}
	});

	test("a change held for confirmation on a project task refreshes the board of the session doing it", async () => {
		const owner = await person();
		const id = await session(owner);
		const projectId = generateId();
		await db.insert(projects).values({
			id: projectId,
			name: `p-${projectId}`,
			ownerUserId: owner,
			visibility: "private",
			createdAt: NOW,
			updatedAt: NOW,
		});
		const projectSpace = await ensureProjectSpace(projectId);
		const written = await writeOutline({
			spaceId: projectSpace.id,
			ops: [{ op: "insert", parent: null, content: "Team plan", task: { status: "todo" } }],
			...byPerson(owner),
		});
		const taskId = written.results[0]?.blockId as string;
		await lockOutlineTask({ blockId: taskId, userId: owner });
		const agent = {
			actor: { kind: "agent" as const, id },
			narratorId: id,
			responsibleUserId: owner,
		};
		// The session takes it up (its board refreshes for that), then rewrites the locked plan.
		await writeOutline({
			spaceId: projectSpace.id,
			ops: [{ op: "setTask", block: { id: taskId }, task: { status: "doing" } }],
			...agent,
		});
		await settleOutlineTaskEditsForTests();
		await Bun.sleep(OUTLINE_TASK_EDIT_TIMING.boardMs + 50);
		broadcasts.length = 0;
		const held = await writeOutline({
			spaceId: projectSpace.id,
			ops: [{ op: "update", block: { id: taskId }, content: "Team plan, rewritten" }],
			...agent,
		});
		expect(held.pending).toBeDefined();
		await settleOutlineTaskEditsForTests();
		expect(await boardRefreshes(id)).toBeGreaterThan(0);
	});
});
