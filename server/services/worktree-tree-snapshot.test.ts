import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import iconv from "iconv-lite";
import { db } from "../db";
import { worktreeTreeSnapshots } from "../db/schema";
import { normalizePathForComparison } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";
import {
	planTreeRevertSegments,
	TreeRestoreError,
	TreeSnapshotError,
	worktreeTreeSnapshot,
} from "./worktree-tree-snapshot";

const tempDirs: string[] = [];
const snapshotPaths: string[] = [];

/** Create a real git repository, since snapshots mirror its ignore rules. */
async function createRepo(prefix: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	snapshotPaths.push(normalizePathForComparison(dir));
	await safeSpawn({ cmd: ["git", "init"], cwd: dir, timeout: 15_000 });
	await safeSpawn({ cmd: ["git", "config", "user.email", "test@example.com"], cwd: dir });
	await safeSpawn({ cmd: ["git", "config", "user.name", "Test"], cwd: dir });
	return dir;
}

/**
 * Create a *linked* worktree, which is the only shape production ever runs.
 *
 * Every chapter lives in `<project>/.worktrees/<name>`, where `.git` is a file
 * pointing at `<main>/.git/worktrees/<name>` and the repository-level `info/exclude`
 * lives in the common dir instead. A `git init` repo — what every existing case here
 * used — has none of that indirection, so it could not see whether the exclude
 * resolution worked.
 *
 * Returns the linked worktree path; the main repo is registered for cleanup too.
 */
async function createLinkedWorktree(prefix: string): Promise<{ main: string; worktree: string }> {
	const main = mkdtempSync(join(tmpdir(), `${prefix}main-`));
	tempDirs.push(main);
	await safeSpawn({ cmd: ["git", "init"], cwd: main, timeout: 15_000 });
	await safeSpawn({ cmd: ["git", "config", "user.email", "test@example.com"], cwd: main });
	await safeSpawn({ cmd: ["git", "config", "user.name", "Test"], cwd: main });
	writeFileSync(join(main, "seed.txt"), "seed\n");
	await safeSpawn({ cmd: ["git", "add", "-A"], cwd: main, timeout: 15_000 });
	await safeSpawn({ cmd: ["git", "commit", "-m", "seed"], cwd: main, timeout: 15_000 });

	const worktree = join(main, ".worktrees", "chapter");
	const added = await safeSpawn({
		cmd: ["git", "worktree", "add", worktree, "-b", "chapter"],
		cwd: main,
		timeout: 15_000,
	});
	if (added.exitCode !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
	tempDirs.push(worktree);
	snapshotPaths.push(normalizePathForComparison(worktree));
	return { main, worktree };
}

/** Write the repository-level exclude, which for a linked worktree is in the common dir. */
async function writeRepoExclude(mainRepo: string, contents: string): Promise<void> {
	const infoDir = join(mainRepo, ".git", "info");
	mkdirSync(infoDir, { recursive: true });
	writeFileSync(join(infoDir, "exclude"), contents);
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await worktreeTreeSnapshot.destroy(dir).catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
	for (const path of snapshotPaths.splice(0)) {
		await db.delete(worktreeTreeSnapshots).where(eq(worktreeTreeSnapshots.worktreePath, path));
	}
});

describe("worktree tree snapshots", () => {
	test("captures a tree hash and records it once per distinct state", async () => {
		const repo = await createRepo("nf-tree-capture-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		const first = await worktreeTreeSnapshot.capture(repo);
		expect(first).toMatch(/^[0-9a-f]{40}$/);

		// Identical content is content-addressed to the same hash and deduplicated.
		const again = await worktreeTreeSnapshot.capture(repo);
		expect(again).toBe(first);

		writeFileSync(join(repo, "a.txt"), "two\n");
		const changed = await worktreeTreeSnapshot.capture(repo);
		expect(changed).not.toBe(first);

		const rows = await db.query.worktreeTreeSnapshots.findMany({
			where: eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(repo)),
		});
		expect(rows).toHaveLength(2);
	});

	test("never creates a commit or branch in the user's repository", async () => {
		const repo = await createRepo("nf-tree-nocommit-");
		writeFileSync(join(repo, "a.txt"), "one\n");
		await worktreeTreeSnapshot.capture(repo);

		// The user's repo must still have no commits and a clean staging area.
		const log = await safeSpawn({ cmd: ["git", "log", "--oneline"], cwd: repo, timeout: 15_000 });
		expect(log.exitCode).not.toBe(0);
		const staged = await safeSpawn({
			cmd: ["git", "diff", "--cached", "--name-only"],
			cwd: repo,
			timeout: 15_000,
		});
		expect(staged.stdout.trim()).toBe("");
	});

	test("captures changes made outside the Write/Edit tools", async () => {
		const repo = await createRepo("nf-tree-external-");
		writeFileSync(join(repo, "a.txt"), "original\n");
		const before = await worktreeTreeSnapshot.capture(repo);

		// Stands in for a Bash command, build script, or the user's own editor —
		// none of which produce recorded tool inputs to replay.
		writeFileSync(join(repo, "a.txt"), "changed by a shell command\n");
		writeFileSync(join(repo, "generated.txt"), "new file\n");
		const after = await worktreeTreeSnapshot.capture(repo);
		expect(after).not.toBe(before);

		const changed = await worktreeTreeSnapshot.diffPaths(repo, before, after);
		expect(changed.sort()).toEqual(["a.txt", "generated.txt"]);
	});

	test("restores modified, deleted, and newly created files", async () => {
		const repo = await createRepo("nf-tree-restore-");
		writeFileSync(join(repo, "keep.txt"), "keep\n");
		writeFileSync(join(repo, "modify.txt"), "before\n");
		writeFileSync(join(repo, "delete-me.txt"), "present\n");
		const snapshot = await worktreeTreeSnapshot.capture(repo);

		writeFileSync(join(repo, "modify.txt"), "after\n");
		rmSync(join(repo, "delete-me.txt"));
		writeFileSync(join(repo, "created.txt"), "should be removed\n");

		const changed = await worktreeTreeSnapshot.restore(repo, snapshot);

		expect(readFileSync(join(repo, "modify.txt"), "utf8")).toBe("before\n");
		expect(readFileSync(join(repo, "delete-me.txt"), "utf8")).toBe("present\n");
		// A file created after the snapshot did not exist in it, so it must be gone.
		expect(existsSync(join(repo, "created.txt"))).toBe(false);
		expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("keep\n");
		expect(changed.sort()).toEqual(["created.txt", "delete-me.txt", "modify.txt"]);
	});

	test("restoring an unchanged worktree is a no-op", async () => {
		const repo = await createRepo("nf-tree-noop-");
		writeFileSync(join(repo, "a.txt"), "one\n");
		const snapshot = await worktreeTreeSnapshot.capture(repo);

		expect(await worktreeTreeSnapshot.restore(repo, snapshot)).toEqual([]);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
	});

	test("round-trips binary files byte for byte", async () => {
		const repo = await createRepo("nf-tree-binary-");
		const blob = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x42, 0x80]);
		writeFileSync(join(repo, "blob.bin"), blob);
		const snapshot = await worktreeTreeSnapshot.capture(repo);

		writeFileSync(join(repo, "blob.bin"), Buffer.from([0x99]));
		await worktreeTreeSnapshot.restore(repo, snapshot);

		// The text-snapshot path cannot do this: decoding and re-encoding these
		// bytes is lossy, which is why binary files are refused there.
		expect(Buffer.compare(readFileSync(join(repo, "blob.bin")), blob)).toBe(0);
	});

	test("round-trips legacy-encoded text without changing its charset", async () => {
		const repo = await createRepo("nf-tree-encoding-");
		const original = "你好世界\n这是GBK编码的文件\n";
		const gbkBytes = iconv.encode(original, "gbk");
		writeFileSync(join(repo, "gbk.txt"), gbkBytes);
		const snapshot = await worktreeTreeSnapshot.capture(repo);

		writeFileSync(join(repo, "gbk.txt"), "overwritten as utf-8");
		await worktreeTreeSnapshot.restore(repo, snapshot);

		// Byte equality means the charset survived; no decode/encode step occurred.
		expect(Buffer.compare(readFileSync(join(repo, "gbk.txt")), gbkBytes)).toBe(0);
		expect(iconv.decode(readFileSync(join(repo, "gbk.txt")), "gbk")).toBe(original);
	});

	test("ignores paths excluded by .gitignore", async () => {
		const repo = await createRepo("nf-tree-ignore-");
		writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.log\n");
		mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "junk\n");
		writeFileSync(join(repo, "debug.log"), "noise\n");
		writeFileSync(join(repo, "src.txt"), "tracked\n");

		const before = await worktreeTreeSnapshot.capture(repo);

		// Touching ignored paths must not change the snapshot identity.
		writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "different junk\n");
		writeFileSync(join(repo, "debug.log"), "more noise\n");
		expect(await worktreeTreeSnapshot.capture(repo)).toBe(before);

		writeFileSync(join(repo, "src.txt"), "changed\n");
		expect(await worktreeTreeSnapshot.capture(repo)).not.toBe(before);
	});

	test("honours a nested .gitignore, not just the root one", async () => {
		const repo = await createRepo("nf-tree-nested-ignore-");
		writeFileSync(join(repo, ".gitignore"), "*.log\n");
		mkdirSync(join(repo, "packages", "app", "dist"), { recursive: true });
		// The shape that matters in a monorepo: the rule that hides build output lives in
		// the package, not at the root. A snapshot that missed it would capture `dist/`
		// and a rollback would then delete files git itself considers ignored.
		writeFileSync(join(repo, "packages", "app", ".gitignore"), "dist/\n");
		writeFileSync(join(repo, "packages", "app", "dist", "bundle.js"), "built\n");
		writeFileSync(join(repo, "packages", "app", "src.ts"), "source\n");

		const before = await worktreeTreeSnapshot.capture(repo);
		expect(await worktreeTreeSnapshot.listPaths(repo, before)).not.toContain(
			"packages/app/dist/bundle.js",
		);

		// Rebuilding must not move the snapshot identity.
		writeFileSync(join(repo, "packages", "app", "dist", "bundle.js"), "rebuilt\n");
		expect(await worktreeTreeSnapshot.capture(repo)).toBe(before);

		// And a rollback must leave the ignored build output alone.
		writeFileSync(join(repo, "packages", "app", "src.ts"), "changed\n");
		await worktreeTreeSnapshot.restore(repo, before);
		expect(readFileSync(join(repo, "packages", "app", "src.ts"), "utf8")).toBe("source\n");
		expect(readFileSync(join(repo, "packages", "app", "dist", "bundle.js"), "utf8")).toBe(
			"rebuilt\n",
		);
	});

	test("restoring leaves ignored files untouched", async () => {
		const repo = await createRepo("nf-tree-ignore-restore-");
		writeFileSync(join(repo, ".gitignore"), "*.log\n");
		writeFileSync(join(repo, "keep.log"), "local only\n");
		writeFileSync(join(repo, "src.txt"), "before\n");
		const snapshot = await worktreeTreeSnapshot.capture(repo);

		writeFileSync(join(repo, "src.txt"), "after\n");
		writeFileSync(join(repo, "keep.log"), "still local\n");
		await worktreeTreeSnapshot.restore(repo, snapshot);

		expect(readFileSync(join(repo, "src.txt"), "utf8")).toBe("before\n");
		// Ignored files are outside the snapshot's authority and must survive.
		expect(readFileSync(join(repo, "keep.log"), "utf8")).toBe("still local\n");
	});

	test("copies a snapshot onto a different worktree", async () => {
		const source = await createRepo("nf-tree-fork-src-");
		const target = await createRepo("nf-tree-fork-dst-");
		writeFileSync(join(source, "a.txt"), "source state\n");
		const snapshot = await worktreeTreeSnapshot.capture(source);

		await worktreeTreeSnapshot.restoreInto(source, target, snapshot);

		expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("source state\n");
	});

	test("reports whether a tree object is present", async () => {
		const repo = await createRepo("nf-tree-has-");
		writeFileSync(join(repo, "a.txt"), "one\n");
		const snapshot = await worktreeTreeSnapshot.capture(repo);

		expect(await worktreeTreeSnapshot.hasTree(repo, snapshot)).toBe(true);
		expect(await worktreeTreeSnapshot.hasTree(repo, "0".repeat(40))).toBe(false);
	});

	test("tryCapture reports failure instead of throwing into the tool path", async () => {
		// A path that does not exist cannot be added; the tool must still proceed.
		const missing = join(tmpdir(), `nf-tree-missing-${Date.now()}`);
		expect(await worktreeTreeSnapshot.tryCapture(missing)).toBeNull();
	});

	test("rejects remote devices explicitly rather than silently using local paths", async () => {
		const repo = await createRepo("nf-tree-remote-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		await expect(worktreeTreeSnapshot.capture(repo, "remote-a")).rejects.toBeInstanceOf(
			TreeSnapshotError,
		);
		expect(await worktreeTreeSnapshot.tryCapture(repo, "remote-a")).toBeNull();
	});

	test("keeps snapshots of different worktrees isolated", async () => {
		const first = await createRepo("nf-tree-iso-a-");
		const second = await createRepo("nf-tree-iso-b-");
		writeFileSync(join(first, "a.txt"), "first\n");
		writeFileSync(join(second, "a.txt"), "second\n");

		const firstTree = await worktreeTreeSnapshot.capture(first);
		const secondTree = await worktreeTreeSnapshot.capture(second);
		expect(firstTree).not.toBe(secondTree);

		// Each shadow repo only knows its own trees.
		expect(await worktreeTreeSnapshot.hasTree(first, secondTree)).toBe(false);
		expect(await worktreeTreeSnapshot.hasTree(second, firstTree)).toBe(false);
	});

	test("respects global gitignore (core.excludesFile) rules", async () => {
		const repo = await createRepo("nf-tree-global-ignore-");
		const globalIgnorePath = join(repo, ".global-gitignore");
		writeFileSync(globalIgnorePath, "*.generated\nbuild/\n");

		// Configure git in this repo to use the custom global excludesFile
		await safeSpawn({
			cmd: ["git", "config", "--local", "core.excludesFile", globalIgnorePath],
			cwd: repo,
			timeout: 15_000,
		});

		writeFileSync(join(repo, "src.txt"), "tracked\n");
		writeFileSync(join(repo, "output.generated"), "should be ignored\n");
		mkdirSync(join(repo, "build"), { recursive: true });
		writeFileSync(join(repo, "build", "app.js"), "compiled\n");

		const before = await worktreeTreeSnapshot.capture(repo);

		// Touching globally-ignored paths must not change the snapshot identity.
		writeFileSync(join(repo, "output.generated"), "changed\n");
		writeFileSync(join(repo, "build", "app.js"), "recompiled\n");
		expect(await worktreeTreeSnapshot.capture(repo)).toBe(before);

		// Touching tracked file must change it.
		writeFileSync(join(repo, "src.txt"), "changed\n");
		expect(await worktreeTreeSnapshot.capture(repo)).not.toBe(before);
	});

	test("global gitignore gracefully degrades when file does not exist", async () => {
		const repo = await createRepo("nf-tree-global-ignore-missing-");

		// Point core.excludesFile at a non-existent path
		await safeSpawn({
			cmd: ["git", "config", "--local", "core.excludesFile", "/nonexistent/gitignore"],
			cwd: repo,
			timeout: 15_000,
		});

		writeFileSync(join(repo, "a.txt"), "content\n");

		// Should not throw — graceful degradation
		const hash = await worktreeTreeSnapshot.capture(repo);
		expect(hash).toMatch(/^[0-9a-f]{40}$/);
	});

	test("lists and diffs non-ASCII paths verbatim, not as quoted escapes", async () => {
		const repo = await createRepo("nf-tree-cjk-paths-");
		const cjk = "中文 文件.txt";
		writeFileSync(join(repo, "ascii.txt"), "a\n");
		const before = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, cjk), "b\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		// git's default core.quotePath would return `"\344\270\255..."`, which is not a
		// path any filesystem call can use.
		expect(await worktreeTreeSnapshot.diffPaths(repo, before, after)).toEqual([cjk]);
		expect((await worktreeTreeSnapshot.listPaths(repo, after)).sort()).toEqual(
			["ascii.txt", cjk].sort(),
		);

		// Restoring must therefore actually remove the file it reports.
		const changed = await worktreeTreeSnapshot.restore(repo, before);
		expect(changed).toEqual([cjk]);
		expect(existsSync(join(repo, cjk))).toBe(false);
	});
});

/**
 * Snapshots against a *linked* worktree — the only shape production runs.
 *
 * Every chapter is a worktree under `.worktrees/`, where `.git` is a pointer file and
 * the repository-level `info/exclude` lives in the common dir named by `commondir`.
 * The previous cases all used `git init`, so nothing covered that indirection and the
 * exclude was in fact never mirrored in production.
 */
describe("linked worktrees", () => {
	test("captures and restores a linked worktree", async () => {
		const { worktree } = await createLinkedWorktree("nf-tree-linked-");
		writeFileSync(join(worktree, "a.txt"), "v1\n");
		const before = await worktreeTreeSnapshot.capture(worktree);

		writeFileSync(join(worktree, "a.txt"), "v2\n");
		writeFileSync(join(worktree, "created.txt"), "new\n");
		const changed = await worktreeTreeSnapshot.restore(worktree, before);

		expect(changed.sort()).toEqual(["a.txt", "created.txt"]);
		expect(readFileSync(join(worktree, "a.txt"), "utf8")).toBe("v1\n");
		expect(existsSync(join(worktree, "created.txt"))).toBe(false);
		// The pointer file must never be captured, or a rollback could rewrite it.
		expect(await worktreeTreeSnapshot.listPaths(worktree, before)).not.toContain(".git");
	});

	test("mirrors the repository-level exclude reached through commondir", async () => {
		const { main, worktree } = await createLinkedWorktree("nf-tree-linked-exclude-");
		// A linked worktree's own gitdir has no info/ at all; this is the file git
		// actually consults, and reading `<gitdir>/info/exclude` found nothing.
		await writeRepoExclude(main, "local-only/\n*.tmp\n");
		mkdirSync(join(worktree, "local-only"), { recursive: true });
		writeFileSync(join(worktree, "local-only", "scratch.txt"), "scratch\n");
		writeFileSync(join(worktree, "notes.tmp"), "temp\n");
		writeFileSync(join(worktree, "tracked.txt"), "tracked\n");

		const before = await worktreeTreeSnapshot.capture(worktree);
		const paths = await worktreeTreeSnapshot.listPaths(worktree, before);
		expect(paths).toContain("tracked.txt");
		expect(paths).not.toContain("notes.tmp");
		expect(paths).not.toContain("local-only/scratch.txt");

		// Touching excluded paths must not move the snapshot identity...
		writeFileSync(join(worktree, "notes.tmp"), "changed\n");
		expect(await worktreeTreeSnapshot.capture(worktree)).toBe(before);

		// ...and a rollback must not delete them, which is what happened when they
		// entered the snapshot: they looked like files created after the boundary.
		writeFileSync(join(worktree, "tracked.txt"), "changed\n");
		await worktreeTreeSnapshot.restore(worktree, before);
		expect(readFileSync(join(worktree, "tracked.txt"), "utf8")).toBe("tracked\n");
		expect(readFileSync(join(worktree, "notes.tmp"), "utf8")).toBe("changed\n");
		expect(existsSync(join(worktree, "local-only", "scratch.txt"))).toBe(true);
	});

	test("picks up a repository-level exclude edited after the first capture", async () => {
		const { main, worktree } = await createLinkedWorktree("nf-tree-linked-exclude-stale-");
		const first = await worktreeTreeSnapshot.capture(worktree);
		expect(await worktreeTreeSnapshot.listPaths(worktree, first)).not.toContain("build.out");

		// The mirrored copy has to be invalidated when the source changes, or a newly
		// ignored build artefact keeps entering snapshots until the process restarts.
		// Asserted on a file created *after* the edit: git keeps an already-indexed path
		// even once it becomes ignored, so a pre-existing file could not tell the two
		// apart.
		await writeRepoExclude(main, "*.out\n");
		writeFileSync(join(worktree, "build.out"), "built\n");
		const after = await worktreeTreeSnapshot.capture(worktree);
		expect(await worktreeTreeSnapshot.listPaths(worktree, after)).not.toContain("build.out");
		// The snapshot identity must not move either — a build must be invisible.
		expect(after).toBe(first);
	});
});

/**
 * A restore that fails partway through must not leave a half-applied worktree.
 *
 * The delete loop runs before `read-tree`/`checkout-index`, and `rmSync` only ignores
 * ENOENT — a path that became a directory or is locked throws mid-loop with earlier
 * files already gone. Without compensation the caller learns only "restore failed"
 * and has no recorded pre-state to undo, because the success path is the only one
 * that returned one.
 */
describe("restore failure compensation", () => {
	test("a failure in the delete loop restores the pre-rollback state", async () => {
		const repo = await createRepo("nf-tree-restore-halfway-");
		writeFileSync(join(repo, "keep.txt"), "keep\n");
		const boundary = await worktreeTreeSnapshot.capture(repo);

		// Both new files are in the delete set (created after the boundary). The second
		// one sits in a directory the process cannot write, so the real `rmSync` raises
		// EACCES — no mocking — after the first has already been deleted.
		writeFileSync(join(repo, "aaa-created.txt"), "first\n");
		mkdirSync(join(repo, "zzz-locked"), { recursive: true });
		writeFileSync(join(repo, "zzz-locked", "trapped.txt"), "second\n");
		writeFileSync(join(repo, "keep.txt"), "changed\n");
		const beforeRollback = await worktreeTreeSnapshot.capture(repo);
		// Read+execute only: entries can be listed but not unlinked.
		chmodSync(join(repo, "zzz-locked"), 0o500);

		let caught: unknown;
		try {
			await worktreeTreeSnapshot.restore(repo, boundary);
		} catch (error) {
			caught = error;
		} finally {
			chmodSync(join(repo, "zzz-locked"), 0o700);
		}

		expect(caught).toBeInstanceOf(TreeRestoreError);
		// The captured hash is what lets the caller register a compensation for a
		// rollback that had already begun writing — the success path is the only one that
		// used to return one, so a mid-restore failure left nothing to undo with.
		expect((caught as TreeRestoreError).capturedTreeHash).toBe(beforeRollback);
		expect((caught as TreeRestoreError).compensated).toBe(true);

		// The pre-rollback state is back: the file deleted before the failure was
		// recreated, and the edit the rollback would have undone still stands.
		expect(existsSync(join(repo, "aaa-created.txt"))).toBe(true);
		expect(readFileSync(join(repo, "aaa-created.txt"), "utf8")).toBe("first\n");
		expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("changed\n");
		expect(await worktreeTreeSnapshot.capture(repo)).toBe(beforeRollback);
	});

	test("a scoped rollback reports the failure and registers its compensation", async () => {
		// The reversal path (not the raw restore) has to carry the same guarantee: it is
		// the one whose catch used to return `TREE_RESTORE_FAILED` without ever calling
		// `registerTreeCompensation`, so all three capture-then-compensate exits had no
		// pre-state to work from.
		const repo = await createRepo("nf-tree-reverse-halfway-");
		writeFileSync(join(repo, "keep.txt"), "keep\n");
		const before = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, "keep.txt"), "changed\n");
		mkdirSync(join(repo, "zzz-locked"), { recursive: true });
		writeFileSync(join(repo, "zzz-locked", "trapped.txt"), "created\n");
		const after = await worktreeTreeSnapshot.capture(repo);
		chmodSync(join(repo, "zzz-locked"), 0o500);

		let caught: unknown;
		try {
			await worktreeTreeSnapshot.reverseAndRestore(repo, [{ before, after, ownedPaths: null }]);
		} catch (error) {
			caught = error;
		} finally {
			chmodSync(join(repo, "zzz-locked"), 0o700);
		}

		expect(caught).toBeInstanceOf(TreeRestoreError);
		expect((caught as TreeRestoreError).capturedTreeHash).toBe(after);
		// Compensated, so the workspace still holds exactly what it held before.
		expect(await worktreeTreeSnapshot.capture(repo)).toBe(after);
		expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("changed\n");
	});
});

describe("planTreeRevertSegments", () => {
	test("merges pairs that chain and splits where a foreign write landed", () => {
		// b→c chains, so those collapse; the c→x gap means someone else wrote in
		// between, and spanning it would reverse their change too.
		expect(
			planTreeRevertSegments([
				{ before: "a", after: "b" },
				{ before: "b", after: "c" },
				{ before: "x", after: "y" },
			]),
		).toEqual([
			{ before: "a", after: "c", ownedPaths: null },
			{ before: "x", after: "y", ownedPaths: null },
		]);
	});

	test("drops calls that changed nothing so they cannot anchor a rollback", () => {
		// A spec:// write or a read-only Bash leaves the tree identical.
		expect(
			planTreeRevertSegments([
				{ before: "a", after: "a" },
				{ before: "a", after: "b" },
				{ before: "b", after: "b" },
			]),
		).toEqual([{ before: "a", after: "b", ownedPaths: null }]);
		expect(planTreeRevertSegments([{ before: "a", after: "a" }])).toEqual([]);
		expect(planTreeRevertSegments([])).toEqual([]);
	});

	test("unions owned paths across a chained run", () => {
		// The collapsed span covers both calls, so reversing it must be allowed to
		// touch either one's paths — but nothing else in the shared worktree.
		expect(
			planTreeRevertSegments([
				{ before: "a", after: "b", ownedPaths: ["one.txt"] },
				{ before: "b", after: "c", ownedPaths: ["two.txt", "one.txt"] },
			]),
		).toEqual([{ before: "a", after: "c", ownedPaths: ["one.txt", "two.txt"] }]);
	});

	test("one unknown range poisons the chained run to whole-tree", () => {
		// A legacy row states nothing about which paths were its own, so the span it
		// belongs to cannot be narrowed. Claiming the known half would leave the other
		// half of the same span un-reversed.
		expect(
			planTreeRevertSegments([
				{ before: "a", after: "b", ownedPaths: ["one.txt"] },
				{ before: "b", after: "c", ownedPaths: null },
			]),
		).toEqual([{ before: "a", after: "c", ownedPaths: null }]);
	});

	test("a duplicate pair does not chain, so it costs an extra segment", () => {
		// Why `selectPairs` dedupes. The same boundary recorded twice (a cloned
		// tool-call row) cannot collapse, because chaining requires `after === before`
		// and here they differ. Each copy becomes its own segment, so a rollback pays
		// one extra `merge-tree` per duplicate.
		//
		// Note this is a cost concern, not a correctness one: reversing the same
		// boundary again is `merge(base=after, ours=before, theirs=before)`, which
		// yields `before` unchanged.
		expect(
			planTreeRevertSegments([
				{ before: "a", after: "b" },
				{ before: "a", after: "b" },
			]),
		).toEqual([
			{ before: "a", after: "b", ownedPaths: null },
			{ before: "a", after: "b", ownedPaths: null },
		]);
	});

	test("does not mutate the caller's pairs", () => {
		const pairs = [
			{ before: "a", after: "b", ownedPaths: ["one.txt"] },
			{ before: "b", after: "c", ownedPaths: ["two.txt"] },
		];
		planTreeRevertSegments(pairs);
		expect(pairs).toEqual([
			{ before: "a", after: "b", ownedPaths: ["one.txt"] },
			{ before: "b", after: "c", ownedPaths: ["two.txt"] },
		]);
	});
});

/**
 * Reversing only the paths one actor owns.
 *
 * A whole-tree merge result cannot be written out in a shared worktree: it also
 * carries back the paths other actors changed in the same window. Reversal
 * therefore adopts the merge result at the owned paths only, and these cases pin
 * the git plumbing that does it — including the file modes and deletions a naive
 * blob copy would lose.
 */
describe("path-restricted reversal", () => {
	test("reverses only the owned path and leaves a neighbour's change in place", async () => {
		const repo = await createRepo("nf-tree-owned-");
		writeFileSync(join(repo, "mine.txt"), "mine-v1\n");
		writeFileSync(join(repo, "theirs.txt"), "theirs-v1\n");
		const before = await worktreeTreeSnapshot.capture(repo);

		writeFileSync(join(repo, "mine.txt"), "mine-v2\n");
		writeFileSync(join(repo, "theirs.txt"), "theirs-v2\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		const outcome = await worktreeTreeSnapshot.reverseAndRestore(repo, [
			{ before, after, ownedPaths: ["mine.txt"] },
		]);
		expect(outcome.conflicts).toEqual([]);
		expect(outcome.changedFiles).toEqual(["mine.txt"]);
		expect(readFileSync(join(repo, "mine.txt"), "utf8")).toBe("mine-v1\n");
		expect(readFileSync(join(repo, "theirs.txt"), "utf8")).toBe("theirs-v2\n");
	});

	test("preserves the executable bit when adopting a path", async () => {
		const repo = await createRepo("nf-tree-owned-mode-exec-");
		mkdirSync(join(repo, "bin"), { recursive: true });
		writeFileSync(join(repo, "bin/run.sh"), "#!/bin/sh\necho v1\n", { mode: 0o755 });
		const before = await worktreeTreeSnapshot.capture(repo);

		writeFileSync(join(repo, "bin/run.sh"), "#!/bin/sh\necho v2\n", { mode: 0o755 });
		const after = await worktreeTreeSnapshot.capture(repo);

		await worktreeTreeSnapshot.reverseAndRestore(repo, [
			{ before, after, ownedPaths: ["bin/run.sh"] },
		]);
		expect(readFileSync(join(repo, "bin/run.sh"), "utf8")).toContain("echo v1");
		// Asserted on disk, not in git: adopting the blob without its mode would leave a
		// script the shell refuses to run.
		expect(statSync(join(repo, "bin/run.sh")).mode & 0o111).not.toBe(0);
	});

	test("restores a symlink as a link rather than a regular file", async () => {
		const repo = await createRepo("nf-tree-owned-mode-link-");
		writeFileSync(join(repo, "target.txt"), "v1\n");
		await safeSpawn({ cmd: ["ln", "-s", "target.txt", "link"], cwd: repo, timeout: 15_000 });
		const before = await worktreeTreeSnapshot.capture(repo);

		// Replace the symlink with a regular file, then reverse just that path.
		rmSync(join(repo, "link"));
		writeFileSync(join(repo, "link"), "not-a-link\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		await worktreeTreeSnapshot.reverseAndRestore(repo, [{ before, after, ownedPaths: ["link"] }]);
		expect(lstatSync(join(repo, "link")).isSymbolicLink()).toBe(true);
	});

	test("removes an owned path that did not exist at the boundary", async () => {
		const repo = await createRepo("nf-tree-owned-delete-");
		writeFileSync(join(repo, "kept.txt"), "keep\n");
		const before = await worktreeTreeSnapshot.capture(repo);

		writeFileSync(join(repo, "created.txt"), "new\n");
		writeFileSync(join(repo, "kept.txt"), "changed-by-someone-else\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		const outcome = await worktreeTreeSnapshot.reverseAndRestore(repo, [
			{ before, after, ownedPaths: ["created.txt"] },
		]);
		expect(outcome.changedFiles).toEqual(["created.txt"]);
		expect(existsSync(join(repo, "created.txt"))).toBe(false);
		expect(readFileSync(join(repo, "kept.txt"), "utf8")).toBe("changed-by-someone-else\n");
	});

	test("a conflict outside the owned set does not block the reversal", async () => {
		const repo = await createRepo("nf-tree-owned-conflict-");
		writeFileSync(join(repo, "mine.txt"), "mine-v1\n");
		writeFileSync(join(repo, "contested.txt"), "base\n");
		const before = await worktreeTreeSnapshot.capture(repo);

		// Both files move inside the window, and `contested.txt` is then changed again
		// so reversing it would conflict. Since it is not owned, that conflict is not
		// this reversal's business.
		writeFileSync(join(repo, "mine.txt"), "mine-v2\n");
		writeFileSync(join(repo, "contested.txt"), "theirs-first\n");
		const after = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, "contested.txt"), "theirs-second\n");

		const outcome = await worktreeTreeSnapshot.reverseAndRestore(repo, [
			{ before, after, ownedPaths: ["mine.txt"] },
		]);
		expect(outcome.conflicts).toEqual([]);
		expect(readFileSync(join(repo, "mine.txt"), "utf8")).toBe("mine-v1\n");
		expect(readFileSync(join(repo, "contested.txt"), "utf8")).toBe("theirs-second\n");
	});

	test("a conflict inside the owned set aborts the reversal and writes nothing", async () => {
		const repo = await createRepo("nf-tree-owned-conflict-inside-");
		// A multi-line body so the reversal is a real three-way merge rather than a
		// whole-file replacement: overlapping edits to the SAME line are what git
		// cannot resolve, and that is the case this asserts.
		writeFileSync(join(repo, "mine.txt"), "one\ntwo\nthree\n");
		const before = await worktreeTreeSnapshot.capture(repo);

		writeFileSync(join(repo, "mine.txt"), "one\nmine-v2\nthree\n");
		const after = await worktreeTreeSnapshot.capture(repo);
		// Someone else rewrote the very line the reversal has to put back, so undoing
		// this owned path cannot be done without discarding their edit.
		writeFileSync(join(repo, "mine.txt"), "one\ntheirs-v3\nthree\n");

		const outcome = await worktreeTreeSnapshot.reverseAndRestore(repo, [
			{ before, after, ownedPaths: ["mine.txt"] },
		]);
		// The owned path is reported as conflicted — the positive side of the owned
		// filter, which the "conflict outside the owned set" case above cannot cover.
		expect(outcome.conflicts).toEqual(["mine.txt"]);
		expect(outcome.changedFiles).toEqual([]);
		// A conflicted merge tree carries conflict markers, so the worktree must be
		// left exactly as it was found.
		expect(readFileSync(join(repo, "mine.txt"), "utf8")).toBe("one\ntheirs-v3\nthree\n");
	});

	test("an empty owned set changes nothing at all", async () => {
		const repo = await createRepo("nf-tree-owned-empty-");
		writeFileSync(join(repo, "theirs.txt"), "v1\n");
		const before = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, "theirs.txt"), "v2\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		// The read-only-shell case: the boundaries moved, but none of it was ours.
		const outcome = await worktreeTreeSnapshot.reverseAndRestore(repo, [
			{ before, after, ownedPaths: [] },
		]);
		expect(outcome.changedFiles).toEqual([]);
		expect(outcome.mergedTree).toBe(outcome.previousTreeHash);
		expect(readFileSync(join(repo, "theirs.txt"), "utf8")).toBe("v2\n");
	});

	test("a null owned set keeps the legacy whole-tree reversal", async () => {
		const repo = await createRepo("nf-tree-owned-legacy-");
		writeFileSync(join(repo, "a.txt"), "a-v1\n");
		writeFileSync(join(repo, "b.txt"), "b-v1\n");
		const before = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, "a.txt"), "a-v2\n");
		writeFileSync(join(repo, "b.txt"), "b-v2\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		// History recorded before owned sets existed must behave exactly as it did.
		const outcome = await worktreeTreeSnapshot.reverseAndRestore(repo, [
			{ before, after, ownedPaths: null },
		]);
		expect(outcome.changedFiles.sort()).toEqual(["a.txt", "b.txt"]);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a-v1\n");
		expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("b-v1\n");
	});

	test("reverses an owned path that turned from a file into a directory", async () => {
		const repo = await createRepo("nf-tree-owned-transition-");
		writeFileSync(join(repo, "foo"), "was-a-file\n");
		const before = await worktreeTreeSnapshot.capture(repo);

		// The shape that makes path-restricted reversal awkward: the same name is a blob
		// in one tree and a tree in the other, so `ls-tree` needs `-r` to report the
		// nested entry, and the delete step needs to remove a directory where it expected
		// a file.
		rmSync(join(repo, "foo"));
		mkdirSync(join(repo, "foo"), { recursive: true });
		writeFileSync(join(repo, "foo", "x.txt"), "now-a-dir\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		const owned = await worktreeTreeSnapshot.diffPaths(repo, before, after);
		expect(owned.sort()).toEqual(["foo", "foo/x.txt"]);
		const outcome = await worktreeTreeSnapshot.reverseAndRestore(repo, [
			{ before, after, ownedPaths: owned },
		]);
		expect(outcome.conflicts).toEqual([]);
		expect(readFileSync(join(repo, "foo"), "utf8")).toBe("was-a-file\n");
		expect(existsSync(join(repo, "foo", "x.txt"))).toBe(false);
	});

	test("adopts a non-ASCII owned path verbatim", async () => {
		const repo = await createRepo("nf-tree-owned-cjk-");
		const cjk = "文档/说明.md";
		mkdirSync(join(repo, "文档"), { recursive: true });
		writeFileSync(join(repo, cjk), "第一版\n");
		const before = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, cjk), "第二版\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		// `ls-tree` would otherwise return a quoted C-escaped name, which resolves to a
		// path that does not exist — the adopt step would then silently do nothing.
		const outcome = await worktreeTreeSnapshot.reverseAndRestore(repo, [
			{ before, after, ownedPaths: [cjk] },
		]);
		expect(outcome.changedFiles).toEqual([cjk]);
		expect(readFileSync(join(repo, cjk), "utf8")).toBe("第一版\n");
	});
});
