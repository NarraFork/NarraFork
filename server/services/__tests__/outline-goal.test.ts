/**
 * `/goal` in a session whose tasks live in the outline (outline P2 PR 5): every behavior the
 * migration preserves (prototype `p/UMvz9lIu`, `p/6oehrsQz`), one test each, plus the outline's
 * own: the goal is a person-created task on the session space's task page, locked by the person
 * in the commit that creates it (D26b), and only the goal (and what the person wrote with it) is
 * the locked plan.
 *
 *   - dedupe by text;
 *   - it keeps its card;
 *   - it does not start in plan mode (written all the same);
 *   - `protectedOnly` runs while it is open, and stops once its completion only waits for the
 *     person;
 *   - the queue consumers run a queued `/goal` (the post-interrupt resume, the run's own consumer,
 *     whose first turn starts even when continuation is off), and the WebSocket ways in queue it;
 *   - an outline subagent has no tasks of its own: its `/goal` is refused before anything is saved.
 *
 * The idle start through the HTTP route (`startSpecContinuationIfPossible` with continuation off)
 * is `outline-goal-start.test.ts`, with a model stand-in.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 * `outline.enabled` is set before each case (the preload restores settings after it).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narratorMessageRefs, narratorMessages, narrators, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { handleNarratorWS } from "../../websocket/narrator-ws";
import * as inbox from "../agent-runtime/inbox";
import { startNarratorRun } from "../agent-runtime/run";
import {
	clearBufferedMessages,
	enqueueBufferedMessage,
	getBufferedMessagesAsync,
	updateBufferedMessage,
} from "../narrator-buffer";
import type { ExecuteLoopResult } from "../narrator-executor";
import * as executor from "../narrator-executor";
import { narratorService } from "../narrator-service";
import {
	executeQueuedGoalCommand,
	parseQueuedGoalCommand,
	resumeNextBufferedMessage,
} from "../narrator-session";
import { OUTLINE_TASKS_PAGE_ALIAS } from "../outline/person-tasks";
import { outlineStore } from "../outline/store";
import type { OutlineBlockRow } from "../outline/store/port";
import { writeOutline } from "../outline/write";
import {
	resetOutlineTaskEditsForTests,
	settleOutlineTaskEditsForTests,
} from "../outline-task-edits";
import { invalidateTaskBackend, taskSourceForNarrator } from "../task-source";

const NOW = "2026-11-03T00:00:00.000Z";

const restores: Array<() => void> = [];
beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
	resetOutlineTaskEditsForTests();
});
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

async function user(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `goal${id.replace(/[^A-Za-z0-9]/g, "")}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	return id;
}

async function session(
	options: {
		backend?: "spec" | "outline";
		status?: "idle" | "working";
		owner?: string;
		traits?: string[];
		continuation?: "off";
		subagentOf?: string;
	} = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: options.subagentOf ? "subagent" : "primary",
		variant: options.subagentOf ? "subagent" : "primary",
		parentNarratorId: options.subagentOf ?? null,
		aclRootNarratorId: options.subagentOf ?? null,
		traits: options.traits ?? ["standalone"],
		status: options.status ?? "idle",
		taskBackend: options.backend ?? "outline",
		ownerUserId: options.owner ?? null,
		autoContinuationOverride: options.continuation ?? "inherit",
		cwd: "/tmp",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function savedMessages(narratorId: string): Promise<string[]> {
	const rows = await db
		.select({ text: narratorMessages.contentText })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId));
	return rows.map((row) => row.text ?? "");
}

async function contentBlocks(narratorId: string): Promise<Array<Record<string, unknown>>> {
	const rows = await db
		.select({ json: narratorMessages.contentJson })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId));
	return rows.flatMap((row) => (row.json ?? []) as Array<Record<string, unknown>>);
}

async function queued(narratorId: string): Promise<string[]> {
	return (await getBufferedMessagesAsync(narratorId)).map((message) => message.text);
}

/** The session's task page and the blocks directly on it, in order. */
async function taskPage(narratorId: string): Promise<{ page: string; tasks: OutlineBlockRow[] }> {
	const space = await outlineStore.findSpace({ kind: "session", narratorId });
	if (!space) return { page: "", tasks: [] };
	const [owner] = await outlineStore.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
	if (!owner) return { page: "", tasks: [] };
	return { page: owner.id, tasks: await outlineStore.listChildren(space.id, owner.id, 50) };
}

/** Queue `/goal <text>` as `by` and run it the way the queue consumers do. */
async function runGoal(narratorId: string, text: string, by: string | null) {
	await enqueueBufferedMessage(narratorId, `/goal ${text}`, undefined, `/goal ${text}`, by);
	const [buffered] = await getBufferedMessagesAsync(narratorId);
	if (!buffered) throw new Error("expected a queued message");
	const goal = parseQueuedGoalCommand(buffered.text, buffered.commandText);
	expect(goal?.objective).toBe(text);
	return await executeQueuedGoalCommand(narratorId, buffered, goal?.objective ?? "");
}

describe("/goal in an outline session writes a locked, person-created task", () => {
	test("on the session's task page, to do, managed and locked by the person who sent it", async () => {
		const owner = await user();
		const id = await session({ owner });
		const outcome = await runGoal(id, "ship the release", owner);
		expect(outcome).toMatchObject({ refused: false, added: true, outline: { locked: true } });
		expect(await savedMessages(id)).toContain("/goal ship the release");
		const { tasks } = await taskPage(id);
		expect(tasks).toHaveLength(1);
		const task = tasks[0] as OutlineBlockRow;
		expect(task.content).toBe("ship the release");
		expect(task.taskJson).toMatchObject({
			status: "todo",
			humanCreated: true,
			manager: { kind: "human", id: owner },
			lock: { by: { kind: "human", id: owner }, delegate: null },
		});
		// Locked in the very commit that created it: the agent never reads the goal unlocked.
		expect(task.taskJson?.lock?.versionSeq).toBe(task.versionSeq);
		expect(task.authorKind).toBe("human");
		if (!outcome.refused) expect(outcome.outline?.address).toEndWith(`/${task.sid}`);
	});

	test("dedupe by text: the same goal again adds nothing; a cancelled one does not count", async () => {
		const owner = await user();
		const id = await session({ owner });
		await runGoal(id, "ship the release", owner);
		expect(await runGoal(id, "ship the release", owner)).toMatchObject({
			refused: false,
			added: false,
		});
		expect((await taskPage(id)).tasks).toHaveLength(1);
		// Whitespace does not make another goal.
		expect(await runGoal(id, "ship  the   release", owner)).toMatchObject({ added: false });
		const [first] = (await taskPage(id)).tasks;
		if (!first) throw new Error("expected the goal");
		await writeOutline({
			spaceId: first.spaceId,
			ops: [{ op: "setTask", block: { id: first.id }, task: { status: "cancelled" } }],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		expect(await runGoal(id, "ship the release", owner)).toMatchObject({ added: true });
		expect((await taskPage(id)).tasks).toHaveLength(2);
	});

	test("what the person wrote with it is locked; the steps the agent adds under it are not", async () => {
		const owner = await user();
		const id = await session({ owner });
		await runGoal(id, "Ship the release\n\nAcceptance: the smoke tests pass", owner);
		const [goal] = (await taskPage(id)).tasks;
		if (!goal) throw new Error("expected the goal");
		expect(goal.content).toBe("Ship the release");
		const [acceptance] = await outlineStore.listChildren(goal.spaceId, goal.id, 10);
		expect(acceptance?.content).toBe("Acceptance: the smoke tests pass");
		const agent = {
			actor: { kind: "agent" as const, id },
			narratorId: id,
			responsibleUserId: owner,
		};
		// The agent rewriting the acceptance waits for the person.
		const rewrite = await writeOutline({
			spaceId: goal.spaceId,
			ops: [{ op: "update", block: { id: acceptance?.id as string }, content: "Acceptance: none" }],
			...agent,
		});
		expect(rewrite.results[0]?.pending).toBe(true);
		expect(rewrite.pending?.decider.by).toEqual({ kind: "human", id: owner });
		// A step under the goal is written directly, and later changes to it too.
		const step = await writeOutline({
			spaceId: goal.spaceId,
			ops: [
				{
					op: "insert",
					parent: { id: goal.id },
					content: "tag the build",
					task: { status: "todo" },
				},
			],
			...agent,
		});
		expect(step.results[0]?.pending).toBeUndefined();
		const stepId = step.results[0]?.blockId as string;
		const reworded = await writeOutline({
			spaceId: goal.spaceId,
			ops: [{ op: "update", block: { id: stepId }, content: "tag and sign the build" }],
			...agent,
		});
		expect(reworded.results[0]?.pending).toBeUndefined();
	});

	test("it keeps its card: added, then already there", async () => {
		const owner = await user();
		const id = await session({ owner });
		await runGoal(id, "ship the release", owner);
		await runGoal(id, "ship the release", owner);
		const cards = (await contentBlocks(id)).filter((block) => block.type === "spec_goal_added");
		expect(cards).toHaveLength(2);
		const added = cards.find((card) => card.added === true);
		expect(added).toMatchObject({ task: "ship the release", taskBackend: "outline", locked: true });
		expect(String(added?.ref)).toMatch(/\/[A-Za-z0-9_-]+$/);
		expect(cards.find((card) => card.added === false)).toMatchObject({
			task: "ship the release",
			taskBackend: "outline",
		});
	});

	test("its commit leaves no note about a person changing the tasks: the message says it", async () => {
		const owner = await user();
		const id = await session({ owner });
		await runGoal(id, "ship the release", owner);
		await settleOutlineTaskEditsForTests();
		const notes = (await contentBlocks(id)).filter(
			(block) => block.type === "system_injection" && block.source === "outline_task_edit",
		);
		expect(notes).toEqual([]);
	});

	test("protectedOnly runs while it is open, and stops once its completion only waits for the person", async () => {
		const owner = await user();
		const id = await session({ owner });
		await runGoal(id, "ship the release", owner);
		const source = await taskSourceForNarrator(id);
		expect(await source.protectedOpenCount()).toBe(1);
		const target = await source.prepareContinuation({ promoteTodo: true });
		expect(target).toMatchObject({
			protectedOpenCount: 1,
			openTask: { status: "doing", protected: true },
		});
		const [goal] = (await taskPage(id)).tasks;
		if (!goal) throw new Error("expected the goal");
		// The agent ticks the whole goal done: held for the person who locked it (D26b).
		const done = await writeOutline({
			spaceId: goal.spaceId,
			ops: [{ op: "setTask", block: { id: goal.id }, task: { status: "done" } }],
			actor: { kind: "agent", id },
			narratorId: id,
			responsibleUserId: owner,
		});
		expect(done.results[0]?.pending).toBe(true);
		expect(await source.protectedOpenCount()).toBe(0);
		expect(await source.awaitingConfirmation?.()).toBe(1);
		expect((await source.prepareContinuation({ promoteTodo: true })).protectedOpenCount).toBe(0);
	});
});

describe("the queue consumers run it", () => {
	test("the post-interrupt resume runs it, does not start in plan mode, and drains on", async () => {
		const owner = await user();
		const id = await session({ owner, status: "working", traits: ["standalone", "plan"] });
		await enqueueBufferedMessage(id, "/goal ship it", undefined, "/goal ship it", owner);
		await enqueueBufferedMessage(id, "and then this");
		const wake = spyOn(inbox, "wakeInboxIfEligible").mockResolvedValue(undefined as never);
		restores.push(() => wake.mockRestore());
		await resumeNextBufferedMessage({ narratorId: id, locale: "en" } as never, "en");
		for (let i = 0; i < 100 && wake.mock.calls.length === 0; i++)
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(await savedMessages(id)).toContain("/goal ship it");
		// Written, not started: plan mode never starts a goal's first turn.
		const { tasks } = await taskPage(id);
		expect(tasks.map((t) => t.taskJson?.status)).toEqual(["todo"]);
		expect(await queued(id)).toEqual(["and then this"]);
		expect(wake).toHaveBeenCalledWith(id, "en");
		expect((await narratorService.getById(id)).substatus).not.toContain("error");
		// Nothing of this case may run on into the next one.
		await clearBufferedMessages(id);
	});

	test("the run's own consumer runs it: its first turn starts even when continuation is off", async () => {
		const owner = await user();
		const id = await session({ owner, continuation: "off" });
		await db
			.update(narrators)
			.set({ model: "outlinegoaltest:claude-sonnet-4" })
			.where(eq(narrators.id, id));
		settings.anthropicProviders = [
			{
				id: "outline-goal-test",
				name: "Outline goal test",
				prefix: "outlinegoaltest",
				apiKey: "test-only",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "claude-sonnet-4",
			},
		];
		let passes = 0;
		const model = spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
			// Only this session's passes count.
			if (options.config.narratorId === id) passes++;
			// Queued while the session works.
			if (passes === 1)
				await enqueueBufferedMessage(id, "/goal ship it", undefined, "/goal ship it", owner);
			const result: ExecuteLoopResult = {
				finalText: "done",
				hasError: false,
				shouldUpdateTitle: false,
				hadToolUses: false,
				completedNaturally: true,
			};
			return result;
		});
		restores.push(() => model.mockRestore());
		const run = await startNarratorRun({
			narratorId: id,
			text: "start",
			locale: "en",
			principal: owner,
			foreground: true,
		});
		expect((await run.terminal).hasError).toBe(false);
		// The first pass, then exactly one more for the goal: continuation is off.
		expect(passes).toBe(2);
		expect(await savedMessages(id)).toContain("/goal ship it");
		const [goal] = (await taskPage(id)).tasks;
		// The goal's first turn took it up: in progress, held by the session.
		expect(goal?.taskJson?.status).toBe("doing");
		// The continuation names it (the outline prompt, with its address).
		const continuation = (await contentBlocks(id)).find(
			(block) => block.type === "spec_continuation",
		);
		expect(String(continuation?.modelText)).toContain(`/${goal?.sid}`);
		expect(String(continuation?.modelText)).toContain("[set by a person]");
		expect(await queued(id)).toEqual([]);
	});

	test("an outline subagent's /goal is refused before anything is saved", async () => {
		const owner = await user();
		const root = await session({ owner });
		const sub = await session({ owner, subagentOf: root });
		expect(await runGoal(sub, "ship it", owner)).toEqual({ refused: true });
		expect(await savedMessages(sub)).toEqual([]);
		expect(await queued(sub)).toEqual([]);
		expect((await taskPage(root)).tasks).toEqual([]);
	});

	test("a spec session's queued /goal still runs as before", async () => {
		const id = await session({ backend: "spec" });
		await enqueueBufferedMessage(id, "/goal ship it", undefined, "/goal ship it");
		const [buffered] = await getBufferedMessagesAsync(id);
		if (!buffered) throw new Error("expected a queued message");
		expect(await executeQueuedGoalCommand(id, buffered, "ship it")).toEqual({
			refused: false,
			added: true,
		});
		expect(await savedMessages(id)).toContain("/goal ship it");
		const card = (await contentBlocks(id)).find((block) => block.type === "spec_goal_added");
		expect(card).toEqual({
			type: "spec_goal_added",
			task: "ship it",
			added: true,
			protected: true,
		});
	});

	test("a row edited into something else before it is run is not taken as a goal", async () => {
		const owner = await user();
		const id = await session({ owner, backend: "outline" });
		await enqueueBufferedMessage(id, "/goal ship it", undefined, null, owner);
		const [read] = await getBufferedMessagesAsync(id);
		if (!read) throw new Error("expected a queued message");
		expect(await updateBufferedMessage(id, read.id, "fix the build instead")).toBe(true);
		const [left] = await getBufferedMessagesAsync(id);
		expect(parseQueuedGoalCommand(left?.text ?? "", left?.commandText)).toBeNull();
	});
});

describe("the WebSocket ways in", () => {
	function openWs(userId: string) {
		const sent: Array<Record<string, unknown>> = [];
		const ws = {
			data: {
				channel: "narrator" as const,
				connectedAt: Date.now(),
				lastPongAt: Date.now(),
				subscribedNarrators: new Set<string>(),
				catchingUpNarrators: new Map(),
				catchUpBuffers: new Map(),
				userId,
				userRole: "user",
			},
			send(payload: string) {
				sent.push(JSON.parse(payload) as Record<string, unknown>);
			},
		} as unknown as Parameters<typeof handleNarratorWS.open>[0];
		handleNarratorWS.open(ws);
		restores.push(() => handleNarratorWS.close(ws));
		return { ws, sent };
	}

	test("buffer_message and update_buffer queue /goal for an outline session", async () => {
		const owner = await user();
		const id = await session({ owner, status: "working" });
		const { ws } = openWs(owner);
		await handleNarratorWS.message(ws, {
			type: "buffer_message",
			narratorId: id,
			text: "/goal ship it",
		});
		expect(await queued(id)).toEqual(["/goal ship it"]);
		const plain = await enqueueBufferedMessage(id, "fix the build");
		await handleNarratorWS.message(ws, {
			type: "update_buffer",
			narratorId: id,
			messageId: plain.id,
			text: "/goal ship the docs",
		});
		expect(await queued(id)).toEqual(["/goal ship it", "/goal ship the docs"]);
	});

	test("an outline subagent's /goal is refused and the queue left as it was", async () => {
		const owner = await user();
		const root = await session({ owner });
		const sub = await session({ owner, subagentOf: root, status: "working" });
		const { ws, sent } = openWs(owner);
		await handleNarratorWS.message(ws, {
			type: "buffer_message",
			narratorId: sub,
			text: "/goal ship it",
		});
		expect(await queued(sub)).toEqual([]);
		expect(
			sent.some((frame) => frame.type === "error" && String(frame.message).includes("/goal")),
		).toBe(true);
	});
});
