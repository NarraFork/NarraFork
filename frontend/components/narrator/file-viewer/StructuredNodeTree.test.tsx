import { afterEach, beforeEach, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../../../locales/en/narrator.json";
import { StructuredNodeTree, toTreeData } from "./StructuredNodeTree";
import type { StructuredNode } from "./structured-parse";

const globalKeys = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"matchMedia",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | undefined;
let container: HTMLDivElement;

const i18n = i18next.createInstance();
void i18n.init({ lng: "en", resources: { en: { narrator: en } } });

const NODES: StructuredNode[] = [
	{ kind: "leaf", key: "id", value: "demo", valueType: "string" },
	{
		kind: "branch",
		key: "metadata",
		childCount: 1,
		children: [
			{
				kind: "branch",
				key: "nested",
				childCount: 1,
				children: [{ kind: "leaf", key: "deep", value: "leaf-value", valueType: "string" }],
			},
		],
	},
];

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const key of globalKeys)
		originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	const overrides = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
		cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(overrides)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	try {
		await act(async () => root?.unmount());
		container?.remove();
	} finally {
		for (const key of globalKeys) {
			const descriptor = originalGlobals.get(key);
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		originalGlobals.clear();
	}
});

async function renderTree(nodes: StructuredNode[] = NODES) {
	await act(async () => {
		root?.render(
			<MantineProvider>
				<I18nextProvider i18n={i18n}>
					<StructuredNodeTree nodes={nodes} />
				</I18nextProvider>
			</MantineProvider>,
		);
	});
}

function clickButton(label: string) {
	const button = container.querySelector(`button[aria-label="${label}"]`);
	expect(button).not.toBeNull();
	act(() => {
		button?.dispatchEvent(new window.Event("click", { bubbles: true }));
	});
}

test("starts fully expanded: a deeply nested leaf is visible right after mount", async () => {
	await renderTree();
	// Regression: the initial expand used to call tree.expandAllNodes(), which only
	// flips keys already in the controller state — empty on mount — so a freshly
	// opened file rendered fully collapsed.
	expect(container.textContent).toContain("leaf-value");
});

test("collapse-all then expand-all actually toggles nested content", async () => {
	await renderTree();
	clickButton("Collapse all");
	expect(container.textContent).not.toContain("leaf-value");
	expect(container.textContent).not.toContain("nested");
	clickButton("Expand all");
	expect(container.textContent).toContain("leaf-value");
});

test("rows carry data-line anchors when nodes provide source lines", async () => {
	await renderTree([
		{ kind: "leaf", key: "a", value: "1", valueType: "string", line: 3 },
		{
			kind: "branch",
			key: "b",
			childCount: 1,
			line: 5,
			children: [{ kind: "leaf", key: "c", value: "2", valueType: "string", line: 6 }],
		},
	]);
	// These attributes are the split view's scroll-sync anchors.
	expect(container.querySelector('[data-line="3"]')).not.toBeNull();
	expect(container.querySelector('[data-line="5"]')).not.toBeNull();
	expect(container.querySelector('[data-line="6"]')).not.toBeNull();
});

test("rows omit data-line when nodes have no source line", async () => {
	await renderTree([{ kind: "leaf", key: "a", value: "1", valueType: "string" }]);
	expect(container.querySelector("[data-line]")).toBeNull();
});

test("toTreeData values stay unique when keys contain separator characters", () => {
	const data = toTreeData([
		{
			kind: "branch",
			key: "a",
			childCount: 1,
			children: [{ kind: "leaf", key: "b", value: "1", valueType: "string" }],
		},
		{ kind: "leaf", key: "a/b", value: "2", valueType: "string" },
		{ kind: "leaf", key: "a~1b", value: "3", valueType: "string" },
	]);
	const values: string[] = [];
	const walk = (items: typeof data) => {
		for (const item of items) {
			values.push(item.value);
			if (item.children) walk(item.children);
		}
	};
	walk(data);
	expect(new Set(values).size).toBe(values.length);
});
