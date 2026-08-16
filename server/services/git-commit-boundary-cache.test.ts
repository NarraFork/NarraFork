/**
 * git-commit-boundary-cache.test.ts — the boundary walk must not run per refetch.
 *
 * `getLastCommitTimes` spawns a `git log` walk (~0.3 s here). The Git panel refetches
 * every 30 s per open chapter, so an uncached call would put a recurring subprocess on the
 * request path for every viewer. These tests pin the three properties that make that safe:
 * reuse, de-duplication, and invalidation that cannot serve boundaries from an old HEAD.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	boundaryCacheSize,
	clearBoundaryCache,
	getCommitBoundariesCached,
	invalidateBoundaries,
} from "./git-commit-boundary-cache";
import { invalidateStatus } from "./git-status-cache";

const repos: string[] = [];

beforeEach(() => {
	clearBoundaryCache();
});

afterEach(() => {
	clearBoundaryCache();
	for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(cwd: string, args: string[]): void {
	const proc = Bun.spawnSync({
		cmd: ["git", ...args],
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
	}
}

/** A repository with one commit touching `a.txt`, plus its HEAD sha. */
function makeRepo(): { dir: string; headSha: string } {
	const dir = mkdtempSync(join(tmpdir(), "nf-boundary-cache-"));
	repos.push(dir);
	run(dir, ["init", "-q", "-b", "main"]);
	writeFileSync(join(dir, "a.txt"), "v1");
	run(dir, ["add", "-A"]);
	run(dir, ["commit", "-q", "-m", "one"]);
	const proc = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: dir });
	return { dir, headSha: proc.stdout.toString().trim() };
}

describe("getCommitBoundariesCached", () => {
	test("resolves boundaries and reuses them within the TTL", async () => {
		const { dir, headSha } = makeRepo();

		const first = await getCommitBoundariesCached(dir, headSha, ["a.txt"]);
		const second = await getCommitBoundariesCached(dir, headSha, ["a.txt"]);

		expect(first.byPath.get("a.txt")).toBeDefined();
		// Identity, not just equality: a cache hit returns the same object rather than
		// re-walking the history.
		expect(second).toBe(first);
		expect(boundaryCacheSize()).toBe(1);
	});

	test("concurrent callers share one walk", async () => {
		const { dir, headSha } = makeRepo();

		const [a, b, c] = await Promise.all([
			getCommitBoundariesCached(dir, headSha, ["a.txt"]),
			getCommitBoundariesCached(dir, headSha, ["a.txt"]),
			getCommitBoundariesCached(dir, headSha, ["a.txt"]),
		]);

		// All three resolve to the same result object, so only one git process ran.
		expect(b).toBe(a);
		expect(c).toBe(a);
		expect(boundaryCacheSize()).toBe(1);
	});

	test("a new HEAD does not reuse the old boundaries", async () => {
		// Boundaries are derived FROM HEAD. Serving them across a commit would filter
		// attributions against a commit that no longer bounds anything.
		const { dir, headSha } = makeRepo();
		const before = await getCommitBoundariesCached(dir, headSha, ["a.txt"]);

		writeFileSync(join(dir, "a.txt"), "v2");
		run(dir, ["add", "-A"]);
		run(dir, ["commit", "-q", "-m", "two"]);
		const newHead = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: dir })
			.stdout.toString()
			.trim();

		const after = await getCommitBoundariesCached(dir, newHead, ["a.txt"]);

		expect(newHead).not.toBe(headSha);
		expect(after).not.toBe(before);
	});

	test("the same path set in a different order hits one entry", async () => {
		// `git status` ordering is not guaranteed stable, so an order-sensitive key would
		// silently double the walks.
		const { dir } = makeRepo();
		writeFileSync(join(dir, "b.txt"), "v1");
		run(dir, ["add", "-A"]);
		run(dir, ["commit", "-q", "-m", "two"]);
		const head = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: dir })
			.stdout.toString()
			.trim();

		const first = await getCommitBoundariesCached(dir, head, ["a.txt", "b.txt"]);
		const second = await getCommitBoundariesCached(dir, head, ["b.txt", "a.txt"]);

		expect(second).toBe(first);
		expect(boundaryCacheSize()).toBe(1);
	});

	test("different path sets are separate entries", async () => {
		const { dir, headSha } = makeRepo();

		const one = await getCommitBoundariesCached(dir, headSha, ["a.txt"]);
		const two = await getCommitBoundariesCached(dir, headSha, []);

		expect(two).not.toBe(one);
		expect(boundaryCacheSize()).toBe(2);
	});

	test("invalidateBoundaries drops a workspace's entries", async () => {
		const { dir, headSha } = makeRepo();
		const first = await getCommitBoundariesCached(dir, headSha, ["a.txt"]);

		invalidateBoundaries(dir);

		expect(boundaryCacheSize()).toBe(0);
		const second = await getCommitBoundariesCached(dir, headSha, ["a.txt"]);
		expect(second).not.toBe(first);
	});

	test("invalidateStatus also drops boundaries, so the two cannot drift", async () => {
		// Staging or discarding changes the set of relevant paths; committing moves the
		// boundaries themselves. Call sites already invalidate status on all of these.
		const { dir, headSha } = makeRepo();
		await getCommitBoundariesCached(dir, headSha, ["a.txt"]);

		invalidateStatus(dir);

		expect(boundaryCacheSize()).toBe(0);
	});

	test("invalidating one workspace leaves another intact", async () => {
		const first = makeRepo();
		const second = makeRepo();
		await getCommitBoundariesCached(first.dir, first.headSha, ["a.txt"]);
		const kept = await getCommitBoundariesCached(second.dir, second.headSha, ["a.txt"]);

		invalidateBoundaries(first.dir);

		expect(boundaryCacheSize()).toBe(1);
		expect(await getCommitBoundariesCached(second.dir, second.headSha, ["a.txt"])).toBe(kept);
	});

	test("entries are capped so distinct path sets cannot accumulate forever", async () => {
		// The key includes the path set, so staging files one at a time produces a new key
		// each time.
		const { dir, headSha } = makeRepo();

		for (let i = 0; i < 40; i++) {
			await getCommitBoundariesCached(dir, headSha, [`f${i}.txt`]);
		}

		expect(boundaryCacheSize()).toBeLessThanOrEqual(32);
	});

	test("ttlMs=0 forces a fresh walk", async () => {
		const { dir, headSha } = makeRepo();
		const first = await getCommitBoundariesCached(dir, headSha, ["a.txt"]);

		const second = await getCommitBoundariesCached(dir, headSha, ["a.txt"], { ttlMs: 0 });

		expect(second).not.toBe(first);
	});

	test("a TTL refresh keeps the key hot, so cold one-off keys cannot evict it", async () => {
		// The key includes the path set, so a session staging files one at a time produces a
		// stream of single-use keys. If an expired-then-recomputed entry kept its original
		// position in insertion order, the one key that is actually being polled every 30 s
		// would be the first one evicted.
		const { dir, headSha } = makeRepo();

		await getCommitBoundariesCached(dir, headSha, ["a.txt"]);
		// Expire it and recompute: this is the path that used to skip the LRU touch.
		const refreshed = await getCommitBoundariesCached(dir, headSha, ["a.txt"], { ttlMs: 0 });
		// Fill the cache with cold keys, one short of the cap so exactly the LRU is evicted.
		for (let i = 0; i < 31; i++) {
			await getCommitBoundariesCached(dir, headSha, [`cold${i}.txt`]);
		}

		expect(boundaryCacheSize()).toBeLessThanOrEqual(32);
		// Still cached: a hit returns the same object rather than re-walking.
		expect(await getCommitBoundariesCached(dir, headSha, ["a.txt"])).toBe(refreshed);
	});

	test("an invalidation during a walk is not overwritten by its result", async () => {
		// The window that matters: a commit lands while a boundary walk is in flight. The
		// walk's answer describes the OLD head, and serving it afterwards would filter
		// attributions against a commit that no longer bounds anything.
		const { dir, headSha } = makeRepo();

		const inflight = getCommitBoundariesCached(dir, headSha, ["a.txt"]);
		invalidateBoundaries(dir);
		await inflight;

		// The invalidation stands: the in-flight result must not have re-populated the entry
		// it was evicted from.
		expect(boundaryCacheSize()).toBe(0);
		// And a caller that already holds the promise still gets a usable answer rather than
		// a rejection — a boundary failure must never fail the panel.
		expect((await inflight).byPath.get("a.txt")).toBeDefined();
	});

	test("concurrent callers still share one walk across an invalidation", async () => {
		const { dir, headSha } = makeRepo();

		const first = getCommitBoundariesCached(dir, headSha, ["a.txt"]);
		const second = getCommitBoundariesCached(dir, headSha, ["a.txt"]);
		invalidateBoundaries(dir);
		const [a, b] = await Promise.all([first, second]);

		// Both were attached to the same walk before the invalidation, so neither spawned a
		// second git process.
		expect(b).toBe(a);
	});

	test("an empty headSha (unborn HEAD) is cached like any other key", async () => {
		// A fresh chapter worktree legitimately has zero commits, and `GitStatusSummary.headSha`
		// is then the empty string. That must be a normal key, not a hole in the cache: with
		// no entry every refetch would spawn a walk for a repository that cannot answer.
		const dir = mkdtempSync(join(tmpdir(), "nf-boundary-cache-unborn-"));
		repos.push(dir);
		run(dir, ["init", "-q", "-b", "main"]);
		writeFileSync(join(dir, "a.txt"), "v1");

		const first = await getCommitBoundariesCached(dir, "", ["a.txt"]);
		const second = await getCommitBoundariesCached(dir, "", ["a.txt"]);

		expect(first.byPath.size).toBe(0);
		expect(first.oldestInWindow).toBeNull();
		// Identity: an unborn HEAD is a cache hit, not a repeated walk.
		expect(second).toBe(first);
		expect(boundaryCacheSize()).toBe(1);
	});

	test("the first commit does not reuse the unborn-HEAD entry", async () => {
		// `headSha` moves from "" to a real sha, so the key changes by construction.
		const dir = mkdtempSync(join(tmpdir(), "nf-boundary-cache-born-"));
		repos.push(dir);
		run(dir, ["init", "-q", "-b", "main"]);
		writeFileSync(join(dir, "a.txt"), "v1");
		const unborn = await getCommitBoundariesCached(dir, "", ["a.txt"]);

		run(dir, ["add", "-A"]);
		run(dir, ["commit", "-q", "-m", "one"]);
		const headSha = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: dir })
			.stdout.toString()
			.trim();
		const born = await getCommitBoundariesCached(dir, headSha, ["a.txt"]);

		expect(unborn.byPath.size).toBe(0);
		expect(born.byPath.get("a.txt")).toBeDefined();
	});

	test("an unusable repository yields empty boundaries instead of rejecting", async () => {
		// A non-zero git exit is reported as "no boundaries known", which the view treats
		// as unbounded. Showing more history than ideal beats failing the whole panel, and
		// the short TTL means a repository that becomes usable is picked up again.
		const missing = join(tmpdir(), "nf-boundary-cache-does-not-exist");

		const result = await getCommitBoundariesCached(missing, "deadbeef", ["a.txt"]);

		expect(result.byPath.size).toBe(0);
		expect(result.oldestInWindow).toBeNull();
	});
});
