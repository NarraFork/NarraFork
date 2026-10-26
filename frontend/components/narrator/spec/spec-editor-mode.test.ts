import { describe, expect, it } from "bun:test";
import {
	availableSpecEditorModes,
	detectRichUnsupported,
	initialSpecEditorMode,
	isMarkdownSpecPath,
	type SpecEditorViewInput,
	type SpecRichUnsupportedKind,
	selectSpecEditorMode,
	syncSpecEditorView,
} from "./spec-editor-mode";

describe("detectRichUnsupported", () => {
	const supported: Record<string, string> = {
		"headings, lists, code and links": [
			"# 设计",
			"",
			"- 改 `server/db/schema.ts`，snake_case 与 *.test.ts",
			"1. 第一步",
			"",
			"> 引用 [文档](https://x.dev/a_b) 与 <https://example.com>",
			"",
			"```ts",
			"const a = 1;",
			"```",
			"",
		].join("\n"),
		"a GFM table": "| a | b |\n| --- | --- |\n| `x \\| y` | **z** |\n",
		"HTML, images and task syntax inside code": [
			"`<div>` 与 `![a](b.png)`",
			"",
			"```md",
			"<!-- comment -->",
			"![a](b.png)",
			"- [ ] task",
			"[^1]: note",
			"```",
			"",
			"    <img src=x> indented code",
			"",
		].join("\n"),
		"a footnote reference without a definition": "结论见[^1]。\n",
		"an ordinary link definition": "见 [文档][doc]。\n\n[doc]: https://example.com\n",
		"a leading horizontal rule followed by a blank line": "---\n\n正文\n\n---\n",
		"a separator later in the file": "正文\n\n---\ntitle: x\n---\n",
		"an empty document": "",
	};
	for (const [name, markdown] of Object.entries(supported)) {
		it(`accepts ${name}`, () => {
			expect(detectRichUnsupported(markdown)).toEqual([]);
		});
	}

	const unsupported: Record<string, [string, SpecRichUnsupportedKind[]]> = {
		"an HTML block": ['<div align="center">\n  <b>x</b>\n</div>\n', ["html"]],
		"an HTML comment": ["段落一\n\n<!-- TODO: 补充风险评估 -->\n\n段落二\n", ["html"]],
		"an HTML block holding only an image": ['<img src="logo.png" width="100">\n', ["html"]],
		"inline HTML": ["按 <kbd>Ctrl</kbd>+<kbd>S</kbd> 保存\n", ["html"]],
		"a <br> inside a table cell": ["| a | b |\n| --- | --- |\n| 1 | 一<br>二 |\n", ["html"]],
		"an inline image": ['见下图：![架构图](./arch.png "架构")\n', ["image"]],
		"an image inside a table cell": ["| a |\n| --- |\n| ![i](x.png) |\n", ["image"]],
		"an image inside a link": ["[![badge](b.svg)](https://x.dev)\n", ["image"]],
		"a reference-style image": ["![图][logo]\n\n[logo]: ./logo.png\n", ["image"]],
		"a task list": ["- [ ] 待办一\n- [x] 已完成二\n", ["taskList"]],
		"a task item mixed with plain items": ["- [ ] 待办\n- 普通项\n", ["taskList"]],
		"an ordered task item in a blockquote": ["> 1. [x] 完成\n", ["taskList"]],
		"a nested task item": ["- 父项\n  - [ ] 子任务\n", ["taskList"]],
		"a footnote definition": ["结论见脚注[^1]。\n\n[^1]: 这是脚注内容。\n", ["footnote"]],
		"a named footnote definition only": ["[^Note-A]: 说明\n", ["footnote"]],
		"YAML front matter": ["---\ntitle: 设计\nstatus: draft\n---\n\n# 正文\n", ["frontMatter"]],
		"front matter closed with dots, CRLF and a BOM": [
			"﻿---\r\ntitle: x\r\n...\r\n正文\r\n",
			["frontMatter"],
		],
		"several kinds at once, in a fixed order": [
			"---\nk: v\n---\n\n- [ ] t\n\n![i](x)<span>s</span>\n\n[^1]: f\n",
			["frontMatter", "html", "image", "taskList", "footnote"],
		],
	};
	for (const [name, [markdown, kinds]] of Object.entries(unsupported)) {
		it(`flags ${name}`, () => {
			expect(detectRichUnsupported(markdown)).toEqual(kinds);
		});
	}
});

describe("spec editor modes by path", () => {
	it("offers source, split and rich for markdown files", () => {
		for (const path of ["index.md", "notes/design.md", "README.MD", "plan.markdown"]) {
			expect(isMarkdownSpecPath(path)).toBe(true);
			expect(availableSpecEditorModes(path)).toEqual(["source", "split", "rich"]);
		}
	});

	it("offers only source for the behavior fence and non-markdown files", () => {
		for (const path of [
			"behavior_fence",
			"notes.json",
			"ci.yaml",
			"steps.yml",
			"todo.txt",
			"NOTES",
		]) {
			expect(isMarkdownSpecPath(path)).toBe(false);
			expect(availableSpecEditorModes(path)).toEqual(["source"]);
		}
	});

	it("opens in the preferred mode only when the file offers it", () => {
		expect(initialSpecEditorMode("source", "index.md")).toBe("source");
		expect(initialSpecEditorMode("split", "index.md")).toBe("split");
		expect(initialSpecEditorMode("rich", "index.md")).toBe("rich");
		expect(initialSpecEditorMode("rich", "notes.json")).toBe("source");
		expect(initialSpecEditorMode("split", "behavior_fence")).toBe("source");
	});
});

describe("syncSpecEditorView", () => {
	const TABLE_DOC = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
	const HTML_DOC = "段落\n\n<!-- 注释 -->\n";

	function input(overrides: Partial<SpecEditorViewInput> = {}): SpecEditorViewInput {
		return {
			documentKey: "spec://design.md",
			path: "design.md",
			revisionKey: "spec://design.md:r1",
			value: TABLE_DOC,
			preferredMode: "source",
			...overrides,
		};
	}

	function countingDetect() {
		const calls: string[] = [];
		const detect = (markdown: string) => {
			calls.push(markdown);
			return detectRichUnsupported(markdown);
		};
		return { calls, detect };
	}

	it("opens in source mode by default without parsing the document", () => {
		const { calls, detect } = countingDetect();
		const view = syncSpecEditorView(null, input(), detect);
		expect(view).toMatchObject({ mode: "source", explicit: false, rich: null });
		expect(calls).toEqual([]);
	});

	it("loads the rich editor for supported markdown, checked once per revision", () => {
		const { calls, detect } = countingDetect();
		const view = syncSpecEditorView(null, input({ preferredMode: "rich" }), detect);
		expect(view.mode).toBe("rich");
		expect(view.rich).toEqual({
			revisionKey: "spec://design.md:r1",
			text: TABLE_DOC,
			unsupported: [],
		});
		// Typing in the rich editor changes the value, not the revision: no re-check, same object.
		const typed = syncSpecEditorView(
			view,
			input({ preferredMode: "rich", value: `${TABLE_DOC}more` }),
			detect,
		);
		expect(typed).toBe(view);
		expect(calls.length).toBe(1);
	});

	it("falls back to source when a file opened in rich mode holds unsupported content", () => {
		const view = syncSpecEditorView(null, input({ preferredMode: "rich", value: HTML_DOC }));
		expect(view).toMatchObject({ mode: "source", explicit: false, rich: null });
		// Stable afterwards: re-syncing changes nothing.
		expect(syncSpecEditorView(view, input({ preferredMode: "rich", value: HTML_DOC }))).toBe(view);
	});

	it("keeps an explicitly picked rich mode but marks unsupported content read-only", () => {
		const opened = syncSpecEditorView(null, input({ value: HTML_DOC }));
		const picked = selectSpecEditorMode(opened, "rich", input({ value: HTML_DOC }));
		expect(picked.mode).toBe("rich");
		expect(picked.explicit).toBe(true);
		expect(picked.rich?.unsupported).toEqual(["html"]);
	});

	it("checks unsaved source edits when rich mode is picked", () => {
		const opened = syncSpecEditorView(null, input());
		const edited = input({ value: `${TABLE_DOC}\n![i](x.png)\n` });
		const picked = selectSpecEditorMode(syncSpecEditorView(opened, edited), "rich", edited);
		expect(picked.rich?.unsupported).toEqual(["image"]);
	});

	it("re-checks a new server revision while in rich mode", () => {
		const rich = syncSpecEditorView(null, input({ preferredMode: "rich" }));
		expect(rich.rich?.unsupported).toEqual([]);
		// The agent adds an image: the default-rich view drops back to source.
		const agentEdit = input({
			preferredMode: "rich",
			revisionKey: "spec://design.md:r2",
			value: `${TABLE_DOC}\n![i](x.png)\n`,
		});
		expect(syncSpecEditorView(rich, agentEdit).mode).toBe("source");
		// After an explicit pick, the view stays in rich mode, read-only.
		const picked = selectSpecEditorMode(rich, "rich", input({ preferredMode: "rich" }));
		const after = syncSpecEditorView(picked, agentEdit);
		expect(after.mode).toBe("rich");
		expect(after.rich).toEqual({
			revisionKey: "spec://design.md:r2",
			text: `${TABLE_DOC}\n![i](x.png)\n`,
			unsupported: ["image"],
		});
	});

	it("re-applies the preferred mode when another document opens", () => {
		const picked = selectSpecEditorMode(syncSpecEditorView(null, input()), "split", input());
		expect(picked).toMatchObject({ mode: "split", explicit: true });
		const other = syncSpecEditorView(
			picked,
			input({
				documentKey: "spec://notes.md",
				path: "notes.md",
				revisionKey: "spec://notes.md:r1",
			}),
		);
		expect(other).toMatchObject({
			documentKey: "spec://notes.md",
			mode: "source",
			explicit: false,
		});
	});

	it("never leaves source mode for the behavior fence or non-markdown files", () => {
		for (const path of ["behavior_fence", "notes.json", "ci.yaml"]) {
			const fileInput = input({
				documentKey: `spec://${path}`,
				path,
				value: '{"a_b": [1, 2]}\n',
				preferredMode: "rich",
			});
			const view = syncSpecEditorView(null, fileInput);
			expect(view.mode).toBe("source");
			expect(selectSpecEditorMode(view, "rich", fileInput).mode).toBe("source");
			expect(selectSpecEditorMode(view, "split", fileInput).mode).toBe("source");
		}
	});
});
