/**
 * RenderWebSearch.align.test.tsx — native web-search text must sit optically
 * next to the 18px icon, not below it.
 *
 * The bug this locks down: Virtual-list mode painted each fragment as an
 * inline-block with `lineHeight: 17px` (the reserved xs line box) inside a
 * flex row that inherited the document body strut (Mantine 16px × 1.55). The
 * glyphs therefore sat on that taller baseline and read several pixels below
 * the 18px ThemeIcon. Classic mode uses Mantine Text size="xs" and does not
 * have this offset.
 *
 * The contract:
 *   1. the reserved 17px line box stays (height model unchanged);
 *   2. the line container kills the inherited strut (`fontSize: 0`);
 *   3. each fragment paints at `lineHeight: 1` so flex can centre the 12px
 *      em-box inside the reserved line.
 */

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installCanvasStub } from "../measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.getComputedStyle = win.getComputedStyle;
	g.IS_REACT_ACT_ENVIRONMENT = true;
	if (typeof g.matchMedia !== "function") {
		g.matchMedia = () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		});
	}
	if (typeof g.ResizeObserver !== "function") {
		g.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
	if (typeof g.requestAnimationFrame !== "function") {
		g.requestAnimationFrame = (cb: (t: number) => void) =>
			setTimeout(() => cb(Date.now()), 0) as unknown as number;
		g.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as Timer);
	}
});

const { RenderWebSearch } = await import("./RenderWebSearch");
const { measureWebSearch, MEASURE_WEB_SEARCH_CONSTANTS } = await import(
	"../measure/measure-web-search"
);

let currentRoot: Root | null = null;
let currentContainer: HTMLElement | null = null;

afterEach(() => {
	act(() => currentRoot?.unmount());
	currentRoot = null;
	currentContainer = null;
});

function renderCard() {
	const measured = measureWebSearch(
		{ query: "cats", status: "completed", label: "Searched" },
		600,
		5,
	);
	const container = document.createElement("div");
	document.body.appendChild(container);
	currentContainer = container as unknown as HTMLElement;
	const root = createRoot(currentContainer);
	currentRoot = root;
	act(() => {
		root.render(
			<MantineProvider>
				<RenderWebSearch measured={measured} isSearching={false} />
			</MantineProvider>,
		);
	});
	return { measured, container: currentContainer };
}

describe("RenderWebSearch optical alignment", () => {
	it("keeps the reserved 17px line box and centres the 12px glyphs inside it", () => {
		const { container } = renderCard();
		const line = container.querySelector("[data-vlist-ws-line]") as HTMLElement | null;
		expect(line).not.toBeNull();
		if (!line) return;
		expect(line.style.height).toBe(`${MEASURE_WEB_SEARCH_CONSTANTS.WEB_SEARCH_TEXT_LINE_HEIGHT}px`);
		// linkedom serializes the numeric `0` as "0"; browsers use "0px". Either
		// form still kills the inherited body strut.
		expect(["0", "0px"]).toContain(line.style.fontSize);
		expect(line.style.lineHeight).toBe("1");
		expect(line.style.alignItems).toBe("center");

		const textLane = container.querySelector("[data-vlist-ws-text]") as HTMLElement | null;
		expect(textLane).not.toBeNull();
		if (!textLane) return;
		expect(["0", "0px"]).toContain(textLane.style.top);

		const fragments = Array.from(line.querySelectorAll("span")).filter(
			(el) =>
				el.getAttribute("data-vlist-frag-gap") == null &&
				el.getAttribute("data-vlist-line-frags") == null,
		);
		expect(fragments.length).toBeGreaterThan(0);
		for (const frag of fragments) {
			expect((frag as HTMLElement).style.lineHeight).toBe("1");
		}
	});
});
