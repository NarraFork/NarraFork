/**
 * MermaidDiagram.interaction.test.tsx — DOM tests for the diagram's click model.
 *
 * Pins the reported bug and its real cause. Clicking the diagram body should ONLY
 * open the fullscreen pan/zoom view, but it also appeared to switch the inline
 * diagram to "actual size". Nothing was toggling the size state: the click opens
 * fullscreen → the component re-renders → React saw a NEW `{__html: svg}` object
 * (compared by identity) → it re-wrote `innerHTML`, replacing the <svg> node and
 * discarding the inline width/height `applySvgSize` had written. Losing the
 * `max-height` cap is visually indistinguishable from switching to actual size,
 * and it never came back because the sizing effect did not re-run.
 *
 * The assertions therefore check the inline SVG's SIZING survives a body click,
 * and that the two controls stay independent.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const realReactI18nextModule = { ...(await import("react-i18next")) };

mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

// mermaid itself is never loaded in tests: the component's render effect is
// awaited through this stub so a deterministic <svg> lands in the host.
mock.module("mermaid", () => ({
	default: {
		initialize: () => {},
		render: async (_id: string, _code: string) => ({
			svg: '<svg viewBox="0 0 400 900" width="100%" style="max-width:400px"><g></g></svg>',
		}),
	},
}));

const { MermaidDiagram } = await import("./MermaidDiagram");

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function installDom() {
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
	const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
	const cancelAnimationFrame = (id: number) => clearTimeout(id);
	Object.defineProperties(window, {
		requestAnimationFrame: { configurable: true, writable: true, value: requestAnimationFrame },
		cancelAnimationFrame: { configurable: true, writable: true, value: cancelAnimationFrame },
		matchMedia: { configurable: true, writable: true, value: matchMedia },
	});
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
		SVGElement: window.SVGElement ?? window.Element,
		ResizeObserver: TestResizeObserver,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
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

const CODE = "flowchart TD\n  A-->B";

async function renderDiagram() {
	await act(async () => {
		root?.render(
			<MantineProvider>
				<MermaidDiagram code={CODE} />
			</MantineProvider>,
		);
	});
	// One more flush so the render effect's promise chain settles.
	await act(async () => {
		await Promise.resolve();
	});
}

function inlineSvg(): SVGSVGElement {
	const host = document.querySelector("[data-nf-mermaid-body]");
	const svg = host?.querySelector("svg");
	if (!svg) throw new Error("inline svg not rendered");
	return svg as unknown as SVGSVGElement;
}

function body(): HTMLElement {
	const el = document.querySelector("[data-nf-mermaid-body]");
	if (!el) throw new Error("diagram body not found");
	return el as HTMLElement;
}

function sizeToggle(): HTMLElement {
	const el = document.querySelector("[data-nf-mermaid-size-toggle]");
	if (!el) throw new Error("size toggle not found");
	return el as HTMLElement;
}

function fullscreenOpen(): boolean {
	return document.querySelectorAll("[data-nf-mermaid-fullscreen]").length > 0;
}

/** The inline max-height cap, which is what the size mode controls. */
function inlineMaxHeight(): string {
	return inlineSvg().style.maxHeight;
}

/**
 * The full inline style. `applySvgSize` owns this; mermaid's own untouched output
 * is `max-width:400px`, so seeing that back means our sizing was lost.
 */
function inlineStyleAttr(): string {
	return inlineSvg().getAttribute("style") ?? "";
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

afterAll(() => {
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.restore();
});

describe("clicking the diagram body", () => {
	test("opens fullscreen and KEEPS the inline diagram at its fit height", async () => {
		await renderDiagram();
		const before = inlineStyleAttr();
		expect(inlineMaxHeight()).toBe("320px"); // starts in "fit" (capped)

		await act(async () => {
			body().click();
		});

		expect(fullscreenOpen()).toBe(true);
		// The decisive assertion: the inline diagram's sizing survives the re-render
		// the fullscreen state change causes. Before the fix this became
		// `max-width:400px` (mermaid's own output) with no height cap at all, which
		// read to the user as "it also switched to actual size".
		expect(inlineMaxHeight()).toBe("320px");
		expect(inlineStyleAttr()).toBe(before);
	});

	test("still shows the fit height after fullscreen is closed again", async () => {
		await renderDiagram();
		await act(async () => {
			body().click();
		});
		const close = document.body.querySelector(
			'button[aria-label="imageViewer_close"]',
		) as HTMLElement | null;
		await act(async () => {
			close?.click();
		});
		expect(fullscreenOpen()).toBe(false);
		expect(inlineMaxHeight()).toBe("320px");
	});
});

describe("clicking the size toggle", () => {
	test("switches to actual size WITHOUT opening fullscreen", async () => {
		await renderDiagram();
		await act(async () => {
			sizeToggle().click();
		});

		expect(inlineMaxHeight()).toBe("none"); // uncapped = "actual"
		// The toggle sits inside the diagram container, above the body that carries
		// the fullscreen shortcut. Its click must not reach it.
		expect(fullscreenOpen()).toBe(false);
	});

	test("switches back to fit size on a second click", async () => {
		await renderDiagram();
		await act(async () => {
			sizeToggle().click();
		});
		await act(async () => {
			sizeToggle().click();
		});
		expect(inlineMaxHeight()).toBe("320px");
		expect(fullscreenOpen()).toBe(false);
	});
});
