import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { buildPretextLayoutIndex, type PretextLayoutManifest } from "@shared/pretext-layout";
import {
	applyExactScrollCorrection,
	buildExactCatchUpCursor,
	buildExactListLayout,
	hasRenderableExactLayout,
	shouldReloadExactDocument,
} from "./PretextExactMessageList";
import { shouldForcePretextDocumentLoad } from "./usePretextDocument";

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

	it("reloads only for a newer persisted message revision after an index exists", () => {
		expect(shouldReloadExactDocument(4, 3, true)).toBe(true);
		expect(shouldReloadExactDocument(3, 3, true)).toBe(false);
		expect(shouldReloadExactDocument(4, 3, false)).toBe(false);
	});

	it("forces a fresh document load once per explicit reload token", () => {
		expect(shouldForcePretextDocumentLoad(1, 0)).toBe(true);
		expect(shouldForcePretextDocumentLoad(1, 1)).toBe(false);
		expect(shouldForcePretextDocumentLoad(2, 1)).toBe(true);
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
		expect(source).toContain("resolveWheelLodStep(event)");
		expect(source).toContain("resolvePinchLodStep(distance / pinchBaseline)");
		expect(source).not.toContain("computeSparseBandSpacers");
		expect(source).not.toContain("bandHeights");
	});
});
