import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, desc, eq, gt, lt, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";
import * as schema from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import * as pool from "../../lib/db-worker/pool";
import { parseSubstatus, redactInternalTraits } from "../../lib/narrator-utils";

const home = mkdtempSync(join(tmpdir(), "narrator-list-workers-"));
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
const drafts = await import("../../services/narrator-draft-service");
const { backgroundTaskService } = await import("../../services/background-task-service");
const { narratorReadableWhere } = await import("../../services/narrator-acl");
const { countNarratorMessageRefsBatch } = await import("../../services/narrator-message-count");
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "alice", role: "user", iat: 0, exp: 0 });
	await next();
});
app.route("/api/narrators", narratorRoutes);
app.onError(
	(error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: "Internal error" }, 500),
);
const previousWorker = process.env.NARRAFORK_DB_WORKER;
const previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
beforeEach(async () => {
	delete process.env.NARRAFORK_DB_WORKER;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
	await pool.resetDbWorkerPoolForTest();
	cleanDb(sqlite);
	spyOn(drafts, "getNarratorIdsWithDraft").mockResolvedValue(new Set());
	spyOn(backgroundTaskService, "countActiveKindsByParentBatch").mockResolvedValue(new Map());
});
afterEach(async () => {
	mock.restore();
	await pool.resetDbWorkerPoolForTest();
});
afterAll(() => {
	mock.module("../../db", () => realDb);
	if (previousWorker === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = previousWorker;
	if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
	sqlite.close();
	rmSync(home, { recursive: true, force: true });
});

const { narrators, terminals, narratorWorktreeResources, containerInstances } = schema;
const now = "2026-10-01T00:00:00.000Z";
function seed() {
	for (const id of ["alice", "bob"])
		db.insert(schema.users)
			.values({ id, username: id, passwordHash: "unused", createdAt: now })
			.run();
	for (let i = 0; i < 8; i++) {
		const id = `n${i}`;
		db.insert(narrators)
			.values({
				id,
				ownerUserId: i === 6 ? "bob" : "alice",
				visibility: "private",
				title: i < 2 ? null : `title-${Math.floor(i / 2)}`,
				status: i === 5 ? "archived" : i % 2 ? "waiting" : "working",
				hiddenFromLists: i === 7,
				messageCount: Math.floor(i / 2) * 10,
				traits: ["standalone"],
				substatus: '["thinking"]',
				enabledTools: ["Read"],
				runtimeRegistrationJson: { version: 1, run: { logicalRunId: "secret" } },
				createdAt: new Date(Date.parse(now) + Math.floor(i / 2) * 1000).toISOString(),
				updatedAt: new Date(Date.parse(now) + Math.floor(i / 3) * 1000).toISOString(),
			})
			.run();
		db.insert(terminals)
			.values({
				id: `t${i}`,
				narratorId: id,
				name: id,
				status: i % 2 ? "exited" : "running",
				createdAt: now,
			})
			.run();
		db.insert(narratorWorktreeResources)
			.values({
				id: `w${i}`,
				ownerNarratorId: id,
				deviceId: "local",
				repositoryKey: id,
				worktreePath: `/unused/${id}`,
				state: "ready",
				createRequestId: id,
			})
			.run();
		db.insert(containerInstances)
			.values({
				id: `c${i}`,
				worktreeResourceId: `w${i}`,
				serviceName: id,
				status: i % 2 ? "stopped" : "running",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		for (let j = 0; j < i % 3; j++) {
			const mid = `m${i}-${j}`;
			db.insert(schema.narratorMessages)
				.values({
					id: mid,
					narratorId: id,
					role: "assistant",
					contentJson: [],
					createdAt: now,
				})
				.run();
			db.insert(schema.narratorMessageRefs)
				.values({
					id: mid,
					narratorId: id,
					messageId: mid,
					seq: j,
				})
				.run();
		}
	}
}

type Sort = "updatedAt" | "createdAt" | "title" | "messageCount";
async function inlineBaseline(params: URLSearchParams) {
	const sortBy = (params.get("sortBy") ?? "updatedAt") as Sort;
	const column = narrators[sortBy];
	const order = params.get("sortOrder") === "asc" ? asc : desc;
	const cmp = params.get("sortOrder") === "asc" ? gt : lt;
	const limit = Number(params.get("limit") ?? 2);
	const status = params.get("status") as "waiting" | "archived" | null;
	const conditions = [
		eq(narrators.variant, "primary"),
		eq(narrators.hiddenFromLists, false),
		narratorReadableWhere({ userId: "alice", isAdmin: false }),
		status ? eq(narrators.status, status) : ne(narrators.status, "archived"),
	];
	if (params.get("hasTerminals") === "true")
		conditions.push(
			sql`EXISTS (SELECT 1 FROM terminals WHERE narrator_id = ${narrators.id} AND status = 'running')`,
		);
	if (params.get("hasRunningContainers") === "true")
		conditions.push(
			sql`EXISTS (SELECT 1 FROM container_instances c JOIN narrator_worktree_resources w ON w.id = c.worktree_resource_id WHERE w.owner_narrator_id = ${narrators.id} AND c.status = 'running')`,
		);
	const baseWhere = and(...conditions);
	let cursorWhere: ReturnType<typeof and>;
	const cursor = params.get("cursor");
	if (cursor) {
		const { v, id } = JSON.parse(Buffer.from(cursor, "base64url").toString());
		cursorWhere = or(cmp(column, v), and(eq(column, v), cmp(narrators.id, id)));
	}
	const [list, total] = await Promise.all([
		db.query.narrators.findMany({
			columns: { runtimeRegistrationJson: false },
			where: and(baseWhere, cursorWhere),
			orderBy: [order(column), order(narrators.id)],
			limit: limit + 1,
		}),
		db.select({ count: sql<number>`count(*)` }).from(narrators).where(baseWhere),
	]);
	const hasMore = list.length > limit;
	const page = hasMore ? list.slice(0, limit) : list;
	const last = page.at(-1);
	const nextCursor =
		hasMore && last
			? Buffer.from(JSON.stringify({ v: last[sortBy] ?? last.updatedAt, id: last.id })).toString(
					"base64url",
				)
			: null;
	const items = await Promise.all(
		page.map(async (n) => {
			const {
				askInPassingGroupId: _group,
				archivedWithNarratorId: _archivedWith,
				...publicRow
			} = n;
			const [refs] = await db
				.select({ count: sql<number>`count(*)` })
				.from(schema.narratorMessageRefs)
				.where(eq(schema.narratorMessageRefs.narratorId, n.id));
			const [term] = await db
				.select({ count: sql<number>`count(*)` })
				.from(terminals)
				.where(and(eq(terminals.narratorId, n.id), eq(terminals.status, "running")));
			const [containers] = await db
				.select({
					total: sql<number>`count(*)`,
					running: sql<number>`coalesce(sum(case when ${containerInstances.status} = 'running' then 1 else 0 end), 0)`,
				})
				.from(containerInstances)
				.innerJoin(
					narratorWorktreeResources,
					eq(narratorWorktreeResources.id, containerInstances.worktreeResourceId),
				)
				.where(eq(narratorWorktreeResources.ownerNarratorId, n.id));
			return {
				...publicRow,
				traits: redactInternalTraits(n.traits),
				hasDraft: false,
				substatus: parseSubstatus(n.substatus),
				messageCount: refs.count,
				activeTerminalCount: term.count,
				activeBackgroundTaskCount: 0,
				activeBackgroundWorkCount: 0,
				activeBackgroundServiceCount: 0,
				containerCount: containers.total,
				runningContainerCount: containers.running,
				viewers: [],
			};
		}),
	);
	return { items, hasMore, nextCursor, totalCount: total[0].count };
}

async function assertPage(params: URLSearchParams) {
	const baseline = await inlineBaseline(params);
	const dispatch = spyOn(pool, "runReadTask");
	const prepare = spyOn(sqlite, "prepare");
	const query = spyOn(sqlite, "query");
	try {
		const response = await app.request(`/api/narrators?${params}`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(JSON.stringify(baseline));
		expect(dispatch).toHaveBeenCalledTimes(baseline.items.length ? 5 : 2);
		const budgets: Record<string, number> = {
			"narrators.list.page": Number(params.get("limit") ?? 2) + 1,
			"narrators.list.total": 1,
			"narrators.list.terminals": baseline.items.length,
			"narrators.list.containers": baseline.items.length,
			"narrators.list.messages": baseline.items.length,
		};
		for (const [, task, options] of dispatch.mock.calls) {
			expect(task.kind).toBe("selectRows");
			if (task.kind === "selectRows")
				expect(task.maxRows).toBe(budgets[options?.diagnosticSource ?? ""]);
			expect(options?.signal).toBeInstanceOf(AbortSignal);
		}
		expect(pool.getDbWorkerPoolStats().workers).toBeGreaterThan(0);
		expect(prepare).not.toHaveBeenCalled();
		expect(query).not.toHaveBeenCalled();
	} finally {
		dispatch.mockRestore();
		prepare.mockRestore();
		query.mockRestore();
	}
	return baseline.nextCursor;
}

test.each([
	"updatedAt",
	"createdAt",
	"title",
	"messageCount",
] as const)("%s page, tiebreaks, cursor and count match the original relational query in both directions", async (sortBy) => {
	seed();
	for (const sortOrder of ["asc", "desc"]) {
		const params = new URLSearchParams({ sortBy, sortOrder, limit: "2" });
		let cursor = await assertPage(params);
		for (let i = 0; cursor && i < 5; i++) {
			params.set("cursor", cursor);
			cursor = await assertPage(params);
		}
	}
});
test.each([
	"status=waiting",
	"status=archived",
	"hasTerminals=true",
	"hasRunningContainers=true",
])("filter %s preserves page and total parity", async (filter) => {
	seed();
	await assertPage(new URLSearchParams(`limit=2&${filter}`));
});
test("empty database remains an empty page", async () => {
	await assertPage(new URLSearchParams("limit=2"));
});

function seedGroupedList() {
	seed();
	db.update(narrators)
		.set({ isAskInPassing: true, parentNarratorId: "n0" })
		.where(or(eq(narrators.id, "n1"), eq(narrators.id, "n6")))
		.run();
}

test("grouped children load on the read worker with the same ACL and safe projection", async () => {
	seedGroupedList();
	const prepare = spyOn(sqlite, "prepare");
	const query = spyOn(sqlite, "query");
	const dispatch = spyOn(pool, "runReadTask");
	const response = await app.request("/api/narrators?groupAskInPassing=true");
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body.items.map((row: { id: string }) => row.id)).not.toContain("n1");
	const parent = body.items.find((row: { id: string }) => row.id === "n0");
	expect(parent?.askInPassingSessions).toEqual([expect.objectContaining({ id: "n1" })]);
	expect(parent.askInPassingSessions[0]).not.toHaveProperty("runtimeRegistrationJson");
	const [, task, options] =
		dispatch.mock.calls.find(
			([, , opts]) => opts?.diagnosticSource === "narrators.list.ask-in-passing",
		) ?? [];
	expect(task).toMatchObject({ kind: "selectRows", maxRows: body.items.length * 20 });
	if (task?.kind === "selectRows") expect(task.sql).not.toContain("runtime_registration_json");
	expect(options?.signal).toBeInstanceOf(AbortSignal);
	expect(prepare).not.toHaveBeenCalled();
	expect(query).not.toHaveBeenCalled();
});

test.each([
	["unavailable", new pool.WorkersUnavailableError("disabled"), 503],
	["queue full", new pool.DbReadTaskOverloadedError(), 503],
	["timeout", new pool.DbReadTaskTimeoutError("timeout"), 503],
	["crash", new pool.DbReadTaskExecutionError("exited"), 500],
] as const)("%s propagates without main-thread execution", async (_name, error, status) => {
	spyOn(pool, "runReadTask").mockRejectedValue(error);
	const prepare = spyOn(sqlite, "prepare");
	const query = spyOn(sqlite, "query");
	const response = await app.request("/api/narrators");
	expect(response.status).toBe(status);
	expect(await response.json()).toHaveProperty("error");
	expect(prepare).not.toHaveBeenCalled();
	expect(query).not.toHaveBeenCalled();
});
test("real disabled pool and aborted requests never execute inline", async () => {
	const prepare = spyOn(sqlite, "prepare");
	const query = spyOn(sqlite, "query");
	process.env.NARRAFORK_DB_WORKER = "off";
	expect((await app.request("/api/narrators")).status).toBe(503);
	delete process.env.NARRAFORK_DB_WORKER;
	const controller = new AbortController();
	controller.abort();
	expect((await app.request("/api/narrators", { signal: controller.signal })).status).toBe(500);
	expect(prepare).not.toHaveBeenCalled();
	expect(query).not.toHaveBeenCalled();
});
test.each([
	"total",
	"terminals",
	"containers",
	"messages",
	"ask-in-passing",
])("a failure in the %s read cannot become a partial successful page", async (stage) => {
	seedGroupedList();
	const runReadTask = pool.runReadTask;
	spyOn(pool, "runReadTask").mockImplementation((path, params, options) => {
		if (options?.diagnosticSource === `narrators.list.${stage}`)
			return Promise.reject(new pool.DbReadTaskTimeoutError("timeout"));
		return runReadTask(path, params, options);
	});
	const prepare = spyOn(sqlite, "prepare");
	const query = spyOn(sqlite, "query");
	const response = await app.request("/api/narrators?groupAskInPassing=true");
	expect(response.status).toBe(503);
	expect(await response.json()).toHaveProperty("error");
	expect(prepare).not.toHaveBeenCalled();
	expect(query).not.toHaveBeenCalled();
});
test("batch ref counts preserve empty input and transaction visibility", async () => {
	expect(await countNarratorMessageRefsBatch([])).toEqual(new Map());
	seed();
	sqlite.run("BEGIN");
	try {
		db.insert(schema.narratorMessageRefs)
			.values({
				id: "uncommitted",
				narratorId: "n0",
				messageId: "m1-0",
				seq: 0,
			})
			.run();
		process.env.NARRAFORK_DB_WORKER = "off";
		expect(await countNarratorMessageRefsBatch(["n0", "n1"])).toEqual(
			new Map([
				["n0", 1],
				["n1", 1],
			]),
		);
	} finally {
		sqlite.run("ROLLBACK");
	}
});
