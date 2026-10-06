/**
 * injection-target.test.ts — the target read off untyped measured data.
 *
 * `spec.data` is a plain record by construction (the measure/render seam does not carry
 * types across), so the render side receives `unknown` and must not trust it. The
 * failure this guards is specific and invisible: an id-less or misspelled target that
 * coerces to something truthy paints a live-looking link which navigates nowhere, or
 * worse, to `undefined`.
 */

import { describe, expect, it } from "bun:test";
import { coerceInjectionTarget } from "../injection-target";

describe("coerceInjectionTarget — accepts well-formed targets", () => {
	it("keeps a narrator target's message id when present", () => {
		expect(coerceInjectionTarget({ kind: "narrator", narratorId: "n1", messageId: "m1" })).toEqual({
			kind: "narrator",
			narratorId: "n1",
			messageId: "m1",
		});
	});

	it("omits the message id rather than carrying null through", () => {
		// Consumers spread this into a call as `messageId ?? undefined`; normalizing here
		// keeps "no target message" one shape instead of three (absent / null / "").
		expect(coerceInjectionTarget({ kind: "narrator", narratorId: "n1", messageId: null })).toEqual({
			kind: "narrator",
			narratorId: "n1",
		});
		expect(coerceInjectionTarget({ kind: "narrator", narratorId: "n1", messageId: "  " })).toEqual({
			kind: "narrator",
			narratorId: "n1",
		});
	});

	it("accepts the other three kinds with their own identifiers", () => {
		expect(coerceInjectionTarget({ kind: "knowledge", entryId: "k1", scope: "personal" })).toEqual({
			kind: "knowledge",
			entryId: "k1",
			scope: "personal",
		});
		expect(coerceInjectionTarget({ kind: "spec", uri: "spec://tasks.json" })).toEqual({
			kind: "spec",
			uri: "spec://tasks.json",
		});
		expect(coerceInjectionTarget({ kind: "chapter", chapterId: "c1" })).toEqual({
			kind: "chapter",
			chapterId: "c1",
		});
	});

	it("defaults an unrecognized knowledge scope to global", () => {
		// The entry id is the load-bearing part, and global is where an injected hint's
		// entries come from — so a garbled scope must not discard a usable target.
		expect(coerceInjectionTarget({ kind: "knowledge", entryId: "k1" })).toEqual({
			kind: "knowledge",
			entryId: "k1",
			scope: "global",
		});
		expect(coerceInjectionTarget({ kind: "knowledge", entryId: "k1", scope: "nonsense" })).toEqual({
			kind: "knowledge",
			entryId: "k1",
			scope: "global",
		});
	});
});

describe("coerceInjectionTarget — refuses everything else", () => {
	it("refuses a target with no identifier", () => {
		// This is the shape that produces a dead link: a recognized kind whose id is
		// missing would otherwise pass a discriminant-only check.
		for (const value of [
			{ kind: "narrator" },
			{ kind: "narrator", narratorId: "" },
			{ kind: "narrator", narratorId: "   " },
			{ kind: "narrator", narratorId: 7 },
			{ kind: "knowledge" },
			{ kind: "spec" },
			{ kind: "chapter" },
		]) {
			expect(coerceInjectionTarget(value)).toBeUndefined();
		}
	});

	it("refuses an unknown kind rather than guessing one", () => {
		expect(coerceInjectionTarget({ kind: "terminal", terminalId: "t1" })).toBeUndefined();
		// A future `narrator.v2` must not be silently read as `narrator`.
		expect(coerceInjectionTarget({ kind: "narrator.v2", narratorId: "n1" })).toBeUndefined();
	});

	it("refuses non-objects, including the shapes a bad producer might emit", () => {
		for (const value of [null, undefined, "narr-1", 42, true, [], [{ kind: "narrator" }]]) {
			expect(coerceInjectionTarget(value)).toBeUndefined();
		}
	});
});
