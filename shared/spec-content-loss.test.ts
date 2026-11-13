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

	test("the same table twice, one dropped: one loss", () => {
		expect(lost(`${TABLE}\n\n${TABLE}`, TABLE)).toHaveLength(1);
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
