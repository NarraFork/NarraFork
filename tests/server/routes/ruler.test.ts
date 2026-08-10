import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { chapterEdges, chapters, narrators, projects } from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../server/db")) };
const realGitServiceModule = { ...(await import("../../../server/services/git-service")) };

mock.module("../../../server/db", () => ({ db, sqlite }));

let mockCommits: Array<{ sha: string }> = [];
let mockTotalCommitCount = 0;
let getCommitCountCalls: string[] = [];

mock.module("../../../server/services/git-service", () => ({
	gitService: {
		getCommitCount: async (_gitPath: string, ref: string) => {
			getCommitCountCalls.push(ref);
			return mockTotalCommitCount;
		},
		getLog: async () => mockCommits,
	},
}));

const { rulerRoutes } = await import("../../../server/routes/ruler");

const app = new Hono();
app.route("/", rulerRoutes);

const NOW = "2025-01-01T00:00:00.000Z";

beforeEach(() => {
	mockCommits = [{ sha: "sha-a" }, { sha: "sha-b" }, { sha: "sha-c" }];
	mockTotalCommitCount = mockCommits.length;
	getCommitCountCalls = [];
});

afterEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
	mock.module("../../../server/services/git-service", () => realGitServiceModule);
	mock.restore();
	cleanDb(sqlite);
	sqlite.close();
});

function seedProject() {
	db.insert(projects)
		.values({
			id: "p1",
			name: "Project",
			gitPath: "/repo",
			defaultBranch: "main",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedChapter(input: {
	id: string;
	title?: string;
	status?: "active" | "dormant" | "merged" | "abandoned";
	parentChapterId?: string | null;
	startCommitSha?: string | null;
	mergeCommitSha?: string | null;
	axisOffset?: number;
	crossOffset?: number;
}) {
	db.insert(chapters)
		.values({
			id: input.id,
			projectId: "p1",
			title: input.title ?? input.id,
			status: input.status ?? "active",
			branch: `chapter/${input.id}`,
			baseBranch: "main",
			parentChapterId: input.parentChapterId ?? null,
			startCommitSha: input.startCommitSha ?? null,
			mergeCommitSha: input.mergeCommitSha ?? null,
			axisOffset: input.axisOffset ?? 0,
			crossOffset: input.crossOffset ?? 0,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedNarrator(
	id: string,
	chapterId: string,
	status: "idle" | "working" | "waiting" | "archived" = "idle",
	substatus = "[]",
) {
	db.insert(narrators)
		.values({
			id,
			chapterId,
			type: "primary",
			variant: "primary",
			status,
			substatus,
			inheritMode: "fresh",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

describe("ruler routes", () => {
	it("returns ruler summary with active and merged chapters", async () => {
		seedProject();
		seedChapter({ id: "ch-active", startCommitSha: "sha-b", axisOffset: 1, crossOffset: 2 });
		seedChapter({
			id: "ch-merged",
			status: "merged",
			startCommitSha: "sha-c",
			mergeCommitSha: "sha-merge",
		});
		seedNarrator("n-active", "ch-active", "idle", '["unread"]');

		const res = await app.request("/p1/ruler");

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			totalCommitCount: number;
			segments: Array<{
				fromSha: string;
				activeChapterCount: number;
				totalChapterCount: number;
				activeChapterIds: string[];
			}>;
			activeChapters: Array<{
				id: string;
				narratorId: string | null;
				narratorStatus: string | null;
				axisOffset: number;
				crossOffset: number;
			}>;
			mergedChapters: Array<{
				id: string;
				narratorId: string | null;
				mergeCommitSha: string | null;
			}>;
		};

		expect(body.totalCommitCount).toBe(3);
		expect(getCommitCountCalls).toEqual(["main"]);
		expect(body.segments.map((s) => s.fromSha)).toEqual(["sha-b", "sha-c"]);
		expect(body.segments.find((s) => s.fromSha === "sha-b")?.activeChapterIds).toEqual([
			"ch-active",
		]);
		const active = body.activeChapters.find((ch) => ch.id === "ch-active");
		expect(active).toMatchObject({
			narratorId: "n-active",
			narratorStatus: "unread",
			axisOffset: 1,
			crossOffset: 2,
		});
		expect(body.mergedChapters).toEqual([
			expect.objectContaining({ id: "ch-merged", narratorId: null, mergeCommitSha: "sha-merge" }),
		]);
	});

	it("loads full segment detail with parent-chain membership and edges", async () => {
		seedProject();
		seedChapter({ id: "ch-parent", startCommitSha: "sha-b" });
		seedChapter({ id: "ch-child", parentChapterId: "ch-parent", startCommitSha: "sha-side" });
		seedNarrator("n-parent", "ch-parent", "working");
		seedNarrator("n-child", "ch-child", "idle", '["error"]');
		db.insert(chapterEdges)
			.values({
				id: "edge-parent-child",
				projectId: "p1",
				sourceId: "ch-parent",
				targetId: "ch-child",
				type: "fork",
				createdAt: NOW,
			})
			.run();

		const res = await app.request("/p1/ruler/segment?from=sha-b&detail=full");

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			chapters: Array<{ id: string; narratorId: string | null; narratorStatus: string | null }>;
			edges: Array<{ id: string; sourceId: string; targetId: string; type: string }>;
		};
		expect(body.chapters.map((ch) => ch.id).sort()).toEqual(["ch-child", "ch-parent"]);
		expect(body.chapters.find((ch) => ch.id === "ch-parent")).toMatchObject({
			narratorId: "n-parent",
			narratorStatus: "working",
		});
		expect(body.chapters.find((ch) => ch.id === "ch-child")).toMatchObject({
			narratorId: "n-child",
			narratorStatus: "error",
		});
		expect(body.edges).toEqual([
			{ id: "edge-parent-child", sourceId: "ch-parent", targetId: "ch-child", type: "fork" },
		]);
	});

	it("saves ruler positions", async () => {
		seedProject();
		seedChapter({ id: "ch-position", startCommitSha: "sha-b" });

		const res = await app.request("/p1/ruler/positions", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				positions: [
					{
						chapterId: "ch-position",
						anchorCommitSha: "sha-c",
						axisOffset: 3,
						crossOffset: 2,
						width: 320,
						height: 240,
					},
				],
			}),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true });
		const chapter = await db.query.chapters.findFirst({
			where: (ch, { eq }) => eq(ch.id, "ch-position"),
		});
		expect(chapter).toMatchObject({
			anchorCommitSha: "sha-c",
			axisOffset: 3,
			crossOffset: 2,
			panelWidth: 320,
			panelHeight: 240,
		});
	});
});
