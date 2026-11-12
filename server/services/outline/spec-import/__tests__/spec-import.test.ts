/**
 * The import of a Dynamic Spec session into the outline (outline P2 PR 12b): the mapping task by
 * task (D52, D54), notes, idempotence, resuming, a source that changed, and what is never
 * imported. Sessions are made through the real spec write path (`fixtures.ts`).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eventBus } from "../../../../lib/event-bus";
import { settings } from "../../../../lib/settings";
import { specIndexSid } from "../../../plugin-spec-compat";
import { readSpecFile, writeSpecFile } from "../../../spec-vfs-service";
import { invalidateTaskBackend } from "../../../task-source";
import { readTaskBackend } from "../../../task-source/backend";
import { stopEditTextWorker } from "../../edit-text-runner";
import { outlineStore } from "../../store";
import { writeOutline } from "../../write";
import { importSpecSession, resetSpecImportRecords, specImportRecord } from "../importer";
import {
	backendOf,
	commitCount,
	makeSession,
	makeUser,
	pages,
	taskPage,
	writeNote,
	writeTasks,
} from "./fixtures";

beforeEach(() => {
	settings.outline.enabled = true;
	settings.outline.specImport = "auto";
	invalidateTaskBackend();
	resetSpecImportRecords();
});
afterAll(() => stopEditTextWorker());

/** Call `fn` at every outline commit until the returned function is called. */
function onCommit(fn: () => void): () => void {
	eventBus.on("outline:committed", fn);
	return () => eventBus.off("outline:committed", fn);
}

const run = (id: string) => importSpecSession(id, { trigger: "manual" });

describe("tasks", () => {
	test("every task arrives in order with its state, and the session is moved", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [
			{ text: "first, to do" },
			{ text: "second, in progress", status: "doing" },
			{ text: "third, done", status: "done" },
			{ text: "fourth, blocked", status: "blocked" },
		]);
		const outcome = await run(id);
		expect(outcome).toMatchObject({ status: "imported", tasks: 4 });
		expect(await backendOf(id)).toBe("outline");
		expect(await readTaskBackend(id)).toBe("outline");
		const tasks = await taskPage(id);
		expect(tasks.map((t) => [t.text, t.status])).toEqual([
			["first, to do", "todo"],
			["second, in progress", "doing"],
			["third, done", "done"],
			["fourth, blocked", "doing"],
		]);
		// In progress is the session's claim, by the write path.
		expect(tasks[1]?.holder).toBe(id);
		expect(tasks[0]?.holder).toBeNull();
		// Blocked: a note under it, and no question.
		expect(tasks[3]?.children).toHaveLength(1);
		expect(tasks[3]?.children[0]).toContain("Blocked");
		expect(tasks.every((t) => t.manager === `agent:${id}`)).toBe(true);
		expect(owner).not.toBeNull();
		// Dynamic Spec rows are untouched.
		expect(specImportRecord(id)?.status).toBe("imported");
	});

	test("only a task a person protected is locked; an agent's is a person's task, unlocked (D52)", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [{ text: "the person's goal", protected: true }], "user");
		await writeTasks(
			id,
			[
				{ text: "the person's goal", protected: true },
				{ text: "the agent's protected", protected: true },
				{ text: "plain" },
			],
			"assistant",
		);
		expect((await run(id)).status).toBe("imported");
		const tasks = await taskPage(id);
		expect(tasks.map((t) => [t.text, t.humanCreated, t.lockedBy, t.manager])).toEqual([
			["the person's goal", true, `human:${owner}`, `human:${owner}`],
			["the agent's protected", true, null, `agent:${id}`],
			["plain", false, null, `agent:${id}`],
		]);
	});

	test("an archived session: in progress comes in to do with a note; blocked to do with its note (D54)", async () => {
		const { id } = await makeSession({ archived: true });
		await writeTasks(id, [
			{ text: "was doing", status: "doing" },
			{ text: "was blocked", status: "blocked" },
			{ text: "done", status: "done" },
		]);
		expect((await run(id)).status).toBe("imported");
		const tasks = await taskPage(id);
		expect(tasks.map((t) => [t.status, t.holder, t.children.length])).toEqual([
			["todo", null, 1],
			["todo", null, 1],
			["done", null, 0],
		]);
		expect(tasks[0]?.children[0]).toContain("archived");
	});

	test("a session without an owner locks nothing", async () => {
		const { id } = await makeSession({ owner: null });
		await writeTasks(id, [{ text: "goal", protected: true }], "user");
		expect((await run(id)).status).toBe("imported");
		expect((await taskPage(id)).map((t) => [t.humanCreated, t.lockedBy])).toEqual([[true, null]]);
	});

	test("notes are written in the owner's language", async () => {
		const owner = await makeUser("zh-CN");
		const { id } = await makeSession({ owner });
		await writeTasks(id, [{ text: "卡住的任务", status: "blocked" }]);
		expect((await run(id)).status).toBe("imported");
		expect((await taskPage(id))[0]?.children[0]).toContain("受阻");
	});
});

describe("notes", () => {
	test("each file is a page; index.md is the page the compatibility layer writes; non-markdown is code", async () => {
		const { id } = await makeSession();
		await writeNote(id, "index.md", "# Plan\n\nSome text with [[a link]] and - [ ] not a task\n");
		await writeNote(id, "design.md", "# Design\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
		await writeNote(id, "data.json", '{"k": [1, 2]}\n');
		const outcome = await run(id);
		expect(outcome).toMatchObject({ status: "imported", tasks: 0, pages: 3 });
		const all = await pages(id);
		expect(all.map((p) => p.title).sort()).toEqual(["data.json", "design.md", "index.md"]);
		expect(all.find((p) => p.title === "index.md")?.sid).toBe(specIndexSid());
		expect(all.find((p) => p.title === "data.json")?.blocks[0]).toContain("```json");
		// Nothing in a note is a task or a link.
		const space = await outlineStore.findSpace({ kind: "session", narratorId: id });
		const open = await outlineStore.listOpenTasks(space?.id ?? "", 10);
		expect(open).toHaveLength(0);
	});
});

describe("idempotence", () => {
	test("a second import writes nothing and says the session is an outline one", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a" }, { text: "b", status: "doing" }]);
		await writeNote(id, "notes.md", "hello\n");
		expect((await run(id)).status).toBe("imported");
		const commits = await commitCount(id);
		expect(await run(id)).toEqual({ status: "skipped", reason: "outline" });
		expect(await commitCount(id)).toBe(commits);
	});

	test("an attempt cut short is finished by the next: nothing twice", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a" }, { text: "b", status: "blocked" }]);
		await writeNote(id, "notes.md", "hello\n\nworld\n");
		// Cut after the first commit.
		const cut = new AbortController();
		let commits = 0;
		const off = onCommit(() => {
			if (++commits === 2) cut.abort(new Error("cut"));
		});
		const first = await importSpecSession(id, { trigger: "sweep", signal: cut.signal });
		off();
		expect(first.status).toBe("failed");
		expect(await backendOf(id)).toBe("spec");
		expect((await run(id)).status).toBe("imported");
		expect((await taskPage(id)).map((t) => t.text)).toEqual(["a", "b"]);
		expect((await pages(id)).filter((p) => p.title === "notes.md")).toHaveLength(1);
	});

	test("a source that changed after an unfinished attempt: the old attempt's blocks go", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "old one" }, { text: "old two" }]);
		await writeNote(id, "notes.md", "old\n");
		const cut = new AbortController();
		let seen = 0;
		const off = onCommit(() => {
			// After the notes page, the task page and the tasks.
			if (++seen === 3) cut.abort(new Error("cut"));
		});
		expect((await importSpecSession(id, { trigger: "sweep", signal: cut.signal })).status).toBe(
			"failed",
		);
		off();
		expect((await taskPage(id)).map((t) => t.text)).toEqual(["old one", "old two"]);
		await writeTasks(id, [{ text: "new one" }]);
		await writeNote(id, "notes.md", "new\n");
		expect((await run(id)).status).toBe("imported");
		expect((await taskPage(id)).map((t) => t.text)).toEqual(["new one"]);
		const notes = (await pages(id)).filter((p) => p.title === "notes.md");
		expect(notes).toHaveLength(1);
		expect(notes[0]?.blocks).toEqual(["new"]);
	});
});

describe("which sessions", () => {
	test("a session that never wrote Dynamic Spec is only moved", async () => {
		const { id } = await makeSession();
		expect(await run(id)).toMatchObject({ status: "imported", tasks: 0, pages: 0, commits: 0 });
		expect(await backendOf(id)).toBe("outline");
		expect(await commitCount(id)).toBe(0);
	});

	test("a subagent is never imported", async () => {
		const root = await makeSession();
		const sub = await makeSession({ type: "subagent", root: root.id, owner: root.owner });
		await writeTasks(sub.id, [{ text: "its own queue" }]);
		expect(await run(sub.id)).toEqual({ status: "skipped", reason: "subagent" });
		expect(await backendOf(sub.id)).toBe("spec");
	});

	test("a session provisioned through the external API keeps Dynamic Spec", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "driven by its client" }]);
		const { db } = await import("../../../../db");
		const { integrationResourceBindings } = await import("../../../../db/schema");
		await db.insert(integrationResourceBindings).values({
			id: `bind-${id}`,
			resourceType: "narrator",
			resourceId: id,
			sourceType: "oauth_client",
			sourceId: "client-1",
			authorityType: "oauth_grant",
			authorityId: "grant-1",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(await run(id)).toEqual({ status: "skipped", reason: "external" });
		expect(await backendOf(id)).toBe("spec");
		// A plugin's recruit (bound to the plugin) is imported like any session.
		const recruit = await makeSession();
		await writeTasks(recruit.id, [{ text: "dispatched" }]);
		await db.insert(integrationResourceBindings).values({
			id: `bind-${recruit.id}`,
			resourceType: "narrator",
			resourceId: recruit.id,
			sourceType: "plugin",
			sourceId: "com.example.team",
			authorityType: "plugin_installation",
			authorityId: "install-1",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		expect((await run(recruit.id)).status).toBe("imported");
		expect(await backendOf(recruit.id)).toBe("outline");
	});

	test("nothing is imported while the setting is off or the outline is", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a" }]);
		settings.outline.specImport = "off";
		expect(await run(id)).toEqual({ status: "skipped", reason: "off" });
		settings.outline.specImport = "auto";
		settings.outline.enabled = false;
		expect(await run(id)).toEqual({ status: "skipped", reason: "off" });
		expect(await backendOf(id)).toBe("spec");
	});

	test("a busy session is left alone", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a" }]);
		const outcome = await importSpecSession(id, {
			trigger: "sweep",
			admit: async () => {
				throw new Error("busy");
			},
		});
		expect(outcome).toEqual({ status: "busy" });
		expect(await commitCount(id)).toBe(0);
	});
});

describe("the guard", () => {
	test("Dynamic Spec writes are refused while the import runs, and after it the session is an outline one", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a" }]);
		let refused: unknown = null;
		const outcome = await importSpecSession(id, {
			trigger: "manual",
			admit: async () => {
				return () => {};
			},
			onMoved: () => {},
			isRunning: () => {
				return false;
			},
		});
		expect(outcome.status).toBe("imported");
		try {
			await writeSpecFile(id, "spec://notes.md", "late", { actor: "user", createdBy: "user" });
		} catch (error) {
			refused = error;
		}
		expect(String((refused as { code?: string })?.code)).toBe("SPEC_OUTLINE_SESSION");
		// The spec rows are still readable.
		expect((await readSpecFile(id, "spec://tasks.json")).content).toContain('"a"');
	});
});

describe("an attempt met again", () => {
	test("a task deleted or reopened between attempts is put back before the session moves", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [
			{ text: "a", status: "doing" },
			{ text: "b" },
			{ text: "c", status: "done" },
		]);
		// First attempt: everything written, then cut before the move.
		const cut = new AbortController();
		let commits = 0;
		const off = onCommit(() => {
			if (++commits === 2) cut.abort(new Error("cut"));
		});
		expect((await importSpecSession(id, { trigger: "sweep", signal: cut.signal })).status).toBe(
			"failed",
		);
		off();
		expect(await backendOf(id)).toBe("spec");
		const before = await taskPage(id);
		expect(before.map((t) => t.text)).toEqual(["a", "b", "c"]);
		const space = await outlineStore.findSpace({ kind: "session", narratorId: id });
		// What was in progress is to do until the move (nothing is claimed before it). Meanwhile
		// someone set it to do again (nothing changes) and deleted a task.
		await writeOutline({
			spaceId: space?.id as string,
			ops: [
				{ op: "setTask", block: { id: before[0]?.id as string }, task: { status: "todo" } },
				{ op: "delete", block: { id: before[1]?.id as string } },
			],
			actor: { kind: "system", id: "outline-task-lease" },
			responsibleUserId: null,
		});
		expect((await run(id)).status).toBe("imported");
		const after = await taskPage(id);
		expect(after.map((t) => [t.text, t.status])).toEqual([
			["a", "doing"],
			["b", "todo"],
			["c", "done"],
		]);
		expect(after[0]?.holder).toBe(id);
		expect(after.map((t) => t.id)).toEqual(before.map((t) => t.id));
	});

	test("an imported task that no longer matches its source moves nothing (needs attention)", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [{ text: "the goal", protected: true }], "user");
		const cut = new AbortController();
		let commits = 0;
		const off = onCommit(() => {
			if (++commits === 2) cut.abort(new Error("cut"));
		});
		expect((await importSpecSession(id, { trigger: "sweep", signal: cut.signal })).status).toBe(
			"failed",
		);
		off();
		const [task] = await taskPage(id);
		expect(task?.lockedBy).toBe(`human:${owner}`);
		// Its person unlocks it before the session is moved: no longer what the source says.
		const space = await outlineStore.findSpace({ kind: "session", narratorId: id });
		await writeOutline({
			spaceId: space?.id as string,
			ops: [{ op: "setTask", block: { id: task?.id as string }, task: { lock: null } }],
			actor: { kind: "human", id: owner as string },
			responsibleUserId: owner,
		});
		const outcome = await run(id);
		expect(outcome).toMatchObject({ status: "failed", attention: true });
		expect((outcome as { error: string }).error).toContain("its lock");
		expect(await backendOf(id)).toBe("spec");
		expect(specImportRecord(id)?.status).toBe("attention");
	});

	test("two imports of one session at once are one import", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a" }, { text: "b" }]);
		const [first, second] = await Promise.all([run(id), run(id)]);
		expect(first.status).toBe("imported");
		expect(second).toEqual(first);
		expect((await taskPage(id)).map((t) => t.text)).toEqual(["a", "b"]);
	});

	test("a source that changes while the import runs moves nothing", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a" }]);
		const { db } = await import("../../../../db");
		const { specNamespaceFiles, specNamespaces } = await import("../../../../db/schema");
		const { eq } = await import("drizzle-orm");
		const ns = await db.query.specNamespaces.findFirst({
			where: eq(specNamespaces.narratorId, id),
		});
		let changed = false;
		const off = onCommit(() => {
			if (changed) return;
			changed = true;
			// Past the guard, as a write of another process would be.
			db.insert(specNamespaceFiles)
				.values({
					id: `late-${id}`,
					namespaceId: ns?.id as string,
					path: "late.md",
					revisionId: null,
					updatedAt: "2026-01-01T00:00:00.000Z",
				})
				.run();
		});
		const outcome = await run(id);
		off();
		expect(outcome).toMatchObject({ status: "failed", attention: false });
		expect(await backendOf(id)).toBe("spec");
		// The next attempt imports what is there now, and nothing twice.
		expect((await run(id)).status).toBe("imported");
		expect((await taskPage(id)).map((t) => t.text)).toEqual(["a"]);
	});
});

describe("limits", () => {
	test("a task text of several paragraphs is the task and what is under it, as /goal splits it", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "The goal\n\nA second paragraph" }, { text: "plain" }]);
		expect((await run(id)).status).toBe("imported");
		const tasks = await taskPage(id);
		expect(tasks.map((t) => t.text)).toEqual(["The goal", "plain"]);
		expect(tasks[0]?.children).toEqual(["A second paragraph"]);
	});

	test("a full task list (100 tasks of 1000 characters) arrives whole, in order, in several commits", async () => {
		const { id } = await makeSession();
		const tasks = Array.from({ length: 100 }, (_, i) => ({
			text: `${i} ${"字".repeat(990)}`,
			status: (["todo", "doing", "done", "blocked"] as const)[i % 4],
		}));
		await writeTasks(id, tasks);
		const outcome = await run(id);
		expect(outcome).toMatchObject({ status: "imported", tasks: 100 });
		expect((outcome as { commits: number }).commits).toBeGreaterThan(2);
		const imported = await taskPage(id);
		expect(imported).toHaveLength(100);
		expect(imported.map((t) => t.text.split(" ")[0])).toEqual(tasks.map((_, i) => String(i)));
		expect(imported.map((t) => t.status)).toEqual(
			tasks.map((t) => (t.status === "blocked" ? "doing" : t.status)),
		);
	});
});
