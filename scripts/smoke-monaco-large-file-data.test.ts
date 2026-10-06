import { describe, expect, test } from "bun:test";
import { createFixture, MiB, matrix } from "./smoke-monaco-large-file-data";

describe("Monaco benchmark source fixtures", () => {
	for (const spec of matrix) {
		test(`${spec.id} retains capacity and oracle alignment`, () => {
			const fixture = createFixture(spec);
			const bytes = Buffer.byteLength(fixture.content);
			if (spec.lines) {
				expect(fixture.content.split("\n")).toHaveLength(spec.lines);
				expect(bytes).toBeLessThanOrEqual(20 * MiB);
			} else expect(bytes).toBe(spec.bytes);
			if (spec.longLine) {
				expect(fixture.content.split("\n")).toHaveLength(1);
				expect(fixture.content.endsWith('";')).toBe(true);
			} else {
				expect(fixture.content).toContain("中文");
				expect(fixture.content).toContain("😀");
				const rows = fixture.content.split("\n");
				for (const block of [0, Math.floor(fixture.blockCount / 2), fixture.blockCount - 1]) {
					const index = fixture.firstLine - 1 + block * fixture.blockLines;
					expect(`${rows.slice(index, index + fixture.blockLines).join("\n")}\n`).toBe(
						fixture.block,
					);
				}
				if (spec.language === "json") expect(Array.isArray(JSON.parse(fixture.content))).toBe(true);
			}
		});
	}
});
