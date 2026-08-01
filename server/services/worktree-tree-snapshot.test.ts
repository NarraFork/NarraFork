import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
			{ before: "a", after: "c" },
			{ before: "x", after: "y" },
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
		).toEqual([{ before: "a", after: "b" }]);
		expect(planTreeRevertSegments([{ before: "a", after: "a" }])).toEqual([]);
		expect(planTreeRevertSegments([])).toEqual([]);
	});

	test("does not mutate the caller's pairs", () => {
		const pairs = [
			{ before: "a", after: "b" },
			{ before: "b", after: "c" },
		];
		planTreeRevertSegments(pairs);
		expect(pairs).toEqual([
			{ before: "a", after: "b" },
			{ before: "b", after: "c" },
		]);
	});
});
