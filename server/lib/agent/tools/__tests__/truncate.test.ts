import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { MAX_BYTES, MAX_LINES, truncateOutput } from "../../truncate";

// ============================================================
// truncateOutput — dual limits + file persistence
// ============================================================

describe("truncateOutput", () => {
	test("returns content unchanged when within limits", () => {
		const text = "line one\nline two\nline three";
		const result = truncateOutput(text);
		expect(result.truncated).toBe(false);
		expect(result.content).toBe(text);
		expect(result.outputPath).toBeUndefined();
	});

	test("truncates when line count exceeds MAX_LINES", () => {
		const lines = Array.from({ length: MAX_LINES + 500 }, (_, i) => `line ${i}`);
		const text = lines.join("\n");
		const result = truncateOutput(text);

		expect(result.truncated).toBe(true);
		expect(result.outputPath).toBeDefined();
		expect(result.content).toContain("truncated");
		expect(result.content).toContain("Read with offset/limit");

		// The kept portion should not exceed MAX_LINES lines (allow +1 for split boundary)
		const previewPart = result.content.split("\n...")[0];
		const previewLines = previewPart.split("\n").length;
		expect(previewLines).toBeLessThanOrEqual(MAX_LINES + 1);
	});

	test("truncates when byte size exceeds MAX_BYTES", () => {
		// Create a small number of very long lines
		const longLine = "x".repeat(10_000);
		const lines = Array.from({ length: 20 }, () => longLine);
		const text = lines.join("\n");
		expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(MAX_BYTES);

		const result = truncateOutput(text);
		expect(result.truncated).toBe(true);
		expect(result.outputPath).toBeDefined();
		expect(result.content).toContain("bytes truncated");
	});

	test("persists full output to a file when truncated", () => {
		const lines = Array.from({ length: MAX_LINES + 100 }, (_, i) => `persisted line ${i}`);
		const text = lines.join("\n");
		const result = truncateOutput(text);

		expect(result.truncated).toBe(true);
		expect(result.outputPath).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: guarded by toBeDefined above
		expect(existsSync(result.outputPath!)).toBe(true);

		// biome-ignore lint/style/noNonNullAssertion: guarded by toBeDefined above
		const saved = readFileSync(result.outputPath!, "utf-8");
		expect(saved).toBe(text);
	});

	test("respects custom maxLines option", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
		const text = lines.join("\n");

		const result = truncateOutput(text, { maxLines: 10 });
		expect(result.truncated).toBe(true);
		expect(result.content).toContain("truncated");
	});

	test("respects custom maxBytes option", () => {
		const text = "a".repeat(2000);
		const result = truncateOutput(text, { maxBytes: 500 });
		expect(result.truncated).toBe(true);
		expect(result.content).toContain("bytes truncated");
	});

	test("does not truncate when exactly at limits", () => {
		// Exactly MAX_LINES lines, each short enough to stay under MAX_BYTES
		const lines = Array.from({ length: MAX_LINES }, (_, i) => `${i}`);
		const text = lines.join("\n");
		// Only test if total bytes are within limit
		if (Buffer.byteLength(text, "utf-8") <= MAX_BYTES) {
			const result = truncateOutput(text);
			expect(result.truncated).toBe(false);
		}
	});

	test("empty string is not truncated", () => {
		const result = truncateOutput("");
		expect(result.truncated).toBe(false);
		expect(result.content).toBe("");
	});

	test("single line within byte limit is not truncated", () => {
		const result = truncateOutput("hello world");
		expect(result.truncated).toBe(false);
		expect(result.content).toBe("hello world");
	});

	test("keeps partial first line when single line exceeds MAX_BYTES", () => {
		// Simulate a minified file: one huge line
		const hugeLine = "x".repeat(MAX_BYTES * 3);
		const result = truncateOutput(hugeLine);

		expect(result.truncated).toBe(true);
		expect(result.outputPath).toBeDefined();
		// The preview should contain some content, not be empty
		const previewPart = result.content.split("\n\n...")[0];
		expect(previewPart.length).toBeGreaterThan(0);
		expect(previewPart).toContain("…[line truncated,");
		expect(previewPart).toContain(`${hugeLine.length} chars total`);
	});

	test("keeps partial first line for multi-line file where first line exceeds MAX_BYTES", () => {
		// e.g. a file with a very long first line followed by short lines
		const longFirst = "y".repeat(MAX_BYTES * 2);
		const text = `${longFirst}\nshort line 2\nshort line 3`;
		const result = truncateOutput(text);

		expect(result.truncated).toBe(true);
		const previewPart = result.content.split("\n\n...")[0];
		expect(previewPart.length).toBeGreaterThan(0);
		expect(previewPart).toContain("…[line truncated,");
	});

	test("output path contains narrafork-tool-output directory", () => {
		const lines = Array.from({ length: MAX_LINES + 10 }, (_, i) => `x${i}`);
		const result = truncateOutput(lines.join("\n"));
		expect(result.outputPath).toContain("narrafork-tool-output");
	});
});
