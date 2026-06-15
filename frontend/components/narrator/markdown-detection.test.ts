import { describe, expect, test } from "bun:test";
import {
	isSafeForFlowtokenAnimation,
	MD_PATTERN,
	normalizeMathDelimiters,
} from "./markdown-detection";

describe("markdown animation safety", () => {
	test("allows plain streaming text through flowtoken", () => {
		expect(isSafeForFlowtokenAnimation("hello streaming world")).toBe(true);
	});

	test("rejects backtick code fences with allowed Markdown indentation", () => {
		const text = "Intro\n  ```ts\nconst value = 1;\n  ```";

		expect(MD_PATTERN.test(text)).toBe(true);
		expect(isSafeForFlowtokenAnimation(text)).toBe(false);
	});
});

describe("normalizeMathDelimiters", () => {
	test("converts inline \\(...\\) to $...$", () => {
		expect(normalizeMathDelimiters("Energy is \\(E=mc^2\\) here")).toBe("Energy is $E=mc^2$ here");
	});

	test("converts display \\[...\\] to $$...$$", () => {
		expect(normalizeMathDelimiters("\\[\\int_0^1 x dx\\]")).toBe("$$\\int_0^1 x dx$$");
	});

	test("leaves dollar-delimited math untouched", () => {
		const text = "Inline $a+b$ and $$c+d$$";
		expect(normalizeMathDelimiters(text)).toBe(text);
	});

	test("returns input unchanged when no backslash delimiters present", () => {
		const text = "plain text with no math";
		expect(normalizeMathDelimiters(text)).toBe(text);
	});

	test("does not rewrite delimiters inside inline code", () => {
		const text = "Use `\\(x\\)` as a pattern";
		expect(normalizeMathDelimiters(text)).toBe(text);
	});

	test("does not rewrite delimiters inside fenced code blocks", () => {
		const text = "```\nmatch \\(group\\) here\n```";
		expect(normalizeMathDelimiters(text)).toBe(text);
	});

	test("does not rewrite delimiters inside indented code blocks", () => {
		const text = "    const pattern = /\\(group\\)/;";
		expect(normalizeMathDelimiters(text)).toBe(text);
	});

	test("converts math outside indented code while preserving the code block", () => {
		const text = "Formula \\(a+b\\)\n    const pattern = /\\(group\\)/;\nThen \\[c\\]";
		expect(normalizeMathDelimiters(text)).toBe(
			"Formula $a+b$\n    const pattern = /\\(group\\)/;\nThen $$c$$",
		);
	});

	test("handles multiple formulas in one string", () => {
		expect(normalizeMathDelimiters("\\(a\\) and \\(b\\) then \\[c\\]")).toBe(
			"$a$ and $b$ then $$c$$",
		);
	});

	test("converts math outside code while preserving code segment", () => {
		const text = "Formula \\(a+b\\) and code `\\(x\\)`";
		expect(normalizeMathDelimiters(text)).toBe("Formula $a+b$ and code `\\(x\\)`");
	});
});
