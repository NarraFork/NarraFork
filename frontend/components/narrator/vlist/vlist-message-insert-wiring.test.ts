/**
 * vlist-message-insert-wiring.test.ts — A mid-window structural marker (a
 * segment-compact marker, or a custom compact with a `beforeMessageId`) lands on
 * the loaded window IN PLACE, with no refetch and no deferral.
 *
 * What this fixes
 * ---------------
 * Both marker kinds used to be answered only by a structural reload, which is
 * gated on `pinnedToBottom` (`vlist-reload-policy.ts`): while the reader has
 * scrolled up the reload is withheld indefinitely. A reader who just selected a
 * segment to compact is BY CONSTRUCTION looking at that segment — scrolled up —
 * so the marker confirming their action only appeared after they scrolled back
 * to the bottom, and the `segment_compact_hide` event that collapses the run had
 * no handler at all.
 *
 * These tests pin: no refetch, the marker lands immediately before the run it
 * compresses, the anchor keeps the reader where they were, the loaded version
 * (the measure-cache generation) stays fixed, and everything the insert must not
 * place is refused.
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

// Suite-unique ids: the measure cache is module-level and a markdown body's "data"
// is a plain string, so it carries no content signature in its key.
function message(seq: number, blocks?: unknown[]): TreeMessage {
	const text = "词".repeat(80);
	return {
		id: `insert-m${seq}`,
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: blocks ?? [{ type: "text", text }],
		contentText: text,
		toolCalls: [],
		createdAt: "2026-07-28T00:00:00.000Z",
		children: [],
		seq,
	} as unknown as TreeMessage;
}

function segmentMarker(seq: number): TreeMessage {
	return {
		...message(seq),
		id: `insert-seg-${seq}`,
		role: "user",
		contentJson: [{ type: "segment_compact", status: "compacting", messageCount: 2 }],
		contentText: "[Segment compacting]",
	} as unknown as TreeMessage;
}

async function loaded(count = 30, hasPrev = true) {
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
					hasPrev,
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

describe("ask-in-passing canonical document mutations", () => {
	for (const eventKind of ["insert", "resolved"] as const) {
		it(`rejects an in-flight stale pending snapshot after a declined ${eventKind} event`, async () => {
			const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
			const coordinator = new PretextLayoutCoordinator();
			const base = [message(0), message(1)];
			const pending = { ...message(1), id: "epoch-A", role: "system", contentJson: [{ type: "ask_in_passing", status: "pending", sourceMessageId: "insert-m0" }] } as unknown as TreeMessage;
			const later = eventKind === "insert"
				? { ...pending, id: "epoch-B" }
				: { ...pending, contentJson: [{ type: "ask_in_passing", status: "resolved", sourceMessageId: "insert-m0", targetNarratorId: "target" }] } as unknown as TreeMessage;
			const deferred = Promise.withResolvers<void>();
			const started = Promise.withResolvers<void>();
			let fetches = 0;
			const canonical = eventKind === "insert"
				? [base[0], later, { ...pending, seq: 2 }, { ...base[1], seq: 3 }]
				: [base[0], later, { ...base[1], seq: 2 }];
			await coordinator.load("n1", BUILD, {
				locateMessage: async () => ({ seq: 0 }),
				fetchPage: async () => {
					fetches++;
					if (fetches === 2) { started.resolve(); await deferred.promise; }
					const messages = fetches === 1 ? base : fetches === 2 ? [base[0], pending, { ...base[1], seq: 2 }] : canonical;
					return { messages, minSeq: 0, maxSeq: messages.length - 1, hasNext: false, hasPrev: false, messageVersion: fetches === 1 ? 7 : fetches === 2 ? 8 : 9 };
				},
			});
			expect(coordinator.upsertMessage(pending, false, scrolledUp)).toBe(false);
			const before = coordinator.getSnapshot().input;
			const firstRefresh = coordinator.refreshAskInPassing(scrolledUp);
			await started.promise;
			expect(coordinator.upsertMessage(later, false, scrolledUp)).toBe(false);
			expect(coordinator.refreshAskInPassing(scrolledUp)).toBe(firstRefresh);
			deferred.resolve();
			expect(await firstRefresh).toBe(false);
			expect(coordinator.getSnapshot().input).toBe(before);
			expect(await coordinator.refreshAskInPassing(scrolledUp)).toBe(true);
			const rows = coordinator.getSnapshot().input?.messages ?? [];
			expect(rows.map((row) => row.id)).toEqual(canonical.map((row) => row.id));
			if (eventKind === "resolved") {
				expect(rows.find((row) => row.id === pending.id)?.contentJson[0]?.status).toBe("resolved");
				coordinator.upsertMessage(pending, false, scrolledUp);
				expect(coordinator.getSnapshot().input?.messages.find((row) => row.id === pending.id)?.contentJson[0]?.status).toBe("resolved");
			}
		});
	}
	it("allows cancelling an all-ask window without changing generic full-delete semantics", async () => {
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		const coordinator = new PretextLayoutCoordinator();
		const ask = {
			...message(1),
			id: "only-ask",
			role: "system",
			contentJson: [
				{ type: "ask_in_passing", status: "pending", sourceMessageId: "unloaded-source" },
			],
		} as unknown as TreeMessage;
		await coordinator.load("n1", BUILD, {
			fetchPage: async () => ({
				messages: [ask],
				minSeq: 1,
				maxSeq: 1,
				hasPrev: true,
				hasNext: false,
				messageVersion: 7,
			}),
		});
		expect(coordinator.removeMessages([ask.id], scrolledUp)).toBe(true);
		expect(coordinator.getSnapshot().input?.messages).toEqual([]);
	});
	it("refreshes ambiguous ordering without jumping after the reader scrolls", async () => {
		const { PretextLayoutCoordinator, captureCoordinatorAnchor } = await import(
			"./pretext-layout-coordinator"
		);
		const { restorePretextLayoutAnchor } = await import("@shared/pretext-layout");
		const coordinator = new PretextLayoutCoordinator();
		const base = Array.from({ length: 30 }, (_, i) => message(i));
		let refresh = false;
		let scrollTop = 200;
		const getView = () => ({ scrollTop, viewportHeight: 600, pinnedToBottom: false });
		const ask = {
			...message(11),
			id: "ask-refresh",
			askInsertVersion: 9,
			role: "system",
			contentJson: [{ type: "ask_in_passing", status: "pending", sourceMessageId: "insert-m10" }],
		} as unknown as TreeMessage;
		const canonical = [
			...base.slice(0, 11),
			ask,
			...base.slice(11).map((row) => ({ ...row, seq: (row.seq ?? 0) + 1 })),
		];
		await coordinator.load("n1", BUILD, {
			locateMessage: async () => ({ seq: 0 }),
			fetchPage: async () => {
				if (refresh) scrollTop = 400;
				return {
					messages: refresh ? canonical : base,
					minSeq: 0,
					maxSeq: refresh ? 30 : 29,
					hasPrev: true,
					hasNext: false,
					messageVersion: refresh ? 9 : 7,
				};
			},
		});
		expect(coordinator.upsertMessage(ask, false, getView)).toBe(false);
		const oldIndex = coordinator.getSnapshot().index;
		if (!oldIndex) throw new Error("missing index");
		refresh = true;
		expect(await coordinator.refreshAskInPassing(getView)).toBe(true);
		const next = coordinator.getSnapshot();
		if (!next.index) throw new Error("missing refreshed index");
		const anchor = captureCoordinatorAnchor(oldIndex, getView());
		expect(next.scrollTop).toBe(restorePretextLayoutAnchor(anchor, next.index, 600));
		expect(next.input?.messageVersion).toBe(9);
		expect(next.input?.oldestLoadedSeq).toBe(0);
		expect(next.input?.messages.some((m) => m.id === ask.id)).toBe(true);
	});
	it("inserts in history without a fetch, deduplicates HTTP/WS and rejects resurrection", async () => {
		const { coordinator, state } = await loaded();
		const ask = {
			...message(11),
			id: "ask-sync-card",
			askInsertVersion: 8,
			role: "system",
			contentJson: [{ type: "ask_in_passing", status: "pending", sourceMessageId: "insert-m10" }],
		} as unknown as TreeMessage;
		expect(coordinator.upsertMessage(ask, false, scrolledUp)).toBe(true);
		expect(coordinator.upsertMessage({ ...ask }, false, scrolledUp)).toBe(true);
		let messages = coordinator.getSnapshot().input?.messages ?? [];
		expect(messages.filter((m) => m.id === ask.id)).toHaveLength(1);
		expect(messages.find((m) => m.id === "insert-m11")?.seq).toBe(12);
		expect(state.fetches).toBe(1);
		expect(coordinator.removeMessages([ask.id], scrolledUp)).toBe(true);
		expect(coordinator.removeMessages([ask.id], scrolledUp)).toBe(true);
		expect(coordinator.upsertMessage(ask, false, scrolledUp)).toBe(true);
		messages = coordinator.getSnapshot().input?.messages ?? [];
		expect(messages.some((m) => m.id === ask.id)).toBe(false);
		expect(state.fetches).toBe(1);
	});
});

describe("insertMessage — a segment-compact marker lands where the segment was", () => {
	it("inserts immediately before the compressed run without issuing a request", async () => {
		const { coordinator, state, count } = await loaded();
		expect(state.fetches).toBe(1);
		// The server persists the marker AT the first compressed row's seq (and shifts
		// the rest up; locally that shift has not happened — see vlist-message-insert).
		const markerSeq = count - 5;
		expect(coordinator.insertMessage(segmentMarker(markerSeq), atBottom)).toBe(true);
		expect(state.fetches).toBe(1);
		const messages = coordinator.getSnapshot().input?.messages ?? [];
		const markerIndex = messages.findIndex((m) => m.id === `insert-seg-${markerSeq}`);
		expect(markerIndex).toBeGreaterThan(0);
		expect(messages[markerIndex + 1]?.id).toBe(`insert-m${markerSeq}`);
		expect(messages.length).toBe(count + 1);
	});

	it("applies while the reader is scrolled up — the actual bug — without moving them", async () => {
		const { coordinator, count } = await loaded();
		const markerSeq = count - 5;
		expect(coordinator.insertMessage(segmentMarker(markerSeq), scrolledUp)).toBe(true);
		const snapshot = coordinator.getSnapshot();
		expect(snapshot.input?.messages.some((m) => m.id === `insert-seg-${markerSeq}`)).toBe(true);
		// The reader stays where they were rather than being yanked anywhere.
		expect(snapshot.scrollTopAnchorKind).toBe("item");
		expect(Math.abs((snapshot.scrollTop ?? 0) - 200)).toBeLessThanOrEqual(BUILD.segmentGap + 40);
	});

	it("keeps the loaded messageVersion (the measure-cache generation) fixed", async () => {
		const { coordinator, count } = await loaded();
		coordinator.insertMessage(segmentMarker(count - 5), atBottom);
		expect(coordinator.getSnapshot().input?.messageVersion).toBe(7);
	});

	it("re-measures only the inserted row: every surviving row is served from cache", async () => {
		const { coordinator, measureCache, count } = await loaded();
		measureCache.resetStats();
		coordinator.insertMessage(segmentMarker(count - 5), atBottom);
		// The misses are the marker itself (and at most one row whose trailing
		// divider flips next to it); the whole previously committed window hits.
		expect(measureCache.misses).toBeLessThanOrEqual(2);
		expect(measureCache.hits).toBeGreaterThan(0);
	});

	it("declines what it must not place, leaving the document for the reload", async () => {
		const { coordinator, count } = await loaded();
		// Newer than the loaded tail is the append path's job.
		expect(coordinator.insertMessage(segmentMarker(count + 10), atBottom)).toBe(false);
		// A duplicate broadcast places nothing twice.
		expect(coordinator.insertMessage(message(count - 1), atBottom)).toBe(false);
		// Declining must leave the document untouched.
		expect(coordinator.getSnapshot().input?.messages.length).toBe(count);
	});

	it("declines a marker above the fetch bound while older pages are still unfetched", async () => {
		// loadOlder pages by `beforeSeq` and knows nothing of a locally inserted row,
		// so a marker older than `oldestLoadedSeq` would come back from the server on
		// the next upward page — a duplicate. The structural reload owns that case.
		const { coordinator, count } = await loaded();
		expect(coordinator.getSnapshot().input?.hasPrev).toBe(true);
		expect(coordinator.insertMessage(segmentMarker(-1), atBottom)).toBe(false);
		expect(coordinator.getSnapshot().input?.messages.length).toBe(count);
	});

	it("declines a marker above the fetch bound EVEN WITH hasPrev false", async () => {
		// The guard used to require `hasPrev`, on the theory that without unfetched
		// history there is no duplicate to worry about. But the bound can also sit
		// above the oldest loaded row because `trimLoadedHead` handed history back, and
		// duplication is not the only failure: `insertLoadedMessage` legitimately
		// answers `insertAt = 0` for a seq below everything loaded, which puts the
		// marker at the very TOP of the window — above rows that are OLDER than it.
		// A marker in a position it does not belong to is worse than one extra reload.
		const { coordinator, count } = await loaded(30, false);
		expect(coordinator.getSnapshot().input?.hasPrev).toBe(false);
		const before = coordinator.getSnapshot().input?.messages ?? [];
		const oldestLoadedSeq = coordinator.getSnapshot().input?.oldestLoadedSeq;
		expect(oldestLoadedSeq).toBe(0);
		expect(coordinator.insertMessage(segmentMarker(-1), atBottom)).toBe(false);
		const after = coordinator.getSnapshot().input?.messages ?? [];
		expect(after.length).toBe(count);
		// Specifically: nothing was placed at the head.
		expect(after[0]?.id).toBe(before[0]?.id);
		expect(after.some((m) => m.id === "insert-seg--1")).toBe(false);
	});

	it("still declines an above-bound marker after a head trim moved the bound up", async () => {
		// The realistic route to "bound above the oldest loaded row with hasPrev
		// irrelevant": a trim drops the head and retreats the cursor with it. A marker
		// for one of the dropped rows must not be re-inserted at the top.
		const { coordinator, count } = await loaded();
		expect(coordinator.trimHead(5, atBottom)).toBe(true);
		const trimmedBound = coordinator.getSnapshot().input?.oldestLoadedSeq;
		expect(trimmedBound).toBe(5);
		// seq 2 belongs to a dropped row, i.e. below the bound.
		expect(coordinator.insertMessage(segmentMarker(2), atBottom)).toBe(false);
		const messages = coordinator.getSnapshot().input?.messages ?? [];
		expect(messages.length).toBe(count - 5);
		expect(messages[0]?.id).toBe("insert-m5");
	});

	it("refuses before the document is loaded", async () => {
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		const coordinator = new PretextLayoutCoordinator();
		expect(coordinator.insertMessage(segmentMarker(2), atBottom)).toBe(false);
	});
});
