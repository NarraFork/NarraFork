import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { launch } from "puppeteer-core";
import { PROFILE_LIMITS } from "../memory-profile-constants";
import type { MemoryProfileRequest, MemoryProfileWorkerReply } from "../memory-profile-types";

const execute = promisify(execFile);
const root = resolve(import.meta.dir, "../../../..");
const workerEntry = "./server/lib/browser/memory-profile-worker.ts";

test("production compile command includes the profile worker entry", async () => {
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

test("minified compiled worker is present outside source cwd, closes port; omission fails safely", async () => {
	const sourceDir = await mkdtemp(join(root, "server/.profile-compiled-probe-"));
	const artifacts = await mkdtemp(join(tmpdir(), "nf-profile-compiled-"));
	try {
		const probe = join(sourceDir, "probe.ts");
		await writeFile(
			probe,
			`
import { Worker } from "node:worker_threads";
import { isCompiledRuntime } from "../lib/runtime-target";
const request = JSON.parse(process.argv[2]);
async function spawn(specifier) {
 return new Promise((resolve) => {
  const worker = new Worker(new URL(specifier, import.meta.url));
  let reply, ready = false, workerError = false;
  const started = performance.now();
  const phases = [];
  const diagnostics = () => ({ workerError, phases, elapsedMs: Math.round(performance.now() - started) });
  const timer = setTimeout(() => { worker.terminate(); resolve({ kind: "failed", stage: "startup_timeout", diagnostics: diagnostics() }); }, 25000);
  worker.on("error", () => { workerError = true; });
  worker.on("message", (message) => {
   // Only fixed lifecycle names and timings: never CDP data, errors, or endpoints.
   if (["ready", "recording", "finalizing", "result", "failed", "cancelled"].includes(message.kind) && phases.length < 8)
    phases.push({ kind: message.kind, elapsedMs: Math.round(performance.now() - started) });
   if (message.kind === "ready") { ready = true; worker.postMessage({ kind: "start", request }); }
   if (["result", "failed", "cancelled"].includes(message.kind)) reply = message;
  });
  worker.on("exit", (code) => { clearTimeout(timer); resolve({ ...(reply ? { ...reply, exitCode: code } : { kind: "failed", stage: "startup", ready }), diagnostics: diagnostics() }); });
 });
}
let result;
for (const path of ["./lib/browser/memory-profile-worker.js", "./server/lib/browser/memory-profile-worker.js", "./memory-profile-worker.js"]) {
 result = await spawn(path);
 if (result.stage !== "startup") break;
}
console.log(JSON.stringify({ compiled: isCompiledRuntime(), ...result }));
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
				{ cwd: root, timeout: 60000, maxBuffer: 1024 * 1024 },
			);
			binaries.push(binary);
		}
		await rm(sourceDir, { recursive: true, force: true });
		const request: MemoryProfileRequest = {
			profileId: "compiled-profile",
			wsEndpoint: "private-invalid-endpoint-canary",
			targetId: "exact-target",
			dir: join(artifacts, "invalid"),
			maxArtifactsBytes: PROFILE_LIMITS.artifactBytes,
			config: {
				mode: "both",
				durationMs: 1000,
				samplingIntervalBytes: PROFILE_LIMITS.defaultSamplingIntervalBytes,
			},
		};
		for (let i = 0; i < binaries.length; i++) {
			const { stdout } = await execute(binaries[i], [JSON.stringify(request)], {
				cwd: artifacts,
				timeout: 35000,
				maxBuffer: 1024 * 1024,
			});
			const reply = JSON.parse(stdout.trim());
			expect(reply.compiled).toBe(true);
			expect(reply.kind).toBe("failed");
			expect(reply.stage).toBe(i === 0 ? "connect" : "startup");
			if (i === 0) expect(reply.exitCode).toBe(0);
			expect(stdout).not.toContain("private-invalid-endpoint-canary");
		}
		const cache = process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
		const candidates = [
			process.env.PUPPETEER_EXECUTABLE_PATH,
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
		];
		if (existsSync(cache)) {
			for await (const path of new Bun.Glob("chrome/**/*{chrome,chrome.exe}").scan({
				cwd: cache,
				absolute: true,
				onlyFiles: true,
			}))
				candidates.push(path);
		}
		const executablePath = candidates.find((path): path is string => !!path && existsSync(path));
		if (!executablePath) {
			console.warn("SKIP compiled real Chrome profile: owned executable unavailable");
			return;
		}
		const chrome = await launch({
			executablePath,
			headless: true,
			args: ["--no-sandbox", "--disable-dev-shm-usage"],
			userDataDir: join(artifacts, "owned-chrome"),
			timeout: 10000,
		});
		try {
			const page = await chrome.newPage();
			await page.goto("data:text/html,<title>compiled-owned-fixture</title>");
			const identity = await page.createCDPSession();
			const { targetInfo } = await identity.send("Target.getTargetInfo");
			await identity.detach();
			request.targetId = targetInfo.targetId;
			request.wsEndpoint = chrome.wsEndpoint();
			request.dir = join(artifacts, "real-recording");
			const { stdout } = await execute(binaries[0], [JSON.stringify(request)], {
				cwd: artifacts,
				timeout: 35000,
				maxBuffer: 1024 * 1024,
			});
			const reply = JSON.parse(stdout.trim()) as MemoryProfileWorkerReply & {
				compiled: boolean;
				exitCode: number;
				diagnostics: {
					workerError: boolean;
					phases: Array<{ kind: string; elapsedMs: number }>;
					elapsedMs: number;
				};
			};
			if (reply.kind === "failed" || reply.kind === "cancelled") {
				console.error("Compiled profile worker failed", {
					kind: reply.kind,
					stage: reply.stage,
					traceStopped: reply.traceStopped,
					compiled: reply.compiled,
					exitCode: reply.exitCode,
					diagnostics: reply.diagnostics,
				});
			}
			expect(reply.kind).toBe("result");
			if (reply.kind !== "result") throw new Error("Expected compiled real worker result");
			expect(reply.traceStopped).toBe(true);
			expect(reply.summary.stopReason).toBe("duration_limit");
			expect(reply.summary.gc?.scope?.threadName).toBe("CrRendererMain");
			expect(reply.exitCode).toBe(0);
			expect(reply.artifacts).toHaveLength(3);
			for (const artifact of reply.artifacts)
				JSON.parse(await readFile(join(request.dir, artifact.filename), "utf8"));
		} finally {
			await chrome.close();
		}
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(artifacts, { recursive: true, force: true });
	}
}, 150000);
