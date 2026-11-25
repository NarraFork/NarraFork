/**
 * Wire shape of the read routes now that they go through the read adapter.
 *
 * `GET /api/projects` moved from a plain `findMany` to a cursor-paginated adapter call, and
 * the contract it has to keep is peculiar: the body must stay a bare JSON ARRAY (the shared
 * fetch helper discards headers, and the frontend indexes the response directly), with the
 * continuation exposed ONLY through the `X-Next-Cursor` header. A well-meaning change to
 * `{ items, nextCursor }` breaks every caller, and dropping the header silently caps every
 * client at one page — neither shows up in an adapter-level test.
 *
 * Also covered here: project 404s (denial and absence must be indistinguishable, so an id
 * cannot be probed).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { aclGrants, projects, users } from "../../../server/db/schema";
import {
	closeRuntimeTestDb,
	getRuntimeTestDb,
} from "../../../server/services/__tests__/agent-runtime-test-database";
import { cleanDb } from "../../setup";

// File-backed WAL fixture: the project reads run on a read Worker, which cannot open
// an in-memory database.
const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
const realDbModule = { ...(await import("../../../server/db")) };
mock.module("../../../server/db", () => ({ db, sqlite }));

const { projectRoutes } = await import("../../../server/routes/projects");
const { buildAppErrorResponse } = await import("../../../server/lib/app-error-response");

const NOW = "2026-05-01T00:00:00.000Z";
const OWNER = "u_route_owner";
const OUTSIDER = "u_route_outsider";

/** Current principal, switched per test rather than re-mounting the app. */
let actingUser = { sub: OWNER, role: "user" as "user" | "admin" };

const app = new Hono();
app.use("*", async (c, next) => {
	const user = { ...actingUser, iat: 0, exp: Number.MAX_SAFE_INTEGER };
	c.set("user", user);
	c.set("auth", { type: "session", user });
	await next();
});
app.route("/projects", projectRoutes);
// The real app serializes AppError subclasses centrally; without this a NotFoundError
// surfaces as a 500 and the 404 assertions would pass for the wrong reason.
app.onError((err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: String(err) }, 500));

beforeEach(() => {
	actingUser = { sub: OWNER, role: "user" };
	for (const id of [OWNER, OUTSIDER]) {
		db.insert(users)
			.values({ id, username: id, passwordHash: "x", role: "user", createdAt: NOW })
			.run();
	}
});

afterEach(() => cleanDb(sqlite));

afterAll(async () => {
	mock.module("../../../server/db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
	await closeRuntimeTestDb(sqlite);
});

function seedProject(id: string, updatedAt: string, visibility: "public" | "private" = "private") {
	db.insert(projects)
		.values({
			id,
			name: `Project ${id}`,
			visibility,
			ownerUserId: OWNER,
			createdAt: NOW,
			updatedAt,
			gitPath: null,
		})
		.run();
}

describe("GET /api/projects response shape", () => {
	it("returns a bare array and advertises the cursor only in a header", async () => {
		// Three projects sharing updatedAt, so the cursor's id tiebreak is what pages.
		seedProject("rp_a", NOW);
		seedProject("rp_b", NOW);
		seedProject("rp_c", NOW);

		const first = await app.request("/projects?limit=2");
		expect(first.status).toBe(200);
		const firstBody = await first.json();
		// A bare array, not `{ items: [...] }` — the frontend indexes this directly.
		expect(Array.isArray(firstBody)).toBe(true);
		expect((firstBody as Array<{ id: string }>).map((row) => row.id)).toEqual(["rp_a", "rp_b"]);
		const cursor = first.headers.get("X-Next-Cursor");
		expect(cursor).toBeTruthy();

		const second = await app.request(
			`/projects?limit=2&cursor=${encodeURIComponent(cursor ?? "")}`,
		);
		const secondBody = (await second.json()) as Array<{ id: string }>;
		expect(secondBody.map((row) => row.id)).toEqual(["rp_c"]);
		// Last page: no continuation, so a client knows to stop.
		expect(second.headers.get("X-Next-Cursor")).toBeNull();
	});

	it("omits the cursor header when a single page holds everything", async () => {
		seedProject("rp_only", NOW);
		const res = await app.request("/projects");
		expect(((await res.json()) as unknown[]).length).toBe(1);
		expect(res.headers.get("X-Next-Cursor")).toBeNull();
	});

	it("filters by status and hides another user's private project", async () => {
		seedProject("rp_active", NOW);
		db.insert(projects)
			.values({
				id: "rp_archived",
				name: "Archived",
				status: "archived",
				visibility: "private",
				ownerUserId: OWNER,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();

		const archived = (await (await app.request("/projects?status=archived")).json()) as Array<{
			id: string;
		}>;
		expect(archived.map((row) => row.id)).toEqual(["rp_archived"]);

		// The same two rows exist for the outsider, who owns neither.
		actingUser = { sub: OUTSIDER, role: "user" };
		expect(await (await app.request("/projects")).json()).toEqual([]);
	});

	it("opens a private project to a direct read grant", async () => {
		seedProject("rp_granted", NOW);
		db.insert(aclGrants)
			.values({
				id: "rg_read",
				scopeType: "project",
				scopeId: "rp_granted",
				principalType: "user",
				principalId: OUTSIDER,
				capability: "read",
				createdAt: NOW,
			})
			.run();

		actingUser = { sub: OUTSIDER, role: "user" };
		const body = (await (await app.request("/projects")).json()) as Array<{ id: string }>;
		expect(body.map((row) => row.id)).toEqual(["rp_granted"]);
	});
});

describe("GET /api/projects/:id", () => {
	it("returns the project for its owner and 404s for an outsider", async () => {
		seedProject("rp_detail", NOW);
		const ok = await app.request("/projects/rp_detail");
		expect(ok.status).toBe(200);
		expect((await ok.json()).id).toBe("rp_detail");

		actingUser = { sub: OUTSIDER, role: "user" };
		const denied = await app.request("/projects/rp_detail");
		expect(denied.status).toBe(404);
		const missing = await app.request("/projects/rp_never_existed");
		expect(missing.status).toBe(404);
		// Denial and absence must be indistinguishable apart from the echoed id, so a caller
		// cannot tell "exists but not yours" from "does not exist".
		const shape = (body: {
			code: string;
			messageCode: string;
			messageParams: { entity: string };
		}) => ({
			code: body.code,
			messageCode: body.messageCode,
			entity: body.messageParams.entity,
		});
		expect(shape(await denied.json())).toEqual(shape(await missing.json()));
	});
});
