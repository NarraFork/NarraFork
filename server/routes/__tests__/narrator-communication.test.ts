import { expect, test } from "bun:test";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";
import { registerNarratorCommunicationRoutes } from "../narrator-communication";

let count = 0;
function fixture(failure?: AppError) {
	const app = new Hono();
	const calls: Array<{ kind: string; args: unknown[] }> = [];
	const userId = `route-user-${++count}`;
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: 2147483647 });
		await next();
	});
	app.onError((error, c) =>
		c.json(
			{ code: error instanceof AppError ? error.code : "INTERNAL" },
			error instanceof AppError ? (error.statusCode as 400) : 500,
		),
	);
	registerNarratorCommunicationRoutes(app, {
		search: async (...args) => {
			calls.push({ kind: "search", args });
			if (failure) throw failure;
			return { items: [], hasMore: false };
		},
		mutate: async (...args) => {
			calls.push({ kind: "mutate", args });
			if (failure) throw failure;
			return { changed: true };
		},
	});
	return { app, calls, userId };
}
const send = (app: Hono, body: unknown) =>
	app.request("/source/communication", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
test("candidate route forwards the authenticated principal, query, limit and abort signal", async () => {
	const { app, calls, userId } = fixture();
	const response = await app.request("/source/communication/candidates?q=%E4%B8%AD&limit=50");
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ items: [], hasMore: false });
	expect(calls[0]?.args).toEqual([
		"source",
		{ userId, isAdmin: false },
		{ query: "中", limit: 50, signal: expect.any(AbortSignal) },
	]);
});
test.each([
	false,
	true,
])("candidate route forwards manual purpose for ranked or exact requests (%j)", async (exact) => {
	const { app, calls, userId } = fixture();
	const response = await app.request(
		`/source/communication/candidates?purpose=manual-connect${exact ? "&targetId=target" : "&q=term"}`,
	);
	expect(response.status).toBe(200);
	expect(calls[0]?.args).toEqual([
		"source",
		{ userId, isAdmin: false },
		{
			query: exact ? undefined : "term",
			limit: undefined,
			purpose: "manual-connect",
			signal: expect.any(AbortSignal),
			...(exact && { targetId: "target" }),
		},
	]);
});
test.each([
	"limit=0",
	"limit=51",
	"limit=NaN",
	`q=${"a".repeat(129)}`,
	"q=test&limit=50&cursor=opaque",
	"cursor=",
	"purpose=execution",
	"purpose=",
	"purpose=manual-connect&viewer=someone-else",
	"unknown=1",
])("rejects invalid query before search: %s", async (query) => {
	const { app, calls } = fixture();
	expect((await app.request(`/source/communication/candidates?${query}`)).status).toBe(400);
	expect(calls).toHaveLength(0);
});
test.each([
	{ kind: "connect", targetNarratorId: "target" },
	{ kind: "disconnect", peerId: "imported_peer_1" },
	{ kind: "split", version: 3 },
	{ kind: "restore", version: 4 },
])("mounts the shared mutation contract: %j", async (body) => {
	const { app, calls, userId } = fixture();
	const result = await send(app, body);
	expect(result.status).toBe(200);
	expect(await result.json()).toEqual({ changed: true });
	expect(calls[0]?.args).toEqual(["source", { userId, isAdmin: false }, body]);
});
test.each([
	{ kind: "reparent", targetNarratorId: "target" },
	{ kind: "disconnect", peerId: "peer", generation: 1 },
	{ kind: "disconnect" },
	{ kind: "restore", version: 1, userId: "admin" },
	{ kind: "split", version: "1" },
])("rejects malformed or authority-bearing mutations: %j", async (body) => {
	const { app, calls } = fixture();
	expect((await send(app, body)).status).toBe(400);
	expect(calls).toHaveLength(0);
});
test("oversized bodies never reach the mutation service", async () => {
	const { app, calls } = fixture();
	expect((await send(app, { kind: "connect", targetNarratorId: "a".repeat(5000) })).status).toBe(
		413,
	);
	expect(calls).toHaveLength(0);
});
test("CAS conflict is retained rather than translated into success", async () => {
	const { app } = fixture(new AppError("Changed", 409, "COMMUNICATION_CONFLICT"));
	const response = await send(app, { kind: "split", version: 1 });
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ code: "COMMUNICATION_CONFLICT" });
});
test("search admission is bounded per authenticated account", async () => {
	const { app, calls } = fixture();
	for (let i = 0; i < 120; i++)
		expect((await app.request("/source/communication/candidates")).status).toBe(200);
	expect((await app.request("/source/communication/candidates")).status).toBe(429);
	expect(calls).toHaveLength(120);
});
