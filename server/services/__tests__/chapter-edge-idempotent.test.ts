import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { chapterEdges, chapters, projects } from "../../db/schema";

const { db, sqlite } = getTestDb();
// Snapshot the real db module before mocking so afterAll can re-point it back.
// Bun's mock.module is process-wide and mock.restore() does NOT undo it, so this
// migration-only in-memory db (no runtime seeds such as the knowledge
// classification levels) would otherwise leak into later real-db suites.
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

const { chapterEdgeService } = await import("../chapter-edge-service");

const BASE_TIME = new Date("2025-01-01T00:00:00.000Z").getTime();
let tsOffset = 0;
function ts() {
	return new Date(BASE_TIME + tsOffset++ * 1000).toISOString();
}

function seedProject() {
	db.insert(projects)
		.values({ id: "p1", name: "Proj", gitPath: "/tmp/repo", createdAt: ts(), updatedAt: ts() })
		.run();
	db.insert(chapters)
		.values({
			id: "ch-src",
			projectId: "p1",
			title: "Source",
			branch: "main",
			baseBranch: "main",
			createdAt: ts(),
			updatedAt: ts(),
		})
		.run();
	db.insert(chapters)
		.values({
			id: "ch-tgt",
			projectId: "p1",
			title: "Target",
			branch: "fork/target",
			baseBranch: "main",
			createdAt: ts(),
			updatedAt: ts(),
		})
		.run();
}

afterEach(() => {
	cleanDb(sqlite);
	tsOffset = 0;
});

describe("createForkEdge idempotency", () => {
	test("second call with same source/target does not create a duplicate edge", async () => {
		seedProject();
		const metadata = {
			commitSha: "abc123",
			worktreeSource: "workspace" as const,
			inheritMode: "full",
		};

		const edge1 = await chapterEdgeService.createForkEdge("p1", "ch-src", "ch-tgt", metadata);
		const edge2 = await chapterEdgeService.createForkEdge("p1", "ch-src", "ch-tgt", {
			commitSha: "def456",
			worktreeSource: "commit",
			inheritMode: "compressed",
		});

		// Same edge row, updated metadata
		expect(edge1.id).toBe(edge2.id);
		expect(edge2.metadata).toMatchObject({
			commitSha: "def456",
			worktreeSource: "commit",
			inheritMode: "compressed",
		});

		// Only one edge in the database
		const allEdges = db.select().from(chapterEdges).where(eq(chapterEdges.projectId, "p1")).all();
		expect(allEdges).toHaveLength(1);
	});

	test("concurrent calls for the same pair still produce exactly one edge", async () => {
		seedProject();
		const metadata = {
			commitSha: "abc123",
			worktreeSource: "workspace" as const,
			inheritMode: "full",
		};

		// `chapter_edges` has no UNIQUE constraint on (source, target, type), so the
		// database cannot reject a duplicate. Interleaving is only prevented by the
		// lookup and the write sharing one synchronous transaction — kicking both
		// calls off without awaiting the first is what would expose a re-introduced
		// await point between the check and the insert.
		const [edge1, edge2] = await Promise.all([
			chapterEdgeService.createForkEdge("p1", "ch-src", "ch-tgt", metadata),
			chapterEdgeService.createForkEdge("p1", "ch-src", "ch-tgt", metadata),
		]);

		expect(edge1.id).toBe(edge2.id);
		const allEdges = db.select().from(chapterEdges).where(eq(chapterEdges.projectId, "p1")).all();
		expect(allEdges).toHaveLength(1);
	});

	test("different target creates a separate edge", async () => {
		seedProject();
		db.insert(chapters)
			.values({
				id: "ch-tgt2",
				projectId: "p1",
				title: "Target 2",
				branch: "fork/target2",
				baseBranch: "main",
				createdAt: ts(),
				updatedAt: ts(),
			})
			.run();

		const metadata = {
			commitSha: "abc123",
			worktreeSource: "workspace" as const,
			inheritMode: "full",
		};
		await chapterEdgeService.createForkEdge("p1", "ch-src", "ch-tgt", metadata);
		await chapterEdgeService.createForkEdge("p1", "ch-src", "ch-tgt2", metadata);

		const allEdges = db.select().from(chapterEdges).where(eq(chapterEdges.projectId, "p1")).all();
		expect(allEdges).toHaveLength(2);
	});
});

/**
 * Merge edges need the same guarantee as fork edges and for the same reason: no
 * UNIQUE constraint backs (source, target, type), so the only thing standing
 * between a double-clicked merge and a duplicated graph edge is the lookup and the
 * write sharing one synchronous transaction.
 */
describe("createMergeEdge idempotency", () => {
	test("second call with same source/target updates rather than duplicates", async () => {
		seedProject();

		const edge1 = await chapterEdgeService.createMergeEdge("p1", "ch-src", "ch-tgt", {
			mergeCommitSha: "abc123",
			strategy: "squash",
			status: "pending",
		});
		const edge2 = await chapterEdgeService.createMergeEdge("p1", "ch-src", "ch-tgt", {
			mergeCommitSha: "def456",
			strategy: "merge",
			status: "completed",
		});

		expect(edge1.id).toBe(edge2.id);
		expect(edge2.metadata).toMatchObject({
			mergeCommitSha: "def456",
			strategy: "merge",
			status: "completed",
		});

		const allEdges = db.select().from(chapterEdges).where(eq(chapterEdges.projectId, "p1")).all();
		expect(allEdges).toHaveLength(1);
	});

	test("concurrent calls for the same pair still produce exactly one edge", async () => {
		seedProject();
		const metadata = { mergeCommitSha: "abc123", strategy: "squash" };

		// Kicking both off without awaiting the first is what exposes an await point
		// between the existence check and the insert.
		const [edge1, edge2] = await Promise.all([
			chapterEdgeService.createMergeEdge("p1", "ch-src", "ch-tgt", metadata),
			chapterEdgeService.createMergeEdge("p1", "ch-src", "ch-tgt", metadata),
		]);

		expect(edge1.id).toBe(edge2.id);
		const allEdges = db.select().from(chapterEdges).where(eq(chapterEdges.projectId, "p1")).all();
		expect(allEdges).toHaveLength(1);
	});

	test("a merge edge and a fork edge for the same pair coexist", async () => {
		// The dedupe key includes `type`, so merging a chapter that was forked from the
		// same parent must not overwrite the fork edge that records its origin.
		seedProject();
		await chapterEdgeService.createForkEdge("p1", "ch-src", "ch-tgt", {
			commitSha: "abc123",
			worktreeSource: "workspace",
			inheritMode: "full",
		});
		await chapterEdgeService.createMergeEdge("p1", "ch-src", "ch-tgt", {
			mergeCommitSha: "def456",
			strategy: "squash",
		});

		const allEdges = db.select().from(chapterEdges).where(eq(chapterEdges.projectId, "p1")).all();
		expect(allEdges).toHaveLength(2);
		expect(allEdges.map((edge) => edge.type).sort()).toEqual(["fork", "merge"]);
	});
});
