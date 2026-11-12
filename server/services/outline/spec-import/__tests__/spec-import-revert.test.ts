/**
 * An administrator's tools (outline P2 PR 12b2, `admin.ts`): moving a session the import moved
 * back to Dynamic Spec, and importing it again.
 *
 * What must hold:
 *  - a move back sets the column back to `spec` and records it; nothing of Dynamic Spec or of the
 *    outline is deleted; the old fence the switch emptied is written back; the task and behavior
 *    pages get a marker on top; the session's plugin commands go to Dynamic Spec again;
 *  - only a session an import moved can be moved back, only while idle, never during an import;
 *  - no automatic trigger, nor the owner's button, imports a moved-back session; an
 *    administrator's re-import does: unchanged since, it is moved forward without writing (the
 *    markers taken away); changed, it is imported as 12b imports, and what was done in the
 *    outline since keeps it from being taken away (needs attention);
 *  - a re-import clears attention and the failed attempts first.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { outlineSpecImports, specFileRevisions, specNamespaces } from "../../../../db/schema";
import { AppError } from "../../../../lib/errors";
import { settings } from "../../../../lib/settings";
import { TEAM_SOP_CLOSE, TEAM_SOP_OPEN } from "../../../behavior-fence-sop";
import { acquireNarratorRevertAdmission, readSpecTasksForPlugin } from "../../../narrator-session";
import { readSpecFile, writeSpecFile } from "../../../spec-vfs-service";
import { invalidateTaskBackend } from "../../../task-source";
import { beginSpecImport } from "../../../task-source/backend";
import { resetOutlineBehaviorImport } from "../../../task-source/outline-behavior";
import { resetOutlineFenceSopMove } from "../../../task-source/outline-plugin-rules";
import { stopEditTextWorker } from "../../edit-text-runner";
import { OUTLINE_BEHAVIOR_ALIAS, OUTLINE_TASKS_PAGE_ALIAS } from "../../model";
import { outlineStore } from "../../store";
import { writeOutline } from "../../write";
import { reimportSpecSession, revertSpecImport, specImportAdminPage } from "../admin";
import { importSpecSession, resetSpecImportRecords } from "../importer";
import { deliverSpecImportNotice, specImportNoticeId } from "../notice";
import { OUTLINE_SPEC_REVERT_ACTOR } from "../plan";
import { readSpecImportState } from "../state";
import {
	importSpecAtRunStart,
	requestSpecImport,
	resetSpecImportRunTries,
	runSpecImportPass,
	settleSpecImportRequests,
	specImportStatus,
} from "../triggers";
import {
	backendOf,
	commitCount,
	makeSession,
	makeUser,
	taskPage,
	writeNote,
	writeTasks,
} from "./fixtures";

beforeEach(() => {
	settings.outline.enabled = true;
	settings.outline.specImport = "auto";
	invalidateTaskBackend();
	resetSpecImportRecords();
	resetSpecImportRunTries();
	resetOutlineBehaviorImport();
	resetOutlineFenceSopMove();
});
afterAll(async () => {
	await settleSpecImportRequests();
	stopEditTextWorker();
});

const FENCE = `Always run the tests.\n\n${TEAM_SOP_OPEN}\nTeam SOP: report daily.\n${TEAM_SOP_CLOSE}\n`;

/** A session with tasks, a note and a fence, imported (the switch empties its old fence). */
async function imported(): Promise<{ id: string; admin: string }> {
	const { id } = await makeSession();
	await writeTasks(id, [{ text: "first" }, { text: "second", status: "doing" }]);
	await writeNote(id, "design.md", "# Design\n\ntext\n");
	await writeSpecFile(id, "spec://behavior_fence", FENCE, { actor: "user", createdBy: "user" });
	expect((await importSpecSession(id, { trigger: "manual" })).status).toBe("imported");
	expect(await backendOf(id)).toBe("outline");
	expect((await readSpecFile(id, "spec://behavior_fence")).content).not.toBe(FENCE);
	return { id, admin: await makeUser() };
}

async function revisions(narratorId: string): Promise<number> {
	const ns = await db.query.specNamespaces.findFirst({
		where: eq(specNamespaces.narratorId, narratorId),
	});
	return (
		await db
			.select({ id: specFileRevisions.id })
			.from(specFileRevisions)
			.where(eq(specFileRevisions.namespaceId, ns?.id as string))
	).length;
}

/** The first children of the task and behavior pages, with who wrote them. */
async function pageTops(narratorId: string) {
	const space = await outlineStore.findSpace({ kind: "session", narratorId });
	if (!space) return { tasks: null, behavior: null };
	const owners = await outlineStore.findAliasOwners(space.id, [
		OUTLINE_TASKS_PAGE_ALIAS,
		OUTLINE_BEHAVIOR_ALIAS,
	]);
	const top = async (alias: string) => {
		const page = owners.find((owner) => owner.alias === alias);
		if (!page) return null;
		const [first] = await outlineStore.listChildren(space.id, page.id, 1);
		return first ? { id: first.id, content: first.content, author: first.authorId } : null;
	};
	return {
		tasks: await top(OUTLINE_TASKS_PAGE_ALIAS),
		behavior: await top(OUTLINE_BEHAVIOR_ALIAS),
	};
}

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	return error instanceof AppError ? error.messageCode : String(error);
}

describe("moving a session back", () => {
	test("the column, the record, the old fence and the markers; nothing deleted", async () => {
		const { id, admin } = await imported();
		const tasksBefore = (await taskPage(id)).map((task) => task.text);
		const revisionsBefore = await revisions(id);
		const result = await revertSpecImport(id, admin);
		expect(result).toEqual({ reverted: true, marked: true, fenceRestored: true });
		expect(await backendOf(id)).toBe("spec");
		const state = await readSpecImportState(id);
		expect(state).toMatchObject({
			status: "reverted",
			revertCount: 1,
			revertedBy: admin,
			lastActor: admin,
			switchCount: 1,
		});
		expect(state?.revertSourceKey).toMatch(/^[0-9a-f]{64}$/);
		expect(state?.revertNoteIds).toHaveLength(2);
		// The outline keeps everything; the markers sit on top.
		const tasksAfter = await taskPage(id);
		expect(tasksAfter.map((task) => task.text)).toEqual([
			expect.stringContaining("moved this session back to Dynamic Spec"),
			...tasksBefore,
		]);
		const tops = await pageTops(id);
		expect(tops.tasks?.content).toContain("no longer reads its tasks here");
		expect(tops.behavior?.content).toContain("no longer reads its behavior boundary here");
		expect(tops.tasks?.author).toBe(OUTLINE_SPEC_REVERT_ACTOR);
		// Dynamic Spec: every revision kept, the fence written back as the import read it.
		expect(await revisions(id)).toBe(revisionsBefore + 1);
		expect((await readSpecFile(id, "spec://behavior_fence")).content).toBe(FENCE);
		// The session is a Dynamic Spec session again: its plugin commands go there, and its
		// files can be written.
		let compat = false;
		const read = await readSpecTasksForPlugin(id, { onCompat: () => (compat = true) });
		expect(compat).toBe(false);
		expect(read.compiled.tasks.map((task) => [task.text, task.status])).toEqual([
			["first", "todo"],
			["second", "doing"],
		]);
		await writeNote(id, "later.md", "written after the move back\n");
		// No notice for it, and the Spec panel says it was moved back.
		expect(await deliverSpecImportNotice(id)).toBe("none");
		expect(await specImportStatus(id)).toMatchObject({ state: "reverted", importable: true });
	});

	test("only a session an import moved, once per move, while idle and with no import running", async () => {
		const admin = await makeUser();
		const native = await makeSession({ backend: "outline" });
		expect(await refusal(revertSpecImport(native.id, admin))).toBe("SPEC_IMPORT_NOT_REVERTIBLE");
		const spec = await makeSession();
		await writeTasks(spec.id, [{ text: "a" }]);
		expect(await refusal(revertSpecImport(spec.id, admin))).toBe("SPEC_IMPORT_NOT_REVERTIBLE");
		expect(await refusal(revertSpecImport("no-such-narrator", admin))).toBe("RESOURCE_NOT_FOUND");

		const { id } = await imported();
		// Busy: the session's admission is held (a run, a file revert).
		const held = await acquireNarratorRevertAdmission(id, {
			signal: new AbortController().signal,
			interrupt: false,
		});
		expect(await refusal(revertSpecImport(id, admin))).toBe("SPEC_IMPORT_SESSION_BUSY");
		held();
		// An import's guard is held (its move finishing).
		const unguard = beginSpecImport(id);
		expect(await refusal(revertSpecImport(id, admin))).toBe("SPEC_IMPORT_IN_PROGRESS");
		unguard();
		expect(await backendOf(id)).toBe("outline");
		expect((await readSpecImportState(id))?.status).toBe("imported");
		await revertSpecImport(id, admin);
		expect(await refusal(revertSpecImport(id, admin))).toBe("SPEC_IMPORT_NOT_REVERTIBLE");
	});

	test("no automatic trigger and no owner's button imports it; across a restart too", async () => {
		const { id, admin } = await imported();
		await revertSpecImport(id, admin);
		resetSpecImportRecords();
		const commits = await commitCount(id);
		expect(await importSpecAtRunStart(id, { subagentsRunning: () => false })).toBeNull();
		await runSpecImportPass({ pauseMs: 0 });
		expect(await importSpecSession(id, { trigger: "sweep" })).toEqual({
			status: "skipped",
			reason: "reverted",
		});
		const pressed = await requestSpecImport(id);
		expect(pressed.state).toBe("reverted");
		await settleSpecImportRequests();
		expect(await backendOf(id)).toBe("spec");
		expect(await commitCount(id)).toBe(commits);
	});
});

describe("an administrator's re-import", () => {
	test("unchanged since the move back: moved forward without writing, markers taken away, told again", async () => {
		const { id, admin } = await imported();
		expect(await deliverSpecImportNotice(id)).toBe("delivered");
		await revertSpecImport(id, admin);
		const tasks = (await taskPage(id)).slice(1);
		const commits = await commitCount(id);
		await reimportSpecSession(id, admin);
		await settleSpecImportRequests();
		expect(await backendOf(id)).toBe("outline");
		// One commit: the markers taken away.
		expect(await commitCount(id)).toBe(commits + 1);
		expect((await taskPage(id)).map((task) => task.text)).toEqual(tasks.map((task) => task.text));
		const tops = await pageTops(id);
		expect(tops.behavior?.content ?? "").not.toContain("moved this session back");
		const state = await readSpecImportState(id);
		expect(state).toMatchObject({
			status: "imported",
			trigger: "admin",
			switchCount: 2,
			revertSourceKey: null,
			revertNoteIds: [],
		});
		// The fence written back at the move back is emptied into the page again.
		expect((await readSpecFile(id, "spec://behavior_fence")).content).not.toContain("Always");
		expect(await deliverSpecImportNotice(id)).toBe("delivered");
		const { narratorMessages } = await import("../../../../db/schema");
		const rows = await db
			.select({ id: narratorMessages.id })
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, id));
		expect(rows.map((row) => row.id)).toEqual(
			expect.arrayContaining([specImportNoticeId(id, 1), specImportNoticeId(id, 2)]),
		);
	});

	test("a marker someone wrote under stays", async () => {
		const { id, admin } = await imported();
		await revertSpecImport(id, admin);
		const marker = (await pageTops(id)).tasks;
		const space = await outlineStore.findSpace({ kind: "session", narratorId: id });
		await writeOutline({
			spaceId: space?.id as string,
			ops: [{ op: "insert", parent: { id: marker?.id as string }, content: "why: see ticket" }],
			actor: { kind: "human", id: admin },
			responsibleUserId: admin,
		});
		await reimportSpecSession(id, admin);
		await settleSpecImportRequests();
		expect(await backendOf(id)).toBe("outline");
		expect((await pageTops(id)).tasks?.id).toBe(marker?.id);
	});

	test("changed since: imported as 12b imports; what was done in the outline keeps it (attention)", async () => {
		const { id, admin } = await imported();
		await revertSpecImport(id, admin);
		// The session works in Dynamic Spec again.
		await writeTasks(id, [
			{ text: "first" },
			{ text: "second", status: "done" },
			{ text: "third" },
		]);
		await reimportSpecSession(id, admin);
		await settleSpecImportRequests();
		expect(await backendOf(id)).toBe("outline");
		expect((await taskPage(id)).map((task) => [task.text, task.status])).toEqual([
			["first", "todo"],
			["second", "done"],
			["third", "todo"],
		]);
		expect((await readSpecImportState(id))?.switchCount).toBe(2);

		// Someone finished a task in the outline before the next move back.
		const other = await imported();
		const [, second] = await taskPage(other.id);
		const space = await outlineStore.findSpace({ kind: "session", narratorId: other.id });
		await writeOutline({
			spaceId: space?.id as string,
			ops: [{ op: "setTask", block: { id: second?.id as string }, task: { status: "done" } }],
			actor: { kind: "human", id: other.admin },
			responsibleUserId: other.admin,
		});
		await revertSpecImport(other.id, other.admin);
		await writeTasks(other.id, [{ text: "first" }, { text: "replaced" }]);
		await reimportSpecSession(other.id, other.admin);
		await settleSpecImportRequests();
		expect(await backendOf(other.id)).toBe("spec");
		const state = await readSpecImportState(other.id);
		expect(state?.status).toBe("attention");
		expect(state?.reason?.code).toBe("kept_blocks");
		// Its finished task is still there.
		expect((await taskPage(other.id)).map((task) => task.status)).toContain("done");
	});

	test("clears attention and the failed attempts first; refused with imports off or for an outline session", async () => {
		const admin = await makeUser();
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a" }]);
		const { writeSpecImportState } = await import("../state");
		await writeSpecImportState(id, {
			status: "attention",
			attempts: 3,
			reason: { code: "task_mismatch", count: 1 },
			attentionReason: "task_mismatch",
		});
		const started = await reimportSpecSession(id, admin);
		expect(["running", "imported"]).toContain(started.state);
		await settleSpecImportRequests();
		expect(await backendOf(id)).toBe("outline");
		const row = await db.query.outlineSpecImports.findFirst({
			where: eq(outlineSpecImports.narratorId, id),
		});
		expect(row).toMatchObject({ status: "imported", attempts: 0, lastActor: admin });
		expect(await refusal(reimportSpecSession(id, admin))).toBe("SPEC_IMPORT_NOT_IMPORTABLE");
		settings.outline.specImport = "off";
		const other = await makeSession();
		expect(await refusal(reimportSpecSession(other.id, admin))).toBe("SPEC_IMPORT_OFF");
	});
});

describe("the admin page", () => {
	test("lists a state's sessions with what may be done to each", async () => {
		const { id, admin } = await imported();
		const page = await specImportAdminPage({ state: "imported", limit: 50 });
		const item = page.items.find((entry) => entry.narratorId === id);
		expect(item).toMatchObject({
			state: "imported",
			taskBackend: "outline",
			canRevert: true,
			canReimport: false,
			switchCount: 1,
		});
		expect(page.counts.imported).toBeGreaterThanOrEqual(1);
		expect(page.mode).toBe("auto");
		await revertSpecImport(id, admin);
		const reverted = await specImportAdminPage({ state: "reverted", limit: 50 });
		expect(reverted.items.find((entry) => entry.narratorId === id)).toMatchObject({
			canRevert: false,
			canReimport: true,
			revertCount: 1,
		});
	});
});
