import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { cleanDb } from "../../../tests/setup";
import { users } from "../../db/schema";
import { DbReadError } from "../../lib/db-worker/errors";
import * as pool from "../../lib/db-worker/pool";
import {
	closeRuntimeTestDb,
	getRuntimeTestDb,
} from "../../services/__tests__/agent-runtime-test-database";

const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { favoriteRoutes } = await import("../favorites");
const { buildAppErrorResponse } = await import("../../lib/app-error-response");

const NOW = "2026-11-24T00:00:00.000Z";

function appFor(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: 2 ** 31 });
		await next();
	});
	app.route("/", favoriteRoutes);
	app.onError((err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: String(err) }, 500));
	return app;
}

function send(userId: string, method: string, path: string, body?: unknown) {
	return appFor(userId).request(path, {
		method,
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

beforeEach(() => {
	cleanDb(sqlite);
	for (const id of ["alice", "bob"])
		db.insert(users)
			.values({ id, username: id, passwordHash: "x", role: "user", createdAt: NOW })
			.run();
});
afterEach(() => mock.restore());
afterAll(async () => {
	await closeRuntimeTestDb(sqlite);
	mock.module("../../db", () => realDbModule);
});

describe("favorite directories", () => {
	test("adds in order, rejects a duplicate path and lists through the Worker", async () => {
		expect((await send("alice", "POST", "/", { path: "/a" })).status).toBe(201);
		expect((await send("alice", "POST", "/", { path: "/b", label: "B" })).status).toBe(201);
		const duplicate = await send("alice", "POST", "/", { path: "/a" });
		expect(duplicate.status).toBe(400);
		const dispatch = spyOn(pool, "runReadTask");
		const list = (await (await send("alice", "GET", "/")).json()) as Array<{
			path: string;
			sortOrder: number;
		}>;
		expect(dispatch).toHaveBeenCalled();
		expect(list.map((row) => [row.path, row.sortOrder])).toEqual([
			["/a", 0],
			["/b", 1],
		]);
	});

	test("another user's favorite can be neither renamed nor deleted", async () => {
		const created = (await (await send("alice", "POST", "/", { path: "/a" })).json()) as {
			id: string;
		};
		expect((await send("bob", "PATCH", `/${created.id}`, { label: "x" })).status).toBe(404);
		expect((await send("bob", "DELETE", `/${created.id}`)).status).toBe(404);
		expect(sqlite.query("SELECT label FROM user_favorite_directories").get()).toEqual({
			label: null,
		});
		expect((await send("alice", "PATCH", `/${created.id}`, { label: "mine" })).status).toBe(200);
		expect((await send("alice", "DELETE", `/${created.id}`)).status).toBe(200);
		expect(sqlite.query("SELECT count(*) AS total FROM user_favorite_directories").get()).toEqual({
			total: 0,
		});
	});

	test("an unavailable Worker fails the listing without reading on the main connection", async () => {
		const error = new DbReadError("DB_READ_UNAVAILABLE", "injected favorites fault");
		spyOn(pool, "runReadTask").mockRejectedValue(error);
		const main = spyOn(sqlite, "prepare");
		const response = await send("alice", "GET", "/");
		expect(response.status).toBeGreaterThanOrEqual(500);
		expect(main).not.toHaveBeenCalled();
	});
});
