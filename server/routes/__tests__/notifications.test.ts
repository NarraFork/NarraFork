import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { AppError } from "../../lib/errors";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { notificationRoutes, NOTIFICATION_READ_BODY_MAX_BYTES, readMarkReadBody } = await import(
	"../notifications"
);
const { ensureNotificationsTableForTests } = await import(
	"../../services/notification-center-service"
);

const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "owner", role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
	await next();
});
app.onError(
	(error) =>
		new Response(JSON.stringify({ error: error.message }), {
			status: error instanceof AppError ? error.statusCode : 500,
			headers: { "content-type": "application/json" },
		}),
);
app.route("/api/notifications", notificationRoutes);

beforeEach(() => {
	cleanDb(sqlite);
	ensureNotificationsTableForTests(sqlite);
	for (const id of ["owner", "other"]) {
		sqlite.run("INSERT INTO users (id,username,password_hash,created_at) VALUES (?,?,?,?)", [
			id,
			id,
			"x",
			new Date().toISOString(),
		]);
		sqlite.run(
			"INSERT INTO notifications (id,user_id,kind,source_key,created_at,title,preview,link_json) VALUES (?,?,'chat_message',?,?,'','','{}')",
			[id, id, id, Date.now() - 1000],
		);
	}
});
afterAll(() => {
	mock.restore();
	mock.module("../../db", () => realDb);
	cleanDb(sqlite);
});

function read(body?: string) {
	return app.request("/api/notifications/read", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
}

function expectUnchanged() {
	expect(sqlite.query("SELECT id,status,read_at FROM notifications ORDER BY id").all()).toEqual([
		{ id: "other", status: "unread", read_at: null },
		{ id: "owner", status: "unread", read_at: null },
	]);
}

test("real handler rejects empty, malformed, implicit and mixed scope with no mutation", async () => {
	for (const body of [
		undefined,
		"",
		" ",
		"{",
		"{}",
		"null",
		"[]",
		'{"ids":["owner"]}',
		'{"scope":"bad"}',
		'{"scope":"all"}',
		'{"scope":"items","ids":[],"before":0}',
		'{"scope":"all","before":0,"ids":[]}',
	]) {
		expect((await read(body)).status).toBe(400);
		expectUnchanged();
	}
});

test("body bytes are capped for normal and unknown-length streaming requests", async () => {
	expect((await read(" ".repeat(NOTIFICATION_READ_BODY_MAX_BYTES + 1))).status).toBe(400);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(NOTIFICATION_READ_BODY_MAX_BYTES));
			controller.enqueue(new Uint8Array(1));
			controller.close();
		},
	});
	const response = await app.request(
		new Request("http://localhost/api/notifications/read", { method: "POST", body: stream }),
	);
	expect(response.status).toBe(400);
	expectUnchanged();
});

test("explicit items empty is no-op; owner scope and id max enforced", async () => {
	expect(await (await read('{"scope":"items","ids":[]}')).json()).toEqual({ updated: 0 });
	expectUnchanged();
	expect(
		(await read(JSON.stringify({ scope: "items", ids: Array(501).fill("owner") }))).status,
	).toBe(400);
	expectUnchanged();
	const response = await read('{"scope":"items","ids":["owner","other"]}');
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ updated: 1 });
	expect(sqlite.query("SELECT read_at FROM notifications WHERE id='other'").get()).toEqual({
		read_at: null,
	});
});

test("asOf all-read preserves later arrivals and source filtering", async () => {
	const pageResponse = await app.request("/api/notifications");
	expect(pageResponse.status).toBe(200);
	const page = await pageResponse.json();
	sqlite.run(
		"INSERT INTO notifications (id,user_id,kind,source_key,created_at,title,preview,link_json) VALUES ('new','owner','chat_message','new',?,'','','{}')",
		[page.asOf + 1],
	);
	const response = await read(
		JSON.stringify({ scope: "all", before: page.asOf, kind: "chat_message" }),
	);
	expect(await response.json()).toEqual({ updated: 1 });
	expect(sqlite.query("SELECT read_at FROM notifications WHERE id='new'").get()).toEqual({
		read_at: null,
	});
});

test("foreign/missing deletes return 404 and list cursor filter is validated", async () => {
	for (const id of ["other", "missing"])
		expect((await app.request(`/api/notifications/${id}/delete`, { method: "POST" })).status).toBe(
			404,
		);
	expectUnchanged();
	expect((await app.request("/api/notifications?cursor=garbage")).status).toBe(400);
});

test("slow request bodies are cancelled within a total budget", async () => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
	});
	const request = new Request("http://localhost/api/notifications/read", { method: "POST", body });
	await expect(readMarkReadBody(request, 10)).rejects.toThrow("timed out");
	expect(cancelled).toBe(true);
	expectUnchanged();
});

test("aborting an in-flight body cancels the reader without acknowledging anything", async () => {
	let cancelled = false;
	const controller = new AbortController();
	const body = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
	});
	const request = new Request("http://localhost/api/notifications/read", {
		method: "POST",
		body,
		signal: controller.signal,
	});
	const reading = readMarkReadBody(request);
	controller.abort();
	await expect(reading).rejects.toThrow("aborted");
	expect(cancelled).toBe(true);
	expectUnchanged();
});
