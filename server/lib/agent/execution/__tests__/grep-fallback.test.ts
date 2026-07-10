import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GrepParams } from "../backend";
import { buildGrepFallbackArgv, stripZeroCountLines } from "../local-backend";

const grepPath = Bun.which("grep");

function makeParams(overrides: Partial<GrepParams>): GrepParams {
	return {
		pattern: "needle",
		searchPath: "/some/dir",
		cwd: "/some/dir",
		outputMode: "content",
		showLineNumbers: true,
		maxBytes: 1024,
		timeoutMs: 5000,
		...overrides,
	};
}

describe("buildGrepFallbackArgv", () => {
	test("directory search is recursive; pattern and path are guarded", () => {
		const argv = buildGrepFallbackArgv("grep", makeParams({ searchPath: "/repo" }), true);
		expect(argv[0]).toBe("grep");
		expect(argv).toContain("-E");
		expect(argv).toContain("-s");
		expect(argv).toContain("-I");
		expect(argv).toContain("-r");
		// pattern is passed via -e and path after -- to prevent option injection
		const eIdx = argv.indexOf("-e");
		expect(eIdx).toBeGreaterThan(-1);
		expect(argv[eIdx + 1]).toBe("needle");
		const dashDash = argv.indexOf("--");
		expect(dashDash).toBeGreaterThan(-1);
		expect(argv[dashDash + 1]).toBe("/repo");
	});

	test("single-file search omits -r", () => {
		const argv = buildGrepFallbackArgv("grep", makeParams({ searchPath: "/repo/a.ts" }), false);
		expect(argv).not.toContain("-r");
	});

	test("files_with_matches maps to -l", () => {
		const argv = buildGrepFallbackArgv(
			"grep",
			makeParams({ outputMode: "files_with_matches" }),
			true,
		);
		expect(argv).toContain("-l");
		expect(argv).not.toContain("-n");
	});

	test("count maps to -c", () => {
		const argv = buildGrepFallbackArgv("grep", makeParams({ outputMode: "count" }), true);
		expect(argv).toContain("-c");
	});

	test("content mode adds -n only when line numbers requested", () => {
		const withN = buildGrepFallbackArgv("grep", makeParams({ showLineNumbers: true }), true);
		expect(withN).toContain("-n");
		const withoutN = buildGrepFallbackArgv("grep", makeParams({ showLineNumbers: false }), true);
		expect(withoutN).not.toContain("-n");
	});

	test("context lines map to -C/-B/-A", () => {
		const c = buildGrepFallbackArgv("grep", makeParams({ contextLines: 3 }), true);
		expect(c.join(" ")).toContain("-C 3");
		const ba = buildGrepFallbackArgv(
			"grep",
			makeParams({ beforeContext: 2, afterContext: 4 }),
			true,
		);
		expect(ba.join(" ")).toContain("-B 2");
		expect(ba.join(" ")).toContain("-A 4");
	});

	test("case-insensitive adds -i", () => {
		const argv = buildGrepFallbackArgv("grep", makeParams({ caseInsensitive: true }), true);
		expect(argv).toContain("-i");
	});

	test("glob maps to --include for directory searches only", () => {
		const dir = buildGrepFallbackArgv("grep", makeParams({ glob: "*.ts" }), true);
		expect(dir).toContain("--include=*.ts");
		const file = buildGrepFallbackArgv("grep", makeParams({ glob: "*.ts" }), false);
		expect(file).not.toContain("--include=*.ts");
	});

	test("rg-only options (multiline, fileType) are dropped", () => {
		const argv = buildGrepFallbackArgv(
			"grep",
			makeParams({ multiline: true, fileType: "ts" }),
			true,
		);
		expect(argv).not.toContain("-U");
		expect(argv).not.toContain("--multiline-dotall");
		expect(argv).not.toContain("--type");
	});
});

describe("stripZeroCountLines", () => {
	const enc = (s: string) => new TextEncoder().encode(s);
	const dec = (b: Uint8Array) => new TextDecoder().decode(b);

	test("removes path:0 lines, keeps non-zero counts", () => {
		const input = enc("a.ts:0\nb.ts:3\nc.ts:0\nd.ts:12\n");
		expect(dec(stripZeroCountLines(input))).toBe("b.ts:3\nd.ts:12\n");
	});

	test("removes a bare 0 (single-file count)", () => {
		expect(dec(stripZeroCountLines(enc("0\n")))).toBe("");
		expect(dec(stripZeroCountLines(enc("5\n")))).toBe("5\n");
	});

	test("does not strip counts that merely end in 0", () => {
		const input = enc("a.ts:10\nb.ts:20\n");
		expect(dec(stripZeroCountLines(input))).toBe("a.ts:10\nb.ts:20\n");
	});

	test("handles missing trailing newline", () => {
		expect(dec(stripZeroCountLines(enc("a.ts:0")))).toBe("");
		expect(dec(stripZeroCountLines(enc("a.ts:7")))).toBe("a.ts:7");
	});
});

describe("grep fallback end-to-end against the real system grep", () => {
	const TEST_DIR = join(tmpdir(), `narrafork-grep-fallback-${Date.now()}`);

	beforeAll(() => {
		mkdirSync(TEST_DIR, { recursive: true });
		writeFileSync(join(TEST_DIR, "a.ts"), "const needle = 1;\nconst other = 2;\n");
		writeFileSync(join(TEST_DIR, "b.txt"), "no match here\n");
	});

	afterAll(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test.skipIf(!grepPath)("generated argv finds matches with the real grep", async () => {
		const argv = buildGrepFallbackArgv(
			grepPath as string,
			makeParams({
				pattern: "needle",
				searchPath: TEST_DIR,
				cwd: TEST_DIR,
				outputMode: "content",
			}),
			true,
		);
		const proc = Bun.spawn(argv, { cwd: TEST_DIR, stdout: "pipe", stderr: "pipe" });
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(stdout).toContain("needle");
		expect(stdout).toContain("a.ts");
		expect(stdout).not.toContain("no match here");
	});

	test.skipIf(!grepPath)("count mode + stripZeroCountLines lists only matching files", async () => {
		const argv = buildGrepFallbackArgv(
			grepPath as string,
			makeParams({
				pattern: "needle",
				searchPath: TEST_DIR,
				cwd: TEST_DIR,
				outputMode: "count",
			}),
			true,
		);
		const proc = Bun.spawn(argv, { cwd: TEST_DIR, stdout: "pipe", stderr: "pipe" });
		const raw = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
		await proc.exited;
		const cleaned = new TextDecoder().decode(stripZeroCountLines(raw));
		expect(cleaned).toContain("a.ts");
		// b.txt has zero matches and must be stripped
		expect(cleaned).not.toContain("b.txt");
	});
});
