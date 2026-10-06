/**
 * Dead-code candidate filtering in `mode=report`.
 *
 * Two false positives motivated this, both from a real session's report on NarratorPanel:
 *
 * 1. `export function NarratorPanel` appeared under "possibly dead" while being the
 *    component's only entry point. An exported symbol's callers are in OTHER files by
 *    definition, so listing it is a category error rather than mere noise.
 * 2. `_getMessageViewportDistanceFromBottom` and three siblings appeared alongside it.
 *    The underscore prefix is the author saying "kept on purpose" — but a convention is
 *    not proof, so these move to their own group instead of vanishing.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { structViewTool } from "../../tools/struct-view";
import type { ToolContext } from "../../types";
import { ensureGrammarFixture } from "./grammar-fixture";

const hasTypescript = await ensureGrammarFixture("typescript");
const describeWithGrammar = hasTypescript ? describe : describe.skip;

/**
 * `helper` is referenced once (its definition) and not exported → a real candidate.
 * `PublicThing` is exported and referenced once → must NOT be a candidate.
 * `_deliberate` is underscore-prefixed → its own group.
 * `used` is referenced twice → in neither list.
 */
const SOURCE = `export function PublicThing() {
	return used();
}

function helper() {
	return 1;
}

function _deliberate() {
	return 2;
}

function used() {
	return 3;
}
`;

let workDir: string;
let file: string;

function ctx(): ToolContext {
	return {
		narratorId: "test",
		cwd: workDir,
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" }),
	} as unknown as ToolContext;
}

async function report(): Promise<string> {
	workDir ??= mkdtempSync(join(tmpdir(), "dead-code-"));
	file = join(workDir, "sample.ts");
	writeFileSync(file, SOURCE, "utf8");
	const result = await structViewTool.execute({ file_path: "sample.ts", mode: "report" }, ctx());
	return result.output;
}

describeWithGrammar("dead-code candidates", () => {
	test("a non-exported single-reference symbol is listed", async () => {
		const out = await report();
		const section = out.split("SINGLE-REFERENCE SYMBOLS")[1]?.split("\n\n")[0] ?? "";
		expect(section).toContain("helper");
	});

	test("an exported symbol is NOT listed as possibly dead", async () => {
		const out = await report();
		const section = out.split("SINGLE-REFERENCE SYMBOLS")[1]?.split("\n\n")[0] ?? "";
		expect(section).not.toContain("PublicThing");
	});

	test("the excluded exports are accounted for rather than silently dropped", async () => {
		// Saying nothing would leave the reader unable to tell whether the list was empty
		// because the file is clean or because everything got filtered.
		const out = await report();
		expect(out).toMatch(/exported symbol\(s\) referenced once here were excluded/);
	});

	test("an underscore-prefixed symbol goes to its own group", async () => {
		const out = await report();
		expect(out).toContain("INTENTIONALLY KEPT");
		const kept = out.split("INTENTIONALLY KEPT")[1]?.split("\n\n")[0] ?? "";
		expect(kept).toContain("_deliberate");
	});

	test("an underscore-prefixed symbol is absent from the main candidate list", async () => {
		const out = await report();
		const section = out.split("SINGLE-REFERENCE SYMBOLS")[1]?.split("\n\n")[0] ?? "";
		expect(section).not.toContain("_deliberate");
	});

	test("the kept group states that the prefix is intent, not proof", async () => {
		const out = await report();
		expect(out).toMatch(/intent, not proof/i);
	});

	test("a symbol used more than once appears in neither list", async () => {
		const out = await report();
		// Matched as a listed ROW (`L<n>  function used`), because the prose above the rows
		// contains the word "used" and would otherwise trigger a false failure.
		const rowFor = (name: string) => new RegExp(`L\\d+\\s+\\w+\\s+${name}\\b`);
		const candidates = out.split("SINGLE-REFERENCE SYMBOLS")[1]?.split("\n\n")[0] ?? "";
		const kept = out.split("INTENTIONALLY KEPT")[1]?.split("\n\n")[0] ?? "";
		expect(candidates).not.toMatch(rowFor("used"));
		expect(kept).not.toMatch(rowFor("used"));
		// The regex must be capable of matching, or this test proves nothing.
		expect(candidates).toMatch(rowFor("helper"));
	});
});
