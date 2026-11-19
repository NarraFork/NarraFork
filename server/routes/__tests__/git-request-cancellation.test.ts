import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { GitLineStats } from "@shared/git-line-stats";
import { Hono } from "hono";
import { testEnvironment } from "../../../tests/preload";
import { cleanDb } from "../../../tests/setup";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import * as pool from "../../lib/db-worker/pool";
import type { SelectRowsParams } from "../../lib/db-worker/protocol";
import * as spawn from "../../lib/spawn";
import { getNarratorWorkerTestDb } from "../../services/__tests__/narrator-worker-fixture";
import type { GitStatusSummary } from "../../services/git-service";
import { ACCESS_PAGE_SIZE, GitAccessScan } from "../../services/git-workspace-access-scan";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
// Initialize the service before its existing message-module import cycle.
await import("../../services/narrator-service");
const management = await import("../../services/git-management-service");
const { narratorGitRoutes } = await import("../git");
const root = await realpath(await mkdtemp(join(testEnvironment.isolatedHome, "git-http-")));
await mkdir(join(root, ".git"));
const unrelated = `${root}-unrelated`;
const alias = `${root}-alias`;
await mkdir(unrelated);
await symlink(root, alias);
const NOW = "2026-10-24T00:00:00.000Z";
const BASE = "http://localhost/api/narrators/n1/git";
const STATUS: GitStatusSummary = {
	hasChanges: false,
	staged: 0,
	unstaged: 0,
	untracked: 0,
	files: [],
	totalFiles: 0,
	headSha: "fixture-head",
	branch: "fixture-branch",
};
const LINE_STATS: GitLineStats = { files: [], linesAdded: 0, linesRemoved: 0, complete: true };
const CANCELLED = {
	error: "Git request was cancelled",
	code: "GIT_REQUEST_CANCELLED",
	messageCode: "GIT_REQUEST_CANCELLED",
};

beforeEach(() => {
	cleanDb(sqlite);
	for (const user of ["viewer", "outsider"])
		sqlite.run(
			"INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'test-only', 'user', ?)",
			[user, user, NOW],
		);
	sqlite.run(
		"INSERT INTO narrators (id, owner_user_id, visibility, write_audience, cwd, traits, created_at, updated_at) VALUES ('n1', 'viewer', 'private', 'owner', ?, '[\"standalone\"]', ?, ?)",
		[root, NOW, NOW],
	);
});
afterEach(() => mock.restore());
afterAll(async () => {
	mock.restore();
	mock.module("../../db", () => realDbModule);
	await fixture.close();
	await rm(alias, { force: true });
	await rm(unrelated, { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
});

function appFor(user = "viewer", role: "user" | "admin" = "user") {
	const failures: Error[] = [];
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: user, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error, c) => {
		failures.push(error);
		return (
			buildAppErrorResponse(error, c) ??
			c.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500)
		);
	});
	app.route("/api/narrators", narratorGitRoutes);
	return { app, failures };
}

/** Keep real ACL/worker/scanner execution; only Git discovery and endpoint IO are fixtures. */
function observeGit() {
	const command = spyOn(spawn, "safeSpawn").mockImplementation(async ({ cmd }) => {
		if (cmd[0] !== "git" || !cmd.includes("rev-parse"))
			throw new Error("Unexpected fixture command");
		return { exitCode: 0, stdout: `true\nfalse\n${root}\n${join(root, ".git")}\n`, stderr: "" };
	});
	const status = spyOn(management, "getGitWorkspaceStatus").mockResolvedValue(STATUS);
	const lineStats = spyOn(management, "getGitWorkspaceLineStats").mockResolvedValue(LINE_STATS);
	const dispose = spyOn(GitAccessScan.prototype, "dispose");
	const processes = spyOn(Bun, "spawn");
	return { command, status, lineStats, dispose, processes };
}

function expectNoGit(io: ReturnType<typeof observeGit>) {
	expect(io.command).not.toHaveBeenCalled();
	expect(io.status).not.toHaveBeenCalled();
	expect(io.lineStats).not.toHaveBeenCalled();
	expect(io.dispose).not.toHaveBeenCalled();
	expect(io.processes).not.toHaveBeenCalled();
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitForEntry(entry: Promise<void>, response: Promise<Response>) {
	await Promise.race([
		entry,
		response.then((result) => {
			throw new Error(`Request settled before authorization gate: ${result.status}`);
		}),
	]);
}

/** Pause the first signal-bearing authorization read, then invoke the real pool. */
function gateRead(signal: AbortSignal) {
	const run = pool.runReadTask;
	const entered = deferred();
	const released = deferred();
	const settled = deferred();
	let matched = false;
	let failure: unknown;
	const spy = spyOn(pool, "runReadTask").mockImplementation(
		async <T>(...args: Parameters<typeof run>): Promise<T> => {
			if (args[2]?.signal !== signal || matched) return run<T>(...args);
			matched = true;
			entered.resolve();
			await released.promise;
			try {
				return await run<T>(...args);
			} catch (error) {
				failure = error;
				throw error;
			} finally {
				settled.resolve();
			}
		},
	);
	return {
		spy,
		release: released.resolve,
		waitForEntry: (response: Promise<Response>) => waitForEntry(entered.promise, response),
		waitForSettlement: () => (matched ? settled.promise : Promise.resolve()),
		failure: () => failure,
	};
}

async function expectHealthy(
	app: ReturnType<typeof appFor>["app"],
	endpoint: "status" | "line-stats",
) {
	const response = await app.request(`${BASE}/${endpoint}`);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(endpoint === "status" ? STATUS : LINE_STATS);
	expect(sqlite.inTransaction).toBe(false);
}

function isAccessPage(options: Parameters<typeof pool.runReadTask>[2]): boolean {
	return options?.diagnosticSource?.startsWith("git-workspace-access.") === true;
}

function forbidCallerAccessPages() {
	const prepare = sqlite.prepare.bind(sqlite);
	return spyOn(sqlite, "prepare").mockImplementation(
		(...args: Parameters<typeof sqlite.prepare>) => {
			if (/select[\s\S]*"git_path"[\s\S]*from "projects"[\s\S]*order by/i.test(args[0]))
				throw new Error("Git access pages must execute in the Worker");
			return prepare(...args);
		},
	);
}

function accessProjects(mode: "lexical" | "alias" | "owner", privateLast = false) {
	const insert = sqlite.prepare(
		"INSERT INTO projects (id, name, git_path, owner_user_id, visibility, created_at, updated_at) VALUES (?, 'ACL fixture', ?, ?, ?, ?, ?)",
	);
	try {
		for (let index = 0; index < 300; index++)
			insert.run(
				`acl-${String(index).padStart(4, "0")}`,
				mode === "lexical" ? root : mode === "alias" && index === 299 ? alias : unrelated,
				mode === "owner" ? "viewer" : null,
				mode === "owner" || (privateLast && index === 299) ? "private" : "public",
				NOW,
				NOW,
			);
	} finally {
		insert.finalize();
	}
}

describe("Git ACL Worker pagination", () => {
	for (const mode of ["lexical", "alias"] as const) {
		test(`${mode} scans every page in Workers and rechecks the final private project`, async () => {
			accessProjects(mode, true);
			const { app } = appFor();
			const io = observeGit();
			const guard = forbidCallerAccessPages();
			const reads = spyOn(pool, "runReadTask");
			const request = new Request(`${BASE}/workspace`);
			const response = await app.request(request);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				state: "access_denied",
				cwd: "",
				rootPath: null,
				capabilities: { read: false, write: false },
			});
			const pages = reads.mock.calls.filter(([, , options]) => isAccessPage(options));
			for (const source of ["lexical-projects", "alias-projects"]) {
				const sourcePages = pages.filter(
					([, , options]) => options?.diagnosticSource === `git-workspace-access.${source}`,
				);
				expect(sourcePages).toHaveLength(mode === "alias" && source === "lexical-projects" ? 1 : 3);
				if (sourcePages.length === 3) {
					expect((sourcePages[1][1] as SelectRowsParams).params).toContain("acl-0127");
					expect((sourcePages[2][1] as SelectRowsParams).params).toContain("acl-0255");
				}
			}
			for (const [, params, options] of pages) {
				expect(params.kind).toBe("selectRows");
				const page = params as SelectRowsParams;
				expect(page.maxRows).toBe(ACCESS_PAGE_SIZE);
				expect(page.params.at(-1)).toBe(ACCESS_PAGE_SIZE);
				expect(page.sql.slice(0, page.sql.indexOf(" from "))).toBe(
					'select "id", "owner_user_id", "visibility", "git_path"',
				);
				expect(options?.timeoutMs).toBeGreaterThan(0);
				expect(options?.timeoutMs).toBeLessThanOrEqual(5000);
				expect(options?.signal).not.toBe(request.signal);
				expect(options?.signal?.aborted).toBe(true);
			}
			expect(io.status).not.toHaveBeenCalled();
			expect(io.lineStats).not.toHaveBeenCalled();
			// A fresh request must observe a changed ACL, not reuse the denied verdict.
			sqlite.run("UPDATE projects SET visibility = 'public' WHERE id = 'acl-0299'");
			const allowed = await app.request(`${BASE}/workspace`);
			expect(await allowed.json()).toMatchObject({
				state: "ready",
				capabilities: { read: true, write: false },
			});
			guard.mockRestore();
		}, 30_000);
	}

	test("owner inventories stay excluded and administrators do not enumerate project pages", async () => {
		accessProjects("owner");
		observeGit();
		forbidCallerAccessPages();
		const canonicalize = spyOn(GitAccessScan.prototype, "canonicalize");
		const reads = spyOn(pool, "runReadTask");
		const owner = await appFor().app.request(`${BASE}/workspace`);
		expect(await owner.json()).toMatchObject({
			state: "ready",
			capabilities: { read: true, write: true },
		});
		for (const [rows] of canonicalize.mock.calls) expect(rows).toEqual([]);
		expect(reads.mock.calls.filter(([, , options]) => isAccessPage(options))).toHaveLength(2);
		reads.mockClear();
		canonicalize.mockClear();
		const admin = await appFor("viewer", "admin").app.request(`${BASE}/workspace`);
		expect(await admin.json()).toMatchObject({
			state: "ready",
			capabilities: { read: true, write: true },
		});
		expect(reads.mock.calls.some(([, , options]) => isAccessPage(options))).toBe(false);
		expect(canonicalize).not.toHaveBeenCalled();
	}, 30_000);

	test("unavailable Workers fail closed without an inline project query", async () => {
		const { app, failures } = appFor();
		const io = observeGit();
		forbidCallerAccessPages();
		const run = pool.runReadTask;
		const unavailable = new pool.WorkersUnavailableError("worker_unavailable");
		let pages = 0;
		spyOn(pool, "runReadTask").mockImplementation(
			async <T>(...args: Parameters<typeof run>): Promise<T> => {
				if (!isAccessPage(args[2])) return run<T>(...args);
				pages++;
				throw unavailable;
			},
		);
		const response = await app.request(`${BASE}/status`);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ code: "DB_READ_UNAVAILABLE" });
		expect(failures).toEqual([unavailable]);
		expect(pages).toBe(1);
		expect(io.status).not.toHaveBeenCalled();
		expect(io.dispose).toHaveBeenCalledTimes(1);
	}, 30_000);

	for (const stop of ["abort", "deadline"] as const) {
		test(`${stop} cancels the in-flight ACL Worker task with the scan boundary`, async () => {
			const { app } = appFor();
			const io = observeGit();
			forbidCallerAccessPages();
			const controller = new AbortController();
			const request = new Request(`${BASE}/status`, { signal: controller.signal });
			const entered = deferred();
			const settled = deferred();
			const released = deferred();
			const run = pool.runReadTask;
			let scan!: GitAccessScan;
			const readOptions = GitAccessScan.prototype.readOptions;
			spyOn(GitAccessScan.prototype, "readOptions").mockImplementation(function (
				this: GitAccessScan,
			) {
				scan = this;
				return readOptions.call(this);
			});
			let workerSignal: AbortSignal | undefined;
			let failure: unknown;
			let pages = 0;
			spyOn(pool, "runReadTask").mockImplementation(
				async <T>(...args: Parameters<typeof run>): Promise<T> => {
					if (!isAccessPage(args[2])) return run<T>(...args);
					pages++;
					workerSignal = args[2]?.signal;
					entered.resolve();
					await new Promise<void>((resolve) => {
						workerSignal?.addEventListener("abort", () => resolve(), { once: true });
						void released.promise.then(resolve);
					});
					try {
						return await run<T>(...args);
					} catch (error) {
						failure = error;
						throw error;
					} finally {
						settled.resolve();
					}
				},
			);
			const response = Promise.resolve(app.request(request));
			let clock: { mockRestore(): void } | undefined;
			try {
				await waitForEntry(entered.promise, response);
				expect(workerSignal).not.toBe(request.signal);
				expect(workerSignal?.aborted).toBe(false);
				if (stop === "abort") controller.abort(new Error("PRIVATE_CLIENT_REASON"));
				else {
					clock = spyOn(performance, "now").mockReturnValue(scan.started + 5000);
					expect(() => scan.check()).toThrow();
				}
				const result = await response;
				await settled.promise;
				expect(workerSignal?.aborted).toBe(true);
				expect(failure).toMatchObject({ code: "DB_READ_ABORTED" });
				expect(pages).toBe(1);
				expect(result.status).toBe(503);
				expect(await result.json()).toEqual({
					error: "Git workspace access check unavailable",
					code: "GIT_WORKSPACE_ACCESS_CHECK_UNAVAILABLE",
				});
				expect(io.status).not.toHaveBeenCalled();
				expect(io.dispose).toHaveBeenCalledTimes(1);
			} finally {
				clock?.mockRestore();
				controller.abort();
				released.resolve();
				await response;
				if (workerSignal) await settled.promise;
			}
		}, 30_000);
	}
});

for (const endpoint of ["status", "line-stats"] as const) {
	describe(`Git ${endpoint} HTTP cancellation`, () => {
		for (const name of ["Error", "TimeoutError"] as const) {
			test(`already cancelled HTTP signal with ${name} reason returns a safe 499`, async () => {
				const { app } = appFor();
				const io = observeGit();
				const reads = spyOn(pool, "runReadTask");
				const controller = new AbortController();
				controller.abort(
					name === "TimeoutError"
						? new DOMException("PRIVATE_CLIENT_REASON", "TimeoutError")
						: new Error("PRIVATE_CLIENT_REASON"),
				);
				const request = new Request(`${BASE}/${endpoint}`, { signal: controller.signal });
				const response = await app.request(request);
				expect(response.status).toBe(499);
				expect(await response.json()).toEqual(CANCELLED);
				// Earlier ACL reads still execute; the aborted workspace read never reaches the pool.
				expect(reads.mock.calls.length).toBeGreaterThan(0);
				expect(reads.mock.calls.some(([, , options]) => options?.signal === request.signal)).toBe(
					false,
				);
				expectNoGit(io);
				await expectHealthy(app, endpoint);
			}, 30_000);
		}

		test("cancellation during authorization translates the real pool rejection", async () => {
			const { app, failures } = appFor();
			const io = observeGit();
			const controller = new AbortController();
			const request = new Request(`${BASE}/${endpoint}`, { signal: controller.signal });
			const gate = gateRead(request.signal);
			const response = Promise.resolve(app.request(request));
			try {
				await gate.waitForEntry(response);
				expect(request.signal.aborted).toBe(false);
				controller.abort(new Error("PRIVATE_CLIENT_REASON"));
				gate.release();
				const result = await response;
				await gate.waitForSettlement();
				expect(gate.failure()).toMatchObject({ code: "DB_READ_ABORTED" });
				expect(result.status).toBe(499);
				expect(await result.json()).toEqual(CANCELLED);
				expect(failures).toHaveLength(1);
				expectNoGit(io);
			} finally {
				controller.abort();
				gate.release();
				await response;
				await gate.waitForSettlement();
				gate.spy.mockRestore();
			}
			await expectHealthy(app, endpoint);
		}, 30_000);

		test("healthy authorization reaches the endpoint and disposes the access scanner", async () => {
			const { app, failures } = appFor();
			const io = observeGit();
			await expectHealthy(app, endpoint);
			expect(failures).toHaveLength(0);
			expect(io.command).toHaveBeenCalledTimes(1);
			expect(io.dispose).toHaveBeenCalledTimes(1);
			expect(endpoint === "status" ? io.status : io.lineStats).toHaveBeenCalledTimes(1);
			expect(endpoint === "status" ? io.lineStats : io.status).not.toHaveBeenCalled();
			expect(io.processes).not.toHaveBeenCalled();
		}, 30_000);

		test("an independent service signal cannot turn a live HTTP request into cancellation", async () => {
			const { app, failures } = appFor();
			const io = observeGit();
			const request = new Request(`${BASE}/${endpoint}`);
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
			expect(failure).toMatchObject({ code: "DB_READ_ABORTED" });
			expect(request.signal.aborted).toBe(false);
			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: "Internal server error",
				code: "INTERNAL_ERROR",
			});
			expect(failures).toHaveLength(1);
			if (!(failure instanceof Error))
				throw new Error("Expected the read pool to reject with Error");
			expect(failures[0]).toBe(failure);
			expectNoGit(io);
		}, 30_000);

		for (const code of [
			undefined,
			"DB_READ_ABORTED",
			"DB_READ_FAILED",
			"DB_READ_BUDGET",
			"DB_READ_INVALID",
			"DB_READ_PROTOCOL",
			"DB_READ_TASK_TIMEOUT",
		] as const) {
			test(`${code ?? "Error"} retains its boundary when HTTP ${code === "DB_READ_ABORTED" ? "is live" : "is cancelled"}`, async () => {
				const { app, failures } = appFor();
				const io = observeGit();
				const controller = new AbortController();
				const request = new Request(`${BASE}/${endpoint}`, { signal: controller.signal });
				const failure = Object.assign(
					new Error("PRIVATE_SQL_BINDS_OR_PROTOCOL"),
					code ? { code } : {},
				);
				const run = pool.runReadTask;
				let matched = 0;
				spyOn(pool, "runReadTask").mockImplementation(
					async <T>(...args: Parameters<typeof run>): Promise<T> => {
						if (args[2]?.signal !== request.signal) return run<T>(...args);
						matched++;
						if (code !== "DB_READ_ABORTED") controller.abort(new Error("PRIVATE_CLIENT_REASON"));
						throw failure;
					},
				);
				const response = await app.request(request);
				expect(matched).toBe(1);
				expect(response.status).toBe(code === "DB_READ_TASK_TIMEOUT" ? 503 : 500);
				const body = await response.json();
				expect(body.code).toBe(code === "DB_READ_TASK_TIMEOUT" ? code : "INTERNAL_ERROR");
				expect(JSON.stringify(body)).not.toContain("PRIVATE_");
				expect(failures).toEqual([failure]);
				expectNoGit(io);
			}, 30_000);
		}

		test("scanner cancellation preserves its service boundary and removes the abort listener", async () => {
			const { app } = appFor();
			const io = observeGit();
			const controller = new AbortController();
			const request = new Request(`${BASE}/${endpoint}`, { signal: controller.signal });
			const added = spyOn(request.signal, "addEventListener");
			const removed = spyOn(request.signal, "removeEventListener");
			const entered = deferred();
			const released = deferred();
			const settled = deferred();
			const run = GitAccessScan.prototype.run;
			let matched = false;
			const scan = spyOn(GitAccessScan.prototype, "run").mockImplementation(function <T>(
				this: GitAccessScan,
				operation: () => PromiseLike<T>,
			): Promise<T> {
				if (matched) return run.call(this, operation) as Promise<T>;
				matched = true;
				return run.call(this, async () => {
					entered.resolve();
					try {
						await released.promise;
						request.signal.throwIfAborted();
						return await operation();
					} finally {
						settled.resolve();
					}
				}) as Promise<T>;
			});
			const response = Promise.resolve(app.request(request));
			try {
				await waitForEntry(entered.promise, response);
				const listener = added.mock.calls.findLast(([event]) => event === "abort");
				expect(listener).toBeDefined();
				expect(listener?.[2]).toEqual({ once: true });
				controller.abort(new Error("PRIVATE_CLIENT_REASON"));
				const result = await response;
				expect(result.status).toBe(503);
				expect(await result.json()).toEqual({
					error: "Git workspace access check unavailable",
					code: "GIT_WORKSPACE_ACCESS_CHECK_UNAVAILABLE",
				});
				expect(io.dispose).toHaveBeenCalledTimes(1);
				expect(
					removed.mock.calls.some(
						([event, callback]) => event === "abort" && callback === listener?.[1],
					),
				).toBe(true);
				expect(io.status).not.toHaveBeenCalled();
				expect(io.lineStats).not.toHaveBeenCalled();
				expect(io.processes).not.toHaveBeenCalled();
			} finally {
				released.resolve();
				await response;
				if (matched) await settled.promise;
				scan.mockRestore();
			}
			await expectHealthy(app, endpoint);
		}, 30_000);

		test("cancellation does not bypass the narrator ACL", async () => {
			const { app } = appFor("outsider");
			const io = observeGit();
			const response = await app.request(
				new Request(`${BASE}/${endpoint}`, { signal: AbortSignal.abort() }),
			);
			expect(response.status).toBe(404);
			expect((await response.json()).code).toBe("NOT_FOUND");
			expectNoGit(io);
		}, 30_000);

		test("an ordinary Git operation AbortError keeps its existing contract", async () => {
			const { app, failures } = appFor();
			const io = observeGit();
			const controller = new AbortController();
			const failure = new DOMException("PRIVATE_GIT_ABORT", "AbortError");
			const operation = endpoint === "status" ? io.status : io.lineStats;
			operation.mockImplementation(async () => {
				controller.abort();
				throw failure;
			});
			const response = await app.request(
				new Request(`${BASE}/${endpoint}`, { signal: controller.signal }),
			);
			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: "Internal server error",
				code: "INTERNAL_ERROR",
			});
			expect(failures).toEqual([failure]);
			expect(io.dispose).toHaveBeenCalledTimes(1);
			expect(io.processes).not.toHaveBeenCalled();
		}, 30_000);
	});
}
