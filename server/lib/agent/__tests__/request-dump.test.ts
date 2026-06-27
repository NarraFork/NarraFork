import { describe, expect, test } from "bun:test";
import { ApiRequestDumpCollector, MAX_DUMP_EVENT_COUNT } from "../request-dump";

describe("ApiRequestDumpCollector.setResponseEventsWithLimit", () => {
	test("keeps all events when under both caps", () => {
		const c = new ApiRequestDumpCollector();
		const events = [{ a: 1 }, { b: 2 }, { c: 3 }];
		c.setResponseEventsWithLimit(events, 100, 1024 * 1024);
		expect(c.snapshot().response?.events).toEqual(events);
	});

	test("truncates by element count and appends a marker", () => {
		const c = new ApiRequestDumpCollector();
		const events = Array.from({ length: 10 }, (_, i) => ({ i }));
		c.setResponseEventsWithLimit(events, 4, 1024 * 1024);
		const stored = c.snapshot().response?.events as unknown[];
		// 4 kept + 1 truncation marker
		expect(stored).toHaveLength(5);
		expect(stored.slice(0, 4)).toEqual(events.slice(0, 4));
		expect(stored[4]).toEqual({ _truncated: 6 });
	});

	test("truncates by byte size from the tail", () => {
		const c = new ApiRequestDumpCollector();
		// Each event serializes to a sizable string; cap bytes so only a few fit.
		const events = Array.from({ length: 20 }, (_, i) => ({ i, pad: "x".repeat(100) }));
		c.setResponseEventsWithLimit(events, MAX_DUMP_EVENT_COUNT, 300);
		const stored = c.snapshot().response?.events as unknown[];
		// At least one event dropped → truncation marker present.
		const marker = stored.at(-1) as { _truncated?: number };
		expect(marker._truncated).toBeGreaterThan(0);
		// Final serialized size is within a small multiple of the cap (kept + marker).
		expect(JSON.stringify(stored).length).toBeLessThan(600);
	});

	test("negative caps disable limiting", () => {
		const c = new ApiRequestDumpCollector();
		const events = Array.from({ length: 5 }, (_, i) => ({ i }));
		c.setResponseEventsWithLimit(events, -1, -1);
		expect(c.snapshot().response?.events).toEqual(events);
	});
});
