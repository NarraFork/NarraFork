import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { GitLineStats } from "@shared/git-line-stats";
import * as spawn from "../lib/spawn";
import { closeGitLineStatsWorkers, getGitLineStats } from "./git-line-stats";
import {
	clearGitLineStatsCache,
	getGitLineStatsCached,
	invalidateGitLineStats,
	invalidateLocalGitLineStats,
} from "./git-line-stats-cache";
import { getLocalGitStatusQueryKey } from "./git-status-query";

const stats = (added = 1): GitLineStats => ({
	files: [],
	linesAdded: added,
	linesRemoved: 0,
	complete: true,
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(clearGitLineStatsCache);
afterAll(closeGitLineStatsWorkers);

describe("independent Git line statistics cache", () => {
	test("defaults to 5s, permits TTL overrides and bounds completed results to 128", async () => {
		let now = 0;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		let calls = 0;
		const load = async () => stats(++calls);
		try {
			await getGitLineStatsCached("first", load);
			now = 4999;
			expect((await getGitLineStatsCached("first", load)).linesAdded).toBe(1);
			now = 5000;
			expect((await getGitLineStatsCached("first", load)).linesAdded).toBe(2);
			expect((await getGitLineStatsCached("first", load, undefined, 0)).linesAdded).toBe(3);
			for (let i = 0; i < 128; i++) await getGitLineStatsCached(`other-${i}`, async () => stats());
			expect((await getGitLineStatsCached("first", load)).linesAdded).toBe(4);
		} finally {
			clock.mockRestore();
		}
	});

	test("two authorized surfaces share one read and its short-lived result", async () => {
		const pending = deferred<GitLineStats>();
		let calls = 0;
		const load = () => {
			calls++;
			return pending.promise;
		};
		const a = getGitLineStatsCached("same", load);
		const b = getGitLineStatsCached("same", load);
		await turn();
		expect(calls).toBe(1);
		pending.resolve(stats());
		expect(await a).toEqual(await b);
		expect(await getGitLineStatsCached("same", load)).toEqual(stats());
		expect(calls).toBe(1);
	});

	test("invalidation queues a fresh read and old completion cannot republish", async () => {
		const pending = deferred<GitLineStats>();
		const old = getGitLineStatsCached("same", () => pending.promise);
		await turn();
		invalidateGitLineStats("same");
		let calls = 0;
		const load = async () => {
			calls++;
			return stats(9);
		};
		const fresh = getGitLineStatsCached("same", load);
		pending.resolve(stats(1));
		expect((await old).linesAdded).toBe(1);
		expect((await fresh).linesAdded).toBe(9);
		expect((await getGitLineStatsCached("same", load)).linesAdded).toBe(9);
		expect(calls).toBe(1);
	});

	test("a cancelled surface does not abort its remaining reader", async () => {
		const pending = deferred<GitLineStats>();
		const controller = new AbortController();
		let shared: AbortSignal | undefined;
		const load = (signal: AbortSignal) => {
			shared = signal;
			return pending.promise;
		};
		const a = getGitLineStatsCached("same", load, controller.signal);
		const b = getGitLineStatsCached("same", load);
		const results = Promise.allSettled([a, b]);
		await turn();
		controller.abort();
		expect(shared?.aborted).toBe(false);
		pending.resolve(stats());
		expect((await results).map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
	});

	test("shared multi-batch reads survive one cancellation and invalidation publishes only the fresh round", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "nf-git-lines-cache-"));
		const paths = Array.from({ length: 254 }, (_, index) => `file-${index}`);
		const batchStarted = deferred<void>();
		const postMessage = Worker.prototype.postMessage;
		let held: { worker: Worker; message: unknown } | undefined;
		const git = spyOn(spawn, "safeSpawn").mockImplementation(async (options) => {
			if (options.cmd.includes("ls-files"))
				options.stdoutStream?.onChunk(Buffer.from(`${paths.join("\0")}\0`));
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		const post = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
			this: Worker,
			message: unknown,
		) {
			const request = message as { action: string; paths: string[] };
			if (request.action === "read" && request.paths[0] === paths[200] && !held) {
				held = { worker: this, message };
				batchStarted.resolve();
				return;
			}
			postMessage.call(this, message);
		});
		try {
			for (const path of paths) await writeFile(join(cwd, path), "one\n");
			let loads = 0;
			let shared: AbortSignal | undefined;
			const load = (signal: AbortSignal) => {
				loads++;
				shared = signal;
				return getGitLineStats(cwd, signal);
			};
			const controller = new AbortController();
			const a = getGitLineStatsCached(cwd, load, controller.signal).catch((error) => error);
			const b = getGitLineStatsCached(cwd, load);
			await batchStarted.promise;
			controller.abort(new Error("cancel one surface"));
			expect(await a).toBeInstanceOf(Error);
			expect(shared?.aborted).toBe(false);
			await writeFile(join(cwd, paths[0]), "one\ntwo\n");
			invalidateGitLineStats(cwd);
			const fresh = getGitLineStatsCached(cwd, load);
			if (!held) throw new Error("Second batch did not start");
			postMessage.call(held.worker, held.message);
			expect(await b).toMatchObject({ linesAdded: 254, complete: true });
			expect(await fresh).toMatchObject({ linesAdded: 255, complete: true });
			expect(await getGitLineStatsCached(cwd, load)).toMatchObject({
				linesAdded: 255,
				complete: true,
			});
			expect(loads).toBe(2);
		} finally {
			clearGitLineStatsCache();
			post.mockRestore();
			git.mockRestore();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("the last cancellation aborts underlying work and never caches it", async () => {
		const pending = deferred<GitLineStats>();
		const controller = new AbortController();
		let shared: AbortSignal | undefined;
		const request = getGitLineStatsCached(
			"same",
			(signal) => {
				shared = signal;
				return pending.promise;
			},
			controller.signal,
		);
		const result = Promise.allSettled([request]);
		await turn();
		controller.abort();
		await result;
		expect(shared?.aborted).toBe(true);
		pending.resolve(stats(99));
		await turn();
		expect((await getGitLineStatsCached("same", async () => stats(2))).linesAdded).toBe(2);
	});

	test("failed reads can be retried and devices/generations never share", async () => {
		await expect(
			getGitLineStatsCached("bad", async () => {
				throw new Error("failed");
			}),
		).rejects.toThrow("failed");
		expect(await getGitLineStatsCached("bad", async () => stats())).toEqual(stats());
		for (const [key, added] of [
			["remote:a:1", 1],
			["remote:a:2", 2],
			["remote:b:1", 3],
		] as const)
			expect((await getGitLineStatsCached(key, async () => stats(added))).linesAdded).toBe(added);
	});

	test("root changes invalidate scoped counts without touching sibling repos or remote keys", async () => {
		const scoped = getLocalGitStatusQueryKey("/repo/sub");
		const sibling = getLocalGitStatusQueryKey("/repo2");
		const remote = JSON.stringify(["remote", "a", 1, "/repo", "/repo"]);
		for (const key of [scoped, sibling, remote])
			await getGitLineStatsCached(key, async () => stats(1));
		invalidateLocalGitLineStats("/repo");
		for (const [key, wanted] of [
			[scoped, 2],
			[sibling, 1],
			[remote, 1],
		] as const)
			expect((await getGitLineStatsCached(key, async () => stats(2))).linesAdded).toBe(wanted);
	});

	test("partial results retain their completeness flag and do not become fake complete zero", async () => {
		const partial = { ...stats(0), complete: false };
		expect(await getGitLineStatsCached("partial", async () => partial)).toEqual(partial);
	});
});
