import { beforeAll, describe, expect, it } from "bun:test";
import type { PretextDocumentPageResult, TreeMessage } from "@frontend/lib/api/types";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { PretextLayoutCoordinator } from "./pretext-layout-coordinator";

beforeAll(() => {
	installCanvasStub();
});

function message(seq: number, text: string): TreeMessage {
	return {
		id: `m-${seq}`,
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [{ type: "text", text }],
		contentText: text,
		toolCalls: [],
		createdAt: "2026-07-23T00:00:00.000Z",
		children: [],
		seq,
	} as TreeMessage;
}

function page(): PretextDocumentPageResult {
	return {
		messages: [message(0, "one"), message(1, "two")],
		minSeq: 0,
		maxSeq: 1,
		hasNext: false,
		hasPrev: false,
		messageVersion: 3,
		pruneBoundaryMessageId: "m-0",
		prunedPercent: 25,
	};
}

const buildOptions = {
	lod: 5 as const,
	widthBucket: "860",
	contentWidth: 860,
	viewportHeight: 720,
	topPadding: 16,
	bottomPadding: 16,
	gap: 4,
};

describe("PretextLayoutCoordinator", () => {
	it("keeps the old document unavailable until the complete input is laid out", async () => {
		const coordinator = new PretextLayoutCoordinator();
		const states: string[] = [];
		coordinator.subscribe(() => states.push(coordinator.getSnapshot().status));
		const result = await coordinator.load("n1", buildOptions, {
			fetchPage: async () => page(),
		});
		expect(result.status).toBe("ready");
		expect(result.index?.totalHeight).toBeGreaterThan(32);
		expect(result.items ?? []).toHaveLength(result.manifest?.items.length ?? 0);
		expect(result.input?.pruneBoundaryMessageId).toBe("m-0");
		expect(result.input?.prunedPercent).toBe(25);
		expect(result.items?.some((item) => item.spec.kind === "prune-divider")).toBe(true);
		expect((result.items ?? []).map((item) => item.measured.height)).toEqual(
			result.manifest?.items.map((item) => item.height) ?? [],
		);
		expect(states).toEqual(["loading", "ready"]);
	});

	it("coalesces a concurrent same-narrator load into one fetch at the latest options", async () => {
		const coordinator = new PretextLayoutCoordinator();
		let fetchCount = 0;
		const gate: { release: (() => void) | null } = { release: null };
		const opened = new Promise<void>((r) => {
			gate.release = r;
		});
		const fetchPage = async () => {
			fetchCount++;
			await opened; // hold the fetch open so both load() calls overlap
			return page();
		};
		// First load (e.g. mount at default width) starts the fetch.
		const p1 = coordinator.load("n1", buildOptions, { fetchPage }, undefined, 600);
		// A build-option change (e.g. ResizeObserver updates width/height) re-runs the
		// effect while the fetch is in flight. It must NOT start a second fetch.
		const wideOptions = { ...buildOptions, widthBucket: "1200", contentWidth: 1200 };
		const p2 = coordinator.load("n1", wideOptions, { fetchPage }, undefined, 900);
		gate.release?.();
		await Promise.all([p1, p2]);
		expect(fetchCount).toBe(1); // only one network fetch (coalesced)
		const snap = coordinator.getSnapshot();
		expect(snap.status).toBe("ready");
		// Committed at the LATEST options (the resized width), not the initial ones.
		expect(snap.manifest?.widthBucket).toBe("1200");
	});

	it("still refetches when forceReload is set even if a load is in flight", async () => {
		const coordinator = new PretextLayoutCoordinator();
		let fetchCount = 0;
		const fetchPage = async () => {
			fetchCount++;
			return page();
		};
		await coordinator.load("n1", buildOptions, { fetchPage });
		await coordinator.load("n1", buildOptions, { fetchPage }, undefined, 0, { forceReload: true });
		expect(fetchCount).toBe(2);
	});

	it("sizes the first-screen tail fetch by the initiating LOD", async () => {
		const highLod = new PretextLayoutCoordinator();
		let highLimit = 0;
		await highLod.load(
			"n1",
			{ ...buildOptions, lod: 5 },
			{
				fetchPage: async (_id, opts) => {
					highLimit = opts.limit;
					return page();
				},
			},
		);
		expect(highLimit).toBe(40); // LOD 5 → capped tail page

		const lowLod = new PretextLayoutCoordinator();
		let lowLimit = 0;
		await lowLod.load(
			"n1",
			{ ...buildOptions, lod: 2 },
			{
				fetchPage: async (_id, opts) => {
					lowLimit = opts.limit;
					return page();
				},
			},
		);
		expect(lowLimit).toBe(100); // LOD 2 → large tail page (collapsed rows)
	});

	it("keeps older (reverse-scroll) pages at pageSize, not the first-screen size", async () => {
		const coordinator = new PretextLayoutCoordinator();
		const limits: number[] = [];
		const fetchPage = async (_id: string, opts: { beforeSeq?: number; limit: number }) => {
			limits.push(opts.limit);
			if (opts.beforeSeq == null) {
				// Tail page (LOD 5 → 40), with older history available.
				return {
					messages: [message(50, "a"), message(51, "b")],
					minSeq: 50,
					maxSeq: 51,
					hasNext: false,
					hasPrev: true,
					messageVersion: 3,
					pruneBoundaryMessageId: null,
					prunedPercent: null,
				} as PretextDocumentPageResult;
			}
			return {
				messages: [message(48, "c"), message(49, "d")],
				minSeq: 48,
				maxSeq: 49,
				hasNext: true,
				hasPrev: false,
				messageVersion: 3,
				pruneBoundaryMessageId: null,
				prunedPercent: null,
			} as PretextDocumentPageResult;
		};
		await coordinator.load("n1", { ...buildOptions, lod: 5 }, { fetchPage, pageSize: 100 });
		await coordinator.loadOlder({ ...buildOptions, lod: 5 }, () => ({
			scrollTop: 0,
			pinnedToBottom: false,
			viewportHeight: 720,
		}));
		expect(limits[0]).toBe(40); // first screen: LOD-derived
		expect(limits[1]).toBe(100); // older page: pageSize
	});

	it("rebuilds the same document for a new LOD and returns an anchor correction", async () => {
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", buildOptions, { fetchPage: async () => page() });
		const current = coordinator.getSnapshot().index;
		if (!current) throw new Error("expected layout");
		const anchor = {
			kind: "item" as const,
			itemKey: current.manifest.items[0]?.itemKey ?? "",
			offsetWithinItem: 4,
			fallbackIndex: 0,
		};
		const rebuilt = coordinator.rebuild({ ...buildOptions, lod: 2 }, anchor, 720);
		expect(rebuilt.status).toBe("ready");
		if (!rebuilt.index || !rebuilt.manifest) throw new Error("expected rebuilt layout");
		expect(rebuilt.scrollTop).toBe(rebuilt.index.itemStart(0) + 4);
		expect(rebuilt.scrollTopAnchorKind).toBe("item");
		expect(rebuilt.manifest.lod).toBe(2);
	});

	it("marks bottom corrections separately so a footer can be applied only there", async () => {
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", buildOptions, { fetchPage: async () => page() });
		const rebuilt = coordinator.rebuild(
			buildOptions,
			{ kind: "bottom", distanceFromBottom: 0 },
			720,
		);
		expect(rebuilt.scrollTopAnchorKind).toBe("bottom");
	});

	// The measure cache keys on `documentRevision`, NOT on `layoutRevision` (which
	// only reaches the manifest identity). The KaTeX revision therefore has to ride
	// on the document revision, or heights and prepared blocks measured before the
	// runtime arrived are served from cache afterwards — a display formula stays an
	// `inline` literal-text block, so the row keeps the wrong height and never
	// paints the formula.
	it("carries the KaTeX revision on the documentRevision, not just the layoutRevision", async () => {
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", buildOptions, { fetchPage: async () => page() });
		const manifest = coordinator.getSnapshot().manifest;
		if (!manifest) throw new Error("expected manifest");
		expect(String(manifest.documentRevision)).toContain("~k:");
		// The message version must remain the leading component so an edit still
		// invalidates independently of KaTeX.
		expect(String(manifest.documentRevision).startsWith(`${page().messageVersion}`)).toBe(true);
	});

	it("clamps a non-bottom anchor when the anchored item becomes shorter", async () => {
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", buildOptions, { fetchPage: async () => page() });
		const current = coordinator.getSnapshot().index;
		if (!current) throw new Error("expected layout");
		const rebuilt = coordinator.rebuild(
			buildOptions,
			{
				kind: "item",
				itemKey: current.manifest.items[0]?.itemKey ?? "",
				offsetWithinItem: Number.MAX_SAFE_INTEGER,
				fallbackIndex: 0,
			},
			720,
		);
		if (!rebuilt.index) throw new Error("expected rebuilt layout");
		expect(rebuilt.scrollTop).toBe(rebuilt.index.itemEnd(0));
	});

	it("loads the tail first, then prepends older pages while pinning the visible top item", async () => {
		const coordinator = new PretextLayoutCoordinator();
		const fetchPage = async (
			_id: string,
			opts: { afterSeq?: number; beforeSeq?: number; limit: number },
		): Promise<PretextDocumentPageResult> => {
			if (opts.beforeSeq == null) {
				// Tail page (newest two messages) with older history available.
				return {
					messages: [message(2, "three"), message(3, "four")],
					minSeq: 2,
					maxSeq: 3,
					hasNext: false,
					hasPrev: true,
					messageVersion: 3,
					pruneBoundaryMessageId: null,
					prunedPercent: null,
				};
			}
			// One older page; nothing older remains after it.
			return {
				messages: [message(0, "one"), message(1, "two")],
				minSeq: 0,
				maxSeq: 1,
				hasNext: true,
				hasPrev: false,
				messageVersion: 3,
				pruneBoundaryMessageId: null,
				prunedPercent: null,
			};
		};

		const tail = await coordinator.load("n1", buildOptions, { fetchPage });
		expect(tail.hasPrev).toBe(true);
		expect(tail.input?.messages.map((m) => m.seq)).toEqual([2, 3]);
		const beforeIndex = coordinator.getSnapshot().index;
		if (!beforeIndex) throw new Error("expected tail index");
		const previousTotalHeight = beforeIndex.totalHeight;
		// The previously-first visible item (seq 2), which the reader is looking at.
		const anchorKey = beforeIndex.manifest.items[0]?.itemKey ?? "";
		const previousAnchorStart = beforeIndex.itemStart(0);
		// Reader is scrolled a bit into the first item (not pinned to the bottom).
		const scrollTopBefore = previousAnchorStart + 5;

		const added = await coordinator.loadOlder(buildOptions, () => ({
			scrollTop: scrollTopBefore,
			pinnedToBottom: false,
			viewportHeight: 720,
		}));
		expect(added).toBe(2);
		const snap = coordinator.getSnapshot();
		expect(snap.status).toBe("ready");
		expect(snap.hasPrev).toBe(false);
		expect(snap.loadingOlder).toBe(false);
		expect(snap.input?.messages.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
		if (!snap.index) throw new Error("expected extended index");
		// Height arithmetic: the whole existing document (incl. the anchored item)
		// shifted down by exactly the prepended height. The correction preserves the
		// reader's position — scrollTop moved by the same delta.
		const heightDelta = snap.index.totalHeight - previousTotalHeight;
		expect(heightDelta).toBeGreaterThan(0);
		expect(snap.scrollTop).toBe(scrollTopBefore + heightDelta);
		expect(snap.scrollTopAnchorKind).toBe("item");
		// Cross-check against the anchored item's new position: it kept its key and
		// moved down by the same delta, so the reader still sees the same content.
		const restored = snap.index.itemByKey(anchorKey);
		expect(restored).toBeDefined();
		expect(snap.index.itemStart(restored?.index ?? 0)).toBe(previousAnchorStart + heightDelta);
		expect(snap.scrollTop).toBe(snap.index.itemStart(restored?.index ?? 0) + 5);
	});

	it("keeps the newest content pinned to the bottom during first-screen fill", async () => {
		const coordinator = new PretextLayoutCoordinator();
		const fetchPage = async (
			_id: string,
			opts: { beforeSeq?: number; limit: number },
		): Promise<PretextDocumentPageResult> =>
			opts.beforeSeq == null
				? {
						messages: [message(2, "three"), message(3, "four")],
						minSeq: 2,
						maxSeq: 3,
						hasNext: false,
						hasPrev: true,
						messageVersion: 3,
						pruneBoundaryMessageId: null,
						prunedPercent: null,
					}
				: {
						messages: [message(0, "one"), message(1, "two")],
						minSeq: 0,
						maxSeq: 1,
						hasNext: true,
						hasPrev: false,
						messageVersion: 3,
						pruneBoundaryMessageId: null,
						prunedPercent: null,
					};
		await coordinator.load("n1", buildOptions, { fetchPage });
		// Pinned to the bottom (short first screen): fill must keep the bottom pinned.
		const viewportHeight = 720;
		const added = await coordinator.loadOlder(buildOptions, () => ({
			scrollTop: 0,
			pinnedToBottom: true,
			viewportHeight,
		}));
		expect(added).toBe(2);
		const snap = coordinator.getSnapshot();
		if (!snap.index) throw new Error("expected extended index");
		expect(snap.scrollTopAnchorKind).toBe("bottom");
		expect(snap.scrollTop).toBe(Math.max(0, snap.index.totalHeight - viewportHeight));
	});

	it("does not fetch older pages when hasPrev is false", async () => {
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", buildOptions, { fetchPage: async () => page() });
		// hasPrev is false from page(); loadOlder must be a no-op.
		const added = await coordinator.loadOlder(buildOptions);
		expect(added).toBe(0);
	});

	it("clears the loadingOlder flag even when a rebuild bumps the generation mid-fetch", async () => {
		const coordinator = new PretextLayoutCoordinator();
		const olderGate: { release: (() => void) | null } = { release: null };
		const fetchPage = async (
			_id: string,
			opts: { beforeSeq?: number; limit: number },
		): Promise<PretextDocumentPageResult> => {
			if (opts.beforeSeq == null) {
				return {
					messages: [message(2, "three")],
					minSeq: 2,
					maxSeq: 2,
					hasNext: false,
					hasPrev: true,
					messageVersion: 3,
					pruneBoundaryMessageId: null,
					prunedPercent: null,
				};
			}
			await new Promise<void>((resolve) => {
				olderGate.release = resolve;
			});
			return {
				messages: [message(1, "two")],
				minSeq: 1,
				maxSeq: 1,
				hasNext: true,
				hasPrev: false,
				messageVersion: 3,
				pruneBoundaryMessageId: null,
				prunedPercent: null,
			};
		};
		await coordinator.load("n1", buildOptions, { fetchPage });
		const older = coordinator.loadOlder(buildOptions);
		// A concurrent LOD rebuild bumps the generation and commits a snapshot while
		// the older-page fetch is still pending (captures loadingOlder=true).
		coordinator.rebuild({ ...buildOptions, lod: 2 }, undefined, 720);
		expect(coordinator.getSnapshot().loadingOlder).toBe(true);
		olderGate.release?.();
		await older;
		// The stale older fetch is discarded (generation moved on) but the spinner
		// flag must not stay stuck on.
		expect(coordinator.getSnapshot().loadingOlder).toBe(false);
	});
});
