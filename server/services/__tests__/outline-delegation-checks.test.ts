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
import { narrators } from "../../db/schema";
import { askTool } from "../../lib/agent/tools/outline";
import type { ToolContext } from "../../lib/agent/types";
import { settings } from "../../lib/settings";
import {
	parseRuntimeRegistration,
	readRuntimeRegistrationColumn,
	registerRun,
} from "../../lib/validators/runtime-registration";
import { narratorService } from "../narrator-service";
import {
	attachDelegatedReport,
	classifyDelegatedResult,
	OUTLINE_DELEGATION_LIMITS,
	renderDelegationBrief,
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
import { writeOutline } from "../outline/write";
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
		const note = '<outline_report task="k/s" status="current">\nbody\n</outline_report>';
		const once = withDelegationNote("result", note);
		expect(once).toBe(`result\n\n${note}`);
		expect(withDelegationNote(once, note)).toBe(once);
		expect(stripDelegationNote(once)).toBe("result");
		expect(withDelegationNote("result", "")).toBe("result");
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
