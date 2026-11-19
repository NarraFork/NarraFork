import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { cleanDb } from "../../../tests/setup";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import * as pool from "../../lib/db-worker/pool";
import type { SelectRowsParams } from "../../lib/db-worker/protocol";
import { ForbiddenError } from "../../lib/errors";
import { getNarratorWorkerTestDb } from "../../services/__tests__/narrator-worker-fixture";

const previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { narratorService } = await import("../../services/narrator-service");
const { narratorRoutes } = await import("../narrators");
const NOW = "2026-10-25T00:00:00.000Z";
const BASE = "http://localhost/api/narrators/n1/permissions";
// Real, bounded SQLite work keeps a worker occupied until the test cancels it.
const SLOW_READ: SelectRowsParams = {
	kind: "selectRows",
	sql: "WITH RECURSIVE scan(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM scan WHERE n < ?) SELECT sum(n) AS total FROM scan",
	params: [3_000_000],
	maxRows: 1,
};

beforeEach(() => {
	cleanDb(sqlite);
	for (const id of ["viewer", "outsider"])
		sqlite.run(
			"INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'test-only', 'user', ?)",
			[id, id, NOW],
		);
	sqlite.run(
		"INSERT INTO narrators (id, owner_user_id, visibility, write_audience, created_at, updated_at) VALUES ('n1', 'viewer', 'private', 'owner', ?, ?)",
		[NOW, NOW],
	);
	sqlite.run(
		"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES ('message', 'n1', 'assistant', '[]', ?)",
		[NOW],
	);
	sqlite.run(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('ref', 'n1', 'message', 1)",
	);
	sqlite.run(
		"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, input_json, status, created_at) VALUES ('permission', 'n1', 'message', 'tool', 'Bash', '{\"command\":\"pwd\"}', 'pending', ?)",
		[NOW],
	);
});
afterEach(() => mock.restore());
afterAll(async () => {
	mock.restore();
	mock.module("../../db", () => realDbModule);
	await fixture.close();
	if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
});

function appFor(user = "viewer") {
	const failures: Error[] = [];
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: user, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error, c) => {
		failures.push(error);
		return (
			buildAppErrorResponse(error, c) ??
			c.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500)
		);
	});
	app.route("/api/narrators", narratorRoutes);
	return { app, failures };
}
async function waitFor(check: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!check()) {
		if (Date.now() >= deadline)
			throw new Error("Permission worker did not reach the expected state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
async function expectHealthy(app: ReturnType<typeof appFor>["app"]) {
	const response = await app.request(BASE);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual([
		expect.objectContaining({
			id: "permission",
			inputJson: { command: "pwd" },
			ownerNarratorId: "n1",
		}),
	]);
	expect(pool.getDbWorkerPoolStats()).toMatchObject({
		busy: 0,
		queued: 0,
		queuedBytes: 0,
		retiring: 0,
	});
	expect(sqlite.inTransaction).toBe(false);
}

for (const reason of [
	new Error("PRIVATE_CLIENT_REASON"),
	new DOMException("PRIVATE_DEADLINE", "TimeoutError"),
]) {
	test(`already cancelled HTTP request with ${reason.name} reason returns a controlled 499`, async () => {
		const { app, failures } = appFor();
		const controller = new AbortController();
		controller.abort(reason);
		const request = new Request(BASE, { signal: controller.signal });
		const reads = spyOn(pool, "runReadTask");
		const response = await app.request(request);
		expect(response.status).toBe(499);
		expect(await response.text()).toBe("");
		expect(failures).toHaveLength(0);
		expect(reads.mock.calls.some(([, , options]) => options?.signal === request.signal)).toBe(
			false,
		);
		await expectHealthy(app);
	});
}

test("HTTP cancellation removes a real queued permission read without scheduling its second read", async () => {
	const { app, failures } = appFor();
	const controller = new AbortController();
	const blockerController = new AbortController();
	const request = new Request(BASE, { signal: controller.signal });
	const run = pool.runReadTask;
	let blocker: Promise<unknown> | undefined;
	let permissionReads = 0;
	spyOn(pool, "runReadTask").mockImplementation(
		async <T>(...args: Parameters<typeof run>): Promise<T> => {
			if (args[2]?.signal === request.signal) {
				permissionReads++;
				if (permissionReads === 1) {
					blocker = run(args[0], SLOW_READ, {
						signal: blockerController.signal,
						timeoutMs: 4000,
					}).catch((error: unknown) => error);
					await waitFor(() => pool.getDbWorkerPoolStats().busy === 1);
				}
			}
			return run<T>(...args);
		},
	);
	const response = Promise.resolve(app.request(request));
	try {
		await waitFor(() => pool.getDbWorkerPoolStats().queued === 1);
		expect(permissionReads).toBe(1);
		expect(pool.getDbWorkerPoolStats().queuedBytes).toBeGreaterThan(0);
		controller.abort(new Error("PRIVATE_CLIENT_REASON"));
		const result = await response;
		expect(result.status).toBe(499);
		expect(await result.text()).toBe("");
		expect(permissionReads).toBe(1);
		expect(pool.getDbWorkerPoolStats()).toMatchObject({ busy: 1, queued: 0, queuedBytes: 0 });
		expect(failures).toHaveLength(0);
	} finally {
		controller.abort();
		blockerController.abort();
		await response;
		await blocker;
		mock.restore();
	}
	await expectHealthy(app);
});

for (const readIndex of [1, 2]) {
	test(`HTTP cancellation retires the real worker during permission read ${readIndex}`, async () => {
		const { app, failures } = appFor();
		const controller = new AbortController();
		const request = new Request(BASE, { signal: controller.signal });
		const run = pool.runReadTask;
		let permissionReads = 0;
		spyOn(pool, "runReadTask").mockImplementation(
			async <T>(...args: Parameters<typeof run>): Promise<T> => {
				if (args[2]?.signal === request.signal && ++permissionReads === readIndex)
					return run<T>(args[0], SLOW_READ, args[2]);
				return run<T>(...args);
			},
		);
		const response = Promise.resolve(app.request(request));
		try {
			await waitFor(() => permissionReads === readIndex && pool.getDbWorkerPoolStats().busy === 1);
			controller.abort(new Error("PRIVATE_CLIENT_REASON"));
			const result = await response;
			expect(result.status).toBe(499);
			expect(await result.text()).toBe("");
			expect(permissionReads).toBe(readIndex);
			expect(pool.getDbWorkerPoolStats()).toMatchObject({ busy: 0, queued: 0, queuedBytes: 0 });
			expect(failures).toHaveLength(0);
		} finally {
			controller.abort();
			await response;
			mock.restore();
		}
		// A healthy request must wait for the actual close event and recover without a pool reset.
		await expectHealthy(app);
	});
}

test("cancelling after the first permission result prevents the second read from reaching the pool", async () => {
	const { app, failures } = appFor();
	const controller = new AbortController();
	const request = new Request(BASE, { signal: controller.signal });
	const run = pool.runReadTask;
	let permissionReads = 0;
	spyOn(pool, "runReadTask").mockImplementation(
		async <T>(...args: Parameters<typeof run>): Promise<T> => {
			const result = await run<T>(...args);
			if (args[2]?.signal === request.signal) {
				permissionReads++;
				controller.abort(new Error("PRIVATE_CLIENT_REASON"));
			}
			return result;
		},
	);
	const response = await app.request(request);
	expect(response.status).toBe(499);
	expect(permissionReads).toBe(1);
	expect(pool.getDbWorkerPoolStats()).toMatchObject({ busy: 0, queued: 0, queuedBytes: 0 });
	expect(failures).toHaveLength(0);
});

test("an independent service abort does not become HTTP cancellation", async () => {
	const { app, failures } = appFor();
	const request = new Request(BASE);
	const deadline = new AbortController();
	deadline.abort(new DOMException("PRIVATE_SERVICE_DEADLINE", "TimeoutError"));
	const run = pool.runReadTask;
	let failure: unknown;
	spyOn(pool, "runReadTask").mockImplementation(
		async <T>(...args: Parameters<typeof run>): Promise<T> => {
			if (args[2]?.signal !== request.signal) return run<T>(...args);
			try {
				return await run<T>(args[0], args[1], { ...args[2], signal: deadline.signal });
			} catch (error) {
				failure = error;
				throw error;
			}
		},
	);
	const response = await app.request(request);
	if (!(failure instanceof Error)) throw new Error("Expected the read pool to reject with Error");
	expect(failure).toMatchObject({ code: "DB_READ_ABORTED" });
	expect(request.signal.aborted).toBe(false);
	expect(response.status).toBe(500);
	expect(await response.json()).toEqual({ error: "Internal server error", code: "INTERNAL_ERROR" });
	expect(failures).toEqual([failure]);
});

for (const code of [
	undefined,
	"DB_READ_FAILED",
	"DB_READ_BUDGET",
	"DB_READ_TASK_TIMEOUT",
	"DB_READ_OVERLOADED",
]) {
	test(`${code ?? "Error"} keeps its error boundary even if HTTP was cancelled`, async () => {
		const { app, failures } = appFor();
		const controller = new AbortController();
		const request = new Request(BASE, { signal: controller.signal });
		const failure = Object.assign(new Error("PRIVATE_SQL_OR_BINDS"), code ? { code } : {});
		const run = pool.runReadTask;
		spyOn(pool, "runReadTask").mockImplementation(
			async <T>(...args: Parameters<typeof run>): Promise<T> => {
				if (args[2]?.signal !== request.signal) return run<T>(...args);
				controller.abort(new Error("PRIVATE_CLIENT_REASON"));
				throw failure;
			},
		);
		const response = await app.request(request);
		const unavailable = code === "DB_READ_TASK_TIMEOUT" || code === "DB_READ_OVERLOADED";
		expect(response.status).toBe(unavailable ? 503 : 500);
		const body = await response.json();
		expect(body.code).toBe(unavailable ? code : "INTERNAL_ERROR");
		expect(JSON.stringify(body)).not.toContain("PRIVATE_");
		expect(failures).toEqual([failure]);
	});
}

test("permission business errors retain their original 403 boundary after HTTP cancellation", async () => {
	const { app, failures } = appFor();
	const failure = new ForbiddenError();
	spyOn(narratorService, "getPendingPermissions").mockRejectedValue(failure);
	const controller = new AbortController();
	controller.abort();
	const response = await app.request(new Request(BASE, { signal: controller.signal }));
	expect(response.status).toBe(403);
	expect(failures).toEqual([failure]);
});

test("the real ACL still refuses an inaccessible narrator before reading permissions", async () => {
	const { app } = appFor("outsider");
	const reads = spyOn(narratorService, "getPendingPermissions");
	const controller = new AbortController();
	controller.abort();
	const response = await app.request(new Request(BASE, { signal: controller.signal }));
	expect(response.status).toBe(404);
	expect(reads).not.toHaveBeenCalled();
});

test("live HTTP and optional service signals preserve permission results and both 30s read budgets", async () => {
	const expected = await narratorService.getPendingPermissions("n1");
	expect(expected).toHaveLength(1);
	const { app, failures } = appFor();
	const request = new Request(BASE);
	const reads = spyOn(pool, "runReadTask");
	const response = await app.request(request);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(expected);
	const permissionReads = reads.mock.calls.filter(
		([, , options]) => options?.signal === request.signal,
	);
	expect(permissionReads).toHaveLength(2);
	for (const [, , options] of permissionReads) expect(options?.timeoutMs).toBe(30_000);
	expect(await narratorService.getPendingPermissions("n1", new AbortController().signal)).toEqual(
		expected,
	);
	expect(failures).toHaveLength(0);
});
