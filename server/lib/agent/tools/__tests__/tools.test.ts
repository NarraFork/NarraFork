import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolContext } from "../../types";
import { bashTool } from "../bash";
import { editTool } from "../edit";
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
		expect(result.output).toContain("not unique");
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
	test("default mode (files_with_matches) returns file paths", async () => {
		const result = await grepTool.execute({ pattern: "const" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("a.ts");
		expect(result.output).toContain("b.ts");
	});

	test("content mode returns matching lines with line numbers", async () => {
		const result = await grepTool.execute(
			{ pattern: "line two", output_mode: "content" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line two");
		// Should have line numbers by default in content mode
		expect(result.output).toMatch(/\d+[:\-].*line two/);
	});

	test("count mode returns match counts", async () => {
		const result = await grepTool.execute(
			{ pattern: "line", output_mode: "count", path: SAMPLE_FILE },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("5");
	});

	test("no matches returns non-error", async () => {
		const result = await grepTool.execute(
			{ pattern: "zzz_nonexistent_pattern_zzz" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("No matches");
	});

	test("case insensitive search", async () => {
		const result = await grepTool.execute(
			{ pattern: "LINE TWO", "-i": true, output_mode: "content" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line two");
	});

	test("glob filter limits search scope", async () => {
		const result = await grepTool.execute(
			{ pattern: "const", glob: "a.ts" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("a.ts");
		expect(result.output).not.toContain("b.ts");
	});

	test("context lines with -C", async () => {
		const result = await grepTool.execute(
			{ pattern: "line three", output_mode: "content", "-C": 1 },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line two");
		expect(result.output).toContain("line three");
		expect(result.output).toContain("line four");
	});

	test("head_limit limits output lines", async () => {
		const result = await grepTool.execute(
			{ pattern: "line", output_mode: "content", path: SAMPLE_FILE, head_limit: 2 },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		const lines = result.output.trim().split("\n");
		expect(lines.length).toBe(2);
	});

	test("offset skips initial results", async () => {
		const result = await grepTool.execute(
			{ pattern: "line", output_mode: "content", path: SAMPLE_FILE, offset: 2, head_limit: 2 },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line three");
		expect(result.output).not.toContain("line one");
	});

	test("type filter works", async () => {
		const result = await grepTool.execute(
			{ pattern: "const", type: "ts" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain(".ts");
		expect(result.output).not.toContain(".json");
	});

	test("multiline search", async () => {
		const result = await grepTool.execute(
			{ pattern: "hello.*world", multiline: true, output_mode: "content" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("hello");
		expect(result.output).toContain("world");
	});

	test("path parameter targets specific file", async () => {
		const result = await grepTool.execute(
			{ pattern: "line", path: SAMPLE_FILE, output_mode: "content" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line one");
	});
});

// ============================================================
// Bash tool
// ============================================================

describe("Bash", () => {
	test("executes simple command", async () => {
		const result = await bashTool.execute({ command: "echo hello" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output.trim()).toBe("hello");
	});

	test("captures stderr", async () => {
		const result = await bashTool.execute(
			{ command: "echo err >&2" },
			makeCtx(),
		);
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
		const result = await bashTool.execute(
			{ command: "sleep 10", timeout: 500 },
			makeCtx(),
		);
		// Should be killed before completing
		expect(result.isError).toBe(true);
	});
});

// ============================================================
// zodToJsonSchema (tool-registry)
// ============================================================

import { zodToJsonSchema } from "../../tool-registry";
import { z } from "zod/v4";

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
		const props = json.properties as Record<string, any>;
		expect(props.mode.enum).toEqual(["a", "b", "c"]);
	});

	test("converts boolean schema", () => {
		const schema = z.object({ flag: z.boolean() });
		const json = zodToJsonSchema(schema);
		const props = json.properties as Record<string, any>;
		expect(props.flag).toEqual({ type: "boolean" });
	});

	test("converts grep tool schema without error", () => {
		const json = zodToJsonSchema(grepTool.parameters);
		expect(json.type).toBe("object");
		const props = json.properties as Record<string, any>;
		expect(props.pattern).toEqual({ type: "string" });
		expect(props.output_mode.enum).toEqual(["content", "files_with_matches", "count"]);
		expect(props["-i"]).toEqual({ type: "boolean" });
		expect(props["-A"]).toEqual({ type: "number" });
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
