import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installCanvasStub } from "../measure/test-canvas-stub";

const disposeCanvas = installCanvasStub();
afterAll(disposeCanvas);
const injectionModule = await import("../measure/measure-injection-bubble");
const { measureCommunicationBubble } = await import("../measure/measure-communication-bubble");
const { RenderCommunicationBubble } = await import("./RenderCommunicationBubble");

let root: Root | undefined;
let container: HTMLElement;
const observed: Element[] = [];
const labels = {
	expand: "展开内容",
	collapse: "收起内容",
	loading: "加载中",
	loadFailed: "加载失败",
};

beforeAll(() => {
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const globals = globalThis as unknown as Record<string, unknown>;
	Object.assign(globals, {
		window: win,
		document: win.document,
		navigator: win.navigator,
		HTMLElement: win.HTMLElement,
		Element: win.Element,
		Node: win.Node,
		getComputedStyle: win.getComputedStyle,
		IS_REACT_ACT_ENVIRONMENT: true,
		matchMedia: () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		}),
		ResizeObserver: class {
			observe(element: Element) {
				observed.push(element);
			}
			unobserve() {}
			disconnect() {}
		},
		requestAnimationFrame: (callback: (time: number) => void) =>
			setTimeout(() => callback(Date.now()), 0),
		cancelAnimationFrame: (handle: Timer) => clearTimeout(handle),
	});
});
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	container?.remove();
	observed.length = 0;
});
function mount(node: React.ReactNode) {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => root?.render(<MantineProvider>{node}</MantineProvider>));
}
function click(selector: string) {
	const element = container.querySelector(selector) as HTMLButtonElement | null;
	if (!element) throw new Error(`missing control: ${selector}`);
	act(() => element.click());
}

const truncated = { message: "short prefix", sourceTruncated: true };
describe("communication preview disclosure boundaries", () => {
	test("a genuinely truncated short prefix has the unified in-place button", () => {
		const measured = measureCommunicationBubble(truncated, 600);
		expect(measured.textPreview).toMatchObject({ sourceText: truncated.message, expanded: false });
		expect(measured.textPreview?.buttonHeight).toBeGreaterThan(0);
		let fetched = 0;
		function Harness() {
			const [expanded, setExpanded] = useState(false);
			return (
				<RenderCommunicationBubble
					measured={measureCommunicationBubble(truncated, 600, 4, { textExpanded: expanded })}
					textPreviewLabels={labels}
					onToggleTextExpanded={() => {
						if (!expanded) fetched++;
						setExpanded(!expanded);
					}}
				/>
			);
		}
		mount(<Harness />);
		click("[data-vlist-text-preview-toggle]");
		expect(fetched).toBe(1);
		expect(
			container.querySelector("[data-vlist-text-preview-toggle]")?.getAttribute("aria-expanded"),
		).toBe("true");
	});
	test("a short injection result without preview metadata still gains a unified button", () => {
		const plain = injectionModule.measureInjectionBubble({ markdown: truncated.message }, 600);
		const { textPreview: _preview, ...withoutPreview } = plain;
		const spy = spyOn(injectionModule, "measureInjectionBubble").mockImplementationOnce(
			() => withoutPreview,
		);
		try {
			const measured = measureCommunicationBubble(truncated, 600);
			expect(measured.textPreview).toMatchObject({
				sourceText: truncated.message,
				previewText: truncated.message,
				charCount: truncated.message.length,
				expanded: false,
			});
			expect(measured.textPreview?.buttonHeight).toBeGreaterThan(0);
			mount(<RenderCommunicationBubble measured={measured} onToggleTextExpanded={() => {}} />);
			expect(container.querySelector("[data-vlist-text-preview-toggle]")).not.toBeNull();
		} finally {
			spy.mockRestore();
		}
	});
	test("an expanded body can collapse during a slow fetch without issuing another fetch", () => {
		let fetched = 0;
		let oldViewer = 0;
		function Harness() {
			const [expanded, setExpanded] = useState(false);
			const [loading, setLoading] = useState(false);
			return (
				<RenderCommunicationBubble
					measured={measureCommunicationBubble(truncated, 600, 4, { textExpanded: expanded })}
					fullTextLoading={loading}
					textPreviewLabels={labels}
					onViewFull={() => {
						oldViewer++;
					}}
					onToggleTextExpanded={() => {
						if (!expanded) {
							fetched++;
							setLoading(true);
						}
						setExpanded(!expanded);
					}}
				/>
			);
		}
		mount(<Harness />);
		click("[data-vlist-text-preview-toggle]");
		let button = container.querySelector("[data-vlist-text-preview-toggle]") as HTMLButtonElement;
		expect(button.disabled).toBe(false);
		expect(button.textContent).toBe(labels.collapse);
		click("[data-vlist-text-preview-toggle]");
		button = container.querySelector("[data-vlist-text-preview-toggle]") as HTMLButtonElement;
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(button.disabled).toBe(true);
		expect(button.textContent).toBe(labels.loading);
		click("[data-vlist-text-preview-toggle]");
		expect(fetched).toBe(1);
		expect(oldViewer).toBe(0);
	});
	test("the source footer prefers the inline disclosure over the legacy viewer callback", () => {
		let toggles = 0;
		let oldViewer = 0;
		mount(
			<RenderCommunicationBubble
				measured={measureCommunicationBubble(truncated, 600)}
				onToggleTextExpanded={() => {
					toggles++;
				}}
				onViewFull={() => {
					oldViewer++;
				}}
			/>,
		);
		click("[data-vlist-communication-view-full]");
		expect(toggles).toBe(1);
		expect(oldViewer).toBe(0);
	});
	test("expanded unknown body and all footers use natural flow, without inner height reporting", () => {
		const measured = measureCommunicationBubble(
			{ message: "```mermaid\n\n```", sourceTruncated: true, error: "delivery failed" },
			600,
			4,
			{ textExpanded: true },
		);
		measured.blocks = measured.blocks.map((block) =>
			block.kind === "unknown"
				? {
						...block,
						tag: "katex" as const,
						intrinsicWidth: undefined,
						data: {
							source: "x",
							html: '<div data-test-tall-content style="height:900px">tall content</div>',
						},
					}
				: block,
		);
		const reports: number[] = [];
		mount(
			<RenderCommunicationBubble
				measured={measured}
				onUnknownHeight={(height) => reports.push(height)}
				onToggleTextExpanded={() => {}}
			/>,
		);
		const frame = container.querySelector("[data-vlist-communication-frame]") as HTMLElement;
		const body = container.querySelector("[data-vlist-communication-body]") as HTMLElement;
		expect(frame.style.height).toBe("");
		expect(frame.style.minHeight).toBe(`${measured.height}px`);
		expect(body.style.height).toBe("");
		expect(body.style.overflowY).toBe("");
		expect(body.style.position).toBe("relative");
		for (const selector of [
			"[data-vlist-communication-error]",
			"[data-vlist-communication-view-full]",
		]) {
			const footer = container.querySelector(selector) as HTMLElement;
			expect(footer.style.position).toBe("relative");
			expect(footer.style.top).toBe("");
		}
		expect(container.querySelector("[data-test-tall-content]")?.textContent).toBe("tall content");
		expect(container.querySelector("[data-vlist-unknown]")?.getAttribute("style")).toContain(
			"position:relative",
		);
		expect(reports).toEqual([]);
		expect(observed.some((element) => element.hasAttribute("data-md-body"))).toBe(false);
	});
	test("collapsed unknown content retains a fixed, bounded viewport", () => {
		const measured = measureCommunicationBubble(
			{ message: "```mermaid\n\n```", warning: "queued" },
			600,
		);
		mount(<RenderCommunicationBubble measured={measured} onToggleTextExpanded={() => {}} />);
		const frame = container.querySelector("[data-vlist-communication-frame]") as HTMLElement;
		const body = container.querySelector("[data-vlist-communication-body]") as HTMLElement;
		expect(frame.style.height).toBe(`${measured.height}px`);
		expect(body.style.height).toBe(`${measured.bodyHeight}px`);
		expect(body.style.overflowY).toBe("hidden");
	});
});
