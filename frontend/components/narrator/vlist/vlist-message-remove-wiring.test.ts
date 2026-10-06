/**
 * vlist-message-remove-wiring.test.ts — A deletion / trailing truncation lands on
 * the loaded window IN PLACE, with no refetch and no deferral.
 *
 * What this fixes
 * ---------------
 * Both events used to be answered only by a structural reload, which is gated on
 * `pinnedToBottom` (`vlist-reload-policy.ts`): while the reader has scrolled up it
 * is withheld indefinitely and merely surfaced as an unread affordance. A reader who
 * right-clicks a message in history to roll back is BY CONSTRUCTION scrolled up, so
 * the rolled-back messages stayed on screen until they happened to scroll back to
 * the bottom — the reported bug.
 *
 * A rollback also arrives as TWO events (messages below deleted, then the boundary
 * message's tail blocks truncated), so both channels are needed or it looks
 * half-applied.
 *
 * These tests pin: no refetch, no deferral while scrolled up, the loaded version
 * (the measure-cache generation) stays fixed, the paging bound is not corrupted, and
 * every update that could serve a stale height is refused.
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
		id: `remove-m${seq}`,
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
					hasPrev: true,
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

describe("removeMessages — a rollback's deleted messages leave immediately", () => {
	it("drops them without issuing another request", async () => {
		const { coordinator, state, count } = await loaded();
		expect(state.fetches).toBe(1);
		const doomed = [`remove-m${count - 1}`, `remove-m${count - 2}`];
		expect(coordinator.removeMessages(doomed, atBottom)).toBe(true);
		expect(state.fetches).toBe(1);
		const snapshot = coordinator.getSnapshot();
		expect(snapshot.input?.messages.length).toBe(count - 2);
		expect(snapshot.items?.length).toBe(count - 2);
		expect(snapshot.input?.messages.some((m) => doomed.includes(m.id))).toBe(false);
	});

	it("applies while the reader is scrolled up — the actual bug", async () => {
		const { coordinator, count } = await loaded();
		// The reload path would have WITHHELD this until the reader returned to the
		// bottom, which is why a right-click rollback appeared to do nothing.
		expect(coordinator.removeMessages([`remove-m${count - 1}`], scrolledUp)).toBe(true);
		const snapshot = coordinator.getSnapshot();
		expect(snapshot.input?.messages.some((m) => m.id === `remove-m${count - 1}`)).toBe(false);
		// And they stay where they were reading rather than being yanked to the tail.
		expect(snapshot.scrollTopAnchorKind).toBe("item");
		expect(Math.abs((snapshot.scrollTop ?? 0) - 200)).toBeLessThanOrEqual(BUILD.segmentGap);
	});

	it("re-measures nothing: every surviving row is served from cache", async () => {
		const { coordinator, measureCache, count } = await loaded();
		measureCache.resetStats();
		coordinator.removeMessages([`remove-m${count - 1}`], atBottom);
		// A removal changes no surviving row's content or key, so unlike an append it
		// should not even cost one measurement.
		expect(measureCache.misses).toBe(0);
		expect(measureCache.hits).toBeGreaterThan(0);
	});

	it("keeps the loaded messageVersion (the cache generation) fixed", async () => {
		const { coordinator, count } = await loaded();
		coordinator.removeMessages([`remove-m${count - 1}`], atBottom);
		expect(coordinator.getSnapshot().input?.messageVersion).toBe(7);
	});

	it("does NOT move the paging bound when the oldest loaded message is deleted", async () => {
		const { coordinator } = await loaded();
		const before = coordinator.getSnapshot().input?.oldestLoadedSeq;
		expect(before).toBe(0);
		coordinator.removeMessages(["remove-m0"], atBottom);
		const after = coordinator.getSnapshot();
		// `oldestLoadedSeq` is the bound of what has been FETCHED, not the oldest row
		// still held. Recomputing it here would make the next upward page start below
		// the deleted span and skip it forever — a silent hole in history.
		expect(after.input?.oldestLoadedSeq).toBe(0);
		expect(after.hasPrev).toBe(true);
	});

	it("declines what it must not apply, leaving the reload to answer", async () => {
		const { coordinator, count } = await loaded();
		// Nothing loaded matches → no row on screen, and nothing to refetch either.
		expect(coordinator.removeMessages(["not-loaded-at-all"], atBottom)).toBe(false);
		expect(coordinator.removeMessages([], atBottom)).toBe(false);
		// Emptying the document is the load path's job, not this channel's.
		const all = Array.from({ length: count }, (_, i) => `remove-m${i}`);
		expect(coordinator.removeMessages(all, atBottom)).toBe(false);
		// Declining must leave the document untouched.
		expect(coordinator.getSnapshot().input?.messages.length).toBe(count);
	});

	it("refuses before the document is loaded", async () => {
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		const coordinator = new PretextLayoutCoordinator();
		expect(coordinator.removeMessages(["remove-m0"], atBottom)).toBe(false);
	});
});

describe("replaceMessage — the other half of a rollback", () => {
	const truncatable = (seq: number) =>
		message(seq, [
			{ type: "text", text: "词".repeat(40) },
			{ type: "text", text: "rolled back".repeat(10) },
		]);

	async function loadedWithTruncatable(count = 12) {
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		const base = Array.from({ length: count }, (_, index) => truncatable(index));
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
		return { coordinator, state, count };
	}

	it("applies a trailing-block truncation with no refetch, while scrolled up", async () => {
		const { coordinator, state, count } = await loadedWithTruncatable();
		const target = count - 1;
		const truncated = message(target, [{ type: "text", text: "词".repeat(40) }]);
		expect(coordinator.replaceMessage(truncated, scrolledUp)).toBe(true);
		expect(state.fetches).toBe(1);
		const snapshot = coordinator.getSnapshot();
		const landed = snapshot.input?.messages.find((m) => m.id === `remove-m${target}`);
		// Without this the rolled-back tail block stayed visible on the very card the
		// reader clicked, until an unrelated reload happened.
		expect(landed?.contentJson).toHaveLength(1);
		expect(snapshot.input?.messageVersion).toBe(7);
	});

	it("refuses an edit that rewrites a surviving block", async () => {
		const { coordinator, count } = await loadedWithTruncatable();
		const target = count - 1;
		// Shorter would be fine, but this keeps `-b0` pointing at DIFFERENT text while
		// messageVersion stays fixed — accepting it would paint the new text at the
		// height measured from the old text (CONTRACT.md §4.5 constraint 3).
		const edited = message(target, [{ type: "text", text: "completely different body" }]);
		expect(coordinator.replaceMessage(edited, atBottom)).toBe(false);
		const landed = coordinator
			.getSnapshot()
			.input?.messages.find((m) => m.id === `remove-m${target}`);
		expect(landed?.contentJson).toHaveLength(2);
	});

	it("refuses a same-length update, a longer one, and a middle-block removal", async () => {
		const { coordinator, count } = await loadedWithTruncatable();
		const target = count - 1;
		const keep = { type: "text", text: "词".repeat(40) };
		expect(
			coordinator.replaceMessage(message(target, [keep, { type: "text", text: "x" }]), atBottom),
		).toBe(false);
		expect(
			coordinator.replaceMessage(
				message(target, [keep, { type: "text", text: "rolled back".repeat(10) }, keep]),
				atBottom,
			),
		).toBe(false);
		// Non-prefix: `-b0` would now denote what used to be `-b1`.
		expect(
			coordinator.replaceMessage(
				message(target, [{ type: "text", text: "rolled back".repeat(10) }]),
				atBottom,
			),
		).toBe(false);
	});

	it("refuses a message that is not loaded, and before any load", async () => {
		const { coordinator } = await loadedWithTruncatable();
		expect(coordinator.replaceMessage(message(9999), atBottom)).toBe(false);
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		expect(new PretextLayoutCoordinator().replaceMessage(message(0), atBottom)).toBe(false);
	});
});
