/**
 * A session is told when tasks it created are finished elsewhere (outline P2 PR 9b, design §2.7):
 * which commits count, who is told and who is not, the per-commit limit, the message and its body,
 * the delivery (a `sys` row under an id derived from the commit, waking the session when idle;
 * nothing written twice; no chosen id and no wake on PostgreSQL), and the listener.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 * The wake goes through the injection scheduler seam; nothing runs a model.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
	userPreferences,
	users,
} from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import * as injection from "../../narrator-injection";
import { type InjectionScheduler, setInjectionScheduler } from "../../narrator-injection";
import * as refsStore from "../../narrator-refs/store";
import { invalidateTaskBackend } from "../../task-source";
import { ensureProjectSpace, ensureSessionSpace } from "../spaces";
import {
	deliverOutlineTaskFinished,
	OUTLINE_TASK_FINISHED_LIMITS,
	OUTLINE_TASK_FINISHED_SOURCE,
	type OutlineCommitEvent,
	type OutlineTaskFinishedMessage,
	outlineTaskFinishedInjection,
	outlineTaskFinishedMessageId,
	readOutlineTaskFinishedMessages,
	setOutlineTaskFinishedDelivery,
	settleOutlineTaskFinishedForTests,
	shareOutNames,
	startOutlineTaskFinishedNotices,
} from "../task-finished";
import { type OutlineOp, type OutlineWriteResult, writeOutline } from "../write";

const NOW = "2026-11-06T00:00:00.000Z";

let wakes: string[] = [];
let previousScheduler: InjectionScheduler | null = null;

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
	wakes = [];
	previousScheduler = setInjectionScheduler({
		requestSoftStop: () => false,
		wakeIfIdle: async (narratorId) => {
			wakes.push(narratorId);
			return { started: true };
		},
	});
});

afterEach(() => {
	setInjectionScheduler(previousScheduler);
	setOutlineTaskFinishedDelivery(null);
});

const usernames = new Map<string, string>();

async function person(): Promise<string> {
	const id = generateId();
	const username = `fin${id.replace(/[^A-Za-z0-9]/g, "")}`;
	await db.insert(users).values({ id, username, passwordHash: "x", role: "user", createdAt: NOW });
	usernames.set(id, username);
	return id;
}

async function session(
	owner: string,
	options: { title?: string; backend?: "spec" | "outline"; status?: "idle" | "archived" } = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: options.title ?? "Session",
		ownerUserId: owner,
		taskBackend: options.backend ?? "outline",
		visibility: "private",
		status: options.status ?? "idle",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function subagentOf(root: string, owner: string): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "subagent",
		title: "Helper",
		ownerUserId: owner,
		parentNarratorId: root,
		aclRootNarratorId: root,
		taskBackend: "outline",
		status: "idle",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function project(owner: string): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `fin-${id}`,
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

const asAgent = (narratorId: string, owner: string) => ({
	actor: { kind: "agent" as const, id: narratorId },
	narratorId,
	responsibleUserId: owner,
});
const asPerson = (userId: string) => ({
	actor: { kind: "human" as const, id: userId },
	responsibleUserId: userId,
});

type Written = OutlineWriteResult & { actor: { kind: "agent" | "human"; id: string } };

async function write(
	spaceId: string,
	who: ReturnType<typeof asAgent> | ReturnType<typeof asPerson>,
	ops: OutlineOp[],
): Promise<Written> {
	return { ...(await writeOutline({ spaceId, ops, ...who })), actor: who.actor };
}

/** The `outline:committed` event of a write, as the write path emits it. */
const eventOf = (result: Written): OutlineCommitEvent => {
	const commit = result.commit;
	if (!commit) throw new Error("nothing committed");
	return {
		spaceId: result.spaceId,
		commitId: commit.id,
		seq: commit.seq,
		actorKind: result.actor.kind,
		actorId: result.actor.id,
	};
};

/** Tasks written by `who` under a new page of `spaceId`: their results, in order. */
async function tasks(
	spaceId: string,
	who: ReturnType<typeof asAgent> | ReturnType<typeof asPerson>,
	titles: readonly string[],
	status: "todo" | "doing" = "todo",
) {
	const written = await write(spaceId, who, [
		{ op: "insert", tempId: "page", parent: null, content: "Work" },
		...titles.map(
			(title, index): OutlineOp => ({
				op: "insert",
				tempId: `t${index}`,
				parent: { tempId: "page" },
				content: title,
				task: { status },
			}),
		),
	]);
	return written.results.slice(1).map((r) => {
		if (!r) throw new Error("seed failed");
		return r;
	});
}

const finish = (ids: readonly string[], status: "done" | "cancelled" = "done"): OutlineOp[] =>
	ids.map((id) => ({ op: "setTask", block: { id }, task: { status } }));

/** The rows of this producer in a session. */
async function notices(narratorId: string) {
	const rows = await db
		.select({
			id: narratorMessages.id,
			json: narratorMessages.contentJson,
			role: narratorMessages.role,
			createdBy: narratorMessages.createdBy,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId));
	return rows.flatMap((row) =>
		((row.json ?? []) as Array<Record<string, unknown>>)
			.filter((b) => b.type === "system_injection" && b.source === OUTLINE_TASK_FINISHED_SOURCE)
			.map((b) => ({
				id: row.id,
				role: row.role,
				createdBy: row.createdBy,
				text: String(b.modelText),
				body: b.body as Record<string, unknown>,
			})),
	);
}

/** Capture what would be delivered, writing nothing. */
function capture(): OutlineTaskFinishedMessage[] {
	const sent: OutlineTaskFinishedMessage[] = [];
	setOutlineTaskFinishedDelivery({
		async deliver(message) {
			sent.push(message);
			return { written: true, woke: false };
		},
	});
	return sent;
}

describe("who is told", () => {
	test("another session ticks a task done: its creator is told once, as a system row that wakes it; delivering the commit again writes and wakes nothing", async () => {
		const owner = await person();
		const creator = await session(owner, { title: "Planner" });
		const doer = await session(owner, { title: "Worker" });
		const space = await ensureSessionSpace(doer);
		const [task, other] = await tasks(space.id, asAgent(creator, owner), [
			"Fix the refresh race",
			"Write the docs",
		]);
		if (!task || !other) throw new Error("seed");
		const done = await write(space.id, asAgent(doer, owner), finish([task.blockId]));
		const event = eventOf(done);

		const first = await deliverOutlineTaskFinished(event);
		expect(first).toEqual({ told: [creator], woke: 1 });
		const [note, ...rest] = await notices(creator);
		expect(rest).toEqual([]);
		expect(note).toMatchObject({ role: "sys", createdBy: null });
		expect(note?.id).toBe(outlineTaskFinishedMessageId(event, creator, [task.blockId]));
		expect(note?.text).toBe(
			`System notice (not the user speaking): tasks this session created in the outline were finished elsewhere.\n\n- \`${task.address}\` Fix the refresh race: ticked done by session "Worker"\n\nThe results and any reports are under each task; read them with OutlineRead. If one does not meet what you wanted, reopen it (set it to do).`,
		);
		expect(note?.body).toEqual({
			kind: "outlineTasks",
			variant: "finished",
			items: [
				{
					address: task.address,
					title: "Fix the refresh race",
					// The reader's card names the session by its title, in no language.
					by: "Worker",
					changes: [{ kind: "status", from: "todo", to: "done" }],
				},
			],
		});
		expect(wakes).toEqual([creator]);
		// The finisher hears nothing of its own commit.
		expect(await notices(doer)).toEqual([]);

		// A retry (the same commit delivered again): nothing written, nothing woken.
		const again = await deliverOutlineTaskFinished(event);
		expect(again).toEqual({ told: [creator], woke: 0 });
		expect(await notices(creator)).toHaveLength(1);
		expect(wakes).toEqual([creator]);
	});

	test("in the creator's language (its owner's), done and cancelled", async () => {
		const owner = await person();
		await db.insert(userPreferences).values({
			id: generateId(),
			userId: owner,
			language: "zh-CN",
			createdAt: NOW,
			updatedAt: NOW,
		});
		const creator = await session(owner, { title: "规划" });
		const doer = await session(owner, { title: "执行" });
		const space = await ensureSessionSpace(doer);
		const [a, b] = await tasks(space.id, asAgent(creator, owner), ["改刷新逻辑", "写文档"]);
		if (!a || !b) throw new Error("seed");
		const sent = capture();
		const done = await write(space.id, asAgent(doer, owner), [
			...finish([a.blockId]),
			...finish([b.blockId], "cancelled"),
		]);
		await deliverOutlineTaskFinished(eventOf(done));
		expect(sent).toHaveLength(1);
		expect(sent[0]?.locale).toBe("zh-CN");
		// Lines by block id (the order the commit's versions are read in).
		const lines = [
			[a.blockId, `- \`${a.address}\` 改刷新逻辑：已被会话「执行」勾成完成`],
			[b.blockId, `- \`${b.address}\` 写文档：已被会话「执行」取消`],
		]
			.sort(([x], [y]) => ((x as string) < (y as string) ? -1 : 1))
			.map(([, line]) => line);
		expect(sent[0]?.content).toBe(
			`系统通知（不是用户发言）：本会话在大纲里建的任务在别处结束了。\n\n${lines.join("\n")}\n\n结果和报告在各自的任务下面，用 OutlineRead 读；不满意可以重开（设回待办）。`,
		);
	});

	test("the same session tree: finished by the creator itself, by its subagent, or a subagent's task by its root: nobody is told", async () => {
		const owner = await person();
		const root = await session(owner);
		const helper = await subagentOf(root, owner);
		const space = await ensureSessionSpace(root);
		const [own, viaHelper] = await tasks(space.id, asAgent(root, owner), ["Own", "Via helper"]);
		const [helpers] = await tasks(space.id, asAgent(helper, owner), ["Helper's own"]);
		if (!own || !viaHelper || !helpers) throw new Error("seed");
		const sent = capture();
		for (const [who, id] of [
			[asAgent(root, owner), own.blockId],
			[asAgent(helper, owner), viaHelper.blockId],
			[asAgent(root, owner), helpers.blockId],
		] as const) {
			await deliverOutlineTaskFinished(eventOf(await write(space.id, who, finish([id]))));
		}
		expect(sent).toEqual([]);
	});

	test("a subagent's task finished by another session: its root is told", async () => {
		const owner = await person();
		const root = await session(owner);
		const helper = await subagentOf(root, owner);
		const doer = await session(owner, { title: "Worker" });
		const space = await ensureSessionSpace(doer);
		const [task] = await tasks(space.id, asAgent(helper, owner), ["Helper wrote this"]);
		if (!task) throw new Error("seed");
		const sent = capture();
		await deliverOutlineTaskFinished(
			eventOf(await write(space.id, asAgent(doer, owner), finish([task.blockId]))),
		);
		expect(sent.map((m) => m.narratorId)).toEqual([root]);
	});

	test("a person manages the task: no message (the report and the board tell them)", async () => {
		const owner = await person();
		const doer = await session(owner);
		const space = await ensureSessionSpace(doer);
		const [task] = await tasks(space.id, asPerson(owner), ["The person's goal"]);
		if (!task) throw new Error("seed");
		const sent = capture();
		await deliverOutlineTaskFinished(
			eventOf(await write(space.id, asAgent(doer, owner), finish([task.blockId]))),
		);
		expect(sent).toEqual([]);
	});

	test("an archived creator, or one whose tasks are not in the outline, is not told", async () => {
		const owner = await person();
		const archived = await session(owner, { status: "archived" });
		const spec = await session(owner, { backend: "spec" });
		const doer = await session(owner);
		const space = await ensureSessionSpace(doer);
		const [a] = await tasks(space.id, asAgent(archived, owner), ["A"]);
		const [b] = await tasks(space.id, asAgent(spec, owner), ["B"]);
		if (!a || !b) throw new Error("seed");
		const sent = capture();
		await deliverOutlineTaskFinished(
			eventOf(await write(space.id, asAgent(doer, owner), finish([a.blockId, b.blockId]))),
		);
		expect(sent).toEqual([]);
	});

	test("only tasks finished in the commit: already finished, reopened, created finished, deleted, or a text edit tell nobody", async () => {
		const owner = await person();
		const creator = await session(owner);
		const doer = await session(owner);
		const space = await ensureSessionSpace(doer);
		const [a, b] = await tasks(space.id, asAgent(creator, owner), ["A", "B"]);
		if (!a || !b) throw new Error("seed");
		await write(space.id, asAgent(doer, owner), finish([a.blockId]));
		const sent = capture();
		const cases: OutlineOp[][] = [
			// A done task edited (text, due date) stays done: not finished in this commit.
			[{ op: "update", block: { id: a.blockId }, content: "A, reworded" }],
			[{ op: "setTask", block: { id: a.blockId }, task: { due: "2026-12-01" } }],
			// Reopened.
			[{ op: "setTask", block: { id: a.blockId }, task: { status: "todo" } }],
			// Deleted.
			[{ op: "delete", block: { id: b.blockId } }],
		];
		for (const ops of cases) {
			const event = eventOf(await write(space.id, asAgent(doer, owner), ops));
			expect(await readOutlineTaskFinishedMessages(event)).toEqual([]);
			await deliverOutlineTaskFinished(event);
		}
		expect(sent).toEqual([]);
	});
});

describe("a person's commit", () => {
	test("in the creator's own session space PR 5 tells it already: no second message", async () => {
		const owner = await person();
		const creator = await session(owner);
		const space = await ensureSessionSpace(creator);
		const [task] = await tasks(space.id, asAgent(creator, owner), ["Mine"]);
		if (!task) throw new Error("seed");
		const sent = capture();
		await deliverOutlineTaskFinished(
			eventOf(await write(space.id, asPerson(owner), finish([task.blockId]))),
		);
		expect(sent).toEqual([]);
	});

	test("in a project, a task another session holds: the creator is told, naming the person", async () => {
		const owner = await person();
		const creator = await session(owner, { title: "Planner" });
		const holder = await session(owner, { title: "Worker" });
		const space = await ensureProjectSpace(await project(owner));
		const [task] = await tasks(space.id, asAgent(creator, owner), ["Ship it"]);
		if (!task) throw new Error("seed");
		await write(space.id, asAgent(holder, owner), [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } },
		]);
		const sent = capture();
		await deliverOutlineTaskFinished(
			eventOf(await write(space.id, asPerson(owner), finish([task.blockId]))),
		);
		expect(sent.map((m) => m.narratorId)).toEqual([creator]);
		expect(sent[0]?.content).toContain(
			`\`${task.address}\` Ship it: ticked done by ${usernames.get(owner)}`,
		);
		expect(sent[0]?.body).toMatchObject({
			items: [
				{ by: usernames.get(owner), changes: [{ kind: "status", from: "doing", to: "done" }] },
			],
		});
		// A person tidying up never costs a request: written for the next turn, not woken.
		expect(sent[0]?.wake).toBe(false);
	});

	test("the real delivery of a person's commit writes the row and wakes nobody", async () => {
		const owner = await person();
		const creator = await session(owner, { title: "Planner" });
		const holder = await session(owner, { title: "Worker" });
		const space = await ensureProjectSpace(await project(owner));
		const [task] = await tasks(space.id, asAgent(creator, owner), ["Ship it"]);
		if (!task) throw new Error("seed");
		await write(space.id, asAgent(holder, owner), [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } },
		]);
		const result = await deliverOutlineTaskFinished(
			eventOf(await write(space.id, asPerson(owner), finish([task.blockId]))),
		);
		expect(result).toEqual({ told: [creator], woke: 0 });
		expect(await notices(creator)).toHaveLength(1);
		expect(wakes).toEqual([]);
	});
});

describe("limits", () => {
	test(`at most ${OUTLINE_TASK_FINISHED_LIMITS.listedPerCommit} tasks named per commit; the rest counted in their creator's message`, async () => {
		const owner = await person();
		const first = await session(owner, { title: "First" });
		const second = await session(owner, { title: "Second" });
		const doer = await session(owner, { title: "Worker" });
		const space = await ensureSessionSpace(doer);
		const mine = await tasks(
			space.id,
			asAgent(first, owner),
			Array.from({ length: 15 }, (_, i) => `First ${i + 1}`),
		);
		const theirs = await tasks(
			space.id,
			asAgent(second, owner),
			Array.from({ length: 10 }, (_, i) => `Second ${i + 1}`),
		);
		const sent = capture();
		const done = await write(
			space.id,
			asAgent(doer, owner),
			finish([...mine, ...theirs].map((t) => t.blockId)),
		);
		await deliverOutlineTaskFinished(eventOf(done));
		const byTarget = new Map(sent.map((m) => [m.narratorId, m]));
		expect([...byTarget.keys()].sort()).toEqual([first, second].sort());
		const a = byTarget.get(first);
		const b = byTarget.get(second);
		expect(a?.body).toMatchObject({ kind: "outlineTasks", variant: "finished" });
		const items = (m: OutlineTaskFinishedMessage | undefined) =>
			m?.body.kind === "outlineTasks" ? m.body.items.length : -1;
		const more = (m: OutlineTaskFinishedMessage | undefined) =>
			m?.body.kind === "outlineTasks" ? (m.body.more ?? 0) : -1;
		// Named across both messages (block id order): 20 in all, the other 5 counted.
		expect(items(a) + items(b)).toBe(20);
		expect(more(a) + more(b)).toBe(5);
		expect(a?.taskIds).toHaveLength(15);
		expect(b?.taskIds).toHaveLength(10);
		// Shared out in turn: the second session's ten are all named, the first's other five are
		// counted in its own message.
		expect([items(a), more(a), items(b), more(b)]).toEqual([10, 5, 10, 0]);
		expect(a?.content).toContain(
			"- 5 more tasks this session created were finished in the same change (not listed).",
		);
		expect(a?.messageId).not.toBe(b?.messageId);
	});

	test("every session told has a task named and is woken, however many another has", async () => {
		const owner = await person();
		const big = await session(owner, { title: "Big" });
		const small = await session(owner, { title: "Small" });
		const doer = await session(owner, { title: "Worker" });
		const space = await ensureSessionSpace(doer);
		const many = await tasks(
			space.id,
			asAgent(big, owner),
			Array.from({ length: 25 }, (_, i) => `Big ${i + 1}`),
		);
		const few = await tasks(space.id, asAgent(small, owner), ["Small 1", "Small 2"]);
		const sent = capture();
		await deliverOutlineTaskFinished(
			eventOf(
				await write(
					space.id,
					asAgent(doer, owner),
					finish([...many, ...few].map((t) => t.blockId)),
				),
			),
		);
		const named = (id: string) => {
			const body = sent.find((m) => m.narratorId === id)?.body;
			return body?.kind === "outlineTasks" ? [body.items.length, body.more ?? 0] : null;
		};
		expect(named(big)).toEqual([18, 7]);
		expect(named(small)).toEqual([2, 0]);
		expect(sent.every((m) => m.wake)).toBe(true);
	});

	test(`at most ${OUTLINE_TASK_FINISHED_LIMITS.sessionsPerCommit} sessions told per commit; each names a task`, async () => {
		const owner = await person();
		const doer = await session(owner, { title: "Worker" });
		const space = await ensureSessionSpace(doer);
		const creators: string[] = [];
		const ids: string[] = [];
		for (let i = 0; i < OUTLINE_TASK_FINISHED_LIMITS.sessionsPerCommit + 1; i++) {
			const creator = await session(owner, { title: `Creator ${i}` });
			creators.push(creator);
			const [task] = await tasks(space.id, asAgent(creator, owner), [`Task ${i}`]);
			ids.push((task as { blockId: string }).blockId);
		}
		const sent = capture();
		await deliverOutlineTaskFinished(
			eventOf(await write(space.id, asAgent(doer, owner), finish(ids))),
		);
		expect(sent).toHaveLength(OUTLINE_TASK_FINISHED_LIMITS.sessionsPerCommit);
		for (const message of sent)
			expect(message.body.kind === "outlineTasks" && message.body.items.length).toBe(1);
	});

	test("every session told has a task named, so none is woken for nothing", () => {
		// Names are shared out in turn and no more sessions are told than there are names: a
		// message that names nothing (and the guard that keeps it from waking) cannot happen.
		expect(OUTLINE_TASK_FINISHED_LIMITS.sessionsPerCommit).toBeLessThanOrEqual(
			OUTLINE_TASK_FINISHED_LIMITS.listedPerCommit,
		);
		const counts = Array.from({ length: OUTLINE_TASK_FINISHED_LIMITS.sessionsPerCommit }, () => 9);
		expect(
			shareOutNames(counts, OUTLINE_TASK_FINISHED_LIMITS.listedPerCommit).every((n) => n > 0),
		).toBe(true);
	});

	test("shareOutNames: in turn, at least one each while names last", () => {
		expect(shareOutNames([25, 2], 20)).toEqual([18, 2]);
		expect(shareOutNames([15, 10], 20)).toEqual([10, 10]);
		expect(shareOutNames([1, 1, 1], 2)).toEqual([1, 1, 0]);
		expect(shareOutNames([3], 20)).toEqual([3]);
		expect(shareOutNames([], 20)).toEqual([]);
	});
});

describe("delivery", () => {
	test("PostgreSQL: no chosen id and no wake; SQLite: the derived id and a wake when idle", async () => {
		const message: OutlineTaskFinishedMessage = {
			narratorId: "n1",
			messageId: "m1",
			locale: "en",
			content: "System notice",
			body: { kind: "outlineTasks", variant: "finished", items: [] },
			taskIds: ["t1"],
			wake: true,
		};
		expect(outlineTaskFinishedInjection(message, true)).toEqual({
			content: "System notice",
			body: message.body,
			source: "outline_task_finished",
			role: "sys",
			schedule: "none",
			locale: "en",
		});
		expect(outlineTaskFinishedInjection(message, false)).toMatchObject({
			messageId: "m1",
			role: "sys",
			schedule: "wakeIfIdle",
		});
		// A message that does not wake (a person's commit) is written for the next turn.
		expect(outlineTaskFinishedInjection({ ...message, wake: false }, false)).toMatchObject({
			messageId: "m1",
			schedule: "none",
		});
	});

	test("the real delivery on PostgreSQL writes through deliverInjection with schedule none", async () => {
		const owner = await person();
		const creator = await session(owner);
		const doer = await session(owner);
		const space = await ensureSessionSpace(doer);
		const [task] = await tasks(space.id, asAgent(creator, owner), ["On PostgreSQL"]);
		if (!task) throw new Error("seed");
		const port = spyOn(refsStore, "getNarratorMessageRefsPort").mockReturnValue(
			{} as ReturnType<typeof refsStore.getNarratorMessageRefsPort>,
		);
		const deliver = spyOn(injection, "deliverInjection").mockResolvedValue({
			messageId: "pg-row",
			turnText: null,
			started: false,
			interjected: false,
		});
		try {
			const result = await deliverOutlineTaskFinished(
				eventOf(await write(space.id, asAgent(doer, owner), finish([task.blockId]))),
			);
			expect(result).toEqual({ told: [creator], woke: 0 });
			expect(deliver).toHaveBeenCalledTimes(1);
			const [target, options] = deliver.mock.calls[0] ?? [];
			expect(target).toBe(creator);
			expect(options).toMatchObject({ schedule: "none", role: "sys" });
			expect(options).not.toHaveProperty("messageId");
		} finally {
			port.mockRestore();
			deliver.mockRestore();
		}
		expect(wakes).toEqual([]);
	});

	test("one session failing does not keep the others from being told", async () => {
		const owner = await person();
		const a = await session(owner);
		const b = await session(owner);
		const doer = await session(owner);
		const space = await ensureSessionSpace(doer);
		const [ta] = await tasks(space.id, asAgent(a, owner), ["A"]);
		const [tb] = await tasks(space.id, asAgent(b, owner), ["B"]);
		if (!ta || !tb) throw new Error("seed");
		const sent: string[] = [];
		setOutlineTaskFinishedDelivery({
			async deliver(message) {
				if (message.narratorId === a) throw new Error("busy");
				sent.push(message.narratorId);
				return { written: true, woke: false };
			},
		});
		const result = await deliverOutlineTaskFinished(
			eventOf(await write(space.id, asAgent(doer, owner), finish([ta.blockId, tb.blockId]))),
		);
		expect(result.told).toEqual([b]);
		expect(sent).toEqual([b]);
	});
});

describe("the listener", () => {
	test("hears commits once started, and nothing while the outline is switched off", async () => {
		startOutlineTaskFinishedNotices();
		startOutlineTaskFinishedNotices();
		const owner = await person();
		const creator = await session(owner);
		const doer = await session(owner);
		const space = await ensureSessionSpace(doer);
		const [a, b] = await tasks(space.id, asAgent(creator, owner), ["A", "B"]);
		if (!a || !b) throw new Error("seed");
		const sent = capture();
		await write(space.id, asAgent(doer, owner), finish([a.blockId]));
		await settleOutlineTaskFinishedForTests();
		expect(sent.map((m) => m.narratorId)).toEqual([creator]);

		settings.outline.enabled = false;
		try {
			await write(space.id, asAgent(doer, owner), finish([b.blockId]));
			await settleOutlineTaskFinishedForTests();
			expect(sent).toHaveLength(1);
		} finally {
			settings.outline.enabled = true;
		}
	});
});
