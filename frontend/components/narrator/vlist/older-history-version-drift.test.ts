/**
 * older-history-version-drift.test.ts — Upward paging must survive the version
 * drift that NORMAL operation guarantees.
 *
 * The bug, end to end
 * -------------------
 * - The server bumps `messageVersion` on every message insert and on tool
 *   completion.
 * - A live lifecycle patch deliberately keeps the CLIENT's version fixed: it is the
 *   measurement-cache generation for the rows on screen, and moving it would
 *   invalidate the whole window on every tool that finishes (CONTRACT.md §4.5).
 * - `loadPretextDocumentOlder` pinned the client's version on the request, and the
 *   server 409s on a mismatch.
 *
 * So the two versions had drifted by construction after the first tool call, the
 * next upward scroll 409'd, and the coordinator turned that into `status: "error"` —
 * where `loadOlder` early-returns forever. The canvas kept rendering the pages it
 * already had, so nothing looked broken; history simply never loaded again.
 *
 * This test reproduces the real sequence (load → tool completes server-side → live
 * patch → scroll up) rather than asserting the internals of the fix.
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

/**
 * Fixture ids are prefixed per suite on purpose.
 *
 * The measurement cache is module-level and keyed on (spec key, width, lod, data
 * revision) — and for a markdown body the "data" is a plain string, so there is no
 * content signature in the key. Real ids are nanoids and any content change bumps
 * `messageVersion`, so production cannot collide; two TEST files both using `m0..`
 * with the same version but different text can. Keeping the prefix unique keeps
 * suites independent regardless of run order.
 */
function message(seq: number): TreeMessage {
	return {
		id: `drift-m${seq}`,
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [{ type: "text", text: "词".repeat(60) }],
		contentText: "词".repeat(60),
		toolCalls: [],
		createdAt: "2026-07-28T00:00:00.000Z",
		children: [],
		seq,
	} as unknown as TreeMessage;
}

/**
 * A server that behaves like the real one: it owns a version that advances on its
 * own, and rejects any request that PINS a version other than the current one.
 */
function fakeServer(totalMessages: number, pageSize = 20) {
	const all = Array.from({ length: totalMessages }, (_, index) => message(index));
	const state = { version: 7, pinnedVersionsSeen: [] as (number | undefined)[] };
	const fetchPage = async (
		_narratorId: string,
		opts: { beforeSeq?: number; limit: number; messageVersion?: number },
	) => {
		if (opts.beforeSeq != null) state.pinnedVersionsSeen.push(opts.messageVersion);
		if (opts.messageVersion != null && opts.messageVersion !== state.version) {
			throw new Error("PRETEXT_DOCUMENT_CHANGED");
		}
		const slice =
			opts.beforeSeq == null
				? all.slice(-pageSize)
				: all
						.filter((entry) => (entry.seq as number) < (opts.beforeSeq as number))
						.slice(-pageSize);
		return {
			messages: slice,
			minSeq: (slice[0]?.seq as number) ?? null,
			maxSeq: (slice[slice.length - 1]?.seq as number) ?? null,
			hasNext: false,
			hasPrev: ((slice[0]?.seq as number) ?? 0) > 0,
			messageVersion: state.version,
			pruneBoundaryMessageId: null,
			prunedPercent: null,
		};
	};
	return { state, fetchPage };
}

describe("upward paging across server-side version drift", () => {
	it("keeps loading history after a tool completes server-side", async () => {
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		const server = fakeServer(60);
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", BUILD, { fetchPage: server.fetchPage }, undefined, 600);
		const loadedVersion = coordinator.getSnapshot().input?.messageVersion;
		const scrolledUp = () => ({ scrollTop: 100, pinnedToBottom: false, viewportHeight: 600 });

		// A tool finishes: the server bumps its version, and the live patch keeps the
		// client's where it is (the cache generation must not move).
		server.state.version = 8;
		coordinator.applyLivePatch((messages) => ({ messages, changed: true }), scrolledUp);
		expect(coordinator.getSnapshot().input?.messageVersion).toBe(loadedVersion);

		// The reader scrolls up. This is where it used to 409 and wedge.
		expect(await coordinator.loadOlder(BUILD, scrolledUp)).toBe(20);
		expect(coordinator.getSnapshot().status).toBe("ready");
		// No stale version is pinned on the request any more.
		expect(server.state.pinnedVersionsSeen).toEqual([undefined]);
	});

	it("keeps paging while the server version moves repeatedly", async () => {
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		const server = fakeServer(60);
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", BUILD, { fetchPage: server.fetchPage }, undefined, 600);
		const scrolledUp = () => ({ scrollTop: 100, pinnedToBottom: false, viewportHeight: 600 });

		server.state.version = 9;
		expect(await coordinator.loadOlder(BUILD, scrolledUp)).toBe(20);
		server.state.version = 15;
		expect(await coordinator.loadOlder(BUILD, scrolledUp)).toBe(20);
		const snapshot = coordinator.getSnapshot();
		expect(snapshot.status).toBe("ready");
		expect(snapshot.input?.messages.length).toBe(60);
		// The whole history is loaded, so there is nothing older left.
		expect(snapshot.hasPrev).toBe(false);
	});

	it("preserves the loaded cache generation across upward pages", async () => {
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		const { measureCache } = await import("./measure-cache");
		const server = fakeServer(60);
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", BUILD, { fetchPage: server.fetchPage }, undefined, 600);
		const loadedVersion = coordinator.getSnapshot().input?.messageVersion;

		server.state.version = 20;
		measureCache.resetStats();
		await coordinator.loadOlder(BUILD, () => ({
			scrollTop: 100,
			pinnedToBottom: false,
			viewportHeight: 600,
		}));
		// Adopting the server's newer version here would re-key every row and discard
		// the window's cached heights — the exact cost the cache exists to avoid.
		expect(coordinator.getSnapshot().input?.messageVersion).toBe(loadedVersion);
		expect(measureCache.hits).toBeGreaterThan(0);
	});
});

describe("a failed upward page leaves recoverable state", () => {
	it("stays ready and clears the retained error once a later page succeeds", async () => {
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		const server = fakeServer(60);
		let failNext = true;
		const flaky: typeof server.fetchPage = async (narratorId, opts) => {
			if (opts.beforeSeq != null && failNext) {
				failNext = false;
				throw new Error("network down");
			}
			return server.fetchPage(narratorId, opts);
		};
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", BUILD, { fetchPage: flaky }, undefined, 600);
		const scrolledUp = () => ({ scrollTop: 100, pinnedToBottom: false, viewportHeight: 600 });

		await expect(coordinator.loadOlder(BUILD, scrolledUp)).rejects.toThrow("network down");
		// The loaded window is untouched, so the list must stay usable and retryable.
		const failed = coordinator.getSnapshot();
		expect(failed.status).toBe("ready");
		expect(failed.loadingOlder).toBe(false);
		expect(failed.error?.message).toBe("network down");

		// The retry succeeds, and the diagnostic error must not ride along afterwards:
		// a "ready" snapshot carrying a stale error misreports the document's health.
		expect(await coordinator.loadOlder(BUILD, scrolledUp)).toBe(20);
		const recovered = coordinator.getSnapshot();
		expect(recovered.status).toBe("ready");
		expect(recovered.error).toBeUndefined();
	});
});
