/**
 * RenderMarkdown.anchor.test.tsx — a document-internal `[x](#heading)` link must
 * be rendered as an IN-PLACE anchor, and the heading it names must advertise a
 * matching slug.
 *
 * The bug: every link got `target="_blank"`, so clicking an in-document anchor
 * opened a new tab, and no heading carried an anchor target at all — so even the
 * new tab scrolled nowhere. Both halves fail SILENTLY (a link that looks right
 * and goes nowhere), which is why the assertions are on the painted DOM rather
 * than on the prepared block alone.
 *
 * Geometry is not at stake: the heading slug is an attribute and the link change
 * only removes `target`, so neither can move a measured box. The height parity
 * assertion at the end states that explicitly, since this path's whole contract
 * is that painted geometry equals predicted geometry.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MD_HEADING_SLUG_ATTR } from "@frontend/lib/markdown-anchor-scroll";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RenderLodCtx } from "../../RenderLodCtx";
import { installCanvasStub } from "../measure/test-canvas-stub";

const CONTENT_WIDTH = 800;

/**
 * Globals the linkedom realm replaces, restored afterwards.
 *
 * Bun shares one process across test files, so leaving this realm installed makes it
 * the `Element`/`Event` of whichever file runs next — `app-shell-scroll.test.tsx`
 * records that exact leak breaking unrelated `instanceof` assertions, and blaming the
 * wrong file for it. Descriptors rather than values: several of these do not exist
 * under Bun, and writing `undefined` back is not the same as removing them.
 */
const DOM_GLOBAL_NAMES = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"getComputedStyle",
	"matchMedia",
	"ResizeObserver",
	"requestAnimationFrame",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

function setGlobal(name: string, value: unknown): void {
	if (!previousGlobals.has(name)) {
		previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	}
	Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

beforeAll(() => {
	installCanvasStub();
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const g = globalThis as unknown as Record<string, unknown>;
	setGlobal("window", win);
	setGlobal("document", win.document);
	setGlobal("navigator", win.navigator);
	setGlobal("HTMLElement", win.HTMLElement);
	setGlobal("Element", win.Element);
	setGlobal("Node", win.Node);
	setGlobal("getComputedStyle", win.getComputedStyle);
	setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	if (typeof g.matchMedia !== "function") {
		setGlobal("matchMedia", () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		}));
	}
	if (typeof g.ResizeObserver !== "function") {
		setGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		);
	}
	if (typeof g.requestAnimationFrame !== "function") {
		setGlobal("requestAnimationFrame", (cb: (t: number) => void) =>
			setTimeout(() => cb(Date.now()), 0),
		);
	}
});

afterAll(() => {
	for (const name of DOM_GLOBAL_NAMES) {
		if (!previousGlobals.has(name)) continue;
		const descriptor = previousGlobals.get(name);
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	previousGlobals.clear();
});

async function renderMarkdown(markdown: string) {
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
					<RenderMarkdown measured={measured} />
				</RenderLodCtx.Provider>
			</MantineProvider>,
		);
	});

	return {
		container,
		/** Slugs advertised by painted heading blocks, in document order. */
		headingSlugs: Array.from(container.querySelectorAll(`[${MD_HEADING_SLUG_ATTR}]`), (el) =>
			el.getAttribute(MD_HEADING_SLUG_ATTR),
		),
		anchors: Array.from(container.querySelectorAll("a")).map((a) => ({
			href: a.getAttribute("href"),
			target: a.getAttribute("target"),
			rel: a.getAttribute("rel"),
			text: a.textContent ?? "",
		})),
		predictedHeight: measured.frame.contentHeight,
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

describe("headings advertise anchor slugs", () => {
	it("tags every heading level", async () => {
		const r = await renderMarkdown(
			["# One", "## Two", "### Three", "#### Four", "##### Five", "###### Six"].join("\n\n"),
		);
		expect(r.headingSlugs).toEqual(["one", "two", "three", "four", "five", "six"]);
		r.unmount();
	});

	it("keeps CJK heading text in the slug", async () => {
		const r = await renderMarkdown("## 实现细节\n\n正文");
		expect(r.headingSlugs).toEqual(["实现细节"]);
		r.unmount();
	});

	it("slugs a heading's VISIBLE text, not a link destination inside it", async () => {
		// The heading token's raw `.text` would fold the url into the slug.
		const r = await renderMarkdown("## 见 [文档](https://example.com/docs)");
		expect(r.headingSlugs).toEqual(["见-文档"]);
		r.unmount();
	});

	it("tags a heading only once when it wraps onto several lines", async () => {
		// A wrapped heading becomes several inline blocks; an anchor must have one
		// landing point, so only the first is tagged.
		const r = await renderMarkdown(`## ${"很长的标题内容".repeat(30)}`);
		expect(r.headingSlugs).toHaveLength(1);
		r.unmount();
	});

	it("does not tag a heading with nothing sluggable", async () => {
		// An empty attribute would match an empty query and swallow every
		// unresolvable anchor.
		const r = await renderMarkdown("## ***\n\n## 🎉");
		expect(r.headingSlugs).toEqual([]);
		r.unmount();
	});

	it("does not tag paragraphs, list items or quotes", async () => {
		const r = await renderMarkdown("正文段落\n\n- 列表项\n\n> 引用");
		expect(r.headingSlugs).toEqual([]);
		r.unmount();
	});
});

describe("same-document anchors render in-place", () => {
	it("gives a fragment link no target while keeping the href", async () => {
		const r = await renderMarkdown("## 实现细节\n\n见 [下文](#实现细节) 说明");
		const anchor = r.anchors.find((a) => a.text === "下文");
		expect(anchor?.href).toBe("#实现细节");
		// The defect: `_blank` here opened a blank tab instead of scrolling.
		expect(anchor?.target).toBeNull();
		expect(anchor?.rel).toBeNull();
		r.unmount();
	});

	it("still opens real destinations in a new tab", async () => {
		const r = await renderMarkdown(
			"见 [外链](https://example.com)、[路由](/knowledge/e1) 与 [他文档锚点](docs.md#section)",
		);
		expect(r.anchors).toHaveLength(3);
		for (const anchor of r.anchors) {
			expect(anchor.target, `must stay external: ${anchor.href}`).toBe("_blank");
			expect(anchor.rel).toBe("noopener noreferrer");
		}
		r.unmount();
	});

	it("applies the same rule inside a table cell", async () => {
		const r = await renderMarkdown(
			"## 目标\n\n| a | b |\n|---|---|\n| [跳转](#目标) | [外链](https://example.com) |",
		);
		const internal = r.anchors.find((a) => a.href === "#目标");
		const external = r.anchors.find((a) => a.href === "https://example.com/");
		expect(internal?.target).toBeNull();
		expect(external?.target).toBe("_blank");
		r.unmount();
	});

	it("exposes a body scope so a click cannot reach another message's headings", async () => {
		// Anchor resolution walks up to `[data-md-body]`; without it the lookup would
		// span the whole document, where several rows repeat a heading.
		const r = await renderMarkdown("## 结论\n\n见 [上文](#结论)");
		const anchor = r.container.querySelector("a");
		expect(anchor?.closest("[data-md-body]")).not.toBeNull();
		// The heading is inside that same scope, i.e. the click will find it.
		const scope = anchor?.closest("[data-md-body]");
		expect(scope?.querySelector(`[${MD_HEADING_SLUG_ATTR}="结论"]`)).not.toBeNull();
		r.unmount();
	});
});

describe("anchors are height-neutral", () => {
	it("predicts the same height with and without an anchor link", async () => {
		// The slug is an attribute and the link change only drops `target`, so the
		// measured geometry must be byte-identical to the plain-text equivalent.
		const { measureMarkdown } = await import("../measure/measure-markdown");
		const withAnchor = measureMarkdown("## 实现细节\n\n见 [下文](#实现细节) 说明", CONTENT_WIDTH);
		const withExternal = measureMarkdown(
			"## 实现细节\n\n见 [下文](https://example.com) 说明",
			CONTENT_WIDTH,
		);
		expect(withAnchor.frame.contentHeight).toBe(withExternal.frame.contentHeight);
	});
});
