/**
 * Surviving a commit-requiring git operation with uncommitted work in the way.
 *
 * Rebase and cherry-pick cannot be moved into snapshot space — they replay commits by
 * definition — so what is under test is the narrower claim this feature actually makes:
 * that uncommitted work can be parked, the operation run, and the work put back without
 * either side being lost.
 *
 * The cases target the ways that goes wrong silently:
 *
 *   - parking that resets the worktree without a verified snapshot (the destructive one),
 *   - a reapply that restores instead of merging, throwing away what the operation
 *     brought in,
 *   - a base read from git's HEAD rather than from a snapshot, which makes an
 *     ignored-but-tracked file read as a deletion,
 *   - a conflict that gets written to disk anyway, leaving markers in files nobody
 *     asked to merge.
 *
 * Real git worktrees and real shadow repositories throughout: the question in every case
 * is whether the git-level pieces compose.
 *
 * The refusal cases carry the most weight, because each one guards a path where
 * proceeding destroys bytes that exist in no other copy: a tracked-but-ignored file the
 * snapshot cannot hold, and an operation already in progress whose state a reset erases.
 * Both assert on the *file contents* afterwards rather than only on the thrown error —
 * the error is the mechanism, the surviving bytes are the point.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { safeSpawn } from "../lib/spawn";
import {
	hasUncommittedWork,
	parkUncommittedWork,
	reapplyParkedWork,
	restoreParkedWork,
	settleParkedWork,
	untrackedCollisions,
} from "./snapshot-dirty-git-op";
import { SNAPSHOT_HEAD_REF, worktreeTreeSnapshot } from "./worktree-tree-snapshot";

const tempDirs: string[] = [];

const FILE = "app.txt";
const BASE = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n";

async function git(args: string[], cwd: string): Promise<string> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

/** Same call, but a non-zero exit is the expected outcome rather than a failure. */
async function gitAllowFail(args: string[], cwd: string): Promise<number> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	return result.exitCode ?? 1;
}

/**
 * Absolute location of a git state file, resolved the way git resolves it.
 *
 * `--git-path` because a linked worktree keeps these under
 * `<main>/.git/worktrees/<name>/`, not in the worktree's own directory — the shape
 * production runs in. Resolved rather than joined blindly: git answers with an absolute
 * path from a linked worktree and a relative one from a plain repository.
 */
async function gitPath(worktree: string, name: string): Promise<string> {
	return resolve(worktree, await git(["rev-parse", "--git-path", name], worktree));
}

/** A repo on `main` with one commit, plus a `feat` worktree branched from it. */
async function createRepoWithBranch(): Promise<{ main: string; feat: string }> {
	const main = mkdtempSync(join(tmpdir(), "nf-park-"));
	tempDirs.push(main);
	await git(["init", "-b", "main"], main);
	await git(["config", "user.email", "test@example.com"], main);
	await git(["config", "user.name", "Test"], main);
	writeFileSync(join(main, FILE), BASE);
	await git(["add", "-A"], main);
	await git(["commit", "-m", "seed"], main);

	const feat = resolve(main, ".worktrees", "feat");
	await git(["worktree", "add", feat, "-b", "feat"], main);
	tempDirs.push(feat);
	return { main, feat };
}

function read(worktree: string, relPath = FILE): string {
	return readFileSync(join(worktree, relPath), "utf-8");
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		worktreeTreeSnapshot.destroy(dir, undefined, { force: true }).catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("parking uncommitted work", () => {
	test("a clean worktree parks nothing", async () => {
		const { feat } = await createRepoWithBranch();
		expect(await hasUncommittedWork(feat)).toBe(false);
		expect(await parkUncommittedWork(feat, "test")).toBeNull();
	});

	test("staged-only changes count as dirty, because git refuses to rebase over them", async () => {
		const { feat } = await createRepoWithBranch();
		writeFileSync(join(feat, "staged.txt"), "s\n");
		await git(["add", "staged.txt"], feat);
		expect(await hasUncommittedWork(feat)).toBe(true);
	});

	test("parking leaves a worktree git will accept, and the work is recoverable", async () => {
		const { feat } = await createRepoWithBranch();
		writeFileSync(join(feat, FILE), BASE.replace("l1", "EDITED"));
		writeFileSync(join(feat, "untracked.txt"), "u\n");

		const parked = await parkUncommittedWork(feat, "test park");
		if (!parked) throw new Error("expected work to be parked");

		// git's own criterion for "operable": nothing dirty at all.
		expect((await git(["status", "--porcelain"], feat)).trim()).toBe("");
		expect(read(feat)).toBe(BASE);
		expect(existsSync(join(feat, "untracked.txt"))).toBe(false);

		// The bytes are in the DAG, which is the only reason resetting was safe.
		const tree = await worktreeTreeSnapshot.treeOfSnapshot(feat, parked.commitSha);
		expect(tree).toBe(parked.treeHash);
	});

	test("loose content under .worktrees/ survives parking's clean", async () => {
		// Parking runs `git clean -fd`, and the exclude that keeps `.worktrees/` out of
		// snapshots lives in the *shadow* repository's `info/exclude` — which the user's
		// `git clean` cannot see. So the clean deleted exactly the paths no snapshot holds.
		//
		// Exercised on the root-chapter shape, where `worktreePath` *is* the project's
		// `gitPath`, because that is the only shape whose workspace contains `.worktrees/`
		// at all. A registered linked worktree is protected by git itself; a stray file and
		// the residue of an unregistered or half-removed worktree are not, and they are
		// unrecoverable once gone.
		const main = mkdtempSync(join(tmpdir(), "nf-park-root-"));
		tempDirs.push(main);
		await git(["init", "-b", "main"], main);
		await git(["config", "user.email", "test@example.com"], main);
		await git(["config", "user.name", "Test"], main);
		writeFileSync(join(main, FILE), BASE);
		await git(["add", "-A"], main);
		await git(["commit", "-m", "seed"], main);

		mkdirSync(join(main, ".worktrees", "orphaned"), { recursive: true });
		writeFileSync(join(main, ".worktrees", "loose.txt"), "stray\n");
		writeFileSync(join(main, ".worktrees", "orphaned", "wip.txt"), "uncommitted\n");
		// A tracked change, so there is something to park at all.
		writeFileSync(join(main, FILE), BASE.replace("l1", "EDITED"));
		// And an ordinary untracked file, to pin that the exclusion did not turn the clean
		// into a no-op.
		writeFileSync(join(main, "scratch.txt"), "s\n");

		const parked = await parkUncommittedWork(main, "root park");
		if (!parked) throw new Error("expected work to be parked");

		expect(read(main, ".worktrees/loose.txt")).toBe("stray\n");
		expect(read(main, ".worktrees/orphaned/wip.txt")).toBe("uncommitted\n");
		expect(existsSync(join(main, "scratch.txt"))).toBe(false);
		// git's criterion for "operable" is that nothing *tracked* is dirty; the surviving
		// `.worktrees/` is untracked, which git replays commits straight over.
		expect(read(main)).toBe(BASE);
		expect((await git(["diff", "HEAD", "--name-only"], main)).trim()).toBe("");
	});

	test("ignored files survive parking, since snapshots deliberately exclude them", async () => {
		const { feat } = await createRepoWithBranch();
		writeFileSync(join(feat, ".gitignore"), "build/\n");
		await git(["add", ".gitignore"], feat);
		await git(["commit", "-m", "ignore build"], feat);
		mkdirSync(join(feat, "build"), { recursive: true });
		writeFileSync(join(feat, "build", "out.bin"), "artifact\n");
		writeFileSync(join(feat, FILE), "dirty\n");

		await parkUncommittedWork(feat, "test park");

		// Cleaning with `-x` would have deleted this, and no snapshot holds it — the loss
		// would be permanent and invisible.
		expect(existsSync(join(feat, "build", "out.bin"))).toBe(true);
	});
});

describe("refusing to park what cannot be parked safely", () => {
	test("a tracked-but-ignored file's uncommitted bytes are never reset away", async () => {
		// The permanent-data-loss case, and the one test in this file whose failure means
		// bytes are gone rather than an operation refused.
		//
		// `dist/` is ignored but `dist/out.txt` is tracked (`add -f`), so `git status`
		// reports it dirty while a shadow repository — which builds its index under its
		// own mirrored excludes — has every reason not to hold it. Parking then resets it
		// to the HEAD version with the edit held in no other copy.
		//
		// Asserted as the invariant rather than as one mechanism: either the snapshot
		// covers the path, in which case parking is safe and the bytes come back, or it
		// does not, in which case parking must refuse. Both are correct; resetting is not.
		// Written this way because the capture layer force-adds such paths, so which
		// branch runs depends on the engine, while "the user still has their edit" is what
		// the feature actually promises.
		const { feat } = await createRepoWithBranch();
		writeFileSync(join(feat, ".gitignore"), "dist/\n");
		mkdirSync(join(feat, "dist"), { recursive: true });
		writeFileSync(join(feat, "dist", "out.txt"), "committed\n");
		await git(["add", ".gitignore"], feat);
		await git(["add", "-f", "dist/out.txt"], feat);
		await git(["commit", "-m", "track an ignored artifact"], feat);

		writeFileSync(join(feat, "dist", "out.txt"), "PRECIOUS UNCOMMITTED\n");
		expect(await hasUncommittedWork(feat)).toBe(true);

		let parked: Awaited<ReturnType<typeof parkUncommittedWork>> = null;
		let refusal: unknown;
		try {
			parked = await parkUncommittedWork(feat, "pre-rebase");
		} catch (err) {
			refusal = err;
		}

		if (refusal) {
			// Refused: nothing was touched, so the edit is exactly where the user left it.
			expect(String(refusal)).toContain("dist/out.txt");
			expect(read(feat, "dist/out.txt")).toBe("PRECIOUS UNCOMMITTED\n");
			return;
		}
		if (!parked) throw new Error("expected either a park or a refusal");
		// Parked: the bytes must be in the snapshot, which is the only thing that made
		// the reset survivable. Recovered here through the reapply the caller would run.
		expect(await worktreeTreeSnapshot.listPathsIn(feat, parked.treeHash, ["dist/out.txt"])).toEqual(
			["dist/out.txt"],
		);
		const result = await reapplyParkedWork(feat, parked);
		expect(result.conflicts).toEqual([]);
		expect(read(feat, "dist/out.txt")).toBe("PRECIOUS UNCOMMITTED\n");
	});

	test("a dirty path the snapshot cannot hold at all is refused, not reset over", async () => {
		// The residual hole the coverage check exists for. `sub/` is tracked by the outer
		// repository and then becomes a git repository of its own, so a shadow `add -A`
		// fails on it ("does not have a commit checked out") and the workspace has no
		// capturable state at all — while `git status` still reports `sub/file.txt` dirty.
		// Without a coverage check the reset would run against a snapshot that holds
		// nothing.
		const { feat } = await createRepoWithBranch();
		mkdirSync(join(feat, "sub"), { recursive: true });
		writeFileSync(join(feat, "sub", "file.txt"), "committed\n");
		await git(["add", "-A"], feat);
		await git(["commit", "-m", "track a path that later becomes a repo"], feat);
		await git(["init", "-b", "main"], join(feat, "sub"));

		writeFileSync(join(feat, "sub", "file.txt"), "PRECIOUS UNCOMMITTED\n");
		expect(await hasUncommittedWork(feat)).toBe(true);

		await expect(parkUncommittedWork(feat, "pre-rebase")).rejects.toThrow();
		expect(read(feat, "sub/file.txt")).toBe("PRECIOUS UNCOMMITTED\n");
	});

	test("a non-ASCII path is compared as itself, not as git's escaped form", async () => {
		// `core.quotepath` renders this as `"\344\270\255..."`, which is not a real path.
		// Comparing that against a tree listing finds no match, so a parser that misses
		// the escaping refuses every park in a repository with a CJK filename.
		const { feat } = await createRepoWithBranch();
		writeFileSync(join(feat, "中文文件.txt"), "kept\n");
		await git(["add", "-A"], feat);
		await git(["commit", "-m", "add a CJK path"], feat);
		writeFileSync(join(feat, "中文文件.txt"), "edited\n");

		const parked = await parkUncommittedWork(feat, "pre-rebase");
		if (!parked) throw new Error("expected work to be parked");
		expect(read(feat, "中文文件.txt")).toBe("kept\n");
		await reapplyParkedWork(feat, parked);
		expect(read(feat, "中文文件.txt")).toBe("edited\n");
	});

	test("deleted files are not mistaken for paths the snapshot failed to hold", async () => {
		// A deletion's correct representation in a captured tree is *absence*, so a
		// coverage check that flags "not in the tree" without qualification refuses every
		// park that includes a deleted file — which is most of them.
		const { feat } = await createRepoWithBranch();
		writeFileSync(join(feat, "unstaged-delete.txt"), "u\n");
		writeFileSync(join(feat, "staged-delete.txt"), "s\n");
		await git(["add", "-A"], feat);
		await git(["commit", "-m", "two files to delete"], feat);

		rmSync(join(feat, "unstaged-delete.txt"));
		await git(["rm", "-q", "staged-delete.txt"], feat);
		writeFileSync(join(feat, FILE), BASE.replace("l1", "EDITED"));

		const parked = await parkUncommittedWork(feat, "pre-rebase");
		if (!parked) throw new Error("expected work to be parked");
		expect(existsSync(join(feat, "unstaged-delete.txt"))).toBe(true); // back from HEAD
		await reapplyParkedWork(feat, parked);
		// Both deletions round-trip: they were in the parked tree as absences.
		expect(existsSync(join(feat, "unstaged-delete.txt"))).toBe(false);
		expect(existsSync(join(feat, "staged-delete.txt"))).toBe(false);
		expect(read(feat)).toBe(BASE.replace("l1", "EDITED"));
	});

	test("a staged rename round-trips, since both of its paths are checked", async () => {
		// `R  new\0old\0` is one record with two NUL-separated fields. A parser that
		// splits naively reads `old` as a status code and misparses the rest of the list.
		const { feat } = await createRepoWithBranch();
		writeFileSync(join(feat, "before.txt"), "content\n");
		await git(["add", "-A"], feat);
		await git(["commit", "-m", "a file to rename"], feat);
		await git(["mv", "before.txt", "after.txt"], feat);

		const parked = await parkUncommittedWork(feat, "pre-rebase");
		if (!parked) throw new Error("expected work to be parked");
		await reapplyParkedWork(feat, parked);
		expect(existsSync(join(feat, "before.txt"))).toBe(false);
		expect(read(feat, "after.txt")).toBe("content\n");
	});

	test("a conflicted merge is refused, because a reset would erase MERGE_HEAD", async () => {
		// `reset --hard` removes MERGE_HEAD — the only record of what was being combined
		// — and reports success. The user's half-resolved merge becomes unfinishable.
		const { main, feat } = await createRepoWithBranch();
		writeFileSync(join(main, FILE), BASE.replace("l5", "TRUNK5"));
		await git(["add", "-A"], main);
		await git(["commit", "-m", "trunk edits l5"], main);
		writeFileSync(join(feat, FILE), BASE.replace("l5", "MINE5"));
		await git(["add", "-A"], feat);
		await git(["commit", "-m", "feat edits l5"], feat);

		expect(await gitAllowFail(["merge", "main"], feat)).not.toBe(0);
		const mergeHead = await gitPath(feat, "MERGE_HEAD");
		expect(existsSync(mergeHead)).toBe(true);

		await expect(parkUncommittedWork(feat, "pre-rebase")).rejects.toThrow(/MERGE_HEAD/);
		expect(existsSync(mergeHead)).toBe(true);
		expect(read(feat)).toContain("<<<<<<<"); // the in-progress merge is untouched
	});

	test("a conflicted rebase is refused, because its residue breaks the next one", async () => {
		// Resetting through a rebase leaves `rebase-merge/` behind, and the *next* rebase
		// then dies with exit 128 telling the user to `rm -fr` it by hand.
		const { main, feat } = await createRepoWithBranch();
		writeFileSync(join(main, FILE), BASE.replace("l5", "TRUNK5"));
		await git(["add", "-A"], main);
		await git(["commit", "-m", "trunk edits l5"], main);
		writeFileSync(join(feat, FILE), BASE.replace("l5", "MINE5"));
		await git(["add", "-A"], feat);
		await git(["commit", "-m", "feat edits l5"], feat);

		expect(await gitAllowFail(["rebase", "main"], feat)).not.toBe(0);
		const rebaseDir = await gitPath(feat, "rebase-merge");
		expect(existsSync(rebaseDir)).toBe(true);

		await expect(parkUncommittedWork(feat, "pre-rebase")).rejects.toThrow(/rebase-merge/);
		expect(existsSync(rebaseDir)).toBe(true);
	});

	test("a finished rebase is not reported as in progress", async () => {
		// REBASE_HEAD survives a completed rebase, so probing refs rather than the
		// `rebase-merge/` directory would refuse forever after the first rebase.
		const { main, feat } = await createRepoWithBranch();
		writeFileSync(join(main, "trunk.txt"), "t\n");
		await git(["add", "-A"], main);
		await git(["commit", "-m", "trunk moves"], main);
		writeFileSync(join(feat, "feat.txt"), "f\n");
		await git(["add", "-A"], feat);
		await git(["commit", "-m", "feat commits"], feat);
		await git(["rebase", "main"], feat);

		writeFileSync(join(feat, FILE), BASE.replace("l1", "AFTER"));
		const parked = await parkUncommittedWork(feat, "second rebase");
		expect(parked).not.toBeNull();
	});
});

describe("untracked-only workspaces", () => {
	test("do not count as work git would refuse to operate over", async () => {
		const { feat } = await createRepoWithBranch();
		writeFileSync(join(feat, "notes.txt"), "scratch\n");
		mkdirSync(join(feat, "scratchdir"), { recursive: true });
		writeFileSync(join(feat, "scratchdir", "more.txt"), "m\n");

		expect(await hasUncommittedWork(feat)).toBe(false);
		expect(await parkUncommittedWork(feat, "park")).toBeNull();
		// Untouched: no reset, no clean, no snapshot round trip.
		expect(read(feat, "notes.txt")).toBe("scratch\n");
		expect(read(feat, "scratchdir/more.txt")).toBe("m\n");
	});

	test("survive a rebase byte-for-byte, which is why skipping the park is correct", async () => {
		const { main, feat } = await createRepoWithBranch();
		writeFileSync(join(main, FILE), BASE.replace("l1", "TRUNK"));
		await git(["add", "-A"], main);
		await git(["commit", "-m", "trunk edit"], main);
		writeFileSync(join(feat, "untracked.txt"), "mine\n");

		expect(await parkUncommittedWork(feat, "park")).toBeNull();
		await git(["rebase", "main"], feat);

		expect(read(feat, "untracked.txt")).toBe("mine\n");
		expect(read(feat)).toBe(BASE.replace("l1", "TRUNK"));
	});

	test("a collision with the incoming history is detectable, and force parks it", async () => {
		// The one case where an untracked file really does block the operation. git
		// reports it before changing anything, so parking on retry is safe — and that
		// retry needs `force`, since the workspace has no tracked changes.
		const { main, feat } = await createRepoWithBranch();
		writeFileSync(join(main, "collide.txt"), "from trunk\n");
		await git(["add", "-A"], main);
		await git(["commit", "-m", "trunk adds collide.txt"], main);
		writeFileSync(join(feat, "collide.txt"), "mine, untracked\n");

		expect(await untrackedCollisions(feat, "main")).toEqual(["collide.txt"]);
		// git's own verdict, and that it aborted without touching anything.
		const headBefore = await git(["rev-parse", "HEAD"], feat);
		expect(await gitAllowFail(["rebase", "main"], feat)).not.toBe(0);
		expect(await git(["rev-parse", "HEAD"], feat)).toBe(headBefore);
		expect(read(feat, "collide.txt")).toBe("mine, untracked\n");

		const parked = await parkUncommittedWork(feat, "retry after collision", { force: true });
		if (!parked) throw new Error("expected a forced park to happen");
		expect(existsSync(join(feat, "collide.txt"))).toBe(false);
		// Which is what lets the rebase run at all.
		await git(["rebase", "main"], feat);

		// And the reapply then reports the collision as the conflict it genuinely is: two
		// sides created the same path from nothing, so there is no third state to merge
		// against and picking one silently would lose the other. Nothing is written, and
		// the user's bytes stay in the snapshot — which is the difference that matters,
		// because before the park they were on disk and the operation simply refused.
		const result = await reapplyParkedWork(feat, parked);
		expect(result.conflicts).toEqual(["collide.txt"]);
		expect(read(feat, "collide.txt")).toBe("from trunk\n");
		expect(await worktreeTreeSnapshot.treeOfSnapshot(feat, parked.commitSha)).toBe(parked.treeHash);
	});

	test("a path that looks like a glob is compared literally", async () => {
		// An unescaped pathspec would treat `f[o]o.txt` as a pattern and could match a
		// different file, reporting a collision that does not exist.
		const { main, feat } = await createRepoWithBranch();
		writeFileSync(join(main, "foo.txt"), "trunk\n");
		await git(["add", "-A"], main);
		await git(["commit", "-m", "trunk adds foo.txt"], main);
		writeFileSync(join(feat, "f[o]o.txt"), "mine\n");

		expect(await untrackedCollisions(feat, "main")).toEqual([]);
	});
});

describe("reapplying parked work", () => {
	test("keeps both the operation's changes and the parked edits", async () => {
		const { main, feat } = await createRepoWithBranch();

		// Trunk advances at the top of the file.
		writeFileSync(join(main, FILE), BASE.replace("l1", "TRUNK"));
		await git(["add", "-A"], main);
		await git(["commit", "-m", "trunk edit"], main);

		// The chapter commits at the bottom, then leaves uncommitted work in the middle.
		writeFileSync(join(feat, FILE), BASE.replace("l10", "FEAT"));
		await git(["add", "-A"], feat);
		await git(["commit", "-m", "feat edit"], feat);
		writeFileSync(join(feat, FILE), BASE.replace("l10", "FEAT").replace("l5", "WIP"));
		writeFileSync(join(feat, "wip.txt"), "work in progress\n");

		const parked = await parkUncommittedWork(feat, "pre-rebase");
		if (!parked) throw new Error("expected work to be parked");
		await git(["rebase", "main"], feat);

		const result = await reapplyParkedWork(feat, parked);
		expect(result.conflicts).toEqual([]);

		const content = read(feat);
		expect(content).toContain("TRUNK"); // brought in by the rebase
		expect(content).toContain("FEAT"); // the chapter's own commit, replayed
		expect(content).toContain("WIP"); // the parked uncommitted edit
		expect(read(feat, "wip.txt")).toBe("work in progress\n");
	});

	test("a reapply is a merge, not a restore — it cannot undo the operation", async () => {
		const { main, feat } = await createRepoWithBranch();
		writeFileSync(join(main, "fromtrunk.txt"), "trunk only\n");
		await git(["add", "-A"], main);
		await git(["commit", "-m", "trunk adds a file"], main);
		writeFileSync(join(feat, FILE), BASE.replace("l10", "FEAT"));
		await git(["add", "-A"], feat);
		await git(["commit", "-m", "feat edit"], feat);
		writeFileSync(join(feat, "mine.txt"), "mine\n");
		// Staged, because an untracked-only workspace deliberately no longer parks: git
		// operates over untracked files fine. Staging makes it the blocking change the
		// case is about while keeping it a newly added path.
		await git(["add", "mine.txt"], feat);

		const parked = await parkUncommittedWork(feat, "pre-rebase");
		if (!parked) throw new Error("expected work to be parked");
		await git(["rebase", "main"], feat);
		await reapplyParkedWork(feat, parked);

		// A restore of the parked tree would delete this, because it predates the rebase.
		expect(existsSync(join(feat, "fromtrunk.txt"))).toBe(true);
		expect(existsSync(join(feat, "mine.txt"))).toBe(true);
	});

	test("a genuine overlap conflicts and nothing is written", async () => {
		const { main, feat } = await createRepoWithBranch();
		// Trunk and the uncommitted work touch the same line.
		writeFileSync(join(main, FILE), BASE.replace("l5", "TRUNK5"));
		await git(["add", "-A"], main);
		await git(["commit", "-m", "trunk edits l5"], main);
		writeFileSync(join(feat, FILE), BASE.replace("l5", "MINE5"));

		const parked = await parkUncommittedWork(feat, "pre-rebase");
		if (!parked) throw new Error("expected work to be parked");
		await git(["rebase", "main"], feat);

		const result = await reapplyParkedWork(feat, parked);
		expect(result.conflicts).toEqual([FILE]);
		expect(result.changedFiles).toEqual([]);
		// Conflict markers on disk would corrupt a file the user never asked to merge.
		expect(read(feat)).not.toContain("<<<<<<<");
		expect(read(feat)).toContain("TRUNK5");
		// The parked work is still recoverable, which is what makes refusing acceptable.
		expect(await worktreeTreeSnapshot.treeOfSnapshot(feat, parked.commitSha)).toBe(parked.treeHash);
	});

	test("a file tracked despite an ignore rule is not read as a deletion", async () => {
		// The base has to come from a snapshot, not from git's HEAD. A shadow repository
		// builds its index under its own excludes, so this file is in HEAD's tree and in no
		// snapshot; used as a merge base, that absence reads as "theirs deleted it".
		const { main, feat } = await createRepoWithBranch();
		writeFileSync(join(feat, ".gitignore"), "tracked-anyway.txt\n");
		writeFileSync(join(feat, "tracked-anyway.txt"), "kept\n");
		await git(["add", "-A", "-f"], feat);
		await git(["commit", "-m", "track an ignored path"], feat);
		writeFileSync(join(feat, FILE), BASE.replace("l1", "WIP"));

		writeFileSync(join(main, "trunk.txt"), "t\n");
		await git(["add", "-A"], main);
		await git(["commit", "-m", "trunk moves"], main);

		const parked = await parkUncommittedWork(feat, "pre-rebase");
		if (!parked) throw new Error("expected work to be parked");
		await git(["rebase", "main"], feat);
		const result = await reapplyParkedWork(feat, parked);

		expect(result.conflicts).toEqual([]);
		expect(existsSync(join(feat, "tracked-anyway.txt"))).toBe(true);
		expect(read(feat, "tracked-anyway.txt")).toBe("kept\n");
	});

	test("a workspace it cannot capture throws and writes nothing", async () => {
		// The third outcome, alongside "merged" and "conflicted", and the only one that was
		// untested: the post-operation capture fails, so there is no `ours` side and the
		// three-way merge cannot be computed at all. It must throw rather than fall back to
		// materialising the parked tree — that would silently undo whatever the operation
		// brought in — and it must leave the disk alone, since the parked snapshot is the
		// user's only copy and the error names it.
		//
		// Callers diverge on this path (`routes/ruler.ts` and `chapter-merge.ts` handle the
		// throw differently), which is the reason to pin the contract here rather than only
		// where it is consumed.
		const { feat } = await createRepoWithBranch();
		writeFileSync(join(feat, FILE), BASE.replace("l1", "MINE"));
		const parked = await parkUncommittedWork(feat, "pre-rebase");
		if (!parked) throw new Error("expected work to be parked");
		// The workspace after the operation: reset to HEAD by the park, then advanced.
		writeFileSync(join(feat, "after-op.txt"), "brought in by the operation\n");
		const onDiskBefore = read(feat);

		const original = worktreeTreeSnapshot.tryCapture;
		// `tryCapture` returning null is exactly what a real failure looks like to this
		// function — a killed git, a stale index.lock, a vanished worktree — and it is the
		// documented contract of that method, so substituting it tests the branch rather
		// than a mock's behaviour.
		worktreeTreeSnapshot.tryCapture = async () => null;
		try {
			await expect(reapplyParkedWork(feat, parked)).rejects.toThrow(
				new RegExp(parked.commitSha.slice(0, 12)),
			);
		} finally {
			worktreeTreeSnapshot.tryCapture = original;
		}

		// Nothing written: the operation's file is still there and the parked edit was not
		// restored over it.
		expect(read(feat, "after-op.txt")).toBe("brought in by the operation\n");
		expect(read(feat)).toBe(onDiskBefore);
		// And the parked work is still where the error says it is.
		expect(await worktreeTreeSnapshot.treeOfSnapshot(feat, parked.commitSha)).toBe(parked.treeHash);
	});

	test("reapplying onto an unchanged workspace is a no-op rather than an error", async () => {
		const { feat } = await createRepoWithBranch();
		writeFileSync(join(feat, FILE), "dirty\n");
		const parked = await parkUncommittedWork(feat, "park");
		if (!parked) throw new Error("expected work to be parked");
		// Put it straight back, so the workspace already equals the parked tree.
		await worktreeTreeSnapshot.materializeTree(feat, parked.treeHash);

		const result = await reapplyParkedWork(feat, parked);
		expect(result.conflicts).toEqual([]);
		expect(result.changedFiles).toEqual([]);
		expect(read(feat)).toBe("dirty\n");
	});

	test("the no-op path still moves the lineage onto what is on disk", async () => {
		// Parking advances the lineage twice — to the dirty state, then to the clean base
		// captured after the reset. Returning early without advancing left the head at
		// that *reset* state while the parked work sat on disk, so a later fork would
		// start from a state the user had already edited past.
		const { feat } = await createRepoWithBranch();
		writeFileSync(join(feat, FILE), "dirty\n");
		const parked = await parkUncommittedWork(feat, "park");
		if (!parked) throw new Error("expected work to be parked");
		await worktreeTreeSnapshot.materializeTree(feat, parked.treeHash);

		await reapplyParkedWork(feat, parked);
		const head = await worktreeTreeSnapshot.getRef(feat, SNAPSHOT_HEAD_REF);
		if (!head) throw new Error("expected a snapshot head");
		expect(await worktreeTreeSnapshot.treeOfSnapshot(feat, head)).toBe(parked.treeHash);
	});
});

describe("undoing a failed operation", () => {
	test("restoring brings back the exact pre-operation workspace", async () => {
		const { main, feat } = await createRepoWithBranch();
		writeFileSync(join(main, FILE), BASE.replace("l1", "TRUNK"));
		await git(["add", "-A"], main);
		await git(["commit", "-m", "trunk edit"], main);

		writeFileSync(join(feat, FILE), BASE.replace("l1", "MINE"));
		writeFileSync(join(feat, "extra.txt"), "e\n");
		const parked = await parkUncommittedWork(feat, "park");
		if (!parked) throw new Error("expected work to be parked");

		// A conflicting rebase that the caller decides to give up on.
		await gitAllowFail(["rebase", "main"], feat);
		await gitAllowFail(["rebase", "--abort"], feat);
		await restoreParkedWork(feat, parked);

		expect(read(feat)).toBe(BASE.replace("l1", "MINE"));
		expect(read(feat, "extra.txt")).toBe("e\n");
	});
});

describe("settling work parked by an earlier operation", () => {
	test("coordinates alone are enough, because the conflict path settles later", async () => {
		// A conflicted rebase is finished by the narrator running `rebase --continue`, so no
		// request runs when it ends: the reapply has to be doable from stored ids only.
		const { main, feat } = await createRepoWithBranch();
		writeFileSync(join(feat, "wip.txt"), "w\n");
		// Staged: untracked-only is no longer treated as blocking, and this case is about
		// the settle rather than about what counts as dirty.
		await git(["add", "wip.txt"], feat);
		const parked = await parkUncommittedWork(feat, "park");
		if (!parked) throw new Error("expected work to be parked");

		writeFileSync(join(main, "later.txt"), "l\n");
		await git(["add", "-A"], main);
		await git(["commit", "-m", "trunk moves"], main);
		await git(["rebase", "main"], feat);

		const settled = await settleParkedWork(feat, parked.commitSha, parked.baseTree);
		expect(settled?.conflicts).toEqual([]);
		expect(existsSync(join(feat, "wip.txt"))).toBe(true);
		expect(existsSync(join(feat, "later.txt"))).toBe(true);
	});

	test("a vanished snapshot reports null instead of claiming success", async () => {
		const { feat } = await createRepoWithBranch();
		const missing = "0".repeat(40);
		expect(await settleParkedWork(feat, missing, missing)).toBeNull();
	});
});
