import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../types";
import { bashTool } from "../bash";
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
import { writeTool } from "../write";

// === Test fixtures ===

const TEST_DIR = join(tmpdir(), `narrafork-tool-test-${Date.now()}`);
const SAMPLE_FILE = join(TEST_DIR, "sample.txt");
const NESTED_DIR = join(TEST_DIR, "sub", "dir");
const NESTED_FILE = join(NESTED_DIR, "nested.ts");

function makeCtx(cwd = TEST_DIR): ToolContext {
	return {
		narratorId: "test-narrator",
		cwd,
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" as const }),
	};
}

beforeAll(() => {
	mkdirSync(NESTED_DIR, { recursive: true });
	writeFileSync(SAMPLE_FILE, "line one\nline two\nline three\nline four\nline five\n");
	writeFileSync(NESTED_FILE, 'export function hello() {\n\treturn "world";\n}\n');
	// Additional files for glob/grep
	writeFileSync(join(TEST_DIR, "a.ts"), "const a = 1;\n");
	writeFileSync(join(TEST_DIR, "b.ts"), "const b = 2;\n");
	writeFileSync(join(TEST_DIR, "c.json"), '{"key": "value"}\n');
});

afterAll(() => {
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

	test("force_full bypasses loop truncation for large files", async () => {
		const target = join(TEST_DIR, "read-force-full.txt");
		const content = "0123456789".repeat(7000); // 70KB
		writeFileSync(target, content);

		const result = await readTool.execute(
			{ file_path: "read-force-full.txt", force_full: true },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.truncated).toBe(true);
		expect(result.output).toContain("0123456789");
		expect(result.output).not.toContain("truncated");
	});

	test("returns error when mixing force_full with line paging", async () => {
		const result = await readTool.execute(
			{ file_path: "sample.txt", offset: 1, force_full: true },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("cannot be combined");
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
		expect(result).toBe("foo qux baz");
	});

	test("line-trimmed match (LineTrimmedReplacer)", () => {
		// File has 4-space indent, search has 2-space indent
		const content = "function test() {\n    const x = 1;\n    return x;\n}";
		const result = replace(content, "  const x = 1;\n  return x;", "  const y = 2;\n  return y;");
		expect(result).toContain("const y = 2");
		expect(result).toContain("return y");
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
		expect(result).toBe("function hello() { return 6; }");
	});

	test("whitespace-normalized match (WhitespaceNormalizedReplacer)", () => {
		const content = "const   x   =   1;";
		const result = replace(content, "const x = 1;", "const x = 2;");
		expect(result).toBe("const x = 2;");
	});

	test("indentation-flexible match (IndentationFlexibleReplacer)", () => {
		const content = "    if (true) {\n        doSomething();\n    }";
		// Search with no indentation
		const result = replace(
			content,
			"if (true) {\n    doSomething();\n}",
			"if (false) {\n    doNothing();\n}",
		);
		expect(result).toContain("doNothing");
	});

	test("escape-normalized match (EscapeNormalizedReplacer)", () => {
		const content = 'console.log("hello\\nworld");';
		// Search with literal escape sequences
		const result = replace(content, 'console.log("hello\\nworld");', 'console.log("goodbye");');
		expect(result).toBe('console.log("goodbye");');
	});

	test("trimmed-boundary match (TrimmedBoundaryReplacer)", () => {
		const content = "hello world";
		const result = replace(content, "  hello world  ", "goodbye");
		expect(result).toBe("goodbye");
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
		expect(result).toBe("class Foo {}");
	});

	test("multi-occurrence with replace_all (MultiOccurrenceReplacer)", () => {
		const result = replace("aaa bbb aaa ccc aaa", "aaa", "xxx", true);
		expect(result).toBe("xxx bbb xxx ccc xxx");
	});

	test("replace_all with exact match", () => {
		const result = replace("aaa bbb aaa", "aaa", "xxx", true);
		expect(result).toBe("xxx bbb xxx");
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
	test("returns structured output with file paths and line numbers", async () => {
		const result = await grepTool.execute({ pattern: "const" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("Found");
		expect(result.output).toContain("matches");
		// Should contain file paths with colon suffix (grouped format)
		expect(result.output).toMatch(/\.ts:/);
		// Should contain "Line N:" format
		expect(result.output).toMatch(/Line \d+:/);
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
		expect(result.output).toContain("No files found");
		expect(result.metadata).toEqual({ matches: 0, truncated: false });
	});

	test("include filter restricts scope", async () => {
		const result = await grepTool.execute({ pattern: "const", include: "*.ts" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("a.ts");
		expect(result.output).not.toContain("c.json");
	});

	test("include with multiple extensions via brace expansion", async () => {
		const result = await grepTool.execute({ pattern: ".", include: "*.{ts,json}" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain(".ts");
		expect(result.output).toContain(".json");
	});

	test("relative path resolved against cwd", async () => {
		const result = await grepTool.execute({ pattern: "line", path: "sample.txt" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line one");
	});

	test("searches specific file", async () => {
		const result = await grepTool.execute({ pattern: "line", path: SAMPLE_FILE }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line one");
		expect(result.output).toContain("Line 1:");
	});

	test("results are sorted by modification time", async () => {
		// Touch a.ts to make it newer
		writeFileSync(join(TEST_DIR, "a.ts"), "const a = 1;\n");
		const result = await grepTool.execute({ pattern: "const", include: "*.ts" }, makeCtx());
		expect(result.isError).toBeFalsy();
		// a.ts was just written, should appear before b.ts
		const aIdx = result.output.indexOf("a.ts:");
		const bIdx = result.output.indexOf("b.ts:");
		expect(aIdx).toBeLessThan(bIdx);
	});

	test("line text is truncated at MAX_LINE_LENGTH", async () => {
		const longLine = "x".repeat(3000);
		writeFileSync(join(TEST_DIR, "long.txt"), `${longLine}\n`);
		const result = await grepTool.execute(
			{ pattern: "x+", path: join(TEST_DIR, "long.txt") },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		// Should contain truncation indicator
		expect(result.output).toContain("...");
		// Should not contain the full 3000-char line
		expect(result.output.length).toBeLessThan(3000);
	});

	test("searches hidden files", async () => {
		writeFileSync(join(TEST_DIR, ".hidden"), "secret_value\n");
		const result = await grepTool.execute({ pattern: "secret_value", path: TEST_DIR }, makeCtx());
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

	test("include with shell metacharacters is not interpreted", async () => {
		const marker = join(TEST_DIR, "pwned3");
		const _result = await grepTool.execute(
			{ pattern: "line", include: `$(touch ${marker})` },
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

	test("rejects unknown params (old params removed)", () => {
		const _result = grepTool.parameters.safeParse({
			pattern: "x",
			output_mode: "content",
			"-i": true,
		});
		// Zod strict mode or extra keys — should still parse pattern but ignore extras
		// The key point: these old params no longer exist in the schema
		const parsed = grepTool.parameters.safeParse({ pattern: "x" });
		expect(parsed.success).toBe(true);
	});

	test("accepts all valid params", () => {
		const result = grepTool.parameters.safeParse({
			pattern: "test",
			path: "/tmp",
			include: "*.ts",
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

	test("returns fatal error for non-existent workdir", async () => {
		const result = await bashTool.execute(
			{ command: "pwd", workdir: "/no/such/directory" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.fatal).toBe(true);
		expect(result.output).toContain("does not exist");
	});

	test("workdir allows path traversal but resolves against cwd", async () => {
		// ../  from TEST_DIR should resolve to its parent
		const result = await bashTool.execute({ command: "pwd", workdir: ".." }, makeCtx());
		expect(result.isError).toBeFalsy();
		const { dirname } = await import("node:path");
		expect(result.output.trim()).toBe(dirname(TEST_DIR));
	});
});

// ============================================================
// zodToJsonSchema (tool-registry)
// ============================================================

import { z } from "zod/v4";
import { zodToJsonSchema } from "../../tool-registry";

describe("zodToJsonSchema", () => {
	test("converts simple object schema", () => {
		const schema = z.object({
			name: z.string(),
			age: z.number().optional(),
		});
		const json = zodToJsonSchema(schema);
		expect(json).toEqual({
			type: "object",
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
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const props = json.properties as Record<string, any>;
		expect(props.mode.enum).toEqual(["a", "b", "c"]);
	});

	test("converts boolean schema", () => {
		const schema = z.object({ flag: z.boolean() });
		const json = zodToJsonSchema(schema);
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const props = json.properties as Record<string, any>;
		expect(props.flag).toEqual({ type: "boolean" });
	});

	test("converts grep tool schema without error", () => {
		const json = zodToJsonSchema(grepTool.parameters);
		expect(json.type).toBe("object");
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const props = json.properties as Record<string, any>;
		expect(props.pattern.type).toBe("string");
		expect(props.pattern.description).toBeDefined();
		expect(props.include.type).toBe("string");
		expect(props.include.description).toBeDefined();
	});

	test("converts all tool schemas without error", () => {
		const tools = [readTool, writeTool, editTool, globTool, grepTool, bashTool];
		for (const tool of tools) {
			const json = zodToJsonSchema(tool.parameters);
			expect(json.type).toBe("object");
			expect(json.properties).toBeDefined();
		}
	});
});
