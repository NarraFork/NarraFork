/**
 * RenderMarkdown.link.test.tsx — a markdown link must PAINT as a real `<a href>`
 * in the exact (virtual-list) path, for every link form the chunked renderer
 * accepts.
 *
 * The render layer decides between `<a>` and `<span>` purely from the prepared
 * fragment's `href`, so anything that loses the href in `parse-markdown` produces
 * correctly-styled but completely dead text — visually almost identical, which is
 * why both bugs below survived: only the blue colour class (`is-link`) was ever
 * asserted, never the anchor.
 *
 * Two regressions are pinned here:
 *   1. ``[`code`](url)`` — the codespan token carries no href of its own, and the
 *      code fragment hardcoded `href: null`, so any link whose label was inline
 *      code went dead.
 *   2. `[x](/route)`, `[x](#anchor)`, `[x](mailto:…)` — `parseHref` ran every
 *      target through `new URL()` and rejected everything that failed to parse as
 *      an ABSOLUTE url, which is every relative path, in-app route and fragment.
 *
 * Geometry is not at stake (the href only changes the wrapping element, not the
 * measured fragment box), so these assertions are about the DOM contract alone.
 * The unsafe-scheme cases are included because widening the filter is exactly
 * where a sanitizer hole would be introduced.
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

interface Anchor {
	href: string | null;
	text: string;
	className: string | null;
}

/** Measure + render one markdown string, then report every painted anchor. */
async function renderAnchors(markdown: string): Promise<{
	anchors: Anchor[];
	/** Full visible text, to prove a rejected target still shows its label. */
	text: string;
	predictedHeight: number;
	unmount: () => void;
}> {
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

	const anchors = Array.from(container.querySelectorAll("a")).map((a) => ({
		href: a.getAttribute("href"),
		text: a.textContent ?? "",
		className: a.getAttribute("class"),
	}));

	return {
		anchors,
		text: container.textContent ?? "",
		predictedHeight: measured.frame.contentHeight,
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

describe("markdown links paint as anchors", () => {
	it("links an ordinary inline link and canonicalizes the absolute url", async () => {
		const r = await renderAnchors("段落里的 [示例](https://example.com) 结束。");
		expect(r.anchors).toHaveLength(1);
		// `new URL` normalization — same value the chunked path's parse tests pin.
		expect(r.anchors[0]?.href).toBe("https://example.com/");
		expect(r.anchors[0]?.text).toBe("示例");
		expect(r.anchors[0]?.className).toContain("is-link");
		r.unmount();
	});

	it("keeps the href when the whole label is inline code", async () => {
		const r = await renderAnchors("见 [`代码链接`](https://example.com/c) 完毕");
		expect(r.anchors).toHaveLength(1);
		expect(r.anchors[0]?.href).toBe("https://example.com/c");
		expect(r.anchors[0]?.text).toBe("代码链接");
		// The code chip's own styling must survive alongside the link colour.
		expect(r.anchors[0]?.className).toContain("vlist-frag--code");
		expect(r.anchors[0]?.className).toContain("is-link");
		r.unmount();
	});

	it("keeps the href on a label that mixes code and plain text", async () => {
		const r = await renderAnchors("见 [前缀 `code` 后缀](https://example.com/m) 完毕");
		// Every fragment of the label links to the same target.
		expect(r.anchors.length).toBeGreaterThanOrEqual(2);
		for (const a of r.anchors) expect(a.href).toBe("https://example.com/m");
		r.unmount();
	});

	it("links in-app routes, fragments and mailto targets", async () => {
		const r = await renderAnchors(
			"见 [路由](/knowledge/e1)、[锚点](#section)、[相对](../sibling) 与 [邮件](mailto:a@b.com)",
		);
		const hrefs = r.anchors.map((a) => a.href);
		// Non-absolute targets are preserved verbatim so the router resolves them.
		expect(hrefs).toEqual(["/knowledge/e1", "#section", "../sibling", "mailto:a@b.com"]);
		r.unmount();
	});

	it("links inside list items, headings and table cells", async () => {
		const list = await renderAnchors("- 列表 [a](https://example.com/l)");
		expect(list.anchors.map((a) => a.href)).toEqual(["https://example.com/l"]);
		list.unmount();

		const heading = await renderAnchors("## 标题 [b](https://example.com/h)");
		expect(heading.anchors.map((a) => a.href)).toEqual(["https://example.com/h"]);
		heading.unmount();

		const table = await renderAnchors("| a | b |\n|---|---|\n| [c](https://example.com/t) | y |");
		expect(table.anchors.map((a) => a.href)).toEqual(["https://example.com/t"]);
		table.unmount();
	});

	it("links every visual line of a bare url that wraps", async () => {
		// A long autolink is cut into several visual lines by the width solver; each
		// piece is its own fragment and must keep the target.
		const url = `https://example.com/${"segment/".repeat(30)}end`;
		const r = await renderAnchors(`参考 ${url} 结束`);
		expect(r.anchors.length).toBeGreaterThan(1);
		for (const a of r.anchors) expect(a.href).toBe(url);
		r.unmount();
	});

	it("refuses script-bearing schemes but still shows the label", async () => {
		for (const target of [
			"javascript:alert(1)",
			"data:text/html,<script>",
			"vbscript:x",
			"file:///etc/passwd",
			"blob:http://x/y",
			"about:blank",
		]) {
			const r = await renderAnchors(`见 [点我](${target}) 完毕`);
			expect(r.anchors).toHaveLength(0);
			// The text is never lost — it just is not a link.
			expect(r.text).toContain("点我");
			r.unmount();
		}
	});

	/**
	 * The reason `parseHref` decodes before it judges.
	 *
	 * marked hands the link destination over EXACTLY as written, character
	 * references intact — remark (and therefore react-markdown's sanitizer) decodes
	 * them first, so the chunked path never sees these spellings at all. A filter
	 * that pattern-matches the raw text therefore misses every encoded `javascript:`
	 * while the browser decodes the attribute happily: `&#106;avascript:alert(1)`
	 * reached the DOM as a live script URL.
	 *
	 * Each vector below was confirmed to LEAK before the decode step existed.
	 */
	it("refuses character-reference encodings of a script scheme", async () => {
		const vectors = [
			// Decimal, with and without the terminating semicolon (the HTML tokenizer
			// decodes both; the semicolon-less form is only a parse error).
			"&#106;avascript:alert(1)",
			"&#106avascript:alert(1)",
			// Leading zeros are legal in a numeric reference.
			"&#0000106;avascript:alert(1)",
			// Hex, lower and upper `x`, and mixed-case digits.
			"&#x6a;avascript:alert(1)",
			"&#X6A;avascript:alert(1)",
			// Double encoding: `&#38;` / `&amp;` decode to `&`, which makes the SECOND
			// pass see `&#106;avascript:` — hence the multi-pass decode.
			"&#38;#106;avascript:alert(1)",
			"&amp;#106;avascript:alert(1)",
			// The colon itself encoded, so the raw text carries no `scheme:` at all.
			"javascript&colon;alert(1)",
			"javascript&#58;alert(1)",
			// Whitespace encoded INSIDE the scheme; browsers strip tab/newline from a
			// URL before parsing it, so this is `javascript:` to them.
			"java&#9;script:alert(1)",
			"java&Tab;script:alert(1)",
			// Mixed case survives decoding and must still be caught.
			"&#106;AvAsCrIpT:alert(1)",
			"&#74;avascript:alert(1)",
		];
		for (const target of vectors) {
			const r = await renderAnchors(`见 [点我](${target}) 完毕`);
			expect(r.anchors, `must not link: ${target}`).toHaveLength(0);
			expect(r.text).toContain("点我");
			r.unmount();
		}
	});

	/**
	 * The reverse assertion, and the reason "reject any href containing `&#`" was
	 * not the fix: `&` is ordinary URL syntax. Decoding is used ONLY to decide
	 * accept/reject — the href written to the DOM stays the original text, so an
	 * `&amp;` in a query is neither rewritten nor grounds for rejection.
	 */
	it("still links ordinary urls whose query contains &", async () => {
		const r = await renderAnchors(
			"见 [查询](https://example.com/s?a=1&b=2)、[转义](/route?a=1&amp;b=2) 与 [片段](#a&b)",
		);
		expect(r.anchors.map((a) => a.href)).toEqual([
			"https://example.com/s?a=1&b=2",
			"/route?a=1&amp;b=2",
			"#a&b",
		]);
		r.unmount();
	});

	/**
	 * A colon after the first `/`, `?` or `#` is path/query/fragment text, not a
	 * scheme — the same rule react-markdown's `defaultUrlTransform` applies. Without
	 * it a relative path with a colon in it would be read as naming an unknown
	 * scheme and dropped.
	 */
	it("does not mistake a colon inside a path or query for a scheme", async () => {
		const r = await renderAnchors(
			"见 [路径](docs/a:b)、[查询](?next=http://x) 与 [协议相对](//cdn.example.com/x)",
		);
		expect(r.anchors.map((a) => a.href)).toEqual([
			"docs/a:b",
			"?next=http://x",
			"//cdn.example.com/x",
		]);
		r.unmount();
	});

	/**
	 * A SPACE is not stripped from the middle of a URL (only tab / newline are), and
	 * it cannot appear in a scheme — so `<my note:1.md>` is a relative file path and
	 * must stay linked, while the same treatment applied to a script scheme
	 * (`java script:`) leaves it a harmless relative path rather than an executable
	 * one. Both forms only reach `parseHref` in angle brackets: CommonMark refuses an
	 * unescaped space in a bare destination, so `[a](my note:1.md)` is never a link
	 * token in the first place.
	 */
	it("treats an interior space as path text, not as a strippable character", async () => {
		const kept = await renderAnchors("见 [笔记](<my note:1.md>) 完毕");
		expect(kept.anchors.map((a) => a.href)).toEqual(["my note:1.md"]);
		kept.unmount();

		const spaced = await renderAnchors("见 [点我](<java script:alert(1)>) 完毕");
		// Not rejected, because it is not a scheme at all — the browser resolves it
		// relatively, exactly as it does the note path above.
		expect(spaced.anchors.map((a) => a.href)).toEqual(["java script:alert(1)"]);
		spaced.unmount();

		// The bracketed form of a REAL script scheme is still refused.
		const blocked = await renderAnchors("见 [点我](<javascript:alert(1)>) 完毕");
		expect(blocked.anchors).toHaveLength(0);
		blocked.unmount();
	});
});
