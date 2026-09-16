/**
 * `mode=usages` at the tool level — cross-file references.
 *
 * The classification (text-only exclusion, ordering) is unit-tested in
 * cross-file-usages.test.ts. This file checks the wiring: the ripgrep prefilter finds
 * candidate files, the parser stage keeps real identifier lines and drops comment-only
 * matches, the current file is excluded, and the precision caveat is always present — a
 * result that read as authoritative would be dangerous, since it is not.
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

// A small project: `target` is declared in def.ts, used as an identifier in user.ts,
// mentioned only inside a comment in comment.ts, and unrelated in other.ts.
const workDir = mkdtempSync(join(tmpdir(), "usages-tool-"));
writeFileSync(join(workDir, "def.ts"), "export function target() {\n\treturn 1;\n}\n", "utf8");
writeFileSync(
	join(workDir, "user.ts"),
	'import { target } from "./def";\n\nexport function caller() {\n\treturn target() + target();\n}\n',
	"utf8",
);
writeFileSync(
	join(workDir, "comment.ts"),
	"// target is described here but not called\nexport const x = 1;\n",
	"utf8",
);
writeFileSync(join(workDir, "other.ts"), "export const unrelated = 2;\n", "utf8");

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

describeWithGrammar("usages mode", () => {
	test("finds the file that references the symbol as an identifier", async () => {
		const r = await run({ file_path: "def.ts", mode: "usages", symbol: "target" });
		expect(r.isError).toBeFalsy();
		expect(r.output).toContain("user.ts");
		// Both call sites are on the same line, deduped to one position.
		expect(r.output).toMatch(/user\.ts.*L4/);
	});

	test("excludes a file that only mentions the name in a comment", async () => {
		const r = await run({ file_path: "def.ts", mode: "usages", symbol: "target" });
		// comment.ts matched ripgrep but has no real identifier, so it must not be listed.
		expect(r.output).not.toMatch(/ {2}comment\.ts {2}\(/);
		// It is accounted for, not silently dropped.
		expect(r.output).toMatch(/comments\/strings/);
	});

	test("excludes the file being inspected", async () => {
		// def.ts declares target; usages answers "who ELSE uses it".
		const r = await run({ file_path: "def.ts", mode: "usages", symbol: "target" });
		expect(r.output).not.toMatch(/ {2}def\.ts {2}\(/);
	});

	test("always states the structural-not-semantic caveat", async () => {
		const r = await run({ file_path: "def.ts", mode: "usages", symbol: "target" });
		expect(r.output).toMatch(/same name/i);
		expect(r.output).toMatch(/alias/i);
	});

	test("reports the file count in metadata", async () => {
		const r = await run({ file_path: "def.ts", mode: "usages", symbol: "target" });
		expect(r.metadata?.mode).toBe("usages");
		expect(r.metadata?.files).toBe(1);
	});

	test("a symbol used nowhere else says so, and still gives the caveat", async () => {
		writeFileSync(
			join(workDir, "lonely.ts"),
			"export function lonelyFn() {\n\treturn 0;\n}\n",
			"utf8",
		);
		const r = await run({ file_path: "lonely.ts", mode: "usages", symbol: "lonelyFn" });
		expect(r.isError).toBeFalsy();
		expect(r.output).toMatch(/No cross-file identifier usages found/);
		expect(r.output).toMatch(/same name/i);
	});

	test("separates files that import the symbol from files that merely share the name", async () => {
		// The distinction is the point: a rename must touch the importer and must NOT touch
		// the unrelated local declaration, and a flat list cannot express that.
		writeFileSync(join(workDir, "shadow.ts"), "function target() {\n\treturn 9;\n}\n", "utf8");
		const r = await run({ file_path: "def.ts", mode: "usages", symbol: "target" });
		expect(r.isError).toBeFalsy();
		expect(r.output).toContain("confirmed");
		expect(r.output).toContain("unverified");
		const confirmedAt = r.output.indexOf("confirmed");
		const unverifiedAt = r.output.indexOf("unverified —");
		// user.ts imports it; shadow.ts declares its own.
		expect(r.output.indexOf("user.ts")).toBeGreaterThan(confirmedAt);
		expect(r.output.indexOf("user.ts")).toBeLessThan(unverifiedAt);
		expect(r.output.indexOf("shadow.ts")).toBeGreaterThan(unverifiedAt);
	});

	test("follows an aliased import to the local name it was renamed to", async () => {
		// This was the documented blind spot: `import { target as renamed }` meant every
		// usage in the file was invisible, because the original name never appears in it.
		writeFileSync(
			join(workDir, "renamer.ts"),
			'import { target as renamed } from "./def";\n\nexport const v = renamed() + renamed();\n',
			"utf8",
		);
		const r = await run({ file_path: "def.ts", mode: "usages", symbol: "target" });
		expect(r.output).toContain("renamer.ts");
		expect(r.output).toContain("imported as renamed");
		// The alias's own lines are reported, not an empty list.
		expect(r.output).toMatch(/renamer\.ts {2}\([1-9]/);
	});

	test("follows a barrel re-export one hop and names the barrel", async () => {
		// The reported "fatal" defect: importing through an index.ts — the normal style in
		// most codebases — made every such usage unverifiable, which left the whole
		// confirmed/unverified split close to useless.
		writeFileSync(join(workDir, "barrel.ts"), 'export { target } from "./def";\n', "utf8");
		writeFileSync(
			join(workDir, "viaBarrel.ts"),
			'import { target } from "./barrel";\n\nexport const b = target();\n',
			"utf8",
		);
		const r = await run({ file_path: "def.ts", mode: "usages", symbol: "target" });
		const confirmed = r.output.slice(r.output.indexOf("confirmed"), r.output.indexOf("unverified"));
		expect(confirmed).toContain("viaBarrel.ts");
		// The barrel is named because a rename may belong there, not at the use site.
		expect(confirmed).toContain("[via ./barrel]");
	});

	test("a star re-export also forwards the symbol", async () => {
		// `export * from` forwards everything by definition, so it needs no name check.
		writeFileSync(join(workDir, "starBarrel.ts"), 'export * from "./def";\n', "utf8");
		writeFileSync(
			join(workDir, "viaStar.ts"),
			'import { target } from "./starBarrel";\n\nexport const s = target();\n',
			"utf8",
		);
		const r = await run({ file_path: "def.ts", mode: "usages", symbol: "target" });
		const confirmed = r.output.slice(r.output.indexOf("confirmed"), r.output.indexOf("unverified"));
		expect(confirmed).toContain("viaStar.ts");
	});

	test("two hops stay unverified rather than being claimed as resolved", async () => {
		// The declared boundary: a second hop costs another read per candidate. Reporting it
		// as confirmed would overstate what was actually checked.
		writeFileSync(join(workDir, "hop1.ts"), 'export { target } from "./def";\n', "utf8");
		writeFileSync(join(workDir, "hop2.ts"), 'export { target } from "./hop1";\n', "utf8");
		writeFileSync(
			join(workDir, "viaTwoHops.ts"),
			'import { target } from "./hop2";\n\nexport const t = target();\n',
			"utf8",
		);
		const r = await run({ file_path: "def.ts", mode: "usages", symbol: "target" });
		const unverified = r.output.slice(r.output.indexOf("unverified —"));
		expect(unverified).toContain("viaTwoHops.ts");
		// And the caveat has to say the limit out loud.
		expect(r.output).toContain("ONE barrel re-export");
	});

	test("the barrel itself is not counted as a user of the symbol", async () => {
		// It forwards the name without using it; listing it as a usage would inflate the
		// count a rename has to reckon with.
		writeFileSync(join(workDir, "pure-barrel.ts"), 'export { target } from "./def";\n', "utf8");
		const r = await run({ file_path: "def.ts", mode: "usages", symbol: "target" });
		const confirmed = r.output.slice(r.output.indexOf("confirmed"), r.output.indexOf("unverified"));
		expect(confirmed).not.toContain("pure-barrel.ts");
	});

	test("missing symbol is a clear error, not an empty scan", async () => {
		const r = await run({ file_path: "def.ts", mode: "usages" });
		expect(r.isError).toBe(true);
		expect(r.output).toMatch(/needs a `symbol`/);
	});
});
