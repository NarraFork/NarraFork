import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { cpSync, renameSync } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertLegacyLinkedWorktreeIdentityUnchangedSync as guard,
	LEGACY_LINKED_WORKTREE_LIMITS,
	prepareLegacyLinkedWorktreeIdentity as prepare,
	revalidateLegacyLinkedWorktreeIdentity as revalidate,
} from "./legacy-linked-worktree-identity";

let base: string;
let projectRoot: string;
let worktreePath: string;
let admin: string;
const git = (cwd: string, ...args: string[]) => {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	if (result.exitCode) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
};
const input = () => ({ projectRoot, worktreePath, expectedBranch: "chapter/one" });
async function snapshot(path: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	async function visit(folder: string) {
		for (const name of (await readdir(folder)).sort()) {
			const full = join(folder, name);
			const info = await lstat(full);
			if (info.isDirectory()) await visit(full);
			else if (info.isFile()) files[full] = (await readFile(full)).toString("base64");
			else files[full] = "symlink";
		}
	}
	await visit(path);
	return files;
}
async function rejectUnchanged(change: () => Promise<unknown>) {
	await change();
	const before = await snapshot(base);
	await expect(prepare(input())).rejects.toThrow();
	expect(await snapshot(base)).toEqual(before);
}
beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "narrafork-linked-identity-"));
	projectRoot = join(base, "main");
	worktreePath = join(base, "linked");
	await mkdir(projectRoot);
	git(projectRoot, "init", "-b", "main");
	git(projectRoot, "config", "user.name", "Fixture");
	git(projectRoot, "config", "user.email", "fixture@example.invalid");
	await writeFile(join(projectRoot, ".gitignore"), "ignored\n");
	await writeFile(join(projectRoot, "tracked"), "committed\n");
	await writeFile(join(projectRoot, "binary"), Buffer.from([0, 255, 128, 13, 10]));
	git(projectRoot, "add", ".");
	git(projectRoot, "commit", "-m", "fixture");
	// The ONLY worktree mutation is fixture setup, never the validator.
	git(projectRoot, "worktree", "add", "-b", "chapter/one", worktreePath);
	admin = git(worktreePath, "rev-parse", "--absolute-git-dir");
	await writeFile(join(worktreePath, "tracked"), "staged\n");
	git(worktreePath, "add", "tracked");
	await writeFile(join(worktreePath, "tracked"), "unstaged\n");
	await writeFile(join(worktreePath, "untracked"), "untracked\n");
	await writeFile(join(worktreePath, "ignored"), "ignored\n");
	await writeFile(join(worktreePath, "binary"), Buffer.from([0, 255, 127, 1, 10]));
});
afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

describe("closed read-only linked-worktree identity", () => {
	test("versioned evidence preserves every Git/user byte including dirty binary state", async () => {
		const before = await snapshot(base);
		const original = childProcess.spawn;
		const commands: string[][] = [];
		const spy = spyOn(childProcess, "spawn").mockImplementation(((
			command: string,
			args: string[],
			options: childProcess.SpawnOptions,
		) => {
			commands.push([command, ...args]);
			return original(command, args, options);
		}) as unknown as typeof childProcess.spawn);
		try {
			const evidence = await prepare(input());
			expect(evidence.version).toBe(1);
			expect(evidence.top).toBe(worktreePath);
			expect(evidence.common).toBe(join(projectRoot, ".git"));
			expect(evidence.adminDir).toBe(admin);
			expect(evidence.branch).toBe("refs/heads/chapter/one");
			expect(evidence.backpointer).toBe(join(worktreePath, ".git"));
			expect(
				evidence.metadata.find((m) => m.path === join(admin, "index"))?.contentDigest,
			).toHaveLength(64);
			expect((await revalidate(input(), evidence)).digest).toBe(evidence.digest);
			expect(commands.length).toBeGreaterThan(0);
			for (const command of commands) {
				expect(command).toContain("--no-optional-locks");
				expect(
					command.some((v) =>
						["checkout", "reset", "add", "remove", "move", "repair", "prune"].includes(v),
					),
				).toBe(false);
			}
		} finally {
			spy.mockRestore();
		}
		expect(await snapshot(base)).toEqual(before);
	});
	test("backpointer mismatch", async () =>
		rejectUnchanged(() => writeFile(join(admin, "gitdir"), `${projectRoot}/.git\n`)));
	test("common closure mismatch", async () =>
		rejectUnchanged(() => writeFile(join(admin, "commondir"), "../..wrong\n")));
	test("foreign repo gitfile", async () =>
		rejectUnchanged(() => writeFile(join(worktreePath, ".git"), `gitdir: ${projectRoot}/.git\n`)));
	test("chapter branch mismatch", async () => {
		await expect(prepare({ ...input(), expectedBranch: "other" })).rejects.toThrow();
	});
	test("detached HEAD", async () =>
		rejectUnchanged(async () => {
			await writeFile(join(admin, "HEAD"), `${git(worktreePath, "rev-parse", "HEAD")}\n`);
		}));
	for (const marker of [
		"MERGE_HEAD",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"REBASE_HEAD",
		"rebase-merge",
		"rebase-apply",
		"sequencer",
		"index.lock",
	]) {
		test(`rejects in-progress ${marker}`, async () =>
			rejectUnchanged(async () => {
				if (["rebase-merge", "rebase-apply", "sequencer"].includes(marker))
					await mkdir(join(admin, marker));
				else await writeFile(join(admin, marker), "active\n");
			}));
	}
	for (const target of ["root", "gitfile", "admin", "common"]) {
		test(`rejects ${target} symlink`, async () =>
			rejectUnchanged(async () => {
				const path =
					target === "root"
						? worktreePath
						: target === "gitfile"
							? join(worktreePath, ".git")
							: target === "admin"
								? admin
								: join(projectRoot, ".git");
				await rename(path, `${path}-saved`);
				await symlink(`${path}-saved`, path);
			}));
	}
	test("ancestor symlink", async () => {
		await symlink(projectRoot, join(base, "alias"));
		await expect(prepare({ ...input(), projectRoot: join(base, "alias") })).rejects.toThrow();
	});
	test("alternates/object symlink escape", async () =>
		rejectUnchanged(async () => {
			await writeFile(join(projectRoot, ".git", "objects", "info", "alternates"), `${base}\n`);
		}));
	test("symlink inside object namespace", async () =>
		rejectUnchanged(async () => {
			await symlink(base, join(projectRoot, ".git", "objects", "escape"));
		}));
	test("unsafe include config is never followed", async () =>
		rejectUnchanged(async () => {
			git(projectRoot, "config", "include.path", join(base, "outside"));
		}));
	test("file budget", async () =>
		rejectUnchanged(async () => {
			await writeFile(
				join(admin, "index"),
				Buffer.alloc(LEGACY_LINKED_WORKTREE_LIMITS.fileBytes + 1),
			);
		}));
	test("registration count budget", async () =>
		rejectUnchanged(async () => {
			for (let n = 0; n < LEGACY_LINKED_WORKTREE_LIMITS.inventoryEntries; n++) {
				const folder = join(projectRoot, ".git", "worktrees", `extra-${n}`);
				await mkdir(folder);
				await writeFile(join(folder, "gitdir"), `${base}/missing-${n}/.git\n`);
			}
		}));
	test("caller cancellation before and during probe", async () => {
		const before = await snapshot(base);
		const controller = new AbortController();
		controller.abort(new Error("caller cancelled"));
		await expect(prepare({ ...input(), signal: controller.signal })).rejects.toThrow(
			"caller cancelled",
		);
		const during = new AbortController();
		const promise = prepare({ ...input(), signal: during.signal });
		during.abort(new Error("during cancelled"));
		await expect(promise).rejects.toThrow("during cancelled");
		expect(await snapshot(base)).toEqual(before);
	});
	for (const target of ["root", "gitfile", "admin", "common"]) {
		test(`re-probe catches ${target} replacement`, async () => {
			const evidence = await prepare(input());
			const path =
				target === "root"
					? worktreePath
					: target === "gitfile"
						? join(worktreePath, ".git")
						: target === "admin"
							? admin
							: join(projectRoot, ".git");
			await rename(path, `${path}-old`);
			if (target === "gitfile") await writeFile(path, await readFile(`${path}-old`));
			else await mkdir(path);
			const before = await snapshot(base);
			await expect(revalidate(input(), evidence)).rejects.toThrow();
			expect(await snapshot(base)).toEqual(before);
		});
	}
	test("re-probe catches HEAD/index metadata content changes", async () => {
		const evidence = await prepare(input());
		await writeFile(join(admin, "index"), await readFile(join(admin, "index")));
		await expect(revalidate(input(), evidence)).rejects.toThrow();
	});
	for (const target of ["root", "gitfile", "admin", "common"]) {
		test(`in-flight ${target} replacement cannot yield ready evidence`, async () => {
			const original = childProcess.spawn;
			let changed = false;
			let actorSnapshot: Promise<Record<string, string>> | undefined;
			const spy = spyOn(childProcess, "spawn").mockImplementation(((
				command: string,
				args: string[],
				options: childProcess.SpawnOptions,
			) => {
				if (!changed) {
					changed = true;
					const path =
						target === "root"
							? worktreePath
							: target === "gitfile"
								? join(worktreePath, ".git")
								: target === "admin"
									? admin
									: join(projectRoot, ".git");
					const saved = join(base, "actor-saved");
					// Controlled adversarial fixture actor, not production validator I/O.
					renameSync(path, saved);
					cpSync(saved, path, { recursive: true });
					actorSnapshot = snapshot(base);
				}
				return original(command, args, options);
			}) as unknown as typeof childProcess.spawn);
			try {
				await expect(prepare(input())).rejects.toThrow();
				if (!actorSnapshot) throw new Error("Fixture race actor did not run");
				expect(await snapshot(base)).toEqual(await actorSnapshot);
			} finally {
				spy.mockRestore();
			}
		});
	}
	test("stat-only commit guard accepts live evidence, rejects serialized/tampered evidence", async () => {
		const before = await snapshot(base);
		const evidence = await prepare(input());
		expect(() => guard(evidence)).not.toThrow();
		expect(() => guard(JSON.parse(JSON.stringify(evidence)))).toThrow("in-process evidence");
		evidence.head = "tampered";
		expect(() => guard(evidence)).toThrow("in-process evidence");
		expect(await snapshot(base)).toEqual(before);
	});
	test("commit guard catches new operation marker and replacement index", async () => {
		const first = await prepare(input());
		await writeFile(join(admin, "MERGE_HEAD"), "active\n");
		expect(() => guard(first)).toThrow();
		await rm(join(admin, "MERGE_HEAD"));
		const next = await prepare(input());
		await rename(join(admin, "index"), join(base, "index-saved"));
		await writeFile(join(admin, "index"), await readFile(join(base, "index-saved")));
		expect(() => guard(next)).toThrow();
	});
	test("total metadata read budget", async () => {
		for (const folder of [join(projectRoot, ".git"), admin]) {
			for (const name of ["index", "config.worktree"])
				await writeFile(join(folder, name), Buffer.alloc(LEGACY_LINKED_WORKTREE_LIMITS.fileBytes));
		}
		const before = await snapshot(base);
		await expect(prepare(input())).rejects.toThrow("Metadata read budget exceeded");
		expect(await snapshot(base)).toEqual(before);
	});
	test("worktree-only include config is rejected before repository Git probes", async () =>
		rejectUnchanged(async () => {
			git(projectRoot, "config", "extensions.worktreeConfig", "true");
			await writeFile(join(admin, "config.worktree"), `[include]\npath = ${base}/outside\n`);
		}));
	test("symlink metadata file", async () =>
		rejectUnchanged(async () => {
			const path = join(admin, "HEAD");
			await rename(path, `${path}-old`);
			await symlink(`${path}-old`, path);
		}));
	test("main-root cannot itself be linked", async () => {
		await expect(
			prepare({ ...input(), projectRoot: worktreePath, worktreePath: projectRoot }),
		).rejects.toThrow();
	});
	test("Git prunable marker cannot yield ready evidence", async () => {
		const before = await snapshot(base);
		const inventory = git(projectRoot, "worktree", "list", "--porcelain", "-z");
		const modified = inventory.replace(
			"branch refs/heads/chapter/one\0\0",
			"branch refs/heads/chapter/one\0prunable missing gitdir\0\0",
		);
		expect(modified).not.toBe(inventory);
		const original = childProcess.spawn;
		const spy = spyOn(childProcess, "spawn").mockImplementation(((
			command: string,
			args: string[],
			options: childProcess.SpawnOptions,
		) => {
			if (args.includes("worktree"))
				return original(
					process.execPath,
					["-e", `process.stdout.write(${JSON.stringify(modified)})`],
					options,
				);
			return original(command, args, options);
		}) as unknown as typeof childProcess.spawn);
		try {
			await expect(prepare(input())).rejects.toThrow("prunable");
		} finally {
			spy.mockRestore();
		}
		expect(await snapshot(base)).toEqual(before);
	});
	test("source output cap terminates probe child without writes", async () => {
		const before = await snapshot(base);
		const original = childProcess.spawn;
		const spy = spyOn(childProcess, "spawn").mockImplementation((() =>
			original(
				process.execPath,
				[
					"-e",
					`process.stdout.write('x'.repeat(${LEGACY_LINKED_WORKTREE_LIMITS.inventoryBytes + 1}));setInterval(()=>{},1000)`,
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			)) as unknown as typeof childProcess.spawn);
		try {
			await expect(prepare(input())).rejects.toThrow("Git output limit exceeded");
		} finally {
			spy.mockRestore();
		}
		expect(await snapshot(base)).toEqual(before);
	});
	test("hard deadline terminates hanging Git child", async () => {
		const original = childProcess.spawn;
		const spy = spyOn(childProcess, "spawn").mockImplementation((() =>
			original(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
				stdio: ["ignore", "pipe", "pipe"],
			})) as unknown as typeof childProcess.spawn);
		try {
			await expect(prepare(input())).rejects.toThrow();
		} finally {
			spy.mockRestore();
		}
	}, 6000);
	test("concurrency cap and cancellation drain both children", async () => {
		const original = childProcess.spawn;
		const spy = spyOn(childProcess, "spawn").mockImplementation((() =>
			original(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
				stdio: ["ignore", "pipe", "pipe"],
			})) as unknown as typeof childProcess.spawn);
		const controller = new AbortController();
		const first = prepare({ ...input(), signal: controller.signal });
		const second = prepare({ ...input(), signal: controller.signal });
		const settled = Promise.allSettled([first, second]);
		try {
			await expect(prepare(input())).rejects.toThrow("Probe concurrency limit");
			controller.abort(new Error("cancel parallel probes"));
			expect((await settled).every((result) => result.status === "rejected")).toBe(true);
		} finally {
			controller.abort();
			await settled;
			spy.mockRestore();
		}
	});
	test("changed branch between probes is rejected without mutation", async () => {
		const evidence = await prepare(input());
		git(projectRoot, "branch", "chapter/two");
		git(worktreePath, "symbolic-ref", "HEAD", "refs/heads/chapter/two");
		const before = await snapshot(base);
		await expect(revalidate(input(), evidence)).rejects.toThrow();
		expect(await snapshot(base)).toEqual(before);
	});
	test("GIT_* injected environment cannot redirect repository", async () => {
		const old = process.env.GIT_DIR;
		process.env.GIT_DIR = join(base, "foreign");
		try {
			expect((await prepare(input())).common).toBe(join(projectRoot, ".git"));
		} finally {
			if (old === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = old;
		}
	});
});
