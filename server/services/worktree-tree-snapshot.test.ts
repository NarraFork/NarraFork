import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import iconv from "iconv-lite";
import { db } from "../db";
import { worktreeTreeSnapshots } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { getNarraforkPath } from "../lib/narrafork-home";
import { normalizePathForComparison } from "../lib/platform-path";
import * as spawn from "../lib/spawn";
import { safeSpawn } from "../lib/spawn";
import {
	planTreeRevertSegments,
	resetHotPathCaptureStateForTests,
	TreeRestoreError,
	TreeSnapshotError,
	treeSnapshotKey,
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
/**
 * `diffPathStatuses` — the per-tool-call change feed the file tree patches from.
 *
 * Run against real git rather than a parsed fixture because the risk being covered is
 * a FORMAT assumption: `--name-status -z` emits `STATUS\0PATH\0` pairs, so its field
 * count is doubled relative to the `--name-only` form this was derived from. Mis-pairing
 * shifts every subsequent path onto the wrong status, which mislabels a delete as an add
 * and makes a tree evict the wrong directory — with no error anywhere.
 */
describe("diffPathStatuses", () => {
	test("reports added, modified and deleted paths with their own kinds", async () => {
		const repo = await createRepo("nf-tree-diffstatus-");
		writeFileSync(join(repo, "keep.txt"), "one\n");
		writeFileSync(join(repo, "gone.txt"), "bye\n");
		const before = await worktreeTreeSnapshot.capture(repo);

		writeFileSync(join(repo, "keep.txt"), "two\n");
		rmSync(join(repo, "gone.txt"));
		writeFileSync(join(repo, "fresh.txt"), "new\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		const statuses = await worktreeTreeSnapshot.diffPathStatuses(repo, before, after);
		const byPath = new Map(statuses.map((entry) => [entry.path, entry.kind]));

		expect(byPath.get("fresh.txt")).toBe("added");
		expect(byPath.get("keep.txt")).toBe("updated");
		expect(byPath.get("gone.txt")).toBe("deleted");
		expect(statuses).toHaveLength(3);
	});

	test("agrees with diffPaths on which paths changed", async () => {
		// The two methods must not drift: attribution uses one and the tree feed the
		// other, and a path present in only one would mean the tree shows a state
		// attribution never recorded (or the reverse).
		const repo = await createRepo("nf-tree-diffstatus-agree-");
		writeFileSync(join(repo, "a.txt"), "one\n");
		const before = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, "a.txt"), "two\n");
		writeFileSync(join(repo, "b.txt"), "new\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		const paths = await worktreeTreeSnapshot.diffPaths(repo, before, after);
		const statuses = await worktreeTreeSnapshot.diffPathStatuses(repo, before, after);

		expect(statuses.map((entry) => entry.path).sort()).toEqual([...paths].sort());
	});

	test("handles paths containing spaces without splitting them", async () => {
		// `-z` is what makes this safe; a space-separated format would break here.
		const repo = await createRepo("nf-tree-diffstatus-space-");
		const before = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, "two words.txt"), "x\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		const statuses = await worktreeTreeSnapshot.diffPathStatuses(repo, before, after);

		expect(statuses).toEqual([{ path: "two words.txt", kind: "added" }]);
	});

	test("reports a rename as a delete plus an add", async () => {
		// Rename detection is deliberately not requested, and both directories need
		// re-reading anyway, so the split form is what the tree wants.
		const repo = await createRepo("nf-tree-diffstatus-rename-");
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "old.txt"), "same bytes\n");
		const before = await worktreeTreeSnapshot.capture(repo);

		rmSync(join(repo, "src", "old.txt"));
		writeFileSync(join(repo, "src", "new.txt"), "same bytes\n");
		const after = await worktreeTreeSnapshot.capture(repo);

		const statuses = await worktreeTreeSnapshot.diffPathStatuses(repo, before, after);
		const byPath = new Map(statuses.map((entry) => [entry.path, entry.kind]));

		expect(byPath.get("src/old.txt")).toBe("deleted");
		expect(byPath.get("src/new.txt")).toBe("added");
	});

	test("returns nothing between identical trees", async () => {
		const repo = await createRepo("nf-tree-diffstatus-same-");
		writeFileSync(join(repo, "a.txt"), "one\n");
		const hash = await worktreeTreeSnapshot.capture(repo);

		expect(await worktreeTreeSnapshot.diffPathStatuses(repo, hash, hash)).toEqual([]);
	});
});

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

describe("restore deletion safety", () => {
	async function attemptRestore(
		repo: string,
		tree: string,
		failCheckout: boolean | "after",
	): Promise<unknown> {
		const realSpawn = spawn.safeSpawn;
		let injected = false;
		const failure = failCheckout
			? spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
					if (!injected && opts.cmd.includes(repo) && opts.cmd.includes("checkout-index")) {
						injected = true;
						if (failCheckout === "after") {
							expect((await realSpawn(opts)).exitCode).toBe(0);
						}
						return { stdout: "", stderr: "injected checkout failure", exitCode: 1 };
					}
					return realSpawn(opts);
				})
			: undefined;
		try {
			return await worktreeTreeSnapshot.restore(repo, tree).catch((error: unknown) => error);
		} finally {
			failure?.mockRestore();
			if (failCheckout === "after") expect(injected).toBe(true);
		}
	}

	for (const operation of ["restore", "checkout-failure", "restoreInto"] as const) {
		const failCheckout = operation === "checkout-failure";
		const copy = operation === "restoreInto";
		const suffix = failCheckout ? " with a checkout failure" : copy ? " using restoreInto" : "";
		test(`failed file restore and compensation preserve an ignored-only directory${suffix}`, async () => {
			const repo = await createRepo("nf-tree-safe-ignored-");
			const source = copy ? await createRepo("nf-tree-safe-ignored-src-") : repo;
			writeFileSync(join(source, ".gitignore"), "*.ignore\n");
			writeFileSync(join(source, "a"), "original file\n");
			const target = await worktreeTreeSnapshot.capture(source);
			writeFileSync(join(repo, ".gitignore"), "*.ignore\n");

			if (!copy) rmSync(join(repo, "a"));
			mkdirSync(join(repo, "a"));
			writeFileSync(join(repo, "a", "keep.ignore"), "not in any snapshot\n");
			const beforeRestore = await worktreeTreeSnapshot.capture(repo);
			expect(await worktreeTreeSnapshot.listPaths(repo, beforeRestore)).toEqual([".gitignore"]);

			const error = copy
				? await worktreeTreeSnapshot
						.restoreInto(source, repo, target)
						.catch((error: unknown) => error)
				: await attemptRestore(repo, target, failCheckout);
			// Neither checkout nor compensation may delete contents the tree cannot restore.
			expect(readFileSync(join(repo, "a", "keep.ignore"), "utf8")).toBe("not in any snapshot\n");
			expect(error).toBeInstanceOf(TreeSnapshotError);
			if (!copy) {
				expect(error).toBeInstanceOf(TreeRestoreError);
				expect((error as TreeRestoreError).capturedTreeHash).toBe(beforeRestore);
				expect((error as TreeRestoreError).compensated).toBe(true);
			}
			expect(await worktreeTreeSnapshot.capture(repo)).toBe(beforeRestore);
		});

		test(`failed file restore cannot delete an ancestor of a nested repository${suffix}`, async () => {
			const repo = await createRepo("nf-tree-safe-nested-");
			const source = copy ? await createRepo("nf-tree-safe-nested-src-") : repo;
			writeFileSync(join(source, "a"), "original file\n");
			const target = await worktreeTreeSnapshot.capture(source);
			if (!copy) rmSync(join(repo, "a"));
			const nested = join(repo, "a", "sub");
			mkdirSync(nested, { recursive: true });
			for (const args of [
				["init"],
				["config", "user.email", "test@example.com"],
				["config", "user.name", "Test"],
			]) {
				expect(
					(await safeSpawn({ cmd: ["git", ...args], cwd: nested, timeout: 15_000 })).exitCode,
				).toBe(0);
			}
			writeFileSync(join(nested, "committed.txt"), "committed\n");
			expect(
				(await safeSpawn({ cmd: ["git", "add", "-A"], cwd: nested, timeout: 15_000 })).exitCode,
			).toBe(0);
			expect(
				(await safeSpawn({ cmd: ["git", "commit", "-m", "seed"], cwd: nested, timeout: 15_000 }))
					.exitCode,
			).toBe(0);
			writeFileSync(join(nested, "valuable"), "uncommitted and irreplaceable\n");
			const beforeRestore = await worktreeTreeSnapshot.capture(repo);
			expect(await worktreeTreeSnapshot.listPaths(repo, beforeRestore)).toContain("a/sub");

			const error = copy
				? await worktreeTreeSnapshot
						.restoreInto(source, repo, target)
						.catch((error: unknown) => error)
				: await attemptRestore(repo, target, failCheckout);
			expect(readFileSync(join(nested, "valuable"), "utf8")).toBe(
				"uncommitted and irreplaceable\n",
			);
			expect(error).toBeInstanceOf(TreeSnapshotError);
			expect(readFileSync(join(nested, "committed.txt"), "utf8")).toBe("committed\n");
			expect(lstatSync(join(nested, ".git")).isDirectory()).toBe(true);
			if (!copy) {
				expect(error).toBeInstanceOf(TreeRestoreError);
				expect((error as TreeRestoreError).compensated).toBe(true);
			}
			expect(await worktreeTreeSnapshot.capture(repo)).toBe(beforeRestore);
		});
	}

	test("deleting a tracked child leaves its ignored sibling and parent directory intact", async () => {
		const repo = await createRepo("nf-tree-safe-ignored-sibling-");
		writeFileSync(join(repo, ".gitignore"), "*.ignore\n");
		const target = await worktreeTreeSnapshot.capture(repo);
		mkdirSync(join(repo, "a"));
		writeFileSync(join(repo, "a", "created.txt"), "remove only this\n");
		writeFileSync(join(repo, "a", "keep.ignore"), "keep the directory for me\n");

		expect(await worktreeTreeSnapshot.restore(repo, target)).toEqual(["a/created.txt"]);
		expect(readFileSync(join(repo, "a", "keep.ignore"), "utf8")).toBe(
			"keep the directory for me\n",
		);
		expect(existsSync(join(repo, "a", "created.txt"))).toBe(false);
	});

	for (const linkTarget of ["dangling", "repository"] as const) {
		test(`compensation unlinks a newly checked-out ${linkTarget} symlink`, async () => {
			const repo = await createRepo("nf-tree-safe-compensate-link-");
			const external = await createRepo("nf-tree-safe-compensate-target-");
			writeFileSync(join(external, "valuable"), "untouched\n");
			const beforeRestore = await worktreeTreeSnapshot.capture(repo);
			symlinkSync(
				linkTarget === "dangling" ? "missing" : external,
				join(repo, "link"),
				linkTarget === "dangling" ? "file" : "dir",
			);
			const target = await worktreeTreeSnapshot.capture(repo);
			rmSync(join(repo, "link"));

			const error = await attemptRestore(repo, target, "after");
			expect(error).toBeInstanceOf(TreeRestoreError);
			expect((error as TreeRestoreError).compensated).toBe(true);
			expect(() => lstatSync(join(repo, "link"))).toThrow();
			expect(readFileSync(join(external, "valuable"), "utf8")).toBe("untouched\n");
			expect(await worktreeTreeSnapshot.capture(repo)).toBe(beforeRestore);
		});
	}

	for (const targetIsFile of [false, true]) {
		test(`compensates a checked-out ${targetIsFile ? "directory-to-file" : "file-to-directory"} transition`, async () => {
			const repo = await createRepo("nf-tree-safe-compensate-shape-");
			writeFileSync(join(repo, "a"), "file\n");
			const fileTree = await worktreeTreeSnapshot.capture(repo);
			rmSync(join(repo, "a"));
			mkdirSync(join(repo, "a", "sub"), { recursive: true });
			writeFileSync(join(repo, "a", "sub", "file.bin"), Buffer.from([0, 255, 128]));
			const dirTree = await worktreeTreeSnapshot.capture(repo);
			if (!targetIsFile) await worktreeTreeSnapshot.restore(repo, fileTree);

			const error = await attemptRestore(repo, targetIsFile ? fileTree : dirTree, "after");
			expect(error).toBeInstanceOf(TreeRestoreError);
			expect((error as TreeRestoreError).compensated).toBe(true);
			expect(await worktreeTreeSnapshot.capture(repo)).toBe(targetIsFile ? dirTree : fileTree);
			if (targetIsFile) {
				expect(readFileSync(join(repo, "a", "sub", "file.bin"))).toEqual(
					Buffer.from([0, 255, 128]),
				);
			} else expect(readFileSync(join(repo, "a"), "utf8")).toBe("file\n");
		});
	}

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"an EACCES discovered after capture is not treated as an absent deletion path",
		async () => {
			const repo = await createRepo("nf-tree-safe-lstat-error-");
			const target = await worktreeTreeSnapshot.capture(repo);
			const locked = join(repo, "locked");
			mkdirSync(locked);
			writeFileSync(join(locked, "valuable"), "must survive\n");
			const realSpawn = spawn.safeSpawn;
			let lockedAfterCapture = false;
			const failure = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
				const result = await realSpawn(opts);
				if (!lockedAfterCapture && opts.cmd.includes(repo) && opts.cmd.includes("ls-tree")) {
					lockedAfterCapture = true;
					chmodSync(locked, 0o000);
				}
				return result;
			});
			try {
				await expect(worktreeTreeSnapshot.restore(repo, target)).rejects.toBeInstanceOf(
					TreeRestoreError,
				);
				expect(lockedAfterCapture).toBe(true);
			} finally {
				chmodSync(locked, 0o700);
				failure.mockRestore();
			}
			expect(readFileSync(join(locked, "valuable"), "utf8")).toBe("must survive\n");
		},
	);

	for (const copy of [false, true]) {
		const operation = copy ? "restoreInto" : "restore";
		test(`${operation} rejects a nonempty directory that appears just before checkout`, async () => {
			const repo = await createRepo("nf-tree-safe-late-directory-");
			const source = copy ? await createRepo("nf-tree-safe-late-directory-src-") : repo;
			writeFileSync(join(source, ".gitignore"), "*.ignore\n");
			writeFileSync(join(source, "a"), "target\n");
			const target = await worktreeTreeSnapshot.capture(source);
			writeFileSync(join(repo, ".gitignore"), "*.ignore\n");
			writeFileSync(join(repo, "a"), "current\n");
			const realSpawn = spawn.safeSpawn;
			let inserted = false;
			const race = spyOn(spawn, "safeSpawn").mockImplementation((opts) => {
				if (!inserted && opts.cmd.includes(repo) && opts.cmd.includes("checkout-index")) {
					inserted = true;
					// A concurrent writer wins after preparation. Force checkout would
					// silently delete this unsnapshotted subtree, despite earlier lstat.
					rmSync(join(repo, "a"), { force: true });
					mkdirSync(join(repo, "a"));
					writeFileSync(join(repo, "a", "keep.ignore"), "arrived after preparation\n");
				}
				return realSpawn(opts);
			});
			try {
				const apply = copy
					? worktreeTreeSnapshot.restoreInto(source, repo, target)
					: worktreeTreeSnapshot.restore(repo, target);
				await expect(apply).rejects.toBeInstanceOf(TreeSnapshotError);
				expect(inserted).toBe(true);
			} finally {
				race.mockRestore();
			}
			expect(readFileSync(join(repo, "a", "keep.ignore"), "utf8")).toBe(
				"arrived after preparation\n",
			);
		});

		test(`${operation} never follows a newly substituted symlink ancestor when deleting`, async () => {
			const repo = await createRepo("nf-tree-safe-link-ancestor-");
			const source = copy ? await createRepo("nf-tree-safe-link-ancestor-src-") : repo;
			const external = await createRepo("nf-tree-safe-link-ancestor-target-");
			writeFileSync(join(external, "valuable"), "external bytes\n");
			const target = await worktreeTreeSnapshot.capture(source);
			mkdirSync(join(repo, "a"));
			writeFileSync(join(repo, "a", "valuable"), "captured bytes\n");
			const realSpawn = spawn.safeSpawn;
			let substituted = false;
			const race = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
				const result = await realSpawn(opts);
				if (!substituted && opts.cmd.includes(repo) && opts.cmd.includes("ls-tree")) {
					substituted = true;
					renameSync(join(repo, "a"), join(external, "original-a"));
					symlinkSync(external, join(repo, "a"), "dir");
				}
				return result;
			});
			try {
				const apply = copy
					? worktreeTreeSnapshot.restoreInto(source, repo, target)
					: worktreeTreeSnapshot.restore(repo, target);
				await expect(apply).rejects.toBeInstanceOf(TreeSnapshotError);
				expect(substituted).toBe(true);
			} finally {
				race.mockRestore();
			}
			expect(readFileSync(join(external, "valuable"), "utf8")).toBe("external bytes\n");
			expect(readFileSync(join(external, "original-a", "valuable"), "utf8")).toBe(
				"captured bytes\n",
			);
		});

		test(`${operation} removes a dangling symlink absent from the target`, async () => {
			const repo = await createRepo("nf-tree-safe-dangling-");
			const source = copy ? await createRepo("nf-tree-safe-dangling-src-") : repo;
			const target = await worktreeTreeSnapshot.capture(source);
			symlinkSync("missing-target", join(repo, "link"));
			expect(lstatSync(join(repo, "link")).isSymbolicLink()).toBe(true);

			if (copy) await worktreeTreeSnapshot.restoreInto(source, repo, target);
			else await worktreeTreeSnapshot.restore(repo, target);

			expect(() => lstatSync(join(repo, "link"))).toThrow();
			expect(await worktreeTreeSnapshot.capture(repo)).toBe(target);
		});

		test(`${operation} unlinks a link to a repository without touching its target`, async () => {
			const repo = await createRepo("nf-tree-safe-link-");
			const source = copy ? await createRepo("nf-tree-safe-link-src-") : repo;
			const external = await createRepo("nf-tree-safe-link-target-");
			writeFileSync(join(external, "valuable"), "outside snapshot authority\n");
			const target = await worktreeTreeSnapshot.capture(source);
			symlinkSync(external, join(repo, "link"), "dir");

			if (copy) await worktreeTreeSnapshot.restoreInto(source, repo, target);
			else await worktreeTreeSnapshot.restore(repo, target);

			expect(() => lstatSync(join(repo, "link"))).toThrow();
			expect(readFileSync(join(external, "valuable"), "utf8")).toBe("outside snapshot authority\n");
			expect(lstatSync(join(external, ".git")).isDirectory()).toBe(true);
		});

		test(`${operation} round-trips a file and a deep directory without recursive deletion`, async () => {
			const source = await createRepo("nf-tree-safe-shape-src-");
			writeFileSync(join(source, "a"), "file bytes\n");
			const fileTree = await worktreeTreeSnapshot.capture(source);
			rmSync(join(source, "a"));
			mkdirSync(join(source, "a", "sub", "deep"), { recursive: true });
			writeFileSync(join(source, "a", "sub", "deep", "file.bin"), Buffer.from([0, 255, 128]));
			const dirTree = await worktreeTreeSnapshot.capture(source);
			const repo = copy ? await createRepo("nf-tree-safe-shape-dst-") : source;
			for (const tree of [fileTree, dirTree, fileTree]) {
				if (copy) await worktreeTreeSnapshot.restoreInto(source, repo, tree);
				else await worktreeTreeSnapshot.restore(repo, tree);
				expect(await worktreeTreeSnapshot.capture(repo)).toBe(tree);
				if (tree === fileTree) expect(readFileSync(join(repo, "a"), "utf8")).toBe("file bytes\n");
				else
					expect(readFileSync(join(repo, "a", "sub", "deep", "file.bin"))).toEqual(
						Buffer.from([0, 255, 128]),
					);
			}
		});
	}
});

describe("planTreeRevertSegments", () => {
	test("preserves each pair even when adjacent workspace hashes match", () => {
		// Hash continuity says nothing about who owned each path inside the windows.
		expect(
			planTreeRevertSegments([
				{ before: "a", after: "b" },
				{ before: "b", after: "c" },
				{ before: "x", after: "y" },
			]),
		).toEqual([
			{ before: "a", after: "b", ownedPaths: null },
			{ before: "b", after: "c", ownedPaths: null },
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

	test("keeps owned paths scoped to the individual pair", () => {
		expect(
			planTreeRevertSegments([
				{ before: "a", after: "b", ownedPaths: ["one.txt"] },
				{ before: "b", after: "c", ownedPaths: ["two.txt", "one.txt"] },
			]),
		).toEqual([
			{ before: "a", after: "b", ownedPaths: ["one.txt"] },
			{ before: "b", after: "c", ownedPaths: ["two.txt", "one.txt"] },
		]);
	});

	test("an unknown range never widens the neighbouring known range", () => {
		expect(
			planTreeRevertSegments([
				{ before: "a", after: "b", ownedPaths: ["one.txt"] },
				{ before: "b", after: "c", ownedPaths: null },
			]),
		).toEqual([
			{ before: "a", after: "b", ownedPaths: ["one.txt"] },
			{ before: "b", after: "c", ownedPaths: null },
		]);
	});

	test("reverses owned b only to its own before, preserving the foreign write in pair one", async () => {
		const repo = await createRepo("nf-tree-owned-boundaries-");
		writeFileSync(join(repo, "a.txt"), "a-original\n");
		writeFileSync(join(repo, "b.txt"), "b-original\n");
		const firstBefore = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, "a.txt"), "a-mine\n");
		writeFileSync(join(repo, "b.txt"), "b-human\n");
		const firstAfter = await worktreeTreeSnapshot.capture(repo);
		const secondBefore = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, "b.txt"), "b-mine\n");
		const secondAfter = await worktreeTreeSnapshot.capture(repo);
		expect(secondBefore).toBe(firstAfter);

		const reversed = await worktreeTreeSnapshot.reverseAndRestore(repo, [
			{ before: firstBefore, after: firstAfter, ownedPaths: ["a.txt"] },
			{ before: secondBefore, after: secondAfter, ownedPaths: ["b.txt"] },
		]);
		expect(reversed.conflicts).toEqual([]);
		expect(reversed.changedFiles.sort()).toEqual(["a.txt", "b.txt"]);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a-original\n");
		expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("b-human\n");
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

/**
 * The root chapter's workspace *is* the project's git root, and every other chapter's
 * worktree lives under `<root>/.worktrees/`. So a capture of the root workspace walks
 * into other chapters' live directories, and a rollback that predates one of them
 * deletes it — uncommitted work included.
 */
describe("nested chapter worktrees", () => {
	test("a child worktree never enters the parent's snapshot", async () => {
		const { main } = await createLinkedWorktree("nf-tree-nested-capture-");
		snapshotPaths.push(normalizePathForComparison(main));
		writeFileSync(join(main, "root.txt"), "root\n");

		const tree = await worktreeTreeSnapshot.capture(main);
		const paths = await worktreeTreeSnapshot.listPaths(main, tree);

		// The child enters as a `160000 commit` gitlink when not excluded, which is what
		// makes the whole child directory a single deletable path in the tree.
		expect(paths).toContain("root.txt");
		expect(paths.some((path) => path.startsWith(".worktrees"))).toBe(false);
	});

	test("rolling the parent back to before a child existed leaves the child alone", async () => {
		// Main repo first, captured before any child exists — the exact history that made
		// the child's path absent from the rollback target.
		const main = await createRepo("nf-tree-nested-revert-main-");
		writeFileSync(join(main, "seed.txt"), "seed\n");
		await safeSpawn({ cmd: ["git", "add", "-A"], cwd: main, timeout: 15_000 });
		await safeSpawn({ cmd: ["git", "commit", "-m", "seed"], cwd: main, timeout: 15_000 });
		const beforeChild = await worktreeTreeSnapshot.capture(main);

		const child = join(main, ".worktrees", "chapter");
		const added = await safeSpawn({
			cmd: ["git", "worktree", "add", child, "-b", "chapter"],
			cwd: main,
			timeout: 15_000,
		});
		expect(added.exitCode).toBe(0);
		// Uncommitted, so nothing but this module's snapshots could bring it back.
		writeFileSync(join(child, "precious.txt"), "hours of unsaved work\n");
		writeFileSync(join(main, "seed.txt"), "edited\n");

		await worktreeTreeSnapshot.restore(main, beforeChild);

		expect(readFileSync(join(main, "seed.txt"), "utf8")).toBe("seed\n");
		expect(existsSync(child)).toBe(true);
		expect(readFileSync(join(child, "precious.txt"), "utf8")).toBe("hours of unsaved work\n");
	});

	test("refuses to delete a nested repository recorded by an older snapshot", async () => {
		const repo = await createRepo("nf-tree-nested-guard-");
		writeFileSync(join(repo, "a.txt"), "one\n");
		const before = await worktreeTreeSnapshot.capture(repo);

		// A plain nested repository rather than a `.worktrees/` child, so the exclude rule
		// does not cover it and the deletion guard is what is under test. It needs a commit
		// to become a `160000` gitlink — an uncommitted nested repo is refused by `add`
		// instead and never enters the tree at all.
		const nested = join(repo, "vendor", "lib");
		mkdirSync(nested, { recursive: true });
		await safeSpawn({ cmd: ["git", "init"], cwd: nested, timeout: 15_000 });
		await safeSpawn({ cmd: ["git", "config", "user.email", "t@example.com"], cwd: nested });
		await safeSpawn({ cmd: ["git", "config", "user.name", "T"], cwd: nested });
		writeFileSync(join(nested, "committed.txt"), "vendored\n");
		await safeSpawn({ cmd: ["git", "add", "-A"], cwd: nested, timeout: 15_000 });
		await safeSpawn({ cmd: ["git", "commit", "-m", "vendor"], cwd: nested, timeout: 15_000 });
		writeFileSync(join(nested, "unsaved.txt"), "someone else's work\n");

		const withNested = await worktreeTreeSnapshot.capture(repo);
		// The gitlink makes the entire nested directory one path in the tree, and it is
		// absent from `before` — so the delete loop is handed the whole repository.
		expect(await worktreeTreeSnapshot.diffPaths(repo, before, withNested)).toContain("vendor/lib");

		await worktreeTreeSnapshot.restore(repo, before).catch(() => {});
		expect(readFileSync(join(nested, "unsaved.txt"), "utf8")).toBe("someone else's work\n");
		expect(readFileSync(join(nested, "committed.txt"), "utf8")).toBe("vendored\n");
	});
});

/**
 * The module's central promise is that a snapshot is the bytes on disk. git's line
 * ending translation breaks it in the worst possible way: the restored file has
 * different bytes, but re-hashing yields the *same* tree, so the engine's own
 * consistency check reports a perfect restore.
 */
describe("byte exactness against git content filters", () => {
	test("a CRLF file round-trips exactly under '* text=auto'", async () => {
		const repo = await createRepo("nf-tree-crlf-");
		// The user's own `.gitattributes` applies to shadow-repo commands, because they
		// run with `--work-tree` pointed at this directory.
		writeFileSync(join(repo, ".gitattributes"), "* text=auto\n");
		const crlf = Buffer.from("first\r\nsecond\r\n", "binary");
		const lf = Buffer.from("first\nsecond\n", "binary");
		writeFileSync(join(repo, "crlf.txt"), crlf);
		writeFileSync(join(repo, "lf.txt"), lf);

		const before = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, "crlf.txt"), Buffer.from("changed\r\n", "binary"));
		writeFileSync(join(repo, "lf.txt"), Buffer.from("changed\n", "binary"));
		await worktreeTreeSnapshot.capture(repo);
		await worktreeTreeSnapshot.restore(repo, before);

		// Compared as bytes, deliberately. A text comparison passes even when every line
		// ending was rewritten, which is the whole failure mode.
		expect(readFileSync(join(repo, "crlf.txt")).equals(crlf)).toBe(true);
		expect(readFileSync(join(repo, "lf.txt")).equals(lf)).toBe(true);
	});

	test("the ident attribute cannot rewrite a restored file's contents", async () => {
		const repo = await createRepo("nf-tree-ident-");
		// `ident` needs no config to take effect, which makes it the cheapest proof that
		// the worktree's own `.gitattributes` is being overridden rather than obeyed. A
		// `filter=` attribute is the same mechanism with a config dependency attached.
		writeFileSync(join(repo, ".gitattributes"), "* ident\n");
		writeFileSync(join(repo, "f.txt"), "ver: $Id$\n");

		const before = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, "f.txt"), "overwritten\n");
		await worktreeTreeSnapshot.capture(repo);
		await worktreeTreeSnapshot.restore(repo, before);

		// Without the override the restored file reads `$Id: <sha> $` — content the user
		// never wrote, produced by a rollback that reported success.
		expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("ver: $Id$\n");
	});

	test("a working-tree-encoding attribute does not fail the capture", async () => {
		const repo = await createRepo("nf-tree-wt-encoding-");
		// The dangerous shape is a file git cannot transcode: `add -A` then exits 128 and
		// the capture fails outright, so the attribute did not corrupt snapshots — it made
		// them impossible for the whole workspace, silently, via `tryCapture`'s null.
		// A UTF-8 BOM under a UTF-16LE declaration is exactly that case.
		writeFileSync(join(repo, ".gitattributes"), "*.txt working-tree-encoding=UTF-16LE\n");
		const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\n")]);
		writeFileSync(join(repo, "bom.txt"), bom);

		const before = await worktreeTreeSnapshot.capture(repo);
		expect(await worktreeTreeSnapshot.listPaths(repo, before)).toContain("bom.txt");

		writeFileSync(join(repo, "bom.txt"), Buffer.from("replaced\n"));
		await worktreeTreeSnapshot.capture(repo);
		await worktreeTreeSnapshot.restore(repo, before);
		expect(readFileSync(join(repo, "bom.txt")).equals(bom)).toBe(true);
	});
});

/**
 * A file the real repository tracks despite an ignore rule (`git add -f .env`) was
 * absent from every snapshot. Both boundary hashes then came out identical, the revert
 * planner read that as "this call changed nothing", and the modification was lost with
 * no warning anywhere.
 */
describe("tracked-but-ignored files", () => {
	/** Track a file the ignore rules cover — the shape `git add -f` produces. */
	async function forceTrack(repo: string, relPath: string): Promise<void> {
		const added = await safeSpawn({
			cmd: ["git", "add", "-f", relPath],
			cwd: repo,
			timeout: 15_000,
		});
		if (added.exitCode !== 0) throw new Error(`git add -f failed: ${added.stderr}`);
		await safeSpawn({ cmd: ["git", "commit", "-m", "track"], cwd: repo, timeout: 15_000 });
	}

	test("captures a file git tracks despite an ignore rule", async () => {
		const repo = await createRepo("nf-tree-tracked-ignored-");
		writeFileSync(join(repo, ".gitignore"), ".env\nbuild/\n");
		writeFileSync(join(repo, ".env"), "SECRET=1\n");
		mkdirSync(join(repo, "build"), { recursive: true });
		writeFileSync(join(repo, "build", "out.o"), "artifact\n");
		await forceTrack(repo, ".env");

		const tree = await worktreeTreeSnapshot.capture(repo);
		const paths = await worktreeTreeSnapshot.listPaths(repo, tree);
		expect(paths).toContain(".env");
		// The rest of the ignore rules must still hold, or this fix would be the older
		// bug where build output entered snapshots and rollbacks deleted ignored files.
		expect(paths.some((path) => path.startsWith("build/"))).toBe(false);
	});

	test("a change to a tracked-but-ignored file moves the boundary and reverts", async () => {
		const repo = await createRepo("nf-tree-tracked-ignored-revert-");
		writeFileSync(join(repo, ".gitignore"), ".env\n");
		writeFileSync(join(repo, ".env"), "SECRET=original\n");
		await forceTrack(repo, ".env");

		const before = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, ".env"), "SECRET=overwritten\n");
		const after = await worktreeTreeSnapshot.capture(repo);
		// The precise failure: identical hashes made `planTreeRevertSegments` drop the
		// segment as a no-op, so the rollback silently skipped it.
		expect(after).not.toBe(before);

		const outcome = await worktreeTreeSnapshot.reverseAndRestore(repo, [
			{ before, after, ownedPaths: [".env"] },
		]);
		expect(outcome.conflicts).toEqual([]);
		expect(readFileSync(join(repo, ".env"), "utf8")).toBe("SECRET=original\n");
	});

	test("a file force-tracked after the first capture is still picked up", async () => {
		const repo = await createRepo("nf-tree-tracked-ignored-cache-");
		writeFileSync(join(repo, ".gitignore"), ".env\n");
		writeFileSync(join(repo, "a.txt"), "one\n");
		await safeSpawn({ cmd: ["git", "add", "-A"], cwd: repo, timeout: 15_000 });
		await safeSpawn({ cmd: ["git", "commit", "-m", "seed"], cwd: repo, timeout: 15_000 });
		// First capture memoizes "no tracked-but-ignored paths" — the state the cache has
		// to be able to leave behind when the user changes their mind.
		await worktreeTreeSnapshot.capture(repo);

		writeFileSync(join(repo, ".env"), "SECRET=late\n");
		await forceTrack(repo, ".env");

		// `git add -f` rewrites the real index, which is what the cache keys on, so the
		// memo must invalidate rather than pin the earlier empty answer forever.
		const tree = await worktreeTreeSnapshot.capture(repo);
		expect(await worktreeTreeSnapshot.listPaths(repo, tree)).toContain(".env");
	});

	test("a restore does not make the next capture drop the force-added path", async () => {
		// The cache's other invalidation event, and the one it originally missed. The memo
		// records "the force-add has already introduced this entry", but the entry lives in
		// the *shadow* index and `read-tree` evicts it — while leaving the real index, which
		// the cache keys on, untouched. So the key still matched, the query short-circuited
		// to `[]`, and the plain `add -A` silently dropped `.env` again.
		//
		// The consequence is worse than a missing path: the post-restore capture comes back
		// *equal to the pre-`add -f` tree*, so the boundary pair reads as "nothing changed"
		// and the revert planner skips the segment. The edit is unrevertable with no warning
		// anywhere, which is why this asserts on the tree hashes and not only on the listing.
		const repo = await createRepo("nf-tree-tracked-ignored-readtree-");
		writeFileSync(join(repo, ".gitignore"), ".env\n");
		writeFileSync(join(repo, "a.txt"), "one\n");
		await safeSpawn({ cmd: ["git", "add", "-A"], cwd: repo, timeout: 15_000 });
		await safeSpawn({ cmd: ["git", "commit", "-m", "seed"], cwd: repo, timeout: 15_000 });
		// Memoizes "no tracked-but-ignored paths" for the pre-`add -f` index.
		const withoutEnv = await worktreeTreeSnapshot.capture(repo);

		writeFileSync(join(repo, ".env"), "SECRET=1\n");
		await forceTrack(repo, ".env");
		const withEnv = await worktreeTreeSnapshot.capture(repo);
		expect(await worktreeTreeSnapshot.listPaths(repo, withEnv)).toContain(".env");

		// `read-tree` of a tree that predates `.env` is what evicts the shadow index entry.
		await worktreeTreeSnapshot.restore(repo, withoutEnv);
		writeFileSync(join(repo, ".env"), "SECRET=after-restore\n");
		const afterRestore = await worktreeTreeSnapshot.capture(repo);

		expect(await worktreeTreeSnapshot.listPaths(repo, afterRestore)).toContain(".env");
		// The silent-loss shape: identical to the tree captured before `.env` was ever
		// tracked, so no boundary distinguishes the edit.
		expect(afterRestore).not.toBe(withoutEnv);
		expect(await worktreeTreeSnapshot.readFileAtTree(repo, afterRestore, ".env")).toBe(
			"SECRET=after-restore\n",
		);
	});

	test("deleting a tracked-but-ignored file is recorded", async () => {
		const repo = await createRepo("nf-tree-tracked-ignored-delete-");
		writeFileSync(join(repo, ".gitignore"), ".env\n");
		writeFileSync(join(repo, ".env"), "SECRET=1\n");
		await forceTrack(repo, ".env");

		const before = await worktreeTreeSnapshot.capture(repo);
		rmSync(join(repo, ".env"));
		const after = await worktreeTreeSnapshot.capture(repo);
		// The force-add only introduces the index entry; once present, a plain `add -A`
		// records its removal, which is why no extra handling is needed for deletions.
		expect(await worktreeTreeSnapshot.listPaths(repo, after)).not.toContain(".env");

		await worktreeTreeSnapshot.restore(repo, before);
		expect(readFileSync(join(repo, ".env"), "utf8")).toBe("SECRET=1\n");
	});
});

/**
 * git only removes its own `index.lock` for signals it can handle. After a `SIGKILL`
 * or an OOM kill the lock survives, every later `add -A` in that shadow repo exits
 * 128, and `tryCapture` swallows it into null — so the workspace silently and
 * permanently loses precise reverts.
 */
describe("stale index.lock recovery", () => {
	/**
	 * The shadow repo directory for a workspace, derived the same way the module does.
	 *
	 * `getNarraforkPath` rather than a hardcoded `~/.narrafork`, because the test preload
	 * redirects `NARRAFORK_HOME` to an isolated directory.
	 */
	function shadowDirFor(worktreePath: string): string {
		const digest = createHash("sha256")
			.update(treeSnapshotKey("local", worktreePath))
			.digest("hex");
		return getNarraforkPath("tree-snapshots", digest.slice(0, 32));
	}

	test("reclaims a lock left behind by a killed git process", async () => {
		const repo = await createRepo("nf-tree-stale-lock-");
		writeFileSync(join(repo, "a.txt"), "one\n");
		await worktreeTreeSnapshot.capture(repo);

		// Backdated past the reclaim threshold: age is what distinguishes an abandoned
		// lock from one a live git is legitimately still holding.
		const lockPath = join(shadowDirFor(repo), "index.lock");
		writeFileSync(lockPath, "");
		const longAgo = new Date(Date.now() - 10 * 60_000);
		utimesSync(lockPath, longAgo, longAgo);

		writeFileSync(join(repo, "a.txt"), "two\n");
		const recovered = await worktreeTreeSnapshot.capture(repo);
		expect(recovered).toMatch(/^[0-9a-f]{40}$/);
		expect(existsSync(lockPath)).toBe(false);
	});

	test("leaves a fresh lock alone, so a live git is never corrupted", async () => {
		const repo = await createRepo("nf-tree-fresh-lock-");
		writeFileSync(join(repo, "a.txt"), "one\n");
		await worktreeTreeSnapshot.capture(repo);

		const lockPath = join(shadowDirFor(repo), "index.lock");
		writeFileSync(lockPath, "");
		try {
			writeFileSync(join(repo, "a.txt"), "two\n");
			// Failing is the correct outcome here: the boundary is recorded as absent and
			// the next capture retries, whereas deleting a live lock destroys an index write.
			expect(await worktreeTreeSnapshot.tryCapture(repo)).toBeNull();
			expect(existsSync(lockPath)).toBe(true);
		} finally {
			rmSync(lockPath, { force: true });
		}
	});
});

/** Unknown paths must never become absent entries in a restorable snapshot. */
describe("incomplete captures", () => {
	const cannotEnforceUnreadable = process.platform === "win32" || process.getuid?.() === 0;

	test.skipIf(cannotEnforceUnreadable)(
		"first unreadable capture produces no deletion baseline when the file later becomes readable",
		async () => {
			const repo = await createRepo("nf-tree-unreadable-");
			writeFileSync(join(repo, "readable.txt"), "kept\n");
			writeFileSync(join(repo, "locked.txt"), "must survive\n");
			chmodSync(join(repo, "locked.txt"), 0o000);
			try {
				await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow("snapshot add failed");
				expect(await worktreeTreeSnapshot.tryCapture(repo)).toBeNull();
				const rows = await db.query.worktreeTreeSnapshots.findMany({
					where: eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(repo)),
				});
				expect(rows).toEqual([]);
			} finally {
				chmodSync(join(repo, "locked.txt"), 0o600);
			}

			// No cache reset: the first usable baseline must include the now-readable
			// file. The old --ignore-errors fallback had published an earlier tree
			// without it, and restoring that tree would silently delete this file.
			const complete = await worktreeTreeSnapshot.capture(repo);
			expect(await worktreeTreeSnapshot.listPaths(repo, complete)).toContain("locked.txt");
			writeFileSync(join(repo, "readable.txt"), "changed\n");
			expect(await worktreeTreeSnapshot.restore(repo, complete)).toEqual(["readable.txt"]);
			expect(readFileSync(join(repo, "locked.txt"), "utf8")).toBe("must survive\n");
		},
	);

	test.skipIf(cannotEnforceUnreadable)(
		"an unreadable current snapshot aborts restore before writing or deleting anything",
		async () => {
			const repo = await createRepo("nf-tree-restore-unreadable-");
			writeFileSync(join(repo, "readable.txt"), "baseline\n");
			const target = await worktreeTreeSnapshot.capture(repo);
			writeFileSync(join(repo, "readable.txt"), "must not be reverted\n");
			writeFileSync(join(repo, "locked.txt"), "must not be deleted\n");
			chmodSync(join(repo, "locked.txt"), 0o000);
			try {
				await expect(worktreeTreeSnapshot.restore(repo, target)).rejects.toThrow(
					"restore add failed",
				);
				expect(readFileSync(join(repo, "readable.txt"), "utf8")).toBe("must not be reverted\n");
				expect(existsSync(join(repo, "locked.txt"))).toBe(true);
			} finally {
				chmodSync(join(repo, "locked.txt"), 0o600);
			}
			expect(readFileSync(join(repo, "locked.txt"), "utf8")).toBe("must not be deleted\n");
		},
	);

	test.skipIf(cannotEnforceUnreadable)(
		"a directory skipped with git exit zero still makes capture and restore unavailable",
		async () => {
			const repo = await createRepo("nf-tree-unreadable-directory-");
			writeFileSync(join(repo, "a.txt"), "baseline\n");
			const target = await worktreeTreeSnapshot.capture(repo);
			writeFileSync(join(repo, "a.txt"), "preserve current\n");
			const locked = join(repo, "locked");
			mkdirSync(locked);
			writeFileSync(join(locked, "secret.txt"), "preserve unseen\n");
			chmodSync(locked, 0o000);
			try {
				await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow("coverage is incomplete");
				await expect(worktreeTreeSnapshot.restore(repo, target)).rejects.toThrow(
					"coverage is incomplete",
				);
				expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("preserve current\n");
			} finally {
				chmodSync(locked, 0o700);
			}
			expect(readFileSync(join(locked, "secret.txt"), "utf8")).toBe("preserve unseen\n");
		},
	);

	test("force-add failure is fatal and its tentative memo cannot hide a later retry", async () => {
		const repo = await createRepo("nf-tree-force-failure-");
		writeFileSync(join(repo, ".gitignore"), ".env\n");
		writeFileSync(join(repo, ".env"), "SECRET=preserve\n");
		await safeSpawn({ cmd: ["git", "add", "-f", ".env"], cwd: repo, timeout: 15_000 });
		const realSpawn = spawn.safeSpawn;
		const failed = spyOn(spawn, "safeSpawn").mockImplementation((opts) => {
			if (opts.cmd.includes(repo) && opts.cmd.includes("--force")) {
				return Promise.resolve({ stdout: "", stderr: "unreadable forced path", exitCode: 1 });
			}
			return realSpawn(opts);
		});
		try {
			await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow("snapshot add failed");
		} finally {
			failed.mockRestore();
		}
		const tree = await worktreeTreeSnapshot.capture(repo);
		expect(await worktreeTreeSnapshot.listPaths(repo, tree)).toContain(".env");
		expect(readFileSync(join(repo, ".env"), "utf8")).toBe("SECRET=preserve\n");
	});

	for (const flag of ["stdoutTruncated", "stderrTruncated"] as const) {
		test(`${flag} cannot turn capture or restore into a complete success`, async () => {
			const repo = await createRepo("nf-tree-output-limit-");
			writeFileSync(join(repo, "a.txt"), "baseline\n");
			const target = await worktreeTreeSnapshot.capture(repo);
			writeFileSync(join(repo, "a.txt"), "preserve current\n");
			writeFileSync(join(repo, "new.txt"), "preserve new\n");
			const realSpawn = spawn.safeSpawn;
			const truncated = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
				const result = await realSpawn(opts);
				return opts.cmd.includes(repo) && opts.cmd.includes("add")
					? { ...result, [flag]: true }
					: result;
			});
			try {
				await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow("size limit");
				await expect(worktreeTreeSnapshot.restore(repo, target)).rejects.toThrow("size limit");
			} finally {
				truncated.mockRestore();
			}
			expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("preserve current\n");
			expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("preserve new\n");
		});
	}

	for (const failure of [
		"query",
		"warning",
		"stdoutTruncated",
		"stderrTruncated",
		"pathCount",
	] as const) {
		test(`tracked-ignored ${failure} failure cannot publish an incomplete tree`, async () => {
			const repo = await createRepo("nf-tree-listing-failure-");
			writeFileSync(join(repo, "a.txt"), "preserve\n");
			const realSpawn = spawn.safeSpawn;
			const failed = spyOn(spawn, "safeSpawn").mockImplementation((opts) => {
				if (opts.cwd === repo && opts.cmd.includes("ls-files")) {
					return Promise.resolve({
						stdout: failure === "pathCount" ? "ignored.txt\0".repeat(5_001) : "ignored.txt\0",
						stderr: failure === "query" || failure === "warning" ? "incomplete listing" : "",
						exitCode: failure === "query" ? 1 : 0,
						stdoutTruncated: failure === "stdoutTruncated",
						stderrTruncated: failure === "stderrTruncated",
					});
				}
				return realSpawn(opts);
			});
			try {
				await expect(worktreeTreeSnapshot.capture(repo)).rejects.toThrow(TreeSnapshotError);
			} finally {
				failed.mockRestore();
			}
			const rows = await db.query.worktreeTreeSnapshots.findMany({
				where: eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(repo)),
			});
			expect(rows).toEqual([]);
			expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("preserve\n");
		});
	}
});

/**
 * The hot-path capture budget. Tool-boundary captures run *inside* the narrator's
 * event consumer, so on a worktree whose full scan exceeds the budget (a huge
 * tree on a slow filesystem — the Windows + modpack-directory failure this came
 * from) the capture must step aside: null for the tool, a background warm-up for
 * the index, and a cooldown instead of a scan loop when the warm-up fails.
 */
describe("hot-path capture budget", () => {
	test("captures within the budget exactly like tryCapture", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-tree-hot-fast-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		const tree = await worktreeTreeSnapshot.tryCaptureHot(repo);
		expect(tree).toMatch(/^[0-9a-f]{40}$/);
		expect(tree).toBe(await worktreeTreeSnapshot.capture(repo));
	});

	test("an over-budget capture returns null, then finishes warming in the background", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-tree-hot-warmup-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		// A zero budget expires before the first git process can possibly exit, so
		// the tool path gets its null and moves on...
		const timedOut = await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, {
			budgetMs: 0,
		});
		expect(timedOut).toBeNull();

		// ...while the capture keeps running as the warm-up. A later call shares that
		// scan instead of queueing a second one, and resolves with its hash.
		const warmed = await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, {
			budgetMs: 30_000,
		});
		expect(warmed).toMatch(/^[0-9a-f]{40}$/);
		expect(warmed).toBe(await worktreeTreeSnapshot.capture(repo));
	});

	test("a fresh boundary never shares an existing observation even with a permissive timestamp", async () => {
		const repo = await createRepo("nf-tree-hot-require-fresh-");
		writeFileSync(join(repo, "a.txt"), "before human\n");
		const oldTree = await worktreeTreeSnapshot.capture(repo);
		writeFileSync(join(repo, "a.txt"), "after human\n");
		const realCapture = worktreeTreeSnapshot.capture.bind(worktreeTreeSnapshot);
		let release: ((tree: string) => void) | undefined;
		const oldObservation = new Promise<string>((resolve) => {
			release = resolve;
		});
		const capture = spyOn(worktreeTreeSnapshot, "capture")
			.mockImplementationOnce(() => oldObservation)
			.mockImplementation(realCapture);
		try {
			expect(
				await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, { budgetMs: 0 }),
			).toBeNull();
			// Millisecond timestamps cannot distinguish calls in the same clock tick.
			// requireFresh must reject sharing independently of the cutoff comparison.
			const fresh = worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, {
				budgetMs: 5_000,
				minStartedAt: 0,
				requireFresh: true,
			});
			release?.(oldTree);
			const tree = await fresh;
			expect(tree).not.toBe(oldTree);
			expect(tree).toMatch(/^[0-9a-f]{40}$/);
			expect(capture).toHaveBeenCalledTimes(2);
		} finally {
			release?.(oldTree);
			capture.mockRestore();
		}
	});

	test("concurrent over-budget calls share one warm-up", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-tree-hot-shared-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		const results = await Promise.all([
			worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, { budgetMs: 0 }),
			worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, { budgetMs: 0 }),
			worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, { budgetMs: 0 }),
		]);
		expect(results).toEqual([null, null, null]);

		// One warm-up completed underneath them all.
		const warmed = await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, {
			budgetMs: 30_000,
		});
		expect(warmed).toMatch(/^[0-9a-f]{40}$/);
	});

	test("a failed warm-up pauses hot-path captures until the cooldown expires", async () => {
		resetHotPathCaptureStateForTests();
		// A missing worktree fails every capture. The failure only starts the
		// cooldown because it outlived the budget, i.e. it ran as the warm-up.
		const dir = join(tmpdir(), `nf-tree-hot-cooldown-${Date.now()}`);
		tempDirs.push(dir);
		snapshotPaths.push(normalizePathForComparison(dir));

		const timedOut = await worktreeTreeSnapshot.tryCaptureHot(dir, LOCAL_DEVICE_ID, {
			budgetMs: 0,
			cooldownMs: 1_000,
		});
		expect(timedOut).toBeNull();
		// Sharing the warm-up to its conclusion guarantees the cooldown has engaged
		// by the time this resolves (the cooldown window came from the first call).
		expect(
			await worktreeTreeSnapshot.tryCaptureHot(dir, LOCAL_DEVICE_ID, { budgetMs: 30_000 }),
		).toBeNull();

		// The workspace is now perfectly capturable, yet the cooldown must suppress
		// even attempting a scan: null, without trying.
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "a.txt"), "one\n");
		expect(await worktreeTreeSnapshot.tryCaptureHot(dir, LOCAL_DEVICE_ID)).toBeNull();

		// Once the window passes, the next call captures normally again.
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_100));
		const recovered = await worktreeTreeSnapshot.tryCaptureHot(dir, LOCAL_DEVICE_ID, {
			budgetMs: 30_000,
		});
		expect(recovered).toMatch(/^[0-9a-f]{40}$/);
	});

	test("a fast failure keeps the retry-next-time behaviour (no cooldown)", async () => {
		resetHotPathCaptureStateForTests();
		const dir = join(tmpdir(), `nf-tree-hot-fastfail-${Date.now()}`);
		tempDirs.push(dir);
		snapshotPaths.push(normalizePathForComparison(dir));

		// The capture fails *within* a generous budget (a vanished worktree), which
		// is a transient shape — the dormant/wake cycle produces it — so no cooldown
		// is recorded and the next call retries immediately.
		expect(
			await worktreeTreeSnapshot.tryCaptureHot(dir, LOCAL_DEVICE_ID, {
				budgetMs: 30_000,
				cooldownMs: 60_000,
			}),
		).toBeNull();

		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "a.txt"), "one\n");
		const retried = await worktreeTreeSnapshot.tryCaptureHot(dir, LOCAL_DEVICE_ID, {
			budgetMs: 30_000,
		});
		expect(retried).toMatch(/^[0-9a-f]{40}$/);
	});

	test("a caller with a cutoff does not share a scan that started before it", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-tree-hot-cutoff-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		// Promote a capture to the background warm-up.
		expect(
			await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, { budgetMs: 0 }),
		).toBeNull();

		// A boundary measured *now* must not come from that older scan (its window
		// may straddle the writes being measured): the call waits for the stale scan
		// to settle, then re-captures — observable as exactly one more capture call.
		const spy = spyOn(worktreeTreeSnapshot, "capture");
		try {
			const tree = await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, {
				budgetMs: 30_000,
				minStartedAt: Date.now(),
			});
			expect(tree).toMatch(/^[0-9a-f]{40}$/);
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});

	test("a caller with a cutoff in the past shares the in-flight scan", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-tree-hot-share-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		expect(
			await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, { budgetMs: 0 }),
		).toBeNull();

		// The in-flight scan started after the cutoff, so its result is valid for the
		// caller and no second scan is started.
		const spy = spyOn(worktreeTreeSnapshot, "capture");
		try {
			const tree = await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, {
				budgetMs: 30_000,
				minStartedAt: 1,
			});
			expect(tree).toMatch(/^[0-9a-f]{40}$/);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	/** A warm-up capture whose scan never finishes on its own, abortable via its signal. */
	function mockHungCapture() {
		const state = { capturedSignal: undefined as AbortSignal | undefined };
		const spy = spyOn(worktreeTreeSnapshot, "capture").mockImplementation(
			(_worktreePath, _deviceId, opts) =>
				new Promise<string>((_resolve, reject) => {
					state.capturedSignal = opts?.signal;
					const timer = setTimeout(() => reject(new Error("warm-up outlived the test")), 60_000);
					opts?.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(new Error("preempted"));
						},
						{ once: true },
					);
				}),
		);
		return { spy, state };
	}

	test("a structural capture preempts an in-flight warm-up instead of queueing behind it", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-tree-hot-preempt-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		const { spy, state } = mockHungCapture();
		// Promote the hung capture to the warm-up slot.
		expect(
			await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, { budgetMs: 0 }),
		).toBeNull();

		// The structural path must kill the warm-up's scan rather than queue behind
		// it for the full warm-up timeout.
		spy.mockRestore();
		const tree = await worktreeTreeSnapshot.capture(repo);
		expect(tree).toMatch(/^[0-9a-f]{40}$/);
		expect(state.capturedSignal?.aborted).toBe(true);

		// Preemption is not a warm-up *failure*: no cooldown, the next hot call captures.
		const warmed = await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, {
			budgetMs: 30_000,
		});
		expect(warmed).toMatch(/^[0-9a-f]{40}$/);
	});

	test("destroy aborts an in-flight warm-up and drops its bookkeeping", async () => {
		resetHotPathCaptureStateForTests();
		const repo = await createRepo("nf-tree-hot-destroy-");
		writeFileSync(join(repo, "a.txt"), "one\n");

		const { spy, state } = mockHungCapture();
		expect(
			await worktreeTreeSnapshot.tryCaptureHot(repo, LOCAL_DEVICE_ID, { budgetMs: 0 }),
		).toBeNull();
		spy.mockRestore();

		expect(await worktreeTreeSnapshot.destroy(repo, LOCAL_DEVICE_ID, { force: true })).toBe(true);
		expect(state.capturedSignal?.aborted).toBe(true);
	});
});
