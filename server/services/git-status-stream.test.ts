import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as spawn from "../lib/spawn";
import {
	GIT_STATUS_MAX_BYTES,
	GIT_STATUS_MAX_RECORDS,
	GitStatusStreamParser,
	readGitStatusStream,
} from "./git-status-stream";

const encode = (value: string) => new TextEncoder().encode(value);
let spawnSpy: ReturnType<typeof spyOn<typeof spawn, "safeSpawn">> | undefined;
afterEach(() => spawnSpy?.mockRestore());

describe("incremental Git status parser", () => {
	test("every byte boundary preserves UTF-8, whitespace, NUL and rename/copy pairs", () => {
		const input = encode(
			"?? 中文\n空 格\0R  新\0旧\0 C copied\0original\0MM both\0UU conflict\0 D deleted\0",
		);
		for (let split = 0; split <= input.length; split++) {
			const parser = new GitStatusStreamParser();
			parser.push(input.subarray(0, split));
			parser.push(input.subarray(split));
			parser.finish(true);
			expect(parser.files).toEqual([
				{ status: "??", path: "中文\n空 格" },
				{ status: "R ", path: "新", oldPath: "旧" },
				{ status: " C", path: "copied", oldPath: "original" },
				{ status: "MM", path: "both" },
				{ status: "UU", path: "conflict" },
				{ status: " D", path: "deleted" },
			]);
			expect([parser.staged, parser.unstaged, parser.untracked, parser.totalFiles]).toEqual([
				3, 4, 1, 6,
			]);
		}
	});

	test("all seven unmerged statuses retain their raw conflict codes", () => {
		const parser = new GitStatusStreamParser();
		const codes = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];
		parser.push(encode(codes.map((code) => `${code} ${code}\0`).join("")));
		parser.finish(true);
		expect(parser.files.map((file) => file.status)).toEqual(codes);
		expect([parser.staged, parser.unstaged]).toEqual([7, 7]);
	});

	test("details cap does not cap the exact scanned count", () => {
		const parser = new GitStatusStreamParser();
		expect(
			parser.push(encode(Array.from({ length: 201 }, (_, i) => `?? file-${i}\0`).join(""))),
		).toBe(true);
		parser.finish(true);
		expect(parser.files).toHaveLength(200);
		expect(parser.totalFiles).toBe(201);
		expect(parser.budgetReached).toBe(false);
	});

	test("record budget stops at 10000 complete records, not their rename halves", () => {
		const parser = new GitStatusStreamParser();
		expect(parser.push(encode(`${"?? file\0".repeat(GIT_STATUS_MAX_RECORDS - 1)}R  new\0`))).toBe(
			true,
		);
		expect(parser.totalFiles).toBe(9999);
		expect(parser.push(encode("old\0?? ignored\0"))).toBe(false);
		expect(parser.totalFiles).toBe(10000);
		expect(parser.files).toHaveLength(200);
		parser.finish(false);
	});

	test("partial NUL/UTF-8/rename records never enter a budget-truncated result", () => {
		for (const text of ["?? partial", "R  new\0old", "R  new\0", "?? 中"]) {
			const parser = new GitStatusStreamParser();
			const bytes = encode(text);
			for (const byte of bytes) parser.push(Uint8Array.of(byte));
			expect(parser.totalFiles).toBe(0);
			expect(() => parser.finish(true)).toThrow("Incomplete Git status record");
			parser.finish(false);
		}
	});
});

describe("bounded status runner", () => {
	test("uses only explicit v1 NUL status and strict streaming budgets", async () => {
		spawnSpy = spyOn(spawn, "safeSpawn").mockImplementation(async (options) => {
			expect(options.cmd).toEqual([
				"git",
				"--no-optional-locks",
				"--literal-pathspecs",
				"-c",
				"core.fsmonitor=false",
				"status",
				"--porcelain=v1",
				"-z",
				"-uall",
				"--",
				".",
			]);
			expect(options.timeout).toBe(30_000);
			expect(options.maxStderrBytes).toBe(4096);
			expect(options.stdoutStream?.maxBytes).toBe(GIT_STATUS_MAX_BYTES);
			options.stdoutStream?.onChunk(encode("?? file\0"));
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		const result = await readGitStatusStream("repo", new AbortController().signal);
		expect(result.budgetReason).toBeUndefined();
		expect(result.parser.totalFiles).toBe(1);
		expect(result.diagnostics.parsedBytes).toBe(8);
		expect(result.diagnostics.maxBytes).toBe(GIT_STATUS_MAX_BYTES);
		expect(result.diagnostics.parseMs).toBeGreaterThanOrEqual(0);
		expect(result.diagnostics.wallMs).toBeGreaterThanOrEqual(0);
	});

	test("intentional byte stop returns only complete records even with nonzero exit", async () => {
		spawnSpy = spyOn(spawn, "safeSpawn").mockImplementation(async (options) => {
			options.stdoutStream?.onChunk(encode("?? complete\0R  new\0partial"));
			return { stdout: "", stderr: "", exitCode: 143, terminationReason: "output-limit" };
		});
		const result = await readGitStatusStream("repo", new AbortController().signal);
		expect(result.budgetReason).toBe("bytes");
		expect(result.parser.files).toEqual([{ status: "??", path: "complete" }]);
	});

	test("intentional record stop is not a Git error", async () => {
		spawnSpy = spyOn(spawn, "safeSpawn").mockImplementation(async (options) => {
			expect(options.stdoutStream?.onChunk(encode("?? file\0".repeat(10001)))).toBe(false);
			return { stdout: "", stderr: "", exitCode: 143, terminationReason: "consumer" };
		});
		expect((await readGitStatusStream("repo", new AbortController().signal)).budgetReason).toBe(
			"records",
		);
	});

	test("timeout and Git failure never masquerade as a truncated success", async () => {
		spawnSpy = spyOn(spawn, "safeSpawn").mockResolvedValue({
			stdout: "",
			stderr: "",
			exitCode: 143,
			terminationReason: "timeout",
		});
		await expect(readGitStatusStream("repo", new AbortController().signal)).rejects.toThrow(
			"timed out",
		);
		spawnSpy.mockResolvedValue({ stdout: "", stderr: "failure", exitCode: 128 });
		await expect(readGitStatusStream("repo", new AbortController().signal)).rejects.toThrow(
			"Git status failed",
		);
	});

	test("cancellation remains an error even if output budget raced it", async () => {
		const controller = new AbortController();
		spawnSpy = spyOn(spawn, "safeSpawn").mockImplementation(async () => {
			controller.abort(new Error("cancelled"));
			return { stdout: "", stderr: "", exitCode: 143, terminationReason: "output-limit" };
		});
		await expect(readGitStatusStream("repo", controller.signal)).rejects.toThrow("cancelled");
	});
});
