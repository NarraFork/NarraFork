import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { textDocumentStore } from "@frontend/lib/text-document-store";
import type { TextDocumentRef } from "@shared/pretext-layout/text-document";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

let pendingHighlight = false;

/** The real Worker has separate token/layout tests; here fake only its exact viewport result. */
mock.module("@frontend/hooks/useTextDocumentView", () => ({
	useTextDocumentView: (
		ref: TextDocumentRef,
		options: { top: number; height: number; width: number; left: number; wrap: boolean },
	) => {
		const text = textDocumentStore.peekRange(ref.id, 0, ref.length) ?? "";
		const lineChars = options.wrap ? 20 : 100;
		const lines = Math.ceil(text.length / lineChars);
		const first = Math.max(0, Math.floor(options.top / 20) - 1);
		const count = Math.ceil(options.height / 20) + 2;
		const horizontal = options.wrap ? 0 : Math.min(80, Math.floor(options.left / 10));
		return {
			ready: true,
			highlightReady: !pendingHighlight,
			revision: ref.revision,
			contentHeight: lines * 20,
			contentWidth: options.wrap ? options.width : 1000,
			error: undefined,
			retry() {},
			rows: Array.from({ length: Math.min(count, Math.max(0, lines - first)) }, (_, n) => {
				const index = first + n;
				const start = index * lineChars + horizontal;
				const end = Math.min(text.length, start + (options.wrap ? 20 : 24));
				return {
					index,
					start,
					end,
					top: index * 20,
					height: 20,
					width: lineChars * 10,
					left: horizontal * 10,
					text: text.slice(start, end),
					points: [
						{ offset: start, x: horizontal * 10 },
						...Array.from(
							new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
								text.slice(start, end),
							),
							(segment, glyph) => ({
								offset: start + segment.index + segment.segment.length,
								x: (horizontal + glyph + 1) * 10,
							}),
						),
					],
					tokens: pendingHighlight ? [] : [{ start, end, color: "#abc" }],
				};
			}),
			locateOffset: async (offset: number) => ({
				index: Math.floor(offset / lineChars),
				top: Math.floor(offset / lineChars) * 20,
				left: (offset % lineChars) * 10,
			}),
			positionAtOffset: (offset: number) => ({
				index: Math.floor(offset / lineChars),
				top: Math.floor(offset / lineChars) * 20,
				left: (offset % lineChars) * 10,
			}),
			offsetAtPosition: (x: number, y: number) =>
				Math.max(0, Math.min(ref.length, Math.floor(y / 20) * lineChars + Math.round(x / 10))),
		};
	},
}));
const { MantineProvider } = await import("@mantine/core");
const { AutoFollowScroll } = await import("../scroll/AutoFollowScroll");
const { DocumentCodeBody } = await import("./DocumentCodeBody");

let root: Root;
let container: HTMLDivElement;
let restore: () => void;
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
const copied: string[] = [];
beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const values: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: {
			...window.navigator,
			clipboard: {
				writeText: async (text: string) => {
					copied.push(text);
				},
			},
		},
		ClipboardItem: undefined,
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
			frames.set(++frameId, fn);
			return frameId;
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
	const proto = window.HTMLElement.prototype;
	const geometry = new Map(
		[
			"scrollTop",
			"scrollLeft",
			"clientHeight",
			"clientWidth",
			"scrollHeight",
			"scrollWidth",
			"getBoundingClientRect",
		].map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)]),
	);
	Object.defineProperties(proto, {
		scrollTop: { configurable: true, writable: true, value: 0 },
		scrollLeft: { configurable: true, writable: true, value: 0 },
		clientHeight: {
			configurable: true,
			get() {
				throw new Error("Forbidden clientHeight");
			},
		},
		clientWidth: {
			configurable: true,
			get() {
				throw new Error("Forbidden clientWidth");
			},
		},
		scrollHeight: {
			configurable: true,
			get() {
				throw new Error("Forbidden scrollHeight");
			},
		},
		scrollWidth: {
			configurable: true,
			get() {
				throw new Error("Forbidden scrollWidth");
			},
		},
		getBoundingClientRect: {
			configurable: true,
			value() {
				return { top: 0, left: 0, width: 200, height: 80, right: 200, bottom: 80 };
			},
		},
	});
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		for (const [key, descriptor] of geometry) {
			if (descriptor) Object.defineProperty(proto, key, descriptor);
			else Reflect.deleteProperty(proto, key);
		}
	};
	frames.clear();
	pendingHighlight = false;
	copied.length = 0;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	frames.clear();
	container.remove();
	restore();
});

async function flushFrames(count = 3) {
	for (let n = 0; n < count; n++)
		await act(async () => {
			const current = [...frames.values()];
			frames.clear();
			for (const callback of current) callback(performance.now());
		});
}
function body(pane = "inline"): HTMLDivElement {
	const element = container.querySelector<HTMLDivElement>(`[data-document-pane="${pane}"]`);
	if (!element) throw new Error("body missing");
	return element;
}
function viewport(pane = "inline"): HTMLElement {
	const element = body(pane).closest<HTMLElement>("[data-content-scrollport]");
	if (!element) throw new Error("viewport missing");
	return element;
}
async function key(element: HTMLElement, key: string, extra: Record<string, unknown> = {}) {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key, ...extra });
	await act(async () => element.dispatchEvent(event));
	return event;
}
async function pointer(type: string, x: number, y: number) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(event, { pointerType: "mouse", pointerId: 1, button: 0, clientX: x, clientY: y });
	await act(async () => body().dispatchEvent(event));
	return event;
}
async function render(ref: TextDocumentRef, wrap = true, modal = false, live = false) {
	await act(async () =>
		root.render(
			<MantineProvider>
				<AutoFollowScroll
					bodyId="doc"
					layout={{ width: 200, height: 80 }}
					live={live}
					revision={ref.revision}
				>
					<DocumentCodeBody document={ref} font="12px monospace" lineHeight={20} wordWrap={wrap} />
				</AutoFollowScroll>
				{modal ? (
					<AutoFollowScroll bodyId="modal-doc" layout={{ width: 200, height: 80 }}>
						<DocumentCodeBody
							document={ref}
							pane="modal"
							font="12px monospace"
							lineHeight={20}
							wordWrap={wrap}
						/>
					</AutoFollowScroll>
				) : null}
			</MantineProvider>,
		),
	);
	await flushFrames();
}

describe("DocumentCodeBody viewport integration", () => {
	test("mounts only visual viewport rows and horizontal fragments, without DOM layout reads", async () => {
		const ref = textDocumentStore.importText("virtual-ui", "x".repeat(200000));
		await render(ref);
		expect(body().querySelectorAll("[data-document-visual-row]").length).toBeLessThanOrEqual(6);
		expect(body().textContent?.length).toBeLessThanOrEqual(120);
		await render(ref, false);
		viewport().scrollLeft = 600;
		await act(async () => viewport().dispatchEvent(new Event("scroll")));
		await flushFrames();
		expect(body().querySelector<HTMLElement>("[data-document-visual-row]")?.style.left).toBe(
			"600px",
		);
		expect(body().textContent?.length).toBeLessThanOrEqual(144);
		expect(body().querySelector("textarea,input")).toBeNull();
	});
	test("first pending layout remains readable and later pending patches preserve confirmed visible colour", async () => {
		const ref = textDocumentStore.importText(
			"pending-ui",
			"visible raw source ".repeat(100),
			false,
		);
		pendingHighlight = true;
		await render(ref);
		expect(body().textContent).toContain("visible raw source");
		expect(body().getAttribute("data-highlight-pending")).toBe("true");
		expect(body().getAttribute("aria-busy")).toBe("true");
		pendingHighlight = false;
		await render(ref);
		expect(body().querySelector<HTMLElement>("span")?.style.color).toBe("#abc");
		pendingHighlight = true;
		await act(async () =>
			textDocumentStore.append(
				{ ...ref, revision: ref.revision + 1, length: ref.length + 4 },
				ref.length,
				"tail",
			),
		);
		await flushFrames();
		expect(body().querySelector<HTMLElement>("span")?.style.color).toBe("#abc");
		expect(body().getAttribute("data-highlight-pending")).toBe("true");
	});
	test("Ctrl+A and Ctrl+C read full raw source; inline and modal selections are independent", async () => {
		const source = "a\r\n\t 中文😀".repeat(5000);
		const ref = textDocumentStore.importText("copy-ui", source);
		await render(ref, true, true);
		expect((await key(body(), "a", { ctrlKey: true })).defaultPrevented).toBe(true);
		expect(body().getAttribute("data-selection-focus")).toBe(String(source.length));
		expect(body("modal").getAttribute("data-selection-focus")).toBe("0");
		await key(body(), "c", { ctrlKey: true });
		expect(copied.at(-1)).toBe(source);
	});
	test("Shift keyboard selection persists while row windows unmount and stream appends", async () => {
		const ref = textDocumentStore.importText("selection-ui", "a".repeat(20000), false);
		await render(ref);
		await key(body(), "ArrowRight", { shiftKey: true });
		expect(body().getAttribute("data-selection-focus")).toBe("1");
		viewport().scrollTop = 2000;
		await act(async () => viewport().dispatchEvent(new Event("scroll")));
		await flushFrames();
		expect(body().querySelector("[data-source-start='0']")).toBeNull();
		await act(async () =>
			textDocumentStore.append(
				{ ...ref, revision: ref.revision + 1, length: ref.length + 4 },
				ref.length,
				"tail",
			),
		);
		await flushFrames();
		expect(body().getAttribute("data-selection-anchor")).toBe("0");
		expect(body().getAttribute("data-selection-focus")).toBe("1");
	});
	test("body Ctrl+F opens source search, input Ctrl+F and sibling shortcuts stay browser-owned", async () => {
		const ref = textDocumentStore.importText("find-ui", `first${"x".repeat(20000)}last`);
		await render(ref);
		const event = await key(body(), "f", { ctrlKey: true });
		expect(event.defaultPrevented).toBe(true);
		const input = container.querySelector<HTMLInputElement>("input");
		if (!input) throw new Error("search input missing");
		expect((await key(input, "f", { ctrlKey: true })).defaultPrevented).toBe(false);
		expect((await key(viewport(), "f", { ctrlKey: true })).defaultPrevented).toBe(false);
		expect((await key(body(), "f", { ctrlKey: true, shiftKey: true })).defaultPrevented).toBe(
			false,
		);
		expect((await key(body(), "ArrowLeft", { altKey: true })).defaultPrevented).toBe(false);
	});
	test("settlement and wrap preserve scroll instance and paused raw anchor", async () => {
		const ref = textDocumentStore.importText("settle-ui", "x".repeat(40000), false);
		await render(ref);
		const original = viewport();
		original.scrollTop = 2000;
		await act(async () => original.dispatchEvent(new Event("scroll")));
		await flushFrames();
		await render({ ...ref, complete: true }, false);
		expect(viewport()).toBe(original);
		expect(viewport().scrollTop).toBe(400);
	});
	test("mouse drag autoscroll spans unmounted rows and reverses without changing the raw anchor", async () => {
		const ref = textDocumentStore.importText("drag-ui", "x".repeat(20000));
		await render(ref);
		await pointer("pointerdown", 10, 20);
		const anchor = body().getAttribute("data-selection-anchor");
		await pointer("pointermove", 100, 160);
		for (let i = 0; i < 6; i++) {
			await flushFrames(1);
			await act(async () => viewport().dispatchEvent(new Event("scroll")));
		}
		expect(viewport().scrollTop).toBeGreaterThan(80);
		expect(Number(body().getAttribute("data-selection-focus"))).toBeGreaterThan(200);
		expect(body().getAttribute("data-selection-anchor")).toBe(anchor);
		const down = viewport().scrollTop;
		await pointer("pointermove", 10, -80);
		await flushFrames(2);
		expect(viewport().scrollTop).toBeLessThan(down);
		expect(body().getAttribute("data-selection-anchor")).toBe(anchor);
		await pointer("pointerup", 10, -80);
	});
	test("live selection and find detach following before async work and append cannot steal the position", async () => {
		const ref = textDocumentStore.importText("live-drag-ui", "x".repeat(4000), false);
		await render(ref, true, false, true);
		expect(viewport().getAttribute("data-following")).toBe("true");
		await pointer("pointerdown", 10, 20);
		await pointer("pointerup", 10, 20);
		expect(viewport().getAttribute("data-following")).toBe("false");
		const paused = viewport().scrollTop;
		await act(async () =>
			textDocumentStore.append(
				{ ...ref, revision: ref.revision + 1, length: ref.length + 100 },
				ref.length,
				"y".repeat(100),
			),
		);
		await flushFrames();
		expect(viewport().scrollTop).toBe(paused);
		await key(body(), "f", { metaKey: true });
		expect(viewport().getAttribute("data-following")).toBe("false");
	});
	test("touch pointerdown does not capture or prevent native scrolling", async () => {
		const ref = textDocumentStore.importText("touch-ui", "x".repeat(20000));
		await render(ref);
		const event = new Event("pointerdown", { bubbles: true, cancelable: true });
		Object.assign(event, {
			pointerType: "touch",
			button: 0,
			clientX: 10,
			clientY: 10,
			pointerId: 1,
		});
		await act(async () => body().dispatchEvent(event));
		expect(event.defaultPrevented).toBe(false);
		expect(body().getAttribute("data-selection-focus")).toBe("0");
	});
});
