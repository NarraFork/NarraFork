/**
 * 验收清单第 9 项：往返不丢（不依赖 DOM 的普通单元测试）。
 * - 方言内的写法：解析 → 序列化逐字不变。
 * - 方言外的写法：拆成子块，或原样保留为文字；不能静默丢掉。
 * - 模糊测试：随机块体 → 序列化 → 解析 → 序列化是不动点，文字不丢，标记只会被降级、不会多出来。
 */
import { describe, expect, test } from "bun:test";
import {
	normalizeBlock,
	parseBlock,
	parseOutline,
	pmToSrc,
	serializeBody,
	serializeOutline,
	srcToPm,
} from "../src/dialect/index";
import { compareBodies, safeStats } from "../src/dialect/safe";
import type { Body, Inline } from "../src/dialect/types";
import { plain, randomBody, rng } from "./fuzz-util";

const CANONICAL = [
	"",
	"plain text",
	"中文段落，带标点。",
	"**粗体**、*斜体*、`代码`、~~删除~~ 和 [链接](https://example.com)",
	'[带标题的链接](https://example.com "标题")',
	"一段 [[space/abc]] 提及",
	"[[space/abc|显示文本]] 开头的提及",
	"**[[P1/b2]]** 加粗的提及",
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
	"`[[行内代码里的提及是字面文字]]`",
	"``a`b``",
	"&#32;   四个空格开头",
	"行尾反斜杠\\\\\n下一行",
	"[x] 不是任务（块里没有引用定义）",
	"a*b*c 词内斜体",
];

describe("方言内的写法往返逐字不变", () => {
	for (const src of CANONICAL) {
		test(JSON.stringify(src), () => {
			const p = parseBlock(src);
			expect(p.extra).toHaveLength(0);
			expect(serializeBody(p.body)).toBe(src);
		});
	}

	test("提及和嵌入在分词阶段识别，行内代码里的是字面文字", () => {
		const p = parseBlock("a [[x/y|lbl]] `[[no]]` b");
		expect(p.body.type).toBe("paragraph");
		const content = (p.body as { content: Inline[] }).content;
		expect(content.filter((n) => n.type === "mention")).toHaveLength(1);
		expect(
			content.some((n) => n.type === "text" && n.text === "[[no]]" && n.marks[0]?.type === "code"),
		).toBe(true);
		expect(parseBlock("![[x/e]]").body).toEqual({ type: "embed", ref: "x/e", label: null });
		// 放在一行中间的只能是提及
		const mid = parseBlock("看 ![[x/e]] 这里").body as { type: string; content: Inline[] };
		expect(mid.type).toBe("paragraph");
		expect(mid.content.some((n) => n.type === "mention")).toBe(true);
	});

	test("块内的换行就是换行（硬换行）", () => {
		const p = parseBlock("a\nb").body as { content: Inline[] };
		expect(p.content.map((n) => n.type)).toEqual(["text", "br", "text"]);
	});
});

describe("方言外的写法：拆成子块或原样保留", () => {
	const cases: Array<{ src: string; content: string; kids: string[]; note: RegExp }> = [
		{ src: "- a\n- b", content: "a", kids: ["b"], note: /列表/ },
		{ src: "intro\n- a\n- b", content: "intro", kids: ["a", "b"], note: /列表/ },
		{ src: "第一段\n\n第二段", content: "第一段", kids: ["第二段"], note: /拆成子块/ },
		{ src: "#### 四级标题", content: "**四级标题**", kids: [], note: /h4/ },
		{ src: "a\n\n---\n\nb", content: "a", kids: ["b"], note: /分隔线/ },
		{ src: "<div>html 块</div>", content: "\\<div>html 块\\</div>", kids: [], note: /html/ },
		{ src: "[x]: https://e.x\n\n正文", content: "\\[x]: https://e.x", kids: ["正文"], note: /def/ },
		{ src: "    缩进代码", content: "```\n缩进代码\n```", kids: [], note: /缩进代码/ },
		{ src: "> a\n>\n> b", content: "> a", kids: ["> b"], note: /引用/ },
	];
	for (const c of cases) {
		test(JSON.stringify(c.src), () => {
			const r = normalizeBlock(c.src);
			expect(r.content).toBe(c.content);
			expect(r.children.map((k) => serializeBody(k.body))).toEqual(c.kids);
			expect(r.notes.join("；")).toMatch(c.note);
		});
	}

	test("图片、数学、行内 HTML、setext 标题：原样保留为文字或规范化，文字不丢", () => {
		const keep = [
			["![图](x.png)", "!\\[图](x.png)"],
			["$E=mc^2$", "\\$E=mc^2\\$"],
			["a <b>粗</b> c", "a \\<b>粗\\</b> c"],
			["标题\n===", "# 标题"],
			["*斜体* 和 _下划线斜体_", "*斜体* 和 *下划线斜体*"],
			["__粗__", "**粗**"],
			["行尾两个空格  \n换行", "行尾两个空格\n换行"],
		];
		for (const [src, want] of keep) {
			const r = normalizeBlock(src);
			expect(r.content).toBe(want);
			// 再规范化一次不变
			expect(normalizeBlock(r.content).content).toBe(want);
		}
	});

	test("中文标点紧贴粗体边界：CommonMark 写不出来，标点挪到标记外面，文字不丢", () => {
		const body: Body = {
			type: "paragraph",
			content: [
				{ type: "text", text: "这是", marks: [] },
				{ type: "text", text: "重点：", marks: [{ type: "strong" }] },
				{ type: "text", text: "内容", marks: [] },
			],
		};
		const s = serializeBody(body);
		expect(s).toBe("这是**重点**：内容");
		const back = parseBlock(s).body as { content: Inline[] };
		expect(plain(back.content)).toBe("这是重点：内容");
	});
});

describe("大纲（粘贴、复制、agent 写入）", () => {
	test("规范大纲往返逐字不变", () => {
		const src = [
			"- [ ] 任务一",
			"  - 子块 **b**",
			"  - [/] 进行中",
			"  - [x] 完成",
			"  - [-] 取消",
			"- 第二块",
			"  第二块的第二行",
			"- ```js",
			"  code",
			"  ```",
			"- # 标题",
			"- > 引用",
			"- | a | b |",
			"  | --- | --- |",
			"  | 1 | 2 |",
			"- ![[P2/b3]]",
		].join("\n");
		const { nodes } = parseOutline(src);
		expect(nodes).toHaveLength(7);
		expect(nodes[0].task).toBe(" ");
		expect(nodes[0].children.map((c) => c.task)).toEqual([null, "/", "x", "-"]);
		expect(serializeOutline(nodes)).toBe(src);
	});

	test("列表项里的多段、顶层段落都拆成块", () => {
		const { nodes, notes } = parseOutline("- 一\n\n  一的第二段\n- 二\n\n顶层段落");
		expect(nodes.map((n) => serializeBody(n.body))).toEqual(["一", "二", "顶层段落"]);
		expect(nodes[0].children.map((n) => serializeBody(n.body))).toEqual(["一的第二段"]);
		expect(notes.join()).toMatch(/拆成子块/);
	});
});

describe("源码偏移 ↔ 编辑器位置", () => {
	test("映射单调，未转义的文字逐字对应", () => {
		const src = "ab **cd** [[x|y]] `e` \\* f\n第二行";
		const p = parseBlock(src);
		const a = p.map.pmToSrc;
		for (let i = 1; i < a.length; i++) expect(a[i]).toBeGreaterThanOrEqual(a[i - 1]);
		const text = plain((p.body as { content: Inline[] }).content);
		// 'c' 在编辑器偏移 3，源码里在 5（跳过 **）
		expect(text[3]).toBe("c");
		expect(src[pmToSrc(p.map, 3)]).toBe("c");
		// 「第二行」前面：内容总长 - 3（提及在编辑器里只占 1 个位置）
		expect(srcToPm(p.map, src.indexOf("第二行"))).toBe(p.map.size - 3);
		expect(text.endsWith("第二行")).toBe(true);
	});

	test("表格、引用、标题的映射", () => {
		const t = parseBlock("| a | bc |\n| --- | --- |\n| 1 | 2 |");
		// 第一行第二格的 'c'：row(1) + cell(1) + 'a'(1) + cell close(1) + cell open(1) + 'b' → 偏移 6
		expect(t.map.pmToSrc[6]).toBe("| a | bc |".indexOf("c"));
		const q = parseBlock("> 一\n> 二");
		expect(q.map.pmToSrc[2]).toBe("> 一\n> 二".indexOf("二"));
		const h = parseBlock("## 标题");
		expect(h.map.pmToSrc[0]).toBe(3);
	});
});

describe("模糊测试", () => {
	function run(seed: number, n: number, gen: (r: () => number) => Body) {
		const r = rng(seed);
		const stats = { n, idem: 0, split: 0, type: 0, text: 0, extraMark: 0, markChanged: 0 };
		for (let i = 0; i < n; i++) {
			const b = gen(r);
			const s1 = serializeBody(b);
			const p = parseBlock(s1);
			if (serializeBody(p.body) !== s1) stats.idem++;
			if (p.extra.length) stats.split++;
			if (p.body.type !== b.type) {
				stats.type++;
				continue;
			}
			const cmp = compareBodies(b, p.body);
			if (!cmp.textEqual) {
				stats.text++;
				continue;
			}
			stats.extraMark += cmp.extraMarks;
			const changed = cmp.changed > 0;
			if (changed) stats.markChanged++;
		}
		return stats;
	}

	test("对抗性字母表（大量标点、分隔符、实体）", () => {
		const total = { n: 0, idem: 0, split: 0, type: 0, text: 0, extraMark: 0, markChanged: 0 };
		for (const seed of [42, 7, 99, 1234]) {
			const s = run(seed, 2500, randomBody);
			for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += s[k];
		}
		console.log("[fuzz adversarial]", JSON.stringify(total), JSON.stringify(safeStats));
		expect(total.idem).toBe(0);
		expect(total.split).toBe(0);
		expect(total.type).toBe(0);
		expect(total.text).toBe(0);
		expect(total.extraMark).toBe(0);
	});

	test("贴近真实的中英文正文（标记落在词边界和中文标点旁）", () => {
		const WORDS = [
			"大纲",
			"编辑器",
			"块",
			"模型",
			"是",
			"真相",
			"，",
			"。",
			"：",
			"「",
			"」",
			"（",
			"）",
			"outline",
			"block",
			"editor",
			" ",
			" ",
			"100%",
			"D23",
			"snake_case",
			"!",
		];
		const gen = (r: () => number): Body => {
			const content: Inline[] = [];
			const n = 2 + Math.floor(r() * 8);
			for (let i = 0; i < n; i++) {
				let text = "";
				const k = 1 + Math.floor(r() * 4);
				for (let j = 0; j < k; j++) text += WORDS[Math.floor(r() * WORDS.length)];
				const marks: Array<{ type: "strong" | "em" | "code" | "strike" }> = [];
				const x = r();
				if (x < 0.15) marks.push({ type: "strong" });
				else if (x < 0.25) marks.push({ type: "em" });
				else if (x < 0.3) marks.push({ type: "code" });
				else if (x < 0.33) marks.push({ type: "strike" });
				if (r() < 0.08) content.push({ type: "mention", ref: "P1/b2", label: null, marks: [] });
				content.push({ type: "text", text, marks });
			}
			return { type: "paragraph", content };
		};
		const before = { ...safeStats };
		const s = run(2026, 4000, gen);
		const degraded = safeStats.degraded - before.degraded;
		console.log("[fuzz realistic]", JSON.stringify(s), `degraded=${degraded}`);
		expect(s.idem).toBe(0);
		expect(s.text).toBe(0);
		expect(s.extraMark).toBe(0);
	});
});
