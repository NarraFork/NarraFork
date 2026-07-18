import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AnimatedMarkdownText, MarkdownContent, segmentMarkdownText } from "./MarkdownContent";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let testDocument: Document | undefined;

type DomGlobalName =
	| "window"
	| "document"
	| "navigator"
	| "HTMLElement"
	| "Element"
	| "Node"
	| "Text"
	| "IS_REACT_ACT_ENVIRONMENT";

const DOM_GLOBAL_NAMES: readonly DomGlobalName[] = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"Text",
	"IS_REACT_ACT_ENVIRONMENT",
];

let previousGlobals: Partial<Record<DomGlobalName, PropertyDescriptor | undefined>>;

function installDom() {
	previousGlobals = Object.fromEntries(
		DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
	) as Partial<Record<DomGlobalName, PropertyDescriptor | undefined>>;

	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	testDocument = window.document;
	Object.assign(globalThis, {
		window,
		document: testDocument,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

function restoreGlobals() {
	for (const name of DOM_GLOBAL_NAMES) {
		const descriptor = previousGlobals[name];
		if (descriptor) {
			Object.defineProperty(globalThis, name, descriptor);
		} else {
			Reflect.deleteProperty(globalThis, name);
		}
	}
}

async function render(element: ReactElement) {
	const currentRoot = root;
	if (!currentRoot) throw new Error("test root is not initialized");
	await act(async () => {
		currentRoot.render(element);
	});
}

async function renderText(text: string) {
	await render(<AnimatedMarkdownText text={text} />);
}

beforeEach(() => {
	installDom();
	if (!testDocument) throw new Error("test document is not initialized");
	container = testDocument.createElement("div");
	testDocument.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	try {
		testDocument?.documentElement?.removeAttribute("data-advanced-anim");
		const currentRoot = root;
		await act(async () => {
			currentRoot?.unmount();
		});
		container?.remove();
	} finally {
		root = undefined;
		container = undefined;
		testDocument = undefined;
		restoreGlobals();
	}
});

describe("streaming markdown animation", () => {
	test("segments Chinese deltas into stable grapheme ids", () => {
		expect(segmentMarkdownText("中文🙂").map((segment) => segment.text)).toEqual([
			"中",
			"文",
			"🙂",
		]);
		expect(segmentMarkdownText("中文🙂").map((segment) => segment.id)).toEqual([
			"segment-0",
			"segment-1",
			"segment-2",
		]);
	});

	test("animates only an appended Chinese suffix without remounting prior graphemes", async () => {
		await renderText("你好");
		if (!container) throw new Error("test container is not initialized");
		const first = Array.from(container.querySelectorAll("[data-markdown-segment-id]"));
		expect(first.map((node) => node.textContent)).toEqual(["你", "好"]);
		expect(first.every((node) => node.getAttribute("data-markdown-segment-new") === "true")).toBe(
			true,
		);

		await renderText("你好世");
		const second = Array.from(container.querySelectorAll("[data-markdown-segment-id]"));
		expect(second).toHaveLength(3);
		expect(second[0]).toBe(first[0]);
		expect(second[1]).toBe(first[1]);
		expect(second[0].getAttribute("data-markdown-segment-new")).toBeNull();
		expect(second[1].getAttribute("data-markdown-segment-new")).toBeNull();
		expect(second[2].getAttribute("data-markdown-segment-new")).toBe("true");

		await renderText("你好世界");
		const third = Array.from(container.querySelectorAll("[data-markdown-segment-id]"));
		expect(third[0]).toBe(first[0]);
		expect(third[1]).toBe(first[1]);
		expect(third[2]).toBe(second[2]);
		expect(third[3].getAttribute("data-markdown-segment-new")).toBe("true");
	});

	test("keeps a growing current word stable while animating only new letters", async () => {
		await renderText("stream");
		if (!container) throw new Error("test container is not initialized");
		const initial = Array.from(container.querySelectorAll("[data-markdown-segment-id]"));

		await renderText("streaming");
		const updated = Array.from(container.querySelectorAll("[data-markdown-segment-id]"));
		expect(updated.slice(0, initial.length)).toEqual(initial);
		expect(
			updated
				.slice(0, initial.length)
				.every((node) => !node.hasAttribute("data-markdown-segment-new")),
		).toBe(true);
		expect(updated.slice(initial.length).map((node) => node.textContent)).toEqual(["i", "n", "g"]);
	});

	test("uses the same suffix-only animation through MarkdownContent advancedAnim", async () => {
		if (!document.documentElement) throw new Error("test document is not initialized");
		document.documentElement.setAttribute("data-advanced-anim", "true");
		await render(<MarkdownContent text="中文" streaming />);
		if (!container) throw new Error("test container is not initialized");
		const first = Array.from(container.querySelectorAll("[data-markdown-segment-id]"));
		expect(first).toHaveLength(2);

		await render(<MarkdownContent text="中文增" streaming />);
		const second = Array.from(container.querySelectorAll("[data-markdown-segment-id]"));
		expect(second[0]).toBe(first[0]);
		expect(second[1]).toBe(first[1]);
		expect(second[2].getAttribute("data-markdown-segment-new")).toBe("true");
	});

	test("does not make a long URL an atomic inline-block", async () => {
		await renderText(`https://example.test/${"a".repeat(120)}`);
		if (!container) throw new Error("test container is not initialized");
		const segments = container.querySelectorAll("[data-markdown-segment-id]");
		expect(segments.length).toBeGreaterThan(100);
		expect(Array.from(segments).every((node) => node.tagName === "SPAN")).toBe(true);
		expect(container.querySelector("span[style*='inline-block']")).toBeNull();
	});
});
