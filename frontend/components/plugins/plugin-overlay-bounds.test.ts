import { afterEach, describe, expect, test } from "bun:test";
import { clipOverlayBounds, pluginOverlayBoundsStore } from "./plugin-overlay-bounds";

afterEach(() => {
	for (const id of Object.keys(pluginOverlayBoundsStore.getSnapshot())) {
		pluginOverlayBoundsStore.clear(id);
	}
});

describe("overlay bounds", () => {
	test("intersects negative coordinates rather than moving invisible content into view", () => {
		expect(clipOverlayBounds({ x: -20, y: -30, width: 50, height: 40 }, 800, 600)).toEqual({
			x: 0,
			y: 0,
			width: 30,
			height: 10,
		});
		expect(clipOverlayBounds({ x: -100, y: 10, width: 50, height: 50 }, 800, 600)).toEqual({
			x: 0,
			y: 10,
			width: 0,
			height: 50,
		});
	});

	test("clips right and bottom edges and permits full viewport overlays", () => {
		expect(clipOverlayBounds({ x: 780, y: 590, width: 50, height: 50 }, 800, 600)).toEqual({
			x: 780,
			y: 590,
			width: 20,
			height: 10,
		});
		expect(clipOverlayBounds({ x: 0, y: 0, width: 100_000, height: 100_000 }, 800, 600)).toEqual({
			x: 0,
			y: 0,
			width: 800,
			height: 600,
		});
		expect(clipOverlayBounds({ x: 900, y: 700, width: 50, height: 50 }, 800, 600)).toEqual({
			x: 800,
			y: 600,
			width: 0,
			height: 0,
		});
	});

	test("handles zero viewports and finite extreme coordinates without overflow", () => {
		expect(clipOverlayBounds({ x: 10, y: 20, width: 30, height: 40 }, 0, 0)).toEqual({
			x: 0,
			y: 0,
			width: 0,
			height: 0,
		});
		expect(
			clipOverlayBounds(
				{ x: -Number.MAX_VALUE, y: Number.MAX_VALUE, width: 100_000, height: 100_000 },
				800,
				600,
			),
		).toEqual({
			x: 0,
			y: 600,
			width: 0,
			height: 0,
		});
	});

	test("clears zero-area rectangles and keeps different overlays independent", () => {
		const bounds = { x: 10, y: 20, width: 30, height: 40 };
		pluginOverlayBoundsStore.set("one", bounds);
		pluginOverlayBoundsStore.set("two", bounds);
		pluginOverlayBoundsStore.set("one", { ...bounds, width: 0 });
		expect(pluginOverlayBoundsStore.getSnapshot()).toEqual({ two: bounds });
		pluginOverlayBoundsStore.clear("two");
		expect(pluginOverlayBoundsStore.getSnapshot()).toEqual({});
	});

	test("publishes immutable copies and skips identical updates", () => {
		const bounds = { x: 10, y: 20, width: 30, height: 40 };
		let calls = 0;
		const unsubscribe = pluginOverlayBoundsStore.subscribe(() => {
			calls += 1;
		});
		try {
			pluginOverlayBoundsStore.set("one", bounds);
			const snapshot = pluginOverlayBoundsStore.getSnapshot();
			bounds.x = 999;
			expect(snapshot.one?.x).toBe(10);
			pluginOverlayBoundsStore.set("one", { x: 10, y: 20, width: 30, height: 40 });
			pluginOverlayBoundsStore.clear("missing");
			expect(pluginOverlayBoundsStore.getSnapshot()).toBe(snapshot);
			expect(calls).toBe(1);
		} finally {
			unsubscribe();
		}
	});

	test("reclips all regions on resize with a single notification and removes offscreen ones", () => {
		pluginOverlayBoundsStore.set("one", { x: 0, y: 0, width: 800, height: 600 });
		pluginOverlayBoundsStore.set("two", { x: 700, y: 500, width: 50, height: 50 });
		let calls = 0;
		const unsubscribe = pluginOverlayBoundsStore.subscribe(() => {
			calls += 1;
		});
		try {
			pluginOverlayBoundsStore.clipToViewport(400, 300);
			expect(pluginOverlayBoundsStore.getSnapshot()).toEqual({
				one: { x: 0, y: 0, width: 400, height: 300 },
			});
			const snapshot = pluginOverlayBoundsStore.getSnapshot();
			pluginOverlayBoundsStore.clipToViewport(400, 300);
			expect(pluginOverlayBoundsStore.getSnapshot()).toBe(snapshot);
			expect(calls).toBe(1);
		} finally {
			unsubscribe();
		}
	});
});
