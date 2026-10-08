import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(import.meta.dir, "../../../..");
const workerEntry = "./server/lib/browser/memory-snapshot-worker.ts";

test("production compile arguments register snapshot worker", async () => {
	const source = await readFile(join(root, "scripts/build-cross-platform.ts"), "utf8");
	const command = source.match(/const compile = await runBuildStep\(\s*\[([\s\S]*?)\]\s*,?\s*\)/);
	expect(command).not.toBeNull();
	const args = command?.[1].replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "") ?? "";
	expect(args).toMatch(/^\s*process\.execPath\s*,\s*"build"\s*,/);
	const { stdout } = await execute(
		process.execPath,
		["--eval", "process.stdout.write(Bun.version)"],
		{
			timeout: 10_000,
			maxBuffer: 1024,
		},
	);
	expect(stdout).toBe(Bun.version);
	expect(args).toContain(`"${workerEntry}"`);
});

test("real minified compiled binary loads worker outside source cwd; omitted entry fails safely", async () => {
	const sourceDir = await mkdtemp(join(root, "server/.snapshot-compiled-probe-"));
	const artifacts = await mkdtemp(join(tmpdir(), "nf-snapshot-compiled-"));
	try {
		const probe = join(sourceDir, "probe.ts");
		await writeFile(
			probe,
			`
import { exportHeapSnapshot } from "../lib/browser/memory-snapshot";
import { isCompiledRuntime } from "../lib/runtime-target";
try {
 await exportHeapSnapshot({wsEndpoint:"bad-endpoint-private-canary",targetId:"precise-id",savePath:${JSON.stringify(join(artifacts, "never.heapsnapshot"))},maxBytes:1024,timeoutMs:5000,collectGarbage:false,signal:new AbortController().signal});
 throw new Error("expected refusal");
} catch(error) {
 console.log(JSON.stringify({compiled:isCompiledRuntime(),message:error.message,stage:error.stage}));
}
`,
		);
		const binaries: string[] = [];
		for (const includeWorker of [true, false]) {
			const binary = join(
				artifacts,
				`${includeWorker ? "complete" : "missing"}${process.platform === "win32" ? ".exe" : ""}`,
			);
			await execute(
				process.execPath,
				[
					"build",
					probe,
					...(includeWorker ? [workerEntry] : []),
					"--root",
					join(root, "server"),
					"--compile",
					"--minify",
					"--asset-naming=[dir]/[name].[ext]",
					"--outfile",
					binary,
				],
				{ cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024 },
			);
			binaries.push(binary);
		}
		await rm(sourceDir, { recursive: true, force: true });
		for (let index = 0; index < binaries.length; index++) {
			const { stdout } = await execute(binaries[index], [], {
				cwd: artifacts,
				timeout: 15_000,
				maxBuffer: 1024 * 1024,
			});
			const result = JSON.parse(stdout.trim());
			expect(result.compiled).toBe(true);
			expect(result.stage).toBe(index === 0 ? "connect" : "startup");
			expect(result.message).toBe(`Heap snapshot failed (${result.stage})`);
			expect(stdout).not.toContain("canary");
		}
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(artifacts, { recursive: true, force: true });
	}
}, 120_000);
