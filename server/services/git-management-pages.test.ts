import { afterAll, expect, spyOn, test } from "bun:test";
import type { GitLineStats } from "@shared/git-line-stats";
import type { GitStatusPageStatsQuery } from "@shared/git-status-page";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import type {
	GitWorkspaceRequest,
	GitWorkspaceResult,
} from "../lib/agent/execution/git-workspace-rpc";
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";
import {
	assertGitWorkspaceStatusPageScope,
	getGitWorkspaceStatusPage,
	getGitWorkspaceStatusPageStats,
	invalidateGitWorkspace,
	invalidateGitWorkspaceFacts,
	validateGitWorkspaceStatusPages,
	validateFilePaths,
	validateGitFileTargets,
} from "./git-management-service";
import { closeGitStatusPages } from "./git-status-page";
import type { GitWorkspaceTarget } from "./git-workspace";
import { GitWorkspaceWatchPool } from "./git-workspace-watch";

let nextFixture = 0;
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
});
afterAll(closeGitStatusPages);

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
function statsQuery(snapshotId: string): GitStatusPageStatsQuery {
	return {
		snapshotId,
		rows: [{ type: "file", section: "unstaged", path: "file-2" }],
	};
}

test("statistics uses the full measurement source once and pins its authorized remote target", async () => {
	const { target, calls } = fixture(measured(561, 4));
	const first = await getGitWorkspaceStatusPage(target, "reader", { limit: 1 });
	const query = statsQuery(first.snapshotId);
	const pending = getGitWorkspaceStatusPageStats(target, "reader", query);
	const originalRoot = target.workspace.rootPath;
	target.backend = {
		...target.backend,
		runtimeGeneration: 8,
		gitWorkspace: async () => {
			throw new Error("Replaced target must not be consulted");
		},
	} as ExecutionBackend;
	target.workspace = { ...target.workspace, rootPath: "/replaced" };
	const result = await pending;
	expect(result).toEqual({
		snapshotId: first.snapshotId,
		rows: [{ ...query.rows[0], added: 4, removed: 1, complete: true }],
	});
	expect(calls.map(({ request }) => request.operation)).toEqual(["status", "lineStats"]);
	expect(calls[1]?.request).toMatchObject({ cwd: originalRoot, expectedRoot: originalRoot });
	expect(calls[1]?.signal).toBeInstanceOf(AbortSignal);
});

test("facts changes replace statistics while preserving the valid status cursor chain", async () => {
	const { target, calls, respond } = fixture(measured(3, 2));
	const first = await getGitWorkspaceStatusPage(target, "reader", { limit: 1 });
	const query = statsQuery(first.snapshotId);
	expect((await getGitWorkspaceStatusPageStats(target, "reader", query)).rows[0]?.added).toBe(2);
	expect((await getGitWorkspaceStatusPageStats(target, "reader", query)).rows[0]?.added).toBe(2);
	expect(calls.filter(({ request }) => request.operation === "lineStats")).toHaveLength(1);
	respond(measured(3, 9));
	invalidateGitWorkspaceFacts(target);
	expect((await getGitWorkspaceStatusPageStats(target, "reader", query)).rows[0]?.added).toBe(9);
	const next = await getGitWorkspaceStatusPage(target, "reader", {
		limit: 1,
		cursor: first.nextCursor ?? undefined,
	});
	expect(next.snapshotId).toBe(first.snapshotId);
	expect(calls.filter(({ request }) => request.operation === "status")).toHaveLength(1);
	expect(calls.filter(({ request }) => request.operation === "lineStats")).toHaveLength(2);
	invalidateGitWorkspace(target);
	expect(await rejected(getGitWorkspaceStatusPageStats(target, "reader", query))).toMatchObject({
		code: "GIT_STATUS_PAGE_EXPIRED",
	});
});

test("statistics rejects cross-actor, workspace, generation, filter and unknown snapshot identities before measurement", async () => {
	const { target, calls } = fixture(measured(3, 2));
	const first = await getGitWorkspaceStatusPage(target, "reader", { filter: ["A"] });
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
		expect(
			await rejected(getGitWorkspaceStatusPageStats(candidate, actorId, candidateQuery)),
		).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
	}
	expect(calls.map(({ request }) => request.operation)).toEqual(["status"]);
});

test("unsupported remote statistics remain unknown without a local or status fallback", async () => {
	const { target, calls } = fixture(measured(3, 2));
	target.backend = { ...target.backend, supportsGitLineStats: false } as ExecutionBackend;
	const first = await getGitWorkspaceStatusPage(target, "reader", {});
	const query = statsQuery(first.snapshotId);
	expect(await getGitWorkspaceStatusPageStats(target, "reader", query)).toEqual({
		snapshotId: first.snapshotId,
		rows: [{ ...query.rows[0], complete: false }],
	});
	expect(calls.map(({ request }) => request.operation)).toEqual(["status"]);
});

test("facts invalidation during a measurement prevents publishing old statistics", async () => {
	const { target } = fixture(measured(3, 2));
	const first = await getGitWorkspaceStatusPage(target, "reader", {});
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	let finish!: (result: GitWorkspaceResult) => void;
	const measurement = new Promise<GitWorkspaceResult>((resolve) => {
		finish = resolve;
	});
	target.backend = {
		...target.backend,
		gitWorkspace: async () => {
			enter();
			return measurement;
		},
	} as ExecutionBackend;
	const pending = getGitWorkspaceStatusPageStats(target, "reader", statsQuery(first.snapshotId));
	await entered;
	invalidateGitWorkspaceFacts(target);
	finish(measured(3, 2));
	expect(await rejected(pending)).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
});

test("request cancellation reaches the shared statistics source", async () => {
	const { target } = fixture(measured(3, 2));
	const first = await getGitWorkspaceStatusPage(target, "reader", {});
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const readSignals: AbortSignal[] = [];
	let abortSource!: () => void;
	const sourceAborted = new Promise<void>((resolve) => {
		abortSource = resolve;
	});
	let finish!: (result: GitWorkspaceResult) => void;
	const measurement = new Promise<GitWorkspaceResult>((resolve) => {
		finish = resolve;
	});
	target.backend = {
		...target.backend,
		gitWorkspace: async (_request: GitWorkspaceRequest, signal?: AbortSignal) => {
			if (signal) {
				readSignals.push(signal);
				signal.addEventListener("abort", abortSource, { once: true });
			}
			enter();
			return measurement;
		},
	} as ExecutionBackend;
	const controller = new AbortController();
	const pending = getGitWorkspaceStatusPageStats(
		target,
		"reader",
		statsQuery(first.snapshotId),
		controller.signal,
	);
	await entered;
	try {
		controller.abort();
		expect(await rejected(pending)).toMatchObject({ code: "GIT_STATUS_PAGE_CANCELLED" });
		await sourceAborted;
		expect(readSignals[0]?.aborted).toBe(true);
	} finally {
		finish(measured(3, 2));
	}
});

test("an uncertain content-only watch change refreshes statistics without expiring its page chain", async () => {
	const { target, calls, respond } = fixture(measured(3, 2));
	const first = await getGitWorkspaceStatusPage(target, "reader", { limit: 1 });
	let fingerprint = "baseline";
	let baseline!: () => void;
	const initialized = new Promise<void>((resolve) => {
		baseline = resolve;
	});
	let changed!: () => void;
	const updated = new Promise<void>((resolve) => {
		changed = resolve;
	});
	const lineStats: GitLineStats = { files: [], linesAdded: 0, linesRemoved: 0, complete: true };
	const pool = new GitWorkspaceWatchPool(
		async () => ({ fingerprints: { worktree: fingerprint }, uncertain: ["worktree"] }),
		5,
		{
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
			lineStats: async () => lineStats,
			invalidate: () => {
				throw new Error("A content-only change must preserve pages");
			},
			invalidateFacts: invalidateGitWorkspaceFacts,
			validate: () => {},
			validatePages: validateGitWorkspaceStatusPages,
		},
		{ boundedIntervalMs: 5 },
	);
	const states: Array<{ statusPagesChanged: boolean; statusPagesReliable: boolean }> = [];
	const stop = pool.subscribe(target, (_categories, state) => {
		if (state) states.push(state);
		if (fingerprint === "baseline") baseline();
		else changed();
	});
	try {
		await initialized;
		const query = statsQuery(first.snapshotId);
		expect((await getGitWorkspaceStatusPageStats(target, "reader", query)).rows[0]?.added).toBe(2);
		respond(measured(3, 9));
		fingerprint = "content-changed";
		await updated;
		expect(states.at(-1)).toEqual({ statusPagesChanged: false, statusPagesReliable: true });
		expect((await getGitWorkspaceStatusPageStats(target, "reader", query)).rows[0]?.added).toBe(9);
		const next = await getGitWorkspaceStatusPage(target, "reader", {
			limit: 1,
			cursor: first.nextCursor ?? undefined,
		});
		expect(next.snapshotId).toBe(first.snapshotId);
		expect(calls.filter(({ request }) => request.operation === "lineStats")).toHaveLength(2);
	} finally {
		stop();
	}
});

test("failed monitoring revalidates statistics through the existing facts refresh interval", async () => {
	const { target, respond } = fixture(measured(3, 2));
	const first = await getGitWorkspaceStatusPage(target, "reader", { limit: 1 });
	let now = Date.now();
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	let failed = false;
	let baseline!: () => void;
	const initialized = new Promise<void>((resolve) => {
		baseline = resolve;
	});
	let failure!: () => void;
	const failedProbe = new Promise<void>((resolve) => {
		failure = resolve;
	});
	const pool = new GitWorkspaceWatchPool(
		async () => {
			if (failed) throw new Error("Monitor unavailable");
			return { fingerprints: { worktree: "baseline" }, uncertain: [] };
		},
		5,
		{
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
			lineStats: async () => ({ files: [], linesAdded: 0, linesRemoved: 0, complete: true }),
			invalidate: () => {
				throw new Error("A monitor failure must preserve page membership");
			},
			invalidateFacts: invalidateGitWorkspaceFacts,
			validate: () => {},
			validatePages: validateGitWorkspaceStatusPages,
		},
	);
	const stop = pool.subscribe(target, (_categories, state) => {
		if (!failed) baseline();
		else if (state?.statusPagesReliable === false) failure();
	});
	try {
		await initialized;
		const query = statsQuery(first.snapshotId);
		expect((await getGitWorkspaceStatusPageStats(target, "reader", query)).rows[0]?.added).toBe(2);
		respond(measured(3, 9));
		now += 60_000;
		failed = true;
		await failedProbe;
		expect((await getGitWorkspaceStatusPageStats(target, "reader", query)).rows[0]?.added).toBe(9);
		expect(
			(
				await getGitWorkspaceStatusPage(target, "reader", {
					limit: 1,
					cursor: first.nextCursor ?? undefined,
				})
			).snapshotId,
		).toBe(first.snapshotId);
	} finally {
		stop();
		clock.mockRestore();
	}
});

test("remote paging reads all 561 raw files once, with pinned root and a cancellable RPC", async () => {
	const { target, calls } = fixture(complete(561));
	const controller = new AbortController();
	let page = await getGitWorkspaceStatusPage(target, "reader", { limit: 100 }, controller.signal);
	const paths = page.files.map((file) => file.path);
	const snapshotId = page.snapshotId;
	while (page.hasMore) {
		page = await getGitWorkspaceStatusPage(target, "reader", {
			limit: 100,
			cursor: page.nextCursor ?? undefined,
		});
		expect(page.snapshotId).toBe(snapshotId);
		paths.push(...page.files.map((file) => file.path));
	}
	expect(paths).toHaveLength(561);
	expect(new Set(paths).size).toBe(561);
	expect(paths).toContain("file-560");
	expect(page.complete).toBe(true);
	expect(page.counts.totalFiles).toBe(561);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.request).toMatchObject({
		operation: "status",
		cwd: target.workspace.rootPath,
		expectedRoot: target.workspace.rootPath,
		maxBytes: 1024 * 1024,
	});
	expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
});

for (const mode of ["truncated", "legacy", "missing-metadata", "missing-status"] as const) {
	test(`remote ${mode} preserves an explicitly incomplete terminal page`, async () => {
		const result =
			mode === "missing-status" ? { totalFilesExact: true, truncated: false } : complete(2);
		if (mode === "truncated") result.truncated = true;
		if (mode === "missing-metadata") delete result.totalFilesExact;
		const { target } = fixture(result, mode !== "legacy");
		const page = await getGitWorkspaceStatusPage(target, "reader", {});
		expect(page.hasMore).toBe(false);
		expect(page.complete).toBe(false);
		expect(page.counts.exact).toBe(false);
		expect(page.limitReason).toBe(mode === "truncated" ? "remote-truncated" : "remote-incomplete");
	});
}

test("facts revalidation preserves a cursor; real invalidation rejects it", async () => {
	const { target, calls } = fixture(complete(4));
	const first = await getGitWorkspaceStatusPage(target, "reader", { limit: 1 });
	invalidateGitWorkspaceFacts(target);
	const second = await getGitWorkspaceStatusPage(target, "reader", {
		limit: 1,
		cursor: first.nextCursor ?? undefined,
	});
	expect(second.snapshotId).toBe(first.snapshotId);
	expect(calls).toHaveLength(1);
	invalidateGitWorkspace(target);
	expect(
		await rejected(
			getGitWorkspaceStatusPage(target, "reader", {
				limit: 1,
				cursor: second.nextCursor ?? undefined,
			}),
		),
	).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
});

test("a cursor cannot cross actors, workspace identity or device generations", async () => {
	const { target, calls } = fixture(complete(3));
	const first = await getGitWorkspaceStatusPage(target, "reader", { limit: 1 });
	const query = { limit: 1, cursor: first.nextCursor ?? undefined };
	expect(await rejected(getGitWorkspaceStatusPage(target, "other", query))).toMatchObject({
		code: "GIT_STATUS_PAGE_INVALID_CURSOR",
	});
	expect(
		await rejected(
			getGitWorkspaceStatusPage(
				{ ...target, workspace: { ...target.workspace, workspaceKey: "other" } },
				"reader",
				query,
			),
		),
	).toMatchObject({ code: "GIT_STATUS_PAGE_INVALID_CURSOR" });
	expect(
		await rejected(
			getGitWorkspaceStatusPage(
				{ ...target, backend: { ...target.backend, runtimeGeneration: 8 } as ExecutionBackend },
				"reader",
				query,
			),
		),
	).toMatchObject({ code: "GIT_STATUS_PAGE_INVALID_CURSOR" });
	expect(calls).toHaveLength(1);
});

test("unsupported remote execution fails without a host Git fallback", async () => {
	const { target, calls } = fixture(complete(1));
	target.backend = { ...target.backend, supportsGitWorkspace: false } as ExecutionBackend;
	expect(await rejected(getGitWorkspaceStatusPage(target, "reader", {}))).toMatchObject({
		code: "GIT_STATUS_PAGE_SOURCE_FAILED",
	});
	expect(calls).toHaveLength(0);
});

test("invalidation during a remote scan prevents publishing its old snapshot", async () => {
	const { target } = fixture(complete(2));
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	let finish!: (value: GitWorkspaceResult) => void;
	const response = new Promise<GitWorkspaceResult>((resolve) => {
		finish = resolve;
	});
	target.backend = {
		...target.backend,
		gitWorkspace: async () => {
			enter();
			return response;
		},
	} as ExecutionBackend;
	const pending = getGitWorkspaceStatusPage(target, "reader", {});
	await entered;
	invalidateGitWorkspace(target);
	finish(complete(2));
	expect(await rejected(pending)).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
});

test("baseline verification invalidates an older HTTP snapshot after external membership changes", async () => {
	const { target, respond } = fixture(complete(3));
	const old = await getGitWorkspaceStatusPage(target, "reader", { limit: 1 });
	respond(complete(4));
	expect(await validateGitWorkspaceStatusPages(target)).toEqual({ changed: true, reliable: true });
	expect(
		await rejected(
			getGitWorkspaceStatusPage(target, "reader", {
				limit: 1,
				cursor: old.nextCursor ?? undefined,
			}),
		),
	).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
});

test("scope proof requires every matching path and rejects eviction and external membership changes", async () => {
	const { target, respond } = fixture(complete(3));
	let first = await getGitWorkspaceStatusPage(target, "reader", { filter: ["A"] });
	const proof = () => ({
		snapshotId: first.snapshotId,
		filter: ["A"] as "A"[],
		section: "unstaged" as const,
	});
	const files = first.files.map((file) => file.path);
	await assertGitWorkspaceStatusPageScope(target, "reader", proof(), files);
	expect(
		await rejected(assertGitWorkspaceStatusPageScope(target, "reader", proof(), files.slice(1))),
	).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
	respond(complete(4));
	expect(
		await rejected(assertGitWorkspaceStatusPageScope(target, "reader", proof(), files)),
	).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
	respond(complete(3));
	first = await getGitWorkspaceStatusPage(target, "reader", { filter: ["A"] });
	for (let index = 0; index < 8; index++)
		await getGitWorkspaceStatusPage(target, "reader", { filter: ["A"] });
	expect(
		await rejected(assertGitWorkspaceStatusPageScope(target, "reader", proof(), files)),
	).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
});

test("2501 unchanged uncertain paths remain pageable while fresh membership changes are detected", async () => {
	const { target, respond } = fixture(complete(2501));
	const first = await getGitWorkspaceStatusPage(target, "reader", { limit: 100 });
	let validations = 0;
	const states: Array<{ statusPagesChanged: boolean; statusPagesReliable: boolean }> = [];
	const pool = new GitWorkspaceWatchPool(
		async () => ({ fingerprints: { worktree: "bounded-unchanged" }, uncertain: ["worktree"] }),
		5,
		{
			status: async () => ({
				hasChanges: true,
				staged: 0,
				unstaged: 0,
				untracked: 2501,
				files: [],
				totalFiles: 2501,
				headSha: "",
				branch: "",
			}),
			lineStats: async () => ({ files: [], linesAdded: 0, linesRemoved: 0, complete: true }),
			invalidate: () => {
				throw new Error("Uncertainty must be verified before expiring pages");
			},
			invalidateFacts: () => {},
			validate: () => {},
			validatePages: async (value, signal) => {
				validations++;
				return validateGitWorkspaceStatusPages(value, signal);
			},
		},
		{ boundedIntervalMs: 5, revalidateIntervalMs: 20 },
	);
	const stop = pool.subscribe(target, (_categories, state) => {
		if (state) states.push(state);
	});
	try {
		for (let index = 0; index < 200 && validations < 3; index++) await Bun.sleep(2);
		expect(validations).toBeGreaterThanOrEqual(3);
		expect(states.some((state) => state.statusPagesReliable && !state.statusPagesChanged)).toBe(
			true,
		);
		const next = await getGitWorkspaceStatusPage(target, "reader", {
			limit: 100,
			cursor: first.nextCursor ?? undefined,
		});
		expect(next.snapshotId).toBe(first.snapshotId);
		respond(complete(2502));
		for (let index = 0; index < 200 && !states.some((state) => state.statusPagesChanged); index++)
			await Bun.sleep(2);
		expect(states.some((state) => state.statusPagesChanged)).toBe(true);
		expect(
			await rejected(
				getGitWorkspaceStatusPage(target, "reader", {
					limit: 100,
					cursor: next.nextCursor ?? undefined,
				}),
			),
		).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
	} finally {
		stop();
	}
});

test("watch baseline and unchanged probes renew facts, while change and refresh invalidate pages", async () => {
	const { target } = fixture(complete(1));
	let changed = false;
	const counts = { facts: 0, pages: 0 };
	const pool = new GitWorkspaceWatchPool(
		async () => ({ fingerprints: { worktree: changed ? "changed" : "same" }, uncertain: [] }),
		5,
		{
			status: async () => ({
				hasChanges: false,
				staged: 0,
				unstaged: 0,
				untracked: 0,
				files: [],
				totalFiles: 0,
				headSha: "",
				branch: "",
			}),
			lineStats: async () => ({ files: [], linesAdded: 0, linesRemoved: 0, complete: true }),
			invalidate: () => {
				counts.pages++;
			},
			invalidateFacts: () => {
				counts.facts++;
			},
			validate: () => {},
		},
	);
	const stop = pool.subscribe(target, () => {});
	try {
		for (let i = 0; i < 10 && !counts.facts; i++) await Bun.sleep(2);
		expect(counts.facts).toBe(1);
		expect(counts.pages).toBe(0);
		await Bun.sleep(12);
		expect(counts.pages).toBe(0);
		changed = true;
		for (let i = 0; i < 15 && !counts.pages; i++) await Bun.sleep(2);
		expect(counts.pages).toBe(1);
		pool.refresh(target);
		expect(counts.pages).toBe(2);
	} finally {
		stop();
	}
});
