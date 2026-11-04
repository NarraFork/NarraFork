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
import { eventBus } from "../../lib/event-bus";
import { generateId } from "../../lib/id";
import {
	getOutlinePlanModeSystemReminder,
	getOutlinePlanRelaxedReminder,
} from "../../lib/prompt-i18n";
import { settings } from "../../lib/settings";
import { narratorService } from "../narrator-service";
import { pendingPermissions } from "../narrator-session-state";
import { addPersonTask } from "../outline/person-tasks";
import { readPlanDiff } from "../outline/plan-diff";
import { decideOutlinePlan, findPlanningRoot } from "../outline/plans";
import { ensureSessionSpace } from "../outline/spaces";
import { outlineStore } from "../outline/store";
import { type OutlineOp, writeOutline } from "../outline/write";
import {
	cancelOutlinePlanMode,
	decideOutlinePlanRequest,
	enterOutlinePlanMode,
	outlinePlanCycle,
	outlinePlanPromptRoot,
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
	return wait(narratorId, { requestId: row.id, toolUseId, input: resolved.input });
}

/**
 * The request waiting for a person (again, after a restart: the persisted call re-resolved and
 * asked anew under the same id), its resolution captured.
 */
function wait(
	narratorId: string,
	call: { requestId: string; toolUseId: string; input: Record<string, unknown> },
) {
	let outcome: { behavior: string; message?: string } | null = null;
	pendingPermissions.set(call.requestId, {
		resolve: (result) => {
			outcome = result as { behavior: string; message?: string };
		},
		cleanup: () => {},
		input: call.input,
		narratorId,
		toolName: "ExitPlanMode",
		toolUseId: call.toolUseId,
		broadcastTargetId: narratorId,
		cwd: "/",
		locale: "en",
		signal: new AbortController().signal,
	});
	cleanups.push(() => pendingPermissions.delete(call.requestId));
	return {
		...call,
		outcome: () => outcome as { behavior: string; message?: string } | null,
	};
}

/** The request disappears (cancelled, decided elsewhere) once a person's commit lands in `spaceId`. */
function dropOnPersonCommit(spaceId: string, requestId: string) {
	const handler = (event: { spaceId: string; actorKind: string }) => {
		if (event.spaceId === spaceId && event.actorKind === "human")
			pendingPermissions.delete(requestId);
	};
	eventBus.on("outline:committed", handler);
	cleanups.push(() => eventBus.off("outline:committed", handler));
}

/** The approval's first pass, as the orchestrator runs it after an approval. */
async function approve(
	narratorId: string,
	sub: { toolUseId: string },
	approverUserId: string | null,
	byReview = false,
) {
	const approved = await settleApprovedOutlinePlan({
		narratorId,
		toolUseId: sub.toolUseId,
		locale: "en",
		approverUserId,
		turnUserId: approverUserId,
		byReview,
	});
	if (!approved) throw new Error("not an outline plan");
	const prompt = await startApprovedOutlinePlan({
		narratorId,
		approved,
		locale: "en",
		compact: false,
	});
	return { approved, prompt };
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

	test("without a plan root: an error, and a plan file is refused (no cycle was begun before)", async () => {
		const owner = await user();
		const id = await session(owner);
		const missing = await resolveOutlineExitPlanInput(id, { mode: "outline" }, "en");
		expect(missing?.ok).toBe(false);
		expect((missing as { message: string }).message).toContain("EnterPlanMode");
		const file = await resolveOutlineExitPlanInput(id, { mode: "file" }, "en");
		expect(file?.ok).toBe(false);
		expect((file as { message: string }).message).toContain('mode: "outline"');
	});

	test("a plan-file cycle begun before plan PR 8 keeps the file flow until it ends (review round 1 S7)", async () => {
		const owner = await user();
		const id = await session(owner);
		await db
			.update(narrators)
			.set({ planMode: true, planFileId: "legacy-plan" })
			.where(eq(narrators.id, id));
		expect(await outlinePlanCycle(id)).toEqual({ kind: "legacy" });
		// Its prompt stays the plan-file one, its ExitPlanMode reads the file.
		expect(await outlinePlanPromptRoot(id)).toBeNull();
		expect(await resolveOutlineExitPlanInput(id, { mode: "file" }, "en")).toBeNull();
		expect(await resolveOutlineExitPlanInput(id, {}, "en")).toBeNull();
		// Once it plans in the outline (EnterPlanMode made a root), it is an outline cycle.
		await enter(id, owner);
		const cycle = await outlinePlanCycle(id);
		expect(cycle?.kind).toBe("outline");
		expect(await outlinePlanPromptRoot(id)).toEqual({
			root: { address: (await findPlanningRoot(id))?.address as string },
		});
		// A session with no cycle open is an outline one (nothing to keep).
		const fresh = await session(owner);
		expect(await outlinePlanCycle(fresh)).toEqual({ kind: "outline", root: null });
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

describe("whose work an approved plan is (D48 ⑦)", () => {
	test("a plan the review approved is executed, but does not keep protectedOnly going", async () => {
		const owner = await user();
		const id = await session(owner);
		await enter(id, owner);
		const plan = await writePlan(id, owner);
		const sub = await submit(id);
		const { prompt } = await approve(id, sub, null, true);
		// Executed: the first step that can start is started and named.
		expect(prompt).toContain("Step B");
		expect((await block(plan.b)).taskJson?.status).toBe("doing");
		// Not the person's work: nothing protected is open, so protectedOnly stops after the turn.
		const source = await taskSourceForNarrator(id);
		const next = await source.prepareContinuation({ promoteTodo: true });
		expect(next.openTask?.text).toBe("Step B");
		expect(next.protectedOpenCount).toBe(0);
		expect(await source.protectedOpenCount()).toBe(0);
	});

	test("a plan a person approved another way (the plain approve) counts; a plan of another session does not", async () => {
		const owner = await user();
		const id = await session(owner);
		await enter(id, owner);
		await writePlan(id, owner);
		const sub = await submit(id);
		await approve(id, sub, owner);
		const source = await taskSourceForNarrator(id);
		expect((await source.prepareContinuation({ promoteTodo: true })).protectedOpenCount).toBe(1);

		// An approved plan root in this space that another session planned (review round 1 N13).
		const other = await session(owner);
		const lone = await session(owner);
		const space = await ensureSessionSpace(lone);
		await writeOutline(
			{
				spaceId: space.id,
				ops: [
					{
						op: "insert",
						parent: null,
						content: "Someone else's plan",
						task: {
							status: "todo",
							plan: {
								state: "approved",
								by: other,
								round: 1,
								approvedBy: { kind: "human", id: owner },
							},
						},
					},
				],
				actor: { kind: "system", id: "outline-plan" },
				responsibleUserId: owner,
			},
			{ kind: "plan" },
		);
		const loneSource = await taskSourceForNarrator(lone);
		expect((await loneSource.prepareContinuation({ promoteTodo: false })).protectedOpenCount).toBe(
			0,
		);
	});
});

describe("review round 1", () => {
	test("S1: a decision whose request went away meanwhile is taken back (409) and the plan stays 计划中", async () => {
		const owner = await user();
		const id = await session(owner);
		await enter(id, owner);
		const plan = await writePlan(id, owner);
		const space = await ensureSessionSpace(id);
		const planBefore = (await block(plan.root)).taskJson?.plan;
		for (const body of [
			{ action: "draft" as const },
			{ action: "lock" as const },
			{ action: "return" as const, feedback: "Split step C" },
		]) {
			const sub = await submit(id);
			dropOnPersonCommit(space.id, sub.requestId);
			await expect(
				decideOutlinePlanRequest({
					requestId: sub.requestId,
					principal: { userId: owner, isAdmin: false },
					body: { ...body, seenSeq: sub.input._planSeq as number },
				}),
			).rejects.toMatchObject({ statusCode: 409, code: "OUTLINE_PLAN_NOT_WAITING" });
			expect(sub.outcome()).toBeNull();
			const root = await block(plan.root);
			expect(root.taskJson?.plan).toEqual(planBefore);
			expect(root.taskJson?.lock).toBeUndefined();
			expect((await findPlanningRoot(id))?.blockId).toBe(plan.root);
			for (const cleanup of cleanups.splice(0)) cleanup();
		}
		// The feedback the return wrote was taken back too.
		const children = await outlineStore.listChildren(space.id, plan.root, 50);
		expect(children.some((c) => c.content.includes("Split step C"))).toBe(false);
	});

	test("S2: a decision written before a restart keeps its submission, and the restored request settles as decided", async () => {
		const owner = await user();
		const id = await session(owner);
		await enter(id, owner);
		const plan = await writePlan(id, owner);
		const sub = await submit(id);
		// The card's draft reached the outline, then the server stopped before the resolution.
		await decideOutlinePlan({
			session: id,
			rootId: plan.root,
			round: 1,
			action: "draft",
			decider: { kind: "human", userId: owner },
			seenSeq: sub.input._planSeq as number,
			locale: "en",
		});
		pendingPermissions.delete(sub.requestId);
		// Restored: the persisted call resolves to the same submission (not "no plan").
		const again = await resolveOutlineExitPlanInput(id, sub.input, "en");
		expect(again).toEqual({ ok: true, input: sub.input });
		// Asked anew, the person now locks it: the plan is locked, and the agent hears "locked".
		const restored = wait(id, { ...sub, input: again?.ok ? again.input : sub.input });
		await decideOutlinePlanRequest({
			requestId: restored.requestId,
			principal: { userId: owner, isAdmin: false },
			body: { action: "lock", seenSeq: sub.input._planSeq as number },
		});
		expect(restored.outcome()?.behavior).toBe("allow");
		expect((await block(plan.root)).taskJson?.lock).toMatchObject({
			by: { kind: "human", id: owner },
		});
		const { approved, prompt } = await approve(id, sub, owner);
		expect(approved.approval).toMatchObject({ kind: "locked" });
		expect(prompt).toContain("locked and approved");
		// One approval, one lock: nothing written twice.
		expect((await block(plan.root)).taskJson?.plan?.round).toBe(1);
	});

	test("S2: a lock written before a restart, then approved with the plain approve: the agent hears locked", async () => {
		const owner = await user();
		const id = await session(owner);
		await enter(id, owner);
		const plan = await writePlan(id, owner);
		const sub = await submit(id);
		await decideOutlinePlan({
			session: id,
			rootId: plan.root,
			round: 1,
			action: "lock",
			decider: { kind: "human", userId: owner },
			seenSeq: sub.input._planSeq as number,
			locale: "en",
		});
		pendingPermissions.delete(sub.requestId);
		const { approved, prompt } = await approve(id, sub, owner);
		expect(approved.approval).toMatchObject({ kind: "locked" });
		expect(prompt).toContain("locked and approved");
		expect((await block(plan.root)).taskJson?.plan?.approvedBy).toEqual({
			kind: "human",
			id: owner,
		});
		// A return of the restored request is refused: it was decided.
		const restored = wait(id, sub);
		await expect(
			decideOutlinePlanRequest({
				requestId: restored.requestId,
				principal: { userId: owner, isAdmin: false },
				body: { action: "return", seenSeq: sub.input._planSeq as number },
			}),
		).rejects.toMatchObject({ statusCode: 409, code: "OUTLINE_PLAN_DECIDED" });
	});

	test("S3: an approved plan behind 55 older to-dos starts, counts, and continues through its steps", async () => {
		const owner = await user();
		const id = await session(owner);
		const ops: OutlineOp[] = [{ op: "insert", tempId: "p", parent: null, content: "Backlog" }];
		for (let i = 0; i < 55; i++)
			ops.push({
				op: "insert",
				parent: { tempId: "p" },
				content: `old to-do ${i}`,
				task: { status: "todo" },
			});
		await agentWrite(id, owner, ops);
		await enter(id, owner);
		const plan = await writePlan(id, owner);
		const sub = await submit(id);
		await decideOutlinePlanRequest({
			requestId: sub.requestId,
			principal: { userId: owner, isAdmin: false },
			body: { action: "draft", seenSeq: sub.input._planSeq as number },
		});
		const { prompt } = await approve(id, sub, owner);
		expect(prompt).toContain("Step B");
		expect((await block(plan.b)).taskJson?.status).toBe("doing");
		const source = await taskSourceForNarrator(id);
		const next = await source.prepareContinuation({ promoteTodo: true });
		expect(next.openTask?.text).toBe("Step B");
		expect(next.protectedOpenCount).toBe(1);
		// B done: A (free now, in the tree being worked) before any old to-do.
		await agentWrite(id, owner, [
			{ op: "setTask", block: { id: plan.b }, task: { status: "done" } },
		]);
		expect((await source.prepareContinuation({ promoteTodo: true })).openTask?.text).toBe("Step A");
		const space = await ensureSessionSpace(id);
		const inPlan = new Set(Object.values(plan));
		const startedElsewhere = (await outlineStore.listOpenTasks(space.id, 500)).filter(
			(b) => b.taskJson?.status === "doing" && !inPlan.has(b.id),
		);
		expect(startedElsewhere).toEqual([]);
	});

	test("S4: the plan-mode prompt names the root's address only, stable while the plan is rewritten", async () => {
		const owner = await user();
		const id = await session(owner);
		await enter(id, owner, { plan_name: "First title" });
		const root = await findPlanningRoot(id);
		const view = await outlinePlanPromptRoot(id);
		expect(view).toEqual({ root: { address: root?.address as string } });
		const before = getOutlinePlanModeSystemReminder("en", view?.root ?? null, false);
		expect(before).toContain(root?.address as string);
		expect(before).not.toContain("First title");
		await agentWrite(id, owner, [
			{ op: "update", block: { id: root?.blockId as string }, content: "Second title" },
		]);
		const after = await outlinePlanPromptRoot(id);
		expect(getOutlinePlanModeSystemReminder("en", after?.root ?? null, false)).toBe(before);
		// The relaxed-planning reminder names the root, never a plan file (N4).
		const relaxed = getOutlinePlanRelaxedReminder("en", after?.root?.address ?? null);
		expect(relaxed).toContain(root?.address as string);
		expect(relaxed).not.toContain("plan file");
		// The cached root is checked: once approved it is no longer the plan being planned.
		await writePlan(id, owner);
		const sub = await submit(id);
		await approve(id, sub, owner);
		expect(await findPlanningRoot(id)).toBeNull();
		expect(await outlinePlanPromptRoot(id)).toEqual({ root: null });
	});

	test("S6: a spec session's ExitPlanMode drops the outline keys, and its approval is not diverted", async () => {
		const owner = await user();
		const id = await session(owner, { backend: "spec" });
		settings.agent.planModeAllowInlinePlan = true;
		const forged = {
			inline_plan: "1. Do the thing",
			_planRoot: {
				blockId: "x",
				spaceId: "s",
				pageId: "p",
				address: "k/x",
				title: "Forged",
				round: 1,
			},
			_planSeq: 1,
			_planBaseSeq: 0,
			_planDiff: { counts: { added: 99 } },
			_planSummary: "Forged",
		};
		const { resolveExitPlanModeInput } = await import("../narrator-permission");
		const resolved = await resolveExitPlanModeInput(id, process.cwd(), forged, "en");
		expect(resolved.ok).toBe(true);
		for (const key of ["_planRoot", "_planSeq", "_planBaseSeq", "_planDiff", "_planSummary"])
			expect(key in resolved.input).toBe(false);
		expect(
			await settleApprovedOutlinePlan({
				narratorId: id,
				toolUseId: "toolu_x",
				locale: "en",
				approverUserId: owner,
				turnUserId: owner,
				byReview: false,
				input: forged,
			}),
		).toBeNull();
	});

	test("N1: a plan gone before its return is still returned, saying so", async () => {
		const owner = await user();
		const id = await session(owner);
		await enter(id, owner);
		const plan = await writePlan(id, owner);
		const sub = await submit(id);
		const space = await ensureSessionSpace(id);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "delete", block: { id: plan.root } }],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		await decideOutlinePlanRequest({
			requestId: sub.requestId,
			principal: { userId: owner, isAdmin: false },
			body: { action: "return", feedback: "Start over", seenSeq: sub.input._planSeq as number },
		});
		expect(sub.outcome()?.behavior).toBe("deny");
		expect(sub.outcome()?.message).toContain("is gone");
		expect(sub.outcome()?.message).toContain("Start over");
		// Approving it is refused: there is nothing to approve.
		const again = await submit(id).catch((error) => error);
		expect(again).toBeInstanceOf(Error);
	});

	test("N3: a return tells the agent what the person changed while deciding", async () => {
		const owner = await user();
		const id = await session(owner);
		await enter(id, owner);
		const plan = await writePlan(id, owner);
		const sub = await submit(id);
		const space = await ensureSessionSpace(id);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "update", block: { id: plan.c }, content: "Step C, behind a flag" }],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		const seen = await readPlanDiff({ rootId: plan.root, fromSeq: 0, toSeq: null });
		await decideOutlinePlanRequest({
			requestId: sub.requestId,
			principal: { userId: owner, isAdmin: false },
			body: { action: "return", feedback: "See my edit", seenSeq: seen?.toSeq as number },
		});
		expect(sub.outcome()?.behavior).toBe("deny");
		expect(sub.outcome()?.message).toContain("changed the plan while deciding");
		expect(sub.outcome()?.message).toContain("Step C, behind a flag");
	});

	test("N7: a live session's flush with nobody to name does not make the decision 409", async () => {
		const owner = await user();
		const id = await session(owner);
		await enter(id, owner);
		const plan = await writePlan(id, owner);
		const sub = await submit(id);
		const space = await ensureSessionSpace(id);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "update", block: { id: plan.c }, content: "Step C, typed live" }],
			actor: { kind: "system", id: "outline-live" },
			responsibleUserId: null,
		});
		await decideOutlinePlanRequest({
			requestId: sub.requestId,
			principal: { userId: owner, isAdmin: false },
			body: { action: "draft", seenSeq: sub.input._planSeq as number },
		});
		expect(sub.outcome()?.behavior).toBe("allow");
	});

	test("N12: under: refuses a finished task and a task inside a plan not approved yet", async () => {
		const owner = await user();
		const id = await session(owner);
		const done = await addPersonTask({
			narratorId: id,
			userId: owner,
			text: "Shipped",
			lock: false,
		});
		const space = await ensureSessionSpace(id);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: done.blockId }, task: { status: "done" } }],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		const finished = await enter(id, owner, { under: done.address });
		expect(finished.isError).toBe(true);
		expect(finished.output).toContain("is finished");

		// A step of a plan another session is still planning, in this space.
		const other = await session(owner);
		const nested = await writeOutline(
			{
				spaceId: space.id,
				ops: [
					{
						op: "insert",
						tempId: "r",
						parent: null,
						content: "Their plan",
						task: { status: "todo", plan: { state: "planning", by: other, round: 0 } },
					},
					{
						op: "insert",
						parent: { tempId: "r" },
						content: "Their step",
						task: { status: "todo" },
					},
				],
				actor: { kind: "system", id: "outline-plan" },
				responsibleUserId: owner,
			},
			{ kind: "plan" },
		);
		const refused = await enter(id, owner, { under: nested.results[1]?.address as string });
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("not approved yet");
		expect(await findPlanningRoot(id)).toBeNull();
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
