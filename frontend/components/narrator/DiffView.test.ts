import { describe, expect, test } from "bun:test";
import { computeDiff } from "./DiffView";

describe("DiffView line-ending handling", () => {
	test("does not report CRLF, LF, and CR as content changes", () => {
		const lines = computeDiff("first\r\nsecond\rthird\r\n", "first\nsecond\nthird\n");

		expect(lines).toHaveLength(3);
		expect(lines.every((line) => line.type === "context")).toBe(true);
		expect(lines.map((line) => line.content)).toEqual(["first", "second", "third"]);
	});

	test("still reports a real replacement when line endings differ", () => {
		const lines = computeDiff(
			"plugins {\r\n  `java-library`\r\n}\r\n",
			"plugins {\n  `maven-publish`\n}\n",
		);

		expect(lines.filter((line) => line.type === "removed").map((line) => line.content)).toEqual([
			"  `java-library`",
		]);
		expect(lines.filter((line) => line.type === "added").map((line) => line.content)).toEqual([
			"  `maven-publish`",
		]);
		expect(lines.filter((line) => line.type === "context").map((line) => line.content)).toEqual([
			"plugins {",
			"}",
		]);
	});

	test("preserves ordinary whitespace changes", () => {
		const lines = computeDiff("const value = 1;\r\n", "const value =  1;\n");

		expect(lines.some((line) => line.type === "removed")).toBe(true);
		expect(lines.some((line) => line.type === "added")).toBe(true);
	});
});
