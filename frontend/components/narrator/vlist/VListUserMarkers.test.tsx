/**
 * VListUserMarkers.test.tsx — the user-turn quick index in the DOM.
 *
 * What this pins (the pure arithmetic is covered by vlist-user-markers.test.ts):
 *  - marks reach the DOM, one per user turn, positioned from the exact layout's
 *    real document fractions;
 *  - the overlay is height-neutral: a zero-height sticky box, so indexing the
 *    document cannot grow the document (CONTRACT.md §0 iron law 2);
 *  - clicking a mark reports the marker it belongs to;
 *  - the index disappears when scrolling cannot help (short document / no turns),
 *    so a brief conversation keeps a clean right edge;
 *  - the mark track hugs the native scrollbar, falling back to a small gutter on
 *    platforms that report zero scrollbar width (Firefox overlay scrollbars).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const { VListUserMarkers } = await import("./VListUserMarkers");
type VListUserMarker = import("./vlist-user-markers").VListUserMarker;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	class TestResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		ResizeObserver: TestResizeObserver,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) Reflect.set(globalThis, key, value);
			continue;
		}
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

/**
 * A stand-in scroll viewport whose scrollbar occupies `scrollbarWidth` px.
 *
 * linkedom reports every size as 0, so the two reads the overlay makes
 * (`offsetWidth` / `clientWidth`) are defined explicitly.
 */
function makeViewport(scrollbarWidth: number): { current: HTMLElement } {
	const node = document.createElement("div");
	Object.defineProperty(node, "offsetWidth", { configurable: true, value: 800 });
	Object.defineProperty(node, "clientWidth", { configurable: true, value: 800 - scrollbarWidth });
	return { current: node as unknown as HTMLElement };
}

function marker(ordinal: number, fraction: number, top: number): VListUserMarker {
	return {
		key: `m${ordinal}-bubble`,
		itemIndex: ordinal,
		top,
		fraction,
		ordinal,
		preview: `turn ${ordinal}`,
	};
}

const MARKERS = [marker(1, 0, 16), marker(2, 0.5, 2000), marker(3, 1, 4000)];

async function renderMarkers(
	overrides: {
		markers?: readonly VListUserMarker[];
		documentHeight?: number;
		trackHeight?: number;
		onJump?: (m: VListUserMarker) => void;
		scrollbarWidth?: number;
	} = {},
): Promise<void> {
	const viewportRef = makeViewport(overrides.scrollbarWidth ?? 15);
	await act(async () => {
		root?.render(
			<VListUserMarkers
				markers={overrides.markers ?? MARKERS}
				documentHeight={overrides.documentHeight ?? 4200}
				trackHeight={overrides.trackHeight ?? 600}
				onJump={overrides.onJump ?? (() => {})}
				viewportRef={viewportRef}
				resolveLabel={(ordinal) => `jump-${ordinal}`}
			/>,
		);
	});
}

function overlayEl(): HTMLElement | null {
	return container?.querySelector("[data-vlist-user-markers]") as HTMLElement | null;
}

function markEls(): HTMLElement[] {
	return Array.from(
		container?.querySelectorAll("[data-vlist-user-marker]") ?? [],
	) as unknown as HTMLElement[];
}

describe("VListUserMarkers", () => {
	test("renders one mark per user turn, in document order", async () => {
		await renderMarkers();
		const marks = markEls();
		expect(marks).toHaveLength(3);
		expect(marks.map((mark) => mark.getAttribute("data-vlist-user-marker"))).toEqual([
			"1",
			"2",
			"3",
		]);
	});

	test("positions marks from the document fraction, keeping the last one in the track", async () => {
		await renderMarkers({ trackHeight: 600 });
		const tops = markEls().map((mark) => mark.style.top);
		// travel = 600 - 6 (mark height) = 594. React serializes a zero-valued
		// numeric style property unitless, hence "0" rather than "0px".
		expect(tops).toEqual(["0", "297px", "594px"]);
	});

	test("is height-neutral: a zero-height sticky box that cannot grow the document", async () => {
		await renderMarkers();
		const overlay = overlayEl();
		expect(overlay).not.toBeNull();
		expect(overlay?.style.position).toBe("sticky");
		// React writes a zero-valued numeric style property unitless.
		expect(overlay?.style.height).toBe("0");
		// Every mark is absolutely positioned inside it, so none of them are in flow.
		for (const mark of markEls()) expect(mark.style.position).toBe("absolute");
	});

	test("reports the clicked marker so the shell can jump to its offset", async () => {
		const jumped: VListUserMarker[] = [];
		await renderMarkers({ onJump: (m) => jumped.push(m) });
		await act(async () => {
			markEls()[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(jumped).toHaveLength(1);
		expect(jumped[0]?.ordinal).toBe(2);
		// The shell scrolls by the marker's real document offset, not a percentage.
		expect(jumped[0]?.top).toBe(2000);
	});

	test("hides itself when scrolling cannot help", async () => {
		// Document fits the viewport → the index would only point at visible content.
		await renderMarkers({ documentHeight: 500, trackHeight: 600 });
		expect(overlayEl()).toBeNull();
		// No user turns at all.
		await renderMarkers({ markers: [] });
		expect(overlayEl()).toBeNull();
		// Viewport not measured yet.
		await renderMarkers({ trackHeight: 0 });
		expect(overlayEl()).toBeNull();
	});

	test("hugs the native scrollbar, with a small gutter when it reports zero width", async () => {
		await renderMarkers({ scrollbarWidth: 15 });
		const track = overlayEl()?.firstElementChild as HTMLElement | null;
		expect(track?.style.right).toBe("15px");
		// Firefox overlay scrollbars / macOS auto-hide report 0 — fall back to 2px so
		// the marks stay visible at the right edge instead of sitting under it.
		await renderMarkers({ scrollbarWidth: 0 });
		const overlayTrack = overlayEl()?.firstElementChild as HTMLElement | null;
		expect(overlayTrack?.style.right).toBe("2px");
	});

	test("labels each mark for assistive tech and previews its text on hover", async () => {
		await renderMarkers();
		const second = markEls()[1];
		expect(second?.getAttribute("aria-label")).toBe("jump-2");
		expect(second?.getAttribute("title")).toBe("#2 · turn 2");
		// Not a tab stop: the index is a pointer affordance beside the scrollbar, and
		// N marks would otherwise insert N tab stops into the reading flow.
		expect(second?.getAttribute("tabindex")).toBe("-1");
	});

	test("omits the preview separator for a text-less turn (attachment only)", async () => {
		await renderMarkers({
			markers: [{ ...marker(1, 0.5, 100), preview: "" }],
		});
		expect(markEls()[0]?.getAttribute("title")).toBe("#1");
	});
});
