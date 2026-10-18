import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import iconv from "iconv-lite";
import { testEnvironment } from "../../tests/preload";
import { safeSpawn } from "../lib/spawn";

test("compiled binary embeds both reusable raw source workers and codecs outside the source checkout", async () => {
	const root = await mkdtemp(join(testEnvironment.isolatedHome, "raw-compiled-"));
	try {
		const source = join(root, "source.txt"),
			binary = join(root, process.platform === "win32" ? "raw-smoke.exe" : "raw-smoke");
		const build = await safeSpawn({
			cmd: [
				process.execPath,
				"build",
				"--compile",
				"./server/editor-raw-smoke.fixture.ts",
				"./server/services/editor-document-stream-worker.ts",
				"./server/services/editor-document-worker.ts",
				"--outfile",
				binary,
			],
			cwd: resolve(import.meta.dir, "../.."),
			timeout: 60000,
			maxOutputBytes: 65536,
		});
		if (build.exitCode)
			throw new Error(`Compiled worker build failed: ${build.stderr || build.stdout}`);
		for (const scenario of ["utf-8", "utf-16be", "gbk", "gb18030", "large"] as const) {
			const encoding = scenario === "large" ? "utf-8" : scenario;
			const text =
				encoding === "gbk"
					? "compiled raw\r\n中文\r尾\n"
					: "\ufeffcompiled raw\r\n中文😀\r\ufeff\n";
			const bytes =
				scenario === "large" ? Buffer.alloc(20 * 1024 * 1024, 65) : iconv.encode(text, encoding);
			await writeFile(source, bytes);
			const run = await safeSpawn({
				cmd: [binary, source, encoding],
				cwd: root,
				env: { ...process.env, HOME: root, NARRAFORK_HOME: join(root, "home") },
				timeout: 15000,
				maxOutputBytes: 65536,
			});
			if (run.exitCode)
				throw new Error(`Compiled worker smoke failed: ${run.stderr || run.stdout}`);
			const result = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "");
			expect(result.compiled).toBe(true);
			expect(result.hashKind).toBe("raw-sha256");
			expect(result.encoding).toBe(encoding);
			expect(result.bytes).toBe(bytes.length);
			expect(result.sealed.bytes).toBe(bytes.length);
			expect(result.sealed.kind).toBe("sealed");
			expect(result.counters).toHaveLength(2);
			expect(result.counters.every((value: { fds: number }) => value.fds === 0)).toBe(true);
			expect(result.admission.active).toBe(0);
			console.info("compiled-raw-worker-smoke", run.stdout.trim());
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 90000);
