import { describe, expect, spyOn, test } from "bun:test";
import type { GitLineStats } from "@shared/git-line-stats";
import type { GitStatusPageCacheState } from "@shared/git-status-page";
import type {
	GitStagingWatchState,
	GitWorkspaceCategory,
	GitWorkspaceSnapshot,
} from "@shared/git-workspace-events";
import { AppError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import type { getGitWorkspaceStatus } from "./git-management-service";
import * as stagingService from "./git-staging-lists-service";
import { GitStatusQueryCoordinator } from "./git-status-query";
import type { GitWorkspaceTarget } from "./git-workspace";
import {
	boundGitSnapshot,
	changedGitCategories,
	GIT_SNAPSHOT_MAX_BYTES,
	GitWatchFactsError,
	GitWorkspaceWatchPool,
	probeGitWatch,
	projectGitSnapshot,
	WATCH_MAX_BYTES,
} from "./git-workspace-watch";

const target = (device = "local"): GitWorkspaceTarget =>
	({
		workspace: {
			deviceId: device,
			workspaceKey: "workspace",
			repositoryKey: "repository",
			rootPath: "/repo",
		},
	}) as GitWorkspaceTarget;
const remoteTarget = (generation: number): GitWorkspaceTarget => ({
	...target("remote"),
	backend: {
		kind: "remote",
		runtimeGeneration: generation,
		supportsGitWorkspaceWatch: true,
	} as NonNullable<GitWorkspaceTarget["backend"]>,
});
test("published SQLite generations refresh groups without refreshing ordinary Git", async () => {
	let state: GitStagingWatchState = {
		fingerprint: "initial",
		databaseIdentity: "database",
		generation: 1,
		observationId: "observation",
		listIds: ["A", "B"],
	};
	let probes = 0;
	const fixture = snapshotFixture();
	const events: Array<Parameters<typeof eventBus.emit>[0]> = [];
	const onChange = (event: Parameters<typeof eventBus.emit>[0]) => events.push(event);
	eventBus.on("git:staging_lists_changed", onChange);
	const pool = new GitWorkspaceWatchPool(
		async () => {
			probes++;
			return {
				fingerprints: { worktree: "same" },
				uncertain: [],
				stagingListsFingerprint: state.fingerprint,
				stagingListsState: state,
			};
		},
		5,
		fixture.reads,
	);
	const off = pool.subscribe(
		target(),
		() => {},
		() => {},
	);
	try {
		await waitFor(() => fixture.counts.lineStats === 1 && probes >= 2);
		const baseline = { ...fixture.counts };
		state = { ...state, fingerprint: "move-a", generation: 2 };
		await waitFor(() => events.length === 1);
		expect(events[0]).toEqual({
			type: "git:staging_lists_changed",
			workspaceKey: "workspace",
			metadataChanged: true,
			affectedListIds: ["A", "B"],
			generation: 2,
			observationId: "observation",
		});
		state = { ...state, fingerprint: "rename", generation: 3 };
		await waitFor(() => events.length === 2);
		expect(events[1]).toEqual({
			type: "git:staging_lists_changed",
			workspaceKey: "workspace",
			metadataChanged: true,
			affectedListIds: ["A", "B"],
			generation: 3,
			observationId: "observation",
		});
		expect(fixture.counts.status).toBe(baseline.status);
		expect(fixture.counts.lineStats).toBe(baseline.lineStats);
		expect(fixture.counts.invalidate).toBe(baseline.invalidate);
	} finally {
		off();
		eventBus.off("git:staging_lists_changed", onChange);
	}
});

test("remote watch carries ordinary Git facts only", async () => {
	const remote = remoteTarget(1);
	remote.backend = {
		...remote.backend,
		gitWorkspace: async () => ({
			outputs: {
				worktree: "work",
				index: "index",
				head: "head",
				stash: "stash",
				stagingListsFingerprint: "ignored",
				stagingListsState: "ignored",
			},
		}),
	} as NonNullable<GitWorkspaceTarget["backend"]>;
	const sample = await probeGitWatch(remote, new AbortController().signal);
	expect(sample).toEqual({
		fingerprints: { worktree: "work", index: "index", head: "head", stash: "stash" },
		uncertain: [],
	});
});

test("failed native Git facts retain the published SQLite observation", async () => {
	let state: GitStagingWatchState = {
		fingerprint: "initial",
		databaseIdentity: "database",
		generation: 1,
		observationId: "observation",
		listIds: ["A"],
	};
	let probes = 0;
	const fixture = snapshotFixture();
	const events: unknown[] = [];
	const changed = (event: unknown) => events.push(event);
	eventBus.on("git:staging_lists_changed", changed);
	const pool = new GitWorkspaceWatchPool(
		async () => {
			probes++;
			throw new GitWatchFactsError(state.fingerprint, new Error("native index unavailable"), state);
		},
		5,
		fixture.reads,
	);
	const off = pool.subscribe(target(), () => {});
	try {
		await waitFor(() => probes >= 2);
		state = { ...state, fingerprint: "external", generation: 2 };
		await waitFor(() => events.length === 1);
		expect(events[0]).toEqual({
			type: "git:staging_lists_changed",
			workspaceKey: "workspace",
			metadataChanged: true,
			affectedListIds: ["A"],
			generation: 2,
			observationId: "observation",
		});
	} finally {
		off();
		eventBus.off("git:staging_lists_changed", changed);
	}
});

test("stable incomplete fingerprints never become a hundred synthetic changes", () => {
	const sample = { fingerprints: { worktree: "bounded" }, uncertain: ["worktree" as const] };
	expect(changedGitCategories(undefined, sample)).toContain("worktree");
	for (let i = 0; i < 100; i++) expect(changedGitCategories(sample, sample)).toEqual([]);
	expect(changedGitCategories(sample, { ...sample, fingerprints: { worktree: "edited" } })).toEqual(
		["worktree"],
	);
});

test("a hundred observed edits coalesce into one in-flight scan and one trailing scan", async () => {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let scans = 0;
	let active = 0;
	let maximum = 0;
	let probes = 0;
	let identity = 0;
	const original = stagingService.createGitStagingListsService;
	const factory = spyOn(stagingService, "createGitStagingListsService").mockImplementation(
		(context) =>
			original(context, {
				execute: async <T>(request: import("./git-staging-worker").GitStagingWork) => {
					if (request.method === "actionPaths") return ["f"] as T;
					if (request.method === "baseline")
						return {
							initialized: true,
							generation: 1,
							observationId: "observed",
							state: "ready",
						} as T;
					scans++;
					active++;
					maximum = Math.max(maximum, active);
					if (scans === 1) await held;
					active--;
					return {
						outcome: "applied",
						affectedListIds: ["A"],
						generation: scans,
						observationId: "observed",
					} as T;
				},
			}),
	);
	const fixture = snapshotFixture();
	const pool = new GitWorkspaceWatchPool(
		async () => {
			probes++;
			return { fingerprints: { worktree: String(identity) }, uncertain: [] };
		},
		1,
		fixture.reads,
	);
	const local = { ...target(), backend: { kind: "local" } } as GitWorkspaceTarget;
	const off = pool.subscribe(local, () => {}, undefined, {
		authorizationKey: "owner:narrator",
		writable: true,
		beforeWrite: async () => {},
		authorizePaths: async () => {},
		observation: () => {},
	});
	try {
		await waitFor(() => scans === 1);
		expect(active).toBe(1);
		for (let i = 0; i < 100; i++) {
			identity++;
			await pause(1);
		}
		expect(scans).toBe(1);
		release();
		await waitFor(() => scans === 2);
		const baseline = probes;
		await waitFor(() => probes >= baseline + 5);
		expect(scans).toBe(2);
		expect(maximum).toBe(1);
		off();
		const stopped = probes;
		await pause(15);
		expect(probes).toBe(stopped);
	} finally {
		release();
		off();
		factory.mockRestore();
	}
});

const pause = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing expected snapshot fixture value");
	return value;
}
async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
	const deadline = performance.now() + timeoutMs;
	while (!predicate()) {
		if (performance.now() >= deadline) throw new Error("Timed out waiting for snapshot state");
		await pause(1);
	}
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const statusFacts = (path = "file"): Awaited<ReturnType<typeof getGitWorkspaceStatus>> => ({
	hasChanges: true,
	staged: 0,
	unstaged: 1,
	untracked: 0,
	totalFiles: 1,
	totalFilesExact: true,
	headSha: "sha",
	branch: "main",
	files: [{ status: " M", path }],
});
const lineFacts = (path = "file", linesAdded = 3): GitLineStats => ({
	linesAdded,
	linesRemoved: 2,
	complete: true,
	files: [{ path, unstagedLinesAdded: linesAdded, unstagedLinesRemoved: 2, complete: true }],
});
function snapshotFixture() {
	const counts = { status: 0, lineStats: 0, invalidate: 0, validate: 0, probes: 0 };
	const reads = {
		status: async (_target: GitWorkspaceTarget, _signal?: AbortSignal) => {
			counts.status++;
			return statusFacts();
		},
		lineStats: async (_target: GitWorkspaceTarget, _signal?: AbortSignal) => {
			counts.lineStats++;
			return lineFacts();
		},
		invalidate: (_target: GitWorkspaceTarget) => {
			counts.invalidate++;
		},
		validate: (_target: GitWorkspaceTarget) => {
			counts.validate++;
		},
	};
	let fingerprint = "baseline";
	const pool = new GitWorkspaceWatchPool(
		async () => {
			counts.probes++;
			return { fingerprints: { worktree: fingerprint }, uncertain: [] };
		},
		5,
		reads,
	);
	return {
		pool,
		reads,
		counts,
		change: (value: string) => {
			fingerprint = value;
		},
	};
}

function coordinatedSnapshotFixture() {
	const statusCache = new GitStatusQueryCoordinator<
		Awaited<ReturnType<typeof getGitWorkspaceStatus>>
	>();
	const lineCache = new GitStatusQueryCoordinator<GitLineStats>();
	const key = "snapshot-initial-baseline";
	let path = "cached-before-opening";
	const counts = { status: 0, lineStats: 0, invalidate: 0, validate: 0 };
	const requestedTtls: Array<{ kind: "status" | "lineStats"; ttlMs: number | undefined }> = [];
	const reads = {
		status: (_target: GitWorkspaceTarget, signal?: AbortSignal, ttlMs?: number) => {
			requestedTtls.push({ kind: "status", ttlMs });
			return statusCache.query(
				key,
				async () => {
					counts.status++;
					return statusFacts(path);
				},
				{ signal, ttlMs },
			);
		},
		lineStats: (_target: GitWorkspaceTarget, signal?: AbortSignal, ttlMs?: number) => {
			requestedTtls.push({ kind: "lineStats", ttlMs });
			return lineCache.query(
				key,
				async () => {
					counts.lineStats++;
					return lineFacts(path);
				},
				{ signal, ttlMs },
			);
		},
		invalidate: (_target: GitWorkspaceTarget) => {
			counts.invalidate++;
			statusCache.invalidate(key);
			lineCache.invalidate(key);
		},
		validate: (_target: GitWorkspaceTarget) => {
			counts.validate++;
			statusCache.validate(key);
			lineCache.validate(key);
		},
	};
	return {
		reads,
		counts,
		requestedTtls,
		beginStatusRead: (pending: Promise<Awaited<ReturnType<typeof getGitWorkspaceStatus>>>) =>
			statusCache.query(
				key,
				async () => {
					counts.status++;
					return pending;
				},
				{ ttlMs: 0 },
			),
		beginLineRead: (pending: Promise<GitLineStats>) =>
			lineCache.query(
				key,
				async () => {
					counts.lineStats++;
					return pending;
				},
				{ ttlMs: 0 },
			),
		setPath: (value: string) => {
			path = value;
		},
		probe: async () => ({ fingerprints: { worktree: path }, uncertain: [] }),
		clear: () => {
			statusCache.clear();
			lineCache.clear();
		},
	};
}

describe("panel-only Git watch pool", () => {
	test("deduplicates workspace+device and releases the last subscription", async () => {
		let probes = 0;
		let notifications = 0;
		const pool = new GitWorkspaceWatchPool(
			async () => ({ fingerprints: { worktree: String(++probes) }, uncertain: [] }),
			5,
		);
		const a = pool.subscribe(target(), () => notifications++);
		const b = pool.subscribe(target(), () => notifications++);
		await pause();
		expect(probes).toBeGreaterThan(0);
		expect(notifications).toBe(probes * 2);
		a();
		b();
		const before = probes;
		await pause();
		expect(probes).toBe(before);
	});
	test("cancels in-flight probe, does not overlap or notify after teardown", async () => {
		let calls = 0;
		let aborted = false;
		let notify = 0;
		const pool = new GitWorkspaceWatchPool(async (_target, signal) => {
			calls++;
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => {
					aborted = true;
					resolve();
				}),
			);
			return { fingerprints: { worktree: "x" }, uncertain: [] };
		}, 1);
		const stop = pool.subscribe(target(), () => notify++);
		await pause();
		expect(calls).toBe(1);
		stop();
		await pause();
		expect(aborted).toBe(true);
		expect(notify).toBe(0);
	});
	test("two subscribers rebind a shared generation without overlapping probes or stale callbacks", async () => {
		const generations: number[] = [];
		const signals: AbortSignal[] = [];
		const events: string[][] = [];
		let finishOld = () => {};
		const pending = new Promise<void>((resolve) => {
			finishOld = resolve;
		});
		const pool = new GitWorkspaceWatchPool(async (current, signal) => {
			const generation = current.backend?.runtimeGeneration ?? 0;
			generations.push(generation);
			signals.push(signal);
			if (generation === 1) await pending;
			return { fingerprints: { worktree: String(generation) }, uncertain: [] };
		}, 5);
		const stopA = pool.subscribe(remoteTarget(1), () => events.push(["old A"]));
		const stopB = pool.subscribe(remoteTarget(1), () => events.push(["old B"]));
		const stops = [stopA, stopB];
		try {
			stopA();
			stops.push(pool.subscribe(remoteTarget(2), (categories) => events.push(categories)));
			stopB();
			stops.push(pool.subscribe(remoteTarget(2), (categories) => events.push(categories)));
			expect(signals[0]?.aborted).toBe(true);
			await pause();
			expect(generations).toEqual([1]); // Cancellation must settle before the replacement runs.
			expect(events).toEqual([]);
			finishOld();
			await pause(30);
			expect(generations.length).toBeGreaterThan(1);
			expect(generations.slice(1).every((generation) => generation === 2)).toBe(true);
			expect(events.slice(0, 2)).toEqual([[], []]);
			// Late teardown and even a late old authorization cannot remove/downgrade the new slot.
			stopA();
			stopB();
			pool.subscribe(remoteTarget(1), () => {})();
			const before = generations.length;
			await pause();
			expect(generations.length).toBeGreaterThan(before);
			expect(generations.slice(1).every((generation) => generation === 2)).toBe(true);
		} finally {
			finishOld();
			for (const stop of stops) stop();
		}
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		const before = generations.length;
		await pause();
		expect(generations).toHaveLength(before);
	});
	test("generation replacement retains one capacity slot and ignores old teardown after recreation", async () => {
		const generations: number[] = [];
		const pool = new GitWorkspaceWatchPool(async (current) => {
			generations.push(current.backend?.runtimeGeneration ?? 0);
			return { fingerprints: {}, uncertain: [] };
		}, 5);
		const stops: (() => void)[] = [];
		try {
			const old = pool.subscribe(remoteTarget(1), () => {});
			stops.push(old);
			for (let i = 0; i < 127; i++) stops.push(pool.subscribe(target(`filler-${i}`), () => {}));
			expect(() => pool.subscribe(target("over-capacity"), () => {})).toThrow("capacity");
			const fresh = pool.subscribe(remoteTarget(2), () => {});
			stops.push(fresh);
			old();
			await pause();
			expect(generations).toContain(2);
			fresh();
			stops.push(pool.subscribe(remoteTarget(3), () => {}));
			old();
			fresh();
			expect(() => pool.subscribe(target("still-over-capacity"), () => {})).toThrow("capacity");
			await pause();
			expect(generations).toContain(3);
		} finally {
			for (const stop of stops) stop();
		}
	});
	test("unchanged samples still authorize but do not invalidate; uncertainty invalidates", async () => {
		let uncertain: GitWorkspaceCategory[] = [];
		const events: string[][] = [];
		const pool = new GitWorkspaceWatchPool(
			async () => ({ fingerprints: { worktree: "same" }, uncertain }),
			5,
		);
		const stop = pool.subscribe(target(), (categories) => events.push(categories));
		await pause();
		expect(events[0]).toEqual([]);
		expect(events.slice(1).every((event) => event.length === 0)).toBe(true);
		uncertain = ["worktree"];
		await pause();
		stop();
		expect(events.at(-1)).toContain("worktree");
	});
	test("different devices do not share probes", async () => {
		let calls = 0;
		const pool = new GitWorkspaceWatchPool(
			async () => ({ fingerprints: { worktree: String(++calls) }, uncertain: [] }),
			1000,
		);
		const a = pool.subscribe(target(), () => {});
		const b = pool.subscribe(target("remote"), () => {});
		await pause();
		a();
		b();
		expect(calls).toBe(2);
	});
	test("legacy watch fallback without staged numstat never claims a stable index", async () => {
		const remote = target("remote");
		remote.backend = {
			kind: "remote",
			gitWorkspace: async (request: Record<string, unknown>) =>
				request.operation === "status"
					? { outputs: { status: "", head: "sha", branch: "main" } }
					: { stdout: "" },
		} as unknown as NonNullable<GitWorkspaceTarget["backend"]>;
		const first = await probeGitWatch(remote, new AbortController().signal);
		const second = await probeGitWatch(remote, new AbortController().signal);
		expect(first.uncertain).toContain("index");
		expect(first.fingerprints.index).toBeUndefined();
		expect(changedGitCategories(first, second)).toEqual([]);
	});
	test("remote idle and equal-line edits never invalidate history; RPC output/time stays bounded", async () => {
		const calls: Record<string, unknown>[] = [];
		let content = "-old\n+new";
		let truncated = false;
		let head = "sha";
		const remote = target("remote");
		remote.backend = {
			kind: "remote",
			gitWorkspace: async (request: Record<string, unknown>) => {
				calls.push(request);
				if (request.operation === "fullDiff") return { stdout: content, truncated };
				if (request.operation === "stashList") return { stdout: "" };
				return { outputs: { status: " M file\0", head, branch: "main", stagedNumstat: "" } };
			},
		} as unknown as NonNullable<GitWorkspaceTarget["backend"]>;
		const sample = await probeGitWatch(remote, new AbortController().signal);
		expect(sample.uncertain).toEqual([]);
		expect(calls).toHaveLength(3);
		const idle = await probeGitWatch(remote, new AbortController().signal);
		expect(changedGitCategories(sample, idle)).toEqual([]);
		content = "-old\n+edit";
		const edited = await probeGitWatch(remote, new AbortController().signal);
		expect(changedGitCategories(idle, edited)).toEqual(["worktree"]);
		truncated = true;
		const capped = await probeGitWatch(remote, new AbortController().signal);
		expect(changedGitCategories(edited, capped)).toEqual(["worktree"]);
		head = "next";
		expect(
			changedGitCategories(capped, await probeGitWatch(remote, new AbortController().signal)),
		).toEqual(["head"]);
		for (const call of calls) {
			expect(call.maxBytes).toBe(WATCH_MAX_BYTES);
			expect(call.timeoutMs).toBe(5000);
			expect(call.expectedRoot).toBe("/repo");
		}
	});
	test("lightweight watch uses one RPC; truncation never forces a history reload", async () => {
		let calls = 0;
		let truncated = false;
		let content = "content";
		const remote = target("remote");
		remote.backend = {
			kind: "remote",
			supportsGitWorkspaceWatch: true,
			gitWorkspace: async (request: Record<string, unknown>) => {
				calls++;
				expect(request.operation).toBe("watch");
				return {
					truncated,
					outputs: {
						worktree: content,
						index: "index",
						head: "head",
						stash: "stash",
						uncertainWorktree: "false",
						stagingListsFingerprint: "remote-public-marker",
					},
				};
			},
		} as unknown as NonNullable<GitWorkspaceTarget["backend"]>;
		const first = await probeGitWatch(remote, new AbortController().signal);
		expect(calls).toBe(1);
		expect(first.stagingListsFingerprint).toBeUndefined();
		expect(
			changedGitCategories(first, await probeGitWatch(remote, new AbortController().signal)),
		).toEqual([]);
		content = "edited";
		const edited = await probeGitWatch(remote, new AbortController().signal);
		expect(changedGitCategories(first, edited)).toEqual(["worktree"]);
		truncated = true;
		const capped = await probeGitWatch(remote, new AbortController().signal);
		const next = await probeGitWatch(remote, new AbortController().signal);
		expect(changedGitCategories(capped, next)).not.toContain("head");
		expect(changedGitCategories(capped, next)).not.toContain("refs");
	});
});

describe("directory-owned Git snapshots", () => {
	test("opening an idle directory invalidates old TTL once, never again for additional readers", async () => {
		const fixture = coordinatedSnapshotFixture();
		const { reads, counts, requestedTtls } = fixture;
		const current = remoteTarget(1);
		const stops: Array<() => void> = [];
		try {
			await reads.status(current);
			await reads.lineStats(current);
			fixture.setPath("edited-with-no-subscribers");
			// Prove the pre-existing HTTP TTL still returns stale facts before opening.
			expect((await reads.status(current)).files[0]?.path).toBe("cached-before-opening");
			expect((await reads.lineStats(current)).files[0]?.path).toBe("cached-before-opening");
			expect(counts.status).toBe(1);
			expect(counts.lineStats).toBe(1);
			requestedTtls.length = 0;
			const pool = new GitWorkspaceWatchPool(fixture.probe, 5, reads);
			const snapshots: GitWorkspaceSnapshot[] = [];
			for (let i = 0; i < 10; i++)
				stops.push(
					pool.subscribe(
						current,
						() => {},
						(value) => snapshots.push(value),
					),
				);
			await waitFor(() => snapshots.at(-1)?.updating === false);
			expect(snapshots.at(-1)).toMatchObject({
				status: { files: [{ path: "edited-with-no-subscribers" }] },
				lineStats: { files: [{ path: "edited-with-no-subscribers" }] },
			});
			expect(requestedTtls).toEqual([
				{ kind: "status", ttlMs: 0 },
				{ kind: "lineStats", ttlMs: 0 },
			]);
			expect(counts.status).toBe(2);
			expect(counts.lineStats).toBe(2);
			expect(counts.invalidate).toBe(1);
			await waitFor(() => counts.validate >= 2);
			const late: GitWorkspaceSnapshot[] = [];
			stops.push(
				pool.subscribe(
					current,
					() => {},
					(value) => late.push(value),
				),
			);
			expect(late).toEqual([required(snapshots.at(-1))]);
			expect(counts.status).toBe(2);
			expect(counts.lineStats).toBe(2);
			expect(counts.invalidate).toBe(1);
		} finally {
			for (const stop of stops) stop();
			fixture.clear();
		}
	});

	test("the first baseline excludes status and line-stat operations started before observation", async () => {
		const fixture = coordinatedSnapshotFixture();
		const staleStatus = deferred<Awaited<ReturnType<typeof getGitWorkspaceStatus>>>();
		const staleLines = deferred<GitLineStats>();
		const oldStatusRequest = fixture.beginStatusRead(staleStatus.promise);
		const oldLineRequest = fixture.beginLineRead(staleLines.promise);
		const snapshots: GitWorkspaceSnapshot[] = [];
		let stop = () => {};
		try {
			await waitFor(() => fixture.counts.status === 1 && fixture.counts.lineStats === 1);
			fixture.setPath("edited-after-http-started");
			const pool = new GitWorkspaceWatchPool(fixture.probe, 5, fixture.reads);
			stop = pool.subscribe(
				remoteTarget(1),
				() => {},
				(value) => snapshots.push(value),
			);
			await waitFor(() => fixture.counts.invalidate === 1 && fixture.requestedTtls.length > 0);
			expect(fixture.counts.status).toBe(1);
			expect(snapshots.some((snapshot) => snapshot.status)).toBe(false);
			staleStatus.resolve(statusFacts("pre-baseline-status"));
			staleLines.resolve(lineFacts("pre-baseline-lines", 999));
			expect((await oldStatusRequest).files[0]?.path).toBe("pre-baseline-status");
			expect((await oldLineRequest).linesAdded).toBe(999);
			await waitFor(() => snapshots.at(-1)?.updating === false);
			expect(snapshots.at(-1)?.status?.files?.[0]?.path).toBe("edited-after-http-started");
			expect(snapshots.at(-1)?.lineStats?.files?.[0]?.path).toBe("edited-after-http-started");
			expect(
				snapshots.some(
					(snapshot) =>
						snapshot.status?.files?.[0]?.path === "pre-baseline-status" ||
						snapshot.lineStats?.linesAdded === 999,
				),
			).toBe(false);
			expect(fixture.counts.status).toBe(2);
			expect(fixture.counts.lineStats).toBe(2);
			expect(fixture.counts.invalidate).toBe(1);
		} finally {
			stop();
			staleStatus.resolve(statusFacts());
			staleLines.resolve(lineFacts());
			await Promise.allSettled([oldStatusRequest, oldLineRequest]);
			fixture.clear();
		}
	});

	test("a recovered initial probe invalidates slow status even before any status snapshot exists", async () => {
		const fixture = coordinatedSnapshotFixture();
		const staleStatus = deferred<Awaited<ReturnType<typeof getGitWorkspaceStatus>>>();
		const oldStatusRequest = fixture.beginStatusRead(staleStatus.promise);
		const recoveredProbe = deferred<Awaited<ReturnType<typeof fixture.probe>>>();
		const snapshots: GitWorkspaceSnapshot[] = [];
		let probes = 0;
		const pool = new GitWorkspaceWatchPool(
			async () => {
				probes++;
				if (probes === 1) throw new Error("Initial probe failed");
				return probes === 2 ? recoveredProbe.promise : fixture.probe();
			},
			5,
			fixture.reads,
		);
		let stop = () => {};
		try {
			await waitFor(() => fixture.counts.status === 1);
			stop = pool.subscribe(
				remoteTarget(1),
				() => {},
				(value) => snapshots.push(value),
			);
			await waitFor(() => probes === 2 && fixture.requestedTtls.length === 1);
			expect(snapshots.some((snapshot) => snapshot.status)).toBe(false);
			expect(fixture.counts.invalidate).toBe(0);
			expect(fixture.counts.lineStats).toBe(0);
			fixture.setPath("fresh-after-monitor-recovery");
			recoveredProbe.resolve(await fixture.probe());
			await waitFor(() => fixture.counts.invalidate === 1);
			staleStatus.resolve(statusFacts("old-status-before-monitor-recovery"));
			await oldStatusRequest;
			await waitFor(() => snapshots.at(-1)?.updating === false);
			expect(snapshots.at(-1)?.status?.files?.[0]?.path).toBe("fresh-after-monitor-recovery");
			expect(snapshots.at(-1)?.lineStats?.files?.[0]?.path).toBe("fresh-after-monitor-recovery");
			expect(
				snapshots.some(
					(snapshot) => snapshot.status?.files?.[0]?.path === "old-status-before-monitor-recovery",
				),
			).toBe(false);
			expect(fixture.counts.status).toBe(2);
			expect(fixture.counts.lineStats).toBe(1);
		} finally {
			stop();
			recoveredProbe.resolve({ fingerprints: { worktree: "cancelled" }, uncertain: [] });
			staleStatus.resolve(statusFacts());
			await Promise.allSettled([oldStatusRequest]);
			fixture.clear();
		}
	});

	test("a slow first probe precedes fresh facts and later edits still invalidate its baseline", async () => {
		const fixture = coordinatedSnapshotFixture();
		const { reads, counts, requestedTtls } = fixture;
		const initialProbe = deferred<Awaited<ReturnType<typeof fixture.probe>>>();
		const current = remoteTarget(1);
		let probes = 0;
		const pool = new GitWorkspaceWatchPool(
			async () => {
				probes++;
				return probes === 1 ? initialProbe.promise : fixture.probe();
			},
			20,
			reads,
		);
		let stop = () => {};
		try {
			await reads.status(current);
			await reads.lineStats(current);
			fixture.setPath("edited-before-probe");
			requestedTtls.length = 0;
			const snapshots: GitWorkspaceSnapshot[] = [];
			const changes: GitWorkspaceCategory[][] = [];
			stop = pool.subscribe(
				current,
				(categories) => changes.push(categories),
				(value) => snapshots.push(value),
			);
			await pause();
			expect(probes).toBe(1);
			expect(requestedTtls).toEqual([]);
			expect(counts.status).toBe(1);
			expect(counts.lineStats).toBe(1);
			expect(snapshots).toEqual([]);
			initialProbe.resolve(await fixture.probe());
			await waitFor(() => snapshots.at(-1)?.updating === false);
			expect(snapshots.at(-1)?.status?.files?.[0]?.path).toBe("edited-before-probe");
			expect(snapshots.at(-1)?.lineStats?.files?.[0]?.path).toBe("edited-before-probe");
			expect(changes[0]).toEqual([]);
			fixture.setPath("edited-after-first-snapshot");
			await waitFor(() => counts.invalidate === 2);
			expect(changes.some((categories) => categories.includes("worktree"))).toBe(true);
			await waitFor(
				() =>
					snapshots.at(-1)?.updating === false &&
					snapshots.at(-1)?.status?.files?.[0]?.path === "edited-after-first-snapshot",
			);
			expect(snapshots.at(-1)?.lineStats?.files?.[0]?.path).toBe("edited-after-first-snapshot");
			expect(counts.status).toBe(3);
			expect(counts.lineStats).toBe(3);
		} finally {
			stop();
			initialProbe.resolve({ fingerprints: { worktree: "cancelled" }, uncertain: [] });
			fixture.clear();
		}
	});

	test("an initial probe failure permits fresh facts, then successful baseline refreshes the unpaired snapshot", async () => {
		const fixture = coordinatedSnapshotFixture();
		const { reads, counts } = fixture;
		const recoveredProbe = deferred<Awaited<ReturnType<typeof fixture.probe>>>();
		const current = remoteTarget(1);
		let probes = 0;
		const pool = new GitWorkspaceWatchPool(
			async () => {
				probes++;
				if (probes === 1) throw new Error("Initial monitor unavailable");
				return probes === 2 ? recoveredProbe.promise : fixture.probe();
			},
			5,
			reads,
		);
		let stop = () => {};
		try {
			await reads.status(current);
			await reads.lineStats(current);
			fixture.setPath("fresh-despite-monitor-failure");
			const snapshots: GitWorkspaceSnapshot[] = [];
			stop = pool.subscribe(
				current,
				() => {},
				(value) => snapshots.push(value),
			);
			await waitFor(() => snapshots.at(-1)?.updating === false);
			expect(snapshots.at(-1)?.status?.files?.[0]?.path).toBe("fresh-despite-monitor-failure");
			expect(snapshots.at(-1)?.lineStats?.files?.[0]?.path).toBe("fresh-despite-monitor-failure");
			expect(counts.status).toBe(2);
			expect(counts.lineStats).toBe(2);
			expect(counts.invalidate).toBe(0);
			await waitFor(() => probes === 2);
			fixture.setPath("changed-before-first-successful-probe");
			recoveredProbe.resolve(await fixture.probe());
			await waitFor(() => counts.invalidate === 1);
			await waitFor(
				() =>
					snapshots.at(-1)?.updating === false &&
					snapshots.at(-1)?.status?.files?.[0]?.path === "changed-before-first-successful-probe",
			);
			expect(snapshots.at(-1)?.lineStats?.files?.[0]?.path).toBe(
				"changed-before-first-successful-probe",
			);
			expect(counts.status).toBe(3);
			expect(counts.lineStats).toBe(3);
		} finally {
			stop();
			recoveredProbe.resolve({ fingerprints: { worktree: "cancelled" }, uncertain: [] });
			fixture.clear();
		}
	});

	test("ten readers share one load; staggered readers reuse facts without invalidation", async () => {
		const { pool, counts } = snapshotFixture();
		const received = Array.from({ length: 10 }, () => [] as GitWorkspaceSnapshot[]);
		const stops = received.map((snapshots) =>
			pool.subscribe(
				remoteTarget(1),
				() => {},
				(value) => snapshots.push(value),
			),
		);
		try {
			await waitFor(() => received.every((values) => values.at(-1)?.updating === false));
			expect(counts.status).toBe(1);
			expect(counts.lineStats).toBe(1);
			expect(counts.invalidate).toBe(1);
			for (const values of received) {
				expect(values).toHaveLength(3);
				expect(new Set(values.map((value) => value.revision)).size).toBe(1);
				expect(values.map((value) => value.updating)).toEqual([true, true, false]);
			}
			const late: GitWorkspaceSnapshot[] = [];
			await waitFor(() => counts.validate >= 2);
			stops.push(
				pool.subscribe(
					remoteTarget(1),
					() => {},
					(value) => late.push(value),
				),
			);
			expect(late).toEqual([required(received[0]?.at(-1))]);
			await waitFor(() => counts.validate >= 4);
			expect(counts.status).toBe(1);
			expect(counts.lineStats).toBe(1);
			expect(counts.invalidate).toBe(1);
		} finally {
			for (const stop of stops) stop();
		}
		const after = { ...counts };
		await pause();
		expect(counts).toEqual(after);
	});

	test("publishes status before slow line statistics and finishes the same revision", async () => {
		const { pool, reads, counts } = snapshotFixture();
		const line = deferred<GitLineStats>();
		reads.lineStats = async () => {
			counts.lineStats++;
			return line.promise;
		};
		const snapshots: GitWorkspaceSnapshot[] = [];
		const stop = pool.subscribe(
			remoteTarget(1),
			() => {},
			(value) => snapshots.push(value),
		);
		try {
			await waitFor(() => counts.lineStats === 1);
			expect(snapshots).toHaveLength(2);
			expect(snapshots.at(-1)).toMatchObject({ status: statusFacts(), updating: true });
			expect(snapshots.at(-1)?.lineStats).toBeUndefined();
			line.resolve(lineFacts());
			await waitFor(() => snapshots.at(-1)?.updating === false);
			expect(snapshots.at(-1)?.lineStats).toEqual(lineFacts());
			expect(new Set(snapshots.map((value) => value.revision)).size).toBe(1);
		} finally {
			line.resolve(lineFacts());
			stop();
		}
	});

	test("changes during a dirty read discard stale stats and run exactly one trailing refresh", async () => {
		const { pool, reads, counts, change } = snapshotFixture();
		const old = deferred<GitLineStats>();
		reads.lineStats = async () => {
			counts.lineStats++;
			return counts.lineStats === 1 ? old.promise : lineFacts("file", 20);
		};
		const snapshots: GitWorkspaceSnapshot[] = [];
		const stop = pool.subscribe(
			remoteTarget(1),
			() => {},
			(value) => snapshots.push(value),
		);
		try {
			await waitFor(() => counts.lineStats === 1);
			const originalRevision = required(snapshots.at(-1)).revision;
			change("second");
			await waitFor(() => counts.invalidate === 2);
			change("third");
			await waitFor(() => counts.invalidate === 3);
			const dirtyRevision = required(snapshots.at(-1)).revision;
			expect(dirtyRevision).toBeGreaterThan(originalRevision);
			old.resolve(lineFacts("old", 999));
			await waitFor(() => snapshots.at(-1)?.updating === false);
			expect(snapshots.some((value) => value.lineStats?.linesAdded === 999)).toBe(false);
			expect(snapshots.at(-1)).toMatchObject({
				revision: dirtyRevision,
				lineStats: { linesAdded: 20 },
			});
			expect(counts.status).toBe(2);
			expect(counts.lineStats).toBe(2);
			await pause();
			expect(counts.status).toBe(2);
		} finally {
			old.resolve(lineFacts());
			stop();
		}
	});

	test("explicit refresh invalidates and reloads only its directory with a newer revision", async () => {
		const { pool, counts } = snapshotFixture();
		const a: GitWorkspaceSnapshot[] = [];
		const b: GitWorkspaceSnapshot[] = [];
		const other = {
			...remoteTarget(1),
			workspace: { ...remoteTarget(1).workspace, workspaceKey: "other", rootPath: "/other" },
		};
		const stops = [
			pool.subscribe(
				remoteTarget(1),
				() => {},
				(value) => a.push(value),
			),
			pool.subscribe(
				other,
				() => {},
				(value) => b.push(value),
			),
		];
		try {
			await waitFor(() => a.at(-1)?.updating === false && b.at(-1)?.updating === false);
			const beforeA = required(a.at(-1)).revision;
			const beforeB = required(b.at(-1));
			pool.refresh(remoteTarget(1));
			await waitFor(() => a.at(-1)?.updating === false && required(a.at(-1)).revision > beforeA);
			expect(counts.invalidate).toBe(3);
			expect(counts.status).toBe(3);
			expect(counts.lineStats).toBe(3);
			expect(b.at(-1)).toBe(beforeB);
			expect(required(a.at(-1)).revision).toBeGreaterThan(beforeB.revision);
		} finally {
			for (const stop of stops) stop();
		}
	});

	test("generation replacement cancels old stats and cannot mix them into new status", async () => {
		const { pool, reads, counts } = snapshotFixture();
		const old = deferred<GitLineStats>();
		let oldSignal: AbortSignal | undefined;
		reads.status = async (current) => {
			counts.status++;
			return statusFacts(`generation-${current.backend?.runtimeGeneration}`);
		};
		reads.lineStats = async (current, signal) => {
			counts.lineStats++;
			if (current.backend?.runtimeGeneration === 1) {
				oldSignal = signal;
				return old.promise;
			}
			return lineFacts("generation-2", 7);
		};
		const snapshots: GitWorkspaceSnapshot[] = [];
		const stops = [
			pool.subscribe(
				remoteTarget(1),
				() => {},
				(value) => snapshots.push(value),
			),
		];
		try {
			await waitFor(() => counts.lineStats === 1);
			stops.push(
				pool.subscribe(
					remoteTarget(2),
					() => {},
					(value) => snapshots.push(value),
				),
			);
			expect(oldSignal?.aborted).toBe(true);
			old.resolve(lineFacts("generation-1", 999));
			await waitFor(() => snapshots.at(-1)?.updating === false);
			expect(snapshots.at(-1)).toMatchObject({
				status: { files: [{ path: "generation-2" }] },
				lineStats: { linesAdded: 7, files: [{ path: "generation-2" }] },
			});
			expect(snapshots.some((value) => value.lineStats?.linesAdded === 999)).toBe(false);
			expect(counts.status).toBe(2);
			expect(counts.lineStats).toBe(2);
		} finally {
			old.resolve(lineFacts());
			for (const stop of stops) stop();
		}
	});

	test("unsupported line statistics are not retried until the runtime generation changes", async () => {
		const { pool, reads, counts } = snapshotFixture();
		reads.lineStats = async (current) => {
			counts.lineStats++;
			if (current.backend?.runtimeGeneration === 1)
				throw new AppError("Upgrade required", 409, "GIT_LINE_STATS_UNSUPPORTED");
			return lineFacts();
		};
		const snapshots: GitWorkspaceSnapshot[] = [];
		const stops = [
			pool.subscribe(
				remoteTarget(1),
				() => {},
				(value) => snapshots.push(value),
			),
		];
		try {
			await waitFor(() => snapshots.at(-1)?.updating === false);
			expect(snapshots.at(-1)).toMatchObject({
				lineStatsError: "GIT_LINE_STATS_UNSUPPORTED",
				status: statusFacts(),
			});
			expect(counts.lineStats).toBe(1);
			pool.refresh(remoteTarget(1));
			await waitFor(() => counts.status === 2 && snapshots.at(-1)?.updating === false);
			expect(counts.lineStats).toBe(1);
			expect(snapshots.at(-1)?.lineStatsError).toBe("GIT_LINE_STATS_UNSUPPORTED");
			stops.push(
				pool.subscribe(
					remoteTarget(2),
					() => {},
					(value) => snapshots.push(value),
				),
			);
			await waitFor(() => counts.status === 3 && snapshots.at(-1)?.updating === false);
			expect(counts.lineStats).toBe(2);
			expect(snapshots.at(-1)?.lineStats).toEqual(lineFacts());
			expect(snapshots.at(-1)?.lineStatsError).toBeUndefined();
		} finally {
			for (const stop of stops) stop();
		}
	});

	test("last unsubscribe aborts the read and suppresses its late publication", async () => {
		const { pool, reads, counts } = snapshotFixture();
		const pending = deferred<Awaited<ReturnType<typeof getGitWorkspaceStatus>>>();
		let signal: AbortSignal | undefined;
		reads.status = async (_target, currentSignal) => {
			counts.status++;
			signal = currentSignal;
			return pending.promise;
		};
		const snapshots: GitWorkspaceSnapshot[] = [];
		const stop = pool.subscribe(
			remoteTarget(1),
			() => {},
			(value) => snapshots.push(value),
		);
		try {
			await waitFor(() => counts.status === 1);
			stop();
			expect(signal?.aborted).toBe(true);
			pending.resolve(statusFacts());
			await pause();
			expect(snapshots).toHaveLength(1);
			expect(counts.lineStats).toBe(0);
		} finally {
			pending.resolve(statusFacts());
			stop();
		}
	});

	test("bounded details retain whole-measurement totals and independent partial flags", () => {
		const files = Array.from({ length: 250 }, (_, i) => ({ status: " M", path: `file-${i}` }));
		const input: GitWorkspaceSnapshot = {
			revision: 42,
			updating: false,
			status: { ...statusFacts(), files, totalFiles: 250 },
			lineStats: {
				linesAdded: 1000,
				linesRemoved: 20,
				complete: false,
				files: files.map(({ path }) => ({ path, complete: false })),
			},
		};
		const bounded = boundGitSnapshot(input);
		expect(bounded.status?.files).toHaveLength(200);
		expect(bounded.lineStats?.files).toHaveLength(200);
		expect(bounded).toMatchObject({
			detailsTruncated: true,
			status: { totalFiles: 250, totalFilesExact: true, truncated: true },
			lineStats: { linesAdded: 1000, linesRemoved: 20, complete: false },
		});
		expect(projectGitSnapshot(bounded, "details")).toBe(bounded);
		const summary = JSON.parse(JSON.stringify(projectGitSnapshot(bounded, "summary")));
		expect(summary.status.files).toBeUndefined();
		expect(summary.lineStats.files).toBeUndefined();
		expect(summary.detailsTruncated).toBeUndefined();
		expect(summary.lineStats.complete).toBe(false);
		expect(summary.status.totalFiles).toBe(250);
		expect(input.status?.files).toHaveLength(250);
		const complete = boundGitSnapshot({
			...input,
			lineStats: { ...required(input.lineStats), complete: true },
		});
		expect(complete.detailsTruncated).toBe(true);
		expect(complete.lineStats?.complete).toBe(true);
	});

	test("byte budget bounds multibyte paths and keeps only matching line details", () => {
		const files = Array.from({ length: 200 }, (_, i) => ({
			status: " M",
			path: `${i}-${"界".repeat(1200)}`,
		}));
		const bounded = boundGitSnapshot({
			revision: 1,
			updating: false,
			status: { ...statusFacts(), files, totalFiles: 200 },
			lineStats: {
				...lineFacts(),
				files: [
					...files.map(({ path }) => ({ path, complete: true })),
					{ path: "not-in-status", complete: true },
				],
			},
		});
		expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
			GIT_SNAPSHOT_MAX_BYTES - 4096,
		);
		expect(bounded.status?.files?.length).toBeGreaterThan(0);
		expect(bounded.status?.files?.length).toBeLessThan(200);
		expect(bounded.lineStats?.files?.map((file) => file.path)).toEqual(
			bounded.status?.files?.map((file) => file.path),
		);
		expect(bounded.detailsTruncated).toBe(true);
		expect(bounded.lineStats?.complete).toBe(true);
	});
});

describe("watch-owned paging cache production", () => {
	const cache = (memberVersion = 1, statsVersion = 0): GitStatusPageCacheState => ({
		status: "ready",
		workerEpoch: "worker-1",
		memberVersion,
		statsVersion,
		updating: statsVersion === 0,
	});

	test("first subscription prewarms while its initial fingerprint probe is still pending", async () => {
		const fixture = snapshotFixture();
		const probe = deferred<{ fingerprints: { worktree: string }; uncertain: [] }>();
		let productions = 0;
		const pool = new GitWorkspaceWatchPool(async () => probe.promise, 5, {
			...fixture.reads,
			observePages: async () => {
				productions++;
				return cache(1, 1);
			},
		});
		const off = pool.subscribe(
			target(),
			() => {},
			() => {},
		);
		try {
			await waitFor(() => productions === 1);
		} finally {
			off();
			probe.resolve({ fingerprints: { worktree: "first" }, uncertain: [] });
		}
	});

	test("first subscription prewarms once and sends complete statistics before the 200-file projection", async () => {
		const fixture = snapshotFixture();
		const release = deferred<void>();
		const snapshots: GitWorkspaceSnapshot[] = [];
		const files = Array.from({ length: 561 }, (_, i) => ({ path: `dir/f-${i}`, status: " M" }));
		let productions = 0;
		let released = 0;
		let fullCount = 0;
		const reads = {
			...fixture.reads,
			status: async () => ({ ...statusFacts(), files, totalFiles: files.length }),
			lineStats: async () => {
				fixture.counts.lineStats++;
				return {
					...lineFacts(),
					files: files.map(({ path }) => ({
						path,
						unstagedLinesAdded: 2,
						unstagedLinesRemoved: 1,
						complete: true,
					})),
				};
			},
			observePages: async (
				_target: GitWorkspaceTarget,
				signal: AbortSignal,
				readStats: (signal: AbortSignal) => Promise<GitLineStats>,
				onPublished?: (cache: GitStatusPageCacheState) => void,
			) => {
				productions++;
				onPublished?.(cache());
				await release.promise;
				fullCount = (await readStats(signal)).files.length;
				return cache(1, 1);
			},
			pagesState: async () => cache(1, 1),
			releasePages: () => {
				released++;
			},
		};
		const pool = new GitWorkspaceWatchPool(
			async () => ({ fingerprints: { worktree: "same" }, uncertain: [] }),
			5,
			reads,
		);
		const first = pool.subscribe(
			target(),
			() => {},
			(value) => snapshots.push(value),
		);
		const second = pool.subscribe(
			target(),
			() => {},
			(value) => snapshots.push(value),
		);
		try {
			await waitFor(() => snapshots.some((value) => value.statusPages?.memberVersion === 1));
			expect(
				snapshots.some(
					(value) => value.statusPages?.statsVersion === 0 && value.statusPages.updating,
				),
			).toBe(true);
			release.resolve();
			await waitFor(() =>
				snapshots.some((value) => value.statusPages?.statsVersion === 1 && !value.updating),
			);
			expect(productions).toBe(1);
			expect(fullCount).toBe(561);
			expect(fixture.counts.lineStats).toBe(1);
			expect(snapshots.at(-1)?.status?.files).toHaveLength(200);
			expect(snapshots.at(-1)?.lineStats?.files).toHaveLength(200);
			first();
			expect(released).toBe(0);
		} finally {
			second();
			first();
		}
		expect(released).toBe(1);
	});

	test("dirty advances before production and burst edits allow only one trailing publication", async () => {
		const fixture = snapshotFixture();
		const gate = deferred<void>();
		const order: string[] = [];
		const snapshots: GitWorkspaceSnapshot[] = [];
		let fingerprint = "a";
		let productions = 0;
		let validations = 0;
		const pool = new GitWorkspaceWatchPool(
			async () => ({ fingerprints: { worktree: fingerprint }, uncertain: [] }),
			5,
			{
				...fixture.reads,
				invalidate: () => {
					order.push("dirty");
				},
				validatePages: async () => {
					validations++;
					return { changed: false, reliable: true };
				},
				observePages: async (_target, _signal, _readStats, onPublished) => {
					const round = ++productions;
					order.push("produce");
					if (round === 1) await gate.promise;
					onPublished?.(cache(round, round));
					return cache(round, round);
				},
			},
		);
		const off = pool.subscribe(
			target(),
			() => {},
			(value) => snapshots.push(value),
		);
		try {
			await waitFor(() => productions === 1);
			fingerprint = "b";
			await waitFor(() => order.filter((value) => value === "dirty").length === 2);
			for (let i = 0; i < 10; i++) {
				fingerprint = `change-${i}`;
				await pause(6);
			}
			gate.resolve();
			await waitFor(() =>
				snapshots.some((value) => value.statusPages?.memberVersion === 2 && !value.updating),
			);
			expect(order[0]).toBe("dirty");
			expect(order[1]).toBe("produce");
			expect(productions).toBe(2);
			expect(validations).toBe(0);
			expect(snapshots.some((value) => value.statusPages?.memberVersion === 1)).toBe(false);
		} finally {
			off();
			gate.resolve();
		}
	});

	test("capacity busy is stable until released capacity makes the existing subscription retryable", async () => {
		const fixture = snapshotFixture();
		const snapshots: GitWorkspaceSnapshot[] = [];
		let productions = 0;
		let admitted = false;
		const state = (): GitStatusPageCacheState =>
			admitted
				? cache(1, 1)
				: { ...cache(0, 0), status: "error", updating: false, errorCode: "GIT_STATUS_PAGE_BUSY" };
		let capacityReleased = false;
		const pool = new GitWorkspaceWatchPool(
			async () => ({ fingerprints: { worktree: "same" }, uncertain: [] }),
			5,
			{
				...fixture.reads,
				observePages: async () => {
					productions++;
					if (capacityReleased) admitted = true;
					return state();
				},
				pagesState: async () =>
					capacityReleased && !admitted
						? { ...cache(0, 0), status: "pending", updating: false }
						: state(),
			},
		);
		const off = pool.subscribe(
			target(),
			() => {},
			(value) => snapshots.push(value),
		);
		try {
			await waitFor(() =>
				snapshots.some(
					(value) => value.statusPages?.errorCode === "GIT_STATUS_PAGE_BUSY" && !value.updating,
				),
			);
			await pause(50);
			expect(productions).toBe(1);
			capacityReleased = true;
			await waitFor(() =>
				snapshots.some((value) => value.statusPages?.memberVersion === 1 && !value.updating),
			);
			expect(productions).toBe(2);
		} finally {
			off();
		}
	});

	test("failed production exposes error and an existing subscription wakes after Worker loss", async () => {
		const fixture = snapshotFixture();
		const snapshots: GitWorkspaceSnapshot[] = [];
		let productions = 0;
		let lost = false;
		let currentCache = cache(1, 1);
		const pool = new GitWorkspaceWatchPool(
			async () => ({ fingerprints: { worktree: "same" }, uncertain: [] }),
			5,
			{
				...fixture.reads,
				observePages: async () => {
					productions++;
					if (productions === 1) throw new Error("worker unavailable");
					currentCache = {
						...cache(productions, productions),
						workerEpoch: lost ? "worker-2" : "worker-1",
					};
					lost = false;
					return currentCache;
				},
				pagesState: async () =>
					productions === 1 || lost
						? { ...cache(0, 0), status: "pending", workerEpoch: "worker-2" }
						: currentCache,
			},
		);
		const off = pool.subscribe(
			target(),
			() => {},
			(value) => snapshots.push(value),
		);
		try {
			await waitFor(() => snapshots.some((value) => value.statusPages?.status === "error"));
			await waitFor(() =>
				snapshots.some((value) => value.statusPages?.memberVersion === 2 && !value.updating),
			);
			lost = true;
			await waitFor(() =>
				snapshots.some(
					(value) =>
						value.statusPages?.workerEpoch === "worker-2" &&
						value.statusPages.memberVersion === 3 &&
						!value.updating,
				),
			);
			expect(productions).toBe(3);
		} finally {
			off();
		}
	}, 7000);
});
