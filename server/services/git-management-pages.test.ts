import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitLineStats } from "@shared/git-line-stats";
import type { GitStatusPageQuery, GitStatusPageStatsQuery } from "@shared/git-status-page";
import { testEnvironment } from "../../tests/preload";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import type {
	GitWorkspaceRequest,
	GitWorkspaceResult,
} from "../lib/agent/execution/git-workspace-rpc";
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";
import * as spawn from "../lib/spawn";
import * as lineStats from "./git-line-stats";
import {
	assertGitWorkspaceStatusPageScope,
	getGitWorkspaceLineStats,
	getGitWorkspaceStatusPage,
	getGitWorkspaceStatusPageStats,
	getGitWorkspaceStatusPagesCacheState,
	invalidateGitWorkspace,
	invalidateGitWorkspaceFacts,
	observeGitWorkspaceStatusPages,
	releaseGitWorkspaceStatusPages,
	validateFilePaths,
	validateGitFileTargets,
	validateGitWorkspaceStatusPages,
} from "./git-management-service";
import { closeGitStatusPages } from "./git-status-page";
import type { GitWorkspaceTarget } from "./git-workspace";
import { boundGitSnapshot, GitWorkspaceWatchPool } from "./git-workspace-watch";

let nextFixture = 0;
test("Unix colon filenames survive authorization while Windows drive paths remain rejected", async () => {
	const { target } = fixture(complete(0));
	await validateGitFileTargets(target, ["a:b.txt"]);
	for (const path of ["C:/outside", "C:\\outside", "../outside"])
		await expect(validateGitFileTargets(target, [path])).rejects.toThrow("Invalid file path");
	const windows = {
		...target,
		backend: { ...target.backend, pathFlavor: "windows" },
	} as GitWorkspaceTarget;
	await expect(validateGitFileTargets(windows, ["a:b.txt"])).rejects.toThrow("Invalid file path");
});

test("whole observation authorization admits 1001 paths without raising the ordinary write limit", async () => {
	const { target } = fixture(complete(0));
	const paths = Array.from({ length: 1001 }, (_, index) => `file-${index}`);
	await validateGitFileTargets(target, paths, 20_000);
	expect(() => validateFilePaths(paths)).toThrow("Too many file paths");
	await expect(validateGitFileTargets(target, [...paths, "../escape"], 20_000)).rejects.toThrow(
		"Invalid file path",
	);
	await expect(
		validateGitFileTargets(
			target,
			Array.from({ length: 20_001 }, (_, index) => `file-${index}`),
			20_000,
		),
	).rejects.toThrow("Too many file paths");
});

async function rejected(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => null,
		(error: unknown) => error,
	);
}
function fixture(response: GitWorkspaceResult, modern = true) {
	const id = ++nextFixture;
	const calls: { request: GitWorkspaceRequest; signal?: AbortSignal }[] = [];
	const backend = {
		kind: "remote",
		pathFlavor: "posix",
		deviceId: `page-device-${id}`,
		runtimeGeneration: 7,
		paths: targetPathSemantics("posix"),
		supportsGitWorkspace: true,
		supportsGitWorkspaceWatch: true,
		supportsGitWorkspaceStatus: modern,
		supportsGitLineStats: true,
		async gitWorkspace(request: GitWorkspaceRequest, signal?: AbortSignal) {
			calls.push({ request, signal });
			return response;
		},
	} as unknown as ExecutionBackend;
	const target = {
		backend,
		workspace: {
			deviceId: backend.deviceId,
			cwd: `/repo-${id}`,
			rootPath: `/repo-${id}`,
			workspaceKey: `workspace-${id}`,
		},
	} as GitWorkspaceTarget;
	return {
		target,
		calls,
		respond: (result: GitWorkspaceResult) => {
			response = result;
		},
	};
}
const raw = (count: number) =>
	Array.from({ length: count }, (_, index) => `?? file-${index}\0`).join("");
const complete = (count: number): GitWorkspaceResult => ({
	outputs: { status: raw(count) },
	totalFilesExact: true,
	truncated: false,
	lineStats: { files: [], linesAdded: 0, linesRemoved: 0, complete: true },
});
afterAll(async () => {
	await closeGitStatusPages();
	await lineStats.closeGitLineStatsWorkers();
});

function measured(count: number, added: number): GitWorkspaceResult {
	return {
		...complete(count),
		lineStats: {
			files: Array.from({ length: count }, (_, index) => ({
				path: `file-${index}`,
				unstagedLinesAdded: added,
				unstagedLinesRemoved: 1,
				complete: true,
			})),
			linesAdded: added * count,
			linesRemoved: count,
			complete: true,
		},
	};
}
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function produce(target: GitWorkspaceTarget, signal = new AbortController().signal) {
	const pinned = { ...target, workspace: { ...target.workspace } };
	return observeGitWorkspaceStatusPages(pinned, signal, (readSignal) =>
		getGitWorkspaceLineStats(pinned, readSignal, 0),
	);
}
async function readyPage(
	target: GitWorkspaceTarget,
	actorId = "reader",
	query: GitStatusPageQuery = {},
	signal?: AbortSignal,
) {
	const result = await getGitWorkspaceStatusPage(target, actorId, query, signal);
	expect(result.status).toBe("ready");
	if (result.status !== "ready") throw new Error("Expected a published status page");
	return result;
}
async function readyStats(target: GitWorkspaceTarget, query: GitStatusPageStatsQuery) {
	const result = await getGitWorkspaceStatusPageStats(target, "reader", query);
	expect(result.status).toBe("ready");
	if (result.status !== "ready") throw new Error("Expected published page statistics");
	return result;
}
async function expectCode(promise: Promise<unknown>, code: string) {
	const result = await promise.catch((error: unknown) => error);
	expect(result).toMatchObject({ code });
}
function statsQuery(snapshotId: string): GitStatusPageStatsQuery {
	return {
		snapshotId,
		rows: [{ type: "file", section: "unstaged", path: "file-2" }],
	};
}
function watchReads() {
	return {
		status: async () => ({
			hasChanges: true,
			staged: 0,
			unstaged: 0,
			untracked: 3,
			files: [],
			totalFiles: 3,
			headSha: "",
			branch: "",
		}),
		lineStats: getGitWorkspaceLineStats,
		invalidate: invalidateGitWorkspace,
		invalidateFacts: invalidateGitWorkspaceFacts,
		validate: () => {},
		validatePages: validateGitWorkspaceStatusPages,
		observePages: observeGitWorkspaceStatusPages,
		pagesState: getGitWorkspaceStatusPagesCacheState,
	};
}

test("cold page GETs report pending without reading Git or fabricating an empty page", async () => {
	const { target, calls } = fixture(measured(561, 4));
	for (const filter of [[], ["A"], ["M"]] as const) {
		const result = await getGitWorkspaceStatusPage(target, "reader", { filter: [...filter] });
		expect(result).toMatchObject({
			status: "pending",
			cache: { status: "pending", memberVersion: 0, statsVersion: 0, updating: false },
		});
		expect(result).not.toHaveProperty("files");
		expect(result).not.toHaveProperty("counts");
		expect(result).not.toHaveProperty("snapshotId");
	}
	expect(calls).toEqual([]);
	await expectCode(
		getGitWorkspaceStatusPageStats(target, "reader", statsQuery("unknown")),
		"GIT_STATUS_PAGE_EXPIRED",
	);
	expect(calls).toEqual([]);
});

test("the producer pins its authorized remote target and publishes full statistics once", async () => {
	const { target, calls } = fixture(measured(561, 4));
	const original = { ...target, workspace: { ...target.workspace } };
	const pending = produce(target);
	target.backend = {
		...target.backend,
		runtimeGeneration: 8,
		gitWorkspace: async () => {
			throw new Error("Replaced target must not be consulted");
		},
	} as ExecutionBackend;
	target.workspace = { ...target.workspace, rootPath: "/replaced" };
	const cache = await pending;
	const first = await readyPage(original, "reader", { limit: 1 });
	const query = statsQuery(first.snapshotId);
	const result = await readyStats(original, query);
	expect(result).toMatchObject({
		status: "ready",
		snapshotId: first.snapshotId,
		rows: [{ ...query.rows[0], added: 4, removed: 1, complete: true }],
		cache,
	});
	await readyStats(original, query);
	await readyPage(original, "another-reader", { filter: ["A"] });
	expect(calls.map(({ request }) => request.operation)).toEqual(["status", "lineStats"]);
	for (const call of calls) {
		expect(call.request).toMatchObject({
			cwd: original.workspace.rootPath,
			expectedRoot: original.workspace.rootPath,
		});
		expect(call.signal).toBeInstanceOf(AbortSignal);
	}
});

test("real measurements of 254 untracked files reach directory and terminal-page cache GETs before the 200-row WebSocket projection", async () => {
	const root = await realpath(
		await mkdtemp(join(testEnvironment.isolatedHome, "git-pages-full-stats-")),
	);
	const target = {
		backend: {
			kind: "local",
			deviceId: "local",
			paths: targetPathSemantics(process.platform === "win32" ? "windows" : "posix"),
		} as ExecutionBackend,
		workspace: {
			deviceId: "local",
			cwd: root,
			rootPath: root,
			workspaceKey: `full-stats-${++nextFixture}`,
		},
	} as GitWorkspaceTarget;
	const measure = spyOn(lineStats, "getGitLineStats");
	let io: ReturnType<typeof spyOn<typeof spawn, "safeSpawn">> | undefined;
	try {
		const initialized = await spawn.safeSpawn({
			cmd: ["git", "init", "-q", "-b", "main"],
			cwd: root,
			timeout: 15_000,
		});
		expect(initialized.exitCode).toBe(0);
		await mkdir(join(root, "src", "complete"), { recursive: true });
		const paths = Array.from(
			{ length: 254 },
			(_, index) => `src/complete/file-${String(index).padStart(4, "0")}.txt`,
		);
		await Promise.all(
			paths.map((path, index) =>
				writeFile(join(root, path), "line\n".repeat(index === 253 ? 7 : 2)),
			),
		);
		expect((await getGitWorkspaceStatusPage(target, "reader", { limit: 200 })).status).toBe(
			"pending",
		);
		expect(measure).not.toHaveBeenCalled();
		let full: GitLineStats | undefined;
		const cache = await observeGitWorkspaceStatusPages(
			target,
			new AbortController().signal,
			async (signal) => {
				full = await lineStats.getGitLineStats(root, signal);
				return full;
			},
		);
		if (!full) throw new Error("Expected a real full-repository line measurement");
		expect(full).toMatchObject({ complete: true, linesAdded: 513, linesRemoved: 0 });
		expect(full.files).toHaveLength(254);
		const projected = boundGitSnapshot({
			revision: 1,
			updating: false,
			statusPages: cache,
			status: {
				hasChanges: true,
				staged: 0,
				unstaged: 0,
				untracked: 254,
				totalFiles: 254,
				headSha: "",
				branch: "main",
				files: paths.map((path) => ({ path, status: "??" })),
			},
			lineStats: full,
		});
		expect(projected.lineStats?.files).toHaveLength(200);
		expect(projected.detailsTruncated).toBe(true);
		expect(projected.lineStats?.files?.some((file) => file.path === paths[253])).toBe(false);
		io = spyOn(spawn, "safeSpawn");
		const first = await readyPage(target, "reader", { limit: 200 });
		expect(first.files).toHaveLength(200);
		expect(first.hasMore).toBe(true);
		expect(first.counts).toMatchObject({ totalFiles: 254, filteredFiles: 254, exact: true });
		const last = await readyPage(target, "reader", {
			limit: 200,
			cursor: first.nextCursor ?? undefined,
		});
		expect(last.snapshotId).toBe(first.snapshotId);
		expect(last.files).toHaveLength(54);
		expect(last.files[0]?.path).toBe(paths[200]);
		expect(last.files.at(-1)?.path).toBe(paths[253]);
		expect(last.hasMore).toBe(false);
		const rows: GitStatusPageStatsQuery["rows"] = [
			{ type: "directory", section: "unstaged", path: "src/complete" },
			{ type: "file", section: "unstaged", path: paths[200] ?? "" },
			{ type: "file", section: "unstaged", path: paths[253] ?? "" },
		];
		const statistics = await readyStats(target, { snapshotId: last.snapshotId, rows });
		expect(statistics.rows).toEqual([
			{ ...rows[0], added: 513, removed: 0, complete: true },
			{ ...rows[1], added: 2, removed: 0, complete: true },
			{ ...rows[2], added: 7, removed: 0, complete: true },
		]);
		expect(statistics.cache).toEqual(cache);
		expect(measure).toHaveBeenCalledTimes(1);
		expect(io).not.toHaveBeenCalled();
	} finally {
		io?.mockRestore();
		measure.mockRestore();
		releaseGitWorkspaceStatusPages(target);
		await rm(root, { recursive: true, force: true });
	}
});

test("facts changes retain last-good statistics until the producer publishes a newer version", async () => {
	const { target, calls, respond } = fixture(measured(3, 2));
	await produce(target);
	const first = await readyPage(target, "reader", { limit: 1 });
	const query = statsQuery(first.snapshotId);
	expect((await readyStats(target, query)).rows[0]?.added).toBe(2);
	respond(measured(3, 9));
	invalidateGitWorkspaceFacts(target);
	const stale = await readyStats(target, query);
	expect(stale.rows[0]?.added).toBe(2);
	expect(stale.cache).toMatchObject({ updating: true, statsVersion: first.cache.statsVersion });
	expect(calls).toHaveLength(2);
	await produce(target);
	const fresh = await readyStats(target, query);
	expect(fresh.rows[0]?.added).toBe(9);
	expect(fresh.cache.statsVersion).toBeGreaterThan(stale.cache.statsVersion);
	const next = await readyPage(target, "reader", {
		limit: 1,
		cursor: first.nextCursor ?? undefined,
	});
	expect(next.snapshotId).toBe(first.snapshotId);
	expect(next.cache.memberVersion).toBe(first.cache.memberVersion);
	expect(calls.map(({ request }) => request.operation)).toEqual([
		"status",
		"lineStats",
		"status",
		"lineStats",
	]);
	invalidateGitWorkspace(target);
	expect((await readyStats(target, query)).rows[0]?.added).toBe(9);
	respond(measured(4, 9));
	await produce(target);
	expect(await rejected(getGitWorkspaceStatusPageStats(target, "reader", query))).toMatchObject({
		code: "GIT_STATUS_PAGE_EXPIRED",
	});
});

test("statistics reject cross-actor, workspace, generation, filter and unknown identities before IO", async () => {
	const { target, calls } = fixture(measured(3, 2));
	await produce(target);
	const first = await readyPage(target, "reader", { filter: ["A"] });
	const query = { ...statsQuery(first.snapshotId), filter: ["A"] as "A"[] };
	for (const [candidate, actorId, candidateQuery] of [
		[target, "other", query],
		[{ ...target, workspace: { ...target.workspace, workspaceKey: "other" } }, "reader", query],
		[
			{ ...target, backend: { ...target.backend, runtimeGeneration: 8 } as ExecutionBackend },
			"reader",
			query,
		],
		[target, "reader", { ...query, filter: ["M"] }],
		[target, "reader", { ...query, snapshotId: "unknown" }],
	] as [GitWorkspaceTarget, string, GitStatusPageStatsQuery][]) {
		await expectCode(
			getGitWorkspaceStatusPageStats(candidate, actorId, candidateQuery),
			"GIT_STATUS_PAGE_EXPIRED",
		);
	}
	expect(calls.map(({ request }) => request.operation)).toEqual(["status", "lineStats"]);
});

test("unsupported remote statistics expose an error without a local or status fallback", async () => {
	const { target, calls } = fixture(measured(3, 2));
	target.backend = { ...target.backend, supportsGitLineStats: false } as ExecutionBackend;
	await produce(target);
	const first = await readyPage(target);
	const result = await getGitWorkspaceStatusPageStats(
		target,
		"reader",
		statsQuery(first.snapshotId),
	);
	expect(first.cache).toMatchObject({ status: "ready", statsVersion: 0 });
	expect(first.cache.memberVersion).toBeGreaterThan(0);
	expect(first.cache).not.toHaveProperty("errorCode");
	expect(result).toMatchObject({
		status: "error",
		cache: { status: "error", statsVersion: 0, statsErrorCode: "GIT_STATUS_PAGE_SOURCE_FAILED" },
	});
	expect(result.cache.memberVersion).toBe(first.cache.memberVersion);
	expect(result.cache).not.toHaveProperty("errorCode");
	expect(result).not.toHaveProperty("rows");
	expect(calls.map(({ request }) => request.operation)).toEqual(["status"]);
});

test("facts invalidation during production prevents publishing old statistics", async () => {
	const { target } = fixture(measured(3, 2));
	await produce(target);
	const first = await readyPage(target);
	const entered = deferred();
	const measurement = deferred<GitWorkspaceResult>();
	const backend = target.backend;
	target.backend = {
		...backend,
		gitWorkspace: async (request: GitWorkspaceRequest) => {
			if (request.operation === "status") return complete(3);
			entered.resolve();
			return measurement.promise;
		},
	} as ExecutionBackend;
	const pending = produce(target);
	await entered.promise;
	invalidateGitWorkspaceFacts(target);
	measurement.resolve(measured(3, 9));
	await expectCode(pending, "GIT_STATUS_PAGE_EXPIRED");
	expect((await readyStats(target, statsQuery(first.snapshotId))).rows[0]?.added).toBe(2);
});

test("producer cancellation reaches its shared statistics source while cached GETs remain readable", async () => {
	const { target } = fixture(measured(3, 2));
	await produce(target);
	const first = await readyPage(target);
	const entered = deferred();
	const sourceAborted = deferred();
	const measurement = deferred<GitWorkspaceResult>();
	const readSignals: AbortSignal[] = [];
	target.backend = {
		...target.backend,
		gitWorkspace: async (request: GitWorkspaceRequest, signal?: AbortSignal) => {
			if (request.operation === "status") return complete(3);
			if (signal) {
				readSignals.push(signal);
				signal.addEventListener("abort", () => sourceAborted.resolve(), { once: true });
			}
			entered.resolve();
			return measurement.promise;
		},
	} as ExecutionBackend;
	const controller = new AbortController();
	const pending = produce(target, controller.signal);
	await entered.promise;
	try {
		controller.abort();
		const error = await pending.catch((reason: unknown) => reason);
		expect(error).toMatchObject({ name: "AbortError" });
		await sourceAborted.promise;
		expect(readSignals[0]?.aborted).toBe(true);
		expect((await readyStats(target, statsQuery(first.snapshotId))).rows[0]?.added).toBe(2);
	} finally {
		measurement.resolve(measured(3, 9));
	}
});

test.each([
	false,
	true,
])("content-only watch changes preserve page chains (uncertain: %s)", async (uncertain) => {
	const { target, calls, respond } = fixture(measured(3, 2));
	let fingerprint = "baseline";
	const initialized = deferred();
	const updated = deferred();
	let baselineVersion = 0;
	const pool = new GitWorkspaceWatchPool(
		async () => ({
			fingerprints: { worktree: fingerprint },
			uncertain: uncertain ? ["worktree"] : [],
		}),
		5,
		watchReads(),
		{ boundedIntervalMs: 5 },
	);
	const stop = pool.subscribe(
		target,
		() => {},
		(snapshot) => {
			if (snapshot.updating || !snapshot.statusPages?.statsVersion) return;
			if (!baselineVersion) {
				baselineVersion = snapshot.statusPages.statsVersion;
				initialized.resolve();
			} else if (snapshot.statusPages.statsVersion > baselineVersion) updated.resolve();
		},
	);
	try {
		await initialized.promise;
		const first = await readyPage(target, "reader", { limit: 1 });
		const query = statsQuery(first.snapshotId);
		expect((await readyStats(target, query)).rows[0]?.added).toBe(2);
		respond(measured(3, 9));
		fingerprint = "content-changed";
		await updated.promise;
		expect((await readyStats(target, query)).rows[0]?.added).toBe(9);
		const next = await readyPage(target, "reader", {
			limit: 1,
			cursor: first.nextCursor ?? undefined,
		});
		expect(next.snapshotId).toBe(first.snapshotId);
		expect(calls.filter(({ request }) => request.operation === "lineStats")).toHaveLength(2);
	} finally {
		stop();
	}
});

test("failed monitoring still publishes statistics through the existing facts refresh interval", async () => {
	const { target, respond } = fixture(measured(3, 2));
	let now = Date.now();
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	let failed = false;
	const initialized = deferred();
	const updated = deferred();
	let baselineVersion = 0;
	const pool = new GitWorkspaceWatchPool(
		async () => {
			if (failed) throw new Error("Monitor unavailable");
			return { fingerprints: { worktree: "baseline" }, uncertain: [] };
		},
		5,
		watchReads(),
	);
	const stop = pool.subscribe(
		target,
		() => {},
		(snapshot) => {
			if (snapshot.updating || !snapshot.statusPages?.statsVersion) return;
			if (!baselineVersion) {
				baselineVersion = snapshot.statusPages.statsVersion;
				initialized.resolve();
			} else if (snapshot.statusPages.statsVersion > baselineVersion) updated.resolve();
		},
	);
	try {
		await initialized.promise;
		const first = await readyPage(target, "reader", { limit: 1 });
		const query = statsQuery(first.snapshotId);
		expect((await readyStats(target, query)).rows[0]?.added).toBe(2);
		respond(measured(3, 9));
		now += 60_000;
		failed = true;
		await updated.promise;
		expect((await readyStats(target, query)).rows[0]?.added).toBe(9);
		expect(
			(await readyPage(target, "reader", { limit: 1, cursor: first.nextCursor ?? undefined }))
				.snapshotId,
		).toBe(first.snapshotId);
	} finally {
		stop();
		clock.mockRestore();
	}
});

test("remote paging serves all 561 cached files after one bounded cancellable producer read", async () => {
	const { target, calls } = fixture(complete(561));
	await produce(target);
	let page = await readyPage(target, "reader", { limit: 100 });
	const paths = page.files.map((file) => file.path);
	const snapshotId = page.snapshotId;
	while (page.hasMore) {
		page = await readyPage(target, "reader", { limit: 100, cursor: page.nextCursor ?? undefined });
		expect(page.snapshotId).toBe(snapshotId);
		paths.push(...page.files.map((file) => file.path));
	}
	expect(paths).toHaveLength(561);
	expect(new Set(paths).size).toBe(561);
	expect(paths).toContain("file-560");
	expect(page.complete).toBe(true);
	expect(page.counts.totalFiles).toBe(561);
	expect(calls.map(({ request }) => request.operation)).toEqual(["status", "lineStats"]);
	expect(calls[0]?.request).toMatchObject({
		operation: "status",
		cwd: target.workspace.rootPath,
		expectedRoot: target.workspace.rootPath,
		maxBytes: 1024 * 1024,
	});
	expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
});

for (const mode of ["truncated", "legacy", "missing-metadata", "missing-status"] as const) {
	test(`remote ${mode} preserves an explicitly incomplete published page`, async () => {
		const result: GitWorkspaceResult =
			mode === "missing-status" ? { totalFilesExact: true, truncated: false } : complete(2);
		if (mode === "truncated") result.truncated = true;
		if (mode === "missing-metadata") delete result.totalFilesExact;
		const { target } = fixture(result, mode !== "legacy");
		await produce(target);
		const page = await readyPage(target);
		expect(page.hasMore).toBe(false);
		expect(page.complete).toBe(false);
		expect(page.counts.exact).toBe(false);
		expect(page.limitReason).toBe(mode === "truncated" ? "remote-truncated" : "remote-incomplete");
	});
}

test("dirty cache retains a cursor until a newer membership version replaces it", async () => {
	const { target, calls, respond } = fixture(complete(4));
	await produce(target);
	const first = await readyPage(target, "reader", { limit: 1 });
	invalidateGitWorkspaceFacts(target);
	const second = await readyPage(target, "reader", {
		limit: 1,
		cursor: first.nextCursor ?? undefined,
	});
	expect(second.snapshotId).toBe(first.snapshotId);
	invalidateGitWorkspace(target);
	expect(
		(await readyPage(target, "reader", { limit: 1, cursor: second.nextCursor ?? undefined }))
			.snapshotId,
	).toBe(first.snapshotId);
	expect(calls).toHaveLength(2);
	respond(complete(5));
	await produce(target);
	await expectCode(
		getGitWorkspaceStatusPage(target, "reader", {
			limit: 1,
			cursor: second.nextCursor ?? undefined,
		}),
		"GIT_STATUS_PAGE_EXPIRED",
	);
});

test("a cached cursor cannot cross actors, workspace identity or device generations", async () => {
	const { target, calls } = fixture(complete(3));
	await produce(target);
	const first = await readyPage(target, "reader", { limit: 1 });
	const query = { limit: 1, cursor: first.nextCursor ?? undefined };
	for (const [candidate, actorId] of [
		[target, "other"],
		[{ ...target, workspace: { ...target.workspace, workspaceKey: "other" } }, "reader"],
		[
			{ ...target, backend: { ...target.backend, runtimeGeneration: 8 } as ExecutionBackend },
			"reader",
		],
	] as [GitWorkspaceTarget, string][]) {
		await expectCode(
			getGitWorkspaceStatusPage(candidate, actorId, query),
			"GIT_STATUS_PAGE_INVALID_CURSOR",
		);
	}
	expect(calls).toHaveLength(2);
});

test("unsupported remote production exposes a cache error without a host Git fallback", async () => {
	const { target, calls } = fixture(complete(1));
	target.backend = { ...target.backend, supportsGitWorkspace: false } as ExecutionBackend;
	expect((await getGitWorkspaceStatusPage(target, "reader", {})).status).toBe("pending");
	await produce(target);
	const result = await getGitWorkspaceStatusPage(target, "reader", {});
	expect(result).toMatchObject({
		status: "error",
		cache: { errorCode: "GIT_STATUS_PAGE_SOURCE_FAILED", memberVersion: 0 },
	});
	expect(result).not.toHaveProperty("files");
	expect(calls).toHaveLength(0);
});

test("invalidation during a remote producer scan prevents publishing its old membership", async () => {
	const { target } = fixture(complete(2));
	const entered = deferred();
	const response = deferred<GitWorkspaceResult>();
	target.backend = {
		...target.backend,
		gitWorkspace: async () => {
			entered.resolve();
			return response.promise;
		},
	} as ExecutionBackend;
	const pending = produce(target);
	await entered.promise;
	invalidateGitWorkspace(target);
	response.resolve(complete(2));
	await expectCode(pending, "GIT_STATUS_PAGE_EXPIRED");
	expect((await getGitWorkspaceStatusPage(target, "reader", {})).status).toBe("pending");
});

test("background verification expires an older snapshot after external membership changes", async () => {
	const { target, respond } = fixture(complete(3));
	await produce(target);
	const old = await readyPage(target, "reader", { limit: 1 });
	respond(complete(4));
	expect(await validateGitWorkspaceStatusPages(target)).toEqual({ changed: true, reliable: true });
	await expectCode(
		getGitWorkspaceStatusPage(target, "reader", { limit: 1, cursor: old.nextCursor ?? undefined }),
		"GIT_STATUS_PAGE_EXPIRED",
	);
});

test("scope proof requires every matching path and rejects eviction and external membership changes", async () => {
	const { target, respond } = fixture(complete(3));
	await produce(target);
	let first = await readyPage(target, "reader", { filter: ["A"] });
	const proof = () => ({
		snapshotId: first.snapshotId,
		filter: ["A"] as "A"[],
		section: "unstaged" as const,
	});
	const files = first.files.map((file) => file.path);
	await assertGitWorkspaceStatusPageScope(target, "reader", proof(), files);
	await expectCode(
		assertGitWorkspaceStatusPageScope(target, "reader", proof(), files.slice(1)),
		"GIT_STATUS_PAGE_EXPIRED",
	);
	respond(complete(4));
	await expectCode(
		assertGitWorkspaceStatusPageScope(target, "reader", proof(), files),
		"GIT_STATUS_PAGE_EXPIRED",
	);
	respond(complete(3));
	await produce(target);
	first = await readyPage(target, "reader", { filter: ["A"] });
	for (let index = 0; index < 8; index++)
		await readyPage(target, `reader-${index}`, { filter: ["A"] });
	await expectCode(
		assertGitWorkspaceStatusPageScope(target, "reader", proof(), files),
		"GIT_STATUS_PAGE_EXPIRED",
	);
});

test("2501 unchanged uncertain paths keep paging until the watcher publishes changed membership", async () => {
	const { target, respond } = fixture(complete(2501));
	let now = Date.now();
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const publications = [deferred(), deferred(), deferred(), deferred()];
	let published = 0;
	let statsVersion = 0;
	const pool = new GitWorkspaceWatchPool(
		async () => ({ fingerprints: { worktree: "bounded-unchanged" }, uncertain: ["worktree"] }),
		5,
		watchReads(),
		{ boundedIntervalMs: 5 },
	);
	const stop = pool.subscribe(
		target,
		() => {},
		(snapshot) => {
			if (
				snapshot.updating ||
				!snapshot.statusPages?.statsVersion ||
				snapshot.statusPages.statsVersion === statsVersion
			)
				return;
			statsVersion = snapshot.statusPages.statsVersion;
			publications[published++]?.resolve();
		},
	);
	try {
		await publications[0]?.promise;
		const first = await readyPage(target, "reader", { limit: 100 });
		for (let index = 1; index < 3; index++) {
			now += 60_000;
			await publications[index]?.promise;
			const unchanged = await readyPage(target, "reader", {
				limit: 100,
				cursor: first.nextCursor ?? undefined,
			});
			expect(unchanged.snapshotId).toBe(first.snapshotId);
			expect(unchanged.cache.memberVersion).toBe(first.cache.memberVersion);
		}
		respond(complete(2502));
		now += 60_000;
		await publications[3]?.promise;
		await expectCode(
			getGitWorkspaceStatusPage(target, "reader", {
				limit: 100,
				cursor: first.nextCursor ?? undefined,
			}),
			"GIT_STATUS_PAGE_EXPIRED",
		);
	} finally {
		stop();
		clock.mockRestore();
	}
});

test("watch baseline renews facts while changed membership and explicit refresh dirty pages", async () => {
	const { target } = fixture(complete(1));
	let changed = false;
	const baseline = deferred();
	const membership = deferred();
	const counts = { facts: 0, pages: 0 };
	const pool = new GitWorkspaceWatchPool(
		async () => ({ fingerprints: { worktree: changed ? "changed" : "same" }, uncertain: [] }),
		5,
		{
			...watchReads(),
			validatePages: undefined,
			invalidate: () => {
				counts.pages++;
				membership.resolve();
			},
			invalidateFacts: () => {
				counts.facts++;
				baseline.resolve();
			},
		},
	);
	const stop = pool.subscribe(target, () => {});
	try {
		await baseline.promise;
		expect(counts.facts).toBe(1);
		expect(counts.pages).toBe(0);
		changed = true;
		await membership.promise;
		expect(counts.pages).toBe(1);
		pool.refresh(target);
		expect(counts.pages).toBe(2);
	} finally {
		stop();
	}
});
