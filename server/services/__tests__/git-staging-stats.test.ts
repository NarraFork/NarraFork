import { expect, test } from "bun:test";
import {
	type GitStagingFile,
	GIT_STAGING_LIMITS as LIMITS,
} from "../../../shared/git-staging-lists";
import {
	parseGitStagingStats,
	projectGitStagingPage,
	stagingStatsBudget,
} from "../git-staging-stats";

function raw(
	path: string,
	status = "M",
	oldPath?: string,
	oldMode = "100644",
	newMode = "100644",
	length = 40,
) {
	const oldOid = (oldMode === "000000" ? "0" : "a").repeat(length);
	const newOid = (newMode === "000000" ? "0" : "b").repeat(length);
	return `:${oldMode} ${newMode} ${oldOid} ${newOid} ${status}\0${oldPath === undefined ? path : `${oldPath}\0${path}`}\0`;
}
function num(path: string, added = "2", removed = "1", oldPath?: string) {
	return `${added}\t${removed}\t${oldPath === undefined ? path : `\0${oldPath}\0${path}`}\0`;
}
function row(path: string, status = "M", added = 2, removed = 1): GitStagingFile {
	return {
		fileId: path,
		unitCount: 1,
		needsReviewCount: 0,
		path,
		status,
		stats: { kind: "text", added, removed },
	};
}
function project(rows: GitStagingFile[], offset = 0, limit: number = LIMITS.maxPageRows) {
	return projectGitStagingPage(rows, {
		workspaceKey: "workspace",
		listId: "a",
		snapshotVersion: "v",
		generation: 1,
		observationId: "obs",
		offset,
		limit,
	});
}

for (const length of [40, 64]) {
	test(`strict raw+numstat pairing handles SHA-${length === 40 ? "1" : "256"}, literal paths, rename and copy`, () => {
		const paths = ["tab\tname", "line\nbreak", ":colon", "中文/😀", " space ", "*.txt", "-dash"];
		const output =
			paths.map((path) => raw(path, "M", undefined, "100644", "100644", length)).join("") +
			raw("new\t\nname", "R099", "old\t\nname", "100644", "100644", length) +
			raw("copy\tname", "C100", "original\nname", "100644", "100644", length) +
			paths.map((path) => num(path)).join("") +
			num("new\t\nname", "3", "4", "old\t\nname") +
			num("copy\tname", "0", "0", "original\nname");
		const rows = parseGitStagingStats(output, length);
		expect(rows.slice(0, paths.length)).toEqual(paths.map((path) => row(path)));
		expect(rows.at(-2)).toEqual({ ...row("new\t\nname", "R099", 3, 4), oldPath: "old\t\nname" });
		expect(rows.at(-1)).toEqual({ ...row("copy\tname", "C100", 0, 0), oldPath: "original\nname" });
	});
}

test("binary, addition, deletion, type change and gitlinks retain their own semantics", () => {
	const output =
		raw("binary", "A", undefined, "000000") +
		raw("deleted", "D", undefined, "100644", "000000") +
		raw("link", "T", undefined, "100644", "120000") +
		raw("sub", "M", undefined, "160000", "160000") +
		raw("sub-added", "A", undefined, "000000", "160000") +
		num("binary", "-", "-") +
		num("deleted", "0", "5") +
		num("link", "1", "1") +
		num("sub", "1", "1") +
		num("sub-added", "1", "0");
	const rows = parseGitStagingStats(output, 40);
	expect(rows.map((entry) => entry.stats)).toEqual([
		{ kind: "binary" },
		{ kind: "text", added: 0, removed: 5 },
		{ kind: "text", added: 1, removed: 1 },
		{ kind: "gitlink" },
		{ kind: "gitlink" },
	]);
	const page = project(rows);
	expect(page.stats.total.A).toEqual({
		files: 2,
		added: 0,
		removed: 0,
		binaryFiles: 1,
		gitlinkFiles: 1,
	});
	expect(page.stats.total.M).toEqual({
		files: 1,
		added: 0,
		removed: 0,
		binaryFiles: 0,
		gitlinkFiles: 1,
	});
	expect(page.stats.total.T?.added).toBe(1);
});

for (const [label, output] of [
	["truncated raw header", raw("f").slice(0, -1)],
	["missing numstat", raw("f")],
	["extra numstat", raw("f") + num("f") + num("extra")],
	["mismatched path", raw("f") + num("g")],
	["swapped paths", raw("f") + raw("g") + num("g") + num("f")],
	["mismatched rename source", raw("new", "R100", "old") + num("new", "0", "0", "wrong")],
	["mismatched rename destination", raw("new", "R100", "old") + num("wrong", "0", "0", "old")],
	["rename as single path", raw("new", "R100", "old") + num("new")],
	["single path as rename", raw("f") + num("f", "1", "1", "old")],
	["mixed binary counts", raw("f") + num("f", "-", "1")],
	["negative counts", raw("f") + num("f", "-1", "0")],
	["fractional counts", raw("f") + num("f", "1.5", "0")],
	["unsafe integer counts", raw("f") + num("f", "9007199254740992", "0")],
	["noncanonical counts", raw("f") + num("f", "01", "0")],
	["truncated numstat", raw("f") + num("f").slice(0, -1)],
	["missing rename path", raw("new", "R100", "old").slice(0, -4)],
	["invalid similarity", raw("new", "R101", "old") + num("new", "0", "0", "old")],
	["missing similarity", raw("new", "R", "old") + num("new", "0", "0", "old")],
	["unexpected score", raw("f", "A100") + num("f")],
	["abbreviated OIDs", raw("f").replaceAll("a".repeat(40), "a".repeat(7)) + num("f")],
	["wrong-format OIDs", raw("f", "M", undefined, "100644", "100644", 64) + num("f")],
	["invalid mode", raw("f", "M", undefined, "100600") + num("f")],
	["zero OID with nonzero mode", raw("f").replace("a".repeat(40), "0".repeat(40)) + num("f")],
	["duplicate paths", raw("f") + raw("f") + num("f") + num("f")],
	["empty path", raw("") + num("")],
	["traversal", raw("../f") + num("../f")],
	["empty component", raw("dir//f") + num("dir//f")],
	["absolute path", raw("/f") + num("/f")],
	["git metadata", raw(".git/config") + num(".git/config")],
] as const) {
	test(`parser rejects ${label} instead of producing zero or partial statistics`, () => {
		expect(() => parseGitStagingStats(output, 40)).toThrow();
	});
}

test("raw and numstat are both required, with bounded bytes, paths and record count", () => {
	expect(parseGitStagingStats("", 40)).toEqual([]);
	expect(() => parseGitStagingStats(num("f"), 40)).toThrow();
	expect(() => parseGitStagingStats("x".repeat(LIMITS.maxPathBytes + 1), 40)).toThrow("budget");
	const path = "f".repeat(LIMITS.maxPathChars + 1);
	expect(() => parseGitStagingStats(raw(path) + num(path), 40)).toThrow("path");
	expect(() =>
		parseGitStagingStats(
			Array.from({ length: LIMITS.maxRowsPerList + 1 }, (_, n) => raw(`f${n}`)).join(""),
			40,
		),
	).toThrow("too many files");
});

test("first page contains complete per-status group and descendant counts, not loaded-page subtotals", () => {
	const rows = [
		row("src/deep/a", "A", 3, 0),
		row("src/deep/b", "M", 2, 1),
		row("src/c", "D", 0, 7),
		{ ...row("src/binary", "A"), stats: { kind: "binary" as const } },
		{ ...row("src/module", "M"), stats: { kind: "gitlink" as const } },
		row("src-other/d", "A", 100, 0),
		{ ...row("dest/new", "R100", 1, 2), oldPath: "src/old" },
	];
	const page = project(rows, 0, 1);
	expect(page.complete).toBe(false);
	expect(page.stats.complete).toBe(true);
	expect(page.stats.total.A).toEqual({
		files: 3,
		added: 103,
		removed: 0,
		binaryFiles: 1,
		gitlinkFiles: 0,
	});
	expect(page.stats.directories.map((entry) => entry.path)).toEqual(["src", "src/deep"]);
	expect(page.stats.directories[0].byStatus).toEqual({
		A: { files: 2, added: 3, removed: 0, binaryFiles: 1, gitlinkFiles: 0 },
		M: { files: 2, added: 2, removed: 1, binaryFiles: 0, gitlinkFiles: 1 },
		D: { files: 1, added: 0, removed: 7, binaryFiles: 0, gitlinkFiles: 0 },
	});
	expect(page.stats.directories[1].byStatus.M?.files).toBe(1);
	expect(JSON.parse(Buffer.from(page.nextCursor as string, "base64url").toString())).toEqual([
		"v",
		1,
	]);
	const last = project(rows, 6, 1);
	expect(last.complete).toBe(true);
	expect(last.nextCursor).toBeNull();
	expect(last.stats.total).toEqual(page.stats.total);
	expect(last.stats.directories.map((entry) => entry.path)).toEqual(["dest"]);
});

test("complete empty aggregates are explicit", () => {
	expect(project([])).toMatchObject({
		files: [],
		nextCursor: null,
		complete: true,
		stats: { complete: true, total: {}, directories: [] },
	});
});

test("directory projections and the response envelope share the 256 KiB page budget", () => {
	const rows = Array.from({ length: 200 }, (_, n) => row(`${n}-${"😀".repeat(220)}/file`));
	const page = project(rows);
	expect(page.files.length).toBeGreaterThan(0);
	expect(page.files.length).toBeLessThan(200);
	expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(LIMITS.maxPageBytes);
	expect(page.stats.total.M?.files).toBe(200);
	expect(page.stats.directories).toHaveLength(page.files.length);
	const cursor = JSON.parse(Buffer.from(page.nextCursor as string, "base64url").toString());
	expect(cursor[1]).toBe(page.files.length);
	const next = project(rows, cursor[1]);
	expect(next.files[0].path).toBe(rows[page.files.length].path);
});

test("directory-prefix, CPU, cancellation and timeout budgets explicitly fail or safely page", () => {
	expect(() => project([row(`${"a/".repeat(700)}file`)])).toThrow("budget");
	const rows = Array.from({ length: 200 }, (_, n) => row(`root-${n}/${"d/".repeat(12)}file`));
	const page = project(rows);
	expect(page.files.length).toBeLessThan(200);
	expect(page.stats.directories.length).toBeLessThanOrEqual(LIMITS.maxDirectoryPrefixes);
	expect(page.stats.total.M?.files).toBe(200);
	expect(() => stagingStatsBudget()(LIMITS.maxStatsOperations + 1)).toThrow("CPU budget");
	expect(() => stagingStatsBudget(undefined, -1)()).toThrow("timed out");
	const controller = new AbortController();
	controller.abort();
	expect(() => parseGitStagingStats("", 40, stagingStatsBudget(controller.signal))).toThrow();
	expect(() =>
		projectGitStagingPage(
			[],
			{
				workspaceKey: "w",
				listId: "a",
				snapshotVersion: "v",
				generation: 1,
				observationId: "obs",
				offset: 0,
				limit: 1,
			},
			stagingStatsBudget(controller.signal),
		),
	).toThrow();
});

test("aggregate overflow is rejected rather than silently rounding counts", () => {
	expect(() => project([row("a", "M", Number.MAX_SAFE_INTEGER, 0), row("b", "M", 1, 0)])).toThrow(
		"safe integers",
	);
});
