import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { chapterEdges, chapters, projects } from "../../../server/db/schema";
import { buildGraph, type GraphNode } from "../../../server/routes/graph";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();

afterEach(() => cleanDb(sqlite));

const now = new Date().toISOString();

function seedGraph() {
	db.insert(projects)
		.values({ id: "p1", name: "Proj", gitPath: "/tmp/repo", createdAt: now, updatedAt: now })
		.run();

	// Root chapter
	db.insert(chapters)
		.values({
			id: "root",
			projectId: "p1",
			title: "Root",
			branch: "chapter/root-aaa",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	// Fork from root
	db.insert(chapters)
		.values({
			id: "fork1",
			projectId: "p1",
			title: "Fork 1",
			branch: "chapter/fork1-bbb",
			baseBranch: "chapter/root-aaa",
			parentChapterId: "root",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	// Merged chapter
	db.insert(chapters)
		.values({
			id: "merged1",
			projectId: "p1",
			title: "Merged",
			status: "merged",
			branch: "chapter/merged-ccc",
			baseBranch: "main",
			parentChapterId: "root",
			mergedIntoChapterId: "root",
			mergeStrategy: "squash",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	// Explicit chapter edges drive graph rendering
	db.insert(chapterEdges)
		.values([
			{
				id: "edge-fork-root-fork1",
				projectId: "p1",
				sourceId: "root",
				targetId: "fork1",
				type: "fork",
				metadata: null,
				createdAt: now,
			},
			{
				id: "edge-fork-root-merged1",
				projectId: "p1",
				sourceId: "root",
				targetId: "merged1",
				type: "fork",
				metadata: null,
				createdAt: now,
			},
			{
				id: "edge-merge-merged1-root",
				projectId: "p1",
				sourceId: "merged1",
				targetId: "root",
				type: "merge",
				metadata: null,
				createdAt: now,
			},
		])
		.run();
}

// Empty maps for tests that don't need narrator/container data
const emptyNarratorCounts = new Map<string, number>();
const emptyNarratorIds = new Map<string, string>();
const emptyNarratorStatuses = new Map<string, string>();
const emptyNarratorSubstatuses = new Map<string, string[]>();
const emptyContainerPresence = new Set<string>();
function pickNodeIds(nodes: GraphNode[]): string[] {
	return nodes.map((n) => n.id).sort();
}

describe("story network graph", () => {
	it("builds nodes for all chapters", async () => {
		seedGraph();
		const allChapters = await db.query.chapters.findMany();
		const edgeRows = await db.select().from(chapterEdges).all();
		const { nodes } = buildGraph(
			allChapters,
			emptyNarratorCounts,
			emptyNarratorIds,
			emptyNarratorStatuses,
			emptyNarratorSubstatuses,
			emptyContainerPresence,
			edgeRows,
		);
		expect(nodes).toHaveLength(3);
		expect(pickNodeIds(nodes)).toEqual(["fork1", "merged1", "root"]);
	});

	it("creates fork edges from parent to child", async () => {
		seedGraph();
		const allChapters = await db.query.chapters.findMany();
		const edgeRows = await db.select().from(chapterEdges).all();
		const { edges } = buildGraph(
			allChapters,
			emptyNarratorCounts,
			emptyNarratorIds,
			emptyNarratorStatuses,
			emptyNarratorSubstatuses,
			emptyContainerPresence,
			edgeRows,
		);
		const forkEdges = edges.filter((e) => e.type === "fork");
		expect(forkEdges).toHaveLength(2);
		expect(forkEdges.some((e) => e.source === "root" && e.target === "fork1")).toBe(true);
	});

	it("creates merge edges from source to target", async () => {
		seedGraph();
		const allChapters = await db.query.chapters.findMany();
		const edgeRows = await db.select().from(chapterEdges).all();
		const { edges } = buildGraph(
			allChapters,
			emptyNarratorCounts,
			emptyNarratorIds,
			emptyNarratorStatuses,
			emptyNarratorSubstatuses,
			emptyContainerPresence,
			edgeRows,
		);
		const mergeEdges = edges.filter((e) => e.type === "merge");
		expect(mergeEdges).toHaveLength(1);
		expect(mergeEdges[0].source).toBe("merged1");
		expect(mergeEdges[0].target).toBe("root");
	});

	it("root chapter has no incoming fork edges", async () => {
		seedGraph();
		const allChapters = await db.query.chapters.findMany();
		const edgeRows = await db.select().from(chapterEdges).all();
		const { edges } = buildGraph(
			allChapters,
			emptyNarratorCounts,
			emptyNarratorIds,
			emptyNarratorStatuses,
			emptyNarratorSubstatuses,
			emptyContainerPresence,
			edgeRows,
		);
		const incomingToRoot = edges.filter((e) => e.target === "root" && e.type === "fork");
		expect(incomingToRoot).toHaveLength(0);
	});
});

/**
 * The two canvases keep separate coordinates.
 *
 * Ruler stores offsets relative to a commit tick (`axisOffset`/`crossOffset` +
 * `anchorCommitSha`); classic stores absolute React Flow coordinates
 * (`graphX`/`graphY`). They shared the ruler pair once, and the result was that a
 * project arranged in ruler became unusable in classic: tick offsets run into the
 * tens of thousands of pixels (240px per commit), so read as world coordinates the
 * nodes landed far off-screen, `fitView` zoomed out to almost nothing, and the
 * canvas looked blank.
 */
describe("classic vs ruler coordinates", () => {
	it("reads classic coordinates, never ruler's tick offsets", async () => {
		seedGraph();
		// A chapter arranged in RULER: large tick-relative offsets, no classic position.
		db.update(chapters)
			.set({
				anchorCommitSha: "deadbeef",
				axisOffset: 48_000,
				crossOffset: 300,
				graphX: null,
				graphY: null,
			})
			.where(eq(chapters.id, "fork1"))
			.run();

		const allChapters = await db.query.chapters.findMany();
		const edgeRows = await db.select().from(chapterEdges).all();
		const { nodes } = buildGraph(
			allChapters,
			emptyNarratorCounts,
			emptyNarratorIds,
			emptyNarratorStatuses,
			emptyNarratorSubstatuses,
			emptyContainerPresence,
			edgeRows,
		);

		const fork = nodes.find((n) => n.id === "fork1");
		// Null, not 48000: unplaced on this canvas, so the client auto-lays it out.
		expect(fork?.position).toEqual({ x: null, y: null });
	});

	it("keeps 0 distinct from unplaced", async () => {
		seedGraph();
		// The origin is a position a user can really drag a node to. Collapsing it into
		// "unplaced" made any node near 0,0 get auto-laid-out away on the next load.
		db.update(chapters).set({ graphX: 0, graphY: 0 }).where(eq(chapters.id, "fork1")).run();

		const allChapters = await db.query.chapters.findMany();
		const edgeRows = await db.select().from(chapterEdges).all();
		const { nodes } = buildGraph(
			allChapters,
			emptyNarratorCounts,
			emptyNarratorIds,
			emptyNarratorStatuses,
			emptyNarratorSubstatuses,
			emptyContainerPresence,
			edgeRows,
		);

		expect(nodes.find((n) => n.id === "fork1")?.position).toEqual({ x: 0, y: 0 });
		// An untouched chapter stays unplaced, so the two states remain telling apart.
		expect(nodes.find((n) => n.id === "root")?.position).toEqual({ x: null, y: null });
	});

	it("preserves negative classic coordinates", async () => {
		seedGraph();
		// Ruler clamps its cross axis at 0 because it measures distance from a track.
		// A React Flow canvas has no such floor, and clamping dragged nodes above the
		// origin back down onto the axis.
		db.update(chapters).set({ graphX: -1_200, graphY: -640 }).where(eq(chapters.id, "fork1")).run();

		const allChapters = await db.query.chapters.findMany();
		const edgeRows = await db.select().from(chapterEdges).all();
		const { nodes } = buildGraph(
			allChapters,
			emptyNarratorCounts,
			emptyNarratorIds,
			emptyNarratorStatuses,
			emptyNarratorSubstatuses,
			emptyContainerPresence,
			edgeRows,
		);

		expect(nodes.find((n) => n.id === "fork1")?.position).toEqual({ x: -1_200, y: -640 });
	});

	it("leaves ruler's columns untouched when classic coordinates are written", async () => {
		seedGraph();
		db.update(chapters)
			.set({ anchorCommitSha: "deadbeef", axisOffset: 48_000, crossOffset: 300 })
			.where(eq(chapters.id, "fork1"))
			.run();

		// What PATCH /graph/positions does: classic columns only.
		db.update(chapters).set({ graphX: 120, graphY: 80 }).where(eq(chapters.id, "fork1")).run();

		const row = await db.query.chapters.findFirst({ where: eq(chapters.id, "fork1") });
		// Arranging the classic canvas must not disturb the ruler layout — that mutual
		// clobbering is the defect these separate columns exist to prevent.
		expect(row?.anchorCommitSha).toBe("deadbeef");
		expect(row?.axisOffset).toBe(48_000);
		expect(row?.crossOffset).toBe(300);
		expect(row?.graphX).toBe(120);
		expect(row?.graphY).toBe(80);
	});
});
