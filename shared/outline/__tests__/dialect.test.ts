/**
 * Round trips of the in-block dialect (no DOM):
 * - in-dialect markdown survives parse → serialize byte for byte;
 * - out-of-dialect markdown is split into child blocks or kept as text, never dropped silently.
 */
import { describe, expect, test } from "bun:test";
import {
	type Body,
	bodyRefs,
	canonicalBody,
	type DialectNoteCode,
	type Inline,
	normalizeBlock,
	parseBlock,
	pmToSrc,
	serializeBody,
	serializeInlineFragment,
	srcToPm,
} from "../dialect";
import { serializeBodyRaw } from "../dialect/serialize";
import { plain } from "./fuzz.fixture";

const CANONICAL = [
	"",
	"plain text",
	"中文段落，带标点。",
	"**粗体**、*斜体*、`代码`、~~删除~~ 和 [链接](https://example.com)",
	'[带标题的链接](https://example.com "标题")',
	"[空格地址](<https://e.x/a b>)",
	"一段 [[space/abc]] 提及",
	"[[space/abc|显示文本]] 开头的提及",
	"**[[P1/b2]]** 加粗的提及",
	"[[带 \\*星号\\* 的标题]] 和 [[x|\\_斜体\\_ 标签]]",
	"第一行\n第二行\n第三行",
	"# 一级标题",
	"## 二级标题 **加粗**",
	"### 三级标题 [[P1/x]]",
	"```ts\nconst a = 1;\n```",
	"```\n空语言\n\n两段\n```",
	"````md\n```\n嵌套围栏\n```\n````",
	"> 引用\n> 第二行",
	"> 引用里有 **粗体** 和 [[a/b]]",
	"| a | b |\n| --- | :---: |\n| 1 | [[x\\|y]] |",
	"| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| `a\\|b` | **c** |  |",
	"| 竖线 \\| 转义 | [[x\\|a\\|b]] |\n| --- | --- |",
	"![[space/xyz]]",
	"![[space/xyz|别名]]",
	"snake_case_name 和 a_b",
	"中文**粗体**和*斜体*",
	"a \\* b",
	"\\# 不是标题",
	"1\\. 不是列表",
	"\\- 不是列表",
	"\\> 不是引用",
	"\\[[不是提及]]",
	"!\\[[不是嵌入]]",
	"x \\<b> y",
	"\\&amp; 字面实体",
	"http://example.com 裸网址就是文字",
	"key:: value",
	"depends:: [[步骤一]]",
	"\\$x\\$ 不是数学",
	"!\\[图](x.png) 不是图片",
	"`[[行内代码里的提及是字面文字]]`",
	"``a`b``",
	"&#32;   四个空格开头",
	"&#32;一个空格开头\n&#9;tab 开头的第二行",
	"行尾反斜杠\\\\\n下一行",
	"[x] 不是任务（块里没有引用定义）",
	"a*b*c 词内斜体",
	"见 https://e.x/a [[P1/b2]]",
];

describe("in-dialect markdown round-trips byte for byte", () => {
	for (const src of CANONICAL) {
		test(JSON.stringify(src), () => {
			const p = parseBlock(src);
			expect(p.extra).toHaveLength(0);
			expect(p.notes).toHaveLength(0);
			expect(serializeBody(p.body)).toBe(src);
		});
	}
});

describe("mentions and embeds", () => {
	test("are recognized while tokenizing; inside inline code they are literal", () => {
		const p = parseBlock("a [[x/y|lbl]] `[[no]]` b");
		const content = (p.body as { content: Inline[] }).content;
		expect(content.filter((n) => n.type === "mention")).toEqual([
			{ type: "mention", ref: "x/y", label: "lbl", marks: [] },
		]);
		expect(content.some((n) => n.type === "text" && n.text === "[[no]]")).toBe(true);
		expect(bodyRefs(p.body)).toEqual([{ kind: "mention", ref: "x/y", label: "lbl" }]);
	});

	test("an embed occupies a whole block; mid-line it can only be a mention", () => {
		expect(parseBlock("![[x/e]]").body).toEqual({ type: "embed", ref: "x/e", label: null });
		expect(bodyRefs(parseBlock("![[x/e|看这里]]").body)).toEqual([
			{ kind: "embed", ref: "x/e", label: "看这里" },
		]);
		const mid = parseBlock("看 ![[x/e]] 这里").body as { type: string; content: Inline[] };
		expect(mid.type).toBe("paragraph");
		expect(mid.content.some((n) => n.type === "mention")).toBe(true);
	});

	test("backslash escapes inside [[…]] are undone, and written back where needed", () => {
		const p = parseBlock("[[a\\*b|\\_d\\_]]");
		const m = (p.body as { content: Inline[] }).content[0];
		expect(m).toEqual({ type: "mention", ref: "a*b", label: "_d_", marks: [] });
		expect(serializeBody(p.body)).toBe("[[a\\*b|\\_d\\_]]");
		// Escapes the serializer does not need are dropped (`_` between letters is literal).
		expect(serializeBody(parseBlock("[[c\\_d]]").body)).toBe("[[c_d]]");
	});

	test("a table cell escapes the label separator and pipes in the label", () => {
		const body: Body = {
			type: "table",
			align: [null],
			rows: [[[{ type: "mention", ref: "P1/x", label: "a|b", marks: [] }]]],
		};
		const s = serializeBody(body);
		expect(s).toBe("| [[P1/x\\|a\\|b]] |\n| --- |");
		expect(parseBlock(s).body).toEqual(body);
	});

	test("a mention that cannot be written as [[…]] is kept as literal text", () => {
		const body: Body = {
			type: "paragraph",
			content: [{ type: "mention", ref: "a]b", label: null, marks: [] }],
		};
		const s = serializeBody(body);
		expect(s).toBe("\\[[a]b]]");
		expect(plain((parseBlock(s).body as { content: Inline[] }).content)).toBe("[[a]b]]");
	});

	test("a bare URL directly followed by a mention gets a separating space", () => {
		const body: Body = {
			type: "paragraph",
			content: [
				{ type: "text", text: "见 https://e.x/a", marks: [] },
				{ type: "mention", ref: "P1/b2", label: null, marks: [] },
			],
		};
		const s = serializeBody(body);
		expect(s).toBe("见 https://e.x/a [[P1/b2]]");
		expect(parseBlock(s).body).toEqual(canonicalBody(body));
	});
});

describe("fragments and references", () => {
	test("an inline fragment keeps marks and escapes line-start syntax", () => {
		const frag: Inline[] = [
			{ type: "text", text: "# 不是标题 ", marks: [] },
			{ type: "text", text: "粗", marks: [{ type: "strong" }] },
			{ type: "text", text: "x", marks: [{ type: "code" }] },
		];
		expect(serializeInlineFragment(frag)).toBe("\\# 不是标题 **粗**`x`");
	});

	test("references in table cells, in order; none in code", () => {
		const t = parseBlock("| [[a]] | `[[no]]` |\n| --- | --- |\n| [[b\\|B]] | x |").body;
		expect(bodyRefs(t)).toEqual([
			{ kind: "mention", ref: "a", label: null },
			{ kind: "mention", ref: "b", label: "B" },
		]);
		expect(bodyRefs(parseBlock("```\n[[x]]\n```").body)).toEqual([]);
	});
});

describe("line breaks", () => {
	test("every newline in a block is a hard break", () => {
		const p = parseBlock("a\nb").body as { content: Inline[] };
		expect(p.content.map((n) => n.type)).toEqual(["text", "br", "text"]);
	});

	test("a line break inside a heading or table cell becomes a space", () => {
		const cell: Inline[] = [
			{ type: "text", text: "上", marks: [] },
			{ type: "br" },
			{ type: "text", text: "下", marks: [] },
		];
		expect(serializeBody({ type: "heading", level: 2, content: cell })).toBe("## 上 下");
		expect(serializeBody({ type: "table", align: [null], rows: [[cell]] })).toBe(
			"| 上 下 |\n| --- |",
		);
	});

	test("blank lines, trailing spaces and edge breaks are normalized away", () => {
		const body: Body = {
			type: "paragraph",
			content: [
				{ type: "br" },
				{ type: "text", text: "a  ", marks: [] },
				{ type: "br" },
				{ type: "text", text: "   ", marks: [] },
				{ type: "br" },
				{ type: "text", text: "b", marks: [{ type: "strong" }] },
				{ type: "br" },
			],
		};
		expect(serializeBody(body)).toBe("a\n**b**");
	});
});

describe("out-of-dialect markdown is split into child blocks or kept as text", () => {
	const cases: Array<{ src: string; content: string; kids: string[]; code: DialectNoteCode }> = [
		{ src: "- a\n- b", content: "a", kids: ["b"], code: "split-list" },
		{ src: "intro\n- a\n- b", content: "intro", kids: ["a", "b"], code: "split-list" },
		{ src: "第一段\n\n第二段", content: "第一段", kids: ["第二段"], code: "split-paragraphs" },
		{ src: "#### 四级标题", content: "**四级标题**", kids: [], code: "heading-demoted" },
		{ src: "###### 六级", content: "**六级**", kids: [], code: "heading-demoted" },
		{ src: "a\n\n---\n\nb", content: "a", kids: ["b"], code: "rule-dropped" },
		{
			src: "<div>html 块</div>",
			content: "\\<div>html 块\\</div>",
			kids: [],
			code: "kept-as-text",
		},
		{
			src: "[x]: https://e.x\n\n正文",
			content: "\\[x]: https://e.x",
			kids: ["正文"],
			code: "kept-as-text",
		},
		{ src: "    缩进代码", content: "```\n缩进代码\n```", kids: [], code: "indented-code" },
		{ src: "> a\n>\n> b", content: "> a", kids: ["> b"], code: "split-quote" },
	];
	for (const c of cases) {
		test(JSON.stringify(c.src), () => {
			const r = normalizeBlock(c.src);
			expect(r.content).toBe(c.content);
			expect(r.children.map((k) => serializeBody(k.body))).toEqual(c.kids);
			expect(r.notes.map((n) => n.code)).toContain(c.code);
			expect(normalizeBlock(r.content)).toEqual({ content: r.content, children: [], notes: [] });
		});
	}

	test("a task list keeps its checkbox states on the split children", () => {
		const r = normalizeBlock("todo:\n\n- [ ] a\n- [x] b\n- [/] c\n- [-] d");
		expect(r.children.map((k) => k.task)).toEqual(["todo", "done", "doing", "cancelled"]);
	});

	test("images, math, inline HTML, setext and other spellings normalize without losing text", () => {
		const keep = [
			["![图](x.png)", "!\\[图](x.png)"],
			["$E=mc^2$", "\\$E=mc^2\\$"],
			["$$x$$", "\\$\\$x\\$\\$"],
			["a <b>粗</b> c", "a \\<b>粗\\</b> c"],
			["a<br>b", "a\\<br>b"],
			["标题\n===", "# 标题"],
			["*斜体* 和 _下划线斜体_", "*斜体* 和 *下划线斜体*"],
			["__粗__", "**粗**"],
			["~单波浪线~", "~~单波浪线~~"],
			["行尾两个空格  \n换行", "行尾两个空格\n换行"],
			["反斜杠硬换行\\\n换行", "反斜杠硬换行\n换行"],
			["<https://e.x>", "\\<https://e.x>"],
			["&copy; &hearts;", "© \\&hearts;"],
			["   三个空格", "三个空格"],
		];
		for (const [src, want] of keep) {
			const r = normalizeBlock(src as string);
			expect(r.content).toBe(want as string);
			expect(normalizeBlock(r.content).content).toBe(want as string);
		}
	});
});

describe("CJK punctuation at the edge of emphasis", () => {
	const cases: Array<[string, Inline[], string]> = [
		[
			"trailing full-width colon moves out of bold",
			[
				{ type: "text", text: "这是", marks: [] },
				{ type: "text", text: "重点：", marks: [{ type: "strong" }] },
				{ type: "text", text: "内容", marks: [] },
			],
			"这是**重点**：内容",
		],
		[
			"corner brackets move out of bold",
			[
				{ type: "text", text: "「重点」", marks: [{ type: "strong" }] },
				{ type: "text", text: "内容", marks: [] },
			],
			"**「重点**」内容",
		],
		[
			"leading punctuation moves out of italics",
			[
				{ type: "text", text: "前", marks: [] },
				{ type: "text", text: "（注）", marks: [{ type: "em" }] },
				{ type: "text", text: "后", marks: [] },
			],
			"前（*注*）后",
		],
	];
	for (const [name, content, want] of cases) {
		test(name, () => {
			const s = serializeBody({ type: "paragraph", content });
			expect(s).toBe(want);
			const back = parseBlock(s).body as { content: Inline[] };
			expect(plain(back.content)).toBe(plain(content));
		});
	}

	test("a mark that cannot be written at all is dropped, the text stays", () => {
		const content: Inline[] = [
			{ type: "text", text: "字", marks: [] },
			{ type: "text", text: "：", marks: [{ type: "strong" }] },
			{ type: "text", text: "字", marks: [] },
		];
		const s = serializeBody({ type: "paragraph", content });
		expect(s).toBe("字：字");
	});
});

describe("source offsets ↔ editor positions", () => {
	test("the map is monotonic and skips delimiters and escapes", () => {
		const src = "ab **cd** [[x|y]] `e` \\* f\n第二行";
		const p = parseBlock(src);
		const a = p.map.pmToSrc;
		for (let i = 1; i < a.length; i++) expect(a[i]).toBeGreaterThanOrEqual(a[i - 1] as number);
		const text = plain((p.body as { content: Inline[] }).content);
		// 'c' is at editor offset 3 and source offset 5 (after `**`).
		expect(text[3]).toBe("c");
		expect(src[pmToSrc(p.map, 3)]).toBe("c");
		// A mention takes one editor position, so 第二行 starts at size - 3.
		expect(srcToPm(p.map, src.indexOf("第二行"))).toBe(p.map.size - 3);
	});

	test("tables, quotes and headings", () => {
		const t = parseBlock("| a | bc |\n| --- | --- |\n| 1 | 2 |");
		// Second header cell's 'c': row(1) + cell(1) + 'a'(1) + close(1) + open(1) + 'b' → 6.
		expect(t.map.pmToSrc[6]).toBe("| a | bc |".indexOf("c"));
		const q = parseBlock("> 一\n> 二");
		expect(q.map.pmToSrc[2]).toBe("> 一\n> 二".indexOf("二"));
		expect(parseBlock("## 标题").map.pmToSrc[0]).toBe(3);
	});
});

describe("cost", () => {
	test("the serializer stays linear on large pathological bodies", () => {
		// Built directly (no marked) so only our code is timed. Quadratic behaviour would take
		// seconds here; the linear writer needs a few hundred milliseconds at most.
		const many = (n: number, f: (i: number) => Inline[]): Inline[] =>
			Array.from({ length: n }, (_, i) => f(i)).flat();
		const bodies: Body[] = [
			{
				type: "paragraph",
				content: many(16_000, () => [
					{ type: "text", text: "a", marks: [{ type: "em" }] },
					{ type: "text", text: " ", marks: [] },
				]),
			},
			{
				type: "paragraph",
				content: many(16_000, () => [{ type: "text", text: "a", marks: [] }, { type: "br" }]),
			},
			{
				type: "paragraph",
				content: [
					{ type: "text", text: "重点：内容，<a [x]( http://x.y_ a@b.c ".repeat(2000), marks: [] },
				],
			},
			{
				type: "paragraph",
				content: many(8_000, () => [
					{ type: "text", text: "重点", marks: [{ type: "strong" }] },
					{ type: "text", text: "：内容，", marks: [] },
				]),
			},
		];
		for (const body of bodies) {
			const t = performance.now();
			serializeBodyRaw(body);
			expect(performance.now() - t).toBeLessThan(2000);
		}
	});
});
