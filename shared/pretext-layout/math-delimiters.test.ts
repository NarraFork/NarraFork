/**
 * math-delimiters.test.ts — Detection, normalization and splitting of LaTeX
 * delimiters shared by the react-markdown and pretext vlist paths.
 *
 * The `normalizeMathDelimiters` cases are carried over from the original
 * `markdown-detection.test.ts` so the move cannot silently change behaviour.
 */

import { describe, expect, test } from "bun:test";
import {
	hasMarkdownMath,
	hasUnclosedDisplayMath,
	hasUnclosedMath,
	normalizeMathDelimiters,
	splitMathOutsideCode,
	splitMathSegments,
} from "./math-delimiters";

describe("hasMarkdownMath", () => {
	test("detects each delimiter form", () => {
		expect(hasMarkdownMath("inline $a+b$ here")).toBe(true);
		expect(hasMarkdownMath("block\n$$a+b$$\n")).toBe(true);
		expect(hasMarkdownMath("paren \\(a+b\\) here")).toBe(true);
		expect(hasMarkdownMath("bracket \\[a+b\\] here")).toBe(true);
	});

	test("ignores prose and prices", () => {
		expect(hasMarkdownMath("plain text with no math")).toBe(false);
		// A lone dollar amount must not be mistaken for math.
		expect(hasMarkdownMath("it costs $5 today")).toBe(false);
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

describe("splitMathSegments", () => {
	test("returns a single text segment when there is no math", () => {
		expect(splitMathSegments("just prose")).toEqual([{ kind: "text", text: "just prose" }]);
	});

	test("splits inline math with its surrounding prose", () => {
		expect(splitMathSegments("mass $E=mc^2$ energy")).toEqual([
			{ kind: "text", text: "mass " },
			{ kind: "inline-math", latex: "E=mc^2" },
			{ kind: "text", text: " energy" },
		]);
	});

	test("splits display math", () => {
		expect(splitMathSegments("$$\\int_0^1 x dx$$")).toEqual([
			{ kind: "display-math", latex: "\\int_0^1 x dx" },
		]);
	});

	test("prefers display over two empty inline pairs", () => {
		const segments = splitMathSegments("before $$a+b$$ after");
		expect(segments).toEqual([
			{ kind: "text", text: "before " },
			{ kind: "display-math", latex: "a+b" },
			{ kind: "text", text: " after" },
		]);
	});

	test("handles several formulas in one string", () => {
		const segments = splitMathSegments("$a$ then $b$ and $$c$$");
		expect(segments.map((s) => s.kind)).toEqual([
			"inline-math",
			"text",
			"inline-math",
			"text",
			"display-math",
		]);
	});

	test("trims whitespace inside the delimiters", () => {
		expect(splitMathSegments("$$\n  a+b\n$$")).toEqual([{ kind: "display-math", latex: "a+b" }]);
	});

	test("keeps an unterminated formula as literal text", () => {
		// Mid-stream the closing delimiter has not arrived yet.
		expect(splitMathSegments("half written $E=mc")).toEqual([
			{ kind: "text", text: "half written $E=mc" },
		]);
	});

	test("keeps a lone dollar amount as literal text", () => {
		expect(splitMathSegments("costs $5 total")).toEqual([{ kind: "text", text: "costs $5 total" }]);
	});

	test("treats an escaped dollar as literal", () => {
		const segments = splitMathSegments("\\$5 and \\$9");
		expect(segments).toEqual([{ kind: "text", text: "\\$5 and \\$9" }]);
	});

	test("keeps an empty delimiter pair literal", () => {
		expect(splitMathSegments("a $$ b")).toEqual([{ kind: "text", text: "a $$ b" }]);
	});

	test("handles math adjacent to CJK with no spaces", () => {
		expect(splitMathSegments("值$x$的大小")).toEqual([
			{ kind: "text", text: "值" },
			{ kind: "inline-math", latex: "x" },
			{ kind: "text", text: "的大小" },
		]);
	});

	test("does not let inline math swallow an escaped dollar in the body", () => {
		expect(splitMathSegments("$a\\$b$")).toEqual([{ kind: "inline-math", latex: "a\\$b" }]);
	});
});

describe("splitMathOutsideCode", () => {
	test("splits math in prose", () => {
		expect(splitMathOutsideCode("mass $E=mc^2$ here")).toEqual([
			{ kind: "text", text: "mass " },
			{ kind: "inline-math", latex: "E=mc^2" },
			{ kind: "text", text: " here" },
		]);
	});

	test("leaves shell variables inside inline code alone", () => {
		const text = "run `echo $HOME` first";
		expect(splitMathOutsideCode(text)).toEqual([
			{ kind: "text", text: "run " },
			{ kind: "text", text: "`echo $HOME`" },
			{ kind: "text", text: " first" },
		]);
	});

	test("leaves a fenced code block alone", () => {
		const text = "```sh\nexport A=$B\necho $C\n```";
		const segments = splitMathOutsideCode(text);
		expect(segments.every((s) => s.kind === "text")).toBe(true);
		expect(segments.map((s) => (s.kind === "text" ? s.text : "")).join("")).toBe(text);
	});

	test("leaves an indented code block alone", () => {
		const text = "    total=$a+$b";
		const segments = splitMathOutsideCode(text);
		expect(segments.every((s) => s.kind === "text")).toBe(true);
	});

	test("splits math outside code while preserving the code region", () => {
		const segments = splitMathOutsideCode("value $x^2$ then `$y$` done");
		expect(segments).toEqual([
			{ kind: "text", text: "value " },
			{ kind: "inline-math", latex: "x^2" },
			{ kind: "text", text: " then " },
			{ kind: "text", text: "`$y$`" },
			{ kind: "text", text: " done" },
		]);
	});

	test("reassembles to the original text when there is no math", () => {
		const text = "prose with `code` and\n    indented\nmore prose";
		const segments = splitMathOutsideCode(text);
		expect(segments.map((s) => (s.kind === "text" ? s.text : "")).join("")).toBe(text);
	});
});

describe("hasUnclosedMath", () => {
	test("false for closed formulas", () => {
		expect(hasUnclosedMath("done $a+b$ here")).toBe(false);
		expect(hasUnclosedMath("done $$a+b$$ here")).toBe(false);
		expect(hasUnclosedMath("done \\(a+b\\) here")).toBe(false);
		expect(hasUnclosedMath("done \\[a+b\\] here")).toBe(false);
	});

	test("false for text with no math at all", () => {
		expect(hasUnclosedMath("plain prose")).toBe(false);
	});

	test("true while a formula is still being written", () => {
		expect(hasUnclosedMath("the value is $E=mc")).toBe(true);
		expect(hasUnclosedMath("the value is $$\\int_0")).toBe(true);
		expect(hasUnclosedMath("the value is \\(a+b")).toBe(true);
		expect(hasUnclosedMath("the value is \\[a+b")).toBe(true);
	});

	test("treats a trailing bare dollar as complete", () => {
		// Nothing follows, so it is far more likely a literal dollar sign than the
		// opening of a formula; blocking the tail on it would stall animation.
		expect(hasUnclosedMath("costs $")).toBe(false);
	});

	test("ignores escaped dollars", () => {
		expect(hasUnclosedMath("costs \\$5 exactly")).toBe(false);
	});

	test("detects the second formula being unclosed", () => {
		expect(hasUnclosedMath("$a$ and then $b")).toBe(true);
	});

	// Code is never math (mirrors splitMathOutsideCode). Without this, a shell
	// variable in prose or a fenced block reads as a half-written formula.
	test("ignores dollars inside code regions", () => {
		expect(hasUnclosedMath("run `echo $HOME` now")).toBe(false);
		expect(hasUnclosedMath("```sh\necho $PATH\n```")).toBe(false);
		expect(hasUnclosedMath("```sh\necho $$TWICE\n```")).toBe(false);
		expect(hasUnclosedMath("prose\n\n    indented $VAR code\n\nmore")).toBe(false);
		// Math outside the code region is still detected.
		expect(hasUnclosedMath("`echo $HOME` then $a+b")).toBe(true);
	});
});

describe("hasUnclosedDisplayMath", () => {
	test("false for closed display formulas", () => {
		expect(hasUnclosedDisplayMath("done $$a+b$$ here")).toBe(false);
		expect(hasUnclosedDisplayMath("done \\[a+b\\] here")).toBe(false);
	});

	test("true while a display formula is still being written", () => {
		expect(hasUnclosedDisplayMath("value $$\\int_0")).toBe(true);
		expect(hasUnclosedDisplayMath("value \\[a+b")).toBe(true);
		expect(hasUnclosedDisplayMath("$$\na+b\n\nc")).toBe(true);
	});

	// The whole point of the narrower detector: inline math cannot span the blank
	// line a streaming cut lands on, so an isolated `$` must never suppress it.
	test("ignores inline math and stray dollar signs", () => {
		expect(hasUnclosedDisplayMath("it costs $5 today")).toBe(false);
		expect(hasUnclosedDisplayMath("value $x+y$ here")).toBe(false);
		expect(hasUnclosedDisplayMath("half inline $a+b")).toBe(false);
		expect(hasUnclosedDisplayMath("inline \\(a+b")).toBe(false);
		expect(hasUnclosedDisplayMath("plain prose")).toBe(false);
	});

	test("ignores display delimiters inside code regions", () => {
		expect(hasUnclosedDisplayMath("`echo $$X`")).toBe(false);
		expect(hasUnclosedDisplayMath("```sh\necho $$X\n```")).toBe(false);
	});

	test("treats a trailing bare `$$` as not yet a formula", () => {
		expect(hasUnclosedDisplayMath("costs $$")).toBe(false);
	});
});
