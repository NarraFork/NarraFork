/**
 * StructSed tool-level tests.
 *
 * These cover the tool's GATES rather than its text arithmetic (that lives in
 * edit-ops.test.ts): address validation, the dry-run default, ambiguity reporting, and
 * the recorded input that replay depends on.
 *
 * Every case here runs without a tool-call binding, so the write path is deliberately
 * refused — which is itself one of the behaviours under test. The mutations are verified
 * through dry-run output plus the pure functions, so no test in this file writes a file.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGrammarFixture } from "../../structural/__tests__/grammar-fixture";
import { MAX_TRAVERSAL_DEPTH } from "../../structural/outline";
import { treeSitterProvider } from "../../structural/tree-sitter-provider";
import type { ToolContext } from "../../types";
import { structSedTool } from "../struct-sed";
import { structViewTool } from "../struct-view";

const TS_SOURCE = `export class PaymentService {
	/** Charge one order. */
	async charge(orderId: string): Promise<string> {
		return orderId;
	}

	refund(orderId: string): void {
		void orderId;
	}
}
`;

const PLAIN_SOURCE = "alpha\nbravo\ncharlie\ndelta\n";

let workDir: string;
let tsFile: string;
let plainFile: string;
let hasGrammar = false;

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "struct-sed-test-"));
	tsFile = join(workDir, "payment.ts");
	plainFile = join(workDir, "notes.txt");
	writeFileSync(tsFile, TS_SOURCE, "utf8");
	writeFileSync(plainFile, PLAIN_SOURCE, "utf8");
	hasGrammar = await ensureGrammarFixture("typescript");
});

function makeCtx(): ToolContext {
	return {
		narratorId: "test-narrator",
		cwd: workDir,
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" }),
	} as unknown as ToolContext;
}

async function run(args: Record<string, unknown>) {
	return structSedTool.execute(args, makeCtx());
}

describe("registration", () => {
	test("is not marked read-only", () => {
		// A read-only flag would let it through plan mode and the read-only tool paths.
		expect(structSedTool.metadata?.readOnly).toBeFalsy();
	});

	test("routes as a write operation", () => {
		// A `read` routing would put this on the read path even for real mutations.
		const routing = structSedTool.executionRouting;
		expect(routing?.kind).toBe("single");
		if (routing?.kind !== "single") throw new Error("expected single routing");
		const request = routing.resolve({ file_path: "/tmp/x.ts", command: "delete" }, {} as never);
		expect(request && "operation" in request ? request.operation : null).toBe("write");
	});
});

describe("address validation", () => {
	test("both symbol and address is refused rather than guessed", () => {
		// Picking one silently could delete a different range than the model named.
		return run({
			file_path: plainFile,
			command: "delete",
			symbol: "charge",
			address: "1,2",
		}).then((result) => {
			expect(result.isError).toBe(true);
			expect(result.output).toContain("not both");
		});
	});

	test("neither is refused", async () => {
		const result = await run({ file_path: plainFile, command: "delete" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("address is required");
	});

	test("an unknown command is refused", async () => {
		const result = await run({ file_path: plainFile, command: "teleport", address: "1" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Unknown command");
	});

	test("an invalid address reports the parse error", async () => {
		const result = await run({
			file_path: plainFile,
			command: "delete",
			address: "not-an-address",
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Invalid address");
	});

	test("an address matching nothing is an error, not a silent no-op", async () => {
		const result = await run({ file_path: plainFile, command: "delete", address: "/zzz-absent/" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("matched nothing");
	});

	test("a missing file reports a read error", async () => {
		const result = await run({
			file_path: join(workDir, "absent.txt"),
			command: "delete",
			address: "1",
		});
		expect(result.isError).toBe(true);
	});
});

describe("EOF addresses", () => {
	for (const [name, source, lastLine] of [
		["trailing newline", "alpha\nbravo\n", 2],
		["no trailing newline", "alpha\nbravo", 2],
		["CRLF", "alpha\r\nbravo\r\n", 2],
		["trailing blank line", "alpha\nbravo\n\n", 3],
		["empty file", "", 1],
	] as const) {
		test(`append at $: ${name}`, async () => {
			const file = join(workDir, `eof-${name}.txt`);
			writeFileSync(file, source);
			const result = await run({
				file_path: file,
				command: "append",
				address: "$",
				content: "CHARLIE",
			});
			expect(result.isError).toBeFalsy();
			expect(result.metadata?.startLine).toBe(lastLine);
			expect(result.metadata?.endLine).toBe(lastLine);
			expect(result.output).toContain("CHARLIE");
			expect(readFileSync(file, "utf8")).toBe(source);
		});
	}

	test("a numeric address beyond the actual last line is still refused", async () => {
		const result = await run({
			file_path: plainFile,
			command: "append",
			address: "5",
			content: "extra",
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("matched nothing");
	});
});

describe("dry run is the default", () => {
	test("no dry_run flag means preview, and nothing is written", async () => {
		const before = readFileSync(plainFile, "utf8");
		const result = await run({ file_path: plainFile, command: "delete", address: "2" });
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("DRY RUN");
		expect(result.metadata?.dryRun).toBe(true);
		expect(readFileSync(plainFile, "utf8")).toBe(before);
	});

	test("the preview reports the resolved range", async () => {
		const result = await run({ file_path: plainFile, command: "delete", address: "2,3" });
		expect(result.metadata?.startLine).toBe(2);
		expect(result.metadata?.endLine).toBe(3);
	});

	test("the preview shows before and after", async () => {
		const result = await run({
			file_path: plainFile,
			command: "replace",
			address: "2",
			content: "BRAVO",
		});
		expect(result.output).toContain("Before:");
		expect(result.output).toContain("After:");
		expect(result.output).toContain("BRAVO");
	});

	test("the preview carries before/after text for the card's diff", async () => {
		// The card renders these as a real diff; the changed region plus context, numbered
		// from where it starts. The output text stays for the model.
		const result = await run({
			file_path: plainFile,
			command: "replace",
			address: "2",
			content: "BRAVO",
		});
		expect(typeof result.metadata?.diffBefore).toBe("string");
		expect(typeof result.metadata?.diffAfter).toBe("string");
		expect(result.metadata?.diffBefore).toContain("bravo");
		expect(result.metadata?.diffAfter).toContain("BRAVO");
		expect(typeof result.metadata?.diffStartLine).toBe("number");
	});

	test("a change spanning the whole file omits the diff so the card keeps the preview", async () => {
		// A move from the top of a large file to the bottom would diff the entire file,
		// which is more overwhelming than the preview it would replace.
		const big = join(workDir, "big.txt");
		writeFileSync(big, Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join("\n"), "utf8");
		const result = await run({
			file_path: big,
			command: "move",
			address: "1",
			to_address: "900",
			placement: "after",
		});
		expect(result.isError).toBeFalsy();
		expect(result.metadata?.diffBefore).toBeUndefined();
		expect(result.output).toContain("Before:");
	});

	test("substitute reports its replacement count", async () => {
		const result = await run({
			file_path: plainFile,
			command: "substitute",
			address: "1,$",
			pattern: "a",
			replacement: "A",
			flags: "g",
		});
		expect(typeof result.metadata?.replacements).toBe("number");
		expect(result.metadata?.replacements).toBeGreaterThan(0);
	});

	test("dry_run: false without a tool-call binding refuses to write", async () => {
		// Edit falls back to an unrecorded write here; StructSed does not. A structural
		// rewrite with no snapshot evidence cannot be reverted, and revert is exactly what
		// matters for the large edits this tool exists to make.
		const before = readFileSync(plainFile, "utf8");
		const result = await run({
			file_path: plainFile,
			command: "delete",
			address: "2",
			dry_run: false,
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("recorded tool call");
		expect(readFileSync(plainFile, "utf8")).toBe(before);
	});
});

describe("line statistics", () => {
	/**
	 * The header `+N -N` must describe what actually changed in the file, not the size of
	 * the addressed range. An earlier version compared `selected region` vs
	 * `content ?? ""`, so a one-token substitute across an 89-line symbol reported `-89`
	 * while the card showed a single edited line.
	 */
	test("substitute counts the lines it rewrote, not the whole selected range", async () => {
		const target = join(workDir, "stats-substitute.txt");
		// Ten lines in the selection; only one token on one line changes.
		writeFileSync(
			target,
			`${Array.from({ length: 10 }, (_, i) => `line ${i + 1} const local = ${i};`).join("\n")}\n`,
			"utf8",
		);
		const result = await run({
			file_path: target,
			command: "substitute",
			address: "1,10",
			pattern: "const local",
			replacement: "let local",
			flags: "g",
		});
		expect(result.isError).toBeFalsy();
		expect(result.metadata?.replacements).toBe(10);
		// Every line is rewritten in place: 10 removed + 10 added, NOT 0/10 or 0/10-range.
		expect(result.metadata?.linesAdded).toBe(10);
		expect(result.metadata?.linesRemoved).toBe(10);
	});

	test("a single-token substitute reports one added and one removed", async () => {
		const target = join(workDir, "stats-substitute-one.txt");
		writeFileSync(
			target,
			"header\nconst local = structuredClone(cfg.local);\nfooter\nmore\nlines\nhere\n",
			"utf8",
		);
		const result = await run({
			file_path: target,
			command: "substitute",
			address: "2",
			pattern: "const local",
			replacement: "let local",
		});
		expect(result.isError).toBeFalsy();
		expect(result.metadata?.replacements).toBe(1);
		expect(result.metadata?.linesAdded).toBe(1);
		expect(result.metadata?.linesRemoved).toBe(1);
	});

	test("insert reports additions only, not a rewrite of the kept region", async () => {
		const target = join(workDir, "stats-insert.txt");
		writeFileSync(target, "alpha\nbeta\ngamma\n", "utf8");
		const result = await run({
			file_path: target,
			command: "insert",
			address: "2,3",
			content: "new line\n",
		});
		expect(result.isError).toBeFalsy();
		expect(result.metadata?.linesAdded).toBe(1);
		expect(result.metadata?.linesRemoved).toBe(0);
	});

	test("delete reports removals only", async () => {
		const target = join(workDir, "stats-delete.txt");
		writeFileSync(target, "alpha\nbeta\ngamma\ndelta\n", "utf8");
		const result = await run({
			file_path: target,
			command: "delete",
			address: "2,3",
		});
		expect(result.isError).toBeFalsy();
		expect(result.metadata?.linesAdded).toBe(0);
		expect(result.metadata?.linesRemoved).toBe(2);
	});

	test("replace diffs the region against its replacement", async () => {
		const target = join(workDir, "stats-replace.txt");
		writeFileSync(target, "alpha\nbeta\ngamma\ndelta\n", "utf8");
		const result = await run({
			file_path: target,
			command: "replace",
			address: "2",
			content: "BETA",
		});
		expect(result.isError).toBeFalsy();
		expect(result.metadata?.linesAdded).toBe(1);
		expect(result.metadata?.linesRemoved).toBe(1);
	});

	test("a surgical substitute in a file past the whole-file budget still counts the real change", async () => {
		// Past `MAX_WHOLE_FILE_STATS_CHARS`, the whole-file diff is dropped. The window
		// fallback must still answer — otherwise a one-line fix in a large module would
		// either vanish or (worse) report the entire addressed range as deleted.
		const target = join(workDir, "stats-large.txt");
		// ~100KB of padding so whole-file stats refuse the input budget.
		const filler = Array.from(
			{ length: 500 },
			(_, i) => `padding line ${i} ${"x".repeat(100)}`,
		).join("\n");
		writeFileSync(target, `${filler}\nconst local = 1;\n${filler}\n`, "utf8");
		const result = await run({
			file_path: target,
			command: "substitute",
			address: "1,$",
			pattern: "const local",
			replacement: "let local",
		});
		expect(result.isError).toBeFalsy();
		expect(result.metadata?.replacements).toBe(1);
		expect(result.metadata?.linesAdded).toBe(1);
		expect(result.metadata?.linesRemoved).toBe(1);
	});
});

describe("cross-file destinations", () => {
	test("refuses to_file instead of silently ignoring it", async () => {
		// Ignoring it resolved the destination inside the SOURCE file, so a same-line
		// target reported "destination overlaps the source" — an error about the wrong
		// file, leaving the caller to believe the cross-file move had happened.
		const result = await run({
			file_path: tsFile,
			command: "move",
			symbol: "PaymentService",
			to_file: join(workDir, "elsewhere.ts"),
			to_address: "1",
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("to_file");
		// The refusal has to name the path that does work — now the stash relay, which
		// keeps the moved text out of the context entirely.
		expect(result.output).toContain("mode=stash");
		expect(result.output).toContain("from_stash");
		expect(result.output).not.toContain("overlaps");
	});
});

describe("create_if_missing", () => {
	test("a missing file is an error unless creation was requested", async () => {
		const target = join(workDir, "does-not-exist.ts");
		const result = await run({
			file_path: target,
			command: "append",
			address: "1",
			content: "export const a = 1;",
		});
		expect(result.isError).toBe(true);
		expect(existsSync(target)).toBe(false);
	});

	test("previews creating a new file without writing it", async () => {
		const target = join(workDir, "fresh-module.ts");
		const result = await run({
			file_path: target,
			command: "append",
			address: "1",
			content: "export const fresh = 1;",
			create_if_missing: true,
		});
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("DRY RUN");
		// A preview must not bring the file into existence.
		expect(existsSync(target)).toBe(false);
	});

	test("refuses to create a file with a command that needs existing text", async () => {
		// delete/substitute/move describe a transformation; on a missing file there is
		// nothing to transform, and creating an empty file would not be what was asked.
		for (const command of ["delete", "substitute", "move"]) {
			const result = await run({
				file_path: join(workDir, `nope-${command}.ts`),
				command,
				address: "1",
				create_if_missing: true,
				...(command === "substitute" ? { pattern: "a", replacement: "b" } : {}),
				...(command === "move" ? { to_address: "2" } : {}),
			});
			expect(result.isError).toBe(true);
			expect(result.output).toContain("create_if_missing");
		}
	});
});

describe("missing command arguments", () => {
	test("replace without content", async () => {
		const result = await run({ file_path: plainFile, command: "replace", address: "1" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("requires `content`");
	});

	test("substitute without pattern", async () => {
		const result = await run({
			file_path: plainFile,
			command: "substitute",
			address: "1",
			replacement: "x",
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("requires `pattern`");
	});

	test("an unsupported substitute flag is rejected", async () => {
		const result = await run({
			file_path: plainFile,
			command: "substitute",
			address: "1",
			pattern: "a",
			replacement: "b",
			flags: "gm",
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Unsupported substitute flags");
	});
});

describe("no-op detection", () => {
	test("replacing content with itself reports no change", async () => {
		const result = await run({
			file_path: plainFile,
			command: "replace",
			address: "1",
			content: "alpha",
		});
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("No changes");
	});

	test("a substitute that matches nothing reports no change", async () => {
		const result = await run({
			file_path: plainFile,
			command: "substitute",
			address: "1,$",
			pattern: "zzz",
			replacement: "y",
		});
		expect(result.output).toContain("No changes");
	});
});

describe("structural addressing", () => {
	test("a symbol resolves to that declaration's range", async () => {
		if (!hasGrammar) return;
		const result = await run({
			file_path: tsFile,
			command: "delete",
			symbol: "PaymentService.charge",
		});
		expect(result.isError).toBeFalsy();
		// The method spans its doc comment's following lines through its closing brace.
		expect(result.metadata?.startLine).toBe(3);
		expect(result.metadata?.endLine).toBe(5);
	});

	test("a bare method name resolves without naming the class", async () => {
		if (!hasGrammar) return;
		const result = await run({ file_path: tsFile, command: "delete", symbol: "refund" });
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("DRY RUN");
	});

	test("an absent symbol points at StructView rather than failing blankly", async () => {
		if (!hasGrammar) return;
		const result = await run({ file_path: tsFile, command: "delete", symbol: "notThere" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("StructView");
	});

	test("replacing a method re-indents the content to the class body", async () => {
		if (!hasGrammar) return;
		const result = await run({
			file_path: tsFile,
			command: "replace",
			symbol: "refund",
			// Written at column 0; must land at the method indent in the preview.
			content: "voidRefund(): void {}",
		});
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("\tvoidRefund(): void {}");
	});

	test("a symbol on a file with no grammar suggests the address form", async () => {
		const result = await run({ file_path: plainFile, command: "delete", symbol: "alpha" });
		expect(result.isError).toBe(true);
		// notes.txt has no language, so the structural path cannot apply.
		expect(result.output).toMatch(/address|provider/i);
	});
});

describe("truncated outlines never authorize symbol-based edits", () => {
	let filePath: string;
	let source: string;

	beforeAll(() => {
		filePath = join(workDir, "truncated.ts");
		// Only two target declarations; the intervening data exhausts the VISITED
		// budget, not the 5000-declaration limit. The file remains below 2 MB.
		source = `class A { target() {} }\nconst cfg = {${"a:0,".repeat(350_000)}};\nclass B { target() {} }\n`;
		writeFileSync(filePath, source, "utf8");
	});

	test("the raised budget fully covers the former 600 KB reproducer", async () => {
		if (!hasGrammar) return;
		const text = `class A { target() {} }\nconst cfg = {${"a:0,".repeat(150_000)}};\nclass B { target() {} }\n`;
		const doc = { filePath: join(workDir, "within-budget.ts"), text, languageId: "typescript" };
		expect(await treeSitterProvider.isOutlineTruncated?.(doc)).toBe(false);
		expect((await treeSitterProvider.locate(doc, { symbol: "target" })).length).toBe(2);
	});

	test("refuses bare, qualified and numbered selectors, even on the cached outline", async () => {
		if (!hasGrammar) return;
		for (const symbol of ["target", "A.target", "target#1"]) {
			const result = await run({ file_path: filePath, command: "delete", symbol });
			expect(result.isError).toBe(true);
			expect(result.output).toContain("truncated");
			expect(result.output).toContain("`address`");
		}
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	test("refuses a symbolic copy/move destination and batch operation", async () => {
		if (!hasGrammar) return;
		for (const command of ["copy", "move"]) {
			const result = await run({ file_path: filePath, command, address: "3", to_symbol: "target" });
			expect(result.isError).toBe(true);
			expect(result.output).toContain("truncated");
			expect(result.output).toContain("`to_address`");
		}
		const batch = await run({
			file_path: filePath,
			operations: [{ command: "delete", symbol: "target" }],
		});
		expect(batch.isError).toBe(true);
		expect(batch.output).toContain("truncated");
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	test("explicit line addresses remain usable", async () => {
		if (!hasGrammar) return;
		const result = await run({ file_path: filePath, command: "delete", address: "3" });
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("DRY RUN");
		expect(result.metadata?.startLine).toBe(3);
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	test("read modes warn about partial results, and symbol stashes refuse them", async () => {
		if (!hasGrammar) return;
		for (const mode of ["outline", "api", "extract", "find"]) {
			const result = await structViewTool.execute(
				{ file_path: filePath, mode, symbol: "target" },
				makeCtx(),
			);
			expect(result.isError).toBeFalsy();
			expect(result.output).toContain("Outline truncated");
		}
		const missingDeclaration = await structViewTool.execute(
			{ mode: "find", symbol: "B" },
			makeCtx(),
		);
		expect(missingDeclaration.metadata?.declarations).toBe(0);
		expect(missingDeclaration.metadata?.truncatedOutlines).toBe(1);
		expect(missingDeclaration.output).toContain("Outline truncated");
		const missing = await structViewTool.execute(
			{ file_path: filePath, mode: "extract", symbol: "B.target" },
			makeCtx(),
		);
		expect(missing.isError).toBe(true);
		expect(missing.output).toContain("Outline truncated");
		const stash = await structViewTool.execute(
			{ file_path: filePath, mode: "stash", symbol: "target" },
			makeCtx(),
		);
		expect(stash.isError).toBe(true);
		expect(stash.output).toContain("truncated");
		const addressed = await structViewTool.execute(
			{ file_path: filePath, mode: "stash", address: "3" },
			makeCtx(),
		);
		expect(addressed.isError).toBeFalsy();
	});

	test("the depth budget also blocks edits when very few nodes are visited", async () => {
		if (!hasGrammar) return;
		const deepFile = join(workDir, "deep.ts");
		const depth = MAX_TRAVERSAL_DEPTH + 20;
		const text = `class A { target() {} }\nconst cfg = ${"{a:".repeat(depth)}0${"}".repeat(depth)};\nclass B { target() {} }\n`;
		writeFileSync(deepFile, text, "utf8");
		const result = await run({ file_path: deepFile, command: "delete", symbol: "target" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("truncated");
		expect(readFileSync(deepFile, "utf8")).toBe(text);
	});
});
describe("cleanup", () => {
	test("removes the temp workspace", () => {
		rmSync(workDir, { recursive: true, force: true });
		expect(true).toBe(true);
	});
});
