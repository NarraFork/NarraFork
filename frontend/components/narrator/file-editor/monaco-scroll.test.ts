import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { editor } from "monaco-editor/editor/editor.api";
import {
	installMonacoScrollBoundary,
	monacoClippedBounds,
	monacoHostVisible,
	revealMonacoPosition,
} from "./monaco-scroll";

let host: HTMLElement;
let dock: HTMLElement;
let original: PropertyDescriptor | undefined;
let hidden = false;
beforeEach(() => {
	const { window } = parseHTML(
		"<html><body><div id='dock'><div id='editor'></div></div></body></html>",
	);
	original = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
	Object.defineProperty(globalThis, "HTMLElement", {
		configurable: true,
		value: window.HTMLElement,
	});
	host = window.document.getElementById("editor") as HTMLElement;
	dock = window.document.getElementById("dock") as HTMLElement;
	hidden = false;
	Object.defineProperty(window, "getComputedStyle", {
		configurable: true,
		value: (element: HTMLElement) => ({
			visibility: hidden ? "hidden" : "visible",
			overflowX: element === dock ? "hidden" : "visible",
			overflowY: element === dock ? "auto" : "visible",
		}),
	});
	Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
	for (const [element, width, height, top, left] of [
		[host, 600, 600, 0, 0],
		[dock, 300, 200, 100, 50],
	] as const) {
		Object.defineProperties(element, {
			clientWidth: { configurable: true, value: width },
			clientHeight: { configurable: true, value: height },
			offsetWidth: { configurable: true, value: width },
			offsetHeight: { configurable: true, value: height },
			clientLeft: { configurable: true, value: 0 },
			clientTop: { configurable: true, value: 0 },
			getBoundingClientRect: {
				configurable: true,
				value: () => ({ top, left, right: left + width, bottom: top + height, width, height }),
			},
			getClientRects: { configurable: true, value: () => [{}] },
		});
	}
});
afterEach(() => {
	if (original) Object.defineProperty(globalThis, "HTMLElement", original);
	else Reflect.deleteProperty(globalThis, "HTMLElement");
});

test("hidden dock visibility is inherited, never overridden by an active editor", () => {
	expect(monacoHostVisible(host)).toBe(true);
	hidden = true;
	expect(monacoHostVisible(host)).toBe(false);
	Object.defineProperty(host, "clientWidth", { configurable: true, value: 0 });
	hidden = false;
	expect(monacoHostVisible(host)).toBe(false);
});

test("clipping respects dock ancestors without scrolling them", () => {
	expect(monacoClippedBounds(host)).toEqual({ top: 100, bottom: 300, left: 50, right: 350 });
});

test("navigation recenters only Monaco scroll offsets within visible ancestor bounds", () => {
	let top = 0;
	let left = 0;
	let reveals = 0;
	const view = {
		revealPositionInCenter: () => {
			reveals++;
		},
		getScrolledVisiblePosition: () => ({ top: 290, left: 500, height: 20 }),
		getScrollTop: () => top,
		setScrollTop: (next: number) => {
			top = next;
		},
		getScrollLeft: () => left,
		setScrollLeft: (next: number) => {
			left = next;
		},
	} as unknown as editor.IStandaloneCodeEditor;
	revealMonacoPosition(view, host, { lineNumber: 50, column: 30 });
	expect(reveals).toBe(1);
	expect(top).toBe(100);
	expect(left).toBe(162);
	expect(dock.scrollTop ?? 0).toBe(0);
	hidden = true;
	revealMonacoPosition(view, host, { lineNumber: 60, column: 30 });
	expect(reveals).toBe(1);
});

test("wheel stays inside editor without disabling its default handling", () => {
	let outerEvents = 0;
	dock.addEventListener("wheel", () => outerEvents++);
	const remove = installMonacoScrollBoundary(host);
	const win = host.ownerDocument.defaultView;
	if (!win) throw new Error("Test window unavailable");
	const event = new win.Event("wheel", { bubbles: true, cancelable: true });
	host.dispatchEvent(event);
	expect(event.defaultPrevented).toBe(false);
	expect(outerEvents).toBe(0);
	remove();
	host.dispatchEvent(new win.Event("wheel", { bubbles: true }));
	expect(outerEvents).toBe(1);
});

test("touch lifecycle reaches Monaco's document listener, which owns scroll prevention", () => {
	const win = host.ownerDocument.defaultView;
	if (!win) throw new Error("Test window unavailable");
	const seen: string[] = [];
	const remove = installMonacoScrollBoundary(host);
	for (const type of ["touchstart", "touchmove", "touchend"]) {
		host.ownerDocument.addEventListener(type, (event) => {
			seen.push(event.type);
			// Monaco's Gesture decides whether a target consumed this touch.
			event.preventDefault();
		});
		const event = new win.Event(type, { bubbles: true, cancelable: true });
		host.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
	}
	expect(seen).toEqual(["touchstart", "touchmove", "touchend"]);
	remove();
});
