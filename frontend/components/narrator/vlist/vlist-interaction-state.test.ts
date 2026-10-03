import { describe, expect, it } from "bun:test";
import {
	createVListInteractionState,
	isVListTextExpanded,
	resetVListInteractionStateForLod,
	setVListExpanded,
	setVListTextExpanded,
	textExpansionSignature,
	toggleVListLodUserOverride,
	toggleVListRow,
	toggleVListShowEarlier,
	toggleVListShowOriginal,
	toggleVListTextExpanded,
} from "./vlist-interaction-state";

describe("vlist interaction state", () => {
	it("synchronizes durable body aliases and clears old live preferences on collapse", () => {
		const initial = createVListInteractionState(5);
		const canonical = "text-lifecycle:blk:body-1";
		const live = setVListTextExpanded(initial, "__streaming__-b0", true, "seg0", canonical);
		const persisted = setVListTextExpanded(live, "message-1-b0", true, "seg0", canonical);
		const reset = resetVListInteractionStateForLod(persisted, 2);
		expect(reset.textExpansionOwners).toBe(persisted.textExpansionOwners);
		expect(isVListTextExpanded(reset, canonical, "seg0")).toBe(true);
		const closed = setVListTextExpanded(reset, "message-1-b0", false, "seg0", canonical);
		expect(isVListTextExpanded(closed, canonical, "seg0")).toBe(false);
		expect(isVListTextExpanded(closed, "__streaming__-b0", "seg0")).toBe(false);
		expect(isVListTextExpanded(closed, "message-1-b0", "seg0")).toBe(false);
		expect(closed.textExpansionOwners.size).toBe(0);
	});

	it("clears aliases whose low-LOD row slots differ from their canonical step slots", () => {
		const canonical = "text-lifecycle:blk:reason-run";
		let state = setVListTextExpanded(
			createVListInteractionState(5),
			"__streaming__-b0",
			true,
			"seg1",
			canonical,
		);
		state = setVListTextExpanded(state, "persisted-b0", true, "seg1", canonical);
		state = setVListTextExpanded(state, "activity-run", true, "r-run0-step-1", canonical, "seg1");
		state = setVListTextExpanded(state, "activity-run", true, "r-run0-step-0", canonical, "seg0");
		const closed = setVListTextExpanded(
			state,
			"activity-run",
			false,
			"r-run0-step-1",
			canonical,
			"seg1",
		);
		for (const [key, slot] of [
			[canonical, "seg1"],
			["__streaming__-b0", "seg1"],
			["persisted-b0", "seg1"],
			["activity-run", "r-run0-step-1"],
		] as const) {
			expect(isVListTextExpanded(closed, key, slot)).toBe(false);
		}
		expect(isVListTextExpanded(closed, canonical, "seg0")).toBe(true);
		expect(isVListTextExpanded(closed, "activity-run", "r-run0-step-0")).toBe(true);
		expect(closed.textExpansionOwners.size).toBe(1);
	});

	it("accepts an explicit direct canonical slot for an untitled trace body", () => {
		const canonical = "text-lifecycle:blk:plain";
		const direct = setVListTextExpanded(
			createVListInteractionState(5),
			"plain-high",
			true,
			undefined,
			canonical,
		);
		const low = setVListTextExpanded(direct, "plain-low", true, "reason-step-0", canonical, null);
		expect(isVListTextExpanded(low, canonical)).toBe(true);
		expect(isVListTextExpanded(low, canonical, "reason-step-0")).toBe(false);
		const closed = setVListTextExpanded(low, "plain-low", false, "reason-step-0", canonical, null);
		expect(isVListTextExpanded(closed, canonical)).toBe(false);
		expect(isVListTextExpanded(closed, "plain-high")).toBe(false);
		expect(isVListTextExpanded(closed, "plain-low", "reason-step-0")).toBe(false);
		expect(closed.textExpansionOwners.size).toBe(0);
	});

	it("keeps text expansion immutable, row-addressed and independent across LOD", () => {
		const initial = createVListInteractionState(5);
		const direct = toggleVListTextExpanded(initial, "trace");
		const row = toggleVListTextExpanded(direct, "trace", "reason-step-0");
		expect(initial.textExpanded.size).toBe(0);
		expect(isVListTextExpanded(row, "trace")).toBe(true);
		expect(isVListTextExpanded(row, "trace", "reason-step-0")).toBe(true);
		expect(isVListTextExpanded(row, "trace", "reason-step-1")).toBe(false);
		expect(row.expanded.size).toBe(0);
		expect(row.lodUserOverrides.size).toBe(0);
		expect(row.fullPayloadRequested.size).toBe(0);
		const reset = resetVListInteractionStateForLod(row, 1);
		expect(reset.textExpanded).toBe(row.textExpanded);
		expect(
			isVListTextExpanded(toggleVListTextExpanded(reset, "trace", "reason-step-0"), "trace"),
		).toBe(true);
	});

	it("avoids ambiguous composite keys and memo invalidation of unrelated rows", () => {
		const initial = createVListInteractionState(5);
		const expanded = toggleVListTextExpanded(initial, "a", "b#row0");
		expect(isVListTextExpanded(expanded, "a#b", "row0")).toBe(false);
		expect(textExpansionSignature(expanded, "other")).toBe(
			textExpansionSignature(initial, "other"),
		);
		expect(textExpansionSignature(expanded, "a")).not.toBe(textExpansionSignature(initial, "a"));
	});

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
