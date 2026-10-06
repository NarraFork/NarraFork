/**
 * What `GET /api/projects`, `GET /api/chapters` and `GET /api/projects/:id/graph` promise their
 * existing clients.
 *
 * These three endpoints are consumed as BARE JSON ARRAYS (and, for the graph, a fixed object)
 * by the dashboard, the project page, the merge modal and the scheduled-task editor. None of
 * them sends a paging parameter, so every property asserted here is something a client already
 * depends on and would lose without any error being raised:
 *
 *  - the project list is most-recently-updated FIRST, and complete;
 *  - the chapter list requires project read, and `[]` versus 404 is a real distinction —
 *    an unreadable project and an empty project produce the same empty array otherwise;
 *  - a bounded read announces itself (`X-Read-Truncated` / a graph fallback) instead of looking
 *    like the whole set;
 *  - the response SHAPE stays an array — no pagination envelope, because wrapping it would
 *    break every caller to serve a case none of them have.
 *
 * The adapter is INJECTED here rather than exercised against a database: these are statements
 * about the routes' translation layer (order preserved, headers set, gate applied, fallback
 * emitted), and the adapters' own behaviour against real rows is covered by the SQLite matrix
 * and the PostgreSQL parity suite. A recording stub also makes it possible to assert what the
 * route ASKED for, which is where the "default page of 100" regression actually lived.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-read-route-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { projectRoutes } = await import("../../../routes/projects");
const { chapterRoutes } = await import("../../../routes/chapters");
const { graphRoutes } = await import("../../../routes/graph");
const { setProjectReadAdapter } = await import("..");
const { AppError } = await import("../../../lib/errors");
const { db } = await import("../../../db");
const { aclGrants, chapters, projects, users } = await import("../../../db/schema");
const { generateId } = await import("../../../lib/id");
const { READ_LIMITS } = await import("../project-read-adapter");
const { COLLECT_MAX_ROWS } = await import("../read-collect");

import type { ProjectPrincipal } from "../../project-acl";
import type { ProjectReadAdapter, ReadPage } from "../project-read-adapter";

const OWNER = "read-route-owner";
const READER = "read-route-reader";
const OUTSIDER = "read-route-outsider";

let privateProject: string;

/** One recorded adapter call, so a test can assert what the route asked for. */
type Call = { method: string; page?: ReadPage; status?: string; projectId?: string };

/**
 * An adapter that answers from a fixed row set and records every call.
 *
 * `listProjects`/`listChaptersPage` implement real keyset paging over that set, because the
 * routes' full-walk behaviour is exactly what is under test: a stub that ignored the cursor
 * would make `collectAllPages` look correct no matter what it did.
 */
function stubAdapter(options: {
	projects?: Array<Record<string, unknown>>;
	chapters?: Array<Record<string, unknown>>;
	graph?: Record<string, unknown>;
	auxiliary?: Record<string, unknown>;
	pageSize?: number;
}) {
	const calls: Call[] = [];
	const projectRows = options.projects ?? [];
	const chapterRows = options.chapters ?? [];
	const pageSize = options.pageSize ?? READ_LIMITS.projectPage;

	const page = <T extends { id: string }>(
		rows: T[],
		sortKey: string,
		cursorField: string,
		requested: ReadPage | undefined,
	) => {
		const limit = Math.min(Math.max(requested?.limit ?? pageSize, 1), pageSize);
		let start = 0;
		if (requested?.cursor) {
			const decoded = JSON.parse(Buffer.from(requested.cursor, "base64url").toString("utf8")) as
				| Record<string, string>
				| undefined;
			const afterId = decoded?.id;
			// Field name is part of the cursor, so a cursor minted for a differently ordered list
			// does not silently resume in the wrong place.
			expect(decoded?.[cursorField]).toBeString();
			start = rows.findIndex((row) => row.id === afterId) + 1;
		}
		const slice = rows.slice(start, start + limit);
		const last = slice.at(-1) as (T & Record<string, string>) | undefined;
		const more = start + limit < rows.length;
		return {
			rows: slice,
			nextCursor:
				more && last
					? Buffer.from(JSON.stringify({ [cursorField]: last[sortKey], id: last.id })).toString(
							"base64url",
						)
					: null,
		};
	};

	const adapter: ProjectReadAdapter = {
		async listProjects(_principal: ProjectPrincipal, requested?: ReadPage, status?: string) {
			calls.push({ method: "listProjects", page: requested, status });
			const filtered = status ? projectRows.filter((row) => row.status === status) : projectRows;
			return page(filtered as Array<{ id: string }>, "updatedAt", "updatedAt", requested);
		},
		async getProject(id: string) {
			calls.push({ method: "getProject", projectId: id });
			return projectRows.find((row) => row.id === id) ?? null;
		},
		async anyProjectExists() {
			calls.push({ method: "anyProjectExists" });
			return projectRows.length > 0;
		},
		async listChapters(projectId: string) {
			calls.push({ method: "listChapters", projectId });
			return chapterRows;
		},
		async listChaptersPage(projectId: string, _principal, requested?: ReadPage, status?: string) {
			calls.push({ method: "listChaptersPage", projectId, page: requested, status });
			const filtered = status ? chapterRows.filter((row) => row.status === status) : chapterRows;
			return page(filtered as Array<{ id: string }>, "createdAt", "createdAt", requested);
		},
		async getChapter(id: string) {
			calls.push({ method: "getChapter", projectId: id });
			return chapterRows.find((row) => row.id === id) ?? null;
		},
		async getGraph(projectId: string) {
			calls.push({ method: "getGraph", projectId });
			return options.graph ?? { chapters: [], edges: [] };
		},
		async getGraphAuxiliaryData(projectId: string) {
			calls.push({ method: "getGraphAuxiliaryData", projectId });
			return (options.auxiliary ?? {
				narrators: [],
				containers: [],
				detachedPanels: [],
			}) as never;
		},
	};
	setProjectReadAdapter(adapter);
	return calls;
}

function appAs(userId: string, role: "admin" | "user" = "user") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	app.route("/projects", projectRoutes);
	app.route("/projects", graphRoutes);
	app.route("/chapters", chapterRoutes);
	return app;
}

function request(userId: string, path: string, role: "admin" | "user" = "user") {
	return appAs(userId, role).request(`http://localhost${path}`);
}

function projectRow(id: string, updatedAt: string, status = "active") {
	return { id, name: id, status, visibility: "private", ownerUserId: OWNER, updatedAt };
}

function chapterRow(id: string, createdAt: string, status = "active") {
	return { id, projectId: privateProject, title: id, status, createdAt };
}

beforeAll(async () => {
	const now = new Date().toISOString();
	for (const id of [OWNER, READER, OUTSIDER]) {
		await db
			.insert(users)
			.values({
				id,
				username: `${id}-${Date.now()}`,
				passwordHash: "x",
				role: "user",
				createdAt: now,
			})
			.onConflictDoNothing();
	}
	privateProject = generateId();
	// A real row, because the chapter route's gate loads the project from the database rather
	// than through the adapter — the gate is authorization, not a read projection.
	await db.insert(projects).values({
		id: privateProject,
		name: "read route project",
		gitPath: join(testHome, "repo"),
		ownerUserId: OWNER,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: privateProject,
		principalType: "user",
		principalId: READER,
		capability: "read",
		createdAt: now,
	});
});

afterEach(() => {
	// Back to the real adapter, so a stub cannot leak into another suite.
	setProjectReadAdapter(undefined);
});

afterAll(async () => {
	setProjectReadAdapter(undefined);
	await db.delete(chapters).where(eqProject(privateProject));
	await db.delete(aclGrants).where(scopedTo(privateProject));
	await db.delete(projects).where(byId(privateProject));
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

// Tiny helpers so the cleanup above reads as intent rather than drizzle plumbing.
function byId(id: string) {
	const { eq } = require("drizzle-orm") as typeof import("drizzle-orm");
	return eq(projects.id, id);
}
function eqProject(id: string) {
	const { eq } = require("drizzle-orm") as typeof import("drizzle-orm");
	return eq(chapters.projectId, id);
}
function scopedTo(id: string) {
	const { eq } = require("drizzle-orm") as typeof import("drizzle-orm");
	return eq(aclGrants.scopeId, id);
}

describe("GET /projects ordering and completeness", () => {
	test("serves most-recently-updated first, as it always has", async () => {
		// The dashboard reads the head of this list as "what I worked on last". Ascending order
		// silently inverted that; nothing errored, the list was simply wrong.
		stubAdapter({
			projects: [
				projectRow("p_new", "2026-03-01T00:00:00.000Z"),
				projectRow("p_mid", "2026-02-01T00:00:00.000Z"),
				projectRow("p_old", "2026-01-01T00:00:00.000Z"),
			],
		});
		const res = await request(OWNER, "/projects");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ id: string }>;
		expect(body.map((row) => row.id)).toEqual(["p_new", "p_mid", "p_old"]);
	});

	test("returns a bare array, not a pagination envelope", async () => {
		stubAdapter({ projects: [projectRow("p_1", "2026-01-01T00:00:00.000Z")] });
		const body = await (await request(OWNER, "/projects")).json();
		expect(Array.isArray(body)).toBe(true);
	});

	test("a request with no paging parameters asks for no limit and walks every page", async () => {
		// The regression: the route sent `limit: 100`, so a user with more projects than that
		// received their first hundred and no indication the rest existed.
		const rows = Array.from({ length: 250 }, (_, index) =>
			projectRow(`p_${String(index).padStart(3, "0")}`, "2026-01-01T00:00:00.000Z"),
		);
		const calls = stubAdapter({ projects: rows, pageSize: 100 });
		const res = await request(OWNER, "/projects");
		const body = (await res.json()) as Array<{ id: string }>;
		// All 250 rows, assembled from bounded pages.
		expect(body).toHaveLength(250);
		expect(body[0]?.id).toBe("p_000");
		expect(body.at(-1)?.id).toBe("p_249");
		// The route named no limit; the adapter chose its own maximum.
		expect(calls[0]?.page?.limit).toBeUndefined();
		expect(calls.filter((call) => call.method === "listProjects").length).toBe(3);
		// A complete answer carries no truncation signal.
		expect(res.headers.get("X-Read-Truncated")).toBeNull();
		expect(res.headers.get("X-Next-Cursor")).toBeNull();
	});

	test("honours an explicit ?limit and reports the continuation", async () => {
		const rows = Array.from({ length: 30 }, (_, index) =>
			projectRow(`p_${String(index).padStart(2, "0")}`, "2026-01-01T00:00:00.000Z"),
		);
		const calls = stubAdapter({ projects: rows });
		const res = await request(OWNER, "/projects?limit=10");
		const body = (await res.json()) as Array<{ id: string }>;
		expect(body).toHaveLength(10);
		expect(calls[0]?.page?.limit).toBe(10);
		// One page was asked for and more remain: say so, and hand back a usable cursor.
		expect(res.headers.get("X-Read-Truncated")).toBe("1");
		const cursor = res.headers.get("X-Next-Cursor");
		expect(cursor).toBeString();

		const next = await request(
			OWNER,
			`/projects?limit=10&cursor=${encodeURIComponent(cursor ?? "")}`,
		);
		const nextBody = (await next.json()) as Array<{ id: string }>;
		// The continuation resumes where the first page stopped — no repeat, no gap.
		expect(nextBody.map((row) => row.id)).toEqual(
			rows.slice(10, 20).map((row) => row.id as string),
		);
	});

	test("a walk that hits the response ceiling is reported, never silently cut", async () => {
		const rows = Array.from({ length: COLLECT_MAX_ROWS + 25 }, (_, index) =>
			projectRow(`p_${String(index).padStart(5, "0")}`, "2026-01-01T00:00:00.000Z"),
		);
		stubAdapter({ projects: rows, pageSize: 200 });
		const res = await request(OWNER, "/projects");
		const body = (await res.json()) as unknown[];
		expect(body).toHaveLength(COLLECT_MAX_ROWS);
		// The whole point: a bounded response must not look like a complete set.
		expect(res.headers.get("X-Read-Truncated")).toBe("1");
		expect(res.headers.get("X-Next-Cursor")).toBeString();
	});

	test("passes a valid status filter through and ignores an unknown one", async () => {
		const calls = stubAdapter({
			projects: [
				projectRow("p_active", "2026-02-01T00:00:00.000Z", "active"),
				projectRow("p_archived", "2026-01-01T00:00:00.000Z", "archived"),
			],
		});
		const archived = (await (await request(OWNER, "/projects?status=archived")).json()) as Array<{
			id: string;
		}>;
		expect(archived.map((row) => row.id)).toEqual(["p_archived"]);
		expect(calls.at(-1)?.status).toBe("archived");

		// An unrecognized status must not become a filter that answers a different question.
		await request(OWNER, "/projects?status=frozen");
		expect(calls.at(-1)?.status).toBeUndefined();
	});
});

describe("GET /projects/hidden-existence uses the serving backend", () => {
	test("asks the adapter for both halves rather than querying SQLite directly", async () => {
		// Asking SQLite while PostgreSQL serves reads would answer "no projects exist" with full
		// confidence, and this endpoint exists precisely to disambiguate an empty list.
		const calls = stubAdapter({ projects: [] });
		const res = await request(OUTSIDER, "/projects/hidden-existence");
		expect(await res.json()).toEqual({ hasHidden: false });
		expect(calls.map((call) => call.method)).toEqual(["listProjects", "anyProjectExists"]);
		// A bounded probe: one row, never the whole list.
		expect(calls[0]?.page?.limit).toBe(1);
	});

	test("reports hidden projects when the caller sees none but some exist", async () => {
		const adapterCalls = stubAdapter({ projects: [] });
		// `listProjects` returns nothing for this principal, `anyProjectExists` says otherwise.
		setProjectReadAdapter({
			async listProjects() {
				adapterCalls.push({ method: "listProjects" });
				return { rows: [], nextCursor: null };
			},
			async getProject() {
				return null;
			},
			async anyProjectExists() {
				return true;
			},
			async listChapters() {
				return [];
			},
			async listChaptersPage() {
				return { rows: [], nextCursor: null };
			},
			async getChapter() {
				return null;
			},
			async getGraph() {
				return { chapters: [], edges: [] };
			},
			async getGraphAuxiliaryData() {
				return { narrators: [], containers: [], detachedPanels: [] };
			},
		});
		expect(await (await request(OUTSIDER, "/projects/hidden-existence")).json()).toEqual({
			hasHidden: true,
		});
	});

	test("nothing is hidden from an admin, without touching the adapter", async () => {
		const calls = stubAdapter({ projects: [projectRow("p_1", "2026-01-01T00:00:00.000Z")] });
		expect(
			await (await request("read-route-admin", "/projects/hidden-existence", "admin")).json(),
		).toEqual({ hasHidden: false });
		expect(calls).toEqual([]);
	});
});

describe("GET /chapters keeps its project gate", () => {
	test("an outsider gets 404, not an empty array", async () => {
		// This is a change of ANSWER, not of status code: the adapter's ACL predicate makes an
		// unreadable project return `[]`, which is exactly what a readable empty project returns.
		// Without the gate the endpoint stops distinguishing "not yours" from "nothing here".
		stubAdapter({ chapters: [chapterRow("c_1", "2026-01-01T00:00:00.000Z")] });
		const res = await request(OUTSIDER, `/chapters?projectId=${privateProject}`);
		expect(res.status).toBe(404);
	});

	test("a read-grant holder gets the chapters", async () => {
		stubAdapter({
			chapters: [
				chapterRow("c_1", "2026-01-01T00:00:00.000Z"),
				chapterRow("c_2", "2026-01-02T00:00:00.000Z"),
			],
		});
		const res = await request(READER, `/chapters?projectId=${privateProject}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ id: string }>;
		// Oldest first: a chapter's parents come before it, which is how the graph reads them.
		expect(body.map((row) => row.id)).toEqual(["c_1", "c_2"]);
	});

	test("a missing projectId is a 400, before any read happens", async () => {
		const calls = stubAdapter({});
		expect((await request(READER, "/chapters")).status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("returns every chapter by default and reports a truncated page", async () => {
		const rows = Array.from({ length: 250 }, (_, index) =>
			chapterRow(`c_${String(index).padStart(3, "0")}`, "2026-01-01T00:00:00.000Z"),
		);
		const calls = stubAdapter({ chapters: rows, pageSize: 100 });
		const res = await request(READER, `/chapters?projectId=${privateProject}`);
		const body = (await res.json()) as unknown[];
		// The merge modal builds its target list from this array: a chapter missing from it looks
		// like a chapter that cannot be merged into.
		expect(body).toHaveLength(250);
		expect(calls.filter((call) => call.method === "listChaptersPage").length).toBe(3);
		expect(res.headers.get("X-Read-Truncated")).toBeNull();

		const paged = await request(READER, `/chapters?projectId=${privateProject}&limit=50`);
		expect((await paged.json()) as unknown[]).toHaveLength(50);
		expect(paged.headers.get("X-Read-Truncated")).toBe("1");
		expect(paged.headers.get("X-Next-Cursor")).toBeString();
	});

	test("the status filter reaches the adapter", async () => {
		const calls = stubAdapter({
			chapters: [
				chapterRow("c_active", "2026-01-01T00:00:00.000Z", "active"),
				chapterRow("c_dormant", "2026-01-02T00:00:00.000Z", "dormant"),
			],
		});
		const body = (await (
			await request(READER, `/chapters?projectId=${privateProject}&status=dormant`)
		).json()) as Array<{ id: string }>;
		expect(body.map((row) => row.id)).toEqual(["c_dormant"]);
		expect(calls.at(-1)?.status).toBe("dormant");
	});
});

describe("GET /projects/:id/graph admits a bounded read", () => {
	const graphChapter = (id: string) => ({
		id,
		title: id,
		status: "dormant",
		branch: `b/${id}`,
		role: "branch",
		color: null,
		groupLabel: null,
		explorationGroupId: null,
		isRoot: 0,
		graphX: null,
		graphY: null,
		commitCount: 0,
		headCommitSha: null,
		// No worktree path: keeps the route off the git-refresh path, which is not what this
		// suite is about (see `routes/__tests__/graph-degraded.test.ts` for that).
		worktreePath: null,
		panelExpanded: 0,
		panelWidth: null,
		panelHeight: null,
		reviewSourceChapterId: null,
		reviewStatus: null,
	});

	test("a complete graph reports no degradation", async () => {
		stubAdapter({
			graph: { chapters: [graphChapter("c_1")], edges: [] },
			auxiliary: { narrators: [], containers: [], detachedPanels: [] },
		});
		const res = await request(OWNER, `/projects/${privateProject}/graph`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			nodes: unknown[];
			degraded: boolean;
			fallbacks: unknown[];
		};
		expect(body.nodes).toHaveLength(1);
		expect(body.degraded).toBe(false);
		expect(body.fallbacks).toEqual([]);
	});

	test("a truncated chapter list surfaces as a graph.size fallback", async () => {
		// A canvas that quietly drops chapters also drops every edge attached to them, which reads
		// as "those branches were deleted" rather than "we did not send them".
		stubAdapter({
			graph: {
				chapters: [graphChapter("c_1"), graphChapter("c_2")],
				edges: [],
				truncated: true,
				truncatedChapters: true,
			},
			auxiliary: { narrators: [], containers: [], detachedPanels: [] },
		});
		const body = (await (await request(OWNER, `/projects/${privateProject}/graph`)).json()) as {
			degraded: boolean;
			fallbacks: Array<{ feature: string; reason?: string; failedChapters?: number }>;
		};
		expect(body.degraded).toBe(true);
		expect(body.fallbacks).toContainEqual({
			feature: "graph.size",
			reason: "graph_chapters_truncated",
			failedChapters: 2,
		});
	});

	test("a truncated edge list is reported with its own reason", async () => {
		stubAdapter({
			graph: {
				chapters: [graphChapter("c_1")],
				edges: [],
				truncated: true,
				truncatedEdges: true,
			},
			auxiliary: { narrators: [], containers: [], detachedPanels: [] },
		});
		const body = (await (await request(OWNER, `/projects/${privateProject}/graph`)).json()) as {
			fallbacks: Array<{ reason?: string }>;
		};
		expect(body.fallbacks.map((fallback) => fallback.reason)).toContain("graph_edges_truncated");
	});

	test("truncated auxiliary data is reported separately from graph size", async () => {
		// Narrator badges become a floor rather than a count; the canvas must be able to say so.
		stubAdapter({
			graph: { chapters: [graphChapter("c_1")], edges: [] },
			auxiliary: {
				narrators: [],
				containers: [],
				detachedPanels: [],
				truncated: true,
			},
		});
		const body = (await (await request(OWNER, `/projects/${privateProject}/graph`)).json()) as {
			degraded: boolean;
			fallbacks: Array<{ feature: string; reason?: string }>;
		};
		expect(body.degraded).toBe(true);
		expect(body.fallbacks.map((fallback) => fallback.feature)).toContain("graph.auxiliary");
	});

	test("an empty graph is served without fallbacks and without auxiliary reads", async () => {
		const calls = stubAdapter({ graph: { chapters: [], edges: [] } });
		const body = (await (await request(OWNER, `/projects/${privateProject}/graph`)).json()) as {
			nodes: unknown[];
			degraded: boolean;
		};
		expect(body.nodes).toEqual([]);
		expect(body.degraded).toBe(false);
		expect(calls.map((call) => call.method)).not.toContain("getGraphAuxiliaryData");
	});

	test("an outsider cannot read the graph at all", async () => {
		stubAdapter({ graph: { chapters: [graphChapter("c_1")], edges: [] } });
		expect((await request(OUTSIDER, `/projects/${privateProject}/graph`)).status).toBe(404);
	});
});
