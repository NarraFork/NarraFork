import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { narrators } from "../../../../db/schema";
import type { ExecutionBackend } from "../../execution/backend";
import { targetPathSemantics } from "../../execution/path-semantics";
import type { ToolContext, ToolDefinition } from "../../types";
import { askUserQuestionTool } from "../ask-user-question";
import {
	bashTool,
	DEFAULT_BACKGROUND_TIMEOUT_MS,
	MISSING_WORKING_DIRECTORY_RECOVERY_KIND,
	resolveBashTimeoutMs,
} from "../bash";
import {
	BlockAnchorReplacer,
	ContextAwareReplacer,
	EscapeNormalizedReplacer,
	editTool,
	IndentationFlexibleReplacer,
	LineTrimmedReplacer,
	MultiOccurrenceReplacer,
	replace,
	SimpleReplacer,
	TrimmedBoundaryReplacer,
	WhitespaceNormalizedReplacer,
} from "../edit";
import { globTool } from "../glob";
import { grepTool } from "../grep";
import { readTool } from "../read";
import { abortableSleep } from "../terminal";
import { writeTool } from "../write";

// === Test fixtures ===

const TEST_RUN_ID = Date.now().toString(36);
const TEST_NARRATOR_ID = `tool-test-${TEST_RUN_ID}`;
const TEST_DIR = join(tmpdir(), `narrafork-tool-test-${TEST_RUN_ID}`);
const SAMPLE_FILE = join(TEST_DIR, "sample.txt");
const NESTED_DIR = join(TEST_DIR, "sub", "dir");
const NESTED_FILE = join(NESTED_DIR, "nested.ts");

function makeCtx(cwd = TEST_DIR): ToolContext {
	return {
		narratorId: TEST_NARRATOR_ID,
		cwd,
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" as const }),
	};
}

function makeTruncatedBackend(onWrite: () => void): ExecutionBackend {
	return {
		kind: "remote",
		deviceId: "remote-truncated",
		paths: targetPathSemantics("posix"),
		pathFlavor: "posix",
		runtimeGeneration: 1,
		statFile: async () => ({ isDirectory: false, isFile: true, size: 20_000_000 }),
		readFileBytes: async () => ({
			bytes: new TextEncoder().encode("truncated prefix"),
			truncated: true,
			totalSize: 20_000_000,
		}),
		writeFileBytes: async () => {
			onWrite();
		},
	} as unknown as ExecutionBackend;
}

beforeAll(async () => {
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: TEST_NARRATOR_ID,
		title: "Tool test narrator",
		createdAt: now,
		updatedAt: now,
	});
	mkdirSync(NESTED_DIR, { recursive: true });
	writeFileSync(SAMPLE_FILE, "line one\nline two\nline three\nline four\nline five\n");
	writeFileSync(NESTED_FILE, 'export function hello() {\n\treturn "world";\n}\n');
	// Additional files for glob/grep
	writeFileSync(join(TEST_DIR, "a.ts"), "const a = 1;\n");
	writeFileSync(join(TEST_DIR, "b.ts"), "const b = 2;\n");
	writeFileSync(join(TEST_DIR, "c.json"), '{"key": "value"}\n');
});

afterAll(async () => {
	await db.delete(narrators).where(eq(narrators.id, TEST_NARRATOR_ID));
	rmSync(TEST_DIR, { recursive: true, force: true });
});

// ============================================================
// Read tool
// ============================================================

describe("Read", () => {
	test("reads file with line numbers", async () => {
		const result = await readTool.execute({ file_path: SAMPLE_FILE }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line one");
		expect(result.output).toContain("line five");
		// Line numbers should be present
		expect(result.output).toMatch(/\d+│line one/);
		// Metadata should include line counts
		expect(result.metadata).toMatchObject({ readAll: false });
		expect(result.metadata?.totalLines).toBe(result.metadata?.readLines);
	});

	test("reads with absolute path", async () => {
		const result = await readTool.execute({ file_path: SAMPLE_FILE }, makeCtx("/tmp"));
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line one");
	});

	test("reads with relative path resolved against cwd", async () => {
		const result = await readTool.execute({ file_path: "sample.txt" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line one");
	});

	test("offset and limit", async () => {
		const result = await readTool.execute(
			{ file_path: "sample.txt", offset: 2, limit: 2 },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line two");
		expect(result.output).toContain("line three");
		expect(result.output).not.toContain("line one");
		expect(result.output).not.toContain("line four");
	});

	test("returns error for missing file", async () => {
		const result = await readTool.execute({ file_path: "nonexistent.txt" }, makeCtx());
		expect(result.isError).toBe(true);
	});

	test("limit=-1 bypasses the default large-file line cap", async () => {
		const target = join(TEST_DIR, "read-force-full.txt");
		// 3000 short lines — more than the 2000-line default auto-limit, but well
		// under the ~100k char read-all cap. read-all must return every line
		// without a line-count truncation suffix.
		const lines = Array.from({ length: 3000 }, (_, i) => `row ${i}`);
		writeFileSync(target, lines.join("\n"));

		const result = await readTool.execute(
			{ file_path: "read-force-full.txt", limit: -1 },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("row 0");
		expect(result.output).toContain("row 2999");
		// No per-line "[line truncated, … chars total]" marker (short lines) and no
		// "output limited to N lines" suffix (read-all ignores the line cap).
		expect(result.output).not.toContain("line truncated");
		expect(result.output).not.toContain("output limited to");
		expect(result.metadata?.readAll).toBe(true);
		expect(result.metadata?.readLines).toBe(3000);
	});

	test("limit=-1 caps output at ~100k chars", async () => {
		const target = join(TEST_DIR, "read-force-full-large.txt");
		// Create a file well over 100k chars (200k+ with line numbers)
		const lines = Array.from({ length: 15000 }, (_, i) => `line ${i}: ${"x".repeat(20)}`);
		writeFileSync(target, lines.join("\n"));

		const result = await readTool.execute(
			{ file_path: "read-force-full-large.txt", limit: -1 },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.truncated).toBe(true);
		expect(result.output.length).toBeLessThanOrEqual(110_000); // some slack for the suffix
		expect(result.output).toContain("output capped at");
		expect(result.output).toContain("Use offset/limit to read a smaller range");
	});

	test("limit=-1 reads from offset to EOF", async () => {
		const result = await readTool.execute(
			{ file_path: "sample.txt", offset: 2, limit: -1 },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line two");
		expect(result.output).toContain("line three");
		expect(result.output).toContain("line four");
		expect(result.output).toContain("line five");
		expect(result.output).not.toContain("line one");
		expect(result.truncated).toBe(true);
		// offset=2 skips "line one", so read-all streams the remaining 4 lines.
		expect(result.metadata).toMatchObject({ readAll: true, readLines: 4, startLine: 2 });
	});
});

// ============================================================
// Write tool
// ============================================================

describe("Write", () => {
	test("writes file with content", async () => {
		const target = join(TEST_DIR, "write-test.txt");
		const result = await writeTool.execute(
			{ file_path: target, content: "hello world" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("11 bytes");
		const content = await Bun.file(target).text();
		expect(content).toBe("hello world");
	});

	test("writes with relative path", async () => {
		const result = await writeTool.execute(
			{ file_path: "write-rel.txt", content: "relative" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		const content = await Bun.file(join(TEST_DIR, "write-rel.txt")).text();
		expect(content).toBe("relative");
	});

	test("creates parent directories", async () => {
		const result = await writeTool.execute(
			{ file_path: "new/deep/dir/file.txt", content: "deep" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		const content = await Bun.file(join(TEST_DIR, "new/deep/dir/file.txt")).text();
		expect(content).toBe("deep");
	});

	test("does not overwrite a file when the backend read is truncated", async () => {
		let writes = 0;
		const ctx = makeCtx();
		ctx.resolveBackend = () => makeTruncatedBackend(() => writes++);

		const result = await writeTool.execute(
			{ file_path: "/workspace/large.txt", content: "replacement" },
			ctx,
		);

		expect(result.isError).toBeTrue();
		expect(result.output).toContain("truncated");
		expect(writes).toBe(0);
	});
});

// ============================================================
// Edit tool
// ============================================================

describe("Edit", () => {
	const EDIT_FILE = join(TEST_DIR, "edit-target.txt");

	test("replaces unique string", async () => {
		writeFileSync(EDIT_FILE, "foo bar baz");
		const result = await editTool.execute(
			{ file_path: EDIT_FILE, old_string: "bar", new_string: "qux" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(await Bun.file(EDIT_FILE).text()).toBe("foo qux baz");
	});

	test("relative path resolved against cwd", async () => {
		writeFileSync(EDIT_FILE, "aaa bbb ccc");
		const result = await editTool.execute(
			{ file_path: "edit-target.txt", old_string: "bbb", new_string: "ddd" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(await Bun.file(EDIT_FILE).text()).toBe("aaa ddd ccc");
	});

	test("errors on non-unique match without replace_all", async () => {
		writeFileSync(EDIT_FILE, "aaa aaa bbb");
		const result = await editTool.execute(
			{ file_path: EDIT_FILE, old_string: "aaa", new_string: "xxx" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("multiple matches");
	});

	test("replace_all replaces all occurrences", async () => {
		writeFileSync(EDIT_FILE, "aaa aaa bbb");
		const result = await editTool.execute(
			{ file_path: EDIT_FILE, old_string: "aaa", new_string: "xxx", replace_all: true },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(await Bun.file(EDIT_FILE).text()).toBe("xxx xxx bbb");
	});

	test("errors when old_string not found", async () => {
		writeFileSync(EDIT_FILE, "hello world");
		const result = await editTool.execute(
			{ file_path: EDIT_FILE, old_string: "missing", new_string: "x" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not found");
	});

	test("errors when old_string === new_string", async () => {
		writeFileSync(EDIT_FILE, "hello world");
		const result = await editTool.execute(
			{ file_path: EDIT_FILE, old_string: "hello", new_string: "hello" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("identical");
	});

	test("creates file when old_string is empty", async () => {
		const newFile = join(TEST_DIR, "edit-create.txt");
		const result = await editTool.execute(
			{ file_path: newFile, old_string: "", new_string: "brand new content" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(await Bun.file(newFile).text()).toBe("brand new content");
	});

	test("does not replace content when the backend read is truncated", async () => {
		let writes = 0;
		const ctx = makeCtx();
		ctx.resolveBackend = () => makeTruncatedBackend(() => writes++);

		const result = await editTool.execute(
			{ file_path: "/workspace/large.txt", old_string: "prefix", new_string: "replacement" },
			ctx,
		);

		expect(result.isError).toBeTrue();
		expect(result.output).toContain("truncated");
		expect(writes).toBe(0);
	});

	test("does not use empty-search overwrite mode on a truncated existing file", async () => {
		let writes = 0;
		const ctx = makeCtx();
		ctx.resolveBackend = () => makeTruncatedBackend(() => writes++);

		const result = await editTool.execute(
			{ file_path: "/workspace/large.txt", old_string: "", new_string: "replacement" },
			ctx,
		);

		expect(result.isError).toBeTrue();
		expect(result.output).toContain("truncated");
		expect(writes).toBe(0);
	});

	test("errors on missing file", async () => {
		const result = await editTool.execute(
			{ file_path: "nonexistent-edit.txt", old_string: "x", new_string: "y" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not found");
	});

	test("normalizes CRLF line endings", async () => {
		writeFileSync(EDIT_FILE, "line1\r\nline2\r\nline3");
		const result = await editTool.execute(
			{ file_path: EDIT_FILE, old_string: "line1\nline2", new_string: "replaced" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(await Bun.file(EDIT_FILE).text()).toContain("replaced");
	});
});

// ============================================================
// Edit — cascading replacer unit tests (replace function)
// ============================================================

describe("Edit replace() — fuzzy matching", () => {
	test("exact match (SimpleReplacer)", () => {
		const result = replace("foo bar baz", "bar", "qux");
		expect(result.content).toBe("foo qux baz");
		expect(result.startLine).toBe(1);
	});

	test("line-trimmed match (LineTrimmedReplacer)", () => {
		// File has 4-space indent, search has 2-space indent
		const content = "function test() {\n    const x = 1;\n    return x;\n}";
		const result = replace(content, "  const x = 1;\n  return x;", "  const y = 2;\n  return y;");
		expect(result.content).toContain("const y = 2");
		expect(result.content).toContain("return y");
	});

	test("block-anchor match (BlockAnchorReplacer)", () => {
		const content = [
			"function hello() {",
			"  const a = 1;",
			"  const b = 2;",
			"  const c = 3;",
			"  return a + b + c;",
			"}",
		].join("\n");
		// Search with slightly different middle lines but same anchors
		const oldStr = [
			"function hello() {",
			"  const a = 1;",
			"  const b = 99;", // different middle
			"  const c = 3;",
			"  return a + b + c;",
			"}",
		].join("\n");
		const newStr = "function hello() { return 6; }";
		const result = replace(content, oldStr, newStr);
		expect(result.content).toBe("function hello() { return 6; }");
	});

	test("whitespace-normalized match (WhitespaceNormalizedReplacer)", () => {
		const content = "const   x   =   1;";
		const result = replace(content, "const x = 1;", "const x = 2;");
		expect(result.content).toBe("const x = 2;");
	});

	test("indentation-flexible match (IndentationFlexibleReplacer)", () => {
		const content = "    if (true) {\n        doSomething();\n    }";
		// Search with no indentation
		const result = replace(
			content,
			"if (true) {\n    doSomething();\n}",
			"if (false) {\n    doNothing();\n}",
		);
		expect(result.content).toContain("doNothing");
	});

	test("escape-normalized match (EscapeNormalizedReplacer)", () => {
		const content = 'console.log("hello\\nworld");';
		// Search with literal escape sequences
		const result = replace(content, 'console.log("hello\\nworld");', 'console.log("goodbye");');
		expect(result.content).toBe('console.log("goodbye");');
	});

	test("trimmed-boundary match (TrimmedBoundaryReplacer)", () => {
		const content = "hello world";
		const result = replace(content, "  hello world  ", "goodbye");
		expect(result.content).toBe("goodbye");
	});

	test("context-aware match (ContextAwareReplacer)", () => {
		const content = [
			"class Foo {",
			"  private x = 1;",
			"  private y = 2;",
			"  private z = 3;",
			"  constructor() {}",
			"}",
		].join("\n");
		// Same first/last anchors, same line count, >50% middle match
		const oldStr = [
			"class Foo {",
			"  private x = 1;",
			"  private y = 999;", // 1 of 3 middle lines differs
			"  private z = 3;",
			"  constructor() {}",
			"}",
		].join("\n");
		const result = replace(content, oldStr, "class Foo {}");
		expect(result.content).toBe("class Foo {}");
	});

	test("multi-occurrence with replace_all (MultiOccurrenceReplacer)", () => {
		const result = replace("aaa bbb aaa ccc aaa", "aaa", "xxx", true);
		expect(result.content).toBe("xxx bbb xxx ccc xxx");
	});

	test("replace_all with exact match", () => {
		const result = replace("aaa bbb aaa", "aaa", "xxx", true);
		expect(result.content).toBe("xxx bbb xxx");
	});

	test("throws on not found", () => {
		expect(() => replace("hello", "missing", "x")).toThrow("not found");
	});

	test("throws on multiple matches without replaceAll", () => {
		expect(() => replace("aaa bbb aaa", "aaa", "xxx")).toThrow("multiple matches");
	});

	test("throws on identical old/new", () => {
		expect(() => replace("hello", "hello", "hello")).toThrow("identical");
	});
});

// ============================================================
// Edit — individual Replacer isolation tests
// ============================================================

describe("Edit Replacers — isolated", () => {
	function collect(replacer: typeof SimpleReplacer, content: string, find: string): string[] {
		return [...replacer(content, find)];
	}

	// --- SimpleReplacer ---
	test("SimpleReplacer yields the find string itself", () => {
		expect(collect(SimpleReplacer, "anything", "foo")).toEqual(["foo"]);
	});

	// --- LineTrimmedReplacer ---
	test("LineTrimmedReplacer matches despite leading/trailing whitespace on lines", () => {
		const content = "  hello  \n  world  ";
		const results = collect(LineTrimmedReplacer, content, "hello\nworld");
		expect(results.length).toBe(1);
		expect(results[0]).toBe("  hello  \n  world  ");
	});

	test("LineTrimmedReplacer yields nothing when lines don't match", () => {
		expect(collect(LineTrimmedReplacer, "aaa\nbbb", "aaa\nccc")).toEqual([]);
	});

	// --- BlockAnchorReplacer ---
	test("BlockAnchorReplacer requires at least 3 lines", () => {
		expect(collect(BlockAnchorReplacer, "a\nb", "a\nb")).toEqual([]);
	});

	test("BlockAnchorReplacer matches with different middle content", () => {
		const content = "START\noriginal middle\nEND";
		const results = collect(BlockAnchorReplacer, content, "START\ntotally different\nEND");
		expect(results.length).toBe(1);
		expect(results[0]).toBe("START\noriginal middle\nEND");
	});

	test("BlockAnchorReplacer picks best candidate among multiple", () => {
		const content = "START\nalpha\nEND\nSTART\nbeta\nEND";
		// Search for something closer to "beta"
		const results = collect(BlockAnchorReplacer, content, "START\nbeta\nEND");
		expect(results.length).toBe(1);
		expect(results[0]).toContain("beta");
	});

	// --- WhitespaceNormalizedReplacer ---
	test("WhitespaceNormalizedReplacer collapses multiple spaces", () => {
		const content = "const   x   =   1;";
		const results = collect(WhitespaceNormalizedReplacer, content, "const x = 1;");
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0]).toBe("const   x   =   1;");
	});

	test("WhitespaceNormalizedReplacer handles multi-line", () => {
		const content = "a  b\nc  d";
		const results = collect(WhitespaceNormalizedReplacer, content, "a b\nc d");
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	// --- IndentationFlexibleReplacer ---
	test("IndentationFlexibleReplacer matches blocks with different base indent", () => {
		const content = "        if (x) {\n            y();\n        }";
		const find = "    if (x) {\n        y();\n    }";
		const results = collect(IndentationFlexibleReplacer, content, find);
		expect(results.length).toBe(1);
		expect(results[0]).toBe(content);
	});

	test("IndentationFlexibleReplacer yields nothing when structure differs", () => {
		const content = "    if (x) {\n        y();\n    }";
		const find = "    if (x) {\n        z();\n    }";
		expect(collect(IndentationFlexibleReplacer, content, find)).toEqual([]);
	});

	// --- EscapeNormalizedReplacer ---
	test("EscapeNormalizedReplacer handles \\n in search", () => {
		const content = "line1\nline2";
		const results = collect(EscapeNormalizedReplacer, content, "line1\\nline2");
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	test("EscapeNormalizedReplacer handles \\t", () => {
		const content = "col1\tcol2";
		const results = collect(EscapeNormalizedReplacer, content, "col1\\tcol2");
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	test("EscapeNormalizedReplacer handles escaped quotes", () => {
		const content = 'say "hello"';
		const results = collect(EscapeNormalizedReplacer, content, 'say \\"hello\\"');
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	// --- TrimmedBoundaryReplacer ---
	test("TrimmedBoundaryReplacer trims leading/trailing whitespace from find", () => {
		const content = "hello world";
		const results = collect(TrimmedBoundaryReplacer, content, "\n  hello world  \n");
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	test("TrimmedBoundaryReplacer skips when find is already trimmed", () => {
		expect(collect(TrimmedBoundaryReplacer, "hello", "hello")).toEqual([]);
	});

	// --- ContextAwareReplacer ---
	test("ContextAwareReplacer requires at least 3 lines", () => {
		expect(collect(ContextAwareReplacer, "a\nb", "a\nb")).toEqual([]);
	});

	test("ContextAwareReplacer matches when >50% middle lines match", () => {
		const content = "HEADER\nline1\nline2\nline3\nFOOTER";
		// 2 of 3 middle lines match
		const find = "HEADER\nline1\nDIFFERENT\nline3\nFOOTER";
		const results = collect(ContextAwareReplacer, content, find);
		expect(results.length).toBe(1);
	});

	test("ContextAwareReplacer rejects when <50% middle lines match", () => {
		const content = "HEADER\nline1\nline2\nline3\nFOOTER";
		// 0 of 3 middle lines match
		const find = "HEADER\nAAA\nBBB\nCCC\nFOOTER";
		const results = collect(ContextAwareReplacer, content, find);
		expect(results).toEqual([]);
	});

	test("ContextAwareReplacer requires same line count", () => {
		const content = "HEADER\nline1\nline2\nFOOTER";
		const find = "HEADER\nline1\nline2\nextra\nFOOTER";
		expect(collect(ContextAwareReplacer, content, find)).toEqual([]);
	});

	// --- MultiOccurrenceReplacer ---
	test("MultiOccurrenceReplacer yields every exact match", () => {
		const results = collect(MultiOccurrenceReplacer, "aaa bbb aaa ccc aaa", "aaa");
		expect(results).toEqual(["aaa", "aaa", "aaa"]);
	});

	test("MultiOccurrenceReplacer yields nothing when not found", () => {
		expect(collect(MultiOccurrenceReplacer, "hello", "missing")).toEqual([]);
	});
});

// ============================================================
// Glob tool
// ============================================================

describe("Glob", () => {
	test("finds .ts files", async () => {
		const result = await globTool.execute({ pattern: "*.ts" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("a.ts");
		expect(result.output).toContain("b.ts");
	});

	test("finds nested files with **", async () => {
		const result = await globTool.execute({ pattern: "**/*.ts" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("nested.ts");
	});

	test("returns no matches for non-matching pattern", async () => {
		const result = await globTool.execute({ pattern: "*.xyz" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("No matches");
	});

	test("respects path parameter", async () => {
		const result = await globTool.execute({ pattern: "*.ts", path: NESTED_DIR }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("nested.ts");
		expect(result.output).not.toContain("a.ts");
	});
});

// ============================================================
// Grep tool
// ============================================================

describe("Grep", () => {
	test("files_with_matches mode returns file paths (default)", async () => {
		const result = await grepTool.execute({ pattern: "const" }, makeCtx());
		expect(result.isError).toBeFalsy();
		// Default mode is files_with_matches — returns file paths
		expect(result.output).toContain(".ts");
	});

	test("content mode returns lines with line numbers", async () => {
		const result = await grepTool.execute({ pattern: "const", output_mode: "content" }, makeCtx());
		expect(result.isError).toBeFalsy();
		// rg -n outputs "path:linenum:content"
		expect(result.output).toMatch(/:\d+:/);
	});

	test("returns title and metadata", async () => {
		const result = await grepTool.execute({ pattern: "const" }, makeCtx());
		expect(result.title).toBe("const");
		expect(result.metadata).toBeDefined();
		expect(result.metadata?.matches).toBeGreaterThan(0);
		expect(result.metadata?.truncated).toBe(false);
	});

	test("no matches returns informative message", async () => {
		const result = await grepTool.execute({ pattern: "zzz_nonexistent_zzz" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("No matches found");
		expect(result.metadata).toEqual({ matches: 0, truncated: false, usedFallback: false });
	});

	test("glob filter restricts scope", async () => {
		const result = await grepTool.execute({ pattern: "const", glob: "*.ts" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("a.ts");
		expect(result.output).not.toContain("c.json");
	});

	test("glob with multiple extensions via brace expansion", async () => {
		const result = await grepTool.execute({ pattern: ".", glob: "*.{ts,json}" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain(".ts");
		expect(result.output).toContain(".json");
	});

	test("relative path resolved against cwd", async () => {
		const result = await grepTool.execute(
			{ pattern: "line", path: "sample.txt", output_mode: "content" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line one");
	});

	test("searches specific file", async () => {
		const result = await grepTool.execute(
			{ pattern: "line", path: SAMPLE_FILE, output_mode: "content" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line one");
		// rg -n outputs line numbers like "1:line one"
		expect(result.output).toContain("1:");
	});

	test("glob filter finds matching files", async () => {
		writeFileSync(join(TEST_DIR, "a.ts"), "const a = 1;\n");
		const result = await grepTool.execute(
			{ pattern: "const", glob: "*.ts", output_mode: "content" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("a.ts");
		expect(result.output).toContain("b.ts");
	});

	test("long lines are included in output", async () => {
		const longLine = "x".repeat(3000);
		writeFileSync(join(TEST_DIR, "long.txt"), `${longLine}\n`);
		const result = await grepTool.execute(
			{ pattern: "x+", path: join(TEST_DIR, "long.txt"), output_mode: "content" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("x");
	});

	test("searches hidden files", async () => {
		writeFileSync(join(TEST_DIR, ".hidden"), "secret_value\n");
		const result = await grepTool.execute(
			{ pattern: "secret_value", path: TEST_DIR, output_mode: "content" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("secret_value");
	});

	test("invalid regex returns error", async () => {
		const result = await grepTool.execute({ pattern: "[invalid" }, makeCtx());
		expect(result.isError).toBe(true);
	});
});

// ============================================================
// Grep — shell injection safety
// ============================================================

describe("Grep injection safety", () => {
	test("pattern with shell metacharacters is not interpreted", async () => {
		const marker = join(TEST_DIR, "pwned");
		const _result = await grepTool.execute(
			{ pattern: `$(touch ${marker})`, path: SAMPLE_FILE },
			makeCtx(),
		);
		expect(existsSync(marker)).toBe(false);
	});

	test("path with shell metacharacters is not interpreted", async () => {
		const marker = join(TEST_DIR, "pwned2");
		const _result = await grepTool.execute(
			{ pattern: "line", path: `$(touch ${marker})` },
			makeCtx(),
		);
		expect(existsSync(marker)).toBe(false);
	});

	test("glob with shell metacharacters is not interpreted", async () => {
		const marker = join(TEST_DIR, "pwned3");
		const _result = await grepTool.execute(
			{ pattern: "line", glob: `$(touch ${marker})` },
			makeCtx(),
		);
		expect(existsSync(marker)).toBe(false);
	});

	test("pattern with semicolon and pipe is treated literally", async () => {
		const result = await grepTool.execute({ pattern: "; echo INJECTED | cat" }, makeCtx());
		expect(result.output).not.toContain("INJECTED");
	});

	test("pattern with backticks is treated literally", async () => {
		const marker = join(TEST_DIR, "pwned4");
		const _result = await grepTool.execute({ pattern: `\`touch ${marker}\`` }, makeCtx());
		expect(existsSync(marker)).toBe(false);
	});
});

describe("Grep schema validation", () => {
	test("rejects missing pattern", () => {
		const result = grepTool.parameters.safeParse({});
		expect(result.success).toBe(false);
	});

	test("accepts all CC params", () => {
		const result = grepTool.parameters.safeParse({
			pattern: "x",
			output_mode: "content",
			"-i": true,
			"-B": 3,
			"-A": 3,
			"-n": true,
			glob: "*.ts",
			type: "ts",
			head_limit: 10,
			offset: 5,
			multiline: true,
		});
		expect(result.success).toBe(true);
	});

	test("accepts minimal params", () => {
		const parsed = grepTool.parameters.safeParse({ pattern: "x" });
		expect(parsed.success).toBe(true);
	});

	test("accepts path and glob", () => {
		const result = grepTool.parameters.safeParse({
			pattern: "test",
			path: "/tmp",
			glob: "*.ts",
		});
		expect(result.success).toBe(true);
	});
});
// ============================================================

describe("Bash", () => {
	test("executes simple command", async () => {
		const result = await bashTool.execute({ command: "echo hello" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output.trim()).toBe("hello");
	});

	test("captures stderr", async () => {
		const result = await bashTool.execute({ command: "echo err >&2" }, makeCtx());
		expect(result.output).toContain("err");
	});

	test("reports non-zero exit code", async () => {
		const result = await bashTool.execute({ command: "exit 42" }, makeCtx());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("exit code: 42");
	});

	test("uses cwd", async () => {
		const result = await bashTool.execute({ command: "pwd" }, makeCtx());
		expect(result.output.trim()).toBe(TEST_DIR);
	});

	test("respects timeout", async () => {
		const result = await bashTool.execute({ command: "sleep 10", timeout: 500 }, makeCtx());
		// Should be killed before completing
		expect(result.isError).toBe(true);
	});

	test("timeout appends bash_metadata", async () => {
		const result = await bashTool.execute({ command: "sleep 10", timeout: 500 }, makeCtx());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("<bash_metadata>");
		expect(result.output).toContain("timed out");
	});

	test("background timeout defaults to five hours and accepts unlimited values", () => {
		expect(resolveBashTimeoutMs(true)).toBe(DEFAULT_BACKGROUND_TIMEOUT_MS);
		expect(resolveBashTimeoutMs(true, 0)).toBeUndefined();
		expect(resolveBashTimeoutMs(true, 2_147_483_648)).toBe(2_147_483_648);
	});

	test("foreground timeout keeps its default and safety cap", () => {
		expect(resolveBashTimeoutMs(false)).toBe(120_000);
		expect(resolveBashTimeoutMs(false, 2_147_483_648)).toBe(86_400_000);
	});

	test("abort kills process and reports in metadata", async () => {
		const ac = new AbortController();
		const ctx = makeCtx();
		ctx.signal = ac.signal;
		// Abort after 200ms
		setTimeout(() => ac.abort(), 200);
		const result = await bashTool.execute({ command: "sleep 10" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("<bash_metadata>");
		expect(result.output).toContain("aborted");
	});

	test("kills child processes on timeout (no orphans)", async () => {
		// Spawn a bash that forks a background child writing to a file
		const marker = join(TEST_DIR, "orphan-marker");
		const cmd = `bash -c 'while true; do echo x >> ${marker}; sleep 0.1; done' &\nsleep 10`;
		const result = await bashTool.execute({ command: cmd, timeout: 600 }, makeCtx());
		expect(result.isError).toBe(true);
		// Wait a bit to see if the child is still writing
		const sizeBefore = await Bun.file(marker)
			.text()
			.then((t) => t.length)
			.catch(() => 0);
		await Bun.sleep(500);
		const sizeAfter = await Bun.file(marker)
			.text()
			.then((t) => t.length)
			.catch(() => 0);
		// If killTree worked, the child should have stopped writing
		expect(sizeAfter).toBe(sizeBefore);
	});

	test("pre-aborted signal kills immediately", async () => {
		const ac = new AbortController();
		ac.abort(); // Already aborted
		const ctx = makeCtx();
		ctx.signal = ac.signal;
		const start = Date.now();
		const result = await bashTool.execute({ command: "sleep 10" }, ctx);
		const elapsed = Date.now() - start;
		expect(result.isError).toBe(true);
		expect(result.output).toContain("aborted");
		// Should finish quickly, not wait for sleep
		expect(elapsed).toBeLessThan(3000);
	});

	test("negative timeout is clamped to 0", async () => {
		const result = await bashTool.execute({ command: "sleep 10", timeout: -1 }, makeCtx());
		expect(result.isError).toBe(true);
	});

	test("emitOutput is called with streaming output", async () => {
		const chunks: string[] = [];
		const ctx = makeCtx();
		ctx.emitOutput = (output: string) => chunks.push(output);
		await bashTool.execute({ command: "echo line1 && echo line2" }, ctx);
		// emitOutput should have been called at least once with cumulative output
		expect(chunks.length).toBeGreaterThanOrEqual(1);
		const last = chunks[chunks.length - 1];
		expect(last).toContain("line1");
		expect(last).toContain("line2");
	});

	test("large output is truncated and marked", async () => {
		// Generate output exceeding MAX_LINES (2000) / MAX_BYTES (50KB)
		const result = await bashTool.execute({ command: "seq 1 3000" }, makeCtx());
		expect(result.truncated).toBe(true);
		expect(result.output).toContain("truncated");
		expect(typeof result.metadata?.fullOutputPath).toBe("string");
		expect(await Bun.file(result.metadata?.fullOutputPath as string).text()).toContain("3000");
	});

	test("workdir changes the working directory", async () => {
		const result = await bashTool.execute({ command: "pwd", workdir: NESTED_DIR }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output.trim()).toBe(NESTED_DIR);
	});

	test("workdir resolves relative paths against cwd", async () => {
		const result = await bashTool.execute({ command: "pwd", workdir: "sub/dir" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output.trim()).toBe(NESTED_DIR);
	});

	test("description is used as title", async () => {
		const result = await bashTool.execute(
			{ command: "echo hello", description: "Prints greeting" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.title).toBe("Prints greeting");
	});

	test("title falls back to command when description is omitted", async () => {
		const result = await bashTool.execute({ command: "echo hello" }, makeCtx());
		expect(result.title).toBe("echo hello");
	});

	test("title falls back to command when description is empty string", async () => {
		const result = await bashTool.execute({ command: "echo hello", description: "" }, makeCtx());
		expect(result.title).toBe("echo hello");
	});

	test("a bad workdir argument is retryable, not a fatal session stop", async () => {
		// The session cwd is fine, so only this call is wrong. Killing the narrator here
		// would throw away a whole conversation over a model-supplied path typo.
		const result = await bashTool.execute(
			{ command: "pwd", workdir: "/no/such/directory" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.fatal).toBeFalsy();
		expect(result.metadata?.cwdRecovery).toBeUndefined();
		expect(result.output).toContain("/no/such/directory");
		expect(result.output).toContain("workdir");
		expect(result.output).toContain(TEST_DIR);
	});

	test("returns fatal recovery metadata when the session cwd is gone", async () => {
		const missingCwd = join(TEST_DIR, "removed-session-cwd");
		const result = await bashTool.execute({ command: "pwd" }, makeCtx(missingCwd));
		expect(result.isError).toBe(true);
		expect(result.fatal).toBe(true);
		expect(result.output).toContain("does not exist");
		expect(result.metadata).toMatchObject({
			cwdRecovery: {
				kind: MISSING_WORKING_DIRECTORY_RECOVERY_KIND,
				missingCwd,
			},
		});
	});

	test("a workdir under a missing session cwd stays fatal", async () => {
		// Both the argument and the session cwd are unusable, so there is nothing left
		// to retry against — keep the fatal stop plus the recovery card.
		const missingCwd = join(TEST_DIR, "removed-session-cwd");
		const result = await bashTool.execute(
			{ command: "pwd", workdir: "nested" },
			makeCtx(missingCwd),
		);
		expect(result.fatal).toBe(true);
		expect(result.metadata).toMatchObject({
			cwdRecovery: {
				kind: MISSING_WORKING_DIRECTORY_RECOVERY_KIND,
				missingCwd: join(missingCwd, "nested"),
			},
		});
	});

	test("workdir allows path traversal but resolves against cwd", async () => {
		// ../  from TEST_DIR should resolve to its parent
		const result = await bashTool.execute({ command: "pwd", workdir: ".." }, makeCtx());
		expect(result.isError).toBeFalsy();
		const { dirname } = await import("node:path");
		expect(result.output.trim()).toBe(dirname(TEST_DIR));
	});
});

describe("Terminal", () => {
	test("abortableSleep resolves false when aborted", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 50);
		const startedAt = Date.now();
		const completed = await abortableSleep(5_000, ac.signal);
		expect(completed).toBe(false);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});

	test("abortableSleep resolves true when timer completes", async () => {
		const completed = await abortableSleep(20, new AbortController().signal);
		expect(completed).toBe(true);
	});
});

	test("pre-aborted signal stops before request", async () => {
		let acquiredContext = false;
		const fakeTokenManager = {
			maxRetries: 1,
			acquireContext: async () => {
				acquiredContext = true;
				throw new Error("should not acquire context after abort");
			},
		const ac = new AbortController();
		ac.abort();

		await expect(client.callTool("web_search", { query: "hello" }, ac.signal)).rejects.toThrow(
			"Aborted",
		);
		expect(acquiredContext).toBe(false);
	});
});

// ============================================================
// zodToJsonSchema (tool-registry)
// ============================================================

import { z } from "zod/v4";
import { resolveToolJsonSchema, zodToJsonSchema } from "../../tool-registry";
import { agentTool } from "../task";

describe("zodToJsonSchema", () => {
	test("converts simple object schema", () => {
		const schema = z.object({
			name: z.string(),
			age: z.number().optional(),
		});
		const json = zodToJsonSchema(schema);
		expect(json).toEqual({
			type: "object",
			additionalProperties: false,
			properties: {
				name: { type: "string" },
				age: { type: "number" },
			},
			required: ["name"],
		});
	});

	test("converts enum schema", () => {
		const schema = z.object({
			mode: z.enum(["a", "b", "c"]),
		});
		const json = zodToJsonSchema(schema);
		const props = json.properties as Record<string, { enum?: unknown }>;
		expect(props.mode.enum).toEqual(["a", "b", "c"]);
	});

	test("converts boolean schema", () => {
		const schema = z.object({ flag: z.boolean() });
		const json = zodToJsonSchema(schema);
		const props = json.properties as Record<string, { type?: string }>;
		expect(props.flag).toEqual({ type: "boolean" });
	});

	test("converts grep tool schema without error", () => {
		const json = zodToJsonSchema(grepTool.parameters);
		expect(json.type).toBe("object");
		const props = json.properties as Record<string, { type?: string; description?: string }>;
		expect(props.pattern.type).toBe("string");
		expect(props.pattern.description).toBeDefined();
		expect(props.glob.type).toBe("string");
		expect(props.glob.description).toBeDefined();
	});

	test("converts all tool schemas without error", () => {
		const tools = [
			readTool,
			writeTool,
			editTool,
			globTool,
			grepTool,
			bashTool,
			startPipelineTool,
			extractPipelineTool,
		];
		for (const tool of tools) {
			const json = zodToJsonSchema(tool.parameters);
			expect(json.type).toBe("object");
			expect(json.properties).toBeDefined();
		}
	});
});

// ============================================================
// Agent tool — rawJsonSchema parity with Zod schema
// ============================================================

type TestJsonSchema = {
	properties?: Record<string, { type?: string; enum?: unknown; description?: string } | undefined>;
	required?: string[];
};

function requireRawJsonSchema(tool: ToolDefinition): TestJsonSchema {
	const schema = tool.rawJsonSchema;
	if (!schema) throw new Error(`${tool.name} rawJsonSchema is missing`);
	return schema as TestJsonSchema;
}

describe("Agent tool rawJsonSchema", () => {
	test("rawJsonSchema includes model parameter", () => {
		const schema = requireRawJsonSchema(agentTool);
		const props = schema.properties ?? {};
		expect(props.model).toBeDefined();
		expect(props.model?.type).toBe("string");
	});

	test("rawJsonSchema includes workdir parameter", () => {
		const schema = requireRawJsonSchema(agentTool);
		const props = schema.properties ?? {};
		expect(props.workdir).toBeDefined();
		expect(props.workdir?.type).toBe("string");
	});

	test("rawJsonSchema includes reasoning_effort parameter", () => {
		const schema = requireRawJsonSchema(agentTool);
		const props = schema.properties ?? {};
		expect(props.reasoning_effort).toBeDefined();
		expect(props.reasoning_effort?.type).toBe("string");
		expect(props.reasoning_effort?.enum).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
		expect(props.reasoning_effort?.description).toContain("ignored");
	});

	test("exposes optional execution timeout without a policy maximum", () => {
		const schema = requireRawJsonSchema(agentTool);
		const props = schema.properties ?? {};
		expect(props.timeout?.type).toBe("number");
		expect(props.timeout?.description).toContain("no wall-clock limit");
		expect(
			agentTool.parameters.safeParse({ prompt: "inspect", timeout: 2_147_483_648 }).success,
		).toBe(true);
		// Lenient numeric handling: out-of-range/negative timeouts no longer fail
		// validation — they are clamped at execution time (negative → 0 = no limit).
		expect(agentTool.parameters.safeParse({ prompt: "inspect", timeout: -1 }).success).toBe(true);
		expect(agentTool.parameters.safeParse({ prompt: "inspect", timeout: "3000" }).success).toBe(
			true,
		);
	});

	test("model description includes available models list", () => {
		const schema = requireRawJsonSchema(agentTool);
		const props = schema.properties ?? {};
		expect(props.model?.description).toContain("Available models:");
	});

	test("rawJsonSchema no longer includes resume parameter", () => {
		const schema = requireRawJsonSchema(agentTool);
		const props = schema.properties ?? {};
		expect(props.resume).toBeUndefined();
	});

	test("rawJsonSchema is dynamic (getter, not static)", () => {
		// Accessing rawJsonSchema twice should return equal but not identical objects
		const a = agentTool.rawJsonSchema;
		const b = agentTool.rawJsonSchema;
		expect(a).toEqual(b);
		expect(a).not.toBe(b);
	});

	test("resolveToolJsonSchema uses rawJsonSchema over Zod", () => {
		const resolved = resolveToolJsonSchema(agentTool);
		const raw = requireRawJsonSchema(agentTool);
		expect(resolved).toEqual(raw);
	});

	test("rawJsonSchema covers all Zod parameter keys", () => {
		const zodSchema = zodToJsonSchema(agentTool.parameters);
		const zodKeys = Object.keys(zodSchema.properties as Record<string, unknown>);
		const rawKeys = Object.keys(requireRawJsonSchema(agentTool).properties ?? {});
		// Zod and rawJsonSchema now use the same parameter names
		for (const key of zodKeys) {
			expect(rawKeys).toContain(key);
		}
	});

	test("rawJsonSchema.required matches Zod required fields", () => {
		const zodSchema = zodToJsonSchema(agentTool.parameters);
		const zodRequired = new Set((zodSchema.required as string[]) ?? []);
		const rawRequired = new Set(requireRawJsonSchema(agentTool).required ?? []);
		// Every field required in rawJsonSchema must also be required in Zod
		for (const key of rawRequired) {
			expect(zodRequired).toContain(key);
		}
		// Every field required in Zod must also be required in rawJsonSchema
		for (const key of zodRequired) {
			expect(rawRequired).toContain(key);
		}
	});
});

// ============================================================
// All tools with rawJsonSchema — parity with Zod schema
// ============================================================

import { awaitTool, DEFAULT_AWAIT_TIMEOUT_MS } from "../await";
import { extractPipelineTool, startPipelineTool } from "../pipeline";
import { enterPlanModeTool, exitPlanModeTool } from "../plan-mode";
import { sendTool } from "../send";
import { skillTool } from "../skill";
import { teamStatusTool } from "../team-status";
import { webFetchTool } from "../web-fetch";
import { webSearchTool } from "../web-search";

describe("Await tool timeout guidance", () => {
	test("defaults to 10 minutes and recommends longer implementation waits", () => {
		expect(DEFAULT_AWAIT_TIMEOUT_MS).toBe(600_000);
		const generatedSchema = zodToJsonSchema(awaitTool.parameters) as TestJsonSchema;
		const rawSchema = requireRawJsonSchema(awaitTool);
		const toolDescription = typeof awaitTool.description === "string" ? awaitTool.description : "";
		const descriptions = [
			toolDescription,
			generatedSchema.properties?.timeout?.description,
			rawSchema.properties?.timeout?.description,
		];

		for (const description of descriptions) {
			const guidance = description ?? "";
			expect(guidance.toLowerCase()).toContain("default");
			expect(guidance).toContain("600000");
			expect(guidance).toContain("10 minutes");
			expect(guidance).toContain("1800000");
			expect(guidance).toContain("30 minutes");
			expect(guidance.toLowerCase()).toContain("repeated short");
		}
	});
});

describe("Skill tool rawJsonSchema", () => {
	test("exposes runtime-supported name alias without over-requiring skill", () => {
		const schema = requireRawJsonSchema(skillTool);
		const props = schema.properties ?? {};
		expect(props.name).toBeDefined();
		expect(props.skill).toBeDefined();
		expect(props.args).toBeDefined();
		expect(schema.required ?? []).not.toContain("skill");
	});
});

// WebFetch keeps mode optional at the raw provider-schema layer so callers may rely on the
// runtime default even though zod-to-json-schema treats `.default("readability")` as required.
// ExitPlanMode intentionally hides the canonical `plan` field from the model-facing schema:
// the model only sees `inline_plan`, which the resolution layer normalizes into `plan` before
// tool-executor's safeParse runs (so Zod must still accept `plan`). This is a deliberate
// divergence, not a parity bug.
const KNOWN_SCHEMA_MISMATCHES = new Set(["WebFetch", "ExitPlanMode"]);

const toolsWithRawJsonSchema = [
	agentTool,
	bashTool,
	readTool,
	writeTool,
	editTool,
	globTool,
	grepTool,
	webSearchTool,
	webFetchTool,
	askUserQuestionTool,
	awaitTool,
	enterPlanModeTool,
	exitPlanModeTool,
	sendTool,
	skillTool,
	teamStatusTool,
	startPipelineTool,
	extractPipelineTool,
].filter((t) => t.rawJsonSchema);

describe("rawJsonSchema parity for all tools", () => {
	for (const tool of toolsWithRawJsonSchema) {
		const skip = KNOWN_SCHEMA_MISMATCHES.has(tool.name);

		(skip ? test.skip : test)(`${tool.name}: rawJsonSchema keys cover Zod keys`, () => {
			const zodSchema = zodToJsonSchema(tool.parameters);
			const zodKeys = Object.keys((zodSchema.properties as Record<string, unknown>) ?? {});
			const rawKeys = Object.keys(requireRawJsonSchema(tool).properties ?? {});
			for (const key of zodKeys) {
				expect(rawKeys).toContain(key);
			}
		});

		(skip ? test.skip : test)(`${tool.name}: rawJsonSchema.required matches Zod required`, () => {
			const zodSchema = zodToJsonSchema(tool.parameters);
			const zodRequired = new Set((zodSchema.required as string[]) ?? []);
			const rawRequired = new Set(requireRawJsonSchema(tool).required ?? []);
			// rawJsonSchema must not require fields that Zod considers optional
			for (const key of rawRequired) {
				expect(zodRequired).toContain(key);
			}
			// Zod required fields must also be required in rawJsonSchema
			for (const key of zodRequired) {
				expect(rawRequired).toContain(key);
			}
		});
	}
});

describe("ExitPlanMode schema divergence (intentional)", () => {
	test("model-facing schema exposes inline_plan and hides the canonical plan field", () => {
		const raw = requireRawJsonSchema(exitPlanModeTool);
		const props = raw.properties ?? {};
		expect(props.inline_plan).toBeDefined();
		// `plan` is an internal-only field populated by the resolution layer; the model
		// must never be offered it, or it invites file-path/location junk.
		expect(props.plan).toBeUndefined();
	});

	test("Zod schema still accepts the canonical plan field for post-resolution safeParse", () => {
		// The resolution layer writes the resolved body into `plan`; tool-executor's
		// safeParse(effectiveInput) must accept it.
		const parsed = exitPlanModeTool.parameters.safeParse({ plan: "resolved plan body" });
		expect(parsed.success).toBe(true);
		// And it accepts the raw model field too.
		const parsedInline = exitPlanModeTool.parameters.safeParse({
			inline_plan: "model-supplied plan",
		});
		expect(parsedInline.success).toBe(true);
	});
});
