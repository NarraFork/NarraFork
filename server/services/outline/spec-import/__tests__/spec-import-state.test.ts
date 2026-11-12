/**
 * The import's persisted state (outline P2 PR 12b2, `state.ts`, table `outline_spec_imports`):
 * the source of truth for the banner and the attempt limits, the in-memory part a cache only.
 * `resetSpecImportRecords()` drops the cache, which is what a restart does.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { outlineSpecImports } from "../../../../db/schema";
import { settings } from "../../../../lib/settings";
import { invalidateTaskBackend } from "../../../task-source";
import { stopEditTextWorker } from "../../edit-text-runner";
import { importSpecSession, resetSpecImportRecords, specImportRecord } from "../importer";
import {
	countSpecImportStates,
	listSpecImportStates,
	readSpecImportState,
	SPEC_IMPORT_STATE_LIMITS,
	writeSpecImportState,
} from "../state";
import {
	importSpecAtRunStart,
	requestSpecImport,
	resetSpecImportRunTries,
	runSpecImportPass,
	SPEC_IMPORT_JOB,
	settleSpecImportRequests,
	specImportStatus,
} from "../triggers";
import { backendOf, commitCount, makeSession, writeNote, writeTasks } from "./fixtures";

beforeEach(() => {
	settings.outline.enabled = true;
	settings.outline.specImport = "auto";
	invalidateTaskBackend();
	resetSpecImportRecords();
	resetSpecImportRunTries();
});
afterAll(async () => {
	await settleSpecImportRequests();
	stopEditTextWorker();
});

/** A session whose tasks.json does not parse (written before it was validated): attention. */
async function brokenSession(): Promise<string> {
	const { id } = await makeSession();
	await writeNote(id, "notes.md", "n\n");
	const { specFileRevisions, specNamespaceFiles, specNamespaces } = await import(
		"../../../../db/schema"
	);
	const ns = await db.query.specNamespaces.findFirst({ where: eq(specNamespaces.narratorId, id) });
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
	return id;
}

async function row(narratorId: string) {
	return await db.query.outlineSpecImports.findFirst({
		where: eq(outlineSpecImports.narratorId, narratorId),
	});
}

describe("what an attempt leaves in the table", () => {
	test("a session never tried has no row; an imported one is recorded with where it landed", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a" }]);
		await writeNote(id, "design.md", "# D\n\ntext\n");
		expect(await row(id)).toBeUndefined();
		expect((await specImportStatus(id)).state).toBe("idle");
		const outcome = await importSpecSession(id, { trigger: "manual" });
		expect(outcome.status).toBe("imported");
		const stored = await row(id);
		expect(stored).toMatchObject({
			status: "imported",
			trigger: "manual",
			attempts: 0,
			switchCount: 1,
			noticeSwitch: 0,
			tasks: 1,
			pages: 1,
		});
		expect(stored?.switchedAt).toBeString();
		expect(stored?.spaceId).toBeString();
		expect(stored?.taskPageId).toBeString();
		// After a restart the banner reads the same from the table.
		resetSpecImportRecords();
		expect(specImportRecord(id)).toBeNull();
		expect(await specImportStatus(id)).toMatchObject({
			state: "imported",
			switchedAt: stored?.switchedAt,
			spaceId: stored?.spaceId,
			taskPageId: stored?.taskPageId,
		});
	});

	test("a session that never wrote to Dynamic Spec is moved and recorded as told", async () => {
		const { id } = await makeSession();
		expect((await importSpecSession(id, { trigger: "sweep" })).status).toBe("imported");
		expect(await row(id)).toMatchObject({ status: "imported", switchCount: 1, noticeSwitch: 1 });
	});

	test("attention and failed attempts survive a restart; the automatic triggers leave the session alone", async () => {
		const id = await brokenSession();
		const outcome = await importSpecSession(id, { trigger: "sweep" });
		expect(outcome).toMatchObject({ status: "failed", attention: true });
		expect(await row(id)).toMatchObject({
			status: "attention",
			attempts: 1,
			lastErrorCode: "broken_tasks",
			attentionReason: "broken_tasks",
		});
		resetSpecImportRecords(); // a restart
		resetSpecImportRunTries();
		const commits = await commitCount(id);
		// Neither the start of a run nor the idle job tries it again.
		expect(await importSpecAtRunStart(id, { subagentsRunning: () => false })).toBeNull();
		const pass = await runSpecImportPass({ pauseMs: 0 });
		expect(pass.givenUp).toBeGreaterThanOrEqual(1);
		expect(await commitCount(id)).toBe(commits);
		expect((await specImportStatus(id)).state).toBe("attention");
		// The button still does (and counts another failure).
		await requestSpecImport(id);
		await settleSpecImportRequests();
		expect((await row(id))?.attempts).toBe(2);
	});

	test("failed attempts count up to the limit across restarts", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a" }]);
		await writeSpecImportState(id, {
			status: "failed",
			attempts: SPEC_IMPORT_JOB.attempts,
			reason: { code: "changed" },
			error: "The session's Dynamic Spec changed during the import",
		});
		resetSpecImportRecords();
		expect(await importSpecAtRunStart(id, { subagentsRunning: () => false })).toBeNull();
		await runSpecImportPass({ pauseMs: 0 });
		expect(await backendOf(id)).toBe("spec");
		// One fewer: the job tries, and a success clears the count.
		await writeSpecImportState(id, { attempts: SPEC_IMPORT_JOB.attempts - 1 });
		resetSpecImportRecords();
		await runSpecImportPass({ pauseMs: 0 });
		expect(await backendOf(id)).toBe("outline");
		expect(await row(id)).toMatchObject({
			status: "imported",
			attempts: 0,
			lastErrorCode: null,
		});
	});

	test("a `running` row no import of this process holds reads as busy (the process stopped)", async () => {
		const { id } = await makeSession();
		await writeSpecImportState(id, { status: "running", trigger: "sweep" });
		resetSpecImportRecords();
		expect((await specImportStatus(id)).state).toBe("busy");
	});

	test("a busy attempt counts nothing against the session", async () => {
		const { id } = await makeSession();
		await writeTasks(id, [{ text: "a" }]);
		const outcome = await importSpecSession(id, {
			trigger: "sweep",
			admit: async () => {
				throw new Error("busy");
			},
		});
		expect(outcome.status).toBe("busy");
		expect(await row(id)).toMatchObject({ status: "busy", attempts: 0 });
	});
});

describe("the store", () => {
	test("bounds the stored detail, and serializes the writes of one session", async () => {
		const { id } = await makeSession();
		await writeSpecImportState(id, { status: "failed", error: "x".repeat(5000) });
		expect((await row(id))?.lastErrorDetail?.length).toBe(SPEC_IMPORT_STATE_LIMITS.detailChars);
		await Promise.all(
			Array.from({ length: 10 }, () =>
				writeSpecImportState(id, (current) => ({ attempts: (current?.attempts ?? 0) + 1 })),
			),
		);
		expect((await row(id))?.attempts).toBe(10);
		resetSpecImportRecords();
		expect((await readSpecImportState(id))?.attempts).toBe(10);
	});

	test("lists one state a page at a time, newest first, and counts per state", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const { id } = await makeSession();
			ids.push(id);
			await writeSpecImportState(id, { status: "reverted" });
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		const first = await listSpecImportStates({ status: "reverted", limit: 2 });
		expect(first.items.map((item) => item.narratorId)).toEqual([ids[4], ids[3]]);
		expect(first.items[0]?.title).toBeNull();
		expect(first.items[0]?.taskBackend).toBe("spec");
		expect(first.items[0]?.ownerName).toBeString();
		const second = await listSpecImportStates({ status: "reverted", limit: 2, after: first.next });
		expect(second.items.map((item) => item.narratorId)).toEqual([ids[2], ids[1]]);
		const third = await listSpecImportStates({ status: "reverted", limit: 2, after: second.next });
		expect(third.items.map((item) => item.narratorId)).toContain(ids[0]);
		expect(third.next).toBeNull();
		const counts = await countSpecImportStates();
		expect(counts.reverted).toBeGreaterThanOrEqual(5);
		expect(Object.keys(counts).sort()).toEqual(
			["attention", "busy", "failed", "idle", "imported", "reverted", "running"].sort(),
		);
	});
});
