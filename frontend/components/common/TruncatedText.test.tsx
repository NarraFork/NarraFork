import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { isTextClipped, TruncatedText } from "./TruncatedText";

describe("isTextClipped", () => {
	test("reports overflow only past the sub-pixel epsilon", () => {
		expect(isTextClipped({ scrollWidth: 300, clientWidth: 120 })).toBe(true);
		expect(isTextClipped({ scrollWidth: 120, clientWidth: 120 })).toBe(false);
		// Fractional rounding on text that really fits must not look like overflow.
		expect(isTextClipped({ scrollWidth: 120.4, clientWidth: 120 })).toBe(false);
	});

	test("treats unmeasurable elements as not clipped", () => {
		// No layout engine (SSR / plain test DOM) reports 0, and a hidden or
		// not-yet-laid-out element has no width — neither may claim truncation,
		// otherwise every label would show a redundant tooltip.
		expect(isTextClipped({})).toBe(false);
		expect(isTextClipped({ scrollWidth: 0, clientWidth: 0 })).toBe(false);
		expect(isTextClipped({ scrollWidth: 300, clientWidth: 0 })).toBe(false);
	});
});

const GLOBAL_KEYS = [
	"window",
	"document",
	"navigator",
	"Event",
	"MouseEvent",
	"PointerEvent",
	"HTMLElement",
	"HTMLButtonElement",
	"HTMLInputElement",
	"SVGElement",
	"Element",
	"Node",
	"ResizeObserver",
	"matchMedia",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"getComputedStyle",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let restoreGlobals: (() => void) | undefined;

/**
 * Width the fake layout engine reports for a text element:
 * `clientWidth` is the box, `scrollWidth` grows with the string length so a
 * long label overflows and a short one does not.
 */
const FAKE_BOX_WIDTH = 100;
const FAKE_CHAR_WIDTH = 10;

class NoopResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

function installIsolatedDom() {
	const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
	for (const key of GLOBAL_KEYS)
		descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));

	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	const requestAnimationFrame = (callback: FrameRequestCallback) =>
		Number(setTimeout(() => callback(0), 0));
	const cancelAnimationFrame = (id: number) => clearTimeout(id);

	// linkedom shares one HTMLElement.prototype across every parseHTML window, so
	// these stubs are process-global and are handed back in restoreGlobals below —
	// otherwise later test FILES inherit this file's fake text metrics.
	const geometryProto = window.HTMLElement.prototype;
	const previousGeometry = new Map(
		["clientWidth", "scrollWidth"].map((key) => [
			key,
			Object.getOwnPropertyDescriptor(geometryProto, key),
		]),
	);
	Object.defineProperties(geometryProto, {
		clientWidth: { configurable: true, get: () => FAKE_BOX_WIDTH },
		scrollWidth: {
			configurable: true,
			get(this: HTMLElement) {
				return Math.max(FAKE_BOX_WIDTH, (this.textContent?.length ?? 0) * FAKE_CHAR_WIDTH);
			},
		},
	});

	// floating-ui probes the platform when the tooltip mounts, and linkedom has no
	// `navigator.platform` — reading it undefined throws inside its Safari check.
	// `window.navigator` builds a NEW object on every access, so the patched
	// instance has to be captured and then installed as the one navigator.
	const navigator = window.navigator;
	Object.defineProperty(navigator, "platform", {
		configurable: true,
		value: "Linux x86_64",
	});
	Object.defineProperty(window, "navigator", { configurable: true, value: navigator });

	const globals = {
		window,
		document: window.document,
		navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		PointerEvent: window.PointerEvent ?? window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		HTMLButtonElement: window.HTMLButtonElement,
		HTMLInputElement: window.HTMLInputElement,
		SVGElement: window.SVGElement,
		Element: window.Element,
		Node: window.Node,
		ResizeObserver: NoopResizeObserver,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}

	restoreGlobals = () => {
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		for (const [key, descriptor] of previousGeometry) {
			if (descriptor) Object.defineProperty(geometryProto, key, descriptor);
			else Reflect.deleteProperty(geometryProto, key);
		}
	};
}

async function render(text: string) {
	await act(async () => {
		root?.render(
			<MantineProvider env="test">
				<TruncatedText text={text} openDelay={0} />
			</MantineProvider>,
		);
	});
}

/** The rendered text node. */
function textElement(): HTMLElement | null {
	return container?.querySelector<HTMLElement>("[data-truncate]") ?? null;
}

beforeEach(() => {
	installIsolatedDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
	restoreGlobals?.();
	restoreGlobals = undefined;
});

describe("TruncatedText", () => {
	test("always renders the text with single-line truncation", async () => {
		await render("short");
		// The visible string is unchanged; only the reveal affordance is conditional.
		expect(container?.textContent).toContain("short");
	});

	test("arms the tooltip only while the text is actually clipped", async () => {
		// A closed Mantine tooltip renders nothing, so the component mirrors its own
		// gate onto the text element. That attribute is what feeds `disabled`.
		await render("x".repeat(60));
		expect(textElement()?.getAttribute("data-overflow-tooltip")).toBe("armed");

		// Same element, shorter content: the gate must close again so a label that
		// fits does not carry a tooltip repeating what is already visible.
		await render("x");
		expect(textElement()?.getAttribute("data-overflow-tooltip")).toBeNull();
	});

	test("does not arm the tooltip for empty text", async () => {
		await render("");
		expect(textElement()?.getAttribute("data-overflow-tooltip")).toBeNull();
	});
});
