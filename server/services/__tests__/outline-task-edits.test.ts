/**
 * A person's changes to a session's outline tasks reach the session (outline P2 PR 5, owner Q4 B):
 * structural changes from any interface (the board, the live editor: both are a person's commits),
 * not text edits; merged into one note; a cut-in user message while the session works (the way
 * `server/routes/spec.ts` does it), a user injection the next turn reads while it is idle. The
 * session's board is told to read again.
 *
 * The session runtime and its queue are stand-ins (a working loop cannot be started here); the
 * outline writes, the injection rows and the task backend are the real ones, on the isolated
 * database from `tests/preload.ts`.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";

interface FakeBuffered {
	id: string;
	text: string;
}
let queue: FakeBuffered[] = [];
let nextId = 1;
const realBuffer = { ...(await import("../narrator-buffer")) };
mock.module("../narrator-buffer", () => ({
	...realBuffer,
	pushBufferedMessage: async (_id: string, text: string, ...rest: unknown[]) => {
		const position = rest[5];
		const entry = { id: `buf-${nextId++}`, text };
		if (position === "front") queue.unshift(entry);
		else queue.push(entry);
		return { ok: true, bufferedAt: new Date().toISOString(), id: entry.id };
	},
	updateBufferedMessage: async (_id: string, messageId: string, text: string) => {
		const entry = queue.find((m) => m.id === messageId);
		if (!entry) return false;
		entry.text = text;
		return true;
	},
	getBufferedMessages: () => queue,
	toBufferSummary: (items: readonly FakeBuffered[]) => items,
}));

let working = false;
const softStops: string[] = [];
const realSession = { ...(await import("../narrator-session")) };
mock.module("../narrator-session", () => ({
	...realSession,
	isLoopRunning: () => working,
	requestBufferedMessageSoftStop: (narratorId: string) => {
		softStops.push(narratorId);
		return true;
	},
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
const { narratorMessageRefs, narratorMessages, narrators, users } = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { settings } = await import("../../lib/settings");
const { ensureProjectSpace, ensureSessionSpace } = await import("../outline/spaces");
const { writeOutline } = await import("../outline/write");
const { invalidateTaskBackend } = await import("../task-source");
const {
	flushOutlineTaskEdits,
	OUTLINE_TASK_EDIT_TIMING,
	resetOutlineTaskEditsForTests,
	settleOutlineTaskEditsForTests,
} = await import("../outline-task-edits");

const NOW = "2026-11-03T00:00:00.000Z";

afterAll(() => {
	mock.restore();
});

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
	resetOutlineTaskEditsForTests();
	queue = [];
	softStops.length = 0;
	broadcasts.length = 0;
	working = false;
});

async function person(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `edits${id.replace(/[^A-Za-z0-9]/g, "")}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	return id;
}

async function session(owner: string, backend: "spec" | "outline" = "outline"): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		ownerUserId: owner,
		taskBackend: backend,
		status: "idle",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

/** The notes the session was left (injection rows of this producer), model text only. */
async function notes(narratorId: string): Promise<string[]> {
	const rows = await db
		.select({ json: narratorMessages.contentJson, role: narratorMessages.role })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId));
	return rows.flatMap((row) =>
		((row.json ?? []) as Array<Record<string, unknown>>)
			.filter((b) => b.type === "system_injection" && b.source === "outline_task_edit")
			.map((b) => `${row.role}:${String(b.modelText)}`),
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
	broadcasts.length = 0;
	return {
		space,
		docs: written.results[1] as { blockId: string; sid: string },
		tag: written.results[2] as { blockId: string; sid: string },
	};
}

const byPerson = (owner: string) => ({
	actor: { kind: "human" as const, id: owner },
	responsibleUserId: owner,
});

describe("a person's changes to a session's tasks", () => {
	test("idle: one user note the next turn reads, with each task's address; no wake", async () => {
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
		expect(note).toStartWith("user:I changed tasks of this session in the interface:");
		expect(note).toContain(`\`${space.key}/${docs.sid}\` Write the docs: set to done`);
		expect(note).toContain(`\`${space.key}/${tag.sid}\` Tag the build: handed to @human:pat`);
		expect(queue).toEqual([]);
		expect(softStops).toEqual([]);
		// The board reads again.
		await Bun.sleep(OUTLINE_TASK_EDIT_TIMING.boardMs + 50);
		expect(broadcasts).toContainEqual({ target: id, type: "outline_tasks_changed" });
	});

	test("text edits are not told; a task reopened and a task added are", async () => {
		const owner = await person();
		const id = await session(owner);
		const { space, docs } = await seed(id, owner);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "update", block: { id: docs.blockId }, content: "Write the user docs" }],
			...byPerson(owner),
		});
		await settleOutlineTaskEditsForTests();
		expect(await notes(id)).toEqual([]);
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
		const [note] = await notes(id);
		// Done then back to to-do within one note: what the person did last.
		expect(note).toContain("Write the user docs: reopened (back to to do)");
		expect(note).toContain("Check the links: added");
	});

	test("working: a cut-in user message with a soft stop, later changes merged into it", async () => {
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
		expect(queue).toHaveLength(1);
		expect(queue[0]?.text).toContain("Write the docs: set to cancelled");
		expect(softStops).toEqual([id]);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "delete", block: { id: tag.blockId } }],
			...byPerson(owner),
		});
		await flushOutlineTaskEdits(id);
		// Still one message, now listing both.
		expect(queue).toHaveLength(1);
		expect(queue[0]?.text).toContain("Write the docs: set to cancelled");
		expect(queue[0]?.text).toContain("Tag the build: deleted");
		expect(await notes(id)).toEqual([]);
	});

	test("a task of a project: the session doing it is told", async () => {
		const owner = await person();
		const id = await session(owner);
		const project = generateId();
		const { projects } = await import("../../db/schema");
		await db
			.insert(projects)
			.values({ id: project, name: `edits-${project}`, createdAt: NOW, updatedAt: NOW });
		const space = await ensureProjectSpace(project);
		const written = await writeOutline({
			spaceId: space.id,
			ops: [{ op: "insert", parent: null, content: "Team task", task: { status: "doing" } }],
			actor: { kind: "agent", id },
			narratorId: id,
			responsibleUserId: owner,
		});
		await writeOutline({
			spaceId: space.id,
			ops: [
				{
					op: "setTask",
					block: { id: written.results[0]?.blockId as string },
					task: { status: "todo" },
				},
			],
			...byPerson(owner),
		});
		await settleOutlineTaskEditsForTests();
		const [note] = await notes(id);
		expect(note).toContain("Team task: set to to do");
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
});
