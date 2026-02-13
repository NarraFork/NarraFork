import { describe, expect, it } from "bun:test";

// Extract the query sanitization logic from search-service for unit testing
function sanitizeQuery(query: string): string {
	return query.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim();
}

function buildFtsQuery(safeQuery: string): string {
	return safeQuery
		.split(/\s+/)
		.map((w) => `"${w}"*`)
		.join(" ");
}

describe("search query sanitization", () => {
	it("strips SQL injection attempts", () => {
		expect(sanitizeQuery("test'; DROP TABLE chapters;--")).toBe("test DROP TABLE chapters--");
	});

	it("preserves alphanumeric, spaces, hyphens, dots, underscores", () => {
		expect(sanitizeQuery("my-file_v2.0 test")).toBe("my-file_v2.0 test");
	});

	it("strips special characters", () => {
		expect(sanitizeQuery("hello@world!#$%")).toBe("helloworld");
	});

	it("returns empty for all-special input", () => {
		expect(sanitizeQuery("@#$%^&*()")).toBe("");
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
