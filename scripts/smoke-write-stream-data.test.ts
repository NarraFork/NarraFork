import { describe, expect, test } from "bun:test";
import { percentile, writeStreamText } from "./smoke-write-stream-data";

describe("Write streaming smoke corpus", () => {
	for (const singleLine of [false, true]) {
		for (const chars of [10_000, 30_000, 100_000, 1024 * 1024]) {
			test(`${singleLine ? "single" : "multi"} ${chars}: exact deterministic UTF-16 length`, () => {
				const options = { chars, singleLine, crlf: true };
				const text = writeStreamText(options);
				expect(text.length).toBe(chars);
				expect(text).toBe(writeStreamText(options));
				expect(text).toContain("中文");
				expect(text).toContain("😀");
				expect(text.includes("\r\n")).toBe(!singleLine);
				expect(text).toContain("enabled: true");
			});
		}
	}
	test("percentiles do not mutate observations and handle an empty run", () => {
		const observed = [50, 1, 2, 3, 4];
		expect(percentile(observed, 0.95)).toBe(4);
		expect(percentile(observed, 1)).toBe(50);
		expect(percentile([], 0.95)).toBe(0);
		expect(observed).toEqual([50, 1, 2, 3, 4]);
	});
});
