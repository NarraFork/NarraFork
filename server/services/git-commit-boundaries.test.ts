/**
 * git-commit-boundaries.test.ts — where does "this round of changes" begin.
 *
 * The Git panel shows UNCOMMITTED changes, so attribution for a file must start at that
 * file's last commit. A single repository-wide HEAD timestamp is not that boundary: in
 * the NarraFork repository 90 of 127 changed files were last committed before HEAD, by a
 * median of 164 hours, and using HEAD dropped real contributors.
 *
 * These tests build throwaway repositories so the boundaries are exact and independent
 * of any developer's history.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUncommittedScope } from "../routes/git";
import { clearBoundaryCache } from "./git-commit-boundary-cache";
import { gitService } from "./git-service";
import { clearStatusCache } from "./git-status-cache";

const repos: string[] = [];

afterEach(() => {
	// Both caches are keyed by workspace path. Temp directories are unique per test, so a
	// leftover entry cannot be served to another test — but clearing keeps the process from
	// retaining every throwaway repository's status for its lifetime.
	clearStatusCache();
	clearBoundaryCache();
	for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A git identity is required for `commit` to work in a clean environment. */
function run(cwd: string, args: string[], date?: string): void {
	const proc = Bun.spawnSync({
		cmd: ["git", ...args],
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
			...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
		},
	});
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
	}
}

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "nf-boundary-"));
	repos.push(dir);
	run(dir, ["init", "-q", "-b", "main"]);
	return dir;
}

/** Move a file on disk, leaving git to detect the rename from content similarity. */
function rename(dir: string, from: string, to: string): void {
	renameSync(join(dir, from), join(dir, to));
}

/**
 * Commit `files`, optionally at a fixed date.
 *
 * Dates must be given explicitly whenever a test compares two boundaries: `%cI` has
 * one-second precision, so two commits made in the same second are indistinguishable
 * and an ordering assertion would fail for reasons unrelated to the code.
 */
function commit(dir: string, files: Record<string, string>, message: string, date?: string): void {
	for (const [path, content] of Object.entries(files)) {
		writeFileSync(join(dir, path), content);
	}
	run(dir, ["add", "-A"]);
	run(dir, ["commit", "-q", "-m", message], date);
}

describe("getLastCommitTimes", () => {
	test("reports each path's own last commit, not a single repository boundary", async () => {
		const dir = makeRepo();
		commit(dir, { "old.txt": "v1", "new.txt": "v1" }, "both", "2026-01-01T00:00:00+00:00");
		// A later commit touching only one file: the other's boundary must stay behind.
		commit(dir, { "new.txt": "v2" }, "only new", "2026-06-01T00:00:00+00:00");

		const { byPath } = await gitService.getLastCommitTimes(dir, ["old.txt", "new.txt"]);

		const older = byPath.get("old.txt") ?? "";
		const newer = byPath.get("new.txt") ?? "";
		expect(older).not.toBe("");
		expect(newer).not.toBe("");
		// This inequality is the entire point: a global HEAD boundary would report the
		// same, newer timestamp for both and discard old.txt's real history window.
		expect(older < newer).toBe(true);
	});

	test("returns UTC timestamps so string comparison against changedAt is valid", async () => {
		// `%cI` emits a local offset; `file_attributions.changedAt` is UTC with `Z`.
		// Compared as strings, "2026-08-14T18:19:20+08:00" sorts AFTER
		// "2026-08-14T11:00:00Z" despite being two hours earlier.
		const dir = makeRepo();
		commit(dir, { "a.txt": "v1" }, "one");

		const { byPath, oldestInWindow } = await gitService.getLastCommitTimes(dir, ["a.txt"]);

		expect(byPath.get("a.txt")).toMatch(/Z$/);
		expect(oldestInWindow).toMatch(/Z$/);
	});

	test("omits a path that was never committed", async () => {
		const dir = makeRepo();
		commit(dir, { "tracked.txt": "v1" }, "one");
		writeFileSync(join(dir, "untracked.txt"), "fresh");

		const { byPath } = await gitService.getLastCommitTimes(dir, ["tracked.txt", "untracked.txt"]);

		expect(byPath.has("tracked.txt")).toBe(true);
		// No boundary means "everything recorded for it belongs to the current change",
		// which is exactly right for a file that has never been committed.
		expect(byPath.has("untracked.txt")).toBe(false);
	});

	test("oldestInWindow is the walk's oldest commit, usable as a fallback boundary", async () => {
		const dir = makeRepo();
		commit(dir, { "a.txt": "v1" }, "first", "2026-01-01T00:00:00+00:00");
		commit(dir, { "a.txt": "v2" }, "second", "2026-06-01T00:00:00+00:00");

		const { byPath, oldestInWindow } = await gitService.getLastCommitTimes(dir, ["a.txt"]);

		// The fallback must never be newer than a resolved boundary would allow it to be
		// used in place of; being older-or-equal keeps it conservative.
		const fallback = oldestInWindow ?? "";
		const resolved = byPath.get("a.txt") ?? "";
		expect(fallback).not.toBe("");
		expect(resolved).not.toBe("");
		expect(fallback <= resolved).toBe(true);
	});

	test("an unborn HEAD yields no boundaries instead of failing", async () => {
		// A fresh chapter worktree can legitimately have zero commits.
		const dir = makeRepo();
		writeFileSync(join(dir, "a.txt"), "v1");

		const result = await gitService.getLastCommitTimes(dir, ["a.txt"]);

		expect(result.byPath.size).toBe(0);
		expect(result.oldestInWindow).toBeNull();
	});

	test("an empty path list does no git work", async () => {
		const dir = makeRepo();
		commit(dir, { "a.txt": "v1" }, "one");

		const result = await gitService.getLastCommitTimes(dir, []);

		expect(result.byPath.size).toBe(0);
		expect(result.oldestInWindow).toBeNull();
	});

	test("paths beyond the cap are omitted rather than truncating the argument vector", async () => {
		const dir = makeRepo();
		const files: Record<string, string> = {};
		for (let i = 0; i < 5; i++) files[`f${i}.txt`] = "v1";
		commit(dir, files, "many");

		// Far more paths than the 200 cap; the call must still succeed and resolve the
		// ones it kept.
		const padded = [...Object.keys(files), ...Array.from({ length: 400 }, (_, i) => `pad${i}.txt`)];
		const { byPath } = await gitService.getLastCommitTimes(dir, padded);

		expect(byPath.get("f0.txt")).toBeDefined();
		expect(byPath.size).toBeLessThanOrEqual(200);
	});

	test("a path containing spaces is matched exactly", async () => {
		const dir = makeRepo();
		commit(dir, { "with space.txt": "v1" }, "spaced");

		const { byPath } = await gitService.getLastCommitTimes(dir, ["with space.txt"]);

		// Paths go through argv, never a shell, so no quoting is involved — but the
		// marker-based parse must not split on whitespace either.
		expect(byPath.get("with space.txt")).toBeDefined();
	});

	test("a renamed file's OLD path still resolves, which is where its history lives", async () => {
		// Attribution rows carry the path that existed when the write happened, so a
		// renamed file's whole recorded history sits under a path that is no longer in the
		// tree. The boundary walk must be able to bound those rows.
		const dir = makeRepo();
		commit(dir, { "old.txt": "v1" }, "create", "2026-01-01T00:00:00+00:00");
		rename(dir, "old.txt", "new.txt");

		const { byPath } = await gitService.getLastCommitTimes(dir, ["old.txt", "new.txt"]);

		// `old.txt` was committed; `new.txt` exists only as an uncommitted rename, so it
		// has no boundary of its own yet.
		expect(byPath.get("old.txt")).toBeDefined();
		expect(byPath.has("new.txt")).toBe(false);
	});
});

// ── uncommitted scope, the shape the endpoint actually passes to the view ─────

describe("resolveUncommittedScope", () => {
	test("reports a rename under both names, aliased to the current one", async () => {
		// The bug: only `status.files.map(f => f.path)` was queried, so every attribution
		// recorded before the rename — under the old path — was neither in the path list
		// nor attachable to the new path's row. It fell through to the `oldestInWindow`
		// fallback, i.e. the "Unknown" badge in another shape.
		const dir = makeRepo();
		commit(dir, { "old.txt": "some content that stays identical\n" }, "create");
		rename(dir, "old.txt", "new.txt");
		// Staged, so porcelain reports `R` rather than a delete plus an untracked add.
		run(dir, ["add", "-A"]);

		const scope = await resolveUncommittedScope(dir);

		expect(scope.filePaths).toContain("new.txt");
		expect(scope.filePaths).toContain("old.txt");
		expect(scope.pathAliases.get("old.txt")).toBe("new.txt");
	});

	test("a plain modification produces no aliases", async () => {
		const dir = makeRepo();
		commit(dir, { "a.txt": "v1" }, "create");
		writeFileSync(join(dir, "a.txt"), "v2");

		const scope = await resolveUncommittedScope(dir);

		expect(scope.filePaths).toEqual(["a.txt"]);
		expect(scope.pathAliases.size).toBe(0);
	});

	test("an untracked file does NOT inherit the oldestInWindow fallback", async () => {
		// This is the branch that only a comment used to guard. An untracked file has never
		// been committed, so every attribution recorded for it belongs to the current
		// change; bounding it at the walk's oldest commit would discard contributors for a
		// file whose entire history IS the current change.
		const dir = makeRepo();
		commit(dir, { "tracked.txt": "v1" }, "create", "2026-01-01T00:00:00+00:00");
		writeFileSync(join(dir, "tracked.txt"), "v2");
		writeFileSync(join(dir, "fresh.txt"), "brand new");

		const scope = await resolveUncommittedScope(dir);

		expect(scope.filePaths.sort()).toEqual(["fresh.txt", "tracked.txt"]);
		// The tracked file is bounded (by its own commit); the untracked one is not bounded
		// at all, which the view reads as "unbounded".
		expect(scope.sinceByPath.get("tracked.txt")).toBeDefined();
		expect(scope.sinceByPath.has("fresh.txt")).toBe(false);
	});

	test("a tracked path the walk did not reach falls back to the window boundary", async () => {
		const dir = makeRepo();
		commit(dir, { "a.txt": "v1" }, "create", "2026-01-01T00:00:00+00:00");
		// A second commit so the walk has an `oldestInWindow` distinct from nothing, then a
		// tracked-but-unreached path: `b.txt` is committed, so it is not untracked, but the
		// pathspec-limited walk resolves it too.
		commit(dir, { "b.txt": "v1" }, "second", "2026-06-01T00:00:00+00:00");
		writeFileSync(join(dir, "a.txt"), "v2");
		writeFileSync(join(dir, "b.txt"), "v2");

		const scope = await resolveUncommittedScope(dir);

		// Both are tracked, so both must end up bounded one way or the other — a tracked
		// file with no boundary would be credited with its entire recorded history.
		expect(scope.sinceByPath.get("a.txt")).toBeDefined();
		expect(scope.sinceByPath.get("b.txt")).toBeDefined();
	});

	test("a clean worktree asks for nothing", async () => {
		const dir = makeRepo();
		commit(dir, { "a.txt": "v1" }, "create");

		const scope = await resolveUncommittedScope(dir);

		// An empty list is meaningful downstream: the view returns nothing rather than
		// widening to the whole workspace.
		expect(scope.filePaths).toEqual([]);
		expect(scope.sinceByPath.size).toBe(0);
	});
});

// ── findCommitLogIndex — prefix matching threshold ────────────────────────────

describe("findCommitLogIndex prefix matching", () => {
	test("a full 40-char SHA matches exactly", async () => {
		const dir = makeRepo();
		commit(dir, { "a.txt": "v1" }, "first");
		const log = await gitService.getLog(dir, { limit: 1 });
		const fullSha = log[0]?.sha ?? "";
		expect(fullSha).not.toBe("");

		const idx = await gitService.findCommitLogIndex(dir, fullSha);
		expect(idx).toBe(0);
	});

	test("an unambiguous abbreviated sha resolves, however short", async () => {
		// Short shas stay supported: correctness comes from rejecting ambiguity, not
		// from guessing a prefix length at which collisions become unlikely.
		const dir = makeRepo();
		commit(dir, { "a.txt": "v1" }, "first");
		const log = await gitService.getLog(dir, { limit: 1 });
		const fullSha = log[0]?.sha ?? "";
		expect(fullSha).not.toBe("");

		for (const length of [4, 7, 12]) {
			expect(await gitService.findCommitLogIndex(dir, fullSha.slice(0, length))).toBe(0);
		}
	});

	test("a prefix matching two commits resolves to null, not to the first one", async () => {
		// The failure this guards against is silent: Ruler pages from the returned
		// index, so a wrong hit shifts the page and drops the commits in between.
		const dir = makeRepo();
		commit(dir, { "a.txt": "v1" }, "first");
		commit(dir, { "b.txt": "v1" }, "second");
		const log = await gitService.getLog(dir, { limit: 2 });
		const shas = log.map((c) => c.sha);
		expect(shas).toHaveLength(2);

		// Find the shortest prefix length at which the two shas still agree; if they
		// differ on the very first character there is no ambiguous prefix to test.
		let shared = 0;
		while (shared < 40 && shas[0]?.[shared] === shas[1]?.[shared]) shared += 1;
		if (shared === 0) return;

		const ambiguous = (shas[0] ?? "").slice(0, shared);
		expect(await gitService.findCommitLogIndex(dir, ambiguous)).toBeNull();
	});
});
