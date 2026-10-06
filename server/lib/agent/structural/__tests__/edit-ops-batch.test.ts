/**
 * `applyBatch` — several operations as one unit.
 *
 * The property under test is that EVERY address is relative to the original file. Applied in
 * the caller's order instead, the second operation's address would depend on how far the
 * first shifted the file, and the model would have to predict the intermediate state to
 * write it. Bottom-up application is what makes the documented semantics true.
 */

import { describe, expect, test } from "bun:test";
import {
	applyBatch,
	type BatchOperation,
	deleteRange,
	EditOpError,
	rangesOverlap,
	replaceRange,
} from "@server/lib/agent/structural/edit-ops";

function del(index: number, startLine: number, endLine: number): BatchOperation {
	return { index, label: "delete", range: { startLine, endLine }, apply: deleteRange };
}

function put(index: number, startLine: number, endLine: number, content: string): BatchOperation {
	return {
		index,
		label: "replace",
		range: { startLine, endLine },
		apply: (text, range) => replaceRange(text, range, content),
	};
}

const FIVE = "a\nb\nc\nd\ne\n";

describe("addresses are relative to the original file", () => {
	test("two deletes both hit the lines they named", () => {
		// Applied top-down, deleting L1 would shift everything up and the L4 delete would
		// remove "e" instead of "d". That failure is silent.
		expect(applyBatch(FIVE, [del(1, 1, 1), del(2, 4, 4)])).toBe("b\nc\ne\n");
	});

	test("the caller's order does not change the result", () => {
		const forward = applyBatch(FIVE, [del(1, 1, 1), del(2, 4, 4)]);
		const reversed = applyBatch(FIVE, [del(1, 4, 4), del(2, 1, 1)]);
		expect(forward).toBe(reversed);
	});

	test("a replace that grows the file does not shift a later address", () => {
		// L1 becomes three lines; the L3 replace must still target the original "c".
		expect(applyBatch(FIVE, [put(1, 1, 1, "x\ny\nz"), put(2, 3, 3, "C")])).toBe(
			"x\ny\nz\nb\nC\nd\ne\n",
		);
	});

	test("a replace that shrinks the file does not shift a later address", () => {
		expect(applyBatch(FIVE, [put(1, 1, 2, "ab"), put(2, 5, 5, "E")])).toBe("ab\nc\nd\nE\n");
	});

	test("three operations across the file", () => {
		expect(applyBatch(FIVE, [put(1, 1, 1, "A"), del(2, 3, 3), put(3, 5, 5, "E")])).toBe(
			"A\nb\nd\nE\n",
		);
	});

	test("a single operation behaves like calling it directly", () => {
		expect(applyBatch(FIVE, [del(1, 2, 2)])).toBe(deleteRange(FIVE, { startLine: 2, endLine: 2 }));
	});
});

describe("overlap is rejected, not ordered", () => {
	test("two operations on the same line reject the whole batch", () => {
		// Whichever ran second would see text the first rewrote, so the result would depend
		// on an ordering the caller never chose.
		expect(() => applyBatch(FIVE, [del(1, 2, 2), put(2, 2, 2, "x")])).toThrow(/overlap/);
	});

	test("partially overlapping ranges are rejected", () => {
		expect(() => applyBatch(FIVE, [del(1, 1, 3), del(2, 3, 5)])).toThrow(/overlap/);
	});

	test("a contained range is rejected", () => {
		expect(() => applyBatch(FIVE, [del(1, 1, 5), del(2, 3, 3)])).toThrow(/overlap/);
	});

	test("the message names both operations so the caller can fix it", () => {
		expect(() => applyBatch(FIVE, [del(7, 2, 2), put(9, 2, 2, "x")])).toThrow(/7.*9|9.*7/s);
	});

	test("adjacent but non-overlapping ranges are allowed", () => {
		expect(applyBatch(FIVE, [del(1, 1, 2), del(2, 3, 4)])).toBe("e\n");
	});
});

describe("atomicity and validation", () => {
	test("an empty batch is an error rather than a silent no-op", () => {
		expect(() => applyBatch(FIVE, [])).toThrow(EditOpError);
	});

	test("an out-of-range address rejects the batch before anything is applied", () => {
		// Validation runs over all operations up front, so a bad address in the second one
		// cannot leave the first half-applied.
		expect(() => applyBatch(FIVE, [del(1, 1, 1), del(2, 90, 90)])).toThrow(/past the end/);
	});

	test("a failing operation names its index", () => {
		const boom: BatchOperation = {
			index: 4,
			label: "replace",
			range: { startLine: 1, endLine: 1 },
			apply: () => {
				throw new Error("nope");
			},
		};
		expect(() => applyBatch(FIVE, [boom])).toThrow(/Operation 4/);
	});

	test("a throwing operation leaves no partial result, because one string is returned", () => {
		const boom: BatchOperation = {
			index: 2,
			label: "replace",
			range: { startLine: 4, endLine: 4 },
			apply: () => {
				throw new Error("nope");
			},
		};
		// The L1 delete would already have run bottom-up if it sorted first; it must not
		// surface as a value.
		expect(() => applyBatch(FIVE, [del(1, 1, 1), boom])).toThrow(EditOpError);
	});
});

describe("rangesOverlap", () => {
	test("touching ranges overlap; neighbours do not", () => {
		expect(rangesOverlap({ startLine: 1, endLine: 2 }, { startLine: 2, endLine: 3 })).toBe(true);
		expect(rangesOverlap({ startLine: 1, endLine: 2 }, { startLine: 3, endLine: 4 })).toBe(false);
	});

	test("it is symmetric", () => {
		const a = { startLine: 1, endLine: 5 };
		const b = { startLine: 3, endLine: 3 };
		expect(rangesOverlap(a, b)).toBe(rangesOverlap(b, a));
	});
});
