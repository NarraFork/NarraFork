/**
 * Plan mode in an outline session (outline P2 PR 8, D48): the plan tree, ExitPlanMode's
 * submission and diff, the three decisions on the card's route (with their 403 and 409 cases),
 * the approval's first pass (the acceptance: the session continues from the first step that can
 * start, the same task blocks, nothing copied), cancelling plan mode, the continuation order of a
 * tree being worked (D48 Q2, `/goal` steps included), and spec sessions left as they were.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 * `outline.enabled` is switched on before each case (the preload restores settings after it).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators, narratorToolCalls, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { narratorService } from "../narrator-service";
import { pendingPermissions } from "../narrator-session-state";
import { addPersonTask } from "../outline/person-tasks";
import { readPlanDiff } from "../outline/plan-diff";
import { findPlanningRoot } from "../outline/plans";
import { ensureSessionSpace } from "../outline/spaces";
import { outlineStore } from "../outline/store";
import { type OutlineOp, writeOutline } from "../outline/write";
import {
	cancelOutlinePlanMode,
	decideOutlinePlanRequest,
	enterOutlinePlanMode,
	resolveOutlineExitPlanInput,
	settleApprovedOutlinePlan,
	startApprovedOutlinePlan,
} from "../outline-plan-mode";
import { taskSourceForNarrator } from "../task-source";

const NOW = "2026-11-04T00:00:00.000Z";

beforeEach(() => {
	settings.outline.enabled = true;
});
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function user(): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `plan-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

async function session(
	owner: string,
	options: { backend?: "spec" | "outline"; mode?: "protectedOnly" | "off" | "always" } = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "default",
		permissionMode: "default",
		status: "idle",
		taskBackend: options.backend ?? "outline",
		ownerUserId: owner,
		autoContinuationOverride: options.mode ?? "protectedOnly",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

/** The agent writing in its session space. */
async function agentWrite(narratorId: string, owner: string, ops: OutlineOp[]) {
	const space = await ensureSessionSpace(narratorId);
	return await writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "agent", id: narratorId },
		responsibleUserId: owner,
		narratorId,
	});
}

async function block(id: string) {
	const row = await outlineStore.getBlock(id);
	if (!row) throw new Error(`no block ${id}`);
	return row;
}

async function enter(narratorId: string, owner: string, input: Record<string, unknown> = {}) {
	const result = await enterOutlinePlanMode({ narratorId, userId: owner, input, locale: "en" });
	if (!result) throw new Error("not an outline plan session");
	return result;
}

/** A plan: a person's step, a milestone whose first step waits for its second, and a last step. */
async function writePlan(narratorId: string, owner: string) {
	const root = await findPlanningRoot(narratorId);
	if (!root) throw new Error("no plan root");
	const space = await ensureSessionSpace(narratorId);
	const r = await agentWrite(narratorId, owner, [
		{ op: "update", block: { id: root.blockId }, content: "Ship the importer" },
		{
			op: "insert",
			tempId: "bob",
			parent: { id: root.blockId },
			content: "Ask Bob for the data",
			task: { status: "todo", assignee: "human:bob" },
		},
		{
			op: "insert",
			tempId: "m1",
			parent: { id: root.blockId },
			content: "Milestone one",
			task: { status: "todo" },
		},
		{
			op: "insert",
			tempId: "b",
			sid: "StepBbbb",
			parent: { tempId: "m1" },
			content: "Step B",
			task: { status: "todo" },
		},
		{
			op: "insert",
			tempId: "a",
			parent: { tempId: "m1" },
			position: { first: true },
			content: "Step A",
			task: { status: "todo", depends: [{ target: `${space.key}/StepBbbb`, label: null }] },
		},
		{
			op: "insert",
			tempId: "c",
			parent: { id: root.blockId },
			content: "Step C",
			task: { status: "todo" },
		},
		{
			op: "insert",
			tempId: "note",
			parent: { id: root.blockId },
			content: "Decision: use the v2 API",
		},
	]);
	const ids = (i: number) => r.results[i]?.blockId as string;
	return {
		root: root.blockId,
		bob: ids(1),
		m1: ids(2),
		b: ids(3),
		a: ids(4),
		c: ids(5),
		note: ids(6),
	};
}

/** Task blocks of the session space, by id. */
async function taskIds(narratorId: string): Promise<string[]> {
	const space = await ensureSessionSpace(narratorId);
	const open = await outlineStore.listOpenTasks(space.id, 500);
	return open.map((b) => b.id).sort();
}

/**
 * ExitPlanMode submitted and waiting: the resolved input persisted on a tool call row (as the
 * permission flow does), and a pending request whose resolution is captured.
 */
async function submit(narratorId: string, input: Record<string, unknown> = { mode: "outline" }) {
	const resolved = await resolveOutlineExitPlanInput(narratorId, input, "en");
	if (!resolved?.ok) throw new Error(`not submitted: ${JSON.stringify(resolved)}`);
	const toolUseId = `toolu_${generateId()}`;
	const msg = await narratorService.persistAssistantMessage(narratorId, {
		uuid: randomUUID(),
		session_id: randomUUID(),
		parent_tool_use_id: null,
		message: {
			content: [{ type: "tool_use", id: toolUseId, name: "ExitPlanMode", input: resolved.input }],
		},
	});
	const row = await db.query.narratorToolCalls.findFirst({
		where: and(eq(narratorToolCalls.messageId, msg.id), eq(narratorToolCalls.toolUseId, toolUseId)),
		columns: { id: true },
	});
	if (!row) throw new Error("no tool call row");
	await db
		.update(narratorToolCalls)
		.set({ inputJson: resolved.input, status: "pending" })
		.where(eq(narratorToolCalls.id, row.id));
	let outcome: { behavior: string; message?: string } | null = null;
	pendingPermissions.set(row.id, {
		resolve: (result) => {
			outcome = result as { behavior: string; message?: string };
		},
		cleanup: () => {},
		input: resolved.input,
		narratorId,
		toolName: "ExitPlanMode",
		toolUseId,
		broadcastTargetId: narratorId,
		cwd: "/",
		locale: "en",
		signal: new AbortController().signal,
	});
	cleanups.push(() => pendingPermissions.delete(row.id));
	return {
		requestId: row.id,
		toolUseId,
		input: resolved.input,
		outcome: () => outcome as { behavior: string; message?: string } | null,
	};
}

describe("the plan tree", () => {
	test("EnterPlanMode makes a plan root last on the task page; entering again resumes it", async () => {
		const owner = await user();
		const id = await session(owner);
		await addPersonTask({ narratorId: id, userId: owner, text: "An earlier goal", lock: true });
		const first = await enter(id, owner, { plan_name: "Ship the importer" });
		expect(first.output).toContain("the plan root was created");
		const root = await findPlanningRoot(id);
		expect(root?.title).toBe("Ship the importer");
		const row = await block(root?.blockId as string);
		expect(row.taskJson).toMatchObject({
			status: "todo",
			manager: { kind: "agent", id },
			plan: { state: "planning", by: id, round: 0, baseSeq: 0 },
		});
		// Last on the task page, after the goal.
		const siblings = await outlineStore.listChildMetas(row.spaceId, [row.parentId], 10);
		expect(siblings.at(-1)?.id).toBe(row.id);
		const again = await enter(id, owner);
		expect(again.output).toContain("continuing this session's plan");
		expect((await findPlanningRoot(id))?.blockId).toBe(row.id);
	});

	test("under: a goal places the plan beneath it; root: a locked tree is refused", async () => {
		const owner = await user();
		const id = await session(owner);
		const goal = await addPersonTask({
			narratorId: id,
			userId: owner,
			text: "The goal",
			lock: true,
		});
		await enter(id, owner, { under: goal.address, plan_name: "How" });
		const root = await findPlanningRoot(id);
		expect((await block(root?.blockId as string)).parentId).toBe(goal.blockId);

		const other = await session(owner);
		const locked = await addPersonTask({
			narratorId: other,
			userId: owner,
			text: "Locked",
			lock: true,
		});
		const refused = await enter(other, owner, { root: locked.address });
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("locked by a person");
		expect(await findPlanningRoot(other)).toBeNull();
	});

	test("an agent cannot set or clear a plan's state", async () => {
		const owner = await user();
		const id = await session(owner);
		await enter(id, owner);
		const root = await findPlanningRoot(id);
		await expect(
			agentWrite(id, owner, [
				{ op: "setTask", block: { id: root?.blockId as string }, task: { plan: null } },
			]),
		).rejects.toThrow(/plan's state/);
	});

	test("a plan being planned is never continued, and the current-tasks view leaves it out", async () => {
		const owner = await user();
		const id = await session(owner, { mode: "always" });
		await enter(id, owner);
		await writePlan(id, owner);
		const source = await taskSourceForNarrator(id);
		const target = await source.prepareContinuation({ promoteTodo: true });
		expect(target.openTask).toBeNull();
		expect((await source.openTasks()).tasks).toEqual([]);
		const space = await ensureSessionSpace(id);
		const doing = (await outlineStore.listOpenTasks(space.id, 50)).filter(
			(b) => b.taskJson?.status === "doing",
		);
		expect(doing).toEqual([]);
	});

	test("cancelling plan mode deletes an empty plan and keeps one with content as planning", async () => {
		const owner = await user();
		const empty = await session(owner);
		await enter(empty, owner);
		const emptyRoot = await findPlanningRoot(empty);
		await cancelOutlinePlanMode(empty, owner);
		expect((await block(emptyRoot?.blockId as string)).deleted).toBe(true);

		const written = await session(owner);
		await enter(written, owner);
		const { root } = await writePlan(written, owner);
		await cancelOutlinePlanMode(written, owner);
		expect((await block(root)).taskJson?.plan?.state).toBe("planning");
		// Resumed on the next EnterPlanMode.
		expect((await enter(written, owner)).output).toContain("continuing");
		expect((await findPlanningRoot(written))?.blockId).toBe(root);
	});
});

describe("submitting a plan", () => {
	test("the submission carries the plan and its diff against nothing; inline or file is refused", async () => {
		const owner = await user();
		const id = await session(owner);
		await enter(id, owner, { plan_name: "Plan" });
		await writePlan(id, owner);
		const resolved = await resolveOutlineExitPlanInput(
			id,
			{ mode: "outline", summary: "First cut" },
			"en",
		);
		expect(resolved?.ok).toBe(true);
		const input = (resolved as { input: Record<string, unknown> }).input;
		expect(input.mode).toBe("outline");
		expect(input.plan).toContain("Ship the importer");
		expect(input.plan).toContain("Step B");
		expect(input.plan).not.toContain("‹plan");
		expect(input._planBaseSeq).toBe(0);
		expect(input._planSummary).toBe("First cut");
		expect((input._planDiff as { counts: { added: number } }).counts.added).toBe(7);
		expect((input._planRoot as { round: number }).round).toBe(1);

		const inline = await resolveOutlineExitPlanInput(
			id,
			{ mode: "inline", inline_plan: "x" },
			"en",
		);
		expect(inline?.ok).toBe(false);
		expect((inline as { message: string }).message).toContain('mode: "outline"');
	});

	test("without a plan root: an error, unless it is a plan-file cycle begun before (null)", async () => {
		const owner = await user();
		const id = await session(owner);
		const missing = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "en");
		expect(missing?.ok).toBe(false);
		expect((missing as { message: string }).message).toContain("EnterPlanMode");
		expect(await resolveOutlineExitPlanInput(id, { mode: "file" }, "en")).toBeNull();
	});

	test("spec sessions are left as they were", async () => {
		const owner = await user();
		const id = await session(owner, { backend: "spec" });
		expect(
			await enterOutlinePlanMode({ narratorId: id, userId: owner, input: {}, locale: "en" }),
		).toBeNull();
		expect(await resolveOutlineExitPlanInput(id, { mode: "outline" }, "en")).toBeNull();
		await cancelOutlinePlanMode(id, owner);
		expect(await findPlanningRoot(id)).toBeNull();
	});
});

describe("deciding (the card's route)", () => {
	test("acceptance: approved as a draft, the session continues from the first step that can start, with the same task blocks", async () => {
		const owner = await user();
		const id = await session(owner);
		// A to-do of the session before the plan, which continuation must not jump to.
		await agentWrite(id, owner, [
			{ op: "insert", tempId: "p", parent: null, content: "Notes" },
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "Unrelated to-do",
				task: { status: "todo" },
			},
		]);
		await enter(id, owner);
		const plan = await writePlan(id, owner);
		const before = await taskIds(id);
		const sub = await submit(id);
		const decision = await decideOutlinePlanRequest({
			requestId: sub.requestId,
			principal: { userId: owner, isAdmin: false },
			body: { action: "draft", seenSeq: sub.input._planSeq as number },
		});
		expect(decision.commit).not.toBeNull();
		expect(sub.outcome()?.behavior).toBe("allow");
		expect((await block(plan.root)).taskJson?.plan).toMatchObject({
			state: "approved",
			round: 1,
			approvedBy: { kind: "human", id: owner },
		});
		expect((await block(plan.root)).taskJson?.lock).toBeUndefined();

		const approved = await settleApprovedOutlinePlan({
			narratorId: id,
			toolUseId: sub.toolUseId,
			locale: "en",
			approverUserId: owner,
			turnUserId: owner,
			byReview: false,
		});
		expect(approved?.approval).toEqual({ kind: "draft" });
		const prompt = await startApprovedOutlinePlan({
			narratorId: id,
			approved: approved as NonNullable<typeof approved>,
			locale: "en",
			compact: false,
		});
		const space = await ensureSessionSpace(id);
		const b = await block(plan.b);
		// Bob's step is a person's, A waits for B: B is the first that can start.
		expect(prompt).toContain(`\`${space.key}/${b.sid}\``);
		expect(prompt).toContain("Step B");
		expect(prompt).toContain("approved as a draft");
		expect(b.taskJson?.status).toBe("doing");
		expect((await block(plan.root)).taskJson?.status).toBe("doing");
		const [claim] = await outlineStore.getTaskClaims([plan.b]);
		expect(claim?.holderNarratorId).toBe(id);
		expect((await block(plan.a)).taskJson?.status).toBe("todo");
		// The same task blocks: nothing copied, nothing added.
		expect(await taskIds(id)).toEqual(before);

		// Continuation goes on through the plan (it counts as the person's work) in its order:
		// B done → A, free now (the tree being worked), before the unrelated to-do that comes
		// first in the document.
		await agentWrite(id, owner, [
			{ op: "setTask", block: { id: plan.b }, task: { status: "done" } },
		]);
		const source = await taskSourceForNarrator(id);
		const next = await source.prepareContinuation({ promoteTodo: true });
		expect(next.protectedOpenCount).toBeGreaterThan(0);
		expect(next.openTask?.text).toBe("Step A");
	});

	test("lock and execute: locked by the person with a delegate; the agent's step changes wait for confirmation", async () => {
		const owner = await user();
		const id = await session(owner);
		const helper = await session(owner);
		await enter(id, owner);
		const plan = await writePlan(id, owner);
		const sub = await submit(id);
		await decideOutlinePlanRequest({
			requestId: sub.requestId,
			principal: { userId: owner, isAdmin: false },
			body: {
				action: "lock",
				delegate: helper,
				seenSeq: sub.input._planSeq as number,
				compactAfter: true,
			},
		});
		expect(sub.outcome()?.behavior).toBe("allow");
		const root = await block(plan.root);
		expect(root.taskJson?.lock).toMatchObject({
			by: { kind: "human", id: owner },
			delegate: helper,
		});
		expect(root.taskJson?.plan?.state).toBe("approved");
		const approved = await settleApprovedOutlinePlan({
			narratorId: id,
			toolUseId: sub.toolUseId,
			locale: "en",
			approverUserId: owner,
			turnUserId: owner,
			byReview: false,
		});
		expect(approved?.approval).toMatchObject({ kind: "locked" });
		// Rewriting a step of the locked plan is held for confirmation.
		const held = await agentWrite(id, owner, [
			{ op: "update", block: { id: plan.c }, content: "Step C, rewritten" },
		]);
		expect(held.pending).toBeDefined();
		expect((await block(plan.c)).content).toBe("Step C");
	});

	test("return: the feedback goes under the plan, and the next version shows only what changed since", async () => {
		const owner = await user();
		const id = await session(owner);
		await enter(id, owner);
		const plan = await writePlan(id, owner);
		const sub = await submit(id);
		await decideOutlinePlanRequest({
			requestId: sub.requestId,
			principal: { userId: owner, isAdmin: false },
			body: {
				action: "return",
				feedback: "Add a rollback step",
				seenSeq: sub.input._planSeq as number,
			},
		});
		expect(sub.outcome()?.behavior).toBe("deny");
		expect(sub.outcome()?.message).toContain("Add a rollback step");
		expect(sub.outcome()?.message).toContain("STILL in plan mode");
		const root = await block(plan.root);
		expect(root.taskJson?.plan).toMatchObject({ state: "planning", round: 1 });
		const children = await outlineStore.listChildren(root.spaceId, root.id, 20);
		expect(children.at(-1)?.content).toBe("Returned (version 1): Add a rollback step");

		await agentWrite(id, owner, [
			{ op: "insert", parent: { id: plan.root }, content: "Rollback", task: { status: "todo" } },
		]);
		const second = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "en");
		const input = (second as { input: Record<string, unknown> }).input;
		expect((input._planRoot as { round: number }).round).toBe(2);
		expect((input._planDiff as { counts: Record<string, number> }).counts).toEqual({
			added: 1,
			removed: 0,
			text: 0,
			task: 0,
			moved: 0,
		});
	});

	test("409: someone else changed the plan since the version on screen; the person's own edits are fine and reach the agent", async () => {
		const owner = await user();
		const colleague = await user();
		const id = await session(owner);
		await enter(id, owner);
		const plan = await writePlan(id, owner);
		const sub = await submit(id);
		const space = await ensureSessionSpace(id);
		// The person edits during the review: allowed, and told to the agent.
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "update", block: { id: plan.c }, content: "Step C, with tests" }],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		// Someone else edits too: the decision on the version seen before is refused.
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "update", block: { id: plan.note }, content: "Decision: use the v3 API" }],
			actor: { kind: "human", id: colleague },
			responsibleUserId: colleague,
		});
		await expect(
			decideOutlinePlanRequest({
				requestId: sub.requestId,
				principal: { userId: owner, isAdmin: false },
				body: { action: "draft", seenSeq: sub.input._planSeq as number },
			}),
		).rejects.toMatchObject({ statusCode: 409, code: "OUTLINE_PLAN_CHANGED" });
		expect(sub.outcome()).toBeNull();
		expect((await block(plan.root)).taskJson?.plan?.state).toBe("planning");
		// Looked at again (the diff as of now): approved, and the agent hears what the person changed.
		const seen = await readPlanDiff({ rootId: plan.root, fromSeq: 0, toSeq: null });
		await decideOutlinePlanRequest({
			requestId: sub.requestId,
			principal: { userId: owner, isAdmin: false },
			body: { action: "draft", seenSeq: seen?.toSeq as number },
		});
		const approved = await settleApprovedOutlinePlan({
			narratorId: id,
			toolUseId: sub.toolUseId,
			locale: "en",
			approverUserId: owner,
			turnUserId: owner,
			byReview: false,
		});
		expect(approved?.edits).toContain("Step C, with tests");
		expect(approved?.edits).toContain("v3 API");
	});

	test("403 for a delegate the person may not write; a plan's own session cannot be its delegate; 404 for a request that is not an outline plan", async () => {
		const owner = await user();
		const stranger = await user();
		const id = await session(owner);
		const theirs = await session(stranger);
		await enter(id, owner);
		await writePlan(id, owner);
		const sub = await submit(id);
		await expect(
			decideOutlinePlanRequest({
				requestId: sub.requestId,
				principal: { userId: owner, isAdmin: false },
				body: { action: "lock", delegate: theirs, seenSeq: sub.input._planSeq as number },
			}),
		).rejects.toMatchObject({ statusCode: 404 });
		await expect(
			decideOutlinePlanRequest({
				requestId: sub.requestId,
				principal: { userId: owner, isAdmin: false },
				body: { action: "lock", delegate: id, seenSeq: sub.input._planSeq as number },
			}),
		).rejects.toMatchObject({ statusCode: 400 });
		await expect(
			decideOutlinePlanRequest({
				requestId: sub.requestId,
				principal: { userId: stranger, isAdmin: false },
				body: { action: "lock", seenSeq: sub.input._planSeq as number },
			}),
		).rejects.toMatchObject({ statusCode: 403 });
		expect(sub.outcome()).toBeNull();
		await expect(
			decideOutlinePlanRequest({
				requestId: `missing-${sub.requestId}`,
				principal: { userId: owner, isAdmin: false },
				body: { action: "draft", seenSeq: 0 },
			}),
		).rejects.toMatchObject({ statusCode: 404 });
	});

	test("an approval that did not come through the card is recorded as a draft on the approver's behalf", async () => {
		const owner = await user();
		const id = await session(owner);
		await enter(id, owner);
		const plan = await writePlan(id, owner);
		const sub = await submit(id);
		const approved = await settleApprovedOutlinePlan({
			narratorId: id,
			toolUseId: sub.toolUseId,
			locale: "en",
			approverUserId: null,
			turnUserId: owner,
			byReview: true,
		});
		expect(approved?.approval).toEqual({ kind: "draft" });
		expect((await block(plan.root)).taskJson?.plan).toMatchObject({
			state: "approved",
			approvedBy: { kind: "system", id: "plan-review" },
		});
		expect((await block(plan.root)).taskJson?.lock).toBeUndefined();
	});
});

describe("continuation of a tree (D48 Q2)", () => {
	test("a /goal with steps: continuation names the first step, not the goal", async () => {
		const owner = await user();
		const id = await session(owner);
		const goal = await addPersonTask({
			narratorId: id,
			userId: owner,
			text: "Release 2.0",
			lock: true,
		});
		const source = await taskSourceForNarrator(id);
		// The goal alone is a leaf: it is started and named.
		expect((await source.prepareContinuation({ promoteTodo: true })).openTask?.text).toBe(
			"Release 2.0",
		);
		await agentWrite(id, owner, [
			{
				op: "insert",
				parent: { id: goal.blockId },
				content: "Tag the build",
				task: { status: "todo" },
			},
			{
				op: "insert",
				parent: { id: goal.blockId },
				content: "Write notes",
				task: { status: "todo" },
			},
		]);
		const target = await source.prepareContinuation({ promoteTodo: true });
		expect(target.openTask?.text).toBe("Tag the build");
		expect(target.protectedOpenCount).toBe(1);
		expect(await source.currentTask()).toMatchObject({ text: "Tag the build" });
	});
});

describe("the diff against the previous version", () => {
	test("added, removed, rewritten, task fields and moves, block by block in tree order", async () => {
		const owner = await user();
		const id = await session(owner);
		await enter(id, owner);
		const plan = await writePlan(id, owner);
		const space = await ensureSessionSpace(id);
		const seq = (await outlineStore.getSpace(space.id))?.nextSeq as number;
		await agentWrite(id, owner, [
			{ op: "update", block: { id: plan.c }, content: "Step C, with tests" },
			{ op: "setTask", block: { id: plan.bob }, task: { assignee: "human:ann" } },
			{ op: "move", block: { id: plan.b }, parent: { id: plan.root } },
			{ op: "delete", block: { id: plan.note } },
			{ op: "insert", parent: { id: plan.root }, content: "Step D", task: { status: "todo" } },
		]);
		const diff = await readPlanDiff({ rootId: plan.root, fromSeq: seq - 1, toSeq: null });
		expect(diff?.counts).toEqual({ added: 1, removed: 1, text: 1, task: 1, moved: 1 });
		const byText = (text: string) =>
			diff?.entries.find((e) => e.after === text || e.before === text);
		expect(byText("Step C, with tests")).toMatchObject({
			changes: ["text"],
			before: "Step C",
			depth: 1,
		});
		expect(byText("Ask Bob for the data")?.changes).toEqual(["task"]);
		expect(byText("Ask Bob for the data")?.taskAfter?.assignee).toBe("human:ann");
		expect(byText("Step B")).toMatchObject({
			changes: ["moved"],
			parentTitle: "Ship the importer",
		});
		expect(byText("Decision: use the v2 API")).toMatchObject({
			changes: ["removed"],
			after: null,
		});
		expect(byText("Step D")?.changes).toEqual(["added"]);
		// Removed blocks come last; the rest in the order of the plan as it is now.
		expect(diff?.entries.at(-1)?.changes).toEqual(["removed"]);
		expect(diff?.truncated).toBe(false);
	});
});
