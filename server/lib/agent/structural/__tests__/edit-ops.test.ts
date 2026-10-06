import { describe, expect, test } from "bun:test";
import {
	appendAfter,
	deleteRange,
	EditOpError,
	extractBlock,
	insertBefore,
	MAX_SUBSTITUTE_MATCHES,
	reindentBlock,
	relocateRange,
	replaceRange,
	substituteInRange,
} from "@server/lib/agent/structural/edit-ops";

const CLASS = "class A {\n\tfoo() {\n\t\treturn 1;\n\t}\n}\n";

describe("replaceRange", () => {
	test("swaps the range's lines", () => {
		expect(replaceRange(CLASS, { startLine: 2, endLine: 4 }, "bar() {\n\treturn 2;\n}")).toBe(
			"class A {\n\tbar() {\n\t\treturn 2;\n\t}\n}\n",
		);
	});

	test("a single line becomes many", () => {
		expect(replaceRange("a\nb\nc\n", { startLine: 2, endLine: 2 }, "x\ny\nz")).toBe(
			"a\nx\ny\nz\nc\n",
		);
	});

	test("many lines become one", () => {
		expect(replaceRange("a\nb\nc\nd\n", { startLine: 2, endLine: 3 }, "merged")).toBe(
			"a\nmerged\nd\n",
		);
	});

	test("a range past EOF clamps instead of inventing lines", () => {
		expect(replaceRange("a\nb\n", { startLine: 2, endLine: 99 }, "z")).toBe("a\nz\n");
	});
});

describe("deleteRange", () => {
	test("removes whole lines, leaving no blank behind", () => {
		expect(deleteRange(CLASS, { startLine: 2, endLine: 4 })).toBe("class A {\n}\n");
	});

	test("deleting every line yields an empty file, not a blank line", () => {
		// Keeping the trailing-newline flag here would leave a file containing "\n".
		expect(deleteRange("only\n", { startLine: 1, endLine: 1 })).toBe("");
	});

	test("deleting the last line keeps the file's ending style", () => {
		expect(deleteRange("a\nb\n", { startLine: 2, endLine: 2 })).toBe("a\n");
	});

	test("a file with no trailing newline stays that way", () => {
		expect(deleteRange("a\nb", { startLine: 1, endLine: 1 })).toBe("b");
	});
});

describe("insertBefore / appendAfter", () => {
	test("insert lands before the range", () => {
		expect(insertBefore("a\nb\n", { startLine: 2, endLine: 2 }, "x")).toBe("a\nx\nb\n");
	});

	test("append lands after the range", () => {
		expect(appendAfter("a\nb\n", { startLine: 1, endLine: 1 }, "x")).toBe("a\nx\nb\n");
	});

	test("append after the last line extends the file", () => {
		expect(appendAfter("a\nb\n", { startLine: 2, endLine: 2 }, "c")).toBe("a\nb\nc\n");
	});

	test("appending a method into a class aligns to the class's indent", () => {
		// The content is written at column 0; it must land at the sibling's indent, with
		// its own internal nesting preserved. Getting this wrong produces code that reads
		// fine in a diff and no longer parses.
		expect(appendAfter(CLASS, { startLine: 2, endLine: 4 }, "baz() {\n\treturn 3;\n}")).toBe(
			"class A {\n\tfoo() {\n\t\treturn 1;\n\t}\n\tbaz() {\n\t\treturn 3;\n\t}\n}\n",
		);
	});
});

describe("reindentBlock", () => {
	test("content already carrying its own indent is rebased, not doubled", () => {
		expect(reindentBlock("\tfoo() {\n\t\treturn 1;\n\t}", "\t\t")).toBe(
			"\t\tfoo() {\n\t\t\treturn 1;\n\t\t}",
		);
	});

	test("relative nesting survives", () => {
		const out = reindentBlock("if (x) {\n\tif (y) {\n\t\tz();\n\t}\n}", "  ");
		expect(out).toBe("  if (x) {\n  \tif (y) {\n  \t\tz();\n  \t}\n  }");
	});

	test("blank lines stay empty rather than gaining trailing whitespace", () => {
		// Formatters strip trailing whitespace on save, which would surface as an
		// unrelated diff on the next write to this file.
		expect(reindentBlock("a\n\nb", "\t")).toBe("\ta\n\n\tb");
	});

	test("a zero anchor is a no-op", () => {
		expect(reindentBlock("a\n\tb", "")).toBe("a\n\tb");
	});
});

describe("substituteInRange", () => {
	test("replaces only inside the range", () => {
		const result = substituteInRange("x\nx\nx\n", { startLine: 2, endLine: 2 }, "x", "y");
		expect(result.text).toBe("x\ny\nx\n");
		expect(result.replacements).toBe(1);
	});

	test("without g only the first match per line changes", () => {
		const result = substituteInRange("a x x\n", { startLine: 1, endLine: 1 }, "x", "Y");
		expect(result.text).toBe("a Y x\n");
		expect(result.replacements).toBe(1);
	});

	test("g replaces every match on every line in range", () => {
		const result = substituteInRange("a x x\nb x\n", { startLine: 1, endLine: 2 }, "x", "Y", {
			flags: "g",
		});
		expect(result.text).toBe("a Y Y\nb Y\n");
		expect(result.replacements).toBe(3);
	});

	test("i is case-insensitive", () => {
		const result = substituteInRange("Foo\n", { startLine: 1, endLine: 1 }, "foo", "bar", {
			flags: "i",
		});
		expect(result.text).toBe("bar\n");
	});

	test("capture groups work", () => {
		const result = substituteInRange(
			"const a = 1;\n",
			{ startLine: 1, endLine: 1 },
			"const (\\w+)",
			"let $1",
		);
		expect(result.text).toBe("let a = 1;\n");
	});

	test("an unsupported flag is rejected rather than ignored", () => {
		// Silently dropping `m` would change what the pattern means without saying so.
		expect(() =>
			substituteInRange("a\n", { startLine: 1, endLine: 1 }, "a", "b", { flags: "gm" }),
		).toThrow(EditOpError);
	});

	test("an invalid pattern reports the regex error", () => {
		expect(() => substituteInRange("a\n", { startLine: 1, endLine: 1 }, "([", "b")).toThrow(
			EditOpError,
		);
	});

	test("the match cap stops a runaway rewrite", () => {
		const wide = `${"x ".repeat(MAX_SUBSTITUTE_MATCHES + 10)}\n`;
		expect(() =>
			substituteInRange(wide, { startLine: 1, endLine: 1 }, "x", "y", { flags: "g" }),
		).toThrow(/exceed/);
	});

	test("no match leaves the text untouched", () => {
		const result = substituteInRange("a\n", { startLine: 1, endLine: 1 }, "zzz", "y");
		expect(result.text).toBe("a\n");
		expect(result.replacements).toBe(0);
	});
});

describe("relocateRange (same-file copy/move)", () => {
	const NUMBERED = "a\nb\nc\nd\ne\n";

	test("move to a later anchor keeps every other line exactly once", () => {
		// The failure this guards: inserting first shifts the lines below, so deleting the
		// source by its ORIGINAL numbers removes the wrong ones. Result looks plausible.
		const out = relocateRange(
			NUMBERED,
			{ startLine: 1, endLine: 2 },
			{
				anchor: { startLine: 4, endLine: 4 },
				placement: "after",
				removeSource: true,
			},
		);
		expect(out).toBe("c\nd\na\nb\ne\n");
	});

	test("move to an earlier anchor", () => {
		const out = relocateRange(
			NUMBERED,
			{ startLine: 4, endLine: 5 },
			{
				anchor: { startLine: 1, endLine: 1 },
				placement: "before",
				removeSource: true,
			},
		);
		expect(out).toBe("d\ne\na\nb\nc\n");
	});

	test("copy leaves the source in place", () => {
		const out = relocateRange(
			NUMBERED,
			{ startLine: 1, endLine: 1 },
			{
				anchor: { startLine: 3, endLine: 3 },
				placement: "after",
				removeSource: false,
			},
		);
		expect(out).toBe("a\nb\nc\na\nd\ne\n");
	});

	test("no anchor appends at end of file", () => {
		const out = relocateRange(NUMBERED, { startLine: 1, endLine: 1 }, { removeSource: true });
		expect(out).toBe("b\nc\nd\ne\na\n");
	});

	test("every original line survives a move", () => {
		// A cheap invariant that catches both duplication and loss.
		const out = relocateRange(
			NUMBERED,
			{ startLine: 2, endLine: 3 },
			{
				anchor: { startLine: 5, endLine: 5 },
				placement: "after",
				removeSource: true,
			},
		);
		expect(out.trim().split("\n").sort()).toEqual(["a", "b", "c", "d", "e"]);
	});

	test("an anchor inside the source range is rejected", () => {
		// "Move these lines to between these lines" has no meaningful answer.
		expect(() =>
			relocateRange(
				NUMBERED,
				{ startLine: 1, endLine: 3 },
				{
					anchor: { startLine: 2, endLine: 2 },
					placement: "after",
					removeSource: true,
				},
			),
		).toThrow(/overlaps/);
	});

	test("an anchor overlapping the source from outside is also rejected", () => {
		expect(() =>
			relocateRange(
				NUMBERED,
				{ startLine: 2, endLine: 3 },
				{
					anchor: { startLine: 1, endLine: 2 },
					placement: "before",
					removeSource: true,
				},
			),
		).toThrow(/overlaps/);
	});

	test("a method moved into a deeper scope is re-indented", () => {
		const src = "helper() {\n\treturn 1;\n}\nclass A {\n\tfoo() {}\n}\n";
		const out = relocateRange(
			src,
			{ startLine: 1, endLine: 3 },
			{
				anchor: { startLine: 5, endLine: 5 },
				placement: "after",
				removeSource: true,
			},
		);
		expect(out).toBe("class A {\n\tfoo() {}\n\thelper() {\n\t\treturn 1;\n\t}\n}\n");
	});

	test("a file with no trailing newline stays that way", () => {
		const out = relocateRange("a\nb\nc", { startLine: 1, endLine: 1 }, { removeSource: true });
		expect(out).toBe("b\nc\na");
	});
});

describe("extractBlock (cross-file payload)", () => {
	test("returns the lines rebased to column 0", () => {
		// The destination decides the final indent; carrying the source's would nest the
		// block by however deep it happened to be.
		const src = "class A {\n\tfoo() {\n\t\treturn 1;\n\t}\n}\n";
		expect(extractBlock(src, { startLine: 2, endLine: 4 })).toBe("foo() {\n\treturn 1;\n}");
	});

	test("a single line comes back without a trailing newline", () => {
		expect(extractBlock("a\nb\n", { startLine: 2, endLine: 2 })).toBe("b");
	});

	test("an out-of-range source is rejected", () => {
		expect(() => extractBlock("a\n", { startLine: 9, endLine: 9 })).toThrow(/past the end/);
	});
});

describe("range validation", () => {
	test("a start past EOF is an error, not a silent no-op", () => {
		expect(() => deleteRange("a\n", { startLine: 5, endLine: 5 })).toThrow(/past the end/);
	});

	test("an inverted range is rejected", () => {
		expect(() => deleteRange("a\nb\n", { startLine: 2, endLine: 1 })).toThrow(/Invalid line range/);
	});

	test("a zero or negative start is rejected", () => {
		expect(() => deleteRange("a\n", { startLine: 0, endLine: 1 })).toThrow(/Invalid line range/);
	});
});

describe("edge-case inputs", () => {
	test("line 1 of an empty file is addressable, and beyond that is not", () => {
		// "Line 1" of nothing is the only way to name where content goes in an empty
		// file, so the content commands accept it and delete is a coherent no-op.
		expect(appendAfter("", { startLine: 1, endLine: 1 }, "a")).toBe("a");
		expect(insertBefore("", { startLine: 1, endLine: 1 }, "a")).toBe("a");
		expect(replaceRange("", { startLine: 1, endLine: 1 }, "a")).toBe("a");
		expect(deleteRange("", { startLine: 1, endLine: 1 })).toBe("");
		// Line 2 of an empty file still names nothing.
		expect(() => deleteRange("", { startLine: 2, endLine: 2 })).toThrow(/past the end/);
	});

	test("a single-line file with no newline round-trips", () => {
		expect(replaceRange("a", { startLine: 1, endLine: 1 }, "b")).toBe("b");
	});

	test("CJK and tabs survive unchanged", () => {
		const src = "\t处理(参数)\n\t返回\n";
		expect(deleteRange(src, { startLine: 2, endLine: 2 })).toBe("\t处理(参数)\n");
	});

	test("a blank-line content inserts exactly one blank line", () => {
		// `"\n"` is one empty line, so it must not become two.
		expect(insertBefore("a\n", { startLine: 1, endLine: 1 }, "\n")).toBe("\na\n");
	});

	test("empty content inserts nothing", () => {
		expect(insertBefore("a\n", { startLine: 1, endLine: 1 }, "")).toBe("a\n");
	});
});
