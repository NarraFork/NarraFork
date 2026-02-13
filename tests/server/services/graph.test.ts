import { afterEach, describe, expect, it } from "bun:test";
import { chapters, projects, repositories } from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();

afterEach(() => cleanDb(sqlite));

const now = new Date().toISOString();

function seedGraph() {
	db.insert(projects).values({ id: "p1", name: "Proj", createdAt: now, updatedAt: now }).run();
	db.insert(repositories)
		.values({
			id: "r1",
			projectId: "p1",
			path: "/tmp/repo",
			displayName: "repo",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	// Root chapter
	db.insert(chapters)
		.values({
			id: "root",
			projectId: "p1",
			repositoryId: "r1",
			title: "Root",
			branch: "meanwhile/root-aaa",
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
			repositoryId: "r1",
			title: "Fork 1",
			type: "whatif",
			branch: "whatif/fork1-bbb",
			baseBranch: "meanwhile/root-aaa",
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
			repositoryId: "r1",
			title: "Merged",
			status: "merged",
			branch: "meanwhile/merged-ccc",
			baseBranch: "main",
			parentChapterId: "root",
			mergedIntoChapterId: "root",
			mergeStrategy: "squash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

// Replicate the graph building logic from server/routes/graph.ts
function buildGraph(projectChapters: any[]) {
	const nodes = projectChapters.map((ch: any) => ({
		id: ch.id,
		type: "chapterNode",
		data: {
			title: ch.title,
			chapterType: ch.type,
			status: ch.status,
		},
	}));

	const edges: Array<{ id: string; source: string; target: string; type: string }> = [];
	for (const ch of projectChapters) {
		if (ch.parentChapterId) {
			edges.push({
				id: `fork-${ch.parentChapterId}-${ch.id}`,
				source: ch.parentChapterId,
				target: ch.id,
				type: "forkEdge",
			});
		}
		if (ch.mergedIntoChapterId) {
			edges.push({
				id: `merge-${ch.id}-${ch.mergedIntoChapterId}`,
				source: ch.id,
				target: ch.mergedIntoChapterId,
				type: "mergeEdge",
			});
		}
	}

	return { nodes, edges };
}

describe("story network graph", () => {
	it("builds nodes for all chapters", async () => {
		seedGraph();
		const allChapters = await db.query.chapters.findMany();
		const { nodes } = buildGraph(allChapters);
		expect(nodes).toHaveLength(3);
		expect(nodes.map((n: any) => n.id).sort()).toEqual(["fork1", "merged1", "root"]);
	});

	it("creates fork edges from parent to child", async () => {
		seedGraph();
		const allChapters = await db.query.chapters.findMany();
		const { edges } = buildGraph(allChapters);
		const forkEdges = edges.filter((e) => e.type === "forkEdge");
		expect(forkEdges).toHaveLength(2); // fork1 and merged1 both have parentChapterId
		expect(forkEdges.some((e) => e.source === "root" && e.target === "fork1")).toBe(true);
	});

	it("creates merge edges from source to target", async () => {
		seedGraph();
		const allChapters = await db.query.chapters.findMany();
		const { edges } = buildGraph(allChapters);
		const mergeEdges = edges.filter((e) => e.type === "mergeEdge");
		expect(mergeEdges).toHaveLength(1);
		expect(mergeEdges[0].source).toBe("merged1");
		expect(mergeEdges[0].target).toBe("root");
	});

	it("root chapter has no incoming fork edges", async () => {
		seedGraph();
		const allChapters = await db.query.chapters.findMany();
		const { edges } = buildGraph(allChapters);
		const incomingToRoot = edges.filter((e) => e.target === "root" && e.type === "forkEdge");
		expect(incomingToRoot).toHaveLength(0);
	});
});
