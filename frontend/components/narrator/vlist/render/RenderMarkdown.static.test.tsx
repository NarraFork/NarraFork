import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { MantineProvider } from "@mantine/core";
import {
	getTypographyRevision,
	resetTypographyForTest,
	setTypography,
} from "@shared/pretext-layout/typography";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { RenderLodCtx } from "../../lod/RenderLodCtx";
import { installCanvasStub } from "../measure/test-canvas-stub";
import type { RenderMarkdownProps } from "./RenderMarkdown";
import { staticInlineMarkupCache } from "./static-inline-markup";

let RenderMarkdown: typeof import("./RenderMarkdown").RenderMarkdown;
let measureMarkdown: typeof import("../measure/measure-markdown").measureMarkdown;
let disposeCanvas: () => void;

beforeAll(async () => {
	disposeCanvas = installCanvasStub();
	({ measureMarkdown } = await import("../measure/measure-markdown"));
	({ RenderMarkdown } = await import("./RenderMarkdown"));
});
afterAll(() => disposeCanvas());
beforeEach(() => {
	resetTypographyForTest();
	staticInlineMarkupCache.clear();
});
afterEach(() => {
	resetTypographyForTest();
	staticInlineMarkupCache.clear();
});

function render(props: RenderMarkdownProps) {
	return parseHTML(
		`<html><body>${renderToStaticMarkup(
			<MantineProvider>
				<RenderLodCtx.Provider value={{ lod: 5, interactive: true }}>
					<RenderMarkdown {...props} />
				</RenderLodCtx.Provider>
			</MantineProvider>,
		)}</body></html>`,
	).document;
}

/** All DOM nodes and attributes, including classes and the complete CSS declaration set. */
function shape(node: Node): unknown {
	if (node.nodeType !== 1) return { type: node.nodeType, text: node.nodeValue };
	const element = node as Element;
	return {
		tag: element.tagName,
		attributes: [...element.attributes]
			.map(({ name, value }) => [
				name,
				name === "style"
					? value
							.split(";")
							.filter(Boolean)
							.map((declaration) => {
								const colon = declaration.indexOf(":");
								const property = declaration.slice(0, colon).trim();
								const cssValue = declaration.slice(colon + 1).trim();
								// React's font-size:0 and the serializer's 0px are identical CSS lengths.
								const length = /^(font-size|margin-(left|right)|top|left|width|height)$/;
								return [
									property,
									length.test(property) && /^0(?:px)?$/.test(cssValue) ? "0" : cssValue,
								];
							})
							.sort(([a], [b]) => String(a).localeCompare(String(b)))
					: value,
			])
			.sort(([a], [b]) => String(a).localeCompare(String(b))),
		children: normalizedChildren(element),
	};
}

/** Entity decoding may split adjacent text nodes in linkedom; DOM.normalize() coalesces them. */
function normalizedChildren(element: Element): unknown[] {
	const children: unknown[] = [];
	let text = "";
	let hasText = false;
	const flush = () => {
		if (hasText) children.push({ type: 3, text });
		text = "";
		hasText = false;
	};
	for (const node of element.childNodes) {
		if (node.nodeType === 3) {
			text += node.nodeValue ?? "";
			hasText = true;
		} else {
			flush();
			children.push(shape(node));
		}
	}
	flush();
	return children;
}

function body(document: Document) {
	const node = document.querySelector("[data-md-body]");
	if (!node) throw new Error("real markdown body did not render");
	return node;
}

function compare(props: RenderMarkdownProps) {
	const fastSpy = spyOn(staticInlineMarkupCache, "get");
	let fast: Document;
	let results: (readonly (string | null)[])[];
	try {
		fast = render(props);
		results = fastSpy.mock.results.map((result) => {
			if (!Array.isArray(result.value)) throw new Error("cache did not return per-line markup");
			return result.value;
		});
	} finally {
		fastSpy.mockRestore();
	}
	const oldSpy = spyOn(staticInlineMarkupCache, "get").mockImplementation((_block, _width, lines) =>
		lines.map(() => null),
	);
	let original: Document;
	try {
		original = render(props);
	} finally {
		oldSpy.mockRestore();
	}
	expect(shape(body(fast))).toEqual(shape(body(original)));
	return { fast, original, results: results.flat() };
}

const mixed = "中文 **mixedBold加粗** and *italic斜体* 与`inline.code`边界， English finish.";
const blockCases = [
	["paragraph mixed marks", mixed, 640],
	[
		"heading quote list task",
		`## 标题 **bold**\n\n> ${mixed}\n\n- ${mixed}\n- [x] 已完成 *task*\n- [ ] 待完成\n\n1. ordered **item**`,
		540,
	],
	["soft wrapping", `${mixed}\nsoft newline second line\n\n${mixed.repeat(6)}`, 190],
] as const;

describe("RenderMarkdown static spans versus the actual React fragment branch", () => {
	for (const [name, markdown, width] of blockCases) {
		for (const spacing of [0, 10, -5]) {
			test(`${name}, letter spacing ${spacing}%: complete parsed DOM is isomorphic`, () => {
				setTypography({ letterSpacingPercent: spacing });
				const { fast, results } = compare({ measured: measureMarkdown(markdown, width) });
				expect(results.some((value) => typeof value === "string")).toBe(true);
				expect(body(fast).querySelectorAll("[data-vlist-line-frags]").length).toBeGreaterThan(0);
				expect(body(fast).textContent).toContain(
					name === "heading quote list task" ? "标题" : "中文",
				);
				if (name === "soft wrapping") {
					expect(body(fast).querySelectorAll("[data-vlist-line]").length).toBeGreaterThan(6);
				}
			});
		}
	}

	test("copyable text keeps inter-fragment spaces and does not insert Chinese/code spaces", () => {
		const markdown = "See **bold** and `code` here. 中文`代码`末尾。";
		const { fast } = compare({ measured: measureMarkdown(markdown, 1600) });
		const line = body(fast).querySelector("[data-vlist-line]");
		expect(line?.textContent).toBe("See bold and code here. 中文代码末尾。");
		const wrapper = line?.querySelector("[data-vlist-line-frags]");
		if (!line || !wrapper) throw new Error("copyable line wrapper did not render");
		expect([...line.children]).toEqual([wrapper]);
		expect(wrapper?.getAttribute("style")).toContain("flex-shrink:0");
		expect(wrapper?.querySelectorAll("[data-vlist-frag-gap]").length).toBeGreaterThan(0);
	});

	test("malicious-looking literal is escaped, and raw source remains complete", () => {
		const literal = '<script>alert("x")</script><img src=x onerror=alert(1)> &lt; & \' "';
		const markdown = `Before \`${literal}\` after **safe**.`;
		const measured = measureMarkdown(markdown, 1600);
		const { fast } = compare({ measured });
		expect(body(fast).querySelector("script,img,[onclick],[onerror]")).toBeNull();
		expect(body(fast).textContent).toContain(literal);
		const source = render({ measured, showSource: true, sourceText: markdown });
		expect(source.querySelector("[data-vlist-markdown-source]")?.textContent).toBe(markdown);
	});

	test("sparse plain lines bypass serialization while preserving complete DOM text", () => {
		const markdown = "Sparse ordinary text, 中文正文 END";
		const spy = spyOn(staticInlineMarkupCache, "get");
		try {
			const document = render({ measured: measureMarkdown(markdown, 1600) });
			expect(spy).not.toHaveBeenCalled();
			expect(body(document).textContent).toBe(markdown);
			expect(body(document).querySelectorAll("[data-vlist-line-frags]")).toHaveLength(1);
		} finally {
			spy.mockRestore();
		}
	});

	test("eligible static lines do not construct fallback fragment React elements", () => {
		const originalGet = staticInlineMarkupCache.get.bind(staticInlineMarkupCache);
		let checked = 0;
		const spy = spyOn(staticInlineMarkupCache, "get").mockImplementation(
			(owner, width, lines, revision) => {
				const result = originalGet(owner, width, lines, revision);
				for (let index = 0; index < lines.length; index++) {
					const fragments = lines[index].fragments;
					if (fragments.length < 3 || result[index] == null) continue;
					checked++;
					// These are the component's freshly materialized arrays, not prepared data.
					Object.defineProperty(fragments, "map", {
						value: () => {
							throw new Error("Static line constructed fallback fragment elements");
						},
					});
				}
				return result;
			},
		);
		try {
			const document = render({ measured: measureMarkdown(mixed, 1600) });
			expect(checked).toBeGreaterThan(0);
			expect(body(document).textContent).toContain("mixedBold加粗");
		} finally {
			spy.mockRestore();
		}
	});

	test("a >256KiB single line falls back without losing its last character", () => {
		const content = `${"x".repeat(270_000)}END_OF_OVERSIZE_LINE`;
		const markdown = `prefix **${content}** tail`;
		const { fast, results } = compare({ measured: measureMarkdown(markdown, 4_000_000) });
		expect(results).toContain(null);
		expect(body(fast).textContent).toBe(`prefix ${content} tail`);
		expect(body(fast).querySelectorAll("[data-vlist-line-frags]")).toHaveLength(1);
	});

	test("links and inline math fall back as whole lines but keep actual visible content", async () => {
		const markdown =
			"See [link label](https://example.com/a?q=1&b=2) end.\n\nEquation $x^2$ end.\n\nplain **eligible** tail";
		const { ensureKatexLoaded } = await import("../katex-runtime");
		await ensureKatexLoaded(markdown);
		const { fast, results } = compare({ measured: measureMarkdown(markdown, 1600) });
		expect(results.filter((value) => value === null)).toHaveLength(2);
		expect(results.some((value) => typeof value === "string")).toBe(true);
		expect(body(fast).querySelector("a")?.getAttribute("href")).toBe(
			"https://example.com/a?q=1&b=2",
		);
		expect(body(fast).querySelector("a")?.textContent).toBe("link label");
		expect(body(fast).querySelector(".katex")).not.toBeNull();
		expect(body(fast).textContent).toContain("end.");
	});

	test("animated inline blocks never ask the static cache and still render real graphemes", () => {
		const props = {
			measured: measureMarkdown("Live **bold** 与`code` END", 640),
			animateStreaming: true,
			animKeyBase: "static-integration-animation",
			animScope: "static-integration-narrator",
		};
		const spy = spyOn(staticInlineMarkupCache, "get");
		try {
			const document = render(props);
			expect(spy).not.toHaveBeenCalled();
			expect(body(document).textContent).toBe("Live bold 与code END");
			expect(body(document).querySelector(".is-strong")).not.toBeNull();
			expect(body(document).querySelector("[data-vlist-line-frags]")).not.toBeNull();
		} finally {
			spy.mockRestore();
		}
	});

	test("table and fenced code bypass the inline cache while retaining their body", () => {
		const markdown =
			"| Column | Value |\n| --- | --- |\n| **cell** | 中文 |\n\n```text\ncode END_CODE\n```";
		const { fast, results } = compare({ measured: measureMarkdown(markdown, 640) });
		expect(results).toHaveLength(0);
		expect(body(fast).textContent).toContain("cell");
		expect(body(fast).textContent).toContain("END_CODE");
	});

	test("unknown display-math block bypasses static spans and keeps its real KaTeX body", async () => {
		const markdown = "```math\nE=mc^2\n```";
		const { ensureKatexLoaded } = await import("../katex-runtime");
		await ensureKatexLoaded(markdown);
		const measured = measureMarkdown(markdown, 640);
		expect(measured.blocks[0]?.kind).toBe("unknown");
		const { fast, results } = compare({ measured });
		expect(results).toHaveLength(0);
		expect(body(fast).querySelector('[data-vlist-unknown="katex"]')).not.toBeNull();
		expect(body(fast).querySelector(".katex")).not.toBeNull();
		expect(body(fast).textContent).toContain("E=mc^2");
	});

	test("mounted memoized body refreshes static CSS for a new typography revision", async () => {
		const { window } = parseHTML("<!doctype html><html><body></body></html>");
		const saved = new Map<string, PropertyDescriptor | undefined>();
		const media = () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		});
		const values = {
			window,
			document: window.document,
			navigator: window.navigator,
			HTMLElement: window.HTMLElement,
			Element: window.Element,
			Node: window.Node,
			IS_REACT_ACT_ENVIRONMENT: true,
			matchMedia: media,
			requestAnimationFrame: () => 1,
			cancelAnimationFrame: () => {},
		};
		// No shared HTMLElement.prototype geometry stubs: this ordinary-inline mount must not measure DOM.
		let root: Root | undefined;
		const spy = spyOn(staticInlineMarkupCache, "get");
		try {
			for (const [key, value] of Object.entries(values)) {
				saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
				Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
			}
			Object.defineProperty(window, "matchMedia", { configurable: true, value: media });
			const container = window.document.body.appendChild(window.document.createElement("div"));
			root = createRoot(container);
			const measured = measureMarkdown("Mounted **mixed** 中文 END", 640);
			const paint = () =>
				root?.render(
					<MantineProvider>
						<RenderMarkdown measured={measured} />
					</MantineProvider>,
				);
			await act(async () => paint());
			expect(container.querySelector(".vlist-frag")?.getAttribute("style")).not.toContain(
				"letter-spacing",
			);
			const firstRevision = getTypographyRevision();
			setTypography({ letterSpacingPercent: 10 });
			await act(async () => paint());
			expect(getTypographyRevision()).toBeGreaterThan(firstRevision);
			expect(container.querySelector(".vlist-frag")?.getAttribute("style")).toContain(
				"letter-spacing:1.4px",
			);
			expect(spy.mock.calls.at(-1)?.[3]).toBe(getTypographyRevision());
			expect(container.querySelector("[data-md-body]")?.textContent).toBe("Mounted mixed 中文 END");
		} finally {
			if (root) await act(async () => root?.unmount());
			spy.mockRestore();
			for (const [key, descriptor] of saved) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	});
});
