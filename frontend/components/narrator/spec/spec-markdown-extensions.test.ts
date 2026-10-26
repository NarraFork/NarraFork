import { describe, expect, it } from "bun:test";
import { Editor } from "@tiptap/core";
import { Marked, Parser, type Token, type Tokens } from "marked";
import { createSpecMarkdownExtensions, escapeTableCellPipes } from "./spec-markdown-extensions";

/**
 * A headless editor (`element: null`, no DOM) configured exactly like SpecMarkdownEditor,
 * including its revision effect that re-applies the value without emitting an update.
 */
function openEditor(markdown: string) {
	const updates: string[] = [];
	const editor = new Editor({
		element: null,
		extensions: createSpecMarkdownExtensions(),
		content: markdown,
		contentType: "markdown",
		onUpdate: ({ editor }) => updates.push(editor.getMarkdown()),
	});
	editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
	return { editor, updates };
}

/** What a save writes after one edit: the whole document re-serialized. */
function save(markdown: string): string {
	const { editor, updates } = openEditor(markdown);
	try {
		expect(updates).toEqual([]);
		expect(() => editor.state.doc.check()).not.toThrow();
		return editor.getMarkdown();
	} finally {
		editor.destroy();
	}
}

interface TableShape {
	align: Tokens.Table["align"];
	header: string[];
	rows: string[][];
}

const lexer = new Marked({ gfm: true });

/**
 * Every GFM table as marked reads it: alignment plus each cell rendered to HTML, so equivalent
 * spellings (`a_b` vs `a\_b`) compare equal while a lost or split cell does not.
 */
function tables(markdown: string): TableShape[] {
	const found: TableShape[] = [];
	lexer.walkTokens(lexer.lexer(markdown), (token: Token) => {
		if (token.type !== "table") return;
		const table = token as Tokens.Table;
		found.push({
			align: table.align,
			header: table.header.map((cell) => Parser.parseInline(cell.tokens)),
			rows: table.rows.map((row) => row.map((cell) => Parser.parseInline(cell.tokens))),
		});
	});
	return found;
}

const TABLE_CASES: Record<string, string> = {
	"between heading and paragraph, with alignment, code and bold": [
		"# 方案对比",
		"",
		"| 方案 | 优点 | 缺点 |",
		"| --- | :---: | ---: |",
		"| A | 快 | 贵 |",
		"| B | `便宜` | **慢** |",
		"",
		"表格后的段落。",
		"",
	].join("\n"),
	"without outer pipes": "前文\n\na | b\n--|--\n1 | 2\n\n后文\n",
	"as the whole file": "| key | value |\n| --- | --- |\n| a | 1 |\n",
	"inside a list item": "- 第一项\n\n  | x | y |\n  | - | - |\n  | 1 | 2 |\n\n- 第二项\n",
	"with an empty cell, a link and snake_case text":
		"| 文件 | 链接 | 备注 |\n| --- | --- | --- |\n| spec_vfs.ts | [文档](https://x.dev/a_b) |  |\n",
	"with an escaped pipe in text": "| 表达式 | 含义 |\n| --- | --- |\n| a \\| b | 或 |\n",
	"with an escaped pipe in inline code":
		"| 命令 | 说明 |\n| --- | --- |\n| `ls \\| wc -l` | 计数 |\n",
	"with a pipe in a link target":
		"| 链接 | 说明 |\n| --- | --- |\n| [x](https://x.dev/?q=a\\|b) | 查询 |\n",
	"with backslashes next to a pipe":
		"| 路径 | 说明 |\n| --- | --- |\n| C:\\\\dir\\\\ \\| D: | 两个 |\n",
};

describe("spec WYSIWYG table round trip", () => {
	for (const [name, markdown] of Object.entries(TABLE_CASES)) {
		it(`keeps a table ${name}`, () => {
			const saved = save(markdown);
			const before = tables(markdown);
			expect(before.length).toBe(1);
			expect(tables(saved)).toEqual(before);
		});

		it(`writes a table ${name} the same way on the second save`, () => {
			const first = save(markdown);
			expect(save(first)).toBe(first);
		});
	}

	it("keeps the text around the table", () => {
		const saved = save(TABLE_CASES["between heading and paragraph, with alignment, code and bold"]);
		expect(saved).toStartWith("# 方案对比\n");
		expect(saved).toEndWith("表格后的段落。");
	});

	it("re-escapes pipes in cell text and inside code spans", () => {
		expect(save(TABLE_CASES["with an escaped pipe in text"])).toContain("| a \\| b |");
		expect(save(TABLE_CASES["with an escaped pipe in inline code"])).toContain("`ls \\| wc -l`");
		expect(tables(save(TABLE_CASES["with an escaped pipe in inline code"]))[0]?.rows).toEqual([
			["<code>ls | wc -l</code>", "计数"],
		]);
	});

	it("keeps a pipe typed into a cell inside that cell", () => {
		const { editor, updates } = openEditor("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
		try {
			let cellEnd = -1;
			editor.state.doc.descendants((node, pos) => {
				if (cellEnd !== -1) return false;
				if (node.type.name !== "tableCell") return true;
				// Cell → paragraph → text: the end of the first body cell's text.
				cellEnd = pos + 2 + (node.firstChild?.content.size ?? 0);
				return false;
			});
			expect(cellEnd).toBeGreaterThan(0);
			editor.commands.insertContentAt(cellEnd, { type: "text", text: " x|y" });
			expect(updates.length).toBe(1);
			const saved = updates[0] ?? "";
			expect(tables(saved)).toEqual([
				{ align: [null, null], header: ["a", "b"], rows: [["1 x|y", "2"]] },
			]);
			expect(save(saved)).toBe(saved);
		} finally {
			editor.destroy();
		}
	});

	it("joins paragraphs split inside one cell with a space, not a control character", () => {
		const { editor } = openEditor("| a | b |\n| --- | --- |\n| 12 | 3 |\n");
		try {
			let inCell = -1;
			editor.state.doc.descendants((node, pos) => {
				if (inCell !== -1) return false;
				if (node.type.name !== "tableCell") return true;
				inCell = pos + 3; // between "1" and "2"
				return false;
			});
			editor.commands.setTextSelection(inCell);
			expect(editor.commands.splitBlock()).toBe(true);
			const saved = editor.getMarkdown();
			expect(saved).not.toContain("\u001f");
			expect(tables(saved)[0]?.rows).toEqual([["1 2", "3"]]);
		} finally {
			editor.destroy();
		}
	});
});

describe("escapeTableCellPipes", () => {
	it("escapes bare pipes", () => {
		expect(escapeTableCellPipes("a|b|c")).toBe("a\\|b\\|c");
	});

	it("leaves pipes that are already escaped", () => {
		expect(escapeTableCellPipes("a\\|b")).toBe("a\\|b");
	});

	it("escapes a pipe that follows an escaped backslash", () => {
		// `\\|` is a literal backslash, then a cell delimiter.
		expect(escapeTableCellPipes("a\\\\|b")).toBe("a\\\\\\|b");
	});

	it("does not touch text without pipes", () => {
		expect(escapeTableCellPipes("C:\\\\dir `code` **b**")).toBe("C:\\\\dir `code` **b**");
	});
});
