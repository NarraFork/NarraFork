import { afterEach, describe, expect, it } from "bun:test";
import { chapters, projects } from "../../../server/db/schema";
import { buildGraph } from "../../../server/routes/graph";
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
}

// Empty maps for tests that don't need narrator/container data
const emptyNarratorCounts = new Map<string, number>();
const emptyContainerPresence = new Set<string>();

describe("story network graph", () => {
	it("builds nodes for all chapters", async () => {
		seedGraph();
		const allChapters = await db.query.chapters.findMany();
		const { nodes } = buildGraph(allChapters as any, emptyNarratorCounts, emptyContainerPresence);
		expect(nodes).toHaveLength(3);
		expect(nodes.map((n: any) => n.id).sort()).toEqual(["fork1", "merged1", "root"]);
	});

	it("creates fork edges from parent to child", async () => {
		seedGraph();
		const allChapters = await db.query.chapters.findMany();
		const { edges } = buildGraph(allChapters as any, emptyNarratorCounts, emptyContainerPresence);
		const forkEdges = edges.filter((e) => e.type === "forkEdge");
		expect(forkEdges).toHaveLength(2); // fork1 and merged1 both have parentChapterId
		expect(forkEdges.some((e) => e.source === "root" && e.target === "fork1")).toBe(true);
	});

	it("creates merge edges from source to target", async () => {
		seedGraph();
		const allChapters = await db.query.chapters.findMany();
		const { edges } = buildGraph(allChapters as any, emptyNarratorCounts, emptyContainerPresence);
		const mergeEdges = edges.filter((e) => e.type === "mergeEdge");
		expect(mergeEdges).toHaveLength(1);
		expect(mergeEdges[0].source).toBe("merged1");
		expect(mergeEdges[0].target).toBe("root");
	});

	it("root chapter has no incoming fork edges", async () => {
		seedGraph();
		const allChapters = await db.query.chapters.findMany();
		const { edges } = buildGraph(allChapters as any, emptyNarratorCounts, emptyContainerPresence);
		const incomingToRoot = edges.filter((e) => e.target === "root" && e.type === "forkEdge");
		expect(incomingToRoot).toHaveLength(0);
	});
});
