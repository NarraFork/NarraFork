import { describe, expect, mock, test } from "bun:test";
import { type GitDiscovery, GitDiscoveryCache } from "./git-discovery-cache";

const ready: GitDiscovery = {
	state: "ready",
	rootPath: "/repo",
	repositoryPath: "/repo/.git",
	branch: "main",
};
const deferred = () => {
	let resolve!: (value: GitDiscovery) => void;
	const promise = new Promise<GitDiscovery>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

describe("Git display discovery cache", () => {
	test("caches Git and explicit not_git, expires both, and returns independent facts", async () => {
		let now = 0;
		const cache = new GitDiscoveryCache(2, 30, () => now);
		const probe = mock(async () => ({ ...ready }));
		const first = await cache.get("local", 0, "/repo", probe);
		first.branch = "tampered";
		expect((await cache.get("local", 0, "/repo", probe)).branch).toBe("main");
		expect(probe).toHaveBeenCalledTimes(1);
		const plain = mock(async (): Promise<GitDiscovery> => ({ state: "not_git" }));
		await cache.get("local", 0, "/plain", plain);
		await cache.get("local", 0, "/plain", plain);
		expect(plain).toHaveBeenCalledTimes(1);
		now = 31;
		await cache.get("local", 0, "/repo", probe);
		await cache.get("local", 0, "/plain", plain);
		expect(probe).toHaveBeenCalledTimes(2);
		expect(plain).toHaveBeenCalledTimes(2);
	});

	test("deduplicates concurrent probes without sharing waiter cancellation", async () => {
		const cache = new GitDiscoveryCache();
		const wait = deferred();
		const probe = mock(() => wait.promise);
		const abort = new AbortController();
		const cancelled = cache.get("local", 0, "/repo", probe, abort.signal);
		const retained = cache.get("local", 0, "/repo", probe);
		abort.abort(new Error("cancelled"));
		await expect(cancelled).rejects.toThrow("cancelled");
		wait.resolve(ready);
		expect(await retained).toEqual(ready);
		expect(probe).toHaveBeenCalledTimes(1);
	});

	test("devices, reconnect generations, and worktrees never share entries", async () => {
		const cache = new GitDiscoveryCache();
		const probe = mock(async () => ready);
		for (const [device, generation, path] of [
			["local", 0, "/repo"],
			["remote", 0, "/repo"],
			["remote", 1, "/repo"],
			["local", 0, "/other"],
		] as const)
			await cache.get(device, generation, path, probe);
		expect(probe).toHaveBeenCalledTimes(4);
	});

	test("exceptions and unavailable states are never negative cached evidence", async () => {
		const cache = new GitDiscoveryCache();
		const failure = mock(async (): Promise<GitDiscovery> => {
			throw new Error("timeout");
		});
		await expect(cache.get("local", 0, "/repo", failure)).rejects.toThrow("timeout");
		expect(cache.size).toBe(0);
		for (const state of [
			"device_offline",
			"access_denied",
			"unsupported",
			"git_unavailable",
			"missing_directory",
		] as const) {
			const probe = mock(async (): Promise<GitDiscovery> => ({ state }));
			await cache.get("local", 0, "/repo", probe);
			await cache.get("local", 0, "/repo", probe);
			expect(probe).toHaveBeenCalledTimes(2);
		}
	});

	test("invalidates sibling cwd aliases and repository facts, not other devices", async () => {
		const cache = new GitDiscoveryCache();
		const probe = mock(async () => ready);
		await cache.get("local", 0, "/repo/sub", probe);
		await cache.get("local", 0, "/linked", probe);
		await cache.get("remote", 0, "/repo", probe);
		cache.invalidate("local", "/repo", "/repo/.git");
		await cache.get("local", 0, "/repo/sub", probe);
		await cache.get("local", 0, "/linked", probe);
		await cache.get("remote", 0, "/repo", probe);
		expect(probe).toHaveBeenCalledTimes(5);
	});

	test("late invalidated probes cannot repopulate the cache", async () => {
		const cache = new GitDiscoveryCache();
		const wait = deferred();
		const pending = cache.get("local", 0, "/repo", () => wait.promise);
		cache.invalidate("local", "/repo");
		wait.resolve(ready);
		await pending;
		const fresh = mock(async () => ({ ...ready, branch: "new" }));
		expect((await cache.get("local", 0, "/repo", fresh)).branch).toBe("new");
		expect(fresh).toHaveBeenCalledTimes(1);
	});

	test("hard bounds retained entries even when all probes are in flight", async () => {
		const cache = new GitDiscoveryCache(2);
		const wait = deferred();
		const tasks = Array.from({ length: 5 }, (_, i) =>
			cache.get("local", 0, `/repo-${i}`, () => wait.promise),
		);
		expect(cache.size).toBe(2);
		wait.resolve(ready);
		await Promise.all(tasks);
		expect(cache.size).toBe(2);
		await cache.get("local", 0, "/last", async () => ready);
		expect(cache.size).toBe(2);
	});
});
