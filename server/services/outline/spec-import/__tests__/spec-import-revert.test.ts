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
import { TEAM_SOP_CLOSE, TEAM_SOP_OPEN, TEAM_SOP_PLUGIN_ID } from "../../../behavior-fence-sop";
import { acquireNarratorRevertAdmission, readSpecTasksForPlugin } from "../../../narrator-session";
import { readSpecFile, writeSpecFile } from "../../../spec-vfs-service";
import { invalidateTaskBackend } from "../../../task-source";
import { beginSpecImport } from "../../../task-source/backend";
import { resetOutlineBehaviorImport } from "../../../task-source/outline-behavior";
import {
	pluginRulesSid,
	resetOutlineFenceSopMove,
} from "../../../task-source/outline-plugin-rules";
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
		expect(result).toEqual({ reverted: true, marked: true, fenceRestored: true, released: 1 });
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
		// The task it was doing is open again, with a note why (S2).
		expect(tasksAfter.find((task) => task.text === "second")).toMatchObject({
			status: "todo",
			holder: null,
		});
		expect(tasksAfter.find((task) => task.text === "second")?.children.at(-1)).toContain(
			"moved the previous executor's session back to Dynamic Spec",
		);
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

	test("what it holds in other spaces is let go too, with a note in the owner's language; nothing renews a claim later (S2)", async () => {
		const owner = await makeUser("zh-CN");
		const { id } = await makeSession({ owner });
		await writeTasks(id, [{ text: "doing", status: "doing" }]);
		expect((await importSpecSession(id, { trigger: "manual" })).status).toBe("imported");
		const { projects } = await import("../../../../db/schema");
		const { generateId } = await import("../../../../lib/id");
		const { ensureProjectSpace } = await import("../../spaces");
		const projectId = generateId();
		await db.insert(projects).values({
			id: projectId,
			name: `P ${projectId.slice(0, 6)}`,
			gitPath: "/srv/p",
			ownerUserId: owner,
			visibility: "private",
			createdAt: "2026-11-12T00:00:00.000Z",
			updatedAt: "2026-11-12T00:00:00.000Z",
		});
		const project = await ensureProjectSpace(projectId);
		const written = await writeOutline({
			spaceId: project.id,
			ops: [
				{ op: "insert", tempId: "p", parent: null, content: "Tasks" },
				{
					op: "insert",
					tempId: "t",
					parent: { tempId: "p" },
					content: "shared",
					task: { status: "todo" },
				},
			],
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		const shared = written.results[1]?.blockId as string;
		const startShared = () =>
			writeOutline({
				spaceId: project.id,
				ops: [{ op: "setTask", block: { id: shared }, task: { status: "doing" } }],
				actor: { kind: "agent", id },
				narratorId: id,
				responsibleUserId: owner,
			});
		await startShared();
		const [own] = (await taskPage(id)).filter((task) => task.text === "doing");
		expect(own?.holder).toBe(id);
		expect((await outlineStore.getTaskClaims([shared]))[0]?.holderNarratorId).toBe(id);

		const result = await revertSpecImport(id, await makeUser());
		expect(result.released).toBe(2);
		expect((await taskPage(id)).find((task) => task.text === "doing")).toMatchObject({
			status: "todo",
			holder: null,
		});
		const sharedBlock = await outlineStore.getBlock(shared);
		expect(sharedBlock?.taskJson?.status).toBe("todo");
		expect((await outlineStore.getTaskClaims([shared]))[0]?.holderNarratorId ?? null).toBeNull();
		const notes = await outlineStore.listChildren(project.id, shared, 5);
		expect(notes.at(-1)?.content).toContain("管理员把之前执行它的会话退回了 Dynamic Spec");

		// A claim that slipped through afterwards is neither renewed by its runs nor kept idle.
		await startShared();
		const before = (await outlineStore.getTaskClaims([shared]))[0]?.expiresAt;
		const { keepOutlineTaskLeases, outlineRunEndsSettled } = await import("../../lease-keeper");
		const keeper = keepOutlineTaskLeases(id, { intervalMs: 0, now: () => Date.now() + 60_000 });
		await keeper.touch();
		await keeper.stop();
		await outlineRunEndsSettled(id);
		expect((await outlineStore.getTaskClaims([shared]))[0]?.expiresAt).toBe(before);
	});

	test("the daily report does not list the move back under other (round 2)", async () => {
		const { id, admin } = await imported();
		const space = await outlineStore.findSpace({ kind: "session", narratorId: id });
		if (!space) throw new Error("no space");
		const from = (await outlineStore.getSpace(space.id))?.nextSeq ?? 1;
		const result = await revertSpecImport(id, admin);
		expect(result.released).toBe(1);
		expect(result.marked).toBe(true);
		const to = ((await outlineStore.getSpace(space.id))?.nextSeq ?? 1) - 1;
		expect(to).toBeGreaterThanOrEqual(from + 1);
		const { OUTLINE_DIGEST_LIMITS, summarizeSpaceWindow } = await import("../../digest");
		const summary = await summarizeSpaceWindow(
			outlineStore,
			space,
			from - 1,
			to,
			OUTLINE_DIGEST_LIMITS,
		);
		expect(summary.other).toEqual([]);
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

	test("a move back the process stopped in the middle of is offered again and completes (review NIT)", async () => {
		const { id, admin } = await imported();
		// `reverted` was recorded, the column not changed yet.
		const { writeSpecImportState } = await import("../state");
		await writeSpecImportState(id, { status: "reverted", revertCount: 1 });
		resetSpecImportRecords();
		expect(await backendOf(id)).toBe("outline");
		const page = await specImportAdminPage({ state: "reverted", limit: 50 });
		expect(page.items.find((item) => item.narratorId === id)).toMatchObject({
			taskBackend: "outline",
			canRevert: true,
			canReimport: false,
		});
		const result = await revertSpecImport(id, admin);
		expect(result.reverted).toBe(true);
		expect(await backendOf(id)).toBe("spec");
		expect(await readSpecImportState(id)).toMatchObject({ status: "reverted", revertCount: 1 });
		expect((await readSpecFile(id, "spec://behavior_fence")).content).toBe(FENCE);
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

	test("a plugin SOP changed while it was moved back replaces the plugin's block (S3)", async () => {
		const { id, admin } = await imported();
		const space = await outlineStore.findSpace({ kind: "session", narratorId: id });
		const rulesText = async () => {
			const [rules] = await outlineStore.getBlockMetas(space?.id as string, {
				sids: [pluginRulesSid(TEAM_SOP_PLUGIN_ID)],
			});
			const blocks = rules
				? await outlineStore.listChildren(space?.id as string, rules.id, 500)
				: [];
			return blocks.map((block) => block.content).join("\n");
		};
		expect(await rulesText()).toContain("Team SOP: report daily.");
		await revertSpecImport(id, admin);
		// The plugin updates its SOP in the old fence while the session is in Dynamic Spec.
		const updated = `Always run the tests.\n\n${TEAM_SOP_OPEN}\nTeam SOP: report every hour.\n${TEAM_SOP_CLOSE}\n`;
		await writeSpecFile(id, "spec://behavior_fence", updated, {
			actor: "system",
			createdBy: "system",
			pluginSop: true,
		});
		await reimportSpecSession(id, admin);
		await settleSpecImportRequests();
		expect(await backendOf(id)).toBe("outline");
		const text = await rulesText();
		expect(text).toContain("Team SOP: report every hour.");
		expect(text).not.toContain("report daily");
		// The fence gave up its SOP only because the block holds the new one.
		expect((await readSpecFile(id, "spec://behavior_fence")).content).not.toContain("every hour");
	});

	test("an SOP unchanged across the move back writes nothing to the plugin's block (S3, round 2)", async () => {
		const { id, admin } = await imported();
		const space = await outlineStore.findSpace({ kind: "session", narratorId: id });
		const block = async () =>
			(
				await outlineStore.getBlockMetas(space?.id as string, {
					sids: [pluginRulesSid(TEAM_SOP_PLUGIN_ID)],
				})
			)[0];
		const before = await block();
		expect(before?.deleted).toBe(false);
		await revertSpecImport(id, admin);
		// The session changes its tasks in Dynamic Spec, not its SOP: a real import, not a move forward.
		await writeTasks(id, [{ text: "first" }, { text: "second" }, { text: "third" }]);
		await reimportSpecSession(id, admin);
		await settleSpecImportRequests();
		expect(await backendOf(id)).toBe("outline");
		expect((await readSpecImportState(id))?.switchCount).toBe(2);
		const after = await block();
		expect(after?.id).toBe(before?.id);
		expect(after?.versionSeq).toBe(before?.versionSeq);
		const children = await outlineStore.listChildren(space?.id as string, after?.id as string, 50);
		expect(children.map((child) => child.content).join("\n")).toContain("Team SOP: report daily.");
	});

	test("a plugin's block someone deleted stays deleted, whatever SOP the fence holds (S3, round 2)", async () => {
		const { id, admin } = await imported();
		const space = await outlineStore.findSpace({ kind: "session", narratorId: id });
		const [held] = await outlineStore.getBlockMetas(space?.id as string, {
			sids: [pluginRulesSid(TEAM_SOP_PLUGIN_ID)],
		});
		await writeOutline({
			spaceId: space?.id as string,
			ops: [{ op: "delete", block: { id: held?.id as string } }],
			actor: { kind: "human", id: admin },
			responsibleUserId: admin,
		});
		await revertSpecImport(id, admin);
		const updated = `Always run the tests.\n\n${TEAM_SOP_OPEN}\nTeam SOP: report every hour.\n${TEAM_SOP_CLOSE}\n`;
		await writeSpecFile(id, "spec://behavior_fence", updated, {
			actor: "system",
			createdBy: "system",
			pluginSop: true,
		});
		await reimportSpecSession(id, admin);
		await settleSpecImportRequests();
		expect(await backendOf(id)).toBe("outline");
		const [after] = await outlineStore.getBlockMetas(space?.id as string, {
			sids: [pluginRulesSid(TEAM_SOP_PLUGIN_ID)],
		});
		expect(after?.id).toBe(held?.id);
		expect(after?.deleted).toBe(true);
	});

	test("a changed SOP too large for the block whole needs attention; the fence keeps it (S3)", async () => {
		const { id, admin } = await imported();
		await revertSpecImport(id, admin);
		// More paragraphs than one rules block holds (12b's case).
		const huge = Array.from({ length: 260 }, (_, i) => `Paragraph ${i}.`).join("\n\n");
		const fence = `Always run the tests.\n\n${TEAM_SOP_OPEN}\n${huge}\n${TEAM_SOP_CLOSE}\n`;
		await writeSpecFile(id, "spec://behavior_fence", fence, {
			actor: "system",
			createdBy: "system",
			pluginSop: true,
		});
		await reimportSpecSession(id, admin);
		await settleSpecImportRequests();
		expect(await backendOf(id)).toBe("spec");
		const state = await readSpecImportState(id);
		expect(state?.status).toBe("attention");
		expect(state?.reason?.code).toBe("sop_too_large");
		expect((await readSpecFile(id, "spec://behavior_fence")).content).toBe(fence);
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
