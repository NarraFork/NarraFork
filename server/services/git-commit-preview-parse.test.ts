import { describe, expect, test } from "bun:test";
import { GIT_COMMIT_PREVIEW_MESSAGE_MAX_BYTES } from "@shared/git-commit-preview";
import {
	assertSingleFilePatch,
	buildCommitDetail,
	parseCommitFiles,
	parseCommitMeta,
	parseNameStatusRecords,
	parseNumstatRecords,
	requireCommitFile,
} from "./git-commit-preview-parse";

const sha = "a".repeat(40);
const meta = (message: string) =>
	[
		sha,
		"aaaaaaa",
		"",
		"Author",
		"a@test",
		"2026-09-26T00:00:00Z",
		"Committer",
		"c@test",
		"2026-09-26T01:00:00Z",
		message,
	].join("\0");

describe("commit preview complete-record parsing", () => {
	test("two patch sections require a verified matching typechange without a rename source", () => {
		const diff = "diff --git a/file b/file\nfirst\ndiff --git a/file b/file\nsecond\n";
		const entry = { status: "typechange" as const, path: "file" };
		expect(() => assertSingleFilePatch(diff, "file", entry)).not.toThrow();
		expect(() => assertSingleFilePatch(diff, "file")).toThrow("single file");
		expect(() => assertSingleFilePatch(diff, "file", { ...entry, path: "other" })).toThrow();
		expect(() => assertSingleFilePatch(diff, "file", { ...entry, status: "modified" })).toThrow();
		expect(() => assertSingleFilePatch(diff, "file", { ...entry, oldPath: "source" })).toThrow();
		expect(() =>
			assertSingleFilePatch(`${diff}diff --git a/extra b/extra\n`, "file", entry),
		).toThrow();
	});

	test("metadata preserves multiline message and caps actual UTF-8 bytes", () => {
		const small = parseCommitMeta(meta("subject\n\nbody\n"), false);
		expect(small).toMatchObject({
			sha,
			parents: [],
			message: "subject\n\nbody",
			messageTruncated: false,
		});
		const large = parseCommitMeta(meta("提交说明".repeat(24000)), false);
		expect(large.messageTruncated).toBe(true);
		expect(Buffer.byteLength(large.message)).toBeLessThanOrEqual(
			GIT_COMMIT_PREVIEW_MESSAGE_MAX_BYTES,
		);
		expect(large.message).not.toContain("�");
		expect(parseCommitMeta(meta("body"), true).messageTruncated).toBe(true);
		expect(() => parseCommitMeta("partial\0header", true)).toThrow("incomplete");
		expect(() => parseCommitMeta(meta("x").replace(sha, "HEAD"), false)).toThrow("identity");
	});

	test("names preserve whitespace, tabs, newlines and rename/copy pairs", () => {
		expect(
			parseNameStatusRecords(
				"A\0文件 name\t\n.txt\0R100\0old.txt\0new.txt\0C075\0source\0copy\0T\0type\0U\0conflict\0",
			),
		).toEqual([
			{ status: "added", path: "文件 name\t\n.txt" },
			{ status: "renamed", oldPath: "old.txt", path: "new.txt" },
			{ status: "copied", oldPath: "source", path: "copy" },
			{ status: "typechange", path: "type" },
			{ status: "unmerged", path: "conflict" },
		]);
	});

	test("all mid-record truncations drop the record, not just its last field", () => {
		for (const record of ["A\0new file\0", "R100\0old.txt\0new.txt\0", "C100\0a\0b\0"]) {
			for (let length = 0; length < record.length; length++) {
				expect(parseNameStatusRecords(`M\0complete\0${record.slice(0, length)}`)).toEqual([
					{ status: "modified", path: "complete" },
				]);
			}
		}
		for (const record of ["2\t3\tfile\0", "0\t0\t\0old\0new\0"]) {
			for (let length = 0; length < record.length; length++) {
				expect(parseNumstatRecords(record.slice(0, length)).size).toBe(0);
			}
		}
	});

	test("binary and unknown stats are distinguished; file list remains authoritative", () => {
		const result = parseCommitFiles({
			nameStatus: "A\0binary\0M\0unknown\0R100\0old\0new\0",
			nameStatusTruncated: false,
			numstat: "-\t-\tbinary\0",
			numstatTruncated: true,
		});
		expect(result.files).toEqual([
			{ path: "binary", status: "added", linesAdded: null, linesRemoved: null, binary: true },
			{ path: "unknown", status: "modified", linesAdded: null, linesRemoved: null, binary: false },
			{
				path: "new",
				oldPath: "old",
				status: "renamed",
				linesAdded: null,
				linesRemoved: null,
				binary: false,
			},
		]);
		expect(result.filesTruncated).toBe(false);
	});

	test("file cap and upstream truncation are explicit even when the list is empty", () => {
		const names = Array.from({ length: 1001 }, (_, i) => `A\0${i}.txt\0`).join("");
		const result = buildCommitDetail(parseCommitMeta(meta("root"), false), {
			nameStatus: names,
			nameStatusTruncated: false,
			numstat: "",
			numstatTruncated: true,
		});
		expect(result.files).toHaveLength(1000);
		expect(result.filesTruncated).toBe(true);
		expect(result.comparedTo).toBeNull();
		expect(
			parseCommitFiles({
				nameStatus: "R100\0old\0partial",
				nameStatusTruncated: true,
				numstat: "",
				numstatTruncated: true,
			}),
		).toEqual({ files: [], filesTruncated: true });
	});

	test("membership uses the exact path and source pair, never directories or alternate files", () => {
		const names = "M\0src/file.txt\0R100\0old\0new\0";
		expect(requireCommitFile(names, false, "new").oldPath).toBe("old");
		expect(() => requireCommitFile(names, false, "new", "unrelated")).toThrow("does not match");
		for (const path of ["src", ".", "missing", "old"])
			expect(() => requireCommitFile(names, false, path)).toThrow("not part");
		expect(() => requireCommitFile(names, true, "missing")).toThrow("budget");
	});
});
