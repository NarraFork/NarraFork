import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

// Install the deterministic canvas stub before importing any pretext-backed
// module (measure-misc only uses fixed/rule blocks, but keep the pattern
// consistent + safe for future additions).
beforeAll(() => {
	installCanvasStub();
});

describe("measurePruneDivider — fixed decorative row", () => {
	it("is a constant height: label row + my='xs' margins (37px)", async () => {
		const { measurePruneDivider, PRUNE_DIVIDER_HEIGHT, MEASURE_MISC_CONSTANTS } = await import(
			"./measure-misc"
		);
		const r = measurePruneDivider(600);
		expect(r.height).toBe(PRUNE_DIVIDER_HEIGHT);
		// 17 (label row) + 10 + 10 (my="xs") = 37.
		const c = MEASURE_MISC_CONSTANTS;
		expect(r.height).toBe(c.PRUNE_DIVIDER_LABEL_ROW + c.PRUNE_DIVIDER_MARGIN_Y * 2);
		expect(r.height).toBe(37);
	});

	it("height is independent of width, label text, and LOD", async () => {
		const { measurePruneDivider } = await import("./measure-misc");
		const narrow = measurePruneDivider(120);
		const wide = measurePruneDivider(2000);
		const labeled = measurePruneDivider(600, { label: "a very long pruned-context boundary hint" });
		const lowLod = measurePruneDivider(600, {}, 1);
		const highLod = measurePruneDivider(600, {}, 5);
		expect(narrow.height).toBe(wide.height);
		expect(labeled.height).toBe(wide.height);
		expect(lowLod.height).toBe(highLod.height);
	});

	it("carries a single rule block and occupies the full width", async () => {
		const { measurePruneDivider, PRUNE_DIVIDER_MARGIN_Y } = await import("./measure-misc");
		const r = measurePruneDivider(600);
		expect(r.blocks).toHaveLength(1);
		expect(r.blocks[0]?.kind).toBe("rule");
		expect(r.blocks[0]?.marginTop).toBe(PRUNE_DIVIDER_MARGIN_Y);
		expect(r.usedWidth).toBe(600);
		expect(r.contentWidth).toBe(600);
	});
});
