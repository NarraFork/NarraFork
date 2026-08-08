/**
 * parse-unified-diff.test.ts — Contract for patch → `DiffLine[]`.
 *
 * The load-bearing case is the FIRST one: `--- a/x` and `+++ b/x` share their
 * first character with a removal and an addition, so a parser that tests for
 * content before headers labels the whole patch header as a change. The second
 * case guards the opposite mistake — matching so broadly that a real `-` or `--`
 * row is swallowed as a header.
 */

import { describe, expect, it } from "bun:test";
import { MAX_DIFF_LINES } from "./diff-core";
import { parseUnifiedDiff } from "./parse-unified-diff";

const shape = (patch: string) => parseUnifiedDiff(patch).lines.map((l) => [l.type, l.content]);

const PATCH = [
	"diff --git a/src/auth.ts b/src/auth.ts",
	"index 8a1f2c3..b4d5e6f 100644",
	"--- a/src/auth.ts",
	"+++ b/src/auth.ts",
	"@@ -12,7 +12,8 @@ export function login(u, p) {",
	"   const user = findUser(u);",
	"-  if (user.pass === p) {",
	"+  if (verifyHash(user.pass, p)) {",
	"+    audit.record(user.id);",
	"     return issueToken(user);",
	"   }",
].join("\n");

describe("parseUnifiedDiff — header vs content", () => {
	it("does not mistake the file header for removed/added rows", () => {
		const rows = shape(PATCH);
		// No row may carry the header text as content.
		expect(rows.some(([, content]) => String(content).includes("a/src/auth.ts"))).toBe(false);
		expect(rows.some(([, content]) => String(content).includes("b/src/auth.ts"))).toBe(false);
		// Exactly one removal and two additions came from the hunk body.
		expect(rows.filter(([type]) => type === "removed")).toHaveLength(1);
		expect(rows.filter(([type]) => type === "added")).toHaveLength(2);
	});

	it("still treats a lone dash and a double dash as removals", () => {
		// `--` here is real code (e.g. a decrement or a CLI flag), not a header.
		const patch = ["@@ -1,2 +1,1 @@", "-", "--", " kept"].join("\n");
		expect(shape(patch)).toEqual([
			["removed", ""],
			["removed", "-"],
			["context", "kept"],
		]);
	});

	it("skips index/mode/rename metadata", () => {
		const patch = [
			"diff --git a/a b/b",
			"old mode 100644",
			"new mode 100755",
			"similarity index 95%",
			"rename from a",
			"rename to b",
			"index 1111111..2222222 100755",
			"@@ -1,1 +1,1 @@",
			"-x",
			"+y",
		].join("\n");
		expect(shape(patch)).toEqual([
			["removed", "x"],
			["added", "y"],
		]);
	});
});

describe("parseUnifiedDiff — line numbers", () => {
	it("takes real file line numbers from the hunk header", () => {
		const { lines } = parseUnifiedDiff(PATCH);
		expect(lines.map((l) => [l.type, l.oldLineNo, l.newLineNo])).toEqual([
			["context", 12, 12],
			["removed", 13, undefined],
			["added", undefined, 13],
			["added", undefined, 14],
			["context", 14, 15],
			["context", 15, 16],
		]);
	});

	it("resets numbering at each hunk so gaps are visible", () => {
		const patch = ["@@ -1,1 +1,1 @@", "-a", "+A", "@@ -50,1 +50,1 @@", "-b", "+B"].join("\n");
		const { lines } = parseUnifiedDiff(patch);
		expect(lines.map((l) => l.oldLineNo ?? l.newLineNo)).toEqual([1, 1, 50, 50]);
	});
});

describe("parseUnifiedDiff — word changes", () => {
	it("emits removals before additions and word-diffs the pairs", () => {
		const { lines } = parseUnifiedDiff(PATCH);
		expect(lines.map((l) => l.type)).toEqual([
			"context",
			"removed",
			"added",
			"added",
			"context",
			"context",
		]);
		// The paired removal/addition carry intra-line marking.
		expect(lines[1]?.wordChanges).toBeDefined();
		expect(lines[2]?.wordChanges).toBeDefined();
		// The unpaired pure addition has nothing to compare against.
		expect(lines[3]?.wordChanges).toBeUndefined();
	});

	it("leaves an unpaired remainder as plain rows", () => {
		const patch = ["@@ -1,3 +1,1 @@", "-a", "-b", "-c", "+A"].join("\n");
		const { lines } = parseUnifiedDiff(patch);
		expect(lines.map((l) => l.type)).toEqual(["removed", "removed", "removed", "added"]);
		expect(lines[0]?.wordChanges).toBeDefined();
		expect(lines[1]?.wordChanges).toBeUndefined();
		expect(lines[2]?.wordChanges).toBeUndefined();
	});
});

describe("parseUnifiedDiff — special rows", () => {
	it("skips the no-newline marker", () => {
		const patch = ["@@ -1,1 +1,1 @@", "-a", "\\ No newline at end of file", "+b"].join("\n");
		expect(shape(patch)).toEqual([
			["removed", "a"],
			["added", "b"],
		]);
	});

	it("keeps an unchanged blank line as context", () => {
		// git prints an unchanged empty line as a single space, but a trailing
		// newline can also yield a bare "".
		const patch = ["@@ -1,3 +1,3 @@", " a", " ", " b"].join("\n");
		expect(shape(patch)).toEqual([
			["context", "a"],
			["context", ""],
			["context", "b"],
		]);
	});

	it("flags a binary patch and emits no rows", () => {
		const patch = [
			"diff --git a/img.png b/img.png",
			"index 111..222 100644",
			"Binary files a/img.png and b/img.png differ",
		].join("\n");
		const result = parseUnifiedDiff(patch);
		expect(result.binary).toBe(true);
		expect(result.lines).toHaveLength(0);
	});
});

describe("parseUnifiedDiff — bounds", () => {
	it("stops at the second file and reports it", () => {
		const patch = [
			"diff --git a/one b/one",
			"@@ -1,1 +1,1 @@",
			"-one",
			"diff --git a/two b/two",
			"@@ -1,1 +1,1 @@",
			"-two",
		].join("\n");
		const result = parseUnifiedDiff(patch);
		expect(result.multiFile).toBe(true);
		expect(shape(patch)).toEqual([["removed", "one"]]);
	});

	it("caps rows at MAX_DIFF_LINES and reports truncation", () => {
		const body = Array.from({ length: MAX_DIFF_LINES + 50 }, (_, i) => ` line${i}`);
		const patch = [`@@ -1,${body.length} +1,${body.length} @@`, ...body].join("\n");
		const result = parseUnifiedDiff(patch);
		expect(result.lines).toHaveLength(MAX_DIFF_LINES);
		expect(result.truncated).toBe(true);
	});

	it("handles an empty patch and a metadata-only patch without throwing", () => {
		expect(parseUnifiedDiff("")).toEqual({
			lines: [],
			truncated: false,
			binary: false,
			multiFile: false,
		});
		const metaOnly = ["diff --git a/x b/x", "index 111..222 100644"].join("\n");
		expect(parseUnifiedDiff(metaOnly).lines).toHaveLength(0);
	});
});
