import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { buildPretextLayoutIndex, type PretextLayoutManifest } from "@shared/pretext-layout";
import {
	applyExactScrollCorrection,
	buildExactCatchUpCursor,
	buildExactListLayout,
	computeToolRunFrames,
	hasRenderableExactLayout,
	isFramedRunItem,
	shouldReloadExactDocument,
} from "./PretextExactMessageList";
import { resolvePretextDocumentView, shouldForcePretextDocumentLoad } from "./usePretextDocument";
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

	it("forces a fresh document load once per explicit reload token", () => {
		expect(shouldForcePretextDocumentLoad(1, 0)).toBe(true);
		expect(shouldForcePretextDocumentLoad(1, 1)).toBe(false);
		expect(shouldForcePretextDocumentLoad(2, 1)).toBe(true);
	});

	it("prefers the synchronous live scroll view when capturing a rebuild anchor", () => {
		const fallback = { scrollTop: 120, viewportHeight: 600, pinnedToBottom: false };
		const live = { scrollTop: 480, viewportHeight: 640, pinnedToBottom: true };
		expect(resolvePretextDocumentView(fallback, () => live)).toBe(live);
		expect(resolvePretextDocumentView(fallback)).toBe(fallback);
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

	it("keeps the experimental shell independent from band geometry", () => {
		const source = readFileSync(`${import.meta.dir}/PretextExactMessageList.tsx`, "utf8");
		expect(source).toContain("pretextDocument.index");
		expect(source).toContain('position: "absolute"');
		expect(source).toContain('overflow: "hidden"');
		expect(source).toContain("exactLayout.totalHeight");
		expect(source).toContain("const resolveExactToolColor = useCallback");
		expect(source).toContain("resolveToolColor: resolveExactToolColor");
		expect(source).toContain("getCurrentView: readCurrentView");
		expect(source).toContain("scrollTop: node?.scrollTop ?? scrollTopRef.current");
		expect(source).toContain("pruneBoundaryMessageId: pretextDocument.pruneBoundaryMessageId");
		expect(source).toContain("prunedPercent: pretextDocument.prunedPercent");
		expect(source).toContain("onPruneBoundary: bumpMessageRevision");
		expect(source).toContain("resolveWheelLodStep(event)");
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
		expect(computeToolRunFrames(items)).toEqual([{ start: 0, end: 2 }]);
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
			{ start: 0, end: 1 },
			{ start: 3, end: 4 },
		]);
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
		expect(computeToolRunFrames(items)).toEqual([{ start: 0, end: 2 }]);
	});

	it("does not extend a run through a standalone subagent card", () => {
		const items = [toolCallInRun("t1"), subagentStandalone("s1"), toolCallInRun("t2")];
		expect(computeToolRunFrames(items)).toEqual([]);
	});
});
