/**
 * The task board's 「转交给会话」 and 「转交并开始」 (outline P2 PR 10a, design §E.1), through the
 * routes: the hand-over is the person's commit and by itself starts nothing (the session is told
 * by a system row, without a wake); 「…并开始」 starts the session it was handed to, on that task,
 * claimed for it by the system start first, but only when the session would continue on it
 * (decided before anything is claimed: idle, not in plan mode, its continuation mode), and only
 * for someone who may write that session. A model stand-in answers the turn (the provider module
 * is replaced for this file, as in `outline-board-start.test.ts`).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; each case makes its own sessions.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { modelInputText, requestInput, rowsAsHistory } from "../../../tests/fixtures/model-input";
import { aclGrants, narrators, users } from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import { AppError } from "../../lib/errors";

const { db } = await import("../../db");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");

// Bun's mock.module is process-wide; the real module is put back after this file.
const realProviderModule = { ...(await import("../../lib/agent/provider")) };
const providerInputs: string[] = [];
/** What the model stand-in does in a turn besides replying (its tool calls, in effect). */
let onTurn: (() => Promise<void>) | null = null;
const testProvider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: rowsAsHistory,
	injectSystemPrompt: () => {},
	async *chat(params) {
		providerInputs.push(`${modelInputText(params as never)}\n${requestInput(params)}`);
		params.onRequestStart?.();
		await onTurn?.();
		yield { text: "task turn ran" };
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
mock.module("../../lib/agent/provider", () => ({
	getProvider: () => testProvider,
	resolveProviderAndModel: () => ({
		requestedProvider: "openai",
		requestedModel: "openai:test-model",
		provider: "openai",
		adapter: testProvider,
		model: "test-model",
	}),
}));

const { outlineRoutes } = await import("../../routes/outline");
const { settings } = await import("../../lib/settings");
const { generateId } = await import("../../lib/id");
const { closeNarrator } = await import("../narrator-session");
const { outlineStore } = await import("../outline/store");
const { writeOutline } = await import("../outline/write");
const { OUTLINE_TASK_START_ACTOR } = await import("../task-source/outline");
const { invalidateTaskBackend } = await import("../task-source");
const { resetOutlineTaskEditsForTests } = await import("../outline-task-edits");

const { ensureProjectSpace, ensureSessionSpace } = await import("../outline/spaces");
const { projects, narratorMessageRefs, narratorMessages } = await import("../../db/schema");
const { sqlite } = await import("../../db");
const { readTestMessageContent } = await import("../../../tests/setup");
const { startOutlineTeamEvents, settleOutlineTeamEventsForTests, OUTLINE_TEAM_SOURCE } =
	await import("../outline/team-events");
const { invalidateSessionReadScopes } = await import("../outline/session-scope");
const { outlineRunEndsSettled } = await import("../outline/lease-keeper");
const { isHandoffBlockId, OUTLINE_HANDOFF_ACTOR } = await import("../outline/handoff");
const { OUTLINE_TASK_GRACE_LEASE_MS } = await import("../outline/model");
// A run's end asks whether anything still works for the session in the background.
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
await backgroundOccupancyStore.start();

const NOW = "2026-11-10T00:00:00.000Z";

afterAll(async () => {
	await closePrefixSnapshotStore();
	mock.module("../../lib/agent/provider", () => realProviderModule);
	mock.restore();
});

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
	resetOutlineTaskEditsForTests();
	invalidateSessionReadScopes();
	startOutlineTeamEvents();
	providerInputs.length = 0;
	onTurn = null;
});

async function person(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `start${id.replace(/[^A-Za-z0-9]/g, "")}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	return id;
}

async function session(
	owner: string,
	projectId: string,
	options: {
		status?: "idle" | "working";
		traits?: string[];
		continuation?: "off" | "protectedOnly" | "always";
		title?: string;
	} = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		title: options.title ?? "Target",
		traits: options.traits ?? ["standalone"],
		model: "openai:test-model",
		permissionMode: "bypassPermissions",
		autoContinuationOverride: options.continuation ?? "off",
		contextProjectId: projectId,
		status: options.status ?? "idle",
		taskBackend: "outline",
		ownerUserId: owner,
		visibility: "private",
		cwd: process.cwd(),
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

function call(userId: string, method: string, path: string, body?: unknown) {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.onError((error) => {
		const status = error instanceof AppError ? error.statusCode : 500;
		return new Response(JSON.stringify({ error: error.message }), { status });
	});
	instance.route("/outline", outlineRoutes);
	return instance.request(`http://localhost${path}`, {
		method,
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function waitIdleAfterTurns(narratorId: string, turns: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { status: true },
		});
		if (providerInputs.length >= turns && row?.status === "idle") return;
		await Bun.sleep(10);
	}
	throw new Error("timed out");
}

async function startedBy(blockId: string) {
	const [claim] = await outlineStore.getTaskClaims([blockId]);
	const versions = await outlineStore.listBlockVersions(blockId, 20);
	const last = versions.at(-1);
	const commit = last ? await outlineStore.getCommit(last.commitId) : null;
	return { holder: claim?.holderNarratorId ?? null, actor: commit?.actorId ?? null };
}

async function world() {
	const owner = await person();
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: `board-transfer-${projectId}`,
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	const space = await ensureProjectSpace(projectId);
	return { owner, projectId, space };
}

/** A project task a person wrote; `humanCreated` as the board's form marks one. */
async function projectTask(
	spaceId: string,
	owner: string,
	title: string,
	options: { humanCreated?: boolean } = {},
) {
	const written = await writeOutline({
		spaceId,
		ops: [
			{
				op: "insert",
				parent: null,
				content: title,
				task: { status: "todo", ...(options.humanCreated ? { humanCreated: true } : {}) },
			},
		],
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	const task = written.results[0] as { blockId: string; sid: string; address: string };
	const block = await outlineStore.getBlock(task.blockId);
	return { ...task, versionSeq: block?.versionSeq as number };
}

async function teamRows(narratorId: string): Promise<string[]> {
	await settleOutlineTeamEventsForTests();
	const rows = await db
		.select({ id: narratorMessages.id })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId));
	return rows.flatMap((row) =>
		readTestMessageContent(sqlite, row.id)
			.filter((b) => b.type === "system_injection" && b.source === OUTLINE_TEAM_SOURCE)
			.map((b) => String(b.modelText)),
	);
}

const state = async (blockId: string) => {
	const [claim] = await outlineStore.getTaskClaims([blockId]);
	const task = (await outlineStore.getBlock(blockId))?.taskJson;
	return {
		status: task?.status,
		assignee: task?.assignee ?? null,
		holder: claim?.holderNarratorId ?? null,
		epoch: claim?.epoch ?? 0,
	};
};

const transfer = (userId: string, task: { blockId: string; versionSeq: number }, body: object) =>
	call(userId, "PATCH", `/outline/tasks/${task.blockId}`, {
		baseVersionSeq: task.versionSeq,
		...body,
	});

describe("转交给会话", () => {
	test("the hand-over is written, the session is told by a system row, and nothing is started", async () => {
		const { owner, projectId, space } = await world();
		const target = await session(owner, projectId);
		const task = await projectTask(space.id, owner, "Tidy the changelog");
		const listed = await call(owner, "GET", `/outline/tasks/${task.blockId}/transfer-sessions`);
		expect(listed.status).toBe(200);
		expect(await listed.json()).toMatchObject({ sessions: [{ narratorId: target }] });
		const response = await transfer(owner, task, {
			assign: { kind: "narrator", narratorId: target },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ started: false });
		expect(await state(task.blockId)).toEqual({
			status: "todo",
			assignee: `agent:${target}`,
			holder: null,
			epoch: 0,
		});
		const [row, ...rest] = await teamRows(target);
		expect(rest).toEqual([]);
		expect(row).toContain(`\`${task.address}\` Tidy the changelog`);
		// A person's commit records and wakes nobody.
		expect(providerInputs).toHaveLength(0);
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, target),
			columns: { status: true },
		});
		expect(narrator?.status).toBe("idle");
	});

	test("a session the person cannot read is not found, and nothing changes", async () => {
		const { owner, projectId, space } = await world();
		const stranger = await person();
		const hidden = await session(stranger, projectId);
		const task = await projectTask(space.id, owner, "Not for them");
		const response = await transfer(owner, task, {
			assign: { kind: "narrator", narratorId: hidden },
		});
		expect(response.status).toBe(404);
		expect((await state(task.blockId)).assignee).toBeNull();
	});
});

describe("转交并开始", () => {
	test("starts the session on the task: claimed for it first (generation 1), named by the turn, which reads the hand-over row; continuation off starts once", async () => {
		const { owner, projectId, space } = await world();
		const target = await session(owner, projectId, { continuation: "off" });
		const task = await projectTask(space.id, owner, "Fix the flaky test");
		const response = await transfer(owner, task, {
			assign: { kind: "narrator", narratorId: target },
			start: true,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ versionSeq: expect.any(Number), started: true });
		await waitIdleAfterTurns(target, 1);
		expect(await state(task.blockId)).toEqual({
			status: "doing",
			assignee: `agent:${target}`,
			holder: target,
			epoch: 1,
		});
		expect(await startedBy(task.blockId)).toEqual({
			holder: target,
			actor: OUTLINE_TASK_START_ACTOR,
		});
		expect(providerInputs[0]).toContain(task.address);
		// The row that tells it who handed the task over was written before the turn read history.
		expect(providerInputs[0]).toContain("Assigned to this session by");
		expect(providerInputs).toHaveLength(1);
		closeNarrator(target);
	});

	test("a task with steps under it: the task is claimed for the session, and its first step is started for it too", async () => {
		const { owner, projectId, space } = await world();
		const target = await session(owner, projectId);
		const written = await writeOutline({
			spaceId: space.id,
			ops: [
				{
					op: "insert",
					tempId: "goal",
					parent: null,
					content: "Ship the importer",
					task: { status: "todo" },
				},
				{
					op: "insert",
					parent: { tempId: "goal" },
					content: "Parse the file",
					task: { status: "todo" },
				},
				{
					op: "insert",
					parent: { tempId: "goal" },
					content: "Write the rows",
					task: { status: "todo" },
				},
			],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		const [goal, first, second] = written.results as Array<{ blockId: string; address: string }>;
		if (!goal || !first || !second) throw new Error("seed");
		const block = await outlineStore.getBlock(goal.blockId);
		const response = await transfer(
			owner,
			{ blockId: goal.blockId, versionSeq: block?.versionSeq as number },
			{ assign: { kind: "narrator", narratorId: target }, start: true },
		);
		expect(await response.json()).toMatchObject({ started: true });
		await waitIdleAfterTurns(target, 1);
		expect(await state(goal.blockId)).toMatchObject({ status: "doing", holder: target });
		// The continuation names the first step that can start, started for the session as well.
		expect(await state(first.blockId)).toMatchObject({ status: "doing", holder: target });
		expect((await state(second.blockId)).status).toBe("todo");
		expect(providerInputs[0]).toContain(first.address);
		closeNarrator(target);
	});

	test("a task another session was doing: its work ends in the person's commit, and the session started claims the next generation", async () => {
		const { owner, projectId, space } = await world();
		const previous = await session(owner, projectId, { title: "Previous" });
		const target = await session(owner, projectId);
		const task = await projectTask(space.id, owner, "Half done");
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } }],
			actor: { kind: "agent", id: previous },
			narratorId: previous,
			responsibleUserId: owner,
		});
		expect(await state(task.blockId)).toMatchObject({ holder: previous, epoch: 1 });
		const now = await outlineStore.getBlock(task.blockId);
		const response = await transfer(
			owner,
			{ blockId: task.blockId, versionSeq: now?.versionSeq as number },
			{ assign: { kind: "narrator", narratorId: target }, start: true },
		);
		expect(await response.json()).toMatchObject({ started: true });
		await waitIdleAfterTurns(target, 1);
		expect(await state(task.blockId)).toMatchObject({
			status: "doing",
			holder: target,
			epoch: 2,
		});
		closeNarrator(target);
	});

	test("not started, and nothing claimed, when the session would not continue on it: running, plan mode, or protectedOnly with no work of a person", async () => {
		const { owner, projectId, space } = await world();
		for (const [options, reason] of [
			[{ status: "working" as const }, "busy"],
			[{ traits: ["standalone", "plan"] as string[] }, "plan_mode"],
			[{ continuation: "protectedOnly" as const }, "continuation_mode"],
		] as const) {
			const target = await session(owner, projectId, options);
			const task = await projectTask(space.id, owner, `Not now (${reason})`);
			const response = await transfer(owner, task, {
				assign: { kind: "narrator", narratorId: target },
				start: true,
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ started: false, notStarted: reason });
			// The hand-over stands; the task was never put in progress for a session that does
			// not run.
			expect(await state(task.blockId)).toEqual({
				status: "todo",
				assignee: `agent:${target}`,
				holder: null,
				epoch: 0,
			});
			const versions = await outlineStore.listBlockVersions(task.blockId, 20);
			expect(versions.some((v) => v.taskJson?.status === "doing")).toBe(false);
		}
		expect(providerInputs).toHaveLength(0);
	});

	test("protectedOnly continues on a task a person created: started", async () => {
		const { owner, projectId, space } = await world();
		const target = await session(owner, projectId, { continuation: "protectedOnly" });
		const task = await projectTask(space.id, owner, "A person's goal", { humanCreated: true });
		const response = await transfer(owner, task, {
			assign: { kind: "narrator", narratorId: target },
			start: true,
		});
		expect(await response.json()).toMatchObject({ started: true });
		await waitIdleAfterTurns(target, 1);
		expect(await state(task.blockId)).toMatchObject({ status: "doing", holder: target });
		closeNarrator(target);
	});

	test("someone who may only read the session cannot start it: refused before anything changes", async () => {
		const { owner, projectId, space } = await world();
		const other = await person();
		const target = await session(other, projectId);
		for (const [scopeType, scopeId, capability] of [
			["narrator", target, "read"],
			["project", projectId, "write"],
		] as const)
			await db.insert(aclGrants).values({
				id: generateId(),
				scopeType,
				scopeId,
				principalType: "user",
				principalId: scopeType === "narrator" ? owner : other,
				capability,
				createdAt: NOW,
			});
		const task = await projectTask(space.id, owner, "Theirs to start");
		const response = await transfer(owner, task, {
			assign: { kind: "narrator", narratorId: target },
			start: true,
		});
		expect(response.status).toBe(403);
		expect(await state(task.blockId)).toMatchObject({ status: "todo", assignee: null });
		expect(providerInputs).toHaveLength(0);
		// Without the start, the hand-over itself is theirs to make.
		const plain = await transfer(owner, task, {
			assign: { kind: "narrator", narratorId: target },
		});
		expect(plain.status).toBe(200);
		expect((await state(task.blockId)).assignee).toBe(`agent:${target}`);
	});
});

describe("a handed-over task the session does not finish (outline P2 PR 10c-2)", () => {
	const handoffsUnder = async (spaceId: string, blockId: string) =>
		(await outlineStore.listChildren(spaceId, blockId, 50)).filter((child) =>
			isHandoffBlockId(child.id),
		);

	test("「转交并开始」: a person picked this session, so its turn's end keeps the task for an hour, assignment intact", async () => {
		const { owner, projectId, space } = await world();
		const target = await session(owner, projectId, { continuation: "off" });
		const task = await projectTask(space.id, owner, "Fix the flaky test");
		const before = Date.now();
		const response = await transfer(owner, task, {
			assign: { kind: "narrator", narratorId: target },
			start: true,
		});
		expect(await response.json()).toMatchObject({ started: true });
		await waitIdleAfterTurns(target, 1);
		await outlineRunEndsSettled(target);
		expect(await state(task.blockId)).toEqual({
			status: "doing",
			assignee: `agent:${target}`,
			holder: target,
			epoch: 1,
		});
		const [claim] = await outlineStore.getTaskClaims([task.blockId]);
		const lease = Date.parse(claim?.expiresAt as string) - before;
		expect(lease).toBeGreaterThan(OUTLINE_TASK_GRACE_LEASE_MS - 5 * 60_000);
		expect(lease).toBeLessThan(OUTLINE_TASK_GRACE_LEASE_MS + 5 * 60_000);
		expect(await handoffsUnder(space.id, task.blockId)).toHaveLength(0);
		closeNarrator(target);
	});

	test("an agent hands it over, the session is woken, takes it and ends its turn unfinished: given back at once, unassigned, with a handoff that tells and wakes nobody", async () => {
		const { owner, projectId, space } = await world();
		const giver = await session(owner, projectId, { title: "Giver" });
		const target = await session(owner, projectId, { continuation: "off" });
		const task = await projectTask(space.id, owner, "Tidy the changelog");
		onTurn = async () => {
			if ((await state(task.blockId)).holder === target) return;
			await writeOutline({
				spaceId: space.id,
				ops: [{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } }],
				actor: { kind: "agent", id: target },
				narratorId: target,
				responsibleUserId: owner,
			});
		};
		// An agent's hand-over (its own commit): the session is told and woken.
		await writeOutline({
			spaceId: space.id,
			ops: [
				{
					op: "setTask",
					block: { id: task.blockId },
					task: { assignee: `agent:${target}` },
				},
			],
			actor: { kind: "agent", id: giver },
			narratorId: giver,
			responsibleUserId: owner,
		});
		await settleOutlineTeamEventsForTests();
		await waitIdleAfterTurns(target, 1);
		await outlineRunEndsSettled(target);
		expect(await state(task.blockId)).toEqual({
			status: "todo",
			assignee: null,
			holder: null,
			epoch: 1,
		});
		expect(await handoffsUnder(space.id, task.blockId)).toHaveLength(1);
		const block = await outlineStore.getBlock(task.blockId);
		const [commit] = await outlineStore.getCommitsBySeqs(space.id, [block?.versionSeq as number]);
		expect(commit).toMatchObject({ actorKind: "system", actorId: OUTLINE_HANDOFF_ACTOR });
		// The release is the system's bookkeeping: no team row for anyone, no turn for anyone.
		const told = { giver: await teamRows(giver), target: await teamRows(target) };
		expect(told.giver).toEqual([]);
		expect(told.target).toHaveLength(1);
		await Bun.sleep(50);
		await settleOutlineTeamEventsForTests();
		expect(providerInputs).toHaveLength(1);
		for (const id of [giver, target]) {
			const row = await db.query.narrators.findFirst({
				where: eq(narrators.id, id),
				columns: { status: true },
			});
			expect(row?.status).toBe("idle");
		}
		closeNarrator(target);
	});
});

describe("交出去 through the board's route (outline P2 PR 10c-3)", () => {
	/** A to-do of `narratorId`'s own space, written by that session. */
	async function sessionTask(narratorId: string, owner: string, title: string) {
		const space = await ensureSessionSpace(narratorId);
		const written = await writeOutline({
			spaceId: space.id,
			ops: [{ op: "insert", parent: null, content: title, task: { status: "todo" } }],
			actor: { kind: "agent", id: narratorId },
			narratorId,
			responsibleUserId: owner,
		});
		const task = written.results[0] as { blockId: string; sid: string };
		return {
			...task,
			versionSeq: (await outlineStore.getBlock(task.blockId))?.versionSeq as number,
		};
	}

	test("「交给团队」: the copy's address in the answer, the task waits for it, nothing is started; refusals carry their reason", async () => {
		const { owner, projectId } = await world();
		const main = await session(owner, projectId, { title: "Main" });
		const task = await sessionTask(main, owner, "Write the migration");
		const response = await transfer(owner, task, { assign: { kind: "team" }, start: true });
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			started: boolean;
			versionSeq: number;
			handedOut: { copyId: string; address: string };
		};
		expect(body.started).toBe(false);
		expect(body.versionSeq).toBe((await outlineStore.getBlock(task.blockId))?.versionSeq as number);
		expect((await outlineStore.getBlock(task.blockId))?.taskJson?.depends).toEqual([
			{ target: body.handedOut.address, label: null },
		]);
		expect(await state(body.handedOut.copyId)).toMatchObject({ status: "todo", holder: null });
		expect(providerInputs).toHaveLength(0);

		// Someone else who may write the session is not its owner: 403.
		const mate = await person();
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "narrator",
			scopeId: main,
			principalType: "user",
			principalId: mate,
			capability: "write",
			createdAt: NOW,
		});
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId: mate,
			capability: "write",
			createdAt: NOW,
		});
		const other = await sessionTask(main, owner, "Not theirs to give");
		const notOwner = await transfer(mate, other, { assign: { kind: "team" } });
		expect(notOwner.status).toBe(403);
		expect(await notOwner.text()).toContain("Only the session's owner");
		// A session of no project: 409, nothing written.
		const loner = await session(owner, projectId, { title: "Loner" });
		await db.update(narrators).set({ contextProjectId: null }).where(eq(narrators.id, loner));
		const lonely = await sessionTask(loner, owner, "Nowhere to go");
		const noProject = await transfer(owner, lonely, { assign: { kind: "team" } });
		expect(noProject.status).toBe(409);
		expect(await noProject.text()).toContain("The session belongs to no project");
		expect((await outlineStore.getBlock(lonely.blockId))?.taskJson?.depends).toBeUndefined();
	});

	test("「转交并开始」 on a session's task: the other session starts on the copy, and the original waits", async () => {
		const { owner, projectId } = await world();
		const main = await session(owner, projectId, { title: "Main" });
		const target = await session(owner, projectId, { continuation: "off", title: "Target" });
		const task = await sessionTask(main, owner, "Profile the importer");
		const listed = await call(owner, "GET", `/outline/tasks/${task.blockId}/transfer-sessions`);
		expect(await listed.json()).toMatchObject({ sessions: [{ narratorId: target }] });
		const response = await transfer(owner, task, {
			assign: { kind: "narrator", narratorId: target },
			start: true,
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			started: boolean;
			handedOut: { copyId: string; address: string };
		};
		expect(body.started).toBe(true);
		await waitIdleAfterTurns(target, 1);
		expect(await state(body.handedOut.copyId)).toMatchObject({
			assignee: `agent:${target}`,
			holder: target,
			epoch: 1,
		});
		expect(providerInputs[0]).toContain(body.handedOut.address);
		expect(await state(task.blockId)).toMatchObject({ status: "todo", holder: null });
		closeNarrator(target);
		// Leave no claim on a lease behind (other files' lease-expiry cases scan them all).
		const copy = await outlineStore.getBlock(body.handedOut.copyId);
		await writeOutline({
			spaceId: copy?.spaceId as string,
			ops: [{ op: "setTask", block: { id: body.handedOut.copyId }, task: { status: "done" } }],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
	});
});
