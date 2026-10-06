/**
 * `mode=interface` at the tool level.
 *
 * The classification logic is unit-tested in extraction-interface.test.ts; this file checks
 * the wiring end to end on a real parse — that a symbol or an address resolves to a range,
 * that the three groups reach the output, and that a range splitting a declaration is
 * called out rather than analysed as if it were a clean seam.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGrammarFixture } from "../../structural/__tests__/grammar-fixture";
import type { ToolContext } from "../../types";
import { structViewTool } from "../struct-view";

const hasTypescript = await ensureGrammarFixture("typescript");
const describeWithGrammar = hasTypescript ? describe : describe.skip;

// The extraction range is L7-14 (region + exported), chosen so each group is populated:
//   outerConst — declared L5, OUTSIDE the range, used inside      → needs input
//   exported   — declared L12 INSIDE the range, called at L2 too  → needs export
//   priv       — declared and used only inside                    → self-contained
const SOURCE = `function consumer() {
	return exported();
}

const outerConst = 1;

function region() {
	const priv = outerConst;
	return priv + exported();
}

function exported() {
	return 2;
}
`;

const workDir = mkdtempSync(join(tmpdir(), "interface-tool-"));

function write(name: string, content: string): string {
	writeFileSync(join(workDir, name), content, "utf8");
	return name;
}

function ctx(): ToolContext {
	return {
		narratorId: "test",
		cwd: workDir,
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" }),
	} as unknown as ToolContext;
}

async function run(args: Record<string, unknown>) {
	return structViewTool.execute(args, ctx());
}

describeWithGrammar("interface mode", () => {
	test("classifies boundary crossings across a multi-declaration range", async () => {
		// L7-14 covers `region` and `exported`. `outerConst` enters from L5, and
		// `exported` is called from `consumer` at L2 — outside the range.
		const file = write("sample.ts", SOURCE);
		const r = await run({ file_path: file, mode: "interface", address: "7,14" });
		expect(r.isError).toBeFalsy();
		expect(r.output).toMatch(/NEEDS INPUT[\s\S]*outerConst/);
		expect(r.output).toMatch(/NEEDS EXPORT[\s\S]*exported/);
	});

		// A flat NEEDS INPUT list mixed language globals, imports and this file's own
		// declarations, so the row that actually signals a bad seam was easy to miss.
		test("splits NEEDS INPUT by what each name actually requires", async () => {
			const file = write(
				"classified.ts",
				'import { helper } from "./helper";\n' +
					"const outerConst = 1;\n" +
					"function region() {\n" +
					"	const seen = new Map();\n" +
					"	return helper(outerConst) + seen.size;\n" +
					"}\n",
			);
			const r = await run({ file_path: file, mode: "interface", symbol: "region" });
			expect(r.isError).toBeFalsy();

			// Declared in this file but outside the range — the signal that the seam is wrong.
			expect(r.output).toMatch(/NEEDS INPUT · declared in this file[\s\S]*outerConst/);
			// Arrives by import: the new file needs the same import, nothing more.
			expect(r.output).toMatch(/NEEDS INPUT · imported[\s\S]*helper/);
			// `Map` is neither declared here nor imported, so it lands in ambient.
			expect(r.output).toMatch(/NEEDS INPUT · ambient[\s\S]*Map/);
			// An import must not also appear under "declared in this file": that would send the
			// reader looking for a declaration this file does not contain. Checked on the group's
			// own line rather than across the whole report, which any loose pattern would match.
			const declaredGroup = r.output
				.split("NEEDS INPUT · declared in this file")[1]
				?.split("NEEDS EXPORT")[0];
			expect(declaredGroup).toBeDefined();
			expect(declaredGroup).toContain("outerConst");
			expect(declaredGroup).not.toContain("helper");
		});

	test("accepts a line-range address", async () => {
		const file = write("sample.ts", SOURCE);
		const r = await run({ file_path: file, mode: "interface", address: "7,14" });
		expect(r.isError).toBeFalsy();
		expect(r.metadata?.mode).toBe("interface");
		expect(r.metadata?.startLine).toBe(7);
		expect(r.metadata?.endLine).toBe(14);
	});

	test("reports a clean seam when nothing escapes the range", async () => {
		// A whole self-contained function has no external dependents.
		const clean = write(
			"clean.ts",
			"function standalone() {\n\tconst x = 1;\n\treturn x + x;\n}\n",
		);
		const r = await run({ file_path: clean, mode: "interface", symbol: "standalone" });
		expect(r.output).toMatch(/Clean seam/);
		expect(r.metadata?.needsExport).toBe(0);
	});

	test("flags a range that splits a declaration in half", async () => {
		const file = write("sample.ts", SOURCE);
		// Lines 8-12 start inside `region` (opens L7) and end inside `exported` (opens L12).
		const r = await run({ file_path: file, mode: "interface", address: "8,12" });
		expect(r.output).toMatch(/SPLITS \d+ DECLARATION/);
		expect(r.output).toMatch(/Not extractable as given/);
		expect(r.metadata?.straddling).toBeGreaterThan(0);
	});

	test("symbol and address together is refused rather than guessed", async () => {
		const file = write("sample.ts", SOURCE);
		const r = await run({
			file_path: file,
			mode: "interface",
			symbol: "region",
			address: "7,14",
		});
		expect(r.isError).toBe(true);
		expect(r.output).toMatch(/not both/i);
	});

	test("neither symbol nor address explains what is needed", async () => {
		const file = write("sample.ts", SOURCE);
		const r = await run({ file_path: file, mode: "interface" });
		expect(r.isError).toBe(true);
		expect(r.output).toMatch(/needs a range/i);
	});

	test("an unknown symbol reports rather than analysing an empty range", async () => {
		const file = write("sample.ts", SOURCE);
		const r = await run({ file_path: file, mode: "interface", symbol: "nope" });
		expect(r.isError).toBe(true);
		expect(r.output).toMatch(/No symbol matching/);
	});

	test("states the single-file, name-based caveat", async () => {
		const file = write("sample.ts", SOURCE);
		const r = await run({ file_path: file, mode: "interface", symbol: "region" });
		expect(r.output).toMatch(/cross-file usage is invisible/i);
	});

	test("counts the whole declarations moving in metadata", async () => {
		const file = write("sample.ts", SOURCE);
		const r = await run({ file_path: file, mode: "interface", symbol: "region" });
		expect(typeof r.metadata?.selfContained).toBe("number");
	});
});
