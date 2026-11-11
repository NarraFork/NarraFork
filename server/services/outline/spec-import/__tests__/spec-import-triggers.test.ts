/**
 * When the import runs (outline P2 PR 12b, `triggers.ts`): before a run, by the idle job, from
 * the button; and what the rest of the system makes of an imported session: the behavior page and
 * the plugin's block (the identities 12a reads), the old plugin commands, continuation's task
 * source, the daily report.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { settings } from "../../../../lib/settings";
import { TEAM_SOP_CLOSE, TEAM_SOP_OPEN, TEAM_SOP_PLUGIN_ID } from "../../../behavior-fence-sop";
import type { ActiveNarrator } from "../../../narrator-session";
import { prepareOutlineRun } from "../../../narrator-session";
import { readSpecTasksCompat } from "../../../plugin-spec-compat";
import { readSpecFile, writeSpecFile } from "../../../spec-vfs-service";
import { invalidateTaskBackend, taskSourceForNarrator } from "../../../task-source";
import { beginSpecImport, waitForSpecImport } from "../../../task-source/backend";
import {
	OUTLINE_BEHAVIOR_IMPORT_ACTOR,
	resetOutlineBehaviorImport,
} from "../../../task-source/outline-behavior";
import {
	pluginRulesSid,
	resetOutlineFenceSopMove,
} from "../../../task-source/outline-plugin-rules";
import { OUTLINE_DIGEST_LIMITS, summarizeSpaceWindow } from "../../digest";
import { stopEditTextWorker } from "../../edit-text-runner";
import { OUTLINE_BEHAVIOR_ALIAS } from "../../model";
import { outlineStore } from "../../store";
import { writeOutline } from "../../write";
import { importSpecSession, resetSpecImportRecords, specImportRecord } from "../importer";
import { OUTLINE_SPEC_IMPORT_ACTOR } from "../plan";
import {
	importSpecAtRunStart,
	requestSpecImport,
	resetSpecImportRunTries,
	runSpecImportPass,
	settleSpecImportRequests,
	specImportStatus,
} from "../triggers";
import { backendOf, commitCount, makeSession, taskPage, writeNote, writeTasks } from "./fixtures";

beforeEach(() => {
	settings.outline.enabled = true;
	settings.outline.specImport = "auto";
	invalidateTaskBackend();
	resetSpecImportRecords();
	resetSpecImportRunTries();
	resetOutlineBehaviorImport();
	resetOutlineFenceSopMove();
});
afterAll(() => stopEditTextWorker());

const active = (id: string) => ({ narratorId: id, locale: "en" }) as unknown as ActiveNarrator;

describe("before a run", () => {
	test("a spec session is an outline session from its first request, its tasks its own", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "going", status: "doing" }, { text: "next" }]);
		await prepareOutlineRun(active(id));
		expect(await backendOf(id)).toBe("outline");
		const source = await taskSourceForNarrator(id);
		expect((await source.currentTask())?.text).toBe("going");
		expect((await source.nextTask())?.text).toBe("next");
		// The run holds it: the claim is on the running lease, not the idle one.
		const [task] = await taskPage(id);
		const [claim] = await outlineStore.getTaskClaims([task?.id as string]);
		expect(Date.parse(claim?.expiresAt as string) - Date.now()).toBeLessThan(60 * 60_000);
	});

	test("tried once per process, never for a large session, a running team or with imports manual", async () => {
		const large = await makeSession();
		await writeTasks(large.id, [{ text: "a" }]);
		await writeNote(large.id, "big.md", "x".repeat(150_000));
		await writeNote(large.id, "big2.md", "y".repeat(150_000));
		expect(await importSpecAtRunStart(large.id, { subagentsRunning: () => false })).toEqual({
			status: "busy",
		});
		expect(await backendOf(large.id)).toBe("spec");

		const team = await makeSession();
		await writeTasks(team.id, [{ text: "a" }]);
		expect(await importSpecAtRunStart(team.id, { subagentsRunning: () => true })).toBeNull();
		// Not counted as tried: the next run, with no subagent running, imports.
		expect((await importSpecAtRunStart(team.id, { subagentsRunning: () => false }))?.status).toBe(
			"imported",
		);

		const manual = await makeSession();
		await writeTasks(manual.id, [{ text: "a" }]);
		settings.outline.specImport = "manual";
		expect(await importSpecAtRunStart(manual.id, { subagentsRunning: () => false })).toBeNull();
		settings.outline.specImport = "auto";

		const once = await makeSession();
		await writeTasks(once.id, [{ text: "a" }]);
		expect(
			(await importSpecAtRunStart(once.id, { subagentsRunning: () => false, timeoutMs: 0 }))
				?.status,
		).toBe("failed");
		expect(await importSpecAtRunStart(once.id, { subagentsRunning: () => false })).toBeNull();
		expect(await backendOf(once.id)).toBe("spec");
	});
});

describe("the idle job", () => {
	test("a pass imports the spec root sessions it meets and leaves the others", async () => {
		const a = await makeSession();
		await writeTasks(a.id, [{ text: "a" }]);
		const archived = await makeSession({ archived: true });
		await writeTasks(archived.id, [{ text: "b", status: "doing" }]);
		const sub = await makeSession({ type: "subagent", root: a.id, owner: a.owner });
		await writeTasks(sub.id, [{ text: "its own" }]);
		const pass = await runSpecImportPass({ pauseMs: 0 });
		expect(pass.imported).toBeGreaterThanOrEqual(2);
		expect(await backendOf(a.id)).toBe("outline");
		expect(await backendOf(archived.id)).toBe("outline");
		expect(await backendOf(sub.id)).toBe("spec");
		// Idle: what the session was doing is on the idle lease.
		const again = await runSpecImportPass({ pauseMs: 0 });
		expect(again.imported).toBe(0);
	});

	test("a session that needs attention is left to the button", async () => {
		const { id } = await makeSession();
		// Written before tasks.json was validated.
		await writeNote(id, "notes.md", "n\n");
		const { db } = await import("../../../../db");
		const { specFileRevisions, specNamespaceFiles, specNamespaces } = await import(
			"../../../../db/schema"
		);
		const { eq } = await import("drizzle-orm");
		const ns = await db.query.specNamespaces.findFirst({
			where: eq(specNamespaces.narratorId, id),
		});
		await db.insert(specFileRevisions).values({
			id: `rev-${id}`,
			namespaceId: ns?.id as string,
			path: "tasks.json",
			content: "not json",
			contentHash: "x",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		await db.insert(specNamespaceFiles).values({
			id: `file-${id}`,
			namespaceId: ns?.id as string,
			path: "tasks.json",
			revisionId: `rev-${id}`,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		const outcome = await importSpecSession(id, { trigger: "sweep" });
		expect(outcome).toMatchObject({ status: "failed", attention: true });
		expect(await backendOf(id)).toBe("spec");
		expect(specImportRecord(id)?.status).toBe("attention");
		const commits = await commitCount(id);
		const pass = await runSpecImportPass({ pauseMs: 0 });
		expect(pass.givenUp).toBeGreaterThanOrEqual(1);
		expect(await commitCount(id)).toBe(commits);
	});
});

describe("the button", () => {
	test("answers at once, imports in the background, and reports the state", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a" }]);
		expect(await specImportStatus(id)).toMatchObject({ importable: true, state: "idle" });
		const started = await requestSpecImport(id);
		expect(["running", "imported"]).toContain(started.state);
		await settleSpecImportRequests();
		expect(await specImportStatus(id)).toMatchObject({ importable: false, state: "imported" });
		expect(await backendOf(id)).toBe("outline");
	});

	test("with imports off nothing is importable or started", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a" }]);
		settings.outline.specImport = "off";
		expect(await requestSpecImport(id)).toMatchObject({ mode: "off", importable: false });
		await settleSpecImportRequests();
		expect(await backendOf(id)).toBe("spec");
	});
});

describe("what 12a reads after an import", () => {
	test("the fence's own text is on the behavior page, the SOP is the plugin's block, the fence is empty", async () => {
		const { id } = await makeSession();
		await writeSpecFile(
			id,
			"spec://behavior_fence",
			`- Own rule\n\n${TEAM_SOP_OPEN}\nTeam SOP.\n${TEAM_SOP_CLOSE}`,
			{ actor: "user" },
		);
		expect((await importSpecSession(id, { trigger: "manual" })).status).toBe("imported");
		const space = await outlineStore.findSpace({ kind: "session", narratorId: id });
		const [page] = await outlineStore.findAliasOwners(space?.id as string, [
			OUTLINE_BEHAVIOR_ALIAS,
		]);
		const onPage = await outlineStore.listChildren(space?.id as string, page?.id as string, 10);
		expect(onPage.map((b) => b.content)).toContain("Own rule");
		const rules = onPage.find((b) => b.sid === pluginRulesSid(TEAM_SOP_PLUGIN_ID));
		expect(rules).toBeDefined();
		expect(
			(await outlineStore.listChildren(space?.id as string, rules?.id as string, 10)).map(
				(b) => b.content,
			),
		).toEqual(["Team SOP."]);
		expect((await readSpecFile(id, "spec://behavior_fence")).content).toBe("");
		// The session's first run finds it all there: nothing is written again.
		const commits = await commitCount(id);
		await prepareOutlineRun(active(id));
		expect(await commitCount(id)).toBe(commits);
		// PR 4's actor wrote the own text, so its short ids are the ones a later run looks for.
		const written = await outlineStore.listCommits(space?.id as string, { limit: 20, afterSeq: 0 });
		expect(written.some((c) => c.actorId === OUTLINE_BEHAVIOR_IMPORT_ACTOR)).toBe(true);
	});

	test("the old plugin command reads the imported list: blocked is blocked, protected is protected", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [
			{ text: "todo" },
			{ text: "doing", status: "doing" },
			{ text: "stuck", status: "blocked", protected: true },
			{ text: "done", status: "done" },
		]);
		expect((await importSpecSession(id, { trigger: "manual" })).status).toBe("imported");
		const read = await readSpecTasksCompat(id);
		expect(read.compiled.tasks.map((t) => [t.text, t.status, t.protected === true])).toEqual([
			["todo", "todo", false],
			["doing", "doing", false],
			["stuck", "blocked", true],
			["done", "done", false],
		]);
	});
});

describe("plugins and the Spec panel during an import", () => {
	test("a write is refused while it runs; a plugin's command waits for its end", async () => {
		const { id } = await makeSession();
		const end = beginSpecImport(id);
		await expect(
			writeSpecFile(id, "spec://notes.md", "late", { actor: "user", createdBy: "user" }),
		).rejects.toMatchObject({ code: "SPEC_IMPORT_IN_PROGRESS" });
		let waited = false;
		const waiting = waitForSpecImport(id).then(() => {
			waited = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(waited).toBe(false);
		end();
		await waiting;
		expect(waited).toBe(true);
		await writeSpecFile(id, "spec://notes.md", "now", { actor: "user", createdBy: "user" });
	});
});

describe("the daily report", () => {
	test("imported tasks are where the day starts from; what happens to them afterwards counts", async () => {
		const { id, owner } = await makeSession();
		await writeTasks(id, [
			{ text: "done before", status: "done" },
			{ text: "doing", status: "doing" },
			{ text: "todo" },
		]);
		expect((await importSpecSession(id, { trigger: "manual" })).status).toBe("imported");
		const space = await outlineStore.findSpace({ kind: "session", narratorId: id });
		if (!space) throw new Error("no space");
		const summarize = async () => {
			const now = await outlineStore.getSpace(space.id);
			return await summarizeSpaceWindow(
				outlineStore,
				space,
				0,
				(now?.nextSeq ?? 1) - 1,
				OUTLINE_DIGEST_LIMITS,
			);
		};
		const first = await summarize();
		expect(first.tasksCreated).toBe(0);
		expect(first.tasksStarted).toBe(0);
		expect(first.tasks).toEqual([]);
		expect(first.other.filter((o) => o.event === "import")).toEqual([]);
		expect(OUTLINE_SPEC_IMPORT_ACTOR).toBe("spec-import");
		// The agent finishes an imported task the same day: that is the day's work.
		const tasks = await taskPage(id);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: tasks[1]?.id as string }, task: { status: "done" } }],
			actor: { kind: "agent", id },
			responsibleUserId: owner,
			narratorId: id,
		});
		const second = await summarize();
		expect(second.tasks.map((t) => [t.blockId, t.event])).toEqual([[tasks[1]?.id, "done"]]);
		expect(second.tasksCreated).toBe(0);
	});
});
