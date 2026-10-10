import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { panelMovePreservesState } from "../../scripts/smoke-narrator-dock";
import { isolatedSmokeEnvironment } from "../../scripts/smoke-plugin-ui";

type Step = { run?: string; if?: string; "continue-on-error"?: boolean };
type Workflow = { jobs: Record<string, { steps: Step[] }> };
const root = resolve(import.meta.dir, "../..");
const workflow = Bun.YAML.parse(
	readFileSync(join(root, ".github/workflows/plugin-platform-acceptance.yml"), "utf8"),
) as Workflow;
const scripts = [
	"scripts/drill-plugin-rollback.ts",
	"scripts/smoke-plugin-ui.ts",
	"scripts/smoke-narrator-dock.ts",
];
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

function scriptInputs(command: string): string[] {
	return [...command.matchAll(/(?<![\w/])scripts\/[\w./*-]+\.tsx?\b/g)].map((match) => match[0]);
}

function existingInput(pattern: string): boolean {
	if (pattern.includes("*")) {
		return [...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })].length > 0;
	}
	return existsSync(join(root, pattern)) && statSync(join(root, pattern)).isFile();
}

function directDependencies(script: string): string[] {
	const source = readFileSync(join(root, script), "utf8");
	const imports = [...source.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g)].map(
		(match) => {
			const path = resolve(root, dirname(script), match[1]);
			return existsSync(path) ? path : `${path}.ts`;
		},
	);
	const inputs = [
		...source.matchAll(/["']((?:server|frontend|tests)\/[^"']+\.(?:ts|json|js|css))["']/g),
	].map((match) => join(root, match[1]));
	return [...new Set([...imports, ...inputs])];
}

describe("plugin acceptance workflow inputs", () => {
	test("a no-op panel drag cannot pass just because its textarea sentinel survived", () => {
		const moved = {
			from: { left: 420, top: 200 },
			to: { left: 1073, top: 200 },
			target: { left: 1073, top: 200 },
			sameElement: true,
			hasSentinel: true,
		};
		expect(panelMovePreservesState(moved)).toBe(true);
		expect(panelMovePreservesState({ ...moved, to: moved.from })).toBe(false);
		expect(panelMovePreservesState({ ...moved, to: { ...moved.from, top: 222 } })).toBe(false);
		expect(panelMovePreservesState({ ...moved, sameElement: false })).toBe(false);
		expect(panelMovePreservesState({ ...moved, hasSentinel: false })).toBe(false);
	});

	test("cleanup removes only its temporary HOME while keeping bounded smoke evidence", () => {
		const result = spawnSync(
			process.execPath,
			[
				"-e",
				`
			const { createSmokeRuntime } = await import("./scripts/smoke-plugin-ui");
			const runtime = await createSmokeRuntime();
			runtime.report(Array.from({length: 50}, () => ({name: "fixture", status: "fail", detail: "x".repeat(2000)})));
			await runtime.cleanup();
			console.log(JSON.stringify({ home: runtime.home, evidenceDir: runtime.evidenceDir }));
		`,
			],
			{ cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 32_768 },
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		const record = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as {
			home: string;
			evidenceDir: string;
		};
		expect(record.evidenceDir.startsWith(join(root, ".narrafork", "browser-smoke-"))).toBe(true);
		try {
			expect(existsSync(record.home)).toBe(false);
			const summaryPath = join(record.evidenceDir, "summary.json");
			expect(statSync(summaryPath).size).toBeLessThan(64 * 1024);
			const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
			expect(summary.outcome).toHaveLength(40);
			expect(summary.outcome[0].detail).toHaveLength(500);
			expect(statSync(join(record.evidenceDir, "server-tail.log")).size).toBeLessThanOrEqual(4096);
		} finally {
			// This unit test owns this newly-created fixture evidence, not any real failed run.
			rmSync(record.evidenceDir, { recursive: true, force: true });
		}
	});

	test("missing evidence directory fails cleanly without leaking owned server or browser processes", () => {
		const result = spawnSync(
			process.execPath,
			[
				"-e",
				`
			import { spawn } from "node:child_process";
			import { existsSync, rmSync } from "node:fs";
			const { createSmokeRuntime } = await import("./scripts/smoke-plugin-ui");
			const runtime = await createSmokeRuntime();
			runtime.start();
			try {
				const deadline = Date.now() + 15000;
				let healthy = false;
				while (Date.now() < deadline) {
					try { healthy = (await fetch(runtime.base + "/api/health", {signal: AbortSignal.timeout(1000)})).ok; } catch {}
					if (healthy) break;
					await Bun.sleep(100);
				}
				if (!healthy) throw new Error("Fixture's isolated backend did not start");
				// A real owned child exercises Browser.process()/close(), without depending on
				// Chrome discovery or reaching any account/network in this lifecycle unit test.
				const browserProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
				const browserClosed = new Promise((resolve) => browserProcess.once("close", resolve));
				runtime.ownBrowser({process: () => browserProcess, close: async () => {browserProcess.kill("SIGTERM"); await browserClosed;}});
				const serverPid = runtime.serverPid();
				const browserPid = browserProcess.pid;
				rmSync(runtime.evidenceDir, {recursive: true, force: true});
				let cleanupFailed = false;
				try { await runtime.cleanup(); } catch { cleanupFailed = true; }
				const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
				const record = {cleanupFailed, homeExists: existsSync(runtime.home), serverAlive: alive(serverPid), browserAlive: alive(browserPid), interrupts: process.listenerCount("SIGINT"), terminations: process.listenerCount("SIGTERM")};
				console.log(JSON.stringify(record));
				process.exit(cleanupFailed && !record.homeExists && !record.serverAlive && !record.browserAlive && record.interrupts === 0 && record.terminations === 0 ? 2 : 3);
			} catch (error) {
				await runtime.cleanup().catch(() => {});
				console.error(error);
				process.exit(3);
			}
		`,
			],
			{ cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 32_768 },
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(2);
		expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({
			cleanupFailed: true,
			homeExists: false,
			serverAlive: false,
			browserAlive: false,
			interrupts: 0,
			terminations: 0,
		});
	}, 40_000);

	test("retains the real rollback and browser smoke steps without skip or error suppression", () => {
		for (const script of scripts) {
			const step = steps.find((value) => value.run?.startsWith(`bun ${script}`));
			expect(step, script).toBeDefined();
			expect(step?.if).toBeUndefined();
			expect(step?.["continue-on-error"]).toBeUndefined();
			expect(step?.run).not.toMatch(/\|\|\s*(?:true|:)|exit\s+0/);
		}
		expect(
			steps.find((step) => step.run?.startsWith("bun scripts/smoke-plugin-ui.ts"))?.run,
		).toContain("--strict");
	});

	test("every referenced script exists, including Biome inputs, and missing paths really fail", () => {
		const referenced = [...new Set(steps.flatMap((step) => scriptInputs(step.run ?? "")))];
		expect(referenced.length).toBeGreaterThanOrEqual(4);
		for (const script of referenced) expect(existingInput(script), script).toBe(true);
		const biome = steps.find((step) => step.run?.includes("@biomejs/biome check"));
		expect(biome).toBeDefined();
		for (const script of scripts) expect(scriptInputs(biome?.run ?? "")).toContain(script);
		expect(existingInput("scripts/definitely-missing-plugin-input.ts")).toBe(false);
	});

	test("all three restored scripts are exactly allowlisted, without a broad scripts exception", () => {
		const lines = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/);
		expect(lines).toContain("scripts/*");
		for (const script of scripts) expect(lines).toContain(`!${script}`);
		expect(lines).not.toContain("!scripts/*");
		expect(lines).not.toContain("!scripts/**");
		const result = spawnSync("git", ["check-ignore", "--no-index", ...scripts], {
			cwd: root,
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 32_768,
		});
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
	});

	test("runtime imports and fixture assets are present in the public tracked dependency tree", () => {
		const dependencies = [...new Set(scripts.flatMap(directDependencies))];
		for (const dependency of dependencies) expect(existsSync(dependency), dependency).toBe(true);
		// Restored script-to-script imports become tracked when this change is committed.
		const required = dependencies.filter(
			(path) => !scripts.some((script) => join(root, script) === path),
		);
		const result = spawnSync("git", ["ls-files", "--", ...required], {
			cwd: root,
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 128 * 1024,
		});
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		const tracked = new Set(
			result.stdout
				.trim()
				.split("\n")
				.map((path) => join(root, path)),
		);
		for (const path of required) expect(tracked.has(path), path).toBe(true);
	});

	test("isolated smoke environment never inherits account, database or provider credentials", () => {
		const previous = process.env.ANTHROPIC_API_KEY;
		try {
			process.env.ANTHROPIC_API_KEY = "fixture-must-not-be-inherited";
			const home = join(root, ".narrafork", "smoke-home-fixture");
			const env = isolatedSmokeEnvironment(home);
			expect(env.HOME).toBe(home);
			expect(env.NARRAFORK_HOME).toBe(home);
			expect(env.NF_DATABASE_BACKEND).toBe("sqlite");
			expect(env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(env.DATABASE_URL).toBeUndefined();
			expect(env.NF_DATABASE_URL).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = previous;
		}
	});
});
