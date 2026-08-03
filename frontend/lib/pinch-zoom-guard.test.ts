/**
 * Guards for the app-wide page-zoom refusal.
 *
 * The bug this prevents: on a landscape tablet a two-finger gesture zoomed the whole
 * page instead of reaching the handler under the fingers, so the narrator list's LOD
 * pinch never fired. Two independent causes, both asserted here:
 *
 *   1. `index.html`'s `user-scalable=no` is ignored by Safari in a browser tab, and
 *      nothing else refused the zoom — there was no gesture-event listener anywhere.
 *   2. The in-app pinch handlers call preventDefault() only after their 1.2 ratio
 *      threshold, which is several frames after the engine has already awarded the
 *      gesture to the viewport.
 *
 * So the assertions are about ORDER and BREADTH, not just "a listener exists":
 * capture + non-passive (so the guard runs first and its preventDefault counts), and
 * a pan is still allowed to scroll.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import {
	createPageZoomTouchGate,
	installPinchZoomGuard,
	PAGE_ZOOM_SCALE_TOLERANCE,
	touchSpread,
	WEBKIT_GESTURE_EVENTS,
} from "./pinch-zoom-guard";

/**
 * The LOD handlers' own pinch threshold, restated rather than imported.
 *
 * The vlist isolation guard forbids any static import from
 * `components/narrator/vlist/` outside that directory, and a test file is no
 * exception. The value is asserted against its source below so the duplicate cannot
 * drift silently.
 */
const LOD_PINCH_RATIO_THRESHOLD = 1.2;

/** Two touches `distance` px apart, centred so the midpoint is irrelevant. */
function spreadTouches(distance: number) {
	return [
		{ clientX: 0, clientY: 0 },
		{ clientX: distance, clientY: 0 },
	];
}

describe("touchSpread", () => {
	it("measures the distance between the first two touches", () => {
		expect(touchSpread(spreadTouches(100))).toBe(100);
		expect(
			touchSpread([
				{ clientX: 0, clientY: 0 },
				{ clientX: 30, clientY: 40 },
			]),
		).toBe(50);
	});

	it("reports 0 for gestures that cannot be a pinch", () => {
		expect(touchSpread([])).toBe(0);
		expect(touchSpread([{ clientX: 10, clientY: 10 }])).toBe(0);
	});
});

describe("page-zoom touch gate", () => {
	it("lets a single finger scroll", () => {
		const gate = createPageZoomTouchGate();
		expect(gate.shouldRefuse([{ clientX: 0, clientY: 0 }])).toBe(false);
		expect(gate.shouldRefuse([{ clientX: 0, clientY: 40 }])).toBe(false);
	});

	it("lets a constant-distance two-finger drag scroll", () => {
		// A two-finger pan is a normal way to scroll on a tablet. Refusing every
		// two-touch move would freeze it app-wide, which is why the gate measures the
		// distance change rather than the touch count.
		const gate = createPageZoomTouchGate();
		gate.shouldRefuse(spreadTouches(200));
		for (const dy of [10, 25, 60]) {
			const panned = [
				{ clientX: 0, clientY: dy },
				{ clientX: 200, clientY: dy },
			];
			expect(gate.shouldRefuse(panned)).toBe(false);
		}
	});

	it("refuses once the fingers change distance", () => {
		const gate = createPageZoomTouchGate();
		expect(gate.shouldRefuse(spreadTouches(200))).toBe(false); // baseline frame
		expect(gate.shouldRefuse(spreadTouches(260))).toBe(true);
	});

	it("claims the gesture well before the LOD handlers' own threshold", () => {
		// The whole point of the guard: the engine decides who owns a pinch on its
		// first moves, so the refusal has to land earlier than the ratio the narrator
		// list acts on. If this inverted, the viewport would win the race again.
		expect(1 + PAGE_ZOOM_SCALE_TOLERANCE).toBeLessThan(LOD_PINCH_RATIO_THRESHOLD);

		const gate = createPageZoomTouchGate();
		gate.shouldRefuse(spreadTouches(200));
		// A spread far below the LOD threshold is already refused.
		expect(gate.shouldRefuse(spreadTouches(200 * 1.1))).toBe(true);
	});

	it("restates the LOD threshold faithfully", async () => {
		// Pins the duplicated constant to its source, which cannot be imported here
		// without breaking the vlist isolation guard.
		const source = await Bun.file(
			new URL("../components/narrator/vlist/vlist-lod-gesture.ts", import.meta.url),
		).text();
		expect(source).toContain(`PINCH_RATIO_THRESHOLD = ${LOD_PINCH_RATIO_THRESHOLD}`);
	});

	it("stays latched for the rest of the gesture", () => {
		// A pinch that pauses mid-gesture must not hand a frame of zoom back to the
		// viewport, so the decision is sticky until the fingers lift.
		const gate = createPageZoomTouchGate();
		gate.shouldRefuse(spreadTouches(200));
		expect(gate.shouldRefuse(spreadTouches(300))).toBe(true);
		expect(gate.shouldRefuse(spreadTouches(300))).toBe(true);
		expect(gate.shouldRefuse(spreadTouches(300))).toBe(true);
	});

	it("re-arms after the fingers lift so the next gesture is judged fresh", () => {
		const gate = createPageZoomTouchGate();
		gate.shouldRefuse(spreadTouches(200));
		expect(gate.shouldRefuse(spreadTouches(300))).toBe(true);

		gate.release(1);
		gate.release(0);

		// A new two-finger pan must scroll again rather than inherit the latch.
		expect(gate.shouldRefuse(spreadTouches(150))).toBe(false);
		const panned = [
			{ clientX: 0, clientY: 30 },
			{ clientX: 150, clientY: 30 },
		];
		expect(gate.shouldRefuse(panned)).toBe(false);
	});

	it("keeps the latch while a third finger is still down", () => {
		const gate = createPageZoomTouchGate();
		gate.shouldRefuse(spreadTouches(200));
		expect(gate.shouldRefuse(spreadTouches(300))).toBe(true);
		gate.release(2);
		expect(gate.shouldRefuse(spreadTouches(300))).toBe(true);
	});
});

/**
 * Listener-registration contract, read from the module source.
 *
 * linkedom has no gesture events and no TouchEvent, so dispatching a real pinch is
 * not available; what matters anyway is HOW the listeners are registered, since
 * capture + non-passive is the entire reason the guard beats the viewport.
 */
describe("installPinchZoomGuard registration", () => {
	const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

	function installDom() {
		const { window } = parseHTML("<!doctype html><html><body></body></html>");
		for (const [key, value] of Object.entries({ window, document: window.document })) {
			const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
			if (!savedGlobals.has(key)) savedGlobals.set(key, descriptor);
			if (descriptor && !descriptor.configurable) continue;
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		return window.document;
	}

	afterAll(() => {
		for (const [key, descriptor] of savedGlobals) {
			const current = Object.getOwnPropertyDescriptor(globalThis, key);
			if (current && !current.configurable) continue;
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		savedGlobals.clear();
	});

	/** Record every add/removeEventListener call on a document. */
	function trackListeners(target: Document) {
		const added: Array<{ type: string; options: unknown }> = [];
		const removed: Array<{ type: string; options: unknown }> = [];
		const originalAdd = target.addEventListener.bind(target);
		const originalRemove = target.removeEventListener.bind(target);
		// biome-ignore lint/suspicious/noExplicitAny: test double over the DOM signature
		(target as any).addEventListener = (type: string, listener: any, options: any) => {
			added.push({ type, options });
			originalAdd(type, listener, options);
		};
		// biome-ignore lint/suspicious/noExplicitAny: test double over the DOM signature
		(target as any).removeEventListener = (type: string, listener: any, options: any) => {
			removed.push({ type, options });
			originalRemove(type, listener, options);
		};
		return { added, removed };
	}

	it("registers every zoom hook in the capture phase, non-passive", () => {
		const document = installDom();
		const tracked = trackListeners(document);

		installPinchZoomGuard(document);

		const types = tracked.added.map((entry) => entry.type);
		for (const gestureEvent of WEBKIT_GESTURE_EVENTS) {
			expect(types).toContain(gestureEvent);
		}
		expect(types).toContain("touchmove");

		// Capture: run before component handlers. Non-passive: preventDefault() is
		// honoured instead of being logged as an intervention. Both are load-bearing.
		for (const entry of tracked.added) {
			expect(entry.options).toEqual({ capture: true, passive: false });
		}
	});

	it("tracks touch end/cancel so a finished pinch releases the latch", () => {
		const document = installDom();
		const tracked = trackListeners(document);

		installPinchZoomGuard(document);

		const types = tracked.added.map((entry) => entry.type);
		expect(types).toContain("touchend");
		expect(types).toContain("touchcancel");
	});

	it("removes every listener it added, matching the capture flag", () => {
		const document = installDom();
		const tracked = trackListeners(document);

		installPinchZoomGuard(document)();

		expect(tracked.removed.map((entry) => entry.type).sort()).toEqual(
			tracked.added.map((entry) => entry.type).sort(),
		);
		// A listener's identity includes its capture flag; dropping it here would leave
		// the bubble-phase listener registered and the capture one installed forever.
		for (const entry of tracked.removed) {
			expect(entry.options).toEqual({ capture: true });
		}
	});
});

describe("bootstrap wiring", () => {
	it("installs the guard before React mounts", async () => {
		// Route-scoped installation would leave gaps exactly where a gesture starts, and
		// installing after render leaves the first paint unguarded.
		const source = await Bun.file(new URL("../main.tsx", import.meta.url)).text();
		expect(source).toContain("installPinchZoomGuard()");
		expect(source.indexOf("installPinchZoomGuard()")).toBeLessThan(
			source.indexOf("ReactDOM.createRoot"),
		);
	});

	it("keeps the declarative no-zoom contract in index.html", async () => {
		// The meta tag still carries Chromium and installed PWAs; the guard covers the
		// engines that ignore it. Removing either half regresses a different platform.
		const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
		expect(html).toContain("user-scalable=no");
	});
});
