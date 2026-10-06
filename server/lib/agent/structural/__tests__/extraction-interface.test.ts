/**
 * Extraction interface analysis.
 *
 * The classification is the whole product here, so these tests pin the three groups against
 * hand-built outlines and reference maps — no parser needed, which also means a failure
 * points at the classification rather than at a grammar.
 *
 * The distinction that matters most is `needsInput` vs `needsExport`. Both are "a symbol
 * crosses the boundary", and a reference COUNT cannot tell them apart; only the declaration
 * side can. Getting it backwards would tell someone to export a symbol that actually has to
 * be passed in.
 */
import { describe, expect, test } from "bun:test";
import { analyzeExtraction, straddlingDeclarations } from "../extraction-interface";
import type { OutlineNode } from "../provider";

function node(partial: Partial<OutlineNode> & { name: string }): OutlineNode {
	return {
		kind: "function",
		startLine: 1,
		endLine: 1,
		depth: 0,
		exported: false,
		...partial,
	} as OutlineNode;
}

const RANGE = { startLine: 10, endLine: 20 };

describe("needsInput: defined outside, used inside", () => {
	test("a symbol declared before the range becomes an input", () => {
		const outline = [node({ name: "outer", kind: "variable", startLine: 2, endLine: 2 })];
		const refs = new Map([["outer", [2, 12, 15]]]);
		const result = analyzeExtraction(RANGE, outline, refs);
		expect(result.needsInput.map((s) => s.name)).toEqual(["outer"]);
		expect(result.needsExport).toHaveLength(0);
	});

	test("a symbol with no declaration in this file is an input", () => {
		// An import or a global: the extracted unit still has to obtain it.
		const refs = new Map([["useState", [12, 13]]]);
		const result = analyzeExtraction(RANGE, [], refs);
		expect(result.needsInput.map((s) => s.name)).toEqual(["useState"]);
	});

	test("a symbol declared after the range is also an input", () => {
		// Hoisted functions are referenced above their declaration; attributing by first
		// reference instead of by declaration site would misfile this.
		const outline = [node({ name: "later", startLine: 40, endLine: 45 })];
		const refs = new Map([["later", [12, 40]]]);
		expect(analyzeExtraction(RANGE, outline, refs).needsInput.map((s) => s.name)).toEqual([
			"later",
		]);
	});

	test("records where an input is declared", () => {
		const outline = [node({ name: "outer", kind: "variable", startLine: 3, endLine: 3 })];
		const refs = new Map([["outer", [3, 12]]]);
		const [entry] = analyzeExtraction(RANGE, outline, refs).needsInput;
		expect(entry).toMatchObject({ declaredAt: 3, kind: "variable" });
	});
});

describe("needsExport: defined inside, used outside", () => {
	test("a symbol used after the range must be exported", () => {
		const outline = [node({ name: "handler", startLine: 12, endLine: 14 })];
		const refs = new Map([["handler", [12, 30, 44]]]);
		const result = analyzeExtraction(RANGE, outline, refs);
		expect(result.needsExport.map((s) => s.name)).toEqual(["handler"]);
		expect(result.needsExport[0]?.outside).toEqual([30, 44]);
	});

	test("an already-exported symbol is flagged so the caller knows it is a no-op", () => {
		const outline = [node({ name: "pub", startLine: 12, endLine: 13, exported: true })];
		const refs = new Map([["pub", [12, 33]]]);
		expect(analyzeExtraction(RANGE, outline, refs).needsExport[0]?.exported).toBe(true);
	});

	test("a symbol used only before the range still needs exporting", () => {
		const outline = [node({ name: "early", startLine: 11, endLine: 11 })];
		const refs = new Map([["early", [5, 11]]]);
		expect(analyzeExtraction(RANGE, outline, refs).needsExport.map((s) => s.name)).toEqual([
			"early",
		]);
	});
});

describe("selfContained: defined and used only inside", () => {
	test("a local helper moves with the block", () => {
		const outline = [node({ name: "local", startLine: 12, endLine: 13 })];
		const refs = new Map([["local", [12, 15, 18]]]);
		const result = analyzeExtraction(RANGE, outline, refs);
		expect(result.selfContained.map((s) => s.name)).toEqual(["local"]);
		expect(result.needsInput).toHaveLength(0);
		expect(result.needsExport).toHaveLength(0);
	});

	test("a clean seam has an empty needsExport", () => {
		// This is the signal being sought: nothing outside depends on the range's internals.
		const outline = [
			node({ name: "a", startLine: 11, endLine: 12 }),
			node({ name: "b", startLine: 13, endLine: 14 }),
		];
		const refs = new Map([
			["a", [11, 13]],
			["b", [13, 19]],
		]);
		expect(analyzeExtraction(RANGE, outline, refs).needsExport).toHaveLength(0);
	});
});

describe("classification integrity", () => {
	test("a symbol never lands in two groups", () => {
		const outline = [
			node({ name: "outer", startLine: 2, endLine: 2 }),
			node({ name: "inner", startLine: 12, endLine: 12 }),
			node({ name: "shared", startLine: 13, endLine: 13 }),
		];
		const refs = new Map([
			["outer", [2, 12]],
			["inner", [12, 14]],
			["shared", [13, 40]],
		]);
		const r = analyzeExtraction(RANGE, outline, refs);
		const all = [...r.needsInput, ...r.needsExport, ...r.selfContained].map((s) => s.name);
		expect(new Set(all).size).toBe(all.length);
	});

	test("symbols never referenced inside the range are ignored entirely", () => {
		const outline = [node({ name: "elsewhere", startLine: 40, endLine: 41 })];
		const refs = new Map([["elsewhere", [40, 50]]]);
		const r = analyzeExtraction(RANGE, outline, refs);
		expect([...r.needsInput, ...r.needsExport, ...r.selfContained]).toHaveLength(0);
	});

	test("range bounds are inclusive on both ends", () => {
		const outline = [node({ name: "edge", startLine: 10, endLine: 20 })];
		const refs = new Map([["edge", [10, 20]]]);
		expect(analyzeExtraction(RANGE, outline, refs).selfContained.map((s) => s.name)).toEqual([
			"edge",
		]);
	});

	test("a destructure is classified by its bindings, not its label", () => {
		// The label is display text like `{ a, b, …+24 }` and matches no identifier.
		const outline = [
			node({
				name: "{ alpha, beta }",
				kind: "variable",
				startLine: 12,
				endLine: 12,
				bindings: ["alpha", "beta"],
			}),
		];
		const refs = new Map([
			["alpha", [12, 15]],
			["beta", [12, 44]],
		]);
		const r = analyzeExtraction(RANGE, outline, refs);
		expect(r.selfContained.map((s) => s.name)).toEqual(["alpha"]);
		expect(r.needsExport.map((s) => s.name)).toEqual(["beta"]);
	});

	test("call entries are not treated as declarations", () => {
		// A `call` node's name is a callee; treating it as a declaration would make an
		// imported function look locally defined and therefore self-contained.
		const outline = [node({ name: "doThing", kind: "call", startLine: 12, endLine: 12 })];
		const refs = new Map([["doThing", [12]]]);
		expect(analyzeExtraction(RANGE, outline, refs).needsInput.map((s) => s.name)).toEqual([
			"doThing",
		]);
	});

	test("the outermost declaration wins when a name is shadowed", () => {
		const outline = [
			node({ name: "dup", startLine: 3, endLine: 3, depth: 0 }),
			node({ name: "dup", startLine: 12, endLine: 12, depth: 2 }),
		];
		const refs = new Map([["dup", [3, 12]]]);
		// Conservative: reported as something the range depends on from outside.
		expect(analyzeExtraction(RANGE, outline, refs).needsInput.map((s) => s.name)).toEqual(["dup"]);
	});

	test("groups are ordered by how much they cross the boundary", () => {
		const refs = new Map([
			["quiet", [12]],
			["loud", [11, 12, 13, 14]],
		]);
		expect(analyzeExtraction(RANGE, [], refs).needsInput.map((s) => s.name)).toEqual([
			"loud",
			"quiet",
		]);
	});

	test("each group is capped by limit", () => {
		const refs = new Map<string, number[]>(Array.from({ length: 60 }, (_, i) => [`s${i}`, [12]]));
		expect(analyzeExtraction(RANGE, [], refs, { limit: 5 }).needsInput).toHaveLength(5);
	});

	test("truncation is propagated so the answer is read as a lower bound", () => {
		expect(analyzeExtraction(RANGE, [], new Map(), { truncated: true }).truncated).toBe(true);
	});
});

describe("declarations in range", () => {
	test("lists what would move", () => {
		const outline = [
			node({ name: "inside", startLine: 12, endLine: 14 }),
			node({ name: "outside", startLine: 40, endLine: 42 }),
		];
		const names = analyzeExtraction(RANGE, outline, new Map()).declarationsInRange.map(
			(n) => n.name,
		);
		expect(names).toEqual(["inside"]);
	});
});

describe("straddling declarations", () => {
	test("detects a declaration cut in half at the start", () => {
		const outline = [node({ name: "big", startLine: 5, endLine: 15 })];
		expect(straddlingDeclarations(RANGE, outline).map((n) => n.name)).toEqual(["big"]);
	});

	test("detects a declaration cut in half at the end", () => {
		const outline = [node({ name: "big", startLine: 15, endLine: 30 })];
		expect(straddlingDeclarations(RANGE, outline).map((n) => n.name)).toEqual(["big"]);
	});

	test("a declaration enclosing the whole range straddles it", () => {
		const outline = [node({ name: "wrapper", startLine: 1, endLine: 99 })];
		expect(straddlingDeclarations(RANGE, outline).map((n) => n.name)).toEqual(["wrapper"]);
	});

	test("a wholly contained declaration does not straddle", () => {
		const outline = [node({ name: "fits", startLine: 12, endLine: 14 })];
		expect(straddlingDeclarations(RANGE, outline)).toHaveLength(0);
	});

	test("a declaration entirely outside does not straddle", () => {
		const outline = [node({ name: "far", startLine: 40, endLine: 45 })];
		expect(straddlingDeclarations(RANGE, outline)).toHaveLength(0);
	});
});
