/**
 * The chapter write store's contract, verified against real SQLite through the
 * production SQLite implementation.
 *
 * WHAT IS BEING PINNED
 * --------------------
 * The port (`services/chapter-write/write-store.ts`) makes three promises that the
 * services rely on, and each is exercised where it can actually break:
 *
 *   - THE EDGE UPSERT RACE: `upsertForkEdge` / `upsertMergeEdge` decide INSIDE the
 *     atomic section, so concurrent upserts of the same (source, target, type)
 *     produce exactly one edge — the table has no unique constraint to lean on.
 *   - CONFLICTS AS VOCABULARY: a uniqueness conflict (the `(project_id, branch)`
 *     unique index) arrives as `WriteConflictError`, never as a driver error, and
 *     the conflicting insert leaves nothing behind.
 *   - ATOMIC SECTIONS: the split's continuation rewrite recomputes the commit count
 *     inside the section and rejects with `NotFoundError` — writing nothing — when
 *     the chapter is gone; the fork-edge retarget re-reads and validates inside the
 *     section with the pre-port error identities.
 *
 * The selection rules (`store.ts`) live in `store-wiring.test.ts`; the PostgreSQL
 * implementation runs the same business facts against a real server in
 * `tests/server/services/chapter-write/pg-chapter-write.test.ts`.
 *
 * ISOLATION: the isolated database from `tests/preload.ts` (temp NARRAFORK_HOME).
 * All rows are tagged per run, so no cleanup is needed.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { chapterCommits, chapterEdges, chapters, projects } from "../../../db/schema";
import { NotFoundError, ValidationError } from "../../../lib/errors";
import { generateId } from "../../../lib/id";
import { sqliteChapterWriteStore as store } from "../sqlite-write-store";
import { WriteConflictError } from "../write-store";

const TAG = generateId(8);
const NOW = () => new Date().toISOString();
const SHA = (n: number) => n.toString(16).padStart(40, "0");

async function makeProject(): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `cw-${TAG}`,
		gitPath: `/tmp/cw-${TAG}`,
		createdAt: NOW(),
		updatedAt: NOW(),
	});
	return id;
}

async function makeChapter(
	projectId: string,
	overrides: Partial<Parameters<typeof store.insertChapter>[0]> = {},
) {
	return store.insertChapter({
		id: generateId(),
		projectId,
		title: `chapter-${generateId(6)}`,
		description: null,
		status: "active",
		role: "branch",
		branch: `chapter/${generateId(8)}`,
		worktreePath: null,
		baseBranch: "main",
		parentChapterId: null,
		forkPoint: null,
		startCommitSha: null,
		lastAccessedAt: null,
		createdAt: NOW(),
		updatedAt: NOW(),
		...overrides,
	});
}

describe("chapter write store (SQLite)", () => {
	test("insertChapter returns the stored row; a branch race crosses as WriteConflictError", async () => {
		const projectId = await makeProject();
		const chapter = await makeChapter(projectId, { title: "first" });
		expect(chapter.title).toBe("first");
		expect(chapter.status).toBe("active");

		// Same (project, branch): the unique index is the last line of defence, and the
		// conflict must cross as port vocabulary — with nothing written.
		let conflict: unknown;
		try {
			await makeChapter(projectId, { branch: chapter.branch });
		} catch (error) {
			conflict = error;
		}
		expect(conflict).toBeInstanceOf(WriteConflictError);
		expect((conflict as WriteConflictError).constraint).toContain("branch");

		const rows = await db
			.select({ id: chapters.id })
			.from(chapters)
			.where(eq(chapters.branch, chapter.branch));
		expect(rows).toHaveLength(1);
	});

	test("upsertForkEdge is idempotent and never duplicates under concurrency", async () => {
		const projectId = await makeProject();
		const source = await makeChapter(projectId);
		const target = await makeChapter(projectId, { parentChapterId: source.id });
		const metadata = { commitSha: SHA(1), worktreeSource: "commit", inheritMode: "full" };

		const first = await store.upsertForkEdge({
			id: generateId(),
			projectId,
			sourceId: source.id,
			targetId: target.id,
			metadata,
			now: NOW(),
		});
		expect(first.type).toBe("fork");
		expect(first.metadata).toEqual(metadata);

		// A second upsert with fresh metadata updates the SAME edge in place.
		const second = await store.upsertForkEdge({
			id: generateId(),
			projectId,
			sourceId: source.id,
			targetId: target.id,
			metadata: { ...metadata, commitSha: SHA(2) },
			now: NOW(),
		});
		expect(second.id).toBe(first.id);
		expect(second.metadata).toMatchObject({ commitSha: SHA(2) });

		// The race the section exists to close: N concurrent upserts, one edge.
		await Promise.all(
			Array.from({ length: 4 }, () =>
				store.upsertForkEdge({
					id: generateId(),
					projectId,
					sourceId: source.id,
					targetId: target.id,
					metadata,
					now: NOW(),
				}),
			),
		);
		const edges = await db.select().from(chapterEdges).where(eq(chapterEdges.projectId, projectId));
		expect(edges).toHaveLength(1);
	});

	test("upsertMergeEdge updates in place and coexists with a fork edge of the same pair", async () => {
		const projectId = await makeProject();
		const source = await makeChapter(projectId);
		const target = await makeChapter(projectId);

		const merge = await store.upsertMergeEdge({
			id: generateId(),
			projectId,
			sourceId: source.id,
			targetId: target.id,
			metadata: { mergeCommitSha: SHA(3), strategy: "merge" },
			now: NOW(),
		});
		const again = await store.upsertMergeEdge({
			id: generateId(),
			projectId,
			sourceId: source.id,
			targetId: target.id,
			metadata: { mergeSnapshotCommitSha: SHA(4), strategy: "squash", status: "completed" },
			now: NOW(),
		});
		expect(again.id).toBe(merge.id);
		expect(again.metadata).toMatchObject({ strategy: "squash", status: "completed" });

		await store.upsertForkEdge({
			id: generateId(),
			projectId,
			sourceId: source.id,
			targetId: target.id,
			metadata: { commitSha: SHA(5), worktreeSource: "commit", inheritMode: "full" },
			now: NOW(),
		});
		const edges = await db.select().from(chapterEdges).where(eq(chapterEdges.projectId, projectId));
		// One merge edge (updated, not duplicated) plus one fork edge of a different type.
		expect(edges.map((e) => e.type).sort()).toEqual(["fork", "merge"]);

		// deleteMergeEdgesBySource removes the merge line and leaves the fork line.
		await store.deleteMergeEdgesBySource(source.id);
		const remaining = await db
			.select()
			.from(chapterEdges)
			.where(eq(chapterEdges.projectId, projectId));
		expect(remaining.map((e) => e.type)).toEqual(["fork"]);
	});

	test("retargetForkEdge validates inside the section and returns the previous target", async () => {
		const projectId = await makeProject();
		const source = await makeChapter(projectId);
		const target = await makeChapter(projectId, { parentChapterId: source.id });
		const other = await makeChapter(projectId);
		const edge = await store.upsertForkEdge({
			id: generateId(),
			projectId,
			sourceId: source.id,
			targetId: target.id,
			metadata: { commitSha: SHA(6), worktreeSource: "commit", inheritMode: "full" },
			now: NOW(),
		});

		const previous = await store.retargetForkEdge({ edgeId: edge.id, newTargetId: other.id });
		expect(previous).toBe(target.id);
		const moved = await db.query.chapterEdges.findFirst({ where: eq(chapterEdges.id, edge.id) });
		expect(moved?.targetId).toBe(other.id);

		// Same-target retarget is a no-op reporting the current target.
		expect(await store.retargetForkEdge({ edgeId: edge.id, newTargetId: other.id })).toBe(other.id);

		await expect(
			store.retargetForkEdge({ edgeId: edge.id, newTargetId: source.id }),
		).rejects.toThrow(ValidationError);
		await expect(
			store.retargetForkEdge({ edgeId: edge.id, newTargetId: generateId() }),
		).rejects.toThrow(NotFoundError);
		await expect(
			store.retargetForkEdge({ edgeId: generateId(), newTargetId: other.id }),
		).rejects.toThrow(NotFoundError);

		// A merge edge is not retargetable.
		const mergeEdge = await store.upsertMergeEdge({
			id: generateId(),
			projectId,
			sourceId: source.id,
			targetId: target.id,
			metadata: { strategy: "merge" },
			now: NOW(),
		});
		await expect(
			store.retargetForkEdge({ edgeId: mergeEdge.id, newTargetId: other.id }),
		).rejects.toThrow(ValidationError);
	});

	test("recordChapterMerge clears snapshot coordinates; the snapshot merge records them", async () => {
		const projectId = await makeProject();
		const target = await makeChapter(projectId);
		const source = await makeChapter(projectId, { worktreePath: "/tmp/wt" });

		await store.recordChapterSnapshotMerge({
			sourceChapterId: source.id,
			targetChapterId: target.id,
			strategy: "merge",
			mergeSnapshotCommitSha: SHA(10),
			preMergeTargetSnapshotSha: SHA(11),
			mergedSourceSnapshotSha: SHA(12),
			preMergeTargetSha: SHA(13),
			now: NOW(),
		});
		let row = await db.query.chapters.findFirst({ where: eq(chapters.id, source.id) });
		expect(row?.status).toBe("merged");
		expect(row?.mergedIntoChapterId).toBe(target.id);
		expect(row?.worktreePath).toBeNull();
		expect(row?.mergeSnapshotCommitSha).toBe(SHA(10));
		expect(row?.mergeCommitSha).toBeNull();

		await store.restoreMergedChapter({
			chapterId: source.id,
			worktreePath: "/tmp/wt2",
			clearSnapshotMergeFields: true,
			now: NOW(),
		});
		row = await db.query.chapters.findFirst({ where: eq(chapters.id, source.id) });
		expect(row?.status).toBe("active");
		expect(row?.mergedIntoChapterId).toBeNull();
		expect(row?.mergeSnapshotCommitSha).toBeNull();
		expect(row?.worktreePath).toBe("/tmp/wt2");

		// Seed stale snapshot coordinates, then record a commit-producing merge: the
		// coordinates must be cleared by the same statement, not left to misroute a
		// later unmerge.
		await store.setChapterParkedWork({
			chapterId: source.id,
			commitSha: SHA(14),
			baseTree: SHA(15),
		});
		await store.recordChapterSnapshotMerge({
			sourceChapterId: source.id,
			targetChapterId: target.id,
			strategy: "squash",
			mergeSnapshotCommitSha: SHA(16),
			preMergeTargetSnapshotSha: SHA(17),
			mergedSourceSnapshotSha: SHA(18),
			preMergeTargetSha: null,
			now: NOW(),
		});
		await store.restoreMergedChapter({
			chapterId: source.id,
			worktreePath: "/tmp/wt3",
			clearSnapshotMergeFields: false,
			now: NOW(),
		});
		row = await db.query.chapters.findFirst({ where: eq(chapters.id, source.id) });
		// The commit-based unmerge deliberately leaves snapshot coordinates alone.
		expect(row?.mergeSnapshotCommitSha).toBe(SHA(16));

		await store.recordChapterMerge({
			sourceChapterId: source.id,
			targetChapterId: target.id,
			strategy: "merge",
			mergeCommitSha: SHA(19),
			preMergeTargetSha: SHA(20),
			now: NOW(),
		});
		row = await db.query.chapters.findFirst({ where: eq(chapters.id, source.id) });
		expect(row?.status).toBe("merged");
		expect(row?.mergeCommitSha).toBe(SHA(19));
		expect(row?.mergeStrategy).toBe("merge");
		expect(row?.mergeSnapshotCommitSha).toBeNull();
		expect(row?.preMergeTargetSnapshotSha).toBeNull();
		expect(row?.mergedSourceSnapshotSha).toBeNull();

		const parked = await db.query.chapters.findFirst({ where: eq(chapters.id, source.id) });
		expect(parked?.parkedSnapshotCommitSha).toBe(SHA(14));
		await store.setChapterParkedWork({ chapterId: source.id, commitSha: null, baseTree: null });
		row = await db.query.chapters.findFirst({ where: eq(chapters.id, source.id) });
		expect(row?.parkedSnapshotCommitSha).toBeNull();
	});

	test("rewriteSplitContinuation recomputes the count and rewrites the lineage atomically", async () => {
		const projectId = await makeProject();
		const prefix = await makeChapter(projectId);
		const original = await makeChapter(projectId, { commitCount: 99 });
		await db.insert(chapterCommits).values([
			{
				id: generateId(),
				chapterId: original.id,
				sha: SHA(21),
				message: "one",
				authoredAt: NOW(),
				createdAt: NOW(),
			},
			{
				id: generateId(),
				chapterId: original.id,
				sha: SHA(22),
				message: "two",
				authoredAt: NOW(),
				createdAt: NOW(),
			},
		]);

		const rewritten = await store.rewriteSplitContinuation({
			chapterId: original.id,
			prefixId: prefix.id,
			commitSha: SHA(23),
			narratorMessageId: generateId(),
			fallbackCommitCount: original.commitCount,
			now: NOW(),
		});
		expect(rewritten.parentChapterId).toBe(prefix.id);
		expect(rewritten.startCommitSha).toBe(SHA(23));
		expect(rewritten.forkPoint).toEqual({
			commitSha: SHA(23),
			narratorMessageId: expect.any(String),
		});
		// Recomputed from chapter_commits, never trusted from the caller's 99.
		expect(rewritten.commitCount).toBe(2);

		// A vanished chapter rejects with NotFoundError — and has written nothing.
		await expect(
			store.rewriteSplitContinuation({
				chapterId: generateId(),
				prefixId: prefix.id,
				commitSha: SHA(24),
				fallbackCommitCount: null,
				now: NOW(),
			}),
		).rejects.toThrow(NotFoundError);

		await store.updateSplitPrefixHead({
			prefixId: prefix.id,
			startCommitSha: SHA(25),
			headCommitSha: SHA(26),
			now: NOW(),
		});
		const head = await db.query.chapters.findFirst({ where: eq(chapters.id, prefix.id) });
		expect(head?.startCommitSha).toBe(SHA(25));
		expect(head?.headCommitSha).toBe(SHA(26));
	});

	test("updateChapterContainerConfig and deleteChapter round-trip", async () => {
		const projectId = await makeProject();
		const chapter = await makeChapter(projectId);
		const config = { compose: "services: { app: {} }" };
		await store.updateChapterContainerConfig({
			chapterId: chapter.id,
			containerConfig: config,
			now: NOW(),
		});
		const configured = await db.query.chapters.findFirst({ where: eq(chapters.id, chapter.id) });
		expect(configured?.containerConfig).toEqual(config);

		await store.deleteChapter(chapter.id);
		expect(
			await db.query.chapters.findFirst({ where: eq(chapters.id, chapter.id) }),
		).toBeUndefined();
	});
});
