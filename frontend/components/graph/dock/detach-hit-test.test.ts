import { describe, expect, test } from "bun:test";
import {
	type DetachedNodeRect,
	type DockRect,
	type Rect,
	resolveCanvasDropTarget,
	toRect,
} from "./detach-hit-test";

const canvas: Rect = { left: 0, top: 0, right: 1000, bottom: 800 };

function dock(surfaceId: string, box: [number, number, number, number]): DockRect {
	const [left, top, right, bottom] = box;
	return { surfaceId, rect: { left, top, right, bottom } };
}

function detached(nodeId: string, box: [number, number, number, number]): DetachedNodeRect {
	const [left, top, right, bottom] = box;
	return { nodeId, rect: { left, top, right, bottom } };
}

describe("resolveCanvasDropTarget", () => {
	test("blank canvas → detach", () => {
		expect(resolveCanvasDropTarget(canvas, [], 500, 400)).toEqual({ kind: "detach" });
	});

	test("outside the canvas → outside", () => {
		expect(resolveCanvasDropTarget(canvas, [], -1, 400).kind).toBe("outside");
		expect(resolveCanvasDropTarget(canvas, [], 500, 900).kind).toBe("outside");
		expect(resolveCanvasDropTarget(canvas, [], 1001, 400).kind).toBe("outside");
	});

	test("no canvas rect yet → outside (never detaches on a stale layout)", () => {
		expect(resolveCanvasDropTarget(null, [], 500, 400).kind).toBe("outside");
	});

	test("over a dock → that dock wins, NOT detach", () => {
		// The precedence that matters: an expanded node's dock is inside the canvas,
		// so checking the canvas alone would tear out a panel the user was merely
		// dragging between tabs.
		const docks = [dock("chap_1", [100, 100, 400, 500])];
		expect(resolveCanvasDropTarget(canvas, docks, 250, 300)).toEqual({
			kind: "dock",
			surfaceId: "chap_1",
		});
	});

	test("just outside a dock but inside the canvas → detach", () => {
		const docks = [dock("chap_1", [100, 100, 400, 500])];
		expect(resolveCanvasDropTarget(canvas, docks, 401, 300).kind).toBe("detach");
		expect(resolveCanvasDropTarget(canvas, docks, 250, 501).kind).toBe("detach");
	});

	test("dock edges are inclusive", () => {
		const docks = [dock("chap_1", [100, 100, 400, 500])];
		for (const [x, y] of [
			[100, 100],
			[400, 500],
			[100, 500],
			[400, 100],
		]) {
			expect(resolveCanvasDropTarget(canvas, docks, x, y).kind).toBe("dock");
		}
	});

	test("picks the correct dock among several", () => {
		const docks = [dock("chap_A", [0, 0, 200, 200]), dock("chap_B", [500, 500, 700, 700])];
		expect(resolveCanvasDropTarget(canvas, docks, 600, 600)).toEqual({
			kind: "dock",
			surfaceId: "chap_B",
		});
		expect(resolveCanvasDropTarget(canvas, docks, 100, 100)).toEqual({
			kind: "dock",
			surfaceId: "chap_A",
		});
		expect(resolveCanvasDropTarget(canvas, docks, 300, 300).kind).toBe("detach");
	});

	test("overlapping docks → the last one (topmost in paint order) wins", () => {
		const docks = [dock("chap_under", [0, 0, 400, 400]), dock("chap_over", [200, 200, 600, 600])];
		expect(resolveCanvasDropTarget(canvas, docks, 300, 300)).toEqual({
			kind: "dock",
			surfaceId: "chap_over",
		});
	});

	describe("standalone panel nodes", () => {
		test("over one → detachedNode, so the drop merges into it", () => {
			const nodes = [detached("dp_a", [100, 100, 300, 300])];
			expect(resolveCanvasDropTarget(canvas, [], 200, 200, nodes)).toEqual({
				kind: "detachedNode",
				nodeId: "dp_a",
			});
		});

		test("clear of them → still detach", () => {
			const nodes = [detached("dp_a", [100, 100, 300, 300])];
			expect(resolveCanvasDropTarget(canvas, [], 700, 500, nodes).kind).toBe("detach");
		});

		test("a dock outranks a standalone node under the same point", () => {
			// An expanded chapter node's dock offers richer drop handling (its own
			// split/merge zones), so it must win rather than being shadowed by a
			// standalone node that happens to overlap.
			const docks = [dock("chap_1", [0, 0, 400, 400])];
			const nodes = [detached("dp_a", [100, 100, 300, 300])];
			expect(resolveCanvasDropTarget(canvas, docks, 200, 200, nodes)).toEqual({
				kind: "dock",
				surfaceId: "chap_1",
			});
		});

		test("overlapping standalone nodes → the last one (topmost) wins", () => {
			const nodes = [
				detached("dp_under", [0, 0, 400, 400]),
				detached("dp_over", [200, 200, 600, 600]),
			];
			expect(resolveCanvasDropTarget(canvas, [], 300, 300)).toEqual({ kind: "detach" });
			expect(resolveCanvasDropTarget(canvas, [], 300, 300, nodes)).toEqual({
				kind: "detachedNode",
				nodeId: "dp_over",
			});
		});

		test("outside the canvas still wins over any node rect", () => {
			const nodes = [detached("dp_a", [-200, -200, 200, 200])];
			expect(resolveCanvasDropTarget(canvas, [], -50, -50, nodes).kind).toBe("outside");
		});

		test("omitting the node rects keeps the previous two-way behaviour", () => {
			// Callers that do not support merging pass nothing and must still get
			// `detach` over blank canvas.
			expect(resolveCanvasDropTarget(canvas, [], 500, 400).kind).toBe("detach");
		});
	});
});

describe("toRect", () => {
	test("keeps only the four edges a hit test needs", () => {
		const domRectLike = {
			left: 1,
			top: 2,
			right: 3,
			bottom: 4,
			width: 2,
			height: 2,
			x: 1,
			y: 2,
		};
		expect(toRect(domRectLike)).toEqual({ left: 1, top: 2, right: 3, bottom: 4 });
	});
});
