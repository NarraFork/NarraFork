import { expect, test } from "bun:test";
import { groupContextSegments } from "@shared/context-composition";
import { ContextNumericCache, type NumericState } from "./context-numeric-cache";

function state(chars = 1): NumericState {
	return {
		profile: "primary",
		revision: "1",
		boundary: -1,
		maxSeq: 1,
		totals: groupContextSegments([{ category: "user", chars }]),
		entries: new Map([["m", { messageId: "m", seq: 1, segments: [{ category: "user", chars }] }]]),
	};
}
test("default numeric cache keeps 32 actors and promotes recently used entries", () => {
	const cache = new ContextNumericCache();
	for (let i = 0; i < 32; i++) cache.set(`n${i}`, state());
	expect(cache.get("n0")).toBeDefined();
	cache.set("new", state());
	expect(cache.get("n1")).toBeUndefined();
	expect(cache.get("n0")).toBeDefined();
});
test("global numeric byte budget evicts oldest actors, oversized entries are not retained", () => {
	const cache = new ContextNumericCache(32, 4096);
	cache.set("a", state());
	cache.set("b", state());
	expect(cache.get("a")).toBeUndefined();
	expect(cache.get("b")).toBeDefined();
	const large = state();
	large.entries
		.get("m")
		?.segments.push(...Array.from({ length: 20 }, () => ({ category: "user" as const, chars: 1 })));
	cache.set("huge", large);
	expect(cache.get("huge")).toBeUndefined();
	expect(cache.get("b")).toBeDefined();
	cache.clear();
	expect(cache.get("b")).toBeUndefined();
});
