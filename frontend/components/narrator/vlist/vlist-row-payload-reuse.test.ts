/**
 * vlist-row-payload-reuse.test.ts — A streaming delta must not re-render rows it
 * did not change.
 *
 * ── The defect ────────────────────────────────────────────────────────────────
 *
 * `ExactRow` is memoized, and its comparator compares `interaction` and
 * `rowInteraction` by identity like every other prop. Both were built in `useMemo`s
 * depending on `renderItems` — a FRESH array on every layout commit, including the
 * one each streaming delta produces. So every delta minted new payload objects for
 * every row, the memo compared unequal for every mounted row, and the entire window
 * re-rendered per frame for the whole duration of a live turn.
 *
 * The visible symptom was the folded row's shimmer stuttering. That animation is a
 * pure CSS `background-position` sweep, so it costs no React work — until React
 * replaces the elements underneath it. Reconciling a screen of rows 60x/second is
 * what made it hitch, which is why the fix is "stop re-rendering unchanged rows"
 * and not "throttle the stream".
 *
 * ── What is asserted here ─────────────────────────────────────────────────────
 *
 * Both directions, because each failing alone is a real bug:
 *   - an unchanged row must yield the SAME object (or the stutter is back);
 *   - a row whose content moved must yield a NEW one (or it silently keeps stale
 *     content — the same class of failure as the frozen live tail).
 * Plus the generation, which is what keeps reuse sound in the presence of closures.
 */

import { describe, expect, it } from "bun:test";
import {
	beginRowPayloadFrame,
	commitRowPayloadFrame,
	type RowPayloadReuseState,
	reuseRowPayload,
	sameBoundActionKeys,
	sameNumberList,
	sameRowPayloadGeneration,
} from "./vlist-row-payload-reuse";

interface Payload {
	title: string;
	index: number;
	onAct: () => void;
}

const payload = (title: string, index = 0): Payload => ({ title, index, onAct: () => {} });

/** Content equality that IGNORES the closure, as the real comparators do. */
const sameContent = (a: Payload, b: Payload) => a.title === b.title && a.index === b.index;

/** Drive one frame through the cache, returning the map it produced. */
function frame(
	ref: { current: RowPayloadReuseState<Payload> | null },
	generation: readonly unknown[],
	rows: readonly (readonly [string, Payload])[],
): Map<string, Payload> {
	const previous = beginRowPayloadFrame(ref.current, generation);
	const map = new Map<string, Payload>();
	for (const [key, next] of rows) {
		map.set(key, reuseRowPayload(previous, key, next, sameContent));
	}
	commitRowPayloadFrame(ref, generation, map);
	return map;
}

describe("an unchanged row keeps its payload identity across frames", () => {
	it("returns the PREVIOUS object when the content is equivalent", () => {
		const ref = { current: null as RowPayloadReuseState<Payload> | null };
		const gen = ["sel", "handlers"];
		const first = frame(ref, gen, [["row-a", payload("Read a.ts")]]);
		// A fresh object with identical content — exactly what a streaming rebuild
		// hands over for a row it did not touch.
		const second = frame(ref, gen, [["row-a", payload("Read a.ts")]]);
		expect(second.get("row-a")).toBe(first.get("row-a"));
	});

	it("holds identity across MANY consecutive frames (the streaming case)", () => {
		const ref = { current: null as RowPayloadReuseState<Payload> | null };
		const gen = ["sel", "handlers"];
		const first = frame(ref, gen, [["row-a", payload("Read a.ts")]]);
		const original = first.get("row-a");
		for (let i = 0; i < 200; i++) {
			const next = frame(ref, gen, [["row-a", payload("Read a.ts")]]);
			expect(next.get("row-a")).toBe(original);
		}
	});

	it("keeps every row of a window stable, not just the first", () => {
		const ref = { current: null as RowPayloadReuseState<Payload> | null };
		const gen = ["sel"];
		const rows = Array.from({ length: 30 }, (_, i) => [`row-${i}`, payload(`t${i}`, i)] as const);
		const first = frame(ref, gen, rows);
		const second = frame(
			ref,
			gen,
			rows.map(([key, p]) => [key, payload(p.title, p.index)] as const),
		);
		for (const [key] of rows) {
			expect(second.get(key)).toBe(first.get(key));
		}
	});
});

describe("a row whose content moved gets a NEW payload", () => {
	it("adopts the next object when a compared field changed", () => {
		const ref = { current: null as RowPayloadReuseState<Payload> | null };
		const gen = ["sel"];
		const first = frame(ref, gen, [["row-a", payload("Read a.ts")]]);
		const second = frame(ref, gen, [["row-a", payload("Read b.ts")]]);
		expect(second.get("row-a")).not.toBe(first.get("row-a"));
		expect(second.get("row-a")?.title).toBe("Read b.ts");
	});

	it("does not leak one row's payload to another key", () => {
		const ref = { current: null as RowPayloadReuseState<Payload> | null };
		const gen = ["sel"];
		const first = frame(ref, gen, [["row-a", payload("same", 1)]]);
		// Identical CONTENT under a different key must not be served row-a's object:
		// the payloads are per-key and the caches must not cross.
		const second = frame(ref, gen, [["row-b", payload("same", 1)]]);
		expect(second.get("row-b")).not.toBe(first.get("row-a"));
	});

	it("forgets rows that left the document (the cache stays bounded)", () => {
		const ref = { current: null as RowPayloadReuseState<Payload> | null };
		const gen = ["sel"];
		const first = frame(ref, gen, [
			["row-a", payload("a")],
			["row-b", payload("b")],
		]);
		const kept = first.get("row-a");
		// row-b drops out of the document...
		frame(ref, gen, [["row-a", payload("a")]]);
		expect(ref.current?.map.has("row-b")).toBe(false);
		// ...and row-a is unaffected by its neighbour disappearing.
		expect(ref.current?.map.get("row-a")).toBe(kept);
	});
});

describe("the generation keeps reuse sound when closures change", () => {
	it("rebuilds EVERY payload when a captured input changed", () => {
		const ref = { current: null as RowPayloadReuseState<Payload> | null };
		const first = frame(ref, ["sel", "handlersV1"], [["row-a", payload("Read a.ts")]]);
		// New handlers → the closures the payload carries are behaviourally different
		// even though every compared field is identical. Reusing here would leave the
		// row wired to the old handlers.
		const second = frame(ref, ["sel", "handlersV2"], [["row-a", payload("Read a.ts")]]);
		expect(second.get("row-a")).not.toBe(first.get("row-a"));
	});

	it("compares generations by position and identity", () => {
		const a = {};
		const b = {};
		expect(sameRowPayloadGeneration([a, b], [a, b])).toBe(true);
		expect(sameRowPayloadGeneration([a, b], [b, a])).toBe(false);
		expect(sameRowPayloadGeneration([a], [a, b])).toBe(false);
		expect(sameRowPayloadGeneration(undefined, [a])).toBe(false);
		// A cleared cache (no prior state) must compare unequal, so the first frame
		// after a reset rebuilds rather than reading a stale map.
		expect(beginRowPayloadFrame(null, [a])).toBeUndefined();
	});
});

describe("the field helpers the real comparators are built from", () => {
	it("sameNumberList compares by value, tolerating undefined", () => {
		expect(sameNumberList([1, 2], [1, 2])).toBe(true);
		expect(sameNumberList([1, 2], [2, 1])).toBe(false);
		expect(sameNumberList([1], [1, 2])).toBe(false);
		expect(sameNumberList(undefined, undefined)).toBe(true);
		expect(sameNumberList(undefined, [])).toBe(false);
	});

	it("sameBoundActionKeys tracks WHICH actions are bound, ignoring identity", () => {
		// The functions differ every frame by construction; what matters is whether
		// the row gained or lost an affordance.
		expect(sameBoundActionKeys({ a: () => {} }, { a: () => {} })).toBe(true);
		// Insertion order varies with the builders' conditional spreads.
		expect(sameBoundActionKeys({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
		// A tool going terminal drops "detach" — that must be a miss.
		expect(sameBoundActionKeys({ a: 1, b: 2 }, { a: 1 })).toBe(false);
		expect(sameBoundActionKeys({ a: 1 }, { b: 1 })).toBe(false);
		expect(sameBoundActionKeys(undefined, undefined)).toBe(true);
		expect(sameBoundActionKeys(undefined, {})).toBe(false);
	});
});
