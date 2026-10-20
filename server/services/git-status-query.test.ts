import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "../lib/logger";
import type { GitStatusSummary } from "./git-service";
import {
	GitStatusQueryCoordinator,
	getLocalGitStatusQueryKey,
	localGitStatusScopesOverlap,
} from "./git-status-query";

function summary(branch = "main"): GitStatusSummary {
	return {
		branch,
		headSha: "abc",
		files: [],
		hasChanges: false,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		totalFiles: 0,
	};
}
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

describe("Git status query coordination", () => {
	test("slow diagnostics separate queue and loader wall time without changing shared results", async () => {
		const c = new GitStatusQueryCoordinator({ concurrency: 1, queued: 8, timeoutMs: 30_000 });
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const first = deferred<GitStatusSummary>();
		const second = deferred<GitStatusSummary>();
		try {
			const a = c.query("a", () => first.promise);
			await turn();
			now = 100;
			const b = c.query("b", () => second.promise);
			const shared = c.query("b", () => Promise.reject(new Error("must share")));
			now = 1200;
			first.resolve(summary());
			await a;
			await turn();
			now = 1600;
			second.resolve(summary("second"));
			expect(await b).toBe(await shared);
			expect(warn.mock.calls[1]?.[1]).toMatchObject({
				elapsedMs: 1500,
				queueMs: 1100,
				loaderMs: 400,
				source: "miss",
				readers: 2,
				peakReaders: 2,
				shared: true,
				runningAtStart: 1,
				trailing: false,
				outcome: "success",
			});
			await c.query("b", () => Promise.reject(new Error("must cache")));
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			c.clear();
			clock.mockRestore();
			warn.mockRestore();
		}
	});

	test("slow errors and queued cancellation preserve rejection and zero loader time", async () => {
		const c = new GitStatusQueryCoordinator({ concurrency: 1, queued: 8, timeoutMs: 30_000 });
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const pending = deferred<GitStatusSummary>();
		try {
			const error = new Error("failure");
			const active = c.query("active", () => pending.promise);
			const rejected = active.catch((reason) => reason);
			await turn();
			const controller = new AbortController();
			const queued = c.query("queued", async () => summary(), { signal: controller.signal });
			const cancelled = queued.catch((reason) => reason);
			now = 1500;
			controller.abort(error);
			expect(await cancelled).toBe(error);
			expect(warn.mock.calls[0]?.[1]).toMatchObject({
				queueMs: 1500,
				loaderMs: 0,
				outcome: "cancelled",
			});
			pending.reject(error);
			expect(await rejected).toBe(error);
			await turn();
			expect(warn.mock.calls[1]?.[1]).toMatchObject({
				queueMs: 0,
				loaderMs: 1500,
				outcome: "error",
			});
		} finally {
			c.clear();
			clock.mockRestore();
			warn.mockRestore();
		}
	});
	test("ten readers share one fresh query and staggered reads reuse the default 3s result", async () => {
		const c = new GitStatusQueryCoordinator();
		const clock = spyOn(Date, "now");
		let now = 10_000;
		clock.mockImplementation(() => now);
		let calls = 0;
		const pending = deferred<GitStatusSummary>();
		const load = () => {
			calls++;
			return pending.promise;
		};
		try {
			const readers = Array.from({ length: 10 }, () => c.query("repo", load, { ttlMs: 0 }));
			await turn();
			expect(calls).toBe(1);
			pending.resolve(summary());
			await Promise.all(readers);
			for (const elapsed of [100, 1000, 2999]) {
				now = 10_000 + elapsed;
				await c.query("repo", load);
			}
			expect(calls).toBe(1);
			now = 13_000;
			await c.query("repo", load);
			expect(calls).toBe(2);
		} finally {
			clock.mockRestore();
			c.clear();
		}
	});

	test("validation extends only existing clean values and never clears dirty", async () => {
		const c = new GitStatusQueryCoordinator();
		const clock = spyOn(Date, "now");
		let now = 0;
		clock.mockImplementation(() => now);
		let calls = 0;
		const load = async () => summary(String(++calls));
		try {
			c.validate("missing");
			expect(c.size).toBe(0);
			await c.query("repo", load);
			now = 2999;
			c.validate("repo");
			now = 5000;
			expect((await c.query("repo", load)).branch).toBe("1");
			c.invalidate("repo");
			c.validate("repo");
			expect(c.peek("repo")?.branch).toBe("1");
			expect((await c.query("repo", load)).branch).toBe("2");
			now = 5100;
			await c.query("repo", load, { ttlMs: 50 });
			expect(calls).toBe(3);
			c.clear();
			expect(c.size).toBe(0);
		} finally {
			clock.mockRestore();
			c.clear();
		}
	});

	test("invalidated completion without a trailing reader cannot become a fresh hit", async () => {
		const c = new GitStatusQueryCoordinator();
		await c.query("repo", async () => summary("last"));
		const pending = deferred<GitStatusSummary>();
		const old = c.query("repo", () => pending.promise, { ttlMs: 0 });
		await turn();
		c.invalidate("repo");
		pending.resolve(summary("old"));
		await old;
		expect(c.peek("repo")?.branch).toBe("last");
		c.validate("repo");
		expect((await c.query("repo", async () => summary("new"))).branch).toBe("new");
	});

	test("same target shares one query, but a later fresh read runs again", async () => {
		const c = new GitStatusQueryCoordinator();
		const first = deferred<GitStatusSummary>();
		let calls = 0;
		const loader = async () => {
			calls++;
			return calls === 1 ? first.promise : summary("fresh");
		};
		const a = c.query("repo", loader);
		const b = c.query("repo", loader);
		await turn();
		expect(calls).toBe(1);
		first.resolve(summary());
		expect(await a).toEqual(await b);
		expect((await c.query("repo", loader, { ttlMs: 0 })).branch).toBe("fresh");
		expect(calls).toBe(2);
	});

	test("invalidation coalesces one trailing refresh without overlapping the old query", async () => {
		const c = new GitStatusQueryCoordinator();
		const first = deferred<GitStatusSummary>();
		let calls = 0;
		const loader = async () => {
			calls++;
			return calls === 1 ? first.promise : summary("after-write");
		};
		const old = c.query("repo", loader);
		await turn();
		c.invalidate("repo");
		const a = c.query("repo", loader);
		c.invalidate("repo");
		const b = c.query("repo", loader);
		await turn();
		expect(calls).toBe(1);
		first.resolve(summary("before-write"));
		expect((await old).branch).toBe("before-write");
		expect((await a).branch).toBe("after-write");
		expect(await b).toEqual(await a);
		expect(calls).toBe(2);
	});

	test("one reader aborts independently; the last reader aborts underlying work", async () => {
		const c = new GitStatusQueryCoordinator();
		const first = deferred<GitStatusSummary>();
		let underlying: AbortSignal | undefined;
		const loader = (signal: AbortSignal) => {
			underlying = signal;
			return first.promise;
		};
		const ac = new AbortController();
		const bc = new AbortController();
		const a = c.query("repo", loader, { signal: ac.signal });
		const b = c.query("repo", loader, { signal: bc.signal });
		const results = Promise.allSettled([a, b]);
		await turn();
		ac.abort(new Error("only a"));
		expect(underlying?.aborted).toBe(false);
		bc.abort(new Error("only b"));
		expect(underlying?.aborted).toBe(true);
		expect((await results).map((r) => r.status)).toEqual(["rejected", "rejected"]);
		first.resolve(summary());
		await turn();
		expect((await c.query("repo", async () => summary("recovered"))).branch).toBe("recovered");
	});

	test("one aborted reader cannot reject another reader's successful result", async () => {
		const c = new GitStatusQueryCoordinator();
		const first = deferred<GitStatusSummary>();
		const controller = new AbortController();
		const a = c.query("repo", () => first.promise, { signal: controller.signal });
		const b = c.query("repo", () => first.promise);
		const settled = Promise.allSettled([a, b]);
		controller.abort();
		first.resolve(summary());
		const result = await settled;
		expect(result[0]?.status).toBe("rejected");
		expect(result[1]?.status).toBe("fulfilled");
	});

	test("global execution and queue bounds apply across distinct targets", async () => {
		const c = new GitStatusQueryCoordinator({ concurrency: 2, queued: 2, timeoutMs: 5000 });
		const jobs = Array.from({ length: 4 }, () => deferred<GitStatusSummary>());
		const started: number[] = [];
		const results = jobs.map((job, index) =>
			c.query(`repo-${index}`, () => {
				started.push(index);
				return job.promise;
			}),
		);
		await turn();
		expect(started).toEqual([0, 1]);
		await expect(c.query("overflow", async () => summary())).rejects.toThrow("queue is full");
		jobs[0]?.resolve(summary());
		await results[0];
		await turn();
		expect(started).toEqual([0, 1, 2]);
		for (const job of jobs) job.resolve(summary());
		await Promise.all(results);
	});

	test("timeout covers queued time and does not start expired jobs", async () => {
		const c = new GitStatusQueryCoordinator({ concurrency: 1, queued: 2, timeoutMs: 20 });
		const first = deferred<GitStatusSummary>();
		let started = 0;
		const a = c.query("first", () => first.promise);
		const b = c.query("second", async () => {
			started++;
			return summary();
		});
		const settled = await Promise.allSettled([a, b]);
		expect(settled.map((r) => r.status)).toEqual(["rejected", "rejected"]);
		expect(started).toBe(0);
		first.resolve(summary());
		await turn();
		expect((await c.query("later", async () => summary())).branch).toBe("main");
	});

	test("failed queries release their key and permit retry", async () => {
		const c = new GitStatusQueryCoordinator();
		await expect(c.query("repo", async () => Promise.reject(new Error("failure")))).rejects.toThrow(
			"failure",
		);
		expect((await c.query("repo", async () => summary())).branch).toBe("main");
	});

	test("clear cancels queued work without starting it", async () => {
		const c = new GitStatusQueryCoordinator({ concurrency: 1, queued: 3, timeoutMs: 5000 });
		const first = deferred<GitStatusSummary>();
		let queuedCalls = 0;
		const a = c.query("first", () => first.promise);
		const b = c.query("second", async () => {
			queuedCalls++;
			return summary();
		});
		const settled = Promise.allSettled([a, b]);
		await turn();
		c.clear();
		await settled;
		expect(queuedCalls).toBe(0);
		first.resolve(summary());
		await turn();
	});

	test("target keys separate local, remote, subdirectories and POSIX literal backslashes", async () => {
		const c = new GitStatusQueryCoordinator();
		const keys = [
			getLocalGitStatusQueryKey("/repo"),
			getLocalGitStatusQueryKey("/repo/sub"),
			JSON.stringify(["remote", "a", 1, "/repo", "/repo"]),
			JSON.stringify(["remote", "a", 2, "/repo", "/repo"]),
			JSON.stringify(["remote", "b", 1, "/repo", "/repo"]),
		];
		let calls = 0;
		await Promise.all(
			keys.map((key) =>
				c.query(key, async () => {
					calls++;
					return summary();
				}),
			),
		);
		expect(calls).toBe(5);
		expect(getLocalGitStatusQueryKey("/repo/./sub/..")).toBe(keys[0] ?? "");
		if (process.platform !== "win32")
			expect(getLocalGitStatusQueryKey("/repo/a\\b")).not.toBe(
				getLocalGitStatusQueryKey("/repo/a/b"),
			);
	});

	test("same-target subscribers are bounded without duplicating or cancelling admitted work", async () => {
		const c = new GitStatusQueryCoordinator();
		const pending = deferred<GitStatusSummary>();
		let calls = 0;
		const readers = Array.from({ length: 256 }, () =>
			c.query("repo", () => {
				calls++;
				return pending.promise;
			}),
		);
		await expect(c.query("repo", async () => summary())).rejects.toThrow(
			"Too many Git status readers",
		);
		expect(calls).toBe(1);
		pending.resolve(summary());
		expect((await Promise.all(readers)).length).toBe(256);
	});

	test("a zero-length queue still admits work when an execution slot is free", async () => {
		const c = new GitStatusQueryCoordinator({ concurrency: 1, queued: 0, timeoutMs: 1000 });
		expect((await c.query("repo", async () => summary())).branch).toBe("main");
	});

	test("root invalidation refreshes scoped reads without crossing path or device boundaries", async () => {
		const c = new GitStatusQueryCoordinator();
		const key = getLocalGitStatusQueryKey("/repo/sub");
		const pending = deferred<GitStatusSummary>();
		const old = c.query(key, () => pending.promise);
		await turn();
		c.invalidateMatching((candidate) => localGitStatusScopesOverlap(candidate, "/repo"));
		const fresh = c.query(key, async () => summary("new"));
		pending.resolve(summary("old"));
		expect((await old).branch).toBe("old");
		expect((await fresh).branch).toBe("new");
		expect(localGitStatusScopesOverlap(getLocalGitStatusQueryKey("/repo"), "/repo/sub")).toBe(true);
		expect(localGitStatusScopesOverlap(getLocalGitStatusQueryKey("/repo2"), "/repo")).toBe(false);
		expect(localGitStatusScopesOverlap(getLocalGitStatusQueryKey("/repo/other"), "/repo/sub")).toBe(
			false,
		);
		expect(localGitStatusScopesOverlap(JSON.stringify(["remote", "/repo"]), "/repo")).toBe(false);
	});
});
