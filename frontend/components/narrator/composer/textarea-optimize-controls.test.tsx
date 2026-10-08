/**
 * The reserved strip for the composer's optimize/expand buttons.
 *
 * This exists to pin the FAILURE MODE, not just the happy value. The original bug was a silently
 * invalid CSS declaration: Mantine writes `rightSectionWidth` verbatim into
 * `--input-right-section-width` and the input reads that variable as its `padding-inline-end`, so
 * the literal `"auto"` produced a declaration the browser drops — the input kept its default
 * inline padding while `.section` still grew to the buttons' real width, and the buttons covered
 * the tail of the text. Nothing threw, nothing logged; only the rendering was wrong.
 *
 * So the assertions here are about the VALUE REACHING CSS: it must be a real length, derived from
 * the controls' own geometry. A regression would show up as a non-length (which is what makes the
 * padding silently disappear) rather than as a failed measurement.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider, Textarea } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { textareaOptimizeControlsWidth } from "./TextareaOptimizeControls";

const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
let root: Root;
let host: HTMLElement;

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		getComputedStyle: (): Partial<CSSStyleDeclaration> => ({
			getPropertyValue: () => "0px",
			direction: "ltr",
			boxSizing: "border-box",
			borderBottomWidth: "0",
			borderTopWidth: "0",
			paddingBottom: "0",
			paddingTop: "0",
		}),
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		requestAnimationFrame: (): number => 1,
		cancelAnimationFrame: () => {},
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	host = document.createElement("div");
	document.body.appendChild(host);
});

afterEach(() => {
	act(() => {
		root?.unmount();
	});
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousGlobals.clear();
});

/** Render a Textarea with the given rightSectionWidth and return its wrapper's inline style. */
function renderTextarea(width: number | string | undefined): CSSStyleDeclaration {
	root = createRoot(host);
	act(() => {
		root.render(
			<MantineProvider>
				<Textarea rightSection={<span />} rightSectionWidth={width as never} label="composer" />
			</MantineProvider>,
		);
	});
	const wrapper = host.querySelector(".mantine-Textarea-wrapper");
	if (!wrapper) throw new Error("Textarea wrapper not rendered");
	return (wrapper as HTMLElement).style;
}

describe("textareaOptimizeControlsWidth", () => {
	test("reserves both buttons, the gap, and the right inset", () => {
		// 22 (ActionIcon size="sm", i.e. Mantine --ai-size-sm) × 2 + 4 gap + 8 inset.
		expect(textareaOptimizeControlsWidth(true)).toBe(56);
	});

	test("reserves a narrower strip when the expand button is absent", () => {
		// The fullscreen editor passes no `onExpand`, so only the optimize button is rendered.
		// Reserving the two-button width there would leave a visible dead gutter.
		expect(textareaOptimizeControlsWidth(false)).toBe(30);
	});

	test("returns a usable CSS length for every case it is called with", () => {
		for (const hasExpand of [true, false]) {
			const width = textareaOptimizeControlsWidth(hasExpand);
			expect(Number.isFinite(width)).toBe(true);
			expect(width).toBeGreaterThan(0);
			expect(`${width}px`).toMatch(/^\d+px$/);
		}
	});
});

describe("the width Mantine actually applies to the input", () => {
	test("a numeric width reaches CSS as a length the browser accepts", () => {
		// The variable the input's `padding-inline-end` is built from. Mantine runs a NUMBER
		// through its `rem()` helper, yielding `calc(3.5rem * var(--mantine-scale))` for 56 — a
		// real length, so the padding is applied and the buttons clear the text. Asserted on the
		// shape (a number plus a length unit) rather than on the exact string, so a change to
		// Mantine's rem formatting does not fail this test for the wrong reason.
		const applied = renderTextarea(textareaOptimizeControlsWidth(true)).getPropertyValue(
			"--input-right-section-width",
		);
		expect(applied).toMatch(/\d/);
		expect(applied).toMatch(/\d(px|rem)\b/);
		expect(applied).not.toBe("auto");
	});

	test('the literal "auto" is what made the padding disappear', () => {
		// Documents WHY the call sites cannot pass "auto": Mantine passes it through verbatim, and
		// `padding-inline-end: auto` is not a valid length, so the declaration is dropped while the
		// section keeps its content width. Asserted rather than described because this is the exact
		// value a future refactor would be tempted to reintroduce.
		const style = renderTextarea("auto");
		const applied = style.getPropertyValue("--input-right-section-width");
		expect(applied).toBe("auto");
		expect(Number.isNaN(Number.parseFloat(applied))).toBe(true);
	});
});
