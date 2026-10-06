/**
 * RenderMarkdown.codecopy-touch.test.tsx — a fenced code block must be copyable
 * with ONE tap on a phone.
 *
 * ## The bug
 *
 * `VListCodeCopyButton` was reveal-on-hover only: `CodeBlockView` flips it visible
 * on `mouseenter` and hides it again on `mouseleave`. A touch pointer fires
 * neither reliably, so on a phone the button was painted with
 * `visibility: hidden` forever — and the panel looked like it had none.
 *
 * Two further mobile-only aggravations made it worse than "hidden by default":
 *
 *   1. `resolveCodeCopyPlacement` moves a LEADING panel's button to the bottom
 *      corner, and DELETES it outright for a short panel, purely to dodge the
 *      row's hover action bar (`VListContentViewActions`). That bar is not mounted
 *      on a mobile viewport at all (`VListContentViewHost` gates it on
 *      `!isMobile`), so the dodge cost a phone reader the button for nothing.
 *   2. The remaining routes were both coarse: the row menu's copy item takes the
 *      WHOLE row (all surrounding prose), and hand-selecting code inside a
 *      fixed-height absolutely-positioned line stack is exactly what a per-panel
 *      button exists to avoid.
 *
 * ## What is asserted
 *
 * The touch branch is decided by media queries, so this suite drives
 * `window.matchMedia` directly rather than dispatching synthetic touches
 * (linkedom has no pointer model, and Mantine reads the query, not the events):
 *
 *   - a hoverless pointer paints the button VISIBLE and tabbable with no hover;
 *   - a mobile viewport keeps the conventional top-right corner, including for the
 *     two cases the desktop bar-dodge would have moved or deleted;
 *   - it still copies the panel's own source, and still costs zero measured pixels
 *     (CONTRACT §0 iron law 2 — the overlay is absolute inside the reserved box);
 *   - a tap on the button does not bubble to the body, whose host counts two taps
 *     as "open fullscreen".
 *
 * The desktop contract lives in `RenderMarkdown.codecopy.test.tsx`; that file
 * stubs a matchMedia that never matches, so the two suites pin opposite ends of
 * the same switch.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RenderLodCtx } from "../../lod/RenderLodCtx";
import { installCanvasStub } from "../measure/test-canvas-stub";

const CONTENT_WIDTH = 800;
const CODE = "const a = 1;\nconst b = 2;\nconsole.log(a + b);";

/**
 * Which media queries `matchMedia` should report as matching, per test.
 *
 * `not all and (min-width: 48em)` is the mobile-viewport query
 * (`MOBILE_VIEWPORT_MEDIA_QUERY`): a NEGATED desktop query, so the stub has to
 * invert it rather than substring-match it like the pointer ones.
 */
let mediaState: { touchPointer: boolean; mobileViewport: boolean } = {
	touchPointer: true,
	mobileViewport: true,
};

let previousWindow: unknown;
let previousDocument: unknown;

beforeAll(() => {
	installCanvasStub();
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const g = globalThis as unknown as Record<string, unknown>;
	previousWindow = g.window;
	previousDocument = g.document;
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.getComputedStyle = win.getComputedStyle;
	g.IS_REACT_ACT_ENVIRONMENT = true;
	// Installed on THIS window object (not globalThis) so the desktop suite's own
	// never-matching stub is untouched whichever order the files run in.
	(win as unknown as Record<string, unknown>).matchMedia = (query: string) => ({
		media: query,
		matches: resolveMatches(query),
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
	});
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
	}
	if (typeof g.cancelAnimationFrame !== "function") {
		g.cancelAnimationFrame = (handle: number) => clearTimeout(handle as unknown as Timer);
	}
});

afterAll(() => {
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = previousWindow;
	g.document = previousDocument;
});

function resolveMatches(query: string): boolean {
	if (query.includes("min-width: 48em")) {
		// `not all and (min-width: 48em)` matches exactly when the viewport is narrow.
		return query.startsWith("not all") ? mediaState.mobileViewport : !mediaState.mobileViewport;
	}
	if (query.includes("hover: none") || query.includes("pointer: coarse")) {
		return mediaState.touchPointer;
	}
	return false;
}

interface Rendered {
	container: Element;
	panel: HTMLElement;
	height: number;
	unmount: () => void;
}

/**
 * Measure + render one markdown body, exactly as the registry would.
 *
 * `onHostClick` stands in for `VListContentViewHost`'s own `onClick` (the mobile
 * double-tap-to-fullscreen shortcut). It is a REACT handler on purpose: React
 * delegates to the root, so a child's `stopPropagation` only shows up against
 * another React handler — a native `addEventListener` on an intermediate node
 * would still fire during the real bubble phase and prove nothing.
 */
async function renderMarkdownBody(markdown: string, onHostClick?: () => void): Promise<Rendered> {
	// Dynamic imports: the canvas stub must be installed before the pretext-backed
	// modules load (CONTRACT §5).
	const { measureMarkdown } = await import("../measure/measure-markdown");
	const { RenderMarkdown } = await import("./RenderMarkdown");
	const measured = measureMarkdown(markdown, CONTENT_WIDTH);

	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	act(() => {
		reactRoot.render(
			<MantineProvider>
				<RenderLodCtx.Provider value={{ lod: 5, interactive: true }}>
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: stands in for the host's tap shortcut */}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: same */}
					<div onClick={onHostClick}>
						<RenderMarkdown measured={measured} />
					</div>
				</RenderLodCtx.Provider>
			</MantineProvider>,
		);
	});
	const panel = container.querySelector('[style*="--vlist-code-bg"]');
	if (!panel) throw new Error("code panel not rendered");
	return {
		container: container as unknown as Element,
		panel: panel as unknown as HTMLElement,
		height: measured.height,
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

const copyOverlay = (root: Element) =>
	root.querySelector("[data-vlist-code-copy]") as unknown as HTMLElement | null;

describe("fenced code copy button on a touch pointer", () => {
	it("is visible with no hover at all", async () => {
		mediaState = { touchPointer: true, mobileViewport: true };
		const view = await renderMarkdownBody(`Intro text\n\n\`\`\`js\n${CODE}\n\`\`\``);
		const overlay = copyOverlay(view.container);
		expect(overlay).not.toBeNull();
		// The whole point: no mouseenter was dispatched, and it is still painted.
		expect(overlay?.style.visibility).toBe("visible");
		expect(overlay?.style.opacity).toBe("1");
		// ...and operable, rather than parked outside the tab order.
		expect(overlay?.querySelector("button")?.getAttribute("tabindex")).toBe("0");
		expect(overlay?.hasAttribute("data-vlist-code-copy-touch")).toBe(true);
		view.unmount();
	});

	it("keeps the top corner for a panel that LEADS the body", async () => {
		// Desktop moves this one to the bottom corner to clear the row's hover bar.
		// That bar is never mounted on a mobile viewport, so the dodge would only
		// drag the button away from the panel's head.
		mediaState = { touchPointer: true, mobileViewport: true };
		const view = await renderMarkdownBody(`\`\`\`js\n${CODE}\n\`\`\``);
		const overlay = copyOverlay(view.container);
		expect(overlay?.getAttribute("data-vlist-code-copy-placement")).toBe("top-right");
		expect(overlay?.style.top).toBe("4px");
		expect(overlay?.style.bottom).toBeFalsy();
		view.unmount();
	});

	it("still paints a button on a panel too short to hold both corners apart", async () => {
		// The desktop outcome here is `hidden`, on the grounds that the row bar's own
		// copy button covers that corner. With no bar there is no fallback, so
		// deleting the button leaves the panel uncopyable — the original complaint.
		mediaState = { touchPointer: true, mobileViewport: true };
		const view = await renderMarkdownBody("```\nconst a = 1;\n```");
		const overlay = copyOverlay(view.container);
		expect(overlay).not.toBeNull();
		expect(overlay?.style.visibility).toBe("visible");
		expect(overlay?.getAttribute("data-vlist-code-copy-value")).toBe("const a = 1;");
		view.unmount();
	});

	it("carries the panel's own source, not the surrounding prose", async () => {
		mediaState = { touchPointer: true, mobileViewport: true };
		const view = await renderMarkdownBody(
			`Some prose before.\n\n\`\`\`js\n${CODE}\n\`\`\`\n\nSome prose after.`,
		);
		const copyValue = copyOverlay(view.container)?.getAttribute("data-vlist-code-copy-value");
		expect(copyValue).toBe(CODE);
		expect(copyValue).not.toContain("Some prose");
		view.unmount();
	});

	it("never changes the measured height (zero-DOM contract)", async () => {
		mediaState = { touchPointer: true, mobileViewport: true };
		const measuredOnly = await import("../measure/measure-markdown");
		const expected = measuredOnly.measureMarkdown(
			`\`\`\`js\n${CODE}\n\`\`\``,
			CONTENT_WIDTH,
		).height;
		const view = await renderMarkdownBody(`\`\`\`js\n${CODE}\n\`\`\``);
		// A permanently-painted button is the change most likely to push lines: it is
		// present during the FIRST paint, unlike the hover one.
		expect(view.height).toBe(expected);
		expect(copyOverlay(view.container)?.style.position).toBe("absolute");
		view.unmount();
	});

	it("swallows its own tap so the body's double-tap does not fire", async () => {
		// VListContentViewHost turns two taps on a body into "open fullscreen".
		// Copying twice must not count toward that.
		mediaState = { touchPointer: true, mobileViewport: true };
		let hostClicks = 0;
		const view = await renderMarkdownBody(`\`\`\`js\n${CODE}\n\`\`\``, () => {
			hostClicks += 1;
		});
		const button = copyOverlay(view.container)?.querySelector("button");
		expect(button).not.toBeNull();
		const EventCtor = (window as unknown as { Event: typeof Event }).Event;
		act(() => {
			button?.dispatchEvent(new EventCtor("click", { bubbles: true, cancelable: true }));
		});
		expect(hostClicks).toBe(0);

		// Discriminating: the same click on the panel body DOES reach the host, so the
		// zero above is the overlay's stopPropagation and not a dead handler.
		act(() => {
			view.panel.dispatchEvent(new EventCtor("click", { bubbles: true, cancelable: true }));
		});
		expect(hostClicks).toBe(1);
		view.unmount();
	});
});

describe("fenced code copy button on a desktop-width touch screen", () => {
	it("keeps the top corner: no tap can summon the row action bar there", async () => {
		// A hoverable-viewport touch device (tablet in landscape) used to keep the
		// desktop dodge because browsers synthesize `mouseenter` on tap, summoning
		// the row bar. The host now ignores synthesized hover on a touch pointer
		// (it popped the bar up mid-gesture and swapped the big scroll-to-top
		// button for the bar's small one), so no bar can ever appear and the dodge
		// would only drag the button away from the panel's head.
		mediaState = { touchPointer: true, mobileViewport: false };
		const view = await renderMarkdownBody(`\`\`\`js\n${CODE}\n\`\`\``);
		const overlay = copyOverlay(view.container);
		expect(overlay?.getAttribute("data-vlist-code-copy-placement")).toBe("top-right");
		expect(overlay?.style.visibility).toBe("visible");
		view.unmount();
	});
});
