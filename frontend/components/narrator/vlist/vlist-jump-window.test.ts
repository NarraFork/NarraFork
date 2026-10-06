/**
 * vlist-jump-window.test.ts — Pins the "can this jump reach its target?" rules.
 *
 * The regression these protect: the exact list used to give up silently when a
 * search hit pointed above the loaded window, because a target with no layout
 * item was indistinguishable from a target that does not exist. The decision
 * below is what separates the two — "page upward" vs "tell the reader" — so its
 * boundaries (window edge, exhausted history, spent budget) are worth pinning.
 */

import { describe, expect, it } from "bun:test";
import {
	JUMP_MAX_OLDER_PAGES,
	type JumpWindowInput,
	resolveJumpWindowDecision,
} from "./vlist-jump-window";

const decide = (overrides: Partial<JumpWindowInput> = {}) =>
	resolveJumpWindowDecision({
		targetSeq: 500,
		oldestLoadedSeq: 400,
		hasPrev: true,
		expansions: 0,
		...overrides,
	});

describe("resolveJumpWindowDecision", () => {
	it("reveals directly when the target sits inside the loaded window", () => {
		expect(decide()).toEqual({ kind: "in-window" });
	});

	it("treats the window's oldest seq as loaded (inclusive boundary)", () => {
		// The oldest loaded message IS in the window; an exclusive test here would
		// trigger a pointless extra page every time the target is the first row.
		expect(decide({ targetSeq: 400, oldestLoadedSeq: 400 })).toEqual({ kind: "in-window" });
	});

	it("expands upward when the target is older than the window", () => {
		expect(decide({ targetSeq: 399, oldestLoadedSeq: 400 })).toEqual({ kind: "expand" });
	});

	it("expands when nothing is loaded yet but older history exists", () => {
		expect(decide({ oldestLoadedSeq: null })).toEqual({ kind: "expand" });
	});

	it("reports unreachable — rather than looping — once history is exhausted", () => {
		expect(decide({ targetSeq: 1, oldestLoadedSeq: 400, hasPrev: false })).toEqual({
			kind: "unreachable",
			reason: "no-older-history",
		});
	});

	it("prefers 'no older history' over the budget when both would apply", () => {
		// A document with nothing above cannot be reached by any number of pages, so
		// the honest reason is the missing history, not the spent budget.
		expect(decide({ targetSeq: 1, oldestLoadedSeq: 400, hasPrev: false, expansions: 999 })).toEqual(
			{ kind: "unreachable", reason: "no-older-history" },
		);
	});

	it("stops after the page budget so one click cannot page forever", () => {
		expect(decide({ targetSeq: 1, expansions: JUMP_MAX_OLDER_PAGES })).toEqual({
			kind: "unreachable",
			reason: "budget-exhausted",
		});
	});

	it("still expands on the last allowed page", () => {
		expect(decide({ targetSeq: 1, expansions: JUMP_MAX_OLDER_PAGES - 1 })).toEqual({
			kind: "expand",
		});
	});

	it("honours a caller-supplied budget", () => {
		expect(decide({ targetSeq: 1, expansions: 2, maxExpansions: 2 })).toEqual({
			kind: "unreachable",
			reason: "budget-exhausted",
		});
		expect(decide({ targetSeq: 1, expansions: 1, maxExpansions: 2 })).toEqual({ kind: "expand" });
	});
});
