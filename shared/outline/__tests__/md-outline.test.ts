import { describe, expect, test } from "bun:test";
import { serializeBody } from "../dialect";
import {
	type OutlineItem,
	type OutlineProps,
	type OutlineTask,
	parseMarkdownOutline,
	serializeMarkdownOutline,
} from "../md-outline";
import { FUZZ_TIMEOUT_MS, fuzzCount, pick, randomBody, rng } from "./fuzz.fixture";

const item = (
	content: string,
	children: OutlineItem[] = [],
	task: OutlineTask | null = null,
	props: OutlineProps = {},
): OutlineItem => ({ content, task, props, children });

function roundTrip(src: string) {
	const first = parseMarkdownOutline(src);
	const out = serializeMarkdownOutline(first.items);
	const second = parseMarkdownOutline(out);
	expect(second.items).toEqual(first.items);
	expect(second.notes).toEqual([]);
	expect(serializeMarkdownOutline(second.items)).toBe(out);
	return { ...first, out };
}

describe("canonical outlines round-trip byte for byte", () => {
	const canonical = [
		"- [ ] 改刷新逻辑 @agent:w-auth",
		"  depends:: [[补回归测试]], [[P1/x|显示]]",
		"  due:: 2026-11-01",
		"  alias:: Q17",
		"  tags:: [[auth]], [[并发]]",
		"  - 方案：刷新时带上版本号，旧版本的请求直接拒绝",
		"    第二行是硬换行",
		"  - [/] 进行中",
		"  - [x] 完成 @human:owner",
		"  - [-] 取消",
		"- ```ts",
		"  const a = 1;",
		"",
		"  - 围栏里的不是列表项",
		"  ```",
		"- # 标题",
		"- > 引用",
		"  > 第二行",
		"- | a | b |",
		"  | --- | :---: |",
		"  | [[x\\|y]] | `a\\|b` |",
		"- ![[P2/b3|嵌入]]",
		"-",
		"- [ ]",
	].join("\n");

	test("parse → serialize is the identity", () => {
		const { items, notes, out } = roundTrip(canonical);
		expect(notes).toEqual([]);
		expect(out).toBe(canonical);
		expect(items).toHaveLength(8);
		const task = items[0] as OutlineItem;
		expect(task.task).toEqual({ status: "todo", assignee: "agent:w-auth" });
		expect(task.props).toEqual({
			depends: [
				{ target: "补回归测试", label: null },
				{ target: "P1/x", label: "显示" },
			],
			due: "2026-11-01",
			alias: "Q17",
			tags: [
				{ target: "auth", label: null },
				{ target: "并发", label: null },
			],
		});
		expect(task.children.map((c) => c.task?.status ?? null)).toEqual([
			null,
			"doing",
			"done",
			"cancelled",
		]);
		expect(task.children[0]?.content).toBe(
			"方案：刷新时带上版本号，旧版本的请求直接拒绝\n第二行是硬换行",
		);
		expect(task.children[2]?.task?.assignee).toBe("human:owner");
		expect(items[1]?.content).toBe("```ts\nconst a = 1;\n\n- 围栏里的不是列表项\n```");
		expect(items[6]?.content).toBe("");
		expect(items[7]?.task).toEqual({ status: "todo", assignee: null });
	});
});

describe("indentation is hierarchy", () => {
	const tree = [
		item("a", [item("b", [item("c")]), item("d")]),
		item("e", [], { status: "todo", assignee: null }),
	];
	test.each([
		["2 spaces", "- a\n  - b\n    - c\n  - d\n- [ ] e"],
		["4 spaces", "- a\n    - b\n        - c\n    - d\n- [ ] e"],
		["tabs", "- a\n\t- b\n\t\t- c\n\t- d\n- [ ] e"],
		["other bullets", "* a\n  + b\n    1. c\n  2) d\n- [ ] e"],
	])("%s", (_name, src) => {
		const r = parseMarkdownOutline(src);
		expect(r.items).toEqual(tree);
		expect(r.notes).toEqual([]);
	});

	test("continuation lines follow the item's indentation style", () => {
		for (const src of ["- a\n  第二行\n  - b", "- a\n    第二行\n    - b", "- a\n\t第二行\n\t- b"])
			expect(parseMarkdownOutline(src).items).toEqual([item("a\n第二行", [item("b")])]);
	});

	test("fenced code keeps its own indentation under any style", () => {
		const want = [item("```py\nif x:\n    y()\n```")];
		expect(parseMarkdownOutline("- ```py\n  if x:\n      y()\n  ```").items).toEqual(want);
		expect(parseMarkdownOutline("- ```py\n    if x:\n        y()\n    ```").items).toEqual(want);
		expect(parseMarkdownOutline("- ```py\n\tif x:\n\t    y()\n\t```").items).toEqual(want);
	});
});

describe("text that is not a list item", () => {
	test("a plain paragraph is one block, with no note", () => {
		expect(parseMarkdownOutline("一条事实")).toEqual({ items: [item("一条事实")], notes: [] });
		expect(parseMarkdownOutline("第一行\n第二行").items).toEqual([item("第一行\n第二行")]);
		expect(parseMarkdownOutline("").items).toEqual([]);
	});

	test("several paragraphs become several top-level blocks", () => {
		const r = parseMarkdownOutline("# 标题\n\n第一段\n\n```\ncode\n```");
		expect(r.items).toEqual([item("# 标题"), item("第一段"), item("```\ncode\n```")]);
		expect(r.notes.map((n) => n.code)).toEqual(["top-level-text"]);
	});

	test("top-level text next to items stays a sibling, in document order", () => {
		const r = parseMarkdownOutline("intro\n- a\n- b\n\noutro");
		expect(r.items).toEqual([item("intro"), item("a"), item("b"), item("outro")]);
		expect(r.notes.map((n) => [n.line, n.code])).toEqual([
			[1, "top-level-text"],
			[5, "top-level-text"],
		]);
	});

	test("an unindented line right after an item's text continues it (lazy line)", () => {
		expect(parseMarkdownOutline("- a\nb").items).toEqual([item("a\nb")]);
		expect(parseMarkdownOutline("- a\n  - b\nc").items).toEqual([item("a", [item("b\nc")])]);
		// After a blank line, or when the line starts a block, it is top-level text instead.
		expect(parseMarkdownOutline("- a\n\nb").items).toEqual([item("a"), item("b")]);
		expect(parseMarkdownOutline("- a\n# h").items).toEqual([item("a"), item("# h")]);
	});

	test("text after an item's children becomes a further child", () => {
		const r = parseMarkdownOutline("- a\n  - b\n  c\n  d");
		expect(r.items).toEqual([item("a", [item("b"), item("c\nd")])]);
		expect(r.notes).toEqual([
			{
				line: 3,
				code: "text-after-children",
				message: "text after child items became a child block",
			},
		]);
	});

	test("a horizontal rule is dropped and reported", () => {
		const r = parseMarkdownOutline("- a\n\n---\n\n- b");
		expect(r.items).toEqual([item("a"), item("b")]);
		expect(r.notes.map((n) => n.code)).toContain("rule-dropped");
	});
});

describe("bodies are normalized by the dialect", () => {
	test("extra paragraphs and nested markdown lists inside an item become child blocks", () => {
		const r = parseMarkdownOutline("- 结论\n\n  补充说明\n  - 子项");
		expect(r.items).toEqual([item("结论", [item("补充说明"), item("子项")])]);
		expect(r.notes.map((n) => n.code)).toEqual(["split-paragraphs"]);
	});

	test("a list inside a quote is split, keeping task states", () => {
		const r = parseMarkdownOutline("- > 引用\n  >\n  > - [x] 子任务");
		expect(r.items[0]?.children[0]?.task?.status).toBe("done");
	});

	test("h4 becomes a bold paragraph; images and math are kept as text", () => {
		const r = parseMarkdownOutline("- #### 小标题\n- ![图](x.png)\n- $x$");
		expect(r.items.map((i) => i.content)).toEqual(["**小标题**", "!\\[图](x.png)", "\\$x\\$"]);
		expect(r.notes.map((n) => [n.line, n.code])).toEqual([[1, "heading-demoted"]]);
	});
});

describe("properties", () => {
	test("tags and depends are links; bare words are read as links and reported", () => {
		const r = parseMarkdownOutline("- [ ] t\n  tags:: auth, 并发\n  depends:: 步骤一");
		expect(r.items[0]?.props).toEqual({
			tags: [
				{ target: "auth", label: null },
				{ target: "并发", label: null },
			],
			depends: [{ target: "步骤一", label: null }],
		});
		expect(r.notes.map((n) => [n.line, n.code])).toEqual([
			[2, "bare-link"],
			[3, "bare-link"],
		]);
		expect(serializeMarkdownOutline(r.items)).toBe(
			"- [ ] t\n  depends:: [[步骤一]]\n  tags:: [[auth]], [[并发]]",
		);
	});

	test("repeated list properties merge; scalar ones keep the last value", () => {
		const r = parseMarkdownOutline(
			"- a\n  tags:: [[x]]\n  tags:: [[y]], [[x]]\n  due:: 2026-01-01\n  due:: 2026-02-01",
		);
		expect(r.items[0]?.props).toEqual({
			tags: [
				{ target: "x", label: null },
				{ target: "y", label: null },
			],
			due: "2026-02-01",
		});
		expect(r.notes.map((n) => n.code)).toEqual(["duplicate-property"]);
	});

	test("`alias:: Q?` asks for the next number; a property may sit after the children", () => {
		const r = parseMarkdownOutline("- 决定\n  - 理由\n  alias:: D?");
		expect(r.items).toEqual([item("决定", [item("理由")], null, { alias: "D?" })]);
	});

	test("unknown keys and invalid values stay in the body, and survive a round trip", () => {
		const { items, notes, out } = roundTrip(
			"- a\n  note:: 一句话\n  due:: next friday\n  alias:: two words",
		);
		expect(items).toEqual([item("a\nnote:: 一句话\ndue:: next friday\nalias:: two words")]);
		expect(notes.map((n) => [n.line, n.code])).toEqual([
			[2, "unknown-property"],
			[3, "invalid-property"],
			[4, "invalid-property"],
		]);
		expect(out).toBe("- a\n  note\\:: 一句话\n  due\\:: next friday\n  alias\\:: two words");
	});

	test("the first line of an item is never a property", () => {
		expect(roundTrip("- due:: 2026-01-01").items).toEqual([item("due:: 2026-01-01")]);
	});
});

describe("tasks and assignees", () => {
	test("checkbox spellings", () => {
		const r = parseMarkdownOutline("- [ ] a\n- [/] b\n- [x] c\n- [X] d\n- [-] e\n- [x]f\n- [?] g");
		expect(r.items.map((i) => [i.task?.status ?? null, i.content])).toEqual([
			["todo", "a"],
			["doing", "b"],
			["done", "c"],
			["done", "d"],
			["cancelled", "e"],
			[null, "[x]f"],
			[null, "[?] g"],
		]);
	});

	test("the assignee may sit anywhere in the first line; code spans are text", () => {
		const r = parseMarkdownOutline(
			"- [ ] 修 @agent:w-auth 这里\n- [ ] 看 `@agent:x`\n- [ ] a @human:x @agent:y\n- 不是任务 @agent:z",
		);
		expect(r.items.map((i) => [i.content, i.task?.assignee ?? null])).toEqual([
			["修 这里", "agent:w-auth"],
			["看 `@agent:x`", null],
			["a @agent:y", "human:x"],
			["不是任务 @agent:z", null],
		]);
		expect(r.notes.map((n) => [n.line, n.code])).toEqual([[3, "extra-assignee"]]);
	});

	test("text that would read as task syntax is escaped on the way out", () => {
		const items = [
			item("[ ] 不是任务"),
			item("[x] 也不是"),
			item("提到 @agent:x 的任务", [], { status: "todo", assignee: "human:me" }),
		];
		const out = serializeMarkdownOutline(items);
		expect(out).toBe("- \\[ ] 不是任务\n- \\[x] 也不是\n- [ ] 提到 \\@agent:x 的任务 @human:me");
		expect(parseMarkdownOutline(out)).toEqual({ items, notes: [] });
	});

	test("a task whose body is not a paragraph still carries its assignee", () => {
		const items = [
			item("```js\nx()\n```", [], { status: "doing", assignee: "agent:a" }),
			item("| a |\n| --- |", [], { status: "todo", assignee: "agent:b" }),
			item("![[P1/x]]", [], { status: "done", assignee: "human:c" }),
		];
		const out = serializeMarkdownOutline(items);
		expect(parseMarkdownOutline(out)).toEqual({ items, notes: [] });
	});
});

describe("labels", () => {
	const label = (_: OutlineItem, path: readonly number[]) => `⟦${path.join(".")}⟧`;
	const readLabel = (head: string) => {
		const m = /^⟦([^⟧]*)⟧/.exec(head);
		return m ? { label: m[1] as string, rest: head.slice(m[0].length) } : null;
	};

	test("a per-block label goes right after the bullet and is read back", () => {
		const items = [item("a", [item("b", [], { status: "todo", assignee: null })]), item("⟦c⟧")];
		const out = serializeMarkdownOutline(items, { label });
		expect(out).toBe("- ⟦0⟧ a\n  - ⟦0.0⟧ [ ] b\n- ⟦1⟧ ⟦c⟧");
		const back = parseMarkdownOutline(out, { readLabel });
		expect(back.notes).toEqual([]);
		expect(back.items[0]?.label).toBe("0");
		expect(back.items[0]?.children[0]?.label).toBe("0.0");
		expect(back.items[1]).toEqual({ ...item("⟦c⟧"), label: "1" });
		const strip = (xs: OutlineItem[]): OutlineItem[] =>
			xs.map(({ label: _l, ...x }) => ({ ...x, children: strip(x.children) }));
		expect(strip(back.items)).toEqual(items);
		expect(serializeMarkdownOutline(back.items, { label })).toBe(out);
	});
});

describe("input robustness", () => {
	test("CRLF, a BOM and trailing blank lines are accepted", () => {
		expect(parseMarkdownOutline("\uFEFF- a\r\n  - b\r\n\r\n").items).toEqual([
			item("a", [item("b")]),
		]);
	});

	test("fences opened in a body line hold item-looking lines", () => {
		const r = parseMarkdownOutline("- 说明\n  ```\n  - x\n  ```\n- 下一项");
		expect(r.items).toEqual([item("说明", [item("```\n- x\n```")]), item("下一项")]);
	});

	test("an unclosed fence ends with its item, without losing lines", () => {
		expect(parseMarkdownOutline("- ```\n  - a\n- b").items).toEqual([
			item("```\n- a\n```"),
			item("b"),
		]);
		expect(parseMarkdownOutline("```\n- a\n- b").items).toEqual([item("```\n- a\n- b\n```")]);
	});
});

describe("random outlines round-trip", () => {
	const ASSIGNEES = ["agent:w-auth", "human:owner", "agent:main"];
	const TARGETS = ["P1/b2", "补回归测试", "a*b", "Q17"];

	function randomItems(r: () => number, depth: number): OutlineItem[] {
		const n = depth > 3 ? 0 : Math.floor(r() * (depth === 0 ? 5 : 3));
		return Array.from({ length: n }, () => {
			const task: OutlineTask | null =
				r() < 0.4
					? {
							status: pick(r, ["todo", "doing", "done", "cancelled"] as const),
							assignee: r() < 0.5 ? pick(r, ASSIGNEES) : null,
						}
					: null;
			const props: OutlineProps = {};
			if (r() < 0.2)
				props.depends = [{ target: pick(r, TARGETS), label: r() < 0.3 ? "显示" : null }];
			if (r() < 0.1) props.due = "2026-11-01";
			if (r() < 0.1) props.alias = pick(r, ["Q17", "D?"]);
			if (r() < 0.1) props.tags = [{ target: pick(r, TARGETS), label: null }];
			return {
				content: serializeBody(randomBody(r)),
				task,
				props,
				children: randomItems(r, depth + 1),
			};
		});
	}

	test(
		"serialize → parse gives the same items, and the text is a fixed point",
		() => {
			const r = rng(77);
			const failures: string[] = [];
			for (let i = 0; i < fuzzCount(250) && failures.length < 3; i++) {
				const items = randomItems(r, 0);
				const out = serializeMarkdownOutline(items);
				const back = parseMarkdownOutline(out);
				if (JSON.stringify(back.items) !== JSON.stringify(items) || back.notes.length)
					failures.push(out);
				else if (serializeMarkdownOutline(back.items) !== out) failures.push(out);
			}
			expect(failures).toEqual([]);
		},
		FUZZ_TIMEOUT_MS,
	);
});
