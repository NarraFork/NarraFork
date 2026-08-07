import { describe, expect, test } from "bun:test";
import {
	isValidToolName,
	MAX_TOOL_NAME_LENGTH,
	normalizeToolName,
	sanitizeToolNameSegment,
	TOOL_NAME_PATTERN,
} from "../tool-name";

describe("isValidToolName", () => {
	test("accepts the built-in tool names unchanged", () => {
		for (const name of [
			"Bash",
			"Read",
			"WebSearch",
			"ExitPlanConfirmAndCompact",
			"mcp__gh__echo",
		]) {
			expect(isValidToolName(name)).toBe(true);
		}
	});

	test("rejects names providers would 400 on", () => {
		for (const name of ["", "github.search", "fs/read", "tool name", "ns:tool", "emoji😀"]) {
			expect(isValidToolName(name)).toBe(false);
		}
	});

	test("rejects names over the length budget", () => {
		expect(isValidToolName("a".repeat(MAX_TOOL_NAME_LENGTH))).toBe(true);
		expect(isValidToolName("a".repeat(MAX_TOOL_NAME_LENGTH + 1))).toBe(false);
	});
});

describe("sanitizeToolNameSegment", () => {
	test("maps illegal characters to underscores instead of dropping them", () => {
		// Dropping would let `a.b` and `ab` collapse onto the same wire name.
		expect(sanitizeToolNameSegment("com.example.duo")).toBe("com_example_duo");
		expect(sanitizeToolNameSegment("github/search issues")).toBe("github_search_issues");
	});

	test("falls back to a placeholder when nothing usable remains", () => {
		expect(sanitizeToolNameSegment("")).toBe("unknown");
		expect(sanitizeToolNameSegment("...")).toBe("unknown");
		expect(sanitizeToolNameSegment("😀")).toBe("unknown");
	});

	test("keeps already-safe segments byte-identical", () => {
		expect(sanitizeToolNameSegment("search_issues-v2")).toBe("search_issues-v2");
	});
});

describe("normalizeToolName", () => {
	test("returns valid names untouched so history keeps matching", () => {
		expect(normalizeToolName("Bash")).toBe("Bash");
		expect(normalizeToolName("mcp__gh__search_issues")).toBe("mcp__gh__search_issues");
	});

	test("produces a provider-valid name for every dynamic input shape", () => {
		for (const raw of [
			"mcp__gh__github.search_issues",
			"plugin__com.example.duo__echo",
			"mcp__srv__ns:tool/name",
			`plugin__${"x".repeat(80)}__handler`,
		]) {
			const normalized = normalizeToolName(raw);
			expect(TOOL_NAME_PATTERN.test(normalized)).toBe(true);
			expect(normalized.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
			expect(isValidToolName(normalized)).toBe(true);
		}
	});

	test("keeps over-long names distinct via a deterministic digest suffix", () => {
		const a = normalizeToolName(`plugin__${"a".repeat(90)}__one`);
		const b = normalizeToolName(`plugin__${"a".repeat(90)}__two`);
		expect(a).not.toBe(b);
		// Same input must always yield the same wire name, or history would break.
		expect(normalizeToolName(`plugin__${"a".repeat(90)}__one`)).toBe(a);
	});
});
