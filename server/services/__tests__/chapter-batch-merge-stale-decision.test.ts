/**
 * Startup gate + resolveDecision state safety for batch merge sessions.
 *
 * The bug class: `cleanupStaleSessions` used to call `abortInteractiveSnapshotMerge`
 * on every stale snapshot session, overwriting commits and uncommitted work written
 * after the conflict. These cases pin the fixed contract:
 *   - cleanup is DB-metadata only and preserves snapshot coordinates as evidence
 *   - resolveDecision is gated on `waiting_decision` and serialised per session
 *   - cancel restore failure surfaces to the caller instead of becoming `cancelled`
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { chapters, mergeSessions, projects } from "../../db/schema";
import { ValidationError } from "../../lib/errors";

const { db, sqlite } = getTestDb();
const dbStub = {
	db,
	sqlite,
	activeDatabaseBackend: "sqlite" as const,
	startupShutdownState: { canSkipVerification: true },
	markDatabaseCleanShutdown: () => true,
	releaseDatabaseInstanceLockOnly: () => {},
};
// Never import the real `../../db`: that opens the production database and runs
// migrations. Point every specifier at the in-memory test DB only.
mock.module("../../db", () => dbStub);
mock.module("@server/db", () => dbStub);

type AbortCall = {
	targetWorktree: string;
	preMergeTree: string;
	guard: { expectedCurrentTree: string; expectedHeadSha: string | null };
};
const abortCalls: AbortCall[] = [];
let abortShouldFail = false;

mock.module("../chapter-merge", () => ({
	chapterMerge: {
		abortInteractiveSnapshotMerge: async (
			targetWorktree: string,
			preMergeTree: string,
			guard: { expectedCurrentTree: string; expectedHeadSha: string | null },
		) => {
			abortCalls.push({ targetWorktree, preMergeTree, guard });
			if (abortShouldFail) throw new Error("simulated restore failure");
		},
		completeInteractiveSnapshotMergeById: async () => ({ resolved: true }),
		completeInteractiveConflictMerge: async () => ({ resolved: true }),
		ensurePendingMergeEdge: async () => {},
	},
}));

mock.module("../chapter-service", () => ({
	chapterService: {
		getById: async (id: string) =>
			db.query.chapters.findFirst({ where: eq(chapters.id, id) }) ?? null,
		remove: async () => {},
	},
}));

// Avoid loading the full narrator/agent stack for these unit paths.
mock.module("../narrator-session", () => ({
	sendMessage: async () => {},
}));
mock.module("../narrator-service", () => ({
	narratorService: { create: async () => ({ id: "narrator-mock" }) },
}));
mock.module("../chapter-fork", () => ({
	chapterFork: { fork: async () => ({ id: "fork-mock" }) },
}));

const { chapterBatchMerge } = await import("../chapter-batch-merge");

afterAll(() => {
	mock.restore();
});

const BASE_TIME = new Date("2025-06-01T00:00:00.000Z").getTime();
let tsOffset = 0;
function ts() {
	return new Date(BASE_TIME + tsOffset++ * 1000).toISOString();
}

function seedChapter(id: string, worktreePath: string | null = "/tmp/nf-wt") {
	db.insert(projects)
		.values({
			id: `proj-${id}`,
			name: `Proj ${id}`,
			gitPath: "/tmp/repo",
			createdAt: ts(),
			updatedAt: ts(),
		})
		.run();
	db.insert(chapters)
		.values({
			id,
			projectId: `proj-${id}`,
			title: `Chapter ${id}`,
			branch: `br/${id}`,
			baseBranch: "main",
			worktreePath,
			status: "active",
			createdAt: ts(),
			updatedAt: ts(),
		})
		.run();
}

type SessionStatus =
	| "running"
	| "waiting_decision"
	| "ai_resolving"
	| "completed"
	| "cancelled"
	| "error";

function seedSession(
	id: string,
	opts: {
		status: SessionStatus;
		targetChapterId?: string;
		preMergeTree?: string | null;
		conflictTree?: string | null;
		preMergeTargetSha?: string | null;
		preMergeTargetSnapshot?: string | null;
		mergeSourceSnapshot?: string | null;
		sourceChapterIds?: string[];
	} = { status: "running" },
) {
	const now = ts();
	const targetChapterId = opts.targetChapterId ?? `ch-tgt-${id}`;
	const sourceIds = opts.sourceChapterIds ?? [`ch-src-${id}`];
	db.insert(mergeSessions)
		.values({
			id,
			targetChapterId,
			sourceChapterIds: sourceIds,
			strategy: "merge",
			status: opts.status,
			currentIndex: 0,
			currentSourceChapterId: sourceIds[0] ?? null,
			mergedCount: 0,
			preMergeTree: opts.preMergeTree ?? null,
			conflictTree: opts.conflictTree ?? null,
			preMergeTargetSha: opts.preMergeTargetSha ?? null,
			preMergeTargetSnapshot: opts.preMergeTargetSnapshot ?? null,
			mergeSourceSnapshot: opts.mergeSourceSnapshot ?? null,
			conflictFiles: ["app.txt"],
			createdAt: now,
			updatedAt: now,
		})
		.run();
	return id;
}

async function sessionRow(id: string) {
	const row = await db.query.mergeSessions.findFirst({ where: eq(mergeSessions.id, id) });
	if (!row) throw new Error(`missing session ${id}`);
	return row;
}

beforeEach(() => {
	abortCalls.length = 0;
	abortShouldFail = false;
	tsOffset = 0;
});

afterEach(() => {
	cleanDb(sqlite);
});

describe("cleanupStaleSessions is DB-metadata only", () => {
	test("marks stale snapshot sessions error, preserves coordinates, never aborts", async () => {
		seedChapter("ch-tgt-a");
		seedSession("sess-a", {
			status: "waiting_decision",
			targetChapterId: "ch-tgt-a",
			preMergeTree: "tree-pre",
			conflictTree: "tree-conflict",
			preMergeTargetSha: "sha-head",
			preMergeTargetSnapshot: "snap-target",
			mergeSourceSnapshot: "snap-source",
		});

		await chapterBatchMerge.cleanupStaleSessions();

		expect(abortCalls).toEqual([]);
		const row = await sessionRow("sess-a");
		expect(row.status).toBe("error");
		expect(row.error).toMatch(/workspace preserved/i);
		expect(row.error).toMatch(/not automatically restored/i);
		expect(row.preMergeTree).toBe("tree-pre");
		expect(row.conflictTree).toBe("tree-conflict");
		expect(row.preMergeTargetSha).toBe("sha-head");
		expect(row.preMergeTargetSnapshot).toBe("snap-target");
		expect(row.mergeSourceSnapshot).toBe("snap-source");
		expect(row.conflictFiles).toEqual(["app.txt"]);
	});

	test("is idempotent and leaves finished/error/cancelled untouched", async () => {
		seedChapter("ch-tgt-b");
		seedChapter("ch-tgt-c");
		seedChapter("ch-tgt-d");
		seedSession("sess-stale", {
			status: "running",
			targetChapterId: "ch-tgt-b",
			preMergeTree: "tree-pre",
			conflictTree: "tree-cf",
		});
		seedSession("sess-done", { status: "completed", targetChapterId: "ch-tgt-c" });
		seedSession("sess-cancelled", {
			status: "cancelled",
			targetChapterId: "ch-tgt-d",
			preMergeTree: "tree-x",
		});

		await chapterBatchMerge.cleanupStaleSessions();
		const first = await sessionRow("sess-stale");
		expect(first.status).toBe("error");
		expect(first.preMergeTree).toBe("tree-pre");

		const errorBefore = first.error;
		const updatedAtBefore = first.updatedAt;
		await chapterBatchMerge.cleanupStaleSessions();
		const second = await sessionRow("sess-stale");
		expect(second.status).toBe("error");
		expect(second.error).toBe(errorBefore);
		expect(second.updatedAt).toBe(updatedAtBefore);
		expect((await sessionRow("sess-done")).status).toBe("completed");
		const cancelled = await sessionRow("sess-cancelled");
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.preMergeTree).toBe("tree-x");
		expect(abortCalls).toEqual([]);
	});

	test("pages via id cursor without needing a full-table load", async () => {
		for (let i = 0; i < 5; i++) {
			const id = `ch-page-${i}`;
			seedChapter(id);
			seedSession(`sess-page-${i}`, {
				status: "ai_resolving",
				targetChapterId: id,
				preMergeTree: `tree-${i}`,
			});
		}

		await chapterBatchMerge.cleanupStaleSessions();

		for (let i = 0; i < 5; i++) {
			const row = await sessionRow(`sess-page-${i}`);
			expect(row.status).toBe("error");
			expect(row.preMergeTree).toBe(`tree-${i}`);
			expect(row.error).toMatch(/workspace preserved/i);
		}
		expect(abortCalls).toEqual([]);
	});
});

describe("resolveDecision state gate and cancel safety", () => {
	test("non-waiting status returns with no side effects", async () => {
		seedChapter("ch-gate");
		seedSession("sess-gate", {
			status: "running",
			targetChapterId: "ch-gate",
			preMergeTree: "tree-pre",
			conflictTree: "tree-cf",
			preMergeTargetSha: "sha-1",
		});

		await chapterBatchMerge.resolveDecision("sess-gate", "cancel");
		await chapterBatchMerge.resolveDecision("sess-gate", "continue");

		expect(abortCalls).toEqual([]);
		const row = await sessionRow("sess-gate");
		expect(row.status).toBe("running");
		expect(row.preMergeTree).toBe("tree-pre");
	});

	test("successful cancel restores with dual-guard then clears coordinates", async () => {
		seedChapter("ch-ok");
		seedSession("sess-ok", {
			status: "waiting_decision",
			targetChapterId: "ch-ok",
			preMergeTree: "tree-pre",
			conflictTree: "tree-cf",
			preMergeTargetSha: "sha-head",
		});

		await chapterBatchMerge.resolveDecision("sess-ok", "cancel");

		expect(abortCalls).toEqual([
			{
				targetWorktree: "/tmp/nf-wt",
				preMergeTree: "tree-pre",
				guard: { expectedCurrentTree: "tree-cf", expectedHeadSha: "sha-head" },
			},
		]);
		const row = await sessionRow("sess-ok");
		expect(row.status).toBe("cancelled");
		expect(row.preMergeTree).toBeNull();
		expect(row.conflictTree).toBeNull();
		expect(row.preMergeTargetSha).toBeNull();
	});

	test("null preMergeTargetSha is forwarded as empty HEAD", async () => {
		seedChapter("ch-nullhead");
		seedSession("sess-nullhead", {
			status: "waiting_decision",
			targetChapterId: "ch-nullhead",
			preMergeTree: "tree-pre",
			conflictTree: "tree-cf",
			preMergeTargetSha: null,
		});

		await chapterBatchMerge.resolveDecision("sess-nullhead", "cancel");

		expect(abortCalls[0]?.guard.expectedHeadSha).toBeNull();
		expect((await sessionRow("sess-nullhead")).status).toBe("cancelled");
	});

	test("abort failure throws and preserves status + coordinates", async () => {
		seedChapter("ch-fail");
		seedSession("sess-fail", {
			status: "waiting_decision",
			targetChapterId: "ch-fail",
			preMergeTree: "tree-pre",
			conflictTree: "tree-cf",
			preMergeTargetSha: "sha-head",
		});
		abortShouldFail = true;

		await expect(chapterBatchMerge.resolveDecision("sess-fail", "cancel")).rejects.toThrow(
			/simulated restore failure/,
		);

		const row = await sessionRow("sess-fail");
		expect(row.status).toBe("waiting_decision");
		expect(row.preMergeTree).toBe("tree-pre");
		expect(row.conflictTree).toBe("tree-cf");
		expect(row.preMergeTargetSha).toBe("sha-head");
	});

	test("missing conflictTree refuses cancel with ValidationError", async () => {
		seedChapter("ch-nocf");
		seedSession("sess-nocf", {
			status: "waiting_decision",
			targetChapterId: "ch-nocf",
			preMergeTree: "tree-pre",
			conflictTree: null,
			preMergeTargetSha: "sha-head",
		});

		await expect(chapterBatchMerge.resolveDecision("sess-nocf", "cancel")).rejects.toThrow(
			ValidationError,
		);
		expect(abortCalls).toEqual([]);
		const row = await sessionRow("sess-nocf");
		expect(row.status).toBe("waiting_decision");
		expect(row.preMergeTree).toBe("tree-pre");
	});

	test("double cancel is serialised: second call is a no-op", async () => {
		seedChapter("ch-dbl");
		seedSession("sess-dbl", {
			status: "waiting_decision",
			targetChapterId: "ch-dbl",
			preMergeTree: "tree-pre",
			conflictTree: "tree-cf",
			preMergeTargetSha: "sha-head",
		});

		await Promise.all([
			chapterBatchMerge.resolveDecision("sess-dbl", "cancel"),
			chapterBatchMerge.resolveDecision("sess-dbl", "cancel"),
		]);

		expect(abortCalls.length).toBe(1);
		const row = await sessionRow("sess-dbl");
		expect(row.status).toBe("cancelled");
		expect(row.preMergeTree).toBeNull();
	});
});
