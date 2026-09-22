import { afterAll, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitWorkspaceTarget } from "./git-workspace";

const spawn = await import("../lib/spawn");
let refs = "head";
let stash = "stash@{0}:first\nstash@{1}:second";
let index = ":100644 100644 a b M file";
const commands: string[][] = [];
mock.module("../lib/spawn", () => ({
	...spawn,
	safeSpawn: async ({ cmd }: { cmd: string[] }) => {
		commands.push(cmd);
		return {
			exitCode: 0,
			stderr: "",
			stdout: cmd.includes("status")
				? "## main\0 M file\0"
				: cmd.includes("rev-parse")
					? refs
					: cmd.includes("stash")
						? stash
						: index,
		};
	},
}));
const { probeGitWatch, changedGitCategories } = await import("./git-workspace-watch");
afterAll(() => mock.module("../lib/spawn", () => spawn));
test("same-status same-length edit changes fingerprint; refs/index/older stash are sampled independently", async () => {
	const root = await mkdtemp(join(tmpdir(), "git-watch-local-"));
	try {
		await writeFile(join(root, "file"), "before");
		const target = {
			workspace: { rootPath: root },
			backend: { kind: "local" },
		} as GitWorkspaceTarget;
		const signal = new AbortController().signal;
		const first = await probeGitWatch(target, signal);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await writeFile(join(root, "file"), "after!");
		const edited = await probeGitWatch(target, signal);
		expect(changedGitCategories(first, edited)).toEqual(["worktree"]);
		refs = "next-head";
		const branch = await probeGitWatch(target, signal);
		expect(changedGitCategories(edited, branch)).toEqual(["refs"]);
		stash = "stash@{0}:first";
		const dropped = await probeGitWatch(target, signal);
		expect(changedGitCategories(branch, dropped)).toEqual(["stash"]);
		index = ":100644 100644 a c M file";
		expect(changedGitCategories(dropped, await probeGitWatch(target, signal))).toEqual(["index"]);
		expect(commands.every((cmd) => cmd.includes("--no-optional-locks") && cmd.includes(root))).toBe(
			true,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
