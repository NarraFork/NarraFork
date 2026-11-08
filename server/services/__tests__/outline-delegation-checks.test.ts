/**
 * Delegation as a task (outline P2 PR 9a), the parts around the acceptance: every refusal of
 * `Agent({ task })` (and that it creates nothing), the instructions written from the task tree
 * and their bounds, plans and plan mode, the write path's delegation claim and claim
 * expectations, the lease, continuation while a subagent has the task, a takeover landing between
 * the attachment's read and its write, and the registration field.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { backgroundTasks, narrators, outlineTaskClaims } from "../../db/schema";
import { askTool } from "../../lib/agent/tools/outline";
import type { ToolContext } from "../../lib/agent/types";
import { settings } from "../../lib/settings";
import {
	parseRuntimeRegistration,
	readRuntimeRegistrationColumn,
	registerRun,
} from "../../lib/validators/runtime-registration";
import * as runModule from "../agent-runtime/run";
import { narratorService } from "../narrator-service";
import {
	attachDelegatedReport,
	classifyDelegatedResult,
	OUTLINE_DELEGATION_LIMITS,
	renderDelegationBrief,
	startingDelegationCount,
	stripDelegationNote,
	withDelegationNote,
} from "../outline/delegation";
import {
	OutlineClaimChangedError,
	OutlineTaskClaimedError,
	OutlineWriteError,
} from "../outline/errors";
import { OUTLINE_TASK_IDLE_LEASE_MS, OUTLINE_TASK_LEASE } from "../outline/model";
import { lockOutlineTask } from "../outline/pending";
import { ensureSessionSpace } from "../outline/spaces";
import { outlineStore } from "../outline/store";
import type { OutlineStore, OutlineTaskClaimRow } from "../outline/store/port";
import { findContinuationCandidates, renewOutlineTaskLeases } from "../outline/tasks";
import * as writeModule from "../outline/write";
import { writeOutline } from "../outline/write";
import { archiveRetiredSubagents, interruptAndArchiveSubagent } from "../subagent-lifecycle";
import {
	agent,
	blockOf,
	children,
	claimOf,
	firstUserMessage,
	gate,
	installDelegationHarness,
	model,
	rootSession,
	runEnded,
	seedTask,
	taskResult,
	treeUnder,
	until,
	user,
	write,
} from "./outline-delegation.fixture";

installDelegationHarness();

/** `Agent({ task })` refused with `text`, and nothing created or changed. */
async function refused(
	root: string,
	owner: string | null,
	args: Record<string, unknown>,
	text: string,
	watch?: string,
) {
	const before = watch ? await claimOf(watch) : null;
	const { result } = await agent(root, owner, args);
	expect(result.isError).toBe(true);
	expect(result.output).toContain("Agent task error:");
	expect(result.output).toContain(text);
	expect(result.output).toContain("No agent was started.");
	expect(await children(root)).toEqual([]);
	if (watch) expect(JSON.stringify(await claimOf(watch))).toBe(JSON.stringify(before));
	return result.output;
}

function ctxFor(narratorId: string, userId: string): ToolContext {
	return {
		narratorId,
		cwd: "/",
		signal: new AbortController().signal,
		locale: "en",
		userId,
		requestPermission: async () => ({ behavior: "allow" }),
	} as unknown as ToolContext;
}

describe("Agent({ task }): every refusal, and nothing is created", () => {
	test("a spec session, or the outline switched off", async () => {
		const owner = await user();
		const spec = await rootSession(owner, { backend: "spec" });
		await refused(
			spec,
			owner,
			{ task: "anything" },
			"only available in sessions whose tasks live in the outline",
		);
		const root = await rootSession(owner);
		const { task } = await seedTask(root, owner);
		settings.outline.enabled = false;
		await refused(
			root,
			owner,
			{ task: task.address },
			"only available in sessions whose tasks live in the outline",
			task.blockId,
		);
	});

	test("plan mode, and with takeover_by_user", async () => {
		const owner = await user();
		const planning = await rootSession(owner, { traits: ["standalone", "plan"] });
		const seeded = await seedTask(planning, owner);
		await refused(
			planning,
			owner,
			{ task: seeded.task.address },
			"this session is in plan mode",
			seeded.task.blockId,
		);
		const root = await rootSession(owner);
		const { task } = await seedTask(root, owner);
		await refused(
			root,
			owner,
			{ task: task.address, takeover_by_user: true },
			"cannot be combined with takeover_by_user",
			task.blockId,
		);
	});

	test("not found, not readable, ambiguous, not a task, deleted, finished", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task, step } = await seedTask(root, owner);
		await refused(
			root,
			owner,
			{ task: "No such task anywhere" },
			"matches no task this session can read",
		);
		// Another session's notes are not this session's to read (D9): not found, nothing more.
		const other = await rootSession(await user("eve"));
		const theirs = await seedTask(other, owner, "Their own task");
		await refused(
			root,
			owner,
			{ task: theirs.task.address },
			"matches no task this session can read",
			theirs.task.blockId,
		);
		await seedTask(root, owner);
		await refused(root, owner, { task: "Fix the refresh race" }, "matches several blocks");
		const note = (await treeUnder(space.id, task.blockId))[0] as string;
		const plain = (await outlineStore.listChildren(space.id, task.blockId, 10)).find(
			(b) => b.content === note,
		);
		await refused(
			root,
			owner,
			{ task: `${space.key}/${plain?.sid}` },
			"is not a task (it has no checkbox)",
		);
		await write(space.id, root, owner, [
			{ op: "setTask", block: { id: step.blockId }, task: { status: "done" } },
		]);
		await refused(
			root,
			owner,
			{ task: step.address },
			"is done; reopen it (set it to do) before delegating it",
		);
		await write(space.id, root, owner, [
			{ op: "setTask", block: { id: step.blockId }, task: { status: "cancelled" } },
		]);
		await refused(root, owner, { task: step.address }, "is cancelled; reopen it");
		await write(space.id, root, owner, [{ op: "delete", block: { id: step.blockId } }]);
		await refused(root, owner, { task: step.address }, "is deleted");
	});

	test("a turn with no person behind it may not write the task's space", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { task } = await seedTask(root, owner);
		await refused(
			root,
			null,
			{ task: task.address },
			"this turn may not write the space",
			task.blockId,
		);
	});

	test("in a plan not approved yet", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const space = await ensureSessionSpace(root);
		const r = await write(space.id, root, owner, [
			{
				op: "insert",
				tempId: "plan",
				parent: null,
				content: "Ship the importer",
				task: { status: "todo" },
			},
			{
				op: "insert",
				parent: { tempId: "plan" },
				content: "Read the format",
				task: { status: "todo" },
			},
		]);
		await writeOutline({
			spaceId: space.id,
			ops: [
				{
					op: "setTask",
					block: { id: r.results[0]?.blockId as string },
					task: { plan: { state: "planning", by: root, round: 0, baseSeq: 0 } },
				},
			],
			actor: { kind: "system", id: "outline-plan" },
			responsibleUserId: owner,
			narratorId: root,
		});
		await refused(
			root,
			owner,
			{ task: r.results[1]?.address },
			"is part of a plan that is not approved yet",
			r.results[1]?.blockId,
		);
	});

	test("waiting: for a prerequisite, for an answer, for a confirmation", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const space = await ensureSessionSpace(root);
		const r = await write(space.id, root, owner, [
			{
				op: "insert",
				tempId: "first",
				parent: null,
				content: "Collect the data",
				task: { status: "todo" },
			},
		]);
		const first = r.results[0];
		const second = (
			await write(space.id, root, owner, [
				{
					op: "insert",
					parent: null,
					content: "Analyse the data",
					task: { status: "todo", depends: [{ target: first?.address as string, label: null }] },
				},
			])
		).results[0];
		await refused(
			root,
			owner,
			{ task: second?.address },
			`waits for its prerequisites (${first?.address})`,
		);

		const { task } = await seedTask(root, owner, "Pick a format");
		const asked = await askTool.execute(
			{ under: task.address, questions: [{ question: "CSV or JSON?", recommend: "JSON" }] },
			ctxFor(root, owner),
		);
		expect(asked.isError).toBeFalsy();
		await refused(
			root,
			owner,
			{ task: task.address },
			"waits for an answer to a question under it",
		);

		const locked = await seedTask(root, owner, "Parse the header");
		await lockOutlineTask({ blockId: locked.task.blockId, userId: owner });
		const held = await write(space.id, root, owner, [
			{ op: "update", block: { id: locked.task.blockId }, content: "Parse the header fast" },
		]);
		expect(held.pending).toBeDefined();
		await refused(
			root,
			owner,
			{ task: locked.task.address },
			"waits for a change to its plan to be confirmed",
		);
	});

	test("assigned to a person; done by another session, or by a person", async () => {
		const owner = await user("carol");
		const root = await rootSession(owner);
		const other = await rootSession(owner, { title: "Other session" });
		const space = await ensureSessionSpace(root);
		const assigned = (
			await write(space.id, root, owner, [
				{
					op: "insert",
					parent: null,
					content: "Sign the contract",
					task: { status: "todo", assignee: "human:carol" },
				},
			])
		).results[0];
		await refused(
			root,
			owner,
			{ task: assigned?.address },
			"is assigned to a person (@human:carol)",
		);

		const { task } = await seedTask(root, owner);
		await write(space.id, other, owner, [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } },
		]);
		await refused(
			root,
			owner,
			{ task: task.address },
			'is being done by the session "Other session"',
			task.blockId,
		);

		const mine = await seedTask(root, owner, "Review the copy");
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: mine.task.blockId }, task: { status: "doing" } }],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		await refused(
			root,
			owner,
			{ task: mine.task.address },
			"is being done by carol-",
			mine.task.blockId,
		);
	});
});

describe("a refusal once the agent exists", () => {
	test("the task taken between the check and the delegation's commit: refused, the new agent archived, never run", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const other = await rootSession(owner, { title: "Quick session" });
		const { space, task } = await seedTask(root, owner);
		const create = narratorService.createSubagent.bind(narratorService);
		const spy = spyOn(narratorService, "createSubagent").mockImplementation(async (input) => {
			const created = await create(input);
			await write(space.id, other, owner, [
				{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } },
			]);
			return created;
		});
		try {
			const { result, childId } = await agent(root, owner, {
				task: task.address,
				run_in_background: true,
			});
			expect(result.isError).toBe(true);
			expect(result.output).toContain('is being done by the session "Quick session"');
			expect(result.output).not.toContain("Subagent error");
			const child = await db.query.narrators.findFirst({
				where: eq(narrators.id, childId as string),
			});
			expect(child?.status).toBe("archived");
			expect(
				readRuntimeRegistrationColumn(child?.runtimeRegistrationJson)?.delegatedTask,
			).toBeUndefined();
			expect(model.passes).not.toContain(childId);
			expect(await claimOf(task.blockId)).toMatchObject({ holderNarratorId: other, epoch: 1 });
		} finally {
			spy.mockRestore();
		}
	});
});

/** Spy on subagent creation to change the outline in the window after the checks. */
function inTheWindow(
	change: (input: Parameters<typeof narratorService.createSubagent>[0]) => Promise<void>,
) {
	const create = narratorService.createSubagent.bind(narratorService);
	return spyOn(narratorService, "createSubagent").mockImplementation(async (input) => {
		const created = await create(input);
		await change(input);
		return created;
	});
}

async function archived(childId: string | null) {
	const row = await db.query.narrators.findFirst({ where: eq(narrators.id, childId as string) });
	expect(row?.status).toBe("archived");
	expect(
		readRuntimeRegistrationColumn(row?.runtimeRegistrationJson)?.delegatedTask,
	).toBeUndefined();
	expect(model.passes).not.toContain(childId);
}

describe("the window between the checks and the delegation's commit (review S1, N4)", () => {
	test("a person cancels the task: refused, the cancel stands", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		const spy = inTheWindow(async () => {
			await writeOutline({
				spaceId: space.id,
				ops: [{ op: "setTask", block: { id: task.blockId }, task: { status: "cancelled" } }],
				actor: { kind: "human", id: owner },
				responsibleUserId: owner,
			});
		});
		try {
			const { result, childId } = await agent(root, owner, { task: task.address });
			expect(result.isError).toBe(true);
			expect(result.output).toContain("changed while it was being delegated");
			expect((await blockOf(task.blockId)).taskJson?.status).toBe("cancelled");
			expect(await claimOf(task.blockId)).toBeNull();
			await archived(childId);
		} finally {
			spy.mockRestore();
		}
	});

	test("the session ticks it done from to do: refused, it stays done", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		const spy = inTheWindow(async () => {
			await write(space.id, root, owner, [
				{ op: "setTask", block: { id: task.blockId }, task: { status: "done" } },
			]);
		});
		try {
			const { result, childId } = await agent(root, owner, { task: task.address });
			expect(result.isError).toBe(true);
			expect(result.output).toContain("changed while it was being delegated");
			expect((await blockOf(task.blockId)).taskJson?.status).toBe("done");
			await archived(childId);
		} finally {
			spy.mockRestore();
		}
	});

	test("a person reassigns it to someone: refused, the assignment stands", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		const spy = inTheWindow(async () => {
			await writeOutline({
				spaceId: space.id,
				ops: [{ op: "setTask", block: { id: task.blockId }, task: { assignee: "human:x" } }],
				actor: { kind: "human", id: owner },
				responsibleUserId: owner,
			});
		});
		try {
			const { result, childId } = await agent(root, owner, { task: task.address });
			expect(result.isError).toBe(true);
			expect(result.output).toContain("changed while it was being delegated");
			const block = await blockOf(task.blockId);
			expect(block.taskJson).toMatchObject({ status: "todo", assignee: "human:x" });
			expect(await claimOf(task.blockId)).toBeNull();
			await archived(childId);
		} finally {
			spy.mockRestore();
		}
	});

	test("a sibling Agent call checking after the commit, before the first run starts: refused (review S4)", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { task } = await seedTask(root, owner);
		const persist = narratorService.persistSubagentUserMessage.bind(narratorService);
		let sibling: Awaited<ReturnType<typeof agent>> | null = null;
		const spy = spyOn(narratorService, "persistSubagentUserMessage").mockImplementation(
			async (...args) => {
				// The first delegation has committed and not started its run yet.
				if (!sibling)
					sibling = await agent(root, owner, { task: task.address, run_in_background: true });
				return await persist(...args);
			},
		);
		const open = gate();
		model.script = [{ text: "the only report", gate: open.promise }];
		try {
			const first = await agent(root, owner, { task: task.address, run_in_background: true });
			expect(first.result.isError).toBeFalsy();
			const second = sibling as unknown as Awaited<ReturnType<typeof agent>>;
			expect(second.result.isError).toBe(true);
			expect(second.result.output).toContain("which is still running");
			expect(second.childId).toBeNull();
			expect(await claimOf(task.blockId)).toMatchObject({
				holderNarratorId: first.childId,
				epoch: 1,
			});
			const sub = first.childId as string;
			await until(() => model.passes.includes(sub), "the first agent's pass");
			open.resolve();
			expect(await taskResult(sub)).toContain('status="current"');
			expect(model.passes.filter((id) => id !== sub)).toEqual([]);
		} finally {
			open.resolve();
			spy.mockRestore();
		}
	});

	test("another Agent call of the session took it first: the refusal says so", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		const create = narratorService.createSubagent.bind(narratorService);
		let sibling: string | null = null;
		const spy = spyOn(narratorService, "createSubagent").mockImplementation(async (input) => {
			const created = await create(input);
			if (!sibling) {
				sibling = (await create({ ...input, title: "Sibling agent" })).id;
				await writeOutline(
					{
						spaceId: space.id,
						ops: [{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } }],
						actor: { kind: "system", id: "outline-delegate" },
						responsibleUserId: owner,
						narratorId: root,
					},
					{ delegateClaim: { blockId: task.blockId, holderNarratorId: sibling, epoch: 1 } },
				);
			}
			return created;
		});
		try {
			const { result, childId } = await agent(root, owner, { task: task.address });
			expect(result.isError).toBe(true);
			expect(result.output).toContain('was just handed to the session "Sibling agent"');
			expect(result.output).toContain("by another Agent call of this session");
			expect(await claimOf(task.blockId)).toMatchObject({ holderNarratorId: sibling, epoch: 1 });
			await archived(childId);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("the in-flight mark (review round 3)", () => {
	test("set from the commit until the run starts, and cleared on every way out: refused, undone, background start, foreground start", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		expect(startingDelegationCount()).toBe(0);

		// Refused commit: the task was taken in the window.
		const other = await rootSession(owner, { title: "Other" });
		const refusedTask = await seedTask(root, owner, "Refused task");
		const create = inTheWindow(async () => {
			await write(refusedTask.space.id, other, owner, [
				{ op: "setTask", block: { id: refusedTask.task.blockId }, task: { status: "doing" } },
			]);
		});
		try {
			expect((await agent(root, owner, { task: refusedTask.task.address })).result.isError).toBe(
				true,
			);
		} finally {
			create.mockRestore();
		}
		expect(startingDelegationCount()).toBe(0);

		// Undone: the Agent call failed after the commit.
		const undoneTask = await seedTask(root, owner, "Undone task");
		const failing = spyOn(narratorService, "persistSubagentUserMessage").mockRejectedValueOnce(
			new Error("simulated write failure"),
		);
		try {
			expect((await agent(root, owner, { task: undoneTask.task.address })).result.isError).toBe(
				true,
			);
		} finally {
			failing.mockRestore();
		}
		expect(startingDelegationCount()).toBe(0);

		// Background start: marked in the window, cleared once its run started (it still runs).
		const bgTask = await seedTask(root, owner, "Background task");
		const persist = narratorService.persistSubagentUserMessage.bind(narratorService);
		let inWindow = -1;
		const watching = spyOn(narratorService, "persistSubagentUserMessage").mockImplementation(
			async (...args) => {
				inWindow = startingDelegationCount();
				return await persist(...args);
			},
		);
		const open = gate();
		model.script = [{ text: "background report", gate: open.promise }];
		try {
			const bg = await agent(root, owner, { task: bgTask.task.address, run_in_background: true });
			expect(inWindow).toBe(1);
			expect(startingDelegationCount()).toBe(0);
			const sub = bg.childId as string;
			await until(() => model.passes.includes(sub), "the background pass");
			expect(runEnded(sub)).toBe(false);
			open.resolve();
			await taskResult(sub);

			// Foreground start: marked in the window, cleared once its run started.
			inWindow = -1;
			const fgTask = await seedTask(root, owner, "Foreground task");
			model.script = [{ text: "foreground report" }];
			const fg = await agent(root, owner, { task: fgTask.task.address });
			expect(fg.result.output).toContain('status="current"');
			expect(inWindow).toBe(1);
			expect(startingDelegationCount()).toBe(0);
		} finally {
			open.resolve();
			watching.mockRestore();
		}
	});
});

describe("a failure after the delegation's commit (review N1 M18, N2, N6)", () => {
	test("a task that was to do is to do again; the agent is archived, never run", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { task } = await seedTask(root, owner);
		const spy = spyOn(narratorService, "persistSubagentUserMessage").mockRejectedValueOnce(
			new Error("simulated write failure"),
		);
		try {
			const { result, childId } = await agent(root, owner, {
				task: task.address,
				run_in_background: true,
			});
			expect(result.isError).toBe(true);
			expect(result.output).toContain("simulated write failure");
			expect((await blockOf(task.blockId)).taskJson?.status).toBe("todo");
			expect(await claimOf(task.blockId)).toMatchObject({
				holderNarratorId: null,
				lastHolderNarratorId: childId,
				epoch: 1,
			});
			const row = await db.query.narrators.findFirst({
				where: eq(narrators.id, childId as string),
			});
			expect(row?.status).toBe("archived");
			expect(model.passes).not.toContain(childId);
		} finally {
			spy.mockRestore();
		}
	});

	/** Fail the Agent call after the delegation's commit, once `change` ran in that window. */
	function failAfterCommit(change: () => Promise<void>) {
		return spyOn(narratorService, "persistSubagentUserMessage").mockImplementationOnce(async () => {
			await change();
			throw new Error("simulated write failure");
		});
	}
	const asPerson = (
		spaceId: string,
		owner: string,
		blockId: string,
		ops: "todo" | "doing" | "done",
	) =>
		writeOutline({
			spaceId,
			ops: [{ op: "setTask", block: { id: blockId }, task: { status: ops } }],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});

	test("a person ticks it done right after the commit: the undo leaves it done (review round 2, nit 1)", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		// The person's tick lands as soon as the delegation's commit is written, before anything
		// else of the delegation runs; then the Agent call fails.
		const write = writeModule.writeOutline;
		const commits = spyOn(writeModule, "writeOutline").mockImplementation(
			async (input, options) => {
				const written = await write(input, options);
				if (options?.delegateClaim) await asPerson(space.id, owner, task.blockId, "done");
				return written;
			},
		);
		const spy = failAfterCommit(async () => {});
		try {
			const { result } = await agent(root, owner, { task: task.address });
			expect(result.isError).toBe(true);
			expect((await blockOf(task.blockId)).taskJson?.status).toBe("done");
		} finally {
			spy.mockRestore();
			commits.mockRestore();
		}
	});

	test("a person resets it and starts it themselves meanwhile: they keep it (review round 2, nit 2)", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		const spy = failAfterCommit(async () => {
			await asPerson(space.id, owner, task.blockId, "todo");
			await asPerson(space.id, owner, task.blockId, "doing");
		});
		try {
			const { result } = await agent(root, owner, { task: task.address });
			expect(result.isError).toBe(true);
			expect((await blockOf(task.blockId)).taskJson?.status).toBe("doing");
			expect(await claimOf(task.blockId)).toMatchObject({ holderUserId: owner, epoch: 2 });
		} finally {
			spy.mockRestore();
		}
	});

	test("its text edited meanwhile: back to do all the same, the edit kept (review round 2, nit 4)", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		const spy = failAfterCommit(async () => {
			await writeOutline({
				spaceId: space.id,
				ops: [
					{ op: "update", block: { id: task.blockId }, content: "Fix the refresh race (edited)" },
				],
				actor: { kind: "human", id: owner },
				responsibleUserId: owner,
			});
		});
		try {
			const { result, childId } = await agent(root, owner, { task: task.address });
			expect(result.isError).toBe(true);
			const block = await blockOf(task.blockId);
			expect(block.taskJson?.status).toBe("todo");
			expect(block.content).toBe("Fix the refresh race (edited)");
			expect(await claimOf(task.blockId)).toMatchObject({
				holderNarratorId: null,
				lastHolderNarratorId: childId,
			});
		} finally {
			spy.mockRestore();
		}
	});

	test("a task the session was doing comes back to it, same generation, on the idle lease", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		await write(space.id, root, owner, [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } },
		]);
		const spy = spyOn(narratorService, "persistSubagentUserMessage").mockRejectedValueOnce(
			new Error("simulated write failure"),
		);
		try {
			const { result } = await agent(root, owner, { task: task.address });
			expect(result.isError).toBe(true);
			expect((await blockOf(task.blockId)).taskJson?.status).toBe("doing");
			const claim = (await claimOf(task.blockId)) as OutlineTaskClaimRow;
			expect(claim).toMatchObject({ holderNarratorId: root, epoch: 2 });
			expect(Date.parse(claim.expiresAt as string) - Date.now()).toBeGreaterThan(
				OUTLINE_TASK_IDLE_LEASE_MS - 60_000,
			);
		} finally {
			spy.mockRestore();
		}
	});

	test("a run that never starts gives the task back at once, and its task row is settled", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { task } = await seedTask(root, owner);
		const idle = Promise.resolve({
			started: false,
			output: "",
			finalText: "",
			hasError: false,
			interrupted: false,
			timedOut: false,
		});
		const spy = spyOn(runModule, "startNarratorRun").mockResolvedValueOnce({
			started: false,
			foreground: idle,
			terminal: idle,
			completion: idle,
		});
		try {
			const { result, childId } = await agent(root, owner, {
				task: task.address,
				run_in_background: true,
			});
			expect(result.isError).toBe(true);
			expect(result.output).toContain("did not start; its task was given back");
			expect((await blockOf(task.blockId)).taskJson?.status).toBe("todo");
			expect((await claimOf(task.blockId))?.holderNarratorId).toBeNull();
			const row = await db.query.backgroundTasks.findFirst({
				where: eq(backgroundTasks.id, childId as string),
			});
			expect(row?.status).not.toBe("running");
		} finally {
			spy.mockRestore();
		}
	});

	test("a subagent of the session holding the task without running (it never started): delegating again takes it", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		const stale = await narratorService.createSubagent({
			parentNarratorId: root,
			subagentType: "general",
			subagentOriginKind: "standalone",
			cwd: ".",
		});
		await writeOutline(
			{
				spaceId: space.id,
				ops: [{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } }],
				actor: { kind: "system", id: "outline-delegate" },
				responsibleUserId: owner,
				narratorId: root,
			},
			{ delegateClaim: { blockId: task.blockId, holderNarratorId: stale.id, epoch: 1 } },
		);
		model.script = [{ text: "picked up" }];
		const { result, childId } = await agent(root, owner, { task: task.address });
		expect(result.output).not.toContain("still running");
		expect(result.output).toContain('status="current"');
		expect((await claimOf(task.blockId))?.epoch).toBe(2);
		expect(childId).not.toBe(stale.id);
	});
});

describe("archiving a running delegated subagent (review S3)", () => {
	for (const how of ["archive", "history rollback"] as const) {
		test(`${how}: the task stays with the session, the report is attached as current`, async () => {
			const owner = await user();
			const root = await rootSession(owner);
			const { space, task } = await seedTask(root, owner);
			const open = gate();
			model.script = [{ text: "partial findings", gate: open.promise }];
			const { childId } = await agent(root, owner, { task: task.address, run_in_background: true });
			const sub = childId as string;
			await until(() => model.passes.includes(sub), "the pass");
			if (how === "archive") expect((await interruptAndArchiveSubagent(sub)).archived).toBe(true);
			else expect((await archiveRetiredSubagents([sub]))[0]?.archived).toBe(true);
			open.resolve();
			await until(() => runEnded(sub), "the run to end");
			await until(async () => {
				const under = (await treeUnder(space.id, task.blockId)) as Array<
					{ content: string } | string
				>;
				const last = under.at(-1);
				return typeof last === "object" && last.content.startsWith("Report");
			}, "the report");
			// Still in progress, with the session that sent it: same generation, idle lease.
			expect((await blockOf(task.blockId)).taskJson?.status).toBe("doing");
			const claim = (await claimOf(task.blockId)) as OutlineTaskClaimRow;
			expect(claim).toMatchObject({ holderNarratorId: root, epoch: 1 });
			expect(Date.parse(claim.expiresAt as string) - Date.now()).toBeGreaterThan(
				OUTLINE_TASK_IDLE_LEASE_MS - 60_000,
			);
			// No "the previous executor's session was archived" note: nothing reopened it.
			const under = await treeUnder(space.id, task.blockId);
			expect(JSON.stringify(under)).not.toContain("was archived");
			expect((await db.query.narrators.findFirst({ where: eq(narrators.id, sub) }))?.status).toBe(
				"archived",
			);
		});
	}

	test("a subagent sent without task keeps the archive's rule: nothing is handed back", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		const plain = await narratorService.createSubagent({
			parentNarratorId: root,
			subagentType: "general",
			subagentOriginKind: "standalone",
			cwd: ".",
		});
		await write(space.id, plain.id, owner, [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } },
		]);
		expect((await claimOf(task.blockId))?.holderNarratorId).toBe(plain.id);
		await interruptAndArchiveSubagent(plain.id);
		// Still its own: the archive's release (the session-end watcher) lets go of it, as before.
		expect((await claimOf(task.blockId))?.holderNarratorId).toBe(plain.id);
	});
});

describe("plans", () => {
	test("a step of an approved plan is delegated; two steps in parallel to two agents", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const space = await ensureSessionSpace(root);
		const r = await write(space.id, root, owner, [
			{
				op: "insert",
				tempId: "plan",
				parent: null,
				content: "Ship the importer",
				task: { status: "doing" },
			},
			{
				op: "insert",
				parent: { tempId: "plan" },
				content: "Read the format",
				task: { status: "todo" },
			},
			{
				op: "insert",
				parent: { tempId: "plan" },
				content: "Write the parser",
				task: { status: "todo" },
			},
		]);
		await writeOutline({
			spaceId: space.id,
			ops: [
				{
					op: "setTask",
					block: { id: r.results[0]?.blockId as string },
					task: {
						plan: {
							state: "approved",
							by: root,
							round: 1,
							baseSeq: 0,
							approvedBy: { kind: "human", id: owner },
						},
					},
				},
			],
			actor: { kind: "system", id: "outline-plan" },
			responsibleUserId: owner,
			narratorId: root,
		});
		const a = gate();
		const b = gate();
		model.script = [
			{ text: "format read", gate: a.promise },
			{ text: "parser written", gate: b.promise },
		];
		const one = await agent(root, owner, { task: r.results[1]?.address, run_in_background: true });
		const two = await agent(root, owner, { task: r.results[2]?.address, run_in_background: true });
		expect(one.result.isError).toBeFalsy();
		expect(two.result.isError).toBeFalsy();
		expect(await claimOf(r.results[1]?.blockId as string)).toMatchObject({
			holderNarratorId: one.childId,
		});
		expect(await claimOf(r.results[2]?.blockId as string)).toMatchObject({
			holderNarratorId: two.childId,
		});
		// The plan root's own claim stays the root's.
		expect((await claimOf(r.results[0]?.blockId as string))?.holderNarratorId).toBe(root);
		a.resolve();
		b.resolve();
		expect(await taskResult(one.childId as string)).toContain('status="current"');
		expect(await taskResult(two.childId as string)).toContain('status="current"');
	});
});

describe("the instructions", () => {
	test("written from the tree: links as titles, questions, prerequisites, the prompt, an earlier report as its title", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const other = await rootSession(await user("dave"));
		const space = await ensureSessionSpace(root);
		const hidden = await seedTask(other, owner, "Somewhere unreadable");
		const done = (
			await write(space.id, root, owner, [
				{
					op: "insert",
					parent: null,
					content: "Add the regression test",
					task: { status: "done" },
				},
			])
		).results[0];
		const target = (
			await write(space.id, root, owner, [
				{ op: "insert", parent: null, content: "Token design notes" },
			])
		).results[0];
		const r = await write(space.id, root, owner, [
			{
				op: "insert",
				tempId: "t",
				parent: null,
				content: "Fix the refresh race",
				task: { status: "todo", depends: [{ target: done?.address as string, label: null }] },
			},
			{
				op: "insert",
				parent: { tempId: "t" },
				content: `See [[${target?.address}]] and [[${hidden.task.address}]]`,
			},
		]);
		const task = r.results[0];
		const decided = await askTool.execute(
			{
				under: task?.address,
				questions: [{ question: "Revoke old tokens?", recommend: "at once" }],
			},
			ctxFor(root, owner),
		);
		const decidedId = (decided.metadata?.blockIds as string[])[0] as string;
		const { answerOutlineQuestions } = await import("../outline/questions");
		await answerOutlineQuestions({
			userId: owner,
			answers: [{ blockId: decidedId, text: "At once" }],
		});
		await askTool.execute(
			{
				under: task?.address,
				questions: [{ question: "Keep old clients?", recommend: "one version" }],
				proceed: true,
			},
			ctxFor(root, owner),
		);
		// An earlier report under the task shows as its title only.
		await attachDelegatedReport({
			subagentId: root,
			delegated: {
				spaceId: space.id,
				blockId: task?.blockId as string,
				epoch: 1,
				delegatorNarratorId: root,
				toolCallId: "earlier-call",
				locale: "en",
			},
			logicalRunId: "earlier",
			text: "# Old findings\n- SECRET DETAIL",
			ending: "completed",
			principal: owner,
		});
		model.script = [{ text: "ok" }];
		const { childId, result } = await agent(root, owner, {
			task: task?.address,
			prompt: "Keep the change small.",
		});
		expect(result.output).not.toContain("Agent task error");
		expect(result.isError).toBeFalsy();
		const brief = await firstUserMessage(childId as string);
		expect(brief).toContain("# Task: Fix the refresh race");
		expect(brief).toContain("- See Token design notes and (a block this session cannot read)");
		expect(brief).toContain("- Decided: Revoke old tokens? → At once");
		expect(brief).toContain("- Open question: Keep old clients? (suggested: one version)");
		expect(brief).toContain("## Prerequisites\n- Add the regression test (done)");
		expect(brief).toContain("## Further instructions\nKeep the change small.");
		expect(brief).toMatch(
			// (Late: the task was to do, nobody holding it, when that report came.)
			/\n- Late report \(generation 1 · [^\n]*\) \(an earlier report; not repeated here\)\n/,
		);
		expect(brief).not.toContain("SECRET DETAIL");
		expect(brief).not.toContain("[[");
		expect(brief).not.toContain(task?.sid as string);
		expect(brief.trimEnd().endsWith("what needs a person's decision.")).toBe(true);
	});

	test("bounded: the tree breadth first within 16 KiB, the rest counted", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const space = await ensureSessionSpace(root);
		const ops = [
			{
				op: "insert" as const,
				tempId: "t",
				parent: null,
				content: "Big task",
				task: { status: "todo" as const },
			},
			...Array.from({ length: 150 }, (_, i) => ({
				op: "insert" as const,
				tempId: `c${i}`,
				parent: { tempId: "t" },
				content: `Note ${i} ${"x".repeat(200)}`,
			})),
			...Array.from({ length: 40 }, (_, i) => ({
				op: "insert" as const,
				parent: { tempId: "c0" },
				content: `Deep ${i}`,
			})),
		];
		const task = (await write(space.id, root, owner, ops)).results[0];
		model.script = [{ text: "ok" }];
		const prompt = "p".repeat(20_000);
		const { childId } = await agent(root, owner, { task: task?.address, prompt });
		const brief = await firstUserMessage(childId as string);
		const withoutPrompt = brief.replace(prompt, "");
		expect(Buffer.byteLength(withoutPrompt, "utf8")).toBeLessThanOrEqual(
			OUTLINE_DELEGATION_LIMITS.briefBytes,
		);
		// The caller's prompt is given whole.
		expect(brief).toContain(prompt);
		// Breadth first: the first level before anything deeper, the rest counted.
		expect(brief).toContain("- Note 0 ");
		expect(brief).not.toContain("Deep 0");
		expect(brief).toMatch(/\n- … \d+ more\n/);
	});

	test("pure rendering: an empty tree, a long body cut, nested steps", () => {
		const brief = renderDelegationBrief({
			title: "T",
			body: "b".repeat(20_000),
			goals: ["Goal A", "Goal B"],
			children: [
				{
					text: "step",
					box: "todo",
					children: [{ text: "sub\nsecond line", box: null, children: [] }],
				},
			],
			prerequisites: [],
		});
		expect(brief).toContain("Part of: Goal A › Goal B");
		expect(brief).toContain("- [ ] step\n  - sub\n    second line");
		expect(brief).toContain("b…");
		expect(Buffer.byteLength(brief, "utf8")).toBeLessThanOrEqual(
			OUTLINE_DELEGATION_LIMITS.briefBytes,
		);
	});
});

describe("the write path's delegation claim", () => {
	async function taskIn(root: string, owner: string, status: "todo" | "doing") {
		const space = await ensureSessionSpace(root);
		const r = await write(space.id, root, owner, [
			{ op: "insert", parent: null, content: `A task ${status}`, task: { status } },
		]);
		return { space, task: r.results[0] as NonNullable<(typeof r.results)[0]> };
	}
	const delegate = (
		spaceId: string,
		root: string,
		blockId: string,
		holder: string,
		epoch: number,
	) =>
		writeOutline(
			{
				spaceId,
				ops: [{ op: "setTask", block: { id: blockId }, task: { status: "doing" } }],
				actor: { kind: "system", id: "outline-delegate" },
				responsibleUserId: null,
				narratorId: root,
			},
			{ delegateClaim: { blockId, holderNarratorId: holder, epoch } },
		);

	test("the root's own claim moves to the subagent with the next generation, on the running lease", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const sub = await rootSession(owner);
		const { space, task } = await taskIn(root, owner, "doing");
		expect(await claimOf(task.blockId)).toMatchObject({ holderNarratorId: root, epoch: 1 });
		const at = Date.now();
		const r = await delegate(space.id, root, task.blockId, sub, 2);
		expect(r.commit).not.toBeNull();
		const claim = (await claimOf(task.blockId)) as OutlineTaskClaimRow;
		expect(claim).toMatchObject({ holderNarratorId: sub, epoch: 2, holderUserId: null });
		const lease = Date.parse(claim.expiresAt as string) - at;
		expect(lease).toBeGreaterThan(OUTLINE_TASK_LEASE.leaseMs - 60_000);
		expect(lease).toBeLessThanOrEqual(OUTLINE_TASK_LEASE.leaseMs + 1000);
	});

	test("nobody holds it: claimed for the subagent; another session's live claim refuses it", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const sub = await rootSession(owner);
		const other = await rootSession(owner);
		const free = await taskIn(root, owner, "todo");
		await delegate(free.space.id, root, free.task.blockId, sub, 1);
		expect(await claimOf(free.task.blockId)).toMatchObject({ holderNarratorId: sub, epoch: 1 });
		expect((await blockOf(free.task.blockId)).taskJson?.status).toBe("doing");

		const taken = await taskIn(root, owner, "todo");
		await write(taken.space.id, other, owner, [
			{ op: "setTask", block: { id: taken.task.blockId }, task: { status: "doing" } },
		]);
		await expect(delegate(taken.space.id, root, taken.task.blockId, sub, 2)).rejects.toBeInstanceOf(
			OutlineTaskClaimedError,
		);
	});

	test("a claim that moved on since it was read refuses it; only the system may delegate", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const sub = await rootSession(owner);
		const { space, task } = await taskIn(root, owner, "doing");
		await expect(delegate(space.id, root, task.blockId, sub, 5)).rejects.toBeInstanceOf(
			OutlineClaimChangedError,
		);
		await expect(
			writeOutline(
				{
					spaceId: space.id,
					ops: [{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } }],
					actor: { kind: "agent", id: root },
					responsibleUserId: owner,
					narratorId: root,
				},
				{ delegateClaim: { blockId: task.blockId, holderNarratorId: sub, epoch: 2 } },
			),
		).rejects.toBeInstanceOf(OutlineWriteError);
		expect(await claimOf(task.blockId)).toMatchObject({ holderNarratorId: root, epoch: 1 });
	});

	test("expected claims: written only while still as read", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await taskIn(root, owner, "doing");
		const row = await claimOf(task.blockId);
		const note = (expect: OutlineTaskClaimRow | null) =>
			writeOutline(
				{
					spaceId: space.id,
					ops: [{ op: "insert", parent: { id: task.blockId }, content: "a note" }],
					actor: { kind: "system", id: "outline-report" },
					responsibleUserId: owner,
					narratorId: root,
				},
				{ expectClaims: [{ taskBlockId: task.blockId, expect }] },
			);
		await expect(note(null)).rejects.toBeInstanceOf(OutlineClaimChangedError);
		expect((await note(row)).commit).not.toBeNull();
	});

	test("expected claims are checked again when the commit is written (a renewal in between)", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await taskIn(root, owner, "doing");
		const row = await claimOf(task.blockId);
		let moved = false;
		const store = new Proxy(outlineStore, {
			get(target, prop, receiver) {
				if (prop === "applyCommit") {
					return async (plan: Parameters<OutlineStore["applyCommit"]>[0]) => {
						if (!moved) {
							moved = true;
							// The claim moves after the plan was made, before it is written.
							await db
								.update(outlineTaskClaims)
								.set({ expiresAt: "2099-01-01T00:00:00.000Z" })
								.where(eq(outlineTaskClaims.taskBlockId, task.blockId));
						}
						return await target.applyCommit(plan);
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as OutlineStore;
		await expect(
			writeOutline(
				{
					spaceId: space.id,
					ops: [{ op: "insert", parent: { id: task.blockId }, content: "rests on the claim" }],
					actor: { kind: "system", id: "outline-report" },
					responsibleUserId: owner,
					narratorId: root,
				},
				{ store, expectClaims: [{ taskBlockId: task.blockId, expect: row }] },
			),
		).rejects.toBeInstanceOf(OutlineClaimChangedError);
		expect(moved).toBe(true);
		expect(await treeUnder(space.id, task.blockId)).toEqual([]);
	});
});

describe("the lease and continuation while a subagent has the task", () => {
	test("its keeper renews the delegated claim; the run's end gives it back, same generation; its tree is the root's again", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task, step } = await seedTask(root, owner);
		const open = gate();
		model.script = [{ text: "report", gate: open.promise }];
		const { childId } = await agent(root, owner, { task: task.address, run_in_background: true });
		const sub = childId as string;
		await until(() => model.passes.includes(sub), "the pass");
		const later = new Date(Date.now() + 5 * 60_000);
		expect(await renewOutlineTaskLeases(sub, { now: later })).toBe(1);
		expect((await claimOf(task.blockId))?.expiresAt).toBe(
			new Date(later.getTime() + OUTLINE_TASK_LEASE.leaseMs).toISOString(),
		);
		const during = await findContinuationCandidates({ narratorId: root, sessionSpaceId: space.id });
		expect(during.ordered.map((c) => c.blockId)).not.toContain(step.blockId);
		expect(during.personWork).toEqual([]);

		open.resolve();
		await taskResult(sub);
		await until(() => runEnded(sub), "the run to end");
		await until(
			async () => (await claimOf(task.blockId))?.holderNarratorId === root,
			"the claim to come back",
		);
		const back = (await claimOf(task.blockId)) as OutlineTaskClaimRow;
		expect(back.epoch).toBe(1);
		expect(Date.parse(back.expiresAt as string) - Date.now()).toBeGreaterThan(
			OUTLINE_TASK_IDLE_LEASE_MS - 60_000,
		);
		const after = await findContinuationCandidates({ narratorId: root, sessionSpaceId: space.id });
		expect(after.ordered.map((c) => c.blockId)).toContain(step.blockId);
		expect(after.ordered.map((c) => c.blockId)).toContain(task.blockId);
	});

	test("a takeover landing between the attachment's read and its write: decided again, late", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const other = await rootSession(owner, { title: "Racer" });
		const { space, task } = await seedTask(root, owner);
		const sub = await rootSession(owner);
		const expire = async () => {
			const { outlineTaskClaims } = await import("../../db/schema");
			await db
				.update(outlineTaskClaims)
				.set({ expiresAt: "2000-01-01T00:00:00.000Z" })
				.where(eq(outlineTaskClaims.taskBlockId, task.blockId));
		};
		await write(space.id, root, owner, [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } },
		]);
		let raced = false;
		const store = new Proxy(outlineStore, {
			get(target, prop, receiver) {
				if (prop === "getTaskClaims") {
					return async (ids: readonly string[]) => {
						const rows = await target.getTaskClaims(ids);
						if (!raced) {
							raced = true;
							await expire();
							await write(space.id, other, owner, [
								{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } },
							]);
						}
						return rows;
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as OutlineStore;
		const note = await attachDelegatedReport({
			subagentId: sub,
			delegated: {
				spaceId: space.id,
				blockId: task.blockId,
				epoch: 1,
				delegatorNarratorId: root,
				toolCallId: "race-call",
				locale: "en",
			},
			logicalRunId: "race-run",
			text: "racing",
			ending: "completed",
			principal: owner,
			store,
		});
		expect(raced).toBe(true);
		expect(note).toContain('status="late"');
		expect(note).toContain('"Racer"');
		const under = await treeUnder(space.id, task.blockId);
		expect((under.at(-1) as { content: string }).content).toMatch(/^Late report/);
	});
});

describe("a report past the limits", () => {
	test("what fits is attached in one commit, then a line pointing at the full text", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		const { space, task } = await seedTask(root, owner);
		await write(space.id, root, owner, [
			{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } },
		]);
		const text = Array.from(
			{ length: 400 },
			(_, i) => `- finding ${i}: ${"detail ".repeat(20)}`,
		).join("\n");
		const note = await attachDelegatedReport({
			subagentId: root,
			delegated: {
				spaceId: space.id,
				blockId: task.blockId,
				epoch: 1,
				delegatorNarratorId: root,
				toolCallId: "big-call",
				locale: "zh-CN",
			},
			logicalRunId: "big-run",
			text,
			ending: "completed",
			principal: owner,
		});
		expect(note).toContain("(200 blocks)");
		const { reportBlockId } = await import("../outline/delegation");
		const container = await blockOf(reportBlockId(root, "big-run"));
		const under = await outlineStore.listChildren(space.id, container.id, 300);
		expect(under).toHaveLength(199);
		expect(under[0]?.content.startsWith("finding 0:")).toBe(true);
		expect(under.at(-1)?.content).toMatch(
			/^其余约 \d+ KiB 没有挂回，原文是子代理会话的最后一条回复。$/,
		);
		const commits = new Set(under.map((b) => b.versionSeq));
		commits.add(container.versionSeq);
		expect(commits.size).toBe(1);
	});
});

describe("late results, as a table (design §2.5)", () => {
	const row = (over: Partial<OutlineTaskClaimRow>): OutlineTaskClaimRow => ({
		taskBlockId: "t",
		holderNarratorId: null,
		holderUserId: null,
		epoch: 3,
		taskVersionAtClaim: 1,
		claimedAt: "2026-11-06T00:00:00.000Z",
		expiresAt: null,
		lastHolderNarratorId: null,
		lastHolderUserId: null,
		...over,
	});
	const facts = (
		claim: OutlineTaskClaimRow | null,
		status: "todo" | "doing" | "done" = "doing",
	) => ({
		epoch: 3,
		subagentId: "sub",
		task: { deleted: false, taskJson: { status, assignee: null } },
		claim,
		inSession: (id: string) => id === "root" || id === "sub" || id === "sub2",
		delegatorNarratorId: "root",
	});
	test("each row of the table", () => {
		expect(
			classifyDelegatedResult(facts(row({ holderNarratorId: "sub", expiresAt: "x" }))),
		).toEqual({
			kind: "current",
			doneBySubagent: false,
		});
		expect(classifyDelegatedResult(facts(row({ holderNarratorId: "root" })))).toMatchObject({
			kind: "current",
		});
		expect(
			classifyDelegatedResult({
				...facts(row({ lastHolderNarratorId: "sub" }), "done"),
				finishedBy: { actorKind: "agent", actorId: "sub", narratorId: "sub" },
			}),
		).toEqual({ kind: "current", doneBySubagent: true });
		expect(classifyDelegatedResult(facts(row({ epoch: 4, holderNarratorId: "b" })))).toMatchObject({
			kind: "late",
			reason: "taken_over",
			epoch: 4,
			holder: { kind: "agent", narratorId: "b" },
		});
		expect(classifyDelegatedResult(facts(row({ epoch: 4, holderUserId: "u" })))).toMatchObject({
			reason: "taken_over",
			holder: { kind: "human", userId: "u" },
		});
		expect(classifyDelegatedResult(facts(row({ epoch: 4, holderNarratorId: "sub2" })))).toEqual({
			kind: "late",
			reason: "redelegated",
			epoch: 4,
		});
		expect(classifyDelegatedResult(facts(row({ epoch: 4, lastHolderNarratorId: "sub2" })))).toEqual(
			{ kind: "late", reason: "redelegated", epoch: 4 },
		);
		// The session itself took it up again (after it went back to do): not "delegated again".
		expect(classifyDelegatedResult(facts(row({ epoch: 4, holderNarratorId: "root" })))).toEqual({
			kind: "late",
			reason: "reclaimed",
			epoch: 4,
		});
		// Same generation, yet held outside the session (a row no write path makes): not current.
		expect(classifyDelegatedResult(facts(row({ holderNarratorId: "b" })))).toMatchObject({
			kind: "late",
			reason: "taken_over",
			holder: { kind: "agent", narratorId: "b" },
		});
		expect(classifyDelegatedResult(facts(row({ holderUserId: "u" })))).toMatchObject({
			kind: "late",
			reason: "taken_over",
			holder: { kind: "human", userId: "u" },
		});
		expect(
			classifyDelegatedResult({
				...facts(row({ lastHolderNarratorId: "sub" }), "done"),
				finishedBy: { actorKind: "agent", actorId: "root", narratorId: "root" },
			}),
		).toMatchObject({ kind: "late", reason: "ended", status: "done" });
		expect(classifyDelegatedResult(facts(row({ lastHolderNarratorId: "sub" }), "todo"))).toEqual({
			kind: "late",
			reason: "reopened",
		});
		expect(classifyDelegatedResult({ ...facts(null), task: null })).toEqual({
			kind: "late",
			reason: "gone",
		});
		expect(
			classifyDelegatedResult({ ...facts(null), task: { deleted: false, taskJson: null } }),
		).toMatchObject({ reason: "gone" });
	});

	test("the note is replaced, never added twice", () => {
		const note =
			'<outline_report task="k/s" report="k/r" generation="1" status="current">\nbody\n</outline_report>';
		const once = withDelegationNote("result", note);
		expect(once).toBe(`result\n\n${note}`);
		expect(withDelegationNote(once, note)).toBe(once);
		expect(stripDelegationNote(once)).toBe("result");
		expect(stripDelegationNote(`${once}\n  \n`)).toBe("result");
		expect(stripDelegationNote(note)).toBe("");
		expect(withDelegationNote("result", "")).toBe("result");
	});

	test("a report that quotes a note keeps every line of it", () => {
		const quoting = [
			"Findings:",
			'<outline_report task="x/y" generation="1" status="late" reason="gone">',
			"quoted example",
			"</outline_report>",
			"More findings here.",
			"Conclusion: fixed.",
			"</outline_report>",
		].join("\n");
		expect(stripDelegationNote(quoting)).toBe(quoting);
		// A note-looking tail whose head is not the system's exact form stays too.
		const loose = 'text\n<outline_report task="x">\nbody\n</outline_report>';
		expect(stripDelegationNote(loose)).toBe(loose);
		// The exact head, but not at the start of a line (the window starts right at it).
		const head = '<outline_report task="k/s" generation="1" status="current">';
		const body = "b".repeat(4096 - head.length - "</outline_report>".length - 2);
		const glued = `prefix ${head}\n${body}\n</outline_report>`;
		expect(stripDelegationNote(glued)).toBe(glued);
		// The exact head, but the line under it holds a tag of its own.
		const tagged = `text\n${head}\nquote </outline_report> more\n</outline_report>`;
		expect(stripDelegationNote(tagged)).toBe(tagged);
		const opened = `text\n${head}\n<outline_report x\n</outline_report>`;
		expect(stripDelegationNote(opened)).toBe(opened);
		// The real note after it is still found.
		const note =
			'<outline_report task="k/s" generation="2" status="late" reason="taken_over">\nLate.\n</outline_report>';
		expect(withDelegationNote(quoting, note)).toBe(`${quoting}\n\n${note}`);
		expect(stripDelegationNote(`${quoting}\n\n${note}`)).toBe(quoting);
	});

	test("stripping is linear: hundreds of KiB of repeated tags take milliseconds", () => {
		const unit =
			'<outline_report task="a" generation="1" status="current">\nx\n</outline_report>\n';
		const huge = unit.repeat(Math.ceil((320 * 1024) / unit.length));
		const open = "<outline_report \n".repeat(20_000);
		const started = performance.now();
		for (let i = 0; i < 5; i++) {
			stripDelegationNote(huge);
			withDelegationNote(huge, "");
			stripDelegationNote(`${open}</outline_report>`);
		}
		expect(performance.now() - started).toBeLessThan(250);
		// Only the last note is the delivery's.
		expect(stripDelegationNote(huge).length).toBe(
			huge.trimEnd().length - unit.trimEnd().length - 1,
		);
	});
});

describe("the registration", () => {
	test("records the delegation across runs; an unknown field from a later version is dropped on read", () => {
		const delegatedTask = {
			spaceId: "s",
			blockId: "b",
			epoch: 2,
			delegatorNarratorId: "root",
			toolCallId: "call",
			locale: "zh-CN" as const,
		};
		const stored = parseRuntimeRegistration({ version: 1, delegatedTask });
		const next = registerRun(stored, "run-2", { principal: { userId: null } }, 0);
		expect(next.delegatedTask).toEqual(delegatedTask);
		expect(readRuntimeRegistrationColumn({ ...next, laterField: { x: 1 } })).toEqual(next);
		expect(() => parseRuntimeRegistration({ ...next, laterField: 1 })).toThrow();
		expect(() => readRuntimeRegistrationColumn({ version: 2 })).toThrow();
		expect(() =>
			parseRuntimeRegistration({ version: 1, delegatedTask: { ...delegatedTask, extra: 1 } }),
		).toThrow();
	});

	test("a subagent sent without task has none, and its result carries no note", async () => {
		const owner = await user();
		const root = await rootSession(owner);
		model.script = [{ text: "plain result" }];
		const { result, childId } = await agent(root, owner, { prompt: "look around" });
		expect(result.output).toMatch(/^<subagent_id>[^<]+<\/subagent_id>\n\nplain result$/);
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, childId as string) });
		expect(
			readRuntimeRegistrationColumn(row?.runtimeRegistrationJson)?.delegatedTask,
		).toBeUndefined();
	});
});
