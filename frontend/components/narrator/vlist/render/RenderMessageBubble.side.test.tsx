/**
 * RenderMessageBubble.side.test.tsx — which SIDE a human turn is painted on.
 *
 * The bug this locks down: the bubble wrapper hard-coded `justifyContent: flex-end`
 * plus the indigo tint, so in a shared deployment every `role: "user"` row claimed to
 * be the reader's own. NarraFork narrators can be driven by several people, so
 * "a person typed this" and "YOU typed this" are different facts, and the right-hand
 * indigo bubble is a claim of authorship.
 *
 * Asserted through a real DOM render rather than by inspecting the helper, because the
 * regression was in the painted wrapper: `resolveBubbleIsSelf` could be perfectly
 * correct while the flag never reached a style.
 *
 * ⚠️ Height invariance is asserted here too, and it is the load-bearing property: side
 * and tint are RENDER-only. If they ever influenced geometry, viewer identity would
 * have to enter the measure cache key — forking every cached height per user for a
 * cosmetic difference. See CONTRACT.md §0 on the measure/render split.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installCanvasStub } from "../measure/test-canvas-stub";

// pretext measures text through canvas `measureText`, which the bun runtime lacks.
// The stub's deterministic width model is enough here: this suite asserts the SIDE and
// that both sides share one geometry, never pixel-exact font metrics.
beforeAll(() => {
	installCanvasStub();
});

const realReactI18nextModule = { ...(await import("react-i18next")) };

mock.module("react-i18next", () => ({
	...realReactI18nextModule,
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const { RenderMessageBubble } = await import("./RenderMessageBubble");
const { measureMessageBubble } = await import("../measure/measure-message-bubble");

let currentRoot: Root | null = null;
let currentContainer: HTMLElement | null = null;

function setupDom() {
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
	return win.document;
}

const WIDTH = 600;

function measured() {
	return measureMessageBubble({ role: "user", text: "hello team", hasHeader: false }, WIDTH);
}

/** The flex wrapper the bubble sits in — the element carrying the side decision. */
function renderBubble(isSelf: boolean): { justifyContent: string; background: string } {
	const doc = setupDom();
	const container = doc.createElement("div");
	doc.body.appendChild(container);
	currentContainer = container as unknown as HTMLElement;
	const root = createRoot(currentContainer);
	currentRoot = root;
	act(() => {
		root.render(
			<MantineProvider>
				{/* biome-ignore lint/a11y/useValidAriaRole: `role` is a domain prop, not an ARIA role */}
				<RenderMessageBubble role="user" measured={measured()} hasHeader={false} isSelf={isSelf} />
			</MantineProvider>,
		);
	});
	const wrapper = currentContainer.querySelector("div");
	if (!wrapper) throw new Error("expected the bubble wrapper to render");
	const inner = wrapper.querySelector("div");
	if (!inner) throw new Error("expected the bubble body to render");
	return {
		justifyContent: (wrapper as HTMLElement).style.justifyContent,
		background: (inner as HTMLElement).style.background,
	};
}

afterEach(() => {
	if (currentRoot) {
		const root = currentRoot;
		act(() => root.unmount());
		currentRoot = null;
	}
	currentContainer?.remove();
	currentContainer = null;
});

afterAll(() => {
	mock.restore();
});

describe("RenderMessageBubble — authorship decides the side", () => {
	test("the reader's own turn is right-aligned and indigo", () => {
		const own = renderBubble(true);
		expect(own.justifyContent).toBe("flex-end");
		expect(own.background).toContain("indigo");
	});

	test("a teammate's turn is left-aligned and NOT indigo", () => {
		const other = renderBubble(false);
		expect(other.justifyContent).toBe("flex-start");
		// The specific neutral is a design choice; what must hold is that it does not
		// reuse the "this is yours" indigo.
		expect(other.background).not.toContain("indigo");
	});

	test("defaults to the reader's own side when authorship is unresolved", () => {
		// Matches the helper's fallback: while `useCurrentUser()` loads, keeping the
		// historical right-hand rendering avoids flipping every bubble for one frame.
		const doc = setupDom();
		const container = doc.createElement("div");
		doc.body.appendChild(container);
		currentContainer = container as unknown as HTMLElement;
		const root = createRoot(currentContainer);
		currentRoot = root;
		act(() => {
			root.render(
				<MantineProvider>
					{/* biome-ignore lint/a11y/useValidAriaRole: `role` is a domain prop, not an ARIA role */}
					<RenderMessageBubble role="user" measured={measured()} hasHeader={false} />
				</MantineProvider>,
			);
		});
		const wrapper = currentContainer.querySelector("div") as HTMLElement | null;
		expect(wrapper?.style.justifyContent).toBe("flex-end");
	});
});

describe("RenderMessageBubble — the side is height-neutral", () => {
	test("both sides paint the SAME measured geometry", () => {
		// The measure layer never learns who is reading, so one measurement serves both
		// sides. This is what keeps viewer identity out of the measure cache key.
		const m = measured();
		expect(m.height).toBeGreaterThan(0);

		const own = renderBubble(true);
		const other = renderBubble(false);
		expect(own.justifyContent).not.toBe(other.justifyContent);

		// Same measured element, so the painted box must be identical on both sides.
		const doc = setupDom();
		const container = doc.createElement("div");
		doc.body.appendChild(container);
		currentContainer = container as unknown as HTMLElement;
		const root = createRoot(currentContainer);
		currentRoot = root;
		const boxes: string[] = [];
		for (const isSelf of [true, false]) {
			act(() => {
				root.render(
					<MantineProvider>
						{/* biome-ignore lint/a11y/useValidAriaRole: `role` is a domain prop, not an ARIA role */}
						<RenderMessageBubble role="user" measured={m} hasHeader={false} isSelf={isSelf} />
					</MantineProvider>,
				);
			});
			const inner = currentContainer.querySelector("div > div") as HTMLElement | null;
			boxes.push(`${inner?.style.width}|${inner?.style.height}`);
		}
		expect(boxes[0]).toBe(boxes[1]);
	});
});
