import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { buildAppErrorResponse } from "../../lib/app-error-response";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { contextMemoryRoutes } = await import("../context-memory");
const { contextMemoryService } = await import("../../services/context-memory-service");
const actor = { userId: "memory-user", isAdmin: false, kind: "user" as const };
const scope = { kind: "user" as const };
const proposal = { scope, key: "tests", content: "只运行相关隔离测试。", expiresAt: null };

function appFor(userId: string | null = actor.userId, oauth = false) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		if (userId) {
			c.set("user", { sub: userId, role: "user", tokenVersion: 0, iat: 0, exp: 4_102_444_800 });
			if (oauth) c.set("oauth", { scopes: [] } as never);
		}
		await next();
	});
	app.onError(
		(error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: error.message }, 500),
	);
	app.route("/api/context-memory", contextMemoryRoutes);
	return app;
}
function request(app: Hono, path = "", method = "GET", body?: unknown) {
	return app.request(`/api/context-memory${path}`, {
		method,
		...(body === undefined
			? {}
			: { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	});
}

beforeEach(() => {
	cleanDb(sqlite);
	for (const id of [actor.userId, "other-user"])
		sqlite.run(
			"INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'hash', 'user', ?)",
			[id, id, new Date().toISOString()],
		);
});
afterAll(() => {
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

describe("context memory session API", () => {
	test("creates a candidate, confirms its version and removes it without retaining content", async () => {
		const app = appFor();
		const created = await request(app, "", "POST", proposal);
		expect(created.status).toBe(201);
		const memory = await created.json();
		expect(memory).toMatchObject({ status: "candidate", ownerUserId: actor.userId, version: 1 });
		expect(await contextMemoryService.recall(scope, actor)).toEqual([]);
		const confirmed = await request(app, `/${memory.id}/decision`, "POST", {
			action: "confirm",
			expectedVersion: 1,
		});
		expect(confirmed.status).toBe(200);
		expect((await confirmed.json()).status).toBe("confirmed");
		expect((await request(app, `/${memory.id}`)).status).toBe(200);
		expect(
			(await (await request(app, `/${memory.id}/events`)).json()).map(
				(e: { action: string }) => e.action,
			),
		).toEqual(["confirm", "propose"]);
		const stale = await request(app, `/${memory.id}`, "PATCH", {
			expectedVersion: 1,
			content: "stale",
			expiresAt: null,
		});
		expect(stale.status).toBe(409);
		expect((await request(app, `/${memory.id}`, "DELETE", { expectedVersion: 2 })).status).toBe(
			200,
		);
		expect((await request(app, `/${memory.id}`)).status).toBe(404);
		expect(sqlite.query("SELECT COUNT(*) AS total FROM context_memory_events").get()).toEqual({
			total: 0,
		});
	});

	test("requires a first-party principal and never accepts authority from JSON", async () => {
		for (const app of [appFor(null), appFor(actor.userId, true)]) {
			expect((await request(app, "", "POST", proposal)).status).toBe(403);
			expect((await request(app, "?scope=user")).status).toBe(403);
		}
		for (const fields of [
			{ ownerUserId: "other-user" },
			{ status: "confirmed" },
			{ actor: { kind: "user" } },
		]) {
			expect((await request(appFor(), "", "POST", { ...proposal, ...fields })).status).toBe(400);
		}
		expect(await contextMemoryService.recall(scope, actor)).toEqual([]);
	});

	test("isolates details, decisions, audit and deletion between users", async () => {
		const memory = await contextMemoryService.propose(proposal, actor);
		const other = appFor("other-user");
		for (const path of [`/${memory.id}`, `/${memory.id}/events`]) {
			expect((await request(other, path)).status).toBe(404);
		}
		expect(
			(
				await request(other, `/${memory.id}/decision`, "POST", {
					action: "confirm",
					expectedVersion: 1,
				})
			).status,
		).toBe(404);
		expect((await request(other, `/${memory.id}`, "DELETE", { expectedVersion: 1 })).status).toBe(
			404,
		);
		expect((await (await request(other, "?scope=user")).json()).items).toEqual([]);
	});

	test("paginates small summaries and rejects malformed or oversized requests", async () => {
		const app = appFor();
		for (const key of ["a", "b", "c"]) {
			await contextMemoryService.propose({ ...proposal, key, content: "文".repeat(1000) }, actor);
		}
		const first = await (await request(app, "?scope=user&limit=2")).json();
		expect(first.items).toHaveLength(2);
		for (const item of first.items) {
			expect(item.content).toBeUndefined();
			expect(item.excerpt.length).toBeLessThanOrEqual(160);
		}
		const last = await (
			await request(app, `?scope=user&limit=2&cursor=${first.nextCursor}`)
		).json();
		expect(last.items).toHaveLength(1);
		expect(last.nextCursor).toBeNull();
		expect((await request(app, "?scope=project")).status).toBe(400);
		expect((await request(app, "?scope=user&limit=51")).status).toBe(400);
		expect((await app.request("/api/context-memory", { method: "POST", body: "{" })).status).toBe(
			400,
		);
		expect(
			(await request(app, "", "POST", { ...proposal, content: "x".repeat(32769) })).status,
		).toBe(413);
	});
});

test("PostgreSQL memory management fails explicitly before legacy database access", async () => {
	mock.module("../../db", () => ({
		...realDbModule,
		db,
		sqlite,
		activeDatabaseBackend: "postgres",
	}));
	try {
		for (const [path, method, body] of [
			["?scope=user", "GET", undefined],
			["/id", "GET", undefined],
			["", "POST", proposal],
			["/id", "DELETE", { expectedVersion: 1 }],
		] as const) {
			const response = await request(appFor(), path, method, body);
			expect(response.status).toBe(503);
			expect((await response.json()).code).toBe("POSTGRES_UNSUPPORTED");
		}
	} finally {
		mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
	}
});
