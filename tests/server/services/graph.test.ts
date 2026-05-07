import { afterEach, describe, expect, it } from "bun:test";
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
