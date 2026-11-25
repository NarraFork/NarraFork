import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";
import * as schema from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import * as pool from "../../lib/db-worker/pool";

const home = mkdtempSync(join(tmpdir(), "narrator-ui-summary-"));
const file = join(home, "fixture.db");
const memory = getTestDb();
writeFileSync(file, memory.sqlite.serialize());
memory.sqlite.close();
const sqlite = new Database(file);
sqlite.run("PRAGMA journal_mode = WAL");
const db = drizzle({ client: sqlite, schema });
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { narratorRoutes } = await import("../narrators");
const { getNarratorUiSummary } = await import("../../services/narrator-ui-summary");
let userId = "alice";
let role: "admin" | "user" = "user";
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: userId, role, iat: 0, exp: 0 });
	await next();
});
app.route("/api/narrators", narratorRoutes);
app.onError(
	(error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: "Internal error" }, 500),
);
const previousWorker = process.env.NARRAFORK_DB_WORKER;
beforeEach(async () => {
	delete process.env.NARRAFORK_DB_WORKER;
	await pool.resetDbWorkerPoolForTest();
	cleanDb(sqlite);
	userId = "alice";
	role = "user";
	for (const id of ["alice", "bob"])
		db.insert(schema.users)
			.values({ id, username: id, passwordHash: "unused", createdAt: now })
			.run();
	db.insert(schema.narrators)
		.values({
			id: "n",
			ownerUserId: "alice",
			visibility: "private",
			writeAudience: "owner",
			createdAt: now,
			updatedAt: now,
			enabledTools: Array(1000).fill("large-unused-field"),
		})
		.run();
});
afterEach(async () => {
	mock.restore();
	await pool.resetDbWorkerPoolForTest();
});
afterAll(() => {
	mock.module("../../db", () => realDb);
	if (previousWorker === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = previousWorker;
	sqlite.close();
	rmSync(home, { recursive: true, force: true });
});
const now = "2026-10-01T00:00:00.000Z";
function request(id = "n") {
	return app.request(`/api/narrators/${id}/ui-summary`);
}
function seedRoom() {
	db.insert(schema.chatRooms)
		.values({ id: "room", kind: "narrator", narratorId: "n", nextSeq: 105, createdAt: now })
		.run();
	for (let seq = 1; seq <= 104; seq++)
		db.insert(schema.chatMessages)
			.values({
				id: `m${seq}`,
				roomId: "room",
				seq,
				contentText: "not read by summary",
				senderUserId: "alice",
				deletedAt: seq === 2 ? now : null,
				createdAt: now,
			})
			.run();
}

test("no room is an exact bounded projection, with no room or membership creation", async () => {
	const dispatch = spyOn(pool, "runReadTask");
	const response = await request();
	expect(response.status).toBe(200);
	const body = await response.text();
	expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(2048);
	expect(JSON.parse(body)).toEqual({
		narratorId: "n",
		canWrite: true,
		activeTerminalCount: 0,
		discussion: { roomId: null, unread: 0, unreadCapped: false },
	});
	expect(db.select().from(schema.chatRooms).all()).toEqual([]);
	expect(db.select().from(schema.chatRoomMembers).all()).toEqual([]);
	const queries = dispatch.mock.calls.map((call) => JSON.stringify(call[1]));
	expect(queries.length).toBeGreaterThan(0);
	expect(queries.join(" ")).not.toMatch(
		/enabled_tools|runtime_registration_json|content_text|last_message_preview|\bgrants\b/i,
	);
	expect(queries.join(" ")).not.toMatch(/select \*/i);
});

test("summary counts ordinary running terminals and probes only the existing room", async () => {
	seedRoom();
	db.insert(schema.terminals)
		.values([
			{ id: "running", narratorId: "n", name: "one", status: "running", createdAt: now },
			{ id: "exited", narratorId: "n", name: "two", status: "exited", createdAt: now },
		])
		.run();
	db.insert(schema.narratorWorktreeResources)
		.values({
			id: "resource",
			ownerNarratorId: "n",
			deviceId: "local",
			repositoryKey: "repo",
			worktreePath: "/unused",
			state: "ready",
			createRequestId: "req",
		})
		.run();
	db.insert(schema.terminals)
		.values({
			id: "resource-terminal",
			worktreeResourceId: "resource",
			name: "resource",
			status: "running",
			createdAt: now,
		})
		.run();
	const response = await request();
	expect(await response.json()).toEqual({
		narratorId: "n",
		canWrite: true,
		activeTerminalCount: 1,
		discussion: { roomId: "room", unread: 100, unreadCapped: true },
	});
	expect(db.select().from(schema.chatRoomMembers).all()).toEqual([]);
});

test("watermark, tombstones and muting match the single-room unread semantics", async () => {
	seedRoom();
	db.insert(schema.chatRoomMembers)
		.values({ id: "member", roomId: "room", userId: "alice", lastReadSeq: 100, joinedAt: now })
		.run();
	expect((await (await request()).json()).discussion).toEqual({
		roomId: "room",
		unread: 4,
		unreadCapped: false,
	});
	db.update(schema.chatRoomMembers)
		.set({ muted: true })
		.where(eq(schema.chatRoomMembers.id, "member"))
		.run();
	expect((await (await request()).json()).discussion).toEqual({
		roomId: "room",
		unread: 0,
		unreadCapped: false,
	});
});

test("same ACL hides private and missing narrators, but a read grant does not grant write", async () => {
	userId = "bob";
	expect((await request()).status).toBe(404);
	expect((await request("missing")).status).toBe(404);
	db.insert(schema.aclGrants)
		.values({
			id: "read",
			scopeType: "narrator",
			scopeId: "n",
			principalType: "user",
			principalId: "bob",
			capability: "read",
			createdAt: now,
		})
		.run();
	expect((await (await request()).json()).canWrite).toBe(false);
	role = "admin";
	expect((await (await request()).json()).canWrite).toBe(true);
});

test("subagent read/write verdicts delegate to the root ACL", async () => {
	db.insert(schema.narrators)
		.values({
			id: "child",
			type: "subagent",
			parentNarratorId: "n",
			aclRootNarratorId: "n",
			visibility: "public",
			writeAudience: "public",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	userId = "bob";
	expect((await request("child")).status).toBe(404);
	db.insert(schema.aclGrants)
		.values({
			id: "read",
			scopeType: "narrator",
			scopeId: "n",
			principalType: "user",
			principalId: "bob",
			capability: "read",
			createdAt: now,
		})
		.run();
	expect((await (await request("child")).json()).canWrite).toBe(false);
});

for (const failure of ["creation", "runtime", "timeout", "disabled"] as const) {
	test(`worker ${failure} fails explicitly without main-thread projection fallback`, async () => {
		if (failure === "disabled") process.env.NARRAFORK_DB_WORKER = "off";
		else spyOn(pool, "runReadTask").mockRejectedValue(new Error(`injected worker ${failure}`));
		const select = spyOn(sqlite, "query");
		const response = await request();
		expect(response.status).toBeGreaterThanOrEqual(500);
		expect(select).not.toHaveBeenCalled();
	});
}

test("oversized legacy identifiers fail explicitly rather than truncating or exceeding 2 KiB", async () => {
	db.insert(schema.chatRooms)
		.values({ id: "x".repeat(3000), kind: "narrator", narratorId: "n", createdAt: now })
		.run();
	const response = await request();
	expect(response.status).toBe(413);
	expect(await response.json()).toMatchObject({ code: "NARRATOR_UI_SUMMARY_TOO_LARGE" });
});

test("an aborted summary does not dispatch any worker read", async () => {
	const dispatch = spyOn(pool, "runReadTask");
	await expect(
		getNarratorUiSummary("n", { userId: "alice", isAdmin: false }, AbortSignal.abort()),
	).rejects.toThrow();
	expect(dispatch).not.toHaveBeenCalled();
});
