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
import type { ShikiModule } from "@frontend/lib/shiki-loader";
import { MantineProvider } from "@mantine/core";
import * as typography from "@shared/pretext-layout/typography";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RenderLodCtx } from "../../lod/RenderLodCtx";
import { installCanvasStub } from "../measure/test-canvas-stub";
import type { MeasuredElement, PreparedInlineBlock } from "../prepared-block";
import type { RenderMarkdownProps } from "./RenderMarkdown";

let RenderMarkdown: typeof import("./RenderMarkdown").RenderMarkdown;
let sameMarkdownRenderInputs: typeof import("./RenderMarkdown").sameMarkdownRenderInputs;
let measureMarkdown: typeof import("../measure/measure-markdown").measureMarkdown;
type Inputs = Parameters<typeof sameMarkdownRenderInputs>[0];
let disposeCanvas: () => void;
let root: Root;
let container: HTMLElement;
const globals = new Map<string, PropertyDescriptor | undefined>();
const mediaListeners = new Map<string, Set<(event: { matches: boolean }) => void>>();
const mediaMatches = new Map<string, boolean>();
const rafs = new Map<number, FrameRequestCallback>();
let rafId = 0;
const observers = new Set<TestResizeObserver>();

class TestResizeObserver {
	node: Element | undefined;
	constructor(readonly callback: () => void) {
		observers.add(this);
	}
	observe(node: Element) {
		this.node = node;
	}
	disconnect() {
		observers.delete(this);
	}
}

beforeAll(async () => {
	disposeCanvas = installCanvasStub();
	// Preparation must load after the canvas seam. No application module mocks.
	({ measureMarkdown } = await import("../measure/measure-markdown"));
	({ RenderMarkdown, sameMarkdownRenderInputs } = await import("./RenderMarkdown"));
});
afterAll(() => disposeCanvas());
beforeEach(() => {
	typography.resetTypographyForTest();
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const matchMedia = (query: string) => {
		let listeners = mediaListeners.get(query);
		if (!listeners) {
			listeners = new Set();
			mediaListeners.set(query, listeners);
		}
		return {
			media: query,
			matches: mediaMatches.get(query) ?? false,
			addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) =>
				listeners.add(listener),
			removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) =>
				listeners.delete(listener),
			addListener() {},
			removeListener() {},
		};
	};
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
		matchMedia,
		ResizeObserver: TestResizeObserver,
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			rafs.set(++rafId, callback);
			return rafId;
		},
		cancelAnimationFrame: (id: number) => rafs.delete(id),
	};
	for (const [key, value] of Object.entries(values)) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});
afterEach(async () => {
	try {
		await act(async () => root.unmount());
	} finally {
		container.remove();
		typography.resetTypographyForTest();
		for (const [key, descriptor] of globals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		globals.clear();
		mediaListeners.clear();
		mediaMatches.clear();
		rafs.clear();
		observers.clear();
	}
});

const noop = () => {};
function inputs(): Required<Inputs> {
	return {
		measured: measureMarkdown("memoized body", 640),
		showSource: false,
		sourceText: "memoized body",
		onUnknownHeight: noop,
		animateStreaming: false,
		sealOnMount: false,
		animKeyBase: "same-body",
		animScope: "memo-test-narrator",
		typographyRevision: typography.getTypographyRevision(),
	};
}
function changedInputs(a: Inputs): Required<Inputs> {
	// Exhaustive at compile time: a newly added prop needs its own invalidation case.
	return {
		measured: { ...a.measured, height: a.measured.height + 1 },
		showSource: true,
		sourceText: "updated raw source",
		onUnknownHeight: () => {},
		animateStreaming: true,
		sealOnMount: true,
		animKeyBase: "different-body-key",
		animScope: "different-narrator-scope",
		typographyRevision: a.typographyRevision + 1,
	};
}
const inputKeys = [
	"measured",
	"showSource",
	"sourceText",
	"onUnknownHeight",
	"animateStreaming",
	"sealOnMount",
	"animKeyBase",
	"animScope",
	"typographyRevision",
] as const satisfies readonly (keyof Inputs)[];
const measuredKeys = ["height", "blocks", "frame", "contentWidth", "usedWidth"] as const;

describe("sameMarkdownRenderInputs", () => {
	test("hits for fresh props/measured wrappers with identical blocks and frame", () => {
		const a = inputs();
		expect(sameMarkdownRenderInputs(a, { ...a, measured: { ...a.measured } })).toBe(true);
		expect(sameMarkdownRenderInputs(a, a)).toBe(true);
	});
	for (const key of inputKeys) {
		test(`invalidates the current prop: ${key}`, () => {
			const a = inputs();
			const b = { ...a, [key]: changedInputs(a)[key] };
			expect(sameMarkdownRenderInputs(a, b)).toBe(false);
			expect(sameMarkdownRenderInputs(b, a)).toBe(false);
		});
	}
	for (const key of measuredKeys) {
		test(`invalidates the measured own field: ${key}`, () => {
			const a = inputs();
			const changed = {
				height: a.measured.height + 1,
				blocks: [...a.measured.blocks],
				frame: { ...a.measured.frame },
				contentWidth: a.measured.contentWidth + 1,
				usedWidth: a.measured.usedWidth + 1,
			} satisfies MeasuredElement;
			const b = { ...a, measured: { ...a.measured, [key]: changed[key] } };
			expect(sameMarkdownRenderInputs(a, b)).toBe(false);
			expect(sameMarkdownRenderInputs(b, a)).toBe(false);
		});
	}
	test("uses Object.is, including NaN and signed zero, for shallow scalar fields", () => {
		const a = inputs();
		const nan = { ...a, measured: { ...a.measured, usedWidth: Number.NaN } };
		expect(sameMarkdownRenderInputs(nan, { ...nan, measured: { ...nan.measured } })).toBe(true);
		const zero = { ...a, measured: { ...a.measured, usedWidth: 0 } };
		expect(
			sameMarkdownRenderInputs(zero, { ...zero, measured: { ...zero.measured, usedWidth: -0 } }),
		).toBe(false);
		expect(
			sameMarkdownRenderInputs({ ...a, typographyRevision: 0 }, { ...a, typographyRevision: -0 }),
		).toBe(false);
	});
	for (const target of ["props", "measured"] as const) {
		test(`invalidates future ${target} fields without a maintained whitelist`, () => {
			const a = inputs();
			const value = { revision: 1 };
			const extend = (extra: object): Inputs =>
				target === "props" ? { ...a, ...extra } : { ...a, measured: { ...a.measured, ...extra } };
			const b = extend({ futureInput: value });
			expect(sameMarkdownRenderInputs(b, extend({ futureInput: value }))).toBe(true);
			expect(sameMarkdownRenderInputs(b, extend({ futureInput: { revision: 1 } }))).toBe(false);
			expect(sameMarkdownRenderInputs(b, extend({ futureInput: 2 }))).toBe(false);
		});
		test(`detects added/deleted undefined own ${target} fields and inherited replacements`, () => {
			const a = inputs();
			const b =
				target === "props"
					? { ...a, futureInput: undefined }
					: { ...a, measured: { ...a.measured, futureInput: undefined } };
			expect(sameMarkdownRenderInputs(a, b)).toBe(false);
			expect(sameMarkdownRenderInputs(b, a)).toBe(false);
			const own = target === "props" ? { ...a } : { ...a.measured };
			const key = target === "props" ? "sourceText" : "usedWidth";
			const value = Reflect.get(own, key);
			Reflect.deleteProperty(own, key);
			Object.setPrototypeOf(own, { [key]: value });
			Object.assign(own, { replacementKey: undefined });
			const inherited =
				target === "props" ? (own as Inputs) : { ...a, measured: own as MeasuredElement };
			expect(sameMarkdownRenderInputs(a, inherited)).toBe(false);
			expect(sameMarkdownRenderInputs(inherited, a)).toBe(false);
		});
	}
	test("never reads, enumerates, hashes or deep-compares the prepared body/frame", () => {
		const a = inputs();
		const forbidden = () => {
			throw new Error("Comparator walked prepared body/frame");
		};
		const trap = { get: forbidden, ownKeys: forbidden, getOwnPropertyDescriptor: forbidden };
		const blocks = new Proxy(a.measured.blocks, trap);
		const frame = new Proxy(a.measured.frame, trap);
		const guarded = {
			...a,
			sourceText: `start${"large正文".repeat(100_000)}end`,
			measured: { ...a.measured, blocks, frame },
		};
		expect(
			sameMarkdownRenderInputs(guarded, { ...guarded, measured: { ...guarded.measured } }),
		).toBe(true);
		// Equal length/prefix/suffix do not make a changed interior source equal.
		const sourceText = `${guarded.sourceText.slice(0, 17_459)}!${guarded.sourceText.slice(17_460)}`;
		expect(sameMarkdownRenderInputs(guarded, { ...guarded, sourceText })).toBe(false);
		const otherBlocks = new Proxy(a.measured.blocks, trap);
		expect(
			sameMarkdownRenderInputs(guarded, {
				...guarded,
				measured: { ...guarded.measured, blocks: otherBlocks },
			}),
		).toBe(false);
		const otherFrame = new Proxy(a.measured.frame, trap);
		expect(
			sameMarkdownRenderInputs(guarded, {
				...guarded,
				measured: { ...guarded.measured, frame: otherFrame },
			}),
		).toBe(false);
	});
});

async function render(props: RenderMarkdownProps, interactive = true) {
	await act(async () =>
		root.render(
			<MantineProvider>
				<RenderLodCtx.Provider value={{ lod: 5, interactive }}>
					<RenderMarkdown key="fixed-react-key" {...props} />
				</RenderLodCtx.Provider>
			</MantineProvider>,
		),
	);
}
function node(selector: string): HTMLElement {
	const result = container.querySelector<HTMLElement>(selector);
	if (!result) throw new Error(`Missing visible markdown node: ${selector}`);
	return result;
}
function styledText(text: string): HTMLElement {
	const result = Array.from(container.querySelectorAll<HTMLElement>("span, a")).find(
		(element) => element.textContent === text && element.style.font,
	);
	if (!result) throw new Error(`Missing styled visible text: ${text}`);
	return result;
}
const codeMarkdown = "Intro paragraph\n\n```\nconst value = 1;\nconsole.log(value);\n```";

describe("the mounted real RenderMarkdown memo", () => {
	test("updates text and measured geometry without replacing the same-key host", async () => {
		const before = measureMarkdown("original body", 640);
		await render({ measured: before });
		const host = node("[data-md-body]");
		expect(container.textContent).toContain("original body");
		const text = "updated body with more content ".repeat(8);
		const after = measureMarkdown(text, 180);
		await render({ measured: after });
		expect(node("[data-md-body]")).toBe(host);
		expect(container.textContent).toContain("updated body");
		expect(container.textContent).not.toContain("original body");
		expect(host.style.width).toBe("180px");
		expect(host.style.height).toBe(`${after.frame.contentHeight}px`);
		expect(after.height).toBeGreaterThan(before.height);
	});
	test("toggles source/rendered form and updates sourceText at the same React key", async () => {
		const sourceText = "# Visible title\n\n**bold body**";
		const measured = measureMarkdown(sourceText, 640);
		await render({ measured, sourceText, showSource: false });
		expect(container.textContent).not.toContain("**bold body**");
		await render({ measured: { ...measured }, sourceText, showSource: true });
		const source = node("[data-vlist-markdown-source]");
		expect(source.textContent).toBe(sourceText);
		expect(source.style.height).toBe(`${measured.frame.contentHeight}px`);
		await render({ measured, sourceText: "## replacement source", showSource: true });
		expect(node("[data-vlist-markdown-source]")).toBe(source);
		expect(source.textContent).toBe("## replacement source");
		await render({ measured, sourceText, showSource: false });
		expect(container.querySelector("[data-vlist-markdown-source]")).toBeNull();
		expect(container.textContent).toContain("Visible title");
		expect(container.textContent).not.toContain("replacement source");
	});
	test("reuses derived inline layout and preserves child hover state across parent wrappers", async () => {
		const measured = measureMarkdown(codeMarkdown, 640);
		const original = measured.blocks[0];
		if (original?.kind !== "inline") throw new Error("Expected an inline paragraph fixture");
		let flowReads = 0;
		const tracked: PreparedInlineBlock = {
			...original,
			get flow() {
				flowReads++;
				return original.flow;
			},
		};
		const stable = { ...measured, blocks: [tracked, ...measured.blocks.slice(1)] };
		await render({ measured: stable });
		const host = node("[data-md-body]");
		const panel = node("[tabindex='0']");
		const overlay = node("[data-vlist-code-copy]");
		const reads = flowReads;
		expect(reads).toBeGreaterThan(0);
		expect(overlay.style.visibility).toBe("hidden");
		await act(async () => panel.dispatchEvent(new window.Event("mouseover", { bubbles: true })));
		expect(overlay.style.visibility).toBe("visible");
		await render({ measured: { ...stable } });
		expect(node("[data-md-body]")).toBe(host);
		expect(node("[tabindex='0']")).toBe(panel);
		expect(node("[data-vlist-code-copy]")).toBe(overlay);
		expect(overlay.style.visibility).toBe("visible");
		expect(flowReads).toBe(reads);
		// A legitimate outer prop change rerenders the body without clearing child useMemo/state.
		await render({ measured: { ...stable }, onUnknownHeight: noop });
		expect(flowReads).toBe(reads);
		expect(overlay.style.visibility).toBe("visible");
	});
	test("lets a real child context update pass through equal markdown props", async () => {
		const measured = measureMarkdown(codeMarkdown, 640);
		await render({ measured });
		const host = node("[data-md-body]");
		expect(container.querySelector("[data-vlist-code-copy]")).not.toBeNull();
		await render({ measured: { ...measured } }, false);
		expect(node("[data-md-body]")).toBe(host);
		expect(container.querySelector("[data-vlist-code-copy]")).toBeNull();
		await render({ measured: { ...measured } }, true);
		expect(container.querySelector("[data-vlist-code-copy]")).not.toBeNull();
	});
	test("lets asynchronous child media state propagate without another parent render", async () => {
		await render({ measured: measureMarkdown(codeMarkdown, 640) });
		const host = node("[data-md-body]");
		const overlay = node("[data-vlist-code-copy]");
		expect(overlay.style.visibility).toBe("hidden");
		const entry = Array.from(mediaListeners.entries()).find(([query]) =>
			query.includes("hover: none"),
		);
		if (!entry) throw new Error("Real child did not subscribe to its pointer media query");
		await act(async () => {
			await Promise.resolve();
			mediaMatches.set(entry[0], true);
			for (const listener of entry[1]) listener({ matches: true });
		});
		expect(node("[data-md-body]")).toBe(host);
		expect(node("[data-vlist-code-copy]")).toBe(overlay);
		expect(overlay.style.visibility).toBe("visible");
		expect(overlay.hasAttribute("data-vlist-code-copy-touch")).toBe(true);
	});
	test("paints asynchronously resolved Shiki tokens through the real child external store", async () => {
		const loader = await import("@frontend/lib/shiki-loader");
		const cache = await import("@frontend/lib/shiki-token-cache");
		cache.clearShikiTokenCache();
		type HighlightResult = Awaited<ReturnType<ShikiModule["codeToTokens"]>>;
		let finish: ((value: HighlightResult) => void) | undefined;
		const pending = new Promise<HighlightResult>((resolve) => {
			finish = resolve;
		});
		let highlights = 0;
		const cachedLoader = spyOn(loader, "getCachedShiki").mockReturnValue({
			bundledLanguages: { "memo-test": true },
			codeToHtml: async () => "",
			codeToTokens: () => {
				highlights++;
				return pending;
			},
		});
		try {
			const code = "const asyncMemoResult = 42;";
			const measured = measureMarkdown(`Intro\n\n\`\`\`memo-test\n${code}\n\`\`\``, 640);
			await render({ measured });
			const host = node("[data-md-body]");
			const line = node("[data-vlist-code-line]");
			expect(line.textContent).toBe(code);
			expect(line.querySelector("span[style*='color']")).toBeNull();
			expect(highlights).toBe(1);
			await render({ measured: { ...measured } });
			await act(async () => {
				if (!finish) throw new Error("Missing deferred highlighter resolver");
				finish({ tokens: [[{ content: code, color: "#123456", offset: 0 }]] });
				await pending;
			});
			expect(node("[data-md-body]")).toBe(host);
			expect(node("[data-vlist-code-line]")).toBe(line);
			const colored = line.querySelector<HTMLElement>("span[style*='color']");
			expect(colored?.textContent).toBe(code);
			expect(colored?.style.color).toBe("#123456");
			expect(highlights).toBe(1);
		} finally {
			cachedLoader.mockRestore();
			cache.clearShikiTokenCache();
		}
	});
	test("reads typography only on the parent's render, retaining font/spacing and measurement timing", async () => {
		const subscription = spyOn(typography, "onTypographyChange");
		try {
			const measured = measureMarkdown(codeMarkdown, 640);
			await render({ measured });
			const host = node("[data-md-body]");
			const originalCodeFont = node("[data-vlist-code-line]").style.font;
			const originalProseFont = styledText("Intro paragraph").style.font;
			const originalHeight = host.style.height;
			await act(async () => {
				typography.setTypography({ fontScalePercent: 140, letterSpacingPercent: 10 });
			});
			// The layout owner has not remeasured/repainted yet: no independent subscription.
			expect(node("[data-vlist-code-line]").style.font).toBe(originalCodeFont);
			expect(host.style.height).toBe(originalHeight);
			await render({ measured: { ...measured } });
			// Same measured fields still invalidate the inner memo via the mandatory revision.
			expect(node("[data-vlist-code-line]").style.font).not.toBe(originalCodeFont);
			expect(Number.parseFloat(styledText("Intro paragraph").style.letterSpacing)).toBeGreaterThan(
				0,
			);
			const remeasured = measureMarkdown(codeMarkdown, 640);
			await render({ measured: remeasured });
			expect(styledText("Intro paragraph").style.font).not.toBe(originalProseFont);
			expect(host.style.height).toBe(`${remeasured.frame.contentHeight}px`);
			const font = styledText("Intro paragraph").style.font;
			const spacing = styledText("Intro paragraph").style.letterSpacing;
			await render({ measured: { ...remeasured } });
			expect(node("[data-md-body]")).toBe(host);
			expect(styledText("Intro paragraph").style.font).toBe(font);
			expect(styledText("Intro paragraph").style.letterSpacing).toBe(spacing);
			expect(subscription).not.toHaveBeenCalled();
			expect(observers.size).toBe(0);
			expect(rafs.size).toBe(0);
		} finally {
			subscription.mockRestore();
		}
	});
	test("keeps the unknown-height observer across equal wrappers and replaces changed callbacks", async () => {
		const measured: MeasuredElement = {
			height: 50,
			contentWidth: 640,
			usedWidth: 640,
			blocks: [
				{
					kind: "unknown",
					tag: "image-unknown",
					placeholderHeight: 50,
					marginTop: 0,
					contentLeft: 0,
					quoteRailLefts: [],
					markerText: null,
					markerLeft: null,
					markerClassName: null,
				},
			],
			frame: {
				contentHeight: 50,
				usedWidth: 640,
				blocks: [{ index: 0, top: 0, height: 50, usedWidth: 640 }],
			},
		};
		const firstReports: number[] = [];
		const secondReports: number[] = [];
		const first = (height: number) => firstReports.push(height);
		const second = (height: number) => secondReports.push(height);
		await render({ measured, onUnknownHeight: first });
		const host = node("[data-md-body]");
		// A per-node seam, never a shared HTMLElement prototype mutation.
		let actualHeight = 90;
		Object.defineProperty(host, "getBoundingClientRect", {
			configurable: true,
			value: () => ({ height: actualHeight }),
		});
		expect(observers.size).toBe(1);
		const observer = Array.from(observers)[0];
		expect(observer?.node).toBe(host);
		await act(async () => {
			for (const callback of rafs.values()) callback(0);
			rafs.clear();
		});
		expect(firstReports).toEqual([90]);
		await render({ measured: { ...measured }, onUnknownHeight: first });
		expect(Array.from(observers)[0]).toBe(observer);
		expect(rafs.size).toBe(0);
		actualHeight = 100;
		await act(async () => observer?.callback());
		expect(firstReports).toEqual([90, 100]);
		await render({ measured: { ...measured }, onUnknownHeight: second });
		expect(node("[data-md-body]")).toBe(host);
		expect(observers.size).toBe(1);
		expect(Array.from(observers)[0]).not.toBe(observer);
		await act(async () => {
			for (const callback of rafs.values()) callback(0);
			rafs.clear();
		});
		expect(firstReports).toEqual([90, 100]);
		expect(secondReports).toEqual([100]);
	});
	test("reflows visible lines when only width/frame change and prepared blocks are reused", async () => {
		const text = "Width-sensitive visible prose repeated for wrapping. ".repeat(6);
		const wide = measureMarkdown(text, 640);
		await render({ measured: wide });
		const host = node("[data-md-body]");
		const wideLines = container.querySelectorAll("[data-vlist-line]").length;
		const narrow = measureMarkdown(text, 160, { preparedBlocks: wide.blocks });
		expect(narrow.blocks).toBe(wide.blocks);
		await render({ measured: narrow });
		expect(node("[data-md-body]")).toBe(host);
		expect(host.style.width).toBe("160px");
		expect(host.style.height).toBe(`${narrow.frame.contentHeight}px`);
		expect(container.querySelectorAll("[data-vlist-line]").length).toBeGreaterThan(wideLines);
		expect(container.textContent).toContain("Width-sensitive");
	});
});
