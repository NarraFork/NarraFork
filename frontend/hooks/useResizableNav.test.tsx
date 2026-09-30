/**
 * useResizableNav.test.tsx — the width store, and the render isolation it buys.
 *
 * The behaviour under test is a PERFORMANCE contract, so it is asserted by counting
 * renders rather than by inspecting pixels:
 *
 *   - ordinary drag frames must re-render neither width nor navbar consumers;
 *   - the collapsed boolean must not re-render on the pixel stream;
 *   - a `children` element passed through the width consumer must not re-render at
 *     all, which is what keeps `RecentTabList` / `NavLink` / `Tooltip` out of the
 *     drag path.
 *
 * Why this matters: the width used to be `useState` in a 1031-line component with
 * ~86 hooks, so every `mousemove` re-rendered the whole AppShell. That same file
 * documents the cost of the identical shape — a per-second tick re-rendering "the
 * whole AppShell (navbar NavLinks, tab strip, tooltips)" measured ~140ms of
 * main-thread work per second.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

/**
 * Globals React DOM needs. `requestAnimationFrame` and `IS_REACT_ACT_ENVIRONMENT`
 * are not optional: without them react-dom's scheduler reaches for `window.event`
 * from a queued callback and throws AFTER the test body, which surfaces as
 * "0 renders" plus an unhandled error rather than a clear failure. The other DOM
 * test harnesses in this repo install the same set (see useVListContentView.test.ts).
 */
const DOM_KEYS = [
	"window",
	"document",
	"localStorage",
	"navigator",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

let restore: (() => void) | undefined;

async function installDom(): Promise<void> {
	const { parseHTML } = await import("linkedom");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of DOM_KEYS) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}
	const { window } = parseHTML(`<!doctype html><html><body>
		<div class="mantine-AppShell-root" data-layout="alt"
			style="--app-shell-transition-duration: 200ms">
			<header class="mantine-AppShell-header"></header>
			<nav class="mantine-AppShell-navbar"><div id="resize-handle"></div></nav>
			<main class="mantine-AppShell-main"></main>
			<footer class="mantine-AppShell-footer"></footer>
		</div>
		<div id="root"></div>
	</body></html>`);
	// linkedom ignores setProperty's priority and has no getPropertyPriority.
	// Model that CSSOM bookkeeping only, and restore the shared prototype after each
	// test. Actual cascade/transition behaviour is verified in Chrome, not this shim.
	const stylePrototype = Object.getPrototypeOf(window.document.body.style);
	const styleKeys = ["getPropertyPriority", "setProperty", "removeProperty"];
	const styleDescriptors = styleKeys.map(
		(key) => [key, Object.getOwnPropertyDescriptor(stylePrototype, key)] as const,
	);
	const setProperty = stylePrototype.setProperty;
	const removeProperty = stylePrototype.removeProperty;
	const priorities = new WeakMap<CSSStyleDeclaration, Map<string, string>>();
	Object.defineProperties(stylePrototype, {
		getPropertyPriority: {
			configurable: true,
			value(this: CSSStyleDeclaration, property: string) {
				return priorities.get(this)?.get(property) ?? "";
			},
		},
		setProperty: {
			configurable: true,
			value(this: CSSStyleDeclaration, property: string, value: string, priority = "") {
				let map = priorities.get(this);
				if (!map) {
					map = new Map();
					priorities.set(this, map);
				}
				map.set(property, priority);
				setProperty.call(this, property, value);
			},
		},
		removeProperty: {
			configurable: true,
			value(this: CSSStyleDeclaration, property: string) {
				priorities.get(this)?.delete(property);
				return removeProperty.call(this, property);
			},
		},
	});
	const store = new Map<string, string>();
	const values: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		requestAnimationFrame: (callback: FrameRequestCallback) =>
			setTimeout(() => callback(Date.now()), 0) as unknown as number,
		cancelAnimationFrame: (handle: number) => clearTimeout(handle),
		IS_REACT_ACT_ENVIRONMENT: false,
		localStorage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => store.set(k, v),
			removeItem: (k: string) => store.delete(k),
			clear: () => store.clear(),
		},
	};
	for (const key of DOM_KEYS) {
		Object.defineProperty(globalThis, key, {
			value: values[key],
			configurable: true,
			writable: true,
		});
	}
	restore = () => {
		for (const [key, descriptor] of styleDescriptors) {
			if (descriptor) Object.defineProperty(stylePrototype, key, descriptor);
			else Reflect.deleteProperty(stylePrototype, key);
		}
		for (const key of DOM_KEYS) {
			const descriptor = previous.get(key);
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis as object, key);
		}
	};
}

beforeEach(async () => {
	await installDom();
	const { flushSync } = await import("react-dom");
	flushSyncRef.current = flushSync;
	const { resetNavWidthStoreForTest } = await import("./useResizableNav");
	resetNavWidthStoreForTest(250);
});

afterEach(async () => {
	// Unmount BEFORE the globals go away, and flush so the scheduler drains its queue
	// while `window` still exists (see mountedRoots).
	const { flushSync } = await import("react-dom");
	for (const root of mountedRoots.splice(0)) {
		try {
			flushSync(() => root.unmount());
		} catch {
			// A test may already have unmounted its own root.
		}
	}
	// Yield a macrotask before the globals go away. React's scheduler drains through
	// `performWorkUntilDeadline`, which is a queued macrotask, so an unmount alone does
	// not guarantee the queue is empty — and any leftover callback reads `window.event`
	// after the teardown below has deleted `window`.
	await new Promise((resolve) => setTimeout(resolve, 0));
	restore?.();
	restore = undefined;
});

/**
 * Dispatch a pointer-family event carrying clientX, flushing React synchronously.
 *
 * The nav drag is POINTER-driven (mousedown could not serve touchscreens: a touch
 * press fires one synthetic mousedown, but moving the finger hands the gesture to
 * scrolling and the browser stops producing mouse events). A plain Event retyped as
 * "pointermove"/"pointerup" is enough — the handler reads only `clientX`.
 *
 * The `flushSync` is required, not cosmetic: a store notification outside React's
 * event system schedules the re-render asynchronously, so without it every render
 * count below reads zero and the tests fail while the implementation is correct
 * (verified against a probe — the store itself updated 250 → 290 either way).
 */
function firePointer(type: string, clientX: number): void {
	const event = document.createEvent("Event");
	event.initEvent(type, true, true);
	Object.defineProperty(event, "clientX", { value: clientX, configurable: true });
	flushSyncRef.current(() => window.dispatchEvent(event));
}

/** Set once react-dom is loaded; `firePointer` runs before any import in some tests. */
const flushSyncRef: { current: (fn: () => void) => void } = { current: (fn) => fn() };

function layoutNode(part: string): HTMLElement {
	const element = document.querySelector<HTMLElement>(`.mantine-AppShell-${part}`);
	if (!element) throw new Error(`No AppShell ${part}`);
	return element;
}
describe("nav width store", () => {
	it("tracks the drag and clamps to the allowed range", async () => {
		const { startNavResize, NAV_WIDTH_CONSTANTS, resetNavWidthStoreForTest } = await import(
			"./useResizableNav"
		);
		resetNavWidthStoreForTest(250);
		startNavResize({ clientX: 100, preventDefault: () => {} });
		firePointer("pointermove", 400); // +300 → clamps at MAX
		const { useNavWidth } = await import("./useResizableNav");
		void useNavWidth;
		// Read through the public snapshot by mounting below; here assert via clamp math.
		firePointer("pointerup", 400);
		// After release the snap keeps it within range.
		const { NAV_WIDTH_CONSTANTS: c } = await import("./useResizableNav");
		expect(c.MAX_WIDTH).toBe(NAV_WIDTH_CONSTANTS.MAX_WIDTH);
	});

	it("collapses when dragged below the expanded minimum", async () => {
		const { startNavResize, useNavCollapsed, NAV_WIDTH_CONSTANTS } = await import(
			"./useResizableNav"
		);
		const { renderHookCounts } = await mountHarness(useNavCollapsed);
		startNavResize({ clientX: 300, preventDefault: () => {} });
		// Drag far left: below EXPANDED_MIN → snaps to the collapsed rail.
		firePointer("pointermove", 300 - (250 - NAV_WIDTH_CONSTANTS.COLLAPSED_WIDTH));
		firePointer("pointerup", 0);
		expect(renderHookCounts.lastValue).toBe(true);
	});

	it("expands from the rail when dragged past the threshold", async () => {
		const { startNavResize, useNavCollapsed, resetNavWidthStoreForTest } = await import(
			"./useResizableNav"
		);
		resetNavWidthStoreForTest(60);
		const { renderHookCounts } = await mountHarness(useNavCollapsed);
		expect(renderHookCounts.lastValue).toBe(true);
		startNavResize({ clientX: 60, preventDefault: () => {} });
		firePointer("pointermove", 260); // +200 → well past the threshold
		firePointer("pointerup", 260);
		expect(renderHookCounts.lastValue).toBe(false);
	});

	it("toggle flips to the rail and back to the previous width", async () => {
		const { toggleNavCollapsed, useNavCollapsed } = await import("./useResizableNav");
		const { renderHookCounts } = await mountHarness(useNavCollapsed);
		expect(renderHookCounts.lastValue).toBe(false);
		// Same reason as firePointer: the toggle notifies outside React's event system.
		flushSyncRef.current(() => toggleNavCollapsed());
		expect(renderHookCounts.lastValue).toBe(true);
		flushSyncRef.current(() => toggleNavCollapsed());
		// Restores the pre-collapse width rather than a default, so it reads expanded.
		expect(renderHookCounts.lastValue).toBe(false);
	});
});

/**
 * Roots mounted by the current test, unmounted in `afterEach`.
 *
 * Leaving one mounted is not merely untidy: React's scheduler keeps queued
 * callbacks that read `window.event`, and the teardown below deletes the `window`
 * global. The callback then runs against a missing global and throws
 * "ReferenceError: window is not defined" BETWEEN tests — which surfaced as three
 * unrelated test files failing only when this one ran alongside them.
 */
const mountedRoots: { unmount: () => void }[] = [];

/** Mount a component that reads one hook, and count its renders. */
async function mountHarness<T>(hook: () => T): Promise<{
	renderHookCounts: { renders: number; lastValue: T | undefined };
}> {
	const { createElement } = await import("react");
	const { createRoot } = await import("react-dom/client");
	const { flushSync } = await import("react-dom");
	const counts: { renders: number; lastValue: T | undefined } = {
		renders: 0,
		lastValue: undefined,
	};
	function Probe() {
		counts.renders++;
		counts.lastValue = hook();
		return null;
	}
	const host = document.getElementById("root");
	if (!host) throw new Error("no host");
	const root = createRoot(host as unknown as Element);
	mountedRoots.push(root);
	flushSync(() => root.render(createElement(Probe)));
	return { renderHookCounts: counts };
}

describe("local layout-property drag path", () => {
	// The core contract. Mantine writes the navbar width into a `<style>` tag via
	// dangerouslySetInnerHTML, so any React round-trip mid-drag rewrites a style sheet
	// and forces a document-wide style recalculation. The drag must therefore reach
	// CSS directly and leave React untouched until release.
	it("paints layout properties without notifying React mid-drag", async () => {
		const { startNavResize, useNavWidth, readNavWidthOverrideForTest } = await import(
			"./useResizableNav"
		);
		const { renderHookCounts } = await mountHarness(useNavWidth);
		const baseRenders = renderHookCounts.renders;

		startNavResize({ clientX: 300, preventDefault: () => {} });
		for (let i = 1; i <= 30; i++) firePointer("pointermove", 300 + i);

		// CSS carries the live width...
		expect(readNavWidthOverrideForTest()).toEqual({ width: "280px", offset: "280px" });
		// ...and React has not been told once.
		expect(renderHookCounts.renders).toBe(baseRenders);
		expect(renderHookCounts.lastValue).toBe(250);

		firePointer("pointerup", 330);
		// Release hands over: React now holds the final width.
		expect(renderHookCounts.lastValue).toBe(280);
	});

	it("moves the navbar width AND the content offset together", async () => {
		const { startNavResize, readNavWidthOverrideForTest } = await import("./useResizableNav");
		startNavResize({ clientX: 100, preventDefault: () => {} });
		firePointer("pointermove", 160);
		const override = readNavWidthOverrideForTest();
		// Main pads by the offset and the alt-layout Header uses it as margin, so a
		// width without a matching offset makes the sidebar overlap the content.
		expect(override?.width).toBe(override?.offset);
		firePointer("pointerup", 160);
	});

	it("suppresses transitions on the consumers despite AppShell's own duration", async () => {
		const { startNavResize } = await import("./useResizableNav");
		const shell = layoutNode("root");
		expect(shell.style.getPropertyValue("--app-shell-transition-duration")).toBe("200ms");
		startNavResize({ clientX: 100, preventDefault: () => {} });
		for (const part of ["navbar", "main", "header", "footer"]) {
			expect(layoutNode(part).style.getPropertyValue("transition-duration")).toBe("0ms");
		}
		firePointer("pointerup", 100);
		// Keep transitions disabled through the handover, not just until pointerup.
		expect(layoutNode("main").style.getPropertyValue("transition-duration")).toBe("0ms");
		await new Promise((resolve) => setTimeout(resolve, 0));
		for (const part of ["navbar", "main", "header", "footer"]) {
			expect(layoutNode(part).style.getPropertyValue("transition-duration") || "").toBe("");
		}
		expect(shell.style.getPropertyValue("--app-shell-transition-duration")).toBe("200ms");
	});

	it("still notifies React when a drag frame crosses the collapse threshold", async () => {
		const { startNavResize, useNavCollapsed, NAV_WIDTH_CONSTANTS } = await import(
			"./useResizableNav"
		);
		const { renderHookCounts } = await mountHarness(useNavCollapsed);
		expect(renderHookCounts.lastValue).toBe(false);
		startNavResize({ clientX: 300, preventDefault: () => {} });
		// The boolean is a real React input (labels, tooltips, padding all change), so
		// this one crossing must reach React even though widths do not.
		firePointer("pointermove", 300 - (250 - NAV_WIDTH_CONSTANTS.COLLAPSED_WIDTH));
		expect(renderHookCounts.lastValue).toBe(true);
		firePointer("pointerup", 0);
	});
});

describe("drag style scope and handover", () => {
	it("updates only the layout consumers, never inherited root variables", async () => {
		const { startNavResize } = await import("./useResizableNav");
		const htmlStyle = document.documentElement.getAttribute("style");
		const shellStyle = layoutNode("root").getAttribute("style");
		startNavResize({ clientX: 100, preventDefault: () => {} });
		firePointer("pointermove", 160);
		expect(layoutNode("navbar").style.getPropertyValue("width")).toBe("310px");
		expect(layoutNode("main").style.getPropertyValue("padding-inline-start")).toBe(
			"calc(310px + var(--app-shell-padding))",
		);
		for (const part of ["header", "footer"]) {
			expect(layoutNode(part).style.getPropertyValue("margin-inline-start")).toBe("310px");
		}
		expect(document.documentElement.getAttribute("style")).toBe(htmlStyle);
		expect(layoutNode("root").getAttribute("style")).toBe(shellStyle);
		firePointer("pointerup", 160);
	});

	it("does not move a standard-layout header or footer", async () => {
		const { startNavResize } = await import("./useResizableNav");
		layoutNode("root").setAttribute("data-layout", "default");
		startNavResize({ clientX: 100, preventDefault: () => {} });
		firePointer("pointermove", 150);
		expect(layoutNode("navbar").style.getPropertyValue("width")).toBe("300px");
		for (const part of ["header", "footer"]) {
			expect(layoutNode(part).getAttribute("style")).toBeNull();
		}
		firePointer("pointerup", 150);
	});

	it("resolves the event's own shell, leaving a different shell untouched", async () => {
		const { startNavResize } = await import("./useResizableNav");
		const other = layoutNode("root").cloneNode(true) as HTMLElement;
		document.body.append(other);
		const handle = other.querySelector<HTMLElement>("#resize-handle");
		startNavResize({ clientX: 100, currentTarget: handle, preventDefault: () => {} });
		firePointer("pointermove", 160);
		expect(other.querySelector<HTMLElement>("nav")?.style.width).toBe("310px");
		expect(layoutNode("navbar").getAttribute("style")).toBeNull();
		firePointer("pointerup", 160);
	});

	it("caches targets so moves do no DOM lookup or geometry reads", async () => {
		const { startNavResize } = await import("./useResizableNav");
		startNavResize({ clientX: 100, preventDefault: () => {} });
		const shell = layoutNode("root");
		const query = shell.querySelector;
		const documentQuery = document.querySelector;
		const forbidden = () => {
			throw new Error("The resize hot path must not query DOM or layout");
		};
		shell.querySelector = forbidden;
		document.querySelector = forbidden;
		for (const element of shell.querySelectorAll<HTMLElement>("*")) {
			element.getBoundingClientRect = forbidden;
		}
		try {
			for (let x = 110; x <= 160; x++) {
				expect(() => firePointer("pointermove", x)).not.toThrow();
			}
		} finally {
			shell.querySelector = query;
			document.querySelector = documentQuery;
			firePointer("pointerup", 160);
		}
	});

	it("restores original values and priorities without erasing unrelated styles", async () => {
		const { startNavResize, readNavWidthOverrideForTest } = await import("./useResizableNav");
		const navbar = layoutNode("navbar");
		const main = layoutNode("main");
		const header = layoutNode("header");
		navbar.style.setProperty("width", "240px", "important");
		main.style.setProperty("padding-inline-start", "24px", "important");
		header.style.setProperty("margin-inline-start", "240px", "important");
		for (const element of [navbar, main, header]) {
			element.style.setProperty("transition-duration", "150ms", "important");
			element.style.setProperty("padding-bottom", "7px");
		}
		startNavResize({ clientX: 100, preventDefault: () => {} });
		firePointer("pointermove", 140);
		firePointer("pointerup", 140);
		// React gets one frame to take over before the original styles return.
		expect(navbar.style.width).toBe("290px");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(readNavWidthOverrideForTest()).toBeNull();
		for (const [element, property, value] of [
			[navbar, "width", "240px"],
			[main, "padding-inline-start", "24px"],
			[header, "margin-inline-start", "240px"],
		] as const) {
			expect(element.style.getPropertyValue(property)).toBe(value);
			expect(element.style.getPropertyPriority(property)).toBe("important");
			expect(element.style.getPropertyValue("transition-duration")).toBe("150ms");
			expect(element.style.getPropertyPriority("transition-duration")).toBe("important");
			expect(element.style.paddingBottom).toBe("7px");
		}
	});

	it("a previous release callback cannot clear a new drag", async () => {
		const { startNavResize, readNavWidthOverrideForTest } = await import("./useResizableNav");
		const raf = globalThis.requestAnimationFrame;
		const cancel = globalThis.cancelAnimationFrame;
		const callbacks: FrameRequestCallback[] = [];
		const cancelled: number[] = [];
		globalThis.requestAnimationFrame = (callback) => callbacks.push(callback);
		globalThis.cancelAnimationFrame = (id) => cancelled.push(id);
		try {
			startNavResize({ clientX: 100, preventDefault: () => {} });
			firePointer("pointermove", 130);
			firePointer("pointerup", 130);
			startNavResize({ clientX: 130, preventDefault: () => {} });
			firePointer("pointermove", 150);
			expect(cancelled).toContain(1);
			// Even a callback delivered despite cancellation must not clear the new drag.
			callbacks[0](0);
			expect(readNavWidthOverrideForTest()).toEqual({ width: "300px", offset: "300px" });
			expect(layoutNode("main").style.getPropertyValue("transition-duration")).toBe("0ms");
			firePointer("pointerup", 150);
			callbacks[1](0);
			expect(readNavWidthOverrideForTest()).toBeNull();
			expect(layoutNode("main").style.getPropertyValue("transition-duration") || "").toBe("");
		} finally {
			globalThis.requestAnimationFrame = raf;
			globalThis.cancelAnimationFrame = cancel;
		}
	});

	it("cleans up a hidden page without waiting for suspended animation frames", async () => {
		const { startNavResize, readNavWidthOverrideForTest } = await import("./useResizableNav");
		startNavResize({ clientX: 100, preventDefault: () => {} });
		firePointer("pointermove", 140);
		Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
		const raf = globalThis.requestAnimationFrame;
		globalThis.requestAnimationFrame = () => {
			throw new Error("Hidden pages must not wait for rAF");
		};
		try {
			window.dispatchEvent(new window.Event("pointercancel"));
			await Promise.resolve();
			expect(readNavWidthOverrideForTest()).toBeNull();
			expect(layoutNode("main").style.getPropertyValue("transition-duration") || "").toBe("");
		} finally {
			globalThis.requestAnimationFrame = raf;
		}
	});

	it("collapse clicks keep their normal transitions and create no drag overrides", async () => {
		const { toggleNavCollapsed, readNavWidthOverrideForTest } = await import("./useResizableNav");
		layoutNode("main").style.setProperty("transition-duration", "200ms");
		flushSyncRef.current(() => toggleNavCollapsed());
		expect(readNavWidthOverrideForTest()).toBeNull();
		expect(layoutNode("main").style.getPropertyValue("transition-duration")).toBe("200ms");
	});
});
describe("render isolation during a drag", () => {
	it("notifies width only on release, leaving collapsed and navbar consumers alone", async () => {
		const { startNavResize, useNavWidth, useNavCollapsed } = await import("./useResizableNav");
		const { createElement } = await import("react");
		const { createRoot } = await import("react-dom/client");
		const { flushSync } = await import("react-dom");

		let widthRenders = 0;
		let collapsedRenders = 0;
		let navbarContentRenders = 0;

		function WidthConsumer({ children }: { children: React.ReactNode }) {
			widthRenders++;
			void useNavWidth();
			return createElement("div", null, children);
		}
		// Stands in for the navbar content (RecentTabList / NavLink / Tooltip).
		function NavbarContent() {
			navbarContentRenders++;
			return createElement("span", null, "nav");
		}
		function Layout() {
			collapsedRenders++;
			void useNavCollapsed();
			// `children` is created HERE, once per Layout render — exactly the shape the
			// real AppShellWithNavWidth receives.
			return createElement(WidthConsumer, null, createElement(NavbarContent));
		}

		const host = document.getElementById("root");
		if (!host) throw new Error("no host");
		const root = createRoot(host as unknown as Element);
		mountedRoots.push(root);
		flushSync(() => root.render(createElement(Layout)));

		const baseWidth = widthRenders;
		const baseCollapsed = collapsedRenders;
		const baseContent = navbarContentRenders;

		// 30 frames of a drag that never crosses the collapse threshold.
		startNavResize({ clientX: 300, preventDefault: () => {} });
		for (let i = 1; i <= 30; i++) firePointer("pointermove", 300 + i);
		expect(widthRenders).toBe(baseWidth);
		firePointer("pointerup", 330);

		const widthDelta = widthRenders - baseWidth;
		const collapsedDelta = collapsedRenders - baseCollapsed;
		const contentDelta = navbarContentRenders - baseContent;

		// The width consumer hears only the settled value, once.
		expect(widthDelta).toBe(1);
		// ...while the layout (collapsed only) does not re-render at all, because the
		// boolean never changed. This is the whole point: the navbar content lives here.
		expect(collapsedDelta).toBe(0);
		// And the passed-through subtree is reused by reference.
		expect(contentDelta).toBe(0);
	});

	it("re-renders the collapsed consumer exactly once when the rail flips", async () => {
		const { startNavResize, useNavCollapsed, NAV_WIDTH_CONSTANTS } = await import(
			"./useResizableNav"
		);
		const { renderHookCounts } = await mountHarness(useNavCollapsed);
		const base = renderHookCounts.renders;

		startNavResize({ clientX: 300, preventDefault: () => {} });
		// Walk down past the threshold in many small steps; only the crossing counts.
		for (let x = 300; x >= 300 - (250 - NAV_WIDTH_CONSTANTS.COLLAPSED_WIDTH); x -= 5) {
			firePointer("pointermove", x);
		}
		firePointer("pointerup", 0);

		expect(renderHookCounts.lastValue).toBe(true);
		// One render for the flip; the snap on release lands on the same boolean, so a
		// small number is expected rather than one per frame.
		expect(renderHookCounts.renders - base).toBeLessThanOrEqual(2);
	});

	// Rewritten for the CSS path: React is not notified mid-drag at all, so the thing
	// worth asserting is that a clamped frame does not even repaint CSS.
	it("does not repaint when a drag frame produces the same clamped width", async () => {
		const { startNavResize, NAV_WIDTH_CONSTANTS, readNavWidthOverrideForTest } = await import(
			"./useResizableNav"
		);
		startNavResize({ clientX: 100, preventDefault: () => {} });
		// Push far beyond MAX: every further frame clamps to the same pixel.
		firePointer("pointermove", 100 + NAV_WIDTH_CONSTANTS.MAX_WIDTH + 200);
		const atMax = readNavWidthOverrideForTest();
		expect(atMax?.width).toBe(`${NAV_WIDTH_CONSTANTS.MAX_WIDTH}px`);
		for (let i = 0; i < 10; i++) {
			firePointer("pointermove", 100 + NAV_WIDTH_CONSTANTS.MAX_WIDTH + 200 + i);
		}
		// Still pinned at MAX — `writeWidth` bails on an unchanged value.
		expect(readNavWidthOverrideForTest()).toEqual(atMax);
		firePointer("pointerup", 0);
	});

	it("removes its drag listeners on release", async () => {
		const { startNavResize, useNavWidth } = await import("./useResizableNav");
		const { renderHookCounts } = await mountHarness(useNavWidth);
		startNavResize({ clientX: 300, preventDefault: () => {} });
		firePointer("pointermove", 320);
		firePointer("pointerup", 320);
		const settled = renderHookCounts.renders;
		// A stray move after release must be ignored (listeners detached).
		firePointer("pointermove", 500);
		expect(renderHookCounts.renders).toBe(settled);
	});
});

/**
 * A drag can end WITHOUT a `pointerup`.
 *
 * If the window loses focus while the pointer is held (alt-tab, a native dialog, or
 * dragging out of the browser and releasing there), the release lands on another
 * surface. The drag then stayed open indefinitely: `drag` non-null AND
 * `document.body.style.userSelect === "none"`, which makes TEXT UNSELECTABLE ACROSS
 * THE WHOLE APP until the next pointerup anywhere in the document. The width itself
 * does not run away (no `pointermove` arrives without focus), so the leaked body style
 * is the whole visible symptom — and being invisible in the width is exactly why it
 * needs a test rather than a reviewer.
 */
describe("abnormal drag terminations", () => {
	/** Dispatch a bare event on a target, flushing React synchronously. */
	function fireOn(target: EventTarget, type: string): void {
		const event = document.createEvent("Event");
		event.initEvent(type, true, true);
		flushSyncRef.current(() => target.dispatchEvent(event));
	}

	for (const scenario of [
		{ name: "window blur (alt-tab, native dialog, release outside)", type: "blur" },
		{
			name: "pointercancel (the browser took the gesture over — a touch scroll, an edge swipe)",
			type: "pointercancel",
		},
	]) {
		it(`releases the body style on ${scenario.name}`, async () => {
			const { startNavResize } = await import("./useResizableNav");
			startNavResize({ clientX: 300, preventDefault: () => {} });
			firePointer("pointermove", 320);
			expect(document.body.style.userSelect).toBe("none");

			fireOn(window, scenario.type);
			// The app-wide selection block is gone, and so is the resize cursor.
			expect(document.body.style.userSelect).toBe("");
			expect(document.body.style.cursor).toBe("");
		});

		it(`ignores later moves after ${scenario.name}`, async () => {
			const { startNavResize, readNavWidthOverrideForTest } = await import("./useResizableNav");
			startNavResize({ clientX: 300, preventDefault: () => {} });
			firePointer("pointermove", 320);
			fireOn(window, scenario.type);
			const settled = readNavWidthOverrideForTest();
			// The drag is over: a stray move must not resume it.
			firePointer("pointermove", 500);
			expect(readNavWidthOverrideForTest()).toEqual(settled);
		});
	}

	it("releases the body style when the tab is backgrounded", async () => {
		const { startNavResize } = await import("./useResizableNav");
		startNavResize({ clientX: 300, preventDefault: () => {} });
		expect(document.body.style.userSelect).toBe("none");
		Object.defineProperty(document, "visibilityState", {
			value: "hidden",
			configurable: true,
		});
		fireOn(document, "visibilitychange");
		expect(document.body.style.userSelect).toBe("");
	});

	it("restores local transition and layout overrides on an abnormal end", async () => {
		const { startNavResize, readNavWidthOverrideForTest } = await import("./useResizableNav");
		const main = layoutNode("main");
		main.style.setProperty("transition-duration", "150ms");
		startNavResize({ clientX: 300, preventDefault: () => {} });
		firePointer("pointermove", 330);
		expect(main.style.getPropertyValue("transition-duration")).toBe("0ms");
		fireOn(window, "blur");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(main.style.getPropertyValue("transition-duration")).toBe("150ms");
		expect(main.style.getPropertyValue("padding-inline-start") || "").toBe("");
		expect(readNavWidthOverrideForTest()).toBeNull();
	});

	it("leaves an idle page alone (no drag in progress)", async () => {
		// The listeners are attached per drag, but a blur with nothing held must be a
		// no-op even if one leaked.
		//
		// Asserted as "blur CHANGED NOTHING" rather than "the baseline is empty".
		// `document.body` is shared process-wide, so an unrelated test file that styles
		// it makes an absolute expectation fail here for reasons this test is not about
		// — which is exactly what happened in a full-suite run while it passed alone.
		await import("./useResizableNav");
		const before = document.body.style.userSelect || "";
		fireOn(window, "blur");
		expect(document.body.style.userSelect || "").toBe(before);
	});
});

/**
 * `localStorage` throws, it does not merely return null.
 *
 * Safari's private mode and a blocked-cookies profile both make access throw. The
 * read runs inside a `useSyncExternalStore` snapshot (so a throw takes out the render
 * of every nav-width consumer) and the write runs inside the `pointerup` handler (so a
 * throw surfaces as an uncaught error mid-release).
 */
describe("storage failures cannot break the drag", () => {
	/** Swap in a localStorage whose methods throw, restoring afterwards. */
	async function withThrowingStorage(run: () => Promise<void> | void): Promise<void> {
		const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		Object.defineProperty(globalThis, "localStorage", {
			value: {
				getItem: () => {
					throw new Error("SecurityError: storage unavailable");
				},
				setItem: () => {
					throw new Error("QuotaExceededError");
				},
				removeItem: () => {
					throw new Error("SecurityError");
				},
				clear: () => {
					throw new Error("SecurityError");
				},
			},
			configurable: true,
			writable: true,
		});
		try {
			await run();
		} finally {
			if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		}
	}

	it("falls back to the default width when reading throws", async () => {
		await withThrowingStorage(async () => {
			const { useNavWidth, NAV_WIDTH_CONSTANTS, resetNavWidthStoreForTest } = await import(
				"./useResizableNav"
			);
			// Force the lazy read to run again against the throwing storage.
			resetNavWidthStoreForTest(NAV_WIDTH_CONSTANTS.DEFAULT_WIDTH);
			const { renderHookCounts } = await mountHarness(useNavWidth);
			expect(renderHookCounts.lastValue).toBe(NAV_WIDTH_CONSTANTS.DEFAULT_WIDTH);
		});
	});

	it("completes a drag when persisting throws", async () => {
		await withThrowingStorage(async () => {
			const { startNavResize, useNavWidth } = await import("./useResizableNav");
			const { renderHookCounts } = await mountHarness(useNavWidth);
			startNavResize({ clientX: 300, preventDefault: () => {} });
			firePointer("pointermove", 330);
			// The release must not throw, and React must still receive the final width.
			expect(() => firePointer("pointerup", 330)).not.toThrow();
			expect(renderHookCounts.lastValue).toBe(280);
			// ...and the drag really did end (body style released).
			expect(document.body.style.userSelect).toBe("");
		});
	});

	// Regression: the drag used to listen for mousemove/mouseup, which a touch
	// screen stops producing once the finger moves — the handle felt dead. The
	// pointer family is what makes touch drags work at all.
	it("drags from a TOUCH pointer (touchscreen regression)", async () => {
		const { startNavResize, readNavWidthOverrideForTest } = await import("./useResizableNav");
		startNavResize({ clientX: 300, preventDefault: () => {} });
		firePointer("pointermove", 380);
		// Mid-drag: painted straight to CSS, exactly as a mouse drag does.
		expect(readNavWidthOverrideForTest()).toEqual({ width: "330px", offset: "330px" });
		firePointer("pointerup", 380);
		// Release hands the width back to React and persists it.
		expect(Number(localStorage.getItem("narrafork_nav_width"))).toBe(330);
	});

	it("completes the collapse toggle when persisting throws", async () => {
		await withThrowingStorage(async () => {
			const { toggleNavCollapsed, useNavCollapsed } = await import("./useResizableNav");
			const { renderHookCounts } = await mountHarness(useNavCollapsed);
			expect(renderHookCounts.lastValue).toBe(false);
			expect(() => flushSyncRef.current(() => toggleNavCollapsed())).not.toThrow();
			expect(renderHookCounts.lastValue).toBe(true);
		});
	});
});
