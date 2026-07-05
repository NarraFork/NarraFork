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
