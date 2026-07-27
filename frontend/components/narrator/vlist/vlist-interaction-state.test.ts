import { describe, expect, it } from "bun:test";
import {
	createVListInteractionState,
	resetVListInteractionStateForLod,
	setVListExpanded,
	toggleVListLodUserOverride,
	toggleVListRow,
	toggleVListShowEarlier,
	toggleVListShowOriginal,
} from "./vlist-interaction-state";

describe("vlist interaction state", () => {
	it("keeps card/reasoning/trace toggles in one immutable model", () => {
		const initial = createVListInteractionState(5);
		const cardOpen = setVListExpanded(initial, "tool-1", true);
		const traceOpen = setVListExpanded(cardOpen, "activity-1", true);
		expect(initial.expanded.size).toBe(0);
		expect(traceOpen.expanded.get("tool-1")).toBe(true);
		expect(traceOpen.expanded.get("activity-1")).toBe(true);
	});

	it("tracks earlier rows and expandable reasoning-step rows independently", () => {
		const initial = createVListInteractionState(4);
		const earlier = toggleVListShowEarlier(initial, "reasoning-1");
		const row = toggleVListRow(earlier, "reasoning-1", 2);
		expect(row.showEarlier.has("reasoning-1")).toBe(true);
		expect(row.expandedRows.get("reasoning-1")?.has(2)).toBe(true);
	});

	it("tracks the show-original choice per key, independent of fold state", () => {
		const initial = createVListInteractionState(5);
		const flipped = toggleVListShowOriginal(initial, "msg-1-b0");
		expect(initial.showOriginal.size).toBe(0);
		expect(flipped.showOriginal.has("msg-1-b0")).toBe(true);
		// Another run is unaffected, and flipping back returns to the translation.
		expect(flipped.showOriginal.has("msg-1-b3")).toBe(false);
		expect(toggleVListShowOriginal(flipped, "msg-1-b0").showOriginal.has("msg-1-b0")).toBe(false);
	});

	it("keeps the show-original choice across an LOD change (content, not fold)", () => {
		// Zooming out must not silently flip a reader back to the translation: the
		// choice is about WHICH TEXT, like `expanded` is about the card, not the LOD.
		const state = toggleVListShowOriginal(createVListInteractionState(5), "msg-1-b0");
		expect(resetVListInteractionStateForLod(state, 2).showOriginal.has("msg-1-b0")).toBe(true);
	});

	it("clears temporary overrides when LOD changes but preserves normal opened state", () => {
		const state = toggleVListRow(
			toggleVListShowEarlier(
				toggleVListLodUserOverride(
					setVListExpanded(createVListInteractionState(5), "card", true),
					"card",
				),
				"trace",
			),
			"trace",
			1,
		);
		const reset = resetVListInteractionStateForLod(state, 4);
		expect(reset.lod).toBe(4);
		expect(reset.expanded.get("card")).toBe(true);
		expect(reset.lodUserOverrides.size).toBe(0);
		expect(reset.showEarlier.size).toBe(0);
		expect(reset.expandedRows.size).toBe(0);
	});
});
