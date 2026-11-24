import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { compiledWorkerBuildEntrypoints } from "../lib/compiled-worker";

const exec = promisify(execFile);
const project = resolve(import.meta.dir, "../..");
const options = { timeout: 60_000, maxBuffer: 1_048_576 };

test("compiled staging Worker preserves ownership snapshots and commits without source files", async () => {
	expect(compiledWorkerBuildEntrypoints()).toContain("./server/services/git-staging-worker.ts");
	const fixture = await mkdtemp(join(tmpdir(), "narrafork-staging-compiled-"));
	try {
		const source = join(fixture, "source");
		for (const path of [
			"shared/git-staging-lists.ts",
			"server/services/git-staging-kernel.ts",
			"server/services/git-changelist-store.ts",
			"server/services/git-changelist-observer.ts",
			"server/services/git-changelist-ownership.ts",
			"server/services/git-changelist-commit.ts",
			"server/services/git-staging-stats.ts",
			"server/services/git-staging-unit-diff.ts",
			"server/services/git-staging-worker.ts",
			"server/services/git-staging-process.ts",
			"server/services/git-status-page-process.ts",
			"server/lib/compiled-worker.ts",
			"server/lib/worker-runtime/lifecycle.ts",
			"server/lib/runtime-target.ts",
			"server/lib/platform-path.ts",
		]) {
			const target = join(source, path);
			await mkdir(dirname(target), { recursive: true });
			await copyFile(join(project, path), target);
		}
		await symlink(join(project, "node_modules"), join(source, "node_modules"), "dir");
		const harness = join(source, "server/probe.ts");
		await writeFile(
			harness,
			`import { compiledWorkerSpecifiers, connectCompiledWorker } from "./lib/compiled-worker";
import { isCompiledRuntime } from "./lib/runtime-target";
const cwd = Bun.argv[2];
async function call(method, request?, listId?) {
 const { worker } = await connectCompiledWorker(compiledWorkerSpecifiers("services/git-staging-worker.ts", "./services/git-staging-worker.ts", import.meta.url));
 try {
  return await new Promise((resolve, reject) => {
   worker.on("message", message => {
    if (message.action === "result") resolve(message.value);
    else if (message.action === "error") reject(new Error(message.code + ": " + message.message));
   });
   worker.once("error", reject);
   worker.postMessage({ action: "execute", method, request, listId, options: {}, cwd, workspaceKey: "compiled", taskId: "compiled-task" });
  });
 } finally { await worker.terminate(); }
}
const initial = await call("summary");
const initialBaseline = await call("baseline");
if (initial.lists.length) throw new Error("Unexpected initial lists");
if (JSON.stringify(initialBaseline) !== JSON.stringify({ initialized: false, generation: 0, observationId: null, state: "uninitialized" })) throw new Error("Unexpected initial baseline");
await call("action", { action: "init" });
const summary = await call("summary");
const baseline = await call("baseline");
if (JSON.stringify(baseline) !== JSON.stringify({ initialized: summary.initialized, generation: summary.generation, observationId: summary.observationId, state: summary.state })) throw new Error("Compiled baseline differs from summary");
const listId = summary.activeListId;
const page = await call("files", undefined, listId);
const result = await call("action", { action: "commit", listId, expectedGeneration: summary.generation, observationId: summary.observationId, message: "compiled group", identity: { name: "Compiled fixture", email: "compiled@example.test" } });
const cleared = await call("files", undefined, listId);
console.log(JSON.stringify({ compiled: isCompiledRuntime(), outcome: result.outcome, count: page.files.length, path: page.files[0].path, cleared: cleared.files.length, commitLength: result.commitOid.length }));
`,
		);
		const binary = join(fixture, process.platform === "win32" ? "probe.exe" : "probe");
		await exec(
			process.execPath,
			[
				"build",
				harness,
				join(source, "server/services/git-staging-worker.ts"),
				"--compile",
				"--minify",
				"--asset-naming=[dir]/[name].[ext]",
				"--outfile",
				binary,
			],
			{ ...options, cwd: source },
		);
		await rm(source, { recursive: true, force: true });
		const repository = join(fixture, "repository");
		const unrelated = join(fixture, "unrelated");
		await mkdir(repository);
		await mkdir(unrelated);
		await exec("git", ["init", "--quiet", "--initial-branch=main"], {
			...options,
			cwd: repository,
		});
		await exec("git", ["config", "commit.gpgSign", "false"], { ...options, cwd: repository });
		await writeFile(join(repository, "f"), "1\n");
		const { stdout } = await exec(binary, [repository], { ...options, cwd: unrelated });
		expect(JSON.parse(stdout.trim())).toEqual({
			compiled: true,
			outcome: "applied",
			count: 1,
			path: "f",
			cleared: 0,
			commitLength: 40,
		});
		expect(await readFile(join(repository, "f"), "utf8")).toBe("1\n");
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
}, 90_000);
