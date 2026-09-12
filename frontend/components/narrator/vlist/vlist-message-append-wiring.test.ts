/**
 * vlist-message-append-wiring.test.ts — A landed message extends the loaded window
 * IN PLACE, with no refetch.
 *
 * What this replaces
 * ------------------
 * A message used to be answered with a tail refetch: 40-100 messages plus a full
 * re-measure, coalesced over 120ms-1s. And because a reload REPLACES the loaded
 * window, it was deliberately deferred while the reader had scrolled up — so
 * browsing history during a live turn meant the view knowingly fell behind and
 * showed an unread affordance instead of the message.
 *
 * The body arrives in the event itself, so the round trip was pure latency. These
 * tests pin the replacement: append costs one row's measurement, keeps the loaded
 * version (the cache generation) fixed, works while scrolled up, and refuses
 * anything that would restructure the document.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

const BUILD = {
	lod: 5 as const,
	widthBucket: "800",
	contentWidth: 800,
	viewportHeight: 600,
	gap: 4,
	segmentGap: 12,
	topPadding: 16,
	bottomPadding: 16,
	resolveToolCategory: () => "generic",
	resolveToolColor: () => "gray",
	resolveToolSummary: () => "cmd",
};

// Suite-unique ids: the measurement cache is module-level and a markdown body's
// "data" is a plain string, so it carries no content signature in its key. Real ids
// are nanoids, so only fixtures can collide.
function message(seq: number, role: "user" | "assistant" = "assistant"): TreeMessage {
	return {
		id: `append-m${seq}`,
		narratorId: "n1",
		parentToolUseId: null,
		role,
		contentJson: [{ type: "text", text: "词".repeat(80) }],
		contentText: "词".repeat(80),
		toolCalls: [],
		createdAt: "2026-07-28T00:00:00.000Z",
		children: [],
		seq,
	} as unknown as TreeMessage;
}

async function loaded(count = 30) {
	const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
	const { measureCache } = await import("./measure-cache");
	const base = Array.from({ length: count }, (_, index) => message(index));
	const state = { fetches: 0 };
	const coordinator = new PretextLayoutCoordinator();
	await coordinator.load(
		"n1",
		BUILD,
		{
			fetchPage: async () => {
				state.fetches++;
				return {
					messages: base,
					minSeq: 0,
					maxSeq: count - 1,
					hasNext: false,
					hasPrev: false,
					messageVersion: 7,
				};
			},
		},
		undefined,
		600,
	);
	return { coordinator, state, measureCache, count };
}

const atBottom = () => ({ scrollTop: 0, pinnedToBottom: true, viewportHeight: 600 });
const scrolledUp = () => ({ scrollTop: 200, pinnedToBottom: false, viewportHeight: 600 });

describe("appendMessage — no refetch, one row measured", () => {
	it("extends the window without issuing another request", async () => {
		const { coordinator, state, count } = await loaded();
		expect(state.fetches).toBe(1);
		for (let seq = count; seq < count + 4; seq++) {
			expect(coordinator.appendMessage(message(seq), false, atBottom)).toBe(true);
		}
		// The whole point: a turn's messages land with zero extra round trips.
		expect(state.fetches).toBe(1);
		const snapshot = coordinator.getSnapshot();
		expect(snapshot.input?.messages.length).toBe(count + 4);
		expect(snapshot.items?.length).toBe(count + 4);
	});

	it("re-measures at most the appended rows, never the whole window", async () => {
		const { coordinator, measureCache, count } = await loaded();
		measureCache.resetStats();
		const appended = 4;
		for (let seq = count; seq < count + appended; seq++) {
			coordinator.appendMessage(message(seq), false, atBottom);
		}
		// The invariant is that an append is O(new rows), not O(window). Committed rows
		// are served from cache on every rebuild.
		//
		// An upper bound rather than an exact count on purpose: the cache is
		// module-level and persists across suites, so an identical fixture row measured
		// by an earlier test legitimately hits instead of missing. What must never
		// happen is the window being re-measured, which this bound catches.
		expect(measureCache.misses).toBeLessThanOrEqual(appended);
		expect(measureCache.hits).toBeGreaterThanOrEqual(count * appended);
	});

	it("keeps the loaded messageVersion (the cache generation) fixed", async () => {
		const { coordinator, count } = await loaded();
		coordinator.appendMessage(message(count), false, atBottom);
		expect(coordinator.getSnapshot().input?.messageVersion).toBe(7);
	});

	it("works while the reader is scrolled up (no deferral, no yank to the tail)", async () => {
		const { coordinator, count } = await loaded();
		expect(coordinator.appendMessage(message(count), false, scrolledUp)).toBe(true);
		const snapshot = coordinator.getSnapshot();
		// The message IS in the document (the reload path would have withheld it), and
		// the reader stays where they were reading.
		expect(snapshot.input?.messages.some((entry) => entry.id === `append-m${count}`)).toBe(true);
		expect(snapshot.scrollTopAnchorKind).toBe("item");
		// The anchor snaps to an item boundary, so the correction can differ from the
		// captured scrollTop by at most one inter-item gap — bounded and one-off, not
		// accumulating per append (asserted below).
		expect(Math.abs((snapshot.scrollTop ?? 0) - 200)).toBeLessThanOrEqual(BUILD.segmentGap);
	});

	it("does not accumulate scroll drift across a burst of appends", async () => {
		const { coordinator, count } = await loaded();
		let live = 200;
		const view = () => ({ scrollTop: live, pinnedToBottom: false, viewportHeight: 600 });
		const corrections: number[] = [];
		for (let seq = count; seq < count + 5; seq++) {
			coordinator.appendMessage(message(seq), false, view);
			const corrected = coordinator.getSnapshot().scrollTop;
			if (corrected != null) live = corrected;
			corrections.push(live);
		}
		// Once snapped to an item top, every later append leaves it untouched — the
		// appended rows are all BELOW the anchored one.
		const settled = corrections.slice(1);
		expect(new Set(settled).size).toBe(1);
	});
});

describe("appendMessage — what falls back to a reload", () => {
	it("refuses a duplicate and a mid-window insert, but appends a tail compact marker", async () => {
		const { coordinator, count } = await loaded();
		coordinator.appendMessage(message(count), false, atBottom);
		// Returning false is the caller's signal to reload instead.
		expect(coordinator.appendMessage(message(count), false, atBottom)).toBe(false);
		expect(coordinator.appendMessage(message(5), false, atBottom)).toBe(false);
		// A structural marker that still restructures the document keeps the reload.
		const askMarker = {
			...message(count + 1),
			role: "system",
			contentJson: [{ type: "ask_in_passing" }],
		} as unknown as TreeMessage;
		expect(coordinator.appendMessage(askMarker, false, atBottom)).toBe(false);
	});

	it("appends a tail compact marker in place — deferring it was the reported bug", async () => {
		const { coordinator, state, count } = await loaded();
		const compactMarker = {
			...message(count),
			role: "system",
			contentJson: [{ type: "compact", status: "compacting" }],
		} as unknown as TreeMessage;
		// Its "history before me is compacted away" meaning belongs to the server's
		// NEXT load; a reader's already-loaded window simply gains the marker row.
		expect(coordinator.appendMessage(compactMarker, false, atBottom)).toBe(true);
		expect(state.fetches).toBe(1);
		expect(coordinator.getSnapshot().input?.messages.some((m) => m.id === compactMarker.id)).toBe(
			true,
		);
	});

	it("refuses a child message on a parent page but accepts it on a subagent page", async () => {
		const { coordinator, count } = await loaded();
		const child = {
			...message(count),
			parentToolUseId: "tool-1",
		} as unknown as TreeMessage;
		expect(coordinator.appendMessage(child, false, atBottom)).toBe(false);
		expect(coordinator.appendMessage(child, true, atBottom)).toBe(true);
	});

	it("refuses to append before the document is loaded", async () => {
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		const coordinator = new PretextLayoutCoordinator();
		expect(coordinator.appendMessage(message(0), false, atBottom)).toBe(false);
	});
});
