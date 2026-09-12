/**
 * VListContentViewHost.test.tsx — the per-body viewer affordances in the DOM.
 *
 * What the vlist was missing (and this pins):
 *  - a hover action bar on each content body, offering source / wrap / copy /
 *    fullscreen, the way the chunked `ContentViewer` does;
 *  - the bar appearing ONLY on hover (a scrolling list must not build Tooltip /
 *    CopyButton trees for bodies nobody is pointing at);
 *  - the bar being height-neutral — a zero-height absolute overlay, so it cannot
 *    move the row it decorates.
 *
 * i18n returns raw keys so the assertions are label-stable.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MantineProvider } from "@mantine/core";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

let isMobileViewport = false;

mock.module("@mantine/hooks", () => ({
	useMediaQuery: () => isMobileViewport,
	useClipboard: () => ({ copy: () => {}, copied: false, reset: () => {} }),
}));
// Empty resources preserve key-based assertions without replacing a shared module export.
const testI18n = i18next.createInstance();
await testI18n.init({
	lng: "en",
	fallbackLng: "en",
	resources: { en: { common: {}, narrator: {} } },
	defaultNS: "common",
	react: { useSuspense: false },
});

const { RenderLodCtx } = await import("../lod/RenderLodCtx");
const { AutoFollowScroll } = await import("../scroll/AutoFollowScroll");
const { VListContentViewHost } = await import("./VListContentViewHost");
type VListViewTarget = import("./vlist-content-view-target").VListViewTarget;
type VListViewControls = import("./VListContentViewHost").VListViewControls;
type ContentViewportSnapshot = import("../scroll/AutoFollowScroll").ContentViewportSnapshot;
let readerProgress: ((node: HTMLElement, snapshot?: ContentViewportSnapshot) => void) | undefined;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** Viewport width the stubbed DOM reports (feeds the floating bar's `right`). */
const TEST_VIEWPORT_WIDTH = 1000;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	// linkedom has no layout, so the float tracker's `window.innerWidth` read needs
	// a value; without it the floating `right` resolves to NaN.
	Object.defineProperty(window, "innerWidth", {
		configurable: true,
		writable: true,
		value: TEST_VIEWPORT_WIDTH,
	});
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
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		innerWidth: TEST_VIEWPORT_WIDTH,
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

const CODE_TARGET: VListViewTarget = {
	owner: { specKey: "owner-tool" },
	id: "tool-tu_1:b0",
	slot: "b0",
	kind: "code",
	text: "const a = 1;",
};

const MARKDOWN_TARGET: VListViewTarget = {
	owner: { specKey: "owner-tool" },
	id: "m1-b0:body",
	slot: "body",
	kind: "markdown",
	text: "# hi",
	// The row's renderer honours an in-place source view, which is what the bar's
	// source/rendered toggle is gated on.
	sourceInline: true,
};

/**
 * A markdown body whose ROW cannot swap in the raw source (e.g. a collapsed
 * reasoning run, which paints no body at all). The toggle must not be offered:
 * it would only flip shell state that no renderer reads.
 */
const MARKDOWN_NO_INLINE_SOURCE: VListViewTarget = {
	owner: { specKey: "owner-tool" },
	id: "m1-b1:body",
	slot: "body",
	kind: "markdown",
	text: "# hi",
};

const DIFF_TARGET: VListViewTarget = {
	owner: { specKey: "owner-tool" },
	id: "tool-tu_2:b0",
	slot: "b0",
	kind: "diff",
	text: "-a\n+b",
};

/** A body whose payload is only a server-side prefix (the auto-load case). */
const TRUNCATED_TARGET: VListViewTarget = {
	owner: { specKey: "owner-tool" },
	id: "tool-tu_3:b0",
	slot: "b0",
	kind: "term",
	text: "first 8KB of output…",
	truncated: true,
};

interface Recorded {
	wrapToggles: string[];
	sourceToggles: string[];
	opened: string[];
	payloadRequests: string[];
}

function makeControls(overrides: Partial<VListViewControls> = {}): {
	controls: VListViewControls;
	recorded: Recorded;
} {
	const recorded: Recorded = {
		wrapToggles: [],
		sourceToggles: [],
		opened: [],
		payloadRequests: [],
	};
	const controls: VListViewControls = {
		isWrapped: () => true,
		isSourceShown: () => false,
		toggleWrap: (target) => recorded.wrapToggles.push(target.id),
		toggleSource: (target) => recorded.sourceToggles.push(target.id),
		openFullscreen: (target) => recorded.opened.push(target.id),
		requestFullPayload: (target) => recorded.payloadRequests.push(target.id),
		...overrides,
	};
	return { controls, recorded };
}

async function renderHost(opts: {
	target?: VListViewTarget;
	controls?: VListViewControls;
	/** Render on a non-interactive surface (workspace preview). */
	interactive?: boolean;
}): Promise<void> {
	await act(async () => {
		root?.render(
			<I18nextProvider i18n={testI18n}>
				<MantineProvider>
					<RenderLodCtx.Provider value={{ lod: 5, interactive: opts.interactive !== false }}>
						<VListContentViewHost target={opts.target} controls={opts.controls}>
							{(onReaderProgress) => {
								readerProgress = onReaderProgress;
								return (
									<AutoFollowScroll
										bodyId={opts.target?.id ?? "fixture-body"}
										onReaderProgress={onReaderProgress}
										viewportStyle={{ height: 200 }}
									>
										<div data-testid="body">
											<div data-testid="nested-scrollbox">body</div>
										</div>
									</AutoFollowScroll>
								);
							}}
						</VListContentViewHost>
					</RenderLodCtx.Provider>
				</MantineProvider>
			</I18nextProvider>,
		);
	});
}

/**
 * Scroll the inner box to `ratio` of its scrollable range and fire `scroll`.
 *
 * linkedom has no layout, so the three metrics the ratio is computed from are
 * stubbed directly. `scrollable = scrollHeight - clientHeight`, matching the
 * production arithmetic.
 *
 * `bubbles: true` is a LINKEDOM WORKAROUND, not a claim about real scroll events.
 * A real `scroll` does not bubble, but per DOM spec it still runs the CAPTURE
 * phase down to its target, which is how the host's capture listener sees a
 * descendant box scrolling. linkedom only walks ancestors for bubbling events, so
 * without this flag no listener fires at all and the handler would go untested.
 * The registration itself is pinned separately (see the capture-phase guard).
 */
async function scrollBody(opts: {
	ratio: number;
	scrollHeight?: number;
	clientHeight?: number;
	reader?: boolean;
}): Promise<void> {
	const box = container?.querySelector("[data-content-scrollport]") as HTMLElement | null;
	if (!box) throw new Error("scroll box not found");
	const scrollHeight = opts.scrollHeight ?? 1000;
	const clientHeight = opts.clientHeight ?? 200;
	const scrollable = Math.max(0, scrollHeight - clientHeight);
	Object.defineProperties(box, {
		scrollHeight: { configurable: true, writable: true, value: scrollHeight },
		clientHeight: { configurable: true, writable: true, value: clientHeight },
		scrollTop: { configurable: true, writable: true, value: scrollable * opts.ratio },
	});
	await act(async () => {
		if (opts.reader !== false) {
			const wheel = new Event("wheel", { bubbles: true });
			Object.defineProperty(wheel, "deltaY", { value: 20 });
			box.dispatchEvent(wheel);
		}
		box.dispatchEvent(new Event("scroll"));
	});
}

/** The host wrapper element (the Box that carries position:relative). */
function hostEl(): HTMLElement {
	const host = container?.querySelector("[data-vlist-content-host]");
	if (!host) throw new Error("host wrapper not found");
	return host as HTMLElement;
}

/** Recorded scroll requests made through the stubbed scroller. */
interface ScrollerStub {
	scrollTops: number[];
}

/**
 * Make the host look like a body inside a scrollable viewport, with its head
 * `above` px past the viewport's top edge.
 *
 * linkedom reports every rect as zero and has no `scrollTo`, so both are stubbed:
 * the host's own rect, plus a scroll container the host can find via
 * `[data-pretext-exact-message-list]` (the fallback the production walk uses,
 * because vlist rows sit inside `overflow:hidden` boxes).
 */
function stubScrollGeometry(opts: {
	above: number;
	bodyHeight?: number;
	bodyRight?: number;
	scrollTop?: number;
}): ScrollerStub {
	const recorded: ScrollerStub = { scrollTops: [] };
	const viewportTop = 100;
	const scroller = container as unknown as HTMLElement;
	scroller.setAttribute("data-pretext-exact-message-list", "");
	Object.defineProperties(scroller, {
		getBoundingClientRect: {
			configurable: true,
			value: () => ({
				top: viewportTop,
				height: 600,
				left: 0,
				width: 800,
				bottom: 700,
				right: 800,
			}),
		},
		scrollTop: { configurable: true, writable: true, value: opts.scrollTop ?? 1000 },
		scrollTo: {
			configurable: true,
			value: (arg: { top: number }) => recorded.scrollTops.push(arg.top),
		},
	});
	const bodyHeight = opts.bodyHeight ?? 400;
	const bodyRight = opts.bodyRight ?? 800;
	Object.defineProperty(hostEl(), "getBoundingClientRect", {
		configurable: true,
		value: () => ({
			top: viewportTop - opts.above,
			height: bodyHeight,
			left: 0,
			width: bodyRight,
			bottom: viewportTop - opts.above + bodyHeight,
			right: bodyRight,
		}),
	});
	return recorded;
}

/**
 * The action bar element, wherever it currently lives: a parked bar sits inside
 * the host, a floating one is portaled to <body>.
 */
function barEl(): HTMLElement | null {
	return document.querySelector("[data-vlist-view-actions]") as HTMLElement | null;
}

/** `parked` | `floating` | null when no bar is mounted at all. */
function barMode(): string | null {
	return barEl()?.getAttribute("data-vlist-view-actions") ?? null;
}

/** Inline style of the action bar. */
function barStyle(): string {
	return barEl()?.getAttribute("style") ?? "";
}

/** Fire mouseenter on the host wrapper so the action bar mounts. */
async function hover(): Promise<void> {
	const host = hostEl();
	await act(async () => {
		host.dispatchEvent(
			new (globalThis.MouseEvent as typeof MouseEvent)("mouseover", {
				bubbles: true,
			}),
		);
	});
	// The float tracker measures in a rAF, so let that frame land.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

/** aria-labels of the currently rendered action buttons (parked or portaled). */
function actionLabels(): string[] {
	return [...(barEl()?.querySelectorAll("button[aria-label]") ?? [])].map(
		(el) => el.getAttribute("aria-label") ?? "",
	);
}

function clickAction(label: string): void {
	const button = [...(barEl()?.querySelectorAll("button[aria-label]") ?? [])].find(
		(el) => el.getAttribute("aria-label") === label,
	);
	if (!button) throw new Error(`action not found: ${label} (have: ${actionLabels().join(" | ")})`);
	(button as HTMLElement).click();
}

beforeEach(() => {
	isMobileViewport = false;
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	root = undefined;
	container = undefined;
	readerProgress = undefined;
});

describe("VListContentViewHost — gating", () => {
	test("keeps the host when the body has no readable target", async () => {
		const { controls } = makeControls();
		await renderHost({ controls });
		// No wrapper and no action bar: the row looks exactly as it did before.
		expect(actionLabels()).toEqual([]);
		expect(hostEl().getAttribute("style")).toBe("position:relative");
	});

	test("renders children untouched when no controls were injected", async () => {
		await renderHost({ target: CODE_TARGET });
		expect(actionLabels()).toEqual([]);
	});

	test("mounts NO action bar until the body is hovered", async () => {
		const { controls } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		expect(actionLabels()).toEqual([]);
		await hover();
		expect(actionLabels().length).toBeGreaterThan(0);
	});
});

describe("VListContentViewHost — which actions each body offers", () => {
	test("a code body offers wrap, copy and fullscreen (no source toggle)", async () => {
		const { controls } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		await hover();
		const labels = actionLabels();
		// The label names the ACTION, not the state: a wrapped body offers "noWrap"
		// (same convention as the chunked ContentViewer).
		expect(labels).toContain("noWrap");
		expect(labels).toContain("copy");
		expect(labels).toContain("fullscreen");
		// Source/rendered only makes sense for markdown.
		expect(labels).not.toContain("source");
		expect(labels).not.toContain("rendered");
	});

	test("a markdown body adds the source/rendered toggle", async () => {
		const { controls } = makeControls();
		await renderHost({ target: MARKDOWN_TARGET, controls });
		await hover();
		expect(actionLabels()).toContain("source");
	});

	test("hides the source toggle when the row cannot render the raw source", async () => {
		// The regression this closes: the bar offered "view source" on every markdown
		// body, but only the tool-card / subagent renderers honoured it — so on a
		// plain message the button lit up and the text on screen never changed.
		const { controls } = makeControls();
		await renderHost({ target: MARKDOWN_NO_INLINE_SOURCE, controls });
		await hover();
		const labels = actionLabels();
		expect(labels).not.toContain("source");
		expect(labels).not.toContain("rendered");
		// The rest of the bar is unaffected — the body is still copyable and openable.
		expect(labels).toContain("copy");
		expect(labels).toContain("fullscreen");
	});

	test("a diff body has no wrap toggle (its rows own their own wrapping)", async () => {
		const { controls } = makeControls();
		await renderHost({ target: DIFF_TARGET, controls });
		await hover();
		const labels = actionLabels();
		expect(labels).not.toContain("wordWrap");
		expect(labels).not.toContain("noWrap");
		expect(labels).toContain("fullscreen");
	});

	test("labels follow the current state (unwrapped → offers wordWrap)", async () => {
		const { controls } = makeControls({ isWrapped: () => false, isSourceShown: () => true });
		await renderHost({ target: MARKDOWN_TARGET, controls });
		await hover();
		const labels = actionLabels();
		expect(labels).toContain("wordWrap");
		expect(labels).toContain("rendered");
	});
});

describe("VListContentViewHost — actions invoke the shell", () => {
	test("fullscreen opens THIS body", async () => {
		const { controls, recorded } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		await hover();
		clickAction("fullscreen");
		expect(recorded.opened).toEqual([CODE_TARGET.id]);
	});

	test("wrap and source toggles carry the body's own id", async () => {
		const { controls, recorded } = makeControls();
		await renderHost({ target: MARKDOWN_TARGET, controls });
		await hover();
		// Wrapped by default, so the wrap control offers "noWrap".
		clickAction("noWrap");
		clickAction("source");
		expect(recorded.wrapToggles).toEqual([MARKDOWN_TARGET.id]);
		expect(recorded.sourceToggles).toEqual([MARKDOWN_TARGET.id]);
	});
});

/**
 * The bar must survive the body's head scrolling past the viewport top. CSS
 * `sticky` cannot do this here (vlist rows sit inside `overflow:hidden` boxes, so
 * sticky would resolve against a box that never scrolls), and a per-frame absolute
 * `top` made it jitter — so a floating bar becomes a portaled `position:fixed`
 * element whose coordinates do not change as the reader scrolls.
 */
describe("VListContentViewHost — floating with the viewport", () => {
	test("stays parked inside the body while its head is visible", async () => {
		const { controls } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		stubScrollGeometry({ above: -50 }); // head 50px BELOW the fold
		await hover();
		expect(barMode()).toBe("parked");
		expect(barStyle()).toContain("position:absolute");
	});

	test("detaches into a fixed bar pinned to the scroller's top edge", async () => {
		const { controls } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		stubScrollGeometry({ above: 120, bodyHeight: 400 });
		await hover();
		expect(barMode()).toBe("floating");
		const style = barStyle();
		expect(style).toContain("position:fixed");
		// scrollerTop (100) + the 4px inset.
		expect(style).toContain("top:104px");
	});

	test("a floating bar leaves the row entirely, so nothing can clip it", async () => {
		const { controls } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		stubScrollGeometry({ above: 120 });
		await hover();
		const bar = barEl();
		expect(bar).toBeTruthy();
		// Portaled to <body>: not a descendant of the host (nor of the React root).
		expect(hostEl().contains(bar)).toBe(false);
		expect(bar?.parentElement).toBe(document.body as unknown as HTMLElement);
	});

	test("aligns its right edge with the body's own right edge", async () => {
		const { controls } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		stubScrollGeometry({ above: 120, bodyRight: 800 });
		await hover();
		// viewportWidth (1000) - bodyRight (800) + gap (4).
		expect(barStyle()).toContain("right:204px");
	});

	test("hides once too little of the body is left to host it", async () => {
		const { controls } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		// Only 20px of a 200px body remains below the fold.
		stubScrollGeometry({ above: 180, bodyHeight: 200 });
		await hover();
		expect(barMode()).toBeNull();
	});
});

describe("VListContentViewHost — back to the start of this body", () => {
	test("the button appears only while the bar is floating", async () => {
		const { controls } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		stubScrollGeometry({ above: -50 });
		await hover();
		expect(actionLabels()).not.toContain("readFromStart");
	});

	test("shows up once the head is out of view, leading the bar", async () => {
		const { controls } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		stubScrollGeometry({ above: 120 });
		await hover();
		const labels = actionLabels();
		expect(labels).toContain("readFromStart");
		expect(labels.indexOf("readFromStart")).toBe(0);
	});

	test("clicking it scrolls the head back into view", async () => {
		const { controls } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		const scroller = stubScrollGeometry({ above: 120, scrollTop: 1000 });
		await hover();
		clickAction("readFromStart");
		// 120px above the fold → move up 120 plus the 8px breathing gap.
		expect(scroller.scrollTops).toEqual([1000 - 120 - 8]);
	});
});

/**
 * A portaled bar is not a DOM descendant of the body it decorates, so reaching for
 * a button fires `mouseleave` on the host. The bar must stay alive on its own
 * hover, or every floating button would be unclickable.
 */
describe("VListContentViewHost — the floating bar stays reachable", () => {
	test("survives the pointer leaving the body for the bar itself", async () => {
		const { controls, recorded } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		stubScrollGeometry({ above: 120 });
		await hover();
		const bar = barEl();
		expect(bar).toBeTruthy();
		// Pointer moves off the body and onto the bar, in that DOM order.
		await act(async () => {
			bar?.dispatchEvent(
				new (globalThis.MouseEvent as typeof MouseEvent)("mouseover", { bubbles: true }),
			);
			hostEl().dispatchEvent(
				new (globalThis.MouseEvent as typeof MouseEvent)("mouseout", { bubbles: true }),
			);
		});
		// Still mounted, and its buttons still work.
		expect(barEl()).toBeTruthy();
		clickAction("fullscreen");
		expect(recorded.opened).toEqual([CODE_TARGET.id]);
	});
});

describe("VListContentViewHost — height neutrality", () => {
	test("the parked bar is a zero-height absolute overlay", async () => {
		const { controls } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		await hover();
		const style = barStyle();
		// React serializes inline styles without spaces after the colon.
		expect(style).toContain("position:absolute");
		expect(style).toContain("height:0");
		expect(style).toContain("pointer-events:none");
	});

	test("the parked bar aligns to the body's top edge instead of straddling it", async () => {
		const { controls } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		await hover();
		// A zero-height flex box with Mantine's default `align-items:center` would
		// centre the buttons ACROSS the top edge, putting their upper half outside the
		// body where the row's `overflow:hidden` cut it off.
		expect(barStyle()).toContain("align-items:flex-start");
	});

	test("floating never touches the decorated box", async () => {
		const { controls } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		stubScrollGeometry({ above: 120 });
		await hover();
		expect(barMode()).toBe("floating");
		// The host keeps exactly the geometry the measure pass reserved.
		expect(hostEl().getAttribute("style")).toBe("position:relative");
	});

	test("the wrapper adds position:relative and nothing that could resize the body", async () => {
		const { controls } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		const host = container?.querySelector("[data-vlist-content-host]");
		const style = host?.getAttribute("style") ?? "";
		expect(style).toContain("position:relative");
		// No padding / border / height of its own: the decorated box keeps exactly the
		// geometry the measure pass reserved for it.
		expect(style).not.toContain("padding");
		expect(style).not.toContain("border");
		expect(style).not.toContain("height");
	});
});

describe("VListContentViewHost — mobile", () => {
	test("shows no hover bar; a double-tap opens fullscreen instead", async () => {
		isMobileViewport = true;
		const { controls, recorded } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		const host = container?.querySelector("[data-vlist-content-host]");
		if (!host) throw new Error("host wrapper not found");
		// Hover does nothing on a touch surface.
		await hover();
		expect(actionLabels()).toEqual([]);
		// One tap arms, the second (within the window) opens.
		await act(async () => {
			(host as HTMLElement).click();
		});
		expect(recorded.opened).toEqual([]);
		await act(async () => {
			(host as HTMLElement).click();
		});
		expect(recorded.opened).toEqual([CODE_TARGET.id]);
	});
});

/**
 * Reading into a PREFIX body fetches the rest.
 *
 * This replaced a clickable "content truncated (17KB) — click here to load"
 * footer, which cost every truncated card a reserved 21px row and read as a
 * warning rather than an affordance. The body's own scroll position is the
 * signal instead: passing the halfway mark says the reader is working through
 * this body and will want what follows.
 *
 * The request stays a USER action, which is what keeps the height invariant
 * intact — and a prefix body already reserves its full cap, so the landing
 * payload measures into the same box.
 */
describe("VListContentViewHost — auto-load on scroll", () => {
	test("requests the full payload once the reader passes the halfway mark", async () => {
		const { controls, recorded } = makeControls();
		await renderHost({ target: TRUNCATED_TARGET, controls });
		await scrollBody({ ratio: 0.5 });
		expect(recorded.payloadRequests).toEqual([TRUNCATED_TARGET.id]);
	});

	test("asks only once, however far the reader keeps scrolling", async () => {
		const { controls, recorded } = makeControls();
		await renderHost({ target: TRUNCATED_TARGET, controls });
		await scrollBody({ ratio: 0.6 });
		await scrollBody({ ratio: 0.8 });
		await scrollBody({ ratio: 1 });
		expect(recorded.payloadRequests).toEqual([TRUNCATED_TARGET.id]);
	});

	test("stays quiet while the reader is still in the body's first half", async () => {
		const { controls, recorded } = makeControls();
		await renderHost({ target: TRUNCATED_TARGET, controls });
		await scrollBody({ ratio: 0 });
		await scrollBody({ ratio: 0.49 });
		expect(recorded.payloadRequests).toEqual([]);
	});

	test("never fires for a body that is already complete", async () => {
		// CODE_TARGET carries no `truncated` flag, so there is nothing to fetch —
		// scrolling to the very bottom of it must not hit the API.
		const { controls, recorded } = makeControls();
		await renderHost({ target: CODE_TARGET, controls });
		await scrollBody({ ratio: 1 });
		expect(recorded.payloadRequests).toEqual([]);
	});

	test("ignores a box with nothing to scroll (ratio would be meaningless)", async () => {
		// `scrollHeight === clientHeight` → scrollable is 0, so scrollTop says nothing
		// about how much the reader has read. Without the guard this divides by zero.
		const { controls, recorded } = makeControls();
		await renderHost({ target: TRUNCATED_TARGET, controls });
		await scrollBody({ ratio: 1, scrollHeight: 200, clientHeight: 200 });
		expect(recorded.payloadRequests).toEqual([]);
	});

	test("a non-interactive surface never issues the request", async () => {
		// Workspace previews render the same bodies read-only; they must not fetch
		// payloads for content nobody is reading.
		const { controls, recorded } = makeControls();
		await renderHost({ target: TRUNCATED_TARGET, controls, interactive: false });
		await scrollBody({ ratio: 1 });
		expect(recorded.payloadRequests).toEqual([]);
	});

	test("scrolling the LIST behind the body is not mistaken for reading it", async () => {
		// The list viewport is an ANCESTOR of the host, so its scroll events never
		// reach the host's capture path. This is the reason the listener is on the
		// host rather than on the document.
		const { controls, recorded } = makeControls();
		await renderHost({ target: TRUNCATED_TARGET, controls });
		const scroller = container as unknown as HTMLElement;
		Object.defineProperties(scroller, {
			scrollHeight: { configurable: true, writable: true, value: 10_000 },
			clientHeight: { configurable: true, writable: true, value: 600 },
			scrollTop: { configurable: true, writable: true, value: 9_000 },
		});
		await act(async () => {
			scroller.dispatchEvent(new (globalThis.Event as typeof Event)("scroll"));
		});
		expect(recorded.payloadRequests).toEqual([]);
	});

	test("does nothing when the shell wired no request channel", async () => {
		const { controls, recorded } = makeControls({ requestFullPayload: undefined });
		await renderHost({ target: TRUNCATED_TARGET, controls });
		await scrollBody({ ratio: 1 });
		expect(recorded.payloadRequests).toEqual([]);
	});

	/**
	 * "Once" spans the body's IDENTITY, not one render of it.
	 *
	 * `target` is derived from the measured document and reallocated on every build,
	 * and the narrator list rebuilds on every live WS patch. While the effect
	 * depended on the whole object it re-registered the listener and reset its
	 * one-shot flag for every visible body on every one of those frames — so a body
	 * the reader had already scrolled past would ask again after the next patch. The
	 * request is deduped server-side, which is why this was invisible rather than
	 * broken; the effect is keyed on `target.id` instead.
	 */
	test("a rebuilt-but-identical body does not ask a second time", async () => {
		const { controls, recorded } = makeControls();
		await renderHost({ target: TRUNCATED_TARGET, controls });
		await scrollBody({ ratio: 0.6 });
		expect(recorded.payloadRequests).toEqual([TRUNCATED_TARGET.id]);
		// A fresh object for the SAME body, exactly what a document rebuild produces.
		await renderHost({ target: { ...TRUNCATED_TARGET }, controls });
		await scrollBody({ ratio: 0.9 });
		expect(recorded.payloadRequests).toEqual([TRUNCATED_TARGET.id]);
	});

	test("a DIFFERENT truncated body in the same host gets its own shot", async () => {
		// The flip side: keying on `target.id` must still let a genuinely new body
		// (a recycled row scrolling into view) issue its own request.
		const { controls, recorded } = makeControls();
		await renderHost({ target: TRUNCATED_TARGET, controls });
		await scrollBody({ ratio: 0.6 });
		const other: VListViewTarget = { ...TRUNCATED_TARGET, id: "tool-tu_9:b0" };
		await renderHost({ target: other, controls });
		await scrollBody({ ratio: 0.6 });
		expect(recorded.payloadRequests).toEqual([TRUNCATED_TARGET.id, other.id]);
	});

	/**
	 * Narrowing the deps to `target.id` must not leave the handler holding a stale
	 * object: the id is the same across a rebuild, so the closure would keep whatever
	 * target was current when the listener was installed. The latest one is read from
	 * a ref at fire time, which this pins by giving the rebuilt object a field the
	 * assertion can see.
	 */
	test("requests the CURRENT target object, not the one captured at mount", async () => {
		const seen: VListViewTarget[] = [];
		const { controls } = makeControls({ requestFullPayload: (t) => seen.push(t) });
		await renderHost({ target: TRUNCATED_TARGET, controls });
		const rebuilt: VListViewTarget = { ...TRUNCATED_TARGET, text: "a longer prefix…" };
		await renderHost({ target: rebuilt, controls });
		await scrollBody({ ratio: 0.6 });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.text).toBe(rebuilt.text);
	});

	test("programmatic scroll is not a full-payload request", async () => {
		const { controls, recorded } = makeControls();
		await renderHost({ target: TRUNCATED_TARGET, controls });
		await scrollBody({ ratio: 0.9, reader: false });
		expect(recorded.payloadRequests).toEqual([]);
	});

	test("nested painter scroll is not a full-payload request", async () => {
		const { controls, recorded } = makeControls();
		await renderHost({ target: TRUNCATED_TARGET, controls });
		const nested = container?.querySelector("[data-testid=nested-scrollbox]");
		nested?.dispatchEvent(new Event("scroll", { bubbles: true }));
		expect(recorded.payloadRequests).toEqual([]);
	});

	test("uses snapshot progress without reading any node geometry", async () => {
		const { controls, recorded } = makeControls();
		await renderHost({ target: TRUNCATED_TARGET, controls });
		const node = document.createElement("div");
		for (const name of ["scrollHeight", "clientHeight", "scrollTop"]) {
			Object.defineProperty(node, name, {
				get() {
					throw new Error(`unexpected ${name} read`);
				},
			});
		}
		const snapshot: ContentViewportSnapshot = {
			scrollTop: 399,
			scrollLeft: 0,
			viewportWidth: 600,
			viewportHeight: 200,
			contentWidth: 600,
			contentOrigin: 0,
			scrollWidth: 600,
			scrollHeight: 1_000,
			source: "layout",
		};
		if (!readerProgress) throw new Error("reader callback not captured");
		readerProgress(node, snapshot);
		expect(recorded.payloadRequests).toEqual([]);
		readerProgress(node, { ...snapshot, scrollTop: 400 });
		expect(recorded.payloadRequests).toEqual([TRUNCATED_TARGET.id]);
	});

	test("keeps zero snapshot values instead of falling back to node metrics", async () => {
		const { controls, recorded } = makeControls();
		await renderHost({ target: TRUNCATED_TARGET, controls });
		const node = document.createElement("div");
		for (const name of ["scrollHeight", "clientHeight", "scrollTop"]) {
			Object.defineProperty(node, name, {
				get() {
					throw new Error(`unexpected ${name} read`);
				},
			});
		}
		if (!readerProgress) throw new Error("reader callback not captured");
		readerProgress(node, {
			scrollTop: 0,
			scrollLeft: 0,
			viewportWidth: 0,
			viewportHeight: 0,
			contentWidth: 0,
			contentOrigin: 0,
			scrollWidth: 0,
			scrollHeight: 0,
			source: "layout",
		});
		expect(recorded.payloadRequests).toEqual([]);
	});

	test("still supports a legacy reader callback that passes only a node", async () => {
		const { controls, recorded } = makeControls();
		await renderHost({ target: TRUNCATED_TARGET, controls });
		const node = document.createElement("div");
		Object.defineProperties(node, {
			scrollHeight: { value: 1_000 },
			clientHeight: { value: 200 },
			scrollTop: { value: 400 },
		});
		if (!readerProgress) throw new Error("reader callback not captured");
		readerProgress(node);
		expect(recorded.payloadRequests).toEqual([TRUNCATED_TARGET.id]);
	});

	test("never captures all descendant scroll events", () => {
		const src = readFileSync(join(import.meta.dir, "VListContentViewHost.tsx"), "utf8");
		expect(src).not.toContain("capture: true");
		expect(src).toContain("children(onReaderProgress)");
	});
});
