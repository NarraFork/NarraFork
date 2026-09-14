import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { createDiffDocument, type DiffDocument } from "@shared/pretext-layout/diff-core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RenderLodCtx } from "../lod/RenderLodCtx";
import type { ContentViewportLayout } from "../scroll/AutoFollowScroll";
import { ContentViewer, handleRegistry } from "./ContentViewer";

const { installCanvasStub } = await import("../vlist/measure/test-canvas-stub");
const { VListViewBody } = await import("../vlist/vlist-content-view-body");
type VListViewTarget = import("../vlist/vlist-content-view-target").VListViewTarget;
const restoreCanvas = installCanvasStub();
afterAll(restoreCanvas);
const DIFF_DOCUMENT = createDiffDocument({ oldText: "before", newText: "after" });

let root: Root;
let container: HTMLDivElement;
let restore: () => void;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const values: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		IS_REACT_ACT_ENVIRONMENT: true,
		getComputedStyle: () => ({ overflowY: "visible" }),
		matchMedia: () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		}),
		requestAnimationFrame: (fn: FrameRequestCallback) => {
			frames.set(++nextFrame, fn);
			return nextFrame;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
		ResizeObserver: class {
			observe() {}
			disconnect() {}
		},
	};
	const previous = new Map(
		Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	for (const [key, value] of Object.entries(values))
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	Object.defineProperties(window.HTMLElement.prototype, {
		scrollTop: { configurable: true, writable: true, value: 0 },
		clientHeight: {
			configurable: true,
			get() {
				return 80;
			},
		},
		clientWidth: {
			configurable: true,
			get() {
				return 600;
			},
		},
		scrollHeight: {
			configurable: true,
			get() {
				return 2_000;
			},
		},
	});
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	frames.clear();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	expect(frames.size).toBe(0);
	container.remove();
	restore();
});
async function render(
	content: string,
	opts: {
		live?: boolean;
		markdown?: boolean;
		language?: string;
		bodyId?: string;
		layout?: ContentViewportLayout;
		fullscreenLayout?: ContentViewportLayout;
		diffDocument?: DiffDocument;
		interactive?: boolean;
	} = {},
) {
	await act(async () =>
		root.render(
			<MantineProvider>
				<RenderLodCtx.Provider value={{ lod: 5, interactive: opts.interactive === true }}>
					<ContentViewer
						bodyId={opts.bodyId ?? "task:output.main"}
						layout={opts.layout}
						fullscreenLayout={opts.fullscreenLayout}
						diffDocument={opts.diffDocument}
						content={content}
						live={opts.live}
						markdown={opts.markdown}
						language={opts.language}
						style={{ maxHeight: 80 }}
					/>
				</RenderLodCtx.Provider>
			</MantineProvider>,
		),
	);
}
function viewport(): HTMLElement {
	const node = container.querySelector<HTMLElement>("[data-content-scrollport]");
	if (!node) throw new Error("real viewport missing");
	return node;
}

async function openFullscreen() {
	const handle = [...handleRegistry.values()].at(-1);
	if (!handle) throw new Error("content viewer handle missing");
	await act(async () => handle.openFullscreen());
}

describe("ContentViewer optional declared layouts", () => {
	it("forwards inline layout without deriving it from the CSS maxHeight", async () => {
		await render("content", { diffDocument: DIFF_DOCUMENT, layout: { width: 320, height: 180 } });
		const node = viewport();
		expect(node.getAttribute("data-content-geometry")).toBe("layout");
		expect(node.style.width).toBe("320px");
		expect(node.style.height).toBe("180px");
		expect(node.style.maxHeight).toBe("180px");
	});

	it("keeps CSS-only callers on the explicitly DOM-owned path", async () => {
		await render("content");
		expect(viewport().getAttribute("data-content-geometry")).toBe("dom");
		expect(viewport().style.width).toBeFalsy();
	});

	it("uses an independent fullscreen layout", async () => {
		await render("content", {
			diffDocument: DIFF_DOCUMENT,
			interactive: true,
			layout: { width: 320, height: 180 },
			fullscreenLayout: { width: 720, height: 420 },
		});
		const inline = viewport();
		await openFullscreen();
		const fullscreen = [
			...document.querySelectorAll<HTMLElement>("[data-content-scrollport]"),
		].find((node) => node !== inline);
		if (!fullscreen) throw new Error("fullscreen viewport missing");
		expect(inline.style.width).toBe("320px");
		expect(fullscreen.style.width).toBe("720px");
		expect(fullscreen.style.height).toBe("420px");
		expect(fullscreen.getAttribute("data-content-geometry")).toBe("layout");
	});

	it("never reuses inline dimensions when fullscreenLayout is absent", async () => {
		await render("content", {
			diffDocument: DIFF_DOCUMENT,
			interactive: true,
			layout: { width: 320, height: 180 },
		});
		const inline = viewport();
		await openFullscreen();
		const fullscreen = [
			...document.querySelectorAll<HTMLElement>("[data-content-scrollport]"),
		].find((node) => node !== inline);
		if (!fullscreen) throw new Error("fullscreen viewport missing");
		expect(inline.getAttribute("data-content-geometry")).toBe("layout");
		expect(fullscreen.getAttribute("data-content-geometry")).toBe("dom");
		expect(fullscreen.style.height).toBe("100%");
	});
});

describe("plain content keeps DOM geometry and follow behavior", () => {
	for (const markdown of [false, true]) {
		it(`${markdown ? "markdown" : "code"} ignores inline/fullscreen layout and can still follow`, async () => {
			await render("content", {
				markdown,
				live: true,
				interactive: true,
				layout: { width: 320, height: 180 },
				fullscreenLayout: { width: 720, height: 420 },
			});
			const inline = viewport();
			expect(inline.getAttribute("data-content-geometry")).toBe("dom");
			expect(inline.scrollTop).toBe(2_000 - 80);
			expect(inline.getAttribute("data-following")).toBe("true");
			await openFullscreen();
			const fullscreen = [
				...document.querySelectorAll<HTMLElement>("[data-content-scrollport]"),
			].find((node) => node !== inline);
			if (!fullscreen) throw new Error("fullscreen viewport missing");
			expect(fullscreen.getAttribute("data-content-geometry")).toBe("dom");
			expect(fullscreen.scrollTop).toBe(2_000 - 80);
		});
	}
});

describe("VListViewBody plain content keeps DOM following", () => {
	for (const kind of ["code", "markdown"] as const) {
		it(`${kind} ignores declared Diff-only dimensions without losing follow`, async () => {
			const target: VListViewTarget = {
				id: "plain:output.main",
				slot: "output.main",
				owner: { specKey: "plain" },
				kind,
				text: "body",
				model: {
					kind: "capped",
					id: "plain:output.main",
					source: "output.main",
					cap: "code",
					format: kind,
					live: true,
					followTarget: { kind: "end" },
					text: "body",
				},
			};
			await act(async () =>
				root.render(
					<MantineProvider>
						<VListViewBody
							target={target}
							text={target.text}
							wordWrap
							showSource={false}
							layout={{ width: 320, height: 180 }}
						/>
					</MantineProvider>,
				),
			);
			expect(viewport().getAttribute("data-content-geometry")).toBe("dom");
			expect(viewport().getAttribute("data-following")).toBe("true");
			expect(viewport().scrollTop).toBe(2_000 - 80);
		});
	}
});

describe("ContentViewer has one permanent scrollport", () => {
	it("keeps its node from empty live output through completion", async () => {
		await render("", { live: true });
		const node = viewport();
		await render("first\nsecond", { live: true });
		expect(viewport()).toBe(node);
		await render("complete output", { live: false });
		expect(viewport()).toBe(node);
		expect(node.textContent).toContain("complete output");
	});
	it("keeps the scrollport when the painter changes between code and markdown", async () => {
		await render("# heading");
		const node = viewport();
		await render("# heading", { markdown: true });
		expect(viewport()).toBe(node);
		expect(node.querySelector("h1")).not.toBeNull();
	});
	it("does not depend on an asynchronously mounted highlighter forwarding a ref", async () => {
		await render("const value = 1;", { live: true });
		const node = viewport();
		await render("const value = 2;", { live: true, language: "typescript" });
		expect(viewport()).toBe(node);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(viewport()).toBe(node);
		expect(node.textContent).toContain("const value = 2;");
	});
	it("opens static history at the head and resets only for a different source id", async () => {
		await render("history\n".repeat(50));
		const node = viewport();
		expect(node.scrollTop).toBe(0);
		expect(node.getAttribute("data-following")).toBe("false");
		await render("other", { bodyId: "other-task:output.main" });
		expect(viewport()).not.toBe(node);
	});
});
