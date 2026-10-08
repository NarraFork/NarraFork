import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	buildNativeTestCommand,
	CI_TEST_CHUNK_BYTES,
	CI_TEST_KILL_GRACE_MS,
	CI_TEST_OUTPUT_LIMIT_BYTES,
	CI_TEST_TIMEOUT_MS,
	type FileStdioOptions,
	type FileStdioResult,
	runWithFileStdio,
} from "../../scripts/run-ci-tests";

type Step = {
	name?: string;
	uses?: string;
	run?: string;
	if?: string;
	with?: Record<string, string | boolean | number>;
	env?: Record<string, string>;
	"continue-on-error"?: boolean;
};
type Job = {
	name: string;
	"runs-on": string;
	"timeout-minutes": number;
	needs?: string[];
	if?: string;
	strategy?: { "fail-fast": boolean; matrix: { shard: number[] } };
	steps: Step[];
	"continue-on-error"?: boolean;
	env?: Record<string, string>;
};
type Workflow = {
	on: Record<string, { branches?: string[] } | null>;
	permissions: Record<string, string>;
	concurrency: { group: string; "cancel-in-progress": string };
	defaults: { run: { shell: string } };
	jobs: Record<string, Job>;
	env?: Record<string, string>;
};

const repository = resolve(import.meta.dir, "../..");
const workflow = Bun.YAML.parse(
	readFileSync(join(repository, ".github/workflows/ci.yml"), "utf8"),
) as Workflow;
const packageManager = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"))
	.packageManager as string;
const pins = {
	checkout: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
	bun: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
	upload: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
	download: "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
};
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function job(id: string): Job {
	const result = workflow.jobs[id];
	if (!result) throw new Error(`Missing CI job: ${id}`);
	return result;
}

function step(id: string, predicate: (value: Step) => boolean): Step {
	const result = job(id).steps.find(predicate);
	if (!result) throw new Error(`Missing expected step in ${id}`);
	return result;
}

function command(id: string, run: string): Step {
	return step(id, (value) => value.run?.trim() === run);
}

function expression(value: string): string {
	return `\${{ ${value} }}`;
}

function shell(script: string, env: Record<string, string> = {}, cwd?: string) {
	return spawnSync(
		Bun.which("bash") ?? "bash",
		["--noprofile", "--norc", "-eo", "pipefail", "-c", script],
		{
			cwd,
			env: { ...process.env, ...env },
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 32_768,
		},
	);
}

describe("generic CI workflow", () => {
	test("runs for every PR, main push and manual dispatch without paths or branch exclusions", () => {
		expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
		expect(workflow.on.pull_request ?? {}).toEqual({});
		expect(workflow.on.push).toEqual({ branches: ["main"] });
		expect(workflow.on.workflow_dispatch ?? {}).toEqual({});
	});

	test("has minimal permissions, no secrets and PR-only cancellation", () => {
		expect(workflow.permissions).toEqual({ contents: "read" });
		expect(JSON.stringify(workflow)).not.toMatch(/secrets\s*\./i);
		expect(workflow.concurrency.group).toContain("github.workflow");
		expect(workflow.concurrency.group).toContain("github.event.pull_request.number || github.ref");
		expect(workflow.concurrency["cancel-in-progress"]).toBe(
			expression("github.event_name == 'pull_request'"),
		);
		expect(workflow.defaults.run.shell).toBe("bash");
	});

	test("bounds every job and pins all actions to verified official commits", () => {
		expect(Object.keys(workflow.jobs).sort()).toEqual(["build", "gate", "static-checks", "tests"]);
		for (const [id, value] of Object.entries(workflow.jobs)) {
			expect(value["runs-on"]).toBe("ubuntu-24.04");
			expect(Number.isInteger(value["timeout-minutes"])).toBe(true);
			expect(value["timeout-minutes"]).toBeGreaterThan(0);
			expect(value["timeout-minutes"]).toBeLessThanOrEqual(60);
			expect(value["continue-on-error"]).toBeUndefined();
			if (id !== "gate") expect(value.if).toBeUndefined();
			for (const valueStep of value.steps) {
				expect(valueStep["continue-on-error"]).toBeUndefined();
				const isReport = id === "tests" && valueStep.uses === pins.upload;
				expect(valueStep.if).toBe(isReport ? expression("always()") : undefined);
				if (valueStep.uses) {
					expect(valueStep.uses).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
					expect(Object.values(pins)).toContain(valueStep.uses);
				}
			}
		}
	});

	test("installs the packageManager Bun version with the frozen lockfile before any check", () => {
		expect(packageManager).toBe("bun@1.4.2");
		for (const id of ["static-checks", "build", "tests"]) {
			const steps = job(id).steps;
			const checkout = step(id, (value) => value.uses === pins.checkout);
			const setup = step(id, (value) => value.uses === pins.bun);
			const install = command(id, "bun install --frozen-lockfile");
			expect(checkout.with?.["persist-credentials"]).toBe(false);
			expect(setup.with?.["bun-version"]).toBe(packageManager.slice(4));
			expect(steps.indexOf(checkout)).toBeLessThan(steps.indexOf(setup));
			expect(steps.indexOf(setup)).toBeLessThan(steps.indexOf(install));
			expect(steps.findIndex((value) => !!value.run)).toBe(steps.indexOf(install));
		}
	});

	test("installs extension type dependencies with its frozen lockfile only before root typecheck", () => {
		const install = command("build", "bun install --cwd vscode-extension --frozen-lockfile");
		const steps = job("build").steps;
		expect(steps.indexOf(command("build", "bun install --frozen-lockfile"))).toBeLessThan(
			steps.indexOf(install),
		);
		expect(steps.indexOf(install)).toBeLessThan(
			steps.indexOf(command("build", "bunx tsgo --noEmit")),
		);
		expect(install.if).toBeUndefined();
		for (const id of ["static-checks", "tests"]) {
			expect(job(id).steps.some((value) => value.run?.includes("--cwd vscode-extension"))).toBe(
				false,
			);
		}
	});

	test("enforces migration assets, whole-repository lint and translation checks", () => {
		for (const run of [
			"bun scripts/check-sqlite-migration-assets.ts",
			"bunx @biomejs/biome check .",
			"bun run i18n:check",
		]) {
			expect(command("static-checks", run).if).toBeUndefined();
		}
	});

	test("generates the route tree before typecheck and hands a non-nested frontend artifact to tests", () => {
		const steps = job("build").steps;
		const build = command("build", "bun run build");
		const verify = step(
			"build",
			(value) => !!value.run?.includes("test -f frontend/routeTree.gen.ts"),
		);
		const typecheck = command("build", "bunx tsgo --noEmit");
		const upload = step("build", (value) => value.uses === pins.upload);
		expect(steps.indexOf(build)).toBeLessThan(steps.indexOf(verify));
		expect(verify.run).toContain("test -f dist/frontend/index.html");
		expect(steps.indexOf(verify)).toBeLessThan(steps.indexOf(typecheck));
		expect(steps.indexOf(typecheck)).toBeLessThan(steps.indexOf(upload));
		expect(upload.with?.path).toBe("dist/frontend/");
		expect(upload.with?.["if-no-files-found"]).toBe("error");
		expect(job("tests").needs).toEqual(["build"]);
		const download = step("tests", (value) => value.uses === pins.download);
		expect(download.with?.name).toBe(upload.with?.name);
		expect(download.with?.path).toBe("dist/frontend/");
		expect(download.with?.["merge-multiple"]).toBeUndefined();
		const verifyDownload = command("tests", "test -f dist/frontend/index.html");
		expect(job("tests").steps.indexOf(download)).toBeLessThan(
			job("tests").steps.indexOf(verifyDownload),
		);
	});

	test("prepares real system dependencies and PostgreSQL in the harness's rootless storage", () => {
		const dependencies = step("tests", (value) => !!value.run?.includes("apt-get install"));
		expect(dependencies.run).toMatch(/apt-get install --yes zstd podman git ripgrep/);
		for (const binary of ["zstd", "podman", "git", "rg"]) {
			expect(dependencies.run).toContain(`command -v ${binary}`);
			expect(dependencies.run).toContain(`${binary} --version`);
		}
		expect(dependencies.run).toContain("mkdir -p .narrafork artifacts");
		const image = step("tests", (value) => !!value.run?.includes("podman pull"));
		expect(image.run).toContain("podman info");
		expect(image.run).toContain("podman pull docker.io/library/postgres:17-alpine");
		expect(image.run).toContain("podman image inspect docker.io/library/postgres:17-alpine");
		expect(image.run).not.toMatch(/sudo|\bHOME=|\bUSERPROFILE=/);
		const environment = { ...workflow.env, ...job("tests").env, ...image.env };
		for (const key of ["HOME", "USERPROFILE", "PG_TEST_IMAGE", "PG_INTEGRATION"]) {
			expect(environment[key]).toBeUndefined();
		}
	});

	test("requires executable Chrome and probes a real headless launch before tests", () => {
		const locate = step("tests", (value) => !!value.run?.includes("command -v google-chrome"));
		expect(locate.run).toContain('"$CHROME_PATH" --version');
		for (const variable of ["NF_TEST_CHROMIUM_PATH", "PUPPETEER_EXECUTABLE_PATH"]) {
			expect(locate.run).toContain(`${variable}=%s`);
		}
		expect(locate.run).toContain('"$GITHUB_ENV"');
		const probe = step("tests", (value) => !!value.run?.includes("puppeteer.launch"));
		expect(probe.run).toContain("process.env.PUPPETEER_EXECUTABLE_PATH");
		expect(probe.run).toContain('args: ["--no-sandbox", "--disable-setuid-sandbox"]');
		expect(probe.run).toContain("await page.goto(");
		expect(probe.run).toContain("await browser.close()");
		expect(probe.if).toBeUndefined();
		const steps = job("tests").steps;
		expect(steps.indexOf(locate)).toBeLessThan(steps.indexOf(probe));
		expect(steps.indexOf(probe)).toBeLessThan(
			steps.indexOf(command("tests", "bun test --isolate tests/preload-isolation.test.ts")),
		);
	});

	test("fails Chrome preflight on missing binaries or a broken version command", () => {
		const locate = step("tests", (value) => !!value.run?.includes("command -v google-chrome"));
		const root = mkdtempSync(join(tmpdir(), "ci-chrome-guard-"));
		roots.push(root);
		const githubEnv = join(root, "github-env");
		const missing = shell(locate.run ?? "", { PATH: root, GITHUB_ENV: githubEnv });
		expect(missing.error).toBeUndefined();
		expect(missing.status).not.toBe(0);
		const broken = shell(`google-chrome() { return 42; }\n${locate.run}`, {
			PATH: root,
			GITHUB_ENV: githubEnv,
		});
		expect(broken.error).toBeUndefined();
		expect(broken.status).toBe(42);
		const ready = shell(`google-chrome() { printf 'Chrome 123\\n'; }\n${locate.run}`, {
			PATH: root,
			GITHUB_ENV: githubEnv,
		});
		expect(ready.error).toBeUndefined();
		expect(ready.status).toBe(0);
		expect(readFileSync(githubEnv, "utf8").trim().split("\n")).toEqual([
			"NF_TEST_CHROMIUM_PATH=google-chrome",
			"PUPPETEER_EXECUTABLE_PATH=google-chrome",
		]);
	});

	test("covers all four native shards without fail-fast or artifact name collisions", () => {
		const tests = job("tests");
		expect(tests.name).toBe(`Tests (${expression("matrix.shard")}/4)`);
		expect(tests["timeout-minutes"]).toBe(45);
		expect(tests.strategy).toEqual({
			"fail-fast": false,
			matrix: { shard: [1, 2, 3, 4] },
		});
		const report = step("tests", (value) => value.uses === pins.upload);
		expect(report.with?.name).toBe(`ci-test-results-${expression("matrix.shard")}`);
		const names = tests.strategy?.matrix.shard.map((shard) =>
			String(report.with?.name).replaceAll(expression("matrix.shard"), String(shard)),
		);
		expect(names).toEqual([
			"ci-test-results-1",
			"ci-test-results-2",
			"ci-test-results-3",
			"ci-test-results-4",
		]);
		expect(new Set(names).size).toBe(4);
		for (const id of ["static-checks", "build", "gate"]) {
			expect(job(id).strategy).toBeUndefined();
		}
	});

	test("runs isolated sharded full discovery after preload verification and always publishes JUnit", () => {
		const isolation = command("tests", "bun test --isolate tests/preload-isolation.test.ts");
		const run = command(
			"tests",
			`bun scripts/run-ci-tests.ts --isolate --only-failures --shard=${expression("matrix.shard")}/4 --reporter=junit --reporter-outfile=artifacts/ci-tests.xml`,
		);
		expect(isolation.if).toBeUndefined();
		expect(run.if).toBeUndefined();
		expect(job("tests").steps.indexOf(isolation)).toBeLessThan(job("tests").steps.indexOf(run));
		const report = step("tests", (value) => value.uses === pins.upload);
		expect(report.if).toBe(expression("always()"));
		expect(String(report.with?.path).trim().split(/\r?\n/)).toEqual([
			"artifacts/ci-tests.xml",
			"artifacts/native-tests*.log",
		]);
		// Logs alone satisfy upload-artifact; a separate normal step must require JUnit.
		expect(report.with?.["if-no-files-found"]).toBe("error");
		const verify = command("tests", "test -s artifacts/ci-tests.xml");
		expect(verify.name).toBe("Verify test report");
		expect(verify.if).toBeUndefined();
		expect(job("tests").steps.indexOf(run)).toBeLessThan(job("tests").steps.indexOf(verify));
		expect(job("tests").steps.indexOf(verify)).toBeLessThan(job("tests").steps.indexOf(report));
		// Render Actions expressions first: a shell substitution error is not test failure evidence.
		for (const shard of [1, 2, 3, 4]) {
			const rendered = (run.run ?? "").replaceAll(expression("matrix.shard"), String(shard));
			const failure = shell(`bun() { printf '%s\\n' "$@"; return 23; }\n${rendered}`);
			expect(failure.error).toBeUndefined();
			expect(failure.status).toBe(23);
			expect(failure.stdout.trim().split("\n")).toEqual([
				"scripts/run-ci-tests.ts",
				"--isolate",
				"--only-failures",
				`--shard=${shard}/4`,
				"--reporter=junit",
				"--reporter-outfile=artifacts/ci-tests.xml",
			]);
			const success = shell(`bun() { return 0; }\n${rendered}`);
			expect(success.error).toBeUndefined();
			expect(success.status).toBe(0);
		}
		for (const value of job("tests").steps) {
			expect(value.run ?? "").not.toMatch(
				/PG_INTEGRATION|--retr(?:y|ies)|--bail|--path-ignore-patterns|--parallel|--timeout|--(?:exclude|filter|test-name-pattern|rerun-each)/,
			);
		}
	});

	test("normal report verification rejects absent or empty JUnit even when stdio logs exist", () => {
		const verify = command("tests", "test -s artifacts/ci-tests.xml");
		expect(verify.if).toBeUndefined();
		const root = mkdtempSync(join(tmpdir(), "ci-report-guard-"));
		roots.push(root);
		mkdirSync(join(root, "artifacts"));
		writeFileSync(join(root, "artifacts/native-tests-fixture.log"), "test process output\n");
		const report = join(root, "artifacts/ci-tests.xml");
		const missing = shell(verify.run ?? "", {}, root);
		expect(missing.error).toBeUndefined();
		expect(missing.status).not.toBe(0);
		writeFileSync(report, "");
		const empty = shell(verify.run ?? "", {}, root);
		expect(empty.error).toBeUndefined();
		expect(empty.status).not.toBe(0);
		writeFileSync(report, "<testsuites/>\n");
		const nonempty = shell(verify.run ?? "", {}, root);
		expect(nonempty.error).toBeUndefined();
		expect(nonempty.status).toBe(0);
	});

	test("CI Gate always runs and rejects failed, cancelled, skipped or missing upstream results", () => {
		const gate = job("gate");
		expect(gate.name).toBe("CI Gate");
		expect(gate.if).toBe(expression("always()"));
		expect(gate.needs?.slice().sort()).toEqual(["build", "static-checks", "tests"]);
		expect(gate.steps).toHaveLength(1);
		const check = gate.steps[0];
		expect(check).toBeDefined();
		if (!check) throw new Error("Missing gate check");
		expect(check.if).toBeUndefined();
		expect(check.env).toEqual({
			STATIC_RESULT: expression("needs.static-checks.result"),
			BUILD_RESULT: expression("needs.build.result"),
			TEST_RESULT: expression("needs.tests.result"),
		});
		const results = { STATIC_RESULT: "success", BUILD_RESULT: "success", TEST_RESULT: "success" };
		expect(shell(check.run ?? "", results).status).toBe(0);
		for (const dependency of Object.keys(results)) {
			for (const result of ["failure", "cancelled", "skipped", ""]) {
				const output = shell(check.run ?? "", { ...results, [dependency]: result });
				expect(output.error).toBeUndefined();
				expect(output.status).toBe(1);
			}
		}
	});
});

function privateRunnerRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "ci-file-stdio-"));
	roots.push(root);
	return root;
}

function fixture(source: string, options: Partial<FileStdioOptions> = {}) {
	return runWithFileStdio({
		cwd: privateRunnerRoot(),
		command: [process.execPath, "--eval", source],
		timeoutMs: 2_000,
		killGraceMs: 100,
		...options,
	});
}

function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		// An orphan can briefly be a zombie awaiting reaping; it cannot run or own open fds.
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			return !/\) [ZX] /.test(stat);
		}
		return true;
	} catch (error) {
		if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

function expectReleased(result: FileStdioResult) {
	expect(result.pid).toBeGreaterThan(0);
	expect(running(result.pid ?? 0)).toBe(false);
}

const ownedGroupFixture = `
	import { spawn } from "node:child_process";
	const descendant = spawn(process.execPath, ["--eval",
		'process.on("SIGTERM", () => {}); setInterval(() => {}, 100);'
	], { stdio: ["ignore", 1, 2] });
	process.on("SIGTERM", () => {});
	process.stdout.write("pids:" + JSON.stringify([process.pid, descendant.pid]) + "\\n");
	setInterval(() => {}, 100);
`;

function expectGroupReleased(result: FileStdioResult) {
	expectReleased(result);
	const match = readFileSync(result.stdoutLog, "utf8").match(/pids:(\[[^\n]+\])/);
	expect(match).not.toBeNull();
	if (!match) throw new Error("Owned group fixture never started");
	const pids = JSON.parse(match[1] ?? "[]") as number[];
	expect(pids).toHaveLength(2);
	for (const pid of pids) expect(running(pid)).toBe(false);
}

function nativeArgs(shard = 1): string[] {
	return [
		"--isolate",
		"--only-failures",
		`--shard=${shard}/4`,
		"--reporter=junit",
		"--reporter-outfile=artifacts/ci-tests.xml",
	];
}

describe("CI runner argument contract", () => {
	test("preserves every native argument and its order without altering the per-test timeout", () => {
		for (const shard of [1, 2, 3, 4]) {
			const args = nativeArgs(shard);
			expect(buildNativeTestCommand(args)).toEqual([process.execPath, "test", ...args]);
			expect(buildNativeTestCommand([...args].reverse())).toEqual([
				process.execPath,
				"test",
				...args.reverse(),
			]);
		}
		expect(CI_TEST_TIMEOUT_MS).toBe(30 * 60 * 1_000);
		expect(CI_TEST_OUTPUT_LIMIT_BYTES).toBe(64 * 1024 * 1024);
		expect(CI_TEST_CHUNK_BYTES).toBe(64 * 1024);
		expect(CI_TEST_KILL_GRACE_MS).toBeGreaterThan(0);
		expect(CI_TEST_KILL_GRACE_MS).toBeLessThanOrEqual(1_000);
	});

	test("rejects incomplete shards, changed discovery, reporter paths and timeout or retry flags", () => {
		for (const args of [
			[],
			nativeArgs().slice(1),
			[...nativeArgs(), "--timeout=30000"],
			[...nativeArgs(), "--bail"],
			[...nativeArgs(), "--retry=1"],
			[...nativeArgs(), "tests/scripts"],
			nativeArgs(0),
			nativeArgs(5),
			nativeArgs().map((flag) => flag.replace("1/4", "1/3")),
			nativeArgs().map((flag) => flag.replace("--only-failures", "--isolate")),
			nativeArgs().map((flag) => flag.replace("artifacts/ci-tests.xml", "elsewhere.xml")),
		]) {
			expect(() => buildNativeTestCommand(args)).toThrow("Expected --isolate");
		}
	});
});

describe.skipIf(process.platform === "win32")("CI regular-file stdio runner", () => {
	test("child fds are real private regular files and raw stdout/stderr plus nonzero exit survive", async () => {
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		const result = await fixture(
			`import { fstatSync, writeSync } from "node:fs";
			const metadata = [1, 2].map(fd => ({ file: fstatSync(fd).isFile(), fifo: fstatSync(fd).isFIFO() }));
			writeSync(1, JSON.stringify(metadata) + "\\n");
			writeSync(1, Buffer.from([0, 255, 128, 10]));
			writeSync(2, Buffer.from([255, 0, 129, 10]));
			process.exit(23);`,
			{
				onStdout: (chunk) => {
					stdoutChunks.push(Buffer.from(chunk));
				},
				onStderr: (chunk) => {
					stderrChunks.push(Buffer.from(chunk));
				},
			},
		);
		const out = readFileSync(result.stdoutLog);
		const err = readFileSync(result.stderrLog);
		expect(JSON.parse(out.subarray(0, out.indexOf(10)).toString())).toEqual([
			{ file: true, fifo: false },
			{ file: true, fifo: false },
		]);
		expect(out.subarray(out.length - 4)).toEqual(Buffer.from([0, 255, 128, 10]));
		expect(err).toEqual(Buffer.from([255, 0, 129, 10]));
		expect(Buffer.concat(stdoutChunks)).toEqual(out);
		expect(Buffer.concat(stderrChunks)).toEqual(err);
		expect(result.exitCode).toBe(23);
		expect(result.error).toBeUndefined();
		expect(result.timedOut || result.cancelled || result.outputLimitExceeded).toBe(false);
		for (const path of [result.stdoutLog, result.stderrLog]) {
			expect(path).toContain("/artifacts/native-tests-");
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
		expectReleased(result);
	});

	test("forwards multiple bounded chunks without overwriting existing run evidence", async () => {
		const cwd = privateRunnerRoot();
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const first = await fixture(
			`import { writeSync } from "node:fs";
			writeSync(1, Buffer.alloc(196_731, 65)); writeSync(2, Buffer.alloc(131_077, 66));`,
			{
				cwd,
				onStdout: (chunk) => {
					out.push(Buffer.from(chunk));
				},
				onStderr: (chunk) => {
					err.push(Buffer.from(chunk));
				},
			},
		);
		const second = await fixture('console.log("another run")', { cwd });
		expect(first.exitCode).toBe(0);
		expect(second.exitCode).toBe(0);
		expect(first.stdoutLog).not.toBe(second.stdoutLog);
		expect(first.stderrLog).not.toBe(second.stderrLog);
		expect(Buffer.concat(out)).toEqual(Buffer.alloc(196_731, 65));
		expect(Buffer.concat(err)).toEqual(Buffer.alloc(131_077, 66));
		expect(readFileSync(first.stdoutLog)).toEqual(Buffer.concat(out));
		for (const chunk of [...out, ...err]) expect(chunk.length).toBeLessThanOrEqual(65_536);
		expect(out.length).toBeGreaterThan(1);
		expect(err.length).toBeGreaterThan(1);
	});

	test("watchdog fails and kills its stubborn leader and owned descendants", async () => {
		const started = Date.now();
		const result = await fixture(ownedGroupFixture, { timeoutMs: 500 });
		expect(result.exitCode).not.toBe(0);
		expect(result.timedOut).toBe(true);
		expect(result.cancelled).toBe(false);
		expect(Date.now() - started).toBeLessThan(3_000);
		expectGroupReleased(result);
	});

	test("abort after real child startup fails and releases the entire owned group", async () => {
		const controller = new AbortController();
		const result = await fixture(ownedGroupFixture, {
			signal: controller.signal,
			onStdout: (chunk) => {
				if (Buffer.from(chunk).toString().includes("pids:")) controller.abort();
			},
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.cancelled).toBe(true);
		expect(result.timedOut).toBe(false);
		expectGroupReleased(result);
	});

	test("pre-abort does not execute the child at all", async () => {
		const cwd = privateRunnerRoot();
		const controller = new AbortController();
		controller.abort();
		const result = await fixture(
			'import { writeFileSync } from "node:fs"; writeFileSync("started", "unsafe");',
			{ cwd, signal: controller.signal },
		);
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).not.toBe(0);
		expect(result.pid).toBeUndefined();
		expect(existsSync(join(cwd, "started"))).toBe(false);
		expect(statSync(result.stdoutLog).size + statSync(result.stderrLog).size).toBe(0);
	});

	test("combined output cap is failure even when the real child exits zero", async () => {
		const result = await fixture(
			'import { writeSync } from "node:fs"; writeSync(1, Buffer.alloc(2048)); writeSync(2, Buffer.alloc(2048));',
			{ maxOutputBytes: 4096 },
		);
		expect(result.outputLimitExceeded).toBe(true);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdoutBytes + result.stderrBytes).toBe(4096);
		expectReleased(result);
	});

	test("output cap terminates a live owned group without limiting unrelated fixture files", async () => {
		const cwd = privateRunnerRoot();
		const result = await fixture(
			`${ownedGroupFixture}
			import { writeFileSync, writeSync } from "node:fs";
			writeFileSync("fixture-data", Buffer.alloc(128 * 1024));
			setInterval(() => writeSync(2, Buffer.alloc(1024)), 10);`,
			{ cwd, maxOutputBytes: 4096 },
		);
		expect(result.outputLimitExceeded).toBe(true);
		expect(result.exitCode).not.toBe(0);
		expect(statSync(join(cwd, "fixture-data")).size).toBe(128 * 1024);
		expectGroupReleased(result);
	});

	test("a blocked log consumer cannot disable the watchdog", async () => {
		const result = await fixture('console.log("ready"); setInterval(() => {}, 100)', {
			timeoutMs: 300,
			onStdout: () => new Promise<void>(() => {}),
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.timedOut).toBe(true);
		expectReleased(result);
	});

	test("consumer errors and real spawn errors are never converted into success", async () => {
		const brokenOutput = await fixture('console.log("ready"); setInterval(() => {}, 100)', {
			onStdout: () => {
				throw new Error("output sink failed");
			},
		});
		expect(brokenOutput.exitCode).not.toBe(0);
		expect(brokenOutput.error).toContain("output sink failed");
		expectReleased(brokenOutput);
		const cwd = privateRunnerRoot();
		const missing = await runWithFileStdio({
			cwd,
			command: [join(cwd, "nonexistent-executable")],
			timeoutMs: 1_000,
			killGraceMs: 100,
		});
		expect(missing.exitCode).not.toBe(0);
		expect(missing.error).toBeDefined();
	});

	test("invalid low-level budgets reject before spawning a real fixture", async () => {
		const cwd = privateRunnerRoot();
		for (const budget of [
			{ timeoutMs: 0 },
			{ timeoutMs: Number.NaN },
			{ timeoutMs: CI_TEST_TIMEOUT_MS + 1 },
			{ maxOutputBytes: 0 },
			{ maxOutputBytes: 1.5 },
			{ maxOutputBytes: CI_TEST_OUTPUT_LIMIT_BYTES + 1 },
			{ killGraceMs: -1 },
			{ killGraceMs: 5_001 },
		]) {
			let error: unknown;
			try {
				await fixture(
					'import { writeFileSync } from "node:fs"; writeFileSync("started", "unsafe");',
					{ cwd, ...budget },
				);
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(Error);
			expect(existsSync(join(cwd, "started"))).toBe(false);
		}
	});

	test("the real CLI rejects misconfiguration rather than launching a different test gate", async () => {
		const result = await runWithFileStdio({
			cwd: privateRunnerRoot(),
			command: [
				process.execPath,
				join(repository, "scripts/run-ci-tests.ts"),
				...nativeArgs(),
				"--timeout=30000",
			],
			timeoutMs: 2_000,
			killGraceMs: 100,
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.timedOut).toBe(false);
		expect(readFileSync(result.stderrLog, "utf8")).toContain("Expected --isolate");
		expectReleased(result);
	});
});
