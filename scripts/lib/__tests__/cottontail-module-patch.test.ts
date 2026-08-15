import { describe, expect, test } from "bun:test";
import {
	applyTrailingNewline,
	hasStaticImport,
	isPatchableFile,
	needsTrailingNewline,
	shouldScanDirectory,
} from "../cottontail-module-patch";

describe("needsTrailingNewline", () => {
	// These four cases are the minimal reproduction that isolated the Cottontail 0.2.3 bug.
	// Only the first combination actually fails to load, so only it may be rewritten.
	test("flags a static import ending in a comment with no trailing newline", () => {
		expect(needsTrailingNewline('import { a } from "./a.js";\nconst x = a;\n// tail')).toBe(true);
	});

	test("leaves a file that already ends in a newline alone", () => {
		expect(needsTrailingNewline('import { a } from "./a.js";\nconst x = a;\n// tail\n')).toBe(
			false,
		);
	});

	test("leaves a file without a static import alone", () => {
		expect(needsTrailingNewline("const x = 1;\n//# sourceMappingURL=x.map")).toBe(false);
	});

	test("leaves a dynamic import alone", () => {
		// Dynamic import() does not route through the async module wrapper.
		expect(needsTrailingNewline('const a = await import("./a.js");\n// tail')).toBe(false);
	});

	test("flags the real esbuild sourceMappingURL shape", () => {
		const source =
			'import { entityKind } from "./entity.js";\nexport {};\n//# sourceMappingURL=errors.js.map';
		expect(needsTrailingNewline(source)).toBe(true);
	});

	test("ignores a file whose last line is code rather than a comment", () => {
		expect(needsTrailingNewline('import a from "./a.js";\nexport default a;')).toBe(false);
	});

	test("ignores a block comment terminator, which cannot swallow the wrapper", () => {
		expect(needsTrailingNewline('import a from "./a.js";\n/* trailing */')).toBe(false);
	});

	test("handles an empty file", () => {
		expect(needsTrailingNewline("")).toBe(false);
	});

	test("respects indentation before the trailing comment", () => {
		expect(needsTrailingNewline('import a from "./a.js";\n  // indented tail')).toBe(true);
	});
});

describe("hasStaticImport", () => {
	test.each([
		['import "./side-effect.js";', "bare specifier"],
		['import a from "./a.js";', "default import"],
		['import { a } from "./a.js";', "named import"],
		['import * as ns from "./a.js";', "namespace import"],
		['const x = 1;\nimport { a } from "./a.js";', "import on a later line"],
		['\timport { a } from "./a.js";', "indented import"],
	])("detects %s (%s)", (source) => {
		expect(hasStaticImport(source)).toBe(true);
	});

	test.each([
		['const a = await import("./a.js");', "dynamic import"],
		["const url = import.meta.url;", "import.meta"],
		['const s = "import a from x";', "the word inside a string"],
		["const important = 1;", "an identifier with the prefix"],
	])("does not treat %s as a static import (%s)", (source) => {
		expect(hasStaticImport(source)).toBe(false);
	});
});

describe("applyTrailingNewline", () => {
	test("appends exactly one newline when required", () => {
		expect(applyTrailingNewline('import a from "./a.js";\n// tail')).toBe(
			'import a from "./a.js";\n// tail\n',
		);
	});

	test("is idempotent", () => {
		const once = applyTrailingNewline('import a from "./a.js";\n// tail');
		expect(applyTrailingNewline(once)).toBe(once);
	});

	test("returns unaffected sources byte-for-byte", () => {
		const source = "const x = 1;\n// tail";
		expect(applyTrailingNewline(source)).toBe(source);
	});
});

describe("scan filters", () => {
	test.each([".js", ".mjs", ".cjs"])("treats %s as patchable", (ext) => {
		expect(isPatchableFile(`/pkg/index${ext}`)).toBe(true);
	});

	test.each([".ts", ".json", ".map", ".node", ".d.ts"])("skips %s", (ext) => {
		expect(isPatchableFile(`/pkg/index${ext}`)).toBe(false);
	});

	test("skips vcs and cache directories", () => {
		expect(shouldScanDirectory(".git")).toBe(false);
		expect(shouldScanDirectory(".cache")).toBe(false);
		expect(shouldScanDirectory("drizzle-orm")).toBe(true);
	});
});
