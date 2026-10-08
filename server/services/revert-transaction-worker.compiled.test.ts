import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dir, "../..");
const manifestEntry = "./server/services/revert-transaction-manifest-worker.ts";
const mainEntry = "./server/index.ts";
const maxBuffer = 1024 * 1024;

/** Read actual compile arguments, not a comment that merely mentions the entry. */
async function productionCompileArguments(): Promise<string[]> {
	const source = await readFile(join(root, "scripts/build-cross-platform.ts"), "utf8");
	const command = source.match(/const compile = await runBuildStep\(\s*\[([\s\S]*?)\]\s*,?\s*\)/);
	if (!command) throw new Error("Production Bun compile argument array was not found");
	const withoutComments = command[1].replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "");
	expect(withoutComments).toMatch(/^\s*process\.execPath\s*,/);
	const { stdout } = await execFileAsync(
		process.execPath,
		["--eval", "process.stdout.write(Bun.version)"],
		{
			timeout: 10_000,
			maxBuffer: 1024,
		},
	);
	expect(stdout).toBe(Bun.version);
	return [
		process.execPath,
		...[...withoutComments.matchAll(/"([^"\r\n]+)"/g)].map((match) => match[1]),
	];
}

// This fixture imports the real runner, never a mocked worker or a database singleton.
// The type-only protocol import is deliberately erased; it cannot embed the missing entry.
const probeSource = `
import {
	RevertTransactionError,
	runRevertManifestWorker,
	revertManifestWorkerSpecifiers,
} from "../services/revert-transaction-worker";
import { isCompiledRuntime } from "../lib/runtime-target";
import type { TransactionManifestRequest } from "../services/revert-transaction-manifest-worker";

async function compare(current: unknown) {
	try {
		return {
			ok: true,
			value: await runRevertManifestWorker<boolean>(
				{ action: "compare", fixed: { selection: ["fixed"] }, current } as TransactionManifestRequest,
				new AbortController().signal,
			),
		};
	} catch (error) {
		if (!(error instanceof RevertTransactionError)) throw error;
		// Public error fields only; server-side diagnostic stacks are not an API response.
		return {
			ok: false,
			error: {
				...error,
				name: error.name,
				message: error.message,
			},
		};
	}
}
console.log(JSON.stringify({
	compiled: isCompiledRuntime(),
	moduleUrl: import.meta.url,
	specifiers: revertManifestWorkerSpecifiers(),
	cwd: process.cwd(),
	home: process.env.NARRAFORK_HOME,
	equal: await compare({ selection: ["fixed"] }),
	stale: await compare({ selection: ["/private/selection-canary"] }),
}));
`;

interface ProbeResult {
	compiled: boolean;
	moduleUrl: string;
	specifiers: string[];
	cwd: string;
	home: string;
	equal: unknown;
	stale: unknown;
}

function refusal(code: string) {
	return {
		ok: false,
		error: {
			name: "RevertTransactionError",
			statusCode: 409,
			code: `REVERT_TRANSACTION_${code}`,
			message: `Local revert transaction refused: ${code}`,
		},
	};
}

function assertNoPublicPaths(value: unknown, privatePaths: string[]) {
	const serialized = JSON.stringify(value);
	for (const path of privatePaths) expect(serialized).not.toContain(path);
	expect(serialized).not.toMatch(/file:|\$bunfs|~BUN|%7EBUN|[A-Za-z]:[\\/]/i);
	expect(serialized).not.toContain("/private/selection-canary");
	expect(serialized).not.toContain("revert-transaction-manifest-worker");
}

describe("revert manifest worker in a real compiled executable", () => {
	test("production compilation registers the manifest worker as an executable entry", async () => {
		const args = await productionCompileArguments();
		expect(args.slice(0, 3)).toEqual([process.execPath, "build", mainEntry]);
		expect(args).toContain("--compile");
		expect(args).toContain("--minify");
		expect(args.slice(2, args.indexOf("--compile"))).toContain(manifestEntry);
	});

	test("minified binaries compare outside the source cwd and fail safely if the worker is omitted", async () => {
		// tests/preload.ts owns this isolation; all children inherit it unchanged.
		expect(process.env.NARRAFORK_TEST).toBe("1");
		const isolatedHome = process.env.NARRAFORK_HOME;
		if (!isolatedHome) throw new Error("tests/preload.ts must isolate NARRAFORK_HOME");
		const args = await productionCompileArguments();
		const entries = args.slice(2, args.indexOf("--compile"));
		expect(entries).toContain(manifestEntry);
		const cleanup: string[] = [];
		try {
			// Keep the entry common root at server/, matching index.ts + production workers.
			const sourceDir = await mkdtemp(join(root, "server/.revert-compiled-probe-"));
			cleanup.push(sourceDir);
			const artifacts = await mkdtemp(join(tmpdir(), "narrafork-revert-compiled-"));
			cleanup.push(artifacts);
			const cwd = join(artifacts, "empty-cwd");
			await mkdir(cwd);
			const probe = join(sourceDir, "probe.ts");
			await writeFile(probe, probeSource);
			const suffix = process.platform === "win32" ? ".exe" : "";
			const complete = join(artifacts, `with-worker${suffix}`);
			const missing = join(artifacts, `without-worker${suffix}`);
			for (const [binary, includeManifest] of [
				[complete, true],
				[missing, false],
			] as const) {
				await execFileAsync(
					process.execPath,
					[
						"build",
						probe,
						...entries.filter(
							(entry) => entry !== mainEntry && (includeManifest || entry !== manifestEntry),
						),
						"--root",
						join(root, "server"),
						"--compile",
						"--minify",
						"--asset-naming=[dir]/[name].[ext]",
						"--external=electron",
						"--outfile",
						binary,
					],
					{ cwd: root, env: { ...process.env }, timeout: 60_000, maxBuffer },
				);
			}
			// Neither executable can load the original probe; cwd has no source or node_modules.
			await rm(sourceDir, { recursive: true, force: true });
			expect(await readdir(cwd)).toEqual([]);
			const results: ProbeResult[] = [];
			for (const binary of [complete, missing]) {
				const { stdout } = await execFileAsync(binary, [], {
					cwd,
					env: { ...process.env },
					timeout: 20_000,
					maxBuffer,
				});
				const result = JSON.parse(stdout.trim()) as ProbeResult;
				expect(result.compiled).toBe(true);
				expect(result.moduleUrl).toMatch(/\$bunfs\/|%7EBUN\/|~BUN\//i);
				expect(
					result.specifiers.some((entry) =>
						entry.endsWith("/services/revert-transaction-manifest-worker.js"),
					),
				).toBe(true);
				expect(result.cwd).toBe(cwd);
				expect(result.home).toBe(isolatedHome);
				for (const specifier of result.specifiers) {
					expect(specifier).toMatch(/\$bunfs\/|%7EBUN\/|~BUN\//i);
					expect(specifier).not.toContain(root);
				}
				assertNoPublicPaths(
					[result.equal, result.stale],
					[root, sourceDir, artifacts, result.home],
				);
				results.push(result);
			}
			expect(results[0].equal).toEqual({ ok: true, value: true });
			expect(results[0].stale).toEqual(refusal("SELECTION_STALE"));
			expect(results[1].equal).toEqual(refusal("MANIFEST_WORKER_FAILED"));
			expect(results[1].stale).toEqual(refusal("MANIFEST_WORKER_FAILED"));
		} finally {
			await Promise.all(cleanup.map((path) => rm(path, { recursive: true, force: true })));
		}
	}, 180_000);
});
