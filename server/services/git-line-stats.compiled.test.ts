import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitLineStats } from "../../shared/git-line-stats";
import { compiledWorkerBuildEntrypoints } from "../lib/compiled-worker";

const exec = promisify(execFile);
const project = resolve(import.meta.dir, "../..");
const childOptions = { timeout: 60_000, maxBuffer: 1024 * 1024 };

test("compiled Git line statistics embed the worker and run after all copied sources are removed", async () => {
	const buildSource = await readFile(join(project, "scripts/build-cross-platform.ts"), "utf8");
	expect(buildSource).toContain("...compiledWorkerBuildEntrypoints()");
	expect(compiledWorkerBuildEntrypoints()).toContain(
		"./server/services/git-untracked-line-worker.ts",
	);

	const fixture = await mkdtemp(join(tmpdir(), "nf-git-lines-compiled-"));
	try {
		const source = join(fixture, "source");
		// Copy the actual minimal source graph, then delete it before running the binary.
		// Never move or modify the live working tree while another agent is testing it.
		const copied = [
			"server/services/git-line-stats.ts",
			"server/services/git-untracked-line-worker.ts",
			"server/services/git-current-baseline-session.ts",
			"server/lib/compiled-worker.ts",
			"server/lib/hot-safe.ts",
			"server/lib/id.ts",
			"server/lib/worker-runtime/lifecycle.ts",
			"server/lib/worker-runtime/pool.ts",
			"server/lib/worker-runtime/queue.ts",
			"server/lib/errors.ts",
			"server/lib/logger.ts",
			"server/lib/narrafork-home.ts",
			"server/lib/runtime-target.ts",
			"server/lib/spawn.ts",
			"server/lib/win-handle-guard.ts",
			"shared/error-catalog.ts",
			"shared/git-line-stats.ts",
		];
		for (const path of copied) {
			const target = join(source, path);
			await mkdir(dirname(target), { recursive: true });
			await copyFile(join(project, path), target);
		}
		await mkdir(join(source, "node_modules"), { recursive: true });
		await cp(
			dirname(Bun.resolveSync("nanoid", import.meta.dir)),
			join(source, "node_modules/nanoid"),
			{ recursive: true },
		);
		await writeFile(
			join(source, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { paths: { "@shared/*": ["./shared/*"] } } }),
		);
		const probe = join(source, "server/probe.ts");
		await writeFile(
			probe,
			`import { getGitLineStats, gitLineStatsWorkerSpecifiers } from "./services/git-line-stats";
import { isCompiledRuntime } from "./lib/runtime-target";
console.log(JSON.stringify({
	compiled: isCompiledRuntime(),
	worker: gitLineStatsWorkerSpecifiers()[0],
	cwd: process.cwd(),
	stats: await getGitLineStats(Bun.argv[2]),
}));
`,
		);
		const binary = join(fixture, process.platform === "win32" ? "probe.exe" : "probe");
		await exec(
			process.execPath,
			[
				"build",
				probe,
				join(source, "server/services/git-untracked-line-worker.ts"),
				"--compile",
				"--minify",
				"--asset-naming=[dir]/[name].[ext]",
				"--outfile",
				binary,
			],
			{ ...childOptions, cwd: source },
		);
		await rm(source, { recursive: true, force: true });
		const cwd = join(fixture, "unrelated-cwd");
		const repository = join(fixture, "repository");
		await mkdir(cwd);
		await mkdir(repository);
		await exec("git", ["init", "-q"], { ...childOptions, cwd: repository });
		await writeFile(join(repository, "staged.txt"), "staged\n");
		await exec("git", ["add", "staged.txt"], { ...childOptions, cwd: repository });
		await writeFile(join(repository, "untracked.txt"), "one\ntwo");
		const { stdout } = await exec(binary, [repository], { ...childOptions, cwd });
		const result = JSON.parse(stdout.trim()) as {
			compiled: boolean;
			worker: string;
			cwd: string;
			stats: GitLineStats;
		};
		expect(result.compiled).toBe(true);
		expect(result.worker).toMatch(/\$bunfs\/|~BUN\/|%7EBUN\//i);
		expect(result.worker).toContain("/services/git-untracked-line-worker.js");
		expect(result.cwd).toBe(cwd);
		expect(result.stats).toMatchObject({ linesAdded: 3, linesRemoved: 0, complete: true });
		expect(result.stats.files.find((file) => file.path === "untracked.txt")).toMatchObject({
			stagedLinesAdded: 0,
			unstagedLinesAdded: 2,
			complete: true,
		});
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
}, 90_000);
