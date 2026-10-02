import { describe, expect, it } from "bun:test";
import { buildPretextLayoutIndex, type PretextLayoutManifest } from "@shared/pretext-layout";
import { NarratorWSManager } from "../../../lib/narrator-ws-manager";
import { shellModule, shellSource } from "./guard-source";
import { sliceBracketedRegion } from "./source-slice";
import {
	resolvePretextDocumentView,
	resolveRebuildView,
	shouldForcePretextDocumentLoad,
} from "./usePretextDocument";
import {
	buildExactCatchUpCursor,
	buildExactMessageSnapshot,
	hasRenderableExactLayout,
	isCompactMarkerMessage,
	resolveExactCatchUpRevisionDelta,
	shouldReloadExactDocument,
} from "./vlist-exact-document";
import {
	buildExactListLayout,
	computeToolRunFrames,
	isFramedRunItem,
	resolveRowHitHeight,
} from "./vlist-exact-layout";
import { applyExactScrollCorrection } from "./vlist-exact-scroll";
import type { VListItem } from "./vlist-pipeline";

function makeManifest(): PretextLayoutManifest {
	return {
		layoutRevision: "exact-test",
		documentRevision: 1,
		lod: 5,
		widthBucket: "800",
		metrics: { topPadding: 16, itemGap: 4, bottomPadding: 16 },
		items: [
			{
				itemKey: "m1-bubble",
				firstSeq: 1,
				lastSeq: 1,
				sourceMessageIds: ["m1"],
				kind: "message-bubble",
				height: 40,
			},
			{
				itemKey: "m2-tool",
				firstSeq: 2,
				lastSeq: 3,
				sourceMessageIds: ["m2", "m3"],
				kind: "tool-run",
				height: 80,
			},
		],
	};
}

describe("PretextExactMessageList", () => {
	it("projects the shared prefix index into absolute-position geometry without estimates", () => {
		const index = buildPretextLayoutIndex(makeManifest());
		const layout = buildExactListLayout(index);
		if (!layout) throw new Error("expected exact layout");
		expect(layout.totalHeight).toBe(156);
		expect(layout.items).toEqual([
			{ top: 16, height: 40, bottom: 56 },
			{ top: 60, height: 80, bottom: 140 },
		]);
	});

	it("extends each row's hit box over the gap below it so the canvas has no bare strips", () => {
		// itemGap 4, but item 0 opens a wider SEGMENT_GAP-style boundary (12).
		const manifest: PretextLayoutManifest = {
			...makeManifest(),
			items: [
				{ ...makeManifest().items[0], gapAfter: 12 },
				makeManifest().items[1],
			] as PretextLayoutManifest["items"],
		};
		const layout = buildExactListLayout(buildPretextLayoutIndex(manifest));
		if (!layout) throw new Error("expected exact layout");
		// item 0: top 16 height 40 → next starts at 68 (16+40+12) ⇒ hit 52
		expect(layout.items[1].top).toBe(68);
		expect(resolveRowHitHeight(layout.items, 0, layout.totalHeight)).toBe(52);
		// last item absorbs the trailing bottomPadding: 164 - 68 = 96 (height 80)
		expect(layout.totalHeight).toBe(164);
		expect(resolveRowHitHeight(layout.items, 1, layout.totalHeight)).toBe(96);
	});

	it("uses the base item gap for ordinary boundaries", () => {
		const layout = buildExactListLayout(buildPretextLayoutIndex(makeManifest()));
		if (!layout) throw new Error("expected exact layout");
		// itemGap 4 ⇒ 40 + 4
		expect(resolveRowHitHeight(layout.items, 0, layout.totalHeight)).toBe(44);
	});

	it("never shrinks a row below its own height (zero gap, bad index, missing data)", () => {
		const items = [
			{ top: 16, height: 40, bottom: 56 },
			// gapAfter 0 (consecutive frameless in-run cards): hit == own height
			{ top: 56, height: 30, bottom: 86 },
		];
		expect(resolveRowHitHeight(items, 0, 102)).toBe(40);
		expect(resolveRowHitHeight(items, 1, 102)).toBe(46);
		// A totalHeight behind the row (inconsistent input) must not produce a
		// negative / shrunken box.
		expect(resolveRowHitHeight(items, 1, 10)).toBe(30);
		expect(resolveRowHitHeight(items, 1, Number.NaN)).toBe(30);
		// Out of range → 0 (nothing to render).
		expect(resolveRowHitHeight(items, 9, 102)).toBe(0);
		expect(resolveRowHitHeight([], 0, 0)).toBe(0);
	});

	it("adds footer height only to bottom-anchor corrections", () => {
		expect(applyExactScrollCorrection(120, "item", 64)).toBe(120);
		expect(applyExactScrollCorrection(120, "bottom", 64)).toBe(184);
	});

	it("reloads for a newer revision only once an index exists and the reader is at the bottom", () => {
		// Pinned to the bottom: a newer persisted revision rebuilds immediately.
		expect(shouldReloadExactDocument(4, 3, true, true)).toBe(true);
		// Same revision: nothing to apply regardless of scroll position.
		expect(shouldReloadExactDocument(3, 3, true, true)).toBe(false);
		// No index yet: the initial load path owns this, not the reload gate.
		expect(shouldReloadExactDocument(4, 3, false, true)).toBe(false);
		// Scrolled up (reading history): defer the structural reload so the reader
		// is not snapped back to the tail; it fires when they return to the bottom.
		expect(shouldReloadExactDocument(4, 3, true, false)).toBe(false);
	});

	it("counts a multi-message catch-up once so the next structural event reloads", () => {
		let messageRevision = 10;
		let appliedRevision = 10;
		const catchUpDelta = resolveExactCatchUpRevisionDelta({
			initialSync: false,
			topLevelCount: 2,
			applied: true,
			orphanChildrenCount: 0,
			subagentActivitiesCount: 0,
		});

		expect(catchUpDelta).toEqual({ messageRevisionDelta: 1, appliedRevisionDelta: 1 });
		messageRevision += catchUpDelta.messageRevisionDelta;
		appliedRevision += catchUpDelta.appliedRevisionDelta;
		expect(shouldReloadExactDocument(messageRevision, appliedRevision, true, true)).toBe(false);

		// The following structural event gets its own revision and must not be mistaken
		// for an already-applied catch-up message.
		messageRevision += 1;
		expect(shouldReloadExactDocument(messageRevision, appliedRevision, true, true)).toBe(true);
	});

	it("forces a fresh document load once per explicit reload token", () => {
		expect(shouldForcePretextDocumentLoad(1, 0)).toBe(true);
		expect(shouldForcePretextDocumentLoad(1, 1)).toBe(false);
		expect(shouldForcePretextDocumentLoad(2, 1)).toBe(true);
	});

	it("recognizes compact / segment_compact markers for the in-place insert path", () => {
		// These markers get the in-place treatment (append at the tail, insert
		// mid-window, live-patch on the status flip) instead of the deferred reload.
		expect(
			isCompactMarkerMessage({
				contentJson: [{ type: "compact", status: "compacting" }],
			} as never),
		).toBe(true);
		expect(
			isCompactMarkerMessage({
				contentJson: [{ type: "segment_compact", status: "compacted" }],
			} as never),
		).toBe(true);
		// Ordinary messages and the OTHER structural inserts must not take that path.
		expect(isCompactMarkerMessage({ contentJson: [{ type: "text" }] } as never)).toBe(false);
		expect(isCompactMarkerMessage({ contentJson: [{ type: "ask_in_passing" }] } as never)).toBe(
			false,
		);
		expect(isCompactMarkerMessage({ contentJson: [{ type: "context_cleared" }] } as never)).toBe(
			false,
		);
		expect(isCompactMarkerMessage(undefined)).toBe(false);
		expect(isCompactMarkerMessage({ contentJson: null } as never)).toBe(false);
	});

	it("prefers the synchronous live scroll view when capturing a rebuild anchor", () => {
		const fallback = { scrollTop: 120, viewportHeight: 600, pinnedToBottom: false };
		const live = { scrollTop: 480, viewportHeight: 640, pinnedToBottom: true };
		expect(resolvePretextDocumentView(fallback, () => live)).toBe(live);
		expect(resolvePretextDocumentView(fallback)).toBe(fallback);
	});

	it("honors the gesture focus point only for an LOD switch", () => {
		const view = { scrollTop: 480, viewportHeight: 640, pinnedToBottom: false, focusOffset: 720 };
		// An LOD switch is the gesture: keep the point the user is pointing at.
		expect(resolveRebuildView(view, true)).toBe(view);
		// Any other rebuild (width change, live patch, older page) fires without the
		// user pointing at anything — a stale pointer must not shift the document.
		expect(resolveRebuildView(view, false).focusOffset).toBeUndefined();
		// No focus in play → the same object, so the identity-sensitive callers below
		// see no spurious change.
		const plain = { scrollTop: 480, viewportHeight: 640, pinnedToBottom: false };
		expect(resolveRebuildView(plain, false)).toBe(plain);
	});

	it("keeps the previous complete layout renderable while replacement input is loading", () => {
		const index = buildPretextLayoutIndex(makeManifest());
		expect(hasRenderableExactLayout(index, 2, 2)).toBe(true);
		expect(hasRenderableExactLayout(index, 1, 2)).toBe(false);
		expect(hasRenderableExactLayout(undefined, 0, 0)).toBe(false);
	});

	it("seeds reconnect catch-up from the last loaded top-level message", () => {
		expect(buildExactCatchUpCursor([{ id: "m1" }, { id: "m2" }])).toEqual({
			parentLastMessageId: "m2",
		});
		expect(buildExactCatchUpCursor([{ id: "m1" }, {}, { id: null }])).toEqual({
			parentLastMessageId: "m1",
		});
		expect(buildExactCatchUpCursor([])).toBeUndefined();
	});

	it("pairs exact document cursor and version, including empty snapshots", () => {
		expect(buildExactMessageSnapshot([{ id: "m1" }, { id: "m2" }], 5)).toEqual({
			cursor: { parentLastMessageId: "m2" },
			messageVersion: 5,
		});
		expect(buildExactMessageSnapshot([], 0)).toEqual({
			cursor: undefined,
			messageVersion: 0,
		});
		expect(buildExactMessageSnapshot([{ id: "m1" }], undefined)).toBeUndefined();
	});

	it("sends the exact REST coordinate even after a shared panel subscription advances", () => {
		const manager = new NarratorWSManager();
		manager.subscribe(["n1"], { kind: "panel" });
		manager.updateCatchUpCursor("n1", { parentLastMessageId: "panel-new" });
		manager.updateMessageVersion("n1", 6);
		const handle = manager.subscribe(["n1"], {
			kind: "messages",
			initialMessageSnapshot: buildExactMessageSnapshot([{ id: "exact-old" }], 5),
		});
		const sent: Array<Record<string, unknown>> = [];
		const internals = manager as unknown as {
			ws: { readyState: number; send: (payload: string) => void };
			_sendSubscribe: (subscription: typeof handle, narratorIds: string[]) => void;
		};
		internals.ws = {
			readyState: WebSocket.OPEN,
			send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>),
		};

		internals._sendSubscribe(handle, ["n1"]);

		expect(sent[0]).toMatchObject({
			catchUpCursor: { parentLastMessageId: "exact-old" },
			version: 5,
		});
	});

	it("keeps the experimental shell independent from band geometry", () => {
		const source = shellSource();
		expect(source).toContain("pretextDocument.index");
		expect(source).toContain('position: "absolute"');
		expect(source).toContain('overflow: "hidden"');
		expect(source).toContain("exactLayout.totalHeight");
		// Rows tile the canvas via an outer hit box and center their own column, so
		// a drag-selection never crosses a caret-less strip (gaps / side margins).
		const rowProps = sliceBracketedRegion(source, "const rowProps: ExactRowProps = {");
		expect(rowProps).toMatch(
			/hitHeight:\s*resolveRowHitHeight\(\s*exactLayout\.items,\s*itemIndex,\s*exactLayout\.totalHeight,?\s*\)/,
		);
		expect(rowProps).toMatch(/\n\s*contentWidth,\s*\n/);
		// The projected geometry must reach ExactRow unchanged through the element factory.
		expect(source).toMatch(/windowRowProjections\.push\(\{\s*props: rowProps,/);
		expect(source).toContain("useVListWindowRows(narratorId, windowRowProjections)");
		expect(shellModule("useVListWindowRows.tsx")).toContain("<ExactRow key={key} {...props} />");
		expect(source).toContain("{ minHeight: hitHeight } : { height: hitHeight }");
		expect(source).toContain('style={{ position: "relative", width: "100%" }}');
		expect(source).toContain("const resolveExactToolColor = useCallback");
		expect(source).toContain("resolveToolColor: resolveExactToolColor");
		expect(source).toContain("getCurrentView: readCurrentView");
		expect(source).toContain("const scrollTop = node?.scrollTop ?? scrollTopRef.current");
		// An LOD gesture must report the point it is centered on, so the rebuild
		// re-anchors THAT content instead of yanking the viewport top into place.
		expect(source).toContain("focusOffset: resolveLodFocusOffset(");
		expect(source).toContain("createLodFocusPoint(clientY, node.getBoundingClientRect().top, now)");
		expect(source).toContain("emit(dir, event.clientY)");
		expect(source).toContain("emit(dir, pinchCenterY(Array.from(event.touches)))");
		// The alt-gesture preference is threaded through so the wheel handler can
		// fall through to normal scrolling when the gesture is turned off.
		expect(source).toContain("resolveWheelLodStep(event, lodAltGesture)");
		expect(source).toContain("resolvePinchLodStep(distance / pinchBaseline)");
		expect(source).not.toContain("computeSparseBandSpacers");
		expect(source).not.toContain("bandHeights");
	});
});

/** Minimal structural VListItem stub for the frame-grouping helpers. */
function stubItem(
	kind: string,
	key: string,
	measured: { inRun?: boolean; borderHeight?: number },
): VListItem {
	return {
		spec: { kind, key, data: {} },
		measured: { height: 40, blocks: [], frame: {}, ...measured },
	} as unknown as VListItem;
}

const toolCallInRun = (key: string) => stubItem("tool-call", key, { inRun: true });
const toolCallStandalone = (key: string) => stubItem("tool-call", key, { inRun: false });
const subagentInRun = (key: string) => stubItem("subagent-card", key, { borderHeight: 0 });
const subagentStandalone = (key: string) => stubItem("subagent-card", key, { borderHeight: 2 });

describe("isFramedRunItem", () => {
	it("flags only frameless in-run tool/subagent cards", () => {
		expect(isFramedRunItem(undefined)).toBe(false);
		expect(isFramedRunItem(toolCallInRun("a"))).toBe(true);
		expect(isFramedRunItem(toolCallStandalone("a"))).toBe(false);
		expect(isFramedRunItem(subagentInRun("a"))).toBe(true);
		expect(isFramedRunItem(subagentStandalone("a"))).toBe(false);
		expect(isFramedRunItem(stubItem("markdown", "m", {}))).toBe(false);
	});
});

describe("computeToolRunFrames", () => {
	it("returns no frames for an empty list", () => {
		expect(computeToolRunFrames([])).toEqual([]);
	});

	it("groups a run of 3 consecutive in-run tool cards into one frame", () => {
		const items = [toolCallInRun("t1"), toolCallInRun("t2"), toolCallInRun("t3")];
		expect(computeToolRunFrames(items)).toEqual([{ key: "run:t1", start: 0, end: 2 }]);
	});

	it("produces separate frames for two runs split by a message bubble", () => {
		const items = [
			toolCallInRun("t1"),
			toolCallInRun("t2"),
			stubItem("message-bubble", "m", {}),
			toolCallInRun("t3"),
			toolCallInRun("t4"),
		];
		expect(computeToolRunFrames(items)).toEqual([
			{ key: "run:t1", start: 0, end: 1 },
			{ key: "run:t3", start: 3, end: 4 },
		]);
	});

	it("keys each frame by its first member, not by its index", () => {
		// The fold transition pairs a frame's before/after geometry by this key. An
		// index-keyed frame would be paired with a DIFFERENT run's box whenever a fold
		// earlier in the document renumbered the items, which is precisely the rebuild
		// the transition has to diff across.
		const before = [stubItem("markdown", "m", {}), toolCallInRun("t1"), toolCallInRun("t2")];
		// Same run, one extra element inserted above it: every index shifted by one.
		const after = [
			stubItem("markdown", "m", {}),
			stubItem("markdown", "n", {}),
			toolCallInRun("t1"),
			toolCallInRun("t2"),
		];
		const [beforeFrame] = computeToolRunFrames(before);
		const [afterFrame] = computeToolRunFrames(after);
		expect(beforeFrame?.start).not.toBe(afterFrame?.start);
		expect(beforeFrame?.key).toBe(afterFrame?.key);
	});

	it("never frames a lone in-run item (≥2 guard)", () => {
		const items = [
			stubItem("markdown", "m", {}),
			toolCallInRun("t1"),
			stubItem("markdown", "n", {}),
		];
		expect(computeToolRunFrames(items)).toEqual([]);
	});

	it("ignores standalone (bordered) cards", () => {
		const items = [toolCallStandalone("t1"), toolCallStandalone("t2")];
		expect(computeToolRunFrames(items)).toEqual([]);
	});

	it("merges a mixed tool-call + subagent-card run into one frame", () => {
		const items = [toolCallInRun("t1"), subagentInRun("s1"), toolCallInRun("t2")];
		expect(computeToolRunFrames(items)).toEqual([{ key: "run:t1", start: 0, end: 2 }]);
	});

	it("does not extend a run through a standalone subagent card", () => {
		const items = [toolCallInRun("t1"), subagentStandalone("s1"), toolCallInRun("t2")];
		expect(computeToolRunFrames(items)).toEqual([]);
	});
});
