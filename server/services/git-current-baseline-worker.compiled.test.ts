import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { compiledWorkerBuildEntrypoints } from "../lib/compiled-worker";

const exec = promisify(execFile);
const project = resolve(import.meta.dir, "../..");
const workerEntry = "./server/services/git-current-baseline-worker.ts";

test("baseline worker static initialization graph stays independent of application settings", async () => {
	const scanner = new Bun.Transpiler({ loader: "ts" });
	const visited = new Set<string>();
	async function visit(path: string): Promise<void> {
		if (visited.has(path)) return;
		visited.add(path);
		const source = await readFile(path, "utf8");
		for (const dependency of scanner.scanImports(source)) {
			// The exceptional POSIX-backslash backend remains lazy, not startup work.
			if (dependency.kind !== "import-statement") continue;
			if (dependency.path.startsWith("node:") || dependency.path.startsWith("bun:")) continue;
			const next = Bun.resolveSync(dependency.path, dirname(path));
			expect(next).not.toMatch(/[/\\](settings|model-catalog)([/\\.]|$)/);
			if (next.endsWith(".ts")) await visit(next);
		}
	}
	await visit(resolve(project, workerEntry));
	expect([...visited]).toContain(join(project, "server/services/file-change-local-identity.ts"));
	expect([...visited]).not.toContain(join(project, "server/services/file-change-local-io.ts"));
});

test("baseline worker snapshots in source and minified production layout outside source cwd", async () => {
	expect(compiledWorkerBuildEntrypoints()).toContain(workerEntry);
	const sourceDir = await mkdtemp(join(project, "server/.baseline-compiled-probe-"));
	const artifacts = await mkdtemp(join(tmpdir(), "nf-baseline-compiled-"));
	try {
		const workspace = join(artifacts, "workspace");
		const cwd = join(artifacts, "empty-cwd");
		await mkdir(workspace);
		await mkdir(cwd);
		await exec("git", ["init", "--quiet", workspace], { timeout: 10_000, maxBuffer: 8192 });
		await writeFile(join(workspace, "sample.txt"), "worker snapshot\n");
		const probe = join(sourceDir, "probe.ts");
		await writeFile(
			probe,
			`
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../lib/compiled-worker";
const specifiers = compiledWorkerSpecifiers("services/git-current-baseline-worker.ts", "../services/git-current-baseline-worker.ts", import.meta.url);
const measurements = [];
for (let i = 0; i < 5; i++) {
	const begin = performance.now();
	const { worker, specifier } = await connectCompiledWorker(specifiers, { signal: AbortSignal.timeout(10000) });
	const readyMs = performance.now() - begin;
	try {
		const beginSnapshot = performance.now();
		const result = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("snapshot timeout")), 10000);
			worker.once("message", value => { clearTimeout(timer); resolve(value); });
			worker.once("error", error => { clearTimeout(timer); reject(error); });
			worker.postMessage({ action: "snapshot", workspacePath: process.argv[2], privateRoot: process.argv[3] });
		});
		measurements.push({ readyMs, snapshotMs: performance.now() - beginSnapshot, specifier, result });
	} finally { await worker.terminate(); }
}
console.log(JSON.stringify(measurements));
`,
		);
		const binary = join(artifacts, process.platform === "win32" ? "probe.exe" : "probe");
		await exec(
			process.execPath,
			[
				"build",
				probe,
				workerEntry,
				"--compile",
				"--minify",
				"--asset-naming=[dir]/[name].[ext]",
				"--outfile",
				binary,
			],
			{ cwd: project, timeout: 90_000, maxBuffer: 1024 * 1024 },
		);
		for (const compiled of [false, true]) {
			const { stdout, stderr } = await exec(
				compiled ? binary : process.execPath,
				[...(compiled ? [] : [probe]), workspace, join(artifacts, "blobs")],
				{ cwd, timeout: 60_000, maxBuffer: 1024 * 1024 },
			);
			expect(stderr).toBe("");
			const rows = JSON.parse(stdout.trim()) as Array<{
				readyMs: number;
				snapshotMs: number;
				specifier: string;
				result: {
					error?: string;
					value: {
						clean: boolean;
						files: Array<{ filePath: string; worktreeState: { kind: string } }>;
					};
				};
			}>;
			expect(rows).toHaveLength(5);
			for (const row of rows) {
				expect(row.result.error).toBeUndefined();
				expect(row.result.value.clean).toBe(false);
				expect(row.result.value.files).toEqual([
					expect.objectContaining({
						filePath: "sample.txt",
						worktreeState: expect.objectContaining({ kind: "regular" }),
					}),
				]);
				if (compiled) expect(row.specifier).toMatch(/\/services\/git-current-baseline-worker\.js$/);
			}
			console.log(
				JSON.stringify({
					mode: compiled ? "compiled" : "source",
					bun: Bun.version,
					measurements: rows.map(({ readyMs, snapshotMs }) => ({ readyMs, snapshotMs })),
				}),
			);
		}
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(artifacts, { recursive: true, force: true });
	}
}, 180_000);
