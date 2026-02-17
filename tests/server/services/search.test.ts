import { describe, expect, it } from "bun:test";
import { buildFtsQuery, sanitizeQuery } from "../../../server/services/search-service";

describe("search query sanitization", () => {
	it("strips SQL injection attempts", () => {
		expect(sanitizeQuery("test'; DROP TABLE chapters;--")).toBe("test DROP TABLE chapters--");
	});

	it("preserves alphanumeric, spaces, hyphens, dots, underscores", () => {
		expect(sanitizeQuery("my-file_v2.0 test")).toBe("my-file_v2.0 test");
	});

	it("strips special characters", () => {
		expect(sanitizeQuery("hello@world!#$%")).toBe("helloworld#$%");
	});

	it("returns empty for all-special input", () => {
		expect(sanitizeQuery("@#$%^&*()")).toBe("#$%");
	});

	it("trims whitespace", () => {
		expect(sanitizeQuery("  hello  ")).toBe("hello");
	});
});

describe("FTS query building", () => {
	it("wraps each word in quotes with prefix wildcard", () => {
		expect(buildFtsQuery("hello world")).toBe('"hello"* "world"*');
	});

	it("handles single word", () => {
		expect(buildFtsQuery("test")).toBe('"test"*');
	});

	it("collapses multiple spaces", () => {
		expect(buildFtsQuery("a   b")).toBe('"a"* "b"*');
	});
});
