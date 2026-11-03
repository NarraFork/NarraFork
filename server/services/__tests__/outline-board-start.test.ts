/**
 * The task board's "Add and start" and "Reopen and start" (outline P2 PR 5, owner Q5; review round
 * 1 S4 and B1): the session starts on THE task the person acted on, claimed for it through the
 * system start (`outline-task-start`) before the turn, whose prompt names it, also with
 * continuation off and with an earlier to-do or another task in progress; when that task cannot
 * be started, the session is not. Only someone who may write the session starts it: a reader is
 * refused before anything changes. A model stand-in answers the turn (the provider module is
 * replaced for this file, as in `outline-goal-start.test.ts`).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; each case makes its own session.
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
const testProvider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: rowsAsHistory,
	injectSystemPrompt: () => {},
	async *chat(params) {
		providerInputs.push(`${modelInputText(params as never)}\n${requestInput(params)}`);
		params.onRequestStart?.();
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
const { ensureSessionSpace } = await import("../outline/spaces");
const { writeOutline } = await import("../outline/write");
const { OUTLINE_TASK_START_ACTOR } = await import("../task-source/outline");
const { invalidateTaskBackend } = await import("../task-source");
const { resetOutlineTaskEditsForTests } = await import("../outline-task-edits");

const NOW = "2026-11-03T00:00:00.000Z";

afterAll(async () => {
	await closePrefixSnapshotStore();
	mock.module("../../lib/agent/provider", () => realProviderModule);
	mock.restore();
});

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
	resetOutlineTaskEditsForTests();
	providerInputs.length = 0;
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

async function session(owner: string, status: "idle" | "working" = "idle"): Promise<string> {
	const id = `board-start-${crypto.randomUUID()}`;
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "openai:test-model",
		permissionMode: "bypassPermissions",
		autoContinuationOverride: "off",
		status,
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

/** An agent's own to-do on a page before the task page (review round 1, P9), and its page. */
async function earlierTodo(narratorId: string, owner: string, status: "todo" | "doing" = "todo") {
	const space = await ensureSessionSpace(narratorId);
	const written = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Earlier work" },
			{ op: "insert", parent: { tempId: "p" }, content: "Old step", task: { status } },
		],
		actor: { kind: "agent", id: narratorId },
		narratorId,
		responsibleUserId: owner,
	});
	return { space, old: written.results[1] as { blockId: string; sid: string } };
}

async function startedBy(blockId: string) {
	const [claim] = await outlineStore.getTaskClaims([blockId]);
	const versions = await outlineStore.listBlockVersions(blockId, 20);
	const last = versions.at(-1);
	const commit = last ? await outlineStore.getCommit(last.commitId) : null;
	return { holder: claim?.holderNarratorId ?? null, actor: commit?.actorId ?? null };
}

describe("Add and start", () => {
	test("starts the task just added, not an earlier to-do, with continuation off", async () => {
		const owner = await person();
		const id = await session(owner);
		const { space, old } = await earlierTodo(id, owner);
		const response = await call(owner, "POST", `/outline/narrators/${id}/tasks`, {
			text: "Fix the login bug now",
			start: true,
		});
		expect(response.status).toBe(201);
		const body = (await response.json()) as {
			added: boolean;
			started: boolean;
			task: { id: string; address: string };
		};
		expect(body).toMatchObject({ added: true, started: true });
		await waitIdleAfterTurns(id, 1);
		const task = await outlineStore.getBlock(body.task.id);
		expect(task?.taskJson?.status).toBe("doing");
		expect(await startedBy(body.task.id)).toEqual({
			holder: id,
			actor: OUTLINE_TASK_START_ACTOR,
		});
		expect((await outlineStore.getBlock(old.blockId))?.taskJson?.status).toBe("todo");
		// The turn's prompt names it, by its address; one turn only.
		expect(providerInputs[0]).toContain(`${space.key}/${task?.sid}`);
		expect(providerInputs[0]).not.toContain(`${space.key}/${old.sid}`);
		await Bun.sleep(100);
		expect(providerInputs).toHaveLength(1);
		closeNarrator(id);
	});

	test("a busy session is not started and the task stays to do", async () => {
		const owner = await person();
		const id = await session(owner, "working");
		const response = await call(owner, "POST", `/outline/narrators/${id}/tasks`, {
			text: "Later",
			start: true,
		});
		const body = (await response.json()) as { started: boolean; task: { id: string } };
		expect(body.started).toBe(false);
		expect((await outlineStore.getBlock(body.task.id))?.taskJson?.status).toBe("todo");
		expect(providerInputs).toHaveLength(0);
	});

	test("someone who may only read the session cannot add, nor start it", async () => {
		const owner = await person();
		const reader = await person();
		const id = await session(owner);
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "narrator",
			scopeId: id,
			principalType: "user",
			principalId: reader,
			capability: "read",
			createdAt: NOW,
		});
		const response = await call(reader, "POST", `/outline/narrators/${id}/tasks`, {
			text: "Not mine to start",
			start: true,
		});
		expect(response.status).toBe(403);
		expect(providerInputs).toHaveLength(0);
	});
});

describe("Reopen and start", () => {
	test("starts the reopened task, even with another task in progress", async () => {
		const owner = await person();
		const id = await session(owner);
		const { space, old } = await earlierTodo(id, owner, "doing");
		const written = await writeOutline({
			spaceId: space.id,
			ops: [{ op: "insert", parent: null, content: "Ship the docs", task: { status: "done" } }],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		const done = written.results[0] as { blockId: string; sid: string };
		const before = await outlineStore.getBlock(done.blockId);
		const response = await call(owner, "PATCH", `/outline/tasks/${done.blockId}`, {
			baseVersionSeq: before?.versionSeq,
			status: "todo",
			start: true,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ started: true });
		await waitIdleAfterTurns(id, 1);
		expect((await outlineStore.getBlock(done.blockId))?.taskJson?.status).toBe("doing");
		expect(await startedBy(done.blockId)).toEqual({ holder: id, actor: OUTLINE_TASK_START_ACTOR });
		expect(providerInputs[0]).toContain(`${space.key}/${done.sid}`);
		expect((await outlineStore.getBlock(old.blockId))?.taskJson?.status).toBe("doing");
		closeNarrator(id);
	});

	test("a task handed to a person is not started, and nothing else is either", async () => {
		const owner = await person();
		const id = await session(owner);
		const { space, old } = await earlierTodo(id, owner);
		const written = await writeOutline({
			spaceId: space.id,
			ops: [
				{
					op: "insert",
					parent: null,
					content: "Review the PR",
					task: { status: "done", assignee: "human:pat" },
				},
			],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		const done = written.results[0] as { blockId: string };
		const before = await outlineStore.getBlock(done.blockId);
		const response = await call(owner, "PATCH", `/outline/tasks/${done.blockId}`, {
			baseVersionSeq: before?.versionSeq,
			status: "todo",
			start: true,
		});
		expect(await response.json()).toMatchObject({ started: false });
		expect((await outlineStore.getBlock(done.blockId))?.taskJson?.status).toBe("todo");
		expect((await outlineStore.getBlock(old.blockId))?.taskJson?.status).toBe("todo");
		expect(providerInputs).toHaveLength(0);
	});

	test("a reader asking to start is refused before anything changes", async () => {
		const owner = await person();
		const reader = await person();
		const id = await session(owner);
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "narrator",
			scopeId: id,
			principalType: "user",
			principalId: reader,
			capability: "read",
			createdAt: NOW,
		});
		const space = await ensureSessionSpace(id);
		const written = await writeOutline({
			spaceId: space.id,
			ops: [{ op: "insert", parent: null, content: "Done thing", task: { status: "done" } }],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		const done = written.results[0] as { blockId: string };
		const before = await outlineStore.getBlock(done.blockId);
		const response = await call(reader, "PATCH", `/outline/tasks/${done.blockId}`, {
			baseVersionSeq: before?.versionSeq,
			status: "todo",
			start: true,
		});
		expect(response.status).toBe(403);
		expect((await outlineStore.getBlock(done.blockId))?.taskJson?.status).toBe("done");
		expect(providerInputs).toHaveLength(0);
	});
});
