/**
 * The detection of content the old Spec panel swallowed (outline P2 PR 12c): which structures a
 * text holds, and which of them a save lost. Pure functions, no I/O.
 */
import { describe, expect, test } from "bun:test";
import {
	buildSpecLossExcerpt,
	extractSpecLossItems,
	hasGfmTableDelimiterRow,
	isSpecLossPath,
	lostSpecItems,
	SPEC_LOSS_CUT_MARK,
	specLossKindCounts,
} from "./spec-content-loss";

const TABLE = "| a | b |\n| --- | :-: |\n| 1 | 2 |";

const kinds = (text: string) => extractSpecLossItems(text).map((item) => item.kind);
const lost = (before: string, after: string, current = after) =>
	lostSpecItems(
		extractSpecLossItems(before),
		extractSpecLossItems(after),
		extractSpecLossItems(current),
	);

describe("extractSpecLossItems", () => {
	test("a table with its rows, also indented in a list and quoted", () => {
		const items = extractSpecLossItems(
			`intro\n\n${TABLE}\n\ntext\n\n- item\n  | x | y |\n  |---|---|\n\n> | q |\n> | - |\n> | r |\n`,
		);
		expect(items.map((item) => item.kind)).toEqual(["table", "table", "table"]);
		expect(items[0]?.raw).toBe(TABLE);
		expect(items[2]?.raw).toBe("> | q |\n> | - |\n> | r |");
	});

	test("code is not looked into: an indented block, a fence with a fenced line inside", () => {
		// Four columns in after a blank line, outside a list: code.
		expect(kinds("text\n\n    |a|b|\n    |-|-|\n    |1|2|\n")).toEqual([]);
		expect(kinds("    |a|b|\n    |-|-|\n\n    ![x](y.png) <br>\n")).toEqual([]);
		// The same indentation under a list item is the item's content.
		expect(kinds("- item\n\n    |a|b|\n    |-|-|\n    |1|2|\n")).toEqual(["table"]);
		// After the list ended, an indented block is code again.
		expect(kinds("- item\n\ntext\n\n    |a|b|\n    |-|-|\n")).toEqual([]);
		// ```js inside an open ``` fence is content, it does not close the fence.
		expect(kinds("```\n```js\n|a|b|\n|-|-|\n```\n")).toEqual([]);
		expect(kinds("```\n```js\n|a|b|\n|-|-|\n```\n\n|x|y|\n|-|-|\n")).toEqual(["table"]);
		expect(
			extractSpecLossItems("````\n```js\n|a|b|\n|-|-|\n```\n````\n|x|y|\n|-|-|\n").map(
				(item) => item.key,
			),
		).toEqual(["x\u001fy"]);
	});

	test("HTML needs a real tag: placeholders, generics and comparisons in prose are not", () => {
		expect(kinds("run foo <file> now\nList<T> here\n<name> is required")).toEqual([]);
		expect(kinds("Use Array<string> and Map<K, V> and a < b > c and <https://x.y>")).toEqual([]);
		expect(kinds("the <title> of the page, the <code> to run")).toEqual([]);
		expect(kinds("use `<div>` here")).toEqual([]);
		expect(kinds("a <file>path</file> b, and vector<i>, and \\<br> escaped")).toEqual([]);
		expect(kinds("x <br> y")).toEqual(["html"]);
		expect(kinds("one line<br>the next")).toEqual(["html"]);
		expect(kinds("a <span>b</span> c")).toEqual(["html"]);
		expect(kinds('<div align="center">\ntext')).toEqual(["html"]);
		expect(kinds("<details>\n<summary>more</summary>\nbody\n</details>")).toEqual(["html"]);
		expect(kinds("<!-- note -->\ntext")).toEqual(["html"]);
		expect(kinds("<my-widget></my-widget>")).toEqual(["html"]);
	});

	test("front matter is key lines after a leading ---, not a rule the document opens with", () => {
		expect(kinds("---\n# Title\n\ntext\n\n---\nrest")).toEqual([]);
		expect(kinds(`---\n# Title\n\n${TABLE}\n\n---\nrest`)).toEqual(["table"]);
		expect(kinds("---\ntitle: x\ntags:\n  - a\n- b\n# note\n---\nbody")).toEqual(["frontMatter"]);
		expect(kinds("---\r\ntitle: x\r\n---\r\nbody")).toEqual(["frontMatter"]);
		// A byte order mark before it.
		expect(kinds("\ufeff---\ntitle: x\n---\nbody")).toEqual(["frontMatter"]);
	});

	test("images and footnotes: the forms read, and long hostile lines read in linear time", () => {
		expect(
			extractSpecLossItems('![a](http://x/y.png "t") ![b][ref] ![中文](<图片.png>) ![c]').map(
				(item) => item.key,
			),
		).toEqual(["http://x/y.png", "[ref]", "图片.png"]);
		expect(extractSpecLossItems("t[^1] and [^注]\n\n[^1]: def").map((item) => item.key)).toEqual([
			"ref:1",
			"ref:注",
			"def:1",
		]);
		for (const text of [
			"![".repeat(200_000),
			"![a](".repeat(100_000),
			"![a][".repeat(100_000),
			"[^a".repeat(150_000),
			"<a ".repeat(150_000),
			"`a".repeat(200_000),
		]) {
			const started = performance.now();
			extractSpecLossItems(text);
			expect(performance.now() - started).toBeLessThan(2000);
		}
		// An inlined image far longer than the other patterns look at is still an image.
		const inlined = `![x](data:image/png;base64,${"A".repeat(300_000)})`;
		expect(extractSpecLossItems(inlined).map((item) => item.kind)).toEqual(["image"]);
	});

	test("a dash line without a pipe is no table; a pipe line without a delimiter row neither", () => {
		expect(kinds("Title\n-----\n\na | b\n\n---\n")).toEqual([]);
	});

	test("a table is compared by its cells: spacing and alignment do not matter", () => {
		const [a] = extractSpecLossItems("| a | b |\n|---|---|\n| 1 | 2 |");
		const [b] = extractSpecLossItems("|a|b|\n| :-- | --: |\n|  1  |  2  |");
		expect(a?.key).toBe(b?.key as string);
		const [c] = extractSpecLossItems("| a | b |\n|---|---|\n| 1 | 3 |");
		expect(c?.key).not.toBe(a?.key as string);
	});

	test("every kind, in order; fenced code is skipped", () => {
		const text = [
			"---",
			"title: x",
			"---",
			'<div class="a">',
			"inner",
			"</div>",
			"",
			"text with <span>inline</span> html",
			"- [ ] open item",
			"1. [x] done item",
			'![alt](img/a.png "t") and ![b][ref]',
			"a note[^1]",
			"[^1]: the note",
			"```",
			TABLE,
			"- [ ] not a task",
			"<div>",
			"```",
			"`<b>` in code is not html, <https://example.com> is a link",
		].join("\n");
		expect(kinds(text)).toEqual([
			"frontMatter",
			"html",
			"html",
			"taskItem",
			"taskItem",
			"image",
			"image",
			"footnote",
			"footnote",
		]);
		const items = extractSpecLossItems(text);
		expect(items.find((item) => item.kind === "image")?.key).toBe("img/a.png");
		expect(items.filter((item) => item.kind === "taskItem").map((item) => item.key)).toEqual([
			"open item",
			"done item",
		]);
	});

	test("a front matter that never closes is none", () => {
		expect(kinds("---\ntitle: x\n\ntext")).toEqual([]);
	});
});

describe("lostSpecItems", () => {
	test("a save that drops the table loses it", () => {
		const found = lost(`# T\n\n${TABLE}\n\ntext`, "# T\n\ntext");
		expect(found.map((item) => item.kind)).toEqual(["table"]);
		expect(found[0]?.raw).toBe(TABLE);
	});

	test("put back since: the current revision holds it, so nothing is lost", () => {
		expect(lost(`${TABLE}\n\ntext`, "text", `text\n\n${TABLE}`)).toEqual([]);
	});

	test("an edited table is not lost: the save holds as many tables as before", () => {
		expect(lost(TABLE, TABLE.replace("| 1 | 2 |", "| 1 | 9 |"))).toEqual([]);
	});

	test("one of two tables dropped: only that one", () => {
		const other = "| x |\n|---|\n| y |";
		const found = lost(`${TABLE}\n\n${other}`, TABLE);
		expect(found.map((item) => item.raw)).toEqual([other]);
	});

	test("what the save still held is not its loss, also when the current revision lacks it", () => {
		const other = "| x |\n|---|\n| y |";
		const found = lost(`${TABLE}\n\n${other}`, TABLE, "nothing left");
		expect(found.map((item) => item.raw)).toEqual([other]);
	});

	test("the same table twice, one dropped: its rows still stand, nothing reported", () => {
		expect(lost(`${TABLE}\n\n${TABLE}`, TABLE)).toEqual([]);
	});

	test("two tables made one with every row kept is no loss; a row gone is", () => {
		const two = "|a|b|\n|-|-|\n|1|2|\n\n|a|b|\n|-|-|\n|3|4|\n";
		expect(lost(two, "|a|b|\n|-|-|\n|1|2|\n|3|4|\n")).toEqual([]);
		// Also when the file as it is now no longer holds them: the save did not lose them.
		expect(lost(two, "|a|b|\n|-|-|\n|1|2|\n|3|4|\n", "nothing left")).toEqual([]);
		// The rows are in the file's current table again: not lost either.
		expect(lost(two, "|a|b|\n|-|-|\n|1|2|\n", "|a|b|\n|-|-|\n|3|4|\n|1|2|\n")).toEqual([]);
		expect(lost(two, "|a|b|\n|-|-|\n|1|2|\n").map((item) => item.raw)).toEqual([
			"|a|b|\n|-|-|\n|3|4|",
		]);
	});

	test("reordering tables, or editing a row, loses nothing; a table made a list is lost", () => {
		const other = "|c|d|\n|-|-|\n|3|4|";
		expect(lost(`${TABLE}\n\n${other}`, `${other}\n\n${TABLE}`)).toEqual([]);
		expect(lost(TABLE, "- a: 1\n- b: 2").map((item) => item.kind)).toEqual(["table"]);
	});

	test("checking a task item loses nothing; items turned into plain bullets are lost", () => {
		expect(lost("- [ ] a\n- [ ] b", "- [x] a\n- [ ] b")).toEqual([]);
		expect(lost("- [ ] a\n- [ ] b", "- a\n- b").map((item) => item.key)).toEqual(["a", "b"]);
	});

	test("images, html, footnotes and front matter rewritten away", () => {
		const before =
			"---\nk: v\n---\n![x](a.png)\n\n<details>\nmore\n</details>\n\nn[^a]\n\n[^a]: note";
		const found = lost(before, "k: v\n\nmore\n\nn");
		expect(specLossKindCounts(found)).toEqual({
			frontMatter: 1,
			image: 1,
			html: 1,
			footnote: 2,
		});
	});

	test("nothing before, nothing lost", () => {
		expect(lost("plain", "")).toEqual([]);
	});
});

describe("buildSpecLossExcerpt", () => {
	test("each source once, in order", () => {
		const items = extractSpecLossItems(`![a](1.png) ![b](2.png)\n\n${TABLE}`);
		const excerpt = buildSpecLossExcerpt(items, 10_000);
		expect(excerpt).toEqual({
			truncated: false,
			parts: [
				{ kind: "image", text: "![a](1.png) ![b](2.png)" },
				{ kind: "table", text: TABLE },
			],
		});
	});

	test("cut at a line when over the size, and said so", () => {
		const rows = Array.from({ length: 50 }, (_, n) => `| 行 ${n} | 值 |`).join("\n");
		const [table] = extractSpecLossItems(`| a | b |\n|---|---|\n${rows}`);
		const excerpt = buildSpecLossExcerpt(table ? [table] : [], 200);
		expect(excerpt.truncated).toBe(true);
		const text = excerpt.parts[0]?.text ?? "";
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(200);
		expect(text.startsWith("| a | b |\n|---|---|\n| 行 0 | 值 |")).toBe(true);
		expect(text.endsWith("|")).toBe(true);
	});
});

test("one lost line longer than the excerpt may be is cut inside and marked, never left out", () => {
	const line = `![x](data:image/png;base64,${"A".repeat(60_000)}) 尾`;
	const items = extractSpecLossItems(line);
	const excerpt = buildSpecLossExcerpt(items, 48 * 1024);
	expect(excerpt.truncated).toBe(true);
	expect(excerpt.parts).toHaveLength(1);
	const text = excerpt.parts[0]?.text ?? "";
	expect(text.startsWith("![x](data:image/png;base64,AAAA")).toBe(true);
	expect(text.endsWith(SPEC_LOSS_CUT_MARK)).toBe(true);
	expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(48 * 1024);
	// Never half a character.
	const wide = buildSpecLossExcerpt([{ kind: "html", key: "k", raw: "😀".repeat(100) }], 50);
	expect(wide.parts[0]?.text).toBe(`${"😀".repeat(10)}${SPEC_LOSS_CUT_MARK}`);
});

test("which files are looked at", () => {
	expect(isSpecLossPath("design.md")).toBe(true);
	expect(isSpecLossPath("notes/A.MARKDOWN")).toBe(true);
	expect(isSpecLossPath("behavior_fence")).toBe(true);
	expect(isSpecLossPath("tasks.json")).toBe(false);
	expect(isSpecLossPath("data.yaml")).toBe(false);
});

test("the delimiter check the offline script uses is unchanged", () => {
	expect(hasGfmTableDelimiterRow(TABLE)).toBe(true);
	expect(hasGfmTableDelimiterRow("a\n---\nb")).toBe(false);
});
