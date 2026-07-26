import { describe, expect, it } from "bun:test";
import {
	type HeightOverrideInput,
	hasEffectiveHeightOverride,
	layoutItemsWithOverrides,
	pruneHeightOverrides,
} from "./vlist-height-overrides";

const input = (heights: number[], keys: string[]): HeightOverrideInput => ({
	heights,
	keys,
	gap: 10,
	topPadding: 8,
	bottomPadding: 8,
});

describe("hasEffectiveHeightOverride", () => {
	it("is false for an empty override map", () => {
		expect(hasEffectiveHeightOverride(["a", "b"], [100, 50], new Map())).toBe(false);
	});

	it("is false when the override equals the arithmetic height", () => {
		expect(hasEffectiveHeightOverride(["a"], [100], new Map([["a", 100]]))).toBe(false);
	});

	it("is false when the override key is not present in the current layout", () => {
		expect(hasEffectiveHeightOverride(["a"], [100], new Map([["ghost", 200]]))).toBe(false);
	});

	it("is true when an override changes a present key's height", () => {
		expect(hasEffectiveHeightOverride(["a", "b"], [100, 50], new Map([["b", 220]]))).toBe(true);
	});
});

describe("layoutItemsWithOverrides", () => {
	it("returns the base arithmetic layout when no override applies", () => {
		const { items, totalHeight } = layoutItemsWithOverrides(
			input([100, 50, 200], ["a", "b", "c"]),
			new Map(),
		);
		expect(items[0]).toEqual({ top: 8, height: 100, bottom: 108 });
		expect(items[1]).toEqual({ top: 118, height: 50, bottom: 168 });
		expect(items[2]).toEqual({ top: 178, height: 200, bottom: 378 });
		expect(totalHeight).toBe(386);
	});

	it("applies an override and shifts every following row's top", () => {
		// Override row "b" from 50 → 150 (grows by 100); rows after shift down 100.
		const { items, totalHeight } = layoutItemsWithOverrides(
			input([100, 50, 200], ["a", "b", "c"]),
			new Map([["b", 150]]),
		);
		expect(items[0]).toEqual({ top: 8, height: 100, bottom: 108 });
		expect(items[1]).toEqual({ top: 118, height: 150, bottom: 268 });
		expect(items[2]).toEqual({ top: 278, height: 200, bottom: 478 });
		expect(totalHeight).toBe(486);
	});

	it("ignores a negative or non-finite override (falls back to arithmetic height)", () => {
		const { items } = layoutItemsWithOverrides(
			input([100, 50], ["a", "b"]),
			new Map([
				["a", -10],
				["b", Number.NaN],
			]),
		);
		expect(items[0]?.height).toBe(100);
		expect(items[1]?.height).toBe(50);
	});

	it("accepts a zero-height override", () => {
		const { items } = layoutItemsWithOverrides(input([100, 50], ["a", "b"]), new Map([["a", 0]]));
		expect(items[0]).toEqual({ top: 8, height: 0, bottom: 8 });
		// Following row starts after the collapsed row + gap.
		expect(items[1]).toEqual({ top: 18, height: 50, bottom: 68 });
	});
});

describe("pruneHeightOverrides", () => {
	it("returns null when every override key is still live", () => {
		const overrides = new Map([
			["a", 100],
			["b", 200],
		]);
		expect(pruneHeightOverrides(overrides, new Set(["a", "b", "c"]))).toBeNull();
	});

	it("drops override entries whose key no longer exists", () => {
		const overrides = new Map([
			["a", 100],
			["gone", 200],
		]);
		const pruned = pruneHeightOverrides(overrides, new Set(["a"]));
		expect(pruned).not.toBeNull();
		expect([...(pruned?.keys() ?? [])]).toEqual(["a"]);
		expect(pruned?.get("a")).toBe(100);
	});

	// Regression: a resolved permission keeps its `tool-<id>` row in the manifest
	// while the live form unmounts. Pruning by manifest presence alone kept the
	// form's tall measured height pinned to the row, so the card floated at the top
	// of a tall empty box and every following row was pushed down.
	it("drops the override of a row that is still present but no longer dynamic", () => {
		const overrides = new Map([["tool-tu1", 420]]);
		const pruned = pruneHeightOverrides(overrides, new Set<string>());
		expect(pruned).not.toBeNull();
		expect(pruned?.size).toBe(0);
	});

	it("keeps the override while the row still hosts a live form", () => {
		const overrides = new Map([["tool-tu1", 420]]);
		expect(pruneHeightOverrides(overrides, new Set(["tool-tu1"]))).toBeNull();
	});

	// The pruned map must actually restore the arithmetic geometry: after the
	// permission resolves, the row collapses back to its manifest height and every
	// following row moves up by the difference (no leftover gap).
	it("restores arithmetic geometry for the row once its override is pruned", () => {
		const geometry = input([40, 42, 60], ["m1", "tool-tu1", "m2"]);
		const withForm = layoutItemsWithOverrides(geometry, new Map([["tool-tu1", 420]]));
		expect(withForm.items[1]?.height).toBe(420);
		expect(withForm.items[2]?.top).toBe(8 + 40 + 10 + 420 + 10);

		const pruned = pruneHeightOverrides(new Map([["tool-tu1", 420]]), new Set<string>());
		const afterResolve = layoutItemsWithOverrides(geometry, pruned ?? new Map());
		expect(afterResolve.items[1]?.height).toBe(42);
		expect(afterResolve.items[2]?.top).toBe(8 + 40 + 10 + 42 + 10);
		expect(afterResolve.totalHeight).toBeLessThan(withForm.totalHeight);
	});
});
