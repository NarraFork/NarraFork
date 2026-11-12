/**
 * The session that created a task is told when the session it was delegated in finishes it
 * (outline P2 PR 9b; PR 9 design §2.7 and §7 acceptance case 5), end to end: the real Agent tool,
 * subagent runner, run service, report attachment, write path and the `outline:committed`
 * listener, with the real injection delivery on SQLite (the wake through the scheduler seam).
 * Only the model pass is scripted.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { readTestMessageContent } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { narratorMessageRefs, narratorMessages } from "../../db/schema";
import { type InjectionScheduler, setInjectionScheduler } from "../narrator-injection";
import { ensureSessionSpace } from "../outline/spaces";
import {
	deliverOutlineTaskFinished,
	OUTLINE_TASK_FINISHED_SOURCE,
	settleOutlineTaskFinishedForTests,
	startOutlineTaskFinishedNotices,
} from "../outline/task-finished";
import {
	agent,
	claimOf,
	installDelegationHarness,
	model,
	REPORT,
	rootSession,
	runEnded,
	until,
	user,
	write,
} from "./outline-delegation.fixture";

installDelegationHarness();

let wakes: string[] = [];
let previous: InjectionScheduler | null = null;

beforeEach(() => {
	startOutlineTaskFinishedNotices();
	wakes = [];
	previous = setInjectionScheduler({
		requestSoftStop: () => false,
		wakeIfIdle: async (narratorId) => {
			wakes.push(narratorId);
			return { started: false };
		},
	});
});

afterEach(() => {
	setInjectionScheduler(previous);
});

async function notices(narratorId: string) {
	const rows = await db
		.select({ id: narratorMessages.id })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId));
	return rows.flatMap((row) =>
		readTestMessageContent(sqlite, row.id)
			.filter((b) => b.type === "system_injection" && b.source === OUTLINE_TASK_FINISHED_SOURCE)
			.map((b) => ({ id: row.id, text: String(b.modelText) })),
	);
}

describe("a delegated task its creator did not do", () => {
	test("delegated, reported, ticked done by the delegating session: the creating session is told once, nobody else", async () => {
		const owner = await user();
		const root = await rootSession(owner, { title: "Worker" });
		const planner = await rootSession(owner, { title: "Planner" });
		// The planner set the task (it manages it); the worker takes it up and delegates it.
		const space = await ensureSessionSpace(root);
		const seeded = await write(space.id, planner, owner, [
			{ op: "insert", tempId: "page", parent: null, content: "Auth work" },
			{
				op: "insert",
				parent: { tempId: "page" },
				content: "Fix the refresh race",
				task: { status: "todo" },
			},
		]);
		const task = seeded.results[1];
		if (!task) throw new Error("seed");
		model.script = [{ text: REPORT }];
		const { result, childId } = await agent(root, owner, { task: task.address });
		expect(result.isError).toBeFalsy();
		if (!childId) throw new Error("no subagent");
		await until(() => runEnded(childId), "the subagent's run to end");
		expect(result.output).toContain('status="current"');
		expect(await claimOf(task.blockId)).toMatchObject({ holderNarratorId: root, epoch: 1 });
		// Delegating and attaching the report finish nothing: nobody is told yet.
		await settleOutlineTaskFinishedForTests();
		expect(await notices(planner)).toEqual([]);

		const done = await write(space.id, root, owner, [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "done" } },
		]);
		await settleOutlineTaskFinishedForTests();
		const [note, ...rest] = await notices(planner);
		expect(rest).toEqual([]);
		expect(note?.text).toContain(
			`- \`${task.address}\` Fix the refresh race: ticked done by session "Worker"`,
		);
		expect(wakes).toEqual([planner]);
		// The session that finished it, and its subagent, are not told.
		expect(await notices(root)).toEqual([]);
		expect(await notices(childId)).toEqual([]);

		// The same commit delivered again (a retry): one row still, no second wake.
		const commit = done.commit;
		if (!commit) throw new Error("no commit");
		await deliverOutlineTaskFinished({
			spaceId: done.spaceId,
			commitId: commit.id,
			seq: commit.seq,
			actorKind: "agent",
			actorId: root,
		});
		expect(await notices(planner)).toHaveLength(1);
		expect(wakes).toEqual([planner]);
	});

	test("a task the delegating session created itself: ticking it done after the report tells nobody", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const space = await ensureSessionSpace(root);
		const seeded = await write(space.id, root, owner, [
			{ op: "insert", tempId: "page", parent: null, content: "Work" },
			{ op: "insert", parent: { tempId: "page" }, content: "Own task", task: { status: "todo" } },
		]);
		const task = seeded.results[1];
		if (!task) throw new Error("seed");
		model.script = [{ text: "Done: changed auth.ts:42." }];
		const { childId } = await agent(root, owner, { task: task.address });
		if (!childId) throw new Error("no subagent");
		await until(() => runEnded(childId), "the subagent's run to end");
		await write(space.id, root, owner, [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "done" } },
		]);
		await settleOutlineTaskFinishedForTests();
		expect(await notices(root)).toEqual([]);
		expect(wakes).toEqual([]);
	});
});
