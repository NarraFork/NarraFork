import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CORE_FILES = [
	"diff-core.ts",
	"element-kinds.ts",
	"engine.ts",
	"golden.ts",
	"golden-fixture.ts",
	"index.ts",
	"layout-pipeline.ts",
	"katex-geometry.ts",
	"math-delimiters.ts",
	"parse-markdown.ts",
	"reasoning-segments.ts",
	"reflection.ts",
	"segment-adapter.ts",
	"tool-detail.ts",
	"prepared-block.ts",
	"pretext-fonts.ts",
	"pretext-metrics.ts",
	"vlist-virtualization.ts",
];

describe("shared pretext core boundary", () => {
	it("does not import React/Mantine/frontend modules or call DOM measurement APIs", () => {
		for (const file of CORE_FILES) {
			const source = readFileSync(join(import.meta.dir, file), "utf8");
			expect(source).not.toMatch(/from\s+["'](?:react|react-dom|@mantine|@frontend)/);
			expect(source).not.toMatch(
				/\b(?:getBoundingClientRect|offsetHeight|offsetWidth|createElement)\s*\(/,
			);
		}
	});
});
