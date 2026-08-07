import { beforeAll, describe, expect, it } from "bun:test";
import type { PretextDocumentPageResult, TreeMessage } from "@frontend/lib/api/types";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { captureCoordinatorAnchor, PretextLayoutCoordinator } from "./pretext-layout-coordinator";

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

/** Labels the adapter composes the compact marker's single line from. */
const COMPACT_LABELS = {
	compacting: "Compacting context…",
	compacted: "Context compacted",
	compactFailed: "Compact failed",
	compactOutputChars: "{count} chars",
	compactThinking: "thinking",
	compactThinkingChars: "{count} chars",
};

const compactBuildOptions = { ...buildOptions, labels: COMPACT_LABELS };

/** A document whose only message is a context-compact marker in `status`. */
function compactPage(
	status: "compacting" | "compacted" | "failed",
	outputChars?: number,
	summary?: string,
): PretextDocumentPageResult {
	return {
		messages: [
			{
				id: "compact-1",
				narratorId: "n1",
				parentToolUseId: null,
				role: "system",
				contentJson: [
					{
						type: "compact",
						status,
						...(outputChars === undefined ? {} : { outputChars }),
						...(summary === undefined ? {} : { summary }),
					},
				],
				contentText: "",
				toolCalls: [],
				createdAt: "2026-07-23T00:00:00.000Z",
				children: [],
				seq: 0,
			} as unknown as TreeMessage,
		],
		minSeq: 0,
		maxSeq: 0,
		hasNext: false,
		hasPrev: false,
		messageVersion: 3,
		pruneBoundaryMessageId: null,
		prunedPercent: null,
	};
}

/** The compact marker row's composed single line, read from the built items. */
function compactMarkerText(snapshot: {
	items?: readonly { spec: { kind: string; data: unknown } }[];
}) {
	const item = snapshot.items?.find((entry) => entry.spec.kind === "system-simple");
	const data = (item?.spec.data ?? {}) as { text?: string };
	return data.text ?? "";
}

function compactMarkerHeight(snapshot: {
	items?: readonly { spec: { kind: string }; measured: { height: number } }[];
}) {
	return snapshot.items?.find((entry) => entry.spec.kind === "system-simple")?.measured.height ?? 0;
}

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

	it("counts the live compact char total up without a refetch or a height change", async () => {
		// The server streams `compact_progress` but never re-persists the marker, so
		// the label can only advance through this in-place patch. Parity with the
		// chunked path's applyCompactProgressByMessageId.
		const coordinator = new PretextLayoutCoordinator();
		let fetchCount = 0;
		const fetchPage = async () => {
			fetchCount++;
			return compactPage("compacting", 0);
		};
		await coordinator.load("n1", compactBuildOptions, { fetchPage });
		const before = coordinator.getSnapshot();
		const markerHeight = compactMarkerHeight(before);
		expect(compactMarkerText(before)).toContain("0 chars");

		coordinator.applyCompactProgress(
			"compact-1",
			{ phase: "output", thinkingChars: 0, outputChars: 128 },
			false,
		);
		const after = coordinator.getSnapshot();
		expect(fetchCount).toBe(1); // patched in place — no network round trip
		expect(compactMarkerText(after)).toContain("128 chars");
		// Constant height is exactly why applyCompactProgress skips anchoring.
		expect(compactMarkerHeight(after)).toBe(markerHeight);
		expect(after.scrollTop).toBeUndefined();
	});

	it("ignores a compact progress tick for an unknown message or a settled marker", async () => {
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", compactBuildOptions, {
			fetchPage: async () => compactPage("compacting", 5),
		});
		const baseline = coordinator.getSnapshot();
		// Unknown message id → no-op (the marker is outside the loaded window).
		coordinator.applyCompactProgress(
			"not-loaded",
			{ phase: "output", thinkingChars: 0, outputChars: 999 },
			false,
		);
		expect(coordinator.getSnapshot()).toBe(baseline);
		// Segment flavour mismatch on a context marker → no-op.
		coordinator.applyCompactProgress(
			"compact-1",
			{ phase: "output", thinkingChars: 0, outputChars: 999 },
			true,
		);
		expect(coordinator.getSnapshot()).toBe(baseline);
		// A duplicate tick with the same count → no-op (cheap late/dup event).
		coordinator.applyCompactProgress(
			"compact-1",
			{ phase: "output", thinkingChars: 0, outputChars: 5 },
			false,
		);
		expect(coordinator.getSnapshot()).toBe(baseline);
	});

	it("leaves a finished compact marker's label alone", async () => {
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", compactBuildOptions, {
			fetchPage: async () => compactPage("compacted", undefined, "the summary"),
		});
		const settled = coordinator.getSnapshot();
		// A late tick must not resurrect a "compacting · N chars" label.
		coordinator.applyCompactProgress(
			"compact-1",
			{ phase: "output", thinkingChars: 0, outputChars: 4242 },
			false,
		);
		expect(coordinator.getSnapshot()).toBe(settled);
		expect(compactMarkerText(settled)).not.toContain("4242");
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

	it("anchors an LOD rebuild on the gesture focus point, not the viewport top", async () => {
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", buildOptions, { fetchPage: async () => page() });
		const current = coordinator.getSnapshot().index;
		if (!current) throw new Error("expected layout");
		// Reader is at the very top; the pointer is over the SECOND item.
		const scrollTop = current.itemStart(0);
		const focusOffset = current.itemStart(1) + 3;
		const viewportOffset = focusOffset - scrollTop;
		const anchor = captureCoordinatorAnchor(current, {
			scrollTop,
			viewportHeight: 720,
			pinnedToBottom: false,
			focusOffset,
		});
		const rebuilt = coordinator.rebuild({ ...buildOptions, lod: 2 }, anchor, 720);
		if (!rebuilt.index) throw new Error("expected rebuilt layout");
		// The focused content returns to the same distance below the viewport top.
		const located = rebuilt.index.itemByKey(anchor.kind === "item" ? anchor.itemKey : "");
		const targetIndex = located?.index ?? 1;
		expect(rebuilt.scrollTop).toBe(
			Math.max(0, rebuilt.index.itemStart(targetIndex) + 3 - viewportOffset),
		);
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

	/**
	 * The FONT generation rides the document revision for the same reason the KaTeX
	 * one does, one level broader: every prepared fragment carries a pixel width
	 * baked against the then-available face, so a face swap invalidates heights on
	 * math-free documents too. Without it here the measure cache would serve the
	 * pre-swap heights while the DOM repaints with the new face.
	 */
	it("carries the font generation on the documentRevision too", async () => {
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", buildOptions, { fetchPage: async () => page() });
		const manifest = coordinator.getSnapshot().manifest;
		if (!manifest) throw new Error("expected manifest");
		expect(String(manifest.documentRevision)).toContain("~f:");
	});

	/**
	 * `reset` deliberately KEEPS the prepared-block cache.
	 *
	 * It used to drop it, to stop a long session accumulating the union of every
	 * document opened. But its keys are the body TEXT plus the KaTeX/font
	 * generations — no narrator identity — so its entries are exactly as valid after
	 * a switch as before one, and it bounds itself at
	 * `PREPARED_CACHE_CHAR_CEILING` with a bulk-clear. Dropping it on switch bought
	 * no correctness and forced the returning document to re-parse every body, which
	 * is ~94% of a full measure and the largest single cost in repainting a first
	 * screen. `measureCache` was already left alone for the same reason.
	 *
	 * The memory bound is asserted here rather than assumed, because "keep it" is
	 * only defensible while something else caps it.
	 */
	it("keeps the prepared-block cache across reset, under a bounded ceiling", async () => {
		const { getPreparedMarkdownBlocks, preparedMarkdownCacheStats, PREPARED_CACHE_CHAR_CEILING } =
			await import("@shared/pretext-layout/prepared-markdown-cache");
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", buildOptions, { fetchPage: async () => page() });
		const body = "# retained body\n\nsome prose";
		const prepared = getPreparedMarkdownBlocks(body, undefined, 0);
		expect(preparedMarkdownCacheStats().size).toBeGreaterThan(0);

		coordinator.reset();
		expect(coordinator.getSnapshot().status).toBe("idle");
		// The SAME prepared array is served after the switch: this is the reuse that
		// makes a revisit cheap, and identity proves no re-parse happened.
		expect(getPreparedMarkdownBlocks(body, undefined, 0)).toBe(prepared);
		expect(preparedMarkdownCacheStats().chars).toBeLessThanOrEqual(PREPARED_CACHE_CHAR_CEILING);
	});

	/**
	 * A switch publishes the outgoing window so the next mount can adopt it, which
	 * is what turns a revisit from "refetch 283KB-1.3MB + cold measure" into a
	 * synchronous commit. Without the publish in `reset`, the route's
	 * `key={narratorId}` teardown loses the document before anything can cache it.
	 */
	it("publishes the document on reset so a later restore can adopt it", async () => {
		const { clearPretextDocumentCache, peekCachedPretextDocument } = await import(
			"./pretext-document-cache"
		);
		clearPretextDocumentCache();
		try {
			const coordinator = new PretextLayoutCoordinator();
			await coordinator.load("n1", buildOptions, { fetchPage: async () => page() });
			const loaded = coordinator.getSnapshot().input;
			if (!loaded) throw new Error("expected a loaded document");

			coordinator.reset();
			expect(peekCachedPretextDocument("n1")).toBe(loaded);

			// And a fresh coordinator adopts it without any transport at all: the
			// fetchPage below would throw if the restore path touched the network.
			const revisit = new PretextLayoutCoordinator();
			expect(
				revisit.restore("n1", buildOptions, {
					fetchPage: async () => {
						throw new Error("restore must not fetch");
					},
				}),
			).toBe(true);
			expect(revisit.getSnapshot().status).toBe("ready");
			expect(revisit.getSnapshot().index).toBeDefined();
			expect(revisit.getSnapshot().input?.messages.length).toBe(loaded?.messages.length);
		} finally {
			clearPretextDocumentCache();
		}
	});

	it("restore reports false for a narrator with nothing cached", async () => {
		const { clearPretextDocumentCache } = await import("./pretext-document-cache");
		clearPretextDocumentCache();
		const coordinator = new PretextLayoutCoordinator();
		expect(coordinator.restore("never-seen", buildOptions)).toBe(false);
		expect(coordinator.getSnapshot().status).toBe("idle");
	});

	it("drops both caches and rebuilds when the font generation moves", async () => {
		const { getPreparedMarkdownBlocks } = await import(
			"@shared/pretext-layout/prepared-markdown-cache"
		);
		const { measureCache } = await import("./measure-cache");
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", buildOptions, { fetchPage: async () => page() });
		const body = "# body\n\nprose";
		const stalePrepared = getPreparedMarkdownBlocks(body, undefined, 0);
		expect(getPreparedMarkdownBlocks(body, undefined, 0)).toBe(stalePrepared);
		expect(measureCache.size).toBeGreaterThan(0);

		expect(coordinator.invalidateFontDependentLayout()).toBe(true);
		// The stale handles carry the OLD face's baked widths, so that exact array may
		// never be served again. (Both caches are repopulated by the rebuild this
		// triggers, so a size check would just observe the new generation's entries.)
		expect(getPreparedMarkdownBlocks(body, undefined, 0)).not.toBe(stalePrepared);
		expect(coordinator.getSnapshot().status).toBe("ready");
		expect(coordinator.getSnapshot().index).toBeDefined();
	});

	it("no-ops the font invalidation before the first commit", () => {
		const coordinator = new PretextLayoutCoordinator();
		expect(coordinator.invalidateFontDependentLayout()).toBe(false);
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

	// A failed upward page used to set `status: "error"`. Since loadOlder only runs
	// while the status is "ready", ONE failure permanently disabled upward paging —
	// and the reader saw no error at all, because the already-loaded canvas kept
	// rendering. History just silently stopped loading.
	it("stays usable after a failed older page and retries successfully", async () => {
		const coordinator = new PretextLayoutCoordinator();
		let failNext = true;
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
			if (failNext) {
				failNext = false;
				throw new Error("network hiccup");
			}
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
		const view = () => ({ scrollTop: 40, pinnedToBottom: false, viewportHeight: 720 });

		await expect(coordinator.loadOlder(buildOptions, view)).rejects.toThrow("network hiccup");
		// The loaded window is untouched and still renderable, and the list is NOT
		// wedged: the status stays ready and the spinner flag is cleared.
		const afterFailure = coordinator.getSnapshot();
		expect(afterFailure.status).toBe("ready");
		expect(afterFailure.loadingOlder).toBe(false);
		expect(afterFailure.hasPrev).toBe(true);
		expect(afterFailure.items?.length).toBeGreaterThan(0);

		// The next upward gesture retries and succeeds.
		expect(await coordinator.loadOlder(buildOptions, view)).toBe(1);
		expect(coordinator.getSnapshot().status).toBe("ready");
	});

	// A second caller used to be told "0 prepended" while a page was in flight. That
	// is fine for the scroll gate but wrong for the jump path, which pages upward in
	// a loop and reads the count to decide whether to page again: a premature 0 ends
	// the jump one page short of its target, so the search hit never appears.
	it("joins an in-flight older page instead of reporting nothing prepended", async () => {
		const coordinator = new PretextLayoutCoordinator();
		const olderGate: { release: (() => void) | null } = { release: null };
		let olderFetches = 0;
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
			olderFetches++;
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
		const view = () => ({ scrollTop: 40, pinnedToBottom: false, viewportHeight: 720 });

		const first = coordinator.loadOlder(buildOptions, view);
		const joined = coordinator.loadOlder(buildOptions, view);
		olderGate.release?.();
		// Both see the same prepended count, from a SINGLE request.
		expect(await first).toBe(1);
		expect(await joined).toBe(1);
		expect(olderFetches).toBe(1);
		expect(coordinator.getSnapshot().input?.messages.map((m) => m.seq)).toEqual([1, 2]);
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

// ─────────────────────────────────────────────────────────────────────────────
// Live lifecycle patches (tool completion / reflection resolution)
// ─────────────────────────────────────────────────────────────────────────────

/** An assistant message with one tool call, enriched exactly as the API does. */
function toolMessage(seq: number, toolUseId: string, status: string): TreeMessage {
	return {
		id: `m-${seq}`,
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [
			{ type: "tool_use", id: toolUseId, name: "Bash", input: {}, status, inputJson: {} },
		],
		contentText: null,
		toolCalls: [
			{
				id: `tc-${toolUseId}`,
				narratorId: "n1",
				messageId: `m-${seq}`,
				toolUseId,
				toolName: "Bash",
				status,
				inputJson: {},
				createdAt: "2026-07-23T00:00:00.000Z",
			},
		],
		createdAt: "2026-07-23T00:00:00.000Z",
		children: [],
		seq,
	} as unknown as TreeMessage;
}

function toolPage(status: string): PretextDocumentPageResult {
	return {
		messages: [toolMessage(0, "tu-1", status)],
		minSeq: 0,
		maxSeq: 0,
		hasNext: false,
		hasPrev: false,
		messageVersion: 7,
		pruneBoundaryMessageId: null,
		prunedPercent: null,
	};
}

function loadedToolStatus(snapshot: { input?: { messages: TreeMessage[] } }): string | undefined {
	const block = snapshot.input?.messages[0]?.contentJson?.find((b) => b.type === "tool_use");
	return (block as { status?: string } | undefined)?.status;
}

describe("PretextLayoutCoordinator.applyLivePatch", () => {
	it("applies a tool status patch without a refetch and without moving messageVersion", async () => {
		const coordinator = new PretextLayoutCoordinator();
		let fetchCount = 0;
		await coordinator.load("n1", buildOptions, {
			fetchPage: async () => {
				fetchCount++;
				return toolPage("running");
			},
		});
		expect(loadedToolStatus(coordinator.getSnapshot())).toBe("running");

		const applied = coordinator.applyLivePatch((messages) => ({
			messages: messages.map((msg) => ({
				...msg,
				contentJson: msg.contentJson.map((block) =>
					block.type === "tool_use" ? { ...block, status: "success" } : block,
				),
			})) as TreeMessage[],
			changed: true,
		}));

		expect(applied).toBe(true);
		const snap = coordinator.getSnapshot();
		expect(snap.status).toBe("ready");
		expect(loadedToolStatus(snap)).toBe("success");
		// The whole point: no network round-trip, and the document version is
		// untouched so upward pagination and the measure cache stay coherent.
		expect(fetchCount).toBe(1);
		expect(snap.input?.messageVersion).toBe(7);
		expect(snap.input?.messages).toHaveLength(1);
	});

	it("skips the rebuild entirely when the patch reports no change", async () => {
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", buildOptions, { fetchPage: async () => toolPage("running") });
		const before = coordinator.getSnapshot();
		let emits = 0;
		coordinator.subscribe(() => emits++);

		const applied = coordinator.applyLivePatch((messages) => ({
			messages: messages as TreeMessage[],
			changed: false,
		}));

		expect(applied).toBe(false);
		expect(emits).toBe(0);
		// Same index object ⇒ no rebuild happened at all (an event for a tool
		// outside the loaded window must cost nothing).
		expect(coordinator.getSnapshot().index).toBe(before.index);
	});

	it("no-ops before any document is loaded", () => {
		const coordinator = new PretextLayoutCoordinator();
		const applied = coordinator.applyLivePatch((messages) => ({
			messages: messages as TreeMessage[],
			changed: true,
		}));
		expect(applied).toBe(false);
		expect(coordinator.getSnapshot().status).toBe("idle");
	});

	it("preserves the viewport by anchoring the rebuild when the patched card resizes", async () => {
		// A tool finishing changes its card's height. The exact list's protected
		// invariant is that a committed row never visually jumps without a user
		// action, so the patch must emit a scroll correction derived from the anchor.
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load(
			"n1",
			buildOptions,
			{ fetchPage: async () => toolPage("running") },
			undefined,
			720,
		);
		const applied = coordinator.applyLivePatch(
			(messages) => ({
				messages: messages.map((msg) => ({
					...msg,
					contentJson: msg.contentJson.map((block) =>
						block.type === "tool_use"
							? { ...block, status: "success", outputJson: "line\nline\nline" }
							: block,
					),
				})) as TreeMessage[],
				changed: true,
			}),
			() => ({ scrollTop: 0, pinnedToBottom: true, viewportHeight: 720 }),
		);
		expect(applied).toBe(true);
		const snap = coordinator.getSnapshot();
		// Pinned reader → a bottom-anchored correction keeps the newest content in view.
		expect(snap.scrollTopAnchorKind).toBe("bottom");
		expect(snap.scrollTop).toBeGreaterThanOrEqual(0);
	});

	it("emits no scroll correction when no live view is supplied", async () => {
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", buildOptions, { fetchPage: async () => toolPage("running") });
		coordinator.applyLivePatch((messages) => ({
			messages: messages.map((msg) => ({ ...msg, contentText: "x" })) as TreeMessage[],
			changed: true,
		}));
		expect(coordinator.getSnapshot().scrollTop).toBeUndefined();
	});
});
