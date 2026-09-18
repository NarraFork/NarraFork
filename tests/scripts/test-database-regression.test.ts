/**
 * Tests for the isolated regression baseline runner.
 *
 * The runner's value is entirely in its classification: a baseline that reports a
 * timeout or a crash as "pass" is worse than no baseline, because it launders a
 * broken file into evidence of health. So the cases exercised here are the ones
 * that must never silently become green — timeout, output flood, import crash,
 * skip/todo-only, missing file — plus the output byte cap that keeps a flooding
 * child from being buffered into this process.
 *
 * Fixture test files are written into a self-managed temp directory and removed
 * afterwards; nothing is written under the repository or the real data dir.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BATCH_ACCEPTANCE1,
	BATCH_EXTENDED,
	BATCH_STAGE2,
	BATCHES,
	buildChildEnv,
	type ClassifyInput,
	capList,
	capOptionalText,
	capText,
	classifyRunOutcome,
	looksLikeFilterMiss,
	MAX_CONCURRENCY,
	MAX_FAILURE_MESSAGE_CHARS,
	MAX_FAILURES_PER_FILE,
	MAX_SKIPPED_NAMES_PER_FILE,
	MAX_TEST_NAME_CHARS,
	NON_PASS_STATUSES,
	PREFLIGHT_FILE,
	parseCliArgs,
	parseJunit,
	readBoundedStream,
	resolveConcurrency,
	resolveFileList,
	runTestFile,
	runWithConcurrency,
	sanitizeLogName,
	toPathArgument,
} from "../../scripts/test-database-regression";

const REPO_ROOT = join(import.meta.dir, "..", "..");

let workspace: string;
let reportDir: string;

function fixture(name: string, source: string): string {
	const path = join(workspace, name);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, source);
	return path;
}

function freshReportDir(name: string): string {
	const dir = join(reportDir, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

beforeAll(() => {
	workspace = mkdtempSync(join(tmpdir(), "nf-regression-runner-test-"));
	reportDir = mkdtempSync(join(tmpdir(), "nf-regression-runner-reports-"));
	// Fixtures run with the repo's bunfig preload, which imports @server/lib/settings.
	// A local bunfig without preload keeps these fixtures independent of that.
	writeFileSync(join(workspace, "bunfig.toml"), "[test]\n");
});

afterAll(() => {
	rmSync(workspace, { recursive: true, force: true });
	rmSync(reportDir, { recursive: true, force: true });
});

describe("junit parsing", () => {
	test("classifies pass, fail, skip and todo distinctly", () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="2" failures="1" skipped="2" time="0.02">
  <testsuite name="probe.test.ts" file="probe.test.ts" tests="4" failures="1" skipped="2">
    <testcase name="skipped one" classname="" time="0" file="probe.test.ts" line="2" assertions="0">
      <skipped />
    </testcase>
    <testcase name="todo one" classname="" time="0" file="probe.test.ts" line="3" assertions="0">
      <skipped message="TODO" />
    </testcase>
    <testcase name="passing one" classname="g" time="0.1" file="probe.test.ts" line="4" assertions="1" />
    <testcase name="failing one" classname="g" time="0.2" file="probe.test.ts" line="5" assertions="1">
      <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;">boom</failure>
    </testcase>
  </testsuite>
</testsuites>`;
		const report = parseJunit(xml);
		expect(report).not.toBeNull();
		if (!report) return;
		expect(report.testcases.map((t) => t.status)).toEqual(["skip", "todo", "pass", "fail"]);
		expect(report.passed).toBe(1);
		expect(report.failed).toBe(1);
		expect(report.skipped).toBe(2);
		expect(report.declared).toEqual({ tests: 4, failures: 1, skipped: 2 });
		// The failure message must survive entity decoding so the report is readable.
		expect(report.testcases[3].failureMessage).toContain("Expected: 2");
		expect(report.testcases[3].failureMessage).toContain("\n");
		expect(report.testcases[2].line).toBe(4);
	});

	test("returns null for content that is not a bun junit report", () => {
		expect(parseJunit("")).toBeNull();
		expect(parseJunit("<html>nope</html>")).toBeNull();
	});
});

describe("outcome classification", () => {
	const base: ClassifyInput = {
		exitCode: 0,
		signal: null,
		timedOut: false,
		cancelled: false,
		outputOverflowKilled: false,
		reportExists: true,
		report: { testcases: [], declared: null, passed: 3, failed: 0, skipped: 0 },
		filterMissed: false,
	};

	test("a clean report with passing tests is the only pass", () => {
		expect(classifyRunOutcome(base)).toBe("pass");
	});

	test("a timeout is a timeout even when a partial green report exists", () => {
		expect(classifyRunOutcome({ ...base, timedOut: true })).toBe("timeout");
	});

	test("an output flood kill is not a pass", () => {
		expect(classifyRunOutcome({ ...base, outputOverflowKilled: true })).toBe("output-overflow");
	});

	test("cancellation outranks every other signal", () => {
		expect(classifyRunOutcome({ ...base, cancelled: true, timedOut: true })).toBe("cancelled");
	});

	test("a non-zero exit with a green report is a crash, not a pass", () => {
		expect(classifyRunOutcome({ ...base, exitCode: 1 })).toBe("crash");
	});

	test("a missing report with a non-zero exit is a crash", () => {
		expect(classifyRunOutcome({ ...base, reportExists: false, report: null, exitCode: 1 })).toBe(
			"crash",
		);
	});

	test("a missing report with a zero exit means no tests ran", () => {
		expect(classifyRunOutcome({ ...base, reportExists: false, report: null, exitCode: 0 })).toBe(
			"no-tests",
		);
	});

	test("an unmatched filter is reported as missing", () => {
		expect(classifyRunOutcome({ ...base, filterMissed: true })).toBe("missing");
	});

	test("skip-only and empty files are distinguished and neither is a pass", () => {
		const skipOnly = classifyRunOutcome({
			...base,
			report: { testcases: [], declared: null, passed: 0, failed: 0, skipped: 2 },
		});
		const empty = classifyRunOutcome({
			...base,
			report: { testcases: [], declared: null, passed: 0, failed: 0, skipped: 0 },
		});
		expect(skipOnly).toBe("skipped");
		expect(empty).toBe("no-tests");
		expect(NON_PASS_STATUSES).toContain(skipOnly);
		expect(NON_PASS_STATUSES).toContain(empty);
	});

	test("declared failures count even if no failing testcase was parsed", () => {
		expect(
			classifyRunOutcome({
				...base,
				report: {
					testcases: [],
					declared: { tests: 1, failures: 1, skipped: 0 },
					passed: 1,
					failed: 0,
					skipped: 0,
				},
			}),
		).toBe("fail");
	});
});

describe("bounded stream reading", () => {
	function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});
	}

	test("retains at most the cap and still reports the true total", async () => {
		const chunk = new TextEncoder().encode("x".repeat(1000));
		const result = await readBoundedStream(streamOf([chunk, chunk, chunk]), 1500);
		expect(result.keptBytes).toBe(1500);
		expect(result.text.length).toBe(1500);
		expect(result.totalBytes).toBe(3000);
		expect(result.truncated).toBe(true);
	});

	test("keeps short output untruncated", async () => {
		const result = await readBoundedStream(streamOf([new TextEncoder().encode("hi")]), 1024);
		expect(result.text).toBe("hi");
		expect(result.truncated).toBe(false);
		expect(result.totalBytes).toBe(2);
	});

	test("signals overflow exactly once past the hard limit", async () => {
		const chunk = new TextEncoder().encode("y".repeat(500));
		let overflows = 0;
		const result = await readBoundedStream(streamOf([chunk, chunk, chunk, chunk]), 100, {
			hardKillBytes: 600,
			onOverflow: () => {
				overflows += 1;
			},
		});
		expect(overflows).toBe(1);
		expect(result.keptBytes).toBe(100);
		expect(result.totalBytes).toBe(2000);
	});

	test("a missing stream is empty rather than an error", async () => {
		const result = await readBoundedStream(undefined, 100);
		expect(result).toEqual({ text: "", keptBytes: 0, totalBytes: 0, truncated: false });
	});
});

describe("child environment", () => {
	test("strips the data-home overrides so the preload owns isolation", () => {
		const env = buildChildEnv({
			PATH: "/usr/bin",
			NARRAFORK_HOME: "/home/dev/.narrafork",
			NARRAFORK_ALLOW_MULTIPLE: "1",
			NARRAFORK_ORIGINAL_HOME: "/home/dev",
			KEEP_ME: "yes",
			DROP_UNDEFINED: undefined,
		});
		expect(env.NARRAFORK_HOME).toBeUndefined();
		expect(env.NARRAFORK_ALLOW_MULTIPLE).toBeUndefined();
		expect(env.NARRAFORK_ORIGINAL_HOME).toBeUndefined();
		expect(env.DROP_UNDEFINED).toBeUndefined();
		expect(env.PATH).toBe("/usr/bin");
		expect(env.KEEP_ME).toBe("yes");
		expect(env.NO_COLOR).toBe("1");
	});

	test("forces NODE_ENV=test regardless of the inherited value", () => {
		// `bun run start:dev` sets NODE_ENV=production, and bun test forwards it
		// unchanged. server/db/connection.ts only guards the real database when
		// NODE_ENV === "test", so inheriting production would disarm it.
		for (const inherited of ["production", "development", "", undefined]) {
			const env = buildChildEnv({ PATH: "/usr/bin", NODE_ENV: inherited });
			expect(env.NODE_ENV).toBe("test");
		}
	});

	test("a child really sees NODE_ENV=test when the parent says production", async () => {
		fixture(
			"nodeenv.test.ts",
			'import { expect, test } from "bun:test";\n' +
				'test("node env is test", () => { expect(process.env.NODE_ENV).toBe("test"); });\n',
		);
		const result = await runTestFile({
			file: "nodeenv.test.ts",
			cwd: workspace,
			timeoutMs: 30_000,
			outputCapBytes: 64 * 1024,
			reportDir: freshReportDir("nodeenv"),
			env: { ...process.env, NODE_ENV: "production" },
		});
		expect(result.status).toBe("pass");
		expect(result.tests.passed).toBe(1);
	});
});

describe("summary field caps", () => {
	test("short text is kept verbatim and marked untruncated", () => {
		expect(capText("hello", 100)).toEqual({
			text: "hello",
			truncated: false,
			originalChars: 5,
		});
	});

	test("long text is clipped and the original length is recorded", () => {
		const capped = capText("z".repeat(9_000), 100);
		expect(capped.text.length).toBe(100);
		expect(capped.truncated).toBe(true);
		expect(capped.originalChars).toBe(9_000);
	});

	test("text exactly at the limit is not marked truncated", () => {
		const capped = capText("z".repeat(50), 50);
		expect(capped.truncated).toBe(false);
		expect(capped.text.length).toBe(50);
	});

	test("a null message stays null rather than becoming an empty string", () => {
		expect(capOptionalText(null, 100)).toBeNull();
		expect(capOptionalText("x", 100)?.text).toBe("x");
	});

	test("lists are clipped with the original count preserved", () => {
		const short = capList([1, 2, 3], 5);
		expect(short).toEqual({ items: [1, 2, 3], truncated: false, originalCount: 3 });
		const long = capList(
			Array.from({ length: 500 }, (_, i) => i),
			10,
		);
		expect(long.items).toHaveLength(10);
		expect(long.truncated).toBe(true);
		expect(long.originalCount).toBe(500);
		// The returned array must be a copy, so mutating it cannot rewrite the source.
		short.items.push(99);
		expect(short.originalCount).toBe(3);
	});

	test("the declared caps are finite and ordered sensibly", () => {
		expect(MAX_FAILURE_MESSAGE_CHARS).toBeGreaterThan(MAX_TEST_NAME_CHARS);
		for (const cap of [
			MAX_FAILURE_MESSAGE_CHARS,
			MAX_TEST_NAME_CHARS,
			MAX_FAILURES_PER_FILE,
			MAX_SKIPPED_NAMES_PER_FILE,
		]) {
			expect(Number.isFinite(cap)).toBe(true);
			expect(cap).toBeGreaterThan(0);
		}
	});

	test("a huge assertion diff is capped in the result and the truncation is visible", async () => {
		// A single toEqual on a large object produces a multi-megabyte message.
		// Uncapped, every such failure would be held in memory for the whole run.
		fixture(
			"hugediff.test.ts",
			'import { expect, test } from "bun:test";\n' +
				'test("huge diff", () => {\n' +
				// String concatenation rather than a template literal: the fixture source
				// is written verbatim into a file, and a `${...}` here would be read as a
				// placeholder of *this* file.
				'  const big = Array.from({ length: 4000 }, (_, i) => "value-" + i + "-" + "p".repeat(80));\n' +
				"  expect(big).toEqual([]);\n" +
				"});\n",
		);
		const result = await runTestFile({
			file: "hugediff.test.ts",
			cwd: workspace,
			timeoutMs: 60_000,
			outputCapBytes: 64 * 1024,
			reportDir: freshReportDir("hugediff"),
		});
		expect(result.status).toBe("fail");
		expect(result.failures.items).toHaveLength(1);
		const message = result.failures.items[0].message;
		expect(message).not.toBeNull();
		if (!message) return;
		expect(message.text.length).toBeLessThanOrEqual(MAX_FAILURE_MESSAGE_CHARS);
		expect(message.truncated).toBe(true);
		expect(message.originalChars).toBeGreaterThan(MAX_FAILURE_MESSAGE_CHARS);
	}, 90_000);

	test("many failures and long names are both capped", async () => {
		const failureCount = MAX_FAILURES_PER_FILE + 25;
		fixture(
			"manyfails.test.ts",
			'import { expect, test } from "bun:test";\n' +
				`const longName = "n".repeat(${MAX_TEST_NAME_CHARS + 300});\n` +
				`for (let i = 0; i < ${failureCount}; i++) {\n` +
				'  test(longName + "-" + i, () => { expect(1).toBe(2); });\n' +
				"}\n",
		);
		const result = await runTestFile({
			file: "manyfails.test.ts",
			cwd: workspace,
			timeoutMs: 60_000,
			outputCapBytes: 128 * 1024,
			reportDir: freshReportDir("manyfails"),
		});
		expect(result.status).toBe("fail");
		expect(result.tests.failed).toBe(failureCount);
		expect(result.failures.items).toHaveLength(MAX_FAILURES_PER_FILE);
		expect(result.failures.truncated).toBe(true);
		// The true count survives the cap: a reader still knows 125 tests failed.
		expect(result.failures.originalCount).toBe(failureCount);
		for (const failure of result.failures.items) {
			expect(failure.name.text.length).toBeLessThanOrEqual(MAX_TEST_NAME_CHARS);
			expect(failure.name.truncated).toBe(true);
		}
	}, 90_000);

	test("skip lists are capped with the original count kept", async () => {
		const skipCount = MAX_SKIPPED_NAMES_PER_FILE + 15;
		fixture(
			"manyskips.test.ts",
			'import { test } from "bun:test";\n' +
				`for (let i = 0; i < ${skipCount}; i++) test.skip("s-" + i, () => {});\n` +
				'test("one real", () => {});\n',
		);
		const result = await runTestFile({
			file: "manyskips.test.ts",
			cwd: workspace,
			timeoutMs: 60_000,
			outputCapBytes: 128 * 1024,
			reportDir: freshReportDir("manyskips"),
		});
		expect(result.skippedNames.items).toHaveLength(MAX_SKIPPED_NAMES_PER_FILE);
		expect(result.skippedNames.truncated).toBe(true);
		expect(result.skippedNames.originalCount).toBe(skipCount);
	}, 90_000);
});

describe("concurrency", () => {
	test("never exceeds the hard cap and never drops below one", () => {
		expect(resolveConcurrency(undefined)).toBeLessThanOrEqual(MAX_CONCURRENCY);
		expect(resolveConcurrency(99)).toBe(MAX_CONCURRENCY);
		expect(resolveConcurrency(0)).toBe(1);
		expect(resolveConcurrency(-5)).toBe(1);
		expect(resolveConcurrency(Number.NaN)).toBeLessThanOrEqual(MAX_CONCURRENCY);
		expect(resolveConcurrency(2)).toBe(2);
	});

	test("the pool keeps result order and respects the limit", async () => {
		let inFlight = 0;
		let peak = 0;
		const results = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await Bun.sleep(5);
			inFlight -= 1;
			return value * 10;
		});
		expect(results).toEqual([10, 20, 30, 40, 50]);
		expect(peak).toBeLessThanOrEqual(2);
	});
});

describe("cli parsing", () => {
	test("caps concurrency from the command line", () => {
		expect(parseCliArgs(["--concurrency=8"]).concurrency).toBe(MAX_CONCURRENCY);
	});

	test("accepts a batch, explicit files and a comma list, deduplicated", () => {
		const options = parseCliArgs([
			"--batch=acceptance1",
			"server/db/fts.test.ts",
			"--files=server/db/fts.test.ts,server/db/run-migrations.test.ts",
			"--timeout=45000",
			"--output-cap=4096",
		]);
		expect(options.timeoutMs).toBe(45_000);
		expect(options.outputCapBytes).toBe(4096);
		const files = resolveFileList(options);
		expect(new Set(files).size).toBe(files.length);
		expect(files).toContain("server/db/fts.test.ts");
		expect(files).toContain("server/db/run-migrations.test.ts");
		for (const file of BATCH_ACCEPTANCE1) expect(files).toContain(file);
	});

	test("rejects an unknown batch instead of running nothing quietly", () => {
		expect(() => resolveFileList(parseCliArgs(["--batch=nope"]))).toThrow(/Unknown batch/);
	});

	test("both wordings of an unmatched argument are recognised", () => {
		// bun's message differs by argument shape; missing one form would report a
		// deleted file as a crash.
		expect(looksLikeFilterMiss("The following filters did not match any test files:")).toBe(true);
		expect(looksLikeFilterMiss('Test filter "./nope.test.ts" had no matches')).toBe(true);
		expect(looksLikeFilterMiss("1 pass\n0 fail")).toBe(false);
	});

	test("relative paths are passed as paths, not as substring filters", () => {
		// bun test treats a bare argument as a filter, so "a.test.ts" also matches
		// "xa.test.ts" and the child would run two files in one process.
		expect(toPathArgument("server/db/fts.test.ts")).toBe("./server/db/fts.test.ts");
		expect(toPathArgument("./already.test.ts")).toBe("./already.test.ts");
		expect(toPathArgument("../up.test.ts")).toBe("../up.test.ts");
		expect(toPathArgument("/abs/path.test.ts")).toBe("/abs/path.test.ts");
		expect(toPathArgument("C:\\win\\path.test.ts")).toBe("C:\\win\\path.test.ts");
	});

	test("log names stay filesystem safe", () => {
		expect(sanitizeLogName("server/routes/__tests__/fs-download.test.ts")).toBe(
			"server__routes____tests____fs-download.test.ts",
		);
		expect(sanitizeLogName("a b/c*d.test.ts")).not.toMatch(/[ */]/);
	});
});

describe("batch definitions", () => {
	test("every declared batch file exists in the repository", () => {
		const missing = [...BATCHES.all, PREFLIGHT_FILE].filter(
			(file) => !existsSync(join(REPO_ROOT, file)),
		);
		expect(missing).toEqual([]);
	});

	test("batches are deduplicated and the first batch covers the required anchors", () => {
		expect(new Set(BATCH_ACCEPTANCE1).size).toBe(BATCH_ACCEPTANCE1.length);
		expect(new Set(BATCH_EXTENDED).size).toBe(BATCH_EXTENDED.length);
		expect(new Set(BATCH_STAGE2).size).toBe(BATCH_STAGE2.length);
		for (const anchor of [
			"server/routes/__tests__/fs-download.test.ts",
			"server/routes/__tests__/trait-layers.test.ts",
			"server/routes/__tests__/project-membership.test.ts",
			"server/routes/__tests__/projects-delete-fallback.test.ts",
			"tests/server/routes/narrators-file-references.test.ts",
			"server/services/worktree-watcher-poll.test.ts",
		]) {
			expect(BATCH_ACCEPTANCE1).toContain(anchor);
		}
		expect(BATCH_EXTENDED.length).toBeGreaterThanOrEqual(20);
		expect(BATCHES.all.length).toBeLessThanOrEqual(80);
	});
});

describe("end-to-end subprocess behaviour", () => {
	test("a passing fixture is reported as pass with per-test counts", async () => {
		fixture(
			"ok.test.ts",
			'import { expect, test } from "bun:test";\n' +
				'test("a", () => { expect(1).toBe(1); });\n' +
				'test("b", () => { expect(2).toBe(2); });\n',
		);
		const result = await runTestFile({
			file: "ok.test.ts",
			cwd: workspace,
			timeoutMs: 30_000,
			outputCapBytes: 64 * 1024,
			reportDir: freshReportDir("ok"),
		});
		expect(result.status).toBe("pass");
		expect(result.tests).toEqual({ passed: 2, failed: 0, skipped: 0 });
		expect(result.failures.items).toEqual([]);
		expect(result.failures.truncated).toBe(false);
	});

	test("a failing fixture yields a test-level failure list", async () => {
		fixture(
			"bad.test.ts",
			'import { expect, test } from "bun:test";\n' +
				'test("good", () => { expect(1).toBe(1); });\n' +
				'test("bad one", () => { expect(1).toBe(2); });\n',
		);
		const result = await runTestFile({
			file: "bad.test.ts",
			cwd: workspace,
			timeoutMs: 30_000,
			outputCapBytes: 64 * 1024,
			reportDir: freshReportDir("bad"),
		});
		expect(result.status).toBe("fail");
		expect(result.tests.failed).toBe(1);
		expect(result.failures.items).toHaveLength(1);
		expect(result.failures.items[0].name.text).toBe("bad one");
		expect(result.failures.items[0].name.truncated).toBe(false);
		expect(result.failures.items[0].message?.text).toContain("Expected: 2");
		expect(result.failures.items[0].message?.truncated).toBe(false);
	});

	test("a hanging fixture is killed and reported as timeout, never as pass", async () => {
		fixture(
			"hang.test.ts",
			'import { test } from "bun:test";\n' +
				'test("hangs", async () => { await new Promise(() => {}); }, 60_000);\n',
		);
		const result = await runTestFile({
			file: "hang.test.ts",
			cwd: workspace,
			timeoutMs: 2_000,
			outputCapBytes: 64 * 1024,
			reportDir: freshReportDir("hang"),
		});
		expect(result.status).toBe("timeout");
		expect(result.timedOut).toBe(true);
		expect(result.durationMs).toBeLessThan(30_000);
	}, 60_000);

	test("an import-time crash is a crash, not an empty pass", async () => {
		fixture("crash.test.ts", 'throw new Error("boom at import");\n');
		const result = await runTestFile({
			file: "crash.test.ts",
			cwd: workspace,
			timeoutMs: 30_000,
			outputCapBytes: 64 * 1024,
			reportDir: freshReportDir("crash"),
		});
		expect(result.status).toBe("crash");
		expect(result.exitCode).not.toBe(0);
	});

	test("a skip/todo-only fixture is not a pass", async () => {
		// `manyskips.test.ts` above contains this name as a substring. A bare path
		// argument would make bun match both files and run a real test alongside,
		// turning this file's identity into "pass" — hence toPathArgument.
		fixture(
			"skips.test.ts",
			'import { test } from "bun:test";\ntest.skip("s", () => {});\ntest.todo("t");\n',
		);
		const result = await runTestFile({
			file: "skips.test.ts",
			cwd: workspace,
			timeoutMs: 30_000,
			outputCapBytes: 64 * 1024,
			reportDir: freshReportDir("skips"),
		});
		expect(result.status).toBe("skipped");
		expect(result.tests.passed).toBe(0);
		expect(result.tests.skipped).toBe(2);
		expect(result.skippedNames.items.map((name) => name.text)).toEqual(["s", "t"]);
		expect(result.skippedNames.truncated).toBe(false);
	});

	test("a sibling whose name contains this file's name is not pulled in", async () => {
		// The regression this guards: with a bare filter argument bun runs both
		// `pair.test.ts` and `xpair.test.ts`, and the reported counts silently
		// belong to two files instead of one.
		fixture(
			"pair.test.ts",
			'import { expect, test } from "bun:test";\n' +
				'test("only mine", () => { expect(1).toBe(1); });\n',
		);
		fixture(
			"xpair.test.ts",
			'import { expect, test } from "bun:test";\n' +
				'test("sibling a", () => { expect(1).toBe(1); });\n' +
				'test("sibling b", () => { expect(1).toBe(1); });\n',
		);
		const result = await runTestFile({
			file: "pair.test.ts",
			cwd: workspace,
			timeoutMs: 30_000,
			outputCapBytes: 64 * 1024,
			reportDir: freshReportDir("pair"),
		});
		expect(result.status).toBe("pass");
		expect(result.tests.passed).toBe(1);
	});

	test("a non-existent file is reported as missing", async () => {
		const result = await runTestFile({
			file: "definitely-not-here.test.ts",
			cwd: workspace,
			timeoutMs: 30_000,
			outputCapBytes: 64 * 1024,
			reportDir: freshReportDir("missing"),
		});
		expect(result.status).toBe("missing");
	});

	test("a flooding fixture is capped in memory and killed as overflow", async () => {
		fixture(
			"flood.test.ts",
			'import { test } from "bun:test";\n' +
				'test("floods", async () => {\n' +
				'  const line = "F".repeat(4096);\n' +
				"  for (let i = 0; i < 20000; i++) console.log(line);\n" +
				"  await new Promise((r) => setTimeout(r, 20000));\n" +
				"}, 60_000);\n",
		);
		const capBytes = 8 * 1024;
		const result = await runTestFile({
			file: "flood.test.ts",
			cwd: workspace,
			timeoutMs: 45_000,
			outputCapBytes: capBytes,
			hardKillBytes: 64 * 1024,
			reportDir: freshReportDir("flood"),
		});
		expect(result.stdout.keptBytes).toBeLessThanOrEqual(capBytes);
		expect(result.stdout.truncated).toBe(true);
		expect(result.stdout.totalBytes).toBeGreaterThan(capBytes);
		expect(result.status).toBe("output-overflow");
		expect(result.killedForOutput).toBe(true);
	}, 90_000);

	test("an aborted signal cancels without spawning", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runTestFile({
			file: "ok.test.ts",
			cwd: workspace,
			timeoutMs: 30_000,
			outputCapBytes: 1024,
			reportDir: freshReportDir("precancelled"),
			signal: controller.signal,
		});
		expect(result.status).toBe("cancelled");
		expect(result.exitCode).toBeNull();
	});

	test("aborting mid-run kills the child and reports cancelled", async () => {
		fixture(
			"slow.test.ts",
			'import { test } from "bun:test";\n' +
				'test("slow", async () => { await new Promise((r) => setTimeout(r, 30000)); }, 60_000);\n',
		);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 800);
		const result = await runTestFile({
			file: "slow.test.ts",
			cwd: workspace,
			timeoutMs: 40_000,
			outputCapBytes: 4096,
			reportDir: freshReportDir("cancelled"),
			signal: controller.signal,
		});
		expect(result.status).toBe("cancelled");
		expect(result.durationMs).toBeLessThan(20_000);
	}, 60_000);
});
