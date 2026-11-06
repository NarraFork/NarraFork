import { describe, expect, test } from "bun:test";
import { serializeMarkdownOutline } from "../md-outline";
import { parseMarkdownSections } from "../md-sections";

describe("parseMarkdownSections", () => {
	test("headings hold their sections; a list after a paragraph goes under it", () => {
		const items = parseMarkdownSections("# A\nintro:\n\n- one\n- two\n## B\ntext\n# C\nend");
		expect(serializeMarkdownOutline(items)).toBe(
			[
				"- # A",
				"  - intro:",
				"    - one",
				"    - two",
				"  - ## B",
				"    - text",
				"- # C",
				"  - end",
			].join("\n"),
		);
	});

	test("without literal, task boxes are tasks; with it, text", () => {
		const src = "- [ ] do it\n- [x] done";
		expect(parseMarkdownSections(src).map((i) => i.task?.status)).toEqual(["todo", "done"]);
		const literal = parseMarkdownSections(src, { literal: true });
		expect(literal.map((i) => [i.content, i.task])).toEqual([
			["[ ] do it", null],
			["[x] done", null],
		]);
	});

	test("literal links and embeds stay text, escaped", () => {
		const [item] = parseMarkdownSections("see [[a|b]] and ![[c]]", { literal: true });
		expect(item?.content).toBe("see \\[[a|b]] and !\\[[c]]");
		expect(parseMarkdownSections("see [[a|b]]")[0]?.content).toBe("see [[a|b]]");
	});

	test("rules are dropped, CRLF and a BOM are read", () => {
		expect(parseMarkdownSections("﻿one\r\n\r\n***\r\n\r\ntwo").map((i) => i.content)).toEqual([
			"one",
			"two",
		]);
	});
});
