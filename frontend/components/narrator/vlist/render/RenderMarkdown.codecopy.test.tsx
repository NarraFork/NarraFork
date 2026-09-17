/**
 * RenderMarkdown.codecopy.test.tsx — a fenced code block in the virtual list must
 * be COPYABLE, not just readable.
 *
 * The bug this locks down: the chunked renderer's `MarkdownCodeBlock` has always
 * pinned a hover-revealed copy button to each fenced panel's top-right corner
 * (MarkdownContent.module.css `.codeCopy`). The exact vlist painted its code
 * panels as bare absolutely-positioned line stacks with no such control, so a
 * multi-line code block could only be copied by hand-selecting it — or by copying
 * the whole row from the row menu, which drags in all the surrounding prose.
 *
 * Three things are asserted, all of which the vlist CONTRACT makes load-bearing:
 *   1. the button APPEARS on hover and copies the panel's own source (not the
 *      whole markdown body, and not the wrapped visual lines);
 *   2. it is ABSENT until hovered, so a scrolling list mounts no Tooltip /
 *      CopyButton tree per fenced block;
 *   3. hovering NEVER changes the row's measured height (CONTRACT §0 iron law 2 —
 *      the overlay is absolute inside the already-reserved panel box).
 *
 * A fourth group covers a follow-up bug: when the fenced block LEADS the body it
 * shares its top-right corner with the row's own hover action bar, which paints
 * above block chrome by design — so the copy button was fully covered and the
 * panel looked like it had none. It must step aside in that case, and only then.
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

let makeMouseEvent: (type: string) => Event;
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
	// linkedom ships no MouseEvent; a bubbling Event reaches React's delegated
	// root listener the same way, which is all `onMouseEnter/Leave` needs.
	const EventCtor = (win as unknown as { Event: typeof Event }).Event;
	makeMouseEvent = (type: string) => new EventCtor(type, { bubbles: true, cancelable: true });
	// Installed on THIS window — unconditionally, and not on globalThis.
	//
	// Both matter. `VListCodeCopyButton` reads `window.matchMedia` to decide whether
	// the pointer can hover at all (the touch branch, covered by
	// RenderMarkdown.codecopy-touch.test.tsx), and every assertion below describes
	// the HOVER surface: a query that matches would make the button permanently
	// visible and this whole file meaningless. A `globalThis` stub does not serve
	// that read, because the line above rebinds `globalThis.window` to a fresh
	// linkedom window; and the old `typeof !== "function"` guard made the stub
	// order-dependent — whichever suite installed one first won, across files.
	(win as unknown as Record<string, unknown>).matchMedia = (query: string) => ({
		media: query,
		matches: false,
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

// Hand the globals back, so a suite that ran before this one keeps its own DOM
// (and its own matchMedia) if it has any work left.
afterAll(() => {
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = previousWindow;
	g.document = previousDocument;
});

interface Rendered {
	container: Element;
	/** The fenced panel host that owns the hover handlers. */
	panel: Element;
	height: number;
	hover: () => void;
	unhover: () => void;
	unmount: () => void;
}

/**
 * Measure + render one markdown string through the real measure/render pair (the
 * same call the registry makes), inside a live DOM so hover state is exercisable.
 */
async function renderMarkdownBody(
	markdown: string,
	{ interactive = true }: { interactive?: boolean } = {},
): Promise<Rendered> {
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
				<RenderLodCtx.Provider value={{ lod: 5, interactive }}>
					<RenderMarkdown measured={measured} />
				</RenderLodCtx.Provider>
			</MantineProvider>,
		);
	});
	// The code panel is the only element carrying the hover handlers; find it by the
	// code foreground variable the render layer paints its lines with.
	const panel = container.querySelector('[style*="--vlist-code-bg"]');
	if (!panel) throw new Error("code panel not rendered");
	return {
		container: container as unknown as Element,
		panel,
		height: measured.height,
		hover: () => {
			act(() => {
				panel.dispatchEvent(makeMouseEvent("mouseover"));
			});
		},
		unhover: () => {
			act(() => {
				panel.dispatchEvent(makeMouseEvent("mouseout"));
			});
		},
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

const copyOverlay = (root: Element) => root.querySelector("[data-vlist-code-copy]");

describe("fenced code copy button (virtual list)", () => {
	it("reveals a copy control when the panel is hovered", async () => {
		const view = await renderMarkdownBody(`Intro text\n\n\`\`\`js\n${CODE}\n\`\`\``);
		// Idle: overlay is mounted but visually hidden (visibility: hidden).
		const overlayBefore = copyOverlay(view.container) as unknown as HTMLElement | null;
		expect(overlayBefore).not.toBeNull();
		expect(overlayBefore?.style.visibility).toBe("hidden");

		view.hover();
		const overlay = copyOverlay(view.container) as unknown as HTMLElement;
		expect(overlay).not.toBeNull();
		expect(overlay.style.visibility).toBe("visible");
		expect(overlay.querySelector("button")).not.toBeNull();

		view.unhover();
		const overlayAfter = copyOverlay(view.container) as unknown as HTMLElement;
		expect(overlayAfter.style.visibility).toBe("hidden");
		view.unmount();
	});

	it("carries the panel's own source, not the surrounding prose", async () => {
		const view = await renderMarkdownBody(
			`Some prose before.\n\n\`\`\`js\n${CODE}\n\`\`\`\n\nSome prose after.`,
		);
		view.hover();
		const overlay = copyOverlay(view.container);
		expect(overlay?.querySelector("button")).not.toBeNull();

		// Asserted through the overlay's own attribute rather than by stubbing
		// `navigator.clipboard`: the copy itself runs inside Mantine's useClipboard,
		// which other suites replace with a module mock (mock.module leaks across
		// files under `bun test`, and mock.restore does not undo it). The value the
		// overlay hands to CopyButton is the whole contract here.
		const copyValue = overlay?.getAttribute("data-vlist-code-copy-value");
		expect(copyValue).toBe(CODE);
		// Discriminating: the prose must NOT ride along, and the value must be the
		// SOURCE (physical lines), never the wrapped visual lines.
		expect(copyValue).not.toContain("Some prose");
		view.unmount();
	});

	it("copies a soft-wrapped long line as one physical line", async () => {
		// The render layer lays code out in VISUAL lines; a naive implementation would
		// copy those, silently injecting newlines that are not in the source. Narrow
		// content width forces several visual rows out of one physical line.
		const longLine = `const message = "${"x".repeat(400)}";`;
		const view = await renderMarkdownBody(`\`\`\`js\n${longLine}\n\`\`\``);
		view.hover();
		const copyValue = copyOverlay(view.container)?.getAttribute("data-vlist-code-copy-value");
		expect(copyValue).toBe(longLine);
		expect(copyValue).not.toContain("\n");
		view.unmount();
	});

	it("never changes the measured height (zero-DOM contract)", async () => {
		const view = await renderMarkdownBody(`\`\`\`js\n${CODE}\n\`\`\``);
		const before = view.height;
		const panelHeightBefore = (view.panel as unknown as HTMLElement).style.height;
		view.hover();
		// The panel box the measure layer reserved must be untouched: same measured
		// element height, same painted box height.
		expect(view.height).toBe(before);
		expect((view.panel as unknown as HTMLElement).style.height).toBe(panelHeightBefore);
		// The overlay must be absolutely positioned — a static one would push lines.
		const overlay = copyOverlay(view.container) as unknown as HTMLElement | null;
		expect(overlay?.style.position).toBe("absolute");
		view.unmount();
	});

	it("stays hidden on a read-only surface (interactive: false)", async () => {
		const view = await renderMarkdownBody(`\`\`\`js\n${CODE}\n\`\`\``, { interactive: false });
		view.hover();
		expect(copyOverlay(view.container)).toBeNull();
		view.unmount();
	});
});

/**
 * The row's hover action bar (source / wrap / copy / fullscreen) parks at the
 * BODY's top-right corner with `zIndex: 2`, deliberately above block-level chrome
 * at `zIndex: 1`. A fenced panel pins its copy button to the same corner, so a
 * body whose first block is a code block hid that button completely.
 *
 * The repair moves the button to the panel's BOTTOM-right corner. Not sideways:
 * parking it beside the bar produced five grey icons in one strip, two of them
 * copy glyphs with different scopes (this panel vs the whole message) — visually
 * noisy and ambiguous about what would be copied.
 *
 * The move must be conditional. A panel that already clears the bar keeps the
 * conventional corner, and a panel too short to separate the two corners paints
 * no button at all (the bar's own copy button covers that spot anyway).
 */
describe("fenced code copy button vs the row action bar", () => {
	const placement = (root: Element): string | null =>
		copyOverlay(root)?.getAttribute("data-vlist-code-copy-placement") ?? null;

	it("drops to the bottom corner when the code block leads the body", async () => {
		const view = await renderMarkdownBody(`\`\`\`js\n${CODE}\n\`\`\``);
		expect(placement(view.container)).toBe("bottom-right");
		const overlay = copyOverlay(view.container) as unknown as HTMLElement;
		// Anchored to the bottom edge, and no longer to the top one: leaving `top`
		// set would pin the button to both and stretch the overlay down the panel.
		// (linkedom reports an unset property as undefined, hence `toBeFalsy`.)
		expect(overlay.style.bottom).toBe("4px");
		expect(overlay.style.top).toBeFalsy();
		expect(overlay.style.right).toBe("4px");
		view.unmount();
	});

	it("keeps the top corner when prose precedes it (nothing to dodge)", async () => {
		const view = await renderMarkdownBody(`Intro text\n\n\`\`\`js\n${CODE}\n\`\`\``);
		// A leading paragraph pushes the panel a full text line down, past the bar.
		expect(placement(view.container)).toBe("top-right");
		const overlay = copyOverlay(view.container) as unknown as HTMLElement;
		expect(overlay.style.top).toBe("4px");
		expect(overlay.style.bottom).toBeFalsy();
		view.unmount();
	});

	it("paints no button when the panel is too short to hold both corners apart", async () => {
		// One unlabelled line: the bottom-right corner would still sit under the
		// bar's own button, so a per-panel button there would be an unclickable
		// duplicate. The row bar's copy button remains the way to copy.
		const view = await renderMarkdownBody("```\nconst a = 1;\n```");
		expect(copyOverlay(view.container)).toBeNull();
		view.unmount();
	});

	it("moving corners never changes the measured height", async () => {
		const view = await renderMarkdownBody(`\`\`\`js\n${CODE}\n\`\`\``);
		const before = view.height;
		const panelHeight = (view.panel as unknown as HTMLElement).style.height;
		view.hover();
		expect(placement(view.container)).toBe("bottom-right");
		expect(view.height).toBe(before);
		expect((view.panel as unknown as HTMLElement).style.height).toBe(panelHeight);
		view.unmount();
	});

	it("later panels in the same body keep the conventional corner", async () => {
		const view = await renderMarkdownBody(
			`\`\`\`js\n${CODE}\n\`\`\`\n\nProse between.\n\n\`\`\`js\n${CODE}\n\`\`\``,
		);
		const overlays = [...view.container.querySelectorAll("[data-vlist-code-copy]")];
		expect(overlays).toHaveLength(2);
		// Only the leading panel collides with the bar.
		expect(overlays[0]?.getAttribute("data-vlist-code-copy-placement")).toBe("bottom-right");
		expect(overlays[1]?.getAttribute("data-vlist-code-copy-placement")).toBe("top-right");
		view.unmount();
	});
});

describe("fenced code copy button keyboard accessibility", () => {
	it("copy button is always in the DOM but visually hidden until hover/focus", async () => {
		const view = await renderMarkdownBody(`\`\`\`js\n${CODE}\n\`\`\``);
		// Idle: overlay is mounted but hidden (visibility: hidden)
		const overlay = copyOverlay(view.container);
		expect(overlay).not.toBeNull();
		const overlayEl = overlay as unknown as HTMLElement;
		expect(overlayEl.style.visibility).toBe("hidden");

		// The button inside has tabIndex=-1 so it's not in tab order when hidden
		const button = overlayEl.querySelector("button");
		expect(button).not.toBeNull();
		expect(button?.getAttribute("tabindex")).toBe("-1");

		view.unmount();
	});

	it("copy button becomes tabbable on hover", async () => {
		const view = await renderMarkdownBody(`\`\`\`js\n${CODE}\n\`\`\``);
		view.hover();
		const overlay = copyOverlay(view.container) as unknown as HTMLElement;
		expect(overlay.style.visibility).toBe("visible");
		const button = overlay.querySelector("button");
		expect(button?.getAttribute("tabindex")).toBe("0");
		view.unhover();
		view.unmount();
	});

	it("focus on the panel shows the copy button (keyboard path)", async () => {
		const view = await renderMarkdownBody(`\`\`\`js\n${CODE}\n\`\`\``);
		// Simulate focus event on the panel (as if keyboard navigation reached it).
		// The panel has tabIndex=0 so it's focusable.
		act(() => {
			view.panel.dispatchEvent(makeMouseEvent("focusin"));
		});
		const overlay = copyOverlay(view.container) as unknown as HTMLElement;
		expect(overlay.style.visibility).toBe("visible");
		const button = overlay.querySelector("button");
		expect(button?.getAttribute("tabindex")).toBe("0");
		view.unmount();
	});

	it("copy button still carries correct source when shown via focus", async () => {
		const view = await renderMarkdownBody(`\`\`\`js\n${CODE}\n\`\`\``);
		act(() => {
			view.panel.dispatchEvent(makeMouseEvent("focusin"));
		});
		const overlay = copyOverlay(view.container);
		const copyValue = overlay?.getAttribute("data-vlist-code-copy-value");
		expect(copyValue).toBe(CODE);
		view.unmount();
	});
});
