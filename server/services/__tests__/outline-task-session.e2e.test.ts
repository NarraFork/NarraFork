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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
/** What the model stand-in does in a turn besides replying (its tool calls, in effect). */
let onTurn: ((turn: number) => Promise<void>) | null = null;
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
		await onTurn?.(requests.length);
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
const { closeNarrator, sendMessage, startSpecContinuationIfPossible } = await import(
	"../narrator-session"
);
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
const { outlineRunEndsSettled } = await import("../outline/lease-keeper");
// The run's end asks whether anything still works for the session in the background.
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
await backgroundOccupancyStore.start();
const { isHandoffBlockId, OUTLINE_HANDOFF_ACTOR } = await import("../outline/handoff");
const { readSubtree, loadBodies } = await import("../outline/read");
const { OUTLINE_TASK_START_ACTOR } = await import("../task-source/outline");
const { invalidateTaskBackend } = await import("../task-source");
const { resetOutlineTaskEditsForTests } = await import("../outline-task-edits");

const NOW = "2026-11-11T00:00:00.000Z";
const dirs: string[] = [];
const opened: string[] = [];
const defaults = {
	mode: settings.agent.autoContinuationMode,
	model: settings.agent.defaultModel,
	planMode: settings.agent.defaultStartInPlanMode,
	visibility: settings.agent.defaultNarratorVisibility,
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
	onTurn = null;
});

afterEach(async () => {
	setOutlineTaskSessionRuntime(null);
	for (const id of opened.splice(0)) {
		await idle(id).catch(() => {});
		closeNarrator(id);
	}
	settings.agent.autoContinuationMode = defaults.mode;
	settings.agent.defaultModel = defaults.model;
	settings.agent.defaultStartInPlanMode = defaults.planMode;
	settings.agent.defaultNarratorVisibility = defaults.visibility;
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
	capability: "read" | "write",
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
		if (requests.length >= turns && row?.status !== "working") {
			// The run's end also settles the session's claims (not waited for by the runtime).
			await outlineRunEndsSettled(narratorId);
			return;
		}
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
		lastHolder: claim?.lastHolderNarratorId ?? null,
		claimSeq: claim?.taskVersionAtClaim ?? null,
		epoch: claim?.epoch ?? 0,
		versionSeq: block?.versionSeq,
	};
}

/** The handoffs under a task, oldest first: each block's text and the texts of its lines. */
async function handoffsUnder(taskId: string) {
	const subtree = await readSubtree(taskId);
	const blocks = (subtree?.root.children ?? []).filter((child) => isHandoffBlockId(child.id));
	if (subtree)
		await loadBodies(subtree.state, [...blocks, ...blocks.flatMap((block) => block.children)]);
	return blocks.map((block) => ({
		id: block.id,
		text: block.content ?? "",
		lines: block.children.map((line) => line.content ?? ""),
	}));
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

		// The claim: taken for the session at generation 1 by one system commit; the assignment to
		// another agent by name went with it. (The stand-in's one turn ends without finishing the
		// task, so by now it is given back: PR 10c-2, covered in its own cases below.)
		const claimed = await stateOf(t.blockId);
		expect(claimed).toMatchObject({
			status: "todo",
			holder: null,
			lastHolder: body.narratorId,
			epoch: 1,
			assignee: null,
		});
		const [commit] = await outlineStore.getCommitsBySeqs(p.space.id, [claimed.claimSeq as number]);
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

describe("whatever the instance's defaults for new sessions", () => {
	test("sessions start in plan mode by default: the task session does not, and it runs", async () => {
		settings.agent.defaultStartInPlanMode = true;
		const alice = await person("alice");
		const p = await project(alice);
		const task = await taskIn(p.space.id, alice);
		const { status, body } = await open(alice, task);
		expect(status).toBe(201);
		await idle(body.narratorId, 1);
		const session = await db.query.narrators.findFirst({
			where: eq(narrators.id, body.narratorId),
		});
		expect(JSON.stringify(session?.traits ?? [])).not.toContain("plan");
		expect(requests).toHaveLength(1);
		expect(await stateOf(task.id)).toMatchObject({ epoch: 1, lastHolder: body.narratorId });
	});

	test("sessions are public by default, the project is private: the task session is the project's, and reads its space", async () => {
		settings.agent.defaultNarratorVisibility = "public";
		const alice = await person("alice");
		const p = await project(alice);
		const task = await taskIn(p.space.id, alice, "A confidential task\nWith a confidential body");
		const { status, body } = await open(alice, task);
		expect(status).toBe(201);
		await idle(body.narratorId, 1);
		const session = await db.query.narrators.findFirst({
			where: eq(narrators.id, body.narratorId),
		});
		// Not public: only the project's readers read the session, its title and its brief.
		expect(session?.visibility).toBe("project");
		const { canSessionReadSpace } = await import("../outline/session-scope");
		expect(await canSessionReadSpace(body.narratorId, p.space, { executingUserId: null })).toBe(
			true,
		);
		expect((await history(body.narratorId))[0]?.text).toContain("With a confidential body");
		// With the instance default private, the session is the person's alone.
		settings.agent.defaultNarratorVisibility = "private";
		const second = await taskIn(p.space.id, alice, "Another task");
		const again = await open(alice, second);
		expect(again.status).toBe(201);
		await idle(again.body.narratorId, 2);
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, again.body.narratorId) }))
				?.visibility,
		).toBe("private");
	});

	test("a session that cannot read the task's space is given nothing: no claim, no brief, archived", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const task = await taskIn(p.space.id, alice, "A confidential task\nWith a confidential body");
		let created = "";
		// However it came to be public (a creation path that ignores the rule above).
		setOutlineTaskSessionRuntime({
			async createSession(input) {
				created = (
					await narratorService.create({
						contextProjectId: input.projectId,
						cwd: input.cwd,
						ownerUserId: input.ownerUserId,
						title: "x",
						taskBackend: "outline",
						visibility: "public",
					})
				).id;
				return created;
			},
		});
		const { status, body } = await open(alice, task);
		expect([status, body.details?.reason]).toEqual([409, "unreadable"]);
		expect(await stateOf(task.id)).toMatchObject({
			status: "todo",
			holder: null,
			epoch: 0,
			versionSeq: task.versionSeq,
		});
		expect(await history(created)).toEqual([]);
		expect(await sessionsOf(p.id)).toEqual([expect.objectContaining({ status: "archived" })]);
		expect(requests).toHaveLength(0);
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
		// The board offers the button on the one task that can be started, and on no other.
		const board = await readProjectTaskBoard({ userId: alice, isAdmin: false }, p.id);
		expect(board.sections[0]?.open.filter((t) => t.openSession).map((t) => t.title)).toEqual([
			"First",
		]);
		expect(board.sections[0]?.open.map((t) => t.title).sort()).toEqual(
			["A plan being planned", "First", "For a person", "Its step", "Mine", "Second"].sort(),
		);
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
		// It was the session's all along; only when the continuation gave up was it given back.
		expect(await stateOf(id)).toMatchObject({ epoch: 1, lastHolder: body.narratorId });
		expect(await handoffsUnder(id)).toHaveLength(1);
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
			epoch: 1,
			lastHolder: body.narratorId,
		});
		// The first step: claimed for the session by the system start.
		const first = await stateOf(s1?.blockId as string);
		expect(first).toMatchObject({ epoch: 1, lastHolder: body.narratorId });
		expect(
			(await outlineStore.getCommitsBySeqs(p.space.id, [first.claimSeq as number]))[0]?.actorId,
		).toBe(OUTLINE_TASK_START_ACTOR);
		// The run ended with neither finished: the task and its step go back together, in one
		// commit, with one handoff, under the task (PR 10c-2).
		expect(await stateOf(t?.blockId as string)).toMatchObject({ status: "todo", holder: null });
		expect(first).toMatchObject({ status: "todo", holder: null });
		expect(await handoffsUnder(t?.blockId as string)).toHaveLength(1);
		expect(await handoffsUnder(s1?.blockId as string)).toHaveLength(0);
		const back = await outlineStore.getCommitsBySeqs(p.space.id, [
			(await outlineStore.getBlock(t?.blockId as string))?.versionSeq as number,
			(await outlineStore.getBlock(s1?.blockId as string))?.versionSeq as number,
		]);
		expect(back).toHaveLength(1);
		expect(back[0]).toMatchObject({ actorKind: "system", actorId: OUTLINE_HANDOFF_ACTOR });
		expect(await stateOf(s2?.blockId as string)).toMatchObject({ status: "todo", holder: null });
		expect(await stateOf(otherTask?.blockId as string)).toMatchObject({
			status: "todo",
			holder: null,
		});
		// The turn names the step it was started on.
		expect((await history(body.narratorId))[1]?.text).toContain(`${p.space.key}/${s1?.sid}`);
	});
});

describe("a step under a task someone is doing", () => {
	test("is theirs: no button on the board, and the route refuses it naming them", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const other = await narratorService.create({
			contextProjectId: p.id,
			cwd: p.dir,
			ownerUserId: alice,
			title: "The session on the parent",
			taskBackend: "outline",
		});
		const page = await write(p.space.id, alice, [
			{ op: "insert", tempId: "p", parent: null, content: "Tasks" },
			{
				op: "insert",
				tempId: "t",
				parent: { tempId: "p" },
				content: "Parent",
				task: { status: "todo" },
			},
			{ op: "insert", parent: { tempId: "t" }, content: "Its step", task: { status: "todo" } },
			{ op: "insert", parent: { tempId: "p" }, content: "Free", task: { status: "todo" } },
		]);
		const [, parent, step] = page.results as Array<{ blockId: string }>;
		const offered = async () =>
			(await readProjectTaskBoard({ userId: alice, isAdmin: false }, p.id)).sections[0]?.open
				.filter((t) => t.openSession)
				.map((t) => t.title)
				.sort();
		expect(await offered()).toEqual(["Free", "Its step", "Parent"]);
		await writeOutline({
			spaceId: p.space.id,
			ops: [{ op: "setTask", block: { id: parent?.blockId as string }, task: { status: "doing" } }],
			actor: { kind: "agent", id: other.id },
			narratorId: other.id,
			responsibleUserId: alice,
		});
		expect(await offered()).toEqual(["Free"]);
		const block = await outlineStore.getBlock(step?.blockId as string);
		const { status, body } = await open(alice, {
			id: step?.blockId as string,
			versionSeq: block?.versionSeq as number,
		});
		expect([status, body.details?.reason]).toEqual([409, "claimed"]);
		expect(body.details?.holder).toMatchObject({
			kind: "session",
			name: "The session on the parent",
		});
		expect(await stateOf(step?.blockId as string)).toMatchObject({ status: "todo", holder: null });
		expect(await sessionsOf(p.id)).toHaveLength(1);
	});

	test("a project task a session holds but was not named: its to-do steps are not started for it", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const plain = await narratorService.create({
			contextProjectId: p.id,
			cwd: p.dir,
			ownerUserId: alice,
			title: "Holder",
			taskBackend: "outline",
			startInPlanMode: false,
		});
		opened.push(plain.id);
		const page = await write(p.space.id, alice, [
			{ op: "insert", tempId: "p", parent: null, content: "Tasks" },
			{
				op: "insert",
				tempId: "t",
				parent: { tempId: "p" },
				content: "Held",
				task: { status: "todo" },
			},
			{ op: "insert", parent: { tempId: "t" }, content: "Held step", task: { status: "todo" } },
		]);
		const [, held, step] = page.results as Array<{ blockId: string }>;
		await writeOutline({
			spaceId: p.space.id,
			ops: [{ op: "setTask", block: { id: held?.blockId as string }, task: { status: "doing" } }],
			actor: { kind: "agent", id: plain.id },
			narratorId: plain.id,
			responsibleUserId: alice,
		});
		// A start that names no task (as a continuation's promotion would).
		expect((await startSpecContinuationIfPossible(plain.id, "en", false, alice)).started).toBe(
			true,
		);
		await idle(plain.id, 1);
		expect(requests).toHaveLength(1);
		expect(await stateOf(step?.blockId as string)).toMatchObject({
			status: "todo",
			holder: null,
			epoch: 0,
		});
		expect(await stateOf(held?.blockId as string)).toMatchObject({
			epoch: 1,
			lastHolder: plain.id,
		});
	});
});

describe("openTaskSession", () => {
	test("a click of the same person after the minute is a refusal, not the same session again", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const task = await taskIn(p.space.id, alice);
		const by = { kind: "human" as const, userId: alice, isAdmin: false };
		const at = Date.now();
		const first = await openTaskSession({
			taskId: task.id,
			baseVersionSeq: task.versionSeq,
			by,
			now: () => new Date(at),
		});
		opened.push(first.narratorId);
		const soon = await openTaskSession({
			taskId: task.id,
			baseVersionSeq: task.versionSeq,
			by,
			now: () => new Date(at + 59_000),
		});
		expect(soon).toMatchObject({ narratorId: first.narratorId, already: true });
		await expect(
			openTaskSession({
				taskId: task.id,
				baseVersionSeq: task.versionSeq,
				by,
				now: () => new Date(at + 61_000),
			}),
		).rejects.toMatchObject({
			reason: "claimed",
			// The person may read their own session: it is named.
			holder: { kind: "session", narratorId: first.narratorId, name: "Fix the refresh logic" },
		});
		expect(await sessionsOf(p.id)).toHaveLength(1);
		await idle(first.narratorId, 1);
	});

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

describe("the whole loop: not finished, handed off, continued by the next session (PR 10c-2)", () => {
	/** A write the model stand-in makes as the session (what its OutlineEdit would do). */
	const asSession = (spaceId: string, narratorId: string, userId: string, ops: Op[]) =>
		writeOutline({
			spaceId,
			ops,
			actor: { kind: "agent", id: narratorId },
			narratorId,
			responsibleUserId: userId,
		});

	test("the first session leaves a note and one step done; the task goes back with a handoff; the second session's brief carries it and it finishes", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const page = await write(p.space.id, alice, [
			{ op: "insert", tempId: "p", parent: null, content: "Tasks" },
			{
				op: "insert",
				tempId: "t",
				parent: { tempId: "p" },
				content: "Fix the refresh logic",
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
		]);
		const [, t, s1, s2] = page.results as Array<{ blockId: string; sid: string }>;
		const task = t?.blockId as string;
		const versionOf = async () => (await outlineStore.getBlock(task))?.versionSeq as number;

		// ── The first session: a note, the first step done, then its turn ends. ──
		let first = "";
		onTurn = async () => {
			await asSession(p.space.id, first, alice, [
				{
					op: "insert",
					parent: { id: task },
					content:
						"Refresh takes two paths; the second is not changed yet\nNext: the concurrency test",
				},
				{ op: "setTask", block: { id: s1?.blockId as string }, task: { status: "done" } },
			]);
		};
		// The id is known only once the session exists: the first turn starts after the claim.
		const opening = open(alice, { id: task, versionSeq: await versionOf() });
		const waitForSession = async () => {
			for (let i = 0; i < 400 && !first; i++) {
				first = (await sessionsOf(p.id))[0]?.id ?? "";
				if (!first) await Bun.sleep(2);
			}
		};
		await waitForSession();
		const one = await opening;
		expect(one.status).toBe(201);
		expect(one.body.narratorId).toBe(first);
		await idle(first, 1);

		expect(await stateOf(task)).toMatchObject({
			status: "todo",
			holder: null,
			lastHolder: first,
			epoch: 1,
		});
		expect(await stateOf(s1?.blockId as string)).toMatchObject({ status: "done" });
		expect(await outlineStore.listClaimedTasks(first, 10)).toHaveLength(0);
		const [handoff, ...others] = await handoffsUnder(task);
		expect(others).toHaveLength(0);
		expect(handoff?.text).toContain("Handoff (generation 1");
		expect(handoff?.text).toContain("not finished; back to do");
		expect(handoff?.lines[0]).toContain("Refresh takes two paths; the second is not changed yet");
		expect(handoff?.lines).toContain("Steps: 1 of 2 done");
		// The model wrote its note, so its last reply is not copied into the project space.
		expect(handoff?.lines.join("\n")).not.toContain("task turn ran");
		// The board: to do again, a session can be opened for it, and it says it was handed off.
		const board = await readProjectTaskBoard({ userId: alice, isAdmin: false }, p.id);
		const onBoard = board.sections.flatMap((s) => s.open).find((entry) => entry.id === task);
		expect(onBoard).toMatchObject({ status: "todo", openSession: true, handoffs: 1 });
		expect(onBoard?.previousDirectory).toBeUndefined();

		// ── The second session: its brief has the handoff and the note in full; it finishes. ──
		let second = "";
		onTurn = async () => {
			await asSession(p.space.id, second, alice, [
				{ op: "setTask", block: { id: s2?.blockId as string }, task: { status: "done" } },
				{ op: "setTask", block: { id: task }, task: { status: "done" } },
			]);
		};
		const reopening = open(alice, { id: task, versionSeq: await versionOf() });
		for (let i = 0; i < 400 && !second; i++) {
			second = (await sessionsOf(p.id)).find((row) => row.id !== first)?.id ?? "";
			if (!second) await Bun.sleep(2);
		}
		const two = await reopening;
		expect(two.status).toBe(201);
		expect(two.body).toMatchObject({ narratorId: second, epoch: 2 });
		await idle(second, 2);

		const brief = (await history(second))[0]?.text ?? "";
		expect(brief).toContain("claim generation 2");
		expect(brief).toContain("## Handoff from the previous session");
		expect(brief).toContain("This task was given back unfinished once.");
		expect(brief).toContain("- Handoff (generation 1");
		expect(brief).toContain("  - Steps: 1 of 2 done");
		expect(brief).toContain("The notes it points to, in full:");
		expect(brief).toContain("  Next: the concurrency test");
		const pos = (text: string) => brief.indexOf(text);
		expect(pos("## Handoff from the previous session")).toBeGreaterThan(-1);
		expect(pos("## Handoff from the previous session")).toBeLessThan(
			pos("## Notes and steps so far"),
		);
		// The handoff is in its own section only.
		expect(brief.split("Handoff (generation 1").length).toBe(2);

		expect(await stateOf(task)).toMatchObject({ status: "done", holder: null, epoch: 2 });
		expect(await handoffsUnder(task)).toHaveLength(1);
		expect(await outlineStore.listClaimedTasks(second, 10)).toHaveLength(0);
		// Finished: no handoff mark is left to act on, and nothing was written by the release.
		const after = await readProjectTaskBoard({ userId: alice, isAdmin: false }, p.id);
		expect(
			after.sections.flatMap((s) => s.open).find((entry) => entry.id === task),
		).toBeUndefined();
	});

	test("a person talks to the session: its turn's end keeps the task for an hour instead of giving it back", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const task = await taskIn(p.space.id, alice);
		const { body } = await open(alice, task);
		await idle(body.narratorId, 1);
		expect(await stateOf(task.id)).toMatchObject({ status: "todo", holder: null, epoch: 1 });

		// The person says "carry on"; the session takes the task up again (the next generation).
		onTurn = async () => {
			await asSession(p.space.id, body.narratorId, alice, [
				{ op: "setTask", block: { id: task.id }, task: { status: "doing" } },
			]);
		};
		const before = Date.now();
		await sendMessage(body.narratorId, "carry on with it", undefined, "en", false, null, alice);
		await idle(body.narratorId, 2);
		const kept = await stateOf(task.id);
		expect(kept).toMatchObject({ status: "doing", holder: body.narratorId, epoch: 2 });
		const [claim] = await outlineStore.getTaskClaims([task.id]);
		const lease = Date.parse(claim?.expiresAt as string) - before;
		// About an hour: neither the running lease (10 min) nor the idle one (24 h).
		expect(lease).toBeGreaterThan(50 * 60_000);
		expect(lease).toBeLessThan(70 * 60_000);
		expect(await handoffsUnder(task.id)).toHaveLength(1);
	});

	test("opened in the previous session's directory: offered on the board when it is inside the project and still there, and used when asked", async () => {
		const alice = await person("alice");
		const p = await project(alice);
		const task = await taskIn(p.space.id, alice);
		const worktree = join(p.dir, ".worktrees", "fix");
		mkdirSync(worktree, { recursive: true });
		const first = await open(alice, task, { cwd: worktree });
		expect(first.status).toBe(201);
		await idle(first.body.narratorId, 1);
		const [handoff] = await handoffsUnder(task.id);
		expect(handoff?.lines).toContain("Working directory: `.worktrees/fix`");
		const read = async () =>
			(await readProjectTaskBoard({ userId: alice, isAdmin: false }, p.id)).sections
				.flatMap((s) => s.open)
				.find((entry) => entry.id === task.id);
		const onBoard = await read();
		expect(onBoard).toMatchObject({ handoffs: 1, previousDirectory: ".worktrees/fix" });

		const second = await open(
			alice,
			{ id: task.id, versionSeq: onBoard?.versionSeq as number },
			{ previousDirectory: true, cwd: "/ignored" },
		);
		expect(second.status).toBe(201);
		const session = await db.query.narrators.findFirst({
			where: eq(narrators.id, second.body.narratorId),
			columns: { cwd: true },
		});
		expect(session?.cwd).toBe(worktree);
		await idle(second.body.narratorId, 2);

		// Gone from the disk: no longer offered, and asking for it is refused with nothing created.
		rmSync(worktree, { recursive: true, force: true });
		const gone = await read();
		expect(gone?.handoffs).toBe(2);
		expect(gone?.previousDirectory).toBeUndefined();
		const sessions = (await sessionsOf(p.id)).length;
		const refused = await open(
			alice,
			{ id: task.id, versionSeq: gone?.versionSeq as number },
			{ previousDirectory: true },
		);
		expect(refused.status).toBe(409);
		expect(refused.body.details?.reason).toBe("no_directory");
		expect(await sessionsOf(p.id)).toHaveLength(sessions);
	});

	test("a reader of the project sees the mark; someone who cannot read the space sees nothing of the task or its handoff", async () => {
		const alice = await person("alice");
		const reader = await person("reader");
		const stranger = await person("stranger");
		const p = await project(alice);
		await grant("project", p.id, reader, "read");
		const task = await taskIn(p.space.id, alice);
		const { body } = await open(alice, task);
		await idle(body.narratorId, 1);
		const seen = await readProjectTaskBoard({ userId: reader, isAdmin: false }, p.id);
		const entry = seen.sections.flatMap((s) => s.open).find((e) => e.id === task.id);
		expect(entry?.handoffs).toBe(1);
		// A reader cannot open sessions: no button, and no directory is looked up for them.
		expect(entry?.openSession).toBeUndefined();
		expect(entry?.previousDirectory).toBeUndefined();
		const hidden = await readProjectTaskBoard({ userId: stranger, isAdmin: false }, p.id);
		expect(hidden.sections.flatMap((s) => [...s.open, ...s.finished])).toHaveLength(0);
	});
});
