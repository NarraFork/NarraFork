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
