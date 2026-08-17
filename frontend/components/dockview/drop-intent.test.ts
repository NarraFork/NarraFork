import { describe, expect, test } from "bun:test";
import type { DockviewApi } from "dockview-react";
import {
	DEFAULT_THRESHOLDS,
	type DropIntent,
	type GroupHit,
	hitTestGroups,
	intentToDirection,
	intentToPosition,
	type SplitDirection,
	toIndicator,
	VERTICAL_ONLY_THRESHOLDS,
} from "./drop-intent";

/**
 * Build a fake DockviewApi exposing a single group whose element occupies the
 * given viewport rect. `hitTestGroups` reads `group.api.boundingBox` (root-
 * relative) and `group.element.getBoundingClientRect()` (viewport) — we make
 * both describe the same box positioned at the origin for simplicity.
 */
function apiWithGroup(opts: {
	left?: number;
	top?: number;
	width: number;
	height: number;
	activePanelId?: string | undefined;
	groupId?: string;
}): DockviewApi {
	const { left = 0, top = 0, width, height, activePanelId = "panel-target", groupId = "g1" } = opts;
	const rect = {
		left,
		top,
		right: left + width,
		bottom: top + height,
		width,
		height,
		x: left,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
	const group = {
		id: groupId,
		element: { getBoundingClientRect: () => rect } as unknown as HTMLElement,
		api: { boundingBox: { left, top, width, height } },
		activePanel: activePanelId ? { id: activePanelId } : undefined,
	};
	return { groups: [group] } as unknown as DockviewApi;
}

/**
 * A group inside an ancestor `transform: scale(zoom)`, modelled the way a browser
 * reports one: `getBoundingClientRect()` and dockview's own `boundingBox` (which it
 * derives from client-rect deltas) are both MAGNIFIED by the zoom, while
 * `offsetWidth` stays the element's unscaled layout width.
 *
 * `layoutWidth`/`layoutHeight` are the group's size in the surface's own pixels.
 */
function apiWithScaledGroup(opts: {
	layoutWidth: number;
	layoutHeight: number;
	zoom: number;
	/** Where the scaled box lands in the viewport. */
	screenLeft?: number;
	screenTop?: number;
	activePanelId?: string;
}): DockviewApi {
	const {
		layoutWidth,
		layoutHeight,
		zoom,
		screenLeft = 0,
		screenTop = 0,
		activePanelId = "target",
	} = opts;
	const width = layoutWidth * zoom;
	const height = layoutHeight * zoom;
	const rect = {
		left: screenLeft,
		top: screenTop,
		right: screenLeft + width,
		bottom: screenTop + height,
		width,
		height,
		x: screenLeft,
		y: screenTop,
		toJSON: () => ({}),
	} as DOMRect;
	const group = {
		id: "g1",
		element: {
			getBoundingClientRect: () => rect,
			offsetWidth: layoutWidth,
		} as unknown as HTMLElement,
		// Root-relative and scaled, exactly like dockview computes it.
		api: { boundingBox: { left: 0, top: 0, width, height } },
		activePanel: { id: activePanelId },
	};
	return { groups: [group] } as unknown as DockviewApi;
}

/**
 * Regression: the overlay rectangle used to be reported in SCALED pixels while
 * being applied as CSS inside the already-scaled dockview root, so the canvas zoom
 * was multiplied in twice — the highlight covered a fraction of the group and sat
 * at the wrong offset. The box must come back in the root's own layout pixels.
 */
describe("hitTestGroups — ancestor scale (graph node dock)", () => {
	test("box is reported in layout pixels, not the scaled screen size", () => {
		const api = apiWithScaledGroup({ layoutWidth: 800, layoutHeight: 600, zoom: 0.5 });
		// Pointer in the middle of the SCALED box (400x300 on screen).
		const hit = hitTestGroups(api, 200, 150, "dragged");
		expect(hit).not.toBeNull();
		expect(hit?.box).toEqual({ left: 0, top: 0, width: 800, height: 600 });
	});

	test("zoom > 1 shrinks the reported box back to layout size", () => {
		const api = apiWithScaledGroup({ layoutWidth: 800, layoutHeight: 600, zoom: 2 });
		const hit = hitTestGroups(api, 800, 600, "dragged");
		expect(hit?.box).toEqual({ left: 0, top: 0, width: 800, height: 600 });
	});

	test("a merge overlay covers the whole group in layout pixels at any zoom", () => {
		for (const zoom of [0.5, 1, 1.75, 3]) {
			const api = apiWithScaledGroup({ layoutWidth: 800, layoutHeight: 600, zoom });
			// Just inside the top-left corner → merge (not a split band) is irrelevant
			// here; we only assert the geometry the overlay is drawn from.
			const hit = hitTestGroups(api, 400 * zoom, 300 * zoom, "dragged");
			expect(hit).not.toBeNull();
			const indicator = toIndicator({ ...(hit as GroupHit), intent: "merge" });
			expect(indicator.width).toBeCloseTo(800, 6);
			expect(indicator.height).toBeCloseTo(600, 6);
		}
	});

	// Intent comes from RATIOS, so it was always zoom-correct; pin it so a future
	// change to the unscaling cannot quietly break hit-testing itself.
	test("intent zones still resolve against the on-screen box", () => {
		const api = apiWithScaledGroup({ layoutWidth: 1000, layoutHeight: 1000, zoom: 0.5 });
		// Scaled box is 500x500. Left edge band is the first 20%.
		expect(hitTestGroups(api, 10, 250, "dragged")?.intent).toBe("left");
		expect(hitTestGroups(api, 250, 250, "dragged")?.intent).toBe("swap");
		expect(hitTestGroups(api, 250, 490, "dragged")?.intent).toBe("below");
	});

	test("an offset scaled box still hit-tests and reports layout-sized geometry", () => {
		const api = apiWithScaledGroup({
			layoutWidth: 800,
			layoutHeight: 600,
			zoom: 0.5,
			screenLeft: 300,
			screenTop: 100,
		});
		expect(hitTestGroups(api, 100, 50, "dragged")).toBeNull();
		const hit = hitTestGroups(api, 500, 250, "dragged");
		expect(hit?.box.width).toBeCloseTo(800, 6);
		expect(hit?.box.height).toBeCloseTo(600, 6);
	});
});

describe("hitTestGroups — three-zone intent", () => {
	const api = apiWithGroup({ width: 1000, height: 1000, activePanelId: "target" });

	test("returns null when the cursor is outside every group", () => {
		expect(hitTestGroups(api, 5000, 5000, "dragged")).toBeNull();
	});

	test("center small square → swap (distinct panel)", () => {
		const hit = hitTestGroups(api, 500, 500, "dragged");
		expect(hit?.intent).toBe("swap");
		expect(hit?.targetPanelId).toBe("target");
	});

	test("center over the dragged panel itself → merge, never self-swap", () => {
		const hit = hitTestGroups(api, 500, 500, "target");
		expect(hit?.intent).toBe("merge");
	});

	test("mid-band (between swap square and edge) → merge", () => {
		// rx ≈ 0.3: outside swapHalf(0.14) but inside edge(0.2)? no — 0.3 > 0.2,
		// so not a split either → merge.
		const hit = hitTestGroups(api, 300, 500, "dragged");
		expect(hit?.intent).toBe("merge");
	});

	test("outer edges → split in each direction", () => {
		const cases: Array<[number, number, DropIntent]> = [
			[50, 500, "left"], // rx=0.05 < 0.2
			[950, 500, "right"], // rx=0.95 > 0.8
			[500, 50, "above"], // ry=0.05 < 0.2
			[500, 950, "below"], // ry=0.95 > 0.8
		];
		for (const [x, y, expected] of cases) {
			expect(hitTestGroups(api, x, y, "dragged")?.intent).toBe(expected);
		}
	});

	test("left edge takes precedence over top when in a corner", () => {
		// Corner (rx<edge AND ry<edge): implementation checks left before above.
		const hit = hitTestGroups(api, 50, 50, "dragged");
		expect(hit?.intent).toBe("left");
	});

	test("group offset by a viewport origin is handled", () => {
		const offset = apiWithGroup({ left: 200, top: 100, width: 400, height: 400 });
		// Center is at (400, 300).
		expect(hitTestGroups(offset, 400, 300, "dragged")?.intent).toBe("swap");
		// Left edge band.
		expect(hitTestGroups(offset, 220, 300, "dragged")?.intent).toBe("left");
	});
});

describe("hitTestGroups — allowedSplits whitelist (mobile drawer)", () => {
	const api = apiWithGroup({ width: 1000, height: 1000 });

	test("vertical-only preset: horizontal edges fall through to merge", () => {
		expect(hitTestGroups(api, 50, 500, "d", VERTICAL_ONLY_THRESHOLDS)?.intent).toBe("merge");
		expect(hitTestGroups(api, 950, 500, "d", VERTICAL_ONLY_THRESHOLDS)?.intent).toBe("merge");
	});

	test("vertical-only preset: vertical edges still split", () => {
		expect(hitTestGroups(api, 500, 50, "d", VERTICAL_ONLY_THRESHOLDS)?.intent).toBe("above");
		expect(hitTestGroups(api, 500, 950, "d", VERTICAL_ONLY_THRESHOLDS)?.intent).toBe("below");
	});

	test("empty allowedSplits → every edge merges", () => {
		const noSplit = { edge: 0.2, swapHalf: 0.14, allowedSplits: [] as SplitDirection[] };
		expect(hitTestGroups(api, 50, 500, "d", noSplit)?.intent).toBe("merge");
		expect(hitTestGroups(api, 500, 50, "d", noSplit)?.intent).toBe("merge");
		// Center still swaps.
		expect(hitTestGroups(api, 500, 500, "d", noSplit)?.intent).toBe("swap");
	});
});

describe("toIndicator — highlight rectangles", () => {
	const box = { left: 0, top: 0, width: 400, height: 200 };

	const withIntent = (intent: DropIntent): GroupHit =>
		({
			group: {} as GroupHit["group"],
			targetPanelId: "t",
			box,
			intent,
		}) satisfies GroupHit;

	test("left/right split → half width, full height", () => {
		expect(toIndicator(withIntent("left"))).toMatchObject({ left: 0, width: 200, height: 200 });
		expect(toIndicator(withIntent("right"))).toMatchObject({ left: 200, width: 200, height: 200 });
	});

	test("above/below split → full width, half height", () => {
		expect(toIndicator(withIntent("above"))).toMatchObject({ top: 0, width: 400, height: 100 });
		expect(toIndicator(withIntent("below"))).toMatchObject({ top: 100, width: 400, height: 100 });
	});

	test("merge → covers the whole group", () => {
		expect(toIndicator(withIntent("merge"))).toMatchObject({
			left: 0,
			top: 0,
			width: 400,
			height: 200,
			variant: "merge",
		});
	});

	test("swap → centered square sized by swapHalf*2", () => {
		const ind = toIndicator(withIntent("swap"), DEFAULT_THRESHOLDS);
		const w = 400 * DEFAULT_THRESHOLDS.swapHalf * 2;
		const h = 200 * DEFAULT_THRESHOLDS.swapHalf * 2;
		expect(ind.width).toBeCloseTo(w);
		expect(ind.height).toBeCloseTo(h);
		// Centered.
		expect(ind.left).toBeCloseTo((400 - w) / 2);
		expect(ind.top).toBeCloseTo((200 - h) / 2);
		expect(ind.variant).toBe("swap");
	});
});

describe("intent → dockview position / direction mapping", () => {
	test("intentToPosition", () => {
		expect(intentToPosition("left")).toBe("left");
		expect(intentToPosition("right")).toBe("right");
		expect(intentToPosition("above")).toBe("top");
		expect(intentToPosition("below")).toBe("bottom");
		expect(intentToPosition("merge")).toBe("center");
		expect(intentToPosition("swap")).toBe("center");
	});

	test("intentToDirection", () => {
		expect(intentToDirection("left")).toBe("left");
		expect(intentToDirection("right")).toBe("right");
		expect(intentToDirection("above")).toBe("above");
		expect(intentToDirection("below")).toBe("below");
		expect(intentToDirection("merge")).toBe("within");
		expect(intentToDirection("swap")).toBe("within");
	});
});
