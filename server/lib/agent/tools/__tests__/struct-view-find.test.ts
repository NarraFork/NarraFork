/**
 * `mode=find` at the tool level — repository-wide declaration lookup.
 *
 * This is the mode that answers "which file holds this?", the question that used to
 * force a grep. The tests therefore focus on what separates it from grep: a call site
 * is not a declaration, a mention in a comment or a string is not a declaration, and a
 * declaration is reported with its kind and line so the next call can address it.
 *
 * The fixture is a small project where the same name appears in every one of those
 * roles at once, so a regression that reverts the mode to text matching fails here
 * rather than silently producing a longer, less trustworthy list.
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

const workDir = mkdtempSync(join(tmpdir(), "find-tool-"));

// `handler` is declared once as a function, once as a class method in another file,
// called in a third, and merely mentioned in a comment and a string in a fourth.
writeFileSync(
	join(workDir, "declare.ts"),
	"export function handler(): number {\n\treturn 1;\n}\n\nfunction localOnly() {\n\treturn 2;\n}\n",
	"utf8",
);
writeFileSync(
	join(workDir, "service.ts"),
	"export class Service {\n\thandler(): number {\n\t\treturn 3;\n\t}\n}\n",
	"utf8",
);
writeFileSync(
	join(workDir, "caller.ts"),
	'import { handler } from "./declare";\n\nexport const value = handler() + handler();\n',
	"utf8",
);
writeFileSync(
	join(workDir, "mentions.ts"),
	'// handler is discussed here\nexport const label = "handler";\n',
	"utf8",
);

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

describe("find mode argument handling", () => {
	test("needs no file_path, unlike every other mode", async () => {
		// The whole point of the mode: requiring a path would defeat it.
		const r = await run({ mode: "find", symbol: "handler" });
		expect(r.output).not.toContain("file_path is required");
	});

	test("a missing file_path still fails for a single-file mode", async () => {
		const r = await run({ mode: "outline" });
		expect(r.isError).toBe(true);
		expect(r.output).toContain("file_path is required");
	});

	test("asks for a symbol when none was given", async () => {
		const r = await run({ mode: "find" });
		expect(r.isError).toBe(true);
		expect(r.output).toContain("`symbol`");
	});

	test("refuses a dotted path rather than silently searching the last segment", async () => {
		// Searching `method` for a request about `Class.method` would answer a different
		// question and look successful doing it.
		const r = await run({ mode: "find", symbol: "Service.handler" });
		expect(r.isError).toBe(true);
		expect(r.output).toContain("not a plain identifier");
	});
});

describeWithGrammar("find mode results", () => {
	test("reports declarations and excludes call sites, comments and strings", async () => {
		const r = await run({ mode: "find", symbol: "handler" });
		expect(r.isError).toBeFalsy();
		// Declared as a function here, and as a method there.
		expect(r.output).toContain("declare.ts");
		expect(r.output).toContain("service.ts");
		// Call sites are not declarations; neither is a comment or a string literal.
		expect(r.output).not.toContain("caller.ts");
		expect(r.output).not.toContain("mentions.ts");
		expect(r.metadata?.declarations).toBe(2);
	});

	test("each hit carries its kind and line so it can be addressed next", async () => {
		const r = await run({ mode: "find", symbol: "handler" });
		expect(r.output).toMatch(/declare\.ts:1\b/);
		expect(r.output).toContain("function handler");
		// The method is reported under its class, not as a bare name.
		expect(r.output).toContain("Service.handler");
		expect(r.output).toContain("method");
	});

	test("paths are workspace-relative so they can be reused as file_path", async () => {
		const r = await run({ mode: "find", symbol: "handler" });
		expect(r.output).not.toContain(workDir);
	});

	test("exported declarations sort ahead of local ones", async () => {
		const r = await run({ mode: "find", symbol: "handler" });
		const exportedAt = r.output.indexOf("exported function handler");
		const methodAt = r.output.indexOf("Service.handler");
		expect(exportedAt).toBeGreaterThanOrEqual(0);
		expect(exportedAt).toBeLessThan(methodAt);
	});

	test("finds a declaration that is never exported or used elsewhere", async () => {
		const r = await run({ mode: "find", symbol: "localOnly" });
		expect(r.isError).toBeFalsy();
		expect(r.output).toContain("declare.ts");
		expect(r.metadata?.declarations).toBe(1);
	});

	test("a name with no declaration says so and points at usages", async () => {
		const r = await run({ mode: "find", symbol: "neverDeclaredAnywhere" });
		expect(r.isError).toBeFalsy();
		expect(r.output).toContain("No declaration");
		expect(r.output).toContain("usages");
		expect(r.metadata?.declarations).toBe(0);
	});

	test("always states that matching is name-based, never semantic", async () => {
		// Two unrelated declarations sharing a name are both listed; a caller who reads
		// this as resolved identity would rename the wrong one.
		const r = await run({ mode: "find", symbol: "handler" });
		expect(r.output).toMatch(/name-based/i);
		expect(r.metadata?.precision).toBe("structural");
	});
});
