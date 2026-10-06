/**
 * RenderMarkdown.copytext.test.tsx — a copied selection must not gain newlines
 * around inline fragments.
 *
 * ## The bug
 *
 * Every vlist text line is an absolutely positioned `display:flex` row, and each
 * pretext fragment is an `inline-block` span. CSS BLOCKIFIES flex items, so each
 * fragment's computed `display` becomes `block`. The plain-text serializer breaks
 * at block boundaries, so
 *
 *     Firefox: `clipboardData.files` is empty.
 *
 * copied out as
 *
 *     "Firefox: \nclipboardData.files\n is empty."
 *
 * — a stray newline before AND after every inline code span, link, bold run, i.e.
 * anything the markdown parser emits as its own fragment.
 *
 * ## What is asserted
 *
 * This is a STRUCTURAL test, not a clipboard test: linkedom has no layout engine
 * and no selection serializer, so it cannot reproduce Chrome's block-boundary
 * behaviour. What it CAN pin down is the DOM invariant the fix rests on, verified
 * against real Chrome 146 beforehand:
 *
 *   1. a line's fragments are NOT direct children of the flex line — they sit
 *      inside a single wrapper, so they are not flex items and are never blockified;
 *   2. that wrapper carries `flex-shrink: 0`, without which a line narrower than its
 *      content squeezes the wrapper and the fragments rewrap onto extra rows,
 *      breaking the reserved height (CONTRACT §0 iron law 2). Reproduced in Chrome
 *      for `TableCellView`, whose line has no `min-width: max-content` guard;
 *   3. the fragments themselves still carry the measured `font` and
 *      `white-space: pre` (CONTRACT §6 — drifting from the measured font rewraps
 *      the text and desyncs the height model).
 *
 * The wrapper is emitted by `LineFragments` (render/line-fragments.tsx); every
 * render-*.tsx painting pretext fragments in a flex line must route through it.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RenderLodCtx } from "../../lod/RenderLodCtx";
import { installCanvasStub } from "../measure/test-canvas-stub";

const CONTENT_WIDTH = 800;

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
	}
	if (typeof g.cancelAnimationFrame !== "function") {
		g.cancelAnimationFrame = (handle: number) => clearTimeout(handle as unknown as Timer);
	}
});

async function renderMarkdownBody(markdown: string) {
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
		container: container as unknown as Element,
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

/** Every text line the markdown body painted. */
const linesOf = (container: Element) => [...container.querySelectorAll("[data-vlist-line]")];
/** The single wrapper a line routes its fragments through. */
const wrapperOf = (line: Element) => line.querySelector("[data-vlist-line-frags]");

describe("copied text has no stray newlines around inline fragments", () => {
	it("wraps a paragraph's fragments in one non-flex-item host", async () => {
		// Three fragments: plain text, inline code, plain text — exactly the shape
		// that produced "Firefox: \nclipboardData.files\n is empty."
		const { container, unmount } = await renderMarkdownBody(
			"Firefox: `clipboardData.files` is empty.",
		);
		try {
			const lines = linesOf(container);
			expect(lines.length).toBeGreaterThan(0);

			for (const line of lines) {
				const wrapper = wrapperOf(line);
				// Without the wrapper the fragments are flex items → blockified →
				// newline-separated when copied.
				expect(wrapper).not.toBeNull();
				// The wrapper must be the line's ONLY element child, otherwise whatever
				// sits beside it is still a flex item and still gets blockified.
				expect([...line.children]).toEqual(wrapper ? [wrapper] : []);
			}

			// The inline code fragment must live INSIDE the wrapper, not beside it.
			const code = container.querySelector(".vlist-frag--code");
			expect(code).not.toBeNull();
			const owner = code?.closest("[data-vlist-line-frags]");
			expect(owner).not.toBeNull();
		} finally {
			unmount();
		}
	});

	it("pins flex-shrink:0 on the wrapper so fragments never rewrap", async () => {
		// A shrinkable wrapper reflows its inline-blocks onto extra rows in any line
		// without a max-content guard (table cells), which silently exceeds the
		// reserved height. Guard the declaration itself, since linkedom cannot lay out.
		const { container, unmount } = await renderMarkdownBody("Some `inline code` here.");
		try {
			const wrappers = [...container.querySelectorAll("[data-vlist-line-frags]")];
			expect(wrappers.length).toBeGreaterThan(0);
			for (const wrapper of wrappers) {
				const style = (wrapper as HTMLElement).style;
				expect(style.flexShrink).toBe("0");
				// Block, so its inline children have no block boundary between them.
				expect(style.display).toBe("block");
			}
		} finally {
			unmount();
		}
	});

	it("keeps the measured font and pre whitespace on each fragment", async () => {
		// CONTRACT §6: the wrapper must not have moved these onto itself — a fragment
		// painted with a different font rewraps and desyncs the height model.
		const { container, unmount } = await renderMarkdownBody(
			"Plain **bold** and `code` and [link](https://example.com) mixed.",
		);
		try {
			const wrappers = [...container.querySelectorAll("[data-vlist-line-frags]")];
			expect(wrappers.length).toBeGreaterThan(0);
			let checked = 0;
			for (const wrapper of wrappers) {
				// Gap separators are siblings of the fragments, so skip them here; they
				// are asserted on their own below.
				for (const frag of [...wrapper.children].filter(
					(el) => !el.hasAttribute("data-vlist-frag-gap"),
				)) {
					const style = (frag as HTMLElement).style;
					expect(style.whiteSpace).toBe("pre");
					expect(style.display).toBe("inline-block");
					expect(style.font.length).toBeGreaterThan(0);
					checked++;
				}
			}
			expect(checked).toBeGreaterThan(1);
		} finally {
			unmount();
		}
	});

	it("emits a copyable space wherever pretext encoded one as gapBefore", async () => {
		// Defect 2: pretext encodes an inter-fragment space as `gapBefore` PIXELS
		// (painted as margin-left), so the space is geometry and never a character —
		// "See **bold** and `code` here." copied as "Seeboldandcodehere.". This was
		// masked by defect 1, because every missing space had a stray newline standing
		// in for it.
		const { container, unmount } = await renderMarkdownBody("See **bold** and `code` here.");
		try {
			const wrappers = [...container.querySelectorAll("[data-vlist-line-frags]")];
			expect(wrappers.length).toBeGreaterThan(0);

			let gapCount = 0;
			for (const wrapper of wrappers) {
				for (const el of [...wrapper.children]) {
					// The gap is the fragment's PRECEDING SIBLING, never its child: nesting
					// it made `a.textContent` return " 示例" instead of "示例", which leaks
					// into copying a single link (RenderMarkdown.link.test.tsx catches that).
					if (el.hasAttribute("data-vlist-frag-gap")) {
						// font-size 0 is the mechanism: real text for the serializer, but
						// zero advance so the measured geometry is untouched. linkedom keeps
						// the unitless "0" React writes; browsers normalize it to "0px".
						expect(Number.parseFloat((el as HTMLElement).style.fontSize)).toBe(0);
						expect(el.textContent).toBe(" ");
						gapCount++;
						continue;
					}
					// A fragment must never carry the gap inside itself.
					expect(el.querySelector("[data-vlist-frag-gap]")).toBeNull();
					// `marginLeft` is how gapBefore is painted; a positive one means the
					// source had a space here, so a separator must precede this fragment.
					const margin = Number.parseFloat((el as HTMLElement).style.marginLeft || "0");
					const prev = el.previousElementSibling;
					const precededByGap = prev?.hasAttribute("data-vlist-frag-gap") ?? false;
					expect(precededByGap).toBe(margin > 0);
				}
			}
			// "See | bold | and | code | here." — four spaced boundaries.
			expect(gapCount).toBe(4);
		} finally {
			unmount();
		}
	});

	it("adds no space between CJK prose and inline code", async () => {
		// Chinese source has no spaces, so every gapBefore is 0 and the copied text
		// must stay glued exactly as written.
		const { container, unmount } = await renderMarkdownBody(
			"长期不支持粘贴，`clipboardData.files` 是空的。",
		);
		try {
			const code = container.querySelector(".vlist-frag--code");
			expect(code).not.toBeNull();
			// The code fragment directly follows CJK text with no space in the source.
			const margin = Number.parseFloat((code as HTMLElement).style.marginLeft || "0");
			expect(margin).toBe(0);
			expect(code?.querySelector("[data-vlist-frag-gap]")).toBeNull();
			// And no separator was inserted before it either.
			expect(code?.previousElementSibling?.hasAttribute("data-vlist-frag-gap") ?? false).toBe(
				false,
			);
		} finally {
			unmount();
		}
	});

	it("wraps table cell lines too (the shape with no max-content guard)", async () => {
		const { container, unmount } = await renderMarkdownBody(
			["| Field | Value |", "| --- | --- |", "| mode | `uri-list` only |"].join("\n"),
		);
		try {
			const table = container.querySelector("[data-vlist-table]");
			expect(table).not.toBeNull();
			const cellLines = [...(table?.querySelectorAll("[data-vlist-line]") ?? [])];
			expect(cellLines.length).toBeGreaterThan(0);
			for (const line of cellLines) {
				const wrapper = wrapperOf(line);
				expect(wrapper).not.toBeNull();
				expect((wrapper as HTMLElement).style.flexShrink).toBe("0");
			}
		} finally {
			unmount();
		}
	});
});
