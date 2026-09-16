/**
 * StructView + structural kernel tests.
 *
 * These run against the REAL tree-sitter grammars when they are present in the
 * cache, and skip the accurate-path assertions when they are not. That split is
 * deliberate: grammars are downloaded on demand, so a fresh clone has none, and a
 * suite that required them would fail for reasons unrelated to the code. The
 * fallback assertions (heuristic outline, print addressing, grammar-store
 * verification) always run because they must hold with no grammar installed at all.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AddressError,
	heuristicProvider,
	parseAddress,
	resolveAddress,
	resolveProvider,
	type StructDocument,
} from "../../structural";
import { ensureGrammarFixture } from "../../structural/__tests__/grammar-fixture";
import type { ToolContext } from "../../types";
import { structViewTool } from "../struct-view";

const TS_SOURCE = `import { Order } from "./order";

/** Charges orders. */
export class PaymentService {
	private cache = new Map<string, number>();

	/** Charge one order. */
	async charge(order: Order, retries = 0): Promise<string> {
		return this.run(order);
	}

	private run(order: Order): string {
		return order.id;
	}
}

export function validateCard(number: string): boolean {
	return number.length > 0;
}

function internalHelper(): void {}

export const arrowFn = async (x: number): Promise<number> => x + 1;

export interface Options {
	retry?: boolean;
}
`;

let workDir: string;
let tsFile: string;
let unknownFile: string;

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "nf-structview-"));
	tsFile = join(workDir, "payment.ts");
	writeFileSync(tsFile, TS_SOURCE, "utf8");
	unknownFile = join(workDir, "notes.zzz");
	writeFileSync(unknownFile, "class Widget:\n    def render(self):\n        pass\n", "utf8");
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
	return structViewTool.execute(args, makeCtx());
}

function cleanupOnce(): void {
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch {
		// Best effort.
	}
}

describe("address parsing (grammar-independent)", () => {
	test("parses every supported address form", () => {
		expect(parseAddress("42")).toEqual({ kind: "line", line: 42 });
		expect(parseAddress("10,20")).toEqual({ kind: "range", start: 10, end: 20 });
		expect(parseAddress("10,$")).toEqual({ kind: "range", start: 10, end: "last" });
		expect(parseAddress("$")).toEqual({ kind: "last" });
		expect(parseAddress("/TODO/")).toEqual({ kind: "regex", pattern: "TODO", flags: "" });
		expect(parseAddress("/a/,/b/")).toEqual({
			kind: "regex-range",
			from: "a",
			to: "b",
			flags: "",
		});
	});

	test("rejects malformed addresses with a readable error", () => {
		expect(() => parseAddress("")).toThrow(AddressError);
		expect(() => parseAddress("abc")).toThrow(AddressError);
		expect(() => parseAddress("20,10")).toThrow(AddressError);
		expect(() => parseAddress("0")).toThrow(AddressError);
	});

	test("drops stateful regex flags so .test cannot skip lines", () => {
		// `g` would make each .test resume from lastIndex, silently missing matches.
		const address = parseAddress("/x/gi");
		expect(address).toEqual({ kind: "regex", pattern: "x", flags: "i" });
	});

	test("resolves line, range and regex addresses against content", () => {
		const lines = ["one", "two TODO", "three", "four TODO", "five"];
		expect(resolveAddress(parseAddress("2"), lines).blocks).toEqual([{ startLine: 2, endLine: 2 }]);
		expect(resolveAddress(parseAddress("$"), lines).blocks).toEqual([{ startLine: 5, endLine: 5 }]);
		expect(resolveAddress(parseAddress("2,$"), lines).blocks).toEqual([
			{ startLine: 2, endLine: 5 },
		]);
		expect(resolveAddress(parseAddress("/TODO/"), lines).blocks).toEqual([
			{ startLine: 2, endLine: 2 },
			{ startLine: 4, endLine: 4 },
		]);
		expect(resolveAddress(parseAddress("/two/,/four/"), lines).blocks).toEqual([
			{ startLine: 2, endLine: 4 },
		]);
	});

	test("parses mixed ranges where only one endpoint is a regex", () => {
		expect(parseAddress("/helpers/,$")).toEqual({
			kind: "mixed-range",
			from: { kind: "regex", pattern: "helpers", flags: "" },
			to: { kind: "last" },
		});
		expect(parseAddress("/helpers/,120")).toEqual({
			kind: "mixed-range",
			from: { kind: "regex", pattern: "helpers", flags: "" },
			to: { kind: "line", line: 120 },
		});
		expect(parseAddress("10,/end/")).toEqual({
			kind: "mixed-range",
			from: { kind: "line", line: 10 },
			to: { kind: "regex", pattern: "end", flags: "" },
		});
	});

	test("finds the separating comma outside regex literals", () => {
		// `{1,2}` contains a comma that must not be read as the endpoint separator.
		expect(parseAddress("/a{1,2}/,$")).toEqual({
			kind: "mixed-range",
			from: { kind: "regex", pattern: "a{1,2}", flags: "" },
			to: { kind: "last" },
		});
	});

	test("rejects a range that starts at end-of-file", () => {
		// `$,/x/` cannot run forwards; clamping it would edit an unnamed region.
		expect(() => parseAddress("$,/x/")).toThrow(AddressError);
	});

	test("resolves mixed ranges, searching the end after the start", () => {
		const lines = ["one", "// helpers", "three", "four", "end here"];
		expect(resolveAddress(parseAddress("/helpers/,$"), lines).blocks).toEqual([
			{ startLine: 2, endLine: 5 },
		]);
		expect(resolveAddress(parseAddress("/helpers/,4"), lines).blocks).toEqual([
			{ startLine: 2, endLine: 4 },
		]);
		expect(resolveAddress(parseAddress("2,/end/"), lines).blocks).toEqual([
			{ startLine: 2, endLine: 5 },
		]);
	});

	test("a mixed range whose end regex also matches the start does not collapse", () => {
		const lines = ["open", "mark", "middle", "mark", "close"];
		expect(resolveAddress(parseAddress("/mark/,/mark/"), lines).blocks).toEqual([
			{ startLine: 2, endLine: 4 },
		]);
		expect(resolveAddress(parseAddress("/mark/,$"), lines).blocks).toEqual([
			{ startLine: 2, endLine: 5 },
		]);
	});

	test("an unmatched mixed-range end runs to EOF, and an unmatched start matches nothing", () => {
		const lines = ["one", "start here", "three"];
		expect(resolveAddress(parseAddress("/start/,/never/"), lines).blocks).toEqual([
			{ startLine: 2, endLine: 3 },
		]);
		expect(resolveAddress(parseAddress("/absent/,$"), lines).blocks).toEqual([]);
	});

	test("a mixed-range end only counts when it follows the start", () => {
		// The only `x` precedes line 3, so the end is never found after the start and
		// the range runs to EOF — it must not reach backwards to line 1.
		const lines = ["x here", "two", "three"];
		expect(resolveAddress(parseAddress("3,/x/"), lines).blocks).toEqual([
			{ startLine: 3, endLine: 3 },
		]);
	});

	test("caps the number of returned blocks", () => {
		const lines = Array.from({ length: 50 }, () => "hit");
		const result = resolveAddress(parseAddress("/hit/"), lines, { maxBlocks: 5 });
		expect(result.blocks).toHaveLength(5);
		expect(result.truncated).toBe(true);
	});
});

describe("mode=print", () => {
	test("prints a line range with numbers and does not modify the file", async () => {
		const before = await Bun.file(tsFile).text();
		const result = await run({ file_path: tsFile, mode: "print", address: "1,3" });
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("import { Order }");
		expect(result.output).toMatch(/\s+1│/);
		expect(await Bun.file(tsFile).text()).toBe(before);
	});

	test("prints regex matches without line numbers when asked", async () => {
		const result = await run({
			file_path: tsFile,
			mode: "print",
			address: "/export function/",
			line_numbers: false,
		});
		expect(result.output).toContain("export function validateCard");
		expect(result.output).not.toMatch(/\s+\d+│/);
	});

	test("works on a file whose language has no grammar at all", async () => {
		const result = await run({ file_path: unknownFile, mode: "print", address: "1" });
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("class Widget");
	});

	test("reports an invalid address as an error, not a crash", async () => {
		const result = await run({ file_path: tsFile, mode: "print", address: "not-an-address" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Invalid address");
	});

	test("requires an address", async () => {
		const result = await run({ file_path: tsFile, mode: "print" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("requires `address`");
	});
});

describe("heuristic provider (no grammar required)", () => {
	const doc: StructDocument = {
		filePath: "/tmp/example.unknownlang",
		languageId: null,
		text: TS_SOURCE,
	};

	test("finds declarations by text pattern", async () => {
		const outline = await heuristicProvider.outline(doc);
		const names = outline.map((node) => node.name);
		expect(names).toContain("PaymentService");
		expect(names).toContain("validateCard");
		expect(names).toContain("arrowFn");
	});

	test("nests members under their parent via indentation", async () => {
		const outline = await heuristicProvider.outline(doc);
		const service = outline.find((node) => node.name === "PaymentService");
		expect(service?.children?.map((child) => child.name)).toContain("charge");
	});

	test("labels itself as approximate", () => {
		const note = heuristicProvider.explainLimitation?.(doc);
		expect(String(note)).toContain("approximate");
	});

	test("never claims full support, so an accurate provider always wins", () => {
		expect(heuristicProvider.supports(doc)).toBe("degraded");
	});
});

describe("unknown-language fallback via the tool", () => {
	test("outline degrades to heuristics and says so", async () => {
		const result = await run({ file_path: unknownFile, mode: "outline" });
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("Widget");
		expect(result.output).toContain("note:");
		expect(result.metadata?.provider).toBe("heuristic");
	});
});

describe("tool-level errors", () => {
	test("missing file returns an error result rather than throwing", async () => {
		const result = await run({ file_path: join(workDir, "does-not-exist.ts") });
		expect(result.isError).toBe(true);
	});

	test("extract without a symbol explains what is needed", async () => {
		const result = await run({ file_path: tsFile, mode: "extract" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("requires `symbol`");
	});

	test("enclosing without a position explains what is needed", async () => {
		const result = await run({ file_path: tsFile, mode: "enclosing" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("requires `position`");
	});

	test("empty file is handled gracefully", async () => {
		const emptyPath = join(workDir, "empty.ts");
		writeFileSync(emptyPath, "", "utf8");
		const result = await run({ file_path: emptyPath });
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("empty");
	});

	test("declares itself read-only", () => {
		expect(structViewTool.metadata?.readOnly).toBe(true);
	});
});

// ── accurate path: only meaningful with the grammar installed ────────

const hasTypescript = ensureGrammarFixture("typescript");
const describeWithGrammar = hasTypescript ? describe : describe.skip;

describeWithGrammar("tree-sitter provider (typescript grammar installed)", () => {
	const doc = (): StructDocument => ({
		filePath: tsFile,
		languageId: "typescript",
		text: TS_SOURCE,
	});

	test("resolves to the tree-sitter provider with full support", async () => {
		const resolved = await resolveProvider(doc());
		expect(resolved?.provider.id).toBe("tree-sitter");
		expect(resolved?.support).toBe("full");
	});

	test("outline reports kinds, signatures, ranges and nesting", async () => {
		const result = await run({ file_path: tsFile, mode: "outline" });
		expect(result.metadata?.provider).toBe("tree-sitter");
		expect(result.output).toContain("class PaymentService");
		expect(result.output).toContain("method charge");
		expect(result.output).toContain("Promise<string>");
		expect(result.output).toContain("function validateCard");
		// A nested member is indented under its parent.
		expect(result.output).toMatch(/class PaymentService[\s\S]*\n\s{2,}L\d+/);
	});

	test("depth=1 hides class members", async () => {
		const result = await run({ file_path: tsFile, mode: "outline", depth: 1 });
		expect(result.output).toContain("class PaymentService");
		expect(result.output).not.toContain("method charge");
	});

	test("kind filter keeps only the requested kinds", async () => {
		const result = await run({ file_path: tsFile, mode: "outline", kind: "interface" });
		expect(result.output).toContain("interface Options");
		expect(result.output).not.toContain("function validateCard");
	});

	test("extract returns the exact body with correct line numbers", async () => {
		const result = await run({ file_path: tsFile, mode: "extract", symbol: "validateCard" });
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("export function validateCard");
		expect(result.output).toContain("return number.length > 0;");
		// Not the neighbouring function.
		expect(result.output).not.toContain("internalHelper");
		const start = result.metadata?.startLine as number;
		const lines = TS_SOURCE.split("\n");
		expect(lines[start - 1]).toContain("export function validateCard");
	});

	test("extract with line_numbers:false yields bare source usable as edit content", async () => {
		const numbered = await run({ file_path: tsFile, mode: "extract", symbol: "validateCard" });
		const bare = await run({
			file_path: tsFile,
			mode: "extract",
			symbol: "validateCard",
			line_numbers: false,
		});
		expect(bare.isError).toBeFalsy();
		// The numbered form carries `123│` gutters; the bare form must carry none, or it
		// cannot be handed to StructSed as replacement content.
		expect(numbered.output).toMatch(/\d+│/);
		expect(bare.output).not.toMatch(/\d+│/);
		expect(bare.metadata?.lineNumbers).toBe(false);
		// Byte-for-byte the region the file actually holds.
		const start = bare.metadata?.startLine as number;
		const end = bare.metadata?.endLine as number;
		const expected = TS_SOURCE.split("\n")
			.slice(start - 1, end)
			.join("\n");
		expect(bare.output).toContain(expected);
	});

	test("extract resolves a member by Class.method and by bare name", async () => {
		const qualified = await run({
			file_path: tsFile,
			mode: "extract",
			symbol: "PaymentService.charge",
		});
		expect(qualified.metadata?.symbolPath).toBe("PaymentService.charge");
		const bare = await run({ file_path: tsFile, mode: "extract", symbol: "charge" });
		expect(bare.metadata?.symbolPath).toBe("PaymentService.charge");
	});

	test("extract carries the declaration's doc comment along", async () => {
		const result = await run({ file_path: tsFile, mode: "extract", symbol: "PaymentService" });
		expect(result.output).toContain("/** Charges orders. */");
		expect(result.output).toContain("export class PaymentService");
	});

	test("extract lists candidates instead of guessing when ambiguous", async () => {
		const dupPath = join(workDir, "dup.ts");
		writeFileSync(
			dupPath,
			"export class A { run() { return 1 } }\nexport class B { run() { return 2 } }\n",
			"utf8",
		);
		const ambiguous = await run({ file_path: dupPath, mode: "extract", symbol: "run" });
		expect(ambiguous.metadata?.ambiguous).toBe(true);
		expect(ambiguous.output).toContain("A.run");
		expect(ambiguous.output).toContain("B.run");

		const picked = await run({ file_path: dupPath, mode: "extract", symbol: "run#2" });
		expect(picked.metadata?.symbolPath).toBe("B.run");
	});

	test("extract on a missing symbol suggests what exists", async () => {
		const result = await run({ file_path: tsFile, mode: "extract", symbol: "noSuchThing" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Declarations present");
		expect(result.output).toContain("validateCard");
	});

	test("enclosing maps a line to its symbol chain", async () => {
		const chargeBodyLine =
			TS_SOURCE.split("\n").findIndex((l) => l.includes("return this.run(order)")) + 1;
		const result = await run({
			file_path: tsFile,
			mode: "enclosing",
			position: String(chargeBodyLine),
		});
		expect(result.metadata?.symbolPath).toBe("PaymentService.charge");
		expect(result.metadata?.chain).toEqual(["PaymentService.charge", "PaymentService"]);
	});

	test("enclosing accepts line:column and reports file scope", async () => {
		const withColumn = await run({ file_path: tsFile, mode: "enclosing", position: "1:5" });
		expect(withColumn.isError).toBeFalsy();
		expect(withColumn.metadata?.depth).toBe(0);
	});

	test("api returns exported signatures and hides private members", async () => {
		const result = await run({ file_path: tsFile, mode: "api" });
		expect(result.output).toContain("class PaymentService");
		expect(result.output).toContain("function validateCard");
		expect(result.output).toContain("interface Options");
		// Non-exported top-level declaration must not appear.
		expect(result.output).not.toContain("internalHelper");
		// Bodies are never included.
		expect(result.output).not.toContain("return number.length > 0;");
	});

	test("imports lists modules and exported symbols", async () => {
		const result = await run({ file_path: tsFile, mode: "imports" });
		expect(result.output).toContain("./order");
		expect(result.output).toContain("validateCard");
		expect(result.metadata?.imports).toBe(1);
	});

	// A barrel's entries have no declaration in this file, so the provider leaves their kind
	// `unknown`. Printing that raw made a normal re-export look like a failed parse.
	test("imports labels a re-export as one and names the module it forwards to", async () => {
		const barrel = join(workDir, "barrel.ts");
		writeFileSync(
			barrel,
			'export { validateCard, applyDiscount } from "./payment";\nexport * from "./order";\nexport const localOwn = 1;\n',
			"utf8",
		);
		const result = await run({ file_path: barrel, mode: "imports" });
		expect(result.output).toContain('re-export validateCard from "./payment"');
		// A star re-export forwards everything; `*` is the honest name for that.
		expect(result.output).toContain('re-export * from "./order"');
		// A real declaration in this file keeps its own kind rather than being relabelled.
		expect(result.output).toContain("localOwn");
		expect(result.output).not.toContain("re-export localOwn");
		// The word that made this look broken must be gone.
		expect(result.output).not.toContain("unknown");
	});
});

test("cleanup", () => {
	cleanupOnce();
	expect(true).toBe(true);
});
