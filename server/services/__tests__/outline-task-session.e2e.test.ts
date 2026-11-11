/**
 * "Open a new session for this" end to end (outline P2 PR 10c-1; design v2 §B, §F): through the
 * real route, the real session service, the real write path and the real continuation, with a
 * model stand-in answering the turns (the provider module is replaced for this file, as in
 * `outline-board-start.test.ts`).
 *
 *   - a click creates a session in the task's project (outline tasks, the person's), claims the
 *     task for it atomically with the next claim generation, writes the opening brief as the first
 *     row of its history, and starts its first turn on the task;
 *   - a repeated click and concurrent clicks open one session; a task someone took meanwhile is a
 *     clear refusal and leaves no session behind; a failure gives the claim back;
 *   - who may click, and what the brief may show (the new session's own read scope);
 *   - the system prompt and the tool definitions are byte for byte those of another session of the
 *     project;
 *   - under the default continuation mode the session keeps working on the task it was opened
 *     for, and the first step of a task with steps is started for it.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; each case makes its own project.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { modelInputText, requestInput, rowsAsHistory } from "../../../tests/fixtures/model-input";
import { readTestMessageContent } from "../../../tests/setup";
import {
	aclGrants,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
	users,
} from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import { buildAppErrorResponse } from "../../lib/app-error-response";

const { db, sqlite } = await import("../../db");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");

// Bun's mock.module is process-wide; the real module is put back after this file.
const realProviderModule = { ...(await import("../../lib/agent/provider")) };
/** One entry per model request: what the model was sent, its system prompt and tools. */
const requests: Array<{ input: string; system: string; tools: string }> = [];
let lastSystem = "";
let lastTools = "";
const testProvider: ProviderAdapter = {
	formatTools: (tools) => {
		lastTools = JSON.stringify(tools);
		return [];
	},
	buildHistory: rowsAsHistory,
	injectSystemPrompt: (_history, systemPrompt) => {
		lastSystem = systemPrompt;
	},
	async *chat(params) {
		requests.push({
			input: `${modelInputText(params as never)}\n${requestInput(params)}`,
			system: lastSystem,
			tools: lastTools,
		});
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
const { closeNarrator, startSpecContinuationIfPossible } = await import("../narrator-session");
const { narratorService } = await import("../narrator-service");
const { outlineStore } = await import("../outline/store");
const { ensurePersonalSpace, ensureProjectSpace, ensureSessionSpace } = await import(
	"../outline/spaces"
);
const { writeOutline } = await import("../outline/write");
const {
	OUTLINE_TASK_BRIEF_LIMITS,
	OUTLINE_TASK_BRIEF_SOURCE,
	OUTLINE_TASK_OPEN_ACTOR,
	openTaskSession,
	resetOutlineTaskSessionsForTests,
	setOutlineTaskSessionRuntime,
} = await import("../outline/task-session");
const { readProjectTaskBoard } = await import("../outline/task-board");
const { OUTLINE_TASK_START_ACTOR } = await import("../task-source/outline");
const { invalidateTaskBackend } = await import("../task-source");
const { resetOutlineTaskEditsForTests } = await import("../outline-task-edits");

const NOW = "2026-11-11T00:00:00.000Z";
const dirs: string[] = [];
const opened: string[] = [];
const defaults = {
	mode: settings.agent.autoContinuationMode,
	model: settings.agent.defaultModel,
};

afterAll(async () => {
	await closePrefixSnapshotStore();
	mock.module("../../lib/agent/provider", () => realProviderModule);
	mock.restore();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	settings.outline.enabled = true;
	// One turn per start unless a case asks for the default mode.
	settings.agent.autoContinuationMode = "off";
	settings.agent.defaultModel = "openai:test-model";
	invalidateTaskBackend();
	resetOutlineTaskEditsForTests();
	resetOutlineTaskSessionsForTests();
	setOutlineTaskSessionRuntime(null);
	requests.length = 0;
});

afterEach(async () => {
	setOutlineTaskSessionRuntime(null);
	for (const id of opened.splice(0)) {
		await idle(id).catch(() => {});
		closeNarrator(id);
	}
	settings.agent.autoContinuationMode = defaults.mode;
	settings.agent.defaultModel = defaults.model;
});

async function person(name: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${name}${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	return id;
}

async function grant(
	scopeType: "project" | "narrator",
	scopeId: string,
	userId: string,
	capability: string,
) {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType,
		scopeId,
		principalType: "user",
		principalId: userId,
		capability,
		createdAt: NOW,
	});
}

/** A project of `owner` with a working directory, and its outline space. */
async function project(owner: string, options: { gitPath?: string | null } = {}) {
	const id = generateId();
	const dir = mkdtempSync(join(tmpdir(), "nf-task-session-"));
	dirs.push(dir);
	await db.insert(projects).values({
		id,
		name: `Project ${id.slice(0, 6)}`,
		gitPath: options.gitPath === undefined ? dir : options.gitPath,
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return { id, dir, space: await ensureProjectSpace(id) };
}

type Op = Parameters<typeof writeOutline>[0]["ops"][number];

async function write(spaceId: string, userId: string, ops: Op[]) {
	return await writeOutline({
		spaceId,
		ops,
		actor: { kind: "human", id: userId },
		responsibleUserId: userId,
	});
}

/** A task page with one to-do task under it, in the project's space. */
async function taskIn(
	spaceId: string,
	owner: string,
	content = "Fix the refresh logic",
	task: Record<string, unknown> = { status: "todo" },
) {
	const written = await write(spaceId, owner, [
		{ op: "insert", tempId: "p", parent: null, content: "Tasks", task: null },
		{ op: "insert", tempId: "t", parent: { tempId: "p" }, content, task: task as never },
	]);
	const result = written.results[1] as { blockId: string; sid: string };
	const block = await outlineStore.getBlock(result.blockId);
	return { id: result.blockId, sid: result.sid, versionSeq: block?.versionSeq as number };
}

function call(userId: string, path: string, body?: unknown, role: "user" | "admin" = "user") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError(
		(error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: String(error) }, 500),
	);
	app.route("/outline", outlineRoutes);
	return app.request(`http://localhost/outline${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
}

interface Opened {
	narratorId: string;
	started: boolean;
	epoch: number;
	already?: true;
}

async function open(userId: string, task: { id: string; versionSeq: number }, extra: object = {}) {
	const response = await call(userId, `/tasks/${task.id}/open-session`, {
		baseVersionSeq: task.versionSeq,
		...extra,
	});
	const body = (await response.json()) as Opened & {
		code?: string;
		details?: { reason?: string; holder?: { kind: string; name: string | null } };
	};
	if (body.narratorId && !opened.includes(body.narratorId)) opened.push(body.narratorId);
	return { status: response.status, body };
}

async function idle(narratorId: string, turns = 0): Promise<void> {
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { status: true },
		});
		if (requests.length >= turns && row?.status !== "working") return;
		await Bun.sleep(5);
	}
	throw new Error("timed out waiting for the session to go idle");
}

/** The session's top-level rows in order, each with its first text and its injection source. */
async function history(narratorId: string) {
	const rows = await db
		.select({ id: narratorMessages.id, role: narratorMessages.role })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId))
		.orderBy(asc(narratorMessageRefs.seq));
	return rows.map((row) => {
		const content = readTestMessageContent<{
			type: string;
			text?: string;
			modelText?: string;
			source?: string;
		}>(sqlite, row.id);
		return {
			role: row.role,
			// What the model reads of the row: its text, or the injection's own model text.
			text:
				content.find((block) => block.type === "text")?.text ??
				content.find((block) => typeof block.modelText === "string")?.modelText ??
				"",
			source: content.find((block) => block.type === "system_injection")?.source ?? null,
		};
	});
}

const sessionsOf = async (projectId: string) =>
	await db
		.select({ id: narrators.id, status: narrators.status })
		.from(narrators)
		.where(eq(narrators.contextProjectId, projectId));

async function stateOf(taskId: string) {
	const block = await outlineStore.getBlock(taskId);
	const [claim] = await outlineStore.getTaskClaims([taskId]);
	return {
		status: block?.taskJson?.status,
		assignee: block?.taskJson?.assignee ?? null,
		holder: claim?.holderNarratorId ?? null,
		epoch: claim?.epoch ?? 0,
		versionSeq: block?.versionSeq,
	};
}

describe("a click opens a session that does the task", () => {
	test("the session, the atomic claim, the brief as the first row, and a run on the task", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		// A fact page the task links to, and a task with a body, steps and that link.
		const fact = await write(p.space.id, alice, [
			{ op: "insert", tempId: "f", parent: null, content: "Auth design" },
			{ op: "insert", parent: { tempId: "f" }, content: "Tokens are refreshed under one lock" },
		]);
		const factSid = (fact.results[0] as { sid: string }).sid;
		const page = await write(p.space.id, alice, [
			{ op: "insert", tempId: "p", parent: null, content: "Tasks" },
			{
				op: "insert",
				tempId: "g",
				parent: { tempId: "p" },
				content: "Make sign-in reliable",
				task: { status: "todo" },
			},
			{ op: "insert", parent: { tempId: "g" }, content: "Users are logged out at random" },
			{
				op: "insert",
				tempId: "t",
				parent: { tempId: "g" },
				content: `Fix the refresh logic\nSee [[${p.space.key}/${factSid}]] before changing it`,
				task: { status: "todo", assignee: "agent:someone-else" },
			},
			{ op: "insert", parent: { tempId: "t" }, content: "It fails when two tabs refresh at once" },
		]);
		const t = page.results[3] as { blockId: string; sid: string };
		const before = await outlineStore.getBlock(t.blockId);

		const { status, body } = await open(
			alice,
			{ id: t.blockId, versionSeq: before?.versionSeq as number },
			{ note: "Keep the public API as it is." },
		);
		expect(status).toBe(201);
		expect(body).toMatchObject({ started: true, epoch: 1 });
		await idle(body.narratorId, 1);

		// The session: in the project, the person's, a root session with its tasks in the outline.
		const session = await db.query.narrators.findFirst({
			where: eq(narrators.id, body.narratorId),
		});
		expect(session).toMatchObject({
			contextProjectId: p.id,
			ownerUserId: alice,
			taskBackend: "outline",
			type: "primary",
			title: "Fix the refresh logic",
			cwd: p.dir,
		});

		// The claim: in progress, held by the session, generation 1, one system commit for it; the
		// assignment to another agent by name went with it.
		expect(await stateOf(t.blockId)).toMatchObject({
			status: "doing",
			holder: body.narratorId,
			epoch: 1,
			assignee: null,
		});
		const [commit] = await outlineStore.getCommitsBySeqs(p.space.id, [
			(await outlineStore.getBlock(t.blockId))?.versionSeq as number,
		]);
		expect(commit).toMatchObject({
			actorKind: "system",
			actorId: OUTLINE_TASK_OPEN_ACTOR,
			narratorId: body.narratorId,
			responsibleUserId: alice,
		});

		// The brief: the first row of the history, a system row, within the budget, with its parts.
		const rows = await history(body.narratorId);
		expect(rows[0]).toMatchObject({ role: "sys", source: OUTLINE_TASK_BRIEF_SOURCE });
		const brief = rows[0]?.text ?? "";
		expect(brief.startsWith("# Task: Fix the refresh logic\n")).toBe(true);
		expect(brief).toContain("Part of: Tasks › Make sign-in reliable");
		expect(brief).toContain(`Address: \`${p.space.key}/${t.sid}\``);
		expect(brief).toContain("claim generation 1");
		expect(brief).toContain("## What to do\nSee Auth design before changing it");
		expect(brief).toContain("- It fails when two tabs refresh at once");
		expect(brief).toContain("## Background (the tasks above this one)");
		expect(brief).toContain("- Make sign-in reliable\n  Users are logged out at random");
		expect(brief).toContain("- Fix the refresh logic (in progress) ← this task");
		expect(brief).toContain("## Facts the task links to");
		expect(brief).toContain("Tokens are refreshed under one lock");
		expect(brief).toContain("## Pages of the project's outline");
		expect(brief).toContain(`- Auth design (\`${p.space.key}/${factSid}\`) · linked from the task`);
		expect(brief).toContain("## How to work on this task");
		expect(brief).toContain("write a handoff note under the task");
		expect(brief).toContain("## Further instructions\nKeep the public API as it is.");
		expect(Buffer.byteLength(brief, "utf8")).toBeLessThanOrEqual(
			OUTLINE_TASK_BRIEF_LIMITS.bytes + Buffer.byteLength("Keep the public API as it is.") + 32,
		);
		// The order: what to do, the material, the rules last.
		const at = (text: string) => brief.indexOf(text);
		expect(at("## What to do")).toBeLessThan(at("## Notes and steps so far"));
		expect(at("## Notes and steps so far")).toBeLessThan(at("## Background"));
		expect(at("## Background")).toBeLessThan(at("## Facts the task links to"));
		expect(at("## Facts the task links to")).toBeLessThan(at("## Pages of the project"));
		expect(at("## Pages of the project")).toBeLessThan(at("## How to work on this task"));

		// The run: one turn (continuation is off here), whose input holds the brief and names the task.
		expect(requests).toHaveLength(1);
		expect(requests[0]?.input).toContain("# Task: Fix the refresh logic");
		expect(rows[1]?.text).toContain(`${p.space.key}/${t.sid}`);
		expect(rows.at(-1)).toMatchObject({ role: "assistant" });
		// The brief is history only: nothing of it is in the system prompt.
		expect(requests[0]?.system).not.toContain("opening brief");
		expect(requests[0]?.system).not.toContain("It fails when two tabs refresh at once");
	});

	test("opened again after the task went back to do: the next claim generation", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const task = await taskIn(p.space.id, alice);
		const first = await open(alice, task);
		expect(first.body.epoch).toBe(1);
		await idle(first.body.narratorId, 1);
		// A person stops it on the board: back to do, the claim released.
		const doing = await stateOf(task.id);
		await write(p.space.id, alice, [
			{
				op: "setTask",
				block: { id: task.id },
				task: { status: "todo" },
				baseVersionSeq: doing.versionSeq,
			},
		]);
		resetOutlineTaskSessionsForTests();
		const again = await open(alice, {
			id: task.id,
			versionSeq: (await stateOf(task.id)).versionSeq as number,
		});
		expect(again.status).toBe(201);
		expect(again.body.epoch).toBe(2);
		expect(again.body.narratorId).not.toBe(first.body.narratorId);
		expect(await stateOf(task.id)).toMatchObject({ holder: again.body.narratorId, epoch: 2 });
		await idle(again.body.narratorId, 2);
		expect((await history(again.body.narratorId))[0]?.text).toContain("claim generation 2");
	});
});

describe("repeated and concurrent clicks", () => {
	test("the same person clicking twice gets the one session", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const task = await taskIn(p.space.id, alice);
		const first = await open(alice, task);
		const second = await open(alice, task);
		expect(first.status).toBe(201);
		expect(second.status).toBe(200);
		expect(second.body).toMatchObject({
			narratorId: first.body.narratorId,
			already: true,
			epoch: 1,
		});
		expect(await sessionsOf(p.id)).toHaveLength(1);
		await idle(first.body.narratorId, 1);
	});

	test("two clicks at once open one session", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const task = await taskIn(p.space.id, alice);
		const [a, b] = await Promise.all([open(alice, task), open(alice, task)]);
		expect([a.status, b.status].sort()).toEqual([200, 201]);
		expect(a.body.narratorId).toBe(b.body.narratorId);
		expect(await sessionsOf(p.id)).toHaveLength(1);
		expect((await stateOf(task.id)).epoch).toBe(1);
		await idle(a.body.narratorId, 1);
	});

	test("two people at once: one opens it, the other is told who is doing it, and no second session exists", async () => {
		const alice = await person("alice");
		const bob = await person("bob");
		const p = await project(alice);
		await grant("project", p.id, bob, "write");
		const task = await taskIn(p.space.id, alice);
		const results = await Promise.all([open(alice, task), open(bob, task)]);
		const won = results.find((r) => r.status === 201);
		const lost = results.find((r) => r.status !== 201);
		expect(won).toBeDefined();
		expect(lost?.status).toBe(409);
		expect(lost?.body.code).toBe("OUTLINE_TASK_SESSION_CLAIMED");
		expect(lost?.body.details).toMatchObject({ reason: "claimed", holder: { kind: "session" } });
		expect(await sessionsOf(p.id)).toHaveLength(1);
		await idle(won?.body.narratorId as string, 1);
	});
});

describe("failures leave nothing behind", () => {
	test("claimed by someone between the checks and the claim: a clear refusal, the new session archived", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const task = await taskIn(p.space.id, alice);
		// Another session of the project, private to someone else, takes the task meanwhile.
		const carol = await person("carol");
		await grant("project", p.id, carol, "write");
		const other = await narratorService.create({
			contextProjectId: p.id,
			cwd: p.dir,
			ownerUserId: carol,
			title: "Carol's secret session",
			taskBackend: "outline",
			visibility: "private",
		});
		setOutlineTaskSessionRuntime({
			async createSession(input) {
				const created = await narratorService.create({
					contextProjectId: input.projectId,
					cwd: input.cwd,
					ownerUserId: input.ownerUserId,
					title: input.title,
					taskBackend: "outline",
				});
				await writeOutline({
					spaceId: p.space.id,
					ops: [{ op: "setTask", block: { id: task.id }, task: { status: "doing" } }],
					actor: { kind: "agent", id: other.id },
					narratorId: other.id,
					responsibleUserId: carol,
				});
				return created.id;
			},
		});
		const { status, body } = await open(alice, task);
		expect(status).toBe(409);
		expect(body.code).toBe("OUTLINE_TASK_SESSION_CLAIMED");
		// Alice may not read Carol's private session: it is not named.
		expect(body.details?.holder).toEqual({ kind: "session", name: null });
		expect(await stateOf(task.id)).toMatchObject({ status: "doing", holder: other.id, epoch: 1 });
		// The session created for the click never ran and is archived: no orphan.
		const sessions = await sessionsOf(p.id);
		expect(sessions.filter((s) => s.id !== other.id)).toEqual([
			expect.objectContaining({ status: "archived" }),
		]);
		expect(requests).toHaveLength(0);
	});

	test("the session cannot be created: the error as it is, the task untouched", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const task = await taskIn(p.space.id, alice);
		setOutlineTaskSessionRuntime({
			createSession: async () => {
				throw new Error("no device");
			},
		});
		const { status } = await open(alice, task);
		expect(status).toBe(500);
		expect(await stateOf(task.id)).toMatchObject({
			status: "todo",
			holder: null,
			epoch: 0,
			versionSeq: task.versionSeq,
		});
		expect(await sessionsOf(p.id)).toHaveLength(0);
	});

	for (const [name, seam] of [
		["the brief cannot be written", { deliverBrief: async () => false }],
		[
			"the start throws",
			{
				start: async () => {
					throw new Error("boom");
				},
			},
		],
		["the session does not start", { start: async () => false }],
	] as const) {
		test(`${name}: the claim is given back and the session archived`, async () => {
			const alice = await person("alice");
			const p = await project(alice);
			const task = await taskIn(p.space.id, alice);
			setOutlineTaskSessionRuntime(seam);
			const { status, body } = await open(alice, task);
			expect(status).toBe(500);
			expect(body.code).toBe("OUTLINE_TASK_SESSION_START_FAILED");
			const state = await stateOf(task.id);
			// Back to do, nobody holds it; the generation is kept for the next claim.
			expect(state).toMatchObject({ status: "todo", holder: null, epoch: 1 });
			// Nothing was attached under the task.
			expect(await outlineStore.listChildMetas(p.space.id, [task.id], 10)).toEqual([]);
			expect(await sessionsOf(p.id)).toEqual([expect.objectContaining({ status: "archived" })]);
			expect(requests).toHaveLength(0);
			// It can be opened again right away.
			setOutlineTaskSessionRuntime(null);
			const again = await open(alice, { id: task.id, versionSeq: state.versionSeq as number });
			expect(again.status).toBe(201);
			expect(again.body.epoch).toBe(2);
			await idle(again.body.narratorId, 1);
		});
	}

	test("a task that cannot be started is refused with the reason, and nothing is created", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const page = await write(p.space.id, alice, [
			{ op: "insert", tempId: "p", parent: null, content: "Tasks" },
			{
				op: "insert",
				tempId: "a",
				parent: { tempId: "p" },
				content: "First",
				task: { status: "todo" },
			},
			{ op: "insert", parent: { tempId: "p" }, content: "Finished", task: { status: "done" } },
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "For a person",
				task: { status: "todo", assignee: "human:pat" },
			},
			{
				op: "insert",
				tempId: "plan",
				parent: { tempId: "p" },
				content: "A plan being planned",
				task: { status: "todo", plan: { state: "planning", by: "x", round: 1 } as never },
			},
			{ op: "insert", parent: { tempId: "plan" }, content: "Its step", task: { status: "todo" } },
		]);
		const ids = page.results.map((r) => (r as { blockId: string }).blockId);
		const first = (await outlineStore.getBlock(ids[1] as string)) as { sid: string };
		const waiting = await write(p.space.id, alice, [
			{
				op: "insert",
				parent: { id: ids[0] as string },
				content: "Second",
				task: {
					status: "todo",
					depends: [{ target: `${p.space.key}/${first.sid}`, label: null }] as never,
				},
			},
			{ op: "insert", parent: { id: ids[0] as string }, content: "Mine", task: { status: "todo" } },
		]);
		const waitingId = (waiting.results[0] as { blockId: string }).blockId;
		const mineId = (waiting.results[1] as { blockId: string }).blockId;
		// A person is doing "Mine".
		await write(p.space.id, alice, [
			{ op: "setTask", block: { id: mineId }, task: { status: "doing" } },
		]);
		const expectRefused = async (id: string, reason: string) => {
			const block = await outlineStore.getBlock(id);
			const { status, body } = await open(alice, { id, versionSeq: block?.versionSeq as number });
			expect([id, status, body.details?.reason]).toEqual([id, 409, reason]);
		};
		await expectRefused(ids[2] as string, "finished");
		await expectRefused(ids[3] as string, "assigned_to_person");
		await expectRefused(ids[4] as string, "planning");
		await expectRefused(ids[5] as string, "planning");
		await expectRefused(waitingId, "prerequisites");
		await expectRefused(mineId, "claimed");
		// A stale board: the task changed since it was read.
		const stale = await open(alice, { id: ids[1] as string, versionSeq: 0 });
		expect([stale.status, stale.body.details?.reason]).toEqual([409, "changed"]);
		// A task of a session space is not a pool task.
		const own = await narratorService.create({
			contextProjectId: p.id,
			cwd: p.dir,
			ownerUserId: alice,
			taskBackend: "outline",
		});
		const sessionSpace = await ensureSessionSpace(own.id);
		const sessionTask = await taskIn(sessionSpace.id, alice, "A session's own");
		const refused = await open(alice, sessionTask);
		expect([refused.status, refused.body.details?.reason]).toEqual([409, "not_project_task"]);
		expect(await sessionsOf(p.id)).toHaveLength(1);
		expect(requests).toHaveLength(0);
	});

	test("a project without a working directory: refused; one given with the click is used", async () => {
		const alice = await person("alice");
		const p = await project(alice, { gitPath: null });
		const task = await taskIn(p.space.id, alice);
		const refused = await open(alice, task);
		expect([refused.status, refused.body.details?.reason]).toEqual([409, "no_directory"]);
		const missing = await open(alice, task, { cwd: join(p.dir, "does-not-exist") });
		expect(missing.body.details?.reason).toBe("no_directory");
		expect(await sessionsOf(p.id)).toHaveLength(0);
		const given = await open(alice, task, { cwd: p.dir });
		expect(given.status).toBe(201);
		await idle(given.body.narratorId, 1);
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, given.body.narratorId) }))?.cwd,
		).toBe(p.dir);
	});

	test("where the session runtime does not run (PostgreSQL): refused cleanly, and the board offers nothing", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const task = await taskIn(p.space.id, alice);
		const principal = { userId: alice, isAdmin: false };
		const offered = async () =>
			(await readProjectTaskBoard(principal, p.id)).sections[0]?.open.map((t) => t.openSession);
		expect(await offered()).toEqual([true]);
		setOutlineTaskSessionRuntime({ available: () => false });
		expect(await offered()).toEqual([undefined]);
		const { status, body } = await open(alice, task);
		expect([status, body.code]).toEqual([409, "OUTLINE_TASK_SESSION_UNAVAILABLE"]);
		expect(await stateOf(task.id)).toMatchObject({ status: "todo", holder: null });
		expect(await sessionsOf(p.id)).toHaveLength(0);
	});
});

describe("who may click, and what the brief may show", () => {
	test("a reader of the project is refused, a stranger sees nothing, and the board offers the button to writers only", async () => {
		const alice = await person("alice");
		const reader = await person("reader");
		const stranger = await person("stranger");
		const p = await project(alice);
		await grant("project", p.id, reader, "read");
		const task = await taskIn(p.space.id, alice);
		expect((await open(reader, task)).status).toBe(403);
		expect((await open(stranger, task)).status).toBe(404);
		const offers = async (userId: string) =>
			(await readProjectTaskBoard({ userId, isAdmin: false }, p.id)).sections[0]?.open.map(
				(t) => t.openSession === true,
			);
		expect(await offers(alice)).toEqual([true]);
		expect(await offers(reader)).toEqual([false]);
		expect(await stateOf(task.id)).toMatchObject({ status: "todo", holder: null });
		expect(await sessionsOf(p.id)).toHaveLength(0);
	});

	test("the brief is put together with the new session's read scope, not the clicking person's", async () => {
		const alice = await person("alice");
		const bob = await person("bob");
		const p = await project(alice);
		// Bob reads the project, and so the sessions opened in it for its tasks.
		await grant("project", p.id, bob, "read");
		// Alice's personal notes, and a private session of hers: both readable to her, neither to
		// everyone who can read the new (project-visible) session.
		const personal = await ensurePersonalSpace(alice);
		const secret = await write(personal.id, alice, [
			{ op: "insert", parent: null, content: "My salary negotiation notes" },
		]);
		const secretSid = (secret.results[0] as { sid: string }).sid;
		const priv = await narratorService.create({
			contextProjectId: p.id,
			cwd: p.dir,
			ownerUserId: alice,
			taskBackend: "outline",
			visibility: "private",
		});
		const privSpace = await ensureSessionSpace(priv.id);
		const hidden = await write(privSpace.id, alice, [
			{ op: "insert", parent: null, content: "Private session scratch" },
		]);
		const hiddenSid = (hidden.results[0] as { sid: string }).sid;
		const task = await taskIn(
			p.space.id,
			alice,
			`Tidy up\nSee [[${personal.key}/${secretSid}]] and [[${privSpace.key}/${hiddenSid}]]`,
		);
		const { status, body } = await open(alice, task);
		expect(status).toBe(201);
		await idle(body.narratorId, 1);
		const brief = (await history(body.narratorId))[0]?.text ?? "";
		expect(brief).not.toContain("salary");
		expect(brief).not.toContain("Private session scratch");
		expect(brief).not.toContain(secretSid);
		expect(brief).not.toContain(hiddenSid);
		// Named as unreadable, in the task's text and among the facts.
		expect(brief).toContain(
			"See (a block this session cannot read) and (a block this session cannot read)",
		);
		expect(brief).toContain("## Facts the task links to\n- (a block this session cannot read)");
	});
});

describe("the prompt cache's shared prefix", () => {
	test("the system prompt and tool definitions are byte for byte those of another session of the project", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const task = await taskIn(p.space.id, alice, "A task with a very particular title");
		const { body } = await open(alice, task);
		await idle(body.narratorId, 1);
		// An ordinary session of the same project, started on a task of its own.
		const plain = await narratorService.create({
			contextProjectId: p.id,
			cwd: p.dir,
			ownerUserId: alice,
			title: "An ordinary session",
			taskBackend: "outline",
		});
		opened.push(plain.id);
		const own = await taskIn((await ensureSessionSpace(plain.id)).id, alice, "Own work");
		expect(
			(
				await startSpecContinuationIfPossible(plain.id, "en", false, alice, {
					preferTaskId: own.id,
				})
			).started,
		).toBe(true);
		await idle(plain.id, 2);
		expect(requests).toHaveLength(2);
		const [taskSession, ordinary] = requests as [(typeof requests)[0], (typeof requests)[0]];
		expect(taskSession.tools.length).toBeGreaterThan(2);
		expect(taskSession.tools).toBe(ordinary.tools);
		// The system prompt carries the epoch's named context, and with it each session's own
		// current tasks (`outline.tasks`), as it does for every outline session. Everything else is
		// the same bytes: before that part (the shared cached prefix) and after it.
		const parts = (system: string) => {
			const from = system.indexOf("## Context: outline.tasks");
			const to = system.indexOf("\n## Context: ", from + 1);
			expect(from).toBeGreaterThan(0);
			expect(to).toBeGreaterThan(from);
			return {
				before: system.slice(0, from),
				own: system.slice(from, to),
				after: system.slice(to),
			};
		};
		const a = parts(taskSession.system);
		const b = parts(ordinary.system);
		expect(a.before.length).toBeGreaterThan(1000);
		expect(a.before).toBe(b.before);
		expect(a.after).toBe(b.after);
		// The task session's own part is its one task in progress, as the view writes any task.
		expect(a.own.replace(/`[^`]+` A task with a very particular title/, "X")).toBe(
			b.own.replace(/`[^`]+` Own work/, "X"),
		);
		// Nothing of the brief is in the system prompt.
		expect(taskSession.system).not.toContain("opening brief");
		expect(taskSession.system).not.toContain("How to work on this task");
		expect(taskSession.input).toContain("A task with a very particular title");
		expect(ordinary.input).not.toContain("A task with a very particular title");
	});
});

describe("the session keeps working on the task it was opened for", () => {
	test("under the default mode (protectedOnly) it continues on the project task it holds", async () => {
		settings.agent.autoContinuationMode = "protectedOnly";
		const alice = await person("alice");
		const p = await project(alice);
		// Not a person's task as `protectedOnly` used to count it: an agent wrote it.
		const author = await narratorService.create({
			contextProjectId: p.id,
			cwd: p.dir,
			ownerUserId: alice,
			taskBackend: "outline",
		});
		const written = await writeOutline({
			spaceId: p.space.id,
			ops: [
				{ op: "insert", tempId: "p", parent: null, content: "Tasks" },
				{
					op: "insert",
					parent: { tempId: "p" },
					content: "Agent-made work",
					task: { status: "todo" },
				},
			],
			actor: { kind: "agent", id: author.id },
			narratorId: author.id,
			responsibleUserId: alice,
		});
		const id = (written.results[1] as { blockId: string }).blockId;
		const block = await outlineStore.getBlock(id);
		expect(block?.taskJson?.humanCreated).not.toBe(true);
		const { status, body } = await open(alice, { id, versionSeq: block?.versionSeq as number });
		expect(status).toBe(201);
		// The stand-in never ticks the task done: the continuation goes on past the first turn.
		await idle(body.narratorId, 2);
		expect(requests.length).toBeGreaterThanOrEqual(2);
		expect(requests[1]?.input).toContain("Outline task continuation");
		expect(await stateOf(id)).toMatchObject({ status: "doing", holder: body.narratorId });
	});

	test("a task with steps: its first step is started for the session; a project task that was not named is not", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const page = await write(p.space.id, alice, [
			{ op: "insert", tempId: "p", parent: null, content: "Tasks" },
			{
				op: "insert",
				tempId: "t",
				parent: { tempId: "p" },
				content: "Ship the fix",
				task: { status: "todo" },
			},
			{
				op: "insert",
				parent: { tempId: "t" },
				content: "Write the test",
				task: { status: "todo" },
			},
			{
				op: "insert",
				parent: { tempId: "t" },
				content: "Change the code",
				task: { status: "todo" },
			},
			{
				op: "insert",
				parent: { tempId: "p" },
				content: "Another pool task",
				task: { status: "todo" },
			},
		]);
		const [, t, s1, s2, otherTask] = page.results as Array<{ blockId: string; sid: string }>;
		const before = await outlineStore.getBlock(t?.blockId as string);
		const { status, body } = await open(alice, {
			id: t?.blockId as string,
			versionSeq: before?.versionSeq as number,
		});
		expect(status).toBe(201);
		await idle(body.narratorId, 1);
		expect(await stateOf(t?.blockId as string)).toMatchObject({
			status: "doing",
			holder: body.narratorId,
		});
		// The first step: in progress, the session's, started by the system start.
		expect(await stateOf(s1?.blockId as string)).toMatchObject({
			status: "doing",
			holder: body.narratorId,
		});
		const stepSeq = (await outlineStore.getBlock(s1?.blockId as string))?.versionSeq as number;
		expect((await outlineStore.getCommitsBySeqs(p.space.id, [stepSeq]))[0]?.actorId).toBe(
			OUTLINE_TASK_START_ACTOR,
		);
		expect(await stateOf(s2?.blockId as string)).toMatchObject({ status: "todo", holder: null });
		expect(await stateOf(otherTask?.blockId as string)).toMatchObject({
			status: "todo",
			holder: null,
		});
		// The turn names the step it was started on.
		expect((await history(body.narratorId))[1]?.text).toContain(`${p.space.key}/${s1?.sid}`);
	});
});

describe("openTaskSession", () => {
	test("the automatic opener is not built: refused", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const task = await taskIn(p.space.id, alice);
		await expect(
			openTaskSession({
				taskId: task.id,
				baseVersionSeq: task.versionSeq,
				by: { kind: "auto", projectId: p.id },
			}),
		).rejects.toMatchObject({ reason: "unavailable" });
		expect(await sessionsOf(p.id)).toHaveLength(0);
	});
});
