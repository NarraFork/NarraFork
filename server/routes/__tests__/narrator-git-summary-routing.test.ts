import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { testEnvironment } from "../../../tests/preload";
import { cleanDb } from "../../../tests/setup";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import * as spawn from "../../lib/spawn";
import { gitDiscoveryCache } from "../../services/git-discovery-cache";
import type { GitStatusSummary } from "../../services/git-service";

const { db, sqlite } = await import("../../db");
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
await import("../../services/narrator-service");
const { executionPolicyEngine } = await import("../../services/execution-policy/engine");
const acl = await import("../../services/narrator-acl");
const access = await import("../../services/git-workspace-access");
const management = await import("../../services/git-management-service");
const { narratorGitRoutes } = await import("../git");
const { narratorRoutes } = await import("../narrators");
const root = await realpath(await mkdtemp(join(testEnvironment.isolatedHome, "git-summary-http-")));
await mkdir(join(root, ".git"));
const NOW = "2026-10-30T00:00:00.000Z";
const BASE = "/api/narrators/n1/git";
const CANCELLED = {
	error: "Git request was cancelled",
	code: "GIT_REQUEST_CANCELLED",
	messageCode: "GIT_REQUEST_CANCELLED",
};
const STATUS: GitStatusSummary = {
	hasChanges: false,
	staged: 0,
	unstaged: 0,
	untracked: 0,
	files: [],
	totalFiles: 0,
	headSha: "fixture-head",
	branch: "main",
};

beforeEach(() => {
	cleanDb(sqlite);
	gitDiscoveryCache.invalidate("local", root);
	executionPolicyEngine.invalidate("n1");
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
	await rm(root, { recursive: true, force: true });
});

function appFor(user = "viewer", mount = "/api/narrators") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: user, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError(
		(error, c) =>
			buildAppErrorResponse(error, c) ??
			c.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500),
	);
	// Match production registration order: Git's wildcard middleware runs first.
	app.route(mount, narratorGitRoutes);
	app.route(mount, narratorRoutes);
	return app;
}

/** Only subprocess IO is controlled; discovery, its cache, ACLs and Workers remain real. */
function observeGit(onProbe?: () => void) {
	const command = spyOn(spawn, "safeSpawn").mockImplementation(async ({ cmd }) => {
		if (cmd[0] !== "git") throw new Error("Unexpected fixture command");
		if (cmd.includes("rev-parse")) {
			onProbe?.();
			return { exitCode: 0, stdout: `true\nfalse\n${root}\n${join(root, ".git")}\n`, stderr: "" };
		}
		if (cmd.includes("symbolic-ref")) return { exitCode: 0, stdout: "main\n", stderr: "" };
		if (cmd.includes("add")) return { exitCode: 0, stdout: "", stderr: "" };
		throw new Error(`Unexpected fixture Git command: ${cmd.join(" ")}`);
	});
	const status = spyOn(management, "getGitWorkspaceStatus").mockResolvedValue(STATUS);
	const authorize = spyOn(access, "authorizeGitTarget");
	const ready = spyOn(access, "requireReadyGitTarget");
	const aclReads = spyOn(acl, "loadNarratorForAccess");
	return {
		command,
		status,
		authorize,
		ready,
		aclReads,
		probes: () => command.mock.calls.filter(([options]) => options.cmd.includes("rev-parse")),
		branches: () => command.mock.calls.filter(([options]) => options.cmd.includes("symbolic-ref")),
		writes: () => command.mock.calls.filter(([options]) => options.cmd.includes("add")),
	};
}

function denyDirectory() {
	sqlite.run(
		"INSERT INTO narrator_blacklist_dirs (id, narrator_id, path, deny_level, enabled, target_kind, created_at) VALUES ('deny-root', 'n1', ?, 'denyAll', 1, 'host', ?)",
		[root, NOW],
	);
	executionPolicyEngine.invalidate("n1");
}

function post(body: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};
}

describe("deferred Git summary with production router order", () => {
	test("cold summary probes once; hot summary reauthorizes without any subprocess", async () => {
		const io = observeGit();
		const app = appFor();
		const cold = await app.request(`${BASE}/summary`);
		expect(cold.status).toBe(200);
		expect(await cold.json()).toMatchObject({
			revision: 0,
			branch: "main",
			workspace: { state: "ready", rootPath: root, capabilities: { read: true, write: true } },
		});
		expect(io.probes()).toHaveLength(1);
		expect(io.branches()).toHaveLength(1);
		const reads = io.aclReads.mock.calls.length;
		const hot = await app.request(`${BASE}/summary?fresh=1&workspaceKey=ignored-display-key`);
		expect(hot.status).toBe(200);
		expect(await hot.json()).toMatchObject({ revision: 0, branch: "main" });
		expect(io.aclReads.mock.calls.length).toBeGreaterThanOrEqual(reads + 3);
		expect(io.probes()).toHaveLength(1);
		expect(io.branches()).toHaveLength(1);
		expect(io.authorize).not.toHaveBeenCalled();
		expect(io.ready).not.toHaveBeenCalled();
		expect(io.status).not.toHaveBeenCalled();
		expect(io.writes()).toHaveLength(0);
	});

	test("exact summary routing is independent of the router mount", async () => {
		const io = observeGit();
		const response = await appFor("viewer", "/narrators").request("/narrators/n1/git/summary");
		expect(response.status).toBe(200);
		expect(io.probes()).toHaveLength(1);
		expect(io.authorize).not.toHaveBeenCalled();
	});

	test("private narrator denial starts no discovery, including a cancelled request", async () => {
		const io = observeGit();
		for (const signal of [undefined, AbortSignal.abort()]) {
			const response = await appFor("outsider").request(`${BASE}/summary`, { signal });
			expect(response.status).toBe(404);
			expect((await response.json()).code).toBe("NOT_FOUND");
		}
		expect(io.command).not.toHaveBeenCalled();
	});

	test("policy denial runs before discovery and keeps summary redaction and status 403", async () => {
		denyDirectory();
		const io = observeGit();
		const app = appFor();
		const summary = await app.request(`${BASE}/summary`);
		expect(summary.status).toBe(200);
		expect(await summary.json()).toMatchObject({
			branch: null,
			workspace: { state: "access_denied", rootPath: null, cwd: "", workspaceKey: null },
		});
		const status = await app.request(`${BASE}/status`);
		expect(status.status).toBe(403);
		expect(io.command).not.toHaveBeenCalled();
		expect(io.status).not.toHaveBeenCalled();
	});

	test("hot filesystem facts cannot retain a revoked narrator authorization", async () => {
		const io = observeGit();
		const app = appFor();
		expect((await app.request(`${BASE}/summary`)).status).toBe(200);
		sqlite.run("UPDATE narrators SET owner_user_id = 'outsider' WHERE id = 'n1'");
		const response = await app.request(`${BASE}/summary`);
		expect(response.status).toBe(404);
		expect(io.probes()).toHaveLength(1);
	});

	test("hot filesystem facts still recheck related project access", async () => {
		const io = observeGit();
		const app = appFor();
		expect((await app.request(`${BASE}/summary`)).status).toBe(200);
		sqlite.run(
			"INSERT INTO projects (id, name, git_path, owner_user_id, visibility, created_at, updated_at) VALUES ('p1', 'Private repository', ?, 'outsider', 'private', ?, ?)",
			[root, NOW, NOW],
		);
		const response = await app.request(`${BASE}/summary`);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			branch: null,
			workspace: { state: "access_denied", rootPath: null, cwd: "", workspaceKey: null },
		});
		expect(io.probes()).toHaveLength(1);
	});

	test("a revision changed during discovery returns a nullable summary", async () => {
		const io = observeGit(() => {
			sqlite.run("UPDATE narrators SET workspace_revision = 1 WHERE id = 'n1'");
		});
		const response = await appFor().request(`${BASE}/summary`);
		expect(response.status).toBe(200);
		expect(await response.json()).toBeNull();
		expect(io.probes()).toHaveLength(1);
	});

	test("access withdrawn during discovery is checked again before returning facts", async () => {
		const io = observeGit(() => {
			sqlite.run("UPDATE narrators SET owner_user_id = 'outsider' WHERE id = 'n1'");
		});
		const response = await appFor().request(`${BASE}/summary`);
		expect(response.status).toBe(404);
		expect(io.probes()).toHaveLength(1);
	});

	for (const reason of [undefined, new Error("PRIVATE_CLIENT_REASON")]) {
		test(`pre-cancelled summary keeps Git cancellation mapping (${reason ? "custom" : "default"})`, async () => {
			const io = observeGit();
			const response = await appFor().request(`${BASE}/summary`, {
				signal: AbortSignal.abort(reason),
			});
			expect(response.status).toBe(499);
			expect(await response.json()).toEqual(CANCELLED);
			expect(io.command).not.toHaveBeenCalled();
		});
	}

	test("summary cancelled during discovery keeps Git cancellation mapping", async () => {
		const controller = new AbortController();
		observeGit(() => controller.abort(new Error("PRIVATE_CLIENT_REASON")));
		const response = await appFor().request(`${BASE}/summary`, { signal: controller.signal });
		expect(response.status).toBe(499);
		expect(await response.json()).toEqual(CANCELLED);
		expect((await appFor().request(`${BASE}/summary`)).status).toBe(200);
	});

	test("workspace and status retain authoritative discovery and workspace validation", async () => {
		const io = observeGit();
		const app = appFor();
		expect((await app.request(`${BASE}/summary`)).status).toBe(200);
		expect((await app.request(`${BASE}/workspace`)).status).toBe(200);
		expect((await app.request(`${BASE}/status?workspaceKey=stale`)).status).toBe(409);
		expect(io.status).not.toHaveBeenCalled();
		const status = await app.request(`${BASE}/status`);
		expect(status.status).toBe(200);
		expect(await status.json()).toEqual(STATUS);
		expect(io.probes()).toHaveLength(4);
		expect(io.authorize).toHaveBeenCalledTimes(3);
		expect(io.ready).toHaveBeenCalledTimes(1);
	});

	test("stage retains workspace-key checks and beforeWrite reauthorization", async () => {
		const io = observeGit();
		const app = appFor();
		const workspace = await (await app.request(`${BASE}/workspace`)).json();
		expect(
			(await app.request(`${BASE}/stage`, post({ all: true, workspaceKey: "stale" }))).status,
		).toBe(409);
		expect(io.writes()).toHaveLength(0);
		io.authorize.mockClear();
		const response = await app.request(
			`${BASE}/stage`,
			post({ all: true, workspaceKey: workspace.workspaceKey }),
		);
		expect(response.status).toBe(200);
		expect(io.authorize).toHaveBeenCalledTimes(2);
		for (const [, , need] of io.authorize.mock.calls) expect(need).toBe("write");
		expect(io.writes()).toHaveLength(1);
	});

	test("nested lookalikes and non-GET summary requests retain Git middleware", async () => {
		const io = observeGit();
		const app = appFor();
		for (const path of ["summary/extra", "nested/git/summary", "summary-other"]) {
			const response = await app.request(`${BASE}/${path}?workspaceKey=stale`);
			expect(response.status).toBe(409);
		}
		for (const method of ["POST", "HEAD"]) {
			// Hono dispatches HEAD to GET handlers but preserves the raw request method.
			const response = await app.request(`${BASE}/summary`, { method });
			expect(response.status).toBe(400);
			if (method === "HEAD") expect(await response.text()).toBe("");
		}
		expect(io.authorize).toHaveBeenCalledTimes(5);
		expect(io.probes()).toHaveLength(5);
		expect(io.branches()).toHaveLength(0);
		expect(io.status).not.toHaveBeenCalled();
	});
});
