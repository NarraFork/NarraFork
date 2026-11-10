/**
 * The old Dynamic Spec plugin commands in an outline session (outline P2 PR 12a; PR 12 design
 * §2.10): the same calls against a spec session and an outline session, through the real public
 * API, answer in the same shape with the same task list (`revisionId` aside), refuse the same
 * protected-task changes with the same error, and the outline session's tasks end up as the
 * outline should hold them. Every converted call is marked in the audit record and warned about
 * once an hour per plugin and command. Spec sessions are unchanged (their side of every case runs
 * the spec path as before).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators, outlineQuestions, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { settings } from "../../lib/settings";
import { readSpecTasksForPlugin, writeSpecForPlugin } from "../narrator-session";
import { OUTLINE_BEHAVIOR_ALIAS } from "../outline/model";
import { OUTLINE_TASKS_PAGE_ALIAS } from "../outline/person-tasks";
import { ensureSessionSpace } from "../outline/spaces";
import { outlineStore } from "../outline/store";
import { writeOutline } from "../outline/write";
import {
	type CapabilityBroker,
	type CommandResult,
	createCommandRequest,
	createCorePluginPublicApiAdapters,
	type HostCallContext,
	PluginPublicApi,
	type PluginPublicApiAuditEntry,
} from "../plugin-public-api";
import { specIndexSid } from "../plugin-spec-compat";
import {
	noteSpecCompatCall,
	resetSpecCompatTelemetry,
	SPEC_COMPAT_TELEMETRY,
} from "../plugin-spec-compat-telemetry";
import { readSpecFile } from "../spec-vfs-service";
import { invalidateTaskBackend } from "../task-source";

const NOW = "2026-11-08T00:00:00.000Z";
const PLUGIN = "com.example.team";

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
	resetSpecCompatTelemetry();
});

const audit: PluginPublicApiAuditEntry[] = [];
const broker: CapabilityBroker = { authorize: async () => ({ allowed: true }) };
const api = new PluginPublicApi({
	capabilityBroker: broker,
	adapters: createCorePluginPublicApiAdapters({
		db,
		pluginManager: {
			list: async () => [],
			getStatus: async () => undefined,
			enable: async () => {
				throw new Error("not used");
			},
			disable: async () => {
				throw new Error("not used");
			},
		},
	}),
	auditSink: { write: (entry) => void audit.push(entry) },
	cursorSecret: "plugin-spec-compat-test-cursor-secret-32by",
});

let sequence = 0;
async function command(name: string, input: Record<string, unknown>): Promise<CommandResult> {
	sequence++;
	const ctx = {
		requestId: `request-${sequence}`,
		correlationId: `correlation-${sequence}`,
		deadlineAt: new Date(Date.now() + 30_000).toISOString(),
		plugin: {
			pluginId: PLUGIN,
			packageVersion: "1.0.0",
			runtimeId: "runtime-1",
			runtimeGeneration: 1,
			installationId: "installation-1",
		},
		invocation: { kind: "plugin_background", source: "event" },
		scope: {},
	} as HostCallContext;
	return await api.command(ctx, createCommandRequest(ctx, `narrafork.narrator.${name}`, input));
}

async function session(backend: "spec" | "outline"): Promise<string> {
	const owner = generateId();
	await db.insert(users).values({
		id: owner,
		username: `psc${owner.replace(/[^A-Za-z0-9]/g, "")}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		status: "idle",
		cwd: "/tmp",
		taskBackend: backend,
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

/** A pair: the same calls against both. */
async function pair() {
	return { spec: await session("spec"), outline: await session("outline") };
}

type Data = Record<string, unknown>;

/** Both answers, which must agree on status and shape; `revisionId` differs by design. */
async function both(
	ids: { spec: string; outline: string },
	name: string,
	input: Record<string, unknown>,
): Promise<{ spec: CommandResult; outline: CommandResult }> {
	const spec = await command(name, { ...input, narratorId: ids.spec });
	const outline = await command(name, { ...input, narratorId: ids.outline });
	expect(outline.status).toBe(spec.status);
	expect(outline.error?.code).toBe(spec.error?.code);
	if (spec.status === "succeeded") {
		expect(Object.keys(outline.data as Data).sort()).toEqual(Object.keys(spec.data as Data).sort());
		const specRevision = (spec.data as Data).revisionId;
		const outlineRevision = (outline.data as Data).revisionId;
		expect(typeof outlineRevision).toBe(typeof specRevision);
		if (typeof outlineRevision === "string") expect(outlineRevision).toMatch(/^outline:[^:]+:\d+$/);
	}
	return { spec, outline };
}

/** `spec_tasks_get` of both, which must be the same list. */
async function sameList(ids: { spec: string; outline: string }) {
	const { spec, outline } = await both(ids, "spec_tasks_get", {});
	const s = spec.data as { content: string; compiled: unknown };
	const o = outline.data as { content: string; compiled: unknown };
	expect(o.compiled).toEqual(s.compiled);
	expect(JSON.parse(o.content)).toEqual(JSON.parse(s.content));
	return o.compiled as {
		tasks: Array<{ text: string; status: string; protected: boolean }>;
		openCount: number;
		protectedOpenCount: number;
	};
}

const doc = (tasks: Array<Record<string, unknown>>) => JSON.stringify({ tasks });

/** The outline session's task page children: text, status, created by a person, locked. */
async function taskPage(narratorId: string) {
	const space = await ensureSessionSpace(narratorId);
	const [page] = await outlineStore.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
	if (!page) return [];
	const rows = await outlineStore.listChildren(space.id, page.id, 100);
	return rows.map((row) => ({
		id: row.id,
		text: row.content,
		status: row.taskJson?.status ?? null,
		humanCreated: row.taskJson?.humanCreated === true,
		locked: !!row.taskJson?.lock,
	}));
}

describe("the same calls on a spec session and an outline session", () => {
	test("add, read, overwrite (reorder, status, new), and the list stays the same", async () => {
		const ids = await pair();
		expect(await sameList(ids)).toEqual({ tasks: [], openCount: 0, protectedOpenCount: 0 });

		const first = await both(ids, "spec_task_add", { text: "Write tests" });
		expect(first.outline.data).toMatchObject({
			added: true,
			taskText: "Write tests",
			protected: false,
		});
		const goal = await both(ids, "spec_task_add", { text: "Ship", protected: true });
		expect(goal.outline.data).toMatchObject({ added: true, protected: true });
		const again = await both(ids, "spec_task_add", { text: "Write tests" });
		expect(again.outline.data).toMatchObject({ added: false, protected: false });
		const againGoal = await both(ids, "spec_task_add", { text: "Ship" });
		expect(againGoal.outline.data).toMatchObject({ added: false, protected: true });
		expect(await sameList(ids)).toEqual({
			tasks: [
				{ text: "Write tests", status: "todo", protected: false },
				{ text: "Ship", status: "todo", protected: true },
			],
			openCount: 2,
			protectedOpenCount: 1,
		});
		// D52: the plugin's protected task is a person's, not locked.
		expect((await taskPage(ids.outline)).map((t) => [t.text, t.humanCreated, t.locked])).toEqual([
			["Write tests", false, false],
			["Ship", true, false],
		]);

		const write = await both(ids, "spec_write", {
			uri: "tasks.json",
			content: doc([
				{ text: "Ship", status: "doing", protected: true },
				{ text: "Write tests", status: "done" },
				{ text: "Review", status: "todo", protected: true },
			]),
		});
		expect(write.outline.data).toMatchObject({ path: "tasks.json", uri: "spec://tasks.json" });
		const list = await sameList(ids);
		expect(list.tasks.map((t) => [t.text, t.status, t.protected])).toEqual([
			["Ship", "doing", true],
			["Write tests", "done", false],
			["Review", "todo", true],
		]);
		const page = await taskPage(ids.outline);
		expect(page.map((t) => [t.text, t.status, t.humanCreated, t.locked])).toEqual([
			["Ship", "doing", true, false],
			["Write tests", "done", false, false],
			["Review", "todo", true, false],
		]);
		// In progress for the session (its claim).
		const [claim] = await outlineStore.getTaskClaims([page[0]?.id as string]);
		expect(claim?.holderNarratorId).toBe(ids.outline);

		// An open task no longer listed: gone from the list on both; cancelled (not deleted) in the
		// outline.
		await both(ids, "spec_task_add", { text: "Temp" });
		const kept = doc([
			{ text: "Ship", status: "doing", protected: true },
			{ text: "Write tests", status: "done" },
			{ text: "Review", status: "todo", protected: true },
		]);
		await both(ids, "spec_write", { uri: "tasks.json", content: kept });
		expect((await sameList(ids)).tasks.map((t) => t.text)).toEqual([
			"Ship",
			"Write tests",
			"Review",
		]);
		expect((await taskPage(ids.outline)).map((t) => [t.text, t.status])).toEqual([
			["Ship", "doing"],
			["Write tests", "done"],
			["Review", "todo"],
			["Temp", "cancelled"],
		]);
		// Writing the same list again writes nothing.
		const space = await ensureSessionSpace(ids.outline);
		const commits = (await outlineStore.listCommits(space.id, { limit: 100 })).length;
		await both(ids, "spec_write", { uri: "tasks.json", content: kept });
		expect(await outlineStore.listCommits(space.id, { limit: 100 })).toHaveLength(commits);

		// A done task no longer listed stays done in the outline (review S3: it is finished work,
		// the report counts it so), and is still listed; the spec file drops it.
		await both(ids, "spec_write", {
			uri: "tasks.json",
			content: doc([
				{ text: "Ship", status: "doing", protected: true },
				{ text: "Review", status: "todo", protected: true },
			]),
		});
		expect(await outlineStore.listCommits(space.id, { limit: 100 })).toHaveLength(commits);
		const outline = await command("spec_tasks_get", { narratorId: ids.outline });
		expect(
			(outline.data as { compiled: { tasks: Array<{ text: string }> } }).compiled.tasks.map(
				(t) => t.text,
			),
		).toEqual(["Ship", "Write tests", "Review"]);
		// The spec session's file is what it always was.
		expect(
			JSON.parse((await readSpecFile(ids.spec, "spec://tasks.json")).content).tasks,
		).toHaveLength(2);
		expect(await outlineStore.findSpace({ kind: "session", narratorId: ids.spec })).toBeNull();
	});

	test("finishing, dropping or un-protecting an open protected task is refused alike: CONFLICT", async () => {
		const ids = await pair();
		await both(ids, "spec_task_add", { text: "Ship", protected: true });
		await both(ids, "spec_task_add", { text: "Other" });
		await both(ids, "spec_task_add", { text: "Ship too", protected: true });
		const attempts = [
			doc([
				{ text: "Ship", status: "done", protected: true },
				{ text: "Other", status: "todo" },
				{ text: "Ship too", status: "todo", protected: true },
			]),
			doc([
				{ text: "Other", status: "todo" },
				{ text: "Ship too", status: "todo", protected: true },
			]),
			doc([
				{ text: "Ship", status: "todo" },
				{ text: "Other", status: "todo" },
				{ text: "Ship too", status: "todo", protected: true },
			]),
			// Two at once: the lines in the same order (review N6).
			doc([
				{ text: "Ship", status: "done", protected: true },
				{ text: "Other", status: "todo" },
			]),
		];
		for (const content of attempts) {
			const { spec, outline } = await both(ids, "spec_write", { uri: "tasks.json", content });
			// Owner decision 4: a permanent refusal says so, with what it touched, in both sessions.
			expect(spec.error?.code).toBe("CONFLICT");
			expect(spec.error?.message).toContain("requires taskReflection");
			expect(outline.error).toEqual(spec.error);
		}
		expect(
			(await both(ids, "spec_write", { uri: "tasks.json", content: attempts[3] as string })).spec
				.error?.message,
		).toMatch(/- complete: Ship \(.*\)\n- delete: Ship too \(/);
		expect(await sameList(ids)).toMatchObject({ protectedOpenCount: 2 });
		expect((await taskPage(ids.outline)).map((t) => t.status)).toEqual(["todo", "todo", "todo"]);
		// Invalid documents are refused alike too.
		for (const content of [
			"not json",
			doc([{ text: "x", status: "later" }]),
			'{"tasks":[],"x":1}',
		]) {
			const { spec, outline } = await both(ids, "spec_write", { uri: "tasks.json", content });
			expect(spec.status).not.toBe("succeeded");
			expect(outline.error).toEqual(spec.error);
		}
	});

	test("the fence command and index.md answer in the spec shape", async () => {
		const ids = await pair();
		const upsert = await both(ids, "spec_behavior_fence_update", {
			mode: "upsert",
			text: "Report to the lead.",
		});
		expect(upsert.outline.data).toMatchObject({ updated: true });
		const cleared = await both(ids, "spec_behavior_fence_update", { mode: "clear" });
		expect(cleared.outline.data).toMatchObject({ updated: true });
		const index = await both(ids, "spec_write", { uri: "index.md", content: "# Notes\n\nHello" });
		expect(index.outline.data).toMatchObject({ path: "index.md", uri: "spec://index.md" });
		const empty = await both(ids, "spec_write", { uri: "index.md", content: "   " });
		expect(empty.spec.status).not.toBe("succeeded");
	});

	test("every converted call is marked in the audit; the spec session's calls are not", async () => {
		const ids = await pair();
		audit.length = 0;
		await both(ids, "spec_task_add", { text: "A" });
		await both(ids, "spec_tasks_get", {});
		await both(ids, "spec_write", { uri: "tasks.json", content: doc([]) });
		await both(ids, "spec_behavior_fence_update", { mode: "clear" });
		// A refused conversion is marked too.
		await both(ids, "spec_write", { uri: "tasks.json", content: "not json" });
		expect(audit.map((entry) => [entry.methodId.split(".").at(-1), entry.compat])).toEqual([
			["spec_task_add", undefined],
			["spec_task_add", "outline"],
			["spec_tasks_get", undefined],
			["spec_tasks_get", "outline"],
			["spec_write", undefined],
			["spec_write", "outline"],
			["spec_behavior_fence_update", undefined],
			["spec_behavior_fence_update", "outline"],
			["spec_write", undefined],
			["spec_write", "outline"],
		]);
	});
});

describe("the list in an outline session", () => {
	test("top-level tasks in document order; waiting reads blocked, cancelled and rules are left out", async () => {
		const id = await session("outline");
		const space = await ensureSessionSpace(id);
		const seeded = await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "insert", tempId: "plan", parent: null, content: "Plan", task: { status: "doing" } },
				{ op: "insert", parent: { tempId: "plan" }, content: "Step", task: { status: "todo" } },
				{ op: "insert", tempId: "notes", parent: null, content: "Notes" },
				{
					op: "insert",
					parent: { tempId: "notes" },
					content: "Under a note",
					task: { status: "todo" },
				},
				{ op: "insert", parent: null, content: "Dropped", task: { status: "cancelled" } },
				{
					op: "insert",
					tempId: "rules",
					parent: null,
					content: "Rules",
					alias: OUTLINE_BEHAVIOR_ALIAS,
				},
				{ op: "insert", parent: { tempId: "rules" }, content: "A rule", task: { status: "todo" } },
				{ op: "insert", parent: null, content: "Done one", task: { status: "done" } },
			],
			actor: { kind: "human", id: "pat" },
			responsibleUserId: null,
		});
		await writeOutline({
			spaceId: space.id,
			ops: [
				{
					op: "insert",
					parent: null,
					content: "Waits for the step",
					task: {
						status: "todo",
						depends: [{ target: seeded.results[1]?.address as string, label: null }],
					},
				},
			],
			actor: { kind: "human", id: "pat" },
			responsibleUserId: null,
		});
		const result = await command("spec_tasks_get", { narratorId: id });
		const data = result.data as {
			revisionId: string;
			compiled: { tasks: unknown[]; openCount: number; protectedOpenCount: number };
		};
		expect(data.compiled).toEqual({
			tasks: [
				{ text: "Plan", status: "doing", protected: false },
				{ text: "Under a note", status: "todo", protected: false },
				{ text: "Done one", status: "done", protected: false },
				{ text: "Waits for the step", status: "blocked", protected: false },
			],
			openCount: 3,
			protectedOpenCount: 0,
		});
		const seq = ((await outlineStore.getSpace(space.id))?.nextSeq ?? 1) - 1;
		expect(data.revisionId).toBe(`outline:${space.key}:${seq}`);
	});
});

describe("the overwrite in an outline session", () => {
	test("only the task page's own tasks are cancelled; a plan's tasks are left alone, notes stay", async () => {
		const id = await session("outline");
		await command("spec_task_add", { narratorId: id, text: "On the page" });
		const space = await ensureSessionSpace(id);
		const [page] = await outlineStore.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
		const [onPage] = await outlineStore.listChildren(space.id, page?.id as string, 10);
		const plan = await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "insert", tempId: "plan", parent: null, content: "Plan" },
				{
					op: "insert",
					parent: { tempId: "plan" },
					content: "Plan step",
					task: { status: "todo" },
				},
				{ op: "insert", parent: { id: onPage?.id as string }, content: "A note under it" },
			],
			actor: { kind: "human", id: "pat" },
			responsibleUserId: null,
		});
		const listed = await command("spec_tasks_get", { narratorId: id });
		expect(
			(listed.data as { compiled: { tasks: Array<{ text: string }> } }).compiled.tasks.map(
				(t) => t.text,
			),
		).toEqual(["On the page", "Plan step"]);
		const written = await command("spec_write", {
			narratorId: id,
			uri: "tasks.json",
			content: doc([]),
		});
		expect(written.status).toBe("succeeded");
		expect((await outlineStore.getBlock(onPage?.id as string))?.taskJson?.status).toBe("cancelled");
		expect(
			(await outlineStore.getBlock(plan.results[1]?.blockId as string))?.taskJson?.status,
		).toBe("todo");
		expect((await outlineStore.getBlock(plan.results[2]?.blockId as string))?.deleted).toBe(false);
		// The plan's task is still listed (it was left alone); the cancelled one is not.
		const after = await command("spec_tasks_get", { narratorId: id });
		expect(
			(after.data as { compiled: { tasks: Array<{ text: string }> } }).compiled.tasks.map(
				(t) => t.text,
			),
		).toEqual(["Plan step"]);
	});

	test("blocked: in progress with the plugin's note, read back as blocked, never written twice (S5)", async () => {
		const id = await session("outline");
		const blocked = doc([{ text: "Stuck", status: "blocked" }]);
		await command("spec_write", { narratorId: id, uri: "tasks.json", content: blocked });
		const [task] = await taskPage(id);
		expect(task).toMatchObject({ text: "Stuck", status: "doing" });
		const space = await ensureSessionSpace(id);
		const notes = async () =>
			(await outlineStore.listChildren(space.id, task?.id as string, 10)).map((b) => b.content);
		expect(await notes()).toEqual([`Blocked (marked by plugin ${PLUGIN})`]);
		expect(
			await db.select().from(outlineQuestions).where(eq(outlineQuestions.spaceId, space.id)),
		).toEqual([]);
		// Read back as blocked (owner decision 2), by both reads.
		const list = async () =>
			(
				(await command("spec_tasks_get", { narratorId: id })).data as {
					compiled: { tasks: unknown[] };
				}
			).compiled.tasks;
		expect(await list()).toEqual([{ text: "Stuck", status: "blocked", protected: false }]);
		const read = await command("tasks_read", { narratorId: id });
		expect((read.data as { tasks: Array<Record<string, unknown>> }).tasks[0]).toMatchObject({
			text: "Stuck",
			status: "doing",
			blocked: true,
		});
		// The same list again writes nothing: no second note, no commit.
		const commits = (await outlineStore.listCommits(space.id, { limit: 100 })).length;
		for (let i = 0; i < 3; i++)
			await command("spec_write", { narratorId: id, uri: "tasks.json", content: blocked });
		expect(await outlineStore.listCommits(space.id, { limit: 100 })).toHaveLength(commits);
		expect(await notes()).toHaveLength(1);
		// Unblocked: the note goes; blocked again: it comes back (its short id is the task's).
		await command("spec_write", {
			narratorId: id,
			uri: "tasks.json",
			content: doc([{ text: "Stuck", status: "doing" }]),
		});
		expect(await notes()).toEqual([]);
		expect(await list()).toEqual([{ text: "Stuck", status: "doing", protected: false }]);
		await command("spec_write", { narratorId: id, uri: "tasks.json", content: blocked });
		expect(await notes()).toEqual([`Blocked (marked by plugin ${PLUGIN})`]);
		// The session finishes it; the plugin marks it blocked again: back in progress, the note it
		// still has is not written a second time.
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: task?.id as string }, task: { status: "done" } }],
			actor: { kind: "agent", id },
			narratorId: id,
			responsibleUserId: null,
		});
		expect(await list()).toEqual([{ text: "Stuck", status: "done", protected: false }]);
		const again = await command("spec_write", {
			narratorId: id,
			uri: "tasks.json",
			content: blocked,
		});
		expect(again.status).toBe("succeeded");
		expect(await notes()).toEqual([`Blocked (marked by plugin ${PLUGIN})`]);
		expect(await list()).toEqual([{ text: "Stuck", status: "blocked", protected: false }]);
		// A person moves the note away: the task no longer reads blocked, and marking it again
		// brings the same note back under it (round 2, nit 3).
		const [noteRow] = await outlineStore.listChildren(space.id, task?.id as string, 10);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "move", block: { id: noteRow?.id as string }, parent: null }],
			actor: { kind: "human", id: "pat" },
			responsibleUserId: null,
		});
		expect(await list()).toEqual([{ text: "Stuck", status: "doing", protected: false }]);
		const marked = await command("spec_write", {
			narratorId: id,
			uri: "tasks.json",
			content: blocked,
		});
		expect(marked.status).toBe("succeeded");
		expect(await notes()).toEqual([`Blocked (marked by plugin ${PLUGIN})`]);
		// A status the plugin sets through the block command ends the mark too.
		await command("task_set_status", {
			narratorId: id,
			blockId: task?.id,
			status: "todo",
		});
		expect(await notes()).toEqual([]);
	});

	test("a task a person locked is not finished or cancelled by the overwrite (review S2)", async () => {
		const id = await session("outline");
		await command("spec_task_add", { narratorId: id, text: "Agent work" });
		await command("spec_task_add", { narratorId: id, text: "Free" });
		const [work] = await taskPage(id);
		const space = await ensureSessionSpace(id);
		await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "setTask", block: { id: work?.id as string }, task: { lock: { delegate: null } } },
			],
			actor: { kind: "human", id: "pat" },
			responsibleUserId: null,
		});
		for (const content of [
			doc([
				{ text: "Agent work", status: "done" },
				{ text: "Free", status: "todo" },
			]),
			doc([{ text: "Free", status: "todo" }]),
		]) {
			const refused = await command("spec_write", { narratorId: id, uri: "tasks.json", content });
			expect(refused.error?.code).toBe("CONFLICT");
			expect(refused.error?.message).toContain("Agent work (Task is locked by a person");
		}
		expect((await taskPage(id)).map((t) => [t.text, t.status, t.locked])).toEqual([
			["Agent work", "todo", true],
			["Free", "todo", false],
		]);
		// Starting it, or finishing the free one, is the plugin's to do.
		const fine = await command("spec_write", {
			narratorId: id,
			uri: "tasks.json",
			content: doc([
				{ text: "Agent work", status: "doing" },
				{ text: "Free", status: "done" },
			]),
		});
		expect(fine.status).toBe("succeeded");
	});

	test("over 100 tasks: every open one, then the latest done ones; no duplicate on write-back (S4)", async () => {
		const id = await session("outline");
		await command("spec_task_add", { narratorId: id, text: "Seed" });
		const space = await ensureSessionSpace(id);
		const [page] = await outlineStore.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
		for (let i = 0; i < 120; i += 60)
			await writeOutline({
				spaceId: space.id,
				ops: Array.from({ length: 60 }, (_, n) => ({
					op: "insert" as const,
					parent: { id: page?.id as string },
					content: `Old ${i + n}`,
					task: { status: "done" as const },
				})),
				actor: { kind: "human", id: "pat" },
				responsibleUserId: null,
			});
		await command("spec_task_add", { narratorId: id, text: "Fresh work" });
		const read = await command("spec_tasks_get", { narratorId: id });
		const compiled = (
			read.data as {
				compiled: { tasks: Array<{ text: string; status: string }>; openCount: number };
			}
		).compiled;
		expect(compiled.tasks).toHaveLength(100);
		expect(compiled.openCount).toBe(2);
		expect(compiled.tasks.map((t) => t.text)).toContain("Fresh work");
		expect(compiled.tasks.map((t) => t.text)).toContain("Seed");
		// The most recent done ones fill the rest: the second batch whole, part of the first.
		const listed = new Set(compiled.tasks.map((t) => t.text));
		for (let n = 60; n < 120; n++) expect(listed.has(`Old ${n}`)).toBe(true);
		const left = Array.from({ length: 60 }, (_, n) => `Old ${n}`).filter((t) => !listed.has(t));
		expect(left).toHaveLength(22);
		// Written back as read, and with a done task the list left out: nothing new is added.
		const before = (await taskPage(id)).length;
		const commits = (await outlineStore.listCommits(space.id, { limit: 100 })).length;
		const back = await command("spec_write", {
			narratorId: id,
			uri: "tasks.json",
			content: doc([
				// One listed done task left out for room (left alone: S3), one the list left out added.
				...compiled.tasks
					.filter((t) => t.text !== "Old 119")
					.map((t) => ({ text: t.text, status: t.status })),
				{ text: left[0] as string, status: "done" },
			]),
		});
		expect(back.status).toBe("succeeded");
		expect(await taskPage(id)).toHaveLength(before);
		expect(await outlineStore.listCommits(space.id, { limit: 100 })).toHaveLength(commits);
	});

	test("texts match as stored: markup a plugin wrote raw does not churn the list", async () => {
		const id = await session("outline");
		const content = doc([{ text: "Fix a*b in [docs]", status: "todo" }]);
		await command("spec_write", { narratorId: id, uri: "tasks.json", content });
		const [first] = await taskPage(id);
		await command("spec_write", { narratorId: id, uri: "tasks.json", content });
		const page = await taskPage(id);
		expect(page.map((t) => [t.id, t.status])).toEqual([[first?.id, "todo"]]);
	});

	test("a full list of long tasks reads and writes back; new text past one commit writes nothing", async () => {
		const id = await session("outline");
		const space = await ensureSessionSpace(id);
		const texts = Array.from({ length: 100 }, (_, n) => `${n} ${"任务正文".repeat(249)}`);
		for (let i = 0; i < texts.length; i += 25) {
			await writeOutline({
				spaceId: space.id,
				ops: texts.slice(i, i + 25).map((content) => ({
					op: "insert" as const,
					parent: null,
					content,
					task: { status: "todo" as const },
				})),
				actor: { kind: "human", id: "pat" },
				responsibleUserId: null,
			});
		}
		// Through the session layer: the public API caps one string at 64 KiB, which this list's
		// tasks.json is over in either backend (as before; not a conversion matter).
		const read = await readSpecTasksForPlugin(id, { pluginId: PLUGIN });
		const listed = read.compiled.tasks;
		expect(listed.map((t) => t.text)).toEqual(texts);
		// Written back as read: matched, nothing to write (the texts are normalized in several jobs).
		const commits = (await outlineStore.listCommits(space.id, { limit: 100 })).length;
		await writeSpecForPlugin(
			id,
			"tasks.json",
			doc(listed.map((t) => ({ text: t.text, status: "todo" }))),
			{ pluginId: PLUGIN },
		);
		expect(await outlineStore.listCommits(space.id, { limit: 100 })).toHaveLength(commits);
		// Replaced by as many new long tasks: more text than one commit carries; nothing written.
		const replaced = await command("spec_write", {
			narratorId: id,
			uri: "tasks.json",
			content: doc(texts.map((text) => ({ text: `new ${text.slice(0, 990)}`, status: "todo" }))),
		});
		expect(replaced.error?.code).toBe("PAYLOAD_TOO_LARGE");
		expect(await outlineStore.listCommits(space.id, { limit: 100 })).toHaveLength(commits);
	});

	test("index.md: a page of notes, replaced on the next write; too large writes nothing", async () => {
		const id = await session("outline");
		const notes = "# Design\n\n- [ ] not a task\n- see [[x]]\n\n## Later\n\nMore.";
		expect(
			(await command("spec_write", { narratorId: id, uri: "index.md", content: notes })).status,
		).toBe("succeeded");
		const space = await ensureSessionSpace(id);
		const [page] = await outlineStore.getBlockMetas(space.id, { sids: [specIndexSid()] });
		expect(page?.parentId).toBeNull();
		const structure = await outlineStore.listPageStructure(page?.id as string, {
			asOf: null,
			limit: 100,
		});
		expect(structure.rows.some((row) => row.taskJson !== null)).toBe(false);
		expect(structure.rows.length).toBeGreaterThan(3);
		await command("spec_write", { narratorId: id, uri: "index.md", content: "Just this." });
		expect(
			(await outlineStore.listChildren(space.id, page?.id as string, 10)).map((b) => b.content),
		).toEqual(["Just this."]);
		// A task on the page is kept by a rewrite; a person's task under a note refuses it (N1).
		const seeded = await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "insert", tempId: "note", parent: { id: page?.id as string }, content: "A note" },
				{
					op: "insert",
					parent: { tempId: "note" },
					content: "A person's task",
					task: { status: "todo", humanCreated: true },
				},
				{
					op: "insert",
					parent: { id: page?.id as string },
					content: "A task on the page",
					task: { status: "todo" },
				},
			],
			actor: { kind: "human", id: "pat" },
			responsibleUserId: null,
		});
		const guarded = await command("spec_write", {
			narratorId: id,
			uri: "index.md",
			content: "Replaced.",
		});
		expect(guarded.error?.code).toBe("CONFLICT");
		const children = async () =>
			(await outlineStore.listChildren(space.id, page?.id as string, 10)).map((b) => b.content);
		expect(await children()).toEqual(["Just this.", "A note", "A task on the page"]);
		// The person takes their note away: the rewrite goes through and keeps the page's task.
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "delete", block: { id: seeded.results[0]?.blockId as string } }],
			actor: { kind: "human", id: "pat" },
			responsibleUserId: null,
		});
		await command("spec_write", { narratorId: id, uri: "index.md", content: "Just this." });
		expect(await children()).toEqual(["A task on the page", "Just this."]);
		const big = Array.from({ length: 300 }, (_, n) => `Paragraph ${n}.`).join("\n\n");
		const refused = await command("spec_write", { narratorId: id, uri: "index.md", content: big });
		expect(refused.error?.code).toBe("PAYLOAD_TOO_LARGE");
		expect(await children()).toEqual(["A task on the page", "Just this."]);
	});
});

describe("the hourly warning", () => {
	test("once an hour per plugin and command, counting the calls in between", () => {
		const warn = spyOn(logger, "warn");
		try {
			const t0 = 1_000_000;
			expect(noteSpecCompatCall("p.one", "spec_tasks_get", t0)).toBe(true);
			expect(noteSpecCompatCall("p.one", "spec_tasks_get", t0 + 1)).toBe(false);
			expect(noteSpecCompatCall("p.one", "spec_tasks_get", t0 + 2)).toBe(false);
			// Another command, another plugin: their own hour.
			expect(noteSpecCompatCall("p.one", "spec_write", t0 + 3)).toBe(true);
			expect(noteSpecCompatCall("p.two", "spec_tasks_get", t0 + 4)).toBe(true);
			expect(
				noteSpecCompatCall("p.one", "spec_tasks_get", t0 + SPEC_COMPAT_TELEMETRY.warnEveryMs),
			).toBe(true);
			const calls = warn.mock.calls.filter((call) =>
				String(call[0]).includes("still uses a Dynamic Spec command"),
			);
			expect(calls).toHaveLength(4);
			expect(calls[3]?.[1]).toMatchObject({
				pluginId: "p.one",
				command: "narrafork.narrator.spec_tasks_get",
				replacement: "narrafork.narrator.tasks_read",
				callsSinceLastWarning: 3,
			});
		} finally {
			warn.mockRestore();
		}
	});

	test("a converted call through the API warns once, a spec session's never", async () => {
		const warn = spyOn(logger, "warn");
		try {
			const ids = await pair();
			for (let i = 0; i < 3; i++) await both(ids, "spec_tasks_get", {});
			const calls = warn.mock.calls.filter((call) =>
				String(call[0]).includes("still uses a Dynamic Spec command"),
			);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.[1]).toMatchObject({ pluginId: PLUGIN });
		} finally {
			warn.mockRestore();
		}
	});
});
