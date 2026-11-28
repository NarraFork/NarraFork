import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { compiledWorkerBuildEntrypoints } from "../lib/compiled-worker";

const exec = promisify(execFile);
const project = resolve(import.meta.dir, "../..");
const childOptions = { timeout: 60_000, maxBuffer: 1024 * 1024 };

test("compiled paging and statistics worker loads with deleted sources and an unrelated working directory", async () => {
	expect(compiledWorkerBuildEntrypoints()).toContain("./server/services/git-status-page-worker.ts");
	const fixture = await mkdtemp(join(tmpdir(), "git-status-page-compiled-"));
	try {
		const source = join(fixture, "source");
		// This complete graph is intentionally independent of database/settings/application modules.
		const copied = [
			"shared/git-status-page.ts",
			"shared/git-line-stats.ts",
			"server/services/git-status-page-stats.ts",
			"server/services/git-status-page.ts",
			"server/services/git-status-page-protocol.ts",
			"server/services/git-status-page-parser.ts",
			"server/services/git-status-page-process.ts",
			"server/services/git-status-page-engine.ts",
			"server/services/git-status-page-worker.ts",
			"server/lib/compiled-worker.ts",
			"server/lib/logger.ts",
			"server/lib/narrafork-home.ts",
			"server/lib/worker-runtime/lifecycle.ts",
			"server/lib/worker-runtime/queue.ts",
			"server/lib/runtime-target.ts",
			"server/lib/platform-path.ts",
		];
		for (const path of copied) {
			const target = join(source, path);
			await mkdir(dirname(target), { recursive: true });
			await copyFile(join(project, path), target);
		}
		const probe = join(source, "server/probe.ts");
		await writeFile(
			probe,
			`import { GitStatusPageService } from "./services/git-status-page";
import { isCompiledRuntime } from "./lib/runtime-target";
const pages = new GitStatusPageService();
const root = Bun.argv[2];
const scope = { actorId: "compiled", workspaceKey: "workspace", queryKey: JSON.stringify(["local", root]) };
const source = { kind: "local" as const, cwd: root };
try {
 const cold = await pages.read({ scope, source, query: {} });
 if (cold.status !== "pending") throw new Error("cold cache must be pending");
 let sourceReads = 0;
 const readStats = async () => {
  sourceReads++;
  return { files: Array.from({ length: 562 }, (_, index) => ({ path: "files/file-" + String(index).padStart(4, "0") + ".txt", unstagedLinesAdded: sourceReads + 1, unstagedLinesRemoved: 1, complete: true })), linesAdded: 1124, linesRemoved: 562, complete: true };
 };
 await pages.observe({ queryKey: scope.queryKey, source, readStats });
 const first = await pages.read({ scope, source, query: {} });
 if (first.status !== "ready") throw new Error("expected ready page");
 let page = first;
 const snapshotId = page.snapshotId;
 if (page.files.length !== 100 || !page.hasMore) throw new Error("first page must stay bounded");
 const directory = { type: "directory" as const, section: "unstaged" as const, path: "files" };
 const measured = await pages.readStats({ scope, source, query: { snapshotId, rows: [directory] }, readStats });
 if (measured.status !== "ready" || measured.snapshotId !== snapshotId) throw new Error("statistics snapshot changed");
 const laterFile = await pages.readStats({ scope, source, query: { snapshotId, rows: [{ type: "file", section: "unstaged", path: "files/file-0561.txt" }] }, readStats });
 if (sourceReads !== 1 || laterFile.status !== "ready") throw new Error("measurement source not reused");
 pages.invalidateStats(scope.queryKey);
 await pages.observe({ queryKey: scope.queryKey, source, readStats });
 const refreshed = await pages.readStats({ scope, source, query: { snapshotId, rows: [directory] }, readStats });
 if (refreshed.status !== "ready") throw new Error("expected ready statistics");
 const paths = page.files.map(file => file.path);
 let pageCount = 1;
 while (page.nextCursor) {
  const next = await pages.read({ scope, source, query: { cursor: page.nextCursor } });
  if (next.status !== "ready" || next.snapshotId !== snapshotId) throw new Error("snapshot changed");
  page = next;
  paths.push(...page.files.map(file => file.path));
  pageCount++;
 }
 console.log(JSON.stringify({ compiled: isCompiledRuntime(), cwd: process.cwd(), pageCount, count: paths.length, unique: new Set(paths).size, complete: page.complete, totalFiles: page.counts.totalFiles, last: paths.at(-1), directoryAdded: measured.rows[0].added, directoryRemoved: measured.rows[0].removed, directoryComplete: measured.rows[0].complete, laterFileAdded: laterFile.rows[0].added, refreshedAdded: refreshed.rows[0].added, sourceReads }));
} finally { await pages.close(); }
`,
		);
		const binary = join(fixture, process.platform === "win32" ? "probe.exe" : "probe");
		await exec(
			process.execPath,
			[
				"build",
				probe,
				join(source, "server/services/git-status-page-worker.ts"),
				"--compile",
				"--minify",
				"--asset-naming=[dir]/[name].[ext]",
				"--outfile",
				binary,
			],
			{ ...childOptions, cwd: source },
		);
		await rm(source, { recursive: true, force: true });
		const repository = join(fixture, "repository");
		const cwd = join(fixture, "unrelated");
		await mkdir(repository);
		await mkdir(join(repository, "files"));
		await mkdir(cwd);
		await exec("git", ["init", "-q"], { ...childOptions, cwd: repository });
		await Promise.all(
			Array.from({ length: 562 }, (_, index) =>
				writeFile(join(repository, "files", `file-${String(index).padStart(4, "0")}.txt`), "x\n"),
			),
		);
		const { stdout } = await exec(binary, [repository], { ...childOptions, cwd });
		expect(JSON.parse(stdout.trim())).toEqual({
			compiled: true,
			cwd,
			pageCount: 6,
			count: 562,
			unique: 562,
			complete: true,
			totalFiles: 562,
			last: "files/file-0561.txt",
			directoryAdded: 1124,
			directoryRemoved: 562,
			directoryComplete: true,
			laterFileAdded: 2,
			refreshedAdded: 1686,
			sourceReads: 2,
		});
		// No runtime source file or application HOME was needed to serve the pages.
		expect(await readFile(join(repository, "files/file-0561.txt"), "utf8")).toBe("x\n");
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
}, 90_000);
