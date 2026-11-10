import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExactRowProps } from "./ExactRow";
import { measureMarkdown } from "./measure/measure-markdown";
import { measureToolCall } from "./measure/measure-tool-call";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { useVListWindowRows } from "./useVListWindowRows";
import type { WindowRowProjection } from "./vlist-window-row-reuse";

let disposeCanvas: () => void;
let root: Root;
let container: HTMLElement;
const globals = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
	disposeCanvas = installCanvasStub();
});
afterAll(() => disposeCanvas());
beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
		matchMedia: () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		}),
	};
	for (const [key, value] of Object.entries(values)) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	Object.defineProperty(window, "matchMedia", { configurable: true, value: values.matchMedia });
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});

const noop = () => {};
function propsFor(text: string): ExactRowProps {
	const measured = measureMarkdown(text, 640);
	return {
		item: { spec: { key: "same-row", kind: "markdown", data: { text } }, measured },
		top: 0,
		height: measured.height,
		hitHeight: measured.height,
		contentWidth: 640,
		itemId: "row-id",
		sourceIds: ["source-message"],
		narratorId: "n1",
		interactionSig: "settled",
		toggles: {
			onToggle: noop,
			onToggleItems: noop,
			onToggleEarlier: noop,
			onToggleRow: noop,
			onToggleTranslation: noop,
			onTogglePrompt: noop,
			onToggleFileChanges: noop,
		},
		renderLabels: {
			reasoning: { reasoning: "Reasoning", thinking: "Thinking" },
		} as ExactRowProps["renderLabels"],
	};
}
function Host({ rows }: { rows: WindowRowProjection[] }) {
	const elements = useVListWindowRows("n1", rows);
	return <MantineProvider>{elements}</MantineProvider>;
}

test("Outline Ask slots use the real row reporter for growth, answer shrink and collapse", async () => {
	const prototype = HTMLElement.prototype;
	const oldHeight = Object.getOwnPropertyDescriptor(prototype, "offsetHeight");
	const oldObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
	let height = 120;
	let report = () => {};
	const disconnect = mock(() => {});
	Object.defineProperty(prototype, "offsetHeight", { configurable: true, get: () => height });
	Object.defineProperty(globalThis, "ResizeObserver", {
		configurable: true,
		value: class {
			constructor(callback: () => void) {
				report = callback;
			}
			observe() {}
			disconnect = disconnect;
		},
	});
	try {
		const onHeight = mock((_height: number) => {});
		const data = {
			toolName: "Ask",
			toolUseId: "ask",
			summary: "Questions",
			category: "outline",
			status: "success",
		} as const;
		const measured = measureToolCall(data, 640, 3, { preferOpen: true });
		const props: ExactRowProps = {
			...propsFor("unused"),
			item: { spec: { key: "tool-ask", kind: "tool-call", data }, measured },
			height: measured.height,
			hitHeight: measured.height,
			outlineAskSlot: <div data-outline-form>Loading questions</div>,
			onUnknownHeight: onHeight,
		};
		await act(async () => root.render(<Host rows={[{ props }]} />));
		expect(container.querySelector("[data-outline-form]")).not.toBeNull();
		expect(onHeight).toHaveBeenLastCalledWith(120);
		height = 620;
		await act(async () => report());
		expect(onHeight).toHaveBeenLastCalledWith(620);
		height = 90;
		await act(async () => report());
		expect(onHeight).toHaveBeenLastCalledWith(90);
		// Removing the slot AND reporter is the list's fold/override-pruning contract.
		const folded = measureToolCall(data, 640, 3, { preferOpen: true, opened: false });
		await act(async () =>
			root.render(
				<Host
					rows={[
						{
							props: {
								...props,
								item: { ...props.item, measured: folded },
								outlineAskSlot: undefined,
								onUnknownHeight: undefined,
								height: folded.height,
								hitHeight: folded.height,
							},
						},
					]}
				/>,
			),
		);
		expect(container.querySelector("[data-outline-form]")).toBeNull();
		expect(disconnect).toHaveBeenCalled();
	} finally {
		if (oldHeight) Object.defineProperty(prototype, "offsetHeight", oldHeight);
		else Reflect.deleteProperty(prototype, "offsetHeight");
		if (oldObserver) Object.defineProperty(globalThis, "ResizeObserver", oldObserver);
		else Reflect.deleteProperty(globalThis, "ResizeObserver");
	}
});

test("the real ExactRow memo receives a same-key content/measurement update", async () => {
	const before = propsFor("original body");
	await act(async () => root.render(<Host rows={[{ props: before }]} />));
	const node = container.querySelector("[data-nf-row-key=same-row]");
	expect(container.textContent).toContain("original body");
	await act(async () =>
		root.render(<Host rows={[{ props: { ...before, sourceIds: [...before.sourceIds] } }]} />),
	);
	expect(container.querySelector("[data-nf-row-key=same-row]")).toBe(node);
	const after = propsFor("updated body with more content");
	expect(after.item.measured).not.toBe(before.item.measured);
	await act(async () => root.render(<Host rows={[{ props: after }]} />));
	expect(container.textContent).toContain("updated body with more content");
	expect(container.textContent).not.toContain("original body");
	expect(container.querySelector("[data-nf-row-key=same-row]")).toBe(node);
});
