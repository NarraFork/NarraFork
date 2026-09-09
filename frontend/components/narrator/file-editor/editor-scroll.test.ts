import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { editor } from "monaco-editor/editor/editor.api";
import { monacoClippedBounds, revealMonacoPosition } from "./monaco-scroll";

let original: PropertyDescriptor | undefined;
beforeEach(() => {
	original = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
});
afterEach(() => {
	if (original) Object.defineProperty(globalThis, "HTMLElement", original);
	else Reflect.deleteProperty(globalThis, "HTMLElement");
});
function fixture(scale = 1) {
	const { window } = parseHTML(
		"<html><body><div id='dock'><div id='editor'></div></div></body></html>",
	);
	Object.defineProperty(globalThis, "HTMLElement", {
		configurable: true,
		value: window.HTMLElement,
	});
	const host = window.document.getElementById("editor") as HTMLElement;
	const dock = window.document.getElementById("dock") as HTMLElement;
	let clipped = false;
	let hidden = false;
	let missingGeometry = false;
	let reads = 0;
	let reveals = 0;
	let scrollTop = 0;
	let scrollLeft = 0;
	Object.defineProperties(window, {
		innerHeight: { configurable: true, value: 2000 },
		innerWidth: { configurable: true, value: 2000 },
		getComputedStyle: {
			configurable: true,
			value: (element: HTMLElement) => ({
				visibility: hidden ? "hidden" : "visible",
				overflowX: clipped && element === dock ? "hidden" : "visible",
				overflowY: clipped && element === dock ? "hidden" : "visible",
			}),
		},
		scrollBy: {
			configurable: true,
			value: () => {
				throw new Error("must not scroll window");
			},
		},
	});
	for (const [element, height] of [
		[host, 200],
		[dock, 100],
	] as const) {
		Object.defineProperties(element, {
			clientWidth: { configurable: true, value: 300 },
			clientHeight: { configurable: true, value: height },
			offsetWidth: { configurable: true, value: 300 },
			offsetHeight: { configurable: true, value: height },
			clientLeft: { configurable: true, value: 0 },
			clientTop: { configurable: true, value: 0 },
			getBoundingClientRect: {
				configurable: true,
				value: () => ({
					top: 50,
					left: 20,
					width: 300 * scale,
					height: height * scale,
					right: 20 + 300 * scale,
					bottom: 50 + height * scale,
				}),
			},
			getClientRects: { configurable: true, value: () => [{}] },
		});
	}
	Object.defineProperties(dock, {
		scrollTop: {
			configurable: true,
			set: () => {
				throw new Error("must not scroll dock");
			},
		},
		scrollLeft: {
			configurable: true,
			set: () => {
				throw new Error("must not scroll dock");
			},
		},
	});
	const view = {
		revealPositionInCenter: () => {
			reveals++;
		},
		getScrolledVisiblePosition: () => {
			reads++;
			if (missingGeometry) {
				missingGeometry = false;
				return null;
			}
			return { top: 300 - scrollTop, left: 500 - scrollLeft, height: 20 };
		},
		getScrollTop: () => scrollTop,
		setScrollTop: (next: number) => {
			scrollTop = next;
		},
		getScrollLeft: () => scrollLeft,
		setScrollLeft: (next: number) => {
			scrollLeft = next;
		},
	} as unknown as editor.IStandaloneCodeEditor;
	return {
		view,
		host,
		window,
		get reads() {
			return reads;
		},
		get reveals() {
			return reveals;
		},
		get top() {
			return scrollTop;
		},
		get left() {
			return scrollLeft;
		},
		clip: () => {
			clipped = true;
		},
		hide: () => {
			hidden = true;
		},
		missOnce: () => {
			missingGeometry = true;
		},
	};
}

describe("editor scroll boundary (Monaco migration)", () => {
	test.each([
		1, 0.7, 1.5,
	])("scrolls internally and repeated centering is stable at scale %s", (scale) => {
		const f = fixture(scale);
		expect(f.reads).toBe(0);
		expect(revealMonacoPosition(f.view, f.host, { lineNumber: 1, column: 1 })).toBe(true);
		expect(f.top).toBeCloseTo(210);
		expect(f.left).toBeCloseTo(200 + 12 / scale);
		revealMonacoPosition(f.view, f.host, { lineNumber: 1, column: 1 });
		expect(f.top).toBeCloseTo(210);
		expect(f.left).toBeCloseTo(200 + 12 / scale);
	});
	test("clipped ancestors change centering bounds but are never themselves scrolled", () => {
		const f = fixture();
		f.clip();
		expect(monacoClippedBounds(f.host)).toEqual({ top: 50, bottom: 150, left: 20, right: 320 });
		revealMonacoPosition(f.view, f.host, { lineNumber: 1, column: 1 });
		expect(f.top).toBe(260);
	});
	test("missing wrapped-line geometry requests refinement after the first internal reveal", () => {
		const f = fixture();
		f.missOnce();
		expect(revealMonacoPosition(f.view, f.host, { lineNumber: 1, column: 1 })).toBe(false);
		expect(f.reveals).toBe(1);
		expect(revealMonacoPosition(f.view, f.host, { lineNumber: 1, column: 1 })).toBe(true);
		expect(f.reads).toBe(2);
		expect(f.top).toBe(210);
	});
	test("hidden and zero-height editors never reveal, measure or scroll an ancestor", () => {
		const f = fixture();
		f.hide();
		expect(revealMonacoPosition(f.view, f.host, { lineNumber: 1, column: 1 })).toBe(false);
		expect(f.reads).toBe(0);
		expect(f.reveals).toBe(0);
		const collapsed = fixture();
		Object.defineProperty(collapsed.host, "clientHeight", { configurable: true, value: 0 });
		expect(revealMonacoPosition(collapsed.view, collapsed.host, { lineNumber: 1, column: 1 })).toBe(
			false,
		);
		expect(collapsed.reads).toBe(0);
		expect(collapsed.top).toBe(0);
	});
	test("visual viewport clipping is respected for embedded mobile layouts", () => {
		const f = fixture();
		Object.defineProperty(f.window, "visualViewport", {
			configurable: true,
			value: { offsetTop: 100, offsetLeft: 40, width: 180, height: 100 },
		});
		expect(monacoClippedBounds(f.host)).toEqual({ top: 100, bottom: 200, left: 40, right: 220 });
		revealMonacoPosition(f.view, f.host, { lineNumber: 1, column: 1 });
		expect(f.top).toBe(210);
		expect(f.left).toBe(312);
	});
});
