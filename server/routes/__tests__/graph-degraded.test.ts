/**
 * The graph endpoint must admit when the git metadata it served is stale.
 *
 * A failed `getHeadCommit`/`syncChapterCommits` leaves the response carrying the
 * cached commit count and HEAD, which look indistinguishable from fresh values. The
 * frontend already renders a degraded alert from `degraded`/`fallbacks`
 * (`summarizeGraphRuntimeState` → `NarraFlow`); before this, the route never set
 * either field, and the only trace was a debug log.
 *
 * `feature`/`reason` strings are asserted verbatim because
 * `frontend/hooks/useNarraFlow.test.ts` pins the message they format into.
 *
 * One case asserts a *negative*: git's stderr must not reach the response. It is
 * unbounded subprocess output shaped by the user's git version, locale and config,
 * and the UI renders whatever string it is handed. That is easy to reintroduce
 * ("just include the error, it helps debugging") and invisible from the client side.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { chapters, projects } from "../../db/schema";
import { generateId } from "../../lib/id";
import { commitSyncService } from "../../services/commit-sync-service";
import { gitService } from "../../services/git-service";
import { graphRoutes } from "../graph";

const app = new Hono().route("/projects", graphRoutes);

interface GraphResponse {
	nodes: Array<{ id: string; data: { commitCount: number; headCommitSha: string | null } }>;
	degraded?: boolean;
	fallbacks?: Array<Record<string, unknown>>;
}

const CACHED_HEAD = "cached0000000000000000000000000000000000";

let projectId: string;
let chapterIds: string[];
const restores: Array<() => void> = [];
/** Every project seeded during a test — re-seeding must not orphan the first fixture. */
const seededProjectIds: string[] = [];

/** Swap a service method for the duration of one test. */
function stub<T extends object, K extends keyof T>(target: T, key: K, value: T[K]) {
	const original = target[key];
	target[key] = value;
	restores.push(() => {
		target[key] = original;
	});
}

async function seed(chapterCount: number) {
	const now = new Date().toISOString();
	projectId = generateId();
	seededProjectIds.push(projectId);
	chapterIds = Array.from({ length: chapterCount }, () => generateId());
	await db.insert(projects).values({
		id: projectId,
		name: "Graph degraded",
		createdAt: now,
		updatedAt: now,
	});
	for (const [index, id] of chapterIds.entries()) {
		await db.insert(chapters).values({
			id,
			projectId,
			title: `Chapter ${index}`,
			branch: `chapter/degraded-${id.slice(0, 8)}`,
			baseBranch: "main",
			status: "active",
			// A worktree path is what puts a chapter on the git refresh path at all.
			worktreePath: `/tmp/narrafork-graph-degraded/${id}`,
			commitCount: 7,
			headCommitSha: CACHED_HEAD,
			createdAt: now,
			updatedAt: now,
		});
	}
}

async function getGraph(): Promise<GraphResponse> {
	const res = await app.request(`/projects/${projectId}/graph`);
	expect(res.status).toBe(200);
	return (await res.json()) as GraphResponse;
}

beforeEach(async () => {
	await seed(1);
});

afterEach(async () => {
	for (const restore of restores.splice(0)) restore();
	for (const id of seededProjectIds.splice(0)) {
		await db.delete(chapters).where(eq(chapters.projectId, id));
		await db.delete(projects).where(eq(projects.id, id));
	}
});

afterAll(async () => {
	for (const restore of restores.splice(0)) restore();
});

describe("GET /projects/:id/graph degradation reporting", () => {
	test("reports a commitSync fallback when reading HEAD fails", async () => {
		stub(gitService, "getHeadCommit", async () => {
			throw new Error("not a git repository");
		});

		const graph = await getGraph();

		expect(graph.degraded).toBe(true);
		expect(graph.fallbacks).toEqual([
			{
				feature: "graph.commitSync",
				reason: "commit_sync_refresh_failed",
				failedChapters: 1,
			},
		]);
	});

	test("does not put the git error text in the response", async () => {
		// Exactly the shape git produces when a worktree is gone: the message carries the
		// absolute path plus whatever else git chose to say. Asserted against the whole
		// serialized body rather than the `fallbacks` array, so reintroducing the detail
		// under any new field name fails.
		//
		// The assertion targets git's *prose*, not the path: `worktreePath` is a declared
		// field of every graph node already, so the path itself is not what this guards.
		// What must not appear is subprocess output we neither wrote nor bounded.
		const worktree = `/tmp/narrafork-graph-degraded/${chapterIds[0]}`;
		stub(gitService, "getHeadCommit", async () => {
			throw new Error(`fatal: cannot change to '${worktree}': No such file or directory`);
		});

		const res = await app.request(`/projects/${projectId}/graph`);
		const body = await res.text();
		const graph = JSON.parse(body) as GraphResponse;

		expect(graph.degraded).toBe(true);
		expect(graph.fallbacks?.[0]).toEqual({
			feature: "graph.commitSync",
			reason: "commit_sync_refresh_failed",
			failedChapters: 1,
		});
		expect(body).not.toContain("No such file or directory");
		expect(body).not.toContain("fatal:");
	});

	test("reports a fallback when commit sync itself fails after HEAD moved", async () => {
		stub(gitService, "getHeadCommit", async () => "live000000000000000000000000000000000000");
		stub(commitSyncService, "syncChapterCommits", async () => {
			throw new Error("git log failed");
		});

		const graph = await getGraph();

		expect(graph.degraded).toBe(true);
		expect(graph.fallbacks?.[0]).toMatchObject({
			feature: "graph.commitSync",
			reason: "commit_sync_refresh_failed",
			failedChapters: 1,
		});
	});

	test("still serves the cached graph while degraded", async () => {
		stub(gitService, "getHeadCommit", async () => {
			throw new Error("worktree missing");
		});

		const graph = await getGraph();

		// The point of the fallback is that the response is still usable — the client
		// shows the alert next to real (if stale) nodes, not an error page.
		expect(graph.nodes).toHaveLength(1);
		expect(graph.nodes[0]?.data.commitCount).toBe(7);
		expect(graph.nodes[0]?.data.headCommitSha).toBe(CACHED_HEAD);
	});

	test("aggregates a repo-wide failure into one entry carrying the scale", async () => {
		// One fallback per chapter would mean hundreds of identical entries on a large
		// project, for a UI that renders a single alert.
		await seed(5);
		stub(gitService, "getHeadCommit", async () => {
			throw new Error("not a git repository");
		});

		const graph = await getGraph();

		expect(graph.fallbacks).toHaveLength(1);
		expect(graph.fallbacks?.[0]).toMatchObject({
			feature: "graph.commitSync",
			failedChapters: 5,
		});
	});

	test("reports a healthy graph when the git refresh succeeds", async () => {
		// HEAD unchanged is the common case: no commit sync runs, nothing degrades.
		stub(gitService, "getHeadCommit", async () => CACHED_HEAD);

		const graph = await getGraph();

		expect(graph.degraded).toBe(false);
		expect(graph.fallbacks).toEqual([]);
	});

	test("reports a healthy graph when no chapter has a worktree", async () => {
		for (const id of chapterIds) {
			await db.update(chapters).set({ worktreePath: null }).where(eq(chapters.id, id));
		}

		const graph = await getGraph();

		expect(graph.degraded).toBe(false);
		expect(graph.fallbacks).toEqual([]);
	});
});
