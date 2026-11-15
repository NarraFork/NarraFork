import { randomUUID } from "node:crypto";
import { chmod, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getNarraforkHome } from "../server/lib/narrafork-home";
import { MAX_RELEASE_BINARY_BYTES } from "../shared/release-patch";
import { runRuntimeBuildCommand } from "./lib/runtime-build-process";

const REPO_ROOT = resolve(import.meta.dir, "..");
const COMPILER = fileURLToPath(new URL("./lib/runtime-compiler.ts", import.meta.url));

export interface RuntimeBuild {
	executable: string;
	buildId: string;
	bytes: number;
	elapsedMs: number;
}

/** Build only. Never starts the application, migrates a database or reuses a stale artifact. */
export async function buildRuntime(
	options: { root?: string; frontend?: boolean; signal?: AbortSignal; home?: string } = {},
): Promise<RuntimeBuild> {
	const started = performance.now();
	options.signal?.throwIfAborted();
	const root = await realpath(options.root ?? REPO_ROOT);
	if (options.frontend && !(await Bun.file(join(root, "dist/frontend/index.html")).exists())) {
		throw new Error(
			"Frontend assets are missing. Run bun run build before start/build:runtime --frontend.",
		);
	}
	const home = resolve(options.home ?? getNarraforkHome());
	await mkdir(home, { recursive: true, mode: 0o700 });
	const runtime = join(await realpath(home), "runtime");
	await mkdir(runtime, { recursive: true, mode: 0o700 });
	const buildId = randomUUID();
	const directory = join(await realpath(runtime), buildId);
	// Exclusive directory creation is the publication boundary; never overwrite an existing build.
	await mkdir(directory, { mode: 0o700 });
	const executable = join(directory, process.platform === "win32" ? "narrafork.exe" : "narrafork");
	const temporary = join(directory, process.platform === "win32" ? ".building.exe" : ".building");
	try {
		await runRuntimeBuildCommand(
			[
				process.execPath,
				"--no-install",
				COMPILER,
				root,
				temporary,
				buildId,
				String(!!options.frontend),
			],
			{ cwd: root, signal: options.signal, env: { NARRAFORK_HOME: home } },
		);
		options.signal?.throwIfAborted();
		const file = await stat(temporary);
		if (!file.isFile() || file.size <= 0 || file.size > MAX_RELEASE_BINARY_BYTES) {
			throw new Error("Runtime executable is missing or exceeds the release binary byte limit");
		}
		await chmod(temporary, 0o555);
		await rename(temporary, executable);
		const result = {
			executable,
			buildId,
			bytes: file.size,
			elapsedMs: Math.round(performance.now() - started),
		};
		await writeFile(
			join(directory, "build.json"),
			`${JSON.stringify({ ...result, frontend: !!options.frontend }, null, 2)}\n`,
			{ flag: "wx", mode: 0o444 },
		);
		options.signal?.throwIfAborted();
		// Successful artifacts have no automatic GC: an older process may still be using them.
		return result;
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

if (import.meta.main) {
	const controller = new AbortController();
	const cancel = () => controller.abort(new Error("Runtime build cancelled"));
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	try {
		const args = process.argv.slice(2);
		if (args.some((arg) => arg !== "--frontend")) {
			throw new Error("Usage: bun scripts/build-runtime.ts [--frontend]");
		}
		const result = await buildRuntime({
			frontend: args.includes("--frontend"),
			signal: controller.signal,
		});
		console.log(`Built runtime ${result.buildId}: ${result.bytes} bytes in ${result.elapsedMs} ms`);
		console.log(
			`Reuse: bun run ${args.includes("--frontend") ? "start" : "start:dev"} --runtime=${JSON.stringify(result.executable)}`,
		);
		console.log(
			`Retained at ${dirname(result.executable)} (remove only after confirming it is unused)`,
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
}
