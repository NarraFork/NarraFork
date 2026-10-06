import { describe, expect, test } from "bun:test";
import type { GitWorkspaceCategory } from "@shared/git-workspace-events";
import type { GitWorkspaceTarget } from "./git-workspace";
import {
	changedGitCategories,
	GitWorkspaceWatchPool,
	probeGitWatch,
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
const pause = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

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
			expect(events.slice(0, 2)).toEqual([["worktree"], ["worktree"]]);
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
		expect(events[0]).toEqual(["worktree"]);
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
		).toEqual(["worktree", "head"]);
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
					},
				};
			},
		} as unknown as NonNullable<GitWorkspaceTarget["backend"]>;
		const first = await probeGitWatch(remote, new AbortController().signal);
		expect(calls).toBe(1);
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
