/**
 * streaming-in-document.test.ts — Live streaming output is a DOCUMENT ROW.
 *
 * These tests pin the behaviour that motivated removing the streaming overlay:
 *
 * 1. Live output cannot vanish. The overlay was retired by a 3s timeout, which also
 *    fired when a structural reload had merely been DEFERRED (the reader scrolled
 *    up) — clearing live text while its replacement had not been loaded. As a
 *    document row the only thing that removes it is a real replacement.
 * 2. Publishing / growing / clearing the row leaves the PERSISTED snapshot alone, so
 *    pagination arithmetic and version checks never see synthetic content, and every
 *    committed row keeps its cached measurement.
 * 3. A reader who has scrolled up is not pushed around while the row grows.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

type Loaded = Awaited<ReturnType<typeof load>>;

async function load() {
	const [coordinator, handoff, cache] = await Promise.all([
		import("./pretext-layout-coordinator"),
		import("./streaming-handoff"),
		import("./measure-cache"),
	]);
	return { ...coordinator, ...handoff, measureCache: cache.measureCache };
}

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

function message(seq: number, role: "user" | "assistant", text: string): TreeMessage {
	return {
		id: `m${seq}`,
		narratorId: "n1",
		parentToolUseId: null,
		role,
		contentJson: [{ type: "text", text }],
		contentText: text,
		toolCalls: [],
		createdAt: "2026-07-28T00:00:00.000Z",
		children: [],
		seq,
	} as unknown as TreeMessage;
}

function streamingRow(chars: number): TreeMessage {
	const text = "词".repeat(chars);
	return {
		id: "__streaming__",
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [{ type: "text", id: "streaming:text:0", text }],
		contentText: null,
		toolCalls: [],
		createdAt: "2026-07-28T00:00:00.000Z",
		children: [],
		seq: 999_999,
	} as unknown as TreeMessage;
}

function page(messages: readonly TreeMessage[], messageVersion: number) {
	return {
		messages: [...messages],
		messageVersion,
		hasPrev: true,
		maxSeq: messages.length - 1,
	};
}

async function loadedCoordinator(mod: Loaded, messages: readonly TreeMessage[], version = 7) {
	const coordinator = new mod.PretextLayoutCoordinator();
	await coordinator.load(
		"n1",
		BUILD,
		{ fetchPage: async () => page(messages, version) as never },
		undefined,
		600,
	);
	return coordinator;
}

const history = Array.from({ length: 20 }, (_, index) =>
	message(index, "assistant", "词".repeat(120)),
);
const atBottom = () => ({ scrollTop: 0, pinnedToBottom: true, viewportHeight: 600 });
const scrolledUp = () => ({ scrollTop: 300, pinnedToBottom: false, viewportHeight: 600 });

function streamingRowCount(items: readonly { spec: { key: string } }[]): number {
	return items.filter((item) => item.spec.key.startsWith("__streaming__")).length;
}

describe("live streaming output survives a deferred reload", () => {
	it("stays in the document while the reply is not yet persisted", async () => {
		const mod = await load();
		// The reader scrolled up, so the structural reload is withheld and the document
		// will NOT gain the assistant reply. The old overlay cleared itself after 3s
		// here, leaving nothing on screen at all.
		const coordinator = await loadedCoordinator(mod, [...history, message(20, "user", "请解释")]);
		for (const chars of [50, 400, 1200, 3000]) {
			coordinator.setStreamingMessage(streamingRow(chars), scrolledUp);
		}
		const snapshot = coordinator.getSnapshot();
		expect(streamingRowCount(snapshot.items ?? [])).toBeGreaterThan(0);
		expect(
			mod.isStreamingMessageSuperseded({
				streamingMessage: snapshot.streamingMessage,
				committedMessages: snapshot.input?.messages ?? [],
			}),
		).toBe(false);
	});

	it("is only superseded once the replacement is actually in the document", async () => {
		const mod = await load();
		const withReply = [...history, message(20, "user", "请解释"), message(21, "assistant", "回答")];
		const coordinator = await loadedCoordinator(mod, withReply, 8);
		coordinator.setStreamingMessage(streamingRow(300), atBottom);
		const snapshot = coordinator.getSnapshot();
		expect(
			mod.isStreamingMessageSuperseded({
				streamingMessage: snapshot.streamingMessage,
				committedMessages: snapshot.input?.messages ?? [],
			}),
		).toBe(true);
		// Retiring it now cannot open a blank window: the replacement is already laid out.
		coordinator.setStreamingMessage(null, atBottom);
		const after = coordinator.getSnapshot();
		expect(streamingRowCount(after.items ?? [])).toBe(0);
		expect(after.input?.messages.some((entry) => entry.id === "m21")).toBe(true);
	});
});

describe("the streaming row does not disturb the persisted document", () => {
	it("adds a row without touching the persisted snapshot or version", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod, history);
		const before = coordinator.getSnapshot();
		coordinator.setStreamingMessage(streamingRow(200), atBottom);
		const after = coordinator.getSnapshot();
		expect(after.items?.length).toBe((before.items?.length ?? 0) + 1);
		// Pagination arithmetic and version checks must never see the synthetic row.
		expect(after.input?.messages.length).toBe(history.length);
		expect(after.input?.messageVersion).toBe(before.input?.messageVersion);
		expect(after.hasPrev).toBe(before.hasPrev);
		expect(after.streamingMessage?.id).toBe("__streaming__");
	});

	it("re-measures only the streaming row as it grows", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod, history);
		coordinator.setStreamingMessage(streamingRow(200), atBottom);
		mod.measureCache.resetStats();
		for (let frame = 1; frame <= 5; frame++) {
			coordinator.setStreamingMessage(streamingRow(200 + frame * 100), atBottom);
		}
		// Every committed row is served from cache on every frame; the growing row is
		// measured outside the cache (its content changes) and so records no misses.
		expect(mod.measureCache.hits).toBe(history.length * 5);
		expect(mod.measureCache.misses).toBe(0);
	});

	it("restores the exact original layout when cleared", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod, history);
		const before = coordinator.getSnapshot();
		coordinator.setStreamingMessage(streamingRow(900), atBottom);
		coordinator.setStreamingMessage(null, atBottom);
		const after = coordinator.getSnapshot();
		expect(after.items?.length).toBe(before.items?.length);
		expect(after.index?.totalHeight).toBe(before.index?.totalHeight);
		expect(after.streamingMessage).toBe(null);
	});

	it("reports no change when the same row object is published twice", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod, history);
		const row = streamingRow(120);
		expect(coordinator.setStreamingMessage(row, atBottom)).toBe(true);
		expect(coordinator.setStreamingMessage(row, atBottom)).toBe(false);
	});

	it("clears the row on reset (narrator switch)", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod, history);
		coordinator.setStreamingMessage(streamingRow(200), atBottom);
		coordinator.reset();
		expect(coordinator.getSnapshot().streamingMessage ?? null).toBe(null);
	});
});

describe("a scrolled-up reader is not moved by streaming growth", () => {
	it("holds the viewport steady across a large append", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod, history);
		coordinator.setStreamingMessage(streamingRow(100), scrolledUp);
		coordinator.setStreamingMessage(streamingRow(4000), scrolledUp);
		const snapshot = coordinator.getSnapshot();
		// The correction returns the reader to the position they were reading at.
		expect(snapshot.scrollTopAnchorKind).toBe("item");
		expect(Math.abs((snapshot.scrollTop ?? 0) - 300)).toBeLessThan(1.5);
	});
});
