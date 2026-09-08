import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { buildAppErrorResponse } from "./app-error-response";
import { AppError } from "./errors";
import {
	mergeGitTrees,
	requireCompleteMergeTree,
	requireMarkerResolvableTree,
	resetMergeTreeSupportCacheForTests,
	supportsMergeTree,
} from "./git-tree-merge";
import * as spawn from "./spawn";

const dirs: string[] = [];
const realSpawn = spawn.safeSpawn;
const nativeSupported = await supportsMergeTree(true);
let stub: ReturnType<typeof spyOn> | undefined;
const scratchDirs = new Set<string>();
const TEXT = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await realSpawn({
		cmd: ["git", ...args],
		cwd,
		timeout: 15_000,
		maxOutputBytes: 1024 * 1024,
	});
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

function oldGit(
	help = "usage: git merge-tree <base-tree> <branch1> <branch2>",
	failure?: (options: spawn.SafeSpawnOptions) => spawn.SafeSpawnResult | undefined,
) {
	resetMergeTreeSupportCacheForTests();
	stub = spyOn(spawn, "safeSpawn").mockImplementation((options) => {
		if (options.cmd.join(" ") === "git merge-tree -h") {
			return Promise.resolve({ stdout: "", stderr: help, exitCode: 129 });
		}
		const index = options.env?.GIT_INDEX_FILE;
		if (index) scratchDirs.add(dirname(index));
		const injected = failure?.(options);
		if (injected) return Promise.resolve(injected);
		return realSpawn(options);
	});
}

async function repo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "nf-merge-compat-test-"));
	dirs.push(dir);
	await git(dir, "init");
	await git(dir, "config", "user.name", "Test");
	await git(dir, "config", "user.email", "test@example.com");
	writeFileSync(join(dir, "app.txt"), TEXT);
	writeFileSync(join(dir, "old.txt"), TEXT);
	writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 255]));
	await git(dir, "add", "-A");
	await git(dir, "commit", "-m", "base");
	return dir;
}

async function commit(dir: string, message: string): Promise<string> {
	await git(dir, "add", "-A");
	await git(dir, "commit", "-m", message);
	return git(dir, "rev-parse", "HEAD");
}

async function diverge(kind: "clean" | "content" | "binary" | "delete" | "rename" | "odd-path") {
	const dir = await repo();
	const path = kind === "odd-path" ? " odd\tname\n中文.txt " : "app.txt";
	if (kind === "odd-path") {
		renameSync(join(dir, "app.txt"), join(dir, path));
		await commit(dir, "odd filename");
	}
	const base = await git(dir, "rev-parse", "HEAD");
	writeFileSync(join(dir, path), TEXT.replace("one", "ours"));
	if (kind === "binary") writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 9, 2, 255]));
	if (kind === "rename") renameSync(join(dir, "old.txt"), join(dir, "renamed.txt"));
	const ours = await commit(dir, "ours");
	await git(dir, "checkout", "--detach", base);
	writeFileSync(
		join(dir, path),
		TEXT.replace(kind === "content" || kind === "odd-path" ? "one" : "ten", "theirs"),
	);
	if (kind === "binary") writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 8, 2, 255]));
	if (kind === "delete") rmSync(join(dir, path));
	if (kind === "rename") writeFileSync(join(dir, "old.txt"), TEXT.replace("five", "renamed-edit"));
	const theirs = await commit(dir, "theirs");
	return { worktreePath: dir, base, ours, theirs, path };
}

function userState(dir: string) {
	return {
		index: readFileSync(join(dir, ".git", "index")),
		head: readFileSync(join(dir, ".git", "HEAD")),
		file: readFileSync(join(dir, "app.txt")),
	};
}

afterEach(() => {
	stub?.mockRestore();
	stub = undefined;
	resetMergeTreeSupportCacheForTests();
	for (const dir of scratchDirs) expect(existsSync(dir)).toBe(false);
	scratchDirs.clear();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("old Git compatibility merge", () => {
	for (const kind of ["clean", "content", "binary", "delete", "rename", "odd-path"] as const) {
		test(`${kind}: preserves merge semantics with an isolated index and worktree`, async () => {
			const options = await diverge(kind);
			const native = await mergeGitTrees(options);
			oldGit();
			expect(await supportsMergeTree()).toBe(false);
			const fallback = await mergeGitTrees(options);
			expect(fallback.hasConflicts).toBe(native.hasConflicts);
			expect([...fallback.conflicts].sort()).toEqual([...native.conflicts].sort());
			if (!native.hasConflicts) expect(fallback.tree).toBe(native.tree);
			else {
				expect(fallback.tree).toBeNull();
				expect(fallback.conflictsComplete).toBe(false);
				expect(fallback.conflictMarkersComplete).toBe(false);
				expect(() => requireCompleteMergeTree(fallback)).toThrow();
			}
			expect(scratchDirs.size).toBe(1);
		});
	}

	test("preserves staged/unstaged/untracked data, HEAD, refs and merge state", async () => {
		const options = await diverge("content");
		const dir = options.worktreePath;
		writeFileSync(join(dir, "app.txt"), "staged\n");
		await git(dir, "add", "app.txt");
		writeFileSync(join(dir, "app.txt"), "unstaged\n");
		writeFileSync(join(dir, "untracked.txt"), "untracked\n");
		writeFileSync(join(dir, ".git", "ORIG_HEAD"), `${options.base}\n`);
		const before = userState(dir);
		const refs = await git(dir, "show-ref");
		const status = await git(dir, "status", "--porcelain=v1", "-z");
		oldGit();
		expect((await mergeGitTrees(options)).hasConflicts).toBe(true);
		expect(userState(dir)).toEqual(before);
		expect(await git(dir, "show-ref")).toBe(refs);
		expect(await git(dir, "status", "--porcelain=v1", "-z")).toBe(status);
		expect(readFileSync(join(dir, "untracked.txt"), "utf8")).toBe("untracked\n");
		expect(readFileSync(join(dir, ".git", "ORIG_HEAD"), "utf8")).toBe(`${options.base}\n`);
		expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(false);
	});

	test("derives the base from snapshot-style ancestry instead of an explicit tree", async () => {
		const options = { ...(await diverge("clean")), base: null };
		const native = await mergeGitTrees(options);
		oldGit();
		expect(await mergeGitTrees(options)).toEqual(native);
	});

	test("accepts bare trees and honors an explicit reverse-merge base", async () => {
		const options = await diverge("clean");
		const merged = await mergeGitTrees(options);
		const trees = {
			worktreePath: options.worktreePath,
			base: await git(options.worktreePath, "rev-parse", `${options.ours}^{tree}`),
			ours: requireCompleteMergeTree(merged),
			theirs: await git(options.worktreePath, "rev-parse", `${options.base}^{tree}`),
		};
		const native = await mergeGitTrees(trees);
		oldGit();
		const reversed = await mergeGitTrees(trees);
		expect(reversed).toEqual(native);
		expect(reversed.tree).toBe(
			await git(options.worktreePath, "rev-parse", `${options.theirs}^{tree}`),
		);
	});

	test.skipIf(!nativeSupported)(
		"Git 2.38/2.39 uses fallback for explicit bases but native for commit ancestry",
		async () => {
			const options = await diverge("clean");
			oldGit("usage: git merge-tree --write-tree --name-only -z <branch1> <branch2>");
			expect(await supportsMergeTree()).toBe(true);
			expect(await supportsMergeTree(true)).toBe(false);
			expect((await mergeGitTrees(options)).hasConflicts).toBe(false);
			expect(scratchDirs.size).toBe(1);
			expect((await mergeGitTrees({ ...options, base: null })).hasConflicts).toBe(false);
			expect(scratchDirs.size).toBe(1);
		},
	);

	test("works from a linked worktree without changing its per-worktree index", async () => {
		const options = await diverge("clean");
		const linkedParent = mkdtempSync(join(tmpdir(), "nf-merge-linked-"));
		dirs.push(linkedParent);
		const linked = join(linkedParent, "worktree");
		await git(options.worktreePath, "worktree", "add", "--detach", linked, options.ours);
		const gitDir = await git(linked, "rev-parse", "--absolute-git-dir");
		const index = readFileSync(join(gitDir, "index"));
		oldGit();
		expect((await mergeGitTrees({ ...options, worktreePath: linked })).hasConflicts).toBe(false);
		expect(readFileSync(join(gitDir, "index"))).toEqual(index);
		expect(await git(linked, "status", "--porcelain")).toBe("");
	});

	for (const failure of ["command", "truncated", "size", "nameless-conflict"] as const) {
		test(`${failure} fails visibly and cleans scratch state without applying anything`, async () => {
			const options = await diverge("content");
			const before = userState(options.worktreePath);
			oldGit(undefined, (opts) => {
				if (failure === "size" && opts.cmd.includes("ls-tree"))
					return {
						stdout: `100644 blob ${options.base} 536870913\tbig.bin\0`,
						stderr: "",
						exitCode: 0,
					};
				if (!opts.cmd.includes("merge-recursive")) return;
				if (failure === "truncated")
					return { stdout: "partial", stderr: "", exitCode: 0, stdoutTruncated: true };
				return {
					stdout: "",
					stderr: "compatibility command unavailable",
					exitCode: failure === "nameless-conflict" ? 1 : 128,
				};
			});
			const app = new Hono();
			app.get("/merge", async (c) => {
				const result = await mergeGitTrees(options);
				requireCompleteMergeTree(result);
				return c.json(result);
			});
			app.onError((err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "masked" }, 500));
			const response = await app.request("/merge");
			expect(response.status).toBe(422);
			const body = await response.json();
			expect(body.messageCode).toBe(
				failure === "nameless-conflict"
					? "GIT_TREE_MERGE_CONFLICTS_UNLISTED"
					: "GIT_TREE_MERGE_FALLBACK_FAILED",
			);
			if (failure !== "nameless-conflict")
				expect(body.messageParams.feature).toContain("--write-tree");
			expect(body.error).not.toBe("Internal server error");
			expect(userState(options.worktreePath)).toEqual(before);
		});
	}

	test("native failure is not mislabeled as old Git and does not start fallback", async () => {
		const options = await diverge("clean");
		oldGit("--write-tree --merge-base", (opts) =>
			opts.cmd.includes("merge-tree")
				? { stdout: "", stderr: "missing object", exitCode: 128 }
				: undefined,
		);
		try {
			await mergeGitTrees(options);
			throw new Error("expected merge failure");
		} catch (error) {
			expect(error).toBeInstanceOf(AppError);
			expect((error as AppError).messageCode).toBe("GIT_TREE_MERGE_FAILED");
		}
		expect(scratchDirs.size).toBe(0);
	});

	test("never turns a native conflict without named paths into a clean tree", async () => {
		const options = await diverge("clean");
		oldGit("--write-tree --merge-base", (opts) =>
			opts.cmd.includes("merge-tree")
				? { stdout: `${options.base}\0\0`, stderr: "", exitCode: 1 }
				: undefined,
		);
		const result = await mergeGitTrees(options);
		expect(result.hasConflicts).toBe(true);
		expect(result.conflictsComplete).toBe(false);
		expect(() => requireCompleteMergeTree(result)).toThrow();
	});

	test("keeps both sides of a directory/file conflict, including displaced files", async () => {
		const dir = await repo();
		const base = await git(dir, "rev-parse", "HEAD");
		writeFileSync(join(dir, "collision"), "ours file must survive\n");
		const ours = await commit(dir, "file side");
		await git(dir, "checkout", "--detach", base);
		mkdirSync(join(dir, "collision"));
		writeFileSync(join(dir, "collision", "child.txt"), "theirs child must survive\n");
		const theirs = await commit(dir, "directory side");
		oldGit();
		const result = await mergeGitTrees({ worktreePath: dir, base, ours, theirs });
		expect(result.hasConflicts).toBe(true);
		expect(result.tree).toBeNull();
		expect(result.conflictsComplete).toBe(false);
		expect(await git(dir, "show", `${ours}:collision`)).toBe("ours file must survive");
		expect(await git(dir, "show", `${theirs}:collision/child.txt`)).toBe(
			"theirs child must survive",
		);
		expect(() => requireCompleteMergeTree(result)).toThrow();
	});

	test("retains submodule conflicts without treating a gitlink as a directory to add", async () => {
		const dir = await repo();
		const tree = await git(dir, "rev-parse", "HEAD^{tree}");
		const subBase = await git(dir, "commit-tree", tree, "-m", "sub-base");
		const subOurs = await git(dir, "commit-tree", tree, "-p", subBase, "-m", "sub-ours");
		const subTheirs = await git(dir, "commit-tree", tree, "-p", subBase, "-m", "sub-theirs");
		await git(dir, "update-index", "--add", "--cacheinfo", "160000", subBase, "sub");
		await git(dir, "commit", "-m", "base submodule");
		const base = await git(dir, "rev-parse", "HEAD");
		await git(dir, "update-index", "--cacheinfo", "160000", subOurs, "sub");
		await git(dir, "commit", "-m", "our submodule");
		const ours = await git(dir, "rev-parse", "HEAD");
		await git(dir, "checkout", "--detach", base);
		await git(dir, "update-index", "--cacheinfo", "160000", subTheirs, "sub");
		await git(dir, "commit", "-m", "their submodule");
		const theirs = await git(dir, "rev-parse", "HEAD");
		oldGit();
		const result = await mergeGitTrees({ worktreePath: dir, base, ours, theirs });
		expect(result.conflicts).toContain("sub");
		expect(result.tree).toBeNull();
		expect(result.conflictsComplete).toBe(false);
		expect(await git(dir, "ls-tree", ours, "sub")).toBe(`160000 commit ${subOurs}\tsub`);
	});

	test("temporary index updates do not run user hooks", async () => {
		const options = await diverge("content");
		const marker = join(options.worktreePath, ".git", "compat-hook-ran");
		const hook = join(options.worktreePath, ".git", "hooks", "post-index-change");
		mkdirSync(dirname(hook), { recursive: true });
		writeFileSync(hook, `#!/bin/sh\nprintf hook > "${marker}"\n`);
		chmodSync(hook, 0o755);
		oldGit();
		expect((await mergeGitTrees(options)).hasConflicts).toBe(true);
		expect(existsSync(marker)).toBe(false);
	});

	test("snapshot fallback preserves raw CRLF and binary bytes under conversion attributes", async () => {
		const { worktreeTreeSnapshot: snapshots } = await import("../services/worktree-tree-snapshot");
		const dir = await repo();
		const crlf = TEXT.replaceAll("\n", "\r\n");
		writeFileSync(join(dir, "app.txt"), crlf);
		writeFileSync(
			join(dir, ".gitattributes"),
			"* text=auto working-tree-encoding=UTF-16LE ident filter=missing\n",
		);
		const base = await snapshots.capture(dir);
		writeFileSync(join(dir, "app.txt"), crlf.replace("one", "ours"));
		const binary = Buffer.from([0, 128, 255, 9]);
		writeFileSync(join(dir, "blob.bin"), binary);
		const ours = await snapshots.capture(dir);
		writeFileSync(join(dir, "app.txt"), crlf.replace("ten", "theirs"));
		writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 255]));
		const theirs = await snapshots.capture(dir);
		const before = userState(dir);
		const native = await snapshots.mergeTreesWithBase(dir, base, ours, theirs);
		oldGit();
		const fallback = await snapshots.mergeTreesWithBase(dir, base, ours, theirs);
		expect(fallback).toEqual(native);
		expect(userState(dir)).toEqual(before);
		await snapshots.restore(dir, requireCompleteMergeTree(fallback));
		expect(readFileSync(join(dir, "app.txt"), "utf8")).toBe(
			crlf.replace("one", "ours").replace("ten", "theirs"),
		);
		expect(readFileSync(join(dir, "blob.bin"))).toEqual(binary);
	});

	test("commit conflict previews use the same compatibility path", async () => {
		const options = await diverge("content");
		const { gitService } = await import("../services/git-service");
		oldGit();
		await expect(
			gitService.mergeTree(options.worktreePath, options.base, options.ours, options.theirs),
		).rejects.toMatchObject({ messageCode: "GIT_TREE_MERGE_CONFLICTS_UNLISTED" });
		expect(scratchDirs.size).toBe(1);
	});

	test("recognizes negatable help flags without sending modern Git through fallback", async () => {
		oldGit("--write-tree --[no-]merge-base <tree> --[no-]messages");
		expect(await supportsMergeTree(true)).toBe(true);
	});

	for (const mode of ["native", "fallback"] as const) {
		test.skipIf(mode === "native" && !nativeSupported)(
			`${mode}: mixed structural conflicts cannot bypass an owned-path reversal`,
			async () => {
				const { worktreeTreeSnapshot: snapshots } = await import(
					"../services/worktree-tree-snapshot"
				);
				const dir = await repo();
				mkdirSync(join(dir, "d"));
				writeFileSync(join(dir, "d/a"), "aaa\n");
				writeFileSync(join(dir, "d/b"), "bbb\n");
				writeFileSync(join(dir, "z"), "base\n");
				const base = await commit(dir, "directory base");
				const baseTree = await snapshots.capture(dir);
				mkdirSync(join(dir, "e"));
				mkdirSync(join(dir, "f"));
				renameSync(join(dir, "d/a"), join(dir, "e/a"));
				renameSync(join(dir, "d/b"), join(dir, "f/b"));
				writeFileSync(join(dir, "z"), "ours\n");
				const ours = await commit(dir, "split directory");
				const oursTree = await snapshots.capture(dir);
				await git(dir, "checkout", "--detach", base);
				writeFileSync(join(dir, "d/c"), "where should this go?\n");
				writeFileSync(join(dir, "z"), "theirs\n");
				await commit(dir, "incoming child");
				const theirsTree = await snapshots.capture(dir);
				await git(dir, "checkout", "--detach", ours);
				const before = userState(dir);
				if (mode === "fallback") oldGit();
				const result = await snapshots.mergeTreesWithBase(dir, baseTree, oursTree, theirsTree);
				expect(result.hasConflicts).toBe(true);
				expect(result.conflicts).toContain("z");
				expect(result.conflictsComplete).toBe(false);
				await expect(
					snapshots.reverseAndRestore(dir, [
						{ before: theirsTree, after: baseTree, ownedPaths: ["d/c"] },
					]),
				).rejects.toMatchObject({ messageCode: "GIT_TREE_MERGE_CONFLICTS_UNLISTED" });
				expect(userState(dir)).toEqual(before);
				expect(existsSync(join(dir, "d/c"))).toBe(false);
				expect(readFileSync(join(dir, "z"), "utf8")).toBe("ours\n");
			},
		);
	}

	test.skipIf(!nativeSupported)(
		"native text markers are verified but binary and mode conflicts cannot auto-complete",
		async () => {
			const text = await mergeGitTrees(await diverge("content"));
			expect(text.conflictMarkersComplete).toBe(true);
			expect(requireMarkerResolvableTree(text)).toBe(requireCompleteMergeTree(text));
			const binary = await mergeGitTrees(await diverge("binary"));
			expect(binary.conflictMarkersComplete).toBe(false);
			expect(() => requireMarkerResolvableTree(binary)).toThrow();
			const dir = await repo();
			const base = await git(dir, "rev-parse", "HEAD");
			writeFileSync(join(dir, "added"), "");
			const ours = await commit(dir, "add empty regular file");
			await git(dir, "checkout", "--detach", base);
			writeFileSync(join(dir, "added"), "text without conflict markers\n");
			await git(dir, "add", "added");
			await git(dir, "update-index", "--chmod=+x", "added");
			await git(dir, "commit", "-m", "add executable file");
			const theirs = await git(dir, "rev-parse", "HEAD");
			const modes = await mergeGitTrees({ worktreePath: dir, base, ours, theirs });
			expect(modes.hasConflicts).toBe(true);
			expect(modes.conflictMarkersComplete).toBe(false);
			expect(() => requireMarkerResolvableTree(modes)).toThrow();
		},
	);

	test("fallback never executes smudge/process/clean filters or writes a source LFS cache", async () => {
		const dir = await repo();
		writeFileSync(join(dir, ".gitattributes"), "payload.bin filter=expand\n");
		writeFileSync(join(dir, "payload.bin"), "pointer");
		const base = await commit(dir, "pointer base");
		writeFileSync(join(dir, "app.txt"), TEXT.replace("one", "ours"));
		const ours = await commit(dir, "ours");
		await git(dir, "checkout", "--detach", base);
		writeFileSync(join(dir, "old.txt"), "theirs\n");
		const theirs = await commit(dir, "theirs");
		const marker = join(dir, ".git", "filter-ran");
		const command = `"${process.execPath}" -e 'require("fs").writeFileSync(${JSON.stringify(marker)},"ran"); process.stdout.write(Buffer.alloc(8*1024*1024,120))'`;
		for (const kind of ["smudge", "process", "clean"])
			await git(dir, "config", `filter.expand.${kind}`, command);
		await git(dir, "config", "filter.expand.required", "true");
		const config = readFileSync(join(dir, ".git/config"));
		const before = userState(dir);
		let checkoutBytes = 0;
		oldGit(undefined, (opts) => {
			if (opts.cmd.includes("merge-recursive")) {
				checkoutBytes = statSync(join(opts.cwd as string, "payload.bin")).size;
				expect(opts.cmd[opts.cmd.indexOf("--git-dir") + 1]).not.toBe(join(dir, ".git"));
				expect(opts.env?.GIT_OBJECT_DIRECTORY).toBe(join(dir, ".git/objects"));
			}
		});
		const result = await mergeGitTrees({ worktreePath: dir, base, ours, theirs });
		expect(result.hasConflicts).toBe(false);
		expect(checkoutBytes).toBe(7);
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(join(dir, ".git/lfs"))).toBe(false);
		expect(readFileSync(join(dir, ".git/config"))).toEqual(config);
		expect(userState(dir)).toEqual(before);
		expect(await git(dir, "show", `${result.tree}:payload.bin`)).toBe("pointer");
	});

	test("fallback preserves builtin union attributes without copying executable drivers", async () => {
		const options = await diverge("content");
		mkdirSync(join(options.worktreePath, ".git/info"), { recursive: true });
		writeFileSync(join(options.worktreePath, ".git/info/attributes"), "app.txt merge=union\n");
		oldGit();
		const result = await mergeGitTrees(options);
		expect(result.hasConflicts).toBe(false);
		const text = await git(options.worktreePath, "show", `${result.tree}:app.txt`);
		expect(text).toContain("ours");
		expect(text).toContain("theirs");
	});

	for (const setting of ["merge.custom.driver", "merge.renormalize"]) {
		test(`fallback explicitly refuses unsafe ${setting} instead of changing its meaning`, async () => {
			const options = await diverge("clean");
			await git(
				options.worktreePath,
				"config",
				setting,
				setting.endsWith("driver") ? "exit 0" : "true",
			);
			const before = userState(options.worktreePath);
			oldGit();
			await expect(mergeGitTrees(options)).rejects.toMatchObject({
				messageCode: "GIT_TREE_MERGE_FALLBACK_FAILED",
			});
			expect(userState(options.worktreePath)).toEqual(before);
			expect(scratchDirs.size).toBe(0);
		});
	}

	test("checks the merged result budget before returning an applicable tree", async () => {
		const options = await diverge("clean");
		let wrote = false;
		oldGit(undefined, (opts) => {
			if (opts.cmd.includes("write-tree")) wrote = true;
			if (wrote && opts.cmd.includes("ls-tree"))
				return { stdout: `100644 blob ${options.base} 536870913\thuge\0`, stderr: "", exitCode: 0 };
		});
		await expect(mergeGitTrees(options)).rejects.toMatchObject({
			messageCode: "GIT_TREE_MERGE_FALLBACK_FAILED",
		});
	});

	test("cancellation fails before modifying the user state", async () => {
		const options = await diverge("clean");
		const before = userState(options.worktreePath);
		oldGit();
		await expect(mergeGitTrees({ ...options, signal: AbortSignal.abort() })).rejects.toMatchObject({
			messageCode: "GIT_TREE_MERGE_FALLBACK_FAILED",
		});
		expect(userState(options.worktreePath)).toEqual(before);
	});
});
