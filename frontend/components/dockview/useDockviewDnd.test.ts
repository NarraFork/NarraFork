import { describe, expect, test } from "bun:test";
import type { DockviewApi, DockviewWillShowOverlayLocationEvent } from "dockview-react";
import { parseHTML } from "linkedom";
import type { PanelDragState } from "../../lib/panel-drag";
import { type DropIndicator, resolveNativeDrop, toIndicator } from "./drop-intent";
import type { DockviewDropTarget } from "./useDockviewDnd";
import {
	bindNativeDropPreview,
	canSurfaceHandleDrag,
	DOCKVIEW_SURFACE_ATTR,
	dropExistingPanel,
	isLocalPanelDrag,
	isTopmostSurface,
	NATIVE_DROP_PREVIEW_CLASS,
} from "./useDockviewDnd";

/**
 * Regression coverage for dropExistingPanel — the function that turns a resolved
 * drop intent into a dockview mutation.
 *
 * The key regression: a MERGE must tab the panel into the target group via an
 * explicit `index`, NOT `position: "center"`. A bare center position is a no-op
 * when the dragged panel is the sole member of its source group, so the two
 * groups never collapse (found via the headless dock smoke test).
 */

interface MoveCall {
	panel: string;
	group?: string;
	position?: string;
	index?: number;
}

function makeApi(
	panels: Record<string, { groupId: string; groupPanelCount?: number }>,
	groups: string[],
): { api: DockviewApi; moves: MoveCall[]; activated: string[] } {
	const moves: MoveCall[] = [];
	const activated: string[] = [];

	const groupObjs = groups.map((id, i) => ({
		id,
		activePanel: { id: Object.keys(panels).find((key) => panels[key].groupId === id) },
		element: {
			getBoundingClientRect: () => ({
				left: i * 500,
				right: (i + 1) * 500,
				top: 0,
				bottom: 800,
				width: 500,
				height: 800,
			}),
		},
		// Each group reports a panels array sized by groupPanelCount of any panel
		// that belongs to it (default 1) so `group.panels.length` is meaningful.
		get panels() {
			const owner = Object.values(panels).find((p) => p.groupId === id);
			return new Array(owner?.groupPanelCount ?? 1).fill({ id: "x" });
		},
		// Minimal group api with a boundingBox so swapPanels can derive sides.
		// Lay groups out left→right, 500px wide each.
		api: { boundingBox: { left: i * 500, top: 0, width: 500, height: 800 } },
	}));
	const groupById = (id: string) => groupObjs.find((g) => g.id === id);

	const makePanel = (panelId: string) => {
		const cfg = panels[panelId];
		return {
			id: panelId,
			api: {
				group: groupById(cfg.groupId),
				moveTo: (opts: { group?: { id: string }; position?: string; index?: number }) => {
					moves.push({
						panel: panelId,
						group: opts.group?.id,
						position: opts.position,
						index: opts.index,
					});
				},
				setActive: () => activated.push(panelId),
			},
		};
	};

	const api = {
		id: "native-surface",
		groups: groupObjs,
		getPanel: (id: string) => (panels[id] ? makePanel(id) : undefined),
	} as unknown as DockviewApi;

	return { api, moves, activated };
}

describe("native drop resolution → preview → panel mutation", () => {
	test.each([
		{ x: 650, intent: "merge", move: { group: "g2", index: 1 } },
		{ x: 750, intent: "swap", move: { group: "g2", position: "right" } },
		{ x: 550, intent: "left", move: { group: "g2", position: "left" } },
	])("$intent uses the same intent for paint and mutation", ({ x, intent, move }) => {
		const { api, moves } = makeApi({ a: { groupId: "g1" }, b: { groupId: "g2" } }, ["g1", "g2"]);
		const resolved = resolveNativeDrop(api, {
			kind: "content",
			group: api.groups[1],
			nativeEvent: { clientX: x, clientY: 400 },
			getData: () => ({ viewId: api.id, panelId: "a" }),
		});
		expect(resolved).not.toBeNull();
		if (!resolved) throw new Error("expected native drop target");
		expect(toIndicator(resolved.hit).variant).toBe(intent);
		dropExistingPanel(api, resolved.panelId, {
			groupId: resolved.hit.group.id,
			intent: resolved.hit.intent,
			targetPanelId: resolved.hit.targetPanelId,
		});
		expect(moves).toHaveLength(1);
		expect(moves[0]).toMatchObject({ panel: "a", ...move });
	});
});

describe("dropExistingPanel", () => {
	test("no-op when panel or target group is missing", () => {
		const { api, moves } = makeApi({ a: { groupId: "g1" } }, ["g1"]);
		dropExistingPanel(api, "a", {
			groupId: "does-not-exist",
			intent: "merge",
			targetPanelId: undefined,
		});
		expect(moves).toHaveLength(0);
	});

	test("MERGE tabs the panel into the target group by index, not position:center", () => {
		// spec panel in g2, merging into g1 (which already has 1 panel).
		const { api, moves, activated } = makeApi(
			{ spec: { groupId: "g2" }, chat: { groupId: "g1", groupPanelCount: 1 } },
			["g1", "g2"],
		);
		const target: DockviewDropTarget = {
			groupId: "g1",
			intent: "merge",
			targetPanelId: "chat",
		};
		dropExistingPanel(api, "spec", target);
		expect(moves).toHaveLength(1);
		// Must move into g1 by index (append), NOT via a center position.
		expect(moves[0]).toMatchObject({ panel: "spec", group: "g1", index: 1 });
		expect(moves[0].position).toBeUndefined();
		expect(activated).toEqual(["spec"]);
	});

	test("MERGE into the group the panel already solely occupies is a no-op move", () => {
		const { api, moves, activated } = makeApi({ spec: { groupId: "g1" } }, ["g1"]);
		dropExistingPanel(api, "spec", {
			groupId: "g1",
			intent: "merge",
			targetPanelId: undefined,
		});
		// No moveTo — just re-activate.
		expect(moves).toHaveLength(0);
		expect(activated).toEqual(["spec"]);
	});

	test("SPLIT onto the panel's own sole-member group is a no-op (Bug 2 guard)", () => {
		// Dragging the lone panel of a group to that same group's edge would not
		// change the arrangement; moving it there tears down the group mid-move
		// and the panel vanishes. Every intent must no-op in this case.
		for (const intent of ["left", "right", "above", "below"] as const) {
			const { api, moves, activated } = makeApi({ solo: { groupId: "g1", groupPanelCount: 1 } }, [
				"g1",
			]);
			dropExistingPanel(api, "solo", { groupId: "g1", intent, targetPanelId: undefined });
			expect(moves).toHaveLength(0); // never calls moveTo
			expect(activated).toEqual(["solo"]);
		}
	});

	test("SPLIT into the panel's own MULTI-panel group still moves (arrangement changes)", () => {
		// When the source group has other panels, splitting off to an edge is a
		// real change, so moveTo must run.
		const { api, moves } = makeApi({ a: { groupId: "g1", groupPanelCount: 2 } }, ["g1"]);
		dropExistingPanel(api, "a", { groupId: "g1", intent: "right", targetPanelId: undefined });
		expect(moves).toHaveLength(1);
		expect(moves[0]).toMatchObject({ panel: "a", group: "g1", position: "right" });
	});

	test("SPLIT keeps a directional position (left/right/above/below)", () => {
		const cases: Array<[DockviewDropTarget["intent"], string]> = [
			["left", "left"],
			["right", "right"],
			["above", "top"],
			["below", "bottom"],
		];
		for (const [intent, position] of cases) {
			const { api, moves } = makeApi({ spec: { groupId: "g2" }, chat: { groupId: "g1" } }, [
				"g1",
				"g2",
			]);
			dropExistingPanel(api, "spec", { groupId: "g1", intent, targetPanelId: undefined });
			expect(moves).toHaveLength(1);
			expect(moves[0]).toMatchObject({ panel: "spec", group: "g1", position });
			expect(moves[0].index).toBeUndefined();
		}
	});

	test("SWAP delegates to swapPanels (sole-member panes → single relocating move)", () => {
		// chat in g1 (left), spec in g2 (right), both sole members. swapPanels
		// relocates the dragged sole pane to the opposite side of the target,
		// swapping their positions with a single move (no group is orphaned).
		const { api, moves } = makeApi({ chat: { groupId: "g1" }, spec: { groupId: "g2" } }, [
			"g1",
			"g2",
		]);
		dropExistingPanel(api, "spec", {
			groupId: "g1",
			intent: "swap",
			targetPanelId: "chat",
		});
		// spec (sole, right) relocates to the opposite side of chat's group (left).
		expect(moves).toEqual([{ panel: "spec", group: "g1", position: "left", index: undefined }]);
	});

	test("SWAP onto itself is a no-op (no self-swap)", () => {
		const { api, moves } = makeApi({ spec: { groupId: "g1" } }, ["g1"]);
		dropExistingPanel(api, "spec", {
			groupId: "g1",
			intent: "swap",
			targetPanelId: "spec",
		});
		expect(moves).toHaveLength(0);
	});
});

/**
 * Which drags a surface may treat as "my own panel being rearranged".
 *
 * This guard is what stops a cross-surface drop from moving the WRONG panel.
 * Panel ids are global (`ndock-terminal`), so once several surfaces coexist — one
 * per expanded graph node — a surface receiving a foreign panel's drop would
 * resolve that id against its own api and silently move its own same-kind panel
 * while the dragged one stayed put.
 */
function drag(over: Partial<PanelDragState> = {}): PanelDragState {
	return { id: "subject", title: "t", x: 0, y: 0, ...over };
}

describe("isLocalPanelDrag", () => {
	test("a live panel from the same surface is local", () => {
		expect(
			isLocalPanelDrag(drag({ panelId: "ndock-terminal", surfaceId: "chap_1" }), "chap_1"),
		).toBe(true);
	});

	test("a live panel from ANOTHER surface is not local (the mis-move guard)", () => {
		// Node A's terminal dropped onto node B: B must not resolve
		// "ndock-terminal" against its own api and move its own terminal.
		expect(
			isLocalPanelDrag(drag({ panelId: "ndock-terminal", surfaceId: "chap_A" }), "chap_B"),
		).toBe(false);
	});

	test("a drag with no panelId is never local (sidebar tab / detached panel)", () => {
		expect(isLocalPanelDrag(drag({ surfaceId: "chap_1" }), "chap_1")).toBe(false);
		expect(isLocalPanelDrag(drag({ toolKind: "terminal" }), "chap_1")).toBe(false);
	});

	test("legacy drags without surfaceId stay local (single-surface behaviour preserved)", () => {
		// The focus page and the workspace worked before this field existed; a drag
		// that carries no surfaceId must keep being handled in-surface.
		expect(isLocalPanelDrag(drag({ panelId: "ndock-spec" }), "chap_1")).toBe(true);
		expect(isLocalPanelDrag(drag({ panelId: "ndock-spec" }), undefined)).toBe(true);
		expect(isLocalPanelDrag(drag({ panelId: "ndock-spec", surfaceId: "chap_1" }), undefined)).toBe(
			true,
		);
	});
});

/**
 * Which drags a surface should ENGAGE with at all (hit-test + drop indicator).
 *
 * Regression coverage for the single-narrator page: its focus dock has no
 * `onDropSubject` (it cannot host another narrator), so a sidebar narrator
 * dragged over it must produce NO indicator — the page-level create-workspace
 * drop zone owns that gesture. Before this gate the dock lit up its groups
 * with merge/split/swap highlights that a drop could never fulfil, competing
 * with the page's overlay (most visible once the dock was split with tool
 * panels on the right).
 */
describe("canSurfaceHandleDrag", () => {
	test("a surface WITHOUT onDropSubject ignores external subjects (sidebar tab, detached panel)", () => {
		// Sidebar narrator drag: no panelId at all.
		expect(canSurfaceHandleDrag(drag({}), "focus:n1", false)).toBe(false);
		// Detached canvas panel: tool kind, still no live panel here.
		expect(canSurfaceHandleDrag(drag({ toolKind: "terminal" }), "focus:n1", false)).toBe(false);
	});

	test("a surface WITHOUT onDropSubject still rearranges its OWN panels", () => {
		expect(
			canSurfaceHandleDrag(
				drag({ panelId: "ndock-terminal", surfaceId: "focus:n1" }),
				"focus:n1",
				false,
			),
		).toBe(true);
	});

	test("a surface WITH onDropSubject accepts external subjects (workspace / graph docks)", () => {
		expect(canSurfaceHandleDrag(drag({}), "workspace:w1", true)).toBe(true);
		expect(canSurfaceHandleDrag(drag({ toolKind: "terminal" }), "chap_1", true)).toBe(true);
	});

	test("a foreign surface's panel drag engages only when a drop handler exists", () => {
		const state = drag({ panelId: "ndock-terminal", surfaceId: "workspace:w1" });
		expect(canSurfaceHandleDrag(state, "focus:n1", false)).toBe(false);
		expect(canSurfaceHandleDrag(state, "focus:n1", true)).toBe(true);
	});
});

/**
 * Which surface owns a release point.
 *
 * The regression this covers: dragging a sidebar recent tab into an ALREADY OPEN
 * workspace showed the drop indicator but did nothing on release. The drop gate
 * asked `elementFromPoint(...)` whether the topmost element belonged to this
 * surface — but @dnd-kit's `<DragOverlay>` is `position: fixed` with no
 * `pointer-events: none`, so the topmost element at the release point is always
 * the drag ghost. Every such drop was rejected, while the move handler (which has
 * no equivalent gate) kept painting the highlight.
 *
 * So the gate has to skip non-surface layers yet still respect front-to-back
 * ordering, since two surfaces can overlap on the story-network canvas and only
 * the frontmost may act.
 */
function surfaceStack(html: string): { doc: Document; el: (id: string) => Element } {
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	return {
		doc: document as unknown as Document,
		el: (id: string) => {
			const found = document.getElementById(id);
			if (!found) throw new Error(`missing #${id}`);
			return found as unknown as Element;
		},
	};
}

describe("native drop preview lifecycle", () => {
	function setup() {
		const { document, window } = parseHTML(
			'<html><body><div id="surface"><div id="childA"></div><div id="childB"></div></div><div id="outside"></div></body></html>',
		);
		const root = document.getElementById("surface") as unknown as HTMLElement;
		root.getBoundingClientRect = () =>
			({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 }) as DOMRect;
		const { api } = makeApi({ a: { groupId: "g1" }, b: { groupId: "g2" } }, ["g1", "g2"]);
		let listener: ((event: DockviewWillShowOverlayLocationEvent) => void) | null = null;
		Object.defineProperty(api, "onWillShowOverlay", {
			value: (callback: typeof listener) => {
				listener = callback;
				return {
					dispose: () => {
						listener = null;
					},
				};
			},
		});
		const indicators: (DropIndicator | null)[] = [];
		const stop = bindNativeDropPreview(api, root, (indicator) => {
			// Must hide the native layer BEFORE the React render is even requested.
			expect(root.classList.contains(NATIVE_DROP_PREVIEW_CLASS)).toBe(indicator !== null);
			indicators.push(indicator);
		});
		const hover = (kind = "content", x = 650, prevented = false) => {
			listener?.({
				kind,
				group: api.groups[1],
				defaultPrevented: prevented,
				nativeEvent: { clientX: x, clientY: 400 },
				getData: () => ({ viewId: api.id, panelId: "a" }),
				preventDefault: () => {
					throw new Error("preview must not disable native dropping");
				},
			} as unknown as DockviewWillShowOverlayLocationEvent);
		};
		const fire = (type: string, target = "childA", fields: Record<string, unknown> = {}) => {
			const event = new window.Event(type, { bubbles: true });
			Object.assign(event, { clientX: 650, clientY: 400, relatedTarget: null, ...fields });
			document.getElementById(target)?.dispatchEvent(event);
		};
		return { root, document, indicators, stop, hover, fire };
	}

	test("child dragleave with/without relatedTarget never clears or remounts the preview", () => {
		const { root, document, indicators, hover, fire, stop } = setup();
		try {
			hover();
			fire("dragleave", "childA", { relatedTarget: document.getElementById("childB") });
			fire("dragleave", "childA");
			fire("dragleave", "outside");
			hover();
			expect(indicators).toHaveLength(1);
			expect(indicators[0]?.variant).toBe("merge");
			expect(root.classList.contains(NATIVE_DROP_PREVIEW_CLASS)).toBe(true);
			hover("content", 750);
			expect(indicators.map((i) => i?.variant)).toEqual(["merge", "swap"]);
		} finally {
			stop();
		}
	});

	test.each(["tab", "header_space", "edge"])("%s hands paint back to Dockview", (kind) => {
		const { root, hover, indicators, stop } = setup();
		try {
			hover();
			hover(kind);
			expect(root.classList.contains(NATIVE_DROP_PREVIEW_CLASS)).toBe(false);
			expect(indicators[1]).toBeNull();
		} finally {
			stop();
		}
	});

	test.each(["drop", "dragend", "pointerup", "pointercancel"])("%s clears once", (type) => {
		const { root, hover, fire, indicators, stop } = setup();
		try {
			hover();
			fire(type);
			fire(type);
			expect(indicators).toHaveLength(2);
			expect(indicators[1]).toBeNull();
			expect(root.classList.contains(NATIVE_DROP_PREVIEW_CLASS)).toBe(false);
		} finally {
			stop();
		}
	});

	test("real surface exit, Escape and vetoed overlays clear", () => {
		const { root, hover, fire, indicators, stop } = setup();
		try {
			hover();
			fire("dragleave", "childA", { clientX: 1100 });
			expect(indicators.at(-1)).toBeNull();
			hover();
			fire("keydown", "childA", { key: "Escape" });
			expect(indicators.at(-1)).toBeNull();
			hover();
			hover("content", 650, true);
			expect(indicators.at(-1)).toBeNull();
			hover();
			fire("dragleave", "surface");
			expect(root.classList.contains(NATIVE_DROP_PREVIEW_CLASS)).toBe(false);
		} finally {
			stop();
		}
	});

	test("dispose removes the suppression and detaches all event handling", () => {
		const { root, hover, fire, indicators, stop } = setup();
		hover();
		stop();
		expect(root.classList.contains(NATIVE_DROP_PREVIEW_CLASS)).toBe(false);
		const count = indicators.length;
		hover();
		fire("dragend");
		expect(indicators).toHaveLength(count);
	});

	test("idle pointer movement does not measure every mounted dock", () => {
		const { root, fire, hover, indicators, stop } = setup();
		try {
			let measurements = 0;
			const measure = root.getBoundingClientRect;
			root.getBoundingClientRect = () => {
				measurements++;
				return measure();
			};
			fire("pointermove");
			expect(measurements).toBe(0);
			hover();
			fire("pointermove", "outside", { clientX: 1100 });
			expect(measurements).toBe(1);
			expect(indicators.at(-1)).toBeNull();
		} finally {
			stop();
		}
	});
});

describe("isTopmostSurface", () => {
	const html = `
		<div id="ghost">tab</div>
		<div id="front" ${DOCKVIEW_SURFACE_ATTR}="chap_A"><div id="frontInner"></div></div>
		<div id="back" ${DOCKVIEW_SURFACE_ATTR}="chap_B"><div id="backInner"></div></div>
	`;

	test("a drag ghost above the surface does not block the drop (the regression)", () => {
		const { el } = surfaceStack(html);
		// Front-to-back: ghost first (it rides under the pointer), then the surface.
		expect(isTopmostSurface(el("front"), [el("ghost"), el("frontInner"), el("front")])).toBe(true);
	});

	test("the frontmost surface wins when two surfaces overlap", () => {
		const { el } = surfaceStack(html);
		const stack = [el("ghost"), el("frontInner"), el("front"), el("backInner"), el("back")];
		expect(isTopmostSurface(el("front"), stack)).toBe(true);
		// The one behind must NOT also act, or the same drop lands twice.
		expect(isTopmostSurface(el("back"), stack)).toBe(false);
	});

	test("a point over no surface at all is rejected", () => {
		const { el } = surfaceStack(html);
		expect(isTopmostSurface(el("front"), [el("ghost")])).toBe(false);
		expect(isTopmostSurface(el("front"), [])).toBe(false);
	});

	test("a descendant of the surface counts as that surface", () => {
		const { el } = surfaceStack(html);
		expect(isTopmostSurface(el("front"), [el("frontInner")])).toBe(true);
	});
});
