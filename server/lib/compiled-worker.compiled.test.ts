import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const project = resolve(import.meta.dir, "../..");

test("a main entry outside server/ misses the first $bunfs layout and loads the next one", async () => {
	const artifacts = await mkdtemp(join(tmpdir(), "nf-compiled-worker-"));
	const probe = join(project, `.compiled-worker-probe-${crypto.randomUUID()}.ts`);
	const binary = join(artifacts, "probe");
	try {
		await writeFile(
			probe,
			`import { compiledWorkerSpecifiers, connectCompiledWorker } from "./server/lib/compiled-worker";
const specifiers = compiledWorkerSpecifiers(
	"services/git-untracked-line-worker.ts",
	"./server/services/git-untracked-line-worker.ts",
	import.meta.url,
);
const attempts = [];
for (const specifier of specifiers) {
	try {
		const started = await connectCompiledWorker([specifier], { timeoutMs: 3000 });
		started.worker.postMessage({ action: "read", cwd: process.cwd(), paths: [], remainingBytes: 0, deadlineAt: Date.now() + 3000 });
		const message = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no reply")), 3000);
			started.worker.once("message", (value) => { clearTimeout(timer); resolve(value); });
			started.worker.once("error", (error) => { clearTimeout(timer); reject(error); });
		});
		await started.worker.terminate();
		attempts.push({ ok: true, specifier: started.specifier, message });
		break;
	} catch (error) {
		attempts.push({ ok: false, specifier, message: error instanceof Error ? error.message : String(error) });
	}
}
console.log(JSON.stringify({ specifiers, attempts }));
`,
		);
		await exec(
			process.execPath,
			[
				"build",
				probe,
				join(project, "server/services/git-untracked-line-worker.ts"),
				"--compile",
				"--minify",
				"--asset-naming=[dir]/[name].[ext]",
				"--outfile",
				binary,
			],
			{ cwd: project, timeout: 60_000, maxBuffer: 1024 * 1024 },
		);
		await rm(probe, { force: true });
		const { stdout } = await exec(binary, [], {
			cwd: artifacts,
			timeout: 20_000,
			maxBuffer: 1024 * 1024,
		});
		const result = JSON.parse(stdout.trim()) as {
			specifiers: string[];
			attempts: Array<{
				ok: boolean;
				specifier: string;
				message: string | { value?: { complete?: boolean } };
			}>;
		};
		expect(result.specifiers[0]).toContain("/services/git-untracked-line-worker.js");
		expect(result.attempts[0]?.ok).toBe(false);
		expect(String(result.attempts[0]?.message)).toContain(
			"Cannot find module '/$bunfs/root/services/git-untracked-line-worker.js'",
		);
		expect(result.attempts[1]?.ok).toBe(true);
		expect(result.attempts[1]?.specifier).toContain(
			"/server/services/git-untracked-line-worker.js",
		);
		expect(result.attempts[1]?.message).toMatchObject({ value: { complete: true, files: [] } });
	} finally {
		await rm(probe, { force: true });
		await rm(artifacts, { recursive: true, force: true });
	}
}, 90_000);
