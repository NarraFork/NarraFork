import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { chapterEdges, chapters, narrators, projects, users } from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../server/db")) };
const realGitServiceModule = { ...(await import("../../../server/services/git-service")) };

mock.module("../../../server/db", () => ({ db, sqlite }));

let mockCommits: Array<{ sha: string }> = [];
let mockTotalCommitCount = 0;
let getCommitCountCalls: string[] = [];
/** Args the route passed to `getLog`, so the paging offset is observable. */
let getLogCalls: Array<{ limit?: number; skip?: number; branch?: string }> = [];
/**
 * Cursor → log index, as `findCommitLogIndex` would answer it.
 *
 * Deliberately NOT derived from `getCommitCount`: conflating those two measurements is the
 * bug this mock's shape exists to keep out. A cursor missing from the map answers null,
 * which is the real "not in this walk" case.
 */
let mockLogIndexBySha: Map<string, number> = new Map();

mock.module("../../../server/services/git-service", () => ({
	gitService: {
		getCommitCount: async (_gitPath: string, ref: string) => {
			getCommitCountCalls.push(ref);
			return mockTotalCommitCount;
		},
		getLog: async (
			_gitPath: string,
			opts: { limit?: number; skip?: number; branch?: string } = {},
		) => {
			getLogCalls.push(opts);
			return mockCommits;
		},
		findCommitLogIndex: async (_gitPath: string, sha: string) => mockLogIndexBySha.get(sha) ?? null,
	},
}));

const { rulerRoutes } = await import("../../../server/routes/ruler");

/** The project owner these tests act as, so the write endpoints pass the project gate. */
const TEST_USER_ID = "ruler-test-owner";

const app = new Hono();
// The ruler routes are mounted behind the project gate, which reads the authenticated
// principal from context. In the real app that is set by requireAuth; here it is stubbed
// so these pagination tests exercise ruler logic rather than re-testing authentication.
app.use("*", async (c, next) => {
	c.set("user", { sub: TEST_USER_ID, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
	await next();
});
app.route("/", rulerRoutes);

const NOW = "2025-01-01T00:00:00.000Z";

beforeEach(() => {
	mockCommits = [{ sha: "sha-a" }, { sha: "sha-b" }, { sha: "sha-c" }];
	mockTotalCommitCount = mockCommits.length;
	getCommitCountCalls = [];
	getLogCalls = [];
	mockLogIndexBySha = new Map(mockCommits.map((c, i) => [c.sha, i]));
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
	// The owner row must exist before the project references it (FK).
	db.insert(users)
		.values({
			id: TEST_USER_ID,
			username: `ruler-owner-${TEST_USER_ID}`,
			passwordHash: "x",
			role: "user",
			createdAt: NOW,
		})
		.onConflictDoNothing()
		.run();
	db.insert(projects)
		.values({
			id: "p1",
			name: "Project",
			gitPath: "/repo",
			defaultBranch: "main",
			// Ruler routes sit behind the project gate. `public` alone is not enough: the
			// write endpoints (positions, rebase, merge) require project WRITE, and public
			// visibility deliberately grants only read — otherwise any signed-in user could
			// rewrite branches in any public project. So the suite authenticates as this
			// owner (see the middleware below). Authorization itself is covered by
			// project-acl-gate.test.ts; these tests are about ruler pagination.
			visibility: "public",
			ownerUserId: TEST_USER_ID,
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

	// ── Paging offsets ────────────────────────────────────────────────────────
	//
	// `git log` is newest-first: offset 0 is HEAD and grows towards OLDER history. The
	// response used to name these ends backwards (`oldestLoadedIndex` for `skip`), and the
	// client paged against those names — so the first page claimed there was nothing older
	// and "load older commits" never appeared. On a repository longer than one page every
	// chapter anchored past the window then lost its tick and was reported as being on
	// another branch.

	it("reports the first page's offsets as HEAD-ward, not oldest-ward", async () => {
		seedProject();

		const res = await app.request("/p1/ruler");
		const body = (await res.json()) as { firstOffset: number; lastOffset: number };

		// skip=0 fetched the NEWEST commits, so this page starts at offset 0 and its last
		// commit is deeper in history — never the reverse.
		expect(body.firstOffset).toBe(0);
		expect(body.lastOffset).toBe(2);
	});

	it("an empty page past HEAD reports lastOffset below firstOffset", async () => {
		// The degenerate end of the walk. `firstOffset - 1` is what makes the client's
		// "no cursor → no further paging" guard reachable rather than theoretical.
		seedProject();
		mockCommits = [];

		const res = await app.request("/p1/ruler?skip=500");
		const body = (await res.json()) as { firstOffset: number; lastOffset: number };

		expect(body.firstOffset).toBe(500);
		expect(body.lastOffset).toBe(499);
	});

	it("[REGRESSION] resolves a cursor by log position, not by reachability count", async () => {
		// `getCommitCount` is mocked to the TOTAL (3) here, which is precisely the value the
		// old implementation would have used as the cursor's index. The log index of "sha-b"
		// is 1, so a correct route pages from skip=2 and a regressed one from skip=4.
		seedProject();

		const res = await app.request("/p1/ruler?cursor=sha-b&direction=older");

		expect(res.status).toBe(200);
		expect(getLogCalls.at(-1)?.skip).toBe(2);
		const body = (await res.json()) as { firstOffset: number };
		expect(body.firstOffset).toBe(2);
	});

	it("pages towards newer history by stepping back a full page from the cursor", async () => {
		seedProject();

		await app.request("/p1/ruler?cursor=sha-c&direction=newer&limit=2");

		// Cursor "sha-c" is at index 2; one page of 2 back is offset 0, clamped at zero.
		expect(getLogCalls.at(-1)?.skip).toBe(0);
	});

	it("keeps the requested skip when the cursor is not in this walk", async () => {
		// Rewritten history, another ref, a deleted branch. Guessing an offset from a
		// position we do not have is how a page silently addresses the wrong commits.
		seedProject();

		await app.request("/p1/ruler?cursor=sha-unknown&direction=older&skip=7");

		expect(getLogCalls.at(-1)?.skip).toBe(7);
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
