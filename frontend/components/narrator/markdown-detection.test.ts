import { describe, expect, test } from "bun:test";
import { isSafeForFlowtokenAnimation, MD_PATTERN } from "./markdown-detection";

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
