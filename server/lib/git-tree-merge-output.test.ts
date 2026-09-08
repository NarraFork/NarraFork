import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMergeTreeOutput } from "./git-tree-merge-output";
import { safeSpawn } from "./spawn";

const TREE = "a".repeat(40);
const MAX_OUTPUT_BYTES = 1024 * 1024;
interface Message {
	paths: string[];
	type: string;
	text?: string;
}
function output(index: string[] = [], messages: Message[] = [], tree = TREE): string {
	return `${[
		tree,
		...index,
		"",
		...messages.flatMap(({ paths, type, text }) => [
			String(paths.length),
			...paths,
			type,
			text ?? "opaque human message\n",
		]),
	].join("\0")}\0`;
}
function auto(path: string): Message {
	return { paths: [path], type: "Auto-merging" };
}
function contents(path: string): Message {
	return { paths: [path], type: "CONFLICT (contents)" };
}

describe("parseMergeTreeOutput", () => {
	test("recognizes plural machine contents, not singular human content", () => {
		const parsed = parseMergeTreeOutput(
			output(
				["file"],
				[
					auto("file"),
					{ ...contents("file"), text: "CONFLICT (content): Merge conflict in file\n" },
				],
			),
			1,
		);
		expect(parsed).toEqual({
			tree: TREE,
			conflicts: ["file"],
			hasConflicts: true,
			conflictsComplete: true,
			conflictMarkersComplete: false,
			markerCheckAllowed: true,
		});
		expect(parseMergeTreeOutput(output(["file"], [auto("file"), contents("file")]), 1)).toEqual(
			parsed,
		);
	});

	test("clean results include the empty section separator, even with no messages", () => {
		for (const tree of [TREE, "B".repeat(40), "f".repeat(64)]) {
			for (const messages of [[], [auto("not-a-conflict")]]) {
				expect(parseMergeTreeOutput(output([], messages, tree), 0)).toEqual({
					tree,
					conflicts: [],
					hasConflicts: false,
					conflictsComplete: true,
					conflictMarkersComplete: true,
					markerCheckAllowed: false,
				});
			}
		}
	});

	test("merges and deduplicates index/message paths in first-seen order", () => {
		const parsed = parseMergeTreeOutput(
			output(
				["z", "a", "z"],
				[
					auto("a"),
					contents("a"),
					{ paths: ["from-message"], type: "CONFLICT (modify/delete)" },
					auto("z"),
					contents("z"),
					contents("a"),
				],
			),
			1,
		);
		expect(parsed.conflicts).toEqual(["z", "a", "from-message"]);
		expect(parsed.conflictsComplete).toBe(true);
		expect(parsed.conflictMarkersComplete).toBe(false);
		expect(parsed.markerCheckAllowed).toBe(false);
	});

	test("preserves tabs, newlines, Unicode, backslashes and leading/trailing spaces", () => {
		const paths = [" odd\tname\n中文.txt ", 'quote"back\\slash', "123", " space "];
		const parsed = parseMergeTreeOutput(
			output(
				paths,
				paths.flatMap((path) => [auto(path), contents(path)]),
			),
			1,
		);
		expect(parsed.conflicts).toEqual(paths);
		expect(parsed.conflictMarkersComplete).toBe(false);
		expect(parsed.markerCheckAllowed).toBe(true);
	});

	test("mixed directory split/text conflicts retain the directory, not invented descendants", () => {
		const parsed = parseMergeTreeOutput(
			output(
				["z"],
				[
					{
						paths: ["d"],
						type: "CONFLICT(directory rename unclear split)",
						text: "This prose mentions d/c, but is NOT a machine path list\n",
					},
					auto("z"),
					contents("z"),
				],
			),
			1,
		);
		expect(parsed).toEqual({
			tree: TREE,
			conflicts: ["z", "d"],
			hasConflicts: true,
			conflictsComplete: false,
			conflictMarkersComplete: false,
			markerCheckAllowed: false,
		});
	});

	test("exit 1 means conflicts even without any index or structured conflict paths", () => {
		for (const messages of [[], [auto("cleanly-merged")]]) {
			expect(parseMergeTreeOutput(output([], messages), 1)).toEqual({
				tree: TREE,
				conflicts: [],
				hasConflicts: true,
				conflictsComplete: false,
				conflictMarkersComplete: false,
				markerCheckAllowed: false,
			});
		}
	});

	test("index-only, Auto-merging-only and partially described stages stay incomplete", () => {
		for (const messages of [[], [auto("z")], [auto("z"), contents("z")]]) {
			const parsed = parseMergeTreeOutput(output(["z", "unexplained"], messages), 1);
			expect(parsed.conflicts).toEqual(["z", "unexplained"]);
			expect(parsed.hasConflicts).toBe(true);
			expect(parsed.conflictsComplete).toBe(false);
			expect(parsed.conflictMarkersComplete).toBe(false);
			expect(parsed.markerCheckAllowed).toBe(false);
		}
	});

	for (const type of ["CONFLICT (binary)", "CONFLICT (modify/delete)"]) {
		test(`${type} is file-local but not marker-complete, including duplicate contents`, () => {
			for (const messages of [
				[{ paths: ["file"], type }],
				[auto("file"), { paths: ["file"], type }, contents("file")],
				[contents("file"), auto("file"), { paths: ["file"], type }],
			]) {
				const parsed = parseMergeTreeOutput(output(["file"], messages), 1);
				expect(parsed.conflicts).toEqual(["file"]);
				expect(parsed.conflictsComplete).toBe(true);
				expect(parsed.conflictMarkersComplete).toBe(false);
				expect(parsed.markerCheckAllowed).toBe(false);
			}
		});
	}

	test("contents without same-path Auto-merging can be a symlink or mode-only conflict", () => {
		const parsed = parseMergeTreeOutput(
			output(["link"], [auto("some-other-file"), contents("link")]),
			1,
		);
		expect(parsed.conflictsComplete).toBe(true);
		expect(parsed.conflictMarkersComplete).toBe(false);
		expect(parsed.markerCheckAllowed).toBe(false);
	});

	const structural: Message[] = [
		{ paths: ["moved", "directory"], type: "CONFLICT (file/directory)" },
		{ paths: ["old", "ours", "theirs"], type: "CONFLICT (rename/rename)" },
		{ paths: ["new", "old"], type: "CONFLICT (rename/delete)" },
		{ paths: ["new", "old"], type: "CONFLICT (rename involved in collision)" },
		{ paths: ["original", "relocated"], type: "CONFLICT (distinct modes)" },
		{ paths: ["original", "ours", "theirs"], type: "CONFLICT (distinct modes)" },
		{ paths: ["new/file", "old/file"], type: "CONFLICT (directory rename suggested)" },
		{ paths: ["target", "source"], type: "CONFLICT (file in way of directory rename)" },
		{ paths: ["target", "a", "b", "c"], type: "CONFLICT(directory rename collision)" },
		{ paths: ["d"], type: "CONFLICT(directory rename unclear split)" },
		...[
			"submodule",
			"submodule with possible resolution",
			"submodule not initialized",
			"submodule history not available",
			"submodule may have rewinds",
			"submodule lacks merge base",
		].map((kind) => ({ paths: ["sub"], type: `CONFLICT (${kind})` })),
	];
	for (const message of structural) {
		test(`${message.type}, ${message.paths.length} paths: structure is not a file boundary`, () => {
			const parsed = parseMergeTreeOutput(output([], [message]), 1);
			expect(parsed.conflicts).toEqual(message.paths);
			expect(parsed.hasConflicts).toBe(true);
			expect(parsed.conflictsComplete).toBe(false);
			expect(parsed.conflictMarkersComplete).toBe(false);
			expect(parsed.markerCheckAllowed).toBe(false);
		});
	}

	test("unknown conflicts retain paths but cannot certify completeness", () => {
		for (const type of ["CONFLICT (future type)", "CONFLICT (content)"]) {
			const parsed = parseMergeTreeOutput(
				output(["z"], [auto("z"), contents("z"), { paths: ["d", "z", "branch"], type }]),
				1,
			);
			expect(parsed.conflicts).toEqual(["z", "d", "branch"]);
			expect(parsed.conflictsComplete).toBe(false);
			expect(parsed.conflictMarkersComplete).toBe(false);
			expect(parsed.markerCheckAllowed).toBe(false);
		}
	});

	test("unknown non-Auto-merging messages are conservative, never parsed as prose", () => {
		const unknown = { paths: ["not-known-to-conflict"], type: "New warning", text: "all fine" };
		const parsed = parseMergeTreeOutput(output(["z"], [auto("z"), contents("z"), unknown]), 1);
		expect(parsed.conflicts).toEqual(["z"]);
		expect(parsed.conflictsComplete).toBe(false);
		expect(parsed.conflictMarkersComplete).toBe(false);
		expect(parsed.markerCheckAllowed).toBe(false);
		// Even a new warning on exit 0 does not certify an understood output format.
		expect(parseMergeTreeOutput(output([], [unknown]), 0)).toMatchObject({
			hasConflicts: false,
			conflictsComplete: false,
			conflictMarkersComplete: false,
			markerCheckAllowed: false,
		});
	});

	test("known clean informational messages never add conflict paths", () => {
		const parsed = parseMergeTreeOutput(
			output(
				[],
				[
					{ paths: ["sub"], type: "Fast forwarding submodule" },
					{ paths: ["new", "old"], type: "Path updated due to directory rename" },
					{ ...auto("innocent"), text: "CONFLICT (binary) in secret\n1\tfalse-path" },
				],
			),
			0,
		);
		expect(parsed.conflicts).toEqual([]);
		expect(parsed.conflictsComplete).toBe(true);
		expect(parsed.conflictMarkersComplete).toBe(true);
		expect(parsed.markerCheckAllowed).toBe(false);
	});

	for (const count of [
		"",
		"0",
		"-1",
		"+1",
		"01",
		"1junk",
		"1.0",
		"1e0",
		"0x1",
		" 1",
		"1 ",
		"1\n",
		"NaN",
		"Infinity",
		"1000000000",
		"9007199254740992",
		"9".repeat(1000),
	]) {
		test(`rejects invalid/oversized path count ${JSON.stringify(count.slice(0, 24))}`, () => {
			expect(() => parseMergeTreeOutput(`${TREE}\0\0${count}\0p\0Auto-merging\0text\0`, 1)).toThrow(
				Error,
			);
		});
	}

	test("rejects mismatched known arities before claiming file-local safety", () => {
		for (const [type, paths] of [
			["Auto-merging", ["a", "b"]],
			["CONFLICT (contents)", ["a", "b"]],
			["CONFLICT (binary)", ["a", "b"]],
			["CONFLICT (modify/delete)", ["a", "b"]],
			["CONFLICT (file/directory)", ["a"]],
			["CONFLICT (rename/rename)", ["a", "b"]],
			["CONFLICT (distinct modes)", ["a", "b", "c", "d"]],
			["CONFLICT(directory rename unclear split)", ["a", "b"]],
			["CONFLICT(directory rename collision)", ["a", "b"]],
			["CONFLICT (submodule)", ["a", "b"]],
		] as const) {
			expect(() => parseMergeTreeOutput(output([], [{ type, paths: [...paths] }]), 1)).toThrow(
				Error,
			);
		}
	});

	test("rejects missing section/record boundaries, empty paths/types and trailing garbage", () => {
		const valid = output(["z"], [auto("z"), contents("z")]);
		for (const malformed of [
			"",
			TREE,
			`${TREE}\0`,
			`${TREE}\0z\0`,
			valid.replace("z\0\0", "z\0"),
			valid.slice(0, -1),
			`${valid}\0`,
			`${valid}garbage`,
			`${TREE}\0\0${"1"}\0path\0type\0`, // Missing the opaque message field.
			output([], [{ paths: [""], type: "Auto-merging" }]),
			output([], [{ paths: ["p"], type: "" }]),
		]) {
			expect(() => parseMergeTreeOutput(malformed, 1)).toThrow(Error);
		}
	});

	test("rejects invalid OIDs, unexpected exits and contradictory clean status", () => {
		for (const tree of [
			"",
			"a".repeat(39),
			"a".repeat(41),
			"a".repeat(63),
			"a".repeat(65),
			"g".repeat(40),
			`${TREE}\n`,
			` ${TREE}`,
		]) {
			expect(() => parseMergeTreeOutput(output([], [], tree), 0)).toThrow(Error);
		}
		for (const exitCode of [-1, 2, 128, 129, 1.5, NaN, Infinity]) {
			expect(() => parseMergeTreeOutput(output(), exitCode)).toThrow(Error);
		}
		expect(() => parseMergeTreeOutput(output(["file"]), 0)).toThrow(Error);
		expect(() => parseMergeTreeOutput(output([], [contents("file")]), 0)).toThrow(Error);
	});

	test("bounds bytes, not JS characters, and permits exactly 1 MiB", () => {
		const emptyText = { ...auto("p"), text: "" };
		const overhead = Buffer.byteLength(output([], [emptyText]));
		const atLimit = output([], [{ ...emptyText, text: "x".repeat(MAX_OUTPUT_BYTES - overhead) }]);
		expect(Buffer.byteLength(atLimit)).toBe(MAX_OUTPUT_BYTES);
		expect(parseMergeTreeOutput(atLimit, 0).conflictsComplete).toBe(true);
		expect(() => parseMergeTreeOutput(`${atLimit}\0`, 0)).toThrow("size limit");
		const multibyte = output([], [{ ...emptyText, text: "中".repeat(MAX_OUTPUT_BYTES / 2) }]);
		expect(multibyte.length).toBeLessThan(MAX_OUTPUT_BYTES);
		expect(() => parseMergeTreeOutput(multibyte, 0)).toThrow("size limit");
	});

	test("truncated record prefixes either fail or remain conservatively incomplete", () => {
		const complete = output(["z"], [auto("z"), contents("z")]);
		for (let length = 0; length < complete.length; length++) {
			let parsed: ReturnType<typeof parseMergeTreeOutput>;
			try {
				parsed = parseMergeTreeOutput(complete.slice(0, length), 1);
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				continue;
			}
			expect(parsed.hasConflicts).toBe(true);
			expect(parsed.conflictsComplete).toBe(false);
			expect(parsed.conflictMarkersComplete).toBe(false);
			expect(parsed.markerCheckAllowed).toBe(false);
		}
	});
});

// Integration fixtures write ONLY to disposable bare repositories. No checkout,
// real-project index/ref changes, hooks, global config, or porcelain commits.
const realSpawn = safeSpawn;
const directories: string[] = [];
const cleanEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
async function runGit(dir: string, ...args: string[]) {
	const result = await realSpawn({
		cmd: ["git", ...args],
		cwd: dir,
		env: {
			...cleanEnvironment,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: join(dir, "no-global-config"),
			GIT_ATTR_NOSYSTEM: "1",
			GIT_INDEX_FILE: join(dir, "fixture-index"),
			GIT_AUTHOR_NAME: "Parser test",
			GIT_AUTHOR_EMAIL: "parser@example.invalid",
			GIT_COMMITTER_NAME: "Parser test",
			GIT_COMMITTER_EMAIL: "parser@example.invalid",
			GIT_TERMINAL_PROMPT: "0",
			LC_ALL: "C",
		},
		timeout: 15_000,
		maxOutputBytes: MAX_OUTPUT_BYTES,
		killProcessTree: true,
	});
	if (result.stdoutTruncated || result.stderrTruncated) throw new Error("Git fixture output limit");
	return result;
}
async function git(dir: string, ...args: string[]) {
	const result = await runGit(dir, ...args);
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}
async function repository() {
	const dir = await mkdtemp(join(tmpdir(), "nf-merge-parser-"));
	directories.push(dir);
	await git(dir, "init", "--bare", "--object-format=sha1", "--template=", ".");
	return dir;
}
type TreeFile = readonly [path: string, data: string | Buffer, mode?: string];
async function commitTree(dir: string, files: readonly TreeFile[], parent?: string) {
	await git(dir, "read-tree", "--empty");
	for (const [path, data, mode = "100644"] of files) {
		const blobInput = join(dir, "blob-input");
		await writeFile(blobInput, data);
		const oid = await git(dir, "hash-object", "-w", "--no-filters", "--", blobInput);
		await git(dir, "update-index", "--add", "--cacheinfo", mode, oid, path);
	}
	const tree = await git(dir, "write-tree");
	return git(dir, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "fixture");
}
async function merge(dir: string, ours: string, theirs: string) {
	return runGit(dir, "merge-tree", "--write-tree", "--name-only", "--messages", "-z", ours, theirs);
}
afterEach(async () => {
	for (const dir of directories.splice(0)) {
		await rm(dir, { recursive: true, force: true, maxRetries: 2 });
	}
});

// Pure fixtures still run on old Git; native regression needs --write-tree (2.38+).
const nativeHelp = await realSpawn({
	cmd: ["git", "merge-tree", "-h"],
	cwd: tmpdir(),
	env: cleanEnvironment,
	timeout: 5000,
	maxOutputBytes: 8192,
}).catch(() => null);
const nativeTest = test.skipIf(
	!`${nativeHelp?.stdout}${nativeHelp?.stderr}`.includes("--write-tree"),
);
const TEXT = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";

describe("real native merge-tree -z regression", () => {
	nativeTest("content and clean Auto-merging output have the documented boundaries", async () => {
		const dir = await repository();
		const path = " odd\tname\n中文.txt ";
		const base = await commitTree(dir, [[path, TEXT]]);
		const ours = await commitTree(dir, [[path, TEXT.replace("one", "ours")]], base);
		const theirs = await commitTree(dir, [[path, TEXT.replace("one", "theirs")]], base);
		const conflicted = await merge(dir, ours, theirs);
		expect(conflicted.exitCode).toBe(1);
		expect(conflicted.stdout.split("\0").slice(1, 7)).toEqual([
			path,
			"",
			"1",
			path,
			"Auto-merging",
			`Auto-merging ${path}\n`,
		]);
		expect(conflicted.stdout.split("\0").slice(7)).toEqual([
			"1",
			path,
			"CONFLICT (contents)",
			`CONFLICT (content): Merge conflict in ${path}\n`,
			"",
		]);
		expect(parseMergeTreeOutput(conflicted.stdout, conflicted.exitCode)).toMatchObject({
			conflicts: [path],
			hasConflicts: true,
			conflictsComplete: true,
			conflictMarkersComplete: false,
			markerCheckAllowed: true,
		});
		const conflictedTree = parseMergeTreeOutput(conflicted.stdout, conflicted.exitCode).tree;
		expect(await git(dir, "show", `${conflictedTree}:${path}`)).toContain("<<<<<<<");
		const other = await commitTree(dir, [[path, TEXT.replace("ten", "theirs")]], base);
		const clean = await merge(dir, ours, other);
		expect(clean.exitCode).toBe(0);
		expect(clean.stdout.split("\0").slice(1)).toEqual([
			"",
			"1",
			path,
			"Auto-merging",
			`Auto-merging ${path}\n`,
			"",
		]);
		expect(parseMergeTreeOutput(clean.stdout, clean.exitCode)).toMatchObject({
			conflicts: [],
			hasConflicts: false,
			conflictsComplete: true,
			conflictMarkersComplete: true,
			markerCheckAllowed: false,
		});
	});

	nativeTest("directory split plus text conflict cannot silently omit d/c", async () => {
		const dir = await repository();
		const baseFiles: TreeFile[] = [
			["d/a", "first\n"],
			["d/b", "second\n"],
			["z", "base\n"],
		];
		const base = await commitTree(dir, baseFiles);
		const ours = await commitTree(
			dir,
			[
				["e/a", "first\n"],
				["f/b", "second\n"],
				["z", "ours\n"],
			],
			base,
		);
		const theirs = await commitTree(
			dir,
			[...baseFiles.slice(0, 2), ["d/c", "new\n"], ["z", "theirs\n"]],
			base,
		);
		const result = await merge(dir, ours, theirs);
		expect(result.exitCode).toBe(1);
		// These exact fields come from Git, not a guessed human-message fixture.
		expect(result.stdout.split("\0").slice(1, 7)).toEqual([
			"z",
			"",
			"1",
			"d",
			"CONFLICT(directory rename unclear split)",
			"CONFLICT (directory rename split): Unclear where to rename d to; it was renamed to multiple other directories, with no destination getting a majority of the files.\n",
		]);
		const parsed = parseMergeTreeOutput(result.stdout, result.exitCode);
		expect(parsed.conflicts).toEqual(["z", "d"]);
		expect(parsed.conflictsComplete).toBe(false);
		expect(parsed.conflictMarkersComplete).toBe(false);
		expect(parsed.markerCheckAllowed).toBe(false);
		expect(await git(dir, "show", `${parsed.tree}:d/c`)).toBe("new");
	});

	nativeTest(
		"mode plus a clean text merge can emit contents/Auto-merging without markers",
		async () => {
			const dir = await repository();
			const base = await commitTree(dir, []);
			const ours = await commitTree(dir, [["file", "", "100644"]], base);
			const theirs = await commitTree(dir, [["file", "theirs\n", "100755"]], base);
			const result = await merge(dir, ours, theirs);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("Auto-merging\0");
			expect(result.stdout).toContain("CONFLICT (contents)\0");
			expect(result.stdout).not.toContain("CONFLICT (distinct modes)\0");
			const parsed = parseMergeTreeOutput(result.stdout, result.exitCode);
			expect(await git(dir, "show", `${parsed.tree}:file`)).toBe("theirs");
			expect(parsed.conflictsComplete).toBe(true);
			expect(parsed.conflictMarkersComplete).toBe(false);
			// Same candidate shape as real text conflicts, NOT a marker certificate.
			expect(parsed.markerCheckAllowed).toBe(true);
		},
	);

	for (const kind of ["binary", "modify/delete", "symlink", "mode"] as const) {
		nativeTest(`${kind} cannot claim complete text markers`, async () => {
			const dir = await repository();
			const isMode = kind === "mode";
			const mode = kind === "symlink" ? "120000" : "100644";
			const data = (text: string) =>
				kind === "binary" ? Buffer.from([0, text.charCodeAt(0), 255]) : `${text}\n`;
			const base = await commitTree(dir, isMode ? [] : [["file", data("base"), mode]]);
			const ours = await commitTree(dir, [["file", data(isMode ? "same" : "ours"), mode]], base);
			const theirs = await commitTree(
				dir,
				kind === "modify/delete"
					? []
					: [["file", data(isMode ? "same" : "theirs"), isMode ? "100755" : mode]],
				base,
			);
			const result = await merge(dir, ours, theirs);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain(
				kind === "modify/delete" ? "CONFLICT (modify/delete)\0" : "CONFLICT (contents)\0",
			);
			if (kind === "binary") expect(result.stdout).toContain("CONFLICT (binary)\0");
			if (kind === "symlink" || isMode) expect(result.stdout).not.toContain("Auto-merging\0");
			const parsed = parseMergeTreeOutput(result.stdout, result.exitCode);
			expect(parsed.conflicts).toEqual(["file"]);
			expect(parsed.hasConflicts).toBe(true);
			expect(parsed.conflictsComplete).toBe(true);
			expect(parsed.conflictMarkersComplete).toBe(false);
			expect(parsed.markerCheckAllowed).toBe(false);
		});
	}
});
