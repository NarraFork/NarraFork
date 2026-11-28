import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { GitLineStats } from "@shared/git-line-stats";
import { Hono } from "hono";
import { testEnvironment } from "../../../tests/preload";
import { cleanDb } from "../../../tests/setup";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import * as spawn from "../../lib/spawn";
import type { GitStatusSummary } from "../../services/git-service";
import * as access from "../../services/git-workspace-access";
import { GitAccessScan } from "../../services/git-workspace-access-scan";

const { db, sqlite } = await import("../../db");
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

function gateAuthorization() {
	const run = access.authorizeGitTarget;
	const entered = deferred();
	const released = deferred();
	const settled = deferred();
	let failure: unknown;
	const spy = spyOn(access, "authorizeGitTarget").mockImplementation(async (...args) => {
		entered.resolve();
		await released.promise;
		try {
			if (args[0].req.raw.signal.aborted)
				throw Object.assign(new Error("Cancelled authorization"), { code: "DB_READ_ABORTED" });
			return await run(...args);
		} catch (error) {
			failure = error;
			throw error;
		} finally {
			settled.resolve();
		}
	});
	return {
		spy,
		release: released.resolve,
		waitForEntry: (response: Promise<Response>) => waitForEntry(entered.promise, response),
		waitForSettlement: () => settled.promise,
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

for (const endpoint of ["status", "line-stats"] as const) {
	describe(`Git ${endpoint} HTTP cancellation`, () => {
		for (const name of ["Error", "TimeoutError"] as const) {
			test(`already cancelled HTTP signal with ${name} reason returns a safe 499`, async () => {
				const { app } = appFor();
				const io = observeGit();
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
				expectNoGit(io);
				await expectHealthy(app, endpoint);
			}, 30_000);
		}

		test("cancellation during authorization translates an aborted read", async () => {
			const { app, failures } = appFor();
			const io = observeGit();
			const controller = new AbortController();
			const request = new Request(`${BASE}/${endpoint}`, { signal: controller.signal });
			const gate = gateAuthorization();
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
