/**
 * Reference POSITIONS, not just counts.
 *
 * A count answers "how often", which is not the question that comes up when splitting a
 * file: "are all 7 references inside the range I want to extract, or do some live outside
 * it?" That is a distribution. Without it the only way to find out is to abandon the
 * structural tools and grep — which is what a report from a real session described doing.
 *
 * `partitionByRange` turns positions into that answer, and is tested directly since it is
 * a pure function and needs no parser.
 */
import { describe, expect, test } from "bun:test";
import type { StructDocument } from "../provider";
import { partitionByRange } from "../references";
import { clearOutlineCache, referenceLines, treeSitterProvider } from "../tree-sitter-provider";
import { ensureGrammarFixture } from "./grammar-fixture";

const hasTypescript = await ensureGrammarFixture("typescript");
const describeWithGrammar = hasTypescript ? describe : describe.skip;

const SOURCE = `const outer = 1;

function keeper() {
	const local = outer;
	return local + local;
}

function other() {
	return outer;
}
`;

function doc(text = SOURCE): StructDocument {
	return { filePath: "/tmp/reference-lines.ts", languageId: "typescript", text };
}

describeWithGrammar("identifier lines", () => {
	test("records the lines an identifier appears on, ascending", async () => {
		clearOutlineCache();
		const lines = await referenceLines(doc());
		// Definition L1, use inside keeper L4, use inside other L9.
		expect(lines?.get("outer")).toEqual([1, 4, 9]);
	});

	test("a line with two references is listed once", async () => {
		clearOutlineCache();
		const stats = await treeSitterProvider.statistics?.(doc());
		const local = stats?.identifiers.find((e) => e.name === "local");
		// `local + local` on one line: counted twice, positioned once.
		expect(local?.count).toBe(3);
		expect(local?.lines).toEqual([4, 5]);
	});

	test("lines are sorted even though the walk is not positional", async () => {
		clearOutlineCache();
		const lines = await referenceLines(doc());
		expect(lines).not.toBeNull();
		for (const positions of (lines ?? new Map()).values()) {
			expect(positions).toEqual([...positions].sort((a: number, b: number) => a - b));
		}
	});

	test("deduped line count never exceeds the reference count", async () => {
		clearOutlineCache();
		const stats = await treeSitterProvider.statistics?.(doc());
		for (const entry of stats?.identifiers ?? []) {
			if (entry.lines) expect(entry.lines.length).toBeLessThanOrEqual(entry.count);
		}
	});

	test("positions survive the provider boundary as plain numbers", async () => {
		// The tree is released when `statistics` returns, so anything tied to it would be
		// unusable here. Plain numbers are why line lists can cross that boundary at all.
		clearOutlineCache();
		const lines = await referenceLines(doc());
		const outer = lines?.get("outer") ?? [];
		expect(outer.every((line) => Number.isInteger(line) && line > 0)).toBe(true);
	});

	test("every reported line exists in the file", async () => {
		clearOutlineCache();
		const total = SOURCE.split("\n").length;
		const lines = await referenceLines(doc());
		for (const positions of (lines ?? new Map()).values()) {
			for (const line of positions as number[]) expect(line).toBeLessThanOrEqual(total);
		}
	});

	test("a symbol used only at its definition has a single position", async () => {
		clearOutlineCache();
		const lines = await referenceLines(doc("const lonely = 1;\n"));
		expect(lines?.get("lonely")).toEqual([1]);
	});
});

describe("partitionByRange", () => {
	test("splits references into inside and outside", () => {
		expect(partitionByRange([1, 4, 9], { startLine: 3, endLine: 6 })).toEqual({
			inside: [4],
			outside: [1, 9],
		});
	});

	test("range bounds are inclusive", () => {
		expect(partitionByRange([3, 6], { startLine: 3, endLine: 6 })).toEqual({
			inside: [3, 6],
			outside: [],
		});
	});

	test("an empty outside means the symbol is self-contained", () => {
		// The extraction signal: nothing beyond the range refers to it, so it can move
		// with the block.
		expect(partitionByRange([4, 5], { startLine: 3, endLine: 6 }).outside).toHaveLength(0);
	});

	test("a non-empty outside means extracting would break those callers", () => {
		const { inside, outside } = partitionByRange([4, 20], { startLine: 3, endLine: 6 });
		expect(inside).toEqual([4]);
		expect(outside).toEqual([20]);
	});

	test("no references partitions to two empty lists", () => {
		expect(partitionByRange([], { startLine: 1, endLine: 10 })).toEqual({
			inside: [],
			outside: [],
		});
	});

	test("every input line lands in exactly one side", () => {
		const lines = [1, 3, 5, 7, 9, 11];
		const { inside, outside } = partitionByRange(lines, { startLine: 4, endLine: 8 });
		expect([...inside, ...outside].sort((a, b) => a - b)).toEqual(lines);
	});
});
