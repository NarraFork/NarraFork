import { describe, expect, test } from "bun:test";
import { stripErrorDisplayPrefix } from "../retry-rule-keyword";

describe("stripErrorDisplayPrefix", () => {
	test("strips the loop's Error: display prefix", () => {
		expect(stripErrorDisplayPrefix("Error: stream error: stream ID 71")).toBe(
			"stream error: stream ID 71",
		);
	});

	test("strips the persisted [Error] prefix", () => {
		expect(stripErrorDisplayPrefix("[Error] all credentials exhausted")).toBe(
			"all credentials exhausted",
		);
	});

	test("collapses the doubly-decorated stored form", () => {
		expect(stripErrorDisplayPrefix("[Error] Error: Concurrency limit exceeded")).toBe(
			"Concurrency limit exceeded",
		);
	});

	test("is case-insensitive about the prefix", () => {
		expect(stripErrorDisplayPrefix("error: boom")).toBe("boom");
		expect(stripErrorDisplayPrefix("[ERROR] boom")).toBe("boom");
	});

	test("leaves an undecorated message untouched apart from trimming", () => {
		expect(stripErrorDisplayPrefix("  Concurrency limit exceeded  ")).toBe(
			"Concurrency limit exceeded",
		);
	});

	test("keeps a mid-string Error: intact", () => {
		expect(stripErrorDisplayPrefix("upstream said Error: nope")).toBe("upstream said Error: nope");
	});

	test("collapses a prefix-only value to empty so callers can drop the condition", () => {
		expect(stripErrorDisplayPrefix("Error:")).toBe("");
		expect(stripErrorDisplayPrefix("[Error] ")).toBe("");
		expect(stripErrorDisplayPrefix("")).toBe("");
	});
});
