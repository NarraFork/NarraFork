import { expect, test } from "bun:test";
import { EDITOR_CACHE_LIMITS, type EditorCacheItem, EditorModelCache } from "./editor-model-cache";

function harness(limits = EDITOR_CACHE_LIMITS) {
	let now = 0;
	let serial = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	const evicted: number[] = [];
	const cache = new EditorModelCache(
		limits,
		() => now,
		(callback, ms) => {
			const id = ++serial;
			timers.set(id, { at: now + ms, callback });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		(id) => {
			timers.delete(id as unknown as number);
		},
	);
	const add = (id: number, bytes = 1, pins: string[] = []) => {
		const item = {
			bytes,
			models: 1,
			reasons: pins,
			cost() {
				return { models: this.models, bytes: this.bytes };
			},
			pins() {
				return this.reasons;
			},
			evict() {
				evicted.push(id);
			},
		} satisfies EditorCacheItem & { bytes: number; models: number; reasons: string[] };
		cache.add(item);
		return item;
	};
	const advance = (ms: number) => {
		const end = now + ms;
		for (let count = 0; count < 100; count++) {
			const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
			if (!next || next[1].at > end) break;
			timers.delete(next[0]);
			now = next[1].at;
			next[1].callback();
		}
		now = end;
	};
	return { cache, add, advance, evicted, timers };
}

test("default eight-model boundary and LRU reflect actual use, not metadata refresh", () => {
	const h = harness();
	const first = h.add(0);
	for (let id = 1; id < 8; id++) {
		h.advance(1);
		h.add(id);
	}
	h.cache.enforce();
	expect(h.evicted).toEqual([]);
	h.advance(1);
	h.cache.used(first);
	h.add(8);
	h.cache.enforce();
	expect(h.evicted).toEqual([1]);
	expect(h.timers.size).toBe(1);
	h.cache.clear();
	expect(h.timers.size).toBe(0);
});

test("64 MiB exact boundary, then one additional estimated byte evicts oldest", () => {
	const h = harness();
	h.add(1, 32 * 1024 * 1024);
	const second = h.add(2, 32 * 1024 * 1024);
	h.cache.enforce();
	expect(h.evicted).toEqual([]);
	second.bytes++;
	h.cache.enforce();
	expect(h.evicted).toEqual([1]);
	h.cache.clear();
});

test("TTL is exact five minutes and repeated inactive updates never touch the deadline", () => {
	const h = harness();
	h.add(1);
	h.cache.enforce();
	h.advance(299_999);
	for (let n = 0; n < 10; n++) h.cache.enforce();
	expect(h.evicted).toEqual([]);
	expect(h.timers.size).toBe(1);
	h.advance(1);
	expect(h.evicted).toEqual([1]);
	expect(h.timers.size).toBe(0);
});

for (const reason of [
	"visible",
	"view",
	"dirty",
	"loading",
	"encoding",
	"uploading",
	"committing",
	"unknown",
	"confirmation",
	"conflict",
	"recovery",
	"candidate-install",
])
	test(`${reason} is protected from count, bytes and TTL pressure until its owner releases`, () => {
		const h = harness({ count: 0, bytes: 0, idleMs: 5 });
		const item = h.add(1, 100, [reason]);
		h.cache.enforce();
		h.advance(100);
		expect(h.evicted).toEqual([]);
		expect(h.timers.size).toBe(0);
		item.reasons = [];
		h.cache.enforce();
		expect(h.evicted).toEqual([1]);
	});

test("pinned/candidate resident costs share admission and evict clean cache before foreground work", () => {
	const h = harness({ count: 8, bytes: 64, idleMs: 1000 });
	h.add(1, 20);
	const active = h.add(2, 40, ["visible", "candidate-install"]);
	active.models = 2;
	h.cache.enforce();
	expect(h.evicted).toEqual([]);
	active.bytes += 10;
	h.cache.enforce();
	expect(h.evicted).toEqual([1]);
	h.advance(2000);
	expect(h.evicted).toEqual([1]);
	h.cache.clear();
});

test("a newly dirty entry racing an eviction decision is rechecked immediately before disposal", () => {
	const h = harness({ count: 0, bytes: 0, idleMs: 1 });
	const item = h.add(1);
	let reads = 0;
	item.pins = () => (++reads > 1 ? ["dirty"] : []);
	h.cache.enforce();
	expect(h.evicted).toEqual([]);
	h.cache.clear();
});
test("orphan recovery body reservations share the clean cache budget and release idempotently", () => {
	const h = harness({ count: 8, bytes: 64, idleMs: 1000 });
	h.add(1, 32);
	const release = h.cache.reserve({ models: 0, bytes: 40 });
	expect(h.evicted).toEqual([1]);
	release();
	release();
	h.add(2, 64);
	h.cache.enforce();
	expect(h.evicted).toEqual([1]);
	h.cache.clear();
});
