import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BuildProfileEnvironment, resolveBuildProfile } from "../../scripts/lib/build-profile";
import { runCiBuildCommand } from "../../scripts/lib/ci-build-strict";
import { safeSpawn } from "../../server/lib/spawn";

const root = resolve(import.meta.dir, "../..");
const diagnosticArgs = ["--keep-names", "--sourcemap", "--minify-syntax", "--minify-whitespace"];

function profile(version: string, env: BuildProfileEnvironment = {}) {
	return resolveBuildProfile(version, env);
}

describe("backend build profiles", () => {
	test("local valid alpha versions retain diagnostic names and maps", () => {
		for (const version of [
			"0.9.10-alpha",
			"0.9.10-alpha.0",
			"0.9.10-alpha.9",
			"1.2.3-alpha.preview-1+build.01",
		]) {
			const selected = profile(version);
			expect(selected.name).toBe("diagnostic");
			expect(selected.compileArgs).toEqual(diagnosticArgs);
			expect(Object.isFrozen(selected)).toBe(true);
			expect(Object.isFrozen(selected.compileArgs)).toBe(true);
		}
	});

	test("non-alpha and malformed semver versions keep release compilation", () => {
		for (const version of [
			"1.2.3",
			"1.2.3-beta.1",
			"1.2.3-beta.alpha",
			"1.2.3-alphabet.1",
			"1.2.3-Alpha.1",
			"01.2.3-alpha.1",
			"1.02.3-alpha.1",
			"1.2.03-alpha.1",
			"1.2.3-alpha.01",
			"1.2.3-alpha..1",
			"1.2.3-alpha.1+",
			"v1.2.3-alpha.1",
			" 1.2.3-alpha.1",
			"1.2.3-alpha.1\n",
			"1.2-alpha.1",
			"",
		]) {
			expect(profile(version).name).toBe("release");
			expect(profile(version).compileArgs).toEqual(["--minify"]);
		}
	});

	test("CI, Actions and release context share normalized on/off rules", () => {
		for (const key of ["CI", "GITHUB_ACTIONS", "NF_BUILD_RELEASE_CONTEXT"] as const) {
			for (const value of [undefined, "", " ", "false", " FALSE ", "0", " 0 "]) {
				expect(profile("1.2.3-alpha.1", { [key]: value }).name).toBe("diagnostic");
			}
			for (const value of ["1", "true", " TRUE ", "yes", "enabled"]) {
				expect(profile("1.2.3-alpha.1", { [key]: value }).compileArgs).toEqual(["--minify"]);
			}
		}
		expect(profile("1.2.3-alpha.1", { CI: "false", GITHUB_ACTIONS: "1" }).name).toBe("release");
		expect(profile("1.2.3-alpha.1", { CI: "0", NF_BUILD_RELEASE_CONTEXT: "1" }).name).toBe(
			"release",
		);
	});

	test("formal entry freezes one shared profile independently of strict validation", async () => {
		const source = await readFile(join(root, "scripts/build-cross-platform.ts"), "utf8");
		expect(source).toContain("resolveBuildProfile(VERSION, process.env)");
		expect(source).toContain('const releaseCi = args.includes("--release-ci")');
		expect(source).toContain(
			"validateCiBuildIdentity(pkg.packageManager, Bun.version, commitHash)",
		);
		expect(source).toContain('"./server/index.ts"');
		expect(source).toContain("...compiledWorkerBuildEntrypoints()");
		expect(source).toContain("...BUILD_PROFILE.compileArgs");
		expect(source).not.toContain('releaseCi ? ["--minify"]');
		expect(source).toContain("JSON.stringify(command)");
	});

	test("release child overrides inherited context after spreading the environment", async () => {
		const source = await readFile(join(root, "scripts/release.ts"), "utf8");
		expect(source).toMatch(
			/env:\s*\{\s*\.\.\.process\.env,[\s\S]*?NF_BUILD_RELEASE_CONTEXT:\s*"1"/,
		);
	});

	test("strict subprocesses inherit environment set by the build entry", async () => {
		const key = "NF_TEST_BUILD_CONTEXT";
		const previous = process.env[key];
		try {
			process.env[key] = "diagnostic";
			await runCiBuildCommand([
				process.execPath,
				"-e",
				'if (process.env.NF_TEST_BUILD_CONTEXT !== "diagnostic") process.exit(1)',
			]);
		} finally {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		}
	});
});

const mainSource = `import { Worker } from "node:worker_threads";
function diagnosticMainFailure() {
 throw new Error("diagnostic-main-error");
}
class DiagnosticFixtureClass {}
function diagnosticHotFunction(milliseconds: number) {
 const deadline = performance.now() + milliseconds;
 let value = 0;
 while (performance.now() < deadline) {
  for (let index = 0; index < 10000; index++) value = (Math.imul(value + index, 1664525) + 1013904223) | 0;
 }
 return value;
}
let mainStack = "";
try { diagnosticMainFailure(); } catch (error) { mainStack = (error as Error).stack ?? ""; }
const workerUrl = new URL("./diagnostic-worker.js", import.meta.url);
const workerPath = process.platform === "win32" ? decodeURIComponent(workerUrl.pathname.slice(1)) : workerUrl;
const worker = new Worker(workerPath);
const workerResult = await new Promise((resolve, reject) => {
 const timer = setTimeout(() => { void worker.terminate(); reject(new Error("fixture worker timeout")); }, 5000);
 worker.once("message", (message) => { clearTimeout(timer); resolve(message); });
 worker.once("error", (error) => { clearTimeout(timer); reject(error); });
 worker.once("exit", (code) => { clearTimeout(timer); if (code !== 0) reject(new Error("fixture worker failed")); });
});
await worker.terminate();
const value = diagnosticHotFunction(400);
console.log(JSON.stringify({ functionName: diagnosticMainFailure.name, className: DiagnosticFixtureClass.name, hotName: diagnosticHotFunction.name, mainStack, worker: workerResult, value }));
`;
const workerSource = `import { parentPort } from "node:worker_threads";
function diagnosticWorkerFailure() {
 throw new Error("diagnostic-worker-error");
}
class DiagnosticWorkerClass {}
let stack = "";
try { diagnosticWorkerFailure(); } catch (error) { stack = (error as Error).stack ?? ""; }
parentPort?.postMessage({ functionName: diagnosticWorkerFailure.name, className: DiagnosticWorkerClass.name, stack });
`;

test("compiled diagnostic main and worker retain names, original stack lines and sampled hot frames", async () => {
	const directory = await mkdtemp(join(tmpdir(), "nf-build-profile-"));
	const home = join(directory, "home");
	const appHome = join(directory, "data");
	const temporary = join(directory, "tmp");
	const profiles = join(directory, "profiles");
	try {
		for (const path of [home, appHome, temporary, profiles]) await mkdir(path, { mode: 0o700 });
		const env = {
			PATH: process.env.PATH,
			HOME: home,
			NARRAFORK_HOME: appHome,
			NARRAFORK_ALLOW_MULTIPLE: "1",
			TMPDIR: temporary,
			TMP: temporary,
			TEMP: temporary,
		};
		const entry = join(directory, "diagnostic-main.ts");
		const worker = join(directory, "diagnostic-worker.ts");
		const binary = join(directory, process.platform === "win32" ? "fixture.exe" : "fixture");
		await writeFile(entry, mainSource, { flag: "wx" });
		await writeFile(worker, workerSource, { flag: "wx" });
		const compiled = await safeSpawn({
			cmd: [
				process.execPath,
				"build",
				entry,
				worker,
				"--compile",
				...profile("1.2.3-alpha.1").compileArgs,
				"--asset-naming=[dir]/[name].[ext]",
				"--outfile",
				binary,
			],
			cwd: directory,
			env,
			timeout: 60_000,
			maxOutputBytes: 256 * 1024,
		});
		expect(compiled.exitCode, compiled.stderr).toBe(0);
		expect(compiled.stdoutTruncated || compiled.stderrTruncated).toBe(false);
		// Prove the executable uses embedded mappings without adjacent map/source files.
		for (const name of await readdir(directory)) {
			if (name.endsWith(".map") || name.endsWith(".ts")) await rm(join(directory, name));
		}
		const result = await safeSpawn({
			cmd: [binary],
			cwd: directory,
			env: {
				...env,
				BUN_OPTIONS: "--cpu-prof --cpu-prof-dir=profiles --cpu-prof-name=diagnostic.cpuprofile",
			},
			timeout: 15_000,
			maxOutputBytes: 64 * 1024,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdoutTruncated || result.stderrTruncated).toBe(false);
		const output = JSON.parse(result.stdout.trim());
		expect(output.functionName).toBe("diagnosticMainFailure");
		expect(output.className).toBe("DiagnosticFixtureClass");
		expect(output.hotName).toBe("diagnosticHotFunction");
		expect(output.worker.functionName).toBe("diagnosticWorkerFailure");
		expect(output.worker.className).toBe("DiagnosticWorkerClass");
		const mainLine =
			mainSource
				.split("\n")
				.findIndex((line) => line.includes('throw new Error("diagnostic-main-error")')) + 1;
		const workerLine =
			workerSource
				.split("\n")
				.findIndex((line) => line.includes('throw new Error("diagnostic-worker-error")')) + 1;
		expect(output.mainStack).toContain(`diagnostic-main.ts:${mainLine}:`);
		expect(output.worker.stack).toContain(`diagnostic-worker.ts:${workerLine}:`);
		const cpu = JSON.parse(await readFile(join(profiles, "diagnostic.cpuprofile"), "utf8")) as {
			nodes: { id: number; callFrame: { functionName: string } }[];
			samples: number[];
			timeDeltas: number[];
		};
		expect(cpu.samples.length).toBeGreaterThan(0);
		expect(cpu.timeDeltas.length).toBe(cpu.samples.length);
		const hotIds = new Set(
			cpu.nodes
				.filter((node) => node.callFrame.functionName === "diagnosticHotFunction")
				.map((node) => node.id),
		);
		expect(hotIds.size).toBeGreaterThan(0);
		expect(cpu.samples.some((id) => hotIds.has(id))).toBe(true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 90_000);
