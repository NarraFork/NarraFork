import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	GIT_STATUS_PAGE_MAX_BYTES,
	GIT_STATUS_PAGE_MAX_LIMIT,
	type GitStatusPageCacheState,
	type GitStatusPageResult,
	type GitStatusPageScopeProof,
	type GitStatusPageStatsResponse,
	type GitStatusPageStatsRow,
} from "@shared/git-status-page";
import { Hono } from "hono";
import { testEnvironment } from "../../../tests/preload";
import { cleanDb } from "../../../tests/setup";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import * as spawn from "../../lib/spawn";
import { closeGitStatusPages, GitStatusPageError } from "../../services/git-status-page";

const { db, sqlite } = await import("../../db");
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
await import("../../services/narrator-service");
const management = await import("../../services/git-management-service");
const { gitService } = await import("../../services/git-service");
const { narratorGitRoutes } = await import("../git");
const root = await realpath(await mkdtemp(join(testEnvironment.isolatedHome, "git-pages-http-")));
execFileSync("git", ["init", "--quiet", root], { timeout: 15_000, maxBuffer: 4096 });
const NOW = "2026-10-29T00:00:00.000Z";
const BASE = "http://localhost/api/narrators/n1/git";
const cache: GitStatusPageCacheState = {
	status: "ready",
	workerEpoch: "worker-epoch",
	memberVersion: 1,
	statsVersion: 2,
	updating: false,
};
const page: Extract<GitStatusPageResult, { status: "ready" }> = {
	status: "ready",
	cache,
	snapshotId: "snapshot",
	expiresAt: Date.now() + 120_000,
	files: [{ path: "a.ts", status: " M" }],
	nextCursor: "next",
	hasMore: true,
	complete: true,
	counts: {
		totalFiles: 2,
		staged: 0,
		unstaged: 2,
		untracked: 0,
		filteredFiles: 2,
		filteredStaged: 0,
		filteredUnstaged: 2,
		badgeCounts: { A: 0, M: 2, D: 0, R: 0, C: 0, U: 0 },
		exact: true,
	},
};
beforeEach(() => {
	cleanDb(sqlite);
	for (const user of ["reader", "outsider"])
		sqlite.run(
			"INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'test-only', 'user', ?)",
			[user, user, NOW],
		);
	sqlite.run(
		"INSERT INTO narrators (id, owner_user_id, visibility, write_audience, cwd, traits, created_at, updated_at) VALUES ('n1', 'reader', 'private', 'owner', ?, '[\"standalone\"]', ?, ?)",
		[root, NOW, NOW],
	);
	spyOn(spawn, "safeSpawn").mockImplementation(async ({ cmd }) => {
		if (cmd[0] !== "git" || !cmd.includes("rev-parse")) throw new Error("Unexpected fixture IO");
		return { exitCode: 0, stdout: `true\nfalse\n${root}\n${join(root, ".git")}\n`, stderr: "" };
	});
});
afterEach(() => mock.restore());
afterAll(async () => {
	mock.restore();
	mock.module("../../db", () => realDbModule);
	await closeGitStatusPages();
	await rm(root, { recursive: true, force: true });
});
function appFor(user = "reader") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: user, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError(
		(error, c) =>
			buildAppErrorResponse(error, c) ?? c.json({ error: "Internal server error" }, 500),
	);
	app.route("/api/narrators", narratorGitRoutes);
	return app;
}
async function workspaceKey(app: ReturnType<typeof appFor>) {
	const response = await app.request(`${BASE}/workspace`);
	expect(response.status).toBe(200);
	return (await response.json()).workspaceKey as string;
}

const statsRows: GitStatusPageStatsRow[] = [
	{ type: "directory", section: "unstaged", path: "src/中文 dir" },
	{ type: "file", section: "staged", path: "src/a.ts" },
];
const statsResult: Extract<GitStatusPageStatsResponse, { status: "ready" }> = {
	status: "ready",
	cache,
	snapshotId: "snapshot",
	rows: statsRows.map((row) => ({ ...row, added: 3, removed: 2, complete: true })),
};
function statsUrl(key: string, query: Record<string, string> = {}) {
	const search = new URLSearchParams({
		workspaceKey: key,
		snapshotId: "snapshot",
		filter: "M,A",
		rows: JSON.stringify(statsRows),
		...query,
	});
	return `${BASE}/status-page-stats?${search}`;
}

test("cold HTTP paging reads return pending without invoking background production or Git facts", async () => {
	const app = appFor();
	const key = await workspaceKey(app);
	const io = spyOn(spawn, "safeSpawn");
	const produce = spyOn(management, "observeGitWorkspaceStatusPages");
	const status = spyOn(management, "getGitWorkspaceStatus");
	const statistics = spyOn(management, "getGitWorkspaceLineStats");
	for (const suffix of ["", "&filter=M", "&filter=A"]) {
		const response = await app.request(
			`${BASE}/status-files?workspaceKey=${encodeURIComponent(key)}${suffix}`,
		);
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result).toMatchObject({
			status: "pending",
			cache: { status: "pending", memberVersion: 0, statsVersion: 0, updating: false },
		});
		expect(result).not.toHaveProperty("files");
		expect(result).not.toHaveProperty("counts");
		expect(result).not.toHaveProperty("snapshotId");
	}
	expect(produce).not.toHaveBeenCalled();
	expect(status).not.toHaveBeenCalled();
	expect(statistics).not.toHaveBeenCalled();
	expect(io.mock.calls.every(([options]) => options.cmd.includes("rev-parse"))).toBe(true);
});

for (const state of ["pending", "error"] as const) {
	test(`HTTP page and statistics reads preserve the ${state} cache DTO with status 200`, async () => {
		const app = appFor();
		const key = await workspaceKey(app);
		const result = {
			status: state,
			cache: {
				...cache,
				status: state,
				memberVersion: 0,
				statsVersion: 0,
				...(state === "error" ? { errorCode: "GIT_STATUS_PAGE_SOURCE_FAILED" } : {}),
			},
		};
		const pages = spyOn(management, "getGitWorkspaceStatusPage").mockResolvedValue(result);
		const statistics = spyOn(management, "getGitWorkspaceStatusPageStats").mockResolvedValue(
			result,
		);
		for (const url of [
			`${BASE}/status-files?workspaceKey=${encodeURIComponent(key)}`,
			statsUrl(key),
		]) {
			const response = await app.request(url);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(result);
		}
		expect(pages).toHaveBeenCalledTimes(1);
		expect(statistics).toHaveBeenCalledTimes(1);
	});
}

test("HTTP statistics failures preserve the independently ready member page", async () => {
	const app = appFor();
	const key = await workspaceKey(app);
	const member = {
		...page,
		cache: { ...cache, statsVersion: 0, statsErrorCode: "GIT_STATUS_PAGE_SOURCE_FAILED" },
	};
	const statistics: GitStatusPageStatsResponse = {
		status: "error",
		cache: { ...member.cache, status: "error" },
	};
	spyOn(management, "getGitWorkspaceStatusPage").mockResolvedValue(member);
	spyOn(management, "getGitWorkspaceStatusPageStats").mockResolvedValue(statistics);
	const memberResponse = await app.request(
		`${BASE}/status-files?workspaceKey=${encodeURIComponent(key)}`,
	);
	expect(memberResponse.status).toBe(200);
	const memberBody = await memberResponse.json();
	expect(memberBody).toEqual(member);
	expect(memberBody.cache).not.toHaveProperty("errorCode");
	const statsResponse = await app.request(statsUrl(key));
	expect(statsResponse.status).toBe(200);
	expect(await statsResponse.json()).toEqual(statistics);
});

test("cold statistics reject an unknown snapshot instead of starting measurement", async () => {
	const app = appFor();
	const key = await workspaceKey(app);
	const statistics = spyOn(management, "getGitWorkspaceLineStats");
	const produce = spyOn(management, "observeGitWorkspaceStatusPages");
	const response = await app.request(statsUrl(key));
	expect(response.status).toBe(409);
	expect((await response.json()).code).toBe("GIT_STATUS_PAGE_EXPIRED");
	expect(statistics).not.toHaveBeenCalled();
	expect(produce).not.toHaveBeenCalled();
});

for (const [code, status] of [
	["GIT_STATUS_PAGE_INVALID_CURSOR", 400],
	["GIT_STATUS_PAGE_BUSY", 429],
	["GIT_STATUS_PAGE_CLOSED", 503],
] as const) {
	test(`HTTP page and statistics transport failures preserve ${code} and status ${status}`, async () => {
		const app = appFor();
		const key = await workspaceKey(app);
		spyOn(management, "getGitWorkspaceStatusPage").mockRejectedValue(new GitStatusPageError(code));
		spyOn(management, "getGitWorkspaceStatusPageStats").mockRejectedValue(
			new GitStatusPageError(code),
		);
		for (const url of [
			`${BASE}/status-files?workspaceKey=${encodeURIComponent(key)}`,
			statsUrl(key),
		]) {
			const response = await app.request(url);
			expect(response.status).toBe(status);
			expect((await response.json()).code).toBe(code);
		}
	});
}

test("statistics uses read authorization and pins the workspace, actor, filter and request signal", async () => {
	const app = appFor();
	const key = await workspaceKey(app);
	const read = spyOn(management, "getGitWorkspaceStatusPageStats").mockResolvedValue(statsResult);
	const request = new Request(`${statsUrl(key)}&cwd=/untrusted`);
	const response = await app.request(request);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(statsResult);
	expect(read).toHaveBeenCalledTimes(1);
	const call = read.mock.calls[0];
	if (!call) throw new Error("Expected authorized statistics read");
	const [target, actorId, query, signal] = call;
	expect(target.workspace.rootPath).toBe(root);
	expect(target.workspace.workspaceKey).toBe(key);
	expect(actorId).toBe("reader");
	expect(query).toEqual({ snapshotId: "snapshot", filter: ["M", "A"], rows: statsRows });
	expect(signal).toBe(request.signal);
});

test("read-only workspace access can read statistics but cannot stage files", async () => {
	sqlite.run(
		"UPDATE narrators SET owner_user_id = 'outsider', visibility = 'public' WHERE id = 'n1'",
	);
	const app = appFor();
	const key = await workspaceKey(app);
	const read = spyOn(management, "getGitWorkspaceStatusPageStats").mockResolvedValue(statsResult);
	expect((await app.request(statsUrl(key))).status).toBe(200);
	expect(read.mock.calls[0]?.[0].workspace.capabilities).toEqual({ read: true, write: false });
	const write = await app.request(`${BASE}/stage`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ workspaceKey: key, files: ["src/a.ts"] }),
	});
	expect([403, 404]).toContain(write.status);
});

test("statistics reauthorizes cached rows after narrator access is revoked", async () => {
	const app = appFor();
	const key = await workspaceKey(app);
	const read = spyOn(management, "getGitWorkspaceStatusPageStats").mockResolvedValue(statsResult);
	expect((await app.request(statsUrl(key))).status).toBe(200);
	sqlite.run("UPDATE narrators SET owner_user_id = 'outsider' WHERE id = 'n1'");
	expect([403, 404]).toContain((await app.request(statsUrl(key))).status);
	expect(read).toHaveBeenCalledTimes(1);
});

test("statistics requires the current workspace key before reading rows", async () => {
	const app = appFor();
	const read = spyOn(management, "getGitWorkspaceStatusPageStats").mockResolvedValue(statsResult);
	expect((await app.request(statsUrl(""))).status).toBe(400);
	expect((await app.request(statsUrl("stale"))).status).toBe(409);
	expect(read).not.toHaveBeenCalled();
});

for (const [name, query] of Object.entries<Record<string, string>>({
	"empty snapshot": { snapshotId: "" },
	"oversized snapshot": { snapshotId: "s".repeat(129) },
	"invalid filter": { filter: "M,,A" },
	"invalid JSON": { rows: "[" },
	"empty rows": { rows: "[]" },
	"unknown row kind": { rows: JSON.stringify([{ ...statsRows[0], type: "folder" }]) },
	"unknown section": { rows: JSON.stringify([{ ...statsRows[0], section: "all" }]) },
	"escaping path": { rows: JSON.stringify([{ ...statsRows[0], path: "../repo" }]) },
	"internal Git path": { rows: JSON.stringify([{ ...statsRows[0], path: "src/.git/config" }]) },
	"absolute path": { rows: JSON.stringify([{ ...statsRows[0], path: "/repo" }]) },
	"oversized batch": {
		rows: JSON.stringify(Array.from({ length: GIT_STATUS_PAGE_MAX_LIMIT + 1 }, () => statsRows[0])),
	},
})) {
	test(`statistics rejects ${name} before its cache lookup`, async () => {
		const app = appFor();
		const key = await workspaceKey(app);
		const read = spyOn(management, "getGitWorkspaceStatusPageStats").mockResolvedValue(statsResult);
		expect((await app.request(statsUrl(key, query))).status).toBe(400);
		expect(read).not.toHaveBeenCalled();
	});
}

test("statistics reuses the full existing page row and byte budgets for directory batches", async () => {
	const app = appFor();
	const key = await workspaceKey(app);
	const read = spyOn(management, "getGitWorkspaceStatusPageStats").mockResolvedValue(statsResult);
	const rows = Array.from({ length: GIT_STATUS_PAGE_MAX_LIMIT }, (_, index) => ({
		type: "directory",
		section: "unstaged",
		path: `${"中文".repeat(40)}/${index}`,
	}));
	const accepted = JSON.stringify(rows);
	expect(Buffer.byteLength(accepted)).toBeGreaterThan(16 * 1024);
	expect(Buffer.byteLength(accepted)).toBeLessThan(GIT_STATUS_PAGE_MAX_BYTES);
	expect((await app.request(statsUrl(key, { rows: accepted }))).status).toBe(200);
	expect(read.mock.calls[0]?.[2].rows).toHaveLength(GIT_STATUS_PAGE_MAX_LIMIT);
	const oversized = JSON.stringify(rows.map((row) => ({ ...row, path: "文".repeat(1000) })));
	expect(Buffer.byteLength(oversized)).toBeGreaterThan(GIT_STATUS_PAGE_MAX_BYTES);
	expect((await app.request(statsUrl(key, { rows: oversized }))).status).toBe(400);
	expect(read).toHaveBeenCalledTimes(1);
});

test("statistics retains paging expiration and cancellation error semantics", async () => {
	const app = appFor();
	const key = await workspaceKey(app);
	const read = spyOn(management, "getGitWorkspaceStatusPageStats").mockRejectedValue(
		new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED"),
	);
	const expired = await app.request(statsUrl(key));
	expect(expired.status).toBe(409);
	expect((await expired.json()).code).toBe("GIT_STATUS_PAGE_EXPIRED");
	const controller = new AbortController();
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	read.mockImplementation(async (_target, _actor, _query, signal) => {
		entered();
		await new Promise<void>((resolve) =>
			signal?.addEventListener("abort", () => resolve(), { once: true }),
		);
		throw new GitStatusPageError("GIT_STATUS_PAGE_CANCELLED");
	});
	const pending = app.request(new Request(statsUrl(key), { signal: controller.signal }));
	await ready;
	controller.abort();
	const cancelled = await pending;
	expect(cancelled.status).toBe(499);
	expect((await cancelled.json()).code).toBe("GIT_STATUS_PAGE_CANCELLED");
});

test("explicit HTTP facts refresh dirties statistics without replacing status page membership", async () => {
	const app = appFor();
	const invalidated = spyOn(management, "invalidateGitWorkspaceFacts").mockImplementation(() => {});
	const pages = spyOn(management, "invalidateGitWorkspace").mockImplementation(() => {});
	spyOn(management, "getGitWorkspaceStatus").mockResolvedValue({
		hasChanges: false,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		files: [],
		totalFiles: 0,
		headSha: "",
		branch: "",
	});
	spyOn(management, "getGitWorkspaceLineStats").mockResolvedValue({
		files: [],
		linesAdded: 0,
		linesRemoved: 0,
		complete: true,
	});
	for (const endpoint of ["status", "line-stats"]) {
		expect((await app.request(`${BASE}/${endpoint}`)).status).toBe(200);
		expect((await app.request(`${BASE}/${endpoint}?fresh=1`)).status).toBe(200);
	}
	expect(invalidated).toHaveBeenCalledTimes(2);
	expect(pages).not.toHaveBeenCalled();
});

test("each page authorizes the actor and passes only the fixed workspace and bounded query", async () => {
	const app = appFor();
	const key = await workspaceKey(app);
	const read = spyOn(management, "getGitWorkspaceStatusPage").mockResolvedValue(page);
	const request = new Request(
		`${BASE}/status-files?workspaceKey=${encodeURIComponent(key)}&limit=1&filter=M,A&cursor=next&cwd=/untrusted`,
	);
	const response = await app.request(request);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(page);
	expect(read).toHaveBeenCalledTimes(1);
	const call = read.mock.calls[0];
	if (!call) throw new Error("Expected one authorized page read");
	const [target, actorId, query, signal] = call;
	expect(actorId).toBe("reader");
	expect(target.workspace.rootPath).toBe(root);
	expect(target.workspace.workspaceKey).toBe(key);
	expect(query).toEqual({ limit: 1, filter: ["M", "A"], cursor: "next" });
	expect(signal).toBe(request.signal);
});

test("cached continuation is inaccessible after narrator access is revoked", async () => {
	const app = appFor();
	const key = await workspaceKey(app);
	const read = spyOn(management, "getGitWorkspaceStatusPage").mockResolvedValue(page);
	expect(
		(await app.request(`${BASE}/status-files?workspaceKey=${encodeURIComponent(key)}`)).status,
	).toBe(200);
	sqlite.run("UPDATE narrators SET owner_user_id = 'outsider' WHERE id = 'n1'");
	const response = await app.request(
		`${BASE}/status-files?workspaceKey=${encodeURIComponent(key)}&cursor=next`,
	);
	expect([403, 404]).toContain(response.status);
	expect(read).toHaveBeenCalledTimes(1);
});

test("workspaceKey is mandatory and a stale key never reaches the paging cache", async () => {
	const app = appFor();
	const read = spyOn(management, "getGitWorkspaceStatusPage").mockResolvedValue(page);
	expect((await app.request(`${BASE}/status-files`)).status).toBe(400);
	expect((await app.request(`${BASE}/status-files?workspaceKey=stale`)).status).toBe(409);
	expect(read).not.toHaveBeenCalled();
});

for (const suffix of ["limit=201", "limit=0", "filter=Z", "filter=M,,A", "cursor="]) {
	test(`invalid paging query ${suffix} is rejected before cache lookup`, async () => {
		const app = appFor();
		const key = await workspaceKey(app);
		const read = spyOn(management, "getGitWorkspaceStatusPage").mockResolvedValue(page);
		expect(
			(await app.request(`${BASE}/status-files?workspaceKey=${encodeURIComponent(key)}&${suffix}`))
				.status,
		).toBe(400);
		expect(read).not.toHaveBeenCalled();
	});
}

test("expired cursor has an explicit 409 code, independent of generic Git failures", async () => {
	const app = appFor();
	const key = await workspaceKey(app);
	spyOn(management, "getGitWorkspaceStatusPage").mockRejectedValue(
		new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED"),
	);
	const response = await app.request(
		`${BASE}/status-files?workspaceKey=${encodeURIComponent(key)}&cursor=expired`,
	);
	expect(response.status).toBe(409);
	expect((await response.json()).code).toBe("GIT_STATUS_PAGE_EXPIRED");
});

test("scoped stage validates the authenticated complete range before dispatching a write", async () => {
	const app = appFor();
	const key = await workspaceKey(app);
	const trace: string[] = [];
	const assert = spyOn(management, "assertGitWorkspaceStatusPageScope").mockImplementation(
		async () => {
			trace.push("assert");
		},
	);
	const stage = mock(async () => {
		trace.push("write");
	});
	spyOn(management, "gitManagementService").mockReturnValue({ ...gitService, stageFiles: stage });
	spyOn(management, "getGitWorkspaceStatus").mockResolvedValue({
		hasChanges: false,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		files: [],
		totalFiles: 0,
		headSha: "",
		branch: "",
	});
	const snapshotScope: GitStatusPageScopeProof = {
		snapshotId: "snapshot",
		filter: ["M"],
		section: "unstaged",
		directory: "src",
	};
	const response = await app.request(`${BASE}/stage`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ workspaceKey: key, files: ["src/a.ts"], snapshotScope }),
	});
	expect(response.status).toBe(200);
	expect(trace).toEqual(["assert", "write"]);
	expect(assert.mock.calls[0]?.[1]).toBe("reader");
	expect(assert.mock.calls[0]?.[2]).toEqual(snapshotScope);
	expect(assert.mock.calls[0]?.[3]).toEqual(["src/a.ts"]);
	expect(stage).toHaveBeenCalledTimes(1);
});

test("an evicted, partial or changed scope returns 409 without executing its write", async () => {
	const app = appFor();
	const key = await workspaceKey(app);
	spyOn(management, "assertGitWorkspaceStatusPageScope").mockRejectedValue(
		new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED"),
	);
	const stage = mock(async () => {});
	spyOn(management, "gitManagementService").mockReturnValue({ ...gitService, stageFiles: stage });
	const response = await app.request(`${BASE}/stage`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			workspaceKey: key,
			files: ["a.ts"],
			snapshotScope: { snapshotId: "expired", filter: ["M"], section: "unstaged" },
		}),
	});
	expect(response.status).toBe(409);
	expect((await response.json()).code).toBe("GIT_STATUS_PAGE_EXPIRED");
	expect(stage).not.toHaveBeenCalled();
});

test("a scoped action cannot substitute a proof for its opposite partition", async () => {
	const app = appFor();
	const key = await workspaceKey(app);
	const assert = spyOn(management, "assertGitWorkspaceStatusPageScope").mockResolvedValue(
		undefined,
	);
	const stage = mock(async () => {});
	spyOn(management, "gitManagementService").mockReturnValue({ ...gitService, stageFiles: stage });
	const response = await app.request(`${BASE}/stage`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			workspaceKey: key,
			files: ["a.ts"],
			snapshotScope: { snapshotId: "snapshot", filter: ["M"], section: "staged" },
		}),
	});
	expect(response.status).toBe(400);
	expect(assert).not.toHaveBeenCalled();
	expect(stage).not.toHaveBeenCalled();
});

test("single-file and unfiltered all writes retain their proof-free semantics", async () => {
	const app = appFor();
	const key = await workspaceKey(app);
	const assert = spyOn(management, "assertGitWorkspaceStatusPageScope").mockResolvedValue(
		undefined,
	);
	const stage = mock(async () => {});
	const stageAll = mock(async () => {});
	spyOn(management, "gitManagementService").mockReturnValue({
		...gitService,
		stageFiles: stage,
		stageAll,
	});
	spyOn(management, "getGitWorkspaceStatus").mockResolvedValue({
		hasChanges: false,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		files: [],
		totalFiles: 0,
		headSha: "",
		branch: "",
	});
	for (const action of [{ files: ["a.ts"] }, { all: true }]) {
		const response = await app.request(`${BASE}/stage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ workspaceKey: key, ...action }),
		});
		expect(response.status).toBe(200);
	}
	expect(assert).not.toHaveBeenCalled();
	expect(stage).toHaveBeenCalledTimes(1);
	expect(stageAll).toHaveBeenCalledTimes(1);
});

test("request cancellation reaches the page source and preserves the cancellation code", async () => {
	const app = appFor();
	const key = await workspaceKey(app);
	const controller = new AbortController();
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	spyOn(management, "getGitWorkspaceStatusPage").mockImplementation(
		async (_target, _actor, _query, signal) => {
			entered();
			await new Promise<void>((resolve) =>
				signal?.addEventListener("abort", () => resolve(), { once: true }),
			);
			throw new GitStatusPageError("GIT_STATUS_PAGE_CANCELLED");
		},
	);
	const pending = app.request(
		new Request(`${BASE}/status-files?workspaceKey=${encodeURIComponent(key)}`, {
			signal: controller.signal,
		}),
	);
	await ready;
	controller.abort();
	const response = await pending;
	expect(response.status).toBe(499);
	expect((await response.json()).code).toBe("GIT_STATUS_PAGE_CANCELLED");
});
