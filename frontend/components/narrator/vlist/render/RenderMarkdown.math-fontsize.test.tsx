/**
 * RenderMarkdown.math-fontsize.test.tsx — a formula must be PAINTED at the same
 * font size it was MEASURED at.
 *
 * The bug this locks down: `katex-geometry` measures formulas against an explicit
 * `basePx` (FONT_SIZE.sm = 14px), because KaTeX's own stylesheet sizes its root
 * box RELATIVELY — `.katex { font: normal 1.21em ... }`. `em` resolves against
 * whatever font size the formula's DOM ancestor happens to carry. The vlist paints
 * text fragments with an inline `font` shorthand (block.fonts[itemIndex]), but the
 * math host span carried NO font size of its own, so KaTeX inherited the document
 * default instead — Mantine sets `body { font-size: var(--mantine-font-size-md) }`
 * = 16px. The formula therefore rendered at 16 × 1.21 while the height model had
 * committed to 14 × 1.21: ~14% too large, and since the host box is width-pinned
 * with `overflow: hidden`, the right side of every inline formula was clipped.
 *
 * The contract asserted here is the same one the text fragments already obey
 * (CONTRACT §0: paint at the geometry that was measured):
 *   1. the inline math host declares an explicit px font size;
 *   2. that size is the SAME basePx katex-geometry measured with;
 *   3. display math obeys it too (same `1.21em` root, same failure mode);
 *   4. the fallback (KaTeX unavailable) is unaffected — it paints source text,
 *      not a KaTeX box.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RenderLodCtx } from "../../lod/RenderLodCtx";
import { installCanvasStub } from "../measure/test-canvas-stub";

const CONTENT_WIDTH = 800;

/** The base the measure layer commits to (parse-markdown passes FONT_SIZE.sm). */
const MEASURED_BASE_PX = 14;

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

interface Rendered {
	container: Element;
	unmount: () => void;
}

/** Measure + render one markdown string through the real measure/render pair. */
async function renderMarkdownBody(markdown: string): Promise<Rendered> {
	// Dynamic imports: the canvas stub must be installed before the pretext-backed
	// modules load (CONTRACT §5), and KaTeX must be reachable so math is measured
	// rather than degraded to literal text.
	const { ensureKatexLoaded } = await import("../katex-runtime");
	await ensureKatexLoaded(markdown);
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

const inlineMathHost = (root: Element) =>
	root.querySelector('[data-vlist-math="inline"]') as unknown as HTMLElement | null;

const displayMathHost = (root: Element) =>
	root.querySelector(".vlist-math-display") as unknown as HTMLElement | null;

describe("inline math font size (virtual list)", () => {
	it("paints the formula at the px base the height model measured with", async () => {
		const view = await renderMarkdownBody("Energy is $E = mc^2$ in total.");
		const host = inlineMathHost(view.container);
		expect(host).not.toBeNull();
		// An explicit px size is the whole point: KaTeX's root is `1.21em`, so
		// inheriting the document default (Mantine body = 16px) silently rescales
		// the formula away from the measured geometry.
		expect(host?.style.fontSize).toBe(`${MEASURED_BASE_PX}px`);
		view.unmount();
	});

	it("keeps the boxed formula inside its reserved width", async () => {
		const view = await renderMarkdownBody("答案是 $\\boxed{21}$。");
		const host = inlineMathHost(view.container);
		expect(host).not.toBeNull();
		// The geometry model includes KaTeX's `.boxpad` class-only padding, so the
		// host can safely clip at its reserved edge without overlapping the next text.
		expect(host?.style.overflow).toBe("hidden");
		expect(Number.parseFloat(host?.style.width ?? "0")).toBeGreaterThan(20);
		view.unmount();
	});

	it("keeps the measured width pinned on the host box", async () => {
		// The width the parser reserved in the pretext flow must be the width the
		// host paints at, otherwise the surrounding text is pushed or the formula
		// is clipped.
		const { ensureKatexLoaded } = await import("../katex-runtime");
		const markdown = "Sum: $\\sum_{i=1}^{n} i^2$ done.";
		await ensureKatexLoaded(markdown);
		const { parseMarkdownToPreparedBlocks } = await import("../parse-markdown");
		const { markdownMathSupport } = await import("../measure/math-support");
		const blocks = parseMarkdownToPreparedBlocks(markdown, markdownMathSupport());
		const fragment = blocks
			.flatMap((b) => (b.kind === "inline" ? (b.mathHtmls ?? []) : []))
			.find((m) => m);
		expect(fragment).toBeDefined();

		const view = await renderMarkdownBody(markdown);
		const host = inlineMathHost(view.container);
		expect(host?.style.width).toBe(`${fragment?.width}px`);
		view.unmount();
	});

	it("applies the same base to a formula inside a heading", async () => {
		// A heading fragment is painted at its own (larger) font, so an inherited
		// size would scale the formula with it — the measure layer still used the
		// body base, so the host must pin that base regardless of context.
		const view = await renderMarkdownBody("## Section $x^2$ heading");
		const host = inlineMathHost(view.container);
		expect(host).not.toBeNull();
		expect(host?.style.fontSize).toBe(`${MEASURED_BASE_PX}px`);
		view.unmount();
	});
});

describe("a formula never wraps inside its host box", () => {
	// KaTeX deliberately splits a formula into SEVERAL `.base` spans, cutting after
	// binary/relation operators so a browser can break a long formula there. Those
	// cuts are real line-break opportunities. The host box is width-pinned to the
	// measured width with no slack, so any sub-pixel rounding lets the box wrap at
	// one of those cuts — the formula then renders on two stacked lines, clipped by
	// the fixed height. Observed on `$x_1 + x_2$`, `$\nabla f(x) = 0$` and
	// `$f(x) = \sum…$`: each broke exactly at its operator.
	//
	// The fix must suppress wrapping rather than widen the box: widening would
	// desync the paint from the reserved geometry (zero-DOM contract).
	const MULTI_BASE = [
		"x_1 + x_2",
		"\\nabla f(x) = 0",
		"E = mc^2",
		"f(x) = \\sum_{i=1}^{n} \\frac{(x - \\mu_i)^2}{2\\sigma_i^2}",
	];

	it("emits multi-base markup for the formulas that broke (regression premise)", async () => {
		// Guards the premise: if KaTeX ever stopped splitting bases, the assertions
		// below would pass for the wrong reason.
		const katex = (await import("katex")).default;
		for (const latex of MULTI_BASE) {
			const html = katex.renderToString(latex, {
				displayMode: false,
				throwOnError: false,
				output: "html",
			});
			expect((html.match(/class="base"/g) ?? []).length).toBeGreaterThan(1);
		}
	});

	it("pins white-space so the operator cuts cannot become line breaks", async () => {
		for (const latex of MULTI_BASE) {
			const view = await renderMarkdownBody(`prose $${latex}$ tail`);
			const host = inlineMathHost(view.container);
			expect(host).not.toBeNull();
			// `nowrap` is what removes the break opportunity between `.base` spans.
			expect(host?.style.whiteSpace).toBe("nowrap");
			view.unmount();
		}
	});

	it("keeps the host a single unwrappable run even in a narrow column", async () => {
		// The real trigger is a tight column: the row is measured at a width the
		// formula only just fits into.
		const { ensureKatexLoaded } = await import("../katex-runtime");
		const { measureMarkdown } = await import("../measure/measure-markdown");
		const { RenderMarkdown } = await import("./RenderMarkdown");
		const markdown = "设 $f(x) = \\sum_{i=1}^{n} \\frac{(x - \\mu_i)^2}{2\\sigma_i^2}$ 为目标函数";
		await ensureKatexLoaded(markdown);
		const measured = measureMarkdown(markdown, 240);

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
		const host = inlineMathHost(container as unknown as Element);
		expect(host?.style.whiteSpace).toBe("nowrap");
		act(() => reactRoot.unmount());
		container.remove();
	});
});

describe("measure and render agree on the base", () => {
	it("pins the same size the measure layer measured with", async () => {
		// The render layer keeps its own `MATH_BASE_FONT_SIZE` (the dev server does not
		// watch `shared/`, so a render-side import of a NEW shared export breaks HMR —
		// see the constant's comment). Both sides derive from FONT_SIZE.sm, and this
		// asserts they actually still agree: if one moves, the painted formula silently
		// desyncs from the reserved geometry again.
		const { MATH_BASE_FONT_SIZE } = await import("../pretext-fonts");
		const { FONT_SIZE } = await import("../pretext-fonts");
		expect(MATH_BASE_FONT_SIZE).toBe(FONT_SIZE.sm);
		expect(MATH_BASE_FONT_SIZE).toBe(MEASURED_BASE_PX);

		// And the painted host uses that very value.
		const view = await renderMarkdownBody("value $x^2$ here");
		expect(inlineMathHost(view.container)?.style.fontSize).toBe(`${MATH_BASE_FONT_SIZE}px`);
		view.unmount();
	});
});

describe("display math font size (virtual list)", () => {
	it("paints display math at the measured px base too", async () => {
		const view = await renderMarkdownBody("$$\\int_0^1 x^2 dx$$");
		const host = displayMathHost(view.container);
		expect(host).not.toBeNull();
		expect(host?.style.fontSize).toBe(`${MEASURED_BASE_PX}px`);
		view.unmount();
	});
});

describe("source fallback is untouched", () => {
	/**
	 * Render the fallback branch: `html: ""` means KaTeX was unavailable or failed,
	 * so the render layer shows the LaTeX source instead of an empty box. `width` is
	 * left at the measured value, which is the state the reserved slot is in.
	 */
	async function renderSourceFallback(markdown: string) {
		const { measureMarkdown } = await import("../measure/measure-markdown");
		const { RenderMarkdown } = await import("./RenderMarkdown");
		const measured = measureMarkdown(markdown, CONTENT_WIDTH);
		const blocks = measured.blocks.map((block) => {
			if (block.kind !== "inline" || !block.mathHtmls) return block;
			return {
				...block,
				mathHtmls: block.mathHtmls.map((m) => (m ? { ...m, html: "" } : m)),
			};
		});

		const container = document.createElement("div");
		document.body.appendChild(container);
		const reactRoot = createRoot(container);
		act(() => {
			reactRoot.render(
				<MantineProvider>
					<RenderLodCtx.Provider value={{ lod: 5, interactive: true }}>
						<RenderMarkdown measured={{ ...measured, blocks }} />
					</RenderLodCtx.Provider>
				</MantineProvider>,
			);
		});
		/** The measured geometry of the first formula in the body. */
		const reserved = blocks
			.flatMap((block) => (block.kind === "inline" ? (block.mathHtmls ?? []) : []))
			.find((m) => m != null);
		return {
			container,
			reserved,
			unmount: () => {
				act(() => reactRoot.unmount());
				container.remove();
			},
		};
	}

	it("renders LaTeX source as text when KaTeX produced no markup", async () => {
		const view = await renderSourceFallback("value $x$ here");
		expect(view.container.querySelector('[data-vlist-math="inline"]')).toBeNull();
		expect(view.container.querySelector(".vlist-frag--math-source")?.textContent).toBe("x");
		view.unmount();
	});

	/**
	 * The fallback must be PINNED to the measured slot, not sized by its own text.
	 *
	 * The slot was reserved from the formula's RENDERED width, and LaTeX source bears
	 * no relation to it — `\sum_{i=1}^{n}` is far wider as source than as a formula.
	 * An unpinned span would overflow the slot and push every later fragment on the
	 * line sideways, so the painted line would no longer match the measured one.
	 */
	it("pins the fallback to the reserved width and clips the overflow", async () => {
		const view = await renderSourceFallback("value $\\sum_{i=1}^{n} x_i$ here");
		const fallback = view.container.querySelector(".vlist-frag--math-source");
		if (!fallback) throw new Error("expected the source fallback span");
		const style = fallback.getAttribute("style") ?? "";
		const reservedWidth = view.reserved?.width ?? 0;
		expect(reservedWidth).toBeGreaterThan(0);
		// Same width pin + clip the rendered branch uses, so the slot cannot grow.
		expect(style).toMatch(new RegExp(`width:\\s*${reservedWidth}px`));
		expect(style).toMatch(/overflow:\s*hidden/);
		view.unmount();
	});
});
